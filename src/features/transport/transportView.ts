import type { MemberId, VehicleId, VehicleInviteId, VehicleQuoteId } from '../../shared/ids.ts'
import type { DriverOffer, VehicleAccess, VehicleControls, VehicleKind } from '../../shared/vehicles.ts'
import type { createVehicleClient } from '../../state/vehicles.ts'
export type DriverIntent = VehicleControls
export { NEUTRAL_CONTROLS as STOPPED_INPUT } from '../../shared/vehicles.ts'
export type TransportPresentation = ReturnType<typeof createVehicleClient>['state']
export type TransportCommand =
  | { kind: 'inspect'; vehicleId: VehicleId }
  | { kind: 'loan'; depotId: string; vehicleKind: VehicleKind }
  | { kind: 'return' }
  | { kind: 'enter'; inviteId?: VehicleInviteId }
  | { kind: 'cycle-seat' }
  | { kind: 'exit' }
  | { kind: 'access'; access: VehicleAccess }
  | { kind: 'invite'; to: MemberId; role: 'driver' | 'passenger' }
  | { kind: 'respond-invite'; inviteId: VehicleInviteId; accept: boolean }
  | { kind: 'offer-driver'; to: MemberId }
  | { kind: 'accept-driver'; offer: DriverOffer }
  | { kind: 'confirm'; quoteId: VehicleQuoteId; entryId: string }
  | { kind: 'dismiss-quote' }
  | { kind: 'depart' | 'cancel-trip' | 'retry' }
