import { chooseArrival } from '../../geo/district.ts'
import type { District, Road } from '../../geo/district.ts'
import type { Vec2 } from '../../shared/geo.ts'
import { CameraObstacles } from '../cameraCollision.ts'
import { navigationFor, pointInPolygon } from '../nav.ts'
import type { StreetNavigator } from '../nav.ts'
import type { ModelName, RegionKit } from './kits.ts'

export interface ModelFootprint { width: number; depth: number; height: number }
export interface Placement { model: ModelName; pos: Vec2; angle: number; seed: number; road: number; side: number; priority?: number }
interface Segment { a: Vec2; b: Vec2; road: Road; index: number; length: number; ux: number; uz: number }
export function seedOf(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619)
  return h >>> 0
}
const random = (seed: number): number => {
  let h = Math.imul(seed ^ (seed >>> 16), 0x45d9f3b)
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}
const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z)
function projection(point: Vec2, s: Segment): { pos: Vec2; distance: number; t: number } {
  const t = Math.max(0, Math.min(s.length, (point.x - s.a.x) * s.ux + (point.z - s.a.z) * s.uz))
  const pos = { x: s.a.x + s.ux * t, z: s.a.z + s.uz * t }
  return { pos, distance: distance(point, pos), t }
}
export function arrivalDirection(district: District): { pos: Vec2; x: number; z: number } {
  const arrival = chooseArrival(district)
  let closest = 25, x = Math.sin(arrival.heading), z = Math.cos(arrival.heading)
  for (const road of district.roads) {
    if (road.tunnel || road.kind === 'rail' || road.kind === 'motorway') continue
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, length = distance(a, b)
      if (length < 1) continue
      const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length
      const t = Math.max(0, Math.min(length, (arrival.pos.x - a.x) * ux + (arrival.pos.z - a.z) * uz))
      const d = Math.hypot(arrival.pos.x - a.x - ux * t, arrival.pos.z - a.z - uz * t)
      if (d >= closest) continue
      closest = d
      const sign = ux * Math.sin(arrival.heading) + uz * Math.cos(arrival.heading) < 0 ? -1 : 1
      x = ux * sign; z = uz * sign
    }
  }
  // Match WorldEngine.arrivalAzimuth. The camera rotates away from mapped buildings after it
  // aligns to the nearest street, so chooseArrival.heading alone can point at the opposite view.
  const navigator = navigationFor(district)
  const pos = navigator.nearestWalkable(arrival.pos) ?? arrival.pos
  const obstacles = new CameraObstacles(district.buildings)
  const preferred = Math.atan2(x, z) + Math.PI
  let best = preferred, bestScore = -Infinity
  for (let index = 0; index < 24; index++) {
    const angle = preferred + index * Math.PI / 12
    const forward = { x: -Math.sin(angle), y: 0, z: -Math.cos(angle) }
    const view = obstacles.distance({ x: pos.x, y: 1.6, z: pos.z }, forward, 32)
    const boom = obstacles.distance({ x: pos.x, y: 2, z: pos.z }, { x: -forward.x, y: 0.18, z: -forward.z }, 4.6)
    let walk = 0
    for (let step = 1; step <= 10; step++) {
      if (!navigator.walkable({ x: pos.x + forward.x * step, z: pos.z + forward.z * step })) break
      walk = step
    }
    const score = view + boom * 3 + walk + Math.abs(Math.cos(angle - preferred)) * 6
    if (score > bestScore) { bestScore = score; best = angle }
  }
  return { pos, x: -Math.sin(best), z: -Math.cos(best) }
}
export function regionPlacements(district: District, navigator: StreetNavigator, kit: RegionKit, footprints: Map<ModelName, ModelFootprint>): Placement[] {
  const segments: Segment[] = [], grid = new Map<string, Segment[]>()
  district.roads.forEach((road, index) => {
    for (let i = 1; i < road.points.length; i++) {
      const a = road.points[i - 1]!, b = road.points[i]!, length = distance(a, b)
      if (length < 0.2) continue
      const s = { a, b, road, index, length, ux: (b.x - a.x) / length, uz: (b.z - a.z) / length }
      segments.push(s)
      const pad = road.width / 2 + 2
      for (let x = Math.floor((Math.min(a.x, b.x) - pad) / 32); x <= Math.floor((Math.max(a.x, b.x) + pad) / 32); x++) for (let z = Math.floor((Math.min(a.z, b.z) - pad) / 32); z <= Math.floor((Math.max(a.z, b.z) + pad) / 32); z++) {
        const key = `${x}:${z}`, cell = grid.get(key)
        if (cell) cell.push(s); else grid.set(key, [s])
      }
    }
  })
  const arrival = arrivalDirection(district)
  const commerce = district.pois.filter(p => /market|shop|mall|grocery|retail|food|restaurant|cafe|clothing|bakery/.test(`${p.category} ${p.subclass}`))
  const commercialGround = district.ground.filter(g => g.kind === 'commercial')
  const busStops = district.pois.filter(p => /bus_stop|bus_station|bus/.test(`${p.category} ${p.subclass}`))
  const post = district.pois.filter(p => /post/.test(`${p.category} ${p.subclass}`))
  const pubs = district.pois.filter(p => /pub|bar|beer/.test(`${p.category} ${p.subclass}`))
  const placements: Placement[] = [], occupied: { pos: Vec2; radius: number }[] = []
  const used = new Set<string>()
  const near = <T extends { pos: Vec2 }>(points: T[], p: Vec2, radius: number): T | undefined => points.find(q => distance(p, q.pos) < radius)
  const available = (point: Vec2, arrivalItem: boolean): boolean => {
    if (!navigator.walkable(point) || distance(point, arrival.pos) < 2.2) return false
    return !(grid.get(`${Math.floor(point.x / 32)}:${Math.floor(point.z / 32)}`) ?? [])
      .some(s => !s.road.tunnel && projection(point, s).distance < s.road.width / 2 + (arrivalItem ? 0.38 : 0.65))
  }
  function place(model: ModelName, s: Segment, t: number, side: number, seed: number, priority = 0, extra = 0): Placement | null {
    const size = footprints.get(model)
    if (!size) return null
    const center = { x: s.a.x + s.ux * t, z: s.a.z + s.uz * t }
    const facesRoad = !['danfo', 'car', 'okada', 'keke', 'bus', 'pole', 'lamp', 'drain', 'canoe', 'gate'].includes(model)
    const heading = Math.atan2(s.ux, s.uz)
    const angle = facesRoad ? heading - side * Math.PI / 2 : heading + (side < 0 ? Math.PI : 0)
    const cos = Math.cos(angle), sin = Math.sin(angle)
    const halfAcross = Math.abs(s.uz * cos + s.ux * sin) * size.width / 2 + Math.abs(s.uz * sin - s.ux * cos) * size.depth / 2
    const across = s.road.width / 2 + (priority ? 0.9 : 1.25) + halfAcross + extra
    const pos = { x: center.x + s.uz * across * side, z: center.z - s.ux * across * side }
    const radius = Math.hypot(size.width, size.depth) / 2 + 0.15
    if (occupied.some(o => distance(o.pos, pos) < o.radius + radius)) return null
    const nx = Math.ceil((size.width + 0.2) / 0.65), nz = Math.ceil((size.depth + 0.2) / 0.65)
    for (let ix = 0; ix <= nx; ix++) for (let iz = 0; iz <= nz; iz++) {
      const x = (ix / nx - .5) * (size.width + .2), z = (iz / nz - .5) * (size.depth + .2)
      if (!available({ x: pos.x + x * cos + z * sin, z: pos.z - x * sin + z * cos }, priority > 0)) return null
    }
    const p = { model, pos, angle, seed, road: s.index, side, priority }
    placements.push(p); occupied.push({ pos, radius }); return p
  }
  // Arrival uses map-aligned clusters first, so global random decor cannot consume these slots.
  if (kit.countryCode === 'NG') {
    const station = district.pois.some(p => distance(p.pos, arrival.pos) < 90 && /bus|rail|station|shop|market/.test(`${p.category} ${p.subclass}`))
    const busy = station || !!near(commerce, arrival.pos, 120)
    const models: ModelName[] = busy
      ? ['rubbish-bin', 'generator', 'lamp', 'produce-goods', 'pos-kiosk', 'rubbish-bin', 'drain', 'palm']
      : ['rubbish-bin', 'lamp', 'generator', 'drain', 'palm', 'rubbish-bin', 'pos-kiosk']
    const candidates = segments.filter(s => !s.road.bridge && !s.road.tunnel && ['major', 'street', 'service', 'pedestrian'].includes(s.road.kind) && projection(arrival.pos, s).distance < 45)
    const slots: { s: Segment; t: number; side: number; score: number }[] = []
    for (const s of candidates) for (let t = .7; t < s.length - .7; t += 1.45) for (const side of [-1, 1]) {
      const center = { x: s.a.x + s.ux * t, z: s.a.z + s.uz * t }
      const dx = center.x - arrival.pos.x, dz = center.z - arrival.pos.z, forward = dx * arrival.x + dz * arrival.z
      if (forward < 7 || forward > 40 || Math.hypot(dx, dz) > 42) continue
      const lateral = Math.abs(dx * arrival.z - dz * arrival.x)
      if (lateral > (forward + 2) * .22) continue
      slots.push({ s, t, side, score: Math.abs(forward - 24) + lateral * 2.5 })
    }
    slots.sort((a, b) => a.score - b.score || a.s.index - b.s.index || a.side - b.side)
    let count = 0
    for (const slot of slots) {
      if (count >= 24) break
      const seed = seedOf(`${district.id}:arrival:${slot.s.index}:${slot.t}:${slot.side}`)
      for (let attempt = 0; attempt < models.length; attempt++) {
        const model = models[(count + attempt) % models.length]!
        const size = footprints.get(model)!
        const half = ['lamp', 'drain', 'pole', 'gate'].includes(model) ? size.width / 2 : size.depth / 2
        const edge = slot.s.road.width / 2 + .9 + half
        const x = slot.s.a.x + slot.s.ux * slot.t + slot.s.uz * edge * slot.side, z = slot.s.a.z + slot.s.uz * slot.t - slot.s.ux * edge * slot.side
        const dx = x - arrival.pos.x, dz = z - arrival.pos.z, forward = dx * arrival.x + dz * arrival.z
        if (forward < 6 || Math.hypot(dx, dz) > 44 || Math.abs(dx * arrival.z - dz * arrival.x) > (forward + 2) * .2) continue
        if (place(model, slot.s, slot.t, slot.side, seed, 1)) { count++; break }
      }
    }
  }
  for (const s of segments) {
    const { road } = s
    if (road.tunnel || road.bridge || !['major', 'street', 'service'].includes(road.kind) || s.length < 9) continue
    const baseSeed = seedOf(`${district.id}:${s.a.x.toFixed(2)}:${s.a.z.toFixed(2)}:${s.b.x.toFixed(2)}:${s.b.z.toFixed(2)}`)
    for (let t = 3 + random(baseSeed) * 5, i = 0; t < s.length - 3; t += 8, i++) for (const side of [-1, 1]) {
      const center = { x: s.a.x + s.ux * t, z: s.a.z + s.uz * t }
      const market = !!near(commerce, center, kit.profile === 'market' ? 115 : 75) || commercialGround.some(g => pointInPolygon(center, g))
      const seed = seedOf(`${baseSeed}:${i}:${side}`)
      if (random(seed) > (market ? Math.min(1, kit.density + .25) : kit.density * (road.kind === 'major' ? .7 : .5))) continue
      const choices = market ? kit.commercial : road.kind === 'major' ? kit.arterial : kit.residential
      let model = choices[Math.floor(random(seed + 1) * choices.length)]!
      const stop = near(busStops, center, 20), postal = near(post, center, 22), pub = near(pubs, center, 22)
      if (kit.countryCode === 'NG' && stop && !used.has(String(stop.placeId))) model = 'shelter'
      if (kit.countryCode === 'NG' && market && random(seed + 3) < .055) model = 'billboard'
      if (kit.profile === 'planned' && model === 'danfo') model = 'car'
      if (kit.id === 'manchester' && postal && !used.has(String(postal.placeId))) model = 'postbox'
      else if (kit.id === 'manchester' && pub && !used.has(String(pub.placeId))) model = 'pubsign'
      const p = place(model, s, t, side, seed)
      if (!p) continue
      if (stop && model === 'shelter') used.add(String(stop.placeId))
      if (postal && model === 'postbox') used.add(String(postal.placeId))
      if (pub && model === 'pubsign') used.add(String(pub.placeId))
      if (market && kit.countryCode === 'NG' && ['stall-red', 'stall-green', 'container-shop', 'kiosk', 'food'].includes(model)) {
        place(random(seed + 4) < .5 ? 'generator' : 'produce-goods', s, Math.min(s.length - 2, t + 3.6), side, seed + 5)
        if (kit.profile !== 'planned') place('shop-goods', s, Math.max(2, t - 3.8), side, seed + 6)
      }
    }
  }
  // Shore furniture stays on dry land adjacent to an actual mapped water polygon.
  if (kit.countryCode === 'NG') for (const water of district.ground.filter(g => g.kind === 'water')) {
    for (let i = 1; i < water.outer.length; i += 3) {
      const a = water.outer[i - 1]!, b = water.outer[i]!, length = distance(a, b)
      if (length < 4) continue
      const midpoint = { x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 }
      for (const side of [-1, 1]) {
        const p = { x: midpoint.x + (b.z - a.z) / length * 5 * side, z: midpoint.z - (b.x - a.x) / length * 5 * side }
        if (!navigator.walkable(p) || pointInPolygon(p, water)) continue
        const closest = segments.filter(s => ['street', 'service', 'path'].includes(s.road.kind)).map(s => ({ s, q: projection(p, s) })).sort((a, b) => a.q.distance - b.q.distance)[0]
        if (!closest || closest.q.distance > 20) continue
        const seed = seedOf(`${district.id}:shore:${i}:${midpoint.x}`)
        place((['canoe', 'mooring-posts', 'net-crates'] satisfies ModelName[])[seed % 3]!, closest.s, closest.q.t, side, seed)
      }
    }
  }
  return placements
}
