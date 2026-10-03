import * as THREE from 'three'
import type { District } from '../../geo/district.ts'
import type { Vec2 } from '../../shared/geo.ts'
import type { FootObstacleGrid } from '../../shared/worldCollision.ts'
import type { StreetNavigator } from '../nav.ts'
import { loadPack, parseModel } from '../packs.ts'
import { REGION_BUDGETS, regionKitFor } from './kits.ts'
import type { ModelName, RegionQuality } from './kits.ts'
import { regionPlacements } from './placement.ts'
import type { ModelFootprint, Placement } from './placement.ts'
import { arrivalDirection } from './placement.ts'
import { createRegionTraffic } from './traffic.ts'
import type { RegionTraffic } from './traffic.ts'
import { createStreetLife } from './streetLife.ts'
import type { StreetLife } from './streetLife.ts'
import { createFrontageSigns } from './frontages.ts'
import type { FrontageSigns } from './frontages.ts'
import { ambience } from '../ambience.ts'
import type { AmbienceSource } from '../ambience.ts'

export { REGION_BUDGETS, REGION_KITS, regionKitFor } from './kits.ts'
export type { RegionKit, RegionQuality } from './kits.ts'
export interface RegionLayerInput {
  district: District; navigator: StreetNavigator; focus: Vec2; quality: RegionQuality
  countryCode: string; areaLabel: string; hour: number
  streetLife?: boolean
}
export interface RegionLayer {
  root: THREE.Group
  update(dt: number, player: Vec2, obstacles?: FootObstacleGrid<string>): void
  peoplePositions(): Vec2[]
  setNight(amount: number): void
  setView(camera: THREE.Vector3, focus: THREE.Vector3): void
  setActivity(state: { idle: boolean; suspended: boolean }): void
  dispose(): void
  stats: { instances: number; triangles: number; textureBytes: number }
}
interface Pool { mesh: THREE.InstancedMesh; triangles: number }

export async function buildRegionLayer(input: RegionLayerInput): Promise<RegionLayer | null> {
  const kit = regionKitFor(input.countryCode, input.areaLabel)
  if (!kit) return null
  const phone = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches
  const quality = phone && input.quality === 'high' ? 'low' : input.quality
  const baseBudget = REGION_BUDGETS[quality]
  const budget = phone ? { ...baseBudget, instances: Math.min(baseBudget.instances, quality === 'low' ? 40 : 64) } : baseBudget
  const root = new THREE.Group()
  root.name = `region:${kit.id}`
  root.userData.description = kit.description
  root.userData.effectiveQuality = quality
  const pools = new Map<ModelName, Pool[]>(), footprints = new Map<ModelName, ModelFootprint>()
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>(), textures = new Set<THREE.Texture>()
  let disposed = false
  let traffic: RegionTraffic | null = null, people: StreetLife | null = null, signs: FrontageSigns | null = null
  let explicitActive: boolean | null = null, active = true, suspended = false
  let currentPlayer = { ...input.focus }, previousPlayer = { ...input.focus }, heading = 0, audioClock = 1
  let activePlacements: Placement[] = []
  let staticTriangles = 0, staticInstances = 0, baseTextureBytes = 0
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    traffic?.dispose(); people?.dispose(); signs?.dispose(); ambience.setRegionContext(null, root.uuid)
    root.removeFromParent()
    root.traverse(object => { if (object instanceof THREE.InstancedMesh) object.dispose() })
    geometries.forEach(g => g.dispose()); materials.forEach(m => m.dispose()); textures.forEach(t => t.dispose())
    root.clear()
  }
  const stats = { instances: 0, triangles: 0, textureBytes: 0 }
  try {
    const pack = await loadPack(kit.pack)
    // Sequential parsing avoids spiking memory on phones.
    const names = kit.models.filter(name => name !== 'bump' && name !== 'beacon')
    for (const name of names) {
      const gltf = await parseModel(pack, name)
      gltf.scene.updateMatrixWorld(true)
      const bounds = new THREE.Box3().setFromObject(gltf.scene), size = bounds.getSize(new THREE.Vector3()), center = bounds.getCenter(new THREE.Vector3())
      footprints.set(name, { width: size.x, depth: size.z, height: size.y })
      const parts: Pool[] = []
      gltf.scene.traverse(object => {
        if (!(object instanceof THREE.Mesh)) return
        const geometry = object.geometry
        geometry.applyMatrix4(object.matrixWorld).translate(-center.x, -bounds.min.y, -center.z)
        geometries.add(geometry)
        const meshMaterials = Array.isArray(object.material) ? object.material : [object.material]
        meshMaterials.forEach(material => {
          materials.add(material)
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value)
        })
        const mesh = new THREE.InstancedMesh(geometry, object.material, budget.instances)
        mesh.name = `region:${name}`
        mesh.count = 0
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage)
        mesh.castShadow = quality === 'high' && !phone
        mesh.receiveShadow = true
        root.add(mesh)
        parts.push({ mesh, triangles: (geometry.index?.count ?? geometry.getAttribute('position').count) / 3 })
      })
      pools.set(name, parts)
    }
    textures.forEach(t => {
      const image: unknown = t.image
      if (image && typeof image === 'object' && 'width' in image && 'height' in image && typeof image.width === 'number' && typeof image.height === 'number') stats.textureBytes += image.width * image.height * 4 * 4 / 3
    })
  } catch (error) {
    dispose()
    throw error
  }
  try {
    const placements = regionPlacements(input.district, input.navigator, kit, footprints)
    root.userData.placementCount = placements.length
    root.userData.regionFootprints = placements.map(p => ({ ...p, ...footprints.get(p.model) }))
    const transform = new THREE.Object3D(), tint = new THREE.Color()
    const templates = new Map([...pools].map(([name, parts]) => [String(name), parts.map(p => ({ geometry: p.mesh.geometry, material: p.mesh.material }))]))
    if (kit.profile === 'planned') templates.delete('danfo')
    traffic = createRegionTraffic({ ...input, quality, templates })
    root.add(traffic.root)
    signs = createFrontageSigns({ district: input.district, placements: [], quality, countryCode: input.countryCode })
    root.add(signs.root)
    people = await createStreetLife({ ...input, quality, maxActors: phone ? (quality === 'low' ? 2 : 3) : undefined, placements, enabled: input.streetLife !== false })
    root.add(people.root)
    root.userData.streetLifeDisclosure = 'People without a name tag are street life, not members.'
    root.userData.streetLifeApproval = input.streetLife !== false ? 'enabled-by-default' : 'explicitly-disabled'
    const arrival = arrivalDirection(input.district)
    heading = Math.atan2(arrival.x, arrival.z)
    root.userData.regionDiagnostics = { traffic: traffic.diagnostics, people: people.diagnostics, arrivalItems: placements.filter(p => Math.hypot(p.pos.x - arrival.pos.x, p.pos.z - arrival.pos.z) < 45 && (p.pos.x - arrival.pos.x) * arrival.x + (p.pos.z - arrival.pos.z) * arrival.z > 0).length, profile: kit.profile, kit: kit.id, active: true }
    const pavingCanvas = document.createElement('canvas')
    pavingCanvas.width = pavingCanvas.height = 128
    const ctx = pavingCanvas.getContext('2d')!
    ctx.fillStyle = '#776d5d'; ctx.fillRect(0, 0, 128, 128)
    for (let y = 0; y < 8; y++) for (let x = -1; x < 8; x++) {
      const shade = 122 + ((x * 17 + y * 31 + 53) % 37)
      ctx.fillStyle = `rgb(${shade + 13},${shade + 4},${shade - 12})`
      ctx.fillRect(x * 20 + (y % 2) * 10 + 1, y * 16 + 1, 18, 14)
    }
    const pavingTexture = new THREE.CanvasTexture(pavingCanvas)
    pavingTexture.colorSpace = THREE.SRGBColorSpace
    const pavingGeometry = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
    const pavingMaterial = new THREE.MeshStandardMaterial({ map: pavingTexture, roughness: 1, color: kit.ground })
    const paving = new THREE.InstancedMesh(pavingGeometry, pavingMaterial, budget.instances)
    paving.name = 'region:shop-paving'; paving.receiveShadow = true
    root.add(paving); geometries.add(pavingGeometry); materials.add(pavingMaterial); textures.add(pavingTexture)
    stats.textureBytes = Math.ceil(stats.textureBytes + 128 * 128 * 4 * 4 / 3)
    const wireGeometry = new THREE.BufferGeometry()
    const wireVertices = new Float32Array(budget.wires * 2 * 12 * 2 * 3)
    wireGeometry.setAttribute('position', new THREE.BufferAttribute(wireVertices, 3).setUsage(THREE.DynamicDrawUsage))
    const wireMaterial = new THREE.LineBasicMaterial({ color: '#292b2b' })
    const wires = new THREE.LineSegments(wireGeometry, wireMaterial)
    wires.frustumCulled = false
    wires.name = 'region:overhead-cables'
    root.add(wires); geometries.add(wireGeometry); materials.add(wireMaterial)

    const glowGeometry = new THREE.SphereGeometry(0.085, 6, 4)
    const glowMaterial = new THREE.MeshBasicMaterial({ color: '#ffce7b', toneMapped: false })
    const glow = new THREE.InstancedMesh(glowGeometry, glowMaterial, budget.instances)
    glow.name = 'region:shop-bulbs'; glow.count = 0
    geometries.add(glowGeometry); materials.add(glowMaterial); root.add(glow)
    const lamps = Array.from({ length: phone || quality === 'low' ? 1 : 2 }, () => {
      const lamp = new THREE.PointLight('#ffdb9d', 0, 14, 2)
      root.add(lamp)
      return lamp
    })
    let night = input.hour < 6 || input.hour >= 19 ? 1 : 0
    const isLit = (p: Placement): boolean => ['stall', 'stall-red', 'stall-green', 'food', 'kiosk', 'container-shop', 'pos-kiosk', 'shelter', 'lamp'].includes(p.model) && p.seed % 7 !== 0
    const decorationCost = (p: Placement): number => isLit(p) ? (glowGeometry.index?.count ?? 0) / 3 + 2 : 0
    let last = { x: Infinity, z: Infinity }
    const rebuild = (player: Vec2): void => {
      last = { ...player }
      const selected: Placement[] = []
      let triangles = 0
      const nearby = placements.map(p => ({ p, d: Math.hypot(p.pos.x - player.x, p.pos.z - player.z) }))
        .filter(p => p.d < budget.radius).sort((a, b) => ((b.p.priority ?? 0) - (a.p.priority ?? 0)) * 30 + a.d - b.d || a.p.seed - b.p.seed)
      for (const { p } of nearby) {
        const cost = (pools.get(p.model) ?? []).reduce((sum, part) => sum + part.triangles, 0) + decorationCost(p)
        if (selected.length >= budget.instances) break
        if (triangles + cost > budget.triangles) continue
        triangles += cost
        selected.push(p)
      }
      for (const [name, parts] of pools) {
        const items = selected.filter(p => p.model === name)
        for (const { mesh } of parts) {
          mesh.count = items.length
          items.forEach((p, i) => {
            transform.position.set(p.pos.x, 0.08, p.pos.z)
            transform.rotation.set(0, p.angle, 0); transform.scale.set(1, 1, 1); transform.updateMatrix()
            mesh.setMatrixAt(i, transform.matrix)
            const shade = 0.9 + (p.seed % 100) / 1000
            tint.setRGB(shade, shade, shade)
            mesh.setColorAt(i, tint)
          })
          mesh.instanceMatrix.needsUpdate = true
          if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true
          mesh.computeBoundingSphere()
        }
      }
      const lit = selected.filter(isLit)
      paving.count = lit.length
      lit.forEach((p, i) => {
        const size = footprints.get(p.model)!
        transform.position.set(p.pos.x, 0.079, p.pos.z)
        transform.rotation.set(0, p.angle, 0); transform.scale.set(size.width + 0.4, 1, size.depth + 0.4)
        transform.updateMatrix(); paving.setMatrixAt(i, transform.matrix)
      })
      paving.instanceMatrix.needsUpdate = true; paving.computeBoundingSphere()
      transform.scale.set(1, 1, 1)
      glow.count = lit.length
      lit.forEach((p, i) => {
        transform.position.set(p.pos.x, 2.04, p.pos.z)
        transform.rotation.set(0, 0, 0); transform.updateMatrix(); glow.setMatrixAt(i, transform.matrix)
      })
      glow.instanceMatrix.needsUpdate = true; glow.computeBoundingSphere()
      lamps.forEach((lamp, i) => {
        const p = lit[i]
        lamp.position.set(p?.pos.x ?? 0, p?.model === 'lamp' ? 4.1 : 3.1, p?.pos.z ?? 0)
        lamp.intensity = p ? night * 65 : 0
        lamp.userData.active = !!p
      })
      let cursor = 0, links = 0
      const poles = selected.filter(p => p.model === 'pole')
      const linked = new Set<string>()
      for (const p of poles) {
        if (links >= budget.wires) break
        const q = poles.filter(q => q !== p && q.side === p.side && Math.abs(Math.sin(q.angle - p.angle)) < 0.25 && Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z) < 65)
          .filter(q => Array.from({ length: 12 }, (_, i) => (i + 1) / 13).every(t => input.navigator.walkable({ x: p.pos.x + (q.pos.x - p.pos.x) * t, z: p.pos.z + (q.pos.z - p.pos.z) * t })))
          .sort((a, b) => Math.hypot(a.pos.x - p.pos.x, a.pos.z - p.pos.z) - Math.hypot(b.pos.x - p.pos.x, b.pos.z - p.pos.z))[0]
        if (!q) continue
        const key = [p.seed, q.seed].sort().join(':')
        if (linked.has(key)) continue
        linked.add(key); links++
        const height = (footprints.get('pole')?.height ?? 7) - 0.45
        const length = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z)
        const nx = (q.pos.z - p.pos.z) / length, nz = -(q.pos.x - p.pos.x) / length
        for (const offset of [-0.32, 0.32]) for (let n = 0; n < 12; n++) for (const t of [n / 12, (n + 1) / 12]) {
          wireVertices[cursor++] = p.pos.x + (q.pos.x - p.pos.x) * t + offset * nx
          wireVertices[cursor++] = height - Math.sin(t * Math.PI) * 0.65
          wireVertices[cursor++] = p.pos.z + (q.pos.z - p.pos.z) * t + offset * nz
        }
      }
      wireGeometry.setDrawRange(0, cursor / 3)
      wireGeometry.getAttribute('position').needsUpdate = true
      activePlacements = selected
      staticInstances = selected.length
      staticTriangles = triangles
      signs?.update(selected)
      stats.instances = staticInstances + (traffic?.stats.instances ?? 0) + (people?.stats.instances ?? 0)
      stats.triangles = staticTriangles + (traffic?.stats.triangles ?? 0) + (people?.stats.triangles ?? 0) + (signs?.stats.triangles ?? 0)
      root.userData.activePlacements = selected.map(p => ({ model: p.model, x: p.pos.x, z: p.pos.z, angle: p.angle }))
    }
    const setNight = (amount: number): void => {
      night = Number.isFinite(amount) ? THREE.MathUtils.clamp(amount, 0, 1) : 0
      traffic?.setNight(night); signs?.setNight(night)
      glow.visible = night > 0.1
      glowMaterial.color.set('#ffce7b').multiplyScalar(0.5 + night * 1.5)
      lamps.forEach(lamp => { lamp.visible = night > .1; lamp.intensity = lamp.userData.active ? night * 65 : 0 })
    }
    baseTextureBytes = stats.textureBytes
    const syncStats = (): void => {
      stats.instances = staticInstances + (traffic?.stats.instances ?? 0) + (people?.stats.instances ?? 0)
      stats.triangles = staticTriangles + (traffic?.stats.triangles ?? 0) + (people?.stats.triangles ?? 0) + (signs?.stats.triangles ?? 0)
      stats.textureBytes = baseTextureBytes + (signs?.stats.textureBytes ?? 0) + (people?.stats.textureBytes ?? 0)
    }
    const updateAudio = (): void => {
      const sources: AmbienceSource[] = []
      for (const p of activePlacements) {
        const kind = p.model === 'generator' ? 'generator' : /stall|kiosk|food|shop/.test(p.model) ? (p.seed % 5 === 0 ? 'music' : 'market') : /canoe|mooring|net-crates/.test(p.model) ? 'water' : null
        if (kind) sources.push({ kind, x: p.pos.x, z: p.pos.z, gain: .75 })
      }
      for (const p of traffic?.diagnostics.positions ?? []) sources.push({ kind: p.model === 'okada' || p.model === 'keke' ? 'motorcycle' : 'traffic', x: p.x, z: p.z, gain: .7 })
      sources.sort((a, b) => Math.hypot(a.x - currentPlayer.x, a.z - currentPlayer.z) - Math.hypot(b.x - currentPlayer.x, b.z - currentPlayer.z))
      ambience.setRegionContext({ sources: sources.slice(0, 6), listener: { ...currentPlayer, heading }, hour: night > .5 ? 21 : input.hour, active: !suspended }, root.uuid)
    }
    const setActivity = (state: { idle: boolean; suspended: boolean }): void => {
      suspended = state.suspended
      explicitActive = !state.suspended
      active = explicitActive
      traffic?.setActive(active); people?.setActive(active)
      root.userData.regionDiagnostics.active = active
      updateAudio()
    }
    root.userData.setActivity = setActivity
    rebuild(input.focus); setNight(night); syncStats(); updateAudio()
    return {
      root, stats, dispose, setNight, setActivity,
      setView(camera, focus) { signs?.setView(camera, focus); syncStats() },
      peoplePositions: () => people?.positions() ?? [],
      update(dt, player, obstacles) {
        if (disposed) return
        currentPlayer = { ...player }
        const dx = player.x - previousPlayer.x, dz = player.z - previousPlayer.z
        if (Math.hypot(dx, dz) > .04) heading = Math.atan2(dx, dz)
        previousPlayer = { ...player }
        // Idle still advances the street at the governor cadence; suspension stops it.
        active = explicitActive ?? !suspended
        traffic?.update(dt, player, active); people?.update(dt, player, active, obstacles)
        if (Math.hypot(player.x - last.x, player.z - last.z) > 12) rebuild(player)
        root.userData.regionDiagnostics.active = active
        syncStats()
        audioClock += Math.max(0, dt)
        if (audioClock > .45) { audioClock = 0; updateAudio() }
      },
    }
  } catch (error) {
    dispose()
    throw error
  }
}
