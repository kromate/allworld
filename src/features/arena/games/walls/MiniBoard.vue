<script setup lang="ts">
// A small corner of a Ten Walls board, drawn for the how-to-play. Row 0 is at the bottom, like
// the real board seen from the first seat.
import { computed } from 'vue'

interface Spot { col: number; row: number }
const props = defineProps<{
  cols: number
  rows: number
  /** What the picture shows, for people who cannot see it. */
  label: string
  pawns?: (Spot & { seat: number })[]
  /** `bad` draws a wall that is not allowed. */
  walls?: (Spot & { dir: 'across' | 'along'; seat?: number; bad?: boolean })[]
  /** Squares a pawn may move to. */
  dots?: Spot[]
  arrows?: { from: Spot; to: Spot; bad?: boolean }[]
  /** Rows tinted as a goal: the row index and the seat racing to it. */
  goals?: { row: number; seat: number }[]
}>()

const CELL = 20, GAP = 5, PITCH = CELL + GAP, EDGE = 5
const width = computed(() => props.cols * PITCH - GAP + EDGE * 2)
const height = computed(() => props.rows * PITCH - GAP + EDGE * 2)
const x = (col: number): number => EDGE + col * PITCH
const y = (row: number): number => EDGE + (props.rows - 1 - row) * PITCH
const cx = (col: number): number => x(col) + CELL / 2
const cy = (row: number): number => y(row) + CELL / 2
const cells = computed(() => Array.from({ length: props.cols * props.rows }, (_, index) => ({ col: index % props.cols, row: Math.floor(index / props.cols) })))
const goalOf = (row: number): number | null => props.goals?.find(goal => goal.row === row)?.seat ?? null

function wallBox(wall: Spot & { dir: 'across' | 'along' }): { x: number; y: number; width: number; height: number } {
  return wall.dir === 'across'
    ? { x: x(wall.col), y: y(wall.row) - GAP, width: CELL * 2 + GAP, height: GAP }
    : { x: x(wall.col) + CELL, y: y(wall.row + 1), width: GAP, height: CELL * 2 + GAP }
}
/** An arrow stops short of the middle of its last square so the head does not hide a pawn or dot. */
function line(arrow: { from: Spot; to: Spot }): { x1: number; y1: number; x2: number; y2: number } {
  const x1 = cx(arrow.from.col), y1 = cy(arrow.from.row), endX = cx(arrow.to.col), endY = cy(arrow.to.row)
  const length = Math.hypot(endX - x1, endY - y1) || 1
  const trim = 5 / length
  return { x1: x1 + (endX - x1) * trim * 1.6, y1: y1 + (endY - y1) * trim * 1.6, x2: endX - (endX - x1) * trim, y2: endY - (endY - y1) * trim }
}
</script>

<template>
  <svg class="mini" :viewBox="`0 0 ${width} ${height}`" role="img" :aria-label="label">
    <defs>
      <marker id="tw-arrow-ok" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#2c2433" /></marker>
      <marker id="tw-arrow-bad" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="#b3261e" /></marker>
    </defs>
    <rect :width="width" :height="height" rx="7" fill="#5b3a21" />
    <rect v-for="cell in cells" :key="`${cell.col}-${cell.row}`" :x="x(cell.col)" :y="y(cell.row)" :width="CELL" :height="CELL" rx="3.5"
      :class="['tile', goalOf(cell.row) === null ? '' : `goal${goalOf(cell.row)}`]" />
    <circle v-for="dot in dots ?? []" :key="`d${dot.col}-${dot.row}`" :cx="cx(dot.col)" :cy="cy(dot.row)" r="3.6" class="dot" />
    <g v-for="(wall, index) in walls ?? []" :key="`w${index}`">
      <rect v-bind="wallBox(wall)" rx="2.5" :class="['wall', wall.bad ? 'bad' : `s${wall.seat ?? 0}`]" />
    </g>
    <line v-for="(arrow, index) in arrows ?? []" :key="`a${index}`" v-bind="line(arrow)" :class="['arrow', { bad: arrow.bad }]" :marker-end="`url(#tw-arrow-${arrow.bad ? 'bad' : 'ok'})`" />
    <g v-for="(arrow, index) in (arrows ?? []).filter(item => item.bad)" :key="`x${index}`" class="cross">
      <path :d="`M${(cx(arrow.from.col) + cx(arrow.to.col)) / 2 - 3.2} ${(cy(arrow.from.row) + cy(arrow.to.row)) / 2 - 3.2}l6.4 6.4m0 -6.4l-6.4 6.4`" />
    </g>
    <g v-for="pawn in pawns ?? []" :key="`p${pawn.seat}`">
      <circle :cx="cx(pawn.col)" :cy="cy(pawn.row) + 1.2" r="7.2" fill="rgba(0,0,0,0.3)" />
      <circle :cx="cx(pawn.col)" :cy="cy(pawn.row)" r="7.2" :class="`pawn s${pawn.seat}`" />
      <circle v-if="pawn.seat === 0" :cx="cx(pawn.col)" :cy="cy(pawn.row)" r="2.3" fill="#fff" />
      <circle v-else :cx="cx(pawn.col)" :cy="cy(pawn.row)" r="3" fill="none" stroke="#fff" stroke-width="1.6" />
    </g>
  </svg>
</template>

<style scoped>
.mini { display: block; width: 100%; height: auto; max-width: 190px; }
.tile { fill: #f6e8c8; }
.tile.goal0 { fill: #f9d3c6; }
.tile.goal1 { fill: #cfe4f6; }
.dot { fill: #2f9d62; opacity: 0.85; }
.wall.s0 { fill: #e2533a; }
.wall.s1 { fill: #2f8fd6; }
.wall.bad { fill: #fff; fill-opacity: 0.35; stroke: #b3261e; stroke-width: 1.4; stroke-dasharray: 3 2; }
.arrow { stroke: #2c2433; stroke-width: 2; stroke-linecap: round; }
.arrow.bad { stroke: #b3261e; stroke-dasharray: 3 3; }
.cross path { stroke: #b3261e; stroke-width: 2.2; stroke-linecap: round; fill: none; }
.pawn.s0 { fill: #e2533a; }
.pawn.s1 { fill: #2f8fd6; }
</style>
