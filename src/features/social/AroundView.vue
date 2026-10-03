<script setup lang="ts">
// Who can I talk to right now? People in the room, friends and where they are (in words), people
// in the city, and the public places where people actually are. When it is quiet, it says so and
// offers the best next thing. Every number is of real members connected now.
import { computed, nextTick, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { FriendPresence, SocialSettings, Spot } from '../../shared/direct.ts'
import type { PresenceMember, PublicMember } from '../../shared/model.ts'
import { api, app, attempt, messageOf, onAccountReset, toast } from '../../state/app.ts'
import { dismissInvitation, goToFriend, goToSpot, helloToInviter, inviteToJoin, loadLinks, messageMember, refreshAround, relationNow, sendWave, shareInvite, social } from '../../state/social.ts'
import { getEngine, world } from '../../state/world.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { count, relativeTime } from '../../ui/format.ts'
import { permits } from '../../ui/gameInput.ts'
import Hangouts from './Hangouts.vue'
import InviteCard from './InviteCard.vue'
import InvitePeople from './InvitePeople.vue'
import WaveCard from './WaveCard.vue'

const props = defineProps<{ highlightWave?: string | null; highlightInvite?: string | null; highlightHangout?: string | null }>()
const router = useRouter()
onMounted(() => { void refreshAround(); void loadLinks() })

const around = computed(() => social.around)
const here = computed<PresenceMember[]>(() => (world.state === 'ready' ? world.members : []))
const hereIds = computed(() => new Set(here.value.map(member => member.id)))
const friendsOnline = computed(() => (around.value?.friends ?? []).filter(friend => friend.member.online))
const friendsOffline = computed(() => (around.value?.friends ?? []).filter(friend => !friend.member.online))
const offlineUnread = computed(() => friendsOffline.value.reduce((sum, friend) => sum + friend.unread, 0))
/** An invitation has done its job once the two are standing in the same room. */
const invites = computed(() => social.invites.filter(invite => !hereIds.value.has(invite.mine ? invite.to.id : invite.from.id)))
/** People who came through the member's invite link and are not friends yet: the next step is theirs or the member's. */
const arrivals = computed(() => {
  const seen = new Map<string, PublicMember>()
  for (const link of social.links) for (const member of link.joined) if (member.relation === 'none' || member.relation === 'intro-received') seen.set(member.id, member)
  return [...seen.values()]
})
async function welcome(member: PublicMember): Promise<void> {
  if (await attempt('intro.send', { to: member.id, note: 'You came through my invite link.' }, `Introduction sent to ${member.displayName}.`)) void loadLinks()
}
const waiting = computed(() => social.waves.length + invites.value.length + arrivals.value.length)
const spotsNow = computed(() => (around.value?.spots ?? []).filter(spot => spot.now > 0 || spot.here))
const spotsToday = computed(() => (around.value?.spots ?? []).filter(spot => spot.now === 0 && !spot.here))
/** Whether the avatar stands somewhere a friend could be invited to. */
const canInviteHere = computed(() => world.state === 'ready' && (world.kind === 'district' || world.kind === 'venue' || (world.kind === 'home' && world.canEditHome)))
const hereName = computed(() => (world.kind === 'venue' ? world.venue?.name : world.kind === 'home' ? 'your home' : world.areaLabel) || 'where you are')
const quiet = computed(() => Boolean(around.value) && !here.value.length && !friendsOnline.value.length && around.value!.city.online === 0)
const summary = computed(() => {
  const info = around.value
  if (!info) return ''
  const parts = [
    here.value.length ? `${count(here.value.length, 'person is', 'people are')} here with you` : '',
    friendsOnline.value.length ? `${count(friendsOnline.value.length, 'friend is', 'friends are')} online` : '',
    info.city.online ? `${count(info.city.online, 'person is', 'people are')} in ${cityName.value} right now` : '',
  ].filter(Boolean)
  return parts.length ? `${parts.join(' · ')}.` : ''
})
/** "Bodija, Ibadan" → "Ibadan": the city part of an area name, when it has one. */
const cityName = computed(() => {
  const label = around.value?.city.label
  if (!label) return 'your city'
  const parts = label.split(',').map(part => part.trim()).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 1]! : label
})

const busy = ref<string | null>(null)
async function run(key: string, action: () => Promise<unknown>): Promise<void> {
  busy.value = key
  try { await action() } finally { busy.value = null }
}
/** When it is quiet: the one thing most likely to put the member in touch with a real person. */
const next = computed<{ text: string; label: string; run: () => Promise<unknown> } | null>(() => {
  if (!quiet.value) return null
  if (friendsOffline.value.length) return { text: 'Leave a message for a friend. They see it when they are back.', label: 'Write a message', run: () => router.push('/messages') }
  const spot = spotsToday.value[0]
  if (spot) return { text: `${count(spot.today, 'person', 'people')} came by ${spot.name} today. It is the likeliest place to meet someone.`, label: 'Go there', run: () => goToSpot(spot) }
  return { text: 'The surest way to have someone here is to bring them. Send someone you know your own invite link.', label: 'Invite someone', run: () => shareInvite(social.links[0]) }
})
const relationWords = (member: PresenceMember): string =>
  ({ self: 'You', friend: 'Friend', 'intro-sent': 'Introduction sent', 'intro-received': 'Wants to connect', none: 'Not a friend yet' })[relationNow(member)]
/** Close the page before walking; a person's card is a separate action. */
async function walkOver(member: PresenceMember): Promise<void> {
  const mine = app.me?.id, room = world.roomKey, instance = world.instance, engine = getEngine()
  if (!mine || !room || !engine || world.state !== 'ready' || world.kind !== 'district') return
  let current = true
  const stopWatching = onAccountReset(() => { current = false })
  try {
    await router.push('/')
    await nextTick()
    if (!current || app.me?.id !== mine || app.phase !== 'ready' || router.currentRoute.value.path !== '/'
      || world.roomKey !== room || world.instance !== instance || world.state !== 'ready' || world.kind !== 'district'
      || getEngine() !== engine || !permits('foot')) return
    const there = world.members.find(person => person.id === member.id)
    if (there) engine.walkTo(there.pos)
  } finally { stopWatching() }
}
const spotIcon = (spot: Spot): string => (spot.kind === 'street' ? '🛣' : categoryStyle(spot.category ?? '').icon)
function spotLine(spot: Spot): string {
  if (spot.now > 0) return `${count(spot.now, 'person', 'people')} here now${spot.today > spot.now ? ` · ${spot.today} today` : ''}`
  if (spot.today > 0) return `${count(spot.today, 'person', 'people')} came by today · nobody right now`
  return 'Only you right now'
}
const friendHere = (friend: FriendPresence): boolean => hereIds.value.has(friend.member.id)

const saving = ref(false)
async function setSetting(key: keyof SocialSettings, value: boolean): Promise<void> {
  const current = around.value?.settings
  if (!current) return
  saving.value = true
  try {
    const { settings } = await api('around.settings', { settings: { ...current, [key]: value } })
    if (social.around) social.around.settings = settings
  } catch (error) { toast(messageOf(error), 'bad') } finally { saving.value = false }
}
</script>

<template>
  <StateView v-if="!around" :state="social.aroundState === 'error' ? 'error' : 'loading'" :message="social.aroundError" @retry="refreshAround" />
  <div v-else class="stack around">
    <!-- Arrived through someone's invite link -->
    <div v-if="social.invitation" class="card tint-amber invited">
      <MemberBadge :member-id="social.invitation.inviter.id" :look="social.invitation.inviter.look" :size="44" :online="social.invitation.inviter.online" />
      <div class="grow">
        <h2 class="head">{{ social.invitation.inviter.displayName }} invited you</h2>
        <p class="small">{{ social.invitation.areaLabel ? `They said to come and find them in ${social.invitation.areaLabel}. ` : '' }}Introduce yourself and, once they accept, you can message each other and go to where the other is.</p>
      </div>
      <div class="row actions">
        <button class="btn primary sm" type="button" @click="helloToInviter">Introduce yourself</button>
        <button class="btn ghost sm" type="button" @click="dismissInvitation">Not now</button>
      </div>
    </div>

    <!-- Waiting for an answer from you -->
    <section v-if="waiting" class="stack tight" aria-labelledby="around-waiting">
      <h2 id="around-waiting" class="head">Waiting for you</h2>
      <article v-for="member in arrivals" :key="member.id" class="card tint-amber invited">
        <MemberBadge :member-id="member.id" :look="member.look" :size="40" :online="member.online" />
        <p class="grow small"><strong>{{ member.displayName }}</strong> came through your invite link{{ member.relation === 'intro-received' ? ' and introduced themselves.' : '.' }}</p>
        <RouterLink v-if="member.relation === 'intro-received'" class="btn primary sm" to="/people?tab=requests">Answer them</RouterLink>
        <button v-else class="btn primary sm" type="button" @click="welcome(member)">Introduce yourself</button>
      </article>
      <InviteCard v-for="invite in invites" :key="invite.id" :invite="invite" :highlight="invite.id === props.highlightInvite" />
      <WaveCard v-for="wave in social.waves" :key="wave.id" :wave="wave" :highlight="wave.id === props.highlightWave" />
    </section>

    <!-- The answer in one line and, when it is quiet, the one best thing to do next -->
    <div class="now stack tight">
      <p class="small">
        <strong>{{ quiet ? 'It is quiet right now.' : summary }}</strong>
        <template v-if="quiet"> Nobody is in your room, no friend is online and nobody else is in {{ cityName }}.</template>
        <span v-if="around.worldOnline" class="muted">{{ ' ' }}{{ count(around.worldOnline, 'person is', 'people are') }} online across the world.</span>
      </p>
      <div v-if="next" class="card tint-sky row wrap">
        <span class="grow small text">{{ next.text }}</span>
        <button class="btn primary" type="button" :disabled="busy === 'next'" @click="run('next', next.run)">{{ next.label }}</button>
      </div>
    </div>

    <!-- In the same room -->
    <section v-if="here.length" class="stack tight" aria-labelledby="around-here">
      <h2 id="around-here" class="head"><span class="live" aria-hidden="true"></span>Here with you <span class="muted where">· {{ hereName }}</span></h2>
      <ul class="plain-list">
        <li v-for="member in here" :key="member.id" class="card person">
          <MemberBadge :member-id="member.id" :look="member.look" :size="38" online />
          <span class="grow lines">
            <strong class="truncate">{{ member.displayName }}</strong>
            <span class="tiny muted">{{ relationWords(member) }}</span>
          </span>
          <span class="row actions">
            <button v-if="relationNow(member) === 'friend'" class="btn sm" type="button" @click="messageMember(member.id)">Message</button>
            <button v-else class="btn sm" type="button" :disabled="busy === `wave:${member.id}`" @click="run(`wave:${member.id}`, () => sendWave(member))"><span aria-hidden="true">👋</span> Wave</button>
            <button class="btn primary sm" type="button" @click="walkOver(member)">Walk over</button>
          </span>
        </li>
      </ul>
    </section>

    <!-- Friends -->
    <section class="stack tight" aria-labelledby="around-friends">
      <h2 id="around-friends" class="head">Friends</h2>
      <ul v-if="friendsOnline.length" class="plain-list">
        <li v-for="friend in friendsOnline" :key="friend.member.id" class="card person friend">
          <MemberBadge :member-id="friend.member.id" :look="friend.member.look" :size="38" online />
          <span class="grow lines">
            <span class="row name"><strong class="truncate">{{ friend.member.displayName }}</strong><span v-if="friend.unread" class="chip coral num" :aria-label="`${friend.unread} unread`">{{ friend.unread }}</span></span>
            <span class="tiny where-words">
              <template v-if="friendHere(friend)">Here with you</template>
              <template v-else>{{ friend.where.hidden ? 'Online · not sharing where' : friend.where.words }}</template>
              <span v-if="!friendHere(friend) && friend.where.sameCity === false" class="chip amber">Another city</span>
            </span>
          </span>
          <!-- Message, and the one way to be together that applies. Waving and the rest are in the conversation. -->
          <span class="row actions">
            <button class="btn sm" :class="{ primary: friend.unread > 0 }" type="button" @click="messageMember(friend.member.id)">Message</button>
            <button v-if="friend.where.canJoin && !friendHere(friend)" class="btn sm" type="button" :disabled="busy === `go:${friend.member.id}`" @click="run(`go:${friend.member.id}`, () => goToFriend(friend.member))">Go to them</button>
            <button v-else-if="canInviteHere && !friend.member.automatic && !friendHere(friend)" class="btn sm" type="button" :disabled="busy === `join:${friend.member.id}`" :title="`Invite ${friend.member.displayName} to ${hereName}`" @click="run(`join:${friend.member.id}`, () => inviteToJoin(friend.member, 'here'))">Join me</button>
          </span>
        </li>
      </ul>
      <p v-else-if="friendsOffline.length" class="small muted">No friend is online right now.</p>
      <p v-else class="small muted">No friends yet. Wave at someone here or in your city; when they wave back you can introduce yourself, and friends can message each other anywhere.</p>

      <details v-if="friendsOffline.length" class="disclosure">
        <summary>Offline friends <span class="chip num">{{ friendsOffline.length }}</span><span v-if="offlineUnread" class="chip coral num">{{ offlineUnread }} unread</span></summary>
        <ul class="plain-list">
          <li v-for="friend in friendsOffline" :key="friend.member.id" class="card person offline">
            <MemberBadge :member-id="friend.member.id" :look="friend.member.look" :size="34" />
            <span class="grow lines">
              <span class="row name"><strong class="truncate">{{ friend.member.displayName }}</strong><span v-if="friend.unread" class="chip coral num" :aria-label="`${friend.unread} unread`">{{ friend.unread }}</span></span>
              <span class="tiny muted">{{ friend.where.hidden ? 'Offline' : friend.where.lastSeenAt ? `Last here ${relativeTime(friend.where.lastSeenAt)}${friend.where.areaLabel ? ` · ${friend.where.areaLabel}` : ''}` : friend.where.words }}</span>
            </span>
            <button class="btn sm" type="button" @click="messageMember(friend.member.id)">Leave a message</button>
          </li>
        </ul>
      </details>
    </section>

    <!-- The city -->
    <section class="stack tight" aria-labelledby="around-city">
      <h2 id="around-city" class="head">In {{ cityName }} now</h2>
      <p v-if="!around.city.label" class="notice amber">Choose where you are to see who is in your city. <RouterLink to="/settings?tab=area">Choose your area</RouterLink></p>
      <template v-else>
        <p class="small">{{ around.city.online ? `${count(around.city.online, 'person is', 'people are')} connected in ${cityName} besides you.` : `Nobody else is connected in ${cityName} at the moment.` }}</p>
        <ul v-if="around.city.people.length" class="plain-list">
          <li v-for="person in around.city.people" :key="person.member.id" class="card person">
            <MemberBadge :member-id="person.member.id" :look="person.member.look" :size="38" online />
            <span class="grow lines">
              <strong class="truncate">{{ person.member.displayName }}</strong>
              <span class="tiny muted">{{ person.areaLabel ? `In ${person.areaLabel}` : 'In your city' }}{{ person.member.bio ? ` · ${person.member.bio}` : '' }}</span>
            </span>
            <span v-if="person.wave === 'sent'" class="chip amber">You waved</span>
            <button v-else class="btn sm" :class="{ primary: person.wave === 'received' }" type="button" :disabled="busy === `wave:${person.member.id}`" @click="run(`wave:${person.member.id}`, () => sendWave(person.member))"><span aria-hidden="true">👋</span> {{ person.wave === 'received' ? 'Wave back' : 'Wave' }}</button>
          </li>
        </ul>
        <div v-else-if="around.city.listWithheld" class="notice sky">
          <div class="grow">You are not discoverable, so you see how many people are in the city but not who, and they do not see you. Only an area name is ever shown, never a position.</div>
          <RouterLink class="btn sm" to="/settings?tab=privacy">Privacy settings</RouterLink>
        </div>
        <p v-else-if="around.city.online" class="tiny muted">None of them chose to be listed. You can still meet them at the places below.</p>
      </template>
    </section>

    <!-- Where people are: open when someone is somewhere now, folded when it is only today's footfall -->
    <details v-if="spotsNow.length || spotsToday.length" class="disclosure" :open="spotsNow.some(spot => spot.now > 0)">
      <summary>Where people are <span class="chip num">{{ spotsNow.length + spotsToday.length }}</span></summary>
      <ul class="plain-list">
        <li v-for="spot in [...spotsNow, ...spotsToday]" :key="spot.id" class="card person">
          <span class="icon-chip" :class="spot.now ? 'leaf' : ''" aria-hidden="true">{{ spotIcon(spot) }}</span>
          <span class="grow lines">
            <strong class="truncate">{{ spot.name }}</strong>
            <span class="tiny muted">{{ spotLine(spot) }}{{ spot.kind === 'venue' ? ` · ${spot.areaLabel}` : '' }}</span>
            <span v-if="spot.friends.length" class="tiny friends">{{ spot.friends.map(friend => friend.displayName).join(', ') }} {{ spot.friends.length === 1 ? 'is' : 'are' }} here</span>
          </span>
          <span v-if="spot.here" class="chip leaf">You are here</span>
          <button v-else class="btn sm" :class="{ primary: spot.now > 0 }" type="button" :disabled="busy === spot.id" @click="run(spot.id, () => goToSpot(spot))">Go there</button>
        </li>
      </ul>
      <p class="tiny muted">Public places and streets in your city. Counts are people connected now, and people who came by in the last day.</p>
    </details>

    <Hangouts :highlight="props.highlightHangout" />

    <!-- Other cities -->
    <details v-if="around.elsewhere.length" class="disclosure">
      <summary>Other cities right now <span class="chip num">{{ around.elsewhere.length }}</span></summary>
      <ul class="plain-list">
        <li v-for="place in around.elsewhere" :key="place.areaLabel" class="card person">
          <span class="icon-chip sky" aria-hidden="true">🌍</span>
          <span class="grow lines"><strong class="truncate">{{ place.areaLabel }}</strong><span class="tiny muted">{{ count(place.online, 'person', 'people') }} there now</span></span>
          <RouterLink class="btn sm" to="/travel">Travel</RouterLink>
        </li>
      </ul>
    </details>

    <InvitePeople />

    <!-- What friends can see: the switches wait behind a row that says where things stand -->
    <details class="disclosure">
      <summary>What your friends can see <span class="chip" :class="around.settings.shareWhereabouts ? 'leaf' : ''">{{ around.settings.shareWhereabouts ? 'Where you are' : 'Online or offline only' }}</span></summary>
      <div class="stack tight">
      <p class="tiny muted">Right now you are {{ around.me.words }}.</p>
      <div class="row between setting">
        <span class="grow"><strong class="small">Where my character is</strong><span class="muted tiny line">An area or venue name, such as “at Bodija Market”. Never a position. Off shows only online or offline.</span></span>
        <button class="switch" type="button" role="switch" :aria-checked="around.settings.shareWhereabouts" aria-label="Friends can see where my character is" :disabled="saving" @click="setSetting('shareWhereabouts', !around.settings.shareWhereabouts)"></button>
      </div>
      <div class="row between setting">
        <span class="grow"><strong class="small">Friends can come to me without asking</strong><span class="muted tiny line">Off means a friend has to be invited with Join me.</span></span>
        <button class="switch" type="button" role="switch" :aria-checked="around.settings.allowJoin" aria-label="Friends can come to me without asking" :disabled="saving || !around.settings.shareWhereabouts" @click="setSetting('allowJoin', !around.settings.allowJoin)"></button>
      </div>
      <p class="tiny muted">People who are not your friends never see where your character is. {{ app.me?.preferences.discoverable ? 'You are discoverable, so people in your city can see your name and area.' : 'You are not discoverable, so you are not listed for people in your city.' }}</p>
      </div>
    </details>
  </div>
</template>

<style scoped>
.around { min-width: 0; container-type: inline-size; }
.head { font-size: 1rem; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.where { font-weight: 500; font-size: 0.86rem; }
.invited { display: flex; align-items: center; flex-wrap: wrap; gap: 10px 12px; }
.invited .grow { flex: 1 1 180px; }
/* Rows inside a folded section sit on its surface, so they need no card of their own. */
.disclosure .plain-list { gap: 0; }
.disclosure .card.person { padding: 8px 0; border: 0; border-radius: 0; background: transparent; }
.disclosure li + li.card.person { border-top: 1px solid var(--line); }
.plain-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.person { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 10px 12px; }
.person.offline { background: var(--surface-2); }
.lines { display: flex; flex-direction: column; gap: 2px; flex: 1 1 130px; }
.name { gap: 6px; min-width: 0; }
.where-words { color: var(--ink-2); display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.friends { color: #1f7447; font-weight: 650; }
.actions { gap: 6px; flex-wrap: wrap; margin-left: auto; }
.text { flex: 1 1 180px; }
.live { width: 9px; height: 9px; border-radius: 50%; background: var(--leaf); flex: none; }
.setting { align-items: flex-start; gap: 12px; }
/* The switch is small to look at; its touch area is not. */
.setting .switch::before { content: ""; position: absolute; inset: -9px -6px; }
.line { display: block; }
a.btn { text-decoration: none; }
@media (pointer: coarse) { .btn.sm { min-height: 40px; } }
</style>
