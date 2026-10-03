// Real-product catalog: sellers, products with honest variants, and quote requests.
//
// Boundaries: placing a furnishing in a virtual home is not a purchase (homes only carry ids);
// no money moves here — a quote is a conversation and `payment` stays 'not-collected'; the
// delivery details exist only on an accepted quote and only the buyer and the seller read them.
import furnitureIndex from '../src/assets/furniture.index.json' with { type: 'json' }
import type { Iso, MemberId, ProductId, QuoteId, SellerId, VariantId } from '../src/shared/ids.ts'
import { iso, ms, newId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import { PRODUCT_CATEGORIES, QUOTE_TTL_DAYS } from '../src/shared/market.ts'
import type { Availability, Fulfilment, Product, ProductCategory, Quote, QuoteStatus, Seller, Variant } from '../src/shared/market.ts'
import type { VariantInput } from '../src/shared/protocol.ts'
import type { World } from './kernel.ts'
import { requireFound } from './kernel.ts'
import { isBlockedEitherWay, record, tryPublicMember } from './members.ts'
import { emit, settle } from './notify.ts'
import { bool, empty, hexColor, id, list, num, obj, oneOf, optId, optNum, optStr, str } from './parse.ts'

interface ProductRecord {
  id: ProductId; sellerId: SellerId; name: string; description: string; category: ProductCategory; model: string
  variants: Variant[]; sharing: Product['sharing']; status: Product['status']; createdAt: Iso; updatedAt: Iso
}
interface QuoteRecord {
  id: QuoteId; productId: ProductId; productName: string; model: string; spec: Variant; quantity: number; note: string
  buyer: MemberId; sellerId: SellerId; status: QuoteStatus; offer: Quote['offer']; fulfilment: Fulfilment | null
  referredBy: MemberId | null; createdAt: Iso; updatedAt: Iso; expiresAt: Iso; timeline: Quote['timeline']
}
interface MarketState {
  sellers: Record<string, Seller>
  products: Record<string, ProductRecord>
  quotes: Record<string, QuoteRecord>
  /** Member → saved product ids. Private to the member. */
  saved: Record<string, string[]>
}

const DAY = 86_400_000
const SAMPLE_OWNER = 'm_local_reviewer' as MemberId
const state = (world: World): MarketState => world.slice<MarketState>('market', () => ({ sellers: {}, products: {}, quotes: {}, saved: {} }))

// ── The furniture index is the truth about which models and materials exist ──

interface ModelInfo { name: string; materials: string[] }
let models: Map<string, ModelInfo> | null = null
function modelInfo(name: string): ModelInfo {
  models ??= new Map((furnitureIndex as ModelInfo[]).map(entry => [entry.name, entry]))
  const found = models.get(name)
  if (!found) throw new WorldError('invalid', `"${name}" is not a furniture model in this world.`)
  return found
}

const forbidden = (message: string): never => { throw new WorldError('forbidden', message) }

function money(minor: number, currency: string): string {
  try {
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    return `${currency} ${(minor / 10 ** digits).toFixed(digits)}`
  } catch { return `${currency} ${minor}` }
}

// ── Sellers ──

const sellerOf = (world: World, memberId: MemberId): Seller | undefined => Object.values(state(world).sellers).find(seller => seller.ownerId === memberId)
const sellerView = (seller: Seller): Seller => ({ ...seller })

function requireReviewer(world: World, memberId: MemberId): void {
  if (!record(world, memberId).reviewer) forbidden('Only catalog reviewers can do that.')
}

// ── Products ──

const isListed = (world: World, viewer: MemberId, product: ProductRecord): boolean => {
  const seller = state(world).sellers[product.sellerId]
  return Boolean(seller) && product.status === 'listed' && seller!.status === 'approved' && !isBlockedEitherWay(world, viewer, seller!.ownerId)
}
const mayView = (world: World, viewer: MemberId, product: ProductRecord): boolean =>
  state(world).sellers[product.sellerId]?.ownerId === viewer || isListed(world, viewer, product)

function productView(world: World, viewer: MemberId, product: ProductRecord): Product {
  return {
    id: product.id, seller: sellerView(requireFound(state(world).sellers[product.sellerId], 'The seller')), name: product.name,
    description: product.description, category: product.category, model: product.model, variants: structuredClone(product.variants),
    sharing: { ...product.sharing }, status: product.status, saved: Boolean(state(world).saved[viewer]?.includes(product.id)), updatedAt: product.updatedAt,
  }
}

function parseVariant(value: unknown, model: ModelInfo): VariantInput {
  const raw = obj(value, 'variant')
  const tints: Record<string, string> = {}
  for (const [material, colour] of Object.entries(obj(raw.tints ?? {}, 'tints'))) {
    if (!model.materials.includes(material)) throw new WorldError('invalid', `${material} is not a material of ${model.name}. Choose from: ${model.materials.join(', ')}.`)
    tints[material] = hexColor(colour, `tint ${material}`)
  }
  const size = obj(raw.dimensionsCm, 'dimensionsCm')
  const currency = str(raw, 'currency', { min: 3, max: 3 })
  if (!/^[A-Z]{3}$/.test(currency)) throw new WorldError('invalid', 'currency must be 3 uppercase letters, for example NGN')
  const variantId = optId<VariantId>(raw, 'id', 'vr')
  return {
    ...(variantId ? { id: variantId } : {}),
    name: str(raw, 'name', { min: 1, max: 60 }), material: str(raw, 'material', { min: 1, max: 40 }), tints,
    dimensionsCm: {
      width: num(size, 'width', { min: 1, max: 1000 }), depth: num(size, 'depth', { min: 1, max: 1000 }), height: num(size, 'height', { min: 1, max: 1000 }),
    },
    priceMinor: optNum(raw, 'priceMinor', { integer: true, min: 0, max: 1e12 }), currency,
    availability: oneOf(raw, 'availability', ['in-stock', 'made-to-order', 'unavailable'] as const),
    leadTimeDays: optNum(raw, 'leadTimeDays', { integer: true, min: 0, max: 365 }),
  }
}

// ── Sample catalog: obvious samples, so the App is never empty and never pretends to be real ──

type SampleVariant = [name: string, material: string, tints: Record<string, string>, size: [number, number, number], price: number | null, availability: Availability, lead: number | null]
interface SampleProduct { name: string; description: string; category: ProductCategory; model: string; variants: SampleVariant[]; share?: string | true }
interface SampleSeller { name: string; about: string; areaLabel: string; currency: string; products: SampleProduct[] }

const SAMPLES: SampleSeller[] = [
  {
    name: 'Sample maker — Oak & Thread', areaLabel: 'Ibadan, Nigeria', currency: 'NGN',
    about: 'Sample seller. Hand-finished iroko frames and woven upholstery. Not a real merchant.',
    products: [
      {
        name: 'Three-seat weave sofa', category: 'seating', model: 'loungeSofa', share: 'Sample note: referrers get a handwritten thank-you card, agreed directly with the maker.',
        description: 'Sample listing. Iroko frame with a loose woven cover, made in the workshop.',
        variants: [
          ['Cream weave', 'iroko and cotton', { carpet: '#d9cfbd', wood: '#8a5a34' }, [210, 90, 85], 18_500_000, 'made-to-order', 21],
          ['Indigo weave', 'iroko and cotton', { carpet: '#2f3e6b', wood: '#5a3a22' }, [210, 90, 85], 19_500_000, 'made-to-order', 28],
          ['Mustard weave', 'iroko and cotton', { carpet: '#c89b2c', wood: '#8a5a34' }, [210, 90, 85], null, 'made-to-order', null],
        ],
      },
      {
        name: 'Lounge armchair', category: 'seating', model: 'loungeChair', share: true,
        description: 'Sample listing. A low armchair that pairs with the weave sofa.',
        variants: [
          ['Cream weave', 'iroko and cotton', { carpet: '#d9cfbd', wood: '#8a5a34' }, [78, 82, 82], 8_900_000, 'in-stock', 5],
          ['Forest weave', 'iroko and cotton', { carpet: '#3f5a46', wood: '#5a3a22' }, [78, 82, 82], 9_400_000, 'made-to-order', 18],
        ],
      },
      {
        name: 'Cushioned dining chair', category: 'seating', model: 'chairCushion',
        description: 'Sample listing. Stackable dining chair with a removable seat pad.',
        variants: [
          ['Natural / clay pad', 'beech', { wood: '#c9a574', carpet: '#b5654a' }, [45, 50, 90], 2_800_000, 'in-stock', 3],
          ['Dark / sand pad', 'beech', { wood: '#4a3322', carpet: '#d8c8a8' }, [45, 50, 90], 3_100_000, 'made-to-order', 14],
        ],
      },
      {
        name: 'Round-top side table', category: 'tables', model: 'sideTable',
        description: 'Sample listing. Turned-leg side table for the end of a sofa.',
        variants: [
          ['Natural', 'iroko', { wood: '#9a6a3c' }, [50, 50, 55], 3_600_000, 'in-stock', 4],
          ['Ebonised', 'iroko', { wood: '#2b2018' }, [50, 50, 55], null, 'made-to-order', null],
        ],
      },
    ],
  },
  {
    name: 'Sample workshop — Nairobi Timber Co.', areaLabel: 'Nairobi, Kenya', currency: 'KES',
    about: 'Sample seller. Solid timber tables and shelving, built to order. Not a real merchant.',
    products: [
      {
        name: 'Family dining table', category: 'tables', model: 'table', share: true,
        description: 'Sample listing. Solid mvule top on a trestle base. Seats six or eight.',
        variants: [
          ['Six-seat, natural', 'mvule', { wood: '#a8743f' }, [180, 90, 75], 6_800_000, 'made-to-order', 24],
          ['Eight-seat, natural', 'mvule', { wood: '#a8743f' }, [220, 100, 75], 8_900_000, 'made-to-order', 30],
          ['Six-seat, walnut stain', 'mvule', { wood: '#5b3d28' }, [180, 90, 75], null, 'made-to-order', null],
        ],
      },
      {
        name: 'Low coffee table', category: 'tables', model: 'tableCoffee',
        description: 'Sample listing. A low slatted table for the living room.',
        variants: [
          ['Natural', 'cedar', { wood: '#b88a55' }, [100, 60, 40], 1_850_000, 'in-stock', 6],
          ['Whitewash', 'cedar', { wood: '#e3dccd' }, [100, 60, 40], 2_050_000, 'made-to-order', 12],
        ],
      },
      {
        name: 'Open bookcase', category: 'storage', model: 'bookcaseOpen',
        description: 'Sample listing. Open shelving with a plain back panel, five shelves.',
        variants: [
          ['Natural', 'pine', { wood: '#c9a574' }, [80, 30, 180], 2_400_000, 'in-stock', 7],
          ['Black', 'pine', { wood: '#26221e' }, [80, 30, 180], 2_600_000, 'made-to-order', 15],
        ],
      },
      {
        name: 'Writing desk', category: 'tables', model: 'desk',
        description: 'Sample listing. A compact desk with a steel frame and a timber top.',
        variants: [
          ['Oak top, black frame', 'oak and steel', { wood: '#b58d57', metal: '#222222' }, [120, 60, 75], 3_900_000, 'made-to-order', 16],
          ['Walnut top, brass frame', 'walnut and steel', { wood: '#5b3d28', metal: '#b08d3c' }, [140, 70, 75], null, 'made-to-order', null],
        ],
      },
    ],
  },
  {
    name: 'Sample studio — Northern Light Home', areaLabel: 'Manchester, United Kingdom', currency: 'GBP',
    about: 'Sample seller. Beds, lighting and soft furnishings. Not a real merchant.',
    products: [
      {
        name: 'Double bed frame', category: 'beds', model: 'bedDouble',
        description: 'Sample listing. Ash frame with a padded headboard. Mattress not included.',
        variants: [
          ['Ash / oatmeal', 'ash and linen', { wood: '#c8a679', carpetWhite: '#e7e0d2', metal: '#8a8a8a' }, [150, 205, 95], 64_900, 'made-to-order', 35],
          ['Dark ash / slate', 'ash and linen', { wood: '#4d3a2a', carpetWhite: '#8d949b', metal: '#222222' }, [150, 205, 95], 67_900, 'made-to-order', 35],
        ],
      },
      {
        name: 'Round floor lamp', category: 'lighting', model: 'lampRoundFloor', share: true,
        description: 'Sample listing. Opal shade on a slim steel stem.',
        variants: [
          ['Brass stem', 'steel', { metal: '#b08d3c', lamp: '#f6edd6' }, [35, 35, 160], 8_900, 'in-stock', 3],
          ['Black stem', 'steel', { metal: '#1f1f1f', lamp: '#f6edd6' }, [35, 35, 160], 7_900, 'in-stock', 3],
        ],
      },
      {
        name: 'Wool rectangle rug', category: 'decor', model: 'rugRectangle',
        description: 'Sample listing. Flat-woven wool rug with a darker border.',
        variants: [
          ['Medium, stone', 'wool', { carpet: '#bdb5a6', carpetDarker: '#8c8576' }, [160, 230, 1], 12_900, 'in-stock', 4],
          ['Large, stone', 'wool', { carpet: '#bdb5a6', carpetDarker: '#8c8576' }, [200, 300, 1], 21_900, 'made-to-order', 20],
          ['Large, rust', 'wool', { carpet: '#a85a3a', carpetDarker: '#7a3f28' }, [200, 300, 1], null, 'made-to-order', null],
        ],
      },
      {
        name: 'Fig in a glazed planter', category: 'decor', model: 'pottedPlant',
        description: 'Sample listing. A real fig, potted in a hand-glazed planter.',
        variants: [
          ['Moss glaze', 'stoneware', { wood: '#6b7a55', woodDark: '#4a5539', plant: '#4f7a3f' }, [30, 30, 70], 4_500, 'in-stock', 2],
          ['Cream glaze', 'stoneware', { wood: '#e3dccd', woodDark: '#bdb5a6', plant: '#4f7a3f' }, [30, 30, 70], null, 'made-to-order', null],
        ],
      },
    ],
  },
]

/** Runs once: the catalog is only seeded while no seller exists, so a restart never duplicates it. */
function seedSamples(world: World): void {
  const data = state(world)
  if (Object.keys(data.sellers).length > 0) return
  const at = iso(world.now())
  for (const sample of SAMPLES) {
    const seller: Seller = { id: newId<SellerId>('sl'), ownerId: SAMPLE_OWNER, name: sample.name, about: sample.about, areaLabel: sample.areaLabel, status: 'approved', sample: true, createdAt: at }
    data.sellers[seller.id] = seller
    for (const product of sample.products) {
      const productId = newId<ProductId>('pd')
      data.products[productId] = {
        id: productId, sellerId: seller.id, name: product.name, description: product.description, category: product.category, model: product.model,
        variants: product.variants.map(([name, material, tints, [width, depth, height], priceMinor, availability, leadTimeDays]): Variant => ({
          id: newId<VariantId>('vr'), name, material, tints, dimensionsCm: { width, depth, height }, priceMinor, currency: sample.currency, availability, leadTimeDays,
        })),
        sharing: { allowed: Boolean(product.share), commissionNote: typeof product.share === 'string' ? product.share : null },
        status: 'listed', createdAt: at, updatedAt: at,
      }
    }
  }
  world.touch()
}

// ── Quotes ──

function quoteView(world: World, viewer: MemberId, quote: QuoteRecord): Quote | null {
  const seller = state(world).sellers[quote.sellerId]
  if (!seller) return null
  const isBuyer = viewer === quote.buyer, isSeller = viewer === seller.ownerId
  // The referrer is not a party: they never see the quote, only that sharing was allowed.
  if (!isBuyer && !isSeller) return null
  const buyer = tryPublicMember(world, viewer, quote.buyer)
  if (!buyer) return null
  return {
    id: quote.id, product: { id: quote.productId, name: quote.productName, model: quote.model }, spec: structuredClone(quote.spec),
    quantity: quote.quantity, note: quote.note, buyer, seller: sellerView(seller), status: quote.status, offer: quote.offer ? { ...quote.offer } : null,
    fulfilment: quote.status === 'accepted' && (isBuyer || isSeller) && quote.fulfilment ? { ...quote.fulfilment } : null,
    payment: 'not-collected', referredBy: quote.referredBy ? tryPublicMember(world, viewer, quote.referredBy) : null,
    createdAt: quote.createdAt, updatedAt: quote.updatedAt, expiresAt: quote.expiresAt, timeline: quote.timeline.map(entry => ({ ...entry })),
  }
}

const parties = (world: World, quote: QuoteRecord): MemberId[] => [quote.buyer, requireFound(state(world).sellers[quote.sellerId], 'The seller').ownerId]

function step(world: World, quote: QuoteRecord, status: QuoteStatus, text: string): void {
  const at = iso(world.now())
  quote.status = status
  quote.updatedAt = at
  quote.timeline.push({ at, text })
  world.touch()
  for (const memberId of parties(world, quote)) world.push(memberId, { type: 'social.changed', scope: 'quotes' })
}

/** Lazy as well as on tick, so an overdue quote is never answerable just because the tick has not run. */
function sweep(world: World): void {
  const now = world.now()
  for (const quote of Object.values(state(world).quotes)) {
    if ((quote.status !== 'requested' && quote.status !== 'quoted') || ms(quote.expiresAt) > now) continue
    step(world, quote, 'expired', `Expired after ${QUOTE_TTL_DAYS} days without an answer`)
    const seller = state(world).sellers[quote.sellerId]
    if (seller) settle(world, seller.ownerId, `quote:${quote.id}`, 'expired')
    emit(world, { to: quote.buyer, category: 'market', kind: 'quote.expired', title: 'A quote request expired', body: `Your request for ${quote.productName} got no answer in time.`, link: `/market/quotes/${quote.id}`, dedupeKey: `quote:${quote.id}` })
  }
}

function loadQuote(world: World, memberId: MemberId, quoteId: QuoteId): { quote: QuoteRecord; seller: Seller } {
  sweep(world)
  const quote = state(world).quotes[quoteId]
  const seller = quote && state(world).sellers[quote.sellerId]
  if (!quote || !seller || (quote.buyer !== memberId && seller.ownerId !== memberId)) throw new WorldError('not_found', 'That quote was not found.')
  return { quote, seller }
}

const live = (quote: QuoteRecord): boolean => quote.status === 'requested' || quote.status === 'quoted'

function requireLive(quote: QuoteRecord, action: string): void {
  if (quote.status === 'expired') throw new WorldError('expired', 'This quote has expired.')
  if (!live(quote)) throw new WorldError('conflict', `This quote is already ${quote.status}, so it cannot be ${action}.`)
}

function parseFulfilment(value: unknown): Fulfilment {
  if (value === null || value === undefined) throw new WorldError('invalid', 'Delivery details are needed to accept an offer.')
  const raw = obj(value, 'fulfilment')
  return {
    recipient: str(raw, 'recipient', { min: 1, max: 80 }), phone: str(raw, 'phone', { min: 1, max: 40 }),
    address: str(raw, 'address', { min: 1, max: 300 }), notes: optStr(raw, 'notes', { max: 300 }) ?? '',
  }
}

const currencyOf = (raw: Record<string, unknown>): string => {
  const currency = str(raw, 'currency', { min: 3, max: 3 })
  if (!/^[A-Z]{3}$/.test(currency)) throw new WorldError('invalid', 'currency must be 3 uppercase letters, for example NGN')
  return currency
}

export function registerMarket(world: World): void {
  seedSamples(world)
  world.onTick(() => sweep(world))

  // ── Catalog ──

  world.register('market.catalog', value => {
    const raw = obj(value)
    return {
      category: raw.category === null || raw.category === undefined ? null : oneOf(raw, 'category', PRODUCT_CATEGORIES),
      query: str(raw, 'query', { max: 80 }), savedOnly: bool(raw, 'savedOnly'),
    }
  }, (ctx, input) => {
    const needle = input.query.toLowerCase()
    const saved = state(world).saved[ctx.memberId] ?? []
    const products = Object.values(state(world).products)
      .filter(product => product.status === 'listed' && isListed(world, ctx.memberId, product))
      .filter(product => !input.category || product.category === input.category)
      .filter(product => !input.savedOnly || saved.includes(product.id))
      .filter(product => !needle || [product.name, product.description, state(world).sellers[product.sellerId]?.name ?? '', ...product.variants.map(variant => variant.material)]
        .some(text => text.toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name))
      .slice(0, 100)
    return { products: products.map(product => productView(world, ctx.memberId, product)) }
  })

  world.register('market.product', value => ({ productId: id<ProductId>(obj(value), 'productId', 'pd') }), (ctx, input) => {
    const product = state(world).products[input.productId]
    if (!product || !mayView(world, ctx.memberId, product)) throw new WorldError('not_found', 'That product was not found.')
    return { product: productView(world, ctx.memberId, product) }
  })

  // What the App calls when a member taps a furnishing in a room.
  world.register('market.byModel', value => ({ model: str(obj(value), 'model', { min: 1, max: 48 }) }), (ctx, input) => ({
    products: Object.values(state(world).products)
      .filter(product => product.model === input.model && product.status === 'listed' && isListed(world, ctx.memberId, product))
      .sort((a, b) => a.name.localeCompare(b.name)).slice(0, 50).map(product => productView(world, ctx.memberId, product)),
  }))

  world.register('market.save', value => {
    const raw = obj(value)
    return { productId: id<ProductId>(raw, 'productId', 'pd'), saved: bool(raw, 'saved') }
  }, (ctx, input) => {
    const product = state(world).products[input.productId]
    if (!product || !mayView(world, ctx.memberId, product)) throw new WorldError('not_found', 'That product was not found.')
    const mine = (state(world).saved[ctx.memberId] ??= [])
    const has = mine.includes(product.id)
    if (input.saved && !has) mine.push(product.id)
    if (!input.saved && has) state(world).saved[ctx.memberId] = mine.filter(entry => entry !== product.id)
    world.touch()
    return { product: productView(world, ctx.memberId, product) }
  })

  // ── Sellers ──

  world.register('market.sellerApply', value => {
    const raw = obj(value)
    return { name: str(raw, 'name', { min: 2, max: 60 }), about: str(raw, 'about', { max: 500 }), areaLabel: str(raw, 'areaLabel', { min: 1, max: 80 }) }
  }, (ctx, input) => {
    const existing = sellerOf(world, ctx.memberId)
    if (existing) return { seller: sellerView(existing) }
    const seller: Seller = {
      id: newId<SellerId>('sl'), ownerId: ctx.memberId, name: input.name, about: input.about, areaLabel: input.areaLabel,
      status: 'pending', sample: false, createdAt: iso(ctx.now),
    }
    state(world).sellers[seller.id] = seller
    world.touch()
    return { seller: sellerView(seller) }
  })

  world.register('market.mySeller', empty, ctx => {
    const seller = sellerOf(world, ctx.memberId) ?? null
    const products = seller ? Object.values(state(world).products).filter(product => product.sellerId === seller.id).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) : []
    return { seller: seller && sellerView(seller), products: products.map(product => productView(world, ctx.memberId, product)) }
  })

  world.register('market.sellerQueue', empty, ctx => {
    requireReviewer(world, ctx.memberId)
    return { sellers: Object.values(state(world).sellers).filter(seller => seller.status === 'pending').sort((a, b) => a.createdAt.localeCompare(b.createdAt)).map(sellerView) }
  })

  world.register('market.sellerReview', value => {
    const raw = obj(value)
    return { sellerId: id<SellerId>(raw, 'sellerId', 'sl'), approve: bool(raw, 'approve') }
  }, (ctx, input) => {
    requireReviewer(world, ctx.memberId)
    const seller = requireFound(state(world).sellers[input.sellerId], 'That seller')
    seller.status = input.approve ? 'approved' : 'suspended'
    world.touch()
    emit(world, {
      to: seller.ownerId, category: 'market', kind: 'seller.reviewed', actor: ctx.memberId, link: '/market/sell', dedupeKey: `seller:${seller.id}`,
      title: input.approve ? 'Your seller profile was approved' : 'Your seller profile was not approved',
      body: input.approve ? `${seller.name} can now list products.` : `${seller.name} cannot list products right now.`,
    })
    return { seller: sellerView(seller) }
  })

  // ── Products ──

  world.register('market.productSave', value => {
    const raw = obj(value)
    const model = modelInfo(str(raw, 'model', { min: 1, max: 48 }))
    const variants = list(raw, 'variants', entry => parseVariant(entry, model), { max: 8 })
    if (variants.length < 1) throw new WorldError('invalid', 'Add at least one variant.')
    const sharingAllowed = bool(raw, 'sharingAllowed')
    return {
      productId: optId<ProductId>(raw, 'productId', 'pd'), name: str(raw, 'name', { min: 2, max: 80 }), description: str(raw, 'description', { max: 1000 }),
      category: oneOf(raw, 'category', PRODUCT_CATEGORIES), model: model.name, variants, sharingAllowed,
      commissionNote: optStr(raw, 'commissionNote', { max: 200 }) || null, listed: bool(raw, 'listed'),
    }
  }, (ctx, input) => {
    const seller = sellerOf(world, ctx.memberId)
    if (!seller) return forbidden('Apply to sell before you add products.')
    if (seller.status !== 'approved') return forbidden(`Your seller profile is ${seller.status}. Only approved sellers can add products.`)
    const existing = input.productId ? requireFound(state(world).products[input.productId], 'That product') : null
    if (existing && existing.sellerId !== seller.id) return forbidden('You can only edit your own products.')
    if (!existing && Object.values(state(world).products).filter(product => product.sellerId === seller.id).length >= 100) throw new WorldError('conflict', 'You have reached the limit of 100 products.')
    const known = new Set(existing?.variants.map(variant => variant.id))
    const used = new Set<string>()
    const variants = input.variants.map((variant): Variant => {
      const keep = variant.id && known.has(variant.id) && !used.has(variant.id) ? variant.id : newId<VariantId>('vr')
      used.add(keep)
      return {
        id: keep, name: variant.name, material: variant.material, tints: variant.tints, dimensionsCm: variant.dimensionsCm, priceMinor: variant.priceMinor,
        currency: variant.currency, availability: variant.availability, leadTimeDays: variant.leadTimeDays,
      }
    })
    const at = iso(ctx.now)
    const next: ProductRecord = {
      id: existing?.id ?? newId<ProductId>('pd'), sellerId: seller.id, name: input.name, description: input.description, category: input.category, model: input.model,
      variants, sharing: { allowed: input.sharingAllowed, commissionNote: input.sharingAllowed ? input.commissionNote : null },
      status: input.listed ? 'listed' : 'unlisted', createdAt: existing?.createdAt ?? at, updatedAt: at,
    }
    state(world).products[next.id] = next
    world.touch()
    return { product: productView(world, ctx.memberId, next) }
  })

  // ── Quotes ──

  world.register('quote.request', value => {
    const raw = obj(value)
    return {
      productId: id<ProductId>(raw, 'productId', 'pd'), variantId: id<VariantId>(raw, 'variantId', 'vr'),
      quantity: num(raw, 'quantity', { integer: true, min: 1, max: 50 }), note: str(raw, 'note', { max: 500 }), referredBy: optId<MemberId>(raw, 'referredBy', 'm'),
    }
  }, (ctx, input) => {
    sweep(world)
    const product = state(world).products[input.productId]
    if (!product || !isListed(world, ctx.memberId, product)) throw new WorldError('not_found', 'That product is not available.')
    const seller = requireFound(state(world).sellers[product.sellerId], 'The seller')
    if (seller.ownerId === ctx.memberId) return forbidden('You cannot request a quote on your own product.')
    const variant = product.variants.find(entry => entry.id === input.variantId)
    if (!variant) throw new WorldError('not_found', 'That option is no longer offered.')
    if (variant.availability === 'unavailable') throw new WorldError('conflict', 'That option is unavailable right now.')
    world.limit(`quote.request:${ctx.memberId}`, 20, 3_600_000)
    // A referrer is credited only when the seller allowed sharing and the referrer is someone else who exists.
    const referrer = input.referredBy && input.referredBy !== ctx.memberId && product.sharing.allowed && tryPublicMember(world, ctx.memberId, input.referredBy) ? input.referredBy : null
    const at = iso(ctx.now)
    const quote: QuoteRecord = {
      id: newId<QuoteId>('q'), productId: product.id, productName: product.name, model: product.model, spec: structuredClone(variant), quantity: input.quantity,
      note: input.note, buyer: ctx.memberId, sellerId: seller.id, status: 'requested', offer: null, fulfilment: null, referredBy: referrer,
      createdAt: at, updatedAt: at, expiresAt: iso(ctx.now + QUOTE_TTL_DAYS * DAY), timeline: [{ at, text: `Quote requested for ${input.quantity} × ${variant.name}` }],
    }
    state(world).quotes[quote.id] = quote
    world.touch()
    for (const memberId of parties(world, quote)) world.push(memberId, { type: 'social.changed', scope: 'quotes' })
    emit(world, {
      to: seller.ownerId, category: 'market', kind: 'quote.requested', actor: ctx.memberId, link: `/market/quotes/${quote.id}`, dedupeKey: `quote:${quote.id}`,
      title: 'New quote request', body: `${input.quantity} × ${product.name} (${variant.name}).`, expiresAt: ms(quote.expiresAt),
    })
    return { quote: requireFound(quoteView(world, ctx.memberId, quote), 'The quote') }
  })

  world.register('quote.list', empty, ctx => {
    sweep(world)
    const all = Object.values(state(world).quotes).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    const mine = (own: (quote: QuoteRecord) => boolean): Quote[] => all.filter(own).flatMap(quote => quoteView(world, ctx.memberId, quote) ?? [])
    return {
      asBuyer: mine(quote => quote.buyer === ctx.memberId),
      asSeller: mine(quote => state(world).sellers[quote.sellerId]?.ownerId === ctx.memberId),
    }
  })

  world.register('quote.get', value => ({ quoteId: id<QuoteId>(obj(value), 'quoteId', 'q') }), (ctx, input) => {
    const { quote } = loadQuote(world, ctx.memberId, input.quoteId)
    return { quote: requireFound(quoteView(world, ctx.memberId, quote), 'That quote') }
  })

  world.register('quote.offer', value => {
    const raw = obj(value)
    return {
      quoteId: id<QuoteId>(raw, 'quoteId', 'q'), priceMinor: num(raw, 'priceMinor', { integer: true, min: 0, max: 1e12 }), currency: currencyOf(raw),
      leadTimeDays: num(raw, 'leadTimeDays', { integer: true, min: 0, max: 365 }), note: str(raw, 'note', { max: 500 }),
    }
  }, (ctx, input) => {
    const { quote, seller } = loadQuote(world, ctx.memberId, input.quoteId)
    if (seller.ownerId !== ctx.memberId) return forbidden('Only the seller can send an offer.')
    requireLive(quote, 'offered on')
    const reoffer = quote.status === 'quoted'
    quote.offer = { priceMinor: input.priceMinor, currency: input.currency, leadTimeDays: input.leadTimeDays, note: input.note, offeredAt: iso(ctx.now) }
    // The buyer gets the full window to answer an offer, however late the seller replied.
    quote.expiresAt = iso(ctx.now + QUOTE_TTL_DAYS * DAY)
    step(world, quote, 'quoted', `${reoffer ? 'Offer updated' : 'Offer sent'}: ${money(input.priceMinor, input.currency)}, ready in about ${input.leadTimeDays} days`)
    emit(world, {
      to: quote.buyer, category: 'market', kind: 'quote.offered', actor: ctx.memberId, link: `/market/quotes/${quote.id}`, dedupeKey: `quote:${quote.id}`,
      title: `${seller.name} sent an offer`, body: `${quote.productName}: ${money(input.priceMinor, input.currency)}. Nothing is charged here.`, expiresAt: ms(quote.expiresAt),
    })
    return { quote: requireFound(quoteView(world, ctx.memberId, quote), 'That quote') }
  })

  world.register('quote.decide', value => {
    const raw = obj(value)
    const accept = bool(raw, 'accept')
    return { quoteId: id<QuoteId>(raw, 'quoteId', 'q'), accept, fulfilment: accept ? parseFulfilment(raw.fulfilment) : null }
  }, (ctx, input) => {
    const { quote, seller } = loadQuote(world, ctx.memberId, input.quoteId)
    if (quote.buyer !== ctx.memberId) return forbidden('Only the buyer can accept or decline an offer.')
    requireLive(quote, input.accept ? 'accepted' : 'declined')
    if (quote.status !== 'quoted') throw new WorldError('conflict', 'There is no offer to answer yet.')
    if (input.accept) quote.fulfilment = input.fulfilment
    step(world, quote, input.accept ? 'accepted' : 'declined', input.accept ? 'Offer accepted. Delivery details shared with the seller. No payment was taken' : 'Offer declined')
    settle(world, ctx.memberId, `quote:${quote.id}`)
    emit(world, {
      to: seller.ownerId, category: 'market', kind: input.accept ? 'quote.accepted' : 'quote.declined', actor: ctx.memberId, link: `/market/quotes/${quote.id}`, dedupeKey: `quote:${quote.id}`,
      title: input.accept ? 'Your offer was accepted' : 'Your offer was declined', body: input.accept ? `${quote.productName}: delivery details are in the quote.` : `${quote.productName}.`,
    })
    return { quote: requireFound(quoteView(world, ctx.memberId, quote), 'That quote') }
  })

  world.register('quote.withdraw', value => ({ quoteId: id<QuoteId>(obj(value), 'quoteId', 'q') }), (ctx, input) => {
    const { quote, seller } = loadQuote(world, ctx.memberId, input.quoteId)
    if (quote.buyer !== ctx.memberId) return forbidden('Only the buyer can withdraw a quote request.')
    requireLive(quote, 'withdrawn')
    step(world, quote, 'withdrawn', 'Withdrawn by the buyer')
    settle(world, seller.ownerId, `quote:${quote.id}`)
    return { quote: requireFound(quoteView(world, ctx.memberId, quote), 'That quote') }
  })
}
