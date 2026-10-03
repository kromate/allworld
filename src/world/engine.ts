// The world engine: renderer, camera, input, the local avatar, remote avatars and the two scene
// kinds (street district and interior). Vue talks to it through methods and the events below.
import * as THREE from 'three'
import { homeFurniturePointerFor } from './homeFurniturePointer.ts'
import type { HomeFurniturePointer } from './homeFurniturePointer.ts'
import type { HomeId, RoomKey, MemberId, VehicleId } from '../shared/ids.ts'
import type { Vec2 } from '../shared/geo.ts'
import { FootObstacleGrid, moveFoot, PERSON_RADIUS, vehicleFootObstacle } from '../shared/worldCollision.ts'
import { neighbouringDistricts } from '../shared/geo.ts'
import type { AvatarLook, FaceScan, PresenceMember } from '../shared/model.ts'
import { MAX_SPEED } from '../shared/model.ts'
import type { HomePlan } from '../shared/homes.ts'
import type { PlacedItem } from '../shared/social.ts'
import type { District, Poi } from '../geo/district.ts'
import { AvatarActor } from './avatars.ts'
import { buildDistrictScene } from './districtScene.ts'
import type { DistrictScene, Quality } from './districtScene.ts'
import { buildInterior } from './interior.ts'
import { buildHomeExterior, exteriorCameraBuildings } from './homeExterior.ts'
import { HOME_PHYSICAL } from '../shared/homes.ts'
import type { HomeExteriorScenery, HomeExteriorEntry } from '../shared/homes.ts'
import type { InteriorScene, InteriorSpec, InteriorStation } from './interior.ts'
import type { HomeGhost } from './homeScene.ts'
import { navigationFor } from './nav.ts'
import type { StreetNavigator } from './nav.ts'
import { CameraObstacles } from './cameraCollision.ts'
import { makeSky } from './sky.ts'
import { surfaceDiagnostics } from './surfaceMaterials.ts'
import { textureMemory } from './surfaceMemory.ts'
import { makeContactShadows } from './surfaceContact.ts'
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js'
import { loadDistrict } from '../geo/district.ts'
import { DistrictMinimap } from './minimap.ts'
import { packCacheStats } from './packs.ts'
import { FrameGovernor, TIER_PRESETS, chooseInitialTier } from './governor.ts'
import type { PowerMode, GovernorSnapshot } from './governor.ts'
import { GpuBudget } from './gpuBudget.ts'
import { loadRegionLayer, regionObstacles } from './regionMount.ts'
import { ambience } from './ambience.ts'
import type { RegionLayer } from './regionMount.ts'
import { STARTER_PLACES } from '../shared/places.ts'
import { districtIdOf } from '../shared/geo.ts'
import type { MinimapOptions } from './minimap.ts'
import type { VehicleSnapshot, VehicleSelf, VehicleControls, VehicleEvent } from '../shared/vehicles.ts'
import { NEUTRAL_CONTROLS, VEHICLE_RULES } from '../shared/vehicles.ts'
import { detourAhead, DETOUR_REPLANS, standingNear } from './footDetour.ts'
import { VehicleScene } from './vehicles/scene.ts'
import { vehicleDistrictContext } from './vehicles/provenance.ts'

export type MemberGesture = Parameters<AvatarActor['gesture']>[0]
export type BroadcastGesture = Exclude<MemberGesture, 'work'>
export interface LocationContext { countryCode: string; areaLabel: string }
export interface DistrictOptions extends Partial<LocationContext> { memberId?: MemberId; spreadArrival?: boolean; authoritative?: boolean; prepared?: PreparedVehicleDistrict }
export interface PreparedVehicleDistrict { district: District; navigator: StreetNavigator; scene: DistrictScene; region: RegionLayer; regionNavigator: StreetNavigator; context: LocationContext; dispose(): void }

export type EdgeDirection = 'north' | 'south' | 'east' | 'west'

export interface EngineEvents {
  /** Throttled local movement, for the network and the HUD. */
  local(pos: Vec2, heading: number, moving: boolean): void
  nearVenue(poi: Poi | null): void
  nearDoor(near: boolean): void
  nearHome?(entry: HomeExteriorEntry | null): void
  nearStation?(station: InteriorStation | null): void
  edge(direction: EdgeDirection | null): void
  pickMember(memberId: MemberId | null): void
  pickItem(key: string | null): void
  floorClick(pos: Vec2): void
  status(status: EngineStatus): void
  rescued(): void
  gesture?(kind: BroadcastGesture): void
  vehicleInput?(intent: VehicleControls): void
  /** Identifies a drawn vehicle only; approach and boarding remain service-checked. */
  vehicleHit?(vehicleId: VehicleId): void
}

export interface EngineStatus { fps: number; quality: Quality; shadows: boolean; pixelRatio: number; triangles: number; degraded: boolean; drawCalls?: number; sceneBuildMs?: number; regionDescription?: string | null }
export interface WorldDiagnostics extends EngineStatus { drawCalls: number; sceneBuildMs: number; cameraDistance: number; requestedCameraDistance: number; cameraOccluded: boolean; cameraPosition: { x: number; y: number; z: number }; cameraTarget: { x: number; y: number; z: number }; mode: WorldEngine['mode']; textures: ReturnType<typeof textureMemory>; surfaces: ReturnType<typeof surfaceDiagnostics>; shadowBytes: number; streamed: Record<string, unknown>; governor: GovernorSnapshot | null; region: { state: string; error: string | null; instances: number; triangles: number; textureBytes: number }; localSpeed: number; packCache: ReturnType<typeof packCacheStats> }

interface Remote {
  actor: AvatarActor
  target: Vec2
  heading: number
  moving: boolean
  tag: THREE.Sprite
  tagKey: string
  faceVersion: number
  speed: number
  transport: PresenceMember['transport']
}

// Matched to the stride of the walk and run clips so feet do not slide.
const WALK_SPEED = 1.9
const SPRINT_SPEED = 5.2

function nameTag(name: string, relation: PresenceMember['relation'], voice: PresenceMember['voice']): THREE.Sprite {
  const canvas = document.createElement('canvas')
  const context = canvas.getContext('2d')!
  const font = '600 28px ui-rounded, "SF Pro Rounded", system-ui, sans-serif'
  context.font = font
  // Preserve name joiners while removing other control and format characters.
  const clean = name.normalize('NFC').replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\u200c' || character === '\u200d' ? character : '').replace(/\s+/gu, ' ').trim() || 'Player'
  const segmenter = typeof Intl.Segmenter === 'function' ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null
  // Without segmentation, retain a short whole name or show an ellipsis; never split it.
  const clusters = segmenter ? Array.from(segmenter.segment(clean), part => part.segment) : Array.from(clean).length <= 24 ? [clean] : []
  const shown = clusters.slice(0, 24)
  const prefix = voice === 'live' ? '🎙 ' : voice === 'muted' ? '🔇 ' : ''
  let shortName = shown.join('') + (clusters.length > shown.length || !shown.length ? '…' : '')
  while (shown.length && context.measureText(prefix + shortName).width > 240) { shown.pop(); shortName = shown.join('') + '…' }
  const label = prefix + shortName
  const width = Math.ceil(context.measureText(label).width) + 34
  canvas.width = width * 2
  canvas.height = 96
  context.scale(2, 2)
  context.font = font
  context.fillStyle = relation === 'friend' ? 'rgba(255,176,32,0.98)' : 'rgba(28,26,36,0.96)'
  context.beginPath()
  context.roundRect(0, 0, width, 48, 24)
  context.fill()
  context.fillStyle = relation === 'friend' ? '#241a05' : '#ffffff'
  context.textBaseline = 'middle'
  context.fillText(label, 17, 25)
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: true, depthWrite: false, transparent: true, sizeAttenuation: false }))
  sprite.userData.aspect = width / 48
  sprite.scale.set((width / 48) * 0.34, 0.34, 1)
  sprite.renderOrder = 6
  return sprite
}

function disposeTag(tag: THREE.Sprite): void {
  tag.removeFromParent()
  tag.material.map?.dispose()
  tag.material.dispose()
}

export const guessQuality = (): Quality => chooseInitialTier()

const QUALITY_ORDER: readonly Quality[] = ['low', 'medium', 'high']
function limitedQuality(requested: Quality, governed: Quality): Quality {
  return QUALITY_ORDER[Math.min(QUALITY_ORDER.indexOf(requested), QUALITY_ORDER.indexOf(governed))] ?? 'low'
}
function memberGesture(kind: string): MemberGesture | null {
  switch (kind) {
    case 'wave': case 'nod': case 'work': case 'clap': case 'cheer': case 'talk': case 'dance': return kind
    default: return null
  }
}

export class WorldEngine {
  private readonly renderer: THREE.WebGLRenderer
  private readonly scene = new THREE.Scene()
  private readonly atmosphere = makeSky()
  private readonly contacts = makeContactShadows()
  private environment: THREE.WebGLRenderTarget | null = null
  private prefetchedDistrict: string | null = null
  private readonly camera = new THREE.PerspectiveCamera(55, 1, 0.08, 1800)
  private readonly sun = new THREE.DirectionalLight('#fff4e0', 2.4)
  private readonly sky = new THREE.HemisphereLight('#cfe6ff', '#b9a98c', 1.1)
  private readonly playerFill = new THREE.DirectionalLight('#bed1ee', 0.2)
  private readonly raycaster = new THREE.Raycaster()
  private readonly groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  private readonly events: EngineEvents
  private readonly canvas: HTMLCanvasElement
  private readonly resizeObserver: ResizeObserver
  private readonly cleanups: (() => void)[] = []

  private quality: Quality
  private requestedQuality: Quality
  private pace = 1
  private regionActivity = ''
  private autoQuality: boolean
  private shadows = true
  private pixelRatioCap = 2
  private frame = 0
  private frames = 0
  private fpsWindow = 0
  private degraded = false
  private running = false
  private governor: FrameGovernor | null = null
  private readonly gpu: GpuBudget | null
  private suspended = false
  private powerMode: PowerMode = 'balanced'
  private activeUntil = 0
  private lastRenderedAt = 0
  private coveredWalkTimer: number | null = null
  private coveredWalkAt = 0
  private actualSpeed = 0
  private remoteGeneration = 0
  private readonly remoteLoads = new Map<MemberId, object>()
  private readonly remoteMoves = new Map<MemberId, Pick<PresenceMember, 'pos' | 'heading' | 'moving'>>()
  private remoteChanges: Map<MemberId, object> | null = null
  private localMemberId: MemberId | null = null
  private readonly vehicles = new VehicleScene()
  private vehicleSelf: VehicleSelf | null = null
  private vehicleInputBlocked = false
  private vehicleIntent = { ...NEUTRAL_CONTROLS }
  private context: LocationContext = { countryCode: '', areaLabel: '' }
  private contextPending = false
  private region: RegionLayer | null = null
  private regionGeneration = 0
  private regionState = 'none'
  private regionError: string | null = null

  private district: District | null = null
  private districtScene: DistrictScene | null = null
  private navigator: StreetNavigator | null = null
  private cameraObstacles: CameraObstacles | null = null
  private minimap: DistrictMinimap | null = null
  private minimapFrames = new WeakMap<HTMLCanvasElement, string>()
  private readonly routeCosts = new Map<string, number | null>()
  private sceneBuildMs = 0
  private measuredFps = 0
  private interior: InteriorScene | null = null
  private homeViews: readonly HomeExteriorScenery[] = []
  private homeEntries: readonly HomeExteriorEntry[] = []
  private homeMeshes: ReturnType<typeof buildHomeExterior>[] = []
  private nearHomeId: HomeId | null = null
  private homeRoute: THREE.Line | null = null
  private regionNavigator: StreetNavigator | null = null
  private hour = 12
  private night = 0

  private local: AvatarActor | null = null
  private localCameraOccluded = false
  private localPos: Vec2 = { x: 0, z: 0 }
  private heading = 0
  private moving = false
  private path: Vec2[] = []
  private readonly remotes = new Map<MemberId, Remote>()
  private readonly keys = new Set<string>()
  private joystick: Vec2 = { x: 0, z: 0 }
  private azimuth = Math.PI * 0.25
  private polar = 1.35
  private distance = 4.6
  private viewAzimuth = this.azimuth
  private viewPolar = this.polar
  private viewDistance = this.distance
  private boomDistance = this.distance
  private readonly cameraDirection = new THREE.Vector3()
  private readonly followTarget = new THREE.Vector3()
  private readonly cameraTarget = new THREE.Vector3()
  private lastSent = 0
  private lastSentMoving = false
  private nearVenueId: string | null = null
  private nearDoor = false
  private nearStationId: string | null = null
  private pendingStationId: string | null = null
  private seatedStation: InteriorStation | null = null
  private edge: EdgeDirection | null = null
  private stuckFor = 0
  private editing = false
  private inputLocked = false
  private walkWhileLocked = false
  /** Home planning: taps and drags on the room are heard while the window is open, keys, the stick and walking are not. */
  private furnitureDrag: { id: number; owner: HomeFurniturePointer; x: number; y: number; moved: boolean } | null = null
  private editPointer = false
  /** A home price or dialog is open over the room: no tap, drag, pinch, wheel or button moves the camera or the editor. */
  private sceneFrozen = false
  /** Forget a drag, a pinch and any pointer capture in progress. Set by `bindInput`. */
  private dropGestures: (() => void) | null = null
  private readonly marker: THREE.Mesh

  constructor(canvas: HTMLCanvasElement, events: EngineEvents, options: { quality: Quality | 'auto' }) {
    this.scene.add(this.vehicles.root)
    this.canvas = canvas
    this.events = events
    this.autoQuality = options.quality === 'auto'
    this.requestedQuality = options.quality === 'auto' ? guessQuality() : options.quality
    this.quality = this.requestedQuality
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' })
    const gl = this.renderer.getContext()
    this.gpu = gl instanceof WebGL2RenderingContext ? new GpuBudget(gl, ms => this.governor?.recordGpu(ms)) : null
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.02
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    const environmentRoom = new RoomEnvironment()
    const environmentBaker = new THREE.PMREMGenerator(this.renderer)
    this.environment = environmentBaker.fromScene(environmentRoom, 0.04, 0.1, 100)
    this.scene.environment = this.environment.texture
    this.scene.environmentIntensity = 0.28
    environmentRoom.dispose()
    environmentBaker.dispose()
    this.applyQuality()

    this.sun.castShadow = true
    this.sun.shadow.camera.near = 10
    this.sun.shadow.camera.far = 520
    this.sun.shadow.bias = -0.0006
    this.sun.shadow.normalBias = 0.035
    this.scene.add(this.sun, this.sun.target, this.sky, this.playerFill, this.playerFill.target, this.atmosphere.mesh, this.contacts.mesh)
    this.scene.fog = new THREE.Fog('#d7ecf7', 260, 1250)

    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.45, 0.7, 24), new THREE.MeshBasicMaterial({ color: '#ffb020', transparent: true, opacity: 0.9, depthTest: false }))
    this.marker.rotation.x = -Math.PI / 2
    this.marker.visible = false
    this.marker.renderOrder = 3
    this.scene.add(this.marker)

    this.resizeObserver = new ResizeObserver(() => this.resize())
    this.resizeObserver.observe(canvas)
    this.resize()
    this.bindInput()
    this.setTime(12)
    this.resetGovernor()
    const visibility = (): void => {
      if (document.hidden) this.pauseMovement()
      this.updateRegionActivity()
      this.lastRenderedAt = 0
      if (!document.hidden) this.wake()
    }
    document.addEventListener('visibilitychange', visibility)
    this.cleanups.push(() => document.removeEventListener('visibilitychange', visibility))
  }

  // ── Setup ──

  private resetGovernor(): void {
    this.governor?.dispose()
    this.governor = new FrameGovernor({
      canvas: this.canvas, tier: this.requestedQuality, automatic: this.autoQuality,
      active: () => this.isActive(),
      frame: delta => {
        const now = performance.now(), elapsed = delta === 0 || !this.lastRenderedAt ? 0 : (now - this.lastRenderedAt) / 1000
        this.lastRenderedAt = now
        this.tick(delta, elapsed)
      },
      changed: tier => {
        const previous = this.quality
        this.quality = limitedQuality(this.requestedQuality, tier)
        this.degraded = this.autoQuality && this.quality !== this.requestedQuality
        this.applyQuality(); this.resize()
        if (previous !== this.quality && this.district) void this.mountRegion()
      },
    })
    this.governor.setMode(this.powerMode)
    this.governor.setSuspended(this.suspended)
    if (this.running) this.governor.start()
  }

  private isActive(): boolean {
    if (performance.now() < this.activeUntil) return true
    if ((!this.inputLocked || this.walkWhileLocked) && this.path.length) return true
    if (!this.inputLocked && (this.moving || Math.hypot(this.joystick.x, this.joystick.z) > 0.12 || ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].some(key => this.keys.has(key)))) return true
    if (Math.abs(this.azimuth - this.viewAzimuth) > 0.005 || Math.abs(this.polar - this.viewPolar) > 0.005 || Math.abs(this.distance - this.viewDistance) > 0.005) return true
    return [...this.remotes.values()].some(remote => {
      const position = remote.actor.group.position
      if (Math.hypot(position.x - this.localPos.x, position.z - this.localPos.z) > 80) return false
      const point = new THREE.Vector3(position.x, position.y + remote.actor.height / 2, position.z).project(this.camera)
      if (Math.abs(point.x) > 1.2 || Math.abs(point.y) > 1.2 || point.z < -1 || point.z > 1) return false
      return remote.moving || Math.hypot(position.x - remote.target.x, position.z - remote.target.z) > 0.05
    })
  }

  private wake(): void { this.activeUntil = Math.max(this.activeUntil, performance.now() + 250); this.governor?.invalidate() }

  private pauseMovement(preserveRoute = false): void {
    this.dropGestures?.()
    this.neutralVehicleInput(); this.keys.clear(); this.joystick = { x: 0, z: 0 }
    if (!preserveRoute) this.stop()
    this.moving = false; this.actualSpeed = 0
    this.local?.setMotion(this.seatedStation?.pose ?? 'idle'); this.local?.setTravelSpeed(0)
    if (this.lastSentMoving && !this.vehicleSelf?.seat) this.events.local({ ...this.localPos }, this.heading, false)
    this.lastSentMoving = false
  }

  private cancelCoveredWalk(): void {
    if (this.coveredWalkTimer !== null) window.clearTimeout(this.coveredWalkTimer)
    this.coveredWalkTimer = null
  }

  private syncCoveredWalk(): void {
    this.cancelCoveredWalk()
    if (!this.running || !this.suspended || !this.walkWhileLocked || !this.path.length || document.hidden) return
    this.coveredWalkAt = performance.now()
    this.coveredWalkTimer = window.setTimeout(() => {
      this.coveredWalkTimer = null
      if (!this.running || !this.suspended || !this.walkWhileLocked || !this.path.length || document.hidden) return
      let remaining = Math.min(0.2, (performance.now() - this.coveredWalkAt) / 1000)
      const sentAt = this.lastSent
      // Map navigation advances without drawing the 3D scene.
      while (remaining > 0.001 && this.path.length) {
        const step = Math.min(1 / 30, remaining)
        this.stepLocal(step); this.updateStation(); remaining -= step
      }
      this.updateProximity()
      this.sendLocalMovement(!this.path.length && this.lastSent === sentAt)
      this.syncCoveredWalk()
    }, 100)
  }

  private sendLocalMovement(force = false): void {
    if (this.vehicleSelf?.seat) return
    const now = performance.now()
    if (force || now - this.lastSent > 120 && (this.moving || this.lastSentMoving)) {
      this.lastSent = now; this.lastSentMoving = this.moving
      this.events.local({ ...this.localPos }, this.heading, this.moving)
    }
  }

  setSuspended(suspended: boolean): void {
    if (this.suspended === suspended) return
    this.suspended = suspended
    if (suspended) this.pauseMovement(true)
    this.lastRenderedAt = 0
    this.governor?.setSuspended(suspended)
    this.updateRegionActivity()
    this.syncCoveredWalk()
    if (!suspended) {
      this.districtScene?.updatePosition(this.localPos); this.updateDistrictFog()
      this.placeLocal(true); this.wake()
    }
  }

  setPowerMode(mode: PowerMode): void {
    this.powerMode = mode; this.governor?.setMode(mode)
    this.applyQuality(); this.resize()
  }

  setLocationContext(context: LocationContext): void { this.context = { ...context }; this.contextPending = true }

  private updateRegionActivity(): void {
    const suspended = this.suspended || document.hidden
    const idle = !this.isActive()
    const key = `${idle}:${suspended}`
    if (key === this.regionActivity) return
    this.regionActivity = key
    ambience.setSuspended(suspended)
    try { this.region?.setActivity?.({ idle, suspended }) } catch (error) { this.failRegion(error) }
  }

  private disposeRegion(): void {
    this.regionNavigator = null
    this.navigator?.unregisterObstacles('region')
    this.regionActivity = ''
    const layer = this.region; this.region = null; this.regionState = 'none'
    if (!layer) return
    layer.root.removeFromParent()
    try { layer.dispose() } catch { /* Optional decoration must not strand a scene transition. */ }
  }

  private updateRegionNight(): void {
    try { this.region?.setNight?.(this.night) } catch (error) { this.failRegion(error) }
  }

  private failRegion(error: unknown): void {
    this.disposeRegion(); this.regionState = 'failed'
    this.regionError = error instanceof Error ? error.message : 'Region kit failed'
  }

  private async mountRegion(): Promise<void> {
    const district = this.district, navigator = this.navigator
    const generation = ++this.regionGeneration
    this.disposeRegion(); this.regionError = null
    if (!district || !navigator) return
    this.regionState = 'loading'
    try {
      // Static placement reads both its passed navigator and navigationFor(district).
      // Give both an isolated map-only frame; dynamic homes join only after generation.
      const staticDistrict = { ...district }
      const regionNavigator = navigationFor(staticDistrict)
      const layer = await loadRegionLayer({ district: staticDistrict, navigator: regionNavigator, focus: { ...this.localPos }, quality: this.quality, ...this.context, hour: this.hour })
      if (generation !== this.regionGeneration || this.district !== district) { layer?.dispose(); return }
      this.region = layer; this.regionState = layer ? 'ready' : 'unavailable'
      this.regionNavigator = layer ? regionNavigator : null
      if (layer) {
        this.navigator?.registerObstacles('region', regionObstacles(layer))
        regionNavigator.registerObstacles('region', regionObstacles(layer))
        regionNavigator.registerObstacles('homes', this.homeViews.flatMap(home => home.footprints))
        this.scene.add(layer.root); this.updateRegionNight(); this.wake(); this.updateRegionActivity()
        this.rescue()
        const destination = this.path[this.path.length - 1]
        if (destination && this.navigator) this.path = this.navigator.walkingRoute(this.localPos, destination).points
      }
    } catch (error) { if (generation === this.regionGeneration) this.failRegion(error) }
  }

  private applyQuality(): void {
    const preset = { low: { ratio: 1, shadows: false, map: 1024, span: 60 }, medium: { ratio: 1.5, shadows: true, map: 1024, span: 70 }, high: { ratio: 2, shadows: true, map: 2048, span: 90 } }[this.quality]
    const budget = this.governor?.snapshot().preset ?? TIER_PRESETS[this.quality]
    this.pixelRatioCap = Math.min(preset.ratio, budget.resolutionCap)
    this.shadows = preset.shadows && budget.shadows
    this.local?.setDetail(this.quality === 'low' ? 'reduced' : 'auto')
    for (const remote of this.remotes.values()) remote.actor.setDetail(this.quality === 'low' ? 'reduced' : 'auto')
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.pixelRatioCap))
    this.renderer.shadowMap.enabled = this.shadows
    this.sun.castShadow = this.shadows && (Boolean(this.interior) || this.night < 0.88)
    if (!this.shadows || this.sun.shadow.mapSize.x !== preset.map) {
      this.sun.shadow.dispose()
      this.sun.shadow.map = null
      this.sun.shadow.mapPass = null
    }
    this.sun.shadow.mapSize.set(preset.map, preset.map)
    const camera = this.sun.shadow.camera
    camera.left = camera.bottom = -preset.span
    camera.right = camera.top = preset.span
    camera.updateProjectionMatrix()
    this.districtScene?.setQuality(this.quality)
    this.interior?.setQuality(this.quality)
    this.updateDistrictFog()
  }

  setQuality(quality: Quality | 'auto'): void {
    this.autoQuality = quality === 'auto'
    this.requestedQuality = quality === 'auto' ? guessQuality() : quality
    this.degraded = false
    const previous = this.quality
    if (this.governor) this.governor.configure(this.requestedQuality, this.autoQuality); else this.resetGovernor()
    // The governor callback already rebuilt detail when its effective tier changed.
    if (previous === this.quality) { this.applyQuality(); this.resize() }
  }

  private resize(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, this.pixelRatioCap)
    if (this.renderer.getPixelRatio() !== ratio) this.renderer.setPixelRatio(ratio)
    const width = this.canvas.clientWidth || 1, height = this.canvas.clientHeight || 1
    this.renderer.setSize(width, height, false)
    this.camera.aspect = width / height
    this.camera.fov = width < height ? 62 : 55
    this.camera.updateProjectionMatrix()
    this.wake()
  }

  /** Local wall-clock hour (0–24) of the place being shown. Drives sun, sky and street lights. */
  setTime(hour: number): void {
    this.hour = hour
    if (this.interior) return
    const elevation = Math.sin(((hour - 6) / 12) * Math.PI)
    const day = THREE.MathUtils.smoothstep(elevation, -0.12, 0.28)
    const golden = 1 - THREE.MathUtils.smoothstep(Math.abs(elevation), 0.05, 0.45)
    this.night = 1 - day
    this.atmosphere.setTime(hour, day, golden)
    const mix = (a: string, b: string, t: number): THREE.Color => new THREE.Color(a).lerp(new THREE.Color(b), t)
    const horizon = mix(mix('#1d2743', '#d9edf8', day).getStyle(), '#ffc48f', golden * day * 0.75)
    this.scene.background = horizon
    ;(this.scene.fog as THREE.Fog).color.copy(horizon)
    this.sun.color.copy(mix('#ffd9a8', '#fff6e6', THREE.MathUtils.smoothstep(elevation, 0.1, 0.6)))
    this.sun.intensity = 0.12 + day * 2.3
    this.sun.castShadow = this.shadows && day > 0.12
    this.playerFill.intensity = 0.2 + this.night * 0.4
    this.renderer.toneMappingExposure = 1.02 + this.night * 0.12
    this.sky.intensity = 0.65 + day * 0.35
    this.scene.environmentIntensity = 0.12 + day * 0.16
    this.sky.color.copy(mix('#9aafd2', '#cfe6ff', day))
    this.sky.groundColor.copy(mix('#4c526a', '#b9a98c', day))
    this.districtScene?.setNight(this.night)
    this.updateRegionNight()
    this.wake()
  }

  // ── Avatars ──

  async setLocalLook(look: AvatarLook): Promise<void> {
    this.localCameraOccluded = false
    if (this.local) {
      this.local.setLook(look)
      if (this.local.lookError && !this.local.lookLoading) void this.local.retryLook().catch(() => undefined)
      await this.settleLocalLook(this.local)
      this.wake()
      return
    }
    this.local = new AvatarActor(look)
    this.local.setDetail(this.quality === 'low' ? 'reduced' : 'auto')
    this.scene.add(this.local.group)
    this.placeLocal()
    await this.settleLocalLook(this.local)
  }

  private async settleLocalLook(actor: AvatarActor): Promise<void> {
    try { await actor.ready } catch (error) { if (!actor.shown) throw error }
  }

  setLocalFace(scan: FaceScan | null, version: number): void { this.local?.setFace(scan, scan ? `self:${version}` : ''); this.wake() }

  gesture(kind: MemberGesture, options: { broadcast?: boolean } = {}): void {
    if (!this.local) return
    this.local.gesture(kind); this.activeUntil = performance.now() + 3000
    if (kind !== 'work' && options.broadcast !== false) this.events.gesture?.(kind)
    this.wake()
  }

  gestureMember(id: MemberId, kind: string): void {
    const gesture = memberGesture(kind)
    if (gesture) this.playMemberGesture(id, gesture)
  }

  setPace(multiplier: number): void {
    if (Number.isFinite(multiplier)) this.pace = THREE.MathUtils.clamp(multiplier, 0.6, 1.2)
  }

  playMemberGesture(memberId: MemberId, kind: MemberGesture): void {
    const remote = this.remotes.get(memberId)
    if (!remote) return
    void remote.actor.ready.then(() => {
      if (this.remotes.get(memberId) !== remote) return
      remote.actor.gesture(kind); this.activeUntil = performance.now() + 3000; this.wake()
    }).catch(() => undefined)
  }

  /** Reconcile remote avatars with a presence list. */
  async syncRemotes(members: PresenceMember[], selfId: MemberId): Promise<void> {
    const generation = ++this.remoteGeneration
    this.remoteLoads.clear()
    this.remoteMoves.clear()
    const changes = new Map<MemberId, object>()
    this.remoteChanges = changes
    this.localMemberId = selfId
    try {
      // Preserve event ordering; each actor loads its own animation family.
      await Promise.resolve()
      if (generation !== this.remoteGeneration) return
      const wanted = new Set(members.filter(member => member.id !== selfId).map(member => member.id))
      for (const [id, remote] of this.remotes) if (!wanted.has(id) && !changes.has(id)) { this.vehicles.clearActor(remote.actor); remote.actor.dispose(); disposeTag(remote.tag); this.remotes.delete(id) }
      for (const member of members) if (member.id !== selfId && !changes.has(member.id)) this.upsertRemote(member)
    } finally { if (this.remoteChanges === changes) this.remoteChanges = null }
  }

  private upsertRemote(member: PresenceMember): void {
    const tagKey = `${member.displayName}|${member.relation}|${member.voice}`
    let remote = this.remotes.get(member.id)
    if (!remote) {
      const actor = new AvatarActor(member.look)
      actor.setDetail(this.quality === 'low' ? 'reduced' : 'auto')
      actor.group.position.set(member.pos.x, this.interior ? 0.01 : 0.15, member.pos.z)
      actor.group.userData.memberId = member.id
      const tag = nameTag(member.displayName, member.relation, member.voice)
      this.scene.add(actor.group, tag)
      remote = { actor, target: { ...member.pos }, heading: member.heading, moving: member.moving, tag, tagKey, faceVersion: 0, speed: 0, transport: member.transport }
      this.remotes.set(member.id, remote)
    } else {
      remote.actor.setLook(member.look)
      remote.target = { ...member.pos }
      remote.heading = member.heading
      remote.moving = member.moving
      remote.transport = member.transport
      if (remote.tagKey !== tagKey) {
        disposeTag(remote.tag)
        remote.tag = nameTag(member.displayName, member.relation, member.voice)
        remote.tagKey = tagKey
        this.scene.add(remote.tag)
      }
    }
    if (!member.look.face) { remote.actor.setFace(null); remote.faceVersion = 0 }
    const movement = this.remoteMoves.get(member.id)
    if (movement) {
      remote.target = { ...movement.pos }; remote.heading = movement.heading; remote.moving = movement.moving
      this.remoteMoves.delete(member.id)
    }
    this.wake()
  }

  async upsertMember(member: PresenceMember): Promise<void> {
    const generation = this.remoteGeneration, token = {}
    this.remoteMoves.delete(member.id)
    this.remoteLoads.set(member.id, token)
    this.remoteChanges?.set(member.id, token)
    try {
      // Presence must not wait for unrelated animation assets.
      await Promise.resolve()
      if (generation !== this.remoteGeneration || this.remoteLoads.get(member.id) !== token || member.id === this.localMemberId) return
      this.upsertRemote(member)
    } finally { if (this.remoteLoads.get(member.id) === token) this.remoteLoads.delete(member.id) }
  }

  removeMember(id: MemberId): void {
    this.remoteLoads.delete(id)
    this.remoteMoves.delete(id)
    this.remoteChanges?.set(id, {})
    const remote = this.remotes.get(id)
    if (!remote) return
    this.vehicles.clearActor(remote.actor)
    remote.actor.dispose()
    disposeTag(remote.tag)
    this.remotes.delete(id)
  }

  moveMember(id: MemberId, pos: Vec2, heading: number, moving: boolean): void {
    if (this.remoteLoads.has(id) || this.remoteChanges) this.remoteMoves.set(id, { pos: { ...pos }, heading, moving })
    const remote = this.remotes.get(id)
    if (remote) { remote.target = { ...pos }; remote.heading = heading; remote.moving = moving; this.wake() }
  }

  /** Remote members whose photo face has not been mounted at this version yet. */
  facesNeeded(members: PresenceMember[]): { id: MemberId; version: number }[] {
    return members.flatMap(member => {
      const remote = this.remotes.get(member.id)
      return member.look.face && remote && remote.faceVersion !== member.look.face.version ? [{ id: member.id, version: member.look.face.version }] : []
    })
  }

  setMemberFace(id: MemberId, scan: FaceScan, version: number): void {
    const remote = this.remotes.get(id)
    if (!remote) return
    remote.faceVersion = version
    remote.actor.setFace(scan, `${id}:${version}`)
  }

  // ── Scenes ──

  async enterDistrict(district: District, at: Vec2, heading: number, options: DistrictOptions = {}): Promise<{ stats: DistrictScene['stats'] }> {
    const started = performance.now()
    const neighbours = this.district ? neighbouringDistricts(this.district.id) : null
    const crossing = neighbours && Object.values(neighbours).includes(district.id)
    const starter = STARTER_PLACES.find(place => districtIdOf(place.anchor) === district.id)
    const inherited = crossing || this.contextPending ? this.context : { countryCode: starter?.countryCode ?? '', areaLabel: starter?.label ?? '' }
    this.context = { countryCode: options.countryCode ?? inherited.countryCode, areaLabel: options.areaLabel ?? inherited.areaLabel }
    this.contextPending = false
    if (options.memberId) this.localMemberId = options.memberId
    const orbit = { azimuth: this.azimuth, polar: this.polar, distance: this.distance }
    this.clearScenes()
    this.district = district
    this.atmosphere.mesh.visible = true
    this.navigator = options.prepared?.navigator ?? navigationFor(district)
    this.cameraObstacles = new CameraObstacles(district.buildings)
    this.minimap = new DistrictMinimap(district)
    this.districtScene = options.prepared?.scene ?? buildDistrictScene(district, this.navigator, at, this.quality, this.context)
    this.scene.add(this.districtScene.root)
    this.localPos = options.spreadArrival && this.localMemberId && !crossing
      ? this.navigator.arrivalPosition(at, this.localMemberId)
      : options.authoritative ? { ...at } : this.navigator.nearestWalkable(at) ?? at
    this.heading = heading
    this.distance = 4.6
    this.polar = 1.35
    this.azimuth = heading + Math.PI
    // Face along the nearest street on arrival instead of staring into the venue wall.
    let nearestRoad = 25
    for (const road of district.roads) {
      if (road.tunnel || road.kind === 'rail' || road.kind === 'motorway') continue
      for (let i = 1; i < road.points.length; i++) {
        const a = road.points[i - 1]!, b = road.points[i]!
        const dx = b.x - a.x, dz = b.z - a.z, length2 = dx * dx + dz * dz
        if (length2 < 1) continue
        const t = THREE.MathUtils.clamp(((this.localPos.x - a.x) * dx + (this.localPos.z - a.z) * dz) / length2, 0, 1)
        const gap = Math.hypot(this.localPos.x - a.x - dx * t, this.localPos.z - a.z - dz * t)
        if (gap >= nearestRoad) continue
        nearestRoad = gap
        let direction = Math.atan2(dx, dz)
        if (Math.cos(direction - heading) < 0) direction += Math.PI
        this.azimuth = direction + Math.PI
      }
    }
    if (!crossing) this.azimuth = this.arrivalAzimuth(this.azimuth)
    if (crossing) { this.azimuth = orbit.azimuth; this.polar = orbit.polar; this.distance = orbit.distance }
    this.updateDistrictFog()
    this.setTime(this.hour)
    this.placeLocal(true)
    this.sceneBuildMs = performance.now() - started
    this.frames = 0; this.fpsWindow = 0; this.measuredFps = 0
    this.lastRenderedAt = 0
    if (options.prepared) {
      this.region = options.prepared.region; this.regionState = 'ready'; this.regionError = null
      this.regionNavigator = options.prepared.regionNavigator
      this.regionNavigator.registerObstacles('region', regionObstacles(this.region))
      this.regionNavigator.registerObstacles('homes', this.homeViews.flatMap(home => home.footprints))
      this.navigator.registerObstacles('region', regionObstacles(this.region))
      this.scene.add(this.region.root); this.updateRegionNight(); this.updateRegionActivity()
    } else await this.mountRegion()
    this.wake()
    return { stats: this.districtScene.stats }
  }

  private updateDistrictFog(): void {
    if (!this.district || !(this.scene.fog instanceof THREE.Fog)) return
    // Fade fully before the finite ground apron, rather than exposing its rectangular edge.
    const margin = this.district.span * 0.8 - Math.max(Math.abs(this.localPos.x), Math.abs(this.localPos.z)) - 60
    this.scene.fog.far = Math.max(180, Math.min(this.quality === 'low' ? 700 : 1250, margin))
    this.scene.fog.near = Math.min(260, this.scene.fog.far * 0.4)
    this.districtScene?.setVisibilityRange(this.scene.fog.far)
  }

  private arrivalAzimuth(preferred: number): number {
    if (!this.cameraObstacles) return preferred
    const origin = { x: this.localPos.x, y: 1.6, z: this.localPos.z }
    let best = preferred, bestScore = -Infinity
    for (let index = 0; index < 24; index++) {
      const angle = preferred + index * Math.PI / 12
      const forward = { x: -Math.sin(angle), y: 0, z: -Math.cos(angle) }
      const view = this.cameraObstacles.distance(origin, forward, 32)
      const boom = this.cameraObstacles.distance({ ...origin, y: 2 }, { x: -forward.x, y: 0.18, z: -forward.z }, 4.6)
      let walk = 0
      for (let distance = 1; distance <= 10; distance++) {
        if (!this.navigator?.walkable({ x: origin.x + forward.x * distance, z: origin.z + forward.z * distance })) break
        walk = distance
      }
      const score = view + boom * 3 + walk + Math.abs(Math.cos(angle - preferred)) * 6
      if (score > bestScore) { bestScore = score; best = angle }
    }
    return best
  }

  async enterInterior(spec: InteriorSpec): Promise<void> {
    const started = performance.now()
    this.clearScenes()
    this.interior = buildInterior(spec, this.quality)
    this.atmosphere.mesh.visible = false
    this.scene.add(this.interior.root)
    await this.interior.setItems(spec.layout.items)
    // A home says where a character steps in and which way they face; other rooms are entered 2.8 m inside their door.
    const stepIn = this.interior.entry
    const entry = stepIn ? { ...stepIn.pos } : { x: this.interior.door.x, z: this.interior.door.z - 2.8 }
    this.localPos = entry
    if (!this.interior.walkable(entry)) {
      let found = false
      for (let radius = 0.5; radius <= 4 && !found; radius += 0.5) {
        for (let step = 0; step < 16; step++) {
          const point = { x: entry.x + Math.cos(step / 8 * Math.PI) * radius, z: entry.z + Math.sin(step / 8 * Math.PI) * radius }
          if (this.interior.walkable(point)) { this.localPos = point; found = true; break }
        }
      }
    }
    this.heading = stepIn ? stepIn.heading : Math.PI
    this.distance = 3.5
    this.polar = 1.35
    this.azimuth = stepIn ? (stepIn.heading + Math.PI + 4 * Math.PI) % (2 * Math.PI) : 0
    const feature = this.interior.stations.find(station => ['counter', 'stall', 'ticket-desk', 'shelf'].includes(station.kind))
    if (feature) {
      this.heading = Math.atan2(feature.position.x - this.localPos.x, feature.position.z - this.localPos.z)
      this.azimuth = this.heading + Math.PI
    }
    ;(this.scene.fog as THREE.Fog).near = 400
    ;(this.scene.fog as THREE.Fog).far = 900
    this.scene.background = new THREE.Color('#2a2738')
    this.scene.environmentIntensity = 0.42
    this.playerFill.intensity = 0.32
    this.renderer.toneMappingExposure = 1.02
    this.sun.castShadow = this.shadows
    this.sun.intensity = 1.9
    this.sun.color.set('#fff1dc')
    this.sky.intensity = 1.15
    this.sky.color.set('#fff6ea')
    this.sky.groundColor.set('#c9b8a3')
    this.placeLocal(true)
    this.sceneBuildMs = performance.now() - started
    this.frames = 0; this.fpsWindow = 0; this.measuredFps = 0
    this.lastRenderedAt = 0
  }

  /** Mount only service-approved exterior projections. */
  setHomeExteriors(homes: readonly HomeExteriorScenery[], entries: readonly HomeExteriorEntry[]): void {
    for (const house of this.homeMeshes) house.dispose()
    this.homeMeshes = []
    this.homeViews = this.district ? homes : []
    const visible = new Set(this.homeViews.map(home => home.buildingId))
    this.homeEntries = this.district ? entries.filter(entry => visible.has(entry.buildingId)) : []
    const footprints = this.homeViews.flatMap(home => home.footprints)
    this.navigator?.registerObstacles('homes', footprints)
    this.regionNavigator?.registerObstacles('homes', footprints)
    if (this.district) {
      for (const home of this.homeViews) {
        const house = buildHomeExterior(home)
        this.homeMeshes.push(house)
        this.scene.add(house.root)
      }
      this.cameraObstacles = new CameraObstacles([...this.district.buildings, ...this.homeViews.flatMap(exteriorCameraBuildings)])
    }
    this.nearHomeId = null
    this.events.nearHome?.(null)
    this.updateProximity()
    this.wake()
  }

  getHomeEntrance(homeId: HomeId): HomeExteriorEntry | null { return this.homeEntries.find(entry => entry.homeId === homeId) ?? null }

  private clearHomeRoute(): void {
    this.homeRoute?.removeFromParent()
    this.homeRoute?.geometry.dispose()
    const material = this.homeRoute?.material
    if (Array.isArray(material)) for (const item of material) item.dispose()
    else material?.dispose()
    this.homeRoute = null
  }

  private drawHomeRoute(): void {
    this.clearHomeRoute()
    if (!this.path.length) return
    const geometry = new THREE.BufferGeometry().setFromPoints([this.localPos, ...this.path].map(point => new THREE.Vector3(point.x, 0.19, point.z)))
    const material = new THREE.LineBasicMaterial({ color: '#21b3c1', transparent: true, opacity: 0.85, depthWrite: false })
    this.homeRoute = new THREE.Line(geometry, material)
    this.homeRoute.name = 'home-walking-route'
    this.scene.add(this.homeRoute)
  }

  get walkingDistanceRemaining(): number {
    let previous = this.localPos, length = 0
    for (const point of this.path) { length += Math.hypot(point.x - previous.x, point.z - previous.z); previous = point }
    return length
  }

  private clearScenes(): void {
    this.remoteGeneration++; this.remoteLoads.clear(); this.remoteMoves.clear(); this.remoteChanges = null
    this.localCameraOccluded = false
    this.clearHomeRoute()
    for (const house of this.homeMeshes) house.dispose()
    this.homeMeshes = []; this.homeViews = []; this.homeEntries = []
    this.navigator?.unregisterObstacles('homes')
    if (this.nearHomeId) this.events.nearHome?.(null)
    this.nearHomeId = null
    this.clearVehicles()
    this.regionGeneration++
    this.cancelCoveredWalk()
    this.editing = false; this.editPointer = false; this.sceneFrozen = false; this.dropGestures?.()
    this.pendingStationId = null; this.seatedStation = null
    if (this.nearStationId) this.events.nearStation?.(null)
    this.nearStationId = null
    this.routeCosts.clear()
    this.disposeRegion()
    this.districtScene?.dispose()
    this.interior?.dispose()
    this.districtScene = null
    this.interior = null
    this.district = null
    this.prefetchedDistrict = null
    this.navigator = null
    this.cameraObstacles = null
    this.minimap = null
    this.minimapFrames = new WeakMap()
    this.path = []
    this.moving = false; this.lastSentMoving = false
    this.local?.setMotion('idle')
    this.joystick = { x: 0, z: 0 }
    this.keys.clear()
    this.marker.visible = false
    this.nearVenueId = null
    this.nearDoor = false
    this.edge = null
    for (const remote of this.remotes.values()) { this.vehicles.clearActor(remote.actor); remote.actor.dispose(); disposeTag(remote.tag) }
    this.remotes.clear()
  }

  async prepareVehicleDistrict(district: District, at: Vec2, signal: AbortSignal): Promise<PreparedVehicleDistrict> {
    signal.throwIfAborted()
    const context = vehicleDistrictContext(district.id)
    if (!context) throw new Error('That district has no supported vehicle scene context.')
    const { StreetNavigator } = await import('./nav.ts')
    const staticDistrict = { ...district }
    const regionNavigator = navigationFor(staticDistrict)
    const navigator = new StreetNavigator(district)
    const scene = buildDistrictScene(district, navigator, at, this.quality, context)
    let region: RegionLayer | null = null
    try {
      region = await loadRegionLayer({ district: staticDistrict, navigator: regionNavigator, focus: at, quality: this.quality, ...context, hour: this.hour })
      signal.throwIfAborted()
      if (!region || region.root.userData.regionDiagnostics?.kit !== context.regionKitId) throw new Error('The vehicle street scene could not be prepared.')
      const preparedRegion = region
      return { district, navigator, scene, region: preparedRegion, regionNavigator, context, dispose: () => { scene.dispose(); preparedRegion.dispose() } }
    } catch (error) { scene.dispose(); region?.dispose(); throw error }
  }

  get vehicleSceneReady(): boolean {
    const expected = this.district && vehicleDistrictContext(this.district.id)
    return Boolean(expected && this.regionState === 'ready' && this.region?.root.userData.regionDiagnostics?.kit === expected.regionKitId)
  }

  syncVehicles(snapshots: readonly VehicleSnapshot[], self: VehicleSelf | null, room: { key: RoomKey; instance: number } | null, motion?: Extract<VehicleEvent, { type: 'vehicle.move' }>): void {
    const changed = this.vehicleSelf?.seat?.vehicleId !== self?.seat?.vehicleId || this.vehicleSelf?.seat?.seatId !== self?.seat?.seatId
    this.vehicleSelf = self
    this.footVehicles = room && this.mode === 'district' ? snapshots.filter(vehicle => vehicle.room.key === room.key && vehicle.room.instance === room.instance) : []
    if (changed) { this.keys.clear(); this.joystick = { x: 0, z: 0 }; this.path = []; this.marker.visible = false; this.neutralVehicleInput(); this.local?.setVehiclePose(null) }
    this.vehicles.sync(room && this.mode === 'district' ? snapshots.filter(vehicle => vehicle.room.key === room.key && vehicle.room.instance === room.instance) : [], motion)
    if (!self?.seat) { this.local?.setVehiclePose(null); if (this.local) this.local.group.visible = true }
    this.wake()
  }

  clearVehicles(): void {
    this.neutralVehicleInput(); this.vehicleSelf = null; this.footVehicles = []; this.footGrid.clear(); this.vehicles.clear()
    if (this.local) { this.local.setVehiclePose(null); this.local.group.visible = true }
    for (const remote of this.remotes.values()) { remote.actor.setVehiclePose(null); remote.actor.group.visible = true; remote.transport = undefined }
  }

  /** The HUD supplies its global gate separately from its seated foot hold. */
  setVehicleInputBlocked(blocked: boolean): void {
    const changed = this.vehicleInputBlocked !== blocked
    this.vehicleInputBlocked = blocked
    if (blocked && changed) this.dropGestures?.()
    if (blocked) { this.keys.clear(); this.joystick = { x: 0, z: 0 }; this.neutralVehicleInput() }
  }

  private neutralVehicleInput(): void {
    if (this.vehicleIntent.throttle || this.vehicleIntent.steer || !this.vehicleIntent.brake) this.events.vehicleInput?.({ ...NEUTRAL_CONTROLS })
    this.vehicleIntent = { ...NEUTRAL_CONTROLS }
  }

  private driveVehicleKeys(): void {
    const vehicle = this.vehicleSelf?.vehicle
    if (this.vehicleInputBlocked || this.suspended || !this.vehicleSelf?.seat || this.vehicleSelf.seat.seatId !== 'driver' || vehicle?.control.kind !== 'member' || vehicle.control.driverId !== this.localMemberId) { this.neutralVehicleInput(); return }
    const forward = this.keys.has('KeyW') || this.keys.has('ArrowUp'), reverse = this.keys.has('KeyS') || this.keys.has('ArrowDown')
    const left = this.keys.has('KeyA') || this.keys.has('ArrowLeft'), right = this.keys.has('KeyD') || this.keys.has('ArrowRight')
    const intent = { throttle: Number(forward) - Number(reverse), steer: Number(right) - Number(left), brake: this.keys.has('Space') || !forward && !reverse }
    if (intent.throttle !== this.vehicleIntent.throttle || intent.steer !== this.vehicleIntent.steer || intent.brake !== this.vehicleIntent.brake) { this.vehicleIntent = intent; this.events.vehicleInput?.(intent) }
  }

  get regionDescription(): string | null {
    const description: unknown = this.region?.root.userData.description
    return typeof description === 'string' ? description : null
  }

  get mode(): 'district' | 'interior' | 'none' { return this.interior ? 'interior' : this.district ? 'district' : 'none' }
  get position(): Vec2 { return { ...this.localPos } }
  get facing(): number { return this.heading }
  get interiorStations(): readonly InteriorStation[] { return this.interior?.stations ?? [] }

  walkToStation(id: string): boolean {
    if (this.inputLocked && !this.walkWhileLocked) return false
    const station = this.interior?.stations.find(candidate => candidate.id === id)
    if (!station) return false
    const near = Math.hypot(station.position.x - this.localPos.x, station.position.z - this.localPos.z) < 0.2
    if (!near && !this.previewWalkTo(station.position)) return false
    this.walkTo(station.position)
    this.pendingStationId = id
    return true
  }

  leaveStation(): void {
    this.pendingStationId = null; this.seatedStation = null
    this.local?.setMotion('idle')
  }

  private updateStation(): void {
    if (!this.interior) return
    const target = this.interior.stations.find(station => station.id === this.pendingStationId)
    if (target && Math.hypot(target.position.x - this.localPos.x, target.position.z - this.localPos.z) < 0.22) {
      const notifying = this.moving || this.lastSentMoving
      this.localPos = { ...target.position }; this.heading = target.facing
      this.stop(); this.seatedStation = target
      if (target.kind === 'counter') {
        // Look across the serving surface at the worker, with room for the work sheet below.
        this.azimuth = target.facing + 0.32
        this.polar = 1.36
        this.distance = 5.2
      }
      this.local?.setMotion(target.pose ?? 'idle'); this.local?.setTravelSpeed(0)
      this.placeLocal()
      if (!notifying) this.sendLocalMovement(true)
    }
    const nearest = this.moving ? null : this.interior.stations
      .filter(station => Math.hypot(station.position.x - this.localPos.x, station.position.z - this.localPos.z) < 0.8)
      .sort((a, b) => Math.hypot(a.position.x - this.localPos.x, a.position.z - this.localPos.z) - Math.hypot(b.position.x - this.localPos.x, b.position.z - this.localPos.z))[0] ?? null
    if ((nearest?.id ?? null) !== this.nearStationId) {
      this.nearStationId = nearest?.id ?? null
      this.events.nearStation?.(nearest)
    }
  }

  async setInteriorItems(items: PlacedItem[]): Promise<void> { await this.interior?.setItems(items); this.wake() }
  /** A home's rooms changed: redraw them where they stand. Nobody is moved; a character left without floor is the service's to refuse. */
  setInteriorPlan(plan: HomePlan): void { this.interior?.setPlan?.(plan); this.wake() }
  setInteriorGhost(ghost: HomeGhost | null): void { this.interior?.setGhost?.(ghost); this.wake() }
  setInteriorCutaway(on: boolean): void { this.interior?.setCutaway?.(on); this.wake() }
  /** Look down on the rooms while planning them, then come back down behind the character. */
  setInteriorOverview(on: boolean): void {
    if (!this.interior) return
    this.polar = on ? 0.62 : 1.35
    this.distance = on ? 13 : 3.5
    this.wake()
  }
  highlightItem(key: string | null): void { this.interior?.highlight(key, homeFurniturePointerFor(this)?.feedback()); this.wake() }
  setEditing(editing: boolean): void { this.editing = editing; if (!editing) this.interior?.highlight(null) }
  /** Hear taps and drags on the room while input is locked (home planning with its window open). Keys, the stick and walking stay locked. */
  setEditPointer(on: boolean): void { if (on !== this.editPointer) { this.editPointer = on; this.dropGestures?.() } }
  /** Freeze the room under a home price or dialog: ends any drag or pinch in progress, and ignores taps, drags, pinch, wheel and the zoom and turn buttons until unfrozen. */
  setSceneFrozen(on: boolean): void { if (on !== this.sceneFrozen) { this.sceneFrozen = on; if (on) this.dropGestures?.() } }
  /** Stop keyboard movement while a text field or a game overlay has focus. */
  /** Stop taking keys, taps and the joystick. A walk already under way carries on only when asked (the map window). */
  lockInput(locked: boolean, options: { preserveWalking?: boolean } = {}): void {
    this.inputLocked = locked; this.walkWhileLocked = locked && options.preserveWalking === true
    if (locked) this.dropGestures?.()
    if (locked) { this.keys.clear(); this.joystick = { x: 0, z: 0 }; if (!this.walkWhileLocked) this.stop() }
    this.syncCoveredWalk()
  }

  // ── Movement ──

  private placeLocal(snapCamera = false): void {
    if (this.local && !this.vehicleSelf?.seat) {
      this.local.group.position.set(this.localPos.x, this.interior ? 0.01 : 0.15, this.localPos.z)
      this.local.group.rotation.y = this.heading
    }
    if (snapCamera) {
      this.cameraTarget.set(this.localPos.x, 1.35, this.localPos.z)
      this.viewAzimuth = this.azimuth; this.viewPolar = this.polar
      this.viewDistance = this.distance; this.boomDistance = this.distance
    }
  }

  /** Put the avatar where the service says it is (after a rejected move or a reconnect). */
  snapTo(pos: Vec2, heading?: number): void { this.localPos = { ...pos }; if (heading !== undefined) this.heading = heading; this.stop(); this.placeLocal(true) }

  private isWalkable(point: Vec2): boolean {
    if (this.interior) return this.interior.walkable(point)
    return this.navigator ? this.navigator.walkable(point) : true
  }

  /** Walk to a point. In a district the route follows real streets where they connect. */
  walkTo(target: Vec2, options: { exact?: boolean } = {}): { viaStreets: boolean; length: number; status?: 'walking' | 'arrived' | 'unreachable' } {
    if (this.inputLocked && !this.walkWhileLocked) return { viaStreets: false, length: 0, status: 'unreachable' }
    if (this.vehicleSelf?.seat) return { viaStreets: false, length: 0, status: 'unreachable' }
    this.wake()
    this.leaveStation()
    if (this.interior) {
      this.path = this.interior.route(this.localPos, target)
      const last = this.path[this.path.length - 1]
      if (last) this.showMarker(last); else this.marker.visible = false
      this.syncCoveredWalk()
      let length = 0, previous = this.localPos
      for (const point of this.path) { length += Math.hypot(point.x - previous.x, point.z - previous.z); previous = point }
      return { viaStreets: false, length }
    }
    if (!this.navigator) return { viaStreets: false, length: 0 }
    const venue = this.districtScene?.venues.find(entry => Math.hypot(entry.poi.pos.x - target.x, entry.poi.pos.z - target.z) < 0.1)
    const destination = options.exact ? target : venue ? this.navigator.venueApproach(venue.poi.pos) ?? venue.anchor : this.navigator.nearestWalkable(target, 40) ?? target
    const route = this.navigator.route(this.localPos, destination)
    this.path = route.points
    if (options.exact) this.drawHomeRoute(); else this.clearHomeRoute()
    if (this.path.length) this.showMarker(this.path[this.path.length - 1]!); else this.marker.visible = false
    this.syncCoveredWalk()
    return { viaStreets: route.viaStreets, length: route.length, status: Math.hypot(destination.x - this.localPos.x, destination.z - this.localPos.z) < 0.7 ? 'arrived' : route.points.length ? 'walking' : 'unreachable' }
  }

  stop(): void {
    this.clearHomeRoute()
    const notify = this.moving || this.lastSentMoving
    this.path = []; this.pendingStationId = null; this.marker.visible = false
    this.moving = false; this.actualSpeed = 0
    this.local?.setMotion(this.seatedStation?.pose ?? 'idle'); this.local?.setTravelSpeed(0)
    this.cancelCoveredWalk()
    if (notify) this.sendLocalMovement(true)
  }

  /** Queue a verified home route while its window closes. Every input hold still controls when walking may advance. */
  queueHomeWalk(target: Vec2): { viaStreets: boolean; length: number; status: 'walking' | 'arrived' | 'unreachable' } {
    if (this.vehicleSelf?.seat || this.sceneFrozen || this.interior || !this.navigator) return { viaStreets: false, length: 0, status: 'unreachable' }
    if (Math.hypot(target.x - this.localPos.x, target.z - this.localPos.z) < 0.7 && this.isWalkable(target)) return { viaStreets: false, length: 0, status: 'arrived' }
    const route = this.previewWalkTo(target, { exact: true })
    if (!route) return { viaStreets: false, length: 0, status: 'unreachable' }
    this.leaveStation(); this.path = route.points; this.drawHomeRoute()
    this.showMarker(this.path[this.path.length - 1]!); this.syncCoveredWalk(); this.wake()
    return { viaStreets: route.viaStreets, length: route.length, status: 'walking' }
  }

  /** The route `walkTo` would take, without starting to walk. Null when there is no way there. */
  previewWalkTo(target: Vec2, options: { exact?: boolean } = {}): { points: Vec2[]; length: number; viaStreets: boolean } | null {
    if (this.interior) {
      const points = this.interior.route(this.localPos, target)
      let length = 0, previous = this.localPos
      for (const point of points) { length += Math.hypot(point.x - previous.x, point.z - previous.z); previous = point }
      return points.length ? { points: points.map(point => ({ ...point })), length, viaStreets: false } : null
    }
    if (!this.navigator) return null
    const venue = this.districtScene?.venues.find(entry => Math.hypot(entry.poi.pos.x - target.x, entry.poi.pos.z - target.z) < 0.1)
    const destination = options.exact ? target : venue ? this.navigator.venueApproach(venue.poi.pos) ?? venue.anchor : this.navigator.nearestWalkable(target, 40) ?? target
    const route = this.navigator.route(this.localPos, destination)
    return route.points.length ? { points: route.points.map(point => ({ ...point })), length: route.length, viaStreets: route.viaStreets } : null
  }

  /** Walking metres from the current position, without changing the route or animation. */
  routeLength(target: Vec2): number | null {
    const key = `${this.mode}:${this.navigator?.revision ?? 0}:${this.localPos.x},${this.localPos.z}:${target.x},${target.z}`
    if (this.routeCosts.has(key)) return this.routeCosts.get(key) ?? null
    const length = Math.hypot(target.x - this.localPos.x, target.z - this.localPos.z) < 0.15 && this.isWalkable(target)
      ? 0 : this.previewWalkTo(target)?.length ?? null
    this.routeCosts.set(key, length)
    if (this.routeCosts.size > 96) { const oldest = this.routeCosts.keys().next().value; if (oldest !== undefined) this.routeCosts.delete(oldest) }
    return length
  }

  private showMarker(at: Vec2): void { this.marker.position.set(at.x, 0.25, at.z); this.marker.visible = true }

  setJoystick(x: number, z: number): void {
    if (this.vehicleSelf?.seat || this.inputLocked || !Number.isFinite(x) || !Number.isFinite(z)) return
    const length = Math.hypot(x, z)
    const scale = length < 0.16 ? 0 : Math.min(1.3, length) / length
    this.joystick = { x: x * scale, z: z * scale }; this.wake()
  }

  private readonly footGrid = new FootObstacleGrid<string>()
  private footVehicles: readonly VehicleSnapshot[] = []

  private updateFootGrid(): void {
    this.footGrid.clear()
    for (const [id, remote] of this.remotes) if (!remote.transport && remote.actor.group.visible) {
      const position = remote.actor.group.position
      this.footGrid.set(`member:${id}`, { kind: 'disc', pos: { x: position.x, z: position.z }, radius: PERSON_RADIUS })
    }
    for (const [index, point] of (this.region?.peoplePositions?.() ?? []).entries()) this.footGrid.set(`scenery:${index}`, { kind: 'disc', pos: point, radius: PERSON_RADIUS })
    for (const vehicle of this.footVehicles) this.footGrid.set(`vehicle:${vehicle.id}`, vehicleFootObstacle(vehicle.kind, vehicle.pos, vehicle.heading))
  }

  /** The walk-rounds given to one route: its added turns, the leg last looked at, and how many it has had. A new route starts a new record. */
  private detour: { path: Vec2[] | null; turns: Set<Vec2>; leg: Vec2 | null; plans: number } = { path: null, turns: new Set(), leg: null, plans: 0 }

  /** Put a way round standing vehicles in front of the route. False when none is needed, none exists, or the route has had its share. */
  private planDetour(): boolean {
    const navigator = this.navigator
    if (this.interior || !navigator || !this.path.length || this.detour.plans >= DETOUR_REPLANS) return false
    // Standing bodies only. A moving vehicle is left to moveFoot, frame by frame.
    const standing = this.footVehicles.filter(vehicle => Math.abs(vehicle.speed) < VEHICLE_RULES.stoppedSpeed && (vehicle.phase === 'parked' || vehicle.phase === 'boarding'))
      .map(vehicle => vehicleFootObstacle(vehicle.kind, vehicle.pos, vehicle.heading))
    if (!standingNear(this.localPos, standing)) return false
    this.detour.leg = this.path[0]!
    const around = detourAhead(this.localPos, this.path, standing, point => navigator.standable(point))
    if (!around) return false
    this.path.splice(0, around.replaces, ...around.points)
    for (const turn of around.points.slice(0, around.turns)) this.detour.turns.add(turn)
    this.detour.plans++; this.detour.leg = this.path[0] ?? null
    if (this.homeRoute) this.drawHomeRoute()
    return true
  }

  private stepLocal(delta: number): void {
    if (this.vehicleSelf?.seat) { this.driveVehicleKeys(); return }
    if (this.localMemberId && this.vehicles.isTransitioning(this.localMemberId)) return
    let dx = 0, dz = 0
    if (!this.inputLocked) {
      if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dz -= 1
      if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dz += 1
      if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx -= 1
      if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx += 1
      dx += this.joystick.x
      dz += this.joystick.z
    }
    const manual = Math.hypot(dx, dz)
    const sprinting = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || Math.hypot(this.joystick.x, this.joystick.z) > 1.25
    let speed = Math.min(MAX_SPEED, (sprinting ? SPRINT_SPEED : WALK_SPEED) * this.pace)
    let moveX = 0, moveZ = 0
    if (manual > 0.12) {
      if (this.seatedStation || this.pendingStationId) this.leaveStation()
      this.path = []
      this.marker.visible = false
      // Input is relative to where the camera looks.
      const sin = Math.sin(this.viewAzimuth), cos = Math.cos(this.viewAzimuth)
      const nx = dx / Math.max(1, manual), nz = dz / Math.max(1, manual)
      moveX = nx * cos + nz * sin
      moveZ = -nx * sin + nz * cos
    } else if ((!this.inputLocked || this.walkWhileLocked) && this.path.length) {
      if (this.detour.path !== this.path) this.detour = { path: this.path, turns: new Set(), leg: null, plans: 0 }
      while (this.path.length && Math.hypot(this.path[0]!.x - this.localPos.x, this.path[0]!.z - this.localPos.z) < 0.18) {
        if (this.detour.turns.delete(this.path.shift()!)) { this.lastSentMoving = true; this.events.local({ ...this.localPos }, this.heading, true) }
      }
      if (!this.path.length) { this.clearHomeRoute(); this.marker.visible = false; this.moving = false; this.local?.setMotion('idle'); this.actualSpeed = 0; this.local?.setTravelSpeed(0); return }
      if (this.path[0] !== this.detour.leg) this.planDetour()
      const next = this.path[0]!
      const gap = Math.hypot(next.x - this.localPos.x, next.z - this.localPos.z)
      moveX = (next.x - this.localPos.x) / gap
      moveZ = (next.z - this.localPos.z) / gap
      // Long routes are jogged so crossing a district does not take minutes.
      let remaining = gap
      for (let index = 1; index < this.path.length; index++) {
        const from = this.path[index - 1]!
        remaining += this.detour.turns.has(from) ? Math.hypot(this.path[index]!.x - from.x, this.path[index]!.z - from.z) : 20
      }
      speed = Math.min(MAX_SPEED, (remaining > 30 ? SPRINT_SPEED : WALK_SPEED) * this.pace, gap / Math.max(delta, 0.001))
    }
    const oldPosition = { ...this.localPos }
    const wasMoving = this.moving
    this.moving = Math.hypot(moveX, moveZ) > 0.05 && delta > 0
    if (this.moving) {
      const stepX = moveX * speed * delta, stepZ = moveZ * speed * delta
      let blocked = false
      const target = { x: this.localPos.x + stepX, z: this.localPos.z + stepZ }
      const obstacles = this.footGrid.query(this.localPos, target).map(entry => entry.obstacle)
      const position = moveFoot(this.localPos, target, obstacles, point => this.interior ? this.interior.walkable(point) : this.navigator?.standable(point) ?? true)
      blocked = Math.hypot(position.x - this.localPos.x, position.z - this.localPos.z) < 1e-5
      this.localPos = position
      const targetHeading = Math.atan2(moveX, moveZ)
      let turn = targetHeading - this.heading
      turn = Math.atan2(Math.sin(turn), Math.cos(turn))
      this.heading += turn * Math.min(1, delta * 12)
      this.heading = Math.atan2(Math.sin(this.heading), Math.cos(this.heading))
      if (blocked && this.stuckFor === 0 && this.path.length) this.planDetour()
      // A route that keeps hitting a wall is abandoned rather than left grinding against it.
      this.stuckFor = blocked ? this.stuckFor + delta : 0
      if (blocked && this.path.length && this.stuckFor > 0.7) { this.path = []; this.marker.visible = false }
      if (blocked) this.moving = false
      this.local?.setMotion(blocked ? 'idle' : speed > WALK_SPEED + 0.5 ? 'sprint' : 'walk')
    } else if (wasMoving) this.local?.setMotion('idle')
    this.actualSpeed = delta > 0 ? Math.hypot(this.localPos.x - oldPosition.x, this.localPos.z - oldPosition.z) / delta : 0
    this.local?.setTravelSpeed(this.actualSpeed)
    this.placeLocal()
  }

  /** If the avatar ends up somewhere it cannot stand, move it to the nearest clear spot. */
  rescue(): void {
    if (!this.navigator || this.interior || this.vehicleSelf?.seat) return
    if (this.navigator.walkable(this.localPos)) return
    const safe = this.navigator.nearestWalkable(this.localPos) ?? this.navigator.nearestStreetPoint(this.localPos)
    if (safe) { this.localPos = safe; this.stop(); this.placeLocal(true); this.events.rescued() }
  }

  // ── Input ──

  private bindInput(): void {
    const listen = <K extends keyof WindowEventMap>(target: Window | HTMLElement, type: K, handler: (event: WindowEventMap[K]) => void, options?: AddEventListenerOptions): void => {
      target.addEventListener(type, handler as EventListener, options)
      this.cleanups.push(() => target.removeEventListener(type, handler as EventListener, options))
    }
    const typing = (event: KeyboardEvent): boolean => {
      const target = event.target as HTMLElement | null
      return Boolean(target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable))
    }
    listen(window, 'keydown', event => {
      if (this.furnitureDrag || (this.vehicleSelf?.seat ? this.vehicleInputBlocked : this.inputLocked) || typing(event) || event.metaKey || event.ctrlKey || event.altKey) return
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.code) && (!this.inputLocked || Boolean(this.vehicleSelf?.seat))) event.preventDefault()
      this.keys.add(event.code); if (this.vehicleSelf?.seat) this.driveVehicleKeys(); this.wake()
      if (event.code === 'BracketLeft') this.azimuth -= 0.3
      if (event.code === 'BracketRight') this.azimuth += 0.3
    })
    listen(window, 'keyup', event => { const held = this.keys.delete(event.code); if (this.vehicleSelf?.seat) this.driveVehicleKeys(); if (held && !this.inputLocked) this.wake() })
    listen(window, 'blur', () => { this.dropGestures?.(); this.neutralVehicleInput(); this.keys.clear(); this.joystick = { x: 0, z: 0 }; this.stop() })

    const pointers = new Map<number, { x: number; y: number }>()
    let down: { x: number; y: number; at: number; moved: number } | null = null
    let pinch = 0
    // A gesture that began before the lock (a window opened, a price appeared, planning ended) ends here, capture and all.
    this.dropGestures = () => {
      const drag = this.furnitureDrag; this.furnitureDrag = null
      drag?.owner.cancel()
      for (const id of [...pointers.keys()]) { try { if (this.canvas.hasPointerCapture(id)) this.canvas.releasePointerCapture(id) } catch { /* the pointer is already gone */ } }
      pointers.clear(); down = null; pinch = 0
    }
    listen(this.canvas, 'pointerdown', event => {
      if (this.furnitureDrag) { this.dropGestures?.(); return }
      if (!this.cameraOpen()) return
      if (this.interior && this.editPointer && pointers.size === 0 && event.isPrimary && event.button === 0) {
        const owner = homeFurniturePointerFor(this), point = this.furniturePoint(event.clientX, event.clientY)
        const key = point ? this.interior.itemAt(this.raycaster) : null
        if (owner && key && point && owner.begin(key, point, event.pointerId)) {
          this.furnitureDrag = { id: event.pointerId, owner, x: event.clientX, y: event.clientY, moved: false }
          this.canvas.setPointerCapture(event.pointerId)
          pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
          event.preventDefault(); this.wake(); return
        }
      }
      this.wake()
      this.canvas.setPointerCapture(event.pointerId)
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 1) down = { x: event.clientX, y: event.clientY, at: performance.now(), moved: 0 }
      if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = Math.hypot(a!.x - b!.x, a!.y - b!.y); down = null }
    })
    listen(this.canvas, 'pointermove', event => {
      const drag = this.furnitureDrag
      if (drag?.id === event.pointerId) {
        if (!this.pointerOpen() || !drag.owner.owns(event.pointerId)) { this.dropGestures?.(); return }
        drag.moved ||= Math.hypot(event.clientX - drag.x, event.clientY - drag.y) >= 6
        if (drag.moved) {
          const point = this.furniturePoint(event.clientX, event.clientY)
          if (point) drag.owner.move(point, event.pointerId)
        }
        event.preventDefault(); this.wake(); return
      }
      const previous = pointers.get(event.pointerId)
      if (!previous) return
      if (!this.cameraOpen()) { this.dropGestures?.(); return }
      const dx = event.clientX - previous.x, dy = event.clientY - previous.y
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()]
        const gap = Math.hypot(a!.x - b!.x, a!.y - b!.y)
        if (pinch && gap > 5) this.zoom(pinch / gap)
        pinch = gap
        return
      }
      if (down) down.moved += Math.abs(dx) + Math.abs(dy)
      if (!down || down.moved < 6) return
      this.wake()
      this.azimuth -= dx * 0.006
      this.polar = THREE.MathUtils.clamp(this.polar - dy * 0.005, 0.45, 1.48)
    })
    const release = (event: PointerEvent): void => {
      const drag = this.furnitureDrag
      if (drag?.id === event.pointerId) {
        this.furnitureDrag = null; pointers.delete(event.pointerId); down = null; pinch = 0
        const point = this.furniturePoint(event.clientX, event.clientY), rect = this.canvas.getBoundingClientRect()
        const onCanvas = event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom
        if (!point || !onCanvas || !this.pointerOpen()) drag.owner.cancel(event.pointerId)
        else { if (drag.moved) drag.owner.move(point, event.pointerId); drag.owner.end(event.pointerId) }
        if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId)
        event.preventDefault(); this.wake(); return
      }
      pointers.delete(event.pointerId)
      if (pointers.size < 2) pinch = 0
      if (down && down.moved < 6 && performance.now() - down.at < 450 && this.pointerOpen()) this.click(event.clientX, event.clientY)
      if (pointers.size === 0) down = null
    }
    listen(this.canvas, 'pointerup', release)
    listen(this.canvas, 'pointercancel', event => { if (this.furnitureDrag?.id === event.pointerId) { this.furnitureDrag.owner.cancel(event.pointerId); this.furnitureDrag = null } pointers.delete(event.pointerId); down = null; pinch = 0 })
    listen(this.canvas, 'lostpointercapture', event => { if (this.furnitureDrag?.id === event.pointerId) { this.furnitureDrag.owner.cancel(event.pointerId); this.furnitureDrag = null } pointers.delete(event.pointerId); down = null; pinch = 0 })
    listen(this.canvas, 'wheel', event => { event.preventDefault(); if (this.cameraOpen()) this.zoom(Math.exp(event.deltaY * 0.0012)) }, { passive: false })
    listen(this.canvas, 'contextmenu', event => event.preventDefault())
  }

  /** Existing home plan metres; this projects a drag without changing the avatar or camera. */
  private furniturePoint(clientX: number, clientY: number): Vec2 | null {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(pointer, this.camera)
    const point = new THREE.Vector3()
    return this.raycaster.ray.intersectPlane(this.groundPlane, point) && Number.isFinite(point.x) && Number.isFinite(point.z) ? { x: point.x, z: point.z } : null
  }

  /** Taps and drags on the room are heard: nothing is frozen over it, and either no window is open or home planning is. */
  private pointerOpen(): boolean { return !this.sceneFrozen && (!this.inputLocked || this.editPointer) }

  /** Seated camera gestures stay available while foot taps keep their own lock. */
  private cameraOpen(): boolean { return !this.furnitureDrag && !this.suspended && !document.hidden && !this.sceneFrozen && (this.editPointer || !this.vehicleInputBlocked && (!this.inputLocked || Boolean(this.vehicleSelf?.seat))) }

  zoom(factor: number): void {
    if (!this.cameraOpen() || !Number.isFinite(factor) || factor <= 0) return
    const [min, max] = this.interior ? [2, 14] : [2.4, 32]
    this.distance = THREE.MathUtils.clamp(this.distance * factor, min, max); this.wake()
  }

  rotate(radians: number): void { if (!this.cameraOpen()) return; this.azimuth += radians; this.wake() }

  drawMinimap(canvas: HTMLCanvasElement, options: MinimapOptions = {}): boolean {
    if (this.suspended || document.hidden) return false
    if (!this.minimap) { canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); return false }
    const stamp = [this.district?.id, this.district?.dataVersion, canvas.width, canvas.height, options.radius, options.headingUp, Math.round(this.localPos.x * 4), Math.round(this.localPos.z * 4), Math.round(this.heading * 40), ...[...this.remotes.values()].map(remote => `${Math.round(remote.actor.group.position.x * 4)}:${Math.round(remote.actor.group.position.z * 4)}:${remote.tagKey}`)].join('|')
    if (this.minimapFrames.get(canvas) === stamp) return true
    this.minimapFrames.set(canvas, stamp)
    this.minimap.draw(canvas, this.localPos, this.heading, [...this.remotes.values()].map(remote => ({ x: remote.actor.group.position.x, z: remote.actor.group.position.z, friend: remote.tagKey.includes('|friend|') })), options)
    return true
  }

  get diagnostics(): WorldDiagnostics {
    return {
      fps: this.suspended || document.hidden ? 0 : this.measuredFps, quality: this.quality, shadows: this.shadows, pixelRatio: this.renderer.getPixelRatio(),
      triangles: this.renderer.info.render.triangles, drawCalls: this.renderer.info.render.calls, degraded: this.degraded,
      sceneBuildMs: this.sceneBuildMs, cameraDistance: this.boomDistance, requestedCameraDistance: this.distance,
      cameraOccluded: this.boomDistance < this.viewDistance - 0.1,
      cameraPosition: { x: this.camera.position.x, y: this.camera.position.y, z: this.camera.position.z },
      cameraTarget: { x: this.cameraTarget.x, y: this.cameraTarget.y, z: this.cameraTarget.z }, mode: this.mode,
      textures: textureMemory(this.scene), surfaces: surfaceDiagnostics(),
      shadowBytes: this.shadows ? this.sun.shadow.mapSize.x * this.sun.shadow.mapSize.y * 8 : 0,
      governor: this.governor?.snapshot() ?? null,
      region: { state: this.regionState, error: this.regionError, instances: this.region?.stats.instances ?? 0, triangles: this.region?.stats.triangles ?? 0, textureBytes: this.region?.stats.textureBytes ?? 0 },
      localSpeed: this.actualSpeed, packCache: packCacheStats(),
      streamed: this.districtScene ? { ...this.districtScene.streaming, buildingMeshPools: this.districtScene.stats.buildingMeshPools, buildingDrawCalls: this.districtScene.stats.buildingDrawCalls, venues: this.districtScene.venues.length } : {},
    }
  }

  private updateCamera(delta: number): void {
    const ease = 1 - Math.exp(-12 * delta)
    this.viewAzimuth += (this.azimuth - this.viewAzimuth) * ease
    this.viewPolar += (this.polar - this.viewPolar) * ease
    this.viewDistance += (this.distance - this.viewDistance) * ease
    const counterView = this.seatedStation?.kind === 'counter'
    const focusHeight = counterView ? (this.camera.aspect < 1 ? 0.35 : 0.85) : Math.min(1.45, (this.local?.height ?? 1.75) * 0.77)
    this.followTarget.set(this.localPos.x, focusHeight, this.localPos.z)
    this.cameraTarget.lerp(this.followTarget, 1 - Math.exp(-16 * delta))
    this.cameraDirection.set(Math.sin(this.viewPolar) * Math.sin(this.viewAzimuth), Math.cos(this.viewPolar), Math.sin(this.viewPolar) * Math.cos(this.viewAzimuth))
    let clear = this.cameraObstacles?.distance(this.cameraTarget, this.cameraDirection, this.viewDistance) ?? this.viewDistance
    if (this.interior) {
      this.raycaster.set(this.cameraTarget, this.cameraDirection)
      this.raycaster.near = 0; this.raycaster.far = this.viewDistance + 0.3
      const hit = this.raycaster.intersectObjects(this.interior.cameraObstacles, false)[0]
      if (hit) clear = Math.min(clear, Math.max(0.18, hit.distance - 0.3))
      this.raycaster.far = Infinity
    }
    // Pull in immediately at a wall; ease out only after the line of sight is clear.
    this.boomDistance = clear < this.boomDistance ? clear : THREE.MathUtils.lerp(this.boomDistance, clear, 1 - Math.exp(-5 * delta))
    this.camera.position.copy(this.cameraTarget).addScaledVector(this.cameraDirection, this.boomDistance)
    this.camera.lookAt(this.cameraTarget)
    this.atmosphere.mesh.position.copy(this.camera.position)
  }

  private click(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect()
    const pointer = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(pointer, this.camera)
    // With the input locked (a window is open) a tap can only edit the room: it never picks a person, enters a place or starts a walk.
    const locked = this.inputLocked
    const avatarHit = locked ? undefined : this.raycaster.intersectObjects([...this.remotes.values()].map(remote => remote.actor.group), true)[0]
    if (avatarHit) {
      let node: THREE.Object3D | null = avatarHit.object
      while (node && !node.userData.memberId) node = node.parent
      if (node) { this.events.pickMember(node.userData.memberId as MemberId); return }
    }
    if (!locked) this.events.pickMember(null)
    if (!locked && !this.vehicleSelf?.seat && this.events.vehicleHit) {
      const vehicleId = this.vehicles.hit(this.raycaster)
      if (vehicleId) { this.events.vehicleHit(vehicleId); return }
    }
    if (this.interior) {
      const key = this.interior.itemAt(this.raycaster)
      if (key) { this.events.pickItem(key); return }
    }
    if (this.districtScene && !locked) {
      const hit = this.raycaster.intersectObjects(this.districtScene.venues.filter(v => v.sprite.visible).map(v => v.sprite), false)[0]
      const venue = hit ? this.districtScene.venues.find(v => v.sprite === hit.object) : undefined
      if (venue) { this.events.floorClick(venue.anchor); this.walkTo(venue.anchor); return }
    }
    const point = new THREE.Vector3()
    if (!this.raycaster.ray.intersectPlane(this.groundPlane, point)) return
    const target = { x: point.x, z: point.z }
    if (this.interior && this.editing) { this.events.pickItem(null); this.events.floorClick(target); return }
    if (locked) return
    this.events.floorClick(target)
    this.walkTo(target)
  }

  // ── Loop ──

  start(): void {
    if (this.running) return
    this.running = true; this.lastRenderedAt = 0
    this.governor?.start()
    this.syncCoveredWalk()
  }

  stopLoop(): void { this.running = false; this.cancelCoveredWalk(); this.governor?.stop(); this.lastRenderedAt = 0 }

  /** Advance and draw one frame. Public so a check can step the world without a display loop. */
  tick(delta: number, elapsed = delta): void {
    this.frame++
    this.vehicles.update(delta, this.localPos)
    this.updateFootGrid()
    this.stepLocal(delta)
    if (!this.vehicleSelf?.seat) this.updateStation()
    if (this.local) {
      const mounted = this.localMemberId ? this.vehicles.mount(this.localMemberId, this.local, this.localPos) : false
      this.local.group.visible = mounted || !this.vehicleSelf?.seat
      if (mounted && this.vehicleSelf?.seat) { this.localPos = { x: this.local.group.position.x, z: this.local.group.position.z }; this.heading = this.local.group.rotation.y }
      this.local.update(delta)
    }

    for (const [id, remote] of this.remotes) {
      const position = remote.actor.group.position
      const mounted = this.vehicles.mount(id, remote.actor, remote.target)
      remote.actor.group.visible = mounted || !remote.transport
      if (!mounted && !remote.transport) {
        position.y = this.interior ? 0.01 : 0.15
        const targetX = remote.target.x, targetZ = remote.target.z
        const gap = Math.hypot(targetX - position.x, targetZ - position.z)
        const ease = gap > 12 ? 1 : 1 - Math.exp(-10 * delta)
        const from = { x: position.x, z: position.z }
        const desired = { x: position.x + (targetX - position.x) * ease, z: position.z + (targetZ - position.z) * ease }
        // The service already checked this pose. Rendered obstacles lag accepted positions and
        // must not stop another member's accepted movement on this viewer's screen.
        const presented = desired
        const moved = Math.hypot(presented.x - from.x, presented.z - from.z)
        position.x = presented.x
        position.z = presented.z
        this.footGrid.set(`member:${id}`, { kind: 'disc', pos: presented, radius: PERSON_RADIUS })
        remote.speed = THREE.MathUtils.lerp(remote.speed, delta > 0 && gap <= 12 && remote.moving ? moved / delta : 0, 1 - Math.exp(-8 * delta))
        let turn = remote.heading - remote.actor.group.rotation.y
        turn = Math.atan2(Math.sin(turn), Math.cos(turn))
        remote.actor.group.rotation.y += turn * Math.min(1, delta * 10)
        remote.actor.setMotion(remote.moving ? remote.speed > 3 ? 'sprint' : 'walk' : 'idle')
        remote.actor.setTravelSpeed(remote.speed)
      }
      remote.actor.update(delta)
      remote.actor.labelAnchor(remote.tag.position)
      const distance = Math.hypot(position.x - this.localPos.x, position.z - this.localPos.z)
      const pixels = 32
      const scale = pixels / Math.max(1, this.canvas.clientHeight) * 2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2)
      const aspect: unknown = remote.tag.userData.aspect
      remote.tag.scale.set(scale * (typeof aspect === 'number' ? aspect : 3), scale, 1)
      remote.tag.material.opacity = 1 - THREE.MathUtils.smoothstep(distance, 24, 32)
      remote.tag.visible = remote.actor.group.visible && distance < 32
    }
    this.updateRegionActivity()
    try { this.region?.update?.(delta, this.localPos, this.footGrid) } catch (error) { this.failRegion(error) }

    this.contacts.update(this.local ? [this.localPos, ...[...this.remotes.values()].map(remote => remote.actor.group.position)] : [], this.interior ? 0.005 : 0.115)
    this.updateCamera(delta)
    if (this.local) {
      const cameraDistance = this.camera.position.distanceTo(this.cameraTarget)
      if (cameraDistance < 0.8) this.localCameraOccluded = true
      else if (cameraDistance > 1.05) this.localCameraOccluded = false
      this.local.group.visible = this.local.group.visible && !this.localCameraOccluded
    }
    try { this.region?.setView?.(this.camera.position, this.followTarget) } catch (error) { this.failRegion(error) }

    this.playerFill.position.set(this.camera.position.x, this.camera.position.y + 2, this.camera.position.z)
    this.playerFill.target.position.set(this.localPos.x, 1, this.localPos.z)
    const sunAngle = ((this.hour - 6) / 12) * Math.PI
    const lift = this.interior ? 0.9 : Math.max(0.18, Math.sin(sunAngle))
    this.sun.target.position.set(this.localPos.x, 0, this.localPos.z)
    this.sun.position.set(this.localPos.x + (this.interior ? 40 : Math.cos(sunAngle) * 170), lift * 190, this.localPos.z + 85)

    if (this.frame % 6 === 0) { this.districtScene?.updatePosition(this.localPos); this.updateDistrictFog(); this.updateProximity() }
    this.sendLocalMovement()
    this.gpu?.begin()
    this.renderer.render(this.scene, this.camera)
    this.gpu?.end()
    this.measure(elapsed)
  }

  private updateProximity(): void {
    let nearHome: HomeId | null = null, homeDistance: number = HOME_PHYSICAL.doorRange
    if (!this.vehicleSelf?.seat && this.navigator?.standable(this.localPos)) for (const home of this.homeEntries) {
      const door = this.homeViews.find(building => building.buildingId === home.buildingId)?.frontDoor
      if (!door) continue
      const dx = this.localPos.x - door.pos.x, dz = this.localPos.z - door.pos.z
      const gap = Math.hypot(dx, dz), publicSide = dx * Math.sin(door.facing) + dz * Math.cos(door.facing)
      if (gap <= homeDistance && publicSide >= HOME_PHYSICAL.publicSide) { nearHome = home.homeId; homeDistance = gap }
    }
    if (nearHome !== this.nearHomeId) { this.nearHomeId = nearHome; this.events.nearHome?.(this.homeEntries.find(entry => entry.homeId === nearHome) ?? null) }
    if (this.districtScene && this.navigator) {
      let nearest: { poi: Poi; distance: number } | null = null
      const labelBoxes: { left: number; right: number; top: number; bottom: number }[] = []
      const width = this.canvas.clientWidth, heightPx = this.canvas.clientHeight
      const labels = [...this.districtScene.venues].sort((a, b) => Math.hypot(a.anchor.x - this.localPos.x, a.anchor.z - this.localPos.z) - Math.hypot(b.anchor.x - this.localPos.x, b.anchor.z - this.localPos.z))
      const labelLimit = width < 600 ? 2 : 4
      for (const venue of labels) {
        const d = Math.hypot(venue.anchor.x - this.localPos.x, venue.anchor.z - this.localPos.z)
        if (d < 9 && (!nearest || d < nearest.distance)) nearest = { poi: venue.poi, distance: d }
        venue.sprite.visible = false
        if (d > 85 || labelBoxes.length >= labelLimit) continue
        const fromCamera = this.camera.position.distanceTo(venue.sprite.position)
        const height = THREE.MathUtils.clamp(fromCamera * 0.026, 0.5, 1.8)
        venue.sprite.scale.set(height * venue.aspect, height, 1)
        venue.sprite.position.y = 3.1 + height / 2
        const projected = venue.sprite.position.clone().project(this.camera)
        if (projected.z < -1 || projected.z > 1) continue
        const x = (projected.x + 1) * width / 2, y = (1 - projected.y) * heightPx / 2
        const pixels = height / Math.max(0.5, fromCamera) * heightPx / (2 * Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2))
        const halfWidth = pixels * venue.aspect / 2 + 7, halfHeight = pixels / 2 + 7
        const box = { left: x - halfWidth, right: x + halfWidth, top: y - halfHeight, bottom: y + halfHeight }
        if (box.left < 8 || box.right > width - 8 || box.top < (width < 600 ? 160 : 105) || box.bottom > heightPx - 80) continue
        if (labelBoxes.some(other => box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top)) continue
        labelBoxes.push(box); venue.sprite.visible = true
      }
      const id = nearest?.poi.placeId ?? null
      if (id !== this.nearVenueId) { this.nearVenueId = id; this.events.nearVenue(nearest?.poi ?? null) }
      const margin = this.navigator.half - 90
      const ahead: EdgeDirection | null = this.localPos.z < -margin ? 'north' : this.localPos.z > margin ? 'south' : this.localPos.x > margin ? 'east' : this.localPos.x < -margin ? 'west' : null
      const neighbours = ahead && this.district ? neighbouringDistricts(this.district.id) : null
      const next = neighbours && ahead ? neighbours[ahead] : null
      if (next && this.prefetchedDistrict !== next) {
        this.prefetchedDistrict = next
        void loadDistrict(next).catch(() => undefined)
      }
      const half = this.navigator.half - 8
      const edge: EdgeDirection | null = this.localPos.z < -half ? 'north' : this.localPos.z > half ? 'south' : this.localPos.x > half ? 'east' : this.localPos.x < -half ? 'west' : null
      if (edge !== this.edge) { this.edge = edge; this.events.edge(edge) }
      this.marker.rotation.z += 0.05
    }
    if (this.interior) {
      const near = Math.hypot(this.interior.door.x - this.localPos.x, this.interior.door.z - this.localPos.z) < 1.6
      if (near !== this.nearDoor) { this.nearDoor = near; this.events.nearDoor(near) }
    }
  }

  private measure(delta: number): void {
    if (document.hidden || delta <= 0 || delta > 1) return
    this.frames++
    this.fpsWindow += delta
    if (this.fpsWindow < 2) return
    const fps = this.frames / this.fpsWindow
    this.measuredFps = Math.round(fps)
    this.frames = 0
    this.fpsWindow = 0
    this.events.status({ fps: Math.round(fps), quality: this.quality, shadows: this.shadows, pixelRatio: this.renderer.getPixelRatio(), triangles: this.renderer.info.render.triangles, degraded: this.degraded, drawCalls: this.renderer.info.render.calls, sceneBuildMs: this.sceneBuildMs, regionDescription: this.regionDescription })
  }

  /** District reached by walking off the given edge, and where to appear in it. */
  neighbour(direction: EdgeDirection): { districtId: string; entry: Vec2 } | null {
    if (!this.district) return null
    const around = neighbouringDistricts(this.district.id)
    if (!around) return null
    const half = this.district.span / 2 - 14
    const entry = { north: { x: this.localPos.x, z: half }, south: { x: this.localPos.x, z: -half }, east: { x: -half, z: this.localPos.z }, west: { x: half, z: this.localPos.z } }[direction]
    return { districtId: around[direction], entry }
  }

  dispose(): void {
    this.stopLoop()
    this.governor?.dispose(); this.gpu?.dispose()
    this.resizeObserver.disconnect()
    for (const cleanup of this.cleanups) cleanup()
    this.clearScenes()
    this.vehicles.dispose()
    this.local?.dispose()
    this.atmosphere.dispose()
    this.contacts.dispose()
    this.environment?.dispose()
    ambience.setSuspended(true)
    this.sun.shadow.dispose()
    this.marker.geometry.dispose()
    const markerMaterial = this.marker.material
    if (!Array.isArray(markerMaterial)) markerMaterial.dispose()
    this.renderer.dispose()
  }
}
