import {
  Box3,
  BoxGeometry,
  CapsuleGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  Euler,
  Float32BufferAttribute,
  Group,
  IcosahedronGeometry,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
} from 'three'
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

const C = {
  yellow: '#efb71d', yellow2: '#f5c842', black: '#14181a', rubber: '#17191a',
  glass: '#244759', glass2: '#8ab7c5', white: '#edf1e8', cream: '#e4d8b7',
  steel: '#676d6d', steel2: '#a8ada8', rust: '#7b3d21', red: '#b82b26',
  blue: '#13649b', blue2: '#75a9c7', brown: '#74472b', wood: '#9b6138',
  tan: '#c99f68', green: '#2e7d46', green2: '#5b9b43', orange: '#ed7b24',
  charcoal: '#2c2925', concrete: '#8c8980', concrete2: '#b6afa2', purple: '#593f68',
  silver: '#788184', silver2: '#a9b0b1', amber: '#e98b22', tail: '#941f1c',
  water: '#b9dfe8', water2: '#e5f2f1', bottle: '#46775e',
  teal: '#278d83', navy: '#27435a', pink: '#c95c7c', fabric: '#865c9c',
}

const LETTERS = {
  A: ['01110','10001','10001','11111','10001','10001','10001'],
  B: ['11110','10001','10001','11110','10001','10001','11110'],
  C: ['01111','10000','10000','10000','10000','10000','01111'],
  D: ['11110','10001','10001','10001','10001','10001','11110'],
  E: ['11111','10000','10000','11110','10000','10000','11111'],
  F: ['11111','10000','10000','11110','10000','10000','10000'],
  G: ['01111','10000','10000','10111','10001','10001','01110'],
  H: ['10001','10001','10001','11111','10001','10001','10001'],
  I: ['11111','00100','00100','00100','00100','00100','11111'],
  L: ['10000','10000','10000','10000','10000','10000','11111'],
  N: ['10001','11001','11001','10101','10011','10011','10001'],
  O: ['01110','10001','10001','10001','10001','10001','01110'],
  P: ['11110','10001','10001','11110','10000','10000','10000'],
  R: ['11110','10001','10001','11110','10100','10010','10001'],
  S: ['01111','10000','10000','01110','00001','00001','11110'],
  T: ['11111','00100','00100','00100','00100','00100','00100'],
  U: ['10001','10001','10001','10001','10001','10001','01110'],
  V: ['10001','10001','10001','10001','10001','01010','00100'],
  Y: ['10001','10001','01010','00100','00100','00100','00100'],
}

function colored(geometry, color) {
  const rgb = new Color(color)
  const values = new Float32Array(geometry.attributes.position.count * 3)
  for (let i = 0; i < geometry.attributes.position.count; i++) {
    values[i * 3] = rgb.r
    values[i * 3 + 1] = rgb.g
    values[i * 3 + 2] = rgb.b
  }
  geometry.setAttribute('color', new Float32BufferAttribute(values, 3))
  return geometry
}

class ModelBuilder {
  constructor(name) {
    this.name = name
    this.parts = []
  }

  add(geometry, color, position = [0, 0, 0], rotation = [0, 0, 0], scale = [1, 1, 1]) {
    const next = colored(geometry.index ? geometry.toNonIndexed() : geometry, color)
    for (const attribute of Object.keys(next.attributes)) {
      if (attribute !== 'position' && attribute !== 'normal' && attribute !== 'color') next.deleteAttribute(attribute)
    }
    const matrix = new Matrix4()
      .makeScale(...scale)
      .premultiply(new Matrix4().makeRotationFromEuler(new Euler(...rotation)))
      .premultiply(new Matrix4().makeTranslation(...position))
    next.applyMatrix4(matrix)
    this.parts.push(next)
    return this
  }

  box(size, color, position, rotation = [0, 0, 0]) {
    return this.add(new BoxGeometry(...size), color, position, rotation)
  }

  roundedBox(size, radius, color, position, rotation = [0, 0, 0], segments = 3) {
    return this.add(new RoundedBoxGeometry(size[0], size[1], size[2], segments, radius), color, position, rotation)
  }

  cylinder(radius, depth, color, position, rotation = [0, 0, 0], segments = 10) {
    return this.add(new CylinderGeometry(radius, radius, depth, segments), color, position, rotation)
  }

  beam(from, to, radius, color, segments = 6) {
    const a = new Vector3(...from), b = new Vector3(...to)
    const direction = b.clone().sub(a)
    const geometry = new CylinderGeometry(radius, radius, direction.length(), segments)
    geometry.applyQuaternion(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), direction.clone().normalize()))
    return this.add(geometry, color, a.add(b).multiplyScalar(0.5).toArray())
  }

  label(text, center, width, color, depth = 0.025) {
    const chars = [...text]
    const cell = width / Math.max(1, chars.length * 6 - 1)
    const total = (chars.length * 6 - 1) * cell
    chars.forEach((letter, ci) => {
      const rows = LETTERS[letter]
      if (!rows) return
      rows.forEach((row, y) => [...row].forEach((on, x) => {
        if (on === '1') this.box([cell * 0.82, cell * 0.82, depth], color, [center[0] - total / 2 + (ci * 6 + x + 0.5) * cell, center[1] + (3 - y) * cell, center[2]])
      }))
    })
    return this
  }

  finish() {
    const geometry = mergeGeometries(this.parts, false)
    geometry.computeBoundingBox()
    geometry.translate(0, -geometry.boundingBox.min.y, 0)
    geometry.computeBoundingBox()
    const material = new MeshStandardMaterial({ vertexColors: true, roughness: 0.76, metalness: 0.04 })
    const mesh = new Mesh(geometry, material)
    mesh.name = this.name
    const group = new Group()
    group.name = this.name
    group.add(mesh)
    return group
  }
}

function wheel(builder, x, y, z, radius = 0.34, width = 0.18) {
  builder.cylinder(radius, width, C.rubber, [x, y, z], [0, 0, Math.PI / 2], 12)
  builder.cylinder(radius * 0.43, width + 0.015, C.steel2, [x, y, z], [0, 0, Math.PI / 2], 10)
}

function vehicleLights(builder, width, z, y, color = C.white) {
  for (const x of [-width * 0.33, width * 0.33]) builder.box([0.3, 0.18, 0.035], color, [x, y, z])
}

function danfo() {
  const b = new ModelBuilder('danfo')
  b.roundedBox([1.78, 1.18, 3.95], 0.15, C.yellow, [0, 1.03, 0], [0, 0, 0], 3)
  b.roundedBox([1.68, 0.74, 3.56], 0.12, C.yellow2, [0, 1.87, -0.06], [0, 0, 0], 3)
  b.roundedBox([1.76, 0.18, 3.68], 0.08, C.yellow, [0, 2.29, -0.08], [0, 0, 0], 2)
  b.box([1.81, 0.14, 3.45], C.black, [0, 1.32, -0.12])
  b.box([1.48, 0.68, 0.035], C.black, [0, 1.89, 1.755], [-0.1, 0, 0])
  b.box([1.31, 0.55, 0.04], C.glass, [0, 1.89, 1.782], [-0.1, 0, 0])
  b.box([0.28, 0.61, 0.04], C.yellow, [0, 1.89, 1.755], [-0.1, 0, 0])
  b.roundedBox([1.7, 0.36, 0.52], 0.08, C.yellow2, [0, 1.34, 1.77], [-0.1, 0, 0], 3)
  for (const side of [-1, 1]) {
    for (const z of [-1.34, -0.55, 0.25, 0.98]) {
      b.box([0.04, 0.58, 0.69], C.black, [side * 0.855, 1.87, z])
      b.box([0.045, 0.47, 0.58], C.glass, [side * 0.88, 1.87, z])
    }
    b.box([0.045, 0.5, 0.08], C.yellow, [side * 0.88, 1.87, 1.33])
    b.box([0.16, 0.09, 0.25], C.black, [side * 1.02, 1.72, 1.45])
    for (const z of [-1.36, 1.23]) b.add(new TorusGeometry(0.41, 0.045, 6, 12, Math.PI), C.black, [side * 0.92, 0.41, z], [0, Math.PI / 2, 0])
    b.box([0.035, 0.035, 1.2], C.rust, [side * 0.902, 0.69, -0.1], [0.03, 0, 0])
    b.box([0.035, 0.025, 0.54], C.steel, [side * 0.905, 0.58, 0.83], [-0.025, 0, 0])
  }
  for (const z of [-1.36, 1.23]) for (const x of [-0.9, 0.9]) wheel(b, x, 0.41, z)
  b.box([1.9, 0.13, 0.18], C.steel, [0, 0.48, 2.05])
  b.box([1.9, 0.13, 0.18], C.steel, [0, 0.48, -2.05])
  b.box([0.8, 0.28, 0.04], C.black, [0, 0.79, 2.005])
  vehicleLights(b, 1.78, 2.02, 1.02)
  b.box([0.55, 0.11, 0.035], C.black, [0, 0.56, 2.03])
  // Rear glass, split doors, lamps, plate recess, and worn lower sill.
  b.box([1.48, 0.62, 0.045], C.black, [0, 1.86, -1.86])
  b.box([1.31, 0.49, 0.04], C.glass, [0, 1.86, -1.89])
  b.box([0.075, 0.59, 0.055], C.yellow, [0, 1.86, -1.92])
  b.box([0.025, 1.28, 0.045], C.black, [0, 0.92, -1.996])
  b.box([1.46, 0.025, 0.045], C.rust, [0, 1.23, -1.997])
  for (const x of [-0.71, 0.71]) {
    b.box([0.16, 0.28, 0.05], C.tail, [x, 0.96, -2.0])
    b.box([0.16, 0.12, 0.055], C.amber, [x, 1.16, -2.005])
  }
  b.box([0.72, 0.22, 0.055], C.black, [0, 0.65, -2.005])
  b.box([0.46, 0.11, 0.06], C.cream, [0, 0.65, -2.04])
  b.box([0.7, 0.05, 0.045], C.rust, [0.22, 0.4, -2.007], [0, 0, -0.035])
  b.box([0.32, 0.035, 0.04], C.steel, [-0.47, 0.31, -2.01], [0, 0, 0.08])
  // Windshield wipers and stamped panel seams keep the front readable at street scale.
  b.beam([-0.5, 1.69, 1.81], [-0.08, 1.84, 1.81], 0.015, C.black, 5)
  b.beam([0.5, 1.69, 1.81], [0.08, 1.84, 1.81], 0.015, C.black, 5)
  for (const x of [-0.58, 0.58]) b.box([0.025, 0.32, 0.045], C.rust, [x, 1.34, 2.02])
  return b.finish()
}

function keke() {
  const b = new ModelBuilder('keke')
  wheel(b, 0, 0.35, 1.14, 0.33, 0.16)
  wheel(b, -0.72, 0.35, -0.78, 0.34, 0.15)
  wheel(b, 0.72, 0.35, -0.78, 0.34, 0.15)
  b.box([1.42, 0.55, 1.7], C.yellow, [0, 0.69, -0.15])
  b.box([1.47, 0.18, 2.05], C.black, [0, 1.86, -0.02])
  b.box([1.38, 0.14, 1.94], C.yellow, [0, 1.97, -0.06])
  for (const x of [-0.66, 0.66]) {
    b.beam([x, 0.82, -0.9], [x, 1.88, -0.9], 0.035, C.black)
    b.beam([x, 0.84, 0.78], [x, 1.88, 0.65], 0.035, C.black)
  }
  b.box([1.18, 0.53, 0.035], C.glass, [0, 1.55, 0.79], [-0.11, 0, 0])
  b.box([1.0, 0.38, 0.35], C.black, [0, 0.98, -0.58])
  b.box([1.18, 0.12, 0.08], C.yellow2, [0, 1.18, -0.55])
  b.box([0.24, 0.16, 0.05], C.white, [0, 0.9, 0.96])
  b.beam([0, 0.72, 0.72], [0, 0.55, 1.1], 0.055, C.black)
  b.box([0.65, 0.09, 0.15], C.black, [0, 1.08, 0.56])
  return b.finish()
}

function okada() {
  const b = new ModelBuilder('okada')
  wheel(b, 0, 0.39, -0.93, 0.38, 0.13)
  wheel(b, 0, 0.39, 0.98, 0.38, 0.13)
  b.beam([0, 0.44, -0.7], [0, 0.88, 0.23], 0.06, C.red)
  b.beam([0, 0.88, 0.23], [0, 0.43, 0.72], 0.06, C.red)
  b.beam([0, 0.43, 0.72], [0, 0.44, -0.7], 0.055, C.black)
  b.box([0.34, 0.18, 0.88], C.black, [0, 0.93, -0.26], [0.03, 0, 0])
  b.box([0.46, 0.4, 0.46], C.steel, [0, 0.61, 0.02])
  b.box([0.5, 0.32, 0.5], C.red, [0, 0.91, 0.31], [-0.18, 0, 0])
  b.beam([0, 0.55, 0.72], [0, 1.22, 0.84], 0.035, C.steel)
  b.beam([-0.42, 1.23, 0.83], [0.42, 1.23, 0.83], 0.035, C.black)
  b.box([0.28, 0.22, 0.08], C.white, [0, 1.12, 0.92])
  b.cylinder(0.08, 0.42, C.steel, [0.23, 0.58, -0.65], [Math.PI / 2, 0, 0], 8)
  return b.finish()
}

function bus() {
  const b = new ModelBuilder('bus')
  b.box([2.5, 1.35, 7.4], C.blue, [0, 1.05, 0])
  b.box([2.43, 1.08, 7.1], C.blue2, [0, 2.22, -0.08])
  b.box([2.52, 0.15, 7.42], C.white, [0, 2.86, 0])
  b.box([2.05, 0.74, 0.04], C.glass, [0, 2.26, 3.57])
  for (const side of [-1, 1]) {
    for (const z of [-2.75, -1.75, -0.75, 0.25, 1.25, 2.25]) b.box([0.035, 0.69, 0.76], C.glass, [side * 1.23, 2.28, z])
    b.box([0.04, 1.34, 0.86], C.black, [side * 1.255, 1.45, 2.88])
    b.box([0.045, 1.22, 0.7], C.glass2, [side * 1.27, 1.5, 2.88])
  }
  for (const z of [-2.35, 2.35]) for (const x of [-1.27, 1.27]) wheel(b, x, 0.51, z, 0.5, 0.2)
  b.box([2.58, 0.16, 0.18], C.steel, [0, 0.5, 3.75])
  vehicleLights(b, 2.5, 3.72, 0.94)
  return b.finish()
}

function car() {
  const b = new ModelBuilder('car')
  b.roundedBox([1.78, 0.58, 3.85], 0.18, C.silver, [0, 0.68, 0], [0, 0, 0], 3)
  b.roundedBox([1.58, 0.68, 1.92], 0.16, C.silver2, [0, 1.2, -0.18], [0, 0, 0], 3)
  b.box([1.5, 0.56, 0.045], C.black, [0, 1.29, 0.82], [-0.42, 0, 0])
  b.box([1.38, 0.46, 0.05], C.glass, [0, 1.29, 0.84], [-0.42, 0, 0])
  b.box([1.5, 0.55, 0.045], C.black, [0, 1.29, -1.18], [0.42, 0, 0])
  b.box([1.38, 0.45, 0.05], C.glass, [0, 1.29, -1.2], [0.42, 0, 0])
  for (const x of [-0.895, 0.895]) {
    b.box([0.035, 0.5, 0.8], C.black, [x, 1.25, 0.29])
    b.box([0.04, 0.41, 0.68], C.glass, [x * 1.012, 1.25, 0.29])
    b.box([0.035, 0.5, 0.8], C.black, [x, 1.25, -0.68])
    b.box([0.04, 0.41, 0.68], C.glass, [x * 1.012, 1.25, -0.68])
    for (const z of [-1.28, 1.28]) b.add(new TorusGeometry(0.4, 0.04, 6, 12, Math.PI), C.black, [x * 1.01, 0.42, z], [0, Math.PI / 2, 0])
    b.box([0.13, 0.08, 0.22], C.black, [x * 1.1, 1.34, 0.72])
  }
  for (const z of [-1.28, 1.28]) for (const x of [-0.91, 0.91]) wheel(b, x, 0.42, z, 0.35, 0.16)
  vehicleLights(b, 1.78, 1.94, 0.68)
  b.box([0.74, 0.18, 0.05], C.black, [0, 0.52, 1.95])
  b.box([1.7, 0.1, 0.14], C.steel2, [0, 0.42, 1.97])
  for (const x of [-0.68, 0.68]) b.box([0.33, 0.2, 0.05], C.tail, [x, 0.72, -1.94])
  b.box([0.7, 0.22, 0.055], C.black, [0, 0.57, -1.95])
  b.box([0.43, 0.11, 0.06], C.cream, [0, 0.57, -1.98])
  b.box([1.7, 0.1, 0.14], C.steel2, [0, 0.4, -1.98])
  return b.finish()
}

function marketStall(name, canopy, spokes) {
  const b = new ModelBuilder(name)
  b.box([2.2, 0.16, 0.92], C.wood, [0, 1.02, 0])
  b.box([2.08, 0.7, 0.78], C.brown, [0, 0.59, 0])
  for (const x of [-0.82, 0, 0.82]) b.box([0.62, 0.3, 0.62], C.tan, [x, 0.38, 0.6])
  const produce = [C.green, C.orange, C.yellow2, C.red]
  for (let x = -0.92, i = 0; x <= 0.92; x += 0.31, i++) b.add(new IcosahedronGeometry(0.13, 1), produce[i % produce.length], [x, 1.21, 0.05 + (i % 2) * 0.18])
  // Unlabelled returnable drinks bottles with contrasting metal caps.
  for (let i = 0; i < 7; i++) {
    const x = -0.86 + i * 0.16
    const z = 0.67 + (i % 2) * 0.13
    const bottleColor = i % 3 === 0 ? C.brown : i % 3 === 1 ? C.bottle : C.glass2
    b.cylinder(0.055, 0.27, bottleColor, [x, 0.69, z], [0, 0, 0], 8)
    b.cylinder(0.029, 0.09, bottleColor, [x, 0.87, z], [0, 0, 0], 8)
    b.cylinder(0.035, 0.025, i % 2 ? C.steel2 : C.yellow2, [x, 0.928, z], [0, 0, 0], 8)
  }
  // A tied bundle of water sachets, suggested with cool translucent colours.
  for (let row = 0; row < 2; row++) for (let column = 0; column < 3; column++) {
    b.roundedBox([0.2, 0.08, 0.15], 0.025, (row + column) % 2 ? C.water : C.water2, [0.54 + column * 0.21, 0.6 + row * 0.085, 0.71], [0, (column - 1) * 0.08, 0], 1)
  }
  b.beam([0.48, 0.71, 0.71], [1.15, 0.71, 0.71], 0.018, C.blue2, 5)
  b.cylinder(0.045, 2.35, C.steel, [0, 2.23, 0], [0, 0, 0], 8)
  b.add(new ConeGeometry(1.7, 0.46, 16), canopy, [0, 3.25, 0])
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4
    if (i % 2) b.beam([0, 3.45, 0], [Math.sin(angle) * 1.58, 3.05, Math.cos(angle) * 1.58], 0.018, spokes)
  }
  return b.finish()
}

function stall() { return marketStall('stall', C.yellow, C.red) }
function stallRed() { return marketStall('stall-red', C.red, C.cream) }
function stallGreen() { return marketStall('stall-green', C.green, C.yellow2) }

function billboard() {
  const b = new ModelBuilder('billboard')
  for (const x of [-0.88, 0.88]) {
    b.box([0.15, 2.25, 0.15], C.steel, [x, 1.125, 0])
    b.box([0.52, 0.12, 0.42], C.concrete, [x, 0.06, 0])
  }
  b.roundedBox([2.9, 1.42, 0.18], 0.08, C.blue, [0, 2.82, 0], [0, 0, 0], 2)
  b.box([2.7, 1.22, 0.06], C.cream, [0, 2.82, 0.12])
  b.label('REPAIRS', [0, 3.05, 0.17], 2.18, C.black, 0.035)
  // Original handset mark: a compact receiver silhouette, not a merchant logo.
  b.beam([-0.31, 2.5, 0.17], [-0.13, 2.37, 0.17], 0.045, C.blue, 7)
  b.beam([-0.13, 2.37, 0.17], [0.13, 2.37, 0.17], 0.045, C.blue, 7)
  b.beam([0.13, 2.37, 0.17], [0.31, 2.5, 0.17], 0.045, C.blue, 7)
  b.box([0.17, 0.14, 0.07], C.blue, [-0.31, 2.52, 0.17], [0, 0, -0.35])
  b.box([0.17, 0.14, 0.07], C.blue, [0.31, 2.52, 0.17], [0, 0, 0.35])
  return b.finish()
}

function produceGoods() {
  const b = new ModelBuilder('produce-goods')
  const baskets = [-0.9, 0, 0.9]
  for (const x of baskets) {
    b.add(new CylinderGeometry(0.43, 0.34, 0.34, 12, 1, true), C.tan, [x, 0.2, 0])
    b.add(new TorusGeometry(0.42, 0.035, 6, 12), C.brown, [x, 0.38, 0], [Math.PI / 2, 0, 0])
    b.add(new TorusGeometry(0.35, 0.025, 5, 12), C.brown, [x, 0.09, 0], [Math.PI / 2, 0, 0])
  }
  for (let i = 0; i < 11; i++) {
    const angle = i * 2.4
    const radius = 0.08 + (i % 3) * 0.09
    b.add(new IcosahedronGeometry(0.105, 0), i % 4 ? C.red : C.orange, [-0.9 + Math.cos(angle) * radius, 0.44 + (i % 2) * 0.07, Math.sin(angle) * radius])
  }
  for (let i = 0; i < 9; i++) {
    const angle = i * 2.1
    b.add(new ConeGeometry(0.08, 0.22, 6), i % 3 ? C.green : C.red, [Math.cos(angle) * 0.25, 0.49 + (i % 2) * 0.06, Math.sin(angle) * 0.2], [0.12, angle, 0.3])
  }
  for (let i = 0; i < 5; i++) b.add(new TorusGeometry(0.25, 0.055, 5, 10, Math.PI * 0.72), i % 2 ? C.yellow2 : C.green2, [0.82 + (i % 2) * 0.12, 0.5 + i * 0.045, (i - 2) * 0.06], [Math.PI / 2, 0.2 * i, -0.25])
  for (let i = 0; i < 4; i++) b.add(new CapsuleGeometry(0.075, 0.36, 3, 7), C.brown, [-0.52 + i * 0.28, 0.18, 0.62], [0, 0, Math.PI / 2 + (i - 1.5) * 0.12])
  return b.finish()
}

function shopGoods() {
  const b = new ModelBuilder('shop-goods')
  const fabrics = [C.fabric, C.green, C.orange, C.blue]
  for (let i = 0; i < fabrics.length; i++) {
    b.cylinder(0.19, 1.3, fabrics[i], [-0.88 + (i % 2) * 0.42, 0.22 + Math.floor(i / 2) * 0.36, -0.05], [0, 0, Math.PI / 2], 10)
    b.cylinder(0.055, 1.32, C.cream, [-0.88 + (i % 2) * 0.42, 0.22 + Math.floor(i / 2) * 0.36, -0.05], [0, 0, Math.PI / 2], 8)
  }
  b.add(new CylinderGeometry(0.46, 0.36, 0.28, 12, 1, true), C.tan, [0.35, 0.16, 0])
  for (let i = 0; i < 6; i++) b.add(new CapsuleGeometry(0.09, 0.22, 3, 7), C.cream, [0.12 + (i % 3) * 0.2, 0.38 + Math.floor(i / 3) * 0.11, (i % 2) * 0.1], [0, 0, Math.PI / 2])
  for (const [i, x] of [0.95, 1.38].entries()) {
    b.roundedBox([0.34, 0.62, 0.3], 0.06, i ? C.yellow : C.blue, [x, 0.31, 0], [0, 0, 0], 1)
    b.add(new TorusGeometry(0.1, 0.035, 5, 8, Math.PI), C.black, [x, 0.66, 0], [0, 0, 0])
    b.box([0.06, 0.2, 0.035], C.black, [x - 0.09, 0.36, 0.17])
  }
  return b.finish()
}

function tyres() {
  const b = new ModelBuilder('tyres')
  for (let i = 0; i < 4; i++) b.add(new TorusGeometry(0.42, 0.13, 8, 14), C.rubber, [-0.48, 0.15 + i * 0.25, 0], [Math.PI / 2, 0, 0])
  b.add(new TorusGeometry(0.5, 0.14, 8, 14), C.rubber, [0.62, 0.55, 0], [0.08, 0.2, -0.16])
  b.add(new TorusGeometry(0.24, 0.035, 6, 12), C.steel2, [0.62, 0.55, 0.02], [0.08, 0.2, -0.16])
  return b.finish()
}

function containerShop() {
  const b = new ModelBuilder('container-shop')
  b.box([3.9, 2.45, 2.35], C.teal, [0, 1.225, 0])
  b.box([2.75, 1.58, 0.06], C.charcoal, [0.25, 1.15, 1.205])
  b.box([0.52, 1.8, 0.1], C.teal, [-1.55, 1.08, 1.22])
  b.box([3.35, 0.38, 0.1], C.teal, [0.15, 2.19, 1.22])
  for (let x = -1.88; x <= 1.88; x += 0.19) b.box([0.035, 2.25, 0.04], x < -1.28 || x > 1.72 ? C.blue2 : C.steel, [x, 1.22, 1.245])
  b.box([2.75, 0.13, 0.58], C.wood, [0.25, 0.77, 1.47])
  b.box([3.15, 0.12, 1.15], C.yellow2, [0.1, 2.47, 1.62], [-0.22, 0, 0])
  for (const x of [-1.4, 1.6]) b.beam([x, 1.72, 1.22], [x, 2.58, 2.1], 0.035, C.steel)
  b.box([1.18, 0.43, 0.08], C.blue, [-0.95, 2.06, 1.29])
  b.label('SHOP', [-0.95, 2.06, 1.345], 0.84, C.white, 0.03)
  return b.finish()
}

function posKiosk() {
  const b = new ModelBuilder('pos-kiosk')
  b.roundedBox([1.42, 2.05, 1.08], 0.09, C.blue, [0, 1.025, 0], [0, 0, 0], 2)
  b.box([1.12, 0.82, 0.05], C.charcoal, [0, 1.2, 0.565])
  b.box([1.25, 0.14, 0.5], C.cream, [0, 0.82, 0.78])
  b.box([1.18, 0.5, 0.06], C.white, [0, 1.75, 0.575])
  b.label('POS', [0, 1.75, 0.62], 0.72, C.blue, 0.03)
  b.roundedBox([0.22, 0.34, 0.09], 0.035, C.black, [-0.33, 0.99, 0.86], [-0.12, 0, 0], 1)
  b.box([0.14, 0.19, 0.02], C.green2, [-0.33, 1.02, 0.915], [-0.12, 0, 0])
  for (const x of [0.08, 0.3, 0.52]) b.box([0.14, 0.22, 0.035], x < 0.2 ? C.red : x < 0.4 ? C.yellow2 : C.green, [x, 1.02, 0.85])
  b.box([1.52, 0.1, 1.25], C.yellow, [0, 2.1, 0])
  return b.finish()
}

function vulcanizer() {
  const b = new ModelBuilder('vulcanizer')
  for (const x of [-1.35, 1.35]) for (const z of [-0.7, 0.7]) b.beam([x, 0, z], [x, 2.3, z], 0.05, C.steel)
  b.box([3.05, 0.13, 1.75], C.rust, [0, 2.34, 0], [0.03, 0, 0])
  for (let i = 0; i < 3; i++) b.add(new TorusGeometry(0.43, 0.13, 8, 14), C.rubber, [-0.72, 0.48 + i * 0.2, 0.4], [Math.PI / 2, 0, 0])
  b.cylinder(0.36, 0.95, C.red, [0.55, 0.48, 0.25], [0, 0, Math.PI / 2], 12)
  b.cylinder(0.11, 0.28, C.black, [0.55, 0.91, 0.25], [0, 0, 0], 9)
  b.add(new TorusGeometry(0.52, 0.025, 5, 16, Math.PI * 1.55), C.black, [0.72, 1.03, 0.08], [0, 0, 0.3])
  b.box([1.24, 0.42, 0.08], C.yellow, [0.66, 1.86, 0.75])
  b.label('TYRES', [0.66, 1.86, 0.805], 0.88, C.black, 0.03)
  return b.finish()
}

function waterTank() {
  const b = new ModelBuilder('water-tank')
  for (const x of [-0.72, 0.72]) for (const z of [-0.72, 0.72]) b.beam([x, 0, z], [x, 2.35, z], 0.07, C.steel)
  for (const y of [0.25, 1.28, 2.28]) {
    b.beam([-0.78, y, -0.78], [0.78, y, -0.78], 0.055, C.steel)
    b.beam([-0.78, y, 0.78], [0.78, y, 0.78], 0.055, C.steel)
    b.beam([-0.78, y, -0.78], [-0.78, y, 0.78], 0.055, C.steel)
    b.beam([0.78, y, -0.78], [0.78, y, 0.78], 0.055, C.steel)
  }
  b.beam([-0.72, 0.25, -0.72], [0.72, 2.28, -0.72], 0.035, C.steel)
  b.beam([0.72, 0.25, 0.72], [-0.72, 2.28, 0.72], 0.035, C.steel)
  b.add(new CylinderGeometry(1.0, 1.0, 1.55, 16), C.black, [0, 3.12, 0])
  for (const y of [2.52, 3.12, 3.72]) b.add(new TorusGeometry(1.005, 0.035, 6, 16), C.steel, [0, y, 0], [Math.PI / 2, 0, 0])
  b.cylinder(0.16, 0.16, C.black, [0, 3.98, 0], [0, 0, 0], 12)
  b.beam([0.9, 2.55, 0], [1.2, 2.25, 0], 0.055, C.blue, 8)
  return b.finish()
}

function rubbishBin() {
  const b = new ModelBuilder('rubbish-bin')
  b.roundedBox([0.72, 0.92, 0.62], 0.08, C.green, [0, 0.53, 0], [-0.05, 0, 0], 2)
  b.box([0.82, 0.12, 0.72], C.charcoal, [0, 1.03, 0.02], [-0.05, 0, 0])
  b.beam([-0.26, 1.06, -0.26], [0.26, 1.06, -0.26], 0.035, C.black)
  for (const x of [-0.31, 0.31]) {
    b.cylinder(0.13, 0.1, C.rubber, [x, 0.17, -0.32], [0, 0, Math.PI / 2], 10)
    b.cylinder(0.05, 0.12, C.steel, [x, 0.17, -0.32], [0, 0, Math.PI / 2], 8)
  }
  return b.finish()
}

function lamp() {
  const b = new ModelBuilder('lamp')
  b.cylinder(0.11, 4.2, C.steel, [0, 2.1, 0], [0, 0, 0], 10)
  b.cylinder(0.22, 0.12, C.black, [0, 0.06, 0], [0, 0, 0], 10)
  b.beam([0, 4.05, 0], [0.72, 4.48, 0], 0.065, C.steel, 8)
  b.beam([0.72, 4.48, 0], [1.08, 4.34, 0], 0.055, C.steel, 8)
  b.add(new ConeGeometry(0.27, 0.22, 12), C.black, [1.08, 4.18, 0], [0, 0, Math.PI])
  b.add(new SphereGeometry(0.14, 10, 6), C.cream, [1.08, 4.04, 0])
  return b.finish()
}

function canoe() {
  const b = new ModelBuilder('canoe')
  b.add(new CapsuleGeometry(0.66, 3.35, 4, 12), C.brown, [0, 0.42, 0], [Math.PI / 2, 0, 0], [1, 1, 0.48])
  b.roundedBox([0.92, 0.16, 3.55], 0.08, C.charcoal, [0, 0.66, 0], [0, 0, 0], 2)
  for (const x of [-0.54, 0.54]) b.beam([x, 0.55, -1.62], [x, 0.55, 1.62], 0.045, C.wood, 7)
  for (const z of [-0.82, 0, 0.82]) b.box([0.92, 0.09, 0.22], C.wood, [0, 0.79, z])
  b.beam([-0.08, 0.83, -0.4], [0.78, 0.92, 1.28], 0.035, C.tan, 7)
  b.box([0.28, 0.08, 0.58], C.wood, [0.86, 0.94, 1.45], [0.08, 0.35, -0.1])
  b.box([0.58, 0.38, 0.48], C.blue, [-0.15, 0.92, -0.75])
  return b.finish()
}

function mooringPosts() {
  const b = new ModelBuilder('mooring-posts')
  for (const x of [-1.0, 0, 1.0]) {
    b.cylinder(0.15, 1.45 + (x === 0 ? 0.2 : 0), C.brown, [x, 0.725 + (x === 0 ? 0.1 : 0), 0], [0, 0, x * 0.04], 9)
    b.add(new ConeGeometry(0.17, 0.24, 9), C.brown, [x, 1.57 + (x === 0 ? 0.2 : 0), 0])
  }
  b.add(new TorusGeometry(0.5, 0.025, 5, 18, Math.PI), C.tan, [-0.5, 1.12, 0.02], [0, 0, 0])
  b.add(new TorusGeometry(0.5, 0.025, 5, 18, Math.PI), C.tan, [0.5, 1.17, 0.02], [0, 0, 0])
  return b.finish()
}

function netCrates() {
  const b = new ModelBuilder('net-crates')
  for (const [i, x] of [-0.55, 0.55].entries()) {
    b.box([0.92, 0.55, 0.72], i ? C.blue : C.teal, [x, 0.275, 0])
    for (const y of [0.11, 0.28, 0.45]) b.box([0.96, 0.035, 0.76], C.charcoal, [x, y, 0])
    for (const dx of [-0.37, 0, 0.37]) b.box([0.035, 0.58, 0.76], C.charcoal, [x + dx, 0.29, 0])
  }
  b.cylinder(0.34, 0.82, C.green2, [0, 0.88, 0], [0, 0, Math.PI / 2], 12)
  for (const x of [-0.42, 0.42]) b.add(new TorusGeometry(0.34, 0.035, 5, 12), C.tan, [x, 0.88, 0], [0, Math.PI / 2, 0])
  for (let i = 0; i < 6; i++) b.add(new SphereGeometry(0.065, 7, 5), i % 2 ? C.orange : C.white, [-0.48 + i * 0.19, 1.14, 0.3])
  return b.finish()
}

function kiosk() {
  const b = new ModelBuilder('kiosk')
  b.box([2.8, 2.35, 1.55], C.tan, [0, 1.175, 0])
  b.box([3.05, 0.13, 1.85], C.rust, [0, 2.46, -0.05], [0.04, 0, 0])
  b.box([1.82, 1.35, 0.05], C.charcoal, [0.32, 0.92, 0.8])
  for (let x = -0.5; x < 1.14; x += 0.16) b.box([0.045, 1.24, 0.035], C.steel, [x, 0.93, 0.83])
  b.box([0.55, 1.72, 0.055], C.brown, [-1.02, 0.88, 0.81])
  b.box([2.58, 0.48, 0.08], C.green, [0, 2.06, 0.825])
  b.label('PROVISIONS', [0, 2.06, 0.875], 2.28, C.white, 0.035)
  b.box([2.2, 0.12, 0.5], C.wood, [0.2, 0.62, 1.0])
  return b.finish()
}

function food() {
  const b = new ModelBuilder('food')
  b.box([2.15, 0.12, 0.85], C.steel, [0, 0.96, 0])
  for (const x of [-0.92, 0.92]) for (const z of [-0.32, 0.32]) b.beam([x, 0, z], [x, 0.9, z], 0.035, C.steel)
  b.box([1.22, 0.35, 0.7], C.charcoal, [-0.32, 1.16, 0])
  b.box([1.05, 0.04, 0.58], C.black, [-0.32, 1.35, 0])
  for (let x = -0.72; x < 0.12; x += 0.18) b.beam([x, 1.41, -0.23], [x + 0.08, 1.42, 0.23], 0.025, C.brown)
  b.box([0.62, 0.6, 0.58], C.rust, [0.72, 0.86, 0])
  b.beam([-0.96, 1.28, -0.36], [-0.96, 2.42, -0.36], 0.035, C.steel)
  b.box([1.14, 0.5, 0.08], C.red, [-0.4, 2.2, -0.36])
  b.label('SUYA', [-0.4, 2.2, -0.305], 0.8, C.white, 0.035)
  b.box([0.74, 0.43, 0.08], C.yellow, [0.7, 2.2, -0.36])
  b.label('BOLI', [0.7, 2.2, -0.305], 0.52, C.black, 0.035)
  return b.finish()
}

function generator() {
  const b = new ModelBuilder('generator')
  b.box([1.25, 0.78, 0.74], C.charcoal, [0, 0.62, 0])
  b.cylinder(0.29, 0.62, C.steel, [0.2, 0.62, 0], [0, 0, Math.PI / 2], 10)
  b.box([0.4, 0.58, 0.62], C.red, [-0.39, 0.64, 0])
  for (const x of [-0.72, 0.72]) for (const z of [-0.47, 0.47]) b.beam([x, 0.1, z], [x, 1.16, z], 0.035, C.orange)
  for (const y of [0.1, 1.16]) for (const z of [-0.47, 0.47]) b.beam([-0.72, y, z], [0.72, y, z], 0.035, C.orange)
  b.cylinder(0.055, 0.36, C.black, [0.43, 1.22, -0.2], [0, 0, 0], 8)
  return b.finish()
}

function cart() {
  const b = new ModelBuilder('cart')
  wheel(b, 0, 0.36, 0.8, 0.34, 0.16)
  b.box([1.02, 0.42, 1.18], C.steel, [0, 0.82, 0.03], [-0.16, 0, 0])
  b.box([0.82, 0.2, 0.9], C.concrete2, [0, 0.95, 0.06], [-0.16, 0, 0])
  for (const x of [-0.42, 0.42]) {
    b.beam([x, 0.63, -0.32], [x, 0.62, -1.48], 0.035, C.steel)
    b.box([0.15, 0.1, 0.42], C.black, [x, 0.62, -1.5])
  }
  b.beam([-0.38, 0.36, -0.38], [-0.55, 0, -0.7], 0.035, C.steel)
  b.beam([0.38, 0.36, -0.38], [0.55, 0, -0.7], 0.035, C.steel)
  return b.finish()
}

function pole() {
  const b = new ModelBuilder('pole')
  b.cylinder(0.13, 6.2, C.brown, [0, 3.1, 0], [0, 0, 0], 10)
  b.beam([-1.35, 5.72, 0], [1.35, 5.72, 0], 0.08, C.brown)
  for (const x of [-1.08, 0, 1.08]) {
    b.cylinder(0.065, 0.27, C.cream, [x, 5.94, 0], [0, 0, 0], 8)
    b.cylinder(0.09, 0.045, C.steel, [x, 6.09, 0], [0, 0, 0], 8)
  }
  b.beam([-0.1, 4.6, 0], [-0.88, 5.66, 0], 0.035, C.steel)
  b.beam([0.1, 4.6, 0], [0.88, 5.66, 0], 0.035, C.steel)
  return b.finish()
}

function drain() {
  const b = new ModelBuilder('drain')
  b.box([0.92, 0.05, 3], C.concrete, [0, 0.025, 0])
  b.box([0.16, 0.16, 3], C.concrete2, [-0.46, 0.08, 0])
  b.box([0.16, 0.16, 3], C.concrete2, [0.46, 0.08, 0])
  b.box([0.58, 0.025, 3], C.charcoal, [0, 0.06, 0])
  for (let z = -1.35; z <= 1.35; z += 0.3) b.box([0.72, 0.035, 0.055], C.steel, [0, 0.13, z])
  return b.finish()
}

function gate() {
  const b = new ModelBuilder('gate')
  for (const x of [-2.45, 2.45]) {
    b.box([0.55, 2.7, 0.55], C.concrete2, [x, 1.35, 0])
    b.add(new ConeGeometry(0.39, 0.28, 4), C.concrete, [x, 2.84, 0], [0, Math.PI / 4, 0])
  }
  b.box([1.1, 1.65, 0.35], C.concrete, [-3.25, 0.825, 0])
  b.box([1.1, 1.65, 0.35], C.concrete, [3.25, 0.825, 0])
  for (const x of [-1.9, -1.55, -1.2, -0.85, -0.5, -0.15, 0.15, 0.5, 0.85, 1.2, 1.55, 1.9]) b.beam([x, 0.18, 0.04], [x, 2.42, 0.04], 0.035, C.black)
  for (const y of [0.2, 1.25, 2.4]) b.beam([-2.15, y, 0.04], [2.15, y, 0.04], 0.045, C.black)
  return b.finish()
}

function palm() {
  const b = new ModelBuilder('palm')
  b.add(new CylinderGeometry(0.42, 0.58, 0.62, 10), C.rust, [0, 0.31, 0])
  b.cylinder(0.18, 2.65, C.brown, [0, 1.83, 0], [0, 0, -0.07], 9)
  b.add(new IcosahedronGeometry(0.35, 1), C.green2, [0.18, 3.16, 0])
  for (let i = 0; i < 9; i++) {
    const angle = i * Math.PI * 2 / 9
    const end = [Math.sin(angle) * 1.15 + 0.18, 2.65 + (i % 2) * 0.13, Math.cos(angle) * 1.15]
    b.beam([0.18, 3.18, 0], end, 0.055, i % 2 ? C.green : C.green2, 5)
    b.add(new ConeGeometry(0.23, 0.82, 5), i % 2 ? C.green : C.green2, end, [Math.PI / 2, angle, 0])
  }
  return b.finish()
}

function shelter() {
  const b = new ModelBuilder('shelter')
  for (const x of [-1.65, 1.65]) for (const z of [-0.48, 0.48]) b.beam([x, 0, z], [x, 2.45, z], 0.045, C.steel)
  b.box([3.65, 0.16, 1.35], C.blue, [0, 2.48, 0])
  b.box([3.35, 1.62, 0.06], C.glass2, [0, 1.42, -0.53])
  b.box([2.62, 0.14, 0.55], C.brown, [0, 0.67, -0.05])
  for (const x of [-1.08, 0, 1.08]) b.beam([x, 0.12, -0.05], [x, 0.62, -0.05], 0.045, C.steel)
  b.box([1.1, 0.42, 0.06], C.white, [0, 1.76, -0.49])
  return b.finish()
}

function bump() {
  const b = new ModelBuilder('bump')
  for (let x = -1.5, i = 0; x < 1.5; x += 0.5, i++) b.add(new CylinderGeometry(0.24, 0.24, 0.5, 10, 1, false, 0, Math.PI), i % 2 ? C.yellow : C.black, [x + 0.25, 0, 0], [0, 0, Math.PI / 2])
  return b.finish()
}

function postbox() {
  const b = new ModelBuilder('postbox')
  b.cylinder(0.44, 1.42, C.red, [0, 0.86, 0], [0, 0, 0], 14)
  b.cylinder(0.52, 0.16, C.red, [0, 0.08, 0], [0, 0, 0], 14)
  b.add(new SphereGeometry(0.45, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), C.red, [0, 1.57, 0])
  b.box([0.48, 0.12, 0.035], C.black, [0, 1.24, 0.43])
  b.box([0.34, 0.42, 0.04], C.white, [0, 0.85, 0.435])
  b.box([0.2, 0.045, 0.05], C.black, [0, 0.79, 0.46])
  return b.finish()
}

function bollards() {
  const b = new ModelBuilder('bollards')
  for (const x of [-0.9, 0, 0.9]) {
    b.cylinder(0.15, 0.82, C.black, [x, 0.41, 0], [0, 0, 0], 10)
    b.cylinder(0.18, 0.16, C.steel, [x, 0.12, 0], [0, 0, 0], 10)
    b.add(new SphereGeometry(0.17, 10, 6), C.black, [x, 0.84, 0])
    b.box([0.31, 0.12, 0.03], C.white, [x, 0.56, 0.145])
  }
  return b.finish()
}

function pubsign() {
  const b = new ModelBuilder('pubsign')
  b.box([0.22, 2.75, 0.22], C.black, [0, 1.375, 0])
  b.add(new ConeGeometry(0.24, 0.26, 4), C.black, [0, 2.86, 0], [0, Math.PI / 4, 0])
  b.beam([0, 2.52, 0], [1.25, 2.52, 0], 0.06, C.black)
  b.beam([0.18, 2.5, 0], [0.68, 2.02, 0], 0.04, C.black)
  b.beam([1.06, 2.49, 0], [1.06, 2.12, 0], 0.025, C.black)
  b.box([1.08, 0.78, 0.08], C.cream, [1.06, 1.72, 0])
  b.box([1.17, 0.87, 0.035], C.green, [1.06, 1.72, 0.055])
  b.label('PUB', [1.06, 1.72, 0.09], 0.68, C.white, 0.035)
  return b.finish()
}

function beacon() {
  const b = new ModelBuilder('beacon')
  b.cylinder(0.24, 0.15, C.black, [0, 0.075, 0], [0, 0, 0], 12)
  for (let i = 0; i < 7; i++) b.cylinder(0.105, 0.34, i % 2 ? C.white : C.black, [0, 0.31 + i * 0.34, 0], [0, 0, 0], 10)
  b.cylinder(0.16, 0.1, C.black, [0, 2.52, 0], [0, 0, 0], 10)
  b.add(new SphereGeometry(0.28, 12, 8), C.orange, [0, 2.78, 0])
  return b.finish()
}

export const REGION_MODELS = {
  nigeria: [
    ['danfo', 'transport', danfo], ['keke', 'transport', keke], ['okada', 'transport', okada],
    ['bus', 'transport', bus], ['car', 'transport', car], ['stall', 'commerce', stall],
    ['stall-red', 'commerce', stallRed], ['stall-green', 'commerce', stallGreen],
    ['produce-goods', 'commerce', produceGoods], ['shop-goods', 'commerce', shopGoods], ['tyres', 'commerce', tyres],
    ['container-shop', 'commerce', containerShop], ['pos-kiosk', 'commerce', posKiosk], ['vulcanizer', 'commerce', vulcanizer],
    ['billboard', 'commerce', billboard], ['kiosk', 'commerce', kiosk], ['food', 'commerce', food], ['generator', 'utility', generator],
    ['water-tank', 'utility', waterTank], ['rubbish-bin', 'street', rubbishBin], ['lamp', 'utility', lamp],
    ['cart', 'street', cart], ['pole', 'utility', pole], ['drain', 'infrastructure', drain],
    ['gate', 'architecture', gate], ['palm', 'plant', palm], ['shelter', 'infrastructure', shelter],
    ['bump', 'infrastructure', bump], ['canoe', 'waterfront', canoe],
    ['mooring-posts', 'waterfront', mooringPosts], ['net-crates', 'waterfront', netCrates],
  ],
  manchester: [
    ['postbox', 'street', postbox], ['bollards', 'street', bollards],
    ['pubsign', 'commerce', pubsign], ['beacon', 'street', beacon],
  ],
}

export function modelStats(object) {
  object.updateMatrixWorld(true)
  const bounds = new Box3().setFromObject(object)
  let triangles = 0
  object.traverse(child => {
    if (!child.isMesh) return
    triangles += child.geometry.index ? child.geometry.index.count / 3 : child.geometry.attributes.position.count / 3
  })
  const round = value => Number(value.toFixed(3))
  return {
    min: bounds.min.toArray().map(round),
    max: bounds.max.toArray().map(round),
    dimensions: bounds.getSize(new Vector3()).toArray().map(round),
    triangles: Math.round(triangles),
  }
}

export function validateModel(object, name) {
  let meshes = 0
  object.traverse(child => {
    if (!child.isMesh) return
    meshes++
    if (!child.geometry.attributes.color) throw new Error(`${name} has no COLOR_0 data`)
  })
  if (meshes !== 1) throw new Error(`${name} has ${meshes} meshes; expected one`)
  const stats = modelStats(object)
  if (Math.abs(stats.min[1]) > 0.011) throw new Error(`${name} does not sit on y=0 (min ${stats.min[1]})`)
  return stats
}

export { C }
