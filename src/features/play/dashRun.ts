// The rules of one Lane Dash run, without a clock or a canvas: record lane changes, judge rows as
// their ticks arrive, and produce the input log the service will replay.
//
// The log must be a legal game for `replayDash` (src/shared/play.ts) or an honest run is refused:
//   · ticks are integers and strictly increasing,
//   · every change moves exactly one lane and stays on the track,
//   · nothing is logged after the tick the run ended on.
// A row is judged the moment its tick begins. A press made during tick T is logged as tick T + 1,
// so it can never rewrite a row that was already judged, and the service's replay reads the log
// exactly as it was played. Each row is judged by `replayDash` itself over the course so far.
import { DASH, buildDashCourse, replayDash } from '../../shared/play.ts'
import type { DashCourse, DashInput } from '../../shared/play.ts'

/** The service reads at most this many lane changes in one run. */
const MAX_INPUTS = 400
/** A quick second press waits its turn, but only this many ticks. */
const MAX_QUEUE_TICKS = 3

export interface DashRun {
  readonly course: DashCourse
  readonly rows: number
  /** Tick of the last row. */
  readonly lastTick: number
  /** Live figures from the replay so far. The final score is the service's, not this. */
  readonly stats: { score: number; rows: number; gems: number }
  /** Rows whose gem was picked up. */
  readonly collected: ReadonlySet<number>
  /** Lane after every recorded change. */
  readonly lane: number
  /** First row not judged yet. */
  readonly nextRow: number
  /** Set once the run is over: the tick it ended on and whether it was a crash. */
  readonly end: { tick: number; crashed: boolean } | null
  /** Judge every row whose tick has begun. `tick` is the current whole tick. */
  advance(tick: number): void
  /** Record a lane change made during `tick`. False when it was not taken. */
  steer(tick: number, direction: -1 | 1): boolean
  /** The lane changes to hand in: everything up to the end tick, nothing after. */
  log(): DashInput[]
}

export function createDashRun(seed: number): DashRun {
  const course = buildDashCourse(seed)
  const rows = course.rowTick.length
  const inputs: DashInput[] = []
  const collected = new Set<number>()
  const stats = { score: 0, rows: 0, gems: 0 }
  let processed = 0
  let nextRow = 0
  let lane = 1
  let end: { tick: number; crashed: boolean } | null = null

  function judge(row: number, tick: number): void {
    const soFar: DashCourse = { blocked: course.blocked.slice(0, row + 1), coins: course.coins.slice(0, row + 1), rowTick: course.rowTick.slice(0, row + 1) }
    const outcome = replayDash(soFar, inputs.filter(input => input.tick <= tick))
    // A log recorded here always replays. If it ever did not, stop and let the service say so.
    if (!outcome) { end = { tick, crashed: true }; return }
    if (outcome.coins > stats.gems) collected.add(row)
    stats.score = outcome.score
    stats.rows = outcome.rows
    stats.gems = outcome.coins
    if (outcome.crashed) { end = { tick, crashed: true }; return }
    nextRow = row + 1
    if (nextRow === rows) end = { tick, crashed: false }
  }

  function advance(tick: number): void {
    while (!end && processed < tick) {
      processed++
      if (course.rowTick[nextRow] === processed) judge(nextRow, processed)
    }
  }

  function steer(tick: number, direction: -1 | 1): boolean {
    advance(tick)
    if (end) return false
    const target = lane + direction
    if (target < 0 || target >= DASH.lanes) return false
    const current = Math.max(Math.floor(tick), processed)
    const previous = inputs.length ? inputs[inputs.length - 1]!.tick : -1
    const at = Math.max(current + 1, previous + 1)
    if (at > current + MAX_QUEUE_TICKS || inputs.length >= MAX_INPUTS) return false
    inputs.push({ tick: at, lane: target })
    lane = target
    return true
  }

  return {
    course, rows, lastTick: course.rowTick[rows - 1]!, stats, collected,
    get lane() { return lane },
    get nextRow() { return nextRow },
    get end() { return end },
    advance, steer,
    log: () => (end ? inputs.filter(input => input.tick <= end!.tick) : [...inputs]),
  }
}
