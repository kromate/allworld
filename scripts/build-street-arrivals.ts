// Compile public arrivals from the exact map and scene used by the shipped road authority.
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildDistrict, chooseArrival } from '../src/geo/district.ts'
import { parseDistrictId } from '../src/shared/geo.ts'
import { canonicalVehicleRoadJson } from '../src/shared/vehicleRoadData.ts'
import type { VehicleRoadDataset } from '../src/shared/vehicleRoadData.ts'
import { PERSON_RADIUS } from '../src/shared/worldCollision.ts'
import { RoadAuthority } from '../service/vehicleRoutes.ts'

const root = new URL('../', import.meta.url)
const sha = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
const data: VehicleRoadDataset = JSON.parse(readFileSync(new URL('service/data/transport/yaba-vehicles.json', root), 'utf8'))
const roads = new RoadAuthority(data)
if (sha(JSON.stringify(data.source.sceneSources)) !== data.source.sceneHash) throw new Error('Scene source manifest does not match its hash.')
for (const source of data.source.sceneSources) if (sha(readFileSync(new URL(source.path, root))) !== source.sha256) throw new Error(`Scene source differs: ${source.path}`)
const districts = data.source.tiles.map(tile => {
  const parsed = parseDistrictId(tile.districtId)
  if (!parsed) throw new Error('Invalid compiled district.')
  const bytes = readFileSync(new URL(`service/data/transport/source/${parsed.z}-${parsed.x}-${parsed.y}.pbf`, root))
  if (sha(bytes) !== tile.sha256) throw new Error(`Tile differs: ${tile.districtId}`)
  const scene = buildDistrict(tile.districtId, bytes, data.mapDataVersion)
  const arrival = chooseArrival(scene)
  // Refuse a bad public point rather than shifting it towards a private doorway.
  if (!roads.standable(tile.districtId, arrival.pos, PERSON_RADIUS)) throw new Error(`Public arrival is obstructed: ${tile.districtId}`)
  return { districtId: tile.districtId, span: scene.span, tileSha256: tile.sha256, pos: arrival.pos, heading: arrival.heading, label: arrival.label }
})
const payload = { schemaVersion: 1, roadDataVersion: data.dataVersion, sceneHash: data.source.sceneHash, districts }
const result = JSON.stringify({ ...payload, dataVersion: sha(canonicalVehicleRoadJson(payload)) }, null, 2) + '\n'
const target = new URL('service/data/transport/street-arrivals.json', root)
if (process.argv.includes('--check')) {
  if (readFileSync(target, 'utf8') !== result) throw new Error('Street arrivals need rebuilding.')
} else writeFileSync(target, result)
console.log(`TRUSTED STREET ARRIVALS: ${districts.length} exact compiled tiles; ${fileURLToPath(target)}`)
