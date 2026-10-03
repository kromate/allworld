import { createHash } from 'node:crypto'
import { configureShippedRoads, RoadAuthority } from '../vehicleRoutes.ts'
import type { VehicleRoadDataset } from '../../src/shared/vehicleRoadData.ts'

export const ROAD_ASSET = {
  path: '/__world-data/yaba-vehicles.json',
  bytes: 23347699,
  sha256: '44cf0458af265d8ceb5ad84216dc722e0df6e289e29b0acfcaf92b78127919e2',
  dataVersion: 'faa561cc10785242ae6b2e8993d78a8d7aa5f9742a2d81b9f1a6d81d69ae4847',
} as const
let ready: RoadAuthority | null = null

async function trustedDataset(assets: Fetcher): Promise<VehicleRoadDataset> {
  const response = await assets.fetch(`https://assets.invalid${ROAD_ASSET.path}`)
  if (response.status !== 200 || !response.body) throw new Error('Trusted road resource is unavailable.')
  const reader = response.body.getReader(), digest = createHash('sha256')
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
  let bytes = 0, text = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > ROAD_ASSET.bytes) { await reader.cancel(); throw new Error('Trusted road resource exceeds its reviewed size.') }
      digest.update(value); text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally { reader.releaseLock() }
  if (bytes !== ROAD_ASSET.bytes || digest.digest('hex') !== ROAD_ASSET.sha256) throw new Error('Trusted road resource does not match the reviewed release.')
  // The exact reviewed file digest authenticates this build-time resource. RoadAuthority
  // independently checks its canonical digest and graph geometry before exposing it.
  const data = JSON.parse(text) as VehicleRoadDataset
  if (data.dataVersion !== ROAD_ASSET.dataVersion) throw new Error('Trusted road resource version differs.')
  return data
}

export async function prepareCloudflareRoads(assets: Fetcher): Promise<void> {
  if (ready) return
  const authority = new RoadAuthority(await trustedDataset(assets))
  configureShippedRoads(() => ({ authority, reason: '' }))
  ready = authority
}
