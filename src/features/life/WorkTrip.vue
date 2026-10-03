<script setup lang="ts">
// The walk to work, as seen from the street: where the journey stands, a way to call it off, the
// button that starts the shift once the avatar is at the counter, and a way back to a shift that
// is still open. The status is a one-line hint with a way to call it off; the button that moves it
// on (start, resume, carry on, walk back, work here) is the stage's one contextual action.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { world } from '../../state/world.ts'
import HudIcon from '../../ui/HudIcon.vue'
import { permits, seated as inVehicle } from '../../ui/gameInput.ts'
import { factsOf, hotkey } from '../../ui/hudKeys.ts'
import { PRIORITY, useInteraction } from '../../ui/interaction.ts'
import type { Interaction } from '../../ui/interaction.ts'
import { beginTrip, cancelTrip, jobsHere, loadWork, resumeTrip, setCovered, startPlacedShift, tripLine, work } from './workTrip.ts'

const route = useRoute()
const router = useRouter()
const now = ref(Date.now())
let clock = 0

const trip = computed(() => work.trip)
// The Work window shows the same journey itself.
const shown = computed(() => route.path !== '/work' && world.state === 'ready')
const moving = computed(() => trip.value !== null && trip.value.stage !== 'ready' && trip.value.stage !== 'stopped')
const open = computed(() => (work.active && Date.parse(work.active.expiresAt) > now.value ? work.active : null))
const closesIn = computed(() => {
  const seconds = open.value ? Math.max(0, Math.round((Date.parse(open.value.expiresAt) - now.value) / 1000)) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})
/** A job this room can host, offered where the member already stands. */
const offer = computed(() => (trip.value || open.value || world.state !== 'ready' || route.path !== '/' ? null : jobsHere()[0] ?? null))
/** The open shift is a placed one and the avatar stands in its room: it can be answered here. */
const atShift = computed(() => Boolean(open.value?.site && world.kind === 'venue' && world.venue?.placeId === open.value.site.placeId))
const awayShift = computed(() => Boolean(open.value?.site && !atShift.value))
/** Away from a placed shift: its place on the map of the district the avatar is in, when it is there. */
const wayBack = computed(() => {
  const site = open.value?.site
  return site && awayShift.value && world.districtId === site.districtId ? world.places.find(poi => poi.placeId === site.placeId) ?? null : null
})
/** The journey is the walk back to a shift that is already open, not the walk to a new one. */
const returning = computed(() => Boolean(trip.value && open.value?.site?.placeId === trip.value.poi.placeId))

/** Back to the open shift. Being in its room is enough: its tickets are answered from anywhere inside. */
function resume(): void {
  cancelTrip()
  void router.push('/work')
}
async function start(): Promise<void> {
  if (returning.value) { resume(); return }
  if (await startPlacedShift()) void router.push('/work')
}
// Starting a walk to work, or back to a shift, is foot work: not from a vehicle seat, and not behind a window or the Menu.
// (Calling a walk off, and answering a shift already open, stay available.)
function workHere(): void {
  if (!permits('foot')) return
  if (offer.value && world.venue) void beginTrip(offer.value, world.venue)
}
function walkBack(): void {
  if (!permits('foot')) return
  const workplace = work.workplaces.find(entry => entry.id === open.value?.workplaceId)
  if (workplace && wayBack.value) void beginTrip(workplace, wayBack.value)
  else void router.push('/work')
}

// The one action that moves work on, most pressing first: the journey or an open shift, then a job offered here.
useInteraction('work.shift', (): Interaction | null => {
  if (!shown.value || inVehicle.value) return null
  const walk = trip.value
  if (walk) {
    if (returning.value && (walk.stage === 'ready' || atShift.value)) return { id: 'work.shift', priority: PRIORITY.shift, verb: 'Resume', target: 'shift', label: 'Resume your shift', icon: 'work', key: 'J', tone: 'primary', run: resume }
    if (walk.stage === 'ready') return { id: 'work.shift', priority: PRIORITY.shift, verb: 'Start shift', label: 'Start your shift', icon: 'work', key: 'J', tone: 'primary', busy: work.starting, run: () => { void start() } }
    if (walk.stage === 'stopped') return { id: 'work.shift', priority: PRIORITY.shift, verb: 'Carry on', target: 'to work', label: 'Carry on to work', icon: 'walk', tone: 'primary', run: resumeTrip }
    return null
  }
  const shift = open.value
  if (!shift) return null
  if (wayBack.value && shift.site) return { id: 'work.shift', priority: PRIORITY.shift, verb: 'Walk back', target: shift.site.venueName, label: `Walk back to ${shift.site.venueName}`, icon: 'walk', tone: 'primary', run: walkBack }
  return { id: 'work.shift', priority: PRIORITY.shift, verb: awayShift.value ? 'Find the way' : 'Resume', target: 'shift', label: awayShift.value ? 'Find the way back to your shift' : 'Resume your shift', icon: 'work', tone: 'primary', run: () => { void router.push('/work') } }
})
useInteraction('work.here', (): Interaction | null => {
  const job = offer.value
  if (!job || inVehicle.value) return null
  return { id: 'work.here', priority: PRIORITY.work, verb: 'Work', target: job.role, label: `Work here: ${job.role}`, icon: 'work', key: 'J', tone: 'dark', run: workHere }
})

function onKey(event: KeyboardEvent): void {
  // J is foot work: the world's only when the avatar is free, and when nobody is typing or has handled it.
  if (route.path !== '/' || !hotkey(factsOf(event), ['j', 'J'], permits('foot'))) return
  if (trip.value?.stage === 'ready') { event.preventDefault(); void start() }
  else if (!trip.value && open.value && !awayShift.value) { event.preventDefault(); resume() }
  else if (offer.value) { event.preventDefault(); workHere() }
}

// After the stage has locked walking for the window that opened, so the journey can ask for it back.
watch(() => route.path, path => setCovered(path !== '/'), { immediate: true, flush: 'post' })
// The countdown only ticks while there is an open shift to count down.
watch(() => Boolean(work.active), active => {
  window.clearInterval(clock)
  if (active) clock = window.setInterval(() => { now.value = Date.now() }, 1000)
}, { immediate: true })

onMounted(() => {
  window.addEventListener('keydown', onKey)
  if (!work.loaded) void loadWork()
})
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); window.clearInterval(clock) })
</script>

<template>
  <div v-if="trip && shown" class="trip glass" :class="{ ready: trip.stage === 'ready' }" role="status">
    <HudIcon class="trip-icon" :class="{ moving }" name="work" :size="20" />
    <span class="grow trip-text">
      <strong>{{ returning ? 'Back to your shift' : trip.workplace.role }}</strong>
      <span>{{ tripLine(trip) }}{{ returning ? ` · closes in ${closesIn}` : trip.stage === 'stopped' && trip.misses >= 2 ? ' Carry on to start from the floor of the room instead.' : '' }}</span>
    </span>
    <button class="btn ghost sm" type="button" :aria-label="returning ? 'Call off the walk back to your shift' : trip.stage === 'ready' ? 'Not now: call off this shift' : 'Call off the walk to work'" @click="cancelTrip">{{ trip.stage === 'ready' && !returning ? 'Not now' : 'Cancel' }}</button>
  </div>
  <div v-else-if="open && shown" class="trip glass" :class="{ ready: !awayShift }" role="status">
    <HudIcon class="trip-icon" name="timer" :size="20" />
    <RouterLink class="grow trip-text link" to="/work">
      <strong>{{ !open.site ? 'Practice shift open' : awayShift ? `Away from your shift at ${open.site.venueName}` : `Shift open at ${open.site.venueName}` }}</strong>
      <span>Ticket {{ open.done.length + 1 }} of {{ open.total }} · closes in <span class="num">{{ closesIn }}</span></span>
    </RouterLink>
  </div>
</template>

<style scoped>
.trip { pointer-events: auto; display: flex; align-items: center; gap: 8px; padding: 5px 5px 5px 14px; border-radius: 999px; font-size: 0.86rem; width: max-content; max-width: min(520px, 100%); background: rgba(28, 26, 36, 0.84); border: 0; box-shadow: 0 2px 10px rgba(20, 14, 6, 0.3); backdrop-filter: none; -webkit-backdrop-filter: none; color: #fff; text-decoration: none; }
.trip.ready { box-shadow: 0 0 0 2px var(--accent), 0 2px 10px rgba(20, 14, 6, 0.3); }
.trip .btn.ghost, .trip .btn.ghost:hover:not(:disabled) { color: #fff; }
.trip-icon { flex: none; }
.trip-icon.moving { animation: step 0.9s ease-in-out infinite; }
@keyframes step { 50% { transform: translateY(-2px); } }
.trip-text { display: flex; flex-direction: column; min-width: 0; line-height: 1.25; }
.trip-text span { color: rgba(255, 255, 255, 0.78); font-size: 0.8rem; }
.trip-text.link { color: inherit; text-decoration: none; }
.trip a.btn { text-decoration: none; }
@media (prefers-reduced-motion: reduce) { .trip-icon.moving { animation: none; } }
@media (max-width: 720px) {
  .trip { border-radius: 18px; padding: 7px 5px 7px 12px; width: 100%; max-width: 100%; }
  .trip-text { flex-basis: 150px; }
}
/* Small buttons grow to a full touch target on touch screens. */
@media (pointer: coarse) { .trip .btn.sm { min-height: 44px; } }
</style>
