import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

// Detailed local geometry for catalogue pieces that have no honest match in the CC0 source set.
// Each builder uses the legacy material names so saved tints still address the intended part.

const COLOURS: Record<string, string> = {
  _defaultMat: '#d9d2c5',
  carpet: '#9b765f',
  carpetBlue: '#557799',
  carpetDarker: '#5b463b',
  carpetWhite: '#eee8dc',
  fur: '#a97745',
  glass: '#92c2cf',
  lamp: '#ffe2a3',
  metal: '#777b7e',
  metalDark: '#272b2e',
  metalLight: '#c8cccd',
  metalMedium: '#7f878a',
  plant: '#496b3f',
  wood: '#8a5d38',
  woodDark: '#4d3222',
}

interface Builder {
  root: THREE.Group
  materials: Map<string, THREE.MeshStandardMaterial>
  keys: readonly string[]
}

const key = (builder: Builder, ...wanted: string[]): string => wanted.find(name => builder.keys.includes(name)) ?? builder.keys[0] ?? '_defaultMat'

function material(builder: Builder, name: string): THREE.MeshStandardMaterial {
  const existing = builder.materials.get(name)
  if (existing) return existing
  const isGlass = name === 'glass'
  const isLamp = name === 'lamp'
  const isMetal = name.startsWith('metal')
  const created = new THREE.MeshStandardMaterial({
    color: COLOURS[name] ?? '#b7afa2',
    roughness: isGlass ? 0.12 : isMetal ? 0.34 : name.startsWith('carpet') || name === 'fur' ? 0.92 : 0.68,
    metalness: isMetal ? 0.62 : isGlass ? 0.08 : 0,
    transparent: isGlass,
    opacity: isGlass ? 0.34 : 1,
    depthWrite: !isGlass,
    side: isGlass ? THREE.DoubleSide : THREE.FrontSide,
    emissive: isLamp ? new THREE.Color('#ffbb55') : new THREE.Color('#000000'),
    emissiveIntensity: isLamp ? 1.25 : 0,
  })
  created.name = name
  builder.materials.set(name, created)
  return created
}

function mesh(builder: Builder, geometry: THREE.BufferGeometry, materialName: string, x: number, y: number, z: number): THREE.Mesh {
  const result = new THREE.Mesh(geometry, material(builder, materialName))
  result.position.set(x, y, z)
  result.castShadow = materialName !== 'glass'
  result.receiveShadow = true
  builder.root.add(result)
  return result
}

function box(builder: Builder, materialName: string, width: number, height: number, depth: number, x = 0, y = height / 2, z = 0): THREE.Mesh {
  return mesh(builder, new THREE.BoxGeometry(width, height, depth), materialName, x, y, z)
}

function cylinder(builder: Builder, materialName: string, top: number, bottom: number, height: number, x: number, y: number, z: number, rotation: readonly [number, number, number] = [0, 0, 0], segments = 20): THREE.Mesh {
  const result = mesh(builder, new THREE.CylinderGeometry(top, bottom, height, segments), materialName, x, y, z)
  result.rotation.set(...rotation)
  return result
}

function sphere(builder: Builder, materialName: string, radius: number, x: number, y: number, z: number, scale: readonly [number, number, number] = [1, 1, 1]): THREE.Mesh {
  const result = mesh(builder, new THREE.SphereGeometry(radius, 20, 12), materialName, x, y, z)
  result.scale.set(...scale)
  return result
}

function torus(builder: Builder, materialName: string, radius: number, tube: number, x: number, y: number, z: number, scale: readonly [number, number, number] = [1, 1, 1], rotation: readonly [number, number, number] = [0, 0, 0]): THREE.Mesh {
  const result = mesh(builder, new THREE.TorusGeometry(radius, tube, 10, 28), materialName, x, y, z)
  result.scale.set(...scale)
  result.rotation.set(...rotation)
  return result
}

function handle(builder: Builder, x: number, y: number, z: number, width = 0.34, vertical = false): void {
  const metal = key(builder, 'metal', 'metalDark', 'metalLight', 'metalMedium')
  if (vertical) {
    cylinder(builder, metal, 0.025, 0.025, width, x, y, z, [0, 0, 0], 12)
    sphere(builder, metal, 0.032, x, y - width / 2, z)
    sphere(builder, metal, 0.032, x, y + width / 2, z)
  } else {
    cylinder(builder, metal, 0.025, 0.025, width, x, y, z, [0, 0, Math.PI / 2], 12)
    sphere(builder, metal, 0.032, x - width / 2, y, z)
    sphere(builder, metal, 0.032, x + width / 2, y, z)
  }
}

function fourLegs(builder: Builder, width: number, depth: number, height: number, materialName: string): void {
  for (const x of [-width / 2, width / 2]) for (const z of [-depth / 2, depth / 2]) box(builder, materialName, 0.09, height, 0.09, x, height / 2, z)
}

function applianceFace(builder: Builder, y: number, radius = 0.29): void {
  const metal = key(builder, 'metalDark', 'metalMedium', 'metal')
  const glass = key(builder, 'glass', 'metalDark')
  cylinder(builder, metal, radius + 0.045, radius + 0.045, 0.055, 0, y, 0.506, [Math.PI / 2, 0, 0], 28)
  cylinder(builder, glass, radius, radius, 0.06, 0, y, 0.54, [Math.PI / 2, 0, 0], 28)
  sphere(builder, key(builder, 'metalLight', 'metalMedium'), 0.045, 0.31, y + 0.36, 0.55)
}

function cabinet(builder: Builder, width = 1, height = 1, depth = 0.58, drawers = 0): void {
  const wood = key(builder, 'wood', '_defaultMat')
  const dark = key(builder, 'woodDark', 'metalDark', wood)
  box(builder, dark, width, height, depth)
  box(builder, wood, width * 0.92, 0.055, depth + 0.04, 0, height + 0.027, 0)
  if (drawers) {
    for (let i = 0; i < drawers; i++) {
      const h = height * 0.84 / drawers
      const y = 0.07 + h * (i + 0.5)
      box(builder, wood, width * 0.88, h - 0.035, 0.035, 0, y, depth / 2 + 0.025)
      handle(builder, 0, y, depth / 2 + 0.065, Math.min(0.34, width * 0.38))
    }
  } else {
    for (const x of [-width * 0.23, width * 0.23]) {
      box(builder, wood, width * 0.43, height * 0.82, 0.035, x, height * 0.48, depth / 2 + 0.025)
      sphere(builder, key(builder, 'metal', 'metalDark'), 0.028, x + Math.sign(-x) * width * 0.12, height * 0.48, depth / 2 + 0.07)
    }
  }
  fourLegs(builder, width * 0.42, depth * 0.34, 0.08, dark)
}

function buildBathroom(builder: Builder, name: string): void {
  const white = key(builder, 'carpetWhite', '_defaultMat', 'metalLight')
  const metal = key(builder, 'metalLight', 'metal', 'metalDark')
  const glass = key(builder, 'glass', 'metalDark')
  if (name === 'bathroomCabinet') { cabinet(builder, 0.72, 1.05, 0.34, 0); return }
  if (name === 'bathroomCabinetDrawer') { cabinet(builder, 1, 0.88, 0.58, 3); return }
  if (name === 'bathroomMirror') {
    box(builder, key(builder, 'wood', 'metal'), 0.82, 1.08, 0.07, 0, 0.66, 0)
    box(builder, glass, 0.7, 0.94, 0.035, 0, 0.66, 0.055)
    box(builder, metal, 0.5, 0.035, 0.04, 0, 0.12, 0.08)
    return
  }
  if (name === 'bathroomSink' || name === 'bathroomSinkSquare') {
    if (name === 'bathroomSink') {
      cylinder(builder, white, 0.17, 0.25, 0.72, 0, 0.36, 0, [0, 0, 0], 24)
      sphere(builder, white, 0.47, 0, 0.78, 0, [1.05, 0.34, 0.78])
    } else {
      box(builder, white, 0.9, 0.24, 0.58, 0, 0.76, 0)
      box(builder, white, 0.56, 0.64, 0.36, 0, 0.36, -0.04)
    }
    sphere(builder, key(builder, 'metalDark', white), 0.18, 0, 0.86, 0.05, [1.45, 0.28, 1])
    cylinder(builder, metal, 0.035, 0.035, 0.28, 0, 1.02, -0.12)
    torus(builder, metal, 0.12, 0.025, 0, 1.09, -0.02, [1, 1, 0.72], [Math.PI / 2, 0, 0])
    return
  }
  if (name === 'bathtub') {
    box(builder, white, 1.9, 0.62, 0.86, 0, 0.31, 0)
    box(builder, key(builder, 'metalDark', white), 1.62, 0.18, 0.58, 0, 0.57, 0)
    box(builder, white, 1.72, 0.08, 0.68, 0, 0.69, 0)
    box(builder, key(builder, 'metalDark', white), 1.5, 0.09, 0.47, 0, 0.72, 0)
    cylinder(builder, metal, 0.03, 0.03, 0.3, 0.68, 0.85, -0.25)
    torus(builder, metal, 0.12, 0.025, 0.56, 0.94, -0.2, [1, 1, 0.7], [Math.PI / 2, 0, 0])
    return
  }
  if (name === 'shower' || name === 'showerRound') {
    const round = name === 'showerRound'
    if (round) cylinder(builder, white, 0.62, 0.66, 0.12, 0, 0.06, 0, [0, 0, 0], 28)
    else box(builder, white, 1.15, 0.12, 1.05, 0, 0.06, 0)
    for (const x of [-0.52, 0.52]) cylinder(builder, metal, 0.025, 0.025, 2.05, x, 1.08, -0.46)
    box(builder, glass, 1.04, 1.92, 0.025, 0, 1.08, -0.45)
    box(builder, glass, 0.025, 1.92, 0.92, -0.52, 1.08, 0.02)
    cylinder(builder, metal, 0.025, 0.025, 1.55, 0.34, 1.12, 0.43)
    torus(builder, metal, 0.17, 0.025, 0.25, 1.85, 0.43, [1, 1, 0.65], [Math.PI / 2, 0, 0])
    cylinder(builder, metal, 0.15, 0.15, 0.035, 0.25, 1.75, 0.45, [Math.PI / 2, 0, 0], 24)
    return
  }
  if (name === 'toilet' || name === 'toiletSquare') {
    const square = name === 'toiletSquare'
    box(builder, white, 0.62, 0.75, 0.34, 0, 0.62, -0.33)
    if (square) box(builder, white, 0.65, 0.35, 0.72, 0, 0.33, 0.12)
    else sphere(builder, white, 0.44, 0, 0.35, 0.13, [0.8, 0.52, 1.15])
    torus(builder, white, 0.29, 0.055, 0, 0.52, 0.17, [1, 1.18, 1], [Math.PI / 2, 0, 0])
    sphere(builder, metal, 0.035, 0.2, 0.85, -0.51)
  }
}

function buildBedside(builder: Builder, name: string): void {
  const drawers = name === 'cabinetBed' ? 0 : name === 'cabinetBedDrawer' ? 1 : 2
  cabinet(builder, 0.76, 0.64, 0.62, drawers)
  if (name === 'cabinetBedDrawerTable') box(builder, key(builder, 'wood', '_defaultMat'), 0.92, 0.06, 0.78, 0, 0.75, 0)
}

function buildBunk(builder: Builder): void {
  const wood = key(builder, 'wood')
  const linen = key(builder, 'carpetWhite', 'carpet')
  const blanket = key(builder, 'carpet', linen)
  for (const y of [0.42, 1.42]) {
    box(builder, wood, 1.12, 0.14, 2.05, 0, y, 0)
    box(builder, linen, 0.98, 0.18, 1.9, 0, y + 0.16, 0)
    box(builder, blanket, 1, 0.055, 1.05, 0, y + 0.275, 0.32)
  }
  for (const x of [-0.51, 0.51]) for (const z of [-0.98, 0.98]) box(builder, wood, 0.09, 2.05, 0.09, x, 1.03, z)
  for (const z of [-0.98, 0.98]) box(builder, wood, 1.1, 0.08, 0.08, 0, 1.98, z)
  for (const y of [0.62, 0.92, 1.22, 1.52, 1.82]) box(builder, wood, 0.54, 0.055, 0.06, 0.78, y, 0.82)
  for (const x of [0.53, 1.02]) box(builder, wood, 0.06, 1.36, 0.06, x, 1.2, 0.82)
  box(builder, wood, 1.02, 0.08, 0.08, 0, 1.78, 0.98)
}

function buildBench(builder: Builder, low: boolean): void {
  const wood = key(builder, 'wood', '_defaultMat')
  const fabric = key(builder, 'carpet', '_defaultMat')
  const seatY = low ? 0.32 : 0.5
  fourLegs(builder, 0.76, 0.34, seatY, wood)
  box(builder, wood, 1, 0.1, 0.52, 0, seatY, 0)
  box(builder, fabric, 0.94, 0.16, 0.48, 0, seatY + 0.13, 0)
  if (!low) {
    box(builder, wood, 0.08, 0.72, 0.08, -0.46, 0.83, -0.21)
    box(builder, wood, 0.08, 0.72, 0.08, 0.46, 0.83, -0.21)
    box(builder, fabric, 0.88, 0.48, 0.12, 0, 0.92, -0.21)
  }
}

function buildBookcase(builder: Builder): void {
  const wood = key(builder, 'wood')
  const metal = key(builder, 'metal', wood)
  box(builder, wood, 1, 1.85, 0.48)
  for (const x of [-0.245, 0.245]) box(builder, wood, 0.46, 1.7, 0.035, x, 0.92, 0.255)
  for (const y of [0.36, 0.76, 1.16, 1.56]) box(builder, wood, 0.94, 0.045, 0.5, 0, y, 0)
  for (const x of [-0.07, 0.07]) handle(builder, x, 0.92, 0.3, 0.26, true)
  box(builder, metal, 0.06, 0.03, 0.02, 0, 1.72, 0.3)
}

function buildComputer(builder: Builder, name: string): void {
  const dark = key(builder, 'metalDark', 'metal')
  const medium = key(builder, 'metalMedium', 'metal', dark)
  if (name === 'computerKeyboard') {
    box(builder, dark, 1, 0.1, 0.38)
    for (let row = 0; row < 4; row++) for (let col = 0; col < 12; col++) box(builder, medium, 0.057, 0.025, 0.052, -0.36 + col * 0.066, 0.068, -0.11 + row * 0.07)
    box(builder, medium, 0.34, 0.025, 0.052, 0, 0.068, 0.17)
    return
  }
  if (name === 'computerMouse') {
    sphere(builder, dark, 0.32, 0, 0.2, 0, [0.66, 0.52, 1])
    box(builder, medium, 0.018, 0.12, 0.22, 0, 0.35, -0.04)
    cylinder(builder, medium, 0.035, 0.035, 0.08, 0, 0.39, -0.08, [Math.PI / 2, 0, 0], 12)
    return
  }
  box(builder, dark, 1.15, 0.72, 0.08, 0, 0.7, 0)
  box(builder, key(builder, 'metal', medium), 1.03, 0.6, 0.025, 0, 0.7, 0.055)
  cylinder(builder, medium, 0.055, 0.055, 0.4, 0, 0.24, 0)
  box(builder, dark, 0.48, 0.055, 0.28, 0, 0.035, 0)
  sphere(builder, medium, 0.025, 0.47, 0.39, 0.07)
}

function buildDesk(builder: Builder, corner: boolean): void {
  const wood = key(builder, 'wood')
  const metal = key(builder, 'metal', wood)
  box(builder, wood, 1.55, 0.1, 0.7, 0, 0.82, 0)
  fourLegs(builder, 1.38, 0.52, 0.8, metal)
  box(builder, wood, 0.48, 0.12, 0.48, 0.44, 0.72, 0)
  if (corner) {
    box(builder, wood, 0.7, 0.1, 1.5, 0.43, 0.82, 0.42)
    for (const z of [0.05, 1.08]) box(builder, metal, 0.09, 0.8, 0.09, 0.72, 0.4, z)
  }
}

function buildDoor(builder: Builder, name: string): void {
  const wood = key(builder, 'wood', '_defaultMat')
  const trim = key(builder, 'metal', 'metalDark', wood)
  const width = 1.05
  const height = 2.15
  for (const x of [-width / 2, width / 2]) box(builder, trim, 0.12, height, 0.14, x, height / 2, 0)
  box(builder, trim, width + 0.12, 0.12, 0.14, 0, height, 0)
  if (name === 'doorwayOpen') return
  box(builder, wood, 0.92, 1.98, 0.09, 0, 1, 0)
  if (name === 'doorwayFront') {
    box(builder, key(builder, 'glass', 'metalDark'), 0.52, 0.72, 0.025, 0, 1.43, 0.06)
    for (const x of [-0.29, 0.29]) box(builder, trim, 0.06, 0.82, 0.05, x, 1.43, 0.08)
    box(builder, trim, 0.62, 0.06, 0.05, 0, 1.06, 0.08)
  } else for (const y of [0.44, 0.98, 1.52]) box(builder, key(builder, 'woodDark', trim), 0.66, 0.06, 0.04, 0, y, 0.065)
  sphere(builder, key(builder, 'metal', 'metalDark'), 0.055, 0.32, 1, 0.09)
}

function buildFan(builder: Builder): void {
  const metal = key(builder, 'metalLight', 'metal')
  const wood = key(builder, 'wood', metal)
  cylinder(builder, metal, 0.06, 0.06, 0.42, 0, 0.94, 0)
  sphere(builder, metal, 0.17, 0, 0.7, 0, [1, 0.58, 1])
  for (let i = 0; i < 4; i++) {
    const angle = i * Math.PI / 2
    const blade = box(builder, wood, 0.75, 0.045, 0.19, Math.cos(angle) * 0.42, 0.7, Math.sin(angle) * 0.42)
    blade.rotation.y = -angle
  }
  cylinder(builder, key(builder, 'lamp', metal), 0.18, 0.23, 0.18, 0, 0.55, 0)
}

function buildFloor(builder: Builder, name: string): void {
  const wood = key(builder, 'wood')
  const half = name === 'floorHalf'
  const width = half ? 0.5 : 1
  if (name === 'floorCornerRound') {
    cylinder(builder, wood, 0.72, 0.72, 0.08, 0, 0.04, 0, [0, 0, 0], 32)
  } else box(builder, wood, width, 0.08, 1)
  const plankCount = half ? 3 : 6
  for (let i = 1; i < plankCount; i++) box(builder, key(builder, 'woodDark', wood), 0.012, 0.006, 0.99, -width / 2 + i * width / plankCount, 0.084, 0)
}

function buildHood(builder: Builder, modern: boolean): void {
  const body = key(builder, modern ? 'metalMedium' : 'metalDark', '_defaultMat')
  box(builder, body, 0.92, 0.56, 0.5, 0, 0.94, -0.04)
  box(builder, body, 0.42, 0.82, 0.36, 0, 1.58, -0.08)
  box(builder, key(builder, '_defaultMat', 'metalMedium'), 0.76, 0.035, 0.35, 0, 0.64, 0.02)
  for (const x of [-0.28, -0.09, 0.09, 0.28]) box(builder, key(builder, '_defaultMat', body), 0.12, 0.02, 0.3, x, 0.61, 0.04)
}

function buildKitchen(builder: Builder, name: string): void {
  const wood = key(builder, 'wood', '_defaultMat')
  const dark = key(builder, 'woodDark', 'metalDark', wood)
  const metal = key(builder, 'metalLight', 'metalMedium', 'metal', dark)
  if (name === 'hoodLarge' || name === 'hoodModern') { buildHood(builder, name === 'hoodModern'); return }
  if (name === 'kitchenBar' || name === 'kitchenBarEnd') {
    const width = name === 'kitchenBarEnd' ? 0.38 : 1.35
    box(builder, dark, width, 0.88, 0.55)
    box(builder, wood, width + 0.08, 0.09, 0.72, 0, 0.93, 0.04)
    if (name === 'kitchenBar') for (const x of [-0.42, 0, 0.42]) box(builder, wood, 0.36, 0.68, 0.035, x, 0.46, 0.295)
    return
  }
  if (name.startsWith('kitchenCabinet')) {
    const upper = name.includes('Upper')
    const low = name.includes('Low')
    const corner = name.includes('Corner')
    const width = corner && name === 'kitchenCabinetUpperCorner' ? 0.62 : 1
    const height = low ? 0.48 : upper ? 0.9 : 0.98
    const depth = upper ? 0.42 : corner ? 0.82 : 0.62
    if (corner) {
      box(builder, dark, width, height, depth)
      box(builder, wood, width * 0.48, height * 0.84, 0.035, -width * 0.24, height * 0.48, depth / 2 + 0.025)
      box(builder, wood, 0.035, height * 0.84, depth * 0.48, width / 2 + 0.025, height * 0.48, depth * 0.24)
      if (name.includes('Round')) cylinder(builder, metal, 0.06, 0.06, height * 0.7, -width * 0.06, height * 0.5, depth / 2 + 0.07)
    } else cabinet(builder, width, height, depth, name.includes('Drawer') ? 3 : 0)
    if (!upper) box(builder, metal, width + 0.04, 0.055, depth + 0.05, 0, height + 0.04, 0)
    return
  }
  if (name === 'kitchenBlender') {
    cylinder(builder, metal, 0.27, 0.31, 0.32, 0, 0.16, 0, [0, 0, 0], 18)
    cylinder(builder, key(builder, 'glass', metal), 0.22, 0.16, 0.54, 0, 0.58, 0, [0, 0, 0], 18)
    box(builder, metal, 0.45, 0.08, 0.4, 0, 0.9, 0)
    sphere(builder, key(builder, 'metal', metal), 0.035, 0, 0.18, 0.29)
    return
  }
  if (name === 'kitchenCoffeeMachine') {
    box(builder, metal, 0.72, 0.82, 0.65, 0, 0.46, -0.05)
    box(builder, dark, 0.56, 0.24, 0.45, 0, 0.47, 0.3)
    box(builder, metal, 0.54, 0.06, 0.42, 0, 0.13, 0.31)
    cylinder(builder, metal, 0.045, 0.045, 0.3, 0.22, 0.37, 0.36)
    torus(builder, key(builder, 'carpetWhite', metal), 0.18, 0.04, 0, 0.35, 0.38, [1, 1.15, 1], [Math.PI / 2, 0, 0])
    for (const x of [-0.18, 0, 0.18]) sphere(builder, dark, 0.035, x, 0.76, 0.3)
    return
  }
  if (name.startsWith('kitchenFridge')) {
    const wide = name === 'kitchenFridgeLarge'
    const builtIn = name === 'kitchenFridgeBuiltIn'
    const width = wide ? 1.25 : 0.92
    box(builder, builtIn ? wood : metal, width, 1.95, 0.72)
    if (wide) {
      box(builder, metal, width * 0.49, 1.82, 0.045, -width * 0.25, 1, 0.385)
      box(builder, metal, width * 0.49, 1.82, 0.045, width * 0.25, 1, 0.385)
      handle(builder, -0.09, 1.12, 0.46, 0.72, true)
      handle(builder, 0.09, 1.12, 0.46, 0.72, true)
    } else {
      box(builder, metal, width * 0.92, 1.22, 0.045, 0, 0.72, 0.385)
      box(builder, metal, width * 0.92, 0.56, 0.045, 0, 1.63, 0.385)
      handle(builder, width * 0.32, 0.8, 0.46, 0.52, true)
      handle(builder, width * 0.32, 1.55, 0.46, 0.3, true)
    }
    if (builtIn) for (const x of [-width / 2 - 0.05, width / 2 + 0.05]) box(builder, wood, 0.08, 2.04, 0.82, x, 1.02, 0)
    if (name !== 'kitchenFridgeSmall') box(builder, key(builder, 'glass', dark), 0.24, 0.3, 0.03, -width * 0.22, 1.05, 0.43)
    return
  }
  if (name === 'kitchenSink') {
    cabinet(builder, 1.1, 0.86, 0.66, 0)
    box(builder, metal, 1.14, 0.08, 0.7, 0, 0.92, 0)
    box(builder, dark, 0.62, 0.035, 0.43, 0, 0.97, 0.02)
    torus(builder, metal, 0.2, 0.035, 0, 1.16, -0.15, [1, 1, 0.72], [Math.PI / 2, 0, 0])
    cylinder(builder, metal, 0.04, 0.04, 0.28, -0.19, 1.08, -0.16)
    return
  }
  if (name === 'toaster') {
    box(builder, metal, 0.76, 0.42, 0.48, 0, 0.23, 0)
    for (const z of [-0.1, 0.1]) box(builder, dark, 0.54, 0.025, 0.05, 0, 0.45, z)
    cylinder(builder, dark, 0.035, 0.035, 0.18, 0.42, 0.25, 0, [0, 0, 0], 12)
    sphere(builder, dark, 0.04, 0.42, 0.12, 0.12)
  }
}

function buildLaundry(builder: Builder, name: string): void {
  const body = key(builder, 'metalLight', 'metalMedium')
  if (name === 'washerDryerStacked') {
    box(builder, body, 0.86, 1.92, 0.82, 0, 0.96, 0)
    applianceFace(builder, 0.5, 0.25)
    applianceFace(builder, 1.42, 0.25)
  } else {
    box(builder, body, 0.9, 0.94, 0.82, 0, 0.47, 0)
    applianceFace(builder, 0.46)
  }
  const dark = key(builder, 'metalDark', 'metalMedium')
  box(builder, dark, 0.38, 0.06, 0.025, -0.18, name === 'washerDryerStacked' ? 1.86 : 0.86, 0.43)
  for (const x of [0.16, 0.28, 0.4]) sphere(builder, dark, 0.027, x, name === 'washerDryerStacked' ? 1.86 : 0.86, 0.45)
}

function buildLamp(builder: Builder, name: string): void {
  const metal = key(builder, 'metal', 'metalLight')
  const light = key(builder, 'lamp', metal)
  if (name === 'lampSquareCeiling') {
    box(builder, metal, 0.12, 0.44, 0.12, 0, 0.22, 0)
    box(builder, light, 0.54, 0.26, 0.54, 0, 0.55, 0)
    return
  }
  if (name === 'lampWall') {
    box(builder, metal, 0.12, 0.48, 0.12, 0, 0.5, -0.2)
    box(builder, light, 0.62, 0.42, 0.38, 0, 0.5, 0.02)
    return
  }
  const square = name === 'lampSquareFloor'
  if (square) box(builder, metal, 0.46, 0.07, 0.46, 0, 0.035, 0)
  else cylinder(builder, metal, 0.25, 0.32, 0.07, 0, 0.035, 0)
  cylinder(builder, metal, 0.035, 0.045, 1.58, 0, 0.83, 0)
  if (square) box(builder, light, 0.52, 0.52, 0.52, 0, 1.64, 0)
  else cylinder(builder, light, 0.28, 0.48, 0.55, 0, 1.64, 0, [0, 0, 0], 28)
}

function buildCoatRack(builder: Builder, standing: boolean): void {
  const wood = key(builder, 'wood', 'metalMedium')
  if (!standing) {
    box(builder, wood, 1.2, 0.13, 0.12, 0, 0.65, 0)
    for (const x of [-0.42, -0.14, 0.14, 0.42]) {
      cylinder(builder, key(builder, 'metalMedium', wood), 0.035, 0.035, 0.22, x, 0.54, 0.06, [Math.PI / 2, 0, 0], 12)
      sphere(builder, key(builder, 'metalMedium', wood), 0.055, x, 0.54, 0.19)
    }
    return
  }
  cylinder(builder, wood, 0.05, 0.07, 1.75, 0, 0.88, 0, [0, 0, 0], 16)
  cylinder(builder, wood, 0.42, 0.5, 0.09, 0, 0.045, 0, [0, 0, 0], 20)
  for (let i = 0; i < 6; i++) {
    const angle = i * Math.PI / 3
    const arm = cylinder(builder, wood, 0.035, 0.035, 0.48, Math.cos(angle) * 0.16, 1.58, Math.sin(angle) * 0.16, [0, 0, Math.PI / 3], 12)
    arm.rotation.y = -angle
    sphere(builder, wood, 0.055, Math.cos(angle) * 0.39, 1.72, Math.sin(angle) * 0.39)
  }
}

function buildRug(builder: Builder, name: string): void {
  const main = key(builder, 'carpet', 'carpetDarker', 'wood')
  const accent = key(builder, 'carpetDarker', 'carpet', main)
  const round = name === 'rugRound'
  const square = name === 'rugSquare'
  const doormat = name === 'rugDoormat'
  if (round) {
    cylinder(builder, main, 0.75, 0.75, 0.035, 0, 0.018, 0, [0, 0, 0], 40)
    torus(builder, accent, 0.58, 0.045, 0, 0.042, 0, [1, 1, 1], [Math.PI / 2, 0, 0])
  } else {
    const width = doormat ? 0.9 : square ? 1.45 : 2.25
    const depth = doormat ? 0.5 : square ? 1.45 : 1.34
    box(builder, main, width, 0.035, depth)
    box(builder, accent, width * 0.86, 0.008, depth * 0.08, 0, 0.023, -depth * 0.34)
    box(builder, accent, width * 0.86, 0.008, depth * 0.08, 0, 0.023, depth * 0.34)
    if (!doormat) for (const x of [-width * 0.36, -width * 0.12, width * 0.12, width * 0.36]) box(builder, accent, width * 0.045, 0.008, depth * 0.48, x, 0.023, 0)
  }
}

function buildSofaCorner(builder: Builder): void {
  const fabric = key(builder, 'carpet', 'carpetBlue')
  const frame = key(builder, 'wood', 'metal')
  box(builder, frame, 2.2, 0.28, 0.86, -0.25, 0.28, 0)
  box(builder, frame, 0.86, 0.28, 1.5, 0.42, 0.28, 0.42)
  for (const x of [-0.86, -0.28, 0.3]) box(builder, fabric, 0.52, 0.22, 0.64, x, 0.47, 0)
  for (const z of [0.54, 1.08]) box(builder, fabric, 0.64, 0.22, 0.5, 0.42, 0.47, z)
  box(builder, fabric, 2.08, 0.72, 0.18, -0.25, 0.86, -0.35)
  box(builder, fabric, 0.18, 0.72, 1.4, 0.77, 0.86, 0.42)
  box(builder, fabric, 0.18, 0.58, 0.84, -1.35, 0.65, 0)
  for (const x of [-0.9, 0.45]) for (const z of [-0.28, 0.95]) box(builder, frame, 0.09, 0.22, 0.09, x, 0.11, z)
}

function buildSpeaker(builder: Builder, small: boolean): void {
  const wood = key(builder, 'wood', 'metalMedium')
  const cone = key(builder, 'metalMedium', 'metalDark', wood)
  const height = small ? 0.72 : 1.4
  box(builder, wood, 0.46, height, 0.42)
  const ys = small ? [0.25, 0.51] : [0.28, 0.7, 1.12]
  for (const [index, y] of ys.entries()) {
    const radius = index === 1 ? 0.14 : 0.1
    cylinder(builder, cone, radius + 0.03, radius + 0.03, 0.035, 0, y, 0.23, [Math.PI / 2, 0, 0], 24)
    cylinder(builder, key(builder, 'metalDark', cone), radius, radius, 0.045, 0, y, 0.25, [Math.PI / 2, 0, 0], 24)
  }
}

function buildStairs(builder: Builder, name: string): void {
  const wood = key(builder, 'wood')
  const dark = key(builder, 'woodDark', 'metal', wood)
  const open = name.startsWith('stairsOpen')
  const corner = name === 'stairsCorner'
  const steps = 10
  for (let i = 0; i < steps; i++) {
    const y = (i + 0.5) * 0.16
    const z = -0.9 + i * 0.18
    box(builder, wood, 1.05, open ? 0.09 : (i + 1) * 0.16, 0.22, 0, open ? y : (i + 1) * 0.08, z)
  }
  if (corner) {
    box(builder, wood, 1.05, 0.16, 1.05, 0, 1.68, 1.04)
    for (let i = 0; i < 6; i++) box(builder, wood, 0.22, (i + 1) * 0.16, 1.05, 0.42 - i * 0.18, 1.68 + (i + 1) * 0.08, 1.04)
  }
  if (open || corner) {
    for (let i = 0; i <= 5; i++) box(builder, dark, 0.055, 0.82, 0.055, 0.58, 0.74 + i * 0.3, -0.85 + i * 0.36)
    const rail = box(builder, dark, 0.06, 0.06, 2.2, 0.58, 1.55, 0)
    rail.rotation.x = -0.72
  }
}

function buildTable(builder: Builder, name: string): void {
  const glassTop = name.includes('Glass') || name === 'tableGlass'
  const cloth = name.includes('Cloth')
  const square = name.includes('Square')
  const coffee = name.startsWith('tableCoffee')
  const wood = key(builder, 'wood', 'metal')
  const frame = key(builder, 'metal', wood)
  const top = glassTop ? key(builder, 'glass', frame) : wood
  const width = coffee ? square ? 0.92 : 1.4 : 1.65
  const depth = coffee ? 0.86 : 0.9
  const height = coffee ? 0.5 : 0.78
  if (name.startsWith('tableCross')) {
    const legA = box(builder, wood, 0.12, height, 1.12, 0, height / 2, 0)
    legA.rotation.z = 0.63
    const legB = box(builder, wood, 0.12, height, 1.12, 0, height / 2, 0)
    legB.rotation.z = -0.63
  } else if (glassTop) {
    box(builder, frame, width * 0.72, 0.08, 0.08, 0, height / 2, 0)
    box(builder, frame, 0.08, height, depth * 0.72, 0, height / 2, 0)
    for (const x of [-width * 0.42, width * 0.42]) for (const z of [-depth * 0.38, depth * 0.38]) box(builder, frame, 0.065, height, 0.065, x, height / 2, z)
  } else fourLegs(builder, width * 0.84, depth * 0.72, height, frame)
  box(builder, top, width, 0.075, depth, 0, height, 0)
  if (cloth) {
    box(builder, key(builder, 'carpet', top), width * 0.94, 0.035, depth * 0.94, 0, height + 0.05, 0)
    for (const z of [-depth * 0.48, depth * 0.48]) box(builder, key(builder, 'carpet', top), width * 0.82, 0.34, 0.035, 0, height - 0.13, z)
  }
}

function buildTelevision(builder: Builder): void {
  const dark = key(builder, 'metalDark', 'metal')
  const trim = key(builder, 'metal', dark)
  box(builder, dark, 1.45, 0.82, 0.11, 0, 0.66, 0)
  box(builder, trim, 1.31, 0.68, 0.03, 0, 0.67, 0.075)
  box(builder, dark, 0.12, 0.38, 0.12, 0, 0.2, 0)
  box(builder, dark, 0.62, 0.06, 0.34, 0, 0.03, 0)
  sphere(builder, trim, 0.025, 0.62, 0.24, 0.08)
}

function buildTvCabinet(builder: Builder, doors: boolean): void {
  const wood = key(builder, 'wood')
  box(builder, wood, 1.65, 0.58, 0.58)
  box(builder, wood, 1.75, 0.07, 0.64, 0, 0.62, 0)
  if (doors) {
    for (const x of [-0.58, 0.58]) {
      box(builder, wood, 0.46, 0.42, 0.035, x, 0.31, 0.315)
      sphere(builder, key(builder, 'metal', wood), 0.025, x + Math.sign(-x) * 0.13, 0.31, 0.36)
    }
    box(builder, key(builder, 'metalDark', wood), 0.58, 0.34, 0.035, 0, 0.31, 0.315)
  } else for (const y of [0.19, 0.38]) box(builder, key(builder, 'woodDark', wood), 1.48, 0.055, 0.5, 0, y, 0)
  fourLegs(builder, 1.42, 0.4, 0.14, wood)
}

function buildWall(builder: Builder, name: string): void {
  const wall = key(builder, '_defaultMat', 'wood')
  const trim = key(builder, 'wood', 'metalDark', wall)
  const glass = key(builder, 'glass', wall)
  const width = name === 'wallHalf' ? 0.5 : 1
  const depth = 0.08
  const height = 1.4
  if (name === 'wall') box(builder, wall, width, height, depth, 0, height / 2, 0)
  else if (name === 'wallHalf') box(builder, wall, width, height, depth, 0, height / 2, 0)
  else if (name === 'wallCorner' || name === 'wallCornerRond') {
    box(builder, wall, 1, height, depth, 0, height / 2, -0.46)
    box(builder, wall, depth, height, 1, -0.46, height / 2, 0)
    if (name === 'wallCornerRond') cylinder(builder, trim, 0.08, 0.08, height, -0.46, height / 2, -0.46)
  } else if (name.startsWith('wallDoorway')) {
    const opening = name === 'wallDoorwayWide' ? 0.72 : 0.55
    const side = (1 - opening) / 2
    for (const x of [-(opening + side) / 2, (opening + side) / 2]) box(builder, wall, side, height, depth, x, height / 2, 0)
    box(builder, wall, opening, 0.28, depth, 0, height - 0.14, 0)
    for (const x of [-opening / 2, opening / 2]) box(builder, trim, 0.055, height * 0.8, depth + 0.035, x, height * 0.4, 0)
    box(builder, trim, opening + 0.11, 0.055, depth + 0.035, 0, height * 0.8, 0)
  } else {
    const opening = 0.66
    const side = (1 - opening) / 2
    for (const x of [-(opening + side) / 2, (opening + side) / 2]) box(builder, wall, side, height, depth, x, height / 2, 0)
    box(builder, wall, opening, 0.36, depth, 0, height - 0.18, 0)
    box(builder, wall, opening, 0.37, depth, 0, 0.185, 0)
    box(builder, glass, opening - 0.06, 0.62, 0.025, 0, 0.87, 0)
    for (const x of [-opening / 2, 0, opening / 2]) box(builder, trim, 0.04, 0.72, depth + 0.035, x, 0.87, 0)
    for (const y of [0.5, 0.87, 1.23]) box(builder, trim, opening, 0.04, depth + 0.035, 0, y, 0)
    if (name === 'wallWindowSlide') box(builder, trim, 0.045, 0.58, depth + 0.06, 0.12, 0.87, 0)
  }
  box(builder, trim, width, 0.055, depth + 0.035, 0, 0.027, 0)
}

function buildMisc(builder: Builder, name: string): void {
  if (name === 'bear') {
    const fur = key(builder, 'fur', 'wood')
    sphere(builder, fur, 0.34, 0, 0.52, 0, [0.85, 1.05, 0.7])
    sphere(builder, fur, 0.27, 0, 0.96, 0, [0.92, 1, 0.82])
    for (const x of [-0.2, 0.2]) sphere(builder, fur, 0.12, x, 1.16, 0, [1, 1, 0.7])
    for (const x of [-0.11, 0.11]) sphere(builder, key(builder, 'metalDark', fur), 0.025, x, 1.02, 0.22)
    sphere(builder, key(builder, 'wood', fur), 0.08, 0, 0.9, 0.24, [1, 0.7, 0.6])
    for (const x of [-0.36, 0.36]) sphere(builder, fur, 0.18, x, 0.58, 0, [0.7, 1.4, 0.7])
    return
  }
  if (name === 'books') {
    const palette = builder.keys.length ? builder.keys : ['carpetDarker']
    for (let i = 0; i < 7; i++) {
      const height = 0.36 + (i % 3) * 0.06
      box(builder, palette[i % palette.length] ?? palette[0] ?? '_defaultMat', 0.11, height, 0.34, -0.36 + i * 0.12, height / 2, 0)
      box(builder, key(builder, 'carpetWhite', 'metal'), 0.075, height * 0.82, 0.345, -0.36 + i * 0.12, height / 2, 0.005)
    }
    return
  }
  if (name === 'paneling') {
    const wood = key(builder, 'wood')
    box(builder, wood, 1, 1.2, 0.05, 0, 0.6, 0)
    for (const x of [-0.4, -0.2, 0, 0.2, 0.4]) box(builder, key(builder, 'woodDark', wood), 0.025, 1.14, 0.025, x, 0.6, 0.04)
    box(builder, wood, 1.04, 0.08, 0.1, 0, 1.18, 0.02)
    return
  }
  if (name === 'sideTableDrawers') { cabinet(builder, 0.92, 0.7, 0.5, 2); return }
  if (name === 'trashcan') {
    const metal = key(builder, 'metal', 'metalDark')
    cylinder(builder, metal, 0.34, 0.28, 0.8, 0, 0.4, 0, [0, 0, 0], 28)
    cylinder(builder, key(builder, 'metalDark', metal), 0.36, 0.36, 0.07, 0, 0.84, 0, [0, 0, 0], 28)
    cylinder(builder, key(builder, 'metalDark', metal), 0.11, 0.11, 0.05, 0, 0.9, 0, [0, 0, 0], 18)
  }
}

function consolidate(builder: Builder): void {
  const byMaterial = new Map<THREE.Material, THREE.BufferGeometry[]>()
  for (const child of builder.root.children) {
    if (!(child instanceof THREE.Mesh) || Array.isArray(child.material)) continue
    child.updateMatrix()
    const geometries = byMaterial.get(child.material) ?? []
    geometries.push(child.geometry.clone().applyMatrix4(child.matrix))
    byMaterial.set(child.material, geometries)
  }
  for (const child of builder.root.children) if (child instanceof THREE.Mesh) child.geometry.dispose()
  builder.root.clear()
  for (const [sourceMaterial, geometries] of byMaterial) {
    const geometry = geometries.length === 1 ? geometries[0] : mergeGeometries(geometries, false)
    if (!geometry) throw new Error(`Could not merge ${sourceMaterial.name} geometry`)
    const merged = new THREE.Mesh(geometry, sourceMaterial)
    merged.castShadow = sourceMaterial.name !== 'glass'
    merged.receiveShadow = true
    builder.root.add(merged)
  }
}

export function createOriginalFurniture(name: string, materialNames: readonly string[]): THREE.Group {
  const builder: Builder = { root: new THREE.Group(), materials: new Map(), keys: materialNames }
  builder.root.name = `original detailed ${name}`

  if (/^bathroom|^bathtub$|^shower|^toilet/.test(name)) buildBathroom(builder, name)
  else if (name === 'bedBunk') buildBunk(builder)
  else if (/^cabinetBed/.test(name)) buildBedside(builder, name)
  else if (/^benchCushion/.test(name)) buildBench(builder, name.endsWith('Low'))
  else if (name === 'bookcaseClosedDoors') buildBookcase(builder)
  else if (/^computer/.test(name)) buildComputer(builder, name)
  else if (/^desk/.test(name)) buildDesk(builder, name === 'deskCorner')
  else if (/^doorway/.test(name)) buildDoor(builder, name)
  else if (/^floor/.test(name)) buildFloor(builder, name)
  else if (/^hood/.test(name) || /^kitchen/.test(name) || name === 'toaster') buildKitchen(builder, name)
  else if (/^(dryer|washer)/.test(name)) buildLaundry(builder, name)
  else if (/^lamp/.test(name)) buildLamp(builder, name)
  else if (name === 'ceilingFan') buildFan(builder)
  else if (/^coatRack/.test(name)) buildCoatRack(builder, name === 'coatRackStanding')
  else if (/^rug/.test(name)) buildRug(builder, name)
  else if (/SofaCorner$/.test(name)) buildSofaCorner(builder)
  else if (/^speaker/.test(name)) buildSpeaker(builder, name === 'speakerSmall')
  else if (/^stairs/.test(name)) buildStairs(builder, name)
  else if (/^table/.test(name)) buildTable(builder, name)
  else if (name === 'televisionModern') buildTelevision(builder)
  else if (/^cabinetTelevision/.test(name)) buildTvCabinet(builder, name.endsWith('Doors'))
  else if (/^wall/.test(name)) buildWall(builder, name)
  else buildMisc(builder, name)

  if (!builder.root.children.length) throw new Error(`No original detailed furniture builder for "${name}"`)
  consolidate(builder)
  return builder.root
}
