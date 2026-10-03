// Branded identifiers. A MemberId cannot be passed where a RoomKey is expected.
declare const kind: unique symbol
export type Id<K extends string> = string & { readonly [kind]: K }

export type MemberId = Id<'member'>
/** Coarse physical cell (web-mercator zoom 12, roughly 6–10 km across). */
export type AreaId = Id<'area'>
/** One walkable scene (zoom 14 tile, roughly 1.5–2.4 km across). */
export type DistrictId = Id<'district'>
export type PlaceId = Id<'place'>
export type HomeId = Id<'home'>
export type RoomKey = Id<'room'>
export type IntroId = Id<'intro'>
export type CommunityId = Id<'community'>
export type PostId = Id<'post'>
export type MeetupId = Id<'meetup'>
export type ShiftId = Id<'shift'>
export type MatchId = Id<'match'>
export type NotificationId = Id<'notification'>
export type DeliveryId = Id<'delivery'>
export type SellerId = Id<'seller'>
export type ProductId = Id<'product'>
export type VariantId = Id<'variant'>
export type QuoteId = Id<'quote'>
export type ListingId = Id<'listing'>
export type ApplicationId = Id<'application'>
export type TaskId = Id<'task'>
export type ReportId = Id<'report'>
/** One vehicle the service runs: `vh_…`. */
export type VehicleId = Id<'vehicle'>
export type VehicleQuoteId = Id<'vehicle-quote'>
export type VehicleInviteId = Id<'vehicle-invite'>

/** ISO-8601 instant. */
export type Iso = string & { readonly [kind]: 'iso' }

const ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789'

export function randomToken(length = 12): string {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  let out = ''
  for (const byte of bytes) out += ALPHABET[byte % ALPHABET.length]
  return out
}

export const newId = <T extends Id<string>>(prefix: string): T => `${prefix}_${randomToken(12)}` as T
export const iso = (ms: number): Iso => new Date(ms).toISOString() as Iso
export const ms = (value: Iso | string): number => Date.parse(value)
