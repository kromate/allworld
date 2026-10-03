<script setup lang="ts">
// One simulated shift, played: read the ticket, put the items on the tray in the order asked,
// hand it over. The service holds the tickets, judges each answer and measures the time.
// On a phone it takes exactly the height its window gives it: the ticket, the stock and the tray row
// are laid one after another and nothing floats over anything. In a half-height sheet all eight stock
// tiles show at once; if a sheet is shorter still, the stock scrolls in its own box above the tray row.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Career, Shift, TaskOutcome, Workplace } from '../../shared/play.ts'
import { api, attempt, messageOf, toast } from '../../state/app.ts'
import { getEngine, world } from '../../state/world.ts'
import { count } from '../../ui/format.ts'
import { beginTrip, tripLine, work } from '../life/workTrip.ts'
import { usePlayKeys } from './keys.ts'
import { PAY, coins } from './playText.ts'

const props = defineProps<{
  shift: Shift
  place: Workplace
  /** True when the shift was already running when this window opened. */
  resumed: boolean
}>()
const emit = defineEmits<{ update: [shift: Shift]; left: [shift: Shift, career: Career]; stale: [] }>()
const router = useRouter()

const tray = ref<string[]>([])
const busy = ref(false)
const confirmLeave = ref(false)
const last = ref<{ outcome: TaskOutcome; customer: string; wanted: string[] } | null>(null)
const now = ref(Date.now())
/** When the ticket in front of the player appeared here. Null when it was already running. */
const shownAt = ref<number | null>(props.resumed ? null : Date.now())
let advancedHere = false
let staleSent = false

const task = computed(() => props.shift.current)
const site = computed(() => props.shift.site)
/**
 * A placed shift is answered in the room it began in: the same district and place the service holds
 * it to, and the same test the shell uses for the half-height sheet. Practice has no place, so it is never away.
 */
const away = computed(() => Boolean(site.value && !(world.kind === 'venue' && world.venue?.placeId === site.value.placeId && world.districtId === site.value.districtId)))
/** The shift's place on the map of the district the avatar is in. Null when it is somewhere else. */
const wayBack = computed(() => (away.value && site.value && world.districtId === site.value.districtId ? world.places.find(poi => poi.placeId === site.value!.placeId) ?? null : null))
/** A walk back to the shift's place that is already under way, or has stopped. */
const trip = computed(() => (away.value && work.trip && work.trip.poi.placeId === site.value?.placeId ? work.trip : null))
const earned = computed(() => props.shift.done.reduce((sum, entry) => sum + entry.points, 0))
const stock = (id: string): { label: string; emoji: string } => props.place.stock.find(item => item.id === id) ?? { label: id, emoji: '❔' }
const slots = computed(() => Math.max(task.value?.wants.length ?? 0, tray.value.length))
const parLeft = computed(() => (!task.value || shownAt.value === null ? 0 : Math.max(0, task.value.parSeconds - (now.value - shownAt.value) / 1000)))
const parShare = computed(() => (task.value ? parLeft.value / task.value.parSeconds : 0))
const parText = computed(() => (shownAt.value === null ? 'clock already running' : parLeft.value > 0 ? `${Math.ceil(parLeft.value)} s for the speed bonus` : `no speed bonus, still pays ${PAY.ticket}`))
/** The same, in the few characters a phone has room for beside the bar. */
const parBrief = computed(() => (shownAt.value === null ? 'clock running' : parLeft.value > 0 ? `${Math.ceil(parLeft.value)} s` : 'no bonus'))
const closesIn = computed(() => {
  const seconds = Math.max(0, Math.round((Date.parse(props.shift.expiresAt) - now.value) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})
const dots = computed(() => Array.from({ length: props.shift.total }, (_, index) => {
  const done = props.shift.done.find(entry => entry.index === index)
  if (done) return done.correct ? { state: 'right', mark: '✓', label: `Ticket ${index + 1}: right, ${coins(done.points)}` } : { state: 'wrong', mark: '✕', label: `Ticket ${index + 1}: not right` }
  return index === props.shift.done.length ? { state: 'now', mark: String(index + 1), label: `Ticket ${index + 1}: in front of you` } : { state: 'todo', mark: String(index + 1), label: `Ticket ${index + 1}: to come` }
}))

// A new ticket: empty tray, and restart the visual timer only when we handed over the last one here.
watch(() => task.value?.index, () => {
  tray.value = []
  shownAt.value = advancedHere ? Date.now() : null
  advancedHere = false
})

function toggle(id: string): void {
  if (busy.value || !task.value || away.value) return
  const at = tray.value.indexOf(id)
  if (at >= 0) tray.value.splice(at, 1)
  else tray.value.push(id)
}
function removeLast(): void { if (!busy.value) tray.value.pop() }

async function handOver(): Promise<void> {
  const current = task.value
  // Away from its place a shift takes no new answer; what is already answered is kept by the service.
  if (!current || busy.value || !tray.value.length || away.value) return
  busy.value = true
  getEngine()?.gesture('work')
  try {
    const { shift } = await api('work.answer', { shiftId: props.shift.id, index: current.index, handed: [...tray.value] })
    const outcome = shift.done.find(entry => entry.index === current.index)
    last.value = outcome ? { outcome, customer: current.customer, wanted: current.wants } : null
    advancedHere = true
    emit('update', shift)
  } catch (error) {
    // The shift may have moved on somewhere else: ask for it again rather than guess.
    toast(messageOf(error), 'bad')
    emit('stale')
  } finally { busy.value = false }
}

async function leave(): Promise<void> {
  busy.value = true
  const result = await attempt('work.leave', { shiftId: props.shift.id })
  busy.value = false
  confirmLeave.value = false
  if (result) emit('left', result.shift, result.career)
}

// ── Away from the place ──

const returning = ref(false)
const walkingBack = computed(() => trip.value !== null && trip.value.stage !== 'stopped' && trip.value.stage !== 'ready')

/** Walk back to the shift's place. The window steps aside once the avatar is moving; a walk that cannot start says why here. */
async function walkBack(): Promise<void> {
  const poi = wayBack.value
  if (!poi || returning.value) return
  returning.value = true
  await beginTrip(props.place, poi)
  returning.value = false
  if (work.trip && work.trip.stage !== 'stopped') void router.push('/')
}

usePlayKeys(event => {
  if (confirmLeave.value || !task.value || away.value) return false
  if (/^[1-9]$/.test(event.key)) {
    const item = props.place.stock[Number(event.key) - 1]
    if (!item) return false
    toggle(item.id)
    return true
  }
  if (event.key === 'Backspace') { removeLast(); return true }
  if (event.key === 'Enter') {
    // Enter hands over, unless the focus is on another control that should get it.
    const control = (event.target as HTMLElement | null)?.closest('button, a')
    if (control && !control.hasAttribute('data-stock')) return false
    if (!event.repeat) void handOver()
    return true
  }
  return false
})

let timer = 0
onMounted(() => {
  timer = window.setInterval(() => {
    now.value = Date.now()
    // Past its closing time the service has ended the shift: fetch how it ended.
    if (!staleSent && now.value > Date.parse(props.shift.expiresAt) + 1500) { staleSent = true; emit('stale') }
  }, 250)
})
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="shift">
    <div class="head">
      <ol class="dots" aria-label="Tickets in this shift">
        <li v-for="(dot, index) in dots" :key="index" class="dot num" :class="dot.state" :aria-label="dot.label" :aria-current="dot.state === 'now' ? 'step' : undefined">
          <span aria-hidden="true">{{ dot.mark }}</span>
        </li>
      </ol>
      <span v-if="!site" class="chip sky">Practice</span>
      <span class="clock num"><span class="sr-only">This shift closes by itself in </span><span aria-hidden="true">⏱ </span>{{ closesIn }}</span>
      <button class="btn ghost sm danger quit" type="button" :disabled="busy || confirmLeave" aria-label="Leave this shift" @click="confirmLeave = true">Leave</button>
    </div>

    <div v-if="confirmLeave" class="notice amber leave" role="alertdialog" aria-label="Leave this shift">
      <span class="grow">Leave now? Only finished tickets are paid{{ shift.done.length ? ` (${coins(earned)} so far)` : '' }}, and a shift left early earns no completion bonus.</span>
      <div class="row">
        <button class="btn sm danger" type="button" :disabled="busy" @click="leave">{{ busy ? 'Leaving…' : 'Leave shift' }}</button>
        <button class="btn sm" type="button" @click="confirmLeave = false">Keep working</button>
      </div>
    </div>

    <!-- One line: how the last ticket went, or what to do. On a phone it is exactly one line, with what
         matters first, so the rows under it never move; words marked "full" are still read out there. -->
    <p v-if="last || !away" :key="last?.outcome.index ?? -1" class="status" :class="last ? (last.outcome.correct ? 'right' : 'wrong') : ''" role="status">
      <template v-if="last?.outcome.correct"><strong><span aria-hidden="true">✓ </span>Right · <span class="num">+{{ coins(last.outcome.points) }}</span></strong> · {{ last.customer }} served in <span class="num">{{ last.outcome.seconds }}</span> s</template>
      <template v-else-if="last">
        <strong><span aria-hidden="true">✕ </span>Not right</strong> · {{ last.customer }} wanted
        <span v-for="(id, index) in last.wanted" :key="id" class="item"><span aria-hidden="true">{{ stock(id).emoji }}</span><span class="full">{{ stock(id).label }}{{ index < last.wanted.length - 1 ? ', ' : ' ' }}</span></span>
        <span class="full">in that order</span>
      </template>
      <template v-else-if="resumed">Picked up at ticket {{ shift.done.length + 1 }} of {{ shift.total }} · its clock kept running</template>
      <template v-else>Tap the stock in the order asked, then hand over.<span class="full"> A right ticket pays {{ PAY.ticket }} coins, up to {{ PAY.speedBonus }} more for speed.</span></template>
    </p>

    <!-- Away from the place: no new ticket is answered, nothing finished is lost, and there is a way back. -->
    <section v-if="away && site" class="card tint-amber stack tight away" aria-labelledby="shift-away">
      <h2 id="shift-away" class="wrap">You are away from {{ site.venueName }}</h2>
      <p class="small">
        Tickets are answered there.
        <template v-if="shift.done.length">Your {{ count(shift.done.length, 'finished ticket') }} {{ shift.done.length === 1 ? 'is' : 'are' }} kept: {{ coins(earned) }} so far, paid when the shift closes.</template>
        <template v-else>None is finished yet, so nothing is paid if it closes now.</template>
      </p>
      <p v-if="trip?.stage === 'stopped'" class="notice coral" role="alert">{{ tripLine(trip) }}</p>
      <div class="row wrap">
        <button v-if="trip && walkingBack" class="btn primary" type="button" @click="router.push('/')">Watch the walk back</button>
        <button v-else-if="wayBack" class="btn primary" type="button" :disabled="returning" :aria-label="`Walk back to ${site.venueName}`" @click="walkBack">{{ returning ? 'Setting off…' : 'Walk back there' }}</button>
        <template v-else-if="world.state === 'ready'">
          <RouterLink class="btn primary" to="/map">Open the map</RouterLink>
          <RouterLink class="btn" to="/travel">Travel</RouterLink>
        </template>
      </div>
      <p v-if="trip && walkingBack" class="small muted">{{ tripLine(trip) }}. The shift carries on when you are back inside.</p>
      <p v-else-if="world.state !== 'ready'" class="small muted" role="status">Finding where your character is…</p>
      <p v-else-if="!wayBack" class="small muted wrap">{{ site.venueName }} is not on the map of the district you are standing in, so there is no walk to offer from here. Find your way back with the map, or by Travel if it is in another city, or leave the shift.</p>
    </section>

    <div v-else-if="task" class="board">
      <!-- The ticket: who, the speed bar, then up to four items in order, always on one row. -->
      <section class="ticket" aria-live="polite" aria-atomic="true">
        <div class="ask">
          <h2 class="who truncate"><span class="sr-only">Ticket {{ task.index + 1 }} of {{ shift.total }}: </span>{{ task.customer }} would like</h2>
          <div class="bar" aria-hidden="true"><div class="fill" :class="{ low: parShare < 0.3 }" :style="{ width: `${parShare * 100}%` }"></div></div>
          <span class="par-text num muted"><span class="full">{{ parText }}</span><span class="brief" aria-hidden="true">{{ parBrief }}</span></span>
        </div>
        <ol class="wants">
          <li v-for="(id, index) in task.wants" :key="id" class="want" :class="{ met: tray[index] === id }">
            <span class="order num" aria-hidden="true">{{ index + 1 }}</span>
            <span class="emoji" aria-hidden="true">{{ stock(id).emoji }}</span>
            <span class="name truncate">{{ stock(id).label }}</span>
          </li>
        </ol>
      </section>

      <!-- The stock: its own box between the ticket and the tray row. Nothing is drawn over it. -->
      <section class="stock" aria-label="Stock">
        <button
          v-for="(item, index) in place.stock" :key="item.id" class="tile" type="button" data-stock :disabled="busy" :aria-pressed="tray.includes(item.id)"
          :aria-keyshortcuts="String(index + 1)" @click="toggle(item.id)"
        >
          <span class="kbd key" aria-hidden="true">{{ index + 1 }}</span>
          <span class="emoji" aria-hidden="true">{{ item.emoji }}</span>
          <span class="tiny truncate name">{{ item.label }}</span>
        </button>
      </section>

      <!-- The tray and the hand-over: an ordinary row under the stock, at the bottom of the sheet. -->
      <div class="hand">
        <ol class="tray" aria-label="Your tray">
          <li v-for="n in slots" :key="n">
            <button v-if="tray[n - 1]" class="slot filled" type="button" :disabled="busy" :aria-label="`Take ${stock(tray[n - 1]!).label} off the tray`" :title="`Take ${stock(tray[n - 1]!).label} off`" @click="toggle(tray[n - 1]!)">
              <span class="emoji" aria-hidden="true">{{ stock(tray[n - 1]!).emoji }}</span>
            </button>
            <span v-else class="slot empty num"><span class="sr-only">Empty place </span>{{ n }}</span>
          </li>
        </ol>
        <button class="btn primary go" type="button" :disabled="!tray.length || busy" :aria-label="`Hand over to ${task.customer}`" @click="handOver">
          {{ busy ? 'Handing over…' : 'Hand over' }}<span class="kbd" aria-hidden="true">Enter</span>
        </button>
      </div>
      <p class="keys muted tiny"><span class="kbd">1</span>–<span class="kbd">{{ place.stock.length }}</span> add or take off · <span class="kbd">⌫</span> last off · <span class="kbd">Enter</span> hand over</p>
    </div>
  </div>
</template>

<style scoped>
/* The game takes the height the window's body has, no more: basis 0 and grow, as the messages window does.
   What does not fit is the stock's to scroll, so the tray row is never laid over anything. */
.shift { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; gap: 6px; container-type: inline-size; }
.shift > * { flex: none; }
.head { display: flex; align-items: center; flex-wrap: wrap; gap: 6px 8px; min-width: 0; }
.dots { display: flex; gap: 4px; list-style: none; margin: 0 auto 0 0; padding: 0; flex: none; }
.dot { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; font-size: 0.72rem; font-weight: 700; background: var(--surface-3); color: var(--muted); border: 2px solid transparent; }
.dot.now { background: var(--accent-soft); color: var(--accent-text); border-color: var(--accent-strong); }
.dot.right { background: var(--leaf); color: #fff; animation: pop 0.3s ease; }
.dot.wrong { background: var(--coral-soft); color: var(--danger); border-color: #f1b9ad; animation: pop 0.3s ease; }
.clock { flex: none; font-size: 0.82rem; font-weight: 700; color: var(--ink-2); }
.status { position: relative; min-height: 1.3em; font-size: 0.82rem; line-height: 1.3; color: var(--ink-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; animation: settle 0.28s ease; }
.status .item { margin-right: 4px; }
/* Words a phone has no room for: out of sight there, still read out. A wide window shows them. */
.full { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.status.right { color: #1c5c39; }
.status.wrong { color: #8f2c19; }
@keyframes pop { 0% { transform: scale(0.6); } 60% { transform: scale(1.2); } }
@keyframes settle { from { transform: translateY(-4px); opacity: 0.4; } }
.leave { align-items: center; flex-wrap: wrap; }
.away h2 { font-size: 1.05rem; }
.wrap { overflow-wrap: anywhere; }
.away a.btn { text-decoration: none; }

/* A phone first: a column that fills what is left of the game. The ticket and the tray row keep their
   height; the stock gives way, down to one row of tiles, and scrolls inside itself when it must. */
.shift > .board { flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column; gap: 5px; }
.board > * { flex: none; }
.ticket { display: flex; flex-direction: column; gap: 4px; min-width: 0; padding: 4px 8px 5px; border-radius: 12px; background: var(--accent-soft); border: 1px solid #f4dfae; }
.ask { display: flex; align-items: center; gap: 8px; min-width: 0; }
.who { flex: 0 1 auto; min-width: 0; font-size: 0.84rem; line-height: 1.25; }
.par-text { position: relative; flex: none; font-size: 0.74rem; }
.bar { flex: 1; min-width: 32px; height: 6px; border-radius: 999px; background: rgba(28, 26, 36, 0.1); overflow: hidden; }
.fill { height: 100%; border-radius: 999px; background: var(--leaf); transition: width 0.25s linear, background 0.3s ease; }
.fill.low { background: var(--coral); }
/* Four equal places, so a ticket of four takes the same one row as a ticket of two. */
.wants { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 5px; list-style: none; margin: 0; padding: 0; }
.want { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; min-width: 0; height: 34px; padding: 1px 2px; border-radius: 10px; background: #fff; border: 1px solid #f0dcae; }
.want.met { border-color: var(--leaf); box-shadow: 0 0 0 2px var(--leaf-soft); }
.want .emoji { font-size: 1.05rem; }
.want .name { max-width: 100%; font-size: 0.68rem; font-weight: 650; line-height: 1.15; }
.order { position: absolute; top: 2px; left: 2px; display: grid; place-items: center; width: 15px; height: 15px; border-radius: 50%; background: var(--ink); color: #fff; font-size: 0.62rem; font-weight: 700; }
.emoji { font-size: 1.2rem; line-height: 1; }

/* The 2 px of padding (taken back by the margin) keeps a tile's shadow and focus ring inside the scroll box. */
.board > .stock { flex: 0 1 auto; min-height: 48px; margin: -2px; padding: 2px; overflow-y: auto; overscroll-behavior: contain; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); grid-auto-rows: min-content; align-content: start; gap: 5px; }
.tile { position: relative; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; min-height: 44px; padding: 3px 2px 2px; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--surface); box-shadow: 0 2px 0 var(--line-strong); transition: transform 0.08s ease, box-shadow 0.08s ease, background 0.15s ease; touch-action: manipulation; }
.tile .emoji { font-size: 1.25rem; }
.tile .name { max-width: 100%; font-size: 0.7rem; font-weight: 650; line-height: 1.15; }
.tile:hover:not(:disabled) { background: var(--accent-soft); border-color: #f0dcae; }
.tile:active:not(:disabled) { transform: translateY(2px); box-shadow: 0 0 0 var(--line-strong); }
.tile[aria-pressed="true"] { background: var(--surface-3); box-shadow: none; transform: translateY(2px); color: var(--muted); }
.tile[aria-pressed="true"] .emoji { opacity: 0.45; }
.tile:disabled { cursor: progress; }
.key { position: absolute; top: 3px; left: 3px; min-width: 18px; padding: 0 4px; font-size: 0.66rem; }

/* Not sticky: it is the row after the stock, so it can never be painted over a tile. */
.hand { display: flex; align-items: center; gap: 8px; min-width: 0; }
.tray { display: flex; gap: 4px; list-style: none; margin: 0; padding: 0; flex: none; }
.slot { display: grid; place-items: center; width: 44px; height: 44px; border-radius: 11px; }
.slot.filled { border: 1px solid var(--line-strong); background: #fff; padding: 0; box-shadow: 0 2px 0 var(--line-strong); }
.slot.filled:hover:not(:disabled) { border-color: #f1b9ad; background: var(--coral-soft); }
.slot.empty { border: 2px dashed var(--line-strong); background: var(--surface-2); color: var(--muted); font-weight: 700; font-size: 0.8rem; }
.go { flex: 1 1 96px; min-width: 0; min-height: 44px; padding: 0 8px; font-size: 1rem; white-space: nowrap; }
.go:disabled { opacity: 1; background: var(--surface-3); border-color: var(--line-strong); color: var(--muted); box-shadow: none; }
.go .kbd { margin-left: 4px; }
/* The key hints are for a window with room and a keyboard; the keys themselves work everywhere. */
.keys { display: none; }

/* A wide window has room for the ticket and the stock side by side, and for every word. */
@container (min-width: 620px) {
  .shift > .board { flex: none; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-template-areas: "ticket stock" "hand stock" "keys keys"; align-items: start; gap: 12px; margin-top: 4px; }
  .ticket { grid-area: ticket; padding: 12px 14px; gap: 10px; border-radius: var(--radius); }
  .ask { flex-wrap: wrap; }
  .who { flex: 1 1 100%; font-size: 1.05rem; }
  .want { height: 52px; }
  .want .emoji { font-size: 1.35rem; }
  .want .name { font-size: 0.8rem; }
  .order { width: 18px; height: 18px; font-size: 0.68rem; }
  .board > .stock { grid-area: stock; min-height: 0; margin: 0; padding: 0; overflow: visible; gap: 8px; }
  .tile { min-height: 64px; }
  .tile .emoji { font-size: 1.5rem; }
  .tile .name { font-size: 0.78rem; }
  .hand { grid-area: hand; }
  .go { min-height: 50px; }
  .keys { grid-area: keys; display: block; }
  .status { white-space: normal; }
  .status .item { margin-right: 0; }
  .full { position: static; width: auto; height: auto; overflow: visible; clip-path: none; white-space: normal; }
  .status .item .full { margin-left: 3px; }
  .brief { display: none; }
}
@media (hover: none) { .key, .keys, .go .kbd { display: none; } }
/* Leave is small to look at so the row stays short; its touch area is not. */
.head .quit { position: relative; min-height: 28px; }
.head .quit::before { content: ""; position: absolute; inset: -8px -4px; }
</style>
