import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import type { Vec2 } from '../shared/geo.ts'
import type { HomeLayout, PlacedItem } from '../shared/social.ts'

export type InteriorStationKind = 'counter' | 'till' | 'table' | 'stall' | 'shelf' | 'bench' | 'ticket-desk'

export interface InteriorStation {
  readonly id: string
  readonly kind: InteriorStationKind
  readonly position: Vec2
  readonly facing: number
  readonly pose?: 'idle' | 'sit'
}

export type VenueInteriorKind = 'cafe' | 'market' | 'station' | 'shop' | 'study' | 'lounge'

export interface VenueInteriorPlan {
  readonly kind: VenueInteriorKind
  readonly seed: number
  readonly stations: readonly InteriorStation[]
}

const plans = new WeakMap<HomeLayout, VenueInteriorPlan>()

function venueKind(category: string): VenueInteriorKind {
  if (['cafe', 'restaurant', 'fast_food', 'bar', 'beer', 'bakery', 'ice_cream', 'lodging'].includes(category)) return 'cafe'
  if (['market', 'marketplace', 'grocery'].includes(category)) return 'market'
  if (['railway', 'station', 'railway_station', 'bus', 'bus_station', 'transport', 'transit'].includes(category)) return 'station'
  if (['shop', 'supermarket', 'convenience', 'clothing_store', 'mall', 'pharmacy', 'hairdresser', 'alcohol_shop'].includes(category)) return 'shop'
  if (['library', 'school', 'college', 'museum', 'art_gallery', 'art', 'craft', 'gallery'].includes(category)) return 'study'
  return 'lounge'
}

function station(id: string, kind: InteriorStationKind, x: number, z: number, facing: number, pose?: 'idle' | 'sit'): InteriorStation {
  return { id, kind, position: { x, z }, facing, ...(pose ? { pose } : {}) }
}

function stationsFor(kind: VenueInteriorKind): readonly InteriorStation[] {
  if (kind === 'cafe') return [
    station('counter', 'counter', 6, 0.72, 0, 'idle'),
    station('till', 'till', 3.5, 2.35, Math.PI, 'idle'),
    station('table-1', 'table', 3, 6.35, Math.PI, 'sit'),
    station('table-2', 'table', 9, 6.35, Math.PI, 'sit'),
    station('table-3', 'table', 3, 9.35, Math.PI, 'sit'),
    station('table-4', 'table', 9, 9.35, Math.PI, 'sit'),
  ]
  if (kind === 'market') return [
    station('stall-1', 'stall', 3.05, 2.25, -Math.PI / 2, 'idle'),
    station('stall-2', 'stall', 3.05, 5, -Math.PI / 2, 'idle'),
    station('stall-3', 'stall', 3.05, 7.75, -Math.PI / 2, 'idle'),
    station('stall-4', 'stall', 8.95, 2.25, Math.PI / 2, 'idle'),
    station('stall-5', 'stall', 8.95, 5, Math.PI / 2, 'idle'),
    station('stall-6', 'stall', 8.95, 7.75, Math.PI / 2, 'idle'),
  ]
  if (kind === 'station') return [
    station('ticket-desk', 'ticket-desk', 6, 2.35, Math.PI, 'idle'),
    station('bench-1', 'bench', 3, 5.2, Math.PI / 2, 'sit'),
    station('bench-2', 'bench', 9, 5.2, -Math.PI / 2, 'sit'),
    station('bench-3', 'bench', 3, 8.1, Math.PI / 2, 'sit'),
    station('bench-4', 'bench', 9, 8.1, -Math.PI / 2, 'sit'),
  ]
  if (kind === 'shop') return [
    station('till', 'till', 9.2, 9.35, Math.PI / 2, 'idle'),
    station('shelf-1', 'shelf', 2.1, 2.15, Math.PI, 'idle'),
    station('shelf-2', 'shelf', 4.7, 2.15, Math.PI, 'idle'),
    station('shelf-3', 'shelf', 7.3, 2.15, Math.PI, 'idle'),
    station('shelf-4', 'shelf', 9.9, 2.15, Math.PI, 'idle'),
  ]
  return []
}

/** Build the stable 12 m illustrative room contract used by the existing state caller. */
export function createVenueLayout(category: string, seed: number): HomeLayout {
  let key = 0
  const item = (model: string, x: number, z: number, turns: 0 | 1 | 2 | 3 = 0): PlacedItem => ({
    key: `v${key++}`, model, x, z, turns, productId: null, variantId: null, tints: {},
  })
  const kind = venueKind(category)
  const items: PlacedItem[] = []
  let floor = '#e0d2bd'
  let wall = '#f3efe8'

  if (kind === 'cafe') {
    for (let x = 6; x <= 18; x += 2) items.push(item('kitchenBar', x, 3))
    for (const [x, z] of [[6, 10], [18, 10], [6, 16], [18, 16]] as const) items.push(item('tableRound', x, z))
    items.push(item('pottedPlant', 22, 2), item('pottedPlant', 2, 21))
    floor = seed % 2 ? '#d9b58c' : '#e6cfa8'; wall = '#f6ead7'
  } else if (kind === 'market') {
    for (const x of [4, 20]) for (const z of [4, 10, 16]) items.push(item('kitchenBar', x, z, 1))
    items.push(item('cardboardBoxClosed', 3, 20), item('cardboardBoxClosed', 21, 20), item('pottedPlant', 22, 2))
    floor = '#d6c29e'; wall = '#f4ead7'
  } else if (kind === 'station') {
    for (let x = 8; x <= 16; x += 2) items.push(item('kitchenBar', x, 3))
    items.push(item('pottedPlant', 22, 2), item('trashcan', 2, 20))
    floor = '#d8dadd'; wall = '#edf0f2'
  } else if (kind === 'shop') {
    for (const x of [4, 9, 14, 19]) items.push(item('bookcaseOpen', x, 2))
    items.push(item('kitchenBar', 20, 19, 1), item('kitchenBar', 20, 21, 1), item('cardboardBoxClosed', 3, 21), item('pottedPlant', 22, 2))
    floor = '#e3e5ea'; wall = '#f2f4f7'
  } else if (kind === 'study') {
    for (let i = 0; i < 5; i++) items.push(item('bookcaseClosedWide', 3 + i * 4, 2))
    for (const [x, z] of [[6, 10], [16, 10], [6, 17], [16, 17]] as const) items.push(item('desk', x, z), item('chairDesk', x, z + 2, 2))
    items.push(item('loungeSofa', 12, 22, 2), item('pottedPlant', 22, 22), item('rugRectangle', 12, 13))
    floor = '#cfae86'; wall = '#eef0e6'
  } else {
    items.push(item('loungeSofa', 6, 4), item('loungeSofa', 16, 4), item('tableCoffee', 11, 8), item('rugRectangle', 11, 9), item('loungeChair', 5, 12, 1),
      item('loungeChair', 18, 12, 3), item('pottedPlant', 2, 2), item('pottedPlant', 22, 2), item('lampRoundFloor', 2, 20), item('bench', 12, 20, 2))
  }

  const layout = { width: 12, depth: 12, floor, wall, items }
  plans.set(layout, { kind, seed, stations: stationsFor(kind) })
  return layout
}

export function venuePlanForLayout(layout: HomeLayout): VenueInteriorPlan | null {
  return plans.get(layout) ?? null
}

interface GeometryPart { readonly material: string; readonly geometry: THREE.BufferGeometry }

interface DressingBuilder {
  readonly root: THREE.Group
  readonly parts: GeometryPart[]
}

const COLOURS: Readonly<Record<string, string>> = {
  wood: '#68442d',
  woodLight: '#b98555',
  metal: '#444c52',
  dark: '#24282c',
  fabric: '#476b75',
  goods: '#ffffff',
}

function coloured(geometry: THREE.BufferGeometry, colour: string): THREE.BufferGeometry {
  const count = geometry.getAttribute('position').count
  const value = new THREE.Color(colour)
  const colours = new Float32Array(count * 3)
  for (let index = 0; index < count; index++) value.toArray(colours, index * 3)
  geometry.setAttribute('color', new THREE.BufferAttribute(colours, 3))
  return geometry
}

function addPart(builder: DressingBuilder, material: string, geometry: THREE.BufferGeometry, position: readonly [number, number, number], rotation: readonly [number, number, number] = [0, 0, 0], colour?: string): void {
  const transform = new THREE.Matrix4().compose(
    new THREE.Vector3(...position),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(...rotation)),
    new THREE.Vector3(1, 1, 1),
  )
  const part = colour ? coloured(geometry, colour) : geometry
  builder.parts.push({ material, geometry: part.applyMatrix4(transform) })
}

function box(builder: DressingBuilder, material: string, size: readonly [number, number, number], position: readonly [number, number, number], colour?: string): void {
  addPart(builder, material, new THREE.BoxGeometry(...size), position, [0, 0, 0], colour)
}

function cylinder(builder: DressingBuilder, material: string, radius: number, height: number, position: readonly [number, number, number], colour?: string, rotation: readonly [number, number, number] = [0, 0, 0]): void {
  addPart(builder, material, new THREE.CylinderGeometry(radius, radius, height, 12), position, rotation, colour)
}

function chair(builder: DressingBuilder, x: number, z: number, facing: number): void {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, facing, 0))
  const local = (dx: number, y: number, dz: number): [number, number, number] => {
    const point = new THREE.Vector3(dx, y, dz).applyQuaternion(q)
    return [x + point.x, point.y, z + point.z]
  }
  box(builder, 'fabric', [0.48, 0.1, 0.46], local(0, 0.45, 0))
  box(builder, 'fabric', [0.48, 0.55, 0.1], local(0, 0.75, -0.2))
  for (const dx of [-0.18, 0.18]) for (const dz of [-0.17, 0.17]) box(builder, 'wood', [0.055, 0.43, 0.055], local(dx, 0.215, dz))
}

function bench(builder: DressingBuilder, x: number, z: number, facing: number): void {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(0, facing, 0))
  const local = (dx: number, y: number, dz: number): [number, number, number] => {
    const point = new THREE.Vector3(dx, y, dz).applyQuaternion(q)
    return [x + point.x, point.y, z + point.z]
  }
  box(builder, 'fabric', [1.45, 0.12, 0.5], local(0, 0.44, 0))
  box(builder, 'fabric', [1.45, 0.55, 0.1], local(0, 0.74, -0.2))
  for (const dx of [-0.6, 0.6]) for (const dz of [-0.17, 0.17]) box(builder, 'metal', [0.06, 0.42, 0.06], local(dx, 0.21, dz))
}

function goods(builder: DressingBuilder, centres: readonly Vec2[], y: number, seed: number, spacing: readonly [number, number] = [0.12, 0.17]): void {
  const colours = ['#d95f4f', '#efb449', '#5c9f65', '#527bb5', '#efe0bb', '#9c6cba']
  let index = 0
  for (const centre of centres) {
    for (let row = 0; row < 2; row++) for (let column = -2; column <= 2; column++) {
      const colour = colours[(seed + index) % colours.length]!
      const x = centre.x + column * spacing[0]
      const z = centre.z + (row - 0.5) * spacing[1]
      if ((seed + index) % 3 === 0) cylinder(builder, 'goods', 0.052, 0.18, [x, y + 0.09, z], colour)
      else box(builder, 'goods', [0.1, 0.14 + ((seed + index) % 2) * 0.05, 0.1], [x, y + 0.07, z], colour)
      index++
    }
  }
}

function cafeDressing(builder: DressingBuilder, plan: VenueInteriorPlan): void {
  // Countertop coffee machine. Its base is at the 0.924 m counter height, never on the floor.
  box(builder, 'metal', [0.56, 0.48, 0.42], [6.9, 1.164, 1.5])
  // The working face points toward the door (+z): screen, group head, handle, spouts and cup.
  box(builder, 'dark', [0.42, 0.2, 0.025], [6.9, 1.27, 1.718])
  cylinder(builder, 'metal', 0.12, 0.08, [6.9, 1.13, 1.735], undefined, [Math.PI / 2, 0, 0])
  cylinder(builder, 'dark', 0.025, 0.34, [7.08, 1.13, 1.78], undefined, [0, 0, Math.PI / 2])
  for (const x of [6.84, 6.96]) cylinder(builder, 'dark', 0.018, 0.13, [x, 1.02, 1.75])
  box(builder, 'dark', [0.4, 0.06, 0.3], [6.9, 0.965, 1.62])
  cylinder(builder, 'fabric', 0.075, 0.15, [6.9, 1.07, 1.82])
  cylinder(builder, 'dark', 0.13, 0.2, [6.65, 1.5, 1.5])
  // Till and card pad sit on the customer-facing end of the same counter.
  box(builder, 'dark', [0.42, 0.18, 0.34], [3.5, 1.014, 1.5])
  box(builder, 'metal', [0.3, 0.18, 0.035], [3.5, 1.15, 1.33])
  const seats = plan.stations.filter(entry => entry.kind === 'table')
  for (const seat of seats) chair(builder, seat.position.x, seat.position.z, seat.facing)
}

function marketDressing(builder: DressingBuilder, plan: VenueInteriorPlan): void {
  const centres = plan.stations.filter(entry => entry.kind === 'stall').map(entry => ({
    x: entry.position.x < 6 ? 2 : 10,
    z: entry.position.z,
  }))
  goods(builder, centres, 0.924, plan.seed)
  for (const centre of centres) {
    box(builder, 'woodLight', [0.78, 0.07, 0.72], [centre.x, 0.96, centre.z])
    box(builder, 'wood', [0.72, 0.24, 0.62], [centre.x, 0.79, centre.z])
  }
}

function stationDressing(builder: DressingBuilder, plan: VenueInteriorPlan): void {
  // A recognisable ticket window, without claiming any real timetable or departure.
  box(builder, 'metal', [2.2, 0.08, 0.08], [6, 2.12, 1.37])
  box(builder, 'metal', [0.08, 1.35, 0.08], [4.94, 1.52, 1.37])
  box(builder, 'metal', [0.08, 1.35, 0.08], [7.06, 1.52, 1.37])
  for (const seat of plan.stations.filter(entry => entry.kind === 'bench')) bench(builder, seat.position.x, seat.position.z, seat.facing)
}

interface FurnitureDimensions { readonly width: number; readonly depth: number; readonly height: number }

function shopDressing(builder: DressingBuilder, plan: VenueInteriorPlan, layout: HomeLayout, dimensionsOf: (model: string, turns: number) => FurnitureDimensions): void {
  const shelfItems = layout.items.filter(item => item.model === 'bookcaseOpen')
  const shelfSize = dimensionsOf('bookcaseOpen', 0)
  const shelves = shelfItems.map(item => ({ x: item.x * 0.5, z: item.z * 0.5 }))
  const shelfHeights = [0.22, 0.48, 0.74].map(fraction => shelfSize.height * fraction)
  const stockSpacing: readonly [number, number] = [Math.max(0.08, (shelfSize.width * 0.76 - 0.1) / 4), Math.min(0.15, shelfSize.depth * 0.5)]
  for (const y of shelfHeights) goods(builder, shelves, y, plan.seed + Math.round(y * 100), stockSpacing)
  // A small till on the checkout bar, again lifted to counter height.
  box(builder, 'dark', [0.38, 0.17, 0.3], [10, 1.009, 9.8])
  box(builder, 'metal', [0.28, 0.17, 0.035], [9.81, 1.14, 9.8], undefined)
}

function board(text: readonly string[], width: number, height: number): THREE.Mesh | null {
  if (typeof document === 'undefined') return null
  const canvas = document.createElement('canvas')
  canvas.width = 256; canvas.height = 128
  const context = canvas.getContext('2d')
  if (!context) return null
  context.fillStyle = '#1d2528'; context.fillRect(0, 0, canvas.width, canvas.height)
  context.strokeStyle = '#d6b66c'; context.lineWidth = 5; context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10)
  context.textAlign = 'center'; context.textBaseline = 'middle'
  context.fillStyle = '#f5ebd4'; context.font = '700 20px system-ui, sans-serif'
  context.fillText(text[0] ?? '', 128, 28)
  context.font = '600 13px system-ui, sans-serif'
  for (let index = 1; index < text.length; index++) context.fillText(text[index]!, 128, 31 + index * 23)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const material = new THREE.MeshStandardMaterial({ map: texture, emissiveMap: texture, emissive: '#4a4030', emissiveIntensity: 0.28, roughness: 0.8 })
  material.userData.ownedMaps = [texture]
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material)
  mesh.castShadow = false
  return mesh
}

function addBoard(builder: DressingBuilder, plan: VenueInteriorPlan): void {
  const lines = plan.kind === 'cafe'
    ? ['ILLUSTRATIVE MENU', 'ORDER & PICK UP', 'COFFEE  •  TEA  •  FOOD']
    : plan.kind === 'station'
      ? ['STATION SERVICES', 'TICKETS  •  LOCAL MAP', 'ASK STAFF FOR DEPARTURES']
      : plan.kind === 'market'
        ? ['MARKET STALLS', 'FRESH  •  PANTRY', 'DAILY GOODS']
        : ['SHOP DIRECTORY', 'SHELVES A  •  B  •  C', 'PAY AT THE TILL']
  const sign = board(lines, plan.kind === 'station' ? 3.5 : plan.kind === 'cafe' ? 1.85 : 3, plan.kind === 'station' ? 0.85 : plan.kind === 'cafe' ? 0.72 : 1.15)
  if (!sign) return
  sign.position.set(plan.kind === 'cafe' ? 4.8 : 6, plan.kind === 'station' ? 2.65 : plan.kind === 'cafe' ? 2.25 : 2.18, 0.112)
  sign.name = `${plan.kind} illustrative service board`
  builder.root.add(sign)
}

/** Original low-poly dressing. No downloaded asset or additional licence is involved. */
export function createVenueDressing(plan: VenueInteriorPlan, layout: HomeLayout, dimensionsOf: (model: string, turns: number) => FurnitureDimensions): THREE.Group {
  const builder: DressingBuilder = { root: new THREE.Group(), parts: [] }
  builder.root.name = `${plan.kind} venue dressing`
  if (plan.kind === 'cafe') cafeDressing(builder, plan)
  else if (plan.kind === 'market') marketDressing(builder, plan)
  else if (plan.kind === 'station') stationDressing(builder, plan)
  else if (plan.kind === 'shop') shopDressing(builder, plan, layout, dimensionsOf)
  else return builder.root

  const byMaterial = new Map<string, THREE.BufferGeometry[]>()
  for (const part of builder.parts) {
    const geometries = byMaterial.get(part.material) ?? []
    geometries.push(part.geometry)
    byMaterial.set(part.material, geometries)
  }
  for (const [name, geometries] of byMaterial) {
    const geometry = geometries.length === 1 ? geometries[0]! : mergeGeometries(geometries, false)
    if (!geometry) throw new Error(`Could not merge venue ${name} geometry`)
    const material = new THREE.MeshStandardMaterial({
      color: COLOURS[name] ?? '#ffffff',
      roughness: name === 'metal' || name === 'dark' ? 0.38 : 0.76,
      metalness: name === 'metal' || name === 'dark' ? 0.5 : 0,
      vertexColors: name === 'goods',
    })
    const mesh = new THREE.Mesh(geometry, material)
    mesh.name = `${plan.kind} ${name}`
    mesh.castShadow = true; mesh.receiveShadow = true
    builder.root.add(mesh)
  }
  addBoard(builder, plan)
  builder.root.userData.drawCalls = builder.root.children.filter(child => child instanceof THREE.Mesh).length
  return builder.root
}
