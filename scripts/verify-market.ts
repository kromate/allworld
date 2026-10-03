// Evidence probe for the market and jobs modules: in-process world, controllable clock, plain asserts.
// Run: node scripts/verify-market.ts   (prints one PASS line per check, exits non-zero on the first failure)
import assert from 'node:assert/strict'
import type { MemberId, ProductId, VariantId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import type { ErrorCode } from '../src/shared/model.ts'
import type { Persistence } from '../service/kernel.ts'
import type { VariantInput } from '../src/shared/protocol.ts'
import { createWorld } from '../service/index.ts'
import { ensureMember } from '../service/members.ts'

const DAY = 86_400_000
let now = Date.UTC(2026, 9, 1, 12)
let stored: Record<string, unknown> | null = null
const persistence: Persistence = { load: () => (stored ? structuredClone(stored) : null), save: state => { stored = structuredClone(state) } }

const A = 'm_local_a' as MemberId, B = 'm_local_b' as MemberId, C = 'm_local_c' as MemberId, R = 'm_local_reviewer' as MemberId
const world = createWorld({ now: () => now, persistence })
ensureMember(world, A, 'Test member A')
ensureMember(world, B, 'Test member B')
ensureMember(world, C, 'Test member C')
ensureMember(world, R, 'Catalog reviewer', { reviewer: true })

function rejects(code: ErrorCode, run: () => unknown): void {
  try { run() } catch (error) {
    assert.ok(error instanceof WorldError, `expected WorldError(${code}), got ${String(error)}`)
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`)
    return
  }
  assert.fail(`expected ${code}, but the call succeeded`)
}

// Career progress lives in the work module (Career, ShiftResult, CareerRecord). A job application must not carry any of it.
// `title` is left out on purpose: the listing's own title is a legitimate public field. Only field names are checked, never values,
// so a random id or a message that happens to contain "xp" or "level" is fine.
const CAREER_KEYS = new Set(['career', 'careers', 'points', 'xp', 'level', 'levelbefore', 'levelafter', 'titleafter', 'nextlevelxp', 'skill', 'skills', 'accuracy', 'shifts', 'completed', 'leftearly', 'recent'])
function careerKeysIn(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => careerKeysIn(item, `${path}[${index}]`))
  if (value === null || typeof value !== 'object') return []
  return Object.entries(value).flatMap(([key, child]) => [...(CAREER_KEYS.has(key.toLowerCase()) ? [`${path}.${key}`] : []), ...careerKeysIn(child, `${path}.${key}`)])
}

let failed = false
function check(name: string, run: () => void): void {
  if (failed) return
  try { run(); console.log(`PASS ${name}`) } catch (error) {
    failed = true
    console.error(`FAIL ${name}`)
    console.error(error)
    process.exit(1)
  }
}

const variant = (over: Partial<VariantInput> = {}): VariantInput => ({
  name: 'Sage', material: 'oak and wool', tints: { carpet: '#8a9a7b', wood: '#a67c52' }, dimensionsCm: { width: 200, depth: 90, height: 85 },
  priceMinor: 12_000_000, currency: 'NGN', availability: 'made-to-order', leadTimeDays: 20, ...over,
})
const productInput = (over: Record<string, unknown> = {}) => ({
  productId: null, name: 'Test sofa', description: 'A sofa made for the probe.', category: 'seating' as const, model: 'loungeSofa',
  variants: [variant()], sharingAllowed: true, commissionNote: null, listed: true, ...over,
})
const fulfilment = { recipient: 'Test member B', phone: '+234 800 000 0000', address: '12 Test Street, Ibadan', notes: 'Ring the bell' }

let sofa: ProductId, sofaVariant: VariantId

check('sample catalog seeded once, every sample seller flagged', () => {
  const first = world.call(B, 'market.catalog', { category: null, query: '', savedOnly: false }).products
  assert.equal(first.length, 12)
  assert.equal(new Set(first.map(product => product.seller.id)).size, 3)
  assert.ok(first.every(product => product.seller.sample === true && product.seller.name.startsWith('Sample ')))
  assert.ok(first.every(product => product.variants.length >= 2 && product.variants.length <= 3))
  world.flush()
  const second = createWorld({ now: () => now, persistence })
  const again = second.call(B, 'market.catalog', { category: null, query: '', savedOnly: false }).products
  assert.equal(again.length, 12)
  assert.deepEqual(again.map(product => product.id).sort(), first.map(product => product.id).sort())
})

check('seller approval gates products and the catalog', () => {
  const seller = world.call(A, 'market.sellerApply', { name: 'Test Furniture A', about: 'Probe seller', areaLabel: 'Ibadan, Nigeria' }).seller
  assert.equal(seller.status, 'pending')
  assert.equal(world.call(A, 'market.sellerApply', { name: 'Another name', about: '', areaLabel: 'x' }).seller.id, seller.id)
  rejects('forbidden', () => world.call(A, 'market.productSave', productInput()))
  rejects('forbidden', () => world.call(B, 'market.sellerQueue', {}))
  rejects('forbidden', () => world.call(A, 'market.sellerReview', { sellerId: seller.id, approve: true }))
  assert.deepEqual(world.call(R, 'market.sellerQueue', {}).sellers.map(entry => entry.id), [seller.id])
  assert.equal(world.call(R, 'market.sellerReview', { sellerId: seller.id, approve: true }).seller.status, 'approved')
  assert.ok(world.call(A, 'notify.list', { includeRead: true }).notifications.some(item => item.category === 'market' && item.link === '/market/sell'))
  const product = world.call(A, 'market.productSave', productInput()).product
  sofa = product.id
  sofaVariant = product.variants[0]!.id
  assert.equal(product.status, 'listed')
  assert.ok(world.call(B, 'market.catalog', { category: 'seating', query: 'test furniture a', savedOnly: false }).products.some(entry => entry.id === sofa))
  assert.equal(world.call(A, 'market.mySeller', {}).products.length, 1)
  rejects('forbidden', () => world.call(B, 'market.productSave', productInput({ productId: sofa })))
  const unlisted = world.call(A, 'market.productSave', productInput({ name: 'Hidden stool', listed: false })).product
  assert.equal(unlisted.status, 'unlisted')
  rejects('not_found', () => world.call(B, 'market.product', { productId: unlisted.id }))
  assert.equal(world.call(A, 'market.product', { productId: unlisted.id }).product.status, 'unlisted')
})

check('variant truth: byModel matches, bad input rejected', () => {
  const products = world.call(B, 'market.byModel', { model: 'loungeSofa' }).products
  assert.ok(products.length >= 2 && products.every(product => product.model === 'loungeSofa'))
  assert.ok(products.some(product => product.id === sofa))
  assert.equal(world.call(B, 'market.byModel', { model: 'doesNotExist' }).products.length, 0)
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [variant({ tints: { chrome: '#ffffff' } })] })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [variant({ tints: { carpet: 'red' } })] })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ model: 'notAModel' })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [variant({ dimensionsCm: { width: 0, depth: 90, height: 85 } })] })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [variant({ dimensionsCm: { width: 200, depth: 1001, height: 85 } })] })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [] })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: Array.from({ length: 9 }, () => variant()) })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [variant({ currency: 'ngn' })] })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [variant({ priceMinor: -1 })] })))
  rejects('invalid', () => world.call(A, 'market.productSave', productInput({ variants: [variant({ leadTimeDays: 400 })] })))
  // An edit keeps the ids of variants it names and mints ids for new ones.
  const edited = world.call(A, 'market.productSave', productInput({ productId: sofa, variants: [{ ...variant(), id: sofaVariant }, variant({ name: 'Rust' })] })).product
  assert.equal(edited.variants[0]!.id, sofaVariant)
  assert.notEqual(edited.variants[1]!.id, sofaVariant)
})

let frozenQuote: string
check('quote spec is frozen at request time', () => {
  const quote = world.call(B, 'quote.request', { productId: sofa, variantId: sofaVariant, quantity: 2, note: 'For the lounge', referredBy: null }).quote
  frozenQuote = quote.id
  assert.equal(quote.status, 'requested')
  assert.equal(quote.spec.dimensionsCm.width, 200)
  assert.equal(quote.spec.priceMinor, 12_000_000)
  const product = world.call(A, 'market.product', { productId: sofa }).product
  world.call(A, 'market.productSave', productInput({
    productId: sofa, variants: product.variants.map(entry => ({ ...entry, dimensionsCm: { width: 250, depth: 95, height: 90 }, priceMinor: 15_000_000 })),
  }))
  assert.equal(world.call(A, 'market.product', { productId: sofa }).product.variants[0]!.dimensionsCm.width, 250)
  const after = world.call(B, 'quote.get', { quoteId: quote.id }).quote
  assert.equal(after.spec.dimensionsCm.width, 200)
  assert.equal(after.spec.priceMinor, 12_000_000)
  rejects('forbidden', () => world.call(A, 'quote.request', { productId: sofa, variantId: sofaVariant, quantity: 1, note: '', referredBy: null }))
  rejects('invalid', () => world.call(B, 'quote.request', { productId: sofa, variantId: sofaVariant, quantity: 51, note: '', referredBy: null }))
  assert.ok(world.call(A, 'notify.list', { includeRead: true }).notifications.some(item => item.kind === 'quote.requested' && item.link === `/market/quotes/${quote.id}`))
})

check('virtual placement is not an order', () => {
  const before = world.call(B, 'quote.list', {})
  const { home } = world.call(B, 'home.get', { homeId: null })
  world.call(B, 'home.save', {
    name: home.name, expectedRevision: home.revision,
    layout: { ...home.layout, items: [...home.layout.items, { key: 'probe-sofa', model: 'loungeSofa', x: 6, z: 6, turns: 0, productId: sofa, variantId: sofaVariant, tints: { carpet: '#8a9a7b' } }] },
  })
  assert.ok(world.call(B, 'home.get', { homeId: null }).home.layout.items.some(item => item.productId === sofa))
  const after = world.call(B, 'quote.list', {})
  assert.equal(after.asBuyer.length, before.asBuyer.length)
  assert.equal(world.call(A, 'quote.list', {}).asSeller.length, before.asBuyer.length)
})

check('quote lifecycle: offer, accept needs fulfilment, repeat conflicts', () => {
  const quoteId = frozenQuote as never
  rejects('conflict', () => world.call(B, 'quote.decide', { quoteId, accept: true, fulfilment }))
  rejects('forbidden', () => world.call(B, 'quote.offer', { quoteId, priceMinor: 1, currency: 'NGN', leadTimeDays: 1, note: '' }))
  const offered = world.call(A, 'quote.offer', { quoteId, priceMinor: 11_500_000, currency: 'NGN', leadTimeDays: 18, note: 'Includes delivery in Ibadan' }).quote
  assert.equal(offered.status, 'quoted')
  assert.equal(offered.offer?.priceMinor, 11_500_000)
  assert.ok(world.call(B, 'notify.list', { includeRead: true }).notifications.some(item => item.kind === 'quote.offered'))
  rejects('invalid', () => world.call(B, 'quote.decide', { quoteId, accept: true, fulfilment: null }))
  rejects('invalid', () => world.call(B, 'quote.decide', { quoteId, accept: true, fulfilment: { ...fulfilment, address: '  ' } }))
  rejects('forbidden', () => world.call(A, 'quote.decide', { quoteId, accept: true, fulfilment }))
  const done = world.call(B, 'quote.decide', { quoteId, accept: true, fulfilment }).quote
  assert.equal(done.status, 'accepted')
  assert.equal(done.payment, 'not-collected')
  assert.equal(done.timeline.length, 3)
  assert.equal(done.spec.priceMinor, 12_000_000)
  rejects('conflict', () => world.call(B, 'quote.decide', { quoteId, accept: true, fulfilment }))
  rejects('conflict', () => world.call(B, 'quote.decide', { quoteId, accept: false, fulfilment: null }))
  rejects('conflict', () => world.call(B, 'quote.withdraw', { quoteId }))
  rejects('conflict', () => world.call(A, 'quote.offer', { quoteId, priceMinor: 1, currency: 'NGN', leadTimeDays: 1, note: '' }))
})

check('fulfilment is private; the referrer never sees the quote', () => {
  const quoteId = frozenQuote as never
  assert.deepEqual(world.call(B, 'quote.get', { quoteId }).quote.fulfilment, fulfilment)
  assert.deepEqual(world.call(A, 'quote.get', { quoteId }).quote.fulfilment, fulfilment)
  rejects('not_found', () => world.call(C, 'quote.get', { quoteId }))
  assert.deepEqual(world.call(C, 'quote.list', {}), { asBuyer: [], asSeller: [] })
  // Sharing allowed: the referrer is recorded but still sees nothing.
  const shared = world.call(B, 'quote.request', { productId: sofa, variantId: sofaVariant, quantity: 1, note: '', referredBy: C }).quote
  assert.equal(shared.referredBy?.id, C)
  rejects('not_found', () => world.call(C, 'quote.get', { quoteId: shared.id }))
  assert.equal(world.call(B, 'quote.get', { quoteId: shared.id }).quote.fulfilment, null)
  // Sharing disabled, or the referrer is the buyer: no credit.
  const noShare = world.call(A, 'market.productSave', productInput({ name: 'No-share table', model: 'table', sharingAllowed: false, commissionNote: 'ignored', variants: [variant({ tints: { wood: '#a67c52' } })] })).product
  assert.equal(noShare.sharing.allowed, false)
  assert.equal(noShare.sharing.commissionNote, null)
  assert.equal(world.call(B, 'quote.request', { productId: noShare.id, variantId: noShare.variants[0]!.id, quantity: 1, note: '', referredBy: C }).quote.referredBy, null)
  assert.equal(world.call(B, 'quote.request', { productId: sofa, variantId: sofaVariant, quantity: 1, note: '', referredBy: B }).quote.referredBy, null)
  const declined = world.call(B, 'quote.withdraw', { quoteId: shared.id }).quote
  assert.equal(declined.status, 'withdrawn')
})

check('unanswered quotes expire after the 14 day window', () => {
  const quote = world.call(B, 'quote.request', { productId: sofa, variantId: sofaVariant, quantity: 1, note: 'slow', referredBy: null }).quote
  assert.equal(Date.parse(quote.expiresAt) - now, 14 * DAY)
  now += 13 * DAY
  world.tick()
  assert.equal(world.call(B, 'quote.get', { quoteId: quote.id }).quote.status, 'requested')
  now += 1 * DAY + 60_000
  world.tick()
  const expired = world.call(B, 'quote.get', { quoteId: quote.id }).quote
  assert.equal(expired.status, 'expired')
  assert.equal(expired.timeline.at(-1)?.text.startsWith('Expired'), true)
  rejects('expired', () => world.call(A, 'quote.offer', { quoteId: quote.id, priceMinor: 1, currency: 'NGN', leadTimeDays: 1, note: '' }))
})

check('saved products are per member', () => {
  const catalog = (member: MemberId, savedOnly: boolean) => world.call(member, 'market.catalog', { category: null, query: '', savedOnly }).products
  assert.equal(world.call(B, 'market.save', { productId: sofa, saved: true }).product.saved, true)
  assert.deepEqual(catalog(B, true).map(product => product.id), [sofa])
  assert.equal(catalog(C, true).length, 0)
  assert.equal(catalog(C, false).find(product => product.id === sofa)?.saved, false)
  assert.equal(catalog(B, false).find(product => product.id === sofa)?.saved, true)
  assert.equal(world.call(B, 'market.save', { productId: sofa, saved: false }).product.saved, false)
  assert.equal(catalog(B, true).length, 0)
})

let listingId: string
check('application privacy scan checks field names, not values', () => {
  const harmless = { id: 'application_xp9f3', listing: { id: 'listing_xp1', title: 'Expert XP level points career workshop', kind: 'job', organisation: 'Xpress Level Co' }, applicant: { id: 'm_xp_local', displayName: 'Xp Career', bio: 'level points', look: { body: 'm01' } }, message: 'xp xp XP, level, points, career', contact: 'xp@example.com', tags: ['xp', { note: 'career' }] }
  assert.deepEqual(careerKeysIn(harmless), [])
  assert.deepEqual(careerKeysIn({ ...harmless, applicant: { ...harmless.applicant, career: { points: 3 } } }), ['$.applicant.career', '$.applicant.career.points'])
  assert.deepEqual(careerKeysIn({ ...harmless, tags: [{ skills: { craft: { xp: 1, level: 2, title: 'Maker', nextLevelXp: 40 } } }] }), ['$.tags[0].skills', '$.tags[0].skills.craft.xp', '$.tags[0].skills.craft.level', '$.tags[0].skills.craft.nextLevelXp'])
  assert.deepEqual(careerKeysIn([{ listing: { XP: 5 } }]), ['$[0].listing.XP'])
  assert.deepEqual(careerKeysIn({ ...harmless, result: { levelAfter: 2, titleAfter: 'x' } }), ['$.result.levelAfter', '$.result.titleAfter'])
})

check('listings and applications: counts, contact and access', () => {
  const listing = world.call(A, 'listing.save', {
    listingId: null, kind: 'job', title: 'Workshop assistant', organisation: 'Test Furniture A', description: 'Help sand and finish frames, three days a week.',
    areaLabel: 'Ibadan, Nigeria', remote: false, compensation: 'Weekly, agreed in person',
  }).listing
  listingId = listing.id
  assert.equal(listing.status, 'open')
  assert.equal(listing.applicationCount, 0)
  rejects('invalid', () => world.call(A, 'listing.save', { listingId: null, kind: 'job', title: 'x', organisation: '', description: 'long enough description', areaLabel: '', remote: false, compensation: '' }))
  rejects('forbidden', () => world.call(B, 'listing.save', { listingId: listing.id, kind: 'job', title: 'Hijacked title', organisation: '', description: 'long enough description', areaLabel: '', remote: false, compensation: '' }))
  assert.ok(world.call(B, 'listing.list', { kind: 'job', mine: false }).listings.some(entry => entry.id === listing.id))
  assert.equal(world.call(B, 'listing.list', { kind: 'task', mine: false }).listings.length, 0)
  const own = world.call(B, 'listing.save', { listingId: null, kind: 'task', title: 'Help me move a sofa', organisation: '', description: 'Two people, one afternoon, a short drive.', areaLabel: 'Ibadan', remote: false, compensation: 'Lunch' }).listing
  rejects('forbidden', () => world.call(B, 'application.submit', { listingId: own.id, message: 'I will do my own task', contact: 'b@example.com' }))
  const application = world.call(B, 'application.submit', { listingId: listing.id, message: 'I have sanded and finished frames for two years.', contact: 'b@example.com' }).application
  assert.equal(application.status, 'submitted')
  assert.equal(application.contact, 'b@example.com')
  assert.deepEqual(careerKeysIn(application), [], 'application carries career progress fields')
  assert.deepEqual(careerKeysIn({ ...application, id: `${application.id}xp`, message: 'xp level points career' }), [], 'a value containing xp is not a field')
  assert.deepEqual(careerKeysIn({ ...application, applicant: { ...application.applicant, career: { skills: { craft: { xp: 1 } } } } }), ['$.applicant.career', '$.applicant.career.skills', '$.applicant.career.skills.craft.xp'], 'a nested career field is caught')
  rejects('conflict', () => world.call(B, 'application.submit', { listingId: listing.id, message: 'Applying a second time.', contact: 'b@example.com' }))
  assert.equal(world.call(A, 'listing.get', { listingId: listing.id }).listing.applicationCount, 1)
  assert.equal(world.call(C, 'listing.get', { listingId: listing.id }).listing.applicationCount, null)
  assert.equal(world.call(B, 'listing.get', { listingId: listing.id }).listing.applicationCount, null)
  assert.equal(world.call(B, 'listing.get', { listingId: listing.id }).listing.myApplication, 'submitted')
  assert.equal(world.call(C, 'listing.get', { listingId: listing.id }).listing.myApplication, null)
  const forListing = world.call(A, 'application.forListing', { listingId: listing.id as never }).applications
  assert.equal(forListing.length, 1)
  assert.equal(forListing[0]!.contact, 'b@example.com')
  rejects('forbidden', () => world.call(C, 'application.forListing', { listingId: listing.id }))
  rejects('forbidden', () => world.call(B, 'application.forListing', { listingId: listing.id }))
  rejects('not_found', () => world.call(C, 'application.decide', { applicationId: application.id, status: 'withdrawn' }))
  assert.ok(world.call(A, 'notify.list', { includeRead: true }).notifications.some(item => item.kind === 'application.received' && item.link === `/jobs/${listing.id}`))
  assert.equal(world.call(A, 'listing.list', { kind: null, mine: true }).listings.length, 1)
})

check('decisions, notifications and closing a listing', () => {
  const application = world.call(A, 'application.forListing', { listingId: listingId as never }).applications[0]!
  rejects('forbidden', () => world.call(B, 'application.decide', { applicationId: application.id, status: 'accepted' }))
  rejects('forbidden', () => world.call(A, 'application.decide', { applicationId: application.id, status: 'withdrawn' }))
  assert.equal(world.call(A, 'application.decide', { applicationId: application.id, status: 'shortlisted' }).application.status, 'shortlisted')
  assert.equal(world.call(A, 'application.decide', { applicationId: application.id, status: 'accepted' }).application.status, 'accepted')
  assert.equal(world.call(B, 'application.mine', {}).applications[0]!.status, 'accepted')
  assert.equal(world.call(C, 'application.mine', {}).applications.length, 0)
  const work = world.call(B, 'notify.list', { includeRead: true }).notifications.filter(item => item.category === 'work')
  assert.ok(work.length >= 1 && work.every(item => item.link === `/jobs/${listingId}`))
  assert.equal(world.call(A, 'listing.setStatus', { listingId: listingId as never, status: 'closed' }).listing.status, 'closed')
  rejects('forbidden', () => world.call(B, 'listing.setStatus', { listingId: listingId as never, status: 'open' }))
  rejects('conflict', () => world.call(C, 'application.submit', { listingId: listingId as never, message: 'Too late to apply here.', contact: 'c@example.com' }))
  assert.equal(world.call(B, 'listing.list', { kind: null, mine: false }).listings.some(entry => entry.id === listingId), false)
  assert.equal(world.call(B, 'listing.get', { listingId: listingId as never }).listing.status, 'closed')
  rejects('not_found', () => world.call(C, 'listing.get', { listingId: listingId as never }))
  assert.equal(world.call(B, 'application.decide', { applicationId: application.id, status: 'withdrawn' }).application.status, 'withdrawn')
  assert.ok(world.call(A, 'notify.list', { includeRead: true }).notifications.some(item => item.link === `/jobs/${listingId}` && item.title.includes('withdrawn')))
})
