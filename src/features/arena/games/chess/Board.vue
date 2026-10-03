<script setup lang="ts">
// The chess board. It draws one ChessView, shows what the piece in hand may do using the same
// rules the service judges by, and emits `move`; it never talks to the service. A move is shown
// at once and taken back if the hall refuses it. Tap a piece then a square, drag it, or use the
// arrow keys and Enter.
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { BoardProps } from '../../../../shared/arena.ts'
import { capturedMaterial, inCheck, kingSquare, legalMoves, positionAfter, sanOf, squares } from '../../../../shared/games/chess.ts'
import type { ChessMove, ChessPosition, ChessView, Colour, PieceKind, PromotionKind } from '../../../../shared/games/chess.ts'
import ChessPiece from './ChessPiece.vue'
import { playCue, setSound, soundOn } from './sound.ts'

const props = defineProps<BoardProps<ChessView, ChessMove>>()
const emit = defineEmits<{ move: [move: ChessMove] }>()

const FILES = 'abcdefgh'
const KIND_NAME: Record<string, string> = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' }
const PROMOTIONS: PromotionKind[] = ['q', 'n', 'r', 'b']
const RESULT: Record<string, string> = {
  checkmate: 'Checkmate', stalemate: 'Stalemate — a draw', repetition: 'Draw — the position came up three times', 'fifty-moves': 'Draw — fifty moves without a capture or pawn move',
  'insufficient-material': 'Draw — not enough pieces to mate', resigned: 'Resigned', 'resigned-insufficient-material': 'Resigned · a draw', time: 'Out of time', 'time-insufficient-material': 'Out of time — a draw', left: 'Left the game',
}

const HowTo = defineAsyncComponent(() => import('./HowTo.vue'))

const boardEl = ref<HTMLDivElement | null>(null)
const chessEl = ref<HTMLDivElement | null>(null)
const heightLimit = ref<number | null>(null)
const helpId = useId()

// A hall may give the board a fixed-height area beside a move list. Fit that area without
// imposing a height on a scrolling host whose height already comes from this component.
let sizeObserver: ResizeObserver | undefined
onMounted(() => {
  const root = chessEl.value, host = root?.parentElement
  if (!root || !host) return
  sizeObserver = new ResizeObserver(() => {
    const available = host.clientHeight - parseFloat(getComputedStyle(host).paddingTop) - parseFloat(getComputedStyle(host).paddingBottom)
    const frame = root.querySelector<HTMLElement>('.frame')
    if (!frame || available <= 0) return
    if (heightLimit.value !== null || root.offsetHeight > available + 1) {
      const surrounding = root.offsetHeight - frame.offsetHeight
      heightLimit.value = Math.max(264, Math.floor(available - surrounding))
    }
  })
  sizeObserver.observe(host)
  sizeObserver.observe(root)
})
onBeforeUnmount(() => sizeObserver?.disconnect())

// How to play, opened from the board's own "?" (the hall has its own way in as well).
const guideEl = ref<HTMLDialogElement | null>(null)
const guideOpen = ref(false)
function openGuide(): void {
  guideOpen.value = true
  guideEl.value?.showModal()
}

// ── What is shown ──

/** A move just sent, drawn before the hall answers. Dropped when the hall's view arrives or it refuses. */
const pending = ref<{ position: ChessPosition; move: ChessMove } | null>(null)
let pendingTimer: ReturnType<typeof setTimeout> | undefined
const shown = computed<ChessPosition>(() => pending.value?.position ?? props.view)
const lastShown = computed<ChessMove | null>(() => pending.value?.move ?? props.lastMove?.move ?? null)
const plies = computed(() => props.view.san.length)
const myColour = computed<Colour | null>(() => (props.seat === 0 ? 'w' : props.seat === 1 ? 'b' : null))
const interactive = computed(() => props.canMove && !pending.value && !props.view.outcome && myColour.value === props.view.turn)

const flipped = ref(props.seat === 1)
// The viewer's side sits at the bottom. Re-seat only when a game begins or the viewer takes or leaves a seat,
// so playing both sides on one device does not spin the board every move.
watch(() => props.seat, (seat, before) => {
  if (plies.value === 0 || seat === null || before === null) flipped.value = seat === 1
  if (seat === null || before === null) {
    clearTimeout(pendingTimer)
    pending.value = null
    selected.value = null
    promotion.value = null
    feedback.value = ''
    onCancel()
  }
})
watch(plies, (now, before) => { if (now === 0 && before > 0) flipped.value = props.seat === 1 })

const nameOf = (col: number, row: number): string => (flipped.value ? FILES[7 - col]! + String(row + 1) : FILES[col]! + String(8 - row))
const placeOf = (square: string): [number, number] => {
  const file = square.charCodeAt(0) - 97, rank = Number(square[1])
  return flipped.value ? [7 - file, rank - 1] : [file, 8 - rank]
}
const pieceMap = computed(() => {
  const map = new Map<string, string>()
  squares(shown.value).forEach((piece, index) => { if (piece) map.set(FILES[index % 8]! + String(8 - Math.floor(index / 8)), piece) })
  return map
})
const mine = (square: string): boolean => {
  const piece = pieceMap.value.get(square)
  return Boolean(piece) && interactive.value && (piece === piece!.toUpperCase() ? 'w' : 'b') === myColour.value
}

const legal = computed(() => (interactive.value ? legalMoves(props.view) : []))
const selected = ref<string | null>(null)
const feedback = ref('')
const targets = computed(() => {
  const map = new Map<string, ChessMove[]>()
  if (selected.value) for (const move of legal.value) if (move.from === selected.value) map.set(move.to, [...(map.get(move.to) ?? []), move])
  return map
})
const hover = ref<string | null>(null)
const checkSquare = computed(() => {
  const checked = pending.value ? inCheck(shown.value) : props.view.check
  return checked ? kingSquare(shown.value, shown.value.turn) : null
})

interface Cell { name: string; dark: boolean; piece: string; rankLabel: string; fileLabel: string }
const cells = computed<Cell[]>(() => {
  const out: Cell[] = []
  for (let row = 0; row < 8; row++) for (let col = 0; col < 8; col++) {
    const name = nameOf(col, row), file = name.charCodeAt(0) - 97, rank = Number(name[1])
    out.push({ name, dark: (file + rank) % 2 === 1, piece: pieceMap.value.get(name) ?? '', rankLabel: col === 0 ? name[1]! : '', fileLabel: row === 7 ? name[0]! : '' })
  }
  return out
})

const pieceName = (piece: string): string => `${piece === piece.toUpperCase() ? 'white' : 'black'} ${KIND_NAME[piece.toLowerCase()]!}`
function labelOf(cell: Cell): string {
  const parts = [cell.name, cell.piece ? pieceName(cell.piece) : 'empty']
  if (cell.name === selected.value) parts.push('picked up')
  if (targets.value.has(cell.name)) parts.push(cell.piece ? 'can capture here' : 'can move here')
  if (cell.name === checkSquare.value) parts.push('in check')
  if (lastShown.value && (cell.name === lastShown.value.from || cell.name === lastShown.value.to)) parts.push('last move')
  return parts.join(', ')
}

// ── Pieces as things that slide ──

interface Sprite { id: number; piece: string; square: string }
const sprites = ref<Sprite[]>([])
let nextSprite = 1
const distance = (a: string, b: string): number => Math.abs(a.charCodeAt(0) - b.charCodeAt(0)) + Math.abs(a.charCodeAt(1) - b.charCodeAt(1))

/** Carry each piece on screen over to where it now stands, so a move is a slide and a capture is a piece going away. */
function settlePieces(): void {
  const want = pieceMap.value, before = sprites.value, hint = lastShown.value
  const used = new Set<number>(), next: Sprite[] = [], open = new Map(want)
  for (const sprite of before) if (open.get(sprite.square) === sprite.piece) { next.push(sprite); used.add(sprite.id); open.delete(sprite.square) }
  // The piece that moved (it may have become another piece on the last rank).
  if (hint && open.has(hint.to)) {
    const mover = before.find(sprite => !used.has(sprite.id) && sprite.square === hint.from)
    if (mover) { next.push({ id: mover.id, piece: open.get(hint.to)!, square: hint.to }); used.add(mover.id); open.delete(hint.to) }
  }
  for (const [square, piece] of open) {
    let nearest: Sprite | null = null
    for (const sprite of before) if (!used.has(sprite.id) && sprite.piece === piece && (!nearest || distance(sprite.square, square) < distance(nearest.square, square))) nearest = sprite
    if (nearest) { next.push({ id: nearest.id, piece, square }); used.add(nearest.id) } else next.push({ id: nextSprite++, piece, square })
  }
  // Keep each DOM node in place. Moving it to the end of the list cancels its CSS slide.
  sprites.value = next.sort((a, b) => a.id - b.id)
}
watch(() => shown.value.board, settlePieces, { immediate: true })

const drag = ref<{ id: number; x: number; y: number } | null>(null)
/** A piece just dropped by hand is already where it belongs: it must not slide there again. */
const dropped = ref(0)
function spriteStyle(sprite: Sprite): Record<string, string> {
  if (drag.value?.id === sprite.id) return { transform: `translate(${drag.value.x}px, ${drag.value.y}px) scale(1.16)` }
  const [col, row] = placeOf(sprite.square)
  return { transform: `translate(${col * 100}%, ${row * 100}%)` }
}

// ── Moving ──

const promotion = ref<{ from: string; to: string; dropped: number } | null>(null)
const promotionPressed = ref<PromotionKind | null>(null)
const promotionStyle = computed<{ left?: string; top?: string; bottom?: string }>(() => {
  if (!promotion.value) return {}
  const [col, row] = placeOf(promotion.value.to)
  return { left: `${col * 12.5}%`, ...(row === 0 ? { top: '0' } : { bottom: '0' }) }
})
const promotionColour = computed(() => (props.view.turn === 'w' ? (kind: string) => kind.toUpperCase() : (kind: string) => kind))

function attempt(from: string, to: string, droppedSprite = 0): void {
  const options = legal.value.filter(move => move.from === from && move.to === to)
  if (!options.length) return
  if (options.length > 1) {
    promotionPressed.value = null
    promotion.value = { from, to, dropped: droppedSprite }
    void nextTick(() => boardEl.value?.querySelector<HTMLButtonElement>('.promo button')?.focus())
    return
  }
  send(options[0]!, droppedSprite)
}

function explainSquare(square: string): void {
  if (!selected.value) return
  const piece = pieceMap.value.get(selected.value)
  if (targets.value.size === 0) feedback.value = `${piece ? pieceName(piece) : 'That piece'} on ${selected.value} has no legal move.`
  else feedback.value = `The ${KIND_NAME[piece?.toLowerCase() ?? 'p']} cannot go to ${square}. Choose a marked square.`
  announcement.value = feedback.value
}

function choosePromotion(kind: PromotionKind, event: MouseEvent): void {
  // The release that opens the picker can also generate a click at the queen's new position.
  // A pointer choice must start in the picker; keyboard and assistive clicks have detail zero.
  if (event.detail !== 0 && promotionPressed.value !== kind) return
  const choice = promotion.value
  if (!choice) return
  promotionPressed.value = null
  promotion.value = null
  send({ from: choice.from, to: choice.to, promotion: kind }, 0)
  focusSquare(choice.to)
}
function cancelPromotion(): void {
  const choice = promotion.value
  promotionPressed.value = null
  promotion.value = null
  if (choice) focusSquare(choice.from)
}

let cuedPlies = props.view.san.length, wasOver = props.view.outcome !== null
function cueFor(san: string, over: boolean): void { playCue(over ? 'end' : /[+#]/.test(san) ? 'check' : san.includes('x') ? 'capture' : 'move') }

function send(move: ChessMove, droppedSprite: number): void {
  feedback.value = ''
  selected.value = null
  cursor.value = move.to
  try {
    const position = positionAfter(props.view, move), san = sanOf(props.view, move)
    if (droppedSprite) {
      dropped.value = droppedSprite
      requestAnimationFrame(() => requestAnimationFrame(() => { dropped.value = 0 }))
    }
    pending.value = { position, move }
    cuedPlies = plies.value + 1
    cueFor(san, san.endsWith('#'))
    clearTimeout(pendingTimer)
    pendingTimer = setTimeout(() => {
      pending.value = null
      feedback.value = 'The move was not confirmed. You can try again.'
      announcement.value = feedback.value
    }, 6000)
  } catch { /* not legal here: send it anyway and let the hall say why */ }
  emit('move', move)
}

const announcement = ref('')
const named = (text: string): string => text.replace(/\{(\d)\}/g, (_, seat: string) => props.seatNames[Number(seat)] ?? (seat === '0' ? 'White' : 'Black'))
function spoken(san: string): string {
  let text: string
  if (san.startsWith('O-O-O')) text = 'castles on the queen’s side'
  else if (san.startsWith('O-O')) text = 'castles on the king’s side'
  else {
    const parts = /^([KQRBN])?[a-h]?[1-8]?(x)?([a-h][1-8])(?:=([QRBN]))?/.exec(san)
    if (!parts) return san
    text = `${KIND_NAME[(parts[1] ?? 'p').toLowerCase()]!} ${parts[2] ? 'takes on' : 'to'} ${parts[3]!}${parts[4] ? `, and becomes a ${KIND_NAME[parts[4].toLowerCase()]!}` : ''}`
  }
  return text + (san.endsWith('#') ? ', checkmate' : san.endsWith('+') ? ', check' : '')
}

// The hall may hand over a fresh object for the same position (a clock tick, a chat line); only a real change resets the hand.
watch(() => `${props.view.fen} ${props.view.outcome?.reason ?? ''}`, () => {
  const view = props.view
  clearTimeout(pendingTimer)
  pending.value = null
  selected.value = null
  promotion.value = null
  feedback.value = ''
  onCancel()
  const count = view.san.length, last = view.san[count - 1], over = view.outcome !== null
  if (last && count > cuedPlies) cueFor(last, over)
  else if (over && !wasOver && !(count === cuedPlies && last?.endsWith('#'))) playCue('end')
  cuedPlies = count
  wasOver = over
  if (last && props.lastMove) announcement.value = `${props.seatNames[props.lastMove.seat] ?? (props.lastMove.seat === 0 ? 'White' : 'Black')}: ${spoken(last)}.${view.outcome ? ` ${named(view.outcome.text)}` : ''}`
  else if (view.outcome) announcement.value = named(view.outcome.text)
  else if (count === 0) announcement.value = 'A new game. White moves first.'
})
watch(() => props.problem, problem => {
  if (!problem) return
  clearTimeout(pendingTimer)
  pending.value = null
  cuedPlies = plies.value
})
onBeforeUnmount(() => clearTimeout(pendingTimer))

// ── Pointer: tap, tap again; or press, drag, let go ──

function squareAt(event: PointerEvent): string | null {
  const rect = boardEl.value?.getBoundingClientRect()
  if (!rect || rect.width === 0) return null
  const col = Math.floor(((event.clientX - rect.left) / rect.width) * 8), row = Math.floor(((event.clientY - rect.top) / rect.height) * 8)
  return col < 0 || col > 7 || row < 0 || row > 7 ? null : nameOf(col, row)
}

let press: { square: string; before: string | null; x: number; y: number; id: number; touch: boolean; sprite: Sprite | null; moved: boolean } | null = null

function onDown(event: PointerEvent): void {
  if (event.button !== 0 || !event.isPrimary || promotion.value) return
  const square = squareAt(event)
  if (!square) return
  focusSquare(square)
  if (!interactive.value) return
  press = { square, before: selected.value, x: event.clientX, y: event.clientY, id: event.pointerId, touch: event.pointerType !== 'mouse', sprite: null, moved: false }
  if (mine(square)) {
    feedback.value = ''
    selected.value = square
    press.sprite = sprites.value.find(sprite => sprite.square === square) ?? null
    boardEl.value?.setPointerCapture(event.pointerId)
    event.preventDefault()
  }
}

function onMove(event: PointerEvent): void {
  if (!press || event.pointerId !== press.id || !press.sprite) return
  if (!press.moved && Math.hypot(event.clientX - press.x, event.clientY - press.y) < (press.touch ? 8 : 4)) return
  press.moved = true
  const rect = boardEl.value!.getBoundingClientRect(), size = rect.width / 8
  // Under a finger the piece rides a little above the touch so it can be seen; the square it will land on is the one under the finger.
  drag.value = { id: press.sprite.id, x: event.clientX - rect.left - size / 2, y: event.clientY - rect.top - size / 2 - (press.touch ? size * 0.6 : 0) }
  const over = squareAt(event)
  hover.value = over && targets.value.has(over) ? over : null
}

function onUp(event: PointerEvent): void {
  if (!press || event.pointerId !== press.id) return
  const { square, before, moved, sprite } = press
  press = null
  const over = squareAt(event)
  if (moved) {
    drag.value = null
    hover.value = null
    if (over && over !== square && targets.value.has(over)) attempt(square, over, sprite?.id ?? 0)
    else if (over && over !== square) explainSquare(over)
    // Set back down where it stood: a second tap whose finger slipped still lets go of the piece.
    else if (over === square && before === square) { selected.value = null; feedback.value = '' }
    return
  }
  if (mine(square)) {
    if (before === square) { selected.value = null; feedback.value = '' }
    else if (!targets.value.size) explainSquare(square)
    return
  }
  if (before && targets.value.has(square)) attempt(before, square)
  else if (before) explainSquare(square)
}

function onCancel(): void {
  press = null
  drag.value = null
  hover.value = null
}

// ── Keyboard and assistive technology: a cursor that walks the squares ──

const cursor = ref(props.seat === 1 ? 'e7' : 'e2')
function focusSquare(square: string): void {
  cursor.value = square
  boardEl.value?.querySelector<HTMLButtonElement>(`[data-square="${square}"]`)?.focus({ preventScroll: true })
}

/** Enter, Space, or a screen reader's activate: pick up, put down, or let go. */
function onClick(square: string, event: MouseEvent): void {
  if (event.detail !== 0 || !interactive.value) return
  if (selected.value && targets.value.has(square)) attempt(selected.value, square)
  else if (mine(square)) {
    feedback.value = ''
    selected.value = selected.value === square ? null : square
    if (selected.value && !targets.value.size) explainSquare(square)
  } else if (selected.value) explainSquare(square)
}

function onKey(square: string, event: KeyboardEvent): void {
  const step = ({ ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] } as Record<string, [number, number]>)[event.key]
  if (step) {
    event.preventDefault()
    event.stopPropagation()
    const [col, row] = placeOf(square)
    focusSquare(nameOf(Math.min(7, Math.max(0, col + step[0])), Math.min(7, Math.max(0, row + step[1]))))
  } else if (event.key === 'Escape' && selected.value) {
    event.stopPropagation()
    selected.value = null
    feedback.value = ''
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.stopPropagation()
  }
}

function onPromotionKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.stopPropagation(); cancelPromotion(); return }
  const buttons = [...(boardEl.value?.querySelectorAll<HTMLButtonElement>('.promo button') ?? [])]
  const at = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const towardBoard = promotion.value && placeOf(promotion.value.to)[1] === 0 ? 'ArrowDown' : 'ArrowUp'
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Tab') {
    event.preventDefault()
    const forward = event.key === 'Tab' ? !event.shiftKey : event.key === towardBoard
    buttons[(at + (forward ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }
}

// ── Around the board ──

const material = computed(() => capturedMaterial(props.view))
const seatName = (colour: Colour): string => props.seatNames[colour === 'w' ? 0 : 1] ?? (colour === 'w' ? 'White' : 'Black')
interface Tray { colour: Colour; name: string; groups: { piece: string; count: number }[]; lead: number; toMove: boolean; label: string }
function tray(colour: Colour): Tray {
  const taken: PieceKind[] = material.value[colour], groups: { piece: string; count: number }[] = []
  for (const kind of taken) {
    const piece = colour === 'w' ? kind : kind.toUpperCase(), group = groups[groups.length - 1]
    if (group?.piece === piece) group.count++; else groups.push({ piece, count: 1 })
  }
  const lead = colour === 'w' ? material.value.lead : -material.value.lead
  const label = groups.length ? `Captured: ${groups.map(group => `${group.count} ${KIND_NAME[group.piece.toLowerCase()]!}${group.count > 1 ? 's' : ''}`).join(', ')}` : 'Nothing captured yet'
  return { colour, name: seatName(colour), groups, lead: Math.max(0, lead), toMove: !props.endText && !props.view.outcome && shown.value.turn === colour, label }
}
const topTray = computed(() => tray(flipped.value ? 'w' : 'b'))
const bottomTray = computed(() => tray(flipped.value ? 'b' : 'w'))

// The host shows how the game ended (`endText`) above the board; here it is enough to say the board is final.
const status = computed(() => {
  if (props.endText) return 'Final position'
  const outcome = props.view.outcome
  if (outcome) return RESULT[outcome.reason] ?? 'The game is over'
  const check = checkSquare.value ? 'Check. ' : ''
  if (props.canMove && !pending.value) return `${check}Your move`
  return `${check}${seatName(shown.value.turn)} to move`
})
const hint = computed(() => {
  if (props.endText) return ''
  if (feedback.value) return feedback.value
  if (promotion.value) return 'Choose a piece for your pawn.'
  if (selected.value) {
    const piece = pieceMap.value.get(selected.value)
    return `${piece ? KIND_NAME[piece.toLowerCase()] : 'Piece'} on ${selected.value} · ${targets.value.size} legal ${targets.value.size === 1 ? 'square' : 'squares'}`
  }
  if (props.view.outcome) return named(props.view.outcome.text)
  if (pending.value) return 'Waiting for the move to be confirmed.'
  if (props.seat === null) return `Watching · ${flipped.value ? 'Black' : 'White'} at the bottom`
  return interactive.value ? 'Tap a piece, then a marked square. Or drag it.' : 'The other player is choosing a move.'
})
const boardLabel = computed(() => `Chess board, ${flipped.value ? 'Black' : 'White'} at the bottom`)
</script>

<template>
  <div ref="chessEl" class="chess" :style="heightLimit !== null ? { '--height-limit': `${heightLimit}px` } : undefined">
    <div v-for="(side, index) in [topTray, bottomTray]" :key="side.colour" class="tray" :class="[index === 0 ? 'top' : 'bottom', { turn: side.toMove }]">
      <span class="disc" :class="side.colour === 'w' ? 'white' : 'black'" aria-hidden="true"></span>
      <span class="name truncate">{{ side.name }}<span class="sr-only">, playing {{ side.colour === 'w' ? 'White' : 'Black' }}{{ side.toMove ? ', to move' : '' }}</span></span>
      <span class="taken" role="img" :aria-label="side.label">
        <span v-for="group in side.groups" :key="group.piece" class="group">
          <span v-for="n in group.count" :key="n" class="mini"><ChessPiece :piece="group.piece" /></span>
        </span>
      </span>
      <span v-if="side.lead" class="lead num" :aria-label="`Ahead by ${side.lead} on material`">+{{ side.lead }}</span>
    </div>

    <div class="frame">
      <div
        ref="boardEl" class="board" :class="{ live: interactive, dragging: drag !== null }" role="group" :aria-label="boardLabel" :aria-describedby="helpId"
        @pointerdown="onDown" @pointermove="onMove" @pointerup="onUp" @pointercancel="onCancel" @lostpointercapture="onCancel"
      >
        <button
          v-for="cell in cells" :key="cell.name" type="button" class="sq"
          :class="[cell.dark ? 'dark' : 'light', {
            last: lastShown !== null && (cell.name === lastShown.from || cell.name === lastShown.to),
            selected: cell.name === selected, target: targets.has(cell.name) && !cell.piece, capture: targets.has(cell.name) && Boolean(cell.piece),
            check: cell.name === checkSquare, hover: cell.name === hover,
          }]"
          :data-square="cell.name" :tabindex="cell.name === cursor ? 0 : -1" :aria-label="labelOf(cell)"
          :aria-pressed="selected === cell.name"
          @click="onClick(cell.name, $event)" @keydown="onKey(cell.name, $event)" @focus="cursor = cell.name"
        >
          <span v-if="cell.rankLabel" class="coord rank" aria-hidden="true">{{ cell.rankLabel }}</span>
          <span v-if="cell.fileLabel" class="coord file" aria-hidden="true">{{ cell.fileLabel }}</span>
        </button>

        <div class="pieces" aria-hidden="true">
          <div
            v-for="sprite in sprites" :key="sprite.id" class="sprite" :data-piece-square="sprite.square"
            :class="{ held: drag?.id === sprite.id, still: dropped === sprite.id, moved: sprite.square === lastShown?.to }" :style="spriteStyle(sprite)"
          >
            <ChessPiece :piece="sprite.piece" />
          </div>
        </div>

        <div v-if="promotion" class="scrim" @pointerdown.stop @pointerup.stop @click.self="cancelPromotion">
          <div class="promo" :class="{ up: promotionStyle.bottom !== undefined }" :style="promotionStyle" role="dialog" aria-modal="true" aria-label="Choose the piece your pawn becomes" @keydown="onPromotionKey">
            <button v-for="kind in PROMOTIONS" :key="kind" type="button" :aria-label="`Promote to a ${KIND_NAME[kind]}`" @pointerdown="promotionPressed = kind" @pointercancel="promotionPressed = null" @click="choosePromotion(kind, $event)">
              <ChessPiece :piece="promotionColour(kind)" />
            </button>
          </div>
        </div>
      </div>
    </div>

    <p class="hint" :class="{ feedback }">{{ hint }}</p>

    <div class="foot">
      <p class="status" :class="{ over: view.outcome !== null, mine: canMove && !pending && !view.outcome }" role="status">{{ status }}</p>
      <button class="btn icon sm ghost" type="button" aria-label="How to play chess" title="How to play" @click="openGuide"><span class="mark" aria-hidden="true">?</span></button>
      <button class="btn icon sm ghost" type="button" aria-label="Turn the board round" title="Turn the board round" @click="flipped = !flipped">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M7 4v14m0 0-3.5-3.5M7 18l3.5-3.5M17 20V6m0 0-3.5 3.5M17 6l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" /></svg>
      </button>
      <button class="btn icon sm ghost" type="button" :aria-pressed="soundOn" :aria-label="soundOn ? 'Sound is on. Turn sound off' : 'Sound is off. Turn sound on'" :title="soundOn ? 'Sound on' : 'Sound off'" @click="setSound(!soundOn)">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
          <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5Z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" />
          <path v-if="soundOn" d="M15.5 9a4.2 4.2 0 0 1 0 6m2.6-8.6a8 8 0 0 1 0 11.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
          <path v-else d="m16 9.5 5 5m0-5-5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <p v-if="problem" class="notice coral problem" role="alert">{{ problem }}</p>

    <dialog ref="guideEl" class="guide" aria-label="How to play chess" @click.self="guideEl?.close()" @close="guideOpen = false" @keydown.esc.stop>
      <header>
        <h2>How to play chess</h2>
        <button class="btn icon sm ghost" type="button" aria-label="Close" @click="guideEl?.close()"><span aria-hidden="true">✕</span></button>
      </header>
      <div class="guide-body"><HowTo v-if="guideOpen" /></div>
    </dialog>
    <p :id="helpId" class="sr-only">Arrow keys move between squares. Enter picks up the piece on a square and puts it down on another. Escape lets go.</p>
    <p class="sr-only" aria-live="polite">{{ announcement }}</p>
  </div>
</template>

<style scoped>
.chess {
  container-type: inline-size; width: 100%; max-width: max(264px, min(640px, calc(100dvh - 236px), var(--height-limit, 640px))); margin-inline: auto;
  display: flex; flex-direction: column; gap: 6px;
  --light: #f0dcb6; --dark: #b98b60; --frame: #6b452b;
}

.tray.top { order: 0; }
.frame { order: 1; }
.tray.bottom { order: 2; }
.foot { order: 3; }
.hint { order: 4; min-height: 18px; font-size: 0.76rem; line-height: 1.4; color: var(--ink-2); padding: 0 4px; }
.hint.feedback { color: #8f2c19; }
.problem { order: 5; }
.tray { display: flex; align-items: center; gap: 7px; min-height: 28px; padding: 0 4px; font-size: 0.86rem; color: var(--ink-2); }
.tray .disc { width: 13px; height: 13px; border-radius: 50%; flex: none; border: 1.5px solid #2a2430; }
.tray .disc.white { background: #fdf8ec; }
.tray .disc.black { background: #37313f; }
.tray .name { font-weight: 650; max-width: 46%; }
.tray.turn .name { color: var(--ink); }
.tray.turn .disc { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 0 4.5px var(--accent-strong); }
.tray .taken { display: flex; align-items: center; flex: 1; min-width: 0; min-height: 22px; overflow: hidden; }
.tray .group { display: flex; margin-right: 5px; }
.tray .mini { width: 20px; height: 20px; flex: none; }
.tray .mini + .mini { margin-left: -11px; }
.tray .lead { font-weight: 700; font-size: 0.8rem; color: var(--ink-2); padding: 1px 7px; border-radius: 999px; background: var(--surface-3); }

.frame {
  padding: clamp(4px, 1.5cqw, 9px); border-radius: clamp(9px, 2.8cqw, 16px);
  background: linear-gradient(150deg, #86593a, var(--frame) 55%, #593822);
  box-shadow: 0 1px 0 rgba(255, 255, 255, 0.22) inset, 0 -1px 0 rgba(0, 0, 0, 0.25) inset, 0 6px 18px rgba(60, 36, 14, 0.18);
}
.board {
  position: relative; display: grid; grid-template: repeat(8, 1fr) / repeat(8, 1fr); aspect-ratio: 1;
  border-radius: clamp(5px, 1.5cqw, 8px); overflow: hidden; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
  box-shadow: 0 0 0 1px rgba(40, 22, 8, 0.45);
}
/* While a move may be made the board keeps the touch, so a drag moves a piece and not the page. */
.board.live { touch-action: none; }
.board.dragging { cursor: grabbing; }
/* A faint grain and sheen so the squares read as wood, not flat paint. */
.board::after {
  content: ""; position: absolute; inset: 0; pointer-events: none; z-index: 1;
  background:
    repeating-linear-gradient(93deg, rgba(96, 56, 20, 0.018) 0 1px, rgba(96, 56, 20, 0) 1px 6px),
    repeating-linear-gradient(87deg, rgba(255, 244, 220, 0.02) 0 2px, rgba(255, 244, 220, 0) 2px 11px),
    linear-gradient(140deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0) 45%, rgba(50, 26, 8, 0.1));
}

.sq { position: relative; appearance: none; border: 0; border-radius: 0; margin: 0; padding: 0; min-width: 0; min-height: 0; background: var(--light); cursor: default; -webkit-tap-highlight-color: transparent; }
.sq.dark { background: var(--dark); }
.board.live .sq { cursor: pointer; }
.sq:focus { outline: none; }
.sq:focus-visible { outline: 3px solid #1d7fd0; outline-offset: -3px; border-radius: 0; box-shadow: inset 0 0 0 5px rgba(255, 255, 255, 0.85); }
.sq::before, .sq::after { content: ""; position: absolute; pointer-events: none; }
.sq::before { inset: 0; }
.sq.last::before { background: rgba(255, 208, 64, 0.5); }
.sq.selected::before { background: rgba(58, 150, 98, 0.58); }
.sq.hover::before { background: rgba(58, 150, 98, 0.5); }
.sq.check::before { background: radial-gradient(circle, rgba(226, 48, 28, 0.95) 0%, rgba(226, 48, 28, 0.6) 40%, rgba(226, 48, 28, 0) 72%); }
.sq.target::after { left: 50%; top: 50%; width: 30%; height: 30%; transform: translate(-50%, -50%); border-radius: 50%; background: rgba(28, 26, 36, 0.26); }
.sq.capture::after { inset: 4%; border-radius: 50%; border: max(3px, 1cqw) solid rgba(28, 26, 36, 0.3); }
.coord { position: absolute; font-size: clamp(8px, 2.5cqw, 13px); font-weight: 700; line-height: 1; color: #644026; pointer-events: none; }
.sq.dark .coord { color: #382414; }
.coord.rank { top: 6%; left: 7%; }
.coord.file { bottom: 5%; right: 8%; }

.pieces { position: absolute; inset: 0; pointer-events: none; z-index: 2; }
.sprite { position: absolute; left: 0; top: 0; width: 12.5%; height: 12.5%; padding: 0.35%; transition: transform 0.2s cubic-bezier(0.25, 0.8, 0.3, 1); filter: drop-shadow(0 1px 0.6px rgba(40, 22, 8, 0.4)); }
.sprite.moved { z-index: 1; }
.sprite.still { transition: none; }
.sprite.held { transition: none; z-index: 4; filter: drop-shadow(0 7px 6px rgba(40, 22, 8, 0.38)); }

.scrim { position: absolute; inset: 0; z-index: 5; background: rgba(28, 26, 36, 0.38); }
.promo { position: absolute; width: 12.5%; display: flex; flex-direction: column; background: var(--surface); box-shadow: var(--shadow-lg); border-radius: clamp(5px, 1.5cqw, 9px); overflow: hidden; }
.promo.up { flex-direction: column-reverse; }
.promo button { appearance: none; border: 0; margin: 0; padding: 4%; background: transparent; aspect-ratio: 1; border-radius: 0; }
.promo button:hover, .promo button:focus-visible { background: var(--accent-soft); outline: none; box-shadow: inset 0 0 0 3px var(--accent-strong); }

.foot { display: flex; align-items: center; gap: 4px; min-height: 34px; padding-left: 4px; }
.status { flex: 1; min-width: 0; font-size: 0.9rem; font-weight: 650; color: var(--ink-2); }
.status.mine { color: var(--accent-text); }
.status.over { color: var(--ink); }
.foot .btn { color: var(--ink-2); }
.foot .btn[aria-pressed="true"] { color: var(--accent-text); background: var(--accent-soft); }
.foot .mark { font-weight: 800; font-size: 1rem; line-height: 1; }
.problem { margin-top: 2px; }

.guide { width: min(680px, calc(100vw - 20px)); max-height: min(88dvh, 920px); padding: 0; border: 0; border-radius: 18px; background: var(--surface); color: var(--ink); box-shadow: var(--shadow-lg); overflow: hidden; }
.guide[open] { display: flex; flex-direction: column; }
.guide::backdrop { background: rgba(28, 26, 36, 0.48); }
.guide header { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 12px 12px 10px 18px; border-bottom: 1px solid var(--line); }
.guide-body { padding: 14px 16px 18px; overflow-y: auto; min-height: 120px; }

@media (prefers-reduced-motion: reduce) {
  .sprite { transition: none; }
}
</style>
