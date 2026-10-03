<script setup lang="ts">
// The social part of the world HUD. Two things live here, and the stage places them:
//  - what is waiting for an answer (a wave, an invitation, a new message, a new friend) as small
//    cards, in the stage's hint column, and what people nearby just did, in one line;
//  - the People and Gestures panels, which render into the stage's single panel (`panelHost`) when
//    the stage's rail buttons ask for them (`panel` is the stage's choice, not this component's).
// What is only good to know (a friend coming online, somewhere busy to go) waits in People, and the
// rail button shows a dot (`attention`) when there is something inside.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { EMOTES } from '../../shared/direct.ts'
import type { EmoteKind } from '../../shared/direct.ts'
import type { MemberId } from '../../shared/ids.ts'
import type { PresenceMember } from '../../shared/model.ts'
import { api, app, messageOf, toast } from '../../state/app.ts'
import {
  dismissInvitation, dismissMoment, emoteWords, goToFriend, goToHangout, goToSpot, helloToInviter, inviteToJoin, messageMember, relationNow, rsvpHangout, sendEmote,
  sendWave, setNavigator, shareInvite, social,
} from '../../state/social.ts'
import type { Moment } from '../../state/social.ts'
import { getEngine, sendChat, world } from '../../state/world.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { permits } from '../../ui/gameInput.ts'
import HudIcon from '../../ui/HudIcon.vue'
import { factsOf, hotkey } from '../../ui/hudKeys.ts'
import type { HudIconName } from '../../ui/hudIcons.ts'
import { count } from '../../ui/format.ts'
import InviteCard from './InviteCard.vue'
import WaveCard from './WaveCard.vue'

const router = useRouter()
const route = useRoute()
const props = defineProps<{
  /** Where the open panel is drawn: the stage's panel body. Until it exists nothing is drawn. */
  panelHost?: HTMLElement | null
}>()
const emit = defineEmits<{ attention: [value: boolean] }>()
setNavigator(path => { void router.push(path) })

/** Which panel the stage has open for this component. It closes it by setting 'none'. */
const panel = defineModel<'none' | 'around' | 'emotes'>('panel', { default: 'none' })
const root = ref<HTMLElement | null>(null)
const narrow = window.matchMedia('(max-width: 720px)')
const small = ref(narrow.matches)
const onNarrow = (): void => { small.value = narrow.matches }

const EMOTE: Record<EmoteKind, { icon: HudIconName; label: string }> = {
  wave: { icon: 'g-wave', label: 'Wave' }, nod: { icon: 'g-nod', label: 'Nod' }, clap: { icon: 'g-clap', label: 'Clap' },
  cheer: { icon: 'g-cheer', label: 'Cheer' }, dance: { icon: 'g-dance', label: 'Dance' }, talk: { icon: 'g-talk', label: 'Talk' },
}
const PHRASES = ['Hello', 'How are you?', 'Where are you from?', 'Want to play a game?', 'Follow me', 'Nice outfit', 'See you later']

const ready = computed(() => world.state === 'ready')
watch(ready, value => { if (!value) panel.value = 'none' })
const here = computed<PresenceMember[]>(() => (ready.value ? world.members : []))
const hereIds = computed(() => new Set(here.value.map(member => member.id)))
const friendsOnline = computed(() => (social.around?.friends ?? []).filter(friend => friend.member.online))
/** Friends online somewhere else: those in the room are already listed under "Here with you". */
const friendsElsewhere = computed(() => friendsOnline.value.filter(friend => !hereIds.value.has(friend.member.id)))
const cityOnline = computed(() => social.around?.city.online ?? 0)
const cityName = computed(() => {
  const label = social.around?.city.label
  if (!label) return 'your city'
  const parts = label.split(',').map(part => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1]! : label
})
const topSpot = computed(() => (social.around?.spots ?? []).find(spot => !spot.here && spot.now > 0) ?? (social.around?.spots ?? []).find(spot => !spot.here && spot.today > 0) ?? null)
const canInviteHere = computed(() => ready.value && (world.kind === 'district' || world.kind === 'venue' || (world.kind === 'home' && world.canEditHome)))
const quiet = computed(() => !here.value.length && !friendsOnline.value.length && cityOnline.value === 0)
const sentence = computed(() => [
  `${count(here.value.length, 'person', 'people')} here with you`,
  `${count(friendsOnline.value.length, 'friend', 'friends')} online`,
  `${count(cityOnline.value, 'person', 'people')} in ${cityName.value} now`,
].join(', '))

// ── Busy now: the one best place to find people, shown when nobody is standing here ──
type Busy =
  | { kind: 'hangout'; text: string; action: string; run: () => Promise<unknown> }
  | { kind: 'spot' | 'city' | 'invite'; text: string; action: string; run: () => Promise<unknown> | void }
const clock = (iso: string, timeZone: string): string => new Intl.DateTimeFormat(undefined, { timeZone, weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso))
const busyNow = computed<Busy | null>(() => {
  const info = social.around
  if (!info || here.value.length) return null
  const live = info.hangouts.find(hangout => hangout.status === 'now')
  if (live) return { kind: 'hangout', text: `Hangout going on at ${live.place.name} · ${count(live.going, 'person', 'people')} said they are coming`, action: 'Go there', run: () => goToHangout(live) }
  const spot = info.spots.find(entry => !entry.here && entry.now > 0)
  if (spot) return { kind: 'spot', text: `${count(spot.now, 'person is', 'people are')} at ${spot.name} now`, action: 'Go there', run: () => goToSpot(spot) }
  const next = info.hangouts.find(hangout => hangout.status === 'upcoming' && Date.parse(hangout.startsAt) - Date.now() < 36 * 3_600_000)
  if (next) return next.iAmGoing
    ? { kind: 'hangout', text: `You are in: ${next.place.name}, ${clock(next.startsAt, next.timezone)} · ${next.going} coming`, action: 'See it', run: async () => open(`/people?tab=nearby&hangout=${next.id}`) }
    : { kind: 'hangout', text: `${clock(next.startsAt, next.timezone)} at ${next.place.name} · ${count(next.going, 'person', 'people')} coming`, action: 'I’m in', run: () => rsvpHangout(next, true) }
  const elsewhere = info.elsewhere[0]
  if (elsewhere) return { kind: 'city', text: `${count(elsewhere.online, 'person is', 'people are')} in ${elsewhere.areaLabel} right now`, action: 'Travel', run: () => open('/travel') }
  const earlier = info.spots.find(entry => !entry.here && entry.today > 0)
  if (earlier) return { kind: 'spot', text: `${count(earlier.today, 'person', 'people')} came by ${earlier.name} today`, action: 'Go there', run: () => goToSpot(earlier) }
  if (!info.friends.length) return { kind: 'invite', text: 'Nobody is about. Bring someone you know.', action: 'Invite', run: () => shareInvite(social.links[0]) }
  return null
})
const BUSY_ICON: Record<'hangout' | 'spot' | 'city' | 'invite', HudIconName> = { hangout: 'timer', spot: 'pin', city: 'globe', invite: 'send' }

// ── What is waiting for an answer, most pressing first: the only cards that sit over the street ──
/** A friend coming online is good to know, not something to answer: the people button counts it instead. */
type Answerable = Exclude<Moment, { kind: 'friend-online' }>
type Card =
  | { key: string; kind: 'invite'; invite: (typeof social.invites)[number] }
  | { key: string; kind: 'wave'; wave: (typeof social.waves)[number] }
  | { key: string; kind: 'moment'; moment: Answerable }
const talking = ref<PresenceMember | null>(null)
/** Someone asking comes first, then what just happened: a message, a new friend. */
const MOMENT_ORDER: Record<Answerable['kind'], number> = { message: 0, 'new-friend': 1 }
const cards = computed<Card[]>(() => [
  ...social.invites.filter(invite => !invite.mine && invite.status === 'pending').map((invite): Card => ({ key: invite.id, kind: 'invite', invite })),
  ...social.waves.filter(wave => wave.status === 'pending').map((wave): Card => ({ key: wave.id, kind: 'wave', wave })),
  // An answered wave stays on the HUD only while there is a step to take; the rest is in People.
  ...social.waves.filter(wave => wave.status === 'returned' && ['none', 'intro-received'].includes((wave.mine ? wave.to : wave.from).relation)).map((wave): Card => ({ key: wave.id, kind: 'wave', wave })),
  ...[...social.moments].reverse().filter((moment): moment is Answerable => moment.kind !== 'friend-online').sort((x, y) => MOMENT_ORDER[x.kind] - MOMENT_ORDER[y.kind]).map((moment): Card => ({ key: moment.id, kind: 'moment', moment })),
])
const shown = computed(() => cards.value.slice(0, small.value ? 1 : 2))
const hiddenCount = computed(() => cards.value.length - shown.value.length)
/** Behind the people button: friends who just came online, and the offer to introduce yourself. */
const behind = computed(() => social.moments.filter(moment => moment.kind === 'friend-online').length + (talking.value ? 1 : 0))
watch(behind, count => emit('attention', count > 0), { immediate: true })

// ── From talking to friends: after a real exchange in nearby chat, offer the introduction ──
const offered = new Set<MemberId>()
watch(() => world.chat.length, () => {
  const mine = app.me?.id
  const latest = world.chat[world.chat.length - 1]
  if (!mine || !latest || latest.from === mine) return
  const member = world.members.find(entry => entry.id === latest.from)
  if (!member || relationNow(member) !== 'none' || offered.has(member.id)) return
  // Both have spoken in the last few minutes: that is a conversation, not someone talking past you.
  const recent = world.chat.filter(message => Date.now() - Date.parse(message.at) < 5 * 60_000)
  if (!recent.some(message => message.from === mine)) return
  offered.add(member.id)
  talking.value = member
})
watch(() => world.roomKey, () => { talking.value = null; panel.value = 'none' })
const introducing = ref(false)
async function introduce(member: PresenceMember): Promise<void> {
  introducing.value = true
  try {
    await api('intro.send', { to: member.id, note: `We talked in ${world.title || 'the street'}.` })
    toast(`Introduction sent to ${member.displayName}. You become friends if they accept.`, 'good')
    talking.value = null
  } catch (error) { toast(messageOf(error), 'bad'); talking.value = null } finally { introducing.value = false }
}

// ── Gestures and phrases ──
const lastEmote = ref<EmoteKind | null>(null)
function emote(kind: EmoteKind): void {
  lastEmote.value = kind
  void sendEmote(kind)
}
const saying = ref(false)
async function say(text: string): Promise<void> {
  if (saying.value) return
  saying.value = true
  getEngine()?.gesture('talk')
  await sendChat(text)
  saying.value = false
  panel.value = 'none'
}

const busy = ref<string | null>(null)
async function run(key: string, action: () => Promise<unknown>): Promise<void> {
  busy.value = key
  try { await action() } finally { busy.value = null }
}
/** Look at someone: their card opens. Nobody moves. */
function view(member: PresenceMember): void {
  world.selected = member.id
  panel.value = 'none'
}
/** Walking over is a deliberate second step and foot work: not from a vehicle seat, and not behind a window or the Menu. */
function walkOver(member: PresenceMember): void {
  if (!permits('foot') || world.kind !== 'district') return
  panel.value = 'none'
  getEngine()?.walkTo(member.pos)
}
/** Going to a spot, a hangout or a friend on foot is foot work too; opening Travel or sharing an invite is not. */
const walksTo = (kind: string): boolean => kind === 'spot' || kind === 'hangout'
function open(path: string): void { panel.value = 'none'; void router.push(path) }

// The world already plays a wave on G; this sends it to the people in view as well. Sending it is social, so it is
// available seated; a modal in front, someone typing, a focused button's own keys and a held key all keep it.
// Escape is the stage's: the panel is its, and the newest open thing closes first.
function onKey(event: KeyboardEvent): void {
  if (route.path !== '/' || !ready.value || !hotkey(factsOf(event), ['g', 'G'], permits('social'))) return
  lastEmote.value = 'wave'
  api('emote.send', { kind: 'wave' }).catch(() => undefined)
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  narrow.addEventListener('change', onNarrow)
})
onBeforeUnmount(() => {
  emit('attention', false)
  window.removeEventListener('keydown', onKey)
  narrow.removeEventListener('change', onNarrow)
})
</script>

<template>
  <div v-if="ready" ref="root" class="hud">
    <div class="upper">
    <!-- Waiting for an answer, newest need first -->
    <div v-if="shown.length" class="cards" aria-live="polite">
      <template v-for="card in shown" :key="card.key">
        <InviteCard v-if="card.kind === 'invite'" class="lift" :invite="card.invite" compact />
        <WaveCard v-else-if="card.kind === 'wave'" class="lift" :wave="card.wave" compact />
        <article v-else-if="card.moment.kind === 'new-friend'" class="moment lift" :aria-label="`You and ${card.moment.member.displayName} are friends now`">
          <MemberBadge :member-id="card.moment.member.id" :look="card.moment.member.look" :size="34" :online="card.moment.member.online" />
          <p class="grow text">You and <strong>{{ card.moment.member.displayName }}</strong> are friends now. You can write to each other from anywhere.</p>
          <span class="row actions">
            <button class="btn primary sm" type="button" @click="messageMember(card.moment.member.id); dismissMoment(card.moment.id)">Say hello</button>
            <button class="btn ghost icon sm" type="button" aria-label="Dismiss" @click="dismissMoment(card.moment.id)">✕</button>
          </span>
        </article>
        <article v-else class="moment lift" :aria-label="`New message from ${card.moment.conversation.peer.displayName}`">
          <MemberBadge :member-id="card.moment.conversation.peer.id" :look="card.moment.conversation.peer.look" :size="34" online />
          <p class="grow text"><strong>{{ card.moment.conversation.peer.displayName }}</strong> <span class="quote">{{ card.moment.message.text }}</span></p>
          <span class="row actions">
            <button class="btn primary sm" type="button" @click="open(`/messages/${card.moment.conversation.id}`); dismissMoment(card.moment.id)">Reply</button>
            <button class="btn ghost icon sm" type="button" aria-label="Dismiss" @click="dismissMoment(card.moment.id)">✕</button>
          </span>
        </article>
      </template>
      <button v-if="hiddenCount > 0" class="more lift" type="button" @click="open('/people')">{{ hiddenCount }} more waiting · open People</button>
    </div>

    <!-- Arrived through someone's invite link -->
    <article v-if="social.invitation && !shown.length" class="moment lift" :aria-label="`${social.invitation.inviter.displayName} invited you`">
      <MemberBadge :member-id="social.invitation.inviter.id" :look="social.invitation.inviter.look" :size="34" :online="social.invitation.inviter.online" />
      <p class="grow text"><strong>{{ social.invitation.inviter.displayName }}</strong> invited you{{ social.invitation.areaLabel ? ` to find them in ${social.invitation.areaLabel}` : '' }}.</p>
      <span class="row actions">
        <button class="btn primary sm" type="button" @click="helloToInviter">Introduce yourself</button>
        <button class="btn ghost icon sm" type="button" aria-label="Not now" @click="dismissInvitation">✕</button>
      </span>
    </article>

    <!-- What people nearby just did, in words until avatars can show it -->
    <p v-if="social.emotes.length" class="feed lift" aria-live="polite">
      <span v-for="entry in social.emotes" :key="entry.id" class="feed-item"><HudIcon :name="EMOTE[entry.kind].icon" :size="18" /> {{ entry.name }} {{ emoteWords(entry.kind) }}</span>
    </p>

    <!-- The two panels draw into the stage's single panel, so only one thing is ever open. -->
    <Teleport v-if="panelHost && panel !== 'none'" :to="panelHost">
    <!-- Gestures and phrases -->
    <section v-if="panel === 'emotes'" id="social-emotes" class="sheet" aria-label="Gestures and quick phrases">
      <div class="emotes" role="group" aria-label="Gestures">
        <button v-for="kind in EMOTES" :key="kind" class="emote" type="button" :aria-pressed="lastEmote === kind" @click="emote(kind)">
          <HudIcon :name="EMOTE[kind].icon" :size="26" /><span>{{ EMOTE[kind].label }}</span>
        </button>
      </div>
      <p class="tiny muted">{{ here.length ? `Seen by ${count(here.length, 'person', 'people')} here.` : 'Nobody else is in view right now. Your character still does it.' }}</p>
      <div class="phrases" role="group" aria-label="Say to people nearby">
        <button v-for="text in PHRASES" :key="text" class="phrase" type="button" :disabled="saying" @click="say(text)">{{ text }}</button>
      </div>
      <p class="tiny muted">{{ world.inRange ? `A phrase is said in nearby chat to ${count(world.inRange, 'person', 'people')} in range.` : 'Nobody is close enough to hear a phrase. Walk up to someone first.' }}</p>
    </section>

    <!-- Who is around -->
    <section v-else-if="panel === 'around'" id="social-around" class="sheet" aria-label="Who is around">
      <p class="summary" role="status"><strong>{{ quiet ? 'It is quiet right now' : 'Who is around' }}</strong><span v-if="!quiet" class="muted small">{{ sentence }}.</span></p>

      <!-- After a real exchange in nearby chat: the step from talking to friends -->
      <div v-if="talking" class="line spot offer">
        <MemberBadge :member-id="talking.id" :look="talking.look" :size="30" />
        <span class="grow two">
          <strong class="truncate">{{ talking.displayName }}</strong>
          <span class="tiny muted">You two are talking. Friends can message each other anywhere.</span>
        </span>
        <button class="btn primary sm" type="button" :disabled="introducing" @click="introduce(talking)">Introduce yourself</button>
        <button class="btn ghost icon sm" type="button" aria-label="Not now" @click="talking = null">✕</button>
      </div>

      <!-- Nobody here: the one best place to find people -->
      <div v-if="busyNow" class="line spot" role="status">
        <span class="icon-chip leaf" aria-hidden="true"><HudIcon :name="BUSY_ICON[busyNow.kind]" :size="20" /></span>
        <span class="grow small">{{ busyNow.text }}</span>
        <button class="btn primary sm" type="button" :disabled="busy === 'busy' || (walksTo(busyNow.kind) && !permits('foot'))" @click="run('busy', async () => { await busyNow!.run() })">{{ busyNow.action }}</button>
      </div>

      <template v-if="here.length">
        <h4 class="label">Here with you · {{ here.length }}</h4>
        <!-- Everyone in the room the service lists, however many: a list that scrolls inside the panel. View opens their card and moves nobody. -->
        <ul class="plain scroll-list" aria-label="People here with you">
          <li v-for="member in here" :key="member.id" class="line">
            <button class="who" type="button" :aria-label="`View ${member.displayName}`" @click="view(member)">
              <span class="who-row"><MemberBadge :member-id="member.id" :look="member.look" :size="30" /><span class="two"><strong class="truncate">{{ member.displayName }}</strong><span class="tiny muted truncate">{{ relationNow(member) === 'friend' ? 'Friend' : 'Not a friend yet' }}</span></span></span>
            </button>
            <button v-if="relationNow(member) === 'friend'" class="btn sm ghost" type="button" :aria-label="`Message ${member.displayName}`" @click="panel = 'none'; messageMember(member.id)"><HudIcon name="chat" :size="20" /></button>
            <button class="btn sm ghost" type="button" :aria-label="`Wave at ${member.displayName}`" :disabled="busy === `wave:${member.id}`" @click="run(`wave:${member.id}`, () => sendWave(member))"><HudIcon name="g-wave" :size="20" /></button>
            <button v-if="world.kind === 'district'" class="btn sm ghost" type="button" :disabled="!permits('foot')" :aria-label="`Walk over to ${member.displayName}`" :title="permits('foot') ? 'Walk over to them' : 'Not while you are in a vehicle or something is open'" @click="walkOver(member)"><HudIcon name="walk" :size="20" /></button>
          </li>
        </ul>
      </template>

      <template v-if="friendsElsewhere.length">
        <h4 class="label">Friends online</h4>
        <ul class="plain scroll-list" aria-label="Friends online">
          <li v-for="friend in friendsElsewhere" :key="friend.member.id" class="line">
            <MemberBadge :member-id="friend.member.id" :look="friend.member.look" :size="30" online />
            <span class="grow two">
              <strong class="truncate">{{ friend.member.displayName }}</strong>
              <span class="tiny muted truncate">{{ friend.where.hidden ? 'Online' : friend.where.words }}</span>
            </span>
            <button class="btn sm ghost" type="button" :aria-label="`Message ${friend.member.displayName}`" @click="panel = 'none'; messageMember(friend.member.id)"><HudIcon name="chat" :size="20" /><span v-if="friend.unread" class="num">{{ friend.unread }}</span></button>
            <button v-if="friend.where.canJoin" class="btn sm" type="button" :aria-label="`Go to ${friend.member.displayName}`" :title="friend.where.sameCity === false ? 'They are in another city: a trip is needed' : 'Walk to where they are'" :disabled="busy === `go:${friend.member.id}` || (friend.where.sameCity !== false && !permits('foot'))" @click="run(`go:${friend.member.id}`, () => goToFriend(friend.member))">Go</button>
            <button v-if="canInviteHere && !friend.member.automatic" class="btn sm" type="button" :aria-label="`Invite ${friend.member.displayName} to join you here`" :disabled="busy === `join:${friend.member.id}`" @click="run(`join:${friend.member.id}`, () => inviteToJoin(friend.member, 'here'))">Join me</button>
          </li>
        </ul>
      </template>

      <h4 class="label">In {{ cityName }}</h4>
      <p class="small">{{ cityOnline ? `${count(cityOnline, 'person is', 'people are')} connected in ${cityName} besides you.` : `Nobody else is connected in ${cityName} right now.` }}</p>
      <div v-if="topSpot && busyNow?.kind !== 'spot'" class="line spot">
        <span class="icon-chip leaf" aria-hidden="true"><HudIcon name="pin" :size="20" /></span>
        <span class="grow two">
          <strong class="truncate">{{ topSpot.name }}</strong>
          <span class="tiny muted">{{ topSpot.now ? `${count(topSpot.now, 'person', 'people')} there now` : `${count(topSpot.today, 'person', 'people')} came by today` }}</span>
        </span>
        <button class="btn sm" :class="{ primary: topSpot.now > 0 }" type="button" :disabled="busy === topSpot.id || !permits('foot')" @click="run(topSpot.id, () => goToSpot(topSpot!))">Go there</button>
      </div>
      <p v-if="quiet && (social.around?.friends.length ?? 0) > 0" class="small muted">Your friends are offline. Leave one a message and they see it when they are back.</p>

      <footer class="row wrap foot">
        <button class="btn sm primary" type="button" @click="open('/people')">See everyone</button>
        <button class="btn sm" type="button" @click="open('/messages')">Messages<span v-if="social.unreadDirect" class="chip coral num">{{ social.unreadDirect }}</span></button>
      </footer>
    </section>
    </Teleport>
    </div>

  </div>
</template>

<style scoped>
.hud { display: flex; flex-direction: column; align-items: center; gap: 6px; width: 100%; pointer-events: none; }
.hud > *, .upper > * { pointer-events: auto; }
/* Everything above the two buttons, grouped so the stage can put it away in one go. It adds no box of its own. */
.upper { display: contents; }
.cards { display: flex; flex-direction: column; gap: 6px; width: min(360px, 100%); }
.lift { box-shadow: var(--shadow-lg); }
.moment { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 8px 10px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); }
.moment .text { flex: 1 1 140px; font-size: 0.9rem; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.quote { color: var(--ink-2); }
.actions { gap: 6px; margin-left: auto; }
.more { border: 0; border-radius: 999px; padding: 6px 12px; background: var(--ink); color: #fff; font-size: 0.8rem; font-weight: 650; align-self: flex-start; }
.feed { display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 6px 12px; border-radius: 999px; background: rgba(28, 26, 36, 0.82); color: #fff; font-size: 0.84rem; font-weight: 600; max-width: 100%; }

.sheet { display: flex; flex-direction: column; gap: 8px; }
.summary { display: flex; flex-direction: column; gap: 2px; }
.feed-item { display: inline-flex; align-items: center; gap: 6px; }
.sheet > * { flex: none; }
.sheet h3 { font-size: 0.98rem; }
.label { margin: 4px 0 0; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.plain { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 2px; }
.line { display: flex; align-items: center; gap: 8px; min-height: 44px; }
/* A long room is a list that scrolls inside the panel: bounded, never cut off. */
.scroll-list { max-height: min(34dvh, 320px); overflow-y: auto; overscroll-behavior: contain; }
.who { flex: 1; min-width: 0; display: flex; align-items: center; min-height: 44px; padding: 0 4px; border: 0; border-radius: 10px; background: transparent; text-align: left; }
.who:hover { background: var(--surface-2); }
.who-row { display: flex; align-items: center; gap: 8px; min-width: 0; }
.two { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.spot { padding: 6px 8px; border-radius: 12px; background: rgba(47, 157, 98, 0.08); }
.spot .icon-chip { width: 32px; height: 32px; font-size: 1rem; }
.spot .btn { flex: none; }
.offer { flex-wrap: wrap; background: var(--accent-soft); }
.offer .two { flex-basis: 150px; }
.foot { gap: 6px; margin-top: 2px; }

.emotes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; }
.emote { display: flex; flex-direction: column; align-items: center; gap: 2px; min-height: 58px; padding: 6px 4px; border: 1px solid var(--line-strong); border-radius: 14px; background: var(--surface); font-size: 0.78rem; font-weight: 650; transition: transform 0.08s ease, background 0.15s ease; }
.emote:hover { background: var(--surface-2); }
.emote:active { transform: scale(0.95); }
.emote[aria-pressed="true"] { background: var(--accent-soft); border-color: #e9b752; }
.phrases { display: flex; flex-wrap: wrap; gap: 6px; }
.phrase { min-height: 44px; padding: 0 12px; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); font-size: 0.86rem; font-weight: 600; }
.phrase:hover:not(:disabled) { background: var(--surface-2); }
.phrase:disabled { opacity: 0.5; }


</style>
