// A product while its seller is editing it: form-shaped drafts, the sentences that say what is still
// wrong, and the exact input the service takes. The limits here mirror the service's own.
import type { ProductId, VariantId } from '../../shared/ids.ts'
import type { Availability, Product, ProductCategory, Variant } from '../../shared/market.ts'
import type { Ops } from '../../shared/protocol.ts'
import { amountFromMinor, isCurrency, minorFromAmount } from './labels.ts'

export const MAX_VARIANTS = 8
export type ProductInput = Ops['market.productSave']['in']

export interface VariantDraft {
  /** Stable key for the list while editing; never sent. */
  key: number
  /** Present for an option that already exists, so quotes and placed pieces keep pointing at it. */
  id?: VariantId
  name: string
  material: string
  tints: Record<string, string>
  width: number | ''
  depth: number | ''
  height: number | ''
  quoteOnly: boolean
  amount: number | ''
  currency: string
  availability: Availability
  leadTime: number | ''
}

export interface ProductDraft {
  name: string
  description: string
  category: ProductCategory
  model: string
  variants: VariantDraft[]
  sharingAllowed: boolean
  commissionNote: string
  listed: boolean
}

let nextKey = 1

export const blankVariant = (currency: string): VariantDraft => ({
  key: nextKey++, name: '', material: '', tints: {}, width: '', depth: '', height: '', quoteOnly: false, amount: '', currency,
  availability: 'made-to-order', leadTime: '',
})

export const variantDraft = (variant: Variant): VariantDraft => ({
  key: nextKey++, id: variant.id, name: variant.name, material: variant.material, tints: { ...variant.tints },
  width: variant.dimensionsCm.width, depth: variant.dimensionsCm.depth, height: variant.dimensionsCm.height,
  quoteOnly: variant.priceMinor === null, amount: variant.priceMinor === null ? '' : amountFromMinor(variant.priceMinor), currency: variant.currency,
  availability: variant.availability, leadTime: variant.leadTimeDays ?? '',
})

/** A new option that starts as a copy of another. It gets its own id when saved. */
export function copyVariant(source: VariantDraft): VariantDraft {
  const { id: _existing, ...rest } = source
  return { ...rest, key: nextKey++, name: source.name ? `${source.name} copy`.slice(0, 60) : '', tints: { ...source.tints } }
}

export const productDraft = (product: Product | null, currency: string): ProductDraft => (product
  ? {
      name: product.name, description: product.description, category: product.category, model: product.model, variants: product.variants.map(variantDraft),
      sharingAllowed: product.sharing.allowed, commissionNote: product.sharing.commissionNote ?? '', listed: product.status === 'listed',
    }
  : { name: '', description: '', category: 'seating', model: '', variants: [blankVariant(currency)], sharingAllowed: false, commissionNote: '', listed: true })

const sized = (value: number | ''): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 1 && value <= 1000

/** What still stops one option from being saved, as plain sentences. */
export function variantProblems(draft: VariantDraft, index: number): string[] {
  const option = `Option ${index + 1}`
  const problems: string[] = []
  if (!draft.name.trim()) problems.push(`${option} needs a name, for example “Cream weave”.`)
  if (!draft.material.trim()) problems.push(`${option} needs a material, for example “oak and linen”.`)
  if (!sized(draft.width) || !sized(draft.depth) || !sized(draft.height)) problems.push(`${option}: width, depth and height are each between 1 and 1000 cm.`)
  if (!draft.quoteOnly && minorFromAmount(draft.amount) === null) problems.push(`${option}: enter the price as a whole amount, or switch it to quote only.`)
  if (!isCurrency(draft.currency)) problems.push(`${option}: the currency is three capital letters, for example NGN.`)
  if (draft.leadTime !== '' && (!Number.isInteger(draft.leadTime) || draft.leadTime < 0 || draft.leadTime > 365)) problems.push(`${option}: lead time is a whole number of days up to 365, or leave it empty.`)
  return problems
}

export function productProblems(draft: ProductDraft): string[] {
  const problems: string[] = []
  if (draft.name.trim().length < 2) problems.push('Give the product a name of at least 2 characters.')
  if (!draft.model) problems.push('Choose the 3D piece that shows this product.')
  if (!draft.variants.length) problems.push('Add at least one option.')
  draft.variants.forEach((variant, index) => problems.push(...variantProblems(variant, index)))
  return problems
}

/** The service input for a draft that has no problems. Colours for materials the piece does not have are left out. */
export function productInput(productId: ProductId | null, draft: ProductDraft, materials: string[]): ProductInput {
  return {
    productId, name: draft.name.trim(), description: draft.description.trim(), category: draft.category, model: draft.model,
    variants: draft.variants.map(variant => ({
      ...(variant.id ? { id: variant.id } : {}),
      name: variant.name.trim(), material: variant.material.trim(),
      tints: Object.fromEntries(Object.entries(variant.tints).filter(([material]) => materials.includes(material))),
      dimensionsCm: { width: Number(variant.width), depth: Number(variant.depth), height: Number(variant.height) },
      priceMinor: variant.quoteOnly ? null : minorFromAmount(variant.amount),
      currency: variant.currency, availability: variant.availability, leadTimeDays: variant.leadTime === '' ? null : variant.leadTime,
    })),
    sharingAllowed: draft.sharingAllowed, commissionNote: draft.sharingAllowed && draft.commissionNote.trim() ? draft.commissionNote.trim() : null, listed: draft.listed,
  }
}

/** A saved product resent unchanged except for whether it is listed. */
export const relisted = (product: Product, listed: boolean): ProductInput => ({
  productId: product.id, name: product.name, description: product.description, category: product.category, model: product.model,
  variants: product.variants.map(variant => ({ ...variant, tints: { ...variant.tints }, dimensionsCm: { ...variant.dimensionsCm } })),
  sharingAllowed: product.sharing.allowed, commissionNote: product.sharing.commissionNote, listed,
})
