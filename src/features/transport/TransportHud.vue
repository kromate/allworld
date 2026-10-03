<script setup lang="ts">
// The vehicle host. On foot it offers ONE action for what the member is standing next to (get in, drive, see the fare for a
// paid ride, borrow at a depot) through src/ui/interaction.ts, and shows the detailed panel only while it has something to
// say: a seat, a fare to confirm, an invitation, an answer from the service, or because the member asked for it. A paid ride
// is never started by the action itself: it opens the destination chooser, and the fare is paid only from the panel's own
// "Confirm … coin ride" button, with the fare and balance in view. The service still decides every one of these.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { app, messageOf, onAccountReset, toast } from '../../state/app.ts'
import { getEngine, onFloorClicked, onVehiclePicked, world } from '../../state/world.ts'
import { vehicles } from '../../state/vehicles.ts'
import { footBlocked, useHold } from '../../ui/gameInput.ts'
import { PRIORITY, primaryInteraction, useInteraction } from '../../ui/interaction.ts'
import type { Interaction } from '../../ui/interaction.ts'
import TransportPanel from './TransportPanel.vue'
import DriverControls from './DriverControls.vue'
import { RIDE_REACH, entriesNear, nearestRideTarget, planBoarding, rideWords, sameTarget } from './rideActions.ts'
import type { RideTarget } from './rideActions.ts'
import type { DriverIntent, TransportCommand } from './transportView.ts'
import type { MemberId, VehicleId } from '../../shared/ids.ts'
import { VEHICLE_KINDS, VEHICLE_SPECS, vehiclePoint } from '../../shared/vehicles.ts'
import type { VehicleDepotView, VehicleKind, VehicleSnapshot } from '../../shared/vehicles.ts'
import type { Vec2 } from '../../shared/geo.ts'
const props = defineProps<{ compactDriver?: boolean; inputBlocked?: boolean }>()
watch(() => props.inputBlocked, blocked => { if (blocked) vehicles.stopDriving() }, { immediate: true, flush: 'sync' })
function drive(intent: DriverIntent): void { if (props.inputBlocked) vehicles.stopDriving(); else vehicles.drive(intent) }
const driveEnabled = computed(() => vehicles.canDrive.value && !props.inputBlocked)
/** `drive-intent`: the member asked to drive, so a page or window open over the world should close (it holds foot input). `boarded`: the service seated them as the driver. */
const emit = defineEmits<{ expanded: [open: boolean]; 'drive-intent': []; boarded: [] }>()
const router = useRouter()
const peers = computed(() => world.members.filter(member => member.id !== app.me?.id))
async function command(intent: TransportCommand): Promise<void> {
  const asked = lifetime
  try {
    switch (intent.kind) {
      case 'inspect': await vehicles.inspect(intent.vehicleId); break
      case 'loan': await vehicles.loan(intent.depotId, intent.vehicleKind); if (vehicles.selected.value) await vehicles.inspect(vehicles.selected.value.id); break
      case 'return': await vehicles.returnVehicle(); break
      case 'board': await vehicles.board(intent.seatId, intent.entryId, intent.inviteId); break
      case 'exit': await vehicles.exit(); break
      case 'access': await vehicles.access(intent.access); break
      case 'invite': await vehicles.invite(intent.to, intent.role); break
      case 'respond-invite': await vehicles.respondInvite(intent.inviteId, intent.accept); break
      case 'offer-driver': await vehicles.offerDriver(intent.to); break
      case 'accept-driver': await vehicles.acceptDriver(intent.offer); break
      case 'confirm': await vehicles.book(intent.quoteId, intent.entryId); break
      case 'dismiss-quote': vehicles.dismissQuote(); break
      case 'depart': await vehicles.depart(); break
      case 'cancel-trip': await vehicles.cancelTrip(); break
      case 'retry': await vehicles.retryLast(); break
      default: { const exhaustive: never = intent; return exhaustive }
    }
  } catch (error) { if (asked === lifetime) vehicles.state.problem = messageOf(error) }
}
async function nearby(): Promise<void> { vehicles.clearSelection(); await vehicles.load() }
function destination(vehicleId: VehicleId): void { closePanel(); vehicles.openMapDestination(vehicleId); void router.push('/map') }

// ── What is open ──
const detailsOpen = ref(false)
let lifetime = 0
/** An answer from the service the member has read and put away. A new, different answer shows again. */
const dismissed = ref('')

// ── What is next to the member ──
/** How far away to start saying where a depot is, and the gap before it goes quiet again (so walking along the edge does not make the card come and go). */
const GUIDE = { take: 120, keep: 140 } as const
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'] as const
/** Which way from one point to another, as the mini-map draws it (north is up). +x is east and +z is south. */
function direction(from: Vec2, to: Vec2): string {
  const turn = Math.atan2(to.x - from.x, from.z - to.z)
  return COMPASS[Math.round((turn + 2 * Math.PI) % (2 * Math.PI) / (Math.PI / 4)) % 8]!
}
/** Whole metres up close, steps of five further out: the words are redrawn four times a second and should not flicker. */
const metres = (distance: number): string => `${distance < 10 ? Math.max(1, Math.round(distance)) : Math.round(distance / 5) * 5} m`
function nearestDepot(at: Vec2, depots: readonly VehicleDepotView[]): { depot: VehicleDepotView; distance: number } | null {
  let best: { depot: VehicleDepotView; distance: number } | null = null
  for (const depot of depots) {
    if (depot.districtId !== world.districtId) continue
    const distance = Math.hypot(at.x - depot.pos.x, at.z - depot.pos.z)
    if (!best || distance < best.distance) best = { depot, distance }
  }
  return best
}
/** The depot id the member is close enough to be told about; kept by `look`. */
const seen = ref<string | null>(null)
const me = computed(() => app.me?.id ?? null)
const target = ref<RideTarget | null>(null)
/** Where the avatar stood at the last look, for choosing the door nearest it. Looked at four times a second, and only while it can matter. */
const position = ref<Vec2 | null>(null)
function look(): void {
  const data = vehicles.state.data, engine = getEngine()
  const here = engine && !document.hidden && world.state === 'ready' && world.kind === 'district' && !vehicles.seated.value ? engine.position : null
  position.value = here
  const next = here && data?.available && !footBlocked.value
    ? nearestRideTarget({ at: here, vehicles: data.vehicles.filter(vehicle => vehicle.room.key === world.roomKey && vehicle.room.instance === world.instance), depots: data.depots.filter(depot => depot.districtId === world.districtId), me: me.value, invites: data.invites, previous: target.value })
    : null
  if (!sameTarget(next, target.value)) target.value = next
  const depot = here && data?.available ? nearestDepot(here, data.depots) : null
  seen.value = depot && depot.distance <= (seen.value === depot.depot.id ? GUIDE.keep : GUIDE.take) ? depot.depot.id : null
  stepIntent()
}
const lookTimer = window.setInterval(look, 250)
onBeforeUnmount(() => window.clearInterval(lookTimer))

const vehicleHere = computed(() => { const here = target.value; return here?.kind === 'vehicle' ? vehicles.state.data?.vehicles.find(vehicle => vehicle.id === here.id) ?? null : null })
const plan = computed(() => vehicleHere.value && position.value ? planBoarding(vehicleHere.value, position.value, { me: me.value, invites: vehicles.state.data?.invites ?? [], paid: vehicleHere.value.source === 'service' }) : null)
/** A vehicle borrowed by this member that is in this room: it can be returned from the panel even when it is not next to them. */
const ownBorrowed = computed(() => { const own = vehicles.self.value?.vehicle; return own && own.source === 'borrowed' && own.ownerId === me.value && !vehicles.seated.value ? own : null })

async function ride(vehicleId: VehicleId): Promise<void> {
  const asked = lifetime
  try {
    await vehicles.inspect(vehicleId)
    if (asked !== lifetime) return
    const vehicle = vehicles.selected.value
    if (!vehicle || vehicle.id !== vehicleId) return
    // A paid ride only asks where to. The fare is shown and confirmed from the panel.
    if (vehicle.source === 'service') { destination(vehicle.id); return }
    const here = getEngine()?.position
    const chosen = here ? planBoarding(vehicle, here, { me: me.value, invites: vehicles.state.data?.invites ?? [], paid: false }) : null
    if (!chosen) { vehicles.state.problem = 'No free seat is within reach of where you are standing.'; return }
    await vehicles.board(chosen.seatId, chosen.entryId, chosen.inviteId)
  } catch (error) { if (asked === lifetime) vehicles.state.problem = messageOf(error) }
}
const idle = (): boolean => !vehicles.seated.value && !vehicles.capabilityReason.value && !vehicles.state.quote && !vehicles.state.paidRide
useInteraction('ride.board', (): Interaction | null => {
  const vehicle = vehicleHere.value, chosen = plan.value
  if (!vehicle || !chosen || !idle()) return null
  return { id: 'ride.board', priority: PRIORITY.vehicleHere, ...rideWords(vehicle, chosen), icon: 'car', key: 'E', tone: 'primary', busy: Boolean(vehicles.state.pending), disabled: !vehicles.state.connected || vehicles.state.uncertain, run: () => { void ride(vehicle.id) } }
})
useInteraction('ride.depot', (): Interaction | null => {
  if (target.value?.kind !== 'depot' || !idle() || intent.value) return null
  return { id: 'ride.depot', priority: PRIORITY.depot, verb: 'Borrow & drive', target: DIRECT_KIND, label: `Borrow a ${DIRECT_KIND} at the nearby depot, walk to it and drive`, icon: 'car', key: 'E', tone: 'primary', busy: Boolean(vehicles.state.pending), disabled: !vehicles.state.connected || vehicles.state.uncertain, run: () => { startBorrowDrive() } }
})
useInteraction('ride.depot-more', (): Interaction | null => {
  if (target.value?.kind !== 'depot' || !idle() || intent.value) return null
  return { id: 'ride.depot-more', priority: PRIORITY.depot - 1, verb: 'Vehicles', target: 'choose another', label: 'Choose a keke, danfo or car at the nearby depot', icon: 'car', tone: 'dark', run: () => { detailsOpen.value = true } }
})
useInteraction('ride.drive', (): Interaction | null => {
  const own = ownBorrowed.value
  if (!own || intent.value || !idle() || !position.value || own.room.key !== world.roomKey || own.room.instance !== world.instance || target.value?.kind === 'vehicle') return null
  const door = entriesNear(own, position.value)[0]
  if (!door || door.distance > GUIDE.keep) return null
  return { id: 'ride.drive', priority: PRIORITY.depot, verb: 'Drive', target: `your ${VEHICLE_SPECS[own.kind].label.toLowerCase()}`, label: `Walk to your borrowed ${VEHICLE_SPECS[own.kind].label.toLowerCase()} and drive it`, icon: 'car', tone: 'dark', busy: Boolean(vehicles.state.pending), disabled: !vehicles.state.connected || vehicles.state.uncertain, run: () => { startApproach(own.id) } }
})
useInteraction('ride.details', (): Interaction | null => {
  if (vehicles.seated.value || detailsOpen.value || (!vehicleHere.value && !ownBorrowed.value)) return null
  return { id: 'ride.details', priority: PRIORITY.rideMore, verb: 'Vehicle', target: 'seats and options', label: 'Seats and options for this vehicle', icon: 'sliders', tone: 'dark', run: () => { detailsOpen.value = true } }
})

// ── The panel: only while it has something to say ──
const blocking = computed(() => {
  const state = vehicles.state, data = state.data
  return Boolean(state.quote || state.paidRide || state.pending || state.uncertain || state.retryLabel || state.transfer || data?.self.offer
    || data?.invites.some(invite => invite.recipient === me.value && invite.status === 'pending') || (state.problem && state.problem !== dismissed.value))
})
const driverDecision = computed(() => Boolean(vehicles.state.uncertain || vehicles.state.retryLabel || vehicles.state.transfer || vehicles.self.value?.offer))
const shown = computed(() => detailsOpen.value || (blocking.value && !intent.value && !driverSeat.value) || Boolean(vehicles.seated.value && !driverSeat.value) || driverDecision.value)
/** Seated as the driver: the panel folds to its header so the controls and the road are not under it. */
const driverSeat = computed(() => vehicles.seated.value?.seatId === 'driver')
const closable = computed(() => (!vehicles.seated.value || driverSeat.value) && !vehicles.state.quote && !vehicles.state.paidRide && !vehicles.state.pending && !vehicles.state.uncertain && !vehicles.state.transfer)
function closePanel(): void { detailsOpen.value = false; dismissed.value = vehicles.state.problem }
useHold('ride.details', () => shown.value && closable.value, { role: 'panel', close: closePanel })
/** The door nearest the member, for a paid ride booked from where they stand (the panel lets them choose another). */
const quoteEntry = computed(() => {
  const quote = vehicles.state.quote, vehicle = quote ? vehicles.state.data?.vehicles.find(item => item.id === quote.vehicleId) : null
  return vehicle && position.value ? entriesNear(vehicle, position.value)[0]?.id : undefined
})
// ── Driving at once: walk to the driver's door, then ask the service to seat the member. ──
// The member's own intent, in one place. It walks the avatar with the engine's ordinary `walkTo` (no teleport, no position write),
// asks to board only from the door, and the service still decides seat, access, range and control. A paid service vehicle
// (a taxi, a driver already in the seat) is never reached from here: that stays the "Ride" action that asks where to and shows the fare.
/** What "Borrow & drive" borrows when the member did not choose. */
const DIRECT_KIND: VehicleKind = 'car'
const INTENT = { totalMs: 45_000, blockedTicks: 8, backoffMetres: 3 } as const
interface DriveIntent {
  phase: 'borrowing' | 'walking' | 'boarding'
  /** Who asked, and where: a different member, street, instance or a dropped link ends it. */
  actor: MemberId | null; roomKey: string | null; instance: number
  vehicleId: VehicleId | null
  startedAt: number; blocked: number; best: number; walking: boolean
  /** The loan was sent and has answered (or failed). */
  loanDone: boolean
}
const intent = ref<DriveIntent | null>(null)
const NOT_DRIVABLE = 'You cannot drive this vehicle. A free seat of your own borrowed vehicle is needed.'
/** End the intent. `stop` also halts the walk the engine is on; it is false when the member took over walking themselves. */
function cancelIntent(reason = '', stop = true): void {
  const was = intent.value
  if (!was) return
  intent.value = null
  if (stop && was.walking) getEngine()?.stop()
  if (reason) vehicles.state.problem = reason
}
function begin(phase: DriveIntent['phase'], vehicleId: VehicleId | null): DriveIntent | null {
  if (intent.value || vehicles.seated.value || !vehicles.state.connected || vehicles.state.pending || vehicles.state.uncertain || vehicles.state.quote || vehicles.state.paidRide || vehicles.capabilityReason.value || world.kind !== 'district') return null
  const next: DriveIntent = { phase, actor: me.value, roomKey: world.roomKey, instance: world.instance, vehicleId, startedAt: Date.now(), blocked: 0, best: Infinity, walking: false, loanDone: false }
  intent.value = next
  closePanel()
  emit('drive-intent')
  return next
}
/** Walk to a parked vehicle the member may drive, then drive it. Does nothing for a vehicle they may not drive (a taxi, someone else's). */
function startApproach(vehicleId: VehicleId): void {
  const data = vehicles.state.data, here = getEngine()?.position
  const vehicle = data?.vehicles.find(item => item.id === vehicleId) ?? (vehicles.self.value?.vehicle?.id === vehicleId ? vehicles.self.value.vehicle : undefined)
  if (!vehicle || !here || vehicle.room.key !== world.roomKey || vehicle.room.instance !== world.instance) return
  const chosen = planBoarding(vehicle, here, { me: me.value, invites: data?.invites ?? [], paid: false })
  if (vehicle.source !== 'borrowed' || chosen?.role !== 'driver') { toast(vehicle.source === 'service' ? 'This taxi has a driver. Use Borrow & drive at the depot for your own car.' : NOT_DRIVABLE, 'info'); return }
  begin('walking', vehicleId)
}
/** The depot's loan, then the same walk. `depotId` and `kind` come from the panel; the action at the depot uses the nearest depot and a keke. */
function startBorrowDrive(depotId?: string, kind: VehicleKind = DIRECT_KIND): void {
  const own = ownBorrowed.value
  if (own) { startApproach(own.id); return }
  const id = depotId ?? depotInfo.value?.id
  if (!id || !vehicles.state.data?.available) return
  const it = begin('borrowing', null)
  if (!it) return
  void command({ kind: 'loan', depotId: id, vehicleKind: kind }).finally(() => { it.loanDone = true })
}
function boardNow(it: DriveIntent, vehicle: VehicleSnapshot): void {
  it.phase = 'boarding'
  void (async () => {
    try {
      if (vehicles.state.selectedId !== vehicle.id) await vehicles.inspect(vehicle.id)
      if (intent.value !== it || me.value !== it.actor || world.roomKey !== it.roomKey || world.instance !== it.instance || !vehicles.state.connected) return
      const fresh = vehicles.selected.value, here = getEngine()?.position
      const chosen = fresh && here ? planBoarding(fresh, here, { me: me.value, invites: vehicles.state.data?.invites ?? [], paid: false }) : null
      // Only the driver's seat, only from the door, only a vehicle the member may drive: never a passenger seat by this route.
      if (!fresh || fresh.id !== vehicle.id || fresh.source !== 'borrowed' || chosen?.role !== 'driver' || chosen.distance > RIDE_REACH.keep) { vehicles.state.problem = NOT_DRIVABLE; return }
      await vehicles.board(chosen.seatId, chosen.entryId, chosen.inviteId)
    } catch (error) { if (intent.value === it && me.value === it.actor) vehicles.state.problem = messageOf(error) }
    finally {
      if (intent.value === it) { intent.value = null; if (vehicles.seated.value) emit('boarded') }
    }
  })()
}
/** One look of the intent, from the same four-a-second tick. */
function stepIntent(): void {
  const it = intent.value
  if (!it || it.phase === 'boarding') return
  const at = position.value
  if (Date.now() - it.startedAt > INTENT.totalMs) return cancelIntent('Could not reach the vehicle. Walk up to it and press Drive.')
  if (!at || me.value !== it.actor || world.roomKey !== it.roomKey || world.instance !== it.instance || !vehicles.state.connected || vehicles.seated.value) return cancelIntent()
  const data = vehicles.state.data
  if (it.phase === 'borrowing') {
    const own = ownBorrowed.value
    // Not while the loan is unsettled: an answer that was lost is checked again from the panel's own retry first.
    if (own && own.room.key === it.roomKey && own.room.instance === it.instance && !vehicles.state.pending && !vehicles.state.uncertain && !vehicles.state.retryLabel) { it.vehicleId = own.id; it.phase = 'walking'; return }
    // The loan answered and there is still no vehicle of theirs: it failed, and the panel says why.
    if (it.loanDone && !vehicles.state.pending && !vehicles.state.uncertain && !vehicles.state.retryLabel) cancelIntent()
    return
  }
  const vehicle = data?.vehicles.find(item => item.id === it.vehicleId) ?? (vehicles.self.value?.vehicle?.id === it.vehicleId ? vehicles.self.value.vehicle : undefined)
  const chosen = vehicle ? planBoarding(vehicle, at, { me: me.value, invites: data?.invites ?? [], paid: false }) : null
  if (!vehicle || vehicle.source !== 'borrowed' || chosen?.role !== 'driver' || (vehicle.phase !== 'parked' && vehicle.phase !== 'boarding') || Math.abs(vehicle.speed) > 0.5) return cancelIntent(NOT_DRIVABLE)
  if (vehicles.state.uncertain || vehicles.state.quote || vehicles.state.paidRide) return cancelIntent()
  if (chosen.distance <= RIDE_REACH.take) { getEngine()?.stop(); it.walking = false; boardNow(it, vehicle); return }
  if (footBlocked.value) { if (++it.blocked > INTENT.blockedTicks) cancelIntent(); return }
  it.blocked = 0
  // Walking away from the door means the member took over: end the intent without stopping their walk.
  if (it.walking && chosen.distance > it.best + INTENT.backoffMetres) return cancelIntent('', false)
  it.best = Math.min(it.best, chosen.distance)
  if (it.walking) return
  const entry = VEHICLE_SPECS[vehicle.kind].entries.find(item => item.id === chosen.entryId)
  // Stop outside the body while staying inside the service's existing boarding range.
  const door = entry ? vehiclePoint(vehicle.pos, vehicle.heading, entry.x + Math.sign(entry.x) * 0.45, entry.z) : null
  const walk = door ? getEngine()?.walkTo(door, { exact: true }) : null
  if (!walk || walk.status === 'unreachable') return cancelIntent('There is no walkable way to the vehicle door from here.')
  it.walking = true
}
const MOVE_KEYS = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
const takeOver = (): void => cancelIntent('', false)
const onKey = (event: KeyboardEvent): void => { if (intent.value && MOVE_KEYS.has(event.code)) takeOver() }
const onPointer = (event: PointerEvent): void => { if (intent.value && event.target instanceof Element && event.target.closest('.stick-slot, canvas')) cancelIntent() }
window.addEventListener('keydown', onKey, true)
window.addEventListener('pointerdown', onPointer, true)
const stopFloor = onFloorClicked(takeOver)
const stopVehiclePick = onVehiclePicked(startApproach)
onBeforeUnmount(() => { lifetime++; window.removeEventListener('keydown', onKey, true); window.removeEventListener('pointerdown', onPointer, true); stopFloor(); stopVehiclePick(); cancelIntent() })
/** For the engine bridge (a click on a parked vehicle in the scene): same intent, same checks. Exposed so the host can hand the click here. */
defineExpose({ approachVehicle: startApproach })
const intentWords = computed(() => {
  const it = intent.value
  if (!it) return ''
  const own = ownBorrowed.value
  return it.phase === 'borrowing' ? 'Borrowing a vehicle…' : it.phase === 'boarding' ? 'Getting in…' : `Walking to your ${own ? VEHICLE_SPECS[own.kind].label.toLowerCase() : 'vehicle'}. Move to take over.`
})

// ── Walking there: say where the depot, or the vehicle just borrowed, is. Words only: nothing moves the member, and the service still checks the range. ──
/** The nearest depot with what the panel needs to point at it. `here` is the same test the "Vehicles" action uses. */
const depotInfo = computed(() => {
  const at = position.value, data = vehicles.state.data
  const found = at && data?.available ? nearestDepot(at, data.depots) : null
  if (!at || !found) return null
  const here = found.distance <= RIDE_REACH.depotTake || (target.value?.kind === 'depot' && target.value.id === found.depot.id && found.distance <= RIDE_REACH.depotKeep)
  return { id: found.depot.id, here, where: `${metres(found.distance)} to the ${direction(at, found.depot.pos)}` }
})
const kindWords = VEHICLE_KINDS.map(kind => VEHICLE_SPECS[kind].label.toLowerCase()).join(', ').replace(/, ([^,]*)$/, ' or $1')
interface Guide { key: string; text: string; /** `drive`: walk to the member's own vehicle and drive. `borrow`: borrow and drive at the depot. */ act?: 'drive' | 'borrow'; vehicleId?: VehicleId }
/** What there is to say about getting to a vehicle, if anything. The member's own borrowed vehicle comes before a depot: it is one at a time. */
const wayTo = computed<Guide | null>(() => {
  const at = position.value
  if (!at || !vehicles.state.data?.available) return null
  const own = ownBorrowed.value
  if (own) {
    // It is in this street and standing; the board action takes over once a door is within reach.
    if (own.room.key !== world.roomKey || own.room.instance !== world.instance || (own.phase !== 'parked' && own.phase !== 'boarding')) return null
    if (target.value?.kind === 'vehicle' && target.value.id === own.id) return null
    const door = entriesNear(own, at)[0]
    if (!door || door.distance > GUIDE.keep) return null
    return { key: `own:${own.id}`, text: `Your ${VEHICLE_SPECS[own.kind].label.toLowerCase()} is ${metres(door.distance)} to the ${direction(at, own.pos)}. Walk up to a door and press Drive, or let it take you there.`, act: 'drive', vehicleId: own.id }
  }
  const depot = depotInfo.value
  if (!depot || (!depot.here && seen.value !== depot.id)) return null
  // Standing at the depot with "Vehicles" already the main button: nothing more to say.
  if (depot.here && primaryInteraction.value?.id === 'ride.depot') return null
  return depot.here
    ? { key: `depot:${depot.id}`, text: `You are at the vehicle depot. Borrow a ${DIRECT_KIND} and drive it, or choose ${kindWords}.`, act: 'borrow' }
    : { key: `depot:${depot.id}`, text: `Vehicle depot ${depot.where}. Walk there to borrow ${kindWords}.` }
})
/** The way the member hid, until it has nothing to say again (they walked off). */
const hidden = ref('')
watch(wayTo, way => { if (!way) hidden.value = '' })
const guide = computed(() => {
  const way = wayTo.value
  return way && way.key !== hidden.value && vehicles.state.connected && !props.inputBlocked && !footBlocked.value && !shown.value && !intent.value && idle() ? way : null
})

// A different member, or a reset account, starts with nothing offered and nothing open.
function forget(): void { lifetime++; cancelIntent(); target.value = null; position.value = null; seen.value = null; hidden.value = ''; detailsOpen.value = false; dismissed.value = '' }
watch(me, forget)
// The same member signing in again after a reset counts too: the vehicle client clears its own state on that signal.
const stopReset = onAccountReset(forget)
onBeforeUnmount(stopReset)
</script>

<template>
  <div v-if="shown || guide || intent || (props.compactDriver && vehicles.driver.value)" class="transport-hud">
    <DriverControls v-if="props.compactDriver && vehicles.driver.value" :enabled="driveEnabled" @input="drive" />
    <p v-if="driverSeat && !shown && vehicles.state.problem" class="driver-notice" role="status">{{ vehicles.state.problem }}</p>
    <button v-if="driverSeat && !shown" class="btn sm transport-close" type="button" @click="detailsOpen = true">Vehicle options</button>
    <section v-if="guide && !shown" class="transport-guide" :class="{ 'transport-guide-passive': !guide.act }" aria-label="Where to find a vehicle">
      <details class="guide-details"><summary>{{ guide.text.split('. ')[0] }}</summary><p>{{ guide.text }}</p></details>
      <div class="transport-guide-actions">
        <button v-if="guide.act === 'borrow'" class="btn sm primary" type="button" @click="startBorrowDrive()">Borrow and drive</button>
        <button v-if="guide.act === 'borrow'" class="btn sm" type="button" @click="detailsOpen = true">Choose vehicle</button>
        <button v-if="guide.act === 'drive' && guide.vehicleId" class="btn sm primary" type="button" @click="startApproach(guide.vehicleId)">Walk there and drive</button>
        <button class="btn sm" type="button" @click="hidden = guide.key">Hide</button>
      </div>
    </section>
    <section v-if="intent && !shown" class="transport-guide" aria-label="Driving">
      <p role="status">{{ intentWords }}</p>
      <div class="transport-guide-actions"><button class="btn sm" type="button" @click="cancelIntent()">Cancel</button></div>
    </section>
    <template v-if="shown">
      <TransportPanel :view="vehicles.state" :member-id="app.me?.id ?? null" :members="peers" :capability-reason="vehicles.capabilityReason.value" :can-drive="driveEnabled" :show-driver-controls="!props.compactDriver" :open="!driverSeat" :preferred-entry="quoteEntry" :depot="depotInfo" @approach="startApproach" @borrow-drive="startBorrowDrive" @command="command" @refresh="nearby" @map="router.push('/map')" @destination="destination" @drive="drive" @expanded="emit('expanded', $event)" />
      <button v-if="closable" class="btn sm transport-close" type="button" @click="closePanel">Close vehicle details</button>
    </template>
  </div>
</template>

<style scoped>
.transport-hud { width: min(360px, 100%); min-width: 0; display: grid; gap: 8px; pointer-events: auto; }
.transport-close { min-height: 44px; justify-self: end; }
.driver-notice { margin: 0; padding: 8px 12px; border-radius: 12px; background: var(--surface); color: var(--ink); font-size: .8rem; }
/* Narrow on purpose, like the doorway card: the thumb pad at the lower left is up to 124 px wide plus its 10 px edge, so on a 360 px phone the card starts to the right of it. */
.transport-guide { display: grid; gap: 8px; width: min(236px, calc(100% - 132px)); min-width: 0; justify-self: end; padding: 10px 12px; border-radius: 18px; background: rgba(255, 253, 249, 0.98); box-shadow: var(--shadow-lg); color: var(--ink); }
.guide-details { min-width: 0; }
.guide-details summary { min-height: 44px; display: flex; align-items: center; gap: 6px; font-size: .8rem; line-height: 1.35; cursor: pointer; overflow-wrap: anywhere; }
.guide-details summary::after { content: '▾'; flex: none; margin-left: auto; }
.guide-details[open] summary::after { content: '▴'; }
.guide-details[open] p { margin-top: 6px; }
.transport-guide-passive { grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
.transport-guide-passive .transport-guide-actions { align-self: start; }
.transport-guide p { margin: 0; font-size: .8rem; line-height: 1.35; overflow-wrap: anywhere; }
.transport-guide-actions { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
.transport-guide .btn { min-height: 44px; }
</style>
