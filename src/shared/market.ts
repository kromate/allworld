// Real-product catalog, quotes, real job listings and member tasks.
//
// Boundaries kept explicit in the types:
//   • placing a furnishing in a virtual home is not a purchase and confers no ownership;
//   • no money moves here — `payment` is always 'not-collected';
//   • fulfilment details exist only on an accepted quote and are visible to buyer and seller only;
//   • job listings and applications are real-world records, separate from simulated careers.
import type { ApplicationId, Iso, ListingId, MemberId, ProductId, QuoteId, SellerId, VariantId } from './ids.ts'
import type { PublicMember } from './model.ts'

export type SellerStatus = 'pending' | 'approved' | 'suspended'

export interface Seller {
  id: SellerId
  ownerId: MemberId
  name: string
  about: string
  areaLabel: string
  status: SellerStatus
  /** True for the bundled sample catalog. Samples are not real merchants. */
  sample: boolean
  createdAt: Iso
}

export type Availability = 'in-stock' | 'made-to-order' | 'unavailable'

export interface Variant {
  id: VariantId
  name: string
  material: string
  /** Furniture material name → hex colour, applied to the 3D model for this variant. */
  tints: Record<string, string>
  dimensionsCm: { width: number; depth: number; height: number }
  /** Seller's indicative price in minor units, or null for "quote only". */
  priceMinor: number | null
  currency: string
  availability: Availability
  leadTimeDays: number | null
}

export const PRODUCT_CATEGORIES = ['seating', 'tables', 'beds', 'storage', 'lighting', 'decor', 'kitchen'] as const
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number]

export interface Product {
  id: ProductId
  seller: Seller
  name: string
  description: string
  category: ProductCategory
  /** Furniture pack model used to show the piece in a room. */
  model: string
  variants: Variant[]
  /** Whether members may share this listing, and the seller's own commission note if any. */
  sharing: { allowed: boolean; commissionNote: string | null }
  status: 'draft' | 'listed' | 'unlisted'
  saved: boolean
  updatedAt: Iso
}

export type QuoteStatus = 'requested' | 'quoted' | 'accepted' | 'declined' | 'withdrawn' | 'expired'

export interface QuoteOffer { priceMinor: number; currency: string; leadTimeDays: number; note: string; offeredAt: Iso }

/** Private delivery details. Collected only after the buyer accepts an offer. */
export interface Fulfilment { recipient: string; phone: string; address: string; notes: string }

export interface Quote {
  id: QuoteId
  product: { id: ProductId; name: string; model: string }
  /** Variant as it was when the quote was requested. Later catalog edits do not change it. */
  spec: Variant
  quantity: number
  note: string
  buyer: PublicMember
  seller: Seller
  status: QuoteStatus
  offer: QuoteOffer | null
  /** Present only for the buyer and the seller, and only after acceptance. */
  fulfilment: Fulfilment | null
  payment: 'not-collected'
  referredBy: PublicMember | null
  createdAt: Iso
  updatedAt: Iso
  expiresAt: Iso
  timeline: { at: Iso; text: string }[]
}

export const QUOTE_TTL_DAYS = 14

// ── Real jobs and member tasks ────────────────────────────────────────────────────────────────

export type ListingKind = 'job' | 'task'
export type ListingStatus = 'open' | 'filled' | 'closed'

export interface Listing {
  id: ListingId
  kind: ListingKind
  owner: PublicMember
  title: string
  organisation: string
  description: string
  areaLabel: string
  remote: boolean
  /** Free text from the owner. This App neither pays nor escrows. */
  compensation: string
  status: ListingStatus
  createdAt: Iso
  /** Owner only. */
  applicationCount: number | null
  /** The viewer's own application status, if any. */
  myApplication: ApplicationStatus | null
}

export type ApplicationStatus = 'submitted' | 'shortlisted' | 'accepted' | 'declined' | 'withdrawn'

export interface Application {
  id: ApplicationId
  listing: { id: ListingId; title: string; kind: ListingKind; organisation: string }
  applicant: PublicMember
  message: string
  /** Contact the applicant chose to give the listing owner. Visible to those two only. */
  contact: string
  status: ApplicationStatus
  createdAt: Iso
  decidedAt: Iso | null
}
