import { computed, reactive, watch } from 'vue'
import { guestAccess } from '../shared/guest.ts'
import { randomToken } from '../shared/ids.ts'
import type { MemberId, VehicleId, VehicleInviteId, VehicleQuoteId } from '../shared/ids.ts'
import { WorldError, roomKey } from '../shared/model.ts'
import type { RoomSnapshot } from '../shared/model.ts'
import type { Vec2 } from '../shared/geo.ts'
import { NEUTRAL_CONTROLS, VEHICLE_RULES } from '../shared/vehicles.ts'
import type { DriverOffer, SeatId, VehicleAccess, VehicleActions, VehicleControls, VehicleDataVersion, VehicleDestination, VehicleEvent, VehicleKind, VehicleOps, VehicleQuote, VehicleSelf, VehicleSnapshot } from '../shared/vehicles.ts'
import { guestStorageScope } from '../platform/guestService.ts'
import { hostedWorldConfig, localActorKey } from '../platform/runtime.ts'
import { api, app, messageOf, onAccountReset, onReconnect, onServerEvent, refreshPoints } from './app.ts'

type VehicleOp = keyof VehicleOps
type StateAnswer = VehicleOps['vehicle.state']['out']
type Transfer = Extract<VehicleEvent, { type: 'vehicle.transfer' }>
type Transferred = Extract<VehicleEvent, { type: 'vehicle.transferred' }>
type Move = Extract<VehicleEvent, { type: 'vehicle.move' }>
type Exit = VehicleOps['vehicle.exit']['out']
type PaidRide = Pick<VehicleOps['vehicle.cancelTrip']['in'], 'vehicleId' | 'tripId'>
type PaidAction = { kind: 'book'; input: VehicleOps['vehicle.book']['in'] } | { kind: 'cancel'; input: VehicleOps['vehicle.cancelTrip']['in'] }
function isVehicleId(value: unknown): value is VehicleId { return typeof value === 'string' && /^vh_[a-z0-9_-]{1,80}$/.test(value) }
function isQuoteId(value: unknown): value is VehicleQuoteId { return typeof value === 'string' && /^vq_[a-z0-9_-]{1,80}$/.test(value) }
const recoveryId = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(value)
function paidRide(value: unknown): PaidRide | null {
  if (!value || typeof value !== 'object' || !('vehicleId' in value) || !('tripId' in value) || !isVehicleId(value.vehicleId) || !recoveryId(value.tripId)) return null
  return { vehicleId: value.vehicleId, tripId: value.tripId }
}
function paidAction(value: unknown): PaidAction | null {
  if (!value || typeof value !== 'object' || !('kind' in value) || !('input' in value) || !value.input || typeof value.input !== 'object' || !('requestId' in value.input) || !recoveryId(value.input.requestId)) return null
  const input = value.input, requestId = value.input.requestId
  if (value.kind === 'cancel') { const ride = paidRide(input); return ride ? { kind: 'cancel', input: { ...ride, requestId } } : null }
  if (value.kind === 'book' && 'quoteId' in input && isQuoteId(input.quoteId) && 'entryId' in input && typeof input.entryId === 'string' && /^[a-z0-9-]{1,40}$/.test(input.entryId)) return { kind: 'book', input: { quoteId: input.quoteId, entryId: input.entryId, requestId } }
  return null
}
export interface VehicleWorldBridge {
  /** Load only. Must not call room.enter, settle a pose, or acknowledge on the engine's behalf. */
  loadTransfer(event: Transfer, signal: AbortSignal): Promise<void>
  transferred(event: Transferred): void
  resumed(snapshot: RoomSnapshot | null, self: VehicleSelf): void
  exited(result: Exit): void
  motion(event: Move): void
}
export interface VehicleRuntime {
  call<K extends VehicleOp>(op: K, input: VehicleOps[K]['in']): Promise<VehicleOps[K]['out']>
  actor(): MemberId | null
  allowed(op: VehicleOp, input: unknown): boolean
  message(error: unknown): string
  balance(balance: number): void
  /** Public world and actor scope. Saved IDs are hints, never authorization. */
  recoveryScope?(): string | null
}
export function createVehicleClient(runtime: VehicleRuntime) {
  const state = reactive<{
    data: StateAnswer | null; load: 'idle' | 'loading' | 'ready' | 'error'; connected: boolean
    selectedId: VehicleId | null; actions: VehicleActions | null; quote: VehicleQuote | null
    paidRide: PaidRide | null; pending: string; problem: string; uncertain: boolean; retryLabel: string; route: Vec2[]
    transfer: Transfer | null; sceneData: VehicleDataVersion | null; destinationMode: 'quote' | 'navigation' | 'preview' | null; previewDestination: VehicleDestination | null; worldBound: boolean
  }>({ data: null, load: 'idle', connected: false, selectedId: null, actions: null, quote: null, paidRide: null, pending: '', problem: '', uncertain: false, retryLabel: '', route: [], transfer: null, sceneData: null, destinationMode: null, previewDestination: null, worldBound: false })
  let recoveryKey: string | null = null, paidRequest: PaidAction | null = null, stoppedRide: PaidRide | null = null
  function saveRecovery(): void {
    if (!recoveryKey) return
    try { if (state.paidRide || paidRequest || stoppedRide) localStorage.setItem(recoveryKey, JSON.stringify({ ride: state.paidRide, action: paidRequest, stopped: stoppedRide })); else localStorage.removeItem(recoveryKey) } catch { /* This tab remains usable if storage is unavailable. */ }
  }
  function restoreRecovery(): void {
    const scope = runtime.recoveryScope?.(), actor = runtime.actor()
    const key = scope && actor ? `nw:paid-ride:${JSON.stringify([scope, actor])}` : null
    if (key === recoveryKey) return
    recoveryKey = key; state.paidRide = null; paidRequest = null; stoppedRide = null
    if (key) try {
      const value: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
      if (value && typeof value === 'object') { if ('ride' in value) state.paidRide = paidRide(value.ride); if ('action' in value) paidRequest = paidAction(value.action); if ('stopped' in value) stoppedRide = paidRide(value.stopped) }
    } catch { /* Corrupt or unavailable storage cannot create a ride. */ }
    if (paidRequest) { state.uncertain = true; state.retryLabel = 'Check the same action again'; retry = () => retryPaid() }
  }
  function observeRide(vehicle: VehicleSnapshot): void {
    const trip = vehicle.trip
    if (stoppedRide?.vehicleId === vehicle.id && trip?.id === stoppedRide.tripId) return
    if (trip?.mode === 'paid-service' && trip.state !== 'arrived' && vehicle.control.kind === 'service' && vehicle.control.bookingMemberId === runtime.actor()) state.paidRide = { vehicleId: vehicle.id, tripId: trip.id }
    else if (state.paidRide?.vehicleId === vehicle.id && (!trip || trip.id !== state.paidRide.tripId || trip.state === 'arrived')) state.paidRide = null
    saveRecovery()
  }
  let account = 0, revision = 0, disposed = false
  let reading: Promise<void> | null = null, followUp: Promise<void> | null = null
  /** A seat kept for this member while their page was away is only handed back by vehicle.resume; vehicle.state shows no seat, and the scene's room.enter would give it up. */
  let needsResume = false, resuming: Promise<void> | null = null
  /** Resume requests run one at a time; a plain repeat joins the one already under way instead of overwriting the scene's pending work. */
  let flight: Promise<void> | null = null, flightInitial = false
  let retry: (() => Promise<void>) | null = null
  let bridge: VehicleWorldBridge | null = null
  let crossing = new AbortController()
  let transferOrigin: { vehicleId: VehicleId; epoch: string; room: VehicleSnapshot['room'] } | null = null
  let inputTimer: ReturnType<typeof setInterval> | undefined
  let changeTimer: ReturnType<typeof setTimeout> | undefined
  let controls: VehicleControls = { ...NEUTRAL_CONTROLS }
  let inputEpoch = '', sequence = 0, inputRun = 0, lastSentAt = -Infinity, acceptedSeq = 0, refusedSeq = 0, refusals = 0
  const outstandingInputs = new Set<object>()
  const motionTicks = new Map<VehicleId, number>()
  const retiredEpochs = new Map<VehicleId, Set<string>>()
  const self = computed(() => state.data?.self ?? null)
  const seated = computed(() => self.value?.seat ?? null)
  const selected = computed(() => self.value?.seat ? self.value.vehicle : state.data?.vehicles.find(vehicle => vehicle.id === state.selectedId) ?? self.value?.vehicle ?? null)
  const compatible = computed(() => Boolean(state.data?.data && state.sceneData && state.data.data.id === state.sceneData.id && state.data.data.dataVersion === state.sceneData.dataVersion && state.data.data.mapDataVersion === state.sceneData.mapDataVersion))
  const capabilityReason = computed(() => !state.data?.available ? state.data?.reason || 'Vehicles are not available here yet.' : !state.worldBound ? 'Vehicle controls are being connected to this world.' : !compatible.value ? 'The vehicle roads do not match the loaded world yet.' : '')
  const driver = computed(() => {
    const vehicle = self.value?.vehicle
    return vehicle && self.value?.seat?.seatId === 'driver' && vehicle.control.kind === 'member' && vehicle.control.driverId === runtime.actor() ? vehicle : null
  })
  const canDrive = computed(() => state.connected && !state.pending && !state.uncertain && !capabilityReason.value && driver.value?.phase !== 'transferring' && !driver.value?.transitions.length && Boolean(driver.value))
  function live(asked: number, actor: MemberId | null): boolean { return !disposed && asked === account && actor !== null && actor === runtime.actor() }
  function put(vehicle: VehicleSnapshot, preserveMotion = false): boolean {
    if (!state.data || retiredEpochs.get(vehicle.id)?.has(vehicle.epoch)) return false
    const previous = state.data.vehicles.find(item => item.id === vehicle.id)
    if (previous?.epoch === vehicle.epoch && previous.revision > vehicle.revision) return false
    if (preserveMotion && previous?.epoch === vehicle.epoch && previous.revision === vehicle.revision && motionTicks.has(vehicle.id)) vehicle = { ...vehicle, pos: previous.pos, heading: previous.heading, speed: previous.speed, steering: previous.steering }
    if (previous && previous.epoch !== vehicle.epoch) {
      const retired = retiredEpochs.get(vehicle.id) ?? new Set<string>(); retired.add(previous.epoch); retiredEpochs.set(vehicle.id, retired); motionTicks.delete(vehicle.id)
    }
    observeRide(vehicle)
    state.data.vehicles = [...state.data.vehicles.filter(item => item.id !== vehicle.id), vehicle]
    if (state.data.self.vehicle?.id === vehicle.id) state.data.self.vehicle = vehicle
    return true
  }
  function applySelf(next: VehicleSelf, preserveMotion = false): void {
    if (!state.data) return
    const previousControl = state.data.self.vehicle?.control
    state.data.self = next
    if (next.vehicle) put(next.vehicle, preserveMotion)
    runtime.balance(next.balance)
    if (next.notice) state.problem = next.notice
    const control = next.vehicle?.control
    if (!next.seat || control?.kind !== 'member' || previousControl?.kind !== 'member' || previousControl.controlEpoch !== control.controlEpoch) stopDriving()
  }
  function check(op: VehicleOp, input: unknown, roads = true): void {
    if (!state.connected || !runtime.actor()) throw new WorldError('unavailable', 'Reconnect to the world before continuing.')
    if (!runtime.allowed(op, input)) throw new WorldError('forbidden', 'This action is not available to this character.')
    if (roads && capabilityReason.value) throw new WorldError('unavailable', capabilityReason.value)
  }
  async function load(): Promise<void> {
    if (disposed || !state.connected || !runtime.actor() || !runtime.allowed('vehicle.state', {})) return
    // First read on a new link: ask for the kept seat back before anything reads the vehicle state or enters a room. Concurrent loads wait for it.
    if (resuming) return resuming
    if (needsResume && runtime.allowed('vehicle.resume', {})) { needsResume = false; const first: Promise<void> = resume(true).finally(() => { if (resuming === first) resuming = null }); resuming = first; return first }
    return read()
  }
  async function read(): Promise<void> {
    if (disposed || !state.connected || !runtime.actor() || !runtime.allowed('vehicle.state', {})) return
    if (reading) {
      if (!followUp) { const next = reading.then(() => { followUp = null; return read() }); followUp = next }
      return followUp
    }
    const asked = account, actor = runtime.actor(), before = revision
    if (!state.data) state.load = 'loading'
    const current = (async () => {
      try {
        const result = await runtime.call('vehicle.state', {})
        if (!live(asked, actor) || before !== revision) return
        const moving = state.data?.vehicles ?? []
        for (const vehicle of result.vehicles) {
          const latest = moving.find(item => item.id === vehicle.id && item.epoch === vehicle.epoch && item.revision === vehicle.revision)
          if (latest && motionTicks.has(vehicle.id)) { vehicle.pos = latest.pos; vehicle.heading = latest.heading; vehicle.speed = latest.speed; vehicle.steering = latest.steering }
        }
        if (result.self.vehicle) result.self.vehicle = result.vehicles.find(item => item.id === result.self.vehicle?.id && item.epoch === result.self.vehicle?.epoch && item.revision === result.self.vehicle?.revision) ?? result.self.vehicle
        state.data = result; state.load = 'ready'; revision++
        for (const vehicle of result.vehicles) observeRide(vehicle)
        if (result.self.vehicle) observeRide(result.self.vehicle)
        if (state.selectedId && !result.vehicles.some(item => item.id === state.selectedId)) { state.selectedId = null; state.actions = null }
        runtime.balance(result.self.balance)
        if (result.self.notice) state.problem = result.self.notice
        if (selected.value) void inspect(selected.value.id)
      } catch (error) {
        if (!live(asked, actor) || before !== revision) return
        if (!state.data) state.load = 'error'
        state.problem = runtime.message(error)
      }
    })().finally(() => { if (reading === current) reading = null })
    reading = current; return current
  }
  async function inspect(vehicleId: VehicleId): Promise<void> {
    const asked = account, actor = runtime.actor(), before = ++revision
    try {
      check('vehicle.inspect', { vehicleId }, false)
      const result = await runtime.call('vehicle.inspect', { vehicleId })
      if (!live(asked, actor)) return
      state.selectedId = vehicleId
      if (before === revision) { put(result.vehicle, true); applySelf(result.self, true); state.actions = result.actions }
      else { state.actions = null; await load() }
    } catch (error) { if (live(asked, actor)) state.problem = runtime.message(error) }
  }
  async function mutate<K extends VehicleOp>(op: K, input: VehicleOps[K]['in'], label: string, apply: (result: VehicleOps[K]['out']) => void, roads = true, idempotent = false, effect?: (result: VehicleOps[K]['out']) => void, rejected?: (error: WorldError) => void): Promise<void> {
    if (disposed || state.pending || state.uncertain) return
    const asked = account, actor = runtime.actor()
    const run = async (): Promise<void> => {
      if (!live(asked, actor) || state.pending) return
      try { check(op, input, roads) } catch (error) { state.problem = runtime.message(error); return }
      const before = ++revision
      state.pending = label; state.problem = ''; state.uncertain = false
      try {
        const result = await runtime.call(op, input)
        if (!live(asked, actor)) return
        retry = null; state.retryLabel = ''; effect?.(result)
        if (before === revision) apply(result)
        await load()
      } catch (error) {
        if (!live(asked, actor)) return
        const known = error instanceof WorldError && error.code !== 'unavailable'
        if (!known && idempotent) { state.uncertain = true; retry = run; state.retryLabel = 'Check the same action again' }
        else { retry = null; state.retryLabel = ''; if (error instanceof WorldError) rejected?.(error) }
        state.problem = runtime.message(error)
        await load()
      } finally { if (live(asked, actor)) state.pending = '' }
    }
    await run()
  }
  const requestId = (): string => `veh_${randomToken(24)}`
  const vehicleAnswer = (answer: { vehicle: VehicleSnapshot | null; self: VehicleSelf }): void => {
    const previous = state.selectedId
    if (answer.vehicle) put(answer.vehicle)
    else if (previous && state.data && answer.self.vehicle?.id !== previous) state.data.vehicles = state.data.vehicles.filter(vehicle => vehicle.id !== previous)
    applySelf(answer.self); state.selectedId = answer.vehicle?.id ?? null; state.actions = null
  }
  const current = (): VehicleSnapshot => { if (!selected.value) throw new WorldError('not_found', 'Choose a vehicle first.'); return selected.value }
  async function loan(depotId: string, kind: VehicleKind): Promise<void> { await mutate('vehicle.loan', { depotId, kind, requestId: requestId() }, 'Borrowing a vehicle…', vehicleAnswer, true, true) }
  async function returnVehicle(): Promise<void> { const vehicle = current(); await mutate('vehicle.return', { vehicleId: vehicle.id, expectedRevision: vehicle.revision, requestId: requestId() }, 'Returning the vehicle…', result => { applySelf(result.self); state.selectedId = null; state.actions = null }, true, true) }
  async function board(seatId: SeatId, entryId: string, inviteId?: VehicleInviteId): Promise<void> {
    const vehicle = current()
    await mutate('vehicle.board', { vehicleId: vehicle.id, seatId, entryId, expectedRevision: vehicle.revision, ...(inviteId ? { inviteId } : {}), requestId: requestId() }, 'Checking your seat…', vehicleAnswer, true, true)
  }
  async function exit(): Promise<void> {
    const seat = seated.value; if (!seat) return
    await mutate('vehicle.exit', { vehicleId: seat.vehicleId, requestId: requestId() }, 'Leaving the vehicle…', result => { vehicleAnswer(result); stopDriving() }, false, true, result => bridge?.exited(result))
  }
  async function access(access: VehicleAccess): Promise<void> { const vehicle = current(); await mutate('vehicle.access', { vehicleId: vehicle.id, access, expectedRevision: vehicle.revision }, 'Updating boarding access…', result => { put(result.vehicle) }) }
  async function invite(to: MemberId, role: 'driver' | 'passenger'): Promise<void> { const vehicle = current(); await mutate('vehicle.invite', { vehicleId: vehicle.id, to, role, expectedRevision: vehicle.revision }, 'Inviting this player…', result => { if (state.data) state.data.invites = [...state.data.invites.filter(item => item.id !== result.invite.id), result.invite] }) }
  async function respondInvite(inviteId: VehicleInviteId, accept: boolean): Promise<void> { await mutate('vehicle.respondInvite', { inviteId, accept }, accept ? 'Accepting invitation…' : 'Declining invitation…', result => { if (state.data) state.data.invites = [...state.data.invites.filter(item => item.id !== result.invite.id), result.invite] }, false) }
  async function offerDriver(to: MemberId): Promise<void> { const vehicle = current(); await mutate('vehicle.offerDriver', { vehicleId: vehicle.id, to, expectedRevision: vehicle.revision }, 'Offering the driver seat…', () => undefined) }
  async function acceptDriver(offer: DriverOffer): Promise<void> { const vehicle = self.value?.vehicle; if (!vehicle || vehicle.id !== offer.vehicleId) return; await mutate('vehicle.acceptDriver', { offerId: offer.id, expectedRevision: vehicle.revision }, 'Taking the driver seat…', vehicleAnswer) }
  async function quote(destination: VehicleDestination): Promise<void> { const vehicle = current(); await mutate('vehicle.quote', { vehicleId: vehicle.id, destination }, 'Checking the route and fare…', result => { state.quote = result.quote }) }
  async function runBook(input: VehicleOps['vehicle.book']['in']): Promise<void> {
    await mutate('vehicle.book', input, 'Confirming the ride…', result => { vehicleAnswer(result); runtime.balance(result.receipt.balance) }, false, true, result => {
      const recovery = result.receipt.recovery
      if (!recovery) {
        // Older servers and historical receipts confirm the fare without enough identity to recover the ride.
        state.uncertain = true; retry = () => retryPaid(); state.retryLabel = 'Check the same booking again'
        state.problem = 'Your payment is recorded, but its ride details are unavailable. Check the same booking again.'
        saveRecovery(); state.quote = null
        return
      }
      const identity = { vehicleId: recovery.vehicleId, tripId: recovery.tripId }
      if (recovery.kind === 'active') {
        if (stoppedRide?.vehicleId !== identity.vehicleId || stoppedRide.tripId !== identity.tripId) state.paidRide = identity
      } else {
        stoppedRide = identity; state.paidRide = null
        state.problem = recovery.kind === 'stopping' ? 'The service is stopping this ride.'
          : `This ride has ended (${recovery.outcome}).${recovery.refunded > 0 ? ` The receipt records a refund of ${recovery.refunded} coins.` : ' No refund is recorded.'}`
      }
      paidRequest = null; saveRecovery(); state.quote = null
    }, () => { paidRequest = null; saveRecovery() })
  }
  async function book(quoteId: VehicleQuoteId, entryId: string): Promise<void> {
    if (state.pending || state.uncertain || state.paidRide) return
    restoreRecovery()
    if (state.uncertain || state.paidRide) return
    check('vehicle.book', { quoteId, entryId }, true)
    const input = { quoteId, entryId, requestId: requestId() }
    paidRequest = { kind: 'book', input }; saveRecovery(); await runBook(input)
  }
  async function depart(): Promise<void> { const vehicle = current(); await mutate('vehicle.depart', { vehicleId: vehicle.id, expectedRevision: vehicle.revision, requestId: requestId() }, 'Starting the ride…', vehicleAnswer, true, true) }
  async function runCancel(input: VehicleOps['vehicle.cancelTrip']['in']): Promise<void> {
    await mutate('vehicle.cancelTrip', input, 'Checking cancellation…', result => { vehicleAnswer(result); state.quote = null }, false, true, () => {
      stoppedRide = { vehicleId: input.vehicleId, tripId: input.tripId }; state.paidRide = null; paidRequest = null; saveRecovery()
    }, error => {
      paidRequest = null
      if (error.code === 'expired' || error.code === 'not_found' || error.code === 'forbidden' || (error.code === 'conflict' && /no paid ride|not this vehicle's ride|has arrived/.test(error.message))) state.paidRide = null
      saveRecovery()
    })
  }
  async function cancelTrip(): Promise<void> {
    if (state.pending || state.uncertain) return
    check('vehicle.cancelTrip', {}, false)
    const vehicle = selected.value
    if (vehicle) observeRide(vehicle)
    const ride = state.paidRide
    if (!ride) return
    const input = { ...ride, requestId: requestId() }
    paidRequest = { kind: 'cancel', input }; saveRecovery(); await runCancel(input)
  }
  async function retryPaid(): Promise<void> {
    const action = paidRequest
    if (!action || state.pending) return
    // Same precondition as mutate. A retry that cannot start sends nothing and must leave the first request unresolved.
    try { check(action.kind === 'book' ? 'vehicle.book' : 'vehicle.cancelTrip', action.input, false) } catch (error) { state.problem = runtime.message(error); return }
    state.uncertain = false
    if (action.kind === 'book') await runBook(action.input)
    else await runCancel(action.input)
  }
  async function destination(destination: VehicleDestination): Promise<void> { const vehicle = current(); await mutate('vehicle.destination', { vehicleId: vehicle.id, destination, expectedRevision: vehicle.revision }, 'Checking the driving route…', result => { put(result.vehicle); state.route = result.route }) }
  const SCENE_RESTORE_FAILED = 'Your seat is kept, but the scene could not be restored. Try again.'
  /** The restore could not be completed from a coherent answer. Said plainly; the next scene-owned resume() is the retry. Never touches a booking's own uncertain/retry state. */
  function sceneRestoreFailed(): void { if (!state.uncertain && !state.retryLabel) state.problem = SCENE_RESTORE_FAILED }
  function coherentPair(result: Awaited<ReturnType<VehicleRuntime['call']>> & { self: VehicleSelf; snapshot: RoomSnapshot | null }): boolean {
    const { self, snapshot } = result, vehicle = self.vehicle
    return Boolean(self.seat && vehicle && snapshot && self.seat.vehicleId === vehicle.id && snapshot.ref.kind === 'district'
      && snapshot.room === vehicle.room.key && snapshot.room === roomKey(snapshot.ref) && snapshot.instance === vehicle.room.instance && snapshot.ref.districtId === vehicle.room.districtId)
  }
  function resume(initial = false): Promise<void> {
    if (flight && !initial && !flightInitial) return flight
    const prior = flight
    const mine: Promise<void> = (prior ? prior.catch(() => undefined).then(() => resumeRun(initial, 3)) : resumeRun(initial, 3)).finally(() => { if (flight === mine) flight = null })
    flight = mine; flightInitial = initial
    return mine
  }
  /** What to do once an answer is in: for the same account and actor, any resume still wanted for this link, else a fresh read of the state. */
  async function afterResume(asked: number, actor: MemberId | null): Promise<void> {
    if (!live(asked, actor)) return
    if (needsResume && runtime.allowed('vehicle.resume', {})) { needsResume = false; return resumeRun(true, 3) } // already inside the flight: run, do not queue behind ourselves
    await read()
  }
  async function resumeRun(initial: boolean, attempts: number): Promise<void> {
    const asked = account, actor = runtime.actor(), target = bridge, before = ++revision
    let again = false
    try {
      check('vehicle.resume', {}, false)
      const result = await runtime.call('vehicle.resume', {})
      if (!live(asked, actor)) return
      const superseded = before !== revision
      if (!superseded) { applySelf(result.self); rollbackTransfer(result.self.vehicle); if (state.transfer && (!result.self.seat || result.self.vehicle?.phase !== 'transferring')) { crossing.abort(); state.transfer = null; transferOrigin = null } }
      const snapshot = result.snapshot, seated = result.self.seat
      // The scene is only ever given one coherent answer: the seat's vehicle, its room and the room snapshot must all name the same room. No exception for a crossing or a missing piece.
      if (initial && seated) { /* the scene's own resume, once it has its engine, asks again and is told from a fresh answer */ }
      else if (bridge && (!target || bridge === target)) { // a world that appeared while this was in flight may be told; one that was replaced may not
        if (!seated) { if (superseded) again = attempts > 1; else bridge.resumed(snapshot, result.self) }
        else if (superseded || !coherentPair(result)) { again = attempts > 1; if (!again) sceneRestoreFailed() }
        else { if (state.problem === SCENE_RESTORE_FAILED) state.problem = ''; bridge.resumed(snapshot, result.self) }
      }
    } catch (error) { if (live(asked, actor)) state.problem = runtime.message(error) }
    if (again) return resumeRun(initial, attempts - 1)
    await afterResume(asked, actor)
  }
  const INPUT_EVERY_MS = 100, INPUT_CHANGE_GAP_MS = 60, INPUT_BACKLOG = 8, INPUT_REFUSALS = 3
  const coasting = (): boolean => controls.throttle === 0 && controls.steer === 0 && !controls.brake
  async function sendInput(): Promise<void> {
    const vehicle = driver.value
    if (!canDrive.value || !vehicle || vehicle.control.kind !== 'member' || outstandingInputs.size >= INPUT_BACKLOG
      || performance.now() - lastSentAt < INPUT_CHANGE_GAP_MS) return
    if (coasting() && vehicle.speed === 0) { stopDriving(); return }
    if (inputEpoch !== vehicle.control.controlEpoch) { inputEpoch = vehicle.control.controlEpoch; sequence = 0; acceptedSeq = 0; refusedSeq = 0; refusals = 0 }
    const asked = account, actor = runtime.actor(), epoch = inputEpoch, run = inputRun, seq = ++sequence
    const vehicleId = vehicle.id, vehicleEpoch = vehicle.epoch, room = vehicle.room.key, instance = vehicle.room.instance
    const current = (): boolean => live(asked, actor) && run === inputRun && epoch === inputEpoch
      && driver.value?.id === vehicleId && driver.value.epoch === vehicleEpoch && driver.value.room.key === room
      && driver.value.room.instance === instance && driver.value.control.kind === 'member' && driver.value.control.controlEpoch === epoch
    const token = {}
    outstandingInputs.add(token); lastSentAt = performance.now()
    try {
      const result = await runtime.call('vehicle.input', { vehicleId, controlEpoch: epoch, seq, ...controls })
      if (!current()) return
      if (result.accepted) {
        acceptedSeq = Math.max(acceptedSeq, seq)
        if (seq > refusedSeq) refusals = 0
      } else if (seq > acceptedSeq && seq > refusedSeq) {
        refusedSeq = seq
        if (++refusals >= INPUT_REFUSALS) { stopDriving(); await resume() }
      }
    } catch (error) { if (current()) { stopDriving(); state.problem = runtime.message(error) } }
    finally { outstandingInputs.delete(token) }
  }
  function scheduleInput(): void {
    if (!inputTimer || changeTimer) return
    const wait = INPUT_CHANGE_GAP_MS - (performance.now() - lastSentAt)
    if (wait <= 0) void sendInput()
    else changeTimer = setTimeout(() => { changeTimer = undefined; if (inputTimer) void sendInput() }, wait)
  }
  function drive(intent: VehicleControls): void {
    if (!canDrive.value || (intent.throttle === 0 && intent.steer === 0 && intent.brake)) { stopDriving(); return }
    const next = { throttle: Math.max(-1, Math.min(1, intent.throttle)), steer: Math.max(-1, Math.min(1, intent.steer)), brake: intent.brake }
    const changed = next.throttle !== controls.throttle || next.steer !== controls.steer || next.brake !== controls.brake
    controls = next
    if (!inputTimer && coasting() && driver.value?.speed === 0) { controls = { ...NEUTRAL_CONTROLS }; return }
    if (!inputTimer) {
      inputRun++; acceptedSeq = 0; refusedSeq = 0; refusals = 0
      inputTimer = setInterval(() => { void sendInput() }, INPUT_EVERY_MS)
      scheduleInput()
    } else if (changed) scheduleInput()
  }
  function stopDriving(): void {
    const wasActive = inputTimer !== undefined
    inputRun++; controls = { ...NEUTRAL_CONTROLS }
    clearInterval(inputTimer); inputTimer = undefined
    clearTimeout(changeTimer); changeTimer = undefined
    refusals = 0
    const vehicle = driver.value
    if (wasActive && !disposed && state.connected && runtime.actor() && vehicle?.control.kind === 'member'
      && inputEpoch === vehicle.control.controlEpoch && outstandingInputs.size < INPUT_BACKLOG) {
      const token = {}
      outstandingInputs.add(token); lastSentAt = performance.now()
      void runtime.call('vehicle.input', { vehicleId: vehicle.id, controlEpoch: inputEpoch, seq: ++sequence, ...NEUTRAL_CONTROLS })
        .catch(() => undefined).finally(() => { outstandingInputs.delete(token) })
    }
    // Never erase pending tokens: their own settlement releases capacity, even across stop/reset.
    // At a full backlog no extra neutral is queued; the service brakes when its last input becomes stale.
  }
  function rollbackTransfer(vehicle: VehicleSnapshot | null): void {
    const origin = transferOrigin
    if (!state.transfer || !origin || !vehicle || vehicle.id !== origin.vehicleId || vehicle.epoch !== origin.epoch) return
    // A target-room snapshot can precede transferred. Only an original-room safe stop proves rollback.
    if (vehicle.room.key === origin.room.key && vehicle.room.instance === origin.room.instance && vehicle.phase !== 'transferring') {
      crossing.abort(); state.transfer = null; transferOrigin = null; stopDriving()
    }
  }
  async function transfer(event: Transfer): Promise<void> {
    const asked = account, actor = runtime.actor()
    crossing.abort(); crossing = new AbortController(); const signal = crossing.signal
    const vehicle = state.data?.vehicles.find(vehicle => vehicle.id === event.vehicleId)
    transferOrigin = vehicle ? { vehicleId: vehicle.id, epoch: vehicle.epoch, room: { ...vehicle.room } } : null
    state.transfer = event; stopDriving()
    if (!bridge) { state.problem = 'The new district could not be loaded. Your vehicle will remain stopped.'; return }
    try {
      await bridge.loadTransfer(event, signal)
      if (signal.aborted || !live(asked, actor) || state.transfer?.transferId !== event.transferId) return
      check('vehicle.ackTransfer', { transferId: event.transferId, token: event.token }, false)
      await runtime.call('vehicle.ackTransfer', { transferId: event.transferId, token: event.token })
    } catch (error) { if (!signal.aborted && live(asked, actor)) state.problem = runtime.message(error) }
  }
  function event(event: VehicleEvent): void {
    if (disposed || !runtime.actor()) return
    if (event.type !== 'vehicle.move' && event.type !== 'vehicle.invite') revision++
    if (!state.data && event.type !== 'vehicle.move') { void load(); return }
    switch (event.type) {
      case 'vehicle.snapshot': {
        if (!put(event.vehicle)) break
        if (state.transfer && transferOrigin?.vehicleId === event.vehicle.id && transferOrigin.epoch !== event.vehicle.epoch) { void resume(); break }
        rollbackTransfer(event.vehicle)
        if (selected.value?.id === event.vehicle.id) { state.actions = null; void inspect(event.vehicle.id) }
        break
      }
      case 'vehicle.self': {
        const previous = event.self.vehicle && state.data?.vehicles.find(vehicle => vehicle.id === event.self.vehicle?.id)
        const accepted = !previous || previous.epoch !== event.self.vehicle?.epoch || previous.revision <= event.self.vehicle.revision
        applySelf(event.self)
        if (accepted && state.transfer && event.self.vehicle && transferOrigin?.vehicleId === event.self.vehicle.id && transferOrigin.epoch !== event.self.vehicle.epoch) { void resume(); break }
        if (accepted) rollbackTransfer(event.self.vehicle)
        if (selected.value) { state.actions = null; void inspect(selected.value.id) }
        break
      }
      case 'vehicle.invite': if (state.data) state.data.invites = [...state.data.invites.filter(item => item.id !== event.invite.id), event.invite]; break
      case 'vehicle.removed': {
        const vehicle = state.data?.vehicles.find(item => item.id === event.vehicleId)
        if (vehicle?.epoch !== event.epoch) break
        if (state.data) state.data.vehicles = state.data.vehicles.filter(item => item.id !== event.vehicleId)
        if (state.selectedId === event.vehicleId) { state.selectedId = null; state.actions = null }
        if (driver.value?.id === event.vehicleId) stopDriving(); break
      }
      case 'vehicle.move': {
        const vehicle = state.data?.vehicles.find(item => item.id === event.vehicleId)
        if (!vehicle || vehicle.epoch !== event.epoch || vehicle.room.key !== event.room || event.tick <= (motionTicks.get(vehicle.id) ?? -1)) break
        motionTicks.set(vehicle.id, event.tick)
        put({ ...vehicle, pos: event.pos, heading: event.heading, speed: event.speed, steering: event.steering }, false)
        if (driver.value?.id === event.vehicleId) sequence = Math.max(sequence, event.ackSeq)
        bridge?.motion(event); break
      }
      case 'vehicle.transfer': void transfer(event); break
      case 'vehicle.transferred': crossing.abort(); state.transfer = null; transferOrigin = null; put(event.vehicle); applySelf(event.self); bridge?.transferred(event); break
      default: { const exhaustive: never = event; return exhaustive }
    }
  }
  function connect(online: boolean): void { if (online) { restoreRecovery(); if (!state.connected) needsResume = true } else needsResume = false; state.connected = online; if (!online) stopDriving() }
  function reset(clearSaved = true): void {
    if (clearSaved) { state.paidRide = null; paidRequest = null; stoppedRide = null; saveRecovery() }
    recoveryKey = null; paidRequest = null; stoppedRide = null; state.paidRide = null
    stopDriving(); crossing.abort(); crossing = new AbortController(); account++; revision++; reading = null; followUp = null; retry = null; needsResume = false; resuming = null; flight = null
    state.data = null; state.load = 'idle'; state.selectedId = null; state.actions = null; state.quote = null; state.pending = ''; state.problem = ''; state.uncertain = false; state.retryLabel = ''; state.route = []; state.transfer = null; state.sceneData = null; state.connected = false; state.destinationMode = null; state.previewDestination = null
    transferOrigin = null; motionTicks.clear(); retiredEpochs.clear(); inputEpoch = ''; sequence = 0; lastSentAt = -Infinity; acceptedSeq = 0; refusedSeq = 0; refusals = 0
  }
  const stopGuard = watch(() => [canDrive.value, driver.value?.control.kind === 'member' ? driver.value.control.controlEpoch : null] as const, ([allowed, epoch], before) => { if (!allowed || epoch !== before?.[1]) stopDriving() })
  function dispose(): void { if (!disposed) { reset(false); stopGuard(); bridge = null; disposed = true } }
  return { state, self, seated, selected, driver, canDrive, compatible, capabilityReason, load, inspect, loan, returnVehicle, board, exit, access, invite, respondInvite, offerDriver, acceptDriver, quote, book, depart, cancelTrip, destination, resume: (): Promise<void> => resume(), drive, stopDriving, event, connect, reset, dispose,
    bindWorld(next: VehicleWorldBridge | null): void { stopDriving(); crossing.abort(); bridge = next; state.worldBound = Boolean(next) },
    scene(next: VehicleDataVersion | null): void { state.sceneData = next; if (!compatible.value) stopDriving() },
    async retryLast(): Promise<void> { if (retry && !state.pending) await retry() },
    openMapDestination(vehicleId: VehicleId): void { state.selectedId = vehicleId; state.destinationMode = seated.value ? driver.value ? 'navigation' : 'preview' : selected.value?.source === 'service' ? 'quote' : 'preview' },
    async mapDestination(target: VehicleDestination): Promise<void> {
      const mode = state.destinationMode; state.destinationMode = null
      if (mode === 'navigation' && driver.value) await destination(target)
      else if (mode === 'quote' && !seated.value) await quote(target)
      else state.previewDestination = target
    },
    clearSelection(): void { state.selectedId = null; state.actions = null },
    dismissQuote(): void { state.quote = null },
  }
}

export const vehicles = createVehicleClient({
  call: api,
  actor: () => app.phase === 'ready' ? app.me?.id ?? null : null,
  allowed: (op, input) => !app.guest || guestAccess(op, input).allowed,
  message: messageOf,
  recoveryScope: () => {
    const config = hostedWorldConfig()
    return config ? JSON.stringify([guestStorageScope(config), app.guest ? 'guest' : 'account']) : app.mode === 'local' ? JSON.stringify([location.origin, 'local', localActorKey()]) : null
  },
  balance: balance => { app.points = balance; void refreshPoints() },
})
const offEvent = onServerEvent(event => { if (event.type.startsWith('vehicle.')) {
  switch (event.type) {
    case 'vehicle.snapshot': case 'vehicle.move': case 'vehicle.removed': case 'vehicle.self': case 'vehicle.invite': case 'vehicle.transfer': case 'vehicle.transferred': vehicles.event(event)
  }
} })
const offReset = onAccountReset(() => vehicles.reset())
const offReconnect = onReconnect(() => { vehicles.stopDriving(); void vehicles.resume() })
const offOnline = watch(() => [app.phase, app.link, app.me?.id] as const, ([phase, link, id]) => { vehicles.connect(phase === 'ready' && link === 'online' && Boolean(id)); if (vehicles.state.connected) void vehicles.load() }, { immediate: true, flush: 'sync' })
const pause = (): void => vehicles.stopDriving()
const visibility = (): void => { if (document.hidden) pause(); else if (vehicles.state.connected) void vehicles.resume() }
window.addEventListener('blur', pause)
document.addEventListener('visibilitychange', visibility)
if (import.meta.hot) import.meta.hot.dispose(() => { offEvent(); offReset(); offReconnect(); offOnline(); window.removeEventListener('blur', pause); document.removeEventListener('visibilitychange', visibility); vehicles.dispose() })
