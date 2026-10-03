<script setup lang="ts">
// Go to work: a simulated job you actually play. It pays coins (play money) and builds a game
// career. It is not a real job and a level is not a qualification — real work is under Jobs.
// A shift is worked at a real place on the map: this window finds one that can be walked to, sends
// the avatar there, and plays the shift once it stands at the counter.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Career, Shift, Skill, Workplace } from '../../shared/play.ts'
import { SHIFT_TIMEOUT_MINUTES, SKILLS, xpForLevel } from '../../shared/play.ts'
import { api, attempt, refreshPoints } from '../../state/app.ts'
import { life, roughly } from '../../state/life.ts'
import { leaveInterior, world } from '../../state/world.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count, relativeTime } from '../../ui/format.ts'
import { STATION_WORDS } from '../life/stations.ts'
import { beginTrip, cancelTrip, findWork, resumeTrip, standingWords, startPlacedShift, tripLine, work } from '../life/workTrip.ts'
import type { WorkSpot } from '../life/workTrip.ts'
import ShiftGame from './ShiftGame.vue'
import { usePlayKeys } from './keys.ts'
import { COIN_HONESTY, PAY, SKILL, coins } from './playText.ts'

const router = useRouter()
let alive = true
onBeforeUnmount(() => { alive = false })
const { data, state, error, reload } = useLoad(() => api('work.places', {}))

/** The shift on screen: the one being played, or the one that just closed. */
const shift = ref<Shift | null>(null)
const resumed = ref(false)
const starting = ref('')
/** The workplace a walk is being set up for, while its first leg is found. */
const going = ref('')
/** Where the avatar stood when the shift on screen was started here, "at the counter". */
const workedAt = ref('')
const again = ref<HTMLButtonElement | null>(null)

const career = computed<Career | null>(() => data.value?.career ?? null)
const placeOf = (workplaceId: string): Workplace | null => data.value?.workplaces.find(place => place.id === workplaceId) ?? null
const place = computed(() => (shift.value ? placeOf(shift.value.workplaceId) : null))
const result = computed(() => (shift.value && shift.value.status !== 'active' ? shift.value.result : null))
const levelled = computed(() => Boolean(result.value && result.value.levelAfter > result.value.levelBefore))

const skillRows = computed(() => SKILLS.map((name: Skill) => {
  const entry = career.value!.skills[name]
  const base = xpForLevel(entry.level)
  const span = Math.max(1, entry.nextLevelXp - base)
  return { name, ...SKILL[name], ...entry, into: entry.xp - base, span, share: Math.min(1, Math.max(0, (entry.xp - base) / span)) }
}))

watch(data, value => {
  if (!value) return
  work.workplaces = value.workplaces
  work.active = value.active
  work.loaded = true
  void findWork()
  if (value.active) {
    // A shift already running when the window opened is picked up where it stands. One started a
    // moment ago from the prompt at the counter is not a return: its first ticket has only just appeared.
    if (shift.value?.id !== value.active.id) {
      resumed.value = value.active.done.length > 0 || Date.now() - Date.parse(value.active.startedAt) > 4000
      const site = value.active.site
      workedAt.value = site && world.kind === 'venue' && world.venue?.placeId === site.placeId ? standingWords() : ''
    }
    shift.value = value.active
  } else if (shift.value?.status === 'active') {
    // It closed while nobody was looking (the clock ran out, or it ended in another tab): show how it ended.
    closed(value.career.recent.find(entry => entry.id === shift.value!.id) ?? null, false)
  }
})

/** A shift ended. Show its result, bring the coin balance up to date, and fetch the new career. */
function closed(ended: Shift | null, refetch = true): void {
  shift.value = ended
  void refreshPoints()
  if (refetch) void reload()
  void nextTick(() => again.value?.focus())
}

/** A shift came back from the service: play it, or show how it ended if it was already over. */
function opened(started: Shift): void {
  // Starting is idempotent: if a shift was already running, this is that one.
  resumed.value = started.done.length > 0 || Date.now() - Date.parse(started.startedAt) > 4000
  if (started.status === 'active') shift.value = started
  else closed(started)
}

/** A practice shift: played in this window, away from any workplace. The service records it as one. */
async function practise(workplace: Workplace): Promise<void> {
  if (starting.value) return
  starting.value = workplace.id
  cancelTrip()
  const started = await attempt('work.start', { workplaceId: workplace.id, venueName: null })
  starting.value = ''
  if (!started) return
  workedAt.value = ''
  opened(started.shift)
}

// ── Getting to a workplace ──

const trip = computed(() => work.trip)
const moving = computed(() => trip.value !== null && trip.value.stage !== 'ready' && trip.value.stage !== 'stopped')
const isHere = (spot: WorkSpot): boolean => world.kind === 'venue' && world.venue?.placeId === spot.poi.placeId
const spotWords = (spot: WorkSpot): string =>
  (isHere(spot) ? 'You are inside' : spot.routed ? `${roughly(spot.metres)}${spot.metres < 15 ? '' : ' walk'}` : `${roughly(spot.metres)} from the door you came in by`)
const goLabel = (spot: WorkSpot): string => (isHere(spot) ? 'Work here' : world.kind === 'district' ? 'Walk there' : 'Step out and walk there')

/** The shortest walk to any job from here: the one the window recommends. */
const nearestAny = computed<{ workplace: Workplace; spot: WorkSpot } | null>(() => {
  let best: { workplace: Workplace; spot: WorkSpot } | null = null
  for (const workplace of work.workplaces) {
    const spot = work.options[workplace.id]?.spots[0]
    if (spot && (!best || spot.metres < best.spot.metres)) best = { workplace, spot }
  }
  return best
})
/** The job whose button is the window's main action. None while a walk is already under way. */
const bestId = computed(() => (trip.value ? '' : nearestAny.value?.workplace.id ?? ''))
/** Every job has been looked for, and none has a place that can be walked to from here. */
const nowhere = computed(() => work.workplaces.length > 0 && !work.searching && work.workplaces.every(workplace => work.options[workplace.id] && !work.options[workplace.id]!.spots.length))

/** Why a job has nowhere to be done from here, in a sentence. */
function why(workplace: Workplace): string {
  const found = work.options[workplace.id]
  if (world.state !== 'ready' || !world.districtId) return 'Your character is not standing in a street yet, so there is nowhere to walk from.'
  if (!found?.mapped) return `No ${workplace.venueWords} is on this district’s map.`
  return `${found.cut?.name ?? 'The nearest one'} is on the map, but there is no walking route to it from where you stand.`
}

/** Set off for a workplace. The window steps aside once the avatar is walking, so the walk can be seen. */
async function go(workplace: Workplace, spot: WorkSpot): Promise<void> {
  if (going.value) return
  going.value = workplace.id
  await beginTrip(workplace, spot.poi)
  going.value = ''
  // Setting off can take a moment; someone who has gone elsewhere meanwhile is not pulled back to the street. The walk goes on and its card is here on return.
  if (alive && work.trip && work.trip.stage !== 'ready' && work.trip.stage !== 'stopped') void router.push('/')
}

/** Start the shift the avatar has walked to. The service says whether it counted as worked at the place. */
async function startHere(): Promise<void> {
  const station = work.trip?.station
  const started = await startPlacedShift()
  if (!started) return
  workedAt.value = station ? STATION_WORDS[station.kind].at : 'on the floor'
  opened(started)
}

/** Still inside the place the shift on screen was worked at. */
const stillThere = computed(() => Boolean(shift.value?.site && world.kind === 'venue' && world.venue?.placeId === shift.value.site.placeId))

/** Another shift: at the same place when the avatar has not left it, otherwise back to the list. */
async function another(): Promise<void> {
  const last = shift.value
  const workplace = last ? placeOf(last.workplaceId) : null
  if (!last || !workplace || !stillThere.value || !world.venue) { shift.value = null; return }
  await beginTrip(workplace, world.venue)
  shift.value = null
  // Already at the counter: the shift starts at once. Otherwise the journey card shows the walk back to it.
  if (work.trip?.stage === 'ready') await startHere()
}

async function stepOut(): Promise<void> {
  shift.value = null
  void router.push('/')
  await leaveInterior()
}

/** What the shift on screen was: where it was worked, or that it was practice. */
const shiftPlace = (entry: Shift): string => entry.site?.venueName ?? `${placeOf(entry.workplaceId)?.name ?? 'Shift'} · practice`

watch(shift, value => { work.active = value?.status === 'active' ? value : null })
// The places worth walking to depend on where the avatar stands: look again when the scene changes.
watch(() => [world.roomKey, world.state], () => { if (work.loaded && world.state === 'ready') void findWork() })

function onUpdate(next: Shift): void {
  if (next.status === 'active') shift.value = next
  else closed(next)
}

function onLeft(left: Shift, next: Career): void {
  if (data.value) data.value.career = next
  closed(left)
}

const STATUS_TITLE: Record<Exclude<Shift['status'], 'active'>, { title: string; art: string; tint: string }> = {
  completed: { title: 'Shift complete', art: '🎉', tint: 'tint-leaf' },
  'left-early': { title: 'You left early', art: '🚪', tint: 'tint-amber' },
  'timed-out': { title: 'This shift closed by itself', art: '⏰', tint: 'tint-coral' },
}
const ended = computed(() => (shift.value && shift.value.status !== 'active' ? STATUS_TITLE[shift.value.status] : null))
const endedText = computed(() => {
  if (!shift.value) return ''
  if (shift.value.status === 'timed-out') return `It ran past ${SHIFT_TIMEOUT_MINUTES} minutes, so the service ended it and paid for the tickets you had finished.`
  if (shift.value.status === 'left-early') return 'Only the tickets you finished were paid, and there is no completion bonus for a shift left early.'
  return 'Every ticket answered. The completion bonus went to your experience.'
})
const RECENT_TEXT: Record<Shift['status'], string> = { active: 'In progress', completed: 'Completed', 'left-early': 'Left early', 'timed-out': `Closed after ${SHIFT_TIMEOUT_MINUTES} minutes` }
const rightCount = (entry: Shift): number => entry.done.filter(task => task.correct).length

/** Daily life: being well fed and rested pays a little more on a finished shift. Said before the shift, and shown after it. */
const form = computed(() => {
  const now = life.state
  if (!now) return null
  if (now.effects.onForm) return { on: true, text: `On form: +${now.effects.shiftBonusPercent}% on this shift` }
  const hungry = now.hunger.value < 60, tired = now.energy.value < 60
  return { on: false, text: hungry && tired ? 'Eat something and rest at home to earn the on-form bonus' : hungry ? 'Eat something to earn the on-form bonus' : 'Rest at home to earn the on-form bonus' }
})
/** The on-form bonus the service paid for the shift on screen, matched by the moment it closed. */
const formBonus = computed(() => {
  const ended = shift.value?.status === 'completed' && shift.value.endedAt ? Date.parse(shift.value.endedAt) : 0
  return ended && life.shift && Math.abs(life.shift.at - ended) < 3000 ? life.shift.bonus : 0
})

usePlayKeys()
</script>

<template>
  <!-- While a shift is played the window is named for its place, so the game needs no heading of its own. -->
  <PanelPage :title="shift?.status === 'active' ? shiftPlace(shift) : 'Go to work'" :subtitle="shift ? undefined : 'A simulated job that pays play-money coins'" wide>
    <StateView v-if="state !== 'ready' || !data || !career" :state="state === 'ready' ? 'loading' : state" :message="error" @retry="reload" />

    <!-- A shift in progress -->
    <ShiftGame
      v-else-if="shift && shift.status === 'active' && place" :key="shift.id" :shift="shift" :place="place" :resumed="resumed"
      @update="onUpdate" @left="onLeft" @stale="reload"
    />

    <!-- How a shift ended -->
    <template v-else-if="shift && ended">
      <section class="card stack result" :class="ended.tint" aria-live="polite">
        <div class="row">
          <span class="art" aria-hidden="true">{{ ended.art }}</span>
          <div class="grow">
            <h2>{{ ended.title }}</h2>
            <p class="muted small wrap">{{ shiftPlace(shift) }}{{ shift.site && workedAt ? `, ${workedAt}` : '' }}</p>
          </div>
        </div>
        <template v-if="result">
          <dl class="figures">
            <div class="figure main"><dt>Coins earned</dt><dd class="num"><span aria-hidden="true">🪙</span> +{{ result.points.toLocaleString() }}</dd></div>
            <div v-if="formBonus" class="figure"><dt>On-form bonus</dt><dd class="num"><span aria-hidden="true">🪙</span> +{{ formBonus }}</dd></div>
            <div class="figure"><dt>Tickets right</dt><dd class="num">{{ rightCount(shift) }} of {{ shift.total }}</dd></div>
            <div class="figure"><dt>{{ SKILL[result.skill].label }} experience</dt><dd class="num">+{{ result.xp }} xp</dd></div>
            <div class="figure">
              <dt>{{ result.titleAfter }}</dt>
              <dd class="num">
                <template v-if="levelled">Level {{ result.levelBefore }} → <strong>{{ result.levelAfter }}</strong> <span aria-hidden="true">⬆️</span></template>
                <template v-else>Level {{ result.levelAfter }}</template>
              </dd>
            </div>
          </dl>
          <p class="small">{{ endedText }}{{ shift.done.length ? '' : ' No tickets were finished, so nothing was paid.' }}</p>
          <details v-if="shift.done.length" class="fold">
            <summary>Each ticket</summary>
            <ol class="tickets">
              <li v-for="task in shift.done" :key="task.index" class="chip" :class="task.correct ? 'leaf' : 'coral'">
                <span aria-hidden="true">{{ task.correct ? '✓' : '✕' }}</span>
                <span class="num">Ticket {{ task.index + 1 }} · {{ task.correct ? `${task.seconds} s · +${task.points}` : 'not right' }}</span>
              </li>
            </ol>
          </details>
        </template>
        <p v-if="!shift.site" class="small muted"><span aria-hidden="true">🧪 </span>This was a practice shift, played away from any workplace.</p>
        <div class="row wrap">
          <button ref="again" class="btn primary" type="button" :disabled="work.starting" @click="another">{{ stillThere ? 'Work another shift here' : shift.site ? 'Find another shift' : 'Find a place to work' }}</button>
          <button v-if="stillThere" class="btn" type="button" @click="stepOut">Step out to the street</button>
        </div>
        <p class="tiny muted">{{ COIN_HONESTY }} They pay for fares, your passport and visas in <RouterLink to="/travel">Travel</RouterLink>.</p>
      </section>
    </template>

    <!-- Workplaces, then the career -->
    <template v-else>
      <!-- A walk to work that is under way, stopped, or has arrived -->
      <section v-if="trip" class="card stack journey" :class="trip.stage === 'ready' ? 'tint-leaf' : trip.stage === 'stopped' ? 'tint-coral' : 'tint-sky'" aria-live="polite">
        <div class="row">
          <span class="icon-chip" :class="SKILL[trip.workplace.skill].tone" aria-hidden="true">{{ SKILL[trip.workplace.skill].icon }}</span>
          <div class="grow">
            <h2 class="truncate">{{ trip.stage === 'ready' ? 'Ready to start' : trip.stage === 'stopped' ? 'The walk to work stopped' : 'On the way to work' }}</h2>
            <p class="small wrap">{{ trip.workplace.role }} · {{ tripLine(trip) }}</p>
          </div>
        </div>
        <p v-if="trip.stage === 'stopped' && trip.misses >= 2" class="small">Carry on to start the shift from the floor of the room instead.</p>
        <div class="row wrap">
          <button v-if="trip.stage === 'ready'" class="btn primary" type="button" :disabled="work.starting" @click="startHere">{{ work.starting ? 'Starting…' : 'Start shift' }}</button>
          <button v-else-if="trip.stage === 'stopped'" class="btn primary" type="button" @click="resumeTrip">Carry on</button>
          <button v-if="moving" class="btn primary" type="button" @click="router.push('/')">Watch the walk</button>
          <button class="btn" type="button" @click="cancelTrip">{{ trip.stage === 'ready' ? 'Not now' : 'Call it off' }}</button>
        </div>
        <p v-if="trip.stage !== 'ready'" class="tiny muted">The shift and its clock start only when you press Start there.</p>
      </section>

      <div class="row between wrap list-head">
        <h2>{{ trip ? 'Other places to work' : 'Where to work' }}</h2>
        <span v-if="work.searching" class="tiny muted" role="status">Measuring the walks…</span>
        <button v-else class="btn ghost sm" type="button" title="Walks are measured from where your character stood when this window opened" @click="findWork">Measure again</button>
      </div>
      <p v-if="form" class="small form" :class="{ on: form.on }"><span aria-hidden="true">{{ form.on ? '✦' : '🍲' }} </span>{{ form.text }}</p>
      <p v-if="nowhere" class="notice amber">
        <span class="grow">No workplace can be walked to from where you stand. Look for one on the map, or take a practice shift below.</span>
        <RouterLink class="btn sm" to="/map">Open the map</RouterLink>
      </p>
      <ul class="places">
        <li v-for="workplace in data.workplaces" :key="workplace.id" class="card stack tight place">
          <div class="row">
            <span class="icon-chip" :class="SKILL[workplace.skill].tone" aria-hidden="true">{{ SKILL[workplace.skill].icon }}</span>
            <div class="grow">
              <h3 class="truncate">{{ workplace.name }}</h3>
              <span class="muted tiny">{{ workplace.role }} · builds {{ SKILL[workplace.skill].label.toLowerCase() }}</span>
            </div>
          </div>

          <!-- The nearest place that can host this job and can be walked to -->
          <template v-if="work.options[workplace.id]?.spots.length">
            <div class="row spot">
              <span class="grow">
                <strong class="truncate block">{{ work.options[workplace.id]!.spots[0]!.poi.name }}</strong>
                <span class="muted tiny">{{ spotWords(work.options[workplace.id]!.spots[0]!) }}</span>
              </span>
              <button
                class="btn" :class="{ primary: workplace.id === bestId }" type="button" :disabled="Boolean(going) || Boolean(starting)"
                :aria-label="`${goLabel(work.options[workplace.id]!.spots[0]!)}: ${workplace.role} at ${work.options[workplace.id]!.spots[0]!.poi.name}`" @click="go(workplace, work.options[workplace.id]!.spots[0]!)"
              >{{ going === workplace.id ? 'Setting off…' : goLabel(work.options[workplace.id]!.spots[0]!) }}</button>
            </div>
          </template>
          <div v-else-if="!work.options[workplace.id]" class="skeleton" style="height: 46px" role="status" aria-label="Looking for places to work"></div>
          <!-- Nowhere to do this job from here: say why, and offer practice, labelled as practice -->
          <template v-else>
            <p class="small unavailable"><span aria-hidden="true">🚧 </span>{{ why(workplace) }}</p>
            <button class="btn" type="button" :disabled="Boolean(starting) || Boolean(going)" @click="practise(workplace)">{{ starting === workplace.id ? 'Starting…' : 'Practice shift instead' }}</button>
            <p class="tiny muted">Practice is played in this window and recorded as practice, not as worked at a place.</p>
          </template>

          <details class="fold">
            <summary>About this job</summary>
            <div class="stack tight">
              <p class="small">{{ workplace.about }}</p>
              <p class="tiny muted num">
                {{ workplace.tasksPerShift }} tickets a shift. {{ PAY.ticket }} coins for each right ticket, up to {{ PAY.speedBonus }} more for speed: at most {{ coins(workplace.tasksPerShift * (PAY.ticket + PAY.speedBonus)) }}.
              </p>
              <div v-for="spot in work.options[workplace.id]?.spots.slice(1, 3) ?? []" :key="spot.poi.placeId" class="row spot">
                <span class="grow">
                  <strong class="truncate block">{{ spot.poi.name }}</strong>
                  <span class="muted tiny">{{ spotWords(spot) }}</span>
                </span>
                <button class="btn sm" type="button" :disabled="Boolean(going) || Boolean(starting)" :aria-label="`${goLabel(spot)}: ${workplace.role} at ${spot.poi.name}`" @click="go(workplace, spot)">{{ goLabel(spot) }}</button>
              </div>
            </div>
          </details>
        </li>
      </ul>

      <details class="disclosure">
        <summary>Your game career <span class="chip leaf num">{{ count(career.shifts.completed, 'shift') }} completed</span></summary>
        <div class="stack">
          <ul class="skills">
            <li v-for="row in skillRows" :key="row.name" class="skill">
              <span class="icon-chip" :class="row.tone" aria-hidden="true">{{ row.icon }}</span>
              <div class="grow">
                <strong class="truncate block">{{ row.title }}</strong>
                <div class="xp" role="progressbar" :aria-label="`${row.label} experience toward level ${row.level + 1}`" aria-valuemin="0" :aria-valuemax="row.span" :aria-valuenow="row.into">
                  <div class="xp-fill" :class="row.tone" :style="{ width: `${row.share * 100}%` }"></div>
                </div>
                <span class="tiny muted num">{{ row.label }} level {{ row.level }} · {{ row.into }} of {{ row.span }} xp to level {{ row.level + 1 }}</span>
              </div>
            </li>
          </ul>
          <p class="tiny muted num">Your coins: <span aria-hidden="true">🪙</span> {{ career.points.toLocaleString() }} · {{ count(career.shifts.completed, 'shift') }} completed · {{ career.shifts.leftEarly }} left early</p>
        </div>
      </details>

      <details v-if="career.recent.length" class="disclosure">
        <summary>Recent shifts <span class="chip num">{{ career.recent.length }}</span></summary>
        <ul class="recent">
          <li v-for="entry in career.recent" :key="entry.id" class="list-row">
            <div class="grow">
              <strong class="truncate block">{{ shiftPlace(entry) }}</strong>
              <span class="muted tiny num">{{ RECENT_TEXT[entry.status] }} · {{ rightCount(entry) }} of {{ entry.total }} right{{ entry.endedAt ? ` · ${relativeTime(entry.endedAt)}` : '' }}</span>
            </div>
            <span class="chip amber num">+{{ coins(entry.result?.points ?? 0) }}</span>
          </li>
        </ul>
      </details>

      <p class="tiny muted">
        This is a game. {{ COIN_HONESTY }} A level is not a real qualification — real jobs are under <RouterLink to="/jobs">Jobs</RouterLink>.
      </p>
    </template>
  </PanelPage>
</template>

<style scoped>
.block { display: block; }
.wrap { overflow-wrap: anywhere; }
.list-head { gap: 8px; }
.form { color: #6f4500; }
.form.on { color: #1c5c39; font-weight: 650; }
.notice { align-items: center; flex-wrap: wrap; }
.notice a.btn { text-decoration: none; }

.places { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.place { min-width: 0; gap: 8px; }
.spot { gap: 8px 10px; min-width: 0; flex-wrap: wrap; }
.spot .grow { flex-basis: 120px; }
.spot .btn { flex: none; }
.unavailable { color: #6f4500; }
.place > .btn { align-self: flex-start; }
.journey { animation: arrive 0.3s ease; }

/* Inside a card, detail folds away behind a plain line of text; whole sections use the shared disclosure. */
.fold > summary { display: flex; align-items: center; gap: 8px; min-height: 36px; cursor: pointer; font-size: 0.8rem; font-weight: 650; color: var(--accent-text); }
.fold[open] > summary { margin-bottom: 6px; }
.place .fold { margin-top: -4px; }

.skills { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 12px; }
.skill { display: flex; gap: 10px; align-items: flex-start; min-width: 0; }
.xp { height: 8px; margin: 5px 0 3px; border-radius: 999px; background: rgba(28, 26, 36, 0.1); overflow: hidden; }
.xp-fill { height: 100%; border-radius: 999px; background: var(--accent-strong); transition: width 0.4s ease; }
.xp-fill.sky { background: var(--sky); }
.xp-fill.grape { background: var(--grape); }
.recent { list-style: none; margin: 0; padding: 0; }
.recent .list-row + .list-row { border-top: 1px solid var(--line); }

.result { animation: arrive 0.3s ease; }
.art { font-size: 2.2rem; line-height: 1; }
.figures { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 8px; margin: 0; }
.figure { padding: 8px 12px; border-radius: 12px; background: rgba(255, 255, 255, 0.75); border: 1px solid var(--line); }
.figure dt { font-size: 0.76rem; font-weight: 650; color: var(--muted); }
.figure dd { margin: 0; font-size: 1.05rem; font-weight: 750; }
.figure.main { grid-column: 1 / -1; }
.figure.main dd { font-size: 1.6rem; color: var(--accent-text); }
.tickets { display: flex; flex-wrap: wrap; gap: 6px; list-style: none; margin: 0; padding: 0; }
@keyframes arrive { from { transform: scale(0.97); opacity: 0; } }
/* Small buttons grow to a full touch target on touch screens. */
@media (pointer: coarse) { .fold > summary { min-height: 44px; } }
</style>
