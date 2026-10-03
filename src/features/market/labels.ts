// Words and small formatters shared by the Market and Jobs windows, so a status reads the same everywhere.
import type {
  ApplicationStatus, Availability, ListingKind, ListingStatus, Product, ProductCategory, QuoteStatus, Variant,
} from '../../shared/market.ts'
import { money } from '../../ui/format.ts'

export const SAMPLE_TITLE = 'Sample catalog entry — not a real merchant'

export const CATEGORY: Record<ProductCategory, { label: string; icon: string }> = {
  seating: { label: 'Seating', icon: '🛋' }, tables: { label: 'Tables', icon: '🍽' }, beds: { label: 'Beds', icon: '🛏' },
  storage: { label: 'Storage', icon: '🗄' }, lighting: { label: 'Lighting', icon: '💡' }, decor: { label: 'Decor', icon: '🪴' },
  kitchen: { label: 'Kitchen', icon: '🍳' },
}

export const AVAILABILITY: Record<Availability, { label: string; tone: string }> = {
  'in-stock': { label: 'In stock', tone: 'leaf' },
  'made-to-order': { label: 'Made to order', tone: 'sky' },
  unavailable: { label: 'Unavailable right now', tone: '' },
}

/** The best availability across a product's options, for a card. */
export function availabilityOf(product: Pick<Product, 'variants'>): Availability {
  if (product.variants.some(variant => variant.availability === 'in-stock')) return 'in-stock'
  if (product.variants.some(variant => variant.availability === 'made-to-order')) return 'made-to-order'
  return 'unavailable'
}

/** The seller's indicative price, or the words for "ask". Display only: nothing is charged here. */
export const priceText = (variant: Pick<Variant, 'priceMinor' | 'currency'>): string =>
  variant.priceMinor === null ? 'Quote only' : money(variant.priceMinor, variant.currency)

/** "From ₦185,000" across the priced options, or "Quote only" when none carries a price. */
export function fromPrice(product: Pick<Product, 'variants'>): string {
  const priced = product.variants.filter((variant): variant is Variant & { priceMinor: number } => variant.priceMinor !== null)
  const first = priced[0]
  if (!first) return 'Quote only'
  // Prices in different currencies cannot be ranked, so the first one stands.
  const comparable = priced.every(variant => variant.currency === first.currency)
  const lowest = comparable ? priced.reduce((low, variant) => (variant.priceMinor < low.priceMinor ? variant : low), first) : first
  const single = priced.length === product.variants.length && priced.every(variant => variant.priceMinor === lowest.priceMinor && variant.currency === lowest.currency)
  return single ? money(lowest.priceMinor, lowest.currency) : `From ${money(lowest.priceMinor, lowest.currency)}`
}

const trim = (value: number): string => (Number.isInteger(value) ? String(value) : value.toFixed(1))

/** Width × depth × height in centimetres, with inches alongside for members who chose imperial units. */
export function dimensionsText(size: Variant['dimensionsCm'], imperial: boolean): string {
  const metric = `${trim(size.width)} × ${trim(size.depth)} × ${trim(size.height)} cm`
  if (!imperial) return metric
  const inches = (cm: number): string => (cm / 2.54).toFixed(1)
  return `${metric} (${inches(size.width)} × ${inches(size.depth)} × ${inches(size.height)} in)`
}

export function leadTimeText(days: number | null): string {
  if (days === null) return 'Ask the maker'
  if (days === 0) return 'Ready now'
  return days === 1 ? 'About 1 day' : `About ${days} days`
}

/** A seller's promised lead time as a sentence start: "Ready in about 18 days". */
export function readyIn(days: number): string {
  if (days === 0) return 'Ready now'
  return days === 1 ? 'Ready in about 1 day' : `Ready in about ${days} days`
}

// ── Furniture models and their materials, in words ──

const MATERIAL: Record<string, string> = {
  wood: 'Wood', woodDark: 'Dark wood', carpet: 'Fabric', carpetWhite: 'Light fabric', carpetDarker: 'Fabric trim', carpetBlue: 'Fabric',
  metal: 'Metal', metalDark: 'Dark metal', metalLight: 'Light metal', metalMedium: 'Mid metal', glass: 'Glass', lamp: 'Shade',
  plant: 'Leaves', fur: 'Fur', _defaultMat: 'Other parts',
}

const words = (name: string): string => {
  const spaced = name.replace(/^_+/, '').replace(/([a-z])([A-Z0-9])/g, '$1 $2').toLowerCase()
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** "woodDark" → "Dark wood". Unknown names fall back to their own words. */
export const materialLabel = (name: string): string => MATERIAL[name] ?? words(name)
/** "loungeSofaLong" → "Lounge sofa long". */
export const modelLabel = (name: string): string => words(name)

/** The colours a variant puts on the model, in the seller's order. */
export const swatchesOf = (variant: Pick<Variant, 'tints'>): string[] => Object.values(variant.tints)

// ── Money typed by a seller ──
// Amounts are typed whole and stored ×100, which is what `money()` divides by when it shows them.

/** Whole amount → minor units, or null when the text is not a whole, non-negative amount. */
export function minorFromAmount(value: number | string): number | null {
  const amount = typeof value === 'number' ? value : value.trim() === '' ? NaN : Number(value)
  if (!Number.isFinite(amount) || amount < 0 || !Number.isInteger(amount) || amount * 100 > 1e12) return null
  return amount * 100
}
export const amountFromMinor = (minor: number): number => Math.round(minor / 100)
export const isCurrency = (value: string): boolean => /^[A-Z]{3}$/.test(value)

// ── Quotes ──

export type QuoteRole = 'buyer' | 'seller'

/** A quote's status in words, from the side of whoever is reading it. */
export function quoteStatus(status: QuoteStatus, role: QuoteRole): { label: string; tone: string } {
  switch (status) {
    case 'requested': return role === 'buyer' ? { label: 'Waiting for the seller', tone: 'amber' } : { label: 'Needs your offer', tone: 'coral' }
    case 'quoted': return role === 'buyer' ? { label: 'Offer waiting for you', tone: 'coral' } : { label: 'Offer sent', tone: 'sky' }
    case 'accepted': return { label: 'Accepted', tone: 'leaf' }
    case 'declined': return { label: 'Declined', tone: '' }
    case 'withdrawn': return { label: 'Withdrawn', tone: '' }
    case 'expired': return { label: 'Expired', tone: '' }
  }
}
export const quoteIsOpen = (status: QuoteStatus): boolean => status === 'requested' || status === 'quoted'
/** True when the reader is the one who has to act next. */
export const quoteNeedsMe = (status: QuoteStatus, role: QuoteRole): boolean => (role === 'buyer' ? status === 'quoted' : status === 'requested')

// ── Jobs and tasks ──

export const KIND: Record<ListingKind, { label: string; icon: string; tone: string }> = {
  job: { label: 'Job', icon: '💼', tone: '' },
  task: { label: 'Task', icon: '🧰', tone: 'sky' },
}

export const LISTING_STATUS: Record<ListingStatus, { label: string; tone: string }> = {
  open: { label: 'Open', tone: 'leaf' },
  filled: { label: 'Filled', tone: 'sky' },
  closed: { label: 'Closed', tone: '' },
}

/** An application's status in words, from the side of whoever is reading it. */
export function applicationStatus(status: ApplicationStatus, role: 'applicant' | 'owner'): { label: string; tone: string } {
  switch (status) {
    case 'submitted': return role === 'applicant' ? { label: 'Waiting for a reply', tone: 'amber' } : { label: 'New', tone: 'coral' }
    case 'shortlisted': return { label: 'Shortlisted', tone: 'sky' }
    case 'accepted': return { label: 'Accepted', tone: 'leaf' }
    case 'declined': return { label: 'Declined', tone: '' }
    case 'withdrawn': return { label: 'Withdrawn', tone: '' }
  }
}

/** Where a listing is, as its owner wrote it. Areas are self-reported and coarse. */
export function placeText(listing: { areaLabel: string; remote: boolean }): string {
  if (listing.remote) return listing.areaLabel ? `Remote · ${listing.areaLabel}` : 'Remote'
  return listing.areaLabel || 'Area not given'
}
