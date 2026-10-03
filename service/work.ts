// Go to work: a short simulated shift at a café, shop or studio. Tickets are generated and judged
// here, the client only ever sees the task in front of it. Points are game points, never money.
import type { Iso, MemberId, ShiftId } from '../src/shared/ids.ts'
import { iso, ms, newId } from '../src/shared/ids.ts'
import { WorldError } from '../src/shared/model.ts'
import { PAY, SHIFT_TIMEOUT_MINUTES, SKILLS, levelForXp, seededRandom, xpForLevel } from '../src/shared/play.ts'
import type { Career, Shift, ShiftResult, ShiftSite, Skill, TaskOutcome, WorkTask, Workplace } from '../src/shared/play.ts'
import type { World } from './kernel.ts'
import { emit } from './notify.ts'
import { empty, id, list, num, obj, optStr, str } from './parse.ts'
import { roomOf } from './rooms.ts'

const WORKPLACES: Workplace[] = [
  {
    id: 'corner-cafe', name: 'Corner café', role: 'Counter assistant', skill: 'service',
    about: 'Take the order, hand over each item in the order it was asked for.',
    venueCategories: ['cafe', 'restaurant', 'fast_food', 'bakery', 'bar', 'beer', 'ice_cream', 'lodging'], stations: ['counter', 'till'],
    venueWords: 'café, restaurant, bakery, bar or hotel',
    stock: [
      { id: 'espresso', label: 'Espresso', emoji: '☕' }, { id: 'latte', label: 'Latte', emoji: '🥛' },
      { id: 'tea', label: 'Tea', emoji: '🍵' }, { id: 'croissant', label: 'Croissant', emoji: '🥐' },
      { id: 'muffin', label: 'Muffin', emoji: '🧁' }, { id: 'cookie', label: 'Cookie', emoji: '🍪' },
      { id: 'juice', label: 'Juice', emoji: '🧃' }, { id: 'sandwich', label: 'Sandwich', emoji: '🥪' },
    ],
    tasksPerShift: 5, parSeconds: 14,
  },
  {
    id: 'corner-shop', name: 'Corner shop', role: 'Stockroom runner', skill: 'logistics',
    about: 'Pick the items on each order from the shelves, in order.',
    venueCategories: ['shop', 'grocery', 'supermarket', 'convenience', 'marketplace', 'mall'], stations: ['shelf', 'stall', 'till'],
    venueWords: 'shop, supermarket, market or mall',
    stock: [
      { id: 'bread', label: 'Bread', emoji: '🍞' }, { id: 'milk', label: 'Milk', emoji: '🥛' },
      { id: 'eggs', label: 'Eggs', emoji: '🥚' }, { id: 'apples', label: 'Apples', emoji: '🍎' },
      { id: 'rice', label: 'Rice', emoji: '🍚' }, { id: 'tomatoes', label: 'Tomatoes', emoji: '🍅' },
      { id: 'cheese', label: 'Cheese', emoji: '🧀' }, { id: 'soap', label: 'Soap', emoji: '🧼' },
    ],
    tasksPerShift: 5, parSeconds: 14,
  },
  {
    id: 'maker-studio', name: 'Maker studio', role: 'Studio assistant', skill: 'craft',
    about: 'Gather the materials for each project in the order the maker lists them.',
    // Study rooms publish no work station yet, so this job is done on the floor of the room.
    venueCategories: ['art', 'craft', 'library', 'gallery', 'art_gallery', 'museum'], stations: [],
    venueWords: 'library, gallery or museum',
    stock: [
      { id: 'paint', label: 'Paint', emoji: '🎨' }, { id: 'brush', label: 'Brush', emoji: '🖌️' },
      { id: 'clay', label: 'Clay', emoji: '🏺' }, { id: 'thread', label: 'Thread', emoji: '🧵' },
      { id: 'scissors', label: 'Scissors', emoji: '✂️' }, { id: 'paper', label: 'Paper', emoji: '📄' },
      { id: 'glue', label: 'Glue', emoji: '🧴' }, { id: 'wood', label: 'Wood', emoji: '🪵' },
    ],
    tasksPerShift: 5, parSeconds: 14,
  },
]

const TITLES: Record<Skill, string[]> = {
  service: ['Trainee', 'Barista', 'Senior barista', 'Shift lead', 'Manager', 'Head of house'],
  logistics: ['Trainee', 'Picker', 'Senior picker', 'Stock lead', 'Supervisor', 'Head of stores'],
  craft: ['Apprentice', 'Assistant', 'Studio hand', 'Maker', 'Senior maker', 'Master maker'],
}
const titleFor = (skill: Skill, level: number): string => TITLES[skill][Math.min(level, TITLES[skill].length) - 1]!

const CUSTOMERS = [
  'Amara', 'Luca', 'Mei', 'Omar', 'Sofia', 'Kofi', 'Aiko', 'Mateo', 'Priya', 'Noor', 'Jonas', 'Lina',
  'Tariq', 'Elena', 'Yusuf', 'Ines', 'Hana', 'Diego', 'Zara', 'Ravi', 'Anya', 'Tomas', 'Ife', 'Chen',
]

const CORRECT_POINTS = PAY.ticket, SPEED_BONUS_MAX = PAY.speedBonus, XP_PER_CORRECT = 12, XP_COMPLETION = 10
const RECENT_KEPT = 5

interface ShiftRecord {
  id: ShiftId; member: MemberId; workplaceId: string; venueName: string | null
  /** The venue room the shift began in. Missing on practice shifts and on records saved before shifts had a place. */
  site?: ShiftSite | null
  status: Shift['status']; startedAt: Iso; expiresAt: Iso; endedAt: Iso | null
  /** Server-only: the whole ticket list and the seed it came from. */
  seed: number; tasks: WorkTask[]
  /** When the current task was issued, for server-measured answer time. */
  issuedAt: number
  done: TaskOutcome[]; total: number; result: ShiftResult | null
}
interface CareerRecord { points: number; xp: Record<Skill, number>; completed: number; leftEarly: number; recent: ShiftId[] }
interface WorkState { shifts: Record<string, ShiftRecord>; careers: Record<string, CareerRecord> }

const state = (world: World): WorkState => world.slice<WorkState>('work', () => ({ shifts: {}, careers: {} }))

function careerOf(world: World, memberId: MemberId): CareerRecord {
  const careers = state(world).careers
  return careers[memberId] ??= { points: 0, xp: { service: 0, logistics: 0, craft: 0 }, completed: 0, leftEarly: 0, recent: [] }
}

/** Game points from play (work shifts, games). Not credits and not money. */
export const careerPoints = (world: World, memberId: MemberId): number => state(world).careers[memberId]?.points ?? 0

export function addPoints(world: World, memberId: MemberId, points: number, earned?: { kind: 'work' | 'game' | 'gift'; text: string }): void {
  if (!(points > 0)) return
  careerOf(world, memberId).points += Math.floor(points)
  world.touch()
  // Earnings are written to the wallet ledger by the travel module, which owns it.
  if (earned) earningHook(world, memberId, Math.floor(points), earned.kind, earned.text)
}

let earningHook: (world: World, memberId: MemberId, amount: number, kind: 'work' | 'game' | 'gift', text: string) => void = () => undefined
export function setEarningHook(hook: typeof earningHook): void { earningHook = hook }
let spendingHook: (world: World, memberId: MemberId, amount: number, kind: 'food', text: string) => void = () => undefined
export function setSpendingHook(hook: typeof spendingHook): void { spendingHook = hook }
/** Told when a shift closes, after its pay is in the balance. `points` is what the shift paid. */
type ShiftClosed = (world: World, memberId: MemberId, shift: { status: 'completed' | 'left-early' | 'timed-out'; points: number }) => void
const shiftClosedHooks: ShiftClosed[] = []
const shiftClosedHook: ShiftClosed = (world, memberId, shift) => { for (const hook of shiftClosedHooks) { try { hook(world, memberId, shift) } catch (error) { console.error('[work] a shift-closed listener failed', error) } } }
/** Any number of modules may listen. `setShiftClosedHook` is kept as the name the first caller used. */
export function onShiftClosed(hook: ShiftClosed): void { shiftClosedHooks.push(hook) }
export const setShiftClosedHook = onShiftClosed

/** Pay for something with game points. The balance never goes below zero: too little refuses the whole amount. */
/** `spent` writes the purchase into the wallet history (the caller that keeps its own history leaves it out). */
export function spendPoints(world: World, memberId: MemberId, amount: number, spent?: { kind: 'food'; text: string }): void {
  if (!Number.isFinite(amount) || amount < 0) throw new WorldError('invalid', 'That amount is not valid.')
  const cost = Math.ceil(amount)
  if (cost === 0) return
  const career = careerOf(world, memberId)
  const short = cost - career.points
  if (short > 0) throw new WorldError('conflict', `You need ${short} more ${short === 1 ? 'coin' : 'coins'}. Work a shift or play a game to earn them.`)
  career.points -= cost
  world.touch()
  if (spent) spendingHook(world, memberId, cost, spent.kind, spent.text)
}

/** Work shifts finished to the last task. Read by the travel module when it decides a visa. */
export const completedShifts = (world: World, memberId: MemberId): number => state(world).careers[memberId]?.completed ?? 0

const workplaceOf = (workplaceId: string): Workplace => {
  const found = WORKPLACES.find(place => place.id === workplaceId)
  if (!found) throw new WorldError('not_found', 'That workplace was not found.')
  return found
}

function shiftView(rec: ShiftRecord): Shift {
  return {
    id: rec.id, workplaceId: rec.workplaceId, site: rec.site ?? null, status: rec.status, startedAt: rec.startedAt, expiresAt: rec.expiresAt, endedAt: rec.endedAt,
    // Future tickets never leave the service.
    current: rec.status === 'active' ? rec.tasks[rec.done.length] ?? null : null,
    done: rec.done, total: rec.total, result: rec.result,
  }
}

function careerView(world: World, memberId: MemberId): Career {
  const career = careerOf(world, memberId)
  const skills = {} as Career['skills']
  for (const skill of SKILLS) {
    const level = levelForXp(career.xp[skill])
    skills[skill] = { xp: career.xp[skill], level, title: titleFor(skill, level), nextLevelXp: xpForLevel(level + 1) }
  }
  const recent = career.recent.flatMap(shiftId => { const rec = state(world).shifts[shiftId]; return rec ? [shiftView(rec)] : [] })
  return { points: career.points, skills, shifts: { completed: career.completed, leftEarly: career.leftEarly }, recent }
}

function makeTasks(place: Workplace, seed: number): WorkTask[] {
  const random = seededRandom(seed)
  const tasks: WorkTask[] = []
  for (let index = 0; index < place.tasksPerShift; index++) {
    const pool = place.stock.map(item => item.id)
    const wants: string[] = []
    const count = 2 + Math.floor(random() * 3)
    for (let n = 0; n < count; n++) wants.push(pool.splice(Math.floor(random() * pool.length), 1)[0]!)
    tasks.push({ index, customer: CUSTOMERS[Math.floor(random() * CUSTOMERS.length)]!, wants, parSeconds: place.parSeconds })
  }
  return tasks
}

const randomSeed = (): number => globalThis.crypto.getRandomValues(new Uint32Array(1))[0]!

/**
 * Where a new shift is worked. It is placed only when the App names a venue and the rooms module
 * has the member standing in a venue room; the place then comes from that room, never from the
 * App. Anything else is a practice shift. The venue's map category and the counter inside it are
 * still the App's to check: the service has no place index or room plan to hold them against.
 */
function siteFor(world: World, memberId: MemberId, venueName: string | null): ShiftSite | null {
  if (!venueName) return null
  const room = roomOf(world, memberId)
  return room?.ref.kind === 'venue' ? { districtId: room.ref.districtId, placeId: room.ref.placeId, venueName } : null
}

/** Close a shift once. Pays the tasks already done; only a full shift earns the completion bonus. */
function closeShift(world: World, rec: ShiftRecord, status: Exclude<Shift['status'], 'active'>, now: number): void {
  if (rec.status !== 'active') return
  const place = workplaceOf(rec.workplaceId)
  const career = careerOf(world, rec.member)
  const correct = rec.done.filter(task => task.correct).length
  const points = rec.done.reduce((sum, task) => sum + task.points, 0)
  const xp = correct * XP_PER_CORRECT + (status === 'completed' ? XP_COMPLETION : 0)
  const levelBefore = levelForXp(career.xp[place.skill])
  career.xp[place.skill] += xp
  career.points += points
  if (points > 0) earningHook(world, rec.member, points, 'work', `Shift pay · ${rec.done.filter(task => task.correct).length} of ${rec.done.length} tasks right`)
  const levelAfter = levelForXp(career.xp[place.skill])
  rec.status = status
  rec.endedAt = iso(now)
  rec.result = {
    points, xp, skill: place.skill, accuracy: rec.total ? correct / rec.total : 0,
    levelBefore, levelAfter, titleAfter: titleFor(place.skill, levelAfter),
  }
  if (status === 'completed') career.completed++
  else career.leftEarly++
  career.recent.unshift(rec.id)
  // Only the latest few closed shifts are kept; older records are dropped.
  for (const dropped of career.recent.splice(RECENT_KEPT)) delete state(world).shifts[dropped]
  world.touch()
  if (status === 'completed' && levelAfter > levelBefore) {
    emit(world, {
      to: rec.member, category: 'work', kind: 'work.levelup', title: `Level up: ${rec.result.titleAfter}`,
      body: `Your ${place.skill} skill reached level ${levelAfter}.`, link: '/work', dedupeKey: `levelup:${rec.member}:${place.skill}:${levelAfter}`,
    })
  }
  shiftClosedHook(world, rec.member, { status, points })
}

function activeShift(world: World, memberId: MemberId): ShiftRecord | null {
  return Object.values(state(world).shifts).find(rec => rec.member === memberId && rec.status === 'active') ?? null
}

function timeOut(world: World, rec: ShiftRecord, now: number): void {
  closeShift(world, rec, 'timed-out', now)
  emit(world, {
    to: rec.member, category: 'work', kind: 'work.closed', title: `Your shift at ${rec.venueName ?? workplaceOf(rec.workplaceId).name} closed`,
    body: `It ran past ${SHIFT_TIMEOUT_MINUTES} minutes, so it ended and paid for the tasks you finished.`, link: '/work', dedupeKey: `shift:${rec.id}`,
  })
}

/** A shift past its expiry closes the moment anyone looks at it, not only on the next tick. */
function freshActive(world: World, memberId: MemberId): ShiftRecord | null {
  const rec = activeShift(world, memberId)
  if (rec && ms(rec.expiresAt) <= world.now()) { timeOut(world, rec, world.now()); return null }
  return rec
}

function ownShift(world: World, memberId: MemberId, shiftId: ShiftId): ShiftRecord {
  const rec = state(world).shifts[shiftId]
  if (!rec || rec.member !== memberId) throw new WorldError('not_found', 'That shift was not found.')
  return rec
}

export function registerWork(world: World): void {
  world.onTick(now => {
    for (const rec of Object.values(state(world).shifts)) if (rec.status === 'active' && ms(rec.expiresAt) <= now) timeOut(world, rec, now)
  })

  world.register('work.places', empty, ctx => ({ workplaces: WORKPLACES, career: careerView(world, ctx.memberId), active: (a => a ? shiftView(a) : null)(freshActive(world, ctx.memberId)) }))

  world.register('work.start', value => {
    const raw = obj(value)
    return { workplaceId: str(raw, 'workplaceId', { min: 1, max: 40 }), venueName: optStr(raw, 'venueName', { max: 80 }) }
  }, (ctx, input) => {
    const place = workplaceOf(input.workplaceId)
    // One shift at a time; asking again resumes the one in progress.
    const existing = freshActive(world, ctx.memberId)
    if (existing) return { shift: shiftView(existing) }
    world.limit(`work-start:${ctx.memberId}`, 20, 600_000)
    const seed = randomSeed()
    const rec: ShiftRecord = {
      id: newId<ShiftId>('sh'), member: ctx.memberId, workplaceId: place.id, venueName: input.venueName || null,
      site: siteFor(world, ctx.memberId, input.venueName || null), status: 'active',
      startedAt: iso(ctx.now), expiresAt: iso(ctx.now + SHIFT_TIMEOUT_MINUTES * 60_000), endedAt: null,
      seed, tasks: makeTasks(place, seed), issuedAt: ctx.now, done: [], total: place.tasksPerShift, result: null,
    }
    state(world).shifts[rec.id] = rec
    world.touch()
    return { shift: shiftView(rec) }
  })

  world.register('work.answer', value => {
    const raw = obj(value)
    return {
      shiftId: id<ShiftId>(raw, 'shiftId', 'sh'), index: num(raw, 'index', { integer: true, min: 0, max: 50 }),
      handed: list(raw, 'handed', item => {
        if (typeof item !== 'string' || item.length > 40) throw new WorldError('invalid', 'handed must be a list of item ids')
        return item
      }, { max: 12 }),
    }
  }, (ctx, input) => {
    const rec = ownShift(world, ctx.memberId, input.shiftId)
    if (rec.status === 'active' && ms(rec.expiresAt) <= ctx.now) timeOut(world, rec, ctx.now)
    // A closed shift or an index already answered comes back unchanged: no second reward.
    if (rec.status !== 'active' || input.index < rec.done.length) return { shift: shiftView(rec) }
    if (input.index > rec.done.length) throw new WorldError('conflict', 'That task is not the one in front of you.')
    if (rec.site) {
      const room = roomOf(world, ctx.memberId)
      if (room?.ref.kind !== 'venue' || room.ref.districtId !== rec.site.districtId || room.ref.placeId !== rec.site.placeId) {
        throw new WorldError('conflict', `Return to ${rec.site.venueName} before serving the next ticket. You can still leave the shift and keep pay for completed tickets.`)
      }
    }
    const task = rec.tasks[input.index]!
    const correct = input.handed.length === task.wants.length && input.handed.every((item, n) => item === task.wants[n])
    const seconds = Math.min(600, Math.max(0, (ctx.now - rec.issuedAt) / 1000))
    const bonus = Math.round(SPEED_BONUS_MAX * Math.max(0, 1 - seconds / task.parSeconds))
    rec.done.push({ index: task.index, correct, seconds: Math.round(seconds * 10) / 10, points: correct ? CORRECT_POINTS + bonus : 0 })
    rec.issuedAt = ctx.now
    if (rec.done.length >= rec.total) closeShift(world, rec, 'completed', ctx.now)
    world.touch()
    return { shift: shiftView(rec) }
  })

  world.register('work.leave', value => ({ shiftId: id<ShiftId>(obj(value), 'shiftId', 'sh') }), (ctx, input) => {
    const rec = ownShift(world, ctx.memberId, input.shiftId)
    closeShift(world, rec, 'left-early', ctx.now)
    return { shift: shiftView(rec), career: careerView(world, ctx.memberId) }
  })

  world.register('work.career', empty, ctx => ({ career: careerView(world, ctx.memberId) }))
}
