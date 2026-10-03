<script setup lang="ts">
// The vehicle host. On foot it offers ONE action for what the member is standing next to (get in, drive, see the fare for a
// paid ride, borrow at a depot) through src/ui/interaction.ts, and shows the detailed panel only while it has something to
// say: a seat, a fare to confirm, an invitation, an answer from the service, or because the member asked for it. A paid ride
// is never started by the action itself: it opens the destination chooser, and the fare is paid only from the panel's own
// "Confirm … coin ride" button, with the fare and balance in view. The service still decides every one of these.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { app, messageOf, onAccountReset } from '../../state/app.ts'
import { getEngine, world } from '../../state/world.ts'
import { vehicles } from '../../state/vehicles.ts'
import { footBlocked, useHold } from '../../ui/gameInput.ts'
import { PRIORITY, useInteraction } from '../../ui/interaction.ts'
import type { Interaction } from '../../ui/interaction.ts'
import TransportPanel from './TransportPanel.vue'
import DriverControls from './DriverControls.vue'
import { entriesNear, nearestRideTarget, planBoarding, rideWords, sameTarget } from './rideActions.ts'
import type { RideTarget } from './rideActions.ts'
import type { DriverIntent, TransportCommand } from './transportView.ts'
import type { VehicleId } from '../../shared/ids.ts'
import type { Vec2 } from '../../shared/geo.ts'
const props = defineProps<{ compactDriver?: boolean; inputBlocked?: boolean }>()
watch(() => props.inputBlocked, blocked => { if (blocked) vehicles.stopDriving() }, { immediate: true, flush: 'sync' })
function drive(intent: DriverIntent): void { if (props.inputBlocked) vehicles.stopDriving(); else vehicles.drive(intent) }
const driveEnabled = computed(() => vehicles.canDrive.value && !props.inputBlocked)
const emit = defineEmits<{ expanded: [open: boolean] }>()
const router = useRouter()
const peers = computed(() => world.members.filter(member => member.id !== app.me?.id))
async function command(intent: TransportCommand): Promise<void> {
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
  } catch (error) { vehicles.state.problem = messageOf(error) }
}
async function nearby(): Promise<void> { vehicles.clearSelection(); await vehicles.load() }
function destination(vehicleId: VehicleId): void { closePanel(); vehicles.openMapDestination(vehicleId); void router.push('/map') }

// ── What is open ──
const detailsOpen = ref(false)
/** An answer from the service the member has read and put away. A new, different answer shows again. */
const dismissed = ref('')

// ── What is next to the member ──
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
}
const lookTimer = window.setInterval(look, 250)
onBeforeUnmount(() => window.clearInterval(lookTimer))

const vehicleHere = computed(() => { const here = target.value; return here?.kind === 'vehicle' ? vehicles.state.data?.vehicles.find(vehicle => vehicle.id === here.id) ?? null : null })
const plan = computed(() => vehicleHere.value && position.value ? planBoarding(vehicleHere.value, position.value, { me: me.value, invites: vehicles.state.data?.invites ?? [], paid: vehicleHere.value.source === 'service' }) : null)
/** A vehicle borrowed by this member that is in this room: it can be returned from the panel even when it is not next to them. */
const ownBorrowed = computed(() => { const own = vehicles.self.value?.vehicle; return own && own.source === 'borrowed' && own.ownerId === me.value && !vehicles.seated.value ? own : null })

async function ride(vehicleId: VehicleId): Promise<void> {
  try {
    await vehicles.inspect(vehicleId)
    const vehicle = vehicles.selected.value
    if (!vehicle || vehicle.id !== vehicleId) return
    // A paid ride only asks where to. The fare is shown and confirmed from the panel.
    if (vehicle.source === 'service') { destination(vehicle.id); return }
    const here = getEngine()?.position
    const chosen = here ? planBoarding(vehicle, here, { me: me.value, invites: vehicles.state.data?.invites ?? [], paid: false }) : null
    if (!chosen) { vehicles.state.problem = 'No free seat is within reach of where you are standing.'; return }
    await vehicles.board(chosen.seatId, chosen.entryId, chosen.inviteId)
  } catch (error) { vehicles.state.problem = messageOf(error) }
}
const idle = (): boolean => !vehicles.seated.value && !vehicles.capabilityReason.value && !vehicles.state.quote && !vehicles.state.paidRide
useInteraction('ride.board', (): Interaction | null => {
  const vehicle = vehicleHere.value, chosen = plan.value
  if (!vehicle || !chosen || !idle()) return null
  return { id: 'ride.board', priority: PRIORITY.vehicleHere, ...rideWords(vehicle, chosen), icon: 'car', key: 'E', tone: 'primary', busy: Boolean(vehicles.state.pending), disabled: !vehicles.state.connected || vehicles.state.uncertain, run: () => { void ride(vehicle.id) } }
})
useInteraction('ride.depot', (): Interaction | null => {
  if (target.value?.kind !== 'depot' || !idle()) return null
  return { id: 'ride.depot', priority: PRIORITY.depot, verb: 'Vehicles', target: 'borrow one', label: 'Borrow a keke, danfo or car at the nearby depot', icon: 'car', key: 'E', tone: 'primary', run: () => { detailsOpen.value = true } }
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
const shown = computed(() => Boolean(vehicles.seated.value) || detailsOpen.value || blocking.value)
const closable = computed(() => !vehicles.seated.value && !vehicles.state.quote && !vehicles.state.paidRide && !vehicles.state.pending && !vehicles.state.uncertain && !vehicles.state.transfer)
function closePanel(): void { detailsOpen.value = false; dismissed.value = vehicles.state.problem }
useHold('ride.details', () => shown.value && closable.value, { role: 'panel', close: closePanel })
/** The door nearest the member, for a paid ride booked from where they stand (the panel lets them choose another). */
const quoteEntry = computed(() => {
  const quote = vehicles.state.quote, vehicle = quote ? vehicles.state.data?.vehicles.find(item => item.id === quote.vehicleId) : null
  return vehicle && position.value ? entriesNear(vehicle, position.value)[0]?.id : undefined
})
// A different member, or a reset account, starts with nothing offered and nothing open.
function forget(): void { target.value = null; position.value = null; detailsOpen.value = false; dismissed.value = '' }
watch(me, forget)
// The same member signing in again after a reset counts too: the vehicle client clears its own state on that signal.
const stopReset = onAccountReset(forget)
onBeforeUnmount(stopReset)
</script>

<template>
  <div v-if="shown || (props.compactDriver && vehicles.driver.value)" class="transport-hud">
    <DriverControls v-if="props.compactDriver && vehicles.driver.value" :enabled="driveEnabled" @input="drive" />
    <template v-if="shown">
      <TransportPanel :view="vehicles.state" :member-id="app.me?.id ?? null" :members="peers" :capability-reason="vehicles.capabilityReason.value" :can-drive="driveEnabled" :show-driver-controls="!props.compactDriver" :open="true" :preferred-entry="quoteEntry" @command="command" @refresh="nearby" @map="router.push('/map')" @destination="destination" @drive="drive" @expanded="emit('expanded', $event)" />
      <button v-if="closable" class="btn sm transport-close" type="button" @click="closePanel">Close vehicle details</button>
    </template>
  </div>
</template>

<style scoped>
.transport-hud { width: min(360px, 100%); min-width: 0; display: grid; gap: 8px; pointer-events: auto; }
.transport-close { min-height: 44px; justify-self: end; }
</style>
