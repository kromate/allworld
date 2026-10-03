// Social state shared by the whole App: unread direct messages, who is around, waves and
// invitations waiting, and the few actions (wave, invite, go to someone) that several windows use.
// The shell reads `social.unreadDirect` for the badge on the dock's Chat button.
import { reactive, watch } from 'vue'
import { INVITE_LINK } from '../shared/direct.ts'
import type { ConversationId } from '../shared/direct.ts'
import type { Around, Conversation, DirectMessage, EmoteKind, Hangout, InviteLanding, InviteLink, JoinInvite, Wave, Way, Whereabouts } from '../shared/direct.ts'
import { brand } from '../brand.ts'
import { guestAccess } from '../shared/guest.ts'
import type { DistrictId, HomeId, MemberId } from '../shared/ids.ts'
import type { PublicMember, Relation } from '../shared/model.ts'
import { api, app, messageOf, onAccountReset, onReconnect, onServerEvent, toast } from './app.ts'
import { enterDistrict, enterVenue, getEngine, leaveInterior, walkToHome, walkToPlace, world } from './world.ts'

/** Something that just happened and is worth a moment on the HUD. It goes away by itself. */
export type Moment =
  | { id: string; kind: 'friend-online'; member: PublicMember; where: Whereabouts }
  | { id: string; kind: 'new-friend'; member: PublicMember }
  | { id: string; kind: 'message'; conversation: Conversation; message: DirectMessage }

export const social = reactive({
  /** Unread direct messages, kept current from service events. */
  unreadDirect: 0,
  around: null as Around | null,
  aroundState: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  aroundError: '',
  /** Waves waiting for the member, and answered ones still worth a next step. */
  waves: [] as Wave[],
  /** Join-me invitations that are still open, both received and sent. */
  invites: [] as JoinInvite[],
  moments: [] as Moment[],
  /** Gestures other people in the room just made, newest last. */
  emotes: [] as { id: string; memberId: MemberId; name: string; kind: EmoteKind }[],
  /** Bumped when the conversation list or who-is-around changed, so open pages reload. */
  changed: { direct: 0, around: 0 },
  /** The conversation on screen, so a message arriving in it is not also announced. */
  openConversation: null as ConversationId | null,
  /**
   * The invite link this member arrived through, once the service has said who made it. Set before
   * onboarding too, so the first screen can offer to start in the inviter's city (`invitation.area`).
   */
  invitation: null as InviteLanding | null,
  /** The member's own invite links that still work. */
  links: [] as InviteLink[],
  /** How friends are doing, in words (from the daily-life track). Null: nothing to say. */
  moods: {} as Record<string, string | null>,
  /** Friends in a live game the member may watch: member id → the hall's match id. */
  watchable: {} as Record<string, string>,
})

/**
 * What a member standing in the room is to the viewer, right now. The room's own record of this is
 * written when someone walks in and is not refreshed when a friendship starts or ends, so the
 * friends list (which is) has the last word on who is a friend.
 */
export function relationNow(member: { id: MemberId; relation: Relation }): Relation {
  const friends = social.around?.friends
  if (!friends || member.relation === 'self') return member.relation
  if (friends.some(friend => friend.member.id === member.id)) return 'friend'
  return member.relation === 'friend' ? 'none' : member.relation
}

// ── Navigation: windows are routes, and this module has no router of its own ──
let navigate: (path: string) => void = path => { window.location.assign(path) }
export function setNavigator(go: (path: string) => void): void { navigate = go }
export const go = (path: string): void => navigate(path)

// ── Who is playing: a member, or a guest ──

/**
 * A member may ask anything. A guest (`app.guest`, set by the session controller) is held to the
 * guest policy, which the service applies as well: what it closes is not asked for at all, so a
 * guest's session is not a steady stream of refusals. Nothing that is open is skipped.
 */
const open = (op: string, input?: unknown): boolean => !app.guest || guestAccess(op, input).allowed

/**
 * Bumped whenever the session changes hands (guest to account, account to guest, another member).
 * An answer that was asked for before the change is dropped instead of filling the new session's state.
 */
let epoch = 0

// ── Who is around ──

let loading: Promise<void> | null = null
let queued = false
let loadedAt = 0
export function refreshAround(): Promise<void> {
  if (!open('around.get')) return Promise.resolve()
  if (loading) { queued = true; return loading }
  if (social.aroundState === 'idle') social.aroundState = 'loading'
  const asked = epoch
  loading = (async () => {
    try {
      const { around } = await api('around.get', {})
      if (asked !== epoch) return
      // A friendship that began since the last look is worth a moment: the first message is one tap away.
      const known = social.around ? new Set(social.around.friends.map(friend => friend.member.id)) : null
      if (known) for (const friend of around.friends) if (!known.has(friend.member.id)) addMoment({ id: `friend:${friend.member.id}`, kind: 'new-friend', member: friend.member }, 25)
      social.around = around
      social.waves = around.waves
      social.invites = around.invites
      social.unreadDirect = around.unreadDirect
      social.aroundState = 'ready'
      social.aroundError = ''
      loadedAt = Date.now()
    } catch (error) {
      if (asked !== epoch) return
      social.aroundError = messageOf(error)
      if (!social.around) social.aroundState = 'error'
    } finally {
      if (asked === epoch) {
        loading = null
        if (queued) { queued = false; scheduleAround(1200) }
      }
    }
  })()
  return loading
}
let aroundTimer: ReturnType<typeof setTimeout> | null = null
/** Several events often arrive together; one reload shortly after covers them all. */
function scheduleAround(wait = 400): void {
  if (aroundTimer || !open('around.get')) return
  aroundTimer = setTimeout(() => { aroundTimer = null; if (ready()) void refreshAround() }, wait)
}
const ready = (): boolean => app.phase === 'ready' && Boolean(app.me?.onboardedAt)

/** Guests have a creator conversation, but cannot use the nearby-people query for its unread count. */
let guestUnreadRequest = 0
async function refreshGuestUnread(): Promise<void> {
  if (!app.guest || !ready()) return
  const request = ++guestUnreadRequest, asked = epoch, changed = social.changed.direct
  try {
    const { unread } = await api('direct.list', {})
    if (request === guestUnreadRequest && asked === epoch && changed === social.changed.direct) social.unreadDirect = unread
  } catch { /* Keep the last count; opening Chat provides the visible retry state. */ }
}

// ── Moments ──

function addMoment(moment: Moment, seconds: number): void {
  social.moments = [...social.moments.filter(entry => entry.id !== moment.id), moment].slice(-4)
  setTimeout(() => dismissMoment(moment.id), seconds * 1000)
}
export function dismissMoment(id: string): void { social.moments = social.moments.filter(entry => entry.id !== id) }

// ── Emotes ──

const EMOTE_WORDS: Record<EmoteKind, string> = { wave: 'waved', nod: 'nodded', clap: 'clapped', cheer: 'cheered', dance: 'is dancing', talk: 'is talking' }
export const emoteWords = (kind: EmoteKind): string => EMOTE_WORDS[kind]

/** The engine can play a gesture on another member's avatar once it has `gestureMember`; until then the HUD says it in words. */
type RemoteGestures = { gestureMember?: (id: MemberId, kind: EmoteKind) => void }

export async function sendEmote(kind: EmoteKind): Promise<void> {
  getEngine()?.gesture(kind)
  // Sent to people in view. Tapping faster than the limit simply plays it on your own avatar.
  try { await api('emote.send', { kind }) } catch { /* not in a room, or too fast: the local gesture still played */ }
}

// ── Waves ──

function upsertWave(wave: Wave): void {
  const live = wave.status === 'pending' ? !wave.mine : wave.status === 'returned'
  social.waves = [...social.waves.filter(entry => entry.id !== wave.id), ...(live ? [wave] : [])]
}

export async function sendWave(member: { id: MemberId; displayName: string }): Promise<boolean> {
  try {
    const { wave, returned } = await api('wave.send', { to: member.id })
    getEngine()?.gesture('wave')
    upsertWave(wave)
    toast(returned ? `You and ${member.displayName} waved at each other.` : `You waved at ${member.displayName}. They will see it${wave.context === 'same-room' ? '' : ' when they are around'}.`, 'good')
    scheduleAround()
    return true
  } catch (error) {
    toast(messageOf(error), 'bad')
    return false
  }
}

export async function waveBack(wave: Wave): Promise<boolean> {
  try {
    upsertWave((await api('wave.back', { waveId: wave.id })).wave)
    getEngine()?.gesture('wave')
    scheduleAround()
    return true
  } catch (error) {
    toast(messageOf(error), 'bad')
    social.waves = social.waves.filter(entry => entry.id !== wave.id)
    return false
  }
}

export async function dismissWave(wave: Wave): Promise<void> {
  social.waves = social.waves.filter(entry => entry.id !== wave.id)
  try { await api('wave.dismiss', { waveId: wave.id }) } catch { /* already gone */ }
}

/** After two people waved at each other, the next step is an introduction. One tap. */
export async function introduceAfterWave(wave: Wave): Promise<boolean> {
  const other = wave.mine ? wave.to : wave.from
  try {
    await api('intro.send', { to: other.id, note: 'We waved at each other.' })
    toast(`Introduction sent to ${other.displayName}. You become friends if they accept.`, 'good')
    scheduleAround()
    return true
  } catch (error) {
    toast(messageOf(error), 'bad')
    scheduleAround()
    return false
  }
}

// ── Join me ──

function upsertInvite(invite: JoinInvite): void {
  const live = invite.status === 'pending' || invite.status === 'accepted'
  social.invites = [...social.invites.filter(entry => entry.id !== invite.id), ...(live ? [invite] : [])]
}

export async function inviteToJoin(member: { id: MemberId; displayName: string }, place: 'here' | 'home', note = ''): Promise<boolean> {
  try {
    const { invite } = await api('join.send', { to: member.id, place, note: note.trim() })
    upsertInvite(invite)
    const minutes = Math.max(1, Math.round((Date.parse(invite.expiresAt) - Date.parse(invite.createdAt)) / 60_000))
    toast(`${member.displayName} was invited to ${placeWords(invite)}. The invitation lasts ${minutes} minutes.`, 'good', {
      label: 'Take it back', run: () => { void api('join.cancel', { inviteId: invite.id }).then(result => upsertInvite(result.invite)).catch(() => undefined) },
    })
    return true
  } catch (error) {
    toast(messageOf(error), 'bad')
    return false
  }
}

/** "Bodija Market in Bodija, Ibadan", "the streets of Yaba, Lagos", "Ada’s place". */
export function placeWords(invite: JoinInvite): string {
  const { place } = invite
  return place.kind === 'venue' && place.areaLabel ? `${place.name} in ${place.areaLabel}` : place.name
}

export async function answerInvite(invite: JoinInvite, accept: boolean): Promise<void> {
  try {
    const result = await api('join.respond', { inviteId: invite.id, accept })
    upsertInvite(result.invite)
    if (result.way) await follow(result.way, invite.from.displayName)
    else toast(`${invite.from.displayName} was told you cannot come right now.`, 'info')
  } catch (error) {
    toast(messageOf(error), 'bad')
    social.invites = social.invites.filter(entry => entry.id !== invite.id)
    scheduleAround()
  }
}

export async function cancelInvite(invite: JoinInvite): Promise<void> {
  try { upsertInvite((await api('join.cancel', { inviteId: invite.id })).invite) } catch (error) { toast(messageOf(error), 'bad') }
}

// ── Going somewhere ──

/**
 * A home is reached on foot, to its front door, on the route `home.approach` verifies (across districts
 * when it must). Nothing here steps inside: at the door the member uses the door, and the service
 * decides then. Leaving a home or a trip behind is the member's to do, so it is asked, not forced.
 */
export async function followToHome(homeId: HomeId, name: string): Promise<void> {
  if (world.kind === 'home') { toast(`Leave this home by its door first, then walk to ${name}.`, 'info'); return }
  if (world.kind === 'venue') await leaveInterior()
  const started = await walkToHome(homeId)
  const walk = world.homeWalk
  if (started) toast(walk.kind === 'at-door' ? `You are at the front door of ${name}. Use the door to step in.` : `Walking to the front door of ${name}.${walk.kind === 'walking' ? ` About ${Math.round(walk.metres)} m.` : ''}`, 'good')
  else if (walk.kind === 'travel') toast(`${name} is in ${walk.to.label}. Book a trip there from Travel first.`, 'info', { label: 'Open Travel', run: () => go('/travel') })
  else toast(walk.kind === 'unavailable' ? walk.message : `The walk to ${name} could not start, so nothing was moved. Try again from the street.`, 'info')
}

/**
 * Act on a way the service gave: walk to a street or venue in this city, walk to a home's front door, or
 * say that a trip is needed. Every step goes through the same room and travel rules as walking
 * there by hand; nothing here can put the avatar somewhere it may not be.
 */
export async function follow(way: Way, toWhom = ''): Promise<void> {
  const destination = way.destination
  if (way.reach === 'travel') { toast(way.text, 'info', { label: 'Open Travel', run: () => go('/travel') }); return }
  if (!destination || way.reach === 'unavailable') { toast(way.text, 'info'); return }
  if (destination.kind === 'table') { go(`/games/match/${destination.matchId}`); return }
  go('/')
  if (destination.kind === 'home') { await followToHome(destination.homeId, destination.name); return }
  const districtId = destination.districtId as DistrictId
  const here = world.kind === 'district' && world.districtId === districtId && world.state === 'ready'
  if (!here) {
    if (world.kind === 'venue' && world.districtId === districtId) await leaveInterior()
    else if (!(await enterDistrict(districtId, { areaLabel: destination.areaLabel }))) return
  }
  if (destination.kind === 'street') {
    // Walk to the person if they are in view, otherwise to where they stood when they asked.
    const person = toWhom ? world.members.find(member => member.displayName === toWhom) : undefined
    const target = person?.pos ?? destination.meet
    if (!target) { toast(here ? `You are already in ${destination.areaLabel}.` : `You are in ${destination.areaLabel}. Look around for people.`, 'good'); return }
    const route = getEngine()?.walkTo(target)
    const metres = route && route.length > 0 ? ` About ${Math.round(route.length)} m.` : ''
    toast(`Walking to ${toWhom || 'the meeting point'}.${metres}`, 'good', route && route.length > 60
      ? { label: 'Go straight there', run: () => { void enterDistrict(districtId, { at: target, areaLabel: destination.areaLabel }) } }
      : undefined)
    return
  }
  const poi = world.places.find(place => place.placeId === destination.placeId)
  if (!poi) { toast(`You are in the right district. Look for ${destination.name} on the places list.`, 'info'); return }
  const route = walkToPlace(poi)
  const metres = route && route.length > 0 ? ` It is about ${Math.round(route.length)} m.` : ''
  toast(`Walking to ${destination.name}.${metres}`, 'good', { label: 'Go straight in', run: () => { void enterVenue(poi) } })
}

export async function goToFriend(member: { id: MemberId; displayName: string }): Promise<void> {
  try { await follow((await api('around.wayToFriend', { memberId: member.id })).way, member.displayName) } catch (error) { toast(messageOf(error), 'bad') }
}

export async function goToSpot(spot: { id: string; name: string }): Promise<void> {
  try { await follow((await api('around.wayToSpot', { spotId: spot.id })).way) } catch (error) { toast(messageOf(error), 'bad'); scheduleAround() }
}

// ── Invite links: bringing in someone you know ──

const INVITE_KEY = 'neighbourhood-world:invite'
/** The address someone opens. It carries a random id and a signature, nothing about anyone. */
export const inviteUrl = (link: InviteLink): string => `${window.location.origin}/?${INVITE_LINK.param}=${link.token}`

// An invite link opened in this browser is remembered until it has been used: making a character comes first.
try {
  const arrived = new URLSearchParams(window.location.search).get(INVITE_LINK.param)
  if (arrived && /^[a-z0-9]{16}\.[\w-]{22}$/.test(arrived)) localStorage.setItem(INVITE_KEY, arrived)
} catch { /* storage is unavailable: the link simply does nothing */ }
const invitedBy = (): string | null => { try { return localStorage.getItem(INVITE_KEY) } catch { return null } }
function forgetInvitation(): void { try { localStorage.removeItem(INVITE_KEY) } catch { /* nothing to forget */ } social.invitation = null }

async function openInvitation(): Promise<void> {
  const token = invitedBy()
  // Invite links are between accounts. A guest keeps the link; it is opened once the character is saved.
  if (!token || !open('link.open', { token })) return
  const asked = epoch
  try {
    const { landing } = await api('link.open', { token })
    if (asked !== epoch) return
    if (landing.own || landing.inviter.relation === 'friend') { forgetInvitation(); return }
    social.invitation = landing
  } catch (error) {
    if (asked !== epoch) return
    // The link ran out or was taken back. A connection problem keeps it for the next try.
    if ((error as { code?: string }).code === 'not_found' || (error as { code?: string }).code === 'expired') { forgetInvitation(); toast(messageOf(error), 'info') }
  }
}
export function dismissInvitation(): void { forgetInvitation() }

/** The one tap: an introduction to the member whose link brought this member here. */
export async function helloToInviter(): Promise<void> {
  const token = invitedBy(), landing = social.invitation
  if (!token || !landing) return
  try {
    const { state, inviter } = await api('link.hello', { token })
    toast(state === 'friends' ? `You and ${inviter.displayName} are already friends.` : state === 'waiting' ? `An introduction between you and ${inviter.displayName} is already waiting. Look in Requests.` : `Introduction sent to ${inviter.displayName}. You become friends when they accept.`, 'good')
    forgetInvitation()
    scheduleAround()
  } catch (error) { toast(messageOf(error), 'bad') }
}

export async function loadLinks(): Promise<void> {
  try { social.links = (await api('link.mine', {})).links } catch { /* the card keeps what it had */ }
}
export async function revokeLink(link: InviteLink): Promise<void> {
  try { social.links = (await api('link.revoke', { id: link.id })).links; toast('That invite link no longer works.', 'good') } catch (error) { toast(messageOf(error), 'bad') }
}
export const inviteText = (link: InviteLink): string => (link.areaLabel ? `Come find me in ${link.areaLabel} on ${brand.name}.` : `Come find me on ${brand.name}.`)

/**
 * Make (or reuse) an invite link and hand it to the member to send themselves: the device's share
 * sheet where there is one, the clipboard otherwise. The App sends nothing to anyone.
 */
export async function shareInvite(existing?: InviteLink): Promise<'shared' | 'copied' | 'shown' | 'failed'> {
  let link = existing
  try {
    if (!link) { const made = await api('link.create', {}); link = made.link; social.links = made.links }
  } catch (error) { toast(messageOf(error), 'bad'); return 'failed' }
  const url = inviteUrl(link), text = inviteText(link)
  if (typeof navigator.share === 'function') {
    try { await navigator.share({ title: brand.name, text, url }); return 'shared' } catch (error) { if ((error as { name?: string }).name === 'AbortError') return 'shown' }
  }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Invite copied. Paste it into a message to the person you want to bring.', 'good'); return 'copied' }
  catch { toast('The link is shown below. Copy it into a message to the person you want to bring.', 'info'); return 'shown' }
}

// ── Open hangouts ──

function upsertHangout(hangout: Hangout): void {
  if (!social.around) return
  const live = hangout.status === 'upcoming' || hangout.status === 'now'
  const rest = social.around.hangouts.filter(entry => entry.id !== hangout.id)
  social.around.hangouts = live ? [...rest, hangout].sort((x, y) => Number(y.status === 'now') - Number(x.status === 'now') || Date.parse(x.startsAt) - Date.parse(y.startsAt)) : rest
}
export async function hostHangout(startsAt: number, note: string): Promise<boolean> {
  try {
    const { hangout } = await api('hangout.create', { startsAt: new Date(startsAt).toISOString(), note: note.trim() })
    upsertHangout(hangout)
    toast(`Your hangout at ${hangout.place.name} is announced to everyone in the city.`, 'good')
    return true
  } catch (error) { toast(messageOf(error), 'bad'); return false }
}
export async function rsvpHangout(hangout: Hangout, going: boolean): Promise<void> {
  try {
    upsertHangout((await api('hangout.rsvp', { hangoutId: hangout.id, going })).hangout)
    toast(going ? `You are in. You get a reminder shortly before it starts.` : 'You are no longer down as coming.', 'good')
  } catch (error) { toast(messageOf(error), 'bad'); scheduleAround() }
}
export async function cancelHangout(hangout: Hangout): Promise<void> {
  try { upsertHangout((await api('hangout.cancel', { hangoutId: hangout.id })).hangout); toast('The hangout is cancelled. Everyone who was coming has been told.', 'good') } catch (error) { toast(messageOf(error), 'bad') }
}
export async function goToHangout(hangout: Hangout): Promise<void> {
  try { await follow((await api('hangout.way', { hangoutId: hangout.id })).way) } catch (error) { toast(messageOf(error), 'bad'); scheduleAround() }
}

// ── What other tracks know about a friend: how they are doing, and a game of theirs to watch ──

const moodAt = new Map<string, number>()
/** A friend's mood in words ("Well fed · rested"), asked for at most once a minute each. */
export function peekMood(memberId: MemberId): void {
  if (!open('life.peek', { memberId }) || Date.now() - (moodAt.get(memberId) ?? 0) < 60_000) return
  moodAt.set(memberId, Date.now())
  const asked = epoch
  api('life.peek', { memberId }).then(({ mood }) => {
    if (asked === epoch) social.moods[memberId] = mood ? `${mood.hungerLabel} · ${mood.energyLabel.toLowerCase()}` : null
  }).catch(() => { if (asked === epoch) social.moods[memberId] = null })
}

let liveAt = 0, liveUnsupported = false
/** Games going on in the hall that this member may watch, by player. Quiet when the hall is not there. */
export function refreshWatchable(): void {
  if (liveUnsupported || !open('arena.live', { game: null }) || Date.now() - liveAt < 20_000) return
  liveAt = Date.now()
  const asked = epoch
  api('arena.live', { game: null }).then(({ matches }) => {
    if (asked !== epoch) return
    const next: Record<string, string> = {}
    for (const match of matches) for (const player of match.players) if (player.member) next[player.member.id] = match.id
    social.watchable = next
  }).catch(error => { if (asked === epoch && (error as { code?: string }).code === 'invalid') liveUnsupported = true })
}

// ── Direct messages ──

export async function messageMember(memberId: MemberId): Promise<void> {
  try { go(`/messages/${(await api('direct.open', { memberId })).conversation.id}`) } catch (error) { toast(messageOf(error), 'bad') }
}

// ── Events ──

onServerEvent(event => {
  switch (event.type) {
    case 'direct.message':
      social.unreadDirect = event.unread
      social.changed.direct++
      if (social.openConversation !== event.conversation.id) addMoment({ id: `message:${event.conversation.id}`, kind: 'message', conversation: event.conversation, message: event.message }, 9)
      break
    case 'direct.state':
      social.changed.direct++
      break
    case 'direct.changed':
      social.unreadDirect = event.unread
      social.changed.direct++
      break
    case 'wave.received':
      upsertWave(event.wave)
      social.changed.around++
      break
    case 'wave.returned': {
      upsertWave(event.wave)
      social.changed.around++
      const other = event.wave.to
      toast(`${other.displayName} waved back.`, 'good', other.relation === 'friend'
        ? { label: 'Message', run: () => { void messageMember(other.id) } }
        : { label: 'Introduce yourself', run: () => { void introduceAfterWave(event.wave) } })
      break
    }
    case 'join.changed': {
      const { invite } = event
      upsertInvite(invite)
      social.changed.around++
      if (invite.mine && invite.status === 'accepted') toast(`${invite.to.displayName} is coming to join you.`, 'good')
      else if (invite.mine && invite.status === 'declined') toast(`${invite.to.displayName} cannot come right now.`, 'info')
      break
    }
    case 'friend.online':
      addMoment({ id: `online:${event.member.id}`, kind: 'friend-online', member: event.member, where: event.where }, 14)
      scheduleAround()
      break
    case 'around.changed':
      social.changed.around++
      scheduleAround()
      break
    case 'hangout.changed':
      upsertHangout(event.hangout)
      break
    case 'arena.changed':
      liveAt = 0
      break
    case 'social.emote': {
      if (event.room !== world.roomKey) break
      const member = world.members.find(entry => entry.id === event.memberId)
      if (!member) break
      ;(getEngine() as RemoteGestures | null)?.gestureMember?.(event.memberId, event.kind)
      const id = `${event.memberId}:${event.at}`
      social.emotes = [...social.emotes.filter(entry => entry.memberId !== event.memberId), { id, memberId: event.memberId, name: member.displayName, kind: event.kind }].slice(-3)
      setTimeout(() => { social.emotes = social.emotes.filter(entry => entry.id !== id) }, 4500)
      break
    }
    case 'social.changed':
      // A friendship or an introduction changed what can be done with the people around.
      if (event.scope === 'friends' || event.scope === 'intros') { social.changed.around++; social.changed.direct++; scheduleAround() }
      break
    case 'presence.join':
    case 'presence.leave':
      // Someone walked into or out of view: the counts for this place moved. In a busy street this
      // happens all the time, so it only brings a reload forward, never more than one in ten seconds.
      if (Date.now() - loadedAt > 10_000) scheduleAround(2500)
      break
    default:
      break
  }
})

// The service learns the name of the venue the avatar stands in from the map on this device, and
// counts the visit, so others can see where people are and came by today.
watch(() => [world.roomKey, world.state] as const, ([room, state]) => {
  // The service counts the visit itself. Only a venue's name has to come from here: the map is on this device.
  const venue = room && state === 'ready' && world.kind === 'venue' ? world.venue : null
  if (!venue?.name) { if (ready()) scheduleAround(1500); return }
  const place = { name: venue.name.slice(0, 80), category: venue.category.slice(0, 40) }
  if (!open('around.place', place)) return
  api('around.place', place).catch(() => undefined).finally(() => scheduleAround())
})
// Who made the link this member arrived through is asked as soon as there is a session, before onboarding too.
watch(() => app.phase === 'ready', value => { if (value) void openInvitation() }, { immediate: true })

// Who is around is kept current only while someone is in the world who may ask for it: loaded when
// that begins, then on a slow timer, because counts drift as people come and go elsewhere in the
// city. The timer does not exist for a guest, before arrival, or between sessions.
let aroundPoll: ReturnType<typeof setInterval> | null = null
watch(() => ready() && open('around.get'), on => {
  if (aroundPoll) { clearInterval(aroundPoll); aroundPoll = null }
  if (!on) return
  void refreshAround()
  aroundPoll = setInterval(() => { if (document.visibilityState === 'visible') void refreshAround() }, 45_000)
}, { immediate: true })
watch(() => ready() && Boolean(app.guest), on => { if (on) void refreshGuestUnread() }, { immediate: true })
// Messages written while the link was down were not pushed to this device, so an open conversation list is read again with the counts.
onReconnect(() => { social.changed.direct++; void refreshAround(); void refreshGuestUnread() })
onAccountReset(() => {
  // The session changed hands. Everything read for the previous one goes, and so does anything
  // still on its way: answers in flight are dropped by `epoch`, and waiting reloads are cancelled.
  epoch++
  guestUnreadRequest++
  if (aroundTimer) { clearTimeout(aroundTimer); aroundTimer = null }
  loading = null; queued = false; loadedAt = 0; liveAt = 0; liveUnsupported = false
  Object.assign(social, { unreadDirect: 0, around: null, aroundState: 'idle', aroundError: '', waves: [], invites: [], moments: [], emotes: [], openConversation: null, invitation: null, links: [], moods: {}, watchable: {} })
  moodAt.clear()
})
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && ready()) scheduleAround() })
