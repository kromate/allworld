// Minimal Mapbox Vector Tile decoder (spec 2.1). Only what the world needs: layers, typed
// properties and geometry as rings in tile units.

export type TagValue = string | number | boolean
export interface TileFeature {
  id: number | null
  /** 1 point, 2 line, 3 polygon. */
  type: 1 | 2 | 3
  tags: Record<string, TagValue>
  /** Points: one ring of points. Lines: one ring per line. Polygons: rings in file order. */
  rings: [number, number][][]
}
export interface TileLayer { name: string; extent: number; features: TileFeature[] }

class Reader {
  private readonly view: DataView
  pos: number
  readonly end: number
  private readonly bytes: Uint8Array

  constructor(bytes: Uint8Array, pos = 0, end = bytes.length) {
    this.bytes = bytes
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.pos = pos
    this.end = end
  }

  varint(): number {
    let result = 0, shift = 0
    for (;;) {
      const byte = this.bytes[this.pos++]!
      result += (byte & 0x7f) * 2 ** shift
      if (byte < 0x80) return result
      shift += 7
    }
  }

  svarint(): number {
    const value = this.varint()
    return value % 2 === 1 ? -(value + 1) / 2 : value / 2
  }

  sub(): Reader {
    const length = this.varint()
    const reader = new Reader(this.bytes, this.pos, this.pos + length)
    this.pos += length
    return reader
  }

  string(): string {
    const length = this.varint()
    const text = new TextDecoder().decode(this.bytes.subarray(this.pos, this.pos + length))
    this.pos += length
    return text
  }

  float(): number { const value = this.view.getFloat32(this.pos, true); this.pos += 4; return value }
  double(): number { const value = this.view.getFloat64(this.pos, true); this.pos += 8; return value }

  skip(wire: number): void {
    if (wire === 0) this.varint()
    else if (wire === 1) this.pos += 8
    else if (wire === 2) this.pos += this.varint()
    else if (wire === 5) this.pos += 4
    else throw new Error(`Unsupported wire type ${wire}`)
  }
}

function readValue(reader: Reader): TagValue {
  let value: TagValue = ''
  while (reader.pos < reader.end) {
    const key = reader.varint()
    const field = key >> 3
    if (field === 1) value = reader.string()
    else if (field === 2) value = reader.float()
    else if (field === 3) value = reader.double()
    else if (field === 4 || field === 5) value = reader.varint()
    else if (field === 6) value = reader.svarint()
    else if (field === 7) value = reader.varint() !== 0
    else reader.skip(key & 7)
  }
  return value
}

function readGeometry(reader: Reader, type: number): [number, number][][] {
  const rings: [number, number][][] = []
  let ring: [number, number][] = []
  let x = 0, y = 0
  while (reader.pos < reader.end) {
    const command = reader.varint()
    const id = command & 7
    const count = command >> 3
    if (id === 1 || id === 2) {
      for (let i = 0; i < count; i++) {
        x += reader.svarint()
        y += reader.svarint()
        // A MoveTo starts a new line or ring; for points every MoveTo is one more point.
        if (id === 1 && type !== 1 && ring.length) { rings.push(ring); ring = [] }
        ring.push([x, y])
      }
    } else if (id === 7) {
      if (ring.length) { rings.push(ring); ring = [] }
    }
  }
  if (ring.length) rings.push(ring)
  return rings
}

function readLayer(reader: Reader): TileLayer {
  const keys: string[] = []
  const values: TagValue[] = []
  const pending: Reader[] = []
  let name = ''
  let extent = 4096
  while (reader.pos < reader.end) {
    const key = reader.varint()
    const field = key >> 3
    if (field === 1) name = reader.string()
    else if (field === 2) pending.push(reader.sub())
    else if (field === 3) keys.push(reader.string())
    else if (field === 4) values.push(readValue(reader.sub()))
    else if (field === 5) extent = reader.varint()
    else reader.skip(key & 7)
  }
  const features = pending.map(feature => {
    let id: number | null = null
    let type: 1 | 2 | 3 = 1
    const tags: Record<string, TagValue> = {}
    let geometry: Reader | null = null
    while (feature.pos < feature.end) {
      const key = feature.varint()
      const field = key >> 3
      if (field === 1) id = feature.varint()
      else if (field === 2) {
        const packed = feature.sub()
        while (packed.pos < packed.end) {
          const tagKey = keys[packed.varint()]
          const tagValue = values[packed.varint()]
          if (tagKey !== undefined && tagValue !== undefined) tags[tagKey] = tagValue
        }
      } else if (field === 3) type = feature.varint() as 1 | 2 | 3
      else if (field === 4) geometry = feature.sub()
      else feature.skip(key & 7)
    }
    return { id, type, tags, rings: geometry ? readGeometry(geometry, type) : [] }
  })
  return { name, extent, features }
}

export function decodeTile(bytes: Uint8Array): Map<string, TileLayer> {
  const reader = new Reader(bytes)
  const layers = new Map<string, TileLayer>()
  while (reader.pos < reader.end) {
    const key = reader.varint()
    if (key >> 3 === 3) { const layer = readLayer(reader.sub()); layers.set(layer.name, layer) }
    else reader.skip(key & 7)
  }
  return layers
}

/** Signed area in tile units. Positive for exterior rings (clockwise with y pointing down). */
export function ringArea(ring: [number, number][]): number {
  let sum = 0
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) sum += (ring[j]![0] - ring[i]![0]) * (ring[i]![1] + ring[j]![1])
  return sum / 2
}
