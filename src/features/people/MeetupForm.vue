<script setup lang="ts">
// Propose a meetup with friends at a public venue, or (for the organiser) change an existing plan.
// The time is typed as the venue's local time and sent as one instant.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MemberId } from '../../shared/ids.ts'
import type { Meetup, PublicVenue } from '../../shared/social.ts'
import { api, app, messageOf, myId, onAccountReset, toast } from '../../state/app.ts'
import { world } from '../../state/world.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { dateTimeIn } from '../../ui/format.ts'
import { isAutomaticFriend } from '../creator/creatorView.ts'
import FriendPicker from './FriendPicker.vue'
import { placeKind } from './labels.ts'
import { instantToZoned, readsDifferently, viewerZone, zonedToInstant } from './zonedTime.ts'

const props = defineProps<{
  /** Set when the organiser is changing an existing plan. */
  meetup?: Meetup | null
  /** A friend to start the invitation with (from "Plan a meetup" on their card). */
  withId?: string | null
}>()
const emit = defineEmits<{ done: [meetup: Meetup]; cancel: [] }>()

const INVITE_MAX = 12
const NOTE_MAX = 240
const BRANCH_MAX = 120
const DAY = 86_400_000
type ChosenVenue = Omit<PublicVenue, 'branch'>

const me = myId()
let closed = false
const stopReset = onAccountReset(() => { closed = true })
onBeforeUnmount(() => { closed = true; stopReset() })
const current = (): boolean => !closed && myId() === me
const revising = computed(() => Boolean(props.meetup))
const heading = ref<HTMLElement | null>(null)
const busy = ref(false)
const tried = ref(false)

// ── Who ──
const friends = useLoad(async () => (props.meetup ? [] : (await api('friends.list', {})).friends), [() => app.changed.friends])
/** A real-world meetup is between friends who both accepted. A friendship the service made is not an invitation to meet. */
const invitable = computed(() => (friends.data.value ?? []).filter(friend => !isAutomaticFriend(friend)))
const invite = ref<MemberId[]>([])
/** The person named in the link cannot be invited: not a friend, or a friend only through the service. */
const withMissing = ref<'' | 'stranger' | 'automatic'>('')
function applyWith(): void {
  const all = friends.data.value
  if (!all || props.meetup) return
  const list = invitable.value
  invite.value = invite.value.filter(id => list.some(friend => friend.id === id))
  withMissing.value = ''
  if (!props.withId) return
  const friend = list.find(entry => entry.id === props.withId)
  if (!friend) withMissing.value = all.some(entry => entry.id === props.withId) ? 'automatic' : 'stranger'
  else if (!invite.value.includes(friend.id) && invite.value.length < INVITE_MAX) invite.value = [...invite.value, friend.id]
}
watch([() => friends.data.value, () => props.withId], applyWith, { immediate: true })

// ── Where ──
const venue = ref<ChosenVenue | null>(props.meetup
  ? { placeId: props.meetup.venue.placeId, districtId: props.meetup.venue.districtId, name: props.meetup.venue.name, category: props.meetup.venue.category }
  : null)
const venueZone = ref(props.meetup?.timezone ?? '')
const branch = ref(props.meetup?.venue.branch ?? '')
const picking = ref(!venue.value)
const placeQuery = ref('')
const placeLimit = ref(6)
const placesReady = computed(() => Boolean(world.districtId) && world.places.length > 0)
const matchingPlaces = computed(() => {
  const text = placeQuery.value.trim().toLowerCase()
  return world.places.filter(place => !text || place.name.toLowerCase().includes(text) || placeKind(place.category).includes(text))
})
watch(placeQuery, () => { placeLimit.value = 6 })

function choosePlace(place: (typeof world.places)[number]): void {
  if (!world.districtId) return
  venue.value = { placeId: place.placeId, districtId: world.districtId, name: place.name.slice(0, 100), category: place.category.slice(0, 40) || 'place' }
  venueZone.value = world.timezone
  picking.value = false
}

// ── When ──
/** The clock the date and time are typed in: the chosen venue's, else the open district's. */
const zone = computed(() => (venue.value && venueZone.value ? venueZone.value : world.districtId ? world.timezone : viewerZone()))
const start = props.meetup
  ? instantToZoned(Date.parse(props.meetup.startsAt), props.meetup.timezone)
  : { date: instantToZoned(Date.now() + DAY, zone.value).date, time: '17:00' }
const date = ref(start.date)
const time = ref(start.time)
const note = ref(props.meetup?.note ?? '')
const today = computed(() => instantToZoned(Date.now(), zone.value).date)
const lastDay = computed(() => instantToZoned(Date.now() + 180 * DAY, zone.value).date)
// The plan's own instant settles the hour that clocks repeat when they go back, so saving it unchanged keeps it.
const when = computed(() => (date.value && time.value ? zonedToInstant(date.value, time.value, zone.value, props.meetup ? Date.parse(props.meetup.startsAt) : undefined) : null))
const whenIso = computed(() => (when.value ? new Date(when.value.instant).toISOString() : ''))
const venueReads = computed(() => (whenIso.value ? dateTimeIn(whenIso.value, zone.value) : ''))
const viewerReads = computed(() => (when.value && readsDifferently(when.value.instant, zone.value, viewerZone()) ? dateTimeIn(whenIso.value, viewerZone()) : ''))

/** The first thing still missing, as a sentence. Empty when the plan can be sent. */
const problem = computed(() => {
  if (!revising.value && !invite.value.length) return 'Choose at least one friend to invite.'
  if (!venue.value) return 'Choose a public venue.'
  if (!when.value) return 'Choose a date and a time.'
  if (when.value.instant < Date.now() + 10 * 60_000) return 'Choose a time at least 10 minutes from now.'
  if (when.value.instant > Date.now() + 180 * DAY) return 'Choose a time within the next six months.'
  return ''
})

async function submit(): Promise<void> {
  tried.value = true
  if (problem.value || !venue.value || !when.value || busy.value) return
  busy.value = true
  const plan = { venue: { ...venue.value, branch: branch.value.trim() }, startsAt: whenIso.value, timezone: zone.value, note: note.value.trim() }
  // The page that opened the form confirms the result, so there is one message, not two.
  try {
    const result = props.meetup
      ? await api('meetup.revise', { meetupId: props.meetup.id, ...plan })
      : await api('meetup.propose', { ...plan, invite: invite.value })
    if (current()) emit('done', result.meetup)
  } catch (error) {
    // A reply that arrives after the account changed belongs to the previous account.
    if (current()) toast(messageOf(error), 'bad')
  } finally {
    busy.value = false
  }
}

onMounted(() => heading.value?.focus())
</script>

<template>
  <form class="card stack plan-form" aria-labelledby="meetup-form-title" novalidate @submit.prevent="submit">
    <div class="row">
      <span class="icon-chip leaf" aria-hidden="true">📅</span>
      <h2 id="meetup-form-title" ref="heading" class="grow" tabindex="-1">{{ revising ? 'Change the plan' : 'Plan a meetup' }}</h2>
      <button class="btn ghost icon sm" type="button" aria-label="Close this form" :disabled="busy" @click="emit('cancel')">✕</button>
    </div>
    <p class="notice sky"><span aria-hidden="true">🔒</span><span>Only the venue, time and who is invited are shared. Nobody sees where you are coming from.</span></p>
    <p v-if="revising" class="notice amber"><span aria-hidden="true">↻</span><span>Changing the plan resets everyone’s answer. They will be asked again.</span></p>

    <!-- Who -->
    <fieldset v-if="!revising" class="group">
      <legend class="label">Friends to invite <span class="muted">(up to {{ INVITE_MAX }})</span></legend>
      <StateView v-if="friends.state.value !== 'ready'" :state="friends.state.value" :message="friends.error.value" @retry="friends.reload" />
      <div v-else-if="!invitable.length" class="notice amber stack tight">
        <span>Meetups are planned with friends you both accepted, and you have none yet. Introduce yourself to someone first.</span>
        <span v-if="withMissing === 'automatic'" role="status">An automatic friendship is for messages; it is not an invitation to meet.</span>
        <RouterLink class="btn sm" to="/people?tab=nearby">Find people</RouterLink>
      </div>
      <template v-else>
        <p v-if="withMissing === 'automatic'" class="notice coral" role="status">That friendship was made automatically, so it is for messages only. A meetup needs a friendship you both accepted.</p>
        <p v-else-if="withMissing" class="notice coral" role="status">That person is not in your friends, so they cannot be invited to a meetup.</p>
        <FriendPicker v-model="invite" :friends="invitable" :max="INVITE_MAX" label="Friends to invite" chosen-prefix="Inviting" />
      </template>
    </fieldset>
    <div v-else-if="meetup" class="group">
      <span class="label">Invited</span>
      <div class="row wrap invited">
        <span v-for="entry in meetup.participants" :key="entry.member.id" class="row who"><MemberBadge :member-id="entry.member.id" :look="entry.member.look" :size="26" /><span class="small truncate">{{ entry.member.displayName }}</span></span>
      </div>
      <small class="muted tiny">The people invited stay the same. Only the venue, time and note can change.</small>
    </div>

    <!-- Where -->
    <fieldset class="group">
      <legend class="label">Public venue</legend>
      <div v-if="venue && !picking" class="chosen row">
        <span class="icon-chip" :style="{ background: `${categoryStyle(venue.category).color}22` }" aria-hidden="true">{{ categoryStyle(venue.category).icon }}</span>
        <span class="grow"><strong class="block wrap-any">{{ venue.name }}</strong><span class="muted tiny">{{ placeKind(venue.category) }} · times in {{ zone }}</span></span>
        <button class="btn sm" type="button" @click="picking = true">Change</button>
      </div>
      <template v-else-if="placesReady">
        <p class="tiny muted">Public places in {{ world.areaLabel || 'the district open in the World' }}. Homes and private addresses cannot be chosen.</p>
        <input v-model="placeQuery" class="input" type="search" placeholder="Filter places by name or kind" aria-label="Filter places by name or kind" />
        <ul v-if="matchingPlaces.length" class="places">
          <li v-for="place in matchingPlaces.slice(0, placeLimit)" :key="place.placeId">
            <button class="place" type="button" :aria-pressed="venue?.placeId === place.placeId && venue?.districtId === world.districtId" @click="choosePlace(place)">
              <span class="icon-chip" :style="{ background: `${categoryStyle(place.category).color}22` }" aria-hidden="true">{{ categoryStyle(place.category).icon }}</span>
              <span class="grow"><strong class="truncate block">{{ place.name }}</strong><span class="muted tiny">{{ placeKind(place.category) }}</span></span>
              <span class="tiny pick">Choose</span>
            </button>
          </li>
        </ul>
        <p v-else class="muted small">No place matches that filter.</p>
        <div class="row wrap">
          <button v-if="matchingPlaces.length > placeLimit" class="btn sm" type="button" @click="placeLimit += 12">Show more places</button>
          <button v-if="venue" class="btn sm ghost" type="button" @click="picking = false">Keep {{ venue.name }}</button>
        </div>
      </template>
      <div v-else class="notice amber stack tight">
        <span v-if="world.districtId">The map has no named public places in {{ world.areaLabel || 'this district' }} yet. Open another district in the World first, then come back to choose a venue.</span>
        <span v-else>No district is open in the World yet. Open a district in the World first, then come back to choose a public venue there.</span>
        <div class="row wrap">
          <RouterLink class="btn sm" to="/">Go to the World</RouterLink>
          <button v-if="venue" class="btn sm ghost" type="button" @click="picking = false">Keep {{ venue.name }}</button>
        </div>
      </div>
      <label class="field">
        <span>Branch or entrance <span class="muted">(optional)</span></span>
        <input v-model="branch" class="input" type="text" :maxlength="BRANCH_MAX" placeholder="For example: main gate" autocomplete="off" />
        <small>Say which one, where a place has several branches or doors.</small>
      </label>
    </fieldset>

    <!-- When -->
    <fieldset class="group">
      <legend class="label">Date and time at the venue</legend>
      <div class="when">
        <label class="field"><span>Date</span><input v-model="date" class="input" type="date" :min="today" :max="lastDay" required /></label>
        <label class="field"><span>Time</span><input v-model="time" class="input" type="time" step="300" required /></label>
      </div>
      <div v-if="venueReads" class="notice leaf stack tight" aria-live="polite">
        <span>Everyone invited sees <strong>{{ venueReads }}</strong>.</span>
        <span v-if="viewerReads">On your own clock that is {{ viewerReads }}.</span>
        <span v-if="when?.shifted">The clocks change that day, so the time you typed does not exist. This is the nearest real time.</span>
      </div>
    </fieldset>

    <label class="field">
      <span>Note <span class="muted">(optional)</span></span>
      <textarea v-model="note" class="textarea" :maxlength="NOTE_MAX" placeholder="What is the plan?"></textarea>
      <small class="num">{{ note.length }} / {{ NOTE_MAX }}</small>
    </label>

    <p v-if="problem" class="small" :class="tried ? 'problem' : 'muted'" :role="tried ? 'alert' : undefined">{{ problem }}</p>
    <div class="row">
      <button class="btn primary" type="submit" :disabled="busy">{{ busy ? 'Sending…' : revising ? 'Save the new plan' : 'Propose meetup' }}</button>
      <button class="btn ghost" type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
    </div>
  </form>
</template>

<style scoped>
.plan-form h2:focus { outline: none; }
.group { display: flex; flex-direction: column; gap: 8px; min-width: 0; margin: 0; padding: 0; border: 0; }
.group legend { padding: 0; margin-bottom: 8px; }
.block { display: block; }
.chosen { padding: 8px 10px; border: 1px solid #c4e6d1; border-radius: 12px; background: var(--leaf-soft); }
.places { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 6px; }
.place { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px; padding: 6px 10px 6px 6px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); text-align: left; transition: background 0.15s ease, border-color 0.15s ease; }
.place:hover { background: var(--surface-2); border-color: var(--line-strong); }
.place[aria-pressed="true"] { background: var(--leaf-soft); border-color: #c4e6d1; }
.pick { font-weight: 650; color: var(--accent-text); flex: none; }
.when { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; }
.invited { gap: 6px 12px; }
.who { gap: 6px; min-width: 0; max-width: 100%; }
.problem { color: var(--danger); font-weight: 600; }
</style>
