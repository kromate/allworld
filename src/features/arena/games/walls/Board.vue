<script setup lang="ts">
// The Ten Walls board. It draws one WallsView, shows what the viewer may do, and emits `move`.
// It never talks to the service: the shared rules tell it at once which steps and walls are
// allowed, and why a wall is not.
//
// The viewer's goal row is always at the top (seat 1 sees the board turned half round); a
// spectator sees it from the first seat's side.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BoardEmits, BoardProps } from '../../../../shared/arena.ts'
import { SIZE, SLOTS, WALLS_EACH, WALLS_TITLE, cellName, goalRow, legalSteps, shortestPath, stepProblem, wallName, wallProblem, withWall } from '../../../../shared/games/walls.ts'
import type { Cell, Wall, WallDir, WallsMove, WallsView } from '../../../../shared/games/walls.ts'
import HowTo from './HowTo.vue'
import { playCue, unlockSound } from './sound.ts'
import { channels, setChannelMuted } from '../../../../state/sound.ts'

const props = defineProps<BoardProps<WallsView, WallsMove>>()
const emit = defineEmits<BoardEmits<WallsMove>>()

// Board geometry, in percent of the playing area: nine squares and eight grooves.
const GROOVE = 0.26
const C = 100 / (SIZE + SLOTS * GROOVE), G = C * GROOVE, P = C + G
const FILES = 'abcdefghi'

const rootEl = ref<HTMLDivElement | null>(null)
const boardEl = ref<HTMLDivElement | null>(null)
const innerEl = ref<HTMLDivElement | null>(null)
const helpEl = ref<HTMLDivElement | null>(null)

const mode = ref<'move' | 'wall'>('move')
const dir = ref<WallDir>('across')
/** The wall being tried: pinned on the board, not yet played. */
const ghost = ref<Wall | null>(null)
/** Where a mouse is pointing in a groove, before any click. */
const hover = ref<Wall | null>(null)
const hint = ref('')
const help = ref(false)
/** Keyboard: the direction of a blocked jump, waiting for a side to step around to. */
const around = ref<{ dc: number; dr: number } | null>(null)
/** Where the last pawn to move came from, for the trail on the board. */
const origin = ref<(Cell & { seat: number }) | null>(null)
const drag = ref<{ id: number; owner: HTMLElement; x: number; y: number; live: boolean } | null>(null)

function stored(key: string): boolean { try { return localStorage.getItem(key) === '1' } catch { return false } }
function store(key: string, on: boolean): void { try { localStorage.setItem(key, on ? '1' : '0') } catch { /* private mode: the choice lasts for this visit */ } }
const routes = ref(stored('nw.tenwalls.routes'))
const sound = computed(() => !channels.effects.muted)
let cueTimer: number | undefined
function cueAfter(cue: 'step' | 'won' | 'lost', delay: number): void {
  window.clearTimeout(cueTimer)
  cueTimer = window.setTimeout(() => { if (sound.value) playCue(cue) }, delay)
}
onBeforeUnmount(() => window.clearTimeout(cueTimer))

const flip = computed(() => props.seat === 1)
/** Ended by the rules (a pawn reached its row) or by the host (time, resignation, called off). */
const over = computed(() => Boolean(props.endText) || Boolean(props.view.result))
const playing = computed(() => props.seat !== null && !over.value)
const act = computed(() => playing.value && props.canMove)
const bottomSeat = computed(() => props.seat ?? 0)
const topSeat = computed(() => 1 - bottomSeat.value)
const myWalls = computed(() => (props.seat === null ? 0 : props.view.wallsLeft[props.seat] ?? 0))
const nameOf = (seat: number): string => (seat === props.seat ? 'You' : props.seatNames[seat] || `Player ${seat + 1}`)
const otherName = computed(() => (props.seat === null ? '' : props.seatNames[1 - props.seat] || 'the other player'))

const same = (a: Cell | null | undefined, b: Cell | null | undefined): boolean => Boolean(a && b && a.col === b.col && a.row === b.row)
const sameWall = (a: Wall | null, b: Wall | null): boolean => Boolean(a && b && a.col === b.col && a.row === b.row && a.dir === b.dir)
const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value))

// ── What is on the board ──

const targets = computed<Cell[]>(() => (act.value && props.seat !== null ? legalSteps(props.view, props.seat) : []))
const isTarget = (cell: Cell): boolean => targets.value.some(target => same(target, cell))
const moveChoices = computed(() => {
  const pawn = props.seat === null ? null : props.view.pawns[props.seat]
  if (!pawn) return []
  return targets.value.map(cell => {
    const dx = (cell.col - pawn.col) * (flip.value ? -1 : 1)
    const dy = (cell.row - pawn.row) * (flip.value ? 1 : -1)
    return { ...cell, angle: Math.atan2(dy, dx) * 180 / Math.PI + 90 }
  })
})
const nudges = [
  { label: 'left', x: -1, y: 0, angle: -90 }, { label: 'up', x: 0, y: -1, angle: 0 },
  { label: 'down', x: 0, y: 1, angle: 180 }, { label: 'right', x: 1, y: 0, angle: 90 },
]
function canNudge(x: number, y: number): boolean {
  if (!ghost.value) return false
  const col = ghost.value.col + (flip.value ? -x : x), row = ghost.value.row + (flip.value ? y : -y)
  return col >= 0 && col < SLOTS && row >= 0 && row < SLOTS
}
const lastStep = computed(() => (props.lastMove?.move.kind === 'step' ? props.lastMove.move : null))
const lastWall = computed(() => (props.lastMove?.move.kind === 'wall' ? props.lastMove.move : null))

const cells = computed(() => {
  const list = []
  for (let row = 0; row < SIZE; row++) {
    for (let col = 0; col < SIZE; col++) {
      const cell = { col, row }
      const pawn = props.view.pawns.findIndex(spot => same(spot, cell))
      const goalFor = row === goalRow(0) ? 0 : row === goalRow(1) ? 1 : null
      const target = mode.value === 'move' && isTarget(cell)
      const words = [cellName(cell)]
      if (pawn >= 0) words.push(pawn === props.seat ? 'your pawn' : `${nameOf(pawn)}’s pawn`)
      if (goalFor !== null) words.push(goalFor === props.seat ? 'your goal row' : `${nameOf(goalFor)}’s goal row`)
      if (target) words.push('you can move here')
      list.push({
        key: `${col}-${row}`, col, row, target, goalFor, label: words.join(', '),
        from: same(origin.value, cell), to: same(lastStep.value, cell),
        style: { left: `${(flip.value ? SIZE - 1 - col : col) * P}%`, top: `${(flip.value ? row : SIZE - 1 - row) * P}%` },
      })
    }
  }
  return list
})

function wallStyle(wall: Wall): Record<string, string> {
  const ax = flip.value ? SLOTS - 1 - wall.col : wall.col
  const ay = flip.value ? wall.row : SLOTS - 1 - wall.row
  return wall.dir === 'across'
    ? { left: `${ax * P}%`, top: `${(ay + 1) * P - G}%`, width: `${2 * C + G}%`, height: `${G}%` }
    : { left: `${(ax + 1) * P - G}%`, top: `${ay * P}%`, width: `${G}%`, height: `${2 * C + G}%` }
}
const pawnStyle = (cell: Cell): Record<string, string> => ({
  transform: `translate(${(flip.value ? SIZE - 1 - cell.col : cell.col) * (100 + GROOVE * 100)}%, ${(flip.value ? cell.row : SIZE - 1 - cell.row) * (100 + GROOVE * 100)}%)`,
})
const files = computed(() => Array.from({ length: SIZE }, (_, x) => ({ text: FILES[flip.value ? SIZE - 1 - x : x]!, at: `${(x * P + C / 2).toFixed(3)}` })))
const ranks = computed(() => Array.from({ length: SIZE }, (_, y) => ({ text: String(flip.value ? y + 1 : SIZE - y), at: `${(y * P + C / 2).toFixed(3)}` })))

// ── The wall being tried, and what it would change ──

const ghostProblem = computed(() => (ghost.value && props.seat !== null ? wallProblem(props.view, props.seat, ghost.value) : null))
const hoverProblem = computed(() => (hover.value && props.seat !== null ? wallProblem(props.view, props.seat, hover.value) : null))
/** The position the routes are drawn for: with the tried wall on it when that wall is allowed. */
const routeView = computed(() => (ghost.value && !ghostProblem.value && props.seat !== null ? withWall(props.view, props.seat, ghost.value) : props.view))
const paths = computed(() => [shortestPath(routeView.value, 0), shortestPath(routeView.value, 1)])
const stepsNow = computed(() => [shortestPath(props.view, 0).length - 1, shortestPath(props.view, 1).length - 1])
const stepsThen = computed(() => paths.value.map(path => path.length - 1))
function points(path: Cell[], seat: number): string {
  // The two routes are drawn a little apart so both show where they share squares.
  const shift = seat === 0 ? -0.9 : 0.9
  return path.map(cell => `${((flip.value ? SIZE - 1 - cell.col : cell.col) * P + C / 2 + shift).toFixed(2)},${((flip.value ? cell.row : SIZE - 1 - cell.row) * P + C / 2 + shift).toFixed(2)}`).join(' ')
}

const steps = (count: number): string => (count === 1 ? '1 step' : `${count} steps`)
/** The small line under a name: whose turn it is, and how far they have to go when routes are shown. */
function rackNote(seat: number): string {
  if (props.view.result) return props.view.result.winner === seat ? 'Won' : ''
  if (props.endText) return ''
  const notes: string[] = []
  if (props.view.turn === seat) notes.push(seat === props.seat ? 'Your turn' : 'To move')
  if (routes.value) notes.push(`${steps(stepsNow.value[seat]!)} to go`)
  return notes.join(' · ')
}
// The host shows how the game ended (`endText`) above the board; here it is enough to say the board is final.
const status = computed(() => {
  if (props.endText) return 'Final position.'
  if (hint.value) return hint.value
  if (props.view.result) return `${nameOf(props.view.result.winner)} ${props.view.result.winner === props.seat ? 'win' : 'wins'}.`
  if (props.seat === null) return `${nameOf(props.view.turn)} to move.`
  if (!props.canMove) return props.view.turn === props.seat ? '' : `Waiting for ${otherName.value}.`
  if (mode.value === 'wall') {
    if (!ghost.value) return 'Tap where the wall should go. It covers two squares.'
    if (ghostProblem.value) return ghostProblem.value
    const mine = props.seat, theirs = 1 - props.seat
    const change = (seat: number): string => (stepsThen.value[seat] === stepsNow.value[seat] ? `stays ${steps(stepsNow.value[seat]!)}` : `${stepsNow.value[seat]} → ${steps(stepsThen.value[seat]!)}`)
    return `Wall ${wallName(ghost.value)}. Their route ${change(theirs)}, yours ${change(mine)}. Press Place to confirm.`
  }
  return myWalls.value > 0 ? 'Your turn. Move to a marked square, or place a wall.' : 'Your turn. You have no walls left, so move to a marked square.'
})
const statusTone = computed(() => ((hint.value && !around.value) || (mode.value === 'wall' && ghost.value && ghostProblem.value) ? 'bad' : ''))

/** The position in words, for people who cannot see the board. */
const summary = computed(() => {
  const line = (seat: number): string => `${nameOf(seat)} ${seat === props.seat ? 'are' : 'is'} on ${cellName(props.view.pawns[seat]!)}, ${steps(stepsNow.value[seat]!)} from the goal, with ${props.view.wallsLeft[seat]} walls left.`
  return `${line(bottomSeat.value)} ${line(topSeat.value)}`
})

// ── Playing a move ──

function refuse(reason: string): void {
  hint.value = reason
  if (sound.value) playCue('refused')
}
function stepTo(cell: Cell): void {
  if (!act.value || props.seat === null) return
  const problem = stepProblem(props.view, props.seat, cell)
  if (problem) { refuse(problem); return }
  hint.value = ''; around.value = null
  emit('move', { kind: 'step', col: cell.col, row: cell.row })
}
function place(): void {
  if (!act.value || props.seat === null) return
  if (!ghost.value) { hint.value = 'Choose where the wall goes first.'; return }
  const problem = wallProblem(props.view, props.seat, ghost.value)
  if (problem) { refuse(problem); return }
  const wall = ghost.value
  hint.value = ''; ghost.value = null; hover.value = null; mode.value = 'move'
  emit('move', { kind: 'wall', col: wall.col, row: wall.row, dir: wall.dir })
}
function setMode(next: 'move' | 'wall'): void {
  if (!act.value) return
  hint.value = ''; around.value = null; hover.value = null
  if (next === 'wall' && myWalls.value <= 0) { refuse('You have no walls left. Move your pawn.'); return }
  mode.value = next
  if (next === 'move') ghost.value = null
}
function rotate(): void {
  dir.value = dir.value === 'across' ? 'along' : 'across'
  hint.value = ''
  if (ghost.value) ghost.value = { ...ghost.value, dir: dir.value }
}
/** A first place for a wall when the keyboard starts one: across the other pawn's next step. */
function suggest(): Wall {
  const seat = props.seat ?? 0
  const path = shortestPath(props.view, 1 - seat)
  const from = path[0], to = path[1]
  if (from && to) {
    const along = from.row === to.row
    const options: Wall[] = along
      ? [0, -1].map(shift => ({ col: Math.min(from.col, to.col), row: from.row + shift, dir: 'along' as const }))
      : [0, -1].map(shift => ({ col: from.col + shift, row: Math.min(from.row, to.row), dir: 'across' as const }))
    const fine = options.find(wall => wall.col >= 0 && wall.col < SLOTS && wall.row >= 0 && wall.row < SLOTS && !wallProblem(props.view, seat, wall))
    if (fine) return fine
  }
  return { col: 3, row: 3, dir: dir.value }
}

function tapCell(cell: Cell, event: MouseEvent): void {
  if (!act.value || props.seat === null) return
  // In wall mode a finger on a square is aiming a wall (handled by the pointer events below); a
  // mouse is precise enough to mean the square itself.
  if (mode.value === 'wall' && lastPointer !== 'mouse' && event.detail !== 0) return
  if (mode.value === 'wall') setMode('move')
  if (same(props.view.pawns[props.seat], cell)) { hint.value = ''; return }
  stepTo(cell)
}

// ── Pointer: aiming, pinning and dragging walls ──

let lastPointer = 'mouse'
let press: { id: number; pinned: boolean; moved: boolean } | null = null

function wallAt(clientX: number, clientY: number, pointerType: string): Wall | null {
  const box = innerEl.value?.getBoundingClientRect()
  if (!box || !box.width) return null
  const px = ((clientX - box.left) / box.width) * 100, py = ((clientY - box.top) / box.height) * 100
  if (px < -3 || px > 103 || py < -3 || py > 103) return null
  const ax = clamp(Math.round((px + G / 2) / P) - 1, 0, SLOTS - 1), ay = clamp(Math.round((py + G / 2) / P) - 1, 0, SLOTS - 1)
  let way = dir.value
  if (pointerType === 'mouse') {
    // A mouse points at the groove itself: left or right of the corner means across, above or below means along.
    const offX = Math.abs(px - ((ax + 1) * P - G / 2)), offY = Math.abs(py - ((ay + 1) * P - G / 2))
    if (Math.abs(offX - offY) > 0.5) way = offX > offY ? 'across' : 'along'
  }
  return { col: flip.value ? SLOTS - 1 - ax : ax, row: flip.value ? ay : SLOTS - 1 - ay, dir: way }
}
const inGroove = (event: PointerEvent): boolean => event.target === innerEl.value

function onDown(event: PointerEvent): void {
  if (press || drag.value || help.value) return
  lastPointer = event.pointerType
  if (sound.value) unlockSound()
  if (!act.value || event.button !== 0 || myWalls.value <= 0) return
  const aiming = event.pointerType === 'mouse' ? inGroove(event) : mode.value === 'wall'
  if (!aiming) return
  const wall = wallAt(event.clientX, event.clientY, event.pointerType)
  if (!wall) return
  event.preventDefault()
  press = { id: event.pointerId, pinned: sameWall(ghost.value, wall), moved: false }
  mode.value = 'wall'; dir.value = wall.dir; ghost.value = wall; hover.value = null; hint.value = ''
  innerEl.value?.setPointerCapture(event.pointerId)
  boardEl.value?.focus({ preventScroll: true })
}
function onMove(event: PointerEvent): void {
  if (press) {
    if (event.pointerId !== press.id) return
    const wall = wallAt(event.clientX, event.clientY, event.pointerType)
    if (wall && !sameWall(wall, ghost.value)) { ghost.value = wall; dir.value = wall.dir; press.moved = true; hint.value = '' }
    return
  }
  if (event.pointerType !== 'mouse' || !act.value || myWalls.value <= 0 || !inGroove(event)) { hover.value = null; return }
  const wall = wallAt(event.clientX, event.clientY, 'mouse')
  hover.value = wall && !sameWall(wall, ghost.value) ? wall : null
}
function onUp(event: PointerEvent): void {
  if (!press || event.pointerId !== press.id) return
  const done = press
  press = null
  releaseCapture(innerEl.value, done.id)
  if (done.pinned && !done.moved) place()
}
function releaseCapture(owner: HTMLElement | null, id: number): void { if (owner?.hasPointerCapture(id)) owner.releasePointerCapture(id) }
function cancelPointers(event?: PointerEvent): void {
  if (press && (!event || event.pointerId === press.id)) { const id = press.id; press = null; releaseCapture(innerEl.value, id) }
  if (drag.value && (!event || event.pointerId === drag.value.id)) { const done = drag.value; drag.value = null; releaseCapture(done.owner, done.id) }
}
function cancelOnBlur(): void { cancelPointers() }
function onFocusOut(event: FocusEvent): void { if (!(event.relatedTarget instanceof Node) || !rootEl.value?.contains(event.relatedTarget)) cancelPointers() }
onMounted(() => window.addEventListener('blur', cancelOnBlur))
onBeforeUnmount(() => { window.removeEventListener('blur', cancelOnBlur); cancelPointers() })
function onLeave(): void { if (!press) hover.value = null }

// Dragging a wall from the rack. A plain click on the rack switches wall mode instead.
function dragStart(event: PointerEvent): void {
  if (press || drag.value || help.value) return
  lastPointer = event.pointerType
  if (!act.value || event.button !== 0) return
  if (myWalls.value <= 0) { refuse('You have no walls left. Move your pawn.'); return }
  const owner = event.currentTarget
  if (!(owner instanceof HTMLElement)) return
  drag.value = { id: event.pointerId, owner, x: event.clientX, y: event.clientY, live: false }
  owner.setPointerCapture(event.pointerId)
  dragFrom = { x: event.clientX, y: event.clientY }
}
let dragFrom = { x: 0, y: 0 }
function dragMove(event: PointerEvent): void {
  if (!drag.value || event.pointerId !== drag.value.id) return
  const live = drag.value.live || Math.hypot(event.clientX - dragFrom.x, event.clientY - dragFrom.y) > 8
  drag.value = { ...drag.value, x: event.clientX, y: event.clientY, live }
  if (!live) return
  const wall = wallAt(event.clientX, event.clientY, event.pointerType)
  if (wall) { mode.value = 'wall'; dir.value = wall.dir; ghost.value = wall; hint.value = '' } else ghost.value = null
}
function dragEnd(event: PointerEvent): void {
  const was = drag.value
  if (!was || event.pointerId !== was.id) return
  drag.value = null
  releaseCapture(was.owner, was.id)
  if (!was.live) { setMode(mode.value === 'wall' ? 'move' : 'wall'); return }
  if (ghost.value) place(); else mode.value = 'move'
}

// ── Keyboard ──
// Keys are claimed on `window` before the world behind the window sees them (it walks on the
// arrows and W), but only while the focus is on this board.

const ARROWS: Record<string, [number, number]> = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }

function arrowStep(sx: number, sy: number): void {
  if (props.seat === null) return
  // Screen direction to board direction: the board is turned half round for seat 1.
  const dc = flip.value ? -sx : sx, dr = flip.value ? sy : -sy
  const me = props.view.pawns[props.seat]!, other = props.view.pawns[1 - props.seat]!
  const pending = around.value
  around.value = null
  if (pending && (pending.dc === 0) !== (dc === 0)) { stepTo({ col: me.col + pending.dc + dc, row: me.row + pending.dr + dr }); return }
  const next = { col: me.col + dc, row: me.row + dr }
  if (same(next, other)) {
    const over = { col: next.col + dc, row: next.row + dr }
    if (isTarget(over)) { stepTo(over); return }
    const sides = targets.value.filter(target => Math.abs(target.col - me.col) === 1 && Math.abs(target.row - me.row) === 1 && (dc === 0 ? target.row === next.row : target.col === next.col))
    if (sides.length) {
      around.value = { dc, dr }
      hint.value = `The jump is blocked. Press ${dc === 0 ? '← or →' : '↑ or ↓'} to step around ${otherName.value}.`
      return
    }
  }
  stepTo(next)
}
function arrowWall(sx: number, sy: number): void {
  const wall = ghost.value ?? suggest()
  const col = clamp(wall.col + (flip.value ? -sx : sx), 0, SLOTS - 1), row = clamp(wall.row + (flip.value ? sy : -sy), 0, SLOTS - 1)
  ghost.value = { col, row, dir: wall.dir }; dir.value = wall.dir; hint.value = ''
}

function onKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  if (help.value) {
    event.stopPropagation()
    if (event.key === 'Tab') {
      const close = helpEl.value?.querySelector('button')
      close?.focus({ preventScroll: true })
      event.preventDefault(); event.stopPropagation()
    }
    if (event.key === 'Escape') { closeHelp(); event.preventDefault(); event.stopPropagation() }
    return
  }
  const focused = document.activeElement
  if (!rootEl.value || !focused || !rootEl.value.contains(focused)) return
  if (sound.value) unlockSound()
  const used = (): void => { event.preventDefault(); event.stopPropagation() }
  const arrow = ARROWS[event.key]
  if (arrow) {
    used()
    if (!act.value) return
    if (mode.value === 'wall') arrowWall(arrow[0], arrow[1]); else arrowStep(arrow[0], arrow[1])
    return
  }
  const key = event.key.toLowerCase()
  if (key === 'w') {
    used()
    if (!act.value) return
    setMode(mode.value === 'wall' ? 'move' : 'wall')
    if (mode.value === 'wall' && !ghost.value) { ghost.value = suggest(); dir.value = ghost.value.dir }
  } else if (key === 'r' && mode.value === 'wall') { used(); rotate() }
  else if (event.key === 'Enter' && mode.value === 'wall' && boardEl.value?.contains(focused)) { used(); place() }
  else if (event.key === 'Escape' && mode.value === 'wall') { used(); setMode('move') }
  else if (event.key === 'Enter' || event.key === ' ') {
    // A focused square is a button: let it act, but keep the key from the world behind.
    event.stopPropagation()
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))

// ── Settings, help ──

function toggleSound(): void {
  setChannelMuted('effects', sound.value)
  if (sound.value) { unlockSound(); cueAfter('step', 60) }
}
function toggleRoutes(): void { routes.value = !routes.value; store('nw.tenwalls.routes', routes.value) }
function openHelp(): void {
  cancelPointers()
  help.value = true
  void nextTick(() => {
    if (rootEl.value) rootEl.value.scrollTop = 0
    helpEl.value?.querySelector('button')?.focus({ preventScroll: true })
  })
}
function closeHelp(): void { help.value = false; void nextTick(() => boardEl.value?.focus({ preventScroll: true })) }

// ── Following the game ──

watch(() => props.view, (now, before) => {
  cancelPointers()
  if (now.ply === 0) {
    window.clearTimeout(cueTimer)
    origin.value = null; ghost.value = null; hover.value = null; hint.value = ''; around.value = null
    mode.value = 'move'; cancelPointers()
  }
  if (!before || now.ply === before.ply) return
  hint.value = ''; around.value = null
  if (now.ply !== before.ply + 1) { origin.value = null; return }
  const mover = before.turn
  const was = before.pawns[mover]!, is = now.pawns[mover]!
  if (same(was, is)) { origin.value = null; if (sound.value) playCue('wall') }
  else {
    origin.value = { ...was, seat: mover }
    const reach = Math.abs(was.col - is.col) + Math.abs(was.row - is.row)
    if (sound.value) playCue(reach > 1 ? 'jump' : 'step')
  }
  if (now.result && !before.result && sound.value) cueAfter(props.seat === null || now.result?.winner === props.seat ? 'won' : 'lost', 220)
})
watch(() => props.seat, () => { cancelPointers(); mode.value = 'move'; ghost.value = null; hover.value = null; hint.value = ''; around.value = null })
watch(act, can => { if (!can) { mode.value = 'move'; ghost.value = null; hover.value = null; cancelPointers() } }, { flush: 'sync' })
watch(() => props.view.result, (now, before) => { if (now && !before && sound.value && now.reason !== 'reached-goal') playCue(props.seat === null || now.winner === props.seat ? 'won' : 'lost') })
</script>

<template>
  <div ref="rootEl" @focusout="onFocusOut" class="tw" :class="{ 'wall-mode': mode === 'wall', over: Boolean(view.result), helping: help }">
    <div class="tw-layout" :inert="help">
      <div class="tw-rack top" :class="[`s${topSeat}`, { turn: !over && view.turn === topSeat, won: view.result?.winner === topSeat }]">
        <span class="tw-token" aria-hidden="true"></span>
        <span class="tw-who">
          <strong class="truncate">{{ nameOf(topSeat) }}</strong>
          <span class="tiny">{{ rackNote(topSeat) }}</span>
        </span>
        <span class="tw-pips" aria-hidden="true"><i v-for="n in WALLS_EACH" :key="n" :class="{ used: n > (view.wallsLeft[topSeat] ?? 0) }"></i></span>
        <span class="tw-count num" :aria-label="`${view.wallsLeft[topSeat]} walls left`">{{ view.wallsLeft[topSeat] }}</span>
      </div>

      <div ref="boardEl" class="tw-board" tabindex="0" role="group"
        :aria-label="`${WALLS_TITLE} board. Arrow keys move your pawn. W switches to placing a wall, R turns it, Enter places it.`">
        <span class="tw-goal" aria-hidden="true">{{ seat === null ? `${nameOf(0)}’s finish` : 'Your finish' }}</span>
        <span v-for="file in files" :key="`f${file.text}`" class="tw-label file" :style="{ '--at': file.at }" aria-hidden="true">{{ file.text }}</span>
        <span v-for="rank in ranks" :key="`r${rank.text}`" class="tw-label rank" :style="{ '--at': rank.at }" aria-hidden="true">{{ rank.text }}</span>
        <div ref="innerEl" class="tw-inner" @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="cancelPointers" @lostpointercapture="cancelPointers" @pointerleave="onLeave">
          <button v-for="cell in cells" :key="cell.key" type="button" class="tw-cell"
            :class="{ target: cell.target, from: cell.from, to: cell.to, mine: cell.goalFor !== null && cell.goalFor === bottomSeat, theirs: cell.goalFor !== null && cell.goalFor === topSeat, [`g${cell.goalFor}`]: cell.goalFor !== null }"
            :style="cell.style" :aria-label="cell.label" :tabindex="cell.target ? 0 : -1" :aria-disabled="!cell.target" @click="tapCell(cell, $event)"></button>

          <svg v-if="routes && !over" class="tw-routes" viewBox="0 0 100 100" aria-hidden="true">
            <polyline v-for="seatIndex in [0, 1]" :key="seatIndex" :class="`s${seatIndex}`" :points="points(paths[seatIndex]!, seatIndex)" />
          </svg>

          <div v-for="wall in view.walls" :key="`${wall.col}-${wall.row}-${wall.dir}`" class="tw-wall"
            :class="[wall.dir, `s${wall.seat}`, { last: lastWall && sameWall(lastWall, wall) }]" :style="wallStyle(wall)"></div>
          <div v-if="hover && act" class="tw-wall hover" :class="[hover.dir, `s${seat ?? 0}`, { bad: Boolean(hoverProblem) }]" :style="wallStyle(hover)"></div>
          <div v-if="ghost && act" class="tw-wall ghost" :class="[ghost.dir, `s${seat ?? 0}`, { bad: Boolean(ghostProblem) }]" :style="wallStyle(ghost)"></div>

          <div v-for="(pawn, index) in view.pawns" :key="index" class="tw-pawn" :class="[`s${index}`, { you: index === seat, turn: !over && view.turn === index, won: view.result?.winner === index }]" :style="pawnStyle(pawn)">
            <span :key="`${index}-${pawn.col}-${pawn.row}`" class="tw-pawn-body" :class="{ hop: lastMove?.seat === index && lastStep !== null }"></span>
          </div>
        </div>
      </div>

      <div class="tw-rack bottom" :class="[`s${bottomSeat}`, { turn: !over && view.turn === bottomSeat, won: view.result?.winner === bottomSeat }]">
        <span class="tw-token" aria-hidden="true"></span>
        <span class="tw-who">
          <strong class="truncate">{{ nameOf(bottomSeat) }}</strong>
          <span class="tiny">{{ rackNote(bottomSeat) }}</span>
        </span>
        <span class="tw-pips" :class="{ grab: act && seat !== null && myWalls > 0 }" :title="act && myWalls > 0 ? 'Drag a wall onto the board' : undefined" aria-hidden="true"
          @pointerdown="seat !== null && dragStart($event)" @pointermove="dragMove" @pointerup="dragEnd" @pointercancel="cancelPointers" @lostpointercapture="cancelPointers">
          <i v-for="n in WALLS_EACH" :key="n" :class="{ used: n > (view.wallsLeft[bottomSeat] ?? 0) }"></i>
        </span>
        <span class="tw-count num" :aria-label="`${view.wallsLeft[bottomSeat]} walls left`">{{ view.wallsLeft[bottomSeat] }}</span>
      </div>

      <div class="tw-side">
        <p v-if="problem" class="notice coral tw-problem" role="alert">{{ problem }}</p>
        <p :class="act && mode === 'move' && !hint ? 'sr-only' : ['tw-status', statusTone]" role="status" aria-live="polite">{{ status }}</p>
        <div v-if="act && mode === 'move'" class="tw-move-choices" role="group" aria-label="Legal pawn moves">
          <span class="tw-choice-label">Move to</span>
          <button v-for="cell in moveChoices" :key="cellName(cell)" type="button" class="btn tw-step" :aria-label="`Move to ${cellName(cell)}`" @click="stepTo(cell)">
            <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" :style="{ transform: `rotate(${cell.angle}deg)` }"><path d="M10 16V4m-5 5 5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
            {{ cellName(cell) }}
          </button>
        </div>
        <div v-if="act && mode === 'wall' && ghost" class="tw-nudges" role="group" aria-label="Adjust wall preview">
          <span class="tw-choice-label">Adjust</span>
          <button v-for="nudge in nudges" :key="nudge.label" type="button" class="btn tw-nudge" :aria-label="`Shift wall ${nudge.label}`" :disabled="!canNudge(nudge.x, nudge.y)" @click="arrowWall(nudge.x, nudge.y)">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true" :style="{ transform: `rotate(${nudge.angle}deg)` }"><path d="M10 16V4m-5 5 5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
        </div>

        <div class="tw-controls" :class="{ walling: mode === 'wall' && act }">
          <div v-if="seat !== null && !over" class="tw-modes" role="group" aria-label="What a tap on the board does">
            <button type="button" class="tw-mode" :aria-pressed="mode === 'move'" :disabled="!act" @click="setMode('move')">Move</button>
            <button type="button" class="tw-mode" :aria-pressed="mode === 'wall'" :disabled="!act || myWalls <= 0" @click="setMode('wall')">Wall <span class="num tw-left">×{{ myWalls }}</span></button>
          </div>
          <template v-if="mode === 'wall' && act">
            <button type="button" class="btn tw-turn" :aria-label="`Turn the wall. It lies ${dir}.`" title="Turn the wall (R)" @click="rotate">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M15.5 10a5.5 5.5 0 1 1-1.7-4M14 2.5V6h-3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
              {{ dir === 'across' ? 'Across' : 'Along' }}
            </button>
            <button type="button" class="btn primary tw-place" :disabled="!ghost || Boolean(ghostProblem)" title="Place the wall (Enter)" @click="place">Place</button>
          </template>
          <span v-else class="grow"></span>
          <div class="tw-aids">
            <button type="button" class="btn icon sm" :aria-pressed="routes" aria-label="Show shortest routes" title="Show shortest routes" @click="toggleRoutes">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 18.5V13a4 4 0 0 1 4-4h4a4 4 0 0 0 4-4" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="0.1 4.6" /><circle cx="6" cy="19" r="2.6" fill="currentColor" /><circle cx="18" cy="5" r="2.6" fill="currentColor" /></svg>
            </button>
            <button type="button" class="btn icon sm" :aria-pressed="sound" aria-label="Sound" :title="sound ? 'Sound is on' : 'Sound is off'" @click="toggleSound">
              <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" /><path v-if="sound" d="M15.5 9a4.5 4.5 0 0 1 0 6M18 6.5a8 8 0 0 1 0 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><path v-else d="M15.5 9.5l5 5m0-5l-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
            </button>
            <button type="button" class="btn icon sm" aria-label="How to play" title="How to play" @click="openHelp">?</button>
          </div>
        </div>

        <p class="sr-only" aria-live="polite">{{ summary }}</p>
        <ul v-if="view.walls.length" class="sr-only" aria-label="Walls on the board">
          <li v-for="wall in view.walls" :key="`${wall.col}-${wall.row}-${wall.dir}`">Wall {{ wallName(wall) }}, placed by {{ nameOf(wall.seat) }}</li>
        </ul>
      </div>
    </div>

    <div v-if="drag?.live && !ghost" class="tw-drag" :class="[dir, `s${seat ?? 0}`]" :style="{ left: `${drag.x}px`, top: `${drag.y}px` }" aria-hidden="true"></div>

    <div v-if="help" ref="helpEl" class="tw-help" role="dialog" aria-modal="true" :aria-label="`How to play ${WALLS_TITLE}`">
      <header class="tw-help-head">
        <h2>How to play {{ WALLS_TITLE }}</h2>
        <button type="button" class="btn sm" @click="closeHelp">Close</button>
      </header>
      <HowTo />
    </div>
  </div>
</template>

<style scoped>
.tw {
  --s0: #e2533a; --s0-light: #ff8d73; --s0-dark: #a8321d;
  --s1: #2f8fd6; --s1-light: #7cc4f5; --s1-dark: #1a5f96;
  --wood: #6f4526; --wood-dark: #4a2c16; --groove: #3a2212;
  --tile: #f8ecd2; --tile-low: #ead6ae; --tile-edge: #c9ae7e;
  position: relative; width: 100%; max-height: 100%; overflow: auto; padding: 4px 4px 12px; container-type: inline-size; -webkit-tap-highlight-color: transparent; user-select: none; -webkit-user-select: none;
}
.tw.helping { overflow: hidden; }
.tw-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; width: min(100%, 560px, max(300px, 100dvh - 330px)); margin: 0 auto; }

/* Racks */
.tw-rack { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 5px 12px 5px 8px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); transition: border-color 0.2s ease, box-shadow 0.2s ease, background 0.2s ease; }
.tw-rack.turn { border-color: var(--seat); box-shadow: 0 0 0 2px color-mix(in srgb, var(--seat) 22%, transparent); background: color-mix(in srgb, var(--seat) 6%, var(--surface)); }
.tw-rack.won { background: var(--leaf-soft); border-color: #c4e6d1; }
.tw-rack.s0 { --seat: var(--s0); --seat-light: var(--s0-light); --seat-dark: var(--s0-dark); }
.tw-rack.s1 { --seat: var(--s1); --seat-light: var(--s1-light); --seat-dark: var(--s1-dark); }
.tw-token { position: relative; width: 28px; height: 28px; flex: none; border-radius: 50%; background: radial-gradient(circle at 35% 28%, var(--seat-light), var(--seat) 55%, var(--seat-dark)); box-shadow: 0 2px 0 var(--seat-dark), 0 3px 5px rgba(40, 20, 0, 0.3); }
.tw-token::after, .tw-pawn-body::after { content: ""; position: absolute; border-radius: 50%; }
.s0 .tw-token::after, .tw-pawn.s0 .tw-pawn-body::after { inset: 36%; background: #fff; }
.s1 .tw-token::after, .tw-pawn.s1 .tw-pawn-body::after { inset: 27%; border: 2.5px solid #fff; }
.tw-who { display: flex; flex-direction: column; min-width: 0; flex: 1; line-height: 1.2; }
.tw-who .tiny { color: var(--ink-2); min-height: 1.1em; }
.tw-rack.turn .tw-who .tiny { font-weight: 700; color: var(--seat-dark); }
.tw-pips { display: flex; gap: 3px; padding: 6px 4px; border-radius: 8px; flex: none; }
.tw-pips i { width: 5px; height: 20px; border-radius: 3px; background: linear-gradient(180deg, var(--seat-light), var(--seat) 45%, var(--seat-dark)); box-shadow: 0 1px 1px rgba(40, 20, 0, 0.35); transition: opacity 0.25s ease, transform 0.25s ease; }
.tw-pips i.used { background: var(--line-strong); box-shadow: none; opacity: 0.55; transform: scaleY(0.6); }
.tw-pips.grab { cursor: grab; touch-action: none; }
.tw-pips.grab:hover { background: var(--surface-3); }
.tw-count { min-width: 1.4em; text-align: right; font-weight: 800; font-size: 1.05rem; }

/* Board */
.tw-board {
  --pad: clamp(13px, 3.6cqi, 20px);
  position: relative; aspect-ratio: 1; padding: var(--pad); border-radius: clamp(14px, 4cqi, 22px);
  background: linear-gradient(145deg, #85562f, var(--wood) 40%, var(--wood-dark));
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.25) inset, 0 -3px 0 rgba(0, 0, 0, 0.25) inset, 0 3px 0 #2e1a0c, 0 10px 22px rgba(40, 22, 6, 0.35);
}
.tw-board:focus-visible { outline-offset: 3px; border-radius: clamp(14px, 4cqi, 22px); }
.tw-label { position: absolute; display: grid; place-items: center; font-size: clamp(9px, 2.5cqi, 12px); font-weight: 700; color: rgba(255, 236, 205, 0.85); pointer-events: none; }
.tw-goal { position: absolute; top: 0; left: 20%; width: 60%; height: var(--pad); display: grid; place-items: center; overflow: hidden; white-space: nowrap; font-size: clamp(9px, 2.5cqi, 11px); font-weight: 700; letter-spacing: 0.03em; color: #ffeccc; }
.tw-label.file { bottom: 0; height: var(--pad); width: 2em; left: calc(var(--pad) + (100% - 2 * var(--pad)) * var(--at) / 100 - 1em); }
.tw-label.rank { left: 0; width: var(--pad); height: 2em; top: calc(var(--pad) + (100% - 2 * var(--pad)) * var(--at) / 100 - 1em); }
.tw-inner { position: relative; width: 100%; height: 100%; border-radius: 6px; background: var(--groove); box-shadow: 0 0 0 3px var(--groove), 0 2px 5px 3px rgba(0, 0, 0, 0.5) inset; touch-action: manipulation; }
.wall-mode .tw-inner { touch-action: none; cursor: crosshair; }

.tw-cell {
  position: absolute; width: 9.0253%; height: 9.0253%; padding: 0; border: 0; border-radius: 17%; cursor: default;
  background: linear-gradient(160deg, var(--tile), var(--tile-low));
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.85) inset, 0 -1px 0 rgba(120, 85, 30, 0.25) inset, 0 2px 0 var(--tile-edge), 0 3px 4px rgba(0, 0, 0, 0.45);
  transition: filter 0.15s ease, transform 0.1s ease;
}
.tw-cell.g0 { background: linear-gradient(160deg, #fde3d6, #f3c7b4); }
.tw-cell.g1 { background: linear-gradient(160deg, #dcedfa, #bcd8ee); }
.tw-cell.target { cursor: pointer; }
/* A finger gets the groove around a marked square as well as the square. */
.tw-cell.target::before { content: ""; position: absolute; inset: -13%; }
.tw-cell.target::after { content: ""; position: absolute; inset: 31%; border-radius: 50%; background: var(--leaf); opacity: 0.8; box-shadow: 0 0 0 4px color-mix(in srgb, var(--leaf) 22%, transparent); animation: tw-pulse 1.6s ease-in-out infinite; }
.tw-cell.target:hover { filter: brightness(1.04); transform: translateY(-1px); }
.tw-cell.target:active { transform: translateY(1px); }
.tw-cell.from { box-shadow: 0 0 0 2px rgba(60, 40, 10, 0.28) inset, 0 2px 0 var(--tile-edge), 0 3px 4px rgba(0, 0, 0, 0.45); }
.tw-cell.to { box-shadow: 0 0 0 2.5px rgba(255, 176, 32, 0.95) inset, 0 2px 0 var(--tile-edge), 0 3px 4px rgba(0, 0, 0, 0.45); }
.tw-cell:focus-visible { z-index: 4; }
.wall-mode .tw-cell { pointer-events: none; }
@media (hover: hover) and (pointer: fine) { .wall-mode .tw-cell { pointer-events: auto; } }
@keyframes tw-pulse { 50% { transform: scale(0.78); opacity: 0.55; } }

.tw-routes { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; z-index: 1; overflow: visible; }
.tw-routes polyline { fill: none; stroke-width: 1.1; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 0.2 2.6; opacity: 0.9; }
.tw-routes .s0 { stroke: var(--s0-dark); }
.tw-routes .s1 { stroke: var(--s1-dark); }

.tw-wall {
  position: absolute; z-index: 2; border-radius: 999px; pointer-events: none;
  background: linear-gradient(180deg, var(--seat-light), var(--seat) 45%, var(--seat-dark));
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.55) inset, 0 2px 0 var(--seat-dark), 0 4px 6px rgba(0, 0, 0, 0.5);
  transform: scale(1.0, 1.25);
}
.tw-wall.along { background: linear-gradient(90deg, var(--seat-light), var(--seat) 45%, var(--seat-dark)); transform: scale(1.25, 1.0); }
.tw-wall.s0 { --seat: var(--s0); --seat-light: var(--s0-light); --seat-dark: var(--s0-dark); }
.tw-wall.s1 { --seat: var(--s1); --seat-light: var(--s1-light); --seat-dark: var(--s1-dark); }
.tw-wall.last { outline: 2px solid #ffe8a5; outline-offset: 1px; animation: tw-drop 0.34s cubic-bezier(0.3, 1.5, 0.5, 1) both, tw-glow 1.6s ease-out 0.3s both; }
.tw-wall.hover { opacity: 0.45; box-shadow: none; }
.tw-wall.ghost { opacity: 0.92; outline: 2px dashed #fff; outline-offset: 1px; animation: tw-breathe 1.2s ease-in-out infinite; }
.tw-wall.bad { background: repeating-linear-gradient(45deg, #5a5560, #5a5560 4px, #2c2833 4px, #2c2833 8px); }
.tw-wall.ghost.bad { outline-color: #ff8f7c; animation: tw-shake 0.3s ease; }
@keyframes tw-drop { from { opacity: 0; translate: 0 -40%; scale: 1.3; } to { opacity: 1; translate: 0 0; scale: 1; } }
@keyframes tw-glow { from { filter: drop-shadow(0 0 7px #ffe08a) brightness(1.25); } to { filter: none; } }
@keyframes tw-breathe { 50% { opacity: 0.68; } }
@keyframes tw-shake { 25% { translate: -3px 0; } 75% { translate: 3px 0; } }

.tw-pawn { position: absolute; left: 0; top: 0; width: 9.0253%; height: 9.0253%; z-index: 3; pointer-events: none; transition: transform 0.28s cubic-bezier(0.3, 0.9, 0.35, 1); }
.tw-pawn.s0 { --seat: var(--s0); --seat-light: var(--s0-light); --seat-dark: var(--s0-dark); }
.tw-pawn.s1 { --seat: var(--s1); --seat-light: var(--s1-light); --seat-dark: var(--s1-dark); }
.tw-pawn-body {
  position: absolute; inset: 10% 10% 14%; border-radius: 50%;
  background: radial-gradient(circle at 35% 26%, var(--seat-light), var(--seat) 52%, var(--seat-dark));
  box-shadow: 0 2px 0 var(--seat-dark), 0 5px 6px rgba(0, 0, 0, 0.45), 0 -2px 3px rgba(0, 0, 0, 0.18) inset, 0 2px 2px rgba(255, 255, 255, 0.45) inset;
}
.tw-pawn-body.hop { animation: tw-hop 0.3s ease-out; }
.tw-pawn.you.turn .tw-pawn-body { box-shadow: 0 0 0 2.5px #fff, 0 0 0 4.5px var(--seat-dark), 0 5px 6px rgba(0, 0, 0, 0.45), 0 -2px 3px rgba(0, 0, 0, 0.18) inset; }
.tw-pawn.won .tw-pawn-body { box-shadow: 0 0 0 3px #ffd766, 0 0 14px 4px rgba(255, 215, 102, 0.8), 0 5px 6px rgba(0, 0, 0, 0.45); }
@keyframes tw-hop { 40% { transform: translateY(-16%) scale(1.14); } }

/* Under the board */
.tw-side { display: grid; gap: 8px; align-content: start; min-width: 0; }
.tw-status { min-height: 2.9em; padding: 0 2px; font-size: 0.88rem; color: var(--ink-2); display: flex; align-items: center; }
.tw-status.bad { color: var(--danger); font-weight: 650; }
.tw-problem { margin: 0; }
.tw-move-choices, .tw-nudges { display: flex; align-items: center; gap: 5px; min-height: 44px; flex-wrap: wrap; }
.tw-choice-label { font-size: 0.76rem; color: var(--ink-2); margin-right: auto; }
.tw-step { flex: 1; min-width: 44px; min-height: 44px; padding: 0 6px; gap: 3px; font-size: 0.85rem; }
.tw-nudge { flex: 1; min-width: 44px; min-height: 44px; padding: 0 8px; }
.tw-step svg { flex: none; }
.tw-controls { display: flex; align-items: center; gap: 6px; min-height: 46px; }
.tw-modes { display: flex; padding: 3px; gap: 3px; border-radius: 13px; background: var(--surface-3); flex: none; }
.tw-mode { min-height: 40px; min-width: 58px; padding: 0 8px; border: 0; border-radius: 10px; background: transparent; font-weight: 700; color: var(--ink-2); display: inline-flex; align-items: center; justify-content: center; gap: 5px; white-space: nowrap; }
.tw-mode[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(40, 30, 10, 0.16); }
.tw-mode:disabled { opacity: 0.5; cursor: not-allowed; }
.tw-left { font-size: 0.82rem; color: var(--muted); }
.tw-aids { display: flex; gap: 6px; flex: none; }
.tw-aids .btn.icon { width: 42px; min-height: 42px; font-weight: 800; font-size: 1.05rem; color: var(--ink-2); }
.tw-aids .btn[aria-pressed="true"] { background: var(--accent-soft); border-color: #f0cf85; color: var(--accent-text); }
.tw-turn, .tw-place { min-height: 44px; padding: 0 12px; }
.tw-turn { flex: none; gap: 6px; }
.tw-place { flex: 1; min-width: 0; }
/* On a narrow board the wall buttons take the place of the three small switches. */
.tw-controls.walling .tw-aids { display: none; }

.tw-drag { position: fixed; z-index: 50; width: 74px; height: 12px; margin: -6px 0 0 -37px; border-radius: 999px; pointer-events: none; background: var(--seat); box-shadow: 0 6px 12px rgba(0, 0, 0, 0.35); opacity: 0.9; }
.tw-drag.along { width: 12px; height: 74px; margin: -37px 0 0 -6px; }
.tw-drag.s0 { --seat: var(--s0); } .tw-drag.s1 { --seat: var(--s1); }

.tw-help { position: absolute; inset: 0; z-index: 20; overflow-y: auto; padding: 14px; border-radius: 16px; background: var(--surface); border: 1px solid var(--line-strong); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 12px; user-select: text; -webkit-user-select: text; }
.tw-help-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; position: sticky; top: -14px; margin: -14px -14px 0; padding: 12px 14px 10px; background: var(--surface); z-index: 1; border-bottom: 1px solid var(--line); }

/* Wide: the board on the left, racks and controls beside it. */
@container (min-width: 760px) {
  .tw-layout { grid-template-columns: minmax(0, 1fr) 290px; grid-template-rows: auto 1fr auto; column-gap: 16px; width: min(100%, 890px, max(560px, 100dvh + 30px)); }
  .tw-board { grid-column: 1; grid-row: 1 / span 3; }
  .tw-rack.top { grid-column: 2; grid-row: 1; }
  .tw-side { grid-column: 2; grid-row: 2; align-content: center; }
  .tw-rack.bottom { grid-column: 2; grid-row: 3; }
  .tw-controls { flex-wrap: wrap; row-gap: 8px; }
  .tw-controls.walling .tw-aids { display: flex; }
  .tw-modes { flex: 1 0 100%; }
  .tw-mode { flex: 1; }
  .tw-status { min-height: 4.4em; }
  .tw-rack { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; gap: 4px 10px; padding: 10px; }
  .tw-rack .tw-pips { grid-column: 2; grid-row: 2; padding-left: 0; }
  .tw-rack .tw-count { grid-column: 3; grid-row: 1 / span 2; }
  .tw-rack .tw-token { grid-column: 1; grid-row: 1 / span 2; }
  .tw-rack .tw-who { grid-column: 2; }
}
@media (prefers-reduced-motion: reduce) {
  .tw *, .tw *::before, .tw *::after { animation: none !important; transition: none !important; }
}
</style>
