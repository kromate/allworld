<script setup lang="ts">
// Word Yard's board and rack. Everything shown comes from one WordsView (which never holds
// another player's tiles); the only thing sent out is a move. Tiles can be dragged, tapped into
// place (tile then square, or square then tiles), or typed.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { BoardEmits, BoardProps } from '../../../../shared/arena.ts'
import { BLANK, CENTRE, EXCHANGE_MIN, NAME, PREMIUMS, PREMIUM_NAMES, SIZE, WHOLE_RACK_BONUS, buildLexicon, cellName, findPlacements, readPlacement, tileValue } from '../../../../shared/games/words.ts'
import type { Lexicon, Premium, WordsMove, WordsView } from '../../../../shared/games/words.ts'
import WordTile from './WordTile.vue'
import HowTo from './HowTo.vue'
import { cue, setSound, soundOn } from './sound.ts'

const props = defineProps<BoardProps<WordsView, WordsMove>>()
const emit = defineEmits<BoardEmits<WordsMove>>()

interface RackTile { id: number; tile: string }
/** A tile put on the board this turn and not played yet. */
interface Fresh { id: number; at: number; letter: string; blank: boolean }

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const EMPTY = '.'
let nextId = 1

const rack = ref<RackTile[]>([])
const fresh = ref<Fresh[]>([])
const selected = ref<number | null>(null)
const cursor = ref<number | null>(null)
const across = ref(true)
const mode = ref<'play' | 'swap' | 'pass'>('play')
const swapping = ref<number[]>([])
const blankFor = ref<{ id: number; at: number } | null>(null)
const sent = ref(false)
const slip = ref('')
const hintBusy = ref(false)
let hintLexicon: Lexicon | null = null
const showUnseen = ref(false)
const zoom = ref(1)
const cellPx = ref(40)
const flash = ref<{ seat: number; text: string; key: number } | null>(null)

const rootEl = ref<HTMLElement | null>(null)
const viewportEl = ref<HTMLElement | null>(null)
const chooserEl = ref<HTMLElement | null>(null)

const watching = computed(() => props.seat === null || props.view.rack === null)
const over = computed(() => Boolean(props.endText) || props.view.outcome !== null)
const nameOf = (seat: number): string => props.seatNames[seat] ?? `Player ${seat + 1}`
const points = (count: number): string => `${count} ${count === 1 ? 'point' : 'points'}`
const tilesText = (count: number): string => `${count} ${count === 1 ? 'tile' : 'tiles'}`

// ── Keeping the rack in step with the view ──────────────────────────────────────────────────

/** Keep the tiles still held where the player arranged them; new tiles join at the end. */
function syncRack(letters: string | null): void {
  const want = [...(letters ?? '')]
  const played = new Set(fresh.value.map(tile => tile.id))
  const kept: RackTile[] = []
  for (const tile of rack.value) {
    if (played.has(tile.id)) continue
    const index = want.indexOf(tile.tile)
    if (index !== -1) { want.splice(index, 1); kept.push(tile) }
  }
  rack.value = [...kept, ...want.map(tile => ({ id: nextId++, tile }))]
  fresh.value = []
  selected.value = null
  cursor.value = null
  swapping.value = []
  blankFor.value = null
  mode.value = 'play'
}
watch([() => props.view.rack, () => props.seat], ([rack]) => syncRack(rack), { immediate: true })
// Someone else covered a square a tile was waiting on: it goes back to the rack.
watch(() => props.view.board, board => {
  if (fresh.value.some(tile => board[tile.at] !== EMPTY)) fresh.value = fresh.value.filter(tile => board[tile.at] === EMPTY)
  if (cursor.value !== null && board[cursor.value] !== EMPTY) cursor.value = null
})
watch(() => [props.view.board, props.view.rack, props.view.turn], () => { sent.value = false })
// The turn moved on or the game ended: a swap or pass still being confirmed belonged to the turn
// that is gone, and at the end tiles waiting on the board go back so only what was played shows.
watch([() => props.view.turn, over], ([, ended]) => {
  mode.value = 'play'
  swapping.value = []
  if (ended) { fresh.value = []; selected.value = null; cursor.value = null; blankFor.value = null }
})
watch(() => props.problem, problem => { if (problem) { sent.value = false; cue('refused') } })
watch(() => props.view.outcome !== null, over => { if (over) cue('over') })
watch(() => JSON.stringify(props.view.last), () => {
  const last = props.view.last
  if (!last) { flash.value = null; return }
  cue(last.seat === props.seat ? 'play' : 'theirs')
  if (last.kind === 'place') flash.value = { seat: last.seat, text: `+${last.score}`, key: Date.now() }
})
watch(fresh, () => { slip.value = '' }, { deep: true })

const held = computed(() => rack.value.filter(tile => !fresh.value.some(placed => placed.id === tile.id)))

// ── The board as shown ──────────────────────────────────────────────────────────────────────

interface Cell { at: number; premium: Premium; tile: { letter: string; blank: boolean } | null; mine: Fresh | null; last: boolean; order: number; label: string }

const rows = computed(() => {
  const board = props.view.board
  const lastCells = props.view.last?.kind === 'place' ? props.view.last.cells : []
  const waiting = new Map(fresh.value.map(tile => [tile.at, tile]))
  return Array.from({ length: SIZE }, (_, row) => Array.from({ length: SIZE }, (_, col): Cell => {
    const at = row * SIZE + col
    const char = board[at] ?? EMPTY
    const premium = PREMIUMS[at]!
    const tile = char === EMPTY ? null : { letter: char.toUpperCase(), blank: char !== char.toUpperCase() }
    const mine = tile ? null : waiting.get(at) ?? null
    const order = lastCells.indexOf(at)
    const square = `${cellName(at)}, ${premium ? PREMIUM_NAMES[premium] : at === CENTRE ? 'start square' : 'plain'}`
    const label = tile ? `${square}: ${tile.letter}, ${tile.blank ? 'a blank, no points' : points(tileValue(tile.letter))}${order !== -1 ? ', just played' : ''}`
      : mine ? `${square}: your ${mine.letter}${mine.blank ? ', a blank' : ''}, not played yet. Press to take it back.`
        : `${square}: empty`
    return { at, premium, tile, mine, last: order !== -1, order: Math.max(0, order), label }
  }))
})

const reading = computed(() => (fresh.value.length ? readPlacement(props.view.board, fresh.value.map(tile => ({ at: tile.at, letter: tile.letter, blank: tile.blank }))) : null))
const bubbleAt = computed(() => (reading.value?.ok ? reading.value.words[0]!.cells.at(-1)! : null))
const canPlay = computed(() => props.canMove && !sent.value && reading.value?.ok === true)
const filled = (at: number): boolean => props.view.board[at] !== EMPTY || fresh.value.some(tile => tile.at === at)

const lastLine = computed(() => {
  const last = props.view.last
  if (!last) return ''
  const who = last.seat === props.seat ? 'You' : nameOf(last.seat)
  if (last.kind === 'pass') return `${who} passed.`
  if (last.kind === 'exchange') return `${who} swapped ${tilesText(last.swapped)}.`
  return `${who} played ${last.words[0] ?? 'a word'} for ${last.score}${last.wholeRack ? ', all seven tiles' : ''}.`
})
const turnLine = computed(() => {
  // The host shows how the game ended (`endText`) above the board; here it is enough to say the board is final.
  if (over.value) return props.endText ? 'Final position.' : outcomeText.value || 'The game is over.'
  if (watching.value) return 'You are watching. Racks stay hidden.'
  if (selected.value !== null) {
    const tile = held.value.find(tile => tile.id === selected.value)
    return `${tile?.tile === BLANK ? 'Blank' : tile?.tile ?? 'Tile'} selected. Tap an empty square to place it.`
  }
  if (!props.canMove) return props.view.turn !== null && props.view.turn !== props.seat ? `Waiting for ${nameOf(props.view.turn)}. You can line up tiles meanwhile.` : 'One moment.'
  if (cursor.value !== null) return `${cellName(cursor.value)} ${across.value ? 'across' : 'down'}: tap tiles or type. Tap the square again to turn.`
  return 'Tap a tile, then a square. Dots show where to connect.'
})
const unseen = computed(() => [...LETTERS, BLANK].map(tile => ({ tile, count: props.view.unseen[tile] ?? 0 })))
const outcomeText = computed(() => props.endText ?? props.view.outcome?.text.replace(/\{(\d+)\}/g, (_, seat: string) => nameOf(Number(seat))) ?? '')
const LEGEND: { premium: Exclude<Premium, ''>; text: string }[] = [
  { premium: '2L', text: 'letter ×2' }, { premium: '3L', text: 'letter ×3' }, { premium: '2W', text: 'word ×2' }, { premium: '3W', text: 'word ×3' },
]

// Connection hints are spatial only. The service still checks every completed word.
const connections = computed(() => {
  const result = new Set<number>()
  if (watching.value || over.value || mode.value !== 'play') return result
  const board = props.view.board
  const placed = fresh.value.map(({ at, letter, blank }) => ({ at, letter, blank }))
  const candidate = held.value.find(tile => tile.id === selected.value) ?? held.value[0]
  if (!candidate) return result
  for (let at = 0; at < SIZE * SIZE; at++) {
    if (filled(at)) continue
    if (placed.length) {
      if (readPlacement(board, [...placed, { at, letter: candidate.tile === BLANK ? 'A' : candidate.tile, blank: candidate.tile === BLANK }]).ok) result.add(at)
    } else if (board === EMPTY.repeat(SIZE * SIZE)) {
      if (at === CENTRE) result.add(at)
    } else if ([at - SIZE, at + SIZE, ...(at % SIZE ? [at - 1] : []), ...(at % SIZE < SIZE - 1 ? [at + 1] : [])].some(other => other >= 0 && other < SIZE * SIZE && board[other] !== EMPTY)) result.add(at)
  }
  return result
})

async function practiceHint(): Promise<void> {
  if (props.view.list !== 'practice' || mode.value !== 'play' || fresh.value.length || !props.canMove || hintBusy.value) return
  hintBusy.value = true
  const board = props.view.board, hand = props.view.rack
  try {
    if (!hintLexicon) {
      const { EVERYDAY_WORDS, MORE_WORDS } = await import('../../../../shared/games/words-practice.ts')
      hintLexicon = buildLexicon([...EVERYDAY_WORDS.split(' '), ...MORE_WORDS.split(' ')])
    }
    if (props.view.board !== board || props.view.rack !== hand || mode.value !== 'play' || fresh.value.length || !props.canMove) return
    const move = findPlacements(board, hand ?? '', hintLexicon, 120_000)[0]
    if (!move) { slip.value = 'No word found in the practice search. Try swapping tiles or passing.'; return }
    const available = [...held.value]
    for (const placement of move.tiles) {
      const index = available.findIndex(tile => tile.tile === (placement.blank ? BLANK : placement.letter))
      const tile = available.splice(index, 1)[0]
      if (tile) put(tile.id, placement.at, placement.letter)
    }
    await nextTick()
    slip.value = 'Practice hint. Change the tiles if you like, then Play.'
  } catch { slip.value = 'The practice hint could not load. You can still build a word yourself.' } finally { hintBusy.value = false }
}

// ── Putting tiles down and taking them back ─────────────────────────────────────────────────

function advance(from: number): number | null {
  const step = across.value ? 1 : SIZE
  for (let at = from + step; at < SIZE * SIZE && (!across.value || Math.floor(at / SIZE) === Math.floor(from / SIZE)); at += step) if (!filled(at)) return at
  return null
}

/** Put a rack tile on a square. A blank asks which letter it stands for first, unless one is given. */
function put(id: number, at: number, as?: string): void {
  const tile = rack.value.find(entry => entry.id === id)
  if (!tile || props.view.board[at] !== EMPTY || fresh.value.some(placed => placed.at === at && placed.id !== id)) return
  if (tile.tile === BLANK && !as) {
    blankFor.value = { id, at }
    void nextTick(() => chooserEl.value?.querySelector('button')?.focus())
    return
  }
  const letter = tile.tile === BLANK ? as! : tile.tile
  fresh.value = [...fresh.value.filter(placed => placed.id !== id), { id, at, letter, blank: tile.tile === BLANK }]
  selected.value = null
  blankFor.value = null
  // Two or more tiles in a line show which way the word runs.
  if (fresh.value.length > 1) {
    if (fresh.value.every(placed => Math.floor(placed.at / SIZE) === Math.floor(at / SIZE))) across.value = true
    else if (fresh.value.every(placed => placed.at % SIZE === at % SIZE)) across.value = false
  }
  cursor.value = advance(at)
  cue('place')
  reveal(cursor.value ?? at)
}

function takeBack(id: number): void {
  const placed = fresh.value.find(tile => tile.id === id)
  if (!placed) return
  fresh.value = fresh.value.filter(tile => tile.id !== id)
  cursor.value = placed.at
  cue('lift')
}
function recall(): void {
  if (!fresh.value.length) return
  fresh.value = []
  selected.value = null
  cursor.value = null
  cue('lift')
}
function shuffle(): void {
  const tiles = [...rack.value]
  for (let i = tiles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = tiles[i]!
    tiles[i] = tiles[j]!
    tiles[j] = swap
  }
  rack.value = tiles
  cue('lift')
}

let lastTap = { at: -1, time: 0 }
function tapCell(at: number): void {
  if (skipClick) return
  // Two quick taps on a small board zoom in on that spot (and back out).
  const now = performance.now()
  if ((cellPx.value < 38 || zoom.value > 1) && lastTap.at === at && now - lastTap.time < 320) { lastTap = { at: -1, time: 0 }; toggleZoom(at); return }
  lastTap = { at, time: now }
  if (watching.value || over.value || mode.value !== 'play') return
  const mine = fresh.value.find(tile => tile.at === at)
  if (mine) { takeBack(mine.id); return }
  if (props.view.board[at] !== EMPTY) { selected.value = null; return }
  if (selected.value !== null) { put(selected.value, at); return }
  if (cursor.value === at) across.value = !across.value
  else cursor.value = at
}

function tapRack(id: number): void {
  if (skipClick) return
  if (mode.value === 'swap') { swapping.value = swapping.value.includes(id) ? swapping.value.filter(other => other !== id) : [...swapping.value, id]; return }
  if (mode.value !== 'play') return
  if (cursor.value !== null && !filled(cursor.value)) { put(id, cursor.value); return }
  selected.value = selected.value === id ? null : id
}

function chooseBlank(letter: string): void {
  if (blankFor.value) {
    const at = blankFor.value.at
    put(blankFor.value.id, at, letter)
    focusCell(cursor.value ?? at)
  }
}
function cancelBlank(): void {
  const at = blankFor.value?.at
  blankFor.value = null
  if (at !== undefined) focusCell(at)
}

function send(move: WordsMove): void {
  sent.value = true
  emit('move', move)
  // The lab can reject the same word twice without changing its problem string.
  void nextTick(() => { if (props.problem) sent.value = false })
}

// ── Sending a move ──────────────────────────────────────────────────────────────────────────

function play(): void {
  if (!fresh.value.length) return
  if (!reading.value?.ok) { slip.value = reading.value?.problem ?? ''; cue('refused'); return }
  if (!props.canMove || sent.value) return
  send({ kind: 'place', tiles: fresh.value.map(tile => (tile.blank ? { at: tile.at, letter: tile.letter, blank: true } : { at: tile.at, letter: tile.letter })) })
}
function startSwap(): void {
  fresh.value = []
  selected.value = null
  swapping.value = []
  mode.value = 'swap'
}
function confirmSwap(): void {
  const tiles = rack.value.filter(tile => swapping.value.includes(tile.id)).map(tile => tile.tile).join('')
  if (!tiles || !props.canMove || sent.value) return
  send({ kind: 'exchange', tiles })
}
function confirmPass(): void {
  if (!props.canMove || sent.value) return
  mode.value = 'play'
  send({ kind: 'pass' })
}

// ── Dragging ────────────────────────────────────────────────────────────────────────────────

const drag = ref<{ id: number; letter: string; blank: boolean; x: number; y: number; over: number | null; slot: number | null } | null>(null)
let hold: { id: number; from: 'rack' | 'board'; x: number; y: number; pointer: number; lift: number; active: boolean } | null = null
let skipClick = false

function tileDown(event: PointerEvent, id: number, from: 'rack' | 'board'): void {
  if (event.button !== 0 || mode.value !== 'play' || watching.value || over.value) return
  hold = { id, from, x: event.clientX, y: event.clientY, pointer: event.pointerId, lift: event.pointerType === 'mouse' ? 0 : 34, active: false }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
}
function tileMove(event: PointerEvent): void {
  if (!hold || event.pointerId !== hold.pointer || !rootEl.value) return
  if (!hold.active && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) < 8) return
  hold.active = true
  selected.value = null
  const x = event.clientX, y = event.clientY - hold.lift
  const under = document.elementFromPoint(x, y)
  const square = under?.closest<HTMLElement>('[data-at]')
  const at = square && rootEl.value.contains(square) ? Number(square.dataset.at) : null
  const free = at !== null && props.view.board[at] === EMPTY && !fresh.value.some(tile => tile.at === at && tile.id !== hold!.id)
  // Over the rack: which gap the tile would drop into.
  let slot: number | null = null
  const shelf = under?.closest<HTMLElement>('.rack')
  if (shelf && rootEl.value.contains(shelf)) {
    const others = [...shelf.querySelectorAll<HTMLElement>('.rack-tile')].filter(element => Number(element.dataset.id) !== hold!.id)
    slot = others.findIndex(element => { const box = element.getBoundingClientRect(); return x < box.left + box.width / 2 })
    if (slot === -1) slot = others.length
  }
  const frame = rootEl.value.getBoundingClientRect()
  const tile = rack.value.find(entry => entry.id === hold!.id)
  const placed = fresh.value.find(entry => entry.id === hold!.id)
  drag.value = { id: hold.id, letter: placed?.letter ?? tile?.tile ?? BLANK, blank: placed?.blank ?? tile?.tile === BLANK, x: x - frame.left, y: y - frame.top, over: free ? at : null, slot }
  // Near the edge of a zoomed board: slide it along.
  const view = viewportEl.value
  if (view && zoom.value > 1) {
    const box = view.getBoundingClientRect()
    if (y > box.top && y < box.bottom) { if (x < box.left + 26) view.scrollLeft -= 9; else if (x > box.right - 26) view.scrollLeft += 9 }
    if (x > box.left && x < box.right) { if (y < box.top + 26) view.scrollTop -= 9; else if (y > box.bottom - 26) view.scrollTop += 9 }
  }
}
function tileUp(event: PointerEvent): void {
  if (!hold || event.pointerId !== hold.pointer) return
  const moved = hold.active, { id, from } = hold, target = drag.value
  hold = null
  drag.value = null
  if (!moved) return
  // The click that follows a drag is not a tap.
  skipClick = true
  setTimeout(() => { skipClick = false }, 0)
  if (target?.over !== null && target?.over !== undefined) { put(id, target.over, fresh.value.find(tile => tile.id === id)?.blank ? fresh.value.find(tile => tile.id === id)!.letter : undefined); return }
  if (target?.slot !== null && target?.slot !== undefined) {
    if (from === 'board') takeBack(id)
    const moving = rack.value.find(tile => tile.id === id)
    if (!moving) return
    // `slot` counts the tiles showing on the rack; place the tile before the one now in that slot.
    const showing = held.value.filter(tile => tile.id !== id)
    const before = showing[target.slot]
    const rest = rack.value.filter(tile => tile.id !== id)
    const index = before ? rest.findIndex(tile => tile.id === before.id) : rest.length
    rack.value = [...rest.slice(0, index), moving, ...rest.slice(index)]
    return
  }
  if (from === 'board') takeBack(id)
  else { slip.value = 'Drop the tile on an empty square, or tap a tile then a square.'; cue('refused') }
}
function tileCancel(): void { hold = null; drag.value = null }

// ── Zoom ────────────────────────────────────────────────────────────────────────────────────

const zoomTo = computed(() => Math.min(2.4, Math.max(1.5, 50 / cellPx.value)))
/** Bring a square into view when the board is zoomed. */
function reveal(at: number): void {
  if (zoom.value <= 1) return
  void nextTick(() => viewportEl.value?.querySelector(`[data-at="${at}"]`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
}
function toggleZoom(at?: number): void {
  const view = viewportEl.value
  if (!view) return
  if (zoom.value > 1) { zoom.value = 1; return }
  const target = at ?? cursor.value ?? fresh.value.at(-1)?.at ?? CENTRE
  zoom.value = zoomTo.value
  void nextTick(() => {
    const side = view.clientWidth, span = side * zoom.value
    view.scrollLeft = ((target % SIZE) + 0.5) / SIZE * span - side / 2
    view.scrollTop = (Math.floor(target / SIZE) + 0.5) / SIZE * span - side / 2
  })
}

let pinch: { distance: number; zoom: number; x: number; y: number; left: number; top: number } | null = null
const spread = (touches: TouchList): number => Math.hypot(touches[0]!.clientX - touches[1]!.clientX, touches[0]!.clientY - touches[1]!.clientY)
function touchStart(event: TouchEvent): void {
  const view = viewportEl.value
  if (event.touches.length !== 2 || !view) { pinch = null; return }
  const box = view.getBoundingClientRect()
  pinch = { distance: spread(event.touches), zoom: zoom.value, x: (event.touches[0]!.clientX + event.touches[1]!.clientX) / 2 - box.left, y: (event.touches[0]!.clientY + event.touches[1]!.clientY) / 2 - box.top, left: view.scrollLeft, top: view.scrollTop }
}
function touchMove(event: TouchEvent): void {
  const view = viewportEl.value
  if (!pinch || event.touches.length !== 2 || !view) return
  event.preventDefault()
  const start = pinch
  const next = Math.min(2.6, Math.max(1, start.zoom * spread(event.touches) / start.distance))
  zoom.value = next < 1.06 ? 1 : next
  // Keep the point between the fingers where it is.
  void nextTick(() => {
    view.scrollLeft = (start.left + start.x) / start.zoom * zoom.value - start.x
    view.scrollTop = (start.top + start.y) / start.zoom * zoom.value - start.y
  })
}
function touchEnd(event: TouchEvent): void { if (event.touches.length < 2) pinch = null }

let sizer: ResizeObserver | null = null
onMounted(() => {
  const view = viewportEl.value
  if (!view) return
  view.addEventListener('touchstart', touchStart, { passive: true })
  view.addEventListener('touchmove', touchMove, { passive: false })
  view.addEventListener('touchend', touchEnd, { passive: true })
  view.addEventListener('touchcancel', touchEnd, { passive: true })
  sizer = new ResizeObserver(() => { cellPx.value = view.clientWidth / SIZE })
  sizer.observe(view)
})
onBeforeUnmount(() => {
  sizer?.disconnect()
  const view = viewportEl.value
  view?.removeEventListener('touchstart', touchStart)
  view?.removeEventListener('touchmove', touchMove)
  view?.removeEventListener('touchend', touchEnd)
  view?.removeEventListener('touchcancel', touchEnd)
})

// ── Keyboard ────────────────────────────────────────────────────────────────────────────────

const focusAt = computed(() => cursor.value ?? CENTRE)
function focusCell(at: number): void {
  void nextTick(() => viewportEl.value?.querySelector<HTMLElement>(`[data-at="${at}"]`)?.focus({ preventScroll: zoom.value <= 1 }))
  reveal(at)
}
function moveCursor(key: string, from: number): void {
  const row = Math.floor(from / SIZE), col = from % SIZE
  const next = key === 'ArrowLeft' ? (col > 0 ? from - 1 : from) : key === 'ArrowRight' ? (col < SIZE - 1 ? from + 1 : from) : key === 'ArrowUp' ? (row > 0 ? from - SIZE : from) : row < SIZE - 1 ? from + SIZE : from
  across.value = key === 'ArrowLeft' || key === 'ArrowRight'
  cursor.value = next
  focusCell(next)
}
function typeLetter(letter: string, asBlank: boolean, focused: number | null): void {
  if (cursor.value === null && focused !== null) cursor.value = focused
  if (cursor.value === null) { slip.value = 'Pick a square first: tap one, or move to one with the arrow keys.'; return }
  let at: number | null = cursor.value
  if (filled(at)) at = advance(at)
  if (at === null) { slip.value = 'There is no empty square further along this line.'; return }
  const tile = (asBlank ? undefined : held.value.find(entry => entry.tile === letter)) ?? held.value.find(entry => entry.tile === BLANK)
  if (!tile) { slip.value = `There is no ${letter} on your rack.`; cue('refused'); return }
  put(tile.id, at, letter)
  if (cursor.value !== null) focusCell(cursor.value)
}
function onKey(event: KeyboardEvent): void {
  if (event.metaKey || event.ctrlKey || event.altKey) return
  const target = event.target instanceof HTMLElement ? event.target : null
  const square = target?.closest<HTMLElement>('[data-at]')
  const focused = square ? Number(square.dataset.at) : null
  const key = event.key
  const letter = /^[a-zA-Z]$/.test(key) ? key.toUpperCase() : ''
  let used = true
  if (blankFor.value) {
    if (key === 'Tab') {
      const buttons = [...(chooserEl.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])]
      const index = buttons.findIndex(button => button === document.activeElement)
      const next = index < 0 ? (event.shiftKey ? buttons.length - 1 : 0) : (index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length
      buttons[next]?.focus()
    } else if (letter) chooseBlank(letter)
    else if (key === 'Escape') cancelBlank()
    else used = false
  } else if (key === 'Escape' && (mode.value !== 'play' || fresh.value.length || showUnseen.value)) {
    if (mode.value !== 'play') mode.value = 'play'
    else if (fresh.value.length) recall()
    else showUnseen.value = false
  } else if (key.startsWith('Arrow') && focused !== null) moveCursor(key, cursor.value ?? focused)
  else if (watching.value || over.value || mode.value !== 'play') used = false
  else if (letter) typeLetter(letter, event.shiftKey, focused)
  else if (key === 'Backspace') { const latest = fresh.value.at(-1); if (latest) { takeBack(latest.id); focusCell(latest.at) } }
  else if (key === 'Delete' && focused !== null) { const mine = fresh.value.find(tile => tile.at === focused); if (mine) takeBack(mine.id) }
  else if (key === ' ' && focused !== null) { cursor.value = focused; across.value = !across.value }
  else if (key === 'Enter' && focused !== null && fresh.value.length) play()
  else used = false
  // The world behind the window listens for keys too (walking, chat on Enter): keep ours here.
  if (used) { event.preventDefault(); event.stopPropagation() } else if (key === 'Enter' || key === ' ' || letter) event.stopPropagation()
}
</script>

<template>
  <div class="words-frame">
  <div ref="rootEl" class="words" :class="{ zoomed: zoom > 1, dragging: drag }" @keydown="onKey">
    <div class="scores" :inert="blankFor !== null" role="list" aria-label="Scores">
      <div v-for="(score, index) in view.scores" :key="index" class="seat" :class="{ turn: !over && view.turn === index, out: view.out[index] }" role="listitem">
        <span class="who"><span class="name truncate">{{ nameOf(index) }}</span><span v-if="!over && view.turn === index" class="chip amber tiny-chip">to play</span><span v-else-if="view.out[index]" class="chip tiny-chip">out</span></span>
        <span class="tally">
          <strong class="score num">{{ score }}</strong>
          <span class="rack-count tiny muted" :aria-label="`holds ${tilesText(view.rackCounts[index] ?? 0)}`"><span class="back" aria-hidden="true"></span>{{ view.rackCounts[index] }}</span>
        </span>
        <span v-if="flash && flash.seat === index" :key="flash.key" class="flash num" aria-hidden="true">{{ flash.text }}</span>
      </div>
      <button class="seat bag" type="button" :aria-expanded="showUnseen" aria-controls="words-unseen" :title="showUnseen ? 'Hide the tiles not seen yet' : 'Show the tiles not seen yet'" @click="showUnseen = !showUnseen">
        <span class="who"><span class="name">Bag</span></span>
        <span class="tally"><strong class="score num">{{ view.bag }}</strong><span class="tiny muted">left</span></span>
      </button>
    </div>

    <div class="stage" :inert="blankFor !== null">
      <div class="ruler top" aria-hidden="true"><span v-for="letter in LETTERS.slice(0, SIZE)" :key="letter">{{ letter }}</span></div>
      <div class="ruler left" aria-hidden="true"><span v-for="n in SIZE" :key="n">{{ n }}</span></div>
      <div ref="viewportEl" class="viewport">
        <div class="grid" role="grid" :aria-label="`${NAME} board, ${SIZE} by ${SIZE}. Arrow keys move, letters place tiles, Enter plays.`" :style="{ '--zoom': zoom }">
          <div v-for="(row, r) in rows" :key="r" class="line" role="row">
            <div v-for="cell in row" :key="cell.at" class="slot" role="gridcell" :aria-selected="cursor === cell.at">
              <button
                type="button" class="cell" :data-at="cell.at" :tabindex="focusAt === cell.at ? 0 : -1" :aria-label="cell.label + (connections.has(cell.at) ? ', possible connection' : '')"
                :class="[cell.premium ? `p${cell.premium}` : '', { centre: cell.at === CENTRE, cursor: cursor === cell.at, over: drag?.over === cell.at, tall: r === 0, wide: cell.at % SIZE > SIZE - 3 }]"
                @click="tapCell(cell.at)"
              >
                <span v-if="cell.tile" class="set" :class="{ landed: cell.last }" :style="{ '--order': cell.order }"><WordTile :letter="cell.tile.letter" :blank="cell.tile.blank" :tone="cell.last ? 'last' : 'plain'" /></span>
                <span
                  v-else-if="cell.mine" class="set mine" :class="{ lifted: drag?.id === cell.mine.id }"
                  @pointerdown="tileDown($event, cell.mine.id, 'board')" @pointermove="tileMove" @pointerup="tileUp" @pointercancel="tileCancel"
                ><WordTile :letter="cell.mine.letter" :blank="cell.mine.blank" tone="fresh" /></span>
                <span v-else-if="cursor === cell.at" class="arrow" aria-hidden="true">{{ across ? '▶' : '▼' }}</span>
                <span v-else-if="cell.premium" class="mark" aria-hidden="true">{{ cell.premium }}</span>
                <span v-else-if="cell.at === CENTRE" class="mark" aria-hidden="true">◆</span>
                <span v-if="connections.has(cell.at) && cursor !== cell.at" class="connection" aria-hidden="true"></span>
                <span v-if="bubbleAt === cell.at && reading?.ok" class="bubble num" aria-hidden="true">{{ reading.score }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      <button v-if="cellPx < 38 || zoom > 1" class="zoom btn icon sm" type="button" :aria-pressed="zoom > 1" :aria-label="zoom > 1 ? 'Show the whole board' : 'Zoom in'" :title="zoom > 1 ? 'Show the whole board' : 'Zoom in (or tap twice, or pinch)'" @click="toggleZoom()">
        <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" fill="none" stroke="currentColor" stroke-width="2" /><path d="M13 13l4.5 4.5M6 8.5h5" stroke="currentColor" stroke-width="2" stroke-linecap="round" /><path v-if="zoom <= 1" d="M8.5 6v5" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
      </button>
    </div>

    <div class="side" :inert="blankFor !== null">
      <div class="status" aria-live="polite">
        <p v-if="problem" class="notice coral" role="alert">{{ problem }}</p>
        <p v-else-if="slip" class="notice sky">{{ slip }}</p>
        <p v-if="mode === 'swap'" class="notice amber">Tap the tiles to put back. You get as many new ones, and your turn ends.</p>
        <p v-else-if="mode === 'pass'" class="notice amber">Pass and score nothing this turn?{{ view.scorelessLeft <= 1 ? ' The game ends if nobody scores now.' : '' }}</p>
        <p v-else-if="reading?.ok" class="made">
          <span v-for="(word, index) in reading.words" :key="index" class="word"><strong>{{ word.word }}</strong> <span class="num">{{ word.score }}</span></span>
          <span v-if="reading.wholeRack" class="word bonus"><strong>All seven</strong> <span class="num">+{{ WHOLE_RACK_BONUS }}</span></span>
          <span class="total num">= {{ points(reading.score) }}</span>
        </p>
        <p v-else-if="reading" class="notice">{{ reading.problem }}</p>
        <p v-else class="hint small"><span v-if="lastLine && !over" class="last-line">{{ lastLine }}</span> {{ turnLine }}</p>
      </div>

      <template v-if="!watching && !over">
        <div class="rack" role="group" :aria-label="mode === 'swap' ? 'Your rack: choose tiles to swap' : 'Your rack'">
          <button
            v-for="tile in held" :key="tile.id" type="button" class="rack-tile" :data-id="tile.id"
            :class="{ lifted: drag?.id === tile.id, picked: mode === 'swap' ? swapping.includes(tile.id) : selected === tile.id }"
            :aria-pressed="mode === 'swap' ? swapping.includes(tile.id) : selected === tile.id"
            :aria-label="tile.tile === BLANK ? 'Blank tile: stands for any letter, no points' : `${tile.tile}, ${points(tileValue(tile.tile))}`"
            @click="tapRack(tile.id)" @pointerdown="tileDown($event, tile.id, 'rack')" @pointermove="tileMove" @pointerup="tileUp" @pointercancel="tileCancel"
          ><WordTile :letter="tile.tile" /></button>
          <span v-if="!held.length" class="tiny muted rack-empty">All your tiles are on the board.</span>
        </div>

        <div v-if="mode === 'swap'" class="actions">
          <button class="btn" type="button" @click="mode = 'play'">Cancel</button>
          <button class="btn primary grow" type="button" :disabled="!swapping.length || !canMove || sent" @click="confirmSwap">{{ swapping.length ? `Swap ${tilesText(swapping.length)}` : 'Choose tiles' }}</button>
        </div>
        <div v-else-if="mode === 'pass'" class="actions">
          <button class="btn" type="button" @click="mode = 'play'">Keep playing</button>
          <button class="btn dark grow" type="button" :disabled="!canMove || sent" @click="confirmPass">Pass the turn</button>
        </div>
        <div v-else class="actions">
          <button class="btn icon" type="button" aria-label="Shuffle your rack" title="Shuffle your rack" @click="shuffle">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M2 5h3.5c4 0 5 10 9 10H18M2 15h3.5c1.4 0 2.4-1.2 3.3-2.8M18 5h-3.5c-1.300 0-2.300 1-3.100 2.400M15.500 2.500 18 5l-2.500 2.500M15.500 12.500 18 15l-2.500 2.500" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <button class="btn icon" type="button" aria-label="Take your tiles back off the board" title="Take tiles back (Esc)" :disabled="!fresh.length" @click="recall">
            <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M7 4 3 8l4 4M3.500 8H12a5 5 0 0 1 0 10H8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>
          </button>
          <button class="btn" type="button" :disabled="!canMove || sent || !view.canExchange" :title="view.canExchange ? 'Put tiles back in the bag for new ones' : `Swapping needs ${EXCHANGE_MIN} tiles in the bag`" @click="startSwap">Swap</button>
          <button class="btn" type="button" :disabled="!canMove || sent" @click="mode = 'pass'">Pass</button>
          <button class="btn primary grow" type="button" :disabled="!canPlay" @click="play">{{ reading?.ok ? `Play ${reading.score}` : 'Play' }}</button>
        </div>
      </template>

      <div v-if="!watching && !over" class="assist">
        <span class="tiny muted">{{ cursor !== null ? `${cellName(cursor)} · ${across ? 'across' : 'down'}` : cellPx < 38 || zoom > 1 ? 'Tap twice or use + to zoom' : 'Arrow keys move · Space turns' }}</span>
        <button v-if="view.list === 'practice'" class="btn sm" type="button" :disabled="mode !== 'play' || !canMove || sent || fresh.length > 0 || hintBusy" @click="practiceHint">{{ hintBusy ? 'Finding…' : 'Hint' }}</button>
      </div>
      <p v-if="reading?.ok" class="tiny muted">{{ view.list === 'practice' ? 'The practice list checks your word when you play.' : 'The word list checks every word when you play.' }}</p>

      <div v-if="showUnseen" id="words-unseen" class="unseen">
        <p class="tiny muted">Tiles you have not seen: the bag and {{ watching ? 'every rack' : 'the other racks' }} together.</p>
        <ul aria-label="Tiles not seen yet">
          <li v-for="entry in unseen" :key="entry.tile" :class="{ none: !entry.count }"><strong>{{ entry.tile === BLANK ? 'Blank' : entry.tile }}</strong><span class="num">{{ entry.count }}</span></li>
        </ul>
      </div>

      <p v-if="view.list === 'unchecked'" class="tiny muted list-note">Words are not being checked against a word list here.</p>
      <!-- Everything that is reference rather than play: what the squares are worth, sound, the word list, the rules. -->
      <details class="rules-help">
        <summary>Square values, sound and how to play</summary>
        <div class="help-body">
          <div class="foot">
            <ul class="legend" aria-label="Premium squares">
              <li v-for="item in LEGEND" :key="item.premium"><span class="swatch" :class="`p${item.premium}`" aria-hidden="true">{{ item.premium }}</span><span class="tiny"><span class="sr-only">{{ item.premium }}: </span>{{ item.text }}</span></li>
            </ul>
            <button class="btn sm ghost sound" type="button" role="switch" :aria-checked="soundOn" @click="setSound(!soundOn)">
              <svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M3 8v4h3l4 3.500v-11L6 8H3z" fill="currentColor" /><path v-if="soundOn" d="M13 7.500c1 .800 1 4.200 0 5M15 5.500c2.200 2 2.200 7 0 9" fill="none" stroke="currentColor" stroke-width="1.600" stroke-linecap="round" /><path v-else d="m13 8 4 4m0-4-4 4" stroke="currentColor" stroke-width="1.600" stroke-linecap="round" /></svg>
              Sound {{ soundOn ? 'on' : 'off' }}
            </button>
          </div>
          <p v-if="view.list === 'practice'" class="tiny muted list-note">Practice word list: about 11,000 everyday words, so some real words are turned down here. The hall checks against the full list of 160,000.</p>
          <HowTo />
        </div>
      </details>
    </div>

    <div v-if="blankFor" class="chooser" @click.self="cancelBlank">
      <div ref="chooserEl" class="chooser-card" role="dialog" aria-modal="true" aria-label="Which letter is the blank?">
        <div class="row between"><strong>Which letter is the blank?</strong><button class="btn ghost sm" type="button" @click="cancelBlank">Cancel</button></div>
        <div class="letters"><button v-for="letter in LETTERS" :key="letter" type="button" class="letter" @click="chooseBlank(letter)">{{ letter }}</button></div>
        <p class="tiny muted">A blank scores nothing, whatever it stands for.</p>
      </div>
    </div>

    <div v-if="drag" class="drag-tile" :style="{ left: `${drag.x}px`, top: `${drag.y}px` }" aria-hidden="true"><WordTile :letter="drag.letter" :blank="drag.blank && drag.letter !== BLANK" tone="fresh" /></div>
  </div>
  </div>
</template>

<style scoped>
.words-frame { container: word-yard / inline-size; width: 100%; max-width: 1040px; min-width: 0; margin: 0 auto; align-self: start; }
.words {
  position: relative; width: 100%; min-width: 0;
  display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; justify-items: center;
  --gap: 1.5px; --rack: min(46px, calc((100cqi - 42px) / 7));
  /* The board is as wide as its container, but never so tall that the rack falls off the screen.
     A host with more around the board can set --words-reserve (the height everything else needs). */
  --side: min(100cqi, max(240px, calc(100dvh - var(--words-reserve, 330px))));
}
.words button { -webkit-tap-highlight-color: transparent; }
.scores, .side { width: 100%; max-width: max(var(--side), 320px); }

/* Scores */
.scores { display: flex; gap: 6px; align-items: stretch; }
.seat { position: relative; flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 1px; padding: 6px 10px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); text-align: left; }
.seat.turn { border-color: #f1c866; background: linear-gradient(135deg, #fff6df, var(--surface) 75%); box-shadow: 0 0 0 2px rgba(255, 176, 32, 0.22); }
.seat.out { opacity: 0.6; }
.who { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 0.8rem; font-weight: 650; color: var(--ink-2); }
.who .name { min-width: 0; }
.tiny-chip { padding: 0 6px; font-size: 0.66rem; line-height: 16px; flex: none; }
.tally { display: flex; align-items: baseline; gap: 8px; }
.score { font-size: 1.25rem; line-height: 1.15; letter-spacing: -0.02em; }
.rack-count { display: inline-flex; align-items: center; gap: 4px; }
.back { width: 10px; height: 10px; border-radius: 3px; background: linear-gradient(175deg, #fbeecb, #e9d29a); box-shadow: inset 0 0 0 1px rgba(150, 112, 30, 0.45); }
.seat.bag { flex: 0 0 auto; min-width: 62px; cursor: pointer; }
.seat.bag:hover { border-color: var(--line-strong); background: var(--surface-2); }
.flash { position: absolute; right: 10px; top: 4px; font-weight: 800; color: #1f7447; animation: rise-away 1.6s ease-out forwards; pointer-events: none; }
@keyframes rise-away { 0% { transform: translateY(8px); opacity: 0; } 18% { transform: translateY(0); opacity: 1; } 75% { opacity: 1; } 100% { transform: translateY(-10px); opacity: 0; } }

/* Board */
.stage { position: relative; width: var(--side); }
.ruler { display: none; }
.viewport { width: var(--side); height: var(--side); border-radius: 12px; overflow: hidden; background: #cbbf9f; box-shadow: 0 1px 2px rgba(40, 30, 10, 0.1), 0 8px 22px rgba(40, 30, 10, 0.12); touch-action: pan-x pan-y; }
.zoomed .viewport { overflow: auto; overscroll-behavior: contain; scrollbar-width: none; }
.zoomed .viewport::-webkit-scrollbar { display: none; }
.grid {
  --span: calc(var(--side) * var(--zoom, 1)); --tile: calc((var(--span) - 14 * var(--gap)) / 13);
  width: var(--span); height: var(--span); display: grid; grid-template-columns: repeat(13, minmax(0, 1fr)); grid-template-rows: repeat(13, minmax(0, 1fr)); gap: var(--gap); padding: var(--gap);
}
.line, .slot { display: contents; }
.cell {
  position: relative; display: grid; place-items: center; min-width: 0; min-height: 0; padding: 0; border: 0; border-radius: 13%;
  background: #f8f2e4; color: #b9ad90; font-size: calc(var(--tile) * 0.36); font-weight: 800; letter-spacing: -0.03em; line-height: 1;
  -webkit-tap-highlight-color: transparent; touch-action: manipulation;
}
.cell:focus-visible { outline: 3px solid var(--ink); outline-offset: -3px; border-radius: 13%; z-index: 2; }
.cell.p2L { background: #d7eaf8; color: #1b6aa6; }
.cell.p3L { background: #3b93d4; color: #fff; }
.cell.p2W { background: #e6defa; color: #5a43ad; }
.cell.p3W { background: #7559cc; color: #fff; }
.cell.centre { background: var(--accent-soft); color: var(--accent-strong); }
.cell.cursor { box-shadow: inset 0 0 0 2px var(--accent-strong); background: #fff3d4; color: var(--accent-text); z-index: 1; }
.cell.over { box-shadow: inset 0 0 0 3px var(--leaf); background: var(--leaf-soft); z-index: 1; }
.connection { position: absolute; width: 5px; height: 5px; bottom: 10%; left: calc(50% - 2.5px); border-radius: 50%; background: currentColor; opacity: 0.75; }
.arrow { font-size: calc(var(--tile) * 0.46); }
.set { position: absolute; inset: 0; display: block; }
.set.mine { touch-action: none; cursor: grab; animation: settle 0.14s ease-out; }
.set.lifted { opacity: 0.25; }
.set.landed { animation: land 0.34s cubic-bezier(0.2, 1.4, 0.4, 1) backwards; animation-delay: calc(var(--order) * 60ms); }
@keyframes settle { from { transform: scale(1.18); } }
@keyframes land { from { transform: translateY(-35%) scale(1.15); opacity: 0; } }
.bubble { position: absolute; right: -34%; top: -40%; z-index: 4; min-width: 1.7em; padding: 2px 5px; border-radius: 999px; background: var(--ink); color: #fff; font-size: max(11px, calc(var(--tile) * 0.36)); font-weight: 750; letter-spacing: 0; box-shadow: 0 2px 6px rgba(28, 26, 36, 0.35); pointer-events: none; }
.cell.tall .bubble { top: auto; bottom: -40%; }
.cell.wide .bubble { right: auto; left: -34%; }
.zoom { position: absolute; right: 6px; bottom: 6px; z-index: 5; border-radius: 50%; background: rgba(255, 253, 249, 0.94); box-shadow: var(--shadow); }
.zoom[aria-pressed="true"] { background: var(--ink); border-color: var(--ink); color: #fff; }

/* Status, rack, actions */
.side { display: flex; flex-direction: column; gap: 8px; }
.status { min-height: 40px; display: flex; flex-direction: column; justify-content: center; align-items: stretch; gap: 6px; }
.status > p { width: 100%; }
.status .notice { padding: 8px 11px; }
.hint { color: var(--ink-2); }
.last-line { font-weight: 650; color: var(--ink); }
.made { display: flex; flex-wrap: wrap; align-items: center; gap: 5px 6px; font-size: 0.88rem; }
.word { padding: 3px 9px; border-radius: 999px; background: var(--surface); border: 1px solid var(--line-strong); }
.word.bonus { background: var(--leaf-soft); border-color: #c4e6d1; color: #1c5c39; }
.total { font-weight: 750; margin-left: 2px; }

.rack { display: flex; justify-content: center; align-items: center; gap: 5px; min-height: calc(var(--rack) + 12px); padding: 6px; border-radius: 14px; background: linear-gradient(180deg, #e2d4b4, #eee3c9); box-shadow: inset 0 2px 5px rgba(90, 70, 20, 0.2), inset 0 -1px 0 rgba(255, 255, 255, 0.6); }
.rack-tile { flex: none; width: var(--rack); height: var(--rack); --tile: var(--rack); padding: 0; border: 0; border-radius: 17%; background: none; touch-action: none; cursor: grab; transition: transform 0.12s ease; }
.rack-tile:hover { transform: translateY(-2px); }
.rack-tile.picked { transform: translateY(-7px); }
.rack-tile.picked :deep(.tile) { box-shadow: inset 0 -0.11em 0 #dc9a10, inset 0 0 0 1px #e29500, 0 0 0 3px var(--ink), 0 6px 10px rgba(40, 30, 10, 0.3); }
.rack-tile.lifted { opacity: 0.25; }
.rack-empty { padding: 0 8px; }
.actions { display: flex; gap: 6px; align-items: center; }
.actions .btn { padding: 0 13px; }
.actions .btn.icon { padding: 0; flex: none; }

.assist { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 40px; }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.legend { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 4px 10px; color: var(--ink-2); }
.legend li { display: inline-flex; align-items: center; gap: 5px; }
.swatch { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 5px; font-size: 0.62rem; font-weight: 800; letter-spacing: -0.03em; }
.swatch.p2L { background: #d7eaf8; color: #1b6aa6; } .swatch.p3L { background: #3b93d4; color: #fff; }
.swatch.p2W { background: #e6defa; color: #5a43ad; } .swatch.p3W { background: #7559cc; color: #fff; }
.sound { user-select: none; -webkit-user-select: none; color: var(--ink-2); padding: 0 8px; }
.unseen { padding: 10px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); display: grid; gap: 8px; }
.unseen ul { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(44px, 1fr)); gap: 4px; }
.unseen li { display: flex; justify-content: space-between; align-items: baseline; gap: 4px; padding: 3px 7px; border-radius: 8px; background: var(--surface-2); font-size: 0.82rem; }
.unseen li:last-child { grid-column: span 2; }
.unseen li.none { opacity: 0.4; }
.list-note { text-wrap: pretty; }
.rules-help { border-top: 1px solid var(--line-strong); padding-top: 8px; }
.rules-help summary { min-height: 44px; align-content: center; cursor: pointer; font-size: 0.86rem; font-weight: 650; }
.rules-help[open] summary { margin-bottom: 10px; }
.help-body { display: flex; flex-direction: column; gap: 10px; }

/* Blank chooser and the tile in hand */
.chooser { position: absolute; inset: -4px; z-index: 20; display: grid; place-items: center; border-radius: 14px; background: rgba(28, 26, 36, 0.38); }
.chooser-card { width: min(340px, calc(100% - 16px)); display: grid; gap: 10px; padding: 14px; border-radius: 16px; background: var(--surface); box-shadow: var(--shadow-lg); }
.letters { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 5px; }
.letter { aspect-ratio: 1; min-height: 40px; border: 0; border-radius: 9px; background: linear-gradient(175deg, #fffdf4, #f3dfa9); box-shadow: inset 0 -2px 0 #d8bd77, inset 0 0 0 1px rgba(150, 112, 30, 0.38); font-weight: 800; font-size: 1.05rem; color: var(--ink); }
.letter:hover { background: linear-gradient(175deg, #fff0bd, #ffc23c); }
.drag-tile { position: absolute; z-index: 30; width: 52px; height: 52px; --tile: 52px; margin: -26px 0 0 -26px; pointer-events: none; transform: rotate(-4deg); filter: drop-shadow(0 8px 10px rgba(28, 26, 36, 0.35)); }
.dragging { cursor: grabbing; user-select: none; -webkit-user-select: none; }

@container word-yard (min-width: 480px) {
  .words { --gap: 2px; }
}

/* Room for two columns: the board on the left with its square names, everything else beside it. */
@container word-yard (min-width: 760px) {
  .words {
    grid-template-columns: auto minmax(280px, 320px); grid-template-areas: 'stage scores' 'stage side'; grid-template-rows: auto 1fr; justify-content: center; align-items: start; gap: 10px 20px;
    --rack: 38px;
    --side: min(calc(100cqi - 362px), max(300px, calc(100dvh - var(--words-reserve-wide, 250px))), 660px);
  }
  .stage { grid-area: stage; width: calc(var(--side) + 20px); padding: 20px 0 0 20px; }
  .scores { grid-area: scores; flex-wrap: wrap; max-width: none; }
  .side { grid-area: side; max-width: none; gap: 10px; }
  .seat { flex: 1 1 110px; }
  .ruler { position: absolute; display: grid; color: var(--muted); font-size: 0.7rem; font-weight: 700; text-align: center; }
  .ruler.top { left: 20px; top: 2px; width: var(--side); grid-template-columns: repeat(13, 1fr); padding: 0 var(--gap); }
  .ruler.left { left: 0; top: 20px; width: 16px; height: var(--side); grid-template-rows: repeat(13, 1fr); align-items: center; padding: var(--gap) 0; }
  .zoomed .ruler { visibility: hidden; }
  .status { min-height: 56px; align-items: flex-start; }
}
@media (prefers-reduced-motion: reduce) {
  .set.mine, .set.landed, .flash, .rack-tile { animation: none; transition: none; }
  .flash { display: none; }
}
</style>
