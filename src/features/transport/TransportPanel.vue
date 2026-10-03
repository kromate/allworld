<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { MemberId, VehicleId } from '../../shared/ids.ts'
import type { PresenceMember } from '../../shared/model.ts'
import { VEHICLE_ACCESS, VEHICLE_KINDS, VEHICLE_SPECS } from '../../shared/vehicles.ts'
import type { SeatId, VehicleKind, VehicleSeat, VehicleSnapshot } from '../../shared/vehicles.ts'
import DriverControls from './DriverControls.vue'
import type { DriverIntent, TransportCommand, TransportPresentation } from './transportView.ts'
const props = withDefaults(defineProps<{ view: TransportPresentation; memberId: MemberId | null; members: readonly Pick<PresenceMember, 'id' | 'displayName' | 'relation'>[]; capabilityReason: string; canDrive: boolean; showDriverControls?: boolean; open?: boolean; preferredEntry?: string }>(), { members: () => [], showDriverControls: true })
const emit = defineEmits<{ command: [command: TransportCommand]; refresh: []; map: []; destination: [vehicleId: VehicleId]; drive: [intent: DriverIntent]; expanded: [open: boolean] }>()
const expanded = ref(Boolean(props.open))
// The host shows this panel only while it has something to say, so it starts open and opens again when asked.
watch(() => props.open, open => { if (open && !expanded.value) { expanded.value = true; emit('expanded', true) } })
// A fare to confirm is never left folded away.
watch(() => props.view.quote?.id, id => { if (id && !expanded.value) { expanded.value = true; emit('expanded', true) } })
const entryIds = ref<Partial<Record<SeatId, string>>>({})
const bookingEntry = ref('')
const kind = ref<VehicleKind>('car')
const chosenDepot = ref('')
const data = computed(() => props.view.data)
const self = computed(() => data.value?.self ?? null)
const vehicle = computed(() => self.value?.seat ? self.value.vehicle : data.value?.available ? data.value.vehicles.find(item => item.id === props.view.selectedId) ?? self.value?.vehicle ?? null : null)
const seated = computed(() => self.value?.seat ?? null)
const role = computed(() => seated.value ? seated.value.seatId === 'driver' ? 'driver' : 'passenger' : null)
const busy = computed(() => !props.view.connected || !!props.view.pending || props.view.uncertain)
const owned = computed(() => vehicle.value?.source === 'borrowed' && vehicle.value.ownerId === props.memberId)
const payer = computed(() => vehicle.value?.control.kind === 'service' && vehicle.value.control.bookingMemberId === props.memberId)
const peerSeats = computed(() => vehicle.value?.seats.flatMap(seat => seat.occupant?.kind === 'member' && seat.occupant.memberId !== props.memberId ? [seat.occupant.memberId] : []) ?? [])
const invitePeers = computed(() => props.members.filter(member => member.id !== props.memberId))
const receivedInvites = computed(() => data.value?.invites.filter(invite => invite.recipient === props.memberId && invite.status === 'pending') ?? [])
const recoveredRide = computed(() => props.view.paidRide && !(payer.value && vehicle.value?.trip?.id === props.view.paidRide.tripId))
const title = computed(() => props.view.paidRide && !seated.value ? 'Your paid ride' : seated.value && vehicle.value ? `${role.value === 'driver' ? 'Driving' : 'Riding in'} ${label(vehicle.value)}` : data.value?.available === false ? 'Vehicles unavailable here' : 'Rides nearby')
const subtitle = computed(() => vehicle.value?.trip?.label || vehicle.value?.phase || (props.view.load === 'loading' ? 'Checking rides…' : data.value?.available === false ? 'Walking and Travel are available' : 'Choose a ride'))
const label = (item: VehicleSnapshot): string => `${item.source === 'borrowed' ? 'Borrowed ' : ''}${VEHICLE_SPECS[item.kind].label}`
const name = (id: MemberId): string => props.members.find(member => member.id === id)?.displayName ?? 'Player in this vehicle'
const seatLabel = (seat: VehicleSeat): string => seat.id === 'driver' ? 'Driver seat' : `Passenger ${seat.id.slice('passenger-'.length)}`
const occupantLabel = (seat: VehicleSeat): string => seat.reservedByService ? 'Ride service' : seat.occupant?.kind === 'hidden' ? 'Occupied' : seat.occupant?.kind === 'member' ? seat.occupant.memberId === props.memberId ? 'You' : name(seat.occupant.memberId) : 'Free'
const entries = (seatId: SeatId): readonly string[] => vehicle.value ? VEHICLE_SPECS[vehicle.value.kind].seats.find(seat => seat.id === seatId)?.entries ?? [] : []
function toggle(): void { expanded.value = !expanded.value; emit('expanded', expanded.value) }
function command(next: TransportCommand): void { if (!busy.value || next.kind === 'retry') emit('command', next) }
function board(seat: VehicleSeat): void {
  const entryId = entryIds.value[seat.id] || entries(seat.id)[0]
  if (!entryId || !vehicle.value) return
  const invitation = data.value?.invites.find(invite => invite.vehicleId === vehicle.value?.id && invite.recipient === props.memberId && invite.status === 'accepted' && invite.role === seat.role)
  command({ kind: 'board', seatId: seat.id, entryId, ...(invitation ? { inviteId: invitation.id } : {}) })
}
function borrow(): void { if (!data.value?.available) return; const depotId = data.value.depots.find(depot => depot.id === chosenDepot.value)?.id || data.value.depots[0]?.id; if (depotId) command({ kind: 'loan', depotId, vehicleKind: kind.value }) }
/** The door the host says is nearest the member when it is one of this vehicle's; otherwise the first, as before. */
function bookingDefault(item: VehicleSnapshot): string | undefined {
  const entries = VEHICLE_SPECS[item.kind].entries
  return entries.find(entry => entry.id === props.preferredEntry)?.id ?? entries[0]?.id
}
function confirm(): void {
  const quote = props.view.quote, quotedVehicle = data.value?.vehicles.find(item => item.id === quote?.vehicleId)
  const entryId = bookingEntry.value || (quotedVehicle ? bookingDefault(quotedVehicle) : null)
  if (quote && entryId) command({ kind: 'confirm', quoteId: quote.id, entryId })
}
</script>

<template>
  <section class="transport-panel" :class="{ expanded }" aria-label="Transport">
    <button class="transport-toggle" type="button" :aria-expanded="expanded" aria-controls="transport-content" @click="toggle">
      <svg class="transport-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M5 10 7 5h10l2 5M4 10h16v8H4zM7 14h2m6 0h2M6 18v2m12-2v2" /></svg>
      <span class="transport-title"><strong>{{ title }}</strong><small>{{ subtitle }}</small></span>
      <svg class="transport-chevron" :class="{ open: expanded }" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div v-if="expanded" id="transport-content" class="transport-content" @keydown.esc.stop="toggle">
      <p v-if="!view.connected" role="status">Reconnecting. Your seat and fare will be checked.</p>
      <p v-if="view.problem" class="problem" role="alert">{{ view.problem }}</p>
      <p v-if="capabilityReason" role="status">{{ capabilityReason }}</p>
      <p v-if="view.pending" role="status">{{ view.pending }}</p>
      <button v-if="view.retryLabel" class="btn sm" type="button" :disabled="!view.connected || !!view.pending" @click="command({ kind: 'retry' })">{{ view.retryLabel }}</button>
      <p v-if="view.load === 'loading'" role="status">Checking nearby vehicles…</p>
      <button v-else-if="view.load === 'error'" class="btn sm" type="button" :disabled="busy" @click="emit('refresh')">Try again</button>
      <section v-if="recoveredRide && view.paidRide" class="transport-section" aria-label="Your paid ride"><h2>Your paid ride</h2><p>Your seat may have been released while disconnected. The service will check whether this ride is still active.</p><p>Stopping before departure returns the fare once. Stopping after departure returns no fare.</p><button class="btn sm" type="button" :disabled="busy" @click="command({ kind: 'cancel-trip' })">Stop ride</button><button class="btn sm" type="button" :disabled="busy" @click="command({ kind: 'inspect', vehicleId: view.paidRide.vehicleId })">Show ride if nearby</button></section>
      <template v-if="data">
        <section v-if="data.available && self?.offer" class="transport-section" aria-label="Driver offer"><h2>Take the wheel?</h2><p>The driver offered you control while this vehicle is stopped.</p><button type="button" class="btn primary" :disabled="busy || !seated" @click="command({ kind: 'accept-driver', offer: self.offer })">Accept driver seat</button></section>
        <ul v-if="data.available && receivedInvites.length" class="transport-nearby" aria-label="Ride invitations"><li v-for="invite in receivedInvites" :key="invite.id"><p>Invitation to ride as {{ invite.role }}</p><div class="transport-actions"><button class="btn sm" type="button" :disabled="busy" @click="command({ kind: 'respond-invite', inviteId: invite.id, accept: true })">Accept invitation</button><button class="btn sm" type="button" :disabled="busy" @click="command({ kind: 'respond-invite', inviteId: invite.id, accept: false })">Decline</button></div><small>Accepting lets you board when you reach the vehicle.</small></li></ul>
        <template v-if="vehicle">
          <div class="transport-vehicle"><div><h2>{{ label(vehicle) }}</h2><p>{{ role ? `You are the ${role}` : `${vehicle.seats.filter(seat => !seat.occupant && !seat.reservedByService).length} seats free` }}</p></div><button class="btn sm" type="button" :disabled="busy" @click="emit('refresh')">Nearby</button></div>
          <ul class="transport-seats" aria-label="Vehicle seats"><li v-for="seat in vehicle.seats" :key="seat.id"><span>{{ seatLabel(seat) }}</span><strong>{{ occupantLabel(seat) }}</strong><template v-if="!seated && !seat.occupant && !seat.reservedByService"><label class="transport-entry">Boarding door<select v-model="entryIds[seat.id]" class="input" :disabled="busy"><option :value="undefined">{{ entries(seat.id)[0]?.replaceAll('-', ' ') }}</option><option v-for="entry in entries(seat.id).slice(1)" :key="entry" :value="entry">{{ entry.replaceAll('-', ' ') }}</option></select></label><button class="btn sm" type="button" :disabled="busy || !!capabilityReason || !view.actions?.board" @click="board(seat)">{{ seat.role === 'driver' ? 'Drive' : 'Enter' }}<span class="sr-only"> {{ seatLabel(seat) }}</span></button></template></li></ul>
          <p v-if="vehicle.trip">{{ vehicle.trip.label }} · {{ vehicle.trip.state }}</p>
          <div class="transport-actions"><button class="btn sm" type="button" @click="emit('map')">Open map</button><button v-if="data.available && ((!seated && vehicle.source === 'service') || role === 'driver')" class="btn sm" type="button" :disabled="busy || !!capabilityReason" @click="emit('destination', vehicle.id)">Choose destination</button><button v-if="seated" class="btn sm" type="button" :disabled="busy" @click="command({ kind: 'exit' })">Exit vehicle (E)</button><button v-if="owned && !seated" class="btn sm" type="button" :disabled="busy || !!capabilityReason" @click="command({ kind: 'return' })">Return vehicle</button></div>
          <div v-if="payer && vehicle.trip?.mode === 'paid-service'" class="transport-actions"><button v-if="data.available && vehicle.trip.state === 'boarding'" class="btn primary" type="button" :disabled="busy || !!capabilityReason" @click="command({ kind: 'depart' })">Start ride</button><button class="btn sm" type="button" :disabled="busy" @click="command({ kind: 'cancel-trip' })">{{ vehicle.trip.state === 'boarding' ? 'Cancel and request refund' : 'Stop ride' }}</button></div>
          <DriverControls v-if="data.available && showDriverControls && role === 'driver'" :enabled="canDrive && !busy" @input="emit('drive', $event)" />
          <p v-if="role === 'passenger'">The driver controls the vehicle. You can explore the map while you ride.</p>
          <details v-if="data.available && owned"><summary>Who can board</summary><div class="transport-actions"><button v-for="access in VEHICLE_ACCESS" :key="access" class="btn sm" type="button" :aria-pressed="vehicle.access === access" :disabled="busy || !!capabilityReason" @click="command({ kind: 'access', access })">{{ access === 'owner' ? 'Only me' : access === 'friends' ? 'Friends and invitees' : 'Invitees' }}</button></div></details>
          <details v-if="data.available && (owned || payer)"><summary>Invite a friend or player here</summary><ul class="transport-nearby"><li v-for="peer in invitePeers" :key="peer.id"><span>{{ peer.displayName }}</span><button class="btn sm" type="button" :disabled="busy || !!capabilityReason" @click="command({ kind: 'invite', to: peer.id, role: 'passenger' })">Invite to ride</button></li></ul><p v-if="!invitePeers.length">No other players are in this room.</p></details>
          <details v-if="data.available && role === 'driver' && view.actions?.handoff"><summary>Offer the driver seat</summary><ul class="transport-nearby"><li v-for="id in peerSeats" :key="id"><span>{{ name(id) }}</span><button class="btn sm" type="button" :disabled="busy || !!capabilityReason" @click="command({ kind: 'offer-driver', to: id })">Offer control</button></li></ul><p v-if="!peerSeats.length">A passenger needs to board before you can hand over.</p></details>
        </template>
        <ul v-else-if="data.available && data.vehicles.length" class="transport-nearby" aria-label="Nearby vehicles"><li v-for="nearby in data.vehicles" :key="nearby.id"><button type="button" :disabled="busy" @click="command({ kind: 'inspect', vehicleId: nearby.id })"><span><strong>{{ label(nearby) }}</strong><small>{{ nearby.phase }} · {{ nearby.seats.filter(seat => !seat.occupant && !seat.reservedByService).length }} seats free</small></span></button></li></ul>
        <p v-else-if="data.available">No usable vehicles nearby. {{ data.depots.length ? 'Walk toward a listed vehicle depot or explore the map.' : 'Explore the map.' }}</p>
        <section v-if="data.available && !seated && data.depots.length" class="transport-section" aria-label="Borrow a vehicle"><h2>Borrow a vehicle</h2><label>Vehicle<select v-model="kind" class="input" :disabled="busy"><option v-for="choice in VEHICLE_KINDS" :key="choice" :value="choice">{{ VEHICLE_SPECS[choice].label }}</option></select></label><label v-if="data.depots.length > 1">Depot<select v-model="chosenDepot" class="input" :disabled="busy"><option value="">First listed depot</option><option v-for="(depot, index) in data.depots" :key="depot.id" :value="depot.id">Depot {{ index + 1 }}</option></select></label><p>Borrow when you are near the depot. Shared passengers ride free.</p><button type="button" class="btn primary" :disabled="busy || !!capabilityReason" @click="borrow">Borrow {{ VEHICLE_SPECS[kind].label }}</button></section>
        <section v-if="data.available && view.quote" class="transport-quote" aria-label="Confirm ride"><h2>Ride to {{ view.quote.label }}</h2><dl><div><dt>Whole vehicle fare</dt><dd>{{ view.quote.fare }} coins</dd></div><div><dt>Your balance</dt><dd>{{ view.quote.balance }} coins</dd></div><div><dt>Journey estimate</dt><dd>{{ view.quote.estimatedSeconds }} seconds</dd></div></dl><p>You pay once. Invited passengers do not pay again.</p><p>Quote expires {{ new Date(view.quote.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }}.</p><p v-if="!view.quote.allowed" class="problem">{{ view.quote.reason }}</p><label v-if="vehicle">Boarding door<select v-model="bookingEntry" class="input" :disabled="busy"><option value="">{{ bookingDefault(vehicle)?.replaceAll('-', ' ') }}</option><option v-for="entry in VEHICLE_SPECS[vehicle.kind].entries.slice(1)" :key="entry.id" :value="entry.id">{{ entry.id.replaceAll('-', ' ') }}</option></select></label><div class="transport-actions"><button class="btn primary" type="button" :disabled="busy || !!capabilityReason || !view.quote.allowed || !!view.paidRide" @click="confirm">Confirm {{ view.quote.fare }} coin ride</button><button class="btn sm" type="button" :disabled="busy" @click="command({ kind: 'dismiss-quote' })">Cancel</button></div></section>
      </template>
    </div>
  </section>
</template>

<style scoped>
.transport-panel { width: min(360px, 100%); min-width: 0; pointer-events: auto; color: var(--ink); background: var(--surface); border: 1px solid var(--line-strong); border-radius: var(--radius); box-shadow: var(--shadow); }
.transport-toggle { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 52px; padding: 10px 12px; border: 0; border-radius: inherit; background: transparent; text-align: left; }
.transport-toggle:hover { background: var(--surface-2); }.transport-icon { flex: none; width: 24px; height: 24px; color: var(--accent-text); }.transport-chevron { flex: none; width: 20px; height: 20px; color: var(--ink-2); }.transport-chevron.open { transform: rotate(180deg); }
.transport-title { display: grid; gap: 2px; flex: 1; min-width: 0; }.transport-title strong { font-size: .86rem; overflow-wrap: anywhere; }.transport-title small, .transport-content p, .transport-content small { font-size: .76rem; color: var(--ink-2); }
.transport-content { display: grid; gap: 12px; padding: 0 12px 12px; max-height: min(440px, 48dvh); overflow-y: auto; overscroll-behavior: contain; scrollbar-color: var(--line-strong) var(--surface); }.transport-content h2 { font-size: .98rem; overflow-wrap: anywhere; }.transport-content label { display: grid; gap: 5px; font-size: .76rem; }.transport-content select { min-height: 44px; max-width: 100%; }
.transport-vehicle { display: flex; justify-content: space-between; align-items: start; gap: 8px; padding-top: 10px; border-top: 1px solid var(--line); }.transport-seats, .transport-nearby { list-style: none; padding: 0; margin: 0; }.transport-seats li { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 5px 8px; min-height: 44px; padding: 5px 0; border-bottom: 1px solid var(--line); font-size: .78rem; }.transport-seats strong { max-width: 140px; overflow-wrap: anywhere; }.transport-entry { min-width: 0; }
.transport-nearby li { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding-block: 8px; }.transport-nearby li + li { border-top: 1px solid var(--line); }.transport-nearby li > button:only-child { display: grid; gap: 4px; width: 100%; min-height: 52px; padding: 9px 0; border: 0; text-align: left; background: transparent; }.transport-nearby strong { font-size: .83rem; overflow-wrap: anywhere; }.transport-nearby small { display: block; }.transport-actions { display: flex; flex-wrap: wrap; gap: 7px; }.transport-panel .btn { min-height: 44px; }.transport-content .problem { color: var(--danger); line-height: 1.5; }.transport-section, .transport-quote { display: grid; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line-strong); }.transport-quote dl { margin: 0; display: grid; gap: 5px; font-size: .78rem; }.transport-quote dl > div { display: flex; justify-content: space-between; gap: 12px; }.transport-quote dd { margin: 0; text-align: right; font-weight: 650; font-variant-numeric: tabular-nums; }.transport-content details > summary { cursor: pointer; min-height: 44px; display: flex; align-items: center; font-size: .8rem; }.transport-panel ::selection { color: var(--accent-ink); background: var(--accent-soft); }
@media (max-width: 720px) { .transport-panel { width: 100%; }.transport-content { max-height: 32dvh; } }
</style>
