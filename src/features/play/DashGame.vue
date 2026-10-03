<script setup lang="ts">
// Lane Dash, played: the clock, the canvas and the controls. The course comes from the seed the
// service issued; dashRun.ts records the lane changes and judges the run with the same
// `replayDash` the service uses. The score shown at the end is the service's, never one computed here.
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { DASH } from '../../shared/play.ts'
import type { DashAttempt, DashResult } from '../../shared/play.ts'
import { api, app, messageOf, refreshPoints } from '../../state/app.ts'
import { createDashRun } from './dashRun.ts'
import { usePlayKeys } from './keys.ts'
import { PAY, REJECT_TEXT, coins, dashCoins } from './playText.ts'

const props = defineProps<{ attempt: DashAttempt }>()
const emit = defineEmits<{ result: [result: DashResult] }>()

type Phase = 'countdown' | 'playing' | 'paused' | 'sending' | 'accepted' | 'rejected' | 'failed' | 'lapsed'
const phase = ref<Phase>('countdown')
const count = ref(3)
const hud = reactive({ score: 0, rows: 0, gems: 0 })
const crashed = ref(false)
const result = ref<DashResult | null>(null)
const failure = ref('')
const stage = ref<HTMLDivElement | null>(null)
const canvasEl = ref<HTMLCanvasElement | null>(null)
const verdict = ref<HTMLDivElement | null>(null)

const run = createDashRun(props.attempt.seed)
const course = run.course
const ROWS = run.rows
const COUNT_STEP_MS = 800
/** Height kept free under the track for the two pads and the window's bottom padding. */
const PADS_SPACE = 104

const over = computed(() => ['accepted', 'rejected', 'failed', 'lapsed'].includes(phase.value))
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches || Boolean(app.me?.preferences.reducedMotion)

// ── The run ──
// Game time is real time: tick = floor((now − startAt) / tickMs), from a start time that only a
// pause moves. The rules of the run and of its input log live in dashRun.ts.

let startAt = 0
let pausedAt = 0
let resuming = false
let alive = true

const mountedAt = performance.now()
/** Our clock's latest moment for the run to be over and still reach the service before its deadline. */
const deadline = mountedAt + (Date.parse(props.attempt.mustSubmitBy) - Date.parse(props.attempt.startedAt)) - 4000
const playedTicks = (): number => (startAt ? ((pausedAt || performance.now()) - startAt) / DASH.tickMs : 0)
const stillFits = (delayMs: number): boolean => performance.now() + delayMs + (run.lastTick - playedTicks()) * DASH.tickMs <= deadline
const tickAt = (now: number): number => Math.floor((now - startAt) / DASH.tickMs)

/** Bring the run up to `now`; when that ends it, hand it in. */
function advance(now: number): void {
  if (phase.value !== 'playing') return
  run.advance(tickAt(now))
  hud.score = run.stats.score
  hud.rows = run.stats.rows
  hud.gems = run.stats.gems
  if (!run.end) return
  crashed.value = run.end.crashed
  effectsUntil = now + 700
  if (run.end.crashed && !reduced) shakeUntil = now + 320
  void submit()
}

function steer(direction: -1 | 1): void {
  if (phase.value !== 'playing') return
  const now = performance.now()
  advance(now)
  if (phase.value === 'playing') run.steer(tickAt(now), direction)
}

async function submit(): Promise<void> {
  phase.value = 'sending'
  failure.value = ''
  try {
    // Only what happened up to the end tick is handed in; a press queued for later is not part of the game.
    const answer = await api('dash.submit', { attemptToken: props.attempt.attemptToken, inputs: run.log() })
    if (!alive) return
    result.value = answer
    phase.value = answer.accepted ? 'accepted' : 'rejected'
    if (answer.accepted) void refreshPoints()
    emit('result', answer)
  } catch (error) {
    if (!alive) return
    failure.value = messageOf(error)
    phase.value = 'failed'
  }
  draw()
  void nextTick(() => verdict.value?.focus())
}

// ── Countdown, pause, resume ──

let countTimer = 0
function countdown(): void {
  phase.value = 'countdown'
  count.value = 3
  window.clearInterval(countTimer)
  countTimer = window.setInterval(() => {
    if (--count.value > 0) return
    window.clearInterval(countTimer)
    const now = performance.now()
    if (resuming) startAt += now - pausedAt
    else startAt = now
    pausedAt = 0
    resuming = false
    phase.value = 'playing'
    kick()
  }, COUNT_STEP_MS)
  kick()
}

function pause(): void {
  if (phase.value === 'playing') {
    const now = performance.now()
    advance(now)
    if (phase.value !== 'playing') return
    pausedAt = now
    resuming = true
    phase.value = 'paused'
  } else if (phase.value === 'countdown') {
    window.clearInterval(countTimer)
    phase.value = 'paused'
  }
}

function resume(): void {
  if (phase.value !== 'paused') return
  if (!stillFits(3 * COUNT_STEP_MS)) { phase.value = 'lapsed'; return }
  countdown()
}

function onVisibility(): void {
  if (document.hidden) pause()
  else if (phase.value === 'paused' && !stillFits(3 * COUNT_STEP_MS)) phase.value = 'lapsed'
  draw()
}

// ── Controls ──

usePlayKeys(event => {
  if (over.value || phase.value === 'sending') return false
  if (event.code === 'ArrowLeft' || event.code === 'KeyA') { if (!event.repeat) steer(-1); return true }
  if (event.code === 'ArrowRight' || event.code === 'KeyD') { if (!event.repeat) steer(1); return true }
  // The avatar behind the window stays put while a run is on.
  return ['ArrowUp', 'ArrowDown', 'KeyW', 'KeyS'].includes(event.code)
})

let swipe: { x: number; moved: boolean } | null = null
function pointerDown(event: PointerEvent): void {
  swipe = { x: event.clientX, moved: false }
  canvasEl.value?.setPointerCapture(event.pointerId)
}
function pointerMove(event: PointerEvent): void {
  if (!swipe) return
  const dx = event.clientX - swipe.x
  if (Math.abs(dx) < 28) return
  steer(dx > 0 ? 1 : -1)
  swipe = { x: event.clientX, moved: true }
}
function pointerUp(event: PointerEvent): void {
  const canvas = canvasEl.value
  // A tap (no swipe) moves one lane toward the lane that was tapped.
  if (swipe && !swipe.moved && canvas) {
    const bounds = canvas.getBoundingClientRect()
    const tapped = Math.max(0, Math.min(DASH.lanes - 1, Math.floor(((event.clientX - bounds.left) / bounds.width) * DASH.lanes)))
    if (tapped !== run.lane) steer(tapped > run.lane ? 1 : -1)
  }
  swipe = null
}
/** Pads act on pointer-down for speed; a click with no pointer behind it is the keyboard. */
function padClick(event: MouseEvent, direction: -1 | 1): void { if (event.detail === 0) steer(direction) }

// ── Drawing ──

const color = { ink: '#1c1a24', coral: '#f0553a', leaf: '#2f9d62', sky: '#2f8fd6', accent: '#ffb020', surface: '#fffdf9' }
let cssW = 320, cssH = 384, dpr = 1
let runnerX = 1
let lastDraw = 0
let shakeUntil = 0
let effectsUntil = 0
let raf = 0

function tickFloat(now: number): number {
  if (run.end) return run.end.tick
  if (phase.value === 'playing') return (now - startAt) / DASH.tickMs
  return resuming ? (pausedAt - startAt) / DASH.tickMs : 0
}

/** Rows scrolled past the runner, as a fraction: row r sits on the runner exactly at its tick. */
function rowAt(tick: number): number {
  let row = Math.min(run.nextRow, ROWS - 1)
  while (row < ROWS && course.rowTick[row]! <= tick) row++
  while (row > 0 && course.rowTick[row - 1]! > tick) row--
  if (row >= ROWS) return ROWS - 1 + (tick - run.lastTick) / DASH.ticksPerRowEnd
  const before = row > 0 ? course.rowTick[row - 1]! : 0
  return row - 1 + (tick - before) / (course.rowTick[row]! - before)
}

function box(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r)
  else ctx.rect(x, y, w, h)
}

function draw(): void {
  const canvas = canvasEl.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx) return
  const now = performance.now()
  const dt = Math.min(0.05, (now - lastDraw) / 1000)
  lastDraw = now
  const w = cssW, h = cssH
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, w, h)
  ctx.save()
  box(ctx, 0, 0, w, h, 18)
  ctx.clip()
  ctx.fillStyle = color.ink
  ctx.fillRect(0, 0, w, h)
  if (now < shakeUntil) ctx.translate((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 6)

  const pad = 8
  const laneW = (w - pad * 2) / DASH.lanes
  const cell = Math.min(laneW, h / 5)
  const runnerY = h - cell * 0.85
  const pos = rowAt(tickFloat(now))
  const laneX = (lane: number): number => pad + laneW * (lane + 0.5)

  ctx.fillStyle = 'rgba(255, 255, 255, 0.05)'
  ctx.fillRect(pad + laneW, 0, laneW, h)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.24)'
  ctx.lineWidth = 2
  const period = cell * 0.5
  ctx.setLineDash([period * 0.56, period * 0.44])
  ctx.lineDashOffset = -((pos * cell) % period)
  for (let lane = 1; lane < DASH.lanes; lane++) {
    ctx.beginPath()
    ctx.moveTo(pad + laneW * lane, 0)
    ctx.lineTo(pad + laneW * lane, h)
    ctx.stroke()
  }
  ctx.setLineDash([])

  // Finish line, one row beyond the last.
  const finishY = runnerY - (ROWS - pos) * cell
  if (finishY > -20 && finishY < h + 20) {
    const size = 10
    for (let n = 0; n * size < w; n++) for (let line = 0; line < 2; line++) {
      ctx.fillStyle = (n + line) % 2 === 0 ? color.surface : 'rgba(255, 255, 255, 0.15)'
      ctx.fillRect(n * size, finishY - size + line * size, size, size)
    }
  }

  const first = Math.max(0, Math.floor(pos - 1.5))
  const lastVisible = Math.min(ROWS - 1, Math.ceil(pos + h / cell + 1))
  for (let row = first; row <= lastVisible; row++) {
    const y = runnerY - (row - pos) * cell
    ctx.globalAlpha = row < run.nextRow ? 0.28 : 1
    const blocked = course.blocked[row]!
    for (let lane = 0; lane < DASH.lanes; lane++) {
      if (!blocked[lane]) continue
      const bw = laneW * 0.8, bh = cell * 0.44
      box(ctx, laneX(lane) - bw / 2, y - bh / 2, bw, bh, 9)
      ctx.fillStyle = color.coral
      ctx.fill()
      box(ctx, laneX(lane) - bw / 2 + 5, y - bh / 2 + 4, bw - 10, Math.max(3, bh * 0.2), 3)
      ctx.fillStyle = 'rgba(255, 255, 255, 0.35)'
      ctx.fill()
    }
    const gem = course.coins[row]
    if (gem !== null && gem !== undefined && !run.collected.has(row)) {
      const x = laneX(gem), r = cell * 0.17
      ctx.beginPath()
      ctx.moveTo(x, y - r)
      ctx.lineTo(x + r * 0.8, y)
      ctx.lineTo(x, y + r)
      ctx.lineTo(x - r * 0.8, y)
      ctx.closePath()
      ctx.fillStyle = color.leaf
      ctx.fill()
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)'
      ctx.stroke()
    }
  }
  ctx.globalAlpha = 1

  // The runner glides to the lane it was sent to; the judging itself is by ticks, not by this glide.
  runnerX += (run.lane - runnerX) * (reduced ? 1 : Math.min(1, dt * 22))
  const x = pad + laneW * (runnerX + 0.5)
  const size = Math.min(laneW, cell) * 0.5
  ctx.beginPath()
  ctx.ellipse(x, runnerY + size * 0.52, size * 0.5, size * 0.14, 0, 0, Math.PI * 2)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)'
  ctx.fill()
  box(ctx, x - size / 2, runnerY - size / 2, size, size, size * 0.3)
  ctx.fillStyle = crashed.value ? color.surface : color.sky
  ctx.fill()
  ctx.lineWidth = 3
  ctx.strokeStyle = crashed.value ? color.coral : color.surface
  ctx.stroke()
  ctx.fillStyle = crashed.value ? color.coral : color.surface
  for (const side of [-1, 1]) {
    ctx.beginPath()
    ctx.arc(x + side * size * 0.17, runnerY - size * 0.1, size * 0.08, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.restore()
}

function kick(): void { if (!raf && alive) raf = requestAnimationFrame(frame) }
function frame(): void {
  raf = 0
  const now = performance.now()
  advance(now)
  draw()
  if (phase.value === 'playing' || phase.value === 'countdown' || now < effectsUntil) kick()
}

function measure(): void {
  const holder = stage.value, canvas = canvasEl.value
  if (!holder || !canvas) return
  cssW = Math.max(240, Math.min(420, Math.floor(holder.clientWidth)))
  // The track takes what is left of the window above the pads, so on a phone both stay in view.
  const scroller = holder.closest<HTMLElement>('.panel-body')
  const room = scroller
    ? scroller.clientHeight - (holder.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop) - PADS_SPACE
    : window.innerHeight - 360
  cssH = Math.round(Math.max(230, Math.min(cssW * 1.2, room)))
  dpr = Math.min(3, window.devicePixelRatio || 1)
  canvas.width = Math.round(cssW * dpr)
  canvas.height = Math.round(cssH * dpr)
  canvas.style.width = `${cssW}px`
  canvas.style.height = `${cssH}px`
  draw()
}

let observer: ResizeObserver | null = null
let lapseTimer = 0
onMounted(() => {
  const css = getComputedStyle(document.documentElement)
  for (const name of Object.keys(color) as (keyof typeof color)[]) {
    const value = css.getPropertyValue(`--${name}`).trim()
    if (value) color[name] = value
  }
  measure()
  if (stage.value) { observer = new ResizeObserver(measure); observer.observe(stage.value) }
  window.addEventListener('resize', measure)
  document.addEventListener('visibilitychange', onVisibility)
  lapseTimer = window.setInterval(() => { if (phase.value === 'paused' && !stillFits(3 * COUNT_STEP_MS)) phase.value = 'lapsed' }, 1000)
  if (document.hidden) phase.value = 'paused'
  else countdown()
})

// Leaving mid-run abandons it: nothing is handed in, and nothing keeps running.
onBeforeUnmount(() => {
  alive = false
  cancelAnimationFrame(raf)
  window.clearInterval(countTimer)
  window.clearInterval(lapseTimer)
  observer?.disconnect()
  window.removeEventListener('resize', measure)
  document.removeEventListener('visibilitychange', onVisibility)
})
</script>

<template>
  <div class="dash">
    <div class="hud">
      <div class="stat"><span class="muted tiny">Score</span><strong class="num">{{ hud.score }}</strong></div>
      <div class="stat"><span class="muted tiny">Gems</span><strong class="num"><span class="gem" aria-hidden="true"></span>{{ hud.gems }}</strong></div>
      <div class="stat grow">
        <span class="muted tiny num">Row {{ hud.rows }} of {{ ROWS }}</span>
        <div class="bar" aria-hidden="true"><div class="fill" :style="{ width: `${(hud.rows / ROWS) * 100}%` }"></div></div>
      </div>
    </div>

    <div ref="stage" class="stage">
      <canvas
        ref="canvasEl" class="canvas" role="img" aria-label="Lane Dash track: three lanes scroll toward your runner at the bottom. Barriers block lanes and gems add to the score."
        @pointerdown="pointerDown" @pointermove="pointerMove" @pointerup="pointerUp" @pointercancel="swipe = null"
      ></canvas>
      <div v-if="phase === 'countdown'" class="over" role="status" aria-live="assertive">
        <span class="count num">{{ count }}</span>
        <span class="small">Dodge the barriers. Change lane with <span class="kbd">←</span> <span class="kbd">→</span>, by tapping the lane you want, or by swiping.</span>
      </div>
      <div v-else-if="phase === 'paused'" class="over" role="status">
        <strong>Paused</strong>
        <span class="small">The run waits while this tab is out of view, for up to about a minute.</span>
        <button class="btn primary" type="button" @click="resume">Resume</button>
      </div>
      <div v-else-if="phase === 'sending'" class="over soft" role="status">
        <strong>{{ crashed ? 'You hit a barrier' : 'Course cleared' }}</strong>
        <span class="small">Checking your run with the service…</span>
      </div>
    </div>

    <template v-if="!over">
      <div class="pads">
        <button class="pad" type="button" aria-label="Move left" :disabled="phase !== 'playing'" @pointerdown.prevent="steer(-1)" @click="padClick($event, -1)"><span aria-hidden="true">←</span></button>
        <button class="pad" type="button" aria-label="Move right" :disabled="phase !== 'playing'" @pointerdown.prevent="steer(1)" @click="padClick($event, 1)"><span aria-hidden="true">→</span></button>
      </div>
      <p class="muted tiny hint">Each row passed is {{ DASH.rowValue }} score and each gem {{ DASH.coinValue }}. It speeds up. The service replays your lane changes to work out the score.</p>
    </template>

    <div v-else ref="verdict" class="card stack verdict" :class="phase === 'accepted' ? 'tint-leaf' : 'tint-coral'" tabindex="-1" role="status">
      <template v-if="phase === 'accepted' && result?.outcome">
        <div class="row between wrap">
          <div>
            <span class="chip leaf">Run counted</span>
            <div class="score num">{{ result.outcome.score }} <span class="small muted">score</span></div>
          </div>
          <div class="earned num"><span aria-hidden="true">🪙</span> +{{ coins(dashCoins(result.outcome.score)) }}</div>
        </div>
        <p class="small">
          {{ result.outcome.crashed ? `You hit a barrier on row ${result.outcome.rows + 1} of ${ROWS}.` : 'You cleared the whole course.' }}
          <span class="num">{{ result.outcome.rows }} rows passed, {{ result.outcome.coins }} {{ result.outcome.coins === 1 ? 'gem' : 'gems' }}.</span>
          This score was worked out by the service. A counted run pays 1 coin for every {{ PAY.dashScorePerCoin }} score.
        </p>
      </template>
      <template v-else-if="phase === 'rejected'">
        <span class="chip coral" style="align-self: flex-start">Run not counted</span>
        <p>{{ result?.reason ? REJECT_TEXT[result.reason] : 'The service did not accept this run.' }}</p>
      </template>
      <template v-else-if="phase === 'failed'">
        <span class="chip coral" style="align-self: flex-start">Not sent yet</span>
        <p>Your run could not reach the service. {{ failure }}</p>
        <div class="row"><button class="btn primary" type="button" @click="submit">Send it again</button></div>
      </template>
      <template v-else>
        <span class="chip coral" style="align-self: flex-start">Run ended</span>
        <p>This run stayed paused past its deadline, so it cannot be counted. Nothing was handed in.</p>
      </template>
      <slot name="actions" :phase="phase" />
    </div>
  </div>
</template>

<style scoped>
.dash { display: flex; flex-direction: column; align-items: center; gap: 10px; }
.dash > * { width: 100%; max-width: 420px; }
.hud { display: flex; align-items: flex-end; gap: 14px; }
.stat { display: flex; flex-direction: column; min-width: 0; }
.stat strong { font-size: 1.2rem; line-height: 1.2; display: flex; align-items: center; gap: 5px; }
.gem { width: 10px; height: 10px; background: var(--leaf); transform: rotate(45deg) scale(0.9, 1.1); border-radius: 2px; }
.bar { height: 8px; margin: 6px 0 5px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.fill { height: 100%; border-radius: 999px; background: var(--sky); }

.stage { position: relative; display: grid; justify-items: center; }
.canvas { display: block; border-radius: 18px; touch-action: none; box-shadow: var(--shadow); cursor: pointer; }
.over { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; padding: 18px; border-radius: 18px; background: rgba(28, 26, 36, 0.62); color: #fff; text-align: center; pointer-events: none; }
.over .btn { pointer-events: auto; }
.over.soft { background: rgba(28, 26, 36, 0.45); justify-content: flex-start; padding-top: 22%; }
.over .kbd { color: var(--ink); }
.count { font-size: 4.2rem; font-weight: 800; line-height: 1; }

.pads { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.pad { min-height: 66px; border-radius: 18px; border: 1px solid var(--line-strong); background: var(--surface); box-shadow: 0 4px 0 var(--line-strong); font-size: 1.7rem; font-weight: 800; touch-action: manipulation; user-select: none; -webkit-user-select: none; }
.pad:active:not(:disabled) { transform: translateY(3px); box-shadow: 0 1px 0 var(--line-strong); background: var(--sky-soft); }
.pad:disabled { opacity: 0.5; cursor: default; }
.hint { text-align: center; }

.verdict { outline-offset: 3px; }
.score { font-size: 2rem; font-weight: 800; line-height: 1.15; letter-spacing: -0.02em; }
.earned { font-size: 1.2rem; font-weight: 750; color: var(--accent-text); }
</style>
