// The home studio: what the owner's three modes share. It holds the catalogue and the estate as the
// service last told them, the furniture draft, the room plan being drawn, and the one price-and-agree
// flow every purchase goes through. It decides nothing about money: a price is the service's quote,
// a purchase is the service's receipt, and an answer that never came is looked up, not assumed.
//
// Everything outside this file is handed in (`StudioDeps`), so a probe runs the real controller
// against the real service handlers with no browser and no engine.
import { computed, reactive } from 'vue'
import type { ComputedRef } from 'vue'
import type { Vec2 } from '../../shared/geo.ts'
import {
  HOME_CATALOG_VERSION, HOME_REQUEST_ID, HOME_RULES, HOME_WALK_MARGIN, MAIN_ROOM_ID, blocksWalking, doorwayPoints, houseType, isFreeFurniture, roomAt, roomKind,
} from '../../shared/homes.ts'
import type {
  HomeCatalog, HomeChange, HomeEstate, HomePlan, HomePlanDraft, HomeQuote, HomeReceipt, HouseType, HouseTypeId, RoomKindId,
} from '../../shared/homes.ts'
import type { HomeGhost } from '../../world/homeScene.ts'
import type { OpName, Ops } from '../../shared/protocol.ts'
import type { Home, HomeLayout, PlacedItem } from '../../shared/social.ts'
import {
  areaOf, autoDoor, blockedOpenings, copyDraft, draftOf, layoutChange, nearestSpot, nextRoomName, problemOf, repairOpenings, roomSpots, sameDraft,
  strandedPieces, withColours, withDoor, withDoorAt, withEntrance, withRoom, withSize, withoutDoor, withoutRoom,
} from './homeLayout.ts'
import type { Footprint } from './homeLayout.ts'

export type StudioMode = 'home' | 'build' | 'buy'

export interface StudioStage {
  /** Draw these pieces in the room, and mark one. */
  showItems(items: PlacedItem[], selected: string | null): void
  /** Draw a home the service has just answered with: the rooms if they changed, then the furniture. */
  showHome(home: Home): Promise<void>
  /** Outline rooms being planned on the floor. */
  ghost(ghost: HomeGhost | null): void
  /** The character's place in the room, when there is one. */
  where(): Vec2 | null
}

export interface StudioDeps {
  api<K extends OpName>(op: K, input: Ops[K]['in']): Promise<Ops[K]['out']>
  /** A fresh id for one intent to pay: 8 to 64 of [A-Za-z0-9_-]. */
  newRequestId(): string
  newItemKey(): string
  footprint: Footprint
  isFurniture(model: string): boolean
  stage: StudioStage
  /** The link to the service is up. A purchase is not sent while it is not. */
  online(): boolean
  /** Told the balance the service reported, so the rest of the App shows it. */
  coins(balance: number): void
  now(): number
}

/** Why a flow stopped, and what the member may do about it. Nothing here ever means "charged" unless it says so. */
export interface Problem {
  kind: 'invalid' | 'funds' | 'stale' | 'expired' | 'busy' | 'network' | 'other'
  message: string
  /** `requote`: ask for a new price. `again`: send the same thing again. `none`: change something first. */
  retry: 'requote' | 'again' | 'none'
}

export interface Flow {
  phase: 'idle' | 'quoting' | 'review' | 'committing' | 'unknown' | 'done' | 'failed'
  change: HomeChange | null
  quote: HomeQuote | null
  /** One per intent to pay. Kept from the first press until the service has answered, so a repeat can never charge twice. */
  requestId: string | null
  receipt: HomeReceipt | null
  repeated: boolean
  problem: Problem | null
  /** What to call this: "Furniture", "Rooms", "Studio to Bungalow". */
  title: string
}

const IDLE = (): Flow => ({ phase: 'idle', change: null, quote: null, requestId: null, receipt: null, repeated: false, problem: null, title: '' })

const codeOf = (error: unknown): string => (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : 'unavailable')
const messageOf = (error: unknown): string => (error instanceof Error && error.message ? error.message : 'Something went wrong. Try again.')
const GRID = HOME_RULES.grid
const label = (model: string): string => model.replace(/([A-Z0-9])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()

export interface Studio {
  state: {
    load: 'idle' | 'loading' | 'ready' | 'error'
    loadError: string
    mode: StudioMode
    catalog: HomeCatalog | null
    /** The service's tables are a newer version than the rules this page was built with: its prices may differ from what is drawn. */
    catalogOld: boolean
    home: Home | null
    estate: HomeEstate | null
    // Furniture
    draft: HomeLayout | null
    baseRevision: number
    name: string
    selected: string | null
    saving: boolean
    saveError: string
    cart: Record<string, number>
    // Rooms and house
    plan: HomePlanDraft | null
    pickedRoom: string | null
    adding: { kind: RoomKindId; width: number; depth: number; x: number | null; z: number | null } | null
    houseTo: HouseTypeId | null
    flow: Flow
  }
  type: ComputedRef<HouseType>
  dirty: ComputedRef<boolean>
  planDirty: ComputedRef<boolean>
  selectedItem: ComputedRef<PlacedItem | null>
  /** The pieces standing in the rooms in the draft, by model. */
  placedIn(model: string): number
  ownedOf(model: string): number | null
  spare(model: string): number | null
  itemProblems: ComputedRef<string[]>
  label(model: string): string
  /** The clock the studio judges a price's age by. */
  now(): number
  load(): Promise<void>
  refresh(): Promise<void>
  reset(): void
  adopt(): void
  place(model: string, link?: Pick<PlacedItem, 'productId' | 'variantId' | 'tints'>): { ok: true; key: string } | { ok: false; reason: string }
  select(key: string | null): void
  nudge(dx: number, dz: number): void
  turn(): void
  moveTo(point: Vec2): void
  sendToRoom(roomId: string): void
  putAway(key: string): void
  save(): Promise<boolean>
  discard(): void
  setQuantity(model: string, quantity: number): void
  askFurniture(): Promise<void>
  adoptPlan(): void
  pickRoom(id: string | null): void
  startAdding(kind: RoomKindId): void
  sizeAdding(width: number, depth: number): void
  spotsForAdding(): { x: number; z: number }[]
  moveAdding(x: number, z: number): void
  confirmAdding(): { ok: true } | { ok: false; reason: string }
  cancelAdding(): void
  resizeRoom(id: string, width: number, depth: number): void
  recolour(id: string, colours: { floor?: string; wall?: string }): void
  removeRoom(id: string): void
  moveDoor(index: number, at: number): void
  addDoor(a: string, b: string, at: number): void
  removeDoor(index: number): void
  moveFront(entrance: HomePlanDraft['entrance']): void
  planProblem: ComputedRef<string | null>
  stranded: ComputedRef<PlacedItem[]>
  blocked: ComputedRef<string[]>
  askLayout(): Promise<void>
  askHouse(to: HouseTypeId): Promise<void>
  confirm(): Promise<void>
  retry(): Promise<void>
  reconcile(): Promise<void>
  cancelFlow(): void
  /** A price is being asked for, a payment is in flight, or its outcome is not known. */
  busy: ComputedRef<boolean>
  /** A price is open (review, paying or unknown): edits to the room, plan and basket are refused until it is closed. */
  modal: ComputedRef<boolean>
  /** The quote the member is looking at can no longer be agreed to: the home or the estate moved on. */
  stale: ComputedRef<boolean>
  affordable: ComputedRef<boolean>
  ghostNow(): HomeGhost | null
}

export function createStudio(deps: StudioDeps): Studio {
  const state: Studio['state'] = reactive({
    load: 'idle', loadError: '', mode: 'home', catalog: null, catalogOld: false, home: null, estate: null,
    draft: null, baseRevision: 0, name: '', selected: null, saving: false, saveError: '', cart: {},
    plan: null, pickedRoom: null, adding: null, houseTo: null, flow: IDLE(),
  })
  let loadGeneration = 0, flowGeneration = 0

  const type = computed(() => houseType(state.estate?.houseType ?? state.home?.building.houseType ?? 'studio'))
  const currentPlan = (): HomePlan | null => state.home?.building.plan ?? null
  const dirty = computed(() => Boolean(state.draft && state.home && (JSON.stringify(state.draft) !== JSON.stringify(state.home.layout) || state.name !== state.home.name)))
  const planDirty = computed(() => Boolean(state.plan && currentPlan() && !sameDraft(state.plan, draftOf(currentPlan()!))))
  const selectedItem = computed(() => state.draft?.items.find(item => item.key === state.selected) ?? null)

  // ── Reading the estate ──
  const apply = (home: Home, estate: HomeEstate): void => {
    state.home = home
    state.estate = estate
    deps.coins(estate.balance)
  }

  async function load(): Promise<void> {
    const mine = ++loadGeneration
    state.load = 'loading'
    try {
      const [catalog, estate] = await Promise.all([deps.api('home.catalog', {}), deps.api('home.estate', {})])
      if (mine !== loadGeneration) return
      state.catalog = catalog.catalog
      state.catalogOld = catalog.catalog.version !== HOME_CATALOG_VERSION
      apply(estate.home, estate.estate)
      if (!state.draft) adopt()
      if (!state.plan) adoptPlan()
      state.load = 'ready'
    } catch (error) {
      if (mine !== loadGeneration) return
      state.loadError = messageOf(error)
      if (!state.home) state.load = 'error'
    }
  }

  /** Read the estate again, keeping the furniture draft the member is in the middle of. */
  async function refresh(): Promise<void> {
    const mine = loadGeneration
    try {
      const { home, estate } = await deps.api('home.estate', {})
      if (mine !== loadGeneration) return
      const moved = !state.home || home.revision !== state.home.revision
      apply(home, estate)
      if (moved && !dirty.value) adopt()
      // A draft not yet saved stays; the room is drawn from it again, in case the home was redrawn from the service meanwhile.
      else if (dirty.value) redraw()
      if (!planDirty.value) adoptPlan()
    } catch { /* keeps what it had; the caller's own call will say if the link is down */ }
  }

  function reset(): void {
    loadGeneration++; flowGeneration++
    Object.assign(state, { load: 'idle', loadError: '', mode: 'home', catalog: null, catalogOld: false, home: null, estate: null, draft: null, baseRevision: 0, name: '', selected: null, saving: false, saveError: '', cart: {}, plan: null, pickedRoom: null, adding: null, houseTo: null, flow: IDLE() })
    deps.stage.ghost(null)
  }

  // ── Furniture ──
  function adopt(): void {
    if (!state.home) return
    state.draft = JSON.parse(JSON.stringify(state.home.layout)) as HomeLayout
    state.baseRevision = state.home.revision
    state.name = state.home.name
    state.selected = null
    deps.stage.showItems(state.draft.items, null)
  }
  const redraw = (): void => { if (state.draft) deps.stage.showItems(state.draft.items, state.selected) }

  const placedIn = (model: string): number => state.draft?.items.filter(item => item.model === model).length ?? 0
  const ownedOf = (model: string): number | null => {
    if (isFreeFurniture(model)) return null
    return state.estate?.inventory.find(entry => entry.model === model)?.owned ?? 0
  }
  const spare = (model: string): number | null => {
    const owned = ownedOf(model)
    return owned === null ? null : owned - placedIn(model)
  }

  const roomOfItem = (item: PlacedItem): ReturnType<typeof roomAt> => {
    const plan = currentPlan()
    return plan ? roomAt(plan.rooms, { x: item.x * GRID, z: item.z * GRID }) : null
  }

  /** Keep a piece wholly inside one room, on the 0.5 m grid. A room too small for it gets it in the middle. */
  function clampInto(item: PlacedItem, room: NonNullable<ReturnType<typeof roomAt>>): void {
    const size = deps.footprint(item.model, item.turns)
    const halfW = Math.ceil(size.width / 2 / GRID), halfD = Math.ceil(size.depth / 2 / GRID)
    const x0 = (room.x / GRID) + halfW, x1 = (room.x + room.width) * 2 - halfW, z0 = (room.z / GRID) + halfD, z1 = (room.z + room.depth) * 2 - halfD
    item.x = x0 > x1 ? (room.x / GRID) + room.width : Math.max(x0, Math.min(x1, Math.round(item.x)))
    item.z = z0 > z1 ? (room.z / GRID) + room.depth : Math.max(z0, Math.min(z1, Math.round(item.z)))
  }

  /** The piece, where it is, would stand where a character goes through a door or the front door. */
  function standsOnOpening(item: PlacedItem, plan: HomePlan): boolean {
    const size = deps.footprint(item.model, item.turns)
    return doorwayPoints(plan).some(point => Math.abs(point.pos.x - item.x * GRID) < size.width / 2 + HOME_WALK_MARGIN && Math.abs(point.pos.z - item.z * GRID) < size.depth / 2 + HOME_WALK_MARGIN)
  }

  function place(model: string, link: Pick<PlacedItem, 'productId' | 'variantId' | 'tints'> = { productId: null, variantId: null, tints: {} }): { ok: true; key: string } | { ok: false; reason: string } {
    const layout = state.draft, plan = currentPlan()
    if (!layout || !plan || !state.estate) return { ok: false, reason: 'Your home is still loading.' }
    if (!deps.isFurniture(model)) return { ok: false, reason: 'That piece is not in the furniture pack.' }
    if (layout.items.length >= state.estate.itemLimit) return { ok: false, reason: `A ${type.value.label.toLowerCase()} holds up to ${state.estate.itemLimit} pieces. Put one away first.` }
    const left = spare(model)
    if (left !== null && left <= 0) return { ok: false, reason: `You have no ${label(model).toLowerCase()} to place. Buy one first.` }
    // A new piece goes in the room the character is standing in, in the middle, nudged so pieces do not stack.
    const at = deps.stage.where()
    const room = (at && roomAt(plan.rooms, at)) ?? plan.rooms.find(entry => entry.id === MAIN_ROOM_ID) ?? plan.rooms[0]!
    const inRoom = layout.items.filter(item => roomOfItem(item)?.id === room.id).length
    const offset = (inRoom % 5) - 2
    const item: PlacedItem = { key: deps.newItemKey(), model, x: (room.x / GRID) + room.width + offset * 2, z: (room.z / GRID) + room.depth + offset, turns: 0, ...link }
    clampInto(item, room)
    // A new piece is not put on a doorway or the front door: the nearest cell clear of them is taken, or the default when the room has none.
    if (blocksWalking(item.model) && standsOnOpening(item, plan)) {
      const size = deps.footprint(item.model, 0)
      const reach = Math.ceil(Math.max(size.width, size.depth) / GRID)
      const start = { x: item.x, z: item.z }
      let best: { x: number; z: number } | null = null, gap = Infinity
      for (let dx = -reach * 4; dx <= reach * 4; dx++) for (let dz = -reach * 4; dz <= reach * 4; dz++) {
        const candidate = { ...item, x: start.x + dx, z: start.z + dz }
        clampInto(candidate, room)
        if (candidate.x !== start.x + dx || candidate.z !== start.z + dz || standsOnOpening(candidate, plan)) continue
        const away = Math.hypot(dx, dz)
        if (away < gap) { gap = away; best = { x: candidate.x, z: candidate.z } }
      }
      if (best) { item.x = best.x; item.z = best.z }
    }
    layout.items.push(item)
    state.selected = item.key
    redraw()
    return { ok: true, key: item.key }
  }

  function select(key: string | null): void { state.selected = key; redraw() }
  function nudge(dx: number, dz: number): void {
    const item = selectedItem.value
    if (!item) return
    const room = roomOfItem(item)
    item.x += dx; item.z += dz
    if (room) clampInto(item, room)
    redraw()
  }
  function turn(): void {
    const item = selectedItem.value
    if (!item) return
    const room = roomOfItem(item)
    item.turns = ((item.turns + 1) % 4) as PlacedItem['turns']
    if (room) clampInto(item, room)
    redraw()
  }
  function moveTo(point: Vec2): void {
    const item = selectedItem.value, plan = currentPlan()
    if (!item || !plan) return
    const room = roomAt(plan.rooms, point) ?? roomOfItem(item)
    if (!room) return
    item.x = point.x / GRID; item.z = point.z / GRID
    clampInto(item, room)
    redraw()
  }
  function sendToRoom(roomId: string): void {
    const item = selectedItem.value, room = currentPlan()?.rooms.find(entry => entry.id === roomId)
    if (!item || !room) return
    item.x = (room.x / GRID) + room.width; item.z = (room.z / GRID) + room.depth
    clampInto(item, room)
    redraw()
  }
  function putAway(key: string): void {
    if (!state.draft) return
    state.draft.items = state.draft.items.filter(item => item.key !== key)
    if (state.selected === key) state.selected = null
    redraw()
  }
  function discard(): void { adopt() }

  /** Why the furniture as drawn cannot be saved, so the button can say it before the service has to. */
  const itemProblems = computed<string[]>(() => {
    const layout = state.draft, plan = currentPlan(), estate = state.estate
    if (!layout || !plan || !estate) return []
    const problems: string[] = []
    if (layout.items.length > estate.itemLimit) problems.push(`A ${type.value.label.toLowerCase()} holds up to ${estate.itemLimit} pieces.`)
    const counts = new Map<string, number>()
    for (const item of layout.items) counts.set(item.model, (counts.get(item.model) ?? 0) + 1)
    for (const [model, count] of counts) {
      const owned = ownedOf(model)
      if (owned !== null && count > owned) problems.push(`You own ${owned} ${label(model).toLowerCase()}, and ${count} are placed.`)
    }
    const points = doorwayPoints(plan)
    // As the service does: every piece must be in a room, but only a piece that is new or moved is held to keeping a doorway clear, so a home is never refused for the way it already was.
    const before = new Map((state.home?.layout.items ?? []).map(item => [item.key, item]))
    const unchanged = (item: PlacedItem): boolean => { const old = before.get(item.key); return Boolean(old && old.model === item.model && old.x === item.x && old.z === item.z && old.turns === item.turns) }
    for (const item of layout.items) {
      if (!roomAt(plan.rooms, { x: item.x * GRID, z: item.z * GRID })) { problems.push(`The ${label(item.model).toLowerCase()} is outside every room.`); continue }
      if (!blocksWalking(item.model) || unchanged(item)) continue
      const size = deps.footprint(item.model, item.turns)
      const point = points.find(candidate => Math.abs(candidate.pos.x - item.x * GRID) < size.width / 2 + HOME_WALK_MARGIN && Math.abs(candidate.pos.z - item.z * GRID) < size.depth / 2 + HOME_WALK_MARGIN)
      if (point) problems.push(`The ${label(item.model).toLowerCase()} blocks ${point.opening === 'entrance' ? 'the front door' : 'a doorway'}.`)
    }
    return [...new Set(problems)]
  })

  async function save(): Promise<boolean> {
    if (!state.draft || !state.home || state.saving) return false
    // An answer that arrives after the account changed belongs to nobody here: it is dropped, and so is its error.
    const mine = loadGeneration
    state.saving = true
    state.saveError = ''
    try {
      const { home } = await deps.api('home.save', { layout: state.draft, name: state.name.trim() || state.home.name, expectedRevision: state.baseRevision })
      if (mine !== loadGeneration) return false
      state.home = home
      adopt()
      await refresh()
      if (mine !== loadGeneration) return false
      await deps.stage.showHome(home)
      return true
    } catch (error) {
      if (mine !== loadGeneration) return false
      state.saveError = codeOf(error) === 'conflict' ? `${messageOf(error)} Reload to see the latest, then place your pieces again.` : messageOf(error)
      return false
    } finally { if (mine === loadGeneration) state.saving = false }
  }

  // ── Buying furniture ──
  function setQuantity(model: string, quantity: number): void {
    const count = Math.max(0, Math.min(state.catalog?.rules.purchaseQuantity ?? 20, Math.floor(quantity)))
    if (count === 0) delete state.cart[model]
    else if (Object.keys(state.cart).length < (state.catalog?.rules.purchaseLines ?? 20) || model in state.cart) state.cart[model] = count
  }

  function describe(change: HomeChange): string {
    if (change.kind === 'furniture') return 'Furniture'
    if (change.kind === 'house') return `${type.value.label} to ${houseType(change.houseType).label}`
    return 'Rooms'
  }

  // ── The one flow every purchase goes through ──
  /** A price is being asked for, a payment is in flight, or its outcome is not known: nothing else may start. */
  const busy = computed(() => state.flow.phase === 'quoting' || state.flow.phase === 'committing' || state.flow.phase === 'unknown')
  /** A price is open for review or being paid: the room, the plan and the basket are behind it and may not change until it is closed. */
  const modal = computed(() => busy.value || state.flow.phase === 'review')

  async function ask(change: HomeChange): Promise<void> {
    if (busy.value) return
    const mine = ++flowGeneration
    state.flow = { ...IDLE(), phase: 'quoting', change, title: describe(change) }
    try {
      const { quote } = await deps.api('home.quote', { change })
      if (mine !== flowGeneration) return
      state.flow.quote = quote
      state.flow.phase = 'review'
    } catch (error) {
      if (mine !== flowGeneration) return
      state.flow.phase = 'failed'
      state.flow.problem = problemOfError(error, 'quote')
    }
  }
  const nothingToAsk = (reason: string): void => {
    if (busy.value) return
    state.flow = { ...IDLE(), phase: 'failed', title: '', problem: { kind: 'invalid', message: reason, retry: 'none' } }
  }

  async function askFurniture(): Promise<void> {
    if (busy.value) return
    const lines = Object.entries(state.cart).filter(([model, quantity]) => quantity > 0 && !isFreeFurniture(model)).map(([model, quantity]) => ({ model, quantity }))
    if (!lines.length) { nothingToAsk('Choose something to buy first.'); return }
    await ask({ kind: 'furniture', lines })
  }

  async function askLayout(): Promise<void> {
    const plan = state.plan, home = state.home
    if (!plan || !home || busy.value) return
    if (dirty.value) { nothingToAsk('You have furniture changes that are not saved. Save or discard them first, so nothing is moved from under you.'); return }
    const problem = problemOf(plan, type.value)
    if (problem) { nothingToAsk(problem); return }
    const blockedNow = blockedOpenings(home.building.plan, plan, home.layout.items, deps.footprint)
    if (blockedNow.length) { nothingToAsk(`The ${label(blockedNow[0]!.item.model).toLowerCase()} is in the way of ${blockedNow[0]!.what}. Move the door along the wall, or put the piece away first.`); return }
    await ask(layoutChange(plan, home.layout.items))
  }

  async function askHouse(to: HouseTypeId): Promise<void> { await ask({ kind: 'house', houseType: to }) }

  const stale = computed(() => {
    const quote = state.flow.quote
    return state.flow.phase === 'review' && quote !== null && state.home !== null && state.estate !== null
      && (state.home.revision !== quote.revision || state.estate.revision !== quote.estateRevision)
  })
  const affordable = computed(() => {
    const quote = state.flow.quote
    if (!quote) return false
    return (state.estate ? state.estate.balance : quote.balance) >= quote.total
  })
  function problemOfError(error: unknown, step: 'quote' | 'commit'): Problem {
    const code = codeOf(error), message = messageOf(error)
    if (code === 'unavailable') return { kind: 'network', message: step === 'commit' ? 'The connection dropped before an answer came. Check whether it went through before you try again.' : 'The service did not answer. Nothing was charged. Try again.', retry: 'again' }
    if (code === 'rate_limited') return { kind: 'busy', message: `${message} Nothing was charged.`, retry: 'again' }
    if (code === 'expired') return { kind: 'expired', message: 'That price ran out. Nothing was charged. Get a new one.', retry: 'requote' }
    if (code === 'conflict') return { kind: 'other', message: `${message} Nothing was charged.`, retry: 'requote' }
    if (code === 'forbidden' || code === 'unauthorized') return { kind: 'other', message: 'Only the owner of a home can change it.', retry: 'none' }
    return { kind: 'invalid', message: `${message} Nothing was charged.`, retry: 'none' }
  }

  function finish(receipt: HomeReceipt, repeated: boolean): void {
    state.flow.phase = 'done'
    state.flow.receipt = receipt
    state.flow.repeated = repeated
    state.flow.problem = null
    state.cart = {}
    state.houseTo = null
    state.adding = null
    state.pickedRoom = null
    deps.stage.ghost(null)
  }

  async function confirm(): Promise<void> {
    const flow = state.flow, quote = flow.quote
    if (!quote || (flow.phase !== 'review' && flow.phase !== 'unknown')) return
    const mine = loadGeneration
    // After a lost answer only the service can say whether the payment went through: a repeat of the same request returns its receipt before the service looks at the price or the coins. So the local price, coin and clock checks are for a first press; a repeat is sent and the service's answer closes the sheet, rather than leaving it on "Check now" with no way out.
    const lost = flow.phase === 'unknown'
    if (!lost && stale.value) { flow.problem = { kind: 'stale', message: 'Your home or your furniture changed since this price. Nothing was charged. Get a new price.', retry: 'requote' }; return }
    if (!lost && !affordable.value) { flow.problem = { kind: 'funds', message: `You have ${state.estate?.balance ?? quote.balance} coins; this costs ${quote.total}. Nothing was charged.`, retry: 'none' }; return }
    if (!deps.online()) { flow.problem = { kind: 'network', message: 'You are offline. Nothing was sent. Pay when the connection is back.', retry: 'again' }; return }
    if (!lost && Date.parse(quote.expiresAt) <= deps.now()) { flow.problem = { kind: 'expired', message: 'That price ran out. Nothing was charged. Get a new one.', retry: 'requote' }; return }
    // One id per intent: made on the first press and kept until the service has answered.
    const requestId = flow.requestId ?? deps.newRequestId()
    if (!HOME_REQUEST_ID.test(requestId)) { flow.problem = { kind: 'invalid', message: 'Could not make a request id. Try again.', retry: 'none' }; return }
    flow.requestId = requestId
    flow.problem = null
    flow.phase = 'committing'
    try {
      const answer = await deps.api('home.commit', { quoteId: quote.id, requestId, expectedRevision: state.home?.revision ?? quote.revision })
      if (mine !== loadGeneration || flow !== state.flow) return
      apply(answer.home, answer.estate)
      finish(answer.receipt, answer.repeated)
      if (!dirty.value || quote.kind === 'layout') adopt()
      adoptPlan()
      await deps.stage.showHome(answer.home)
    } catch (error) {
      if (mine !== loadGeneration || flow !== state.flow) return
      const code = codeOf(error)
      if (code === 'unavailable') { flow.phase = 'unknown'; flow.problem = problemOfError(error, 'commit'); return }
      // A refusal after the request was sent once could still hide a receipt (a restart forgets the price, not the receipt): look before saying "not charged".
      await refresh()
      if (mine !== loadGeneration || flow !== state.flow) return
      const found = state.estate?.receipts.find(receipt => receipt.requestId === requestId)
      if (found) { finish(found, true); await deps.stage.showHome(state.home!); return }
      flow.phase = 'failed'
      flow.problem = problemOfError(error, 'commit')
      if (code === 'conflict') {
        const short = (state.estate?.balance ?? quote.balance) < quote.total
        const moved = state.home?.revision !== quote.revision || state.estate?.revision !== quote.estateRevision
        if (short) flow.problem = { kind: 'funds', message: `You have ${state.estate?.balance} coins; this costs ${quote.total}. Nothing was charged.`, retry: 'none' }
        else if (moved) flow.problem = { kind: 'stale', message: 'Your home changed since this price. Nothing was charged. Get a new price.', retry: 'requote' }
      }
      // A refused quote is used up or gone: its request id must not go with a new one. A busy answer only asks to wait, so the same intent stands.
      if (flow.problem.kind !== 'busy') flow.requestId = null
    }
  }

  /** After a lost answer: look for the receipt; if there is none, send the same request again (it is safe: it can only ever charge once). */
  async function reconcile(): Promise<void> {
    const flow = state.flow
    if (flow.phase !== 'unknown' || !flow.requestId) return
    const mine = loadGeneration
    await refresh()
    if (mine !== loadGeneration || flow !== state.flow) return
    const found = state.estate?.receipts.find(receipt => receipt.requestId === flow.requestId)
    if (found) { finish(found, true); if (state.home) await deps.stage.showHome(state.home); return }
    await confirm()
  }

  async function retry(): Promise<void> {
    const flow = state.flow
    if (flow.phase === 'unknown') { await reconcile(); return }
    const old = flow.phase === 'review' && flow.quote !== null && (stale.value || Date.parse(flow.quote.expiresAt) <= deps.now())
    if (!old && ((flow.phase !== 'failed' && flow.phase !== 'review') || !flow.problem)) return
    const change = flow.change
    if (!old && flow.problem?.retry === 'again' && flow.quote) { flow.phase = 'review'; flow.problem = null; await confirm(); return }
    if (!change) return
    // Work from what the service says now, not from what was on screen when the price was asked.
    // If the sheet is closed, the account changes or another price is asked for while that is read, this one is let go.
    const mine = flowGeneration
    await refresh()
    if (mine !== flowGeneration) return
    state.flow = IDLE()
    if (change.kind === 'layout') await askLayout()
    else await ask(change)
  }

  function cancelFlow(): void {
    // A price nobody agreed to costs nothing; a payment in flight cannot be cancelled from here.
    if (state.flow.phase === 'committing' || state.flow.phase === 'unknown') return
    // A price still being asked for is let go: when it arrives nobody is waiting, and it does not open the sheet again.
    flowGeneration++
    state.flow = IDLE()
  }

  // ── Rooms ──
  function adoptPlan(): void {
    const plan = currentPlan()
    state.plan = plan ? draftOf(plan) : null
    state.pickedRoom = null
    state.adding = null
    deps.stage.ghost(null)
  }

  const planProblem = computed(() => (state.plan ? problemOf(state.plan, type.value) : null))
  const stranded = computed(() => (state.plan && state.home ? strandedPieces(state.home.layout.items, state.plan) : []))
  const blocked = computed(() => {
    const plan = currentPlan()
    if (!state.plan || !plan || !state.home) return []
    return blockedOpenings(plan, state.plan, state.home.layout.items, deps.footprint).map(entry => `The ${label(entry.item.model).toLowerCase()} is in the way of ${entry.what}.`)
  })

  const pickRoom = (id: string | null): void => { state.pickedRoom = id; state.adding = null }
  function startAdding(kind: RoomKindId): void {
    const row = roomKind(kind)
    state.pickedRoom = null
    state.adding = { kind, width: Math.max(row.min.width, Math.min(4, row.max.width)), depth: Math.max(row.min.depth, Math.min(4, row.max.depth)), x: null, z: null }
    sizeAdding(state.adding.width, state.adding.depth)
  }
  const spotsForAdding = (): { x: number; z: number }[] => {
    const adding = state.adding
    if (!adding || !state.plan || !state.home) return []
    return roomSpots(state.plan, adding.kind, adding.width, adding.depth, type.value, state.home.layout.items, deps.footprint)
  }
  function sizeAdding(width: number, depth: number): void {
    const adding = state.adding
    if (!adding) return
    const row = roomKind(adding.kind)
    adding.width = Math.max(row.min.width, Math.min(row.max.width, Math.round(width)))
    adding.depth = Math.max(row.min.depth, Math.min(row.max.depth, Math.round(depth)))
    const spots = spotsForAdding()
    // Keep the chosen corner if a room this size still fits there, otherwise take the nearest that does.
    const wanted = adding.x !== null && adding.z !== null ? { x: adding.x, z: adding.z } : (() => { const plan = currentPlan(); return plan ? { x: plan.entrance.x, z: plan.entrance.z } : { x: 0, z: 0 } })()
    const spot = spots.find(entry => entry.x === wanted.x && entry.z === wanted.z) ?? nearestSpot(spots, wanted)
    adding.x = spot ? spot.x : null
    adding.z = spot ? spot.z : null
  }
  function moveAdding(x: number, z: number): void {
    const adding = state.adding
    if (!adding) return
    const spots = spotsForAdding()
    const spot = spots.find(entry => entry.x === x && entry.z === z) ?? nearestSpot(spots, { x, z })
    adding.x = spot ? spot.x : null; adding.z = spot ? spot.z : null
  }
  function confirmAdding(): { ok: true } | { ok: false; reason: string } {
    const adding = state.adding, plan = state.plan, home = state.home
    if (!adding || !plan || !home || adding.x === null || adding.z === null) return { ok: false, reason: 'There is no place for a room this size. Make it smaller, or move up to a bigger house.' }
    const room = { id: nextRoomName(plan), kind: adding.kind, x: adding.x, z: adding.z, width: adding.width, depth: adding.depth, floor: roomKind(adding.kind).floor, wall: roomKind(adding.kind).wall }
    const door = autoDoor(plan.rooms, room, home.layout.items, deps.footprint)
    if (!door) return { ok: false, reason: 'A door needs two metres of shared wall that no furniture is blocking.' }
    state.plan = withRoom(plan, room, door)
    state.adding = null
    state.pickedRoom = room.id
    return { ok: true }
  }
  const cancelAdding = (): void => { state.adding = null }

  function resizeRoom(id: string, width: number, depth: number): void {
    if (!state.plan) return
    const room = state.plan.rooms.find(entry => entry.id === id)
    if (!room) return
    const row = roomKind(room.kind)
    state.plan = withSize(state.plan, id, Math.max(row.min.width, Math.min(row.max.width, Math.round(width))), Math.max(row.min.depth, Math.min(row.max.depth, Math.round(depth))))
  }
  function recolour(id: string, colours: { floor?: string; wall?: string }): void { if (state.plan) state.plan = withColours(state.plan, id, colours) }
  function removeRoom(id: string): void {
    if (!state.plan || id === MAIN_ROOM_ID) return
    state.plan = repairOpenings(withoutRoom(state.plan, id))
    if (state.pickedRoom === id) state.pickedRoom = null
  }
  const moveDoor = (index: number, at: number): void => { if (state.plan) state.plan = withDoorAt(state.plan, index, at) }
  const addDoor = (a: string, b: string, at: number): void => { if (state.plan) state.plan = withDoor(state.plan, { a, b, at }) }
  const removeDoor = (index: number): void => { if (state.plan) state.plan = withoutDoor(state.plan, index) }
  const moveFront = (entrance: HomePlanDraft['entrance']): void => { if (state.plan) state.plan = withEntrance(state.plan, entrance) }

  /** The outlines to draw in the room for what is being planned right now. */
  function ghostNow(): HomeGhost | null {
    const plan = state.plan, current = currentPlan()
    if (!plan || !current) return null
    const ghost: HomeGhost = { rooms: [], doors: [] }
    const known = new Set(current.rooms.map(room => room.id))
    for (const room of plan.rooms) {
      if (!known.has(room.id)) ghost.rooms.push({ x: room.x, z: room.z, width: room.width, depth: room.depth, look: 'new' })
      else {
        const before = current.rooms.find(entry => entry.id === room.id)!
        if (before.width !== room.width || before.depth !== room.depth) ghost.rooms.push({ x: room.x, z: room.z, width: room.width, depth: room.depth, look: 'selected' })
      }
    }
    const now = new Set(plan.rooms.map(room => room.id))
    for (const room of current.rooms) if (!now.has(room.id)) ghost.rooms.push({ x: room.x, z: room.z, width: room.width, depth: room.depth, look: 'removed' })
    if (state.pickedRoom) {
      const room = plan.rooms.find(entry => entry.id === state.pickedRoom)
      if (room && known.has(room.id) && !ghost.rooms.some(entry => entry.x === room.x && entry.z === room.z && entry.width === room.width && entry.depth === room.depth)) ghost.rooms.push({ x: room.x, z: room.z, width: room.width, depth: room.depth, look: 'selected' })
    }
    const adding = state.adding
    if (adding && adding.x !== null && adding.z !== null) ghost.rooms.push({ x: adding.x, z: adding.z, width: adding.width, depth: adding.depth, look: 'new' })
    else if (adding) {
      const bounds = current.bounds
      ghost.rooms.push({ x: bounds.x + bounds.width + 1, z: bounds.z, width: adding.width, depth: adding.depth, look: 'blocked' })
    }
    return ghost.rooms.length ? ghost : null
  }

  /** An edit made while a price is open would change what the price is for. Refused, as nothing. */
  const held = <A extends unknown[]>(edit: (...args: A) => void): ((...args: A) => void) => (...args) => { if (!modal.value) edit(...args) }
  const heldPlace: Studio['place'] = (model, link) => (modal.value ? { ok: false, reason: 'Finish or close the price first.' } : place(model, link))
  const heldAdd = (): { ok: true } | { ok: false; reason: string } => (modal.value ? { ok: false, reason: 'Finish or close the price first.' } : confirmAdding())
  const heldSave = async (): Promise<boolean> => (modal.value ? false : save())

  return {
    state, type, dirty, planDirty, selectedItem, placedIn, ownedOf, spare, itemProblems, label, now: deps.now,
    load, refresh, reset, adopt, place: heldPlace, select, nudge: held(nudge), turn: held(turn), moveTo: held(moveTo), sendToRoom: held(sendToRoom), putAway: held(putAway), save: heldSave,
    discard: held(discard), setQuantity: held(setQuantity), askFurniture,
    adoptPlan: held(adoptPlan), pickRoom: held(pickRoom), startAdding: held(startAdding), sizeAdding: held(sizeAdding), spotsForAdding, moveAdding: held(moveAdding), confirmAdding: heldAdd,
    cancelAdding: held(cancelAdding), resizeRoom: held(resizeRoom), recolour: held(recolour), removeRoom: held(removeRoom), moveDoor: held(moveDoor), addDoor: held(addDoor), removeDoor: held(removeDoor), moveFront: held(moveFront),
    planProblem, stranded, blocked, askLayout, askHouse, confirm, retry, reconcile, cancelFlow, busy, modal, stale, affordable, ghostNow,
  }
}
