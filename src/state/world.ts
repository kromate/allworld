// World controller: which scene is showing, who else is in the room, proximity chat, and the
// bridge between the 3D engine and the world service.
import { reactive, watch } from 'vue'
import type { DistrictId, HomeId, MemberId, RoomKey, VehicleId } from '../shared/ids.ts'
import { areaOfDistrict, distance, districtIdOf, tileToLatLon, parseDistrictId } from '../shared/geo.ts'
import type { Vec2 } from '../shared/geo.ts'
import { PROXIMITY_RADIUS, roomKey } from '../shared/model.ts'
import type { ChatMessage, CoarseArea, PresenceMember, RoomRef, RoomSnapshot } from '../shared/model.ts'
import type { Home, HomeLayout } from '../shared/social.ts'
import { homeParcelSource, sameParcelSource } from '../shared/homes.ts'
import type { HomeEntered, HomeLeft, HomeParcelManifest, HomeParcelSource, HomeExteriorEntry } from '../shared/homes.ts'
import vehicleManifest from '../assets/transport/yaba-vehicle-scene.json'
import homeManifest from '../assets/homes/yaba-home-scene.json'
import { DistrictLoadError, chooseArrival, loadDistrict, nearestStreetName } from '../geo/district.ts'
import type { Arrival, Coverage, District, Poi } from '../geo/district.ts'
import { timezoneAt } from '../geo/areas.ts'
// The 3D engine is the heaviest part of the App. It is fetched when the stage first needs it,
// not with the first screen, so the sign-in and loading states appear quickly on a slow phone.
import type { EdgeDirection, EngineStatus, WorldEngine, PreparedVehicleDistrict } from '../world/engine.ts'
import type { InteriorStation } from '../world/interior.ts'
import { api, app, messageOf, myId, onAccountReset, onServerEvent, toast } from './app.ts'
import { ambience } from './sound.ts'
import { vehicles } from './vehicles.ts'
import type { VehicleEvent, VehicleSelf } from '../shared/vehicles.ts'
import { loadVehicleDistrict, vehicleSceneData, vehicleDistrictContext } from '../world/vehicles/provenance.ts'

export type SceneKind = 'district' | 'venue' | 'home' | 'table'
export type HomeWalkState =
  | { kind: 'idle' }
  | { kind: 'walking'; homeId: HomeId; name: string; metres: number }
  | { kind: 'at-door'; homeId: HomeId; name: string }
  | { kind: 'paused'; homeId: HomeId; name: string }
  | { kind: 'travel'; homeId: HomeId; to: CoarseArea }
  | { kind: 'unavailable'; message: string }

export const world = reactive({
  state: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  loadingLabel: '',
  error: '',
  errorKind: '' as '' | 'network' | 'not-found' | 'invalid' | 'forbidden',
  kind: null as SceneKind | null,
  title: '',
  subtitle: '',
  /** True when the scene is the member's confirmed current area, false when just browsing. */
  inCurrentArea: false,
  districtId: null as DistrictId | null,
  areaLabel: '',
  timezone: 'UTC',
  /** Country of the place on screen: it decides the street dressing and the sound of the place. */
  countryCode: '',
  coverage: null as Coverage | null,
  arrival: null as Arrival | null,
  dataVersion: '',
  homeSceneRevision: '',
  homeSource: null as HomeParcelSource | null,
  street: null as string | null,
  places: [] as Poi[],
  nearVenue: null as Poi | null,
  nearDoor: false,
  nearHome: null as HomeExteriorEntry | null,
  homeWalk: { kind: 'idle' } as HomeWalkState,
  station: null as InteriorStation | null,
  edge: null as EdgeDirection | null,
  roomKey: null as RoomKey | null,
  instance: 1,
  capacity: 0,
  members: [] as PresenceMember[],
  chat: [] as ChatMessage[],
  selected: null as MemberId | null,
  home: null as Home | null,
  canEditHome: false,
  venue: null as Poi | null,
  status: null as EngineStatus | null,
  timeMode: (localStorage.getItem('neighbourhood-world:time') === 'day' ? 'day' : 'local') as 'local' | 'day',
  /** How many others would currently receive a message. */
  inRange: 0,
})

let engine: WorldEngine | null = null
let district: District | null = null
let currentRef: RoomRef | null = null
let returnTo: { districtId: DistrictId; pos: Vec2 } | null = null
let generation = 0
let homeWalkGeneration = 0
let homeLegDirection: EdgeDirection | null = null
let homeTargetDistrict: DistrictId | null = null
let homeTargetBuilding: string | null = null
let crossingHomeLeg = false
let drawnPlan = 0
let pendingHomeExit: HomeLeft | null = null
let homeRestorePending = false
let homeLeaveRequested = false
let vehicleResumeWork: Promise<void> | null = null
let vehicleResumeSequence = 0, vehicleResumeGeneration = -1, vehicleRestoreAttempt = 0
let exteriorWork: { scene: number; memberId: MemberId; loaded: District; target: WorldEngine; dirty: boolean; promise: Promise<void> } | null = null
let parcelManifestRequest: Promise<HomeParcelManifest> | null = null
let preparedTransfer: { id: string; generation: number; prepared: PreparedVehicleDistrict; disposeAbort(): void; timer: ReturnType<typeof setTimeout> } | null = null
const itemListeners = new Set<(key: string | null) => void>()
type HomeWalker = (homeId: HomeId) => Promise<boolean>
let homeWalker: HomeWalker | null = null
/** The home editor uses this bridge; failure never authorizes instant entry. */
export function setHomeWalker(walker: HomeWalker | null): void { homeWalker = walker }
export async function walkToHome(homeId: HomeId): Promise<boolean> {
  if (vehicles.seated.value) { toast('Step out of your vehicle before walking home.', 'info'); return false }
  return homeWalker ? homeWalker(homeId) : false
}

const floorListeners = new Set<(pos: Vec2) => void>()
const vehicleListeners = new Set<(id: VehicleId) => void>()

export const getEngine = (): WorldEngine | null => engine
let attachGeneration = 0
let engineWaiters: (() => void)[] = []
/** Resolves once the stage has an engine. Scene changes wait for it instead of failing when asked early. */
export function engineReady(): Promise<void> { return engine ? Promise.resolve() : new Promise(resolve => { engineWaiters.push(resolve) }) }
/** Where the member is on the street map: their street position, or the door they went in by when indoors. */
export function getStreetContext(): { districtId: DistrictId; position: Vec2; approximate: boolean } | null {
  if (world.kind === 'district' && world.districtId && engine) return { districtId: world.districtId, position: engine.position, approximate: false }
  return returnTo ? { districtId: returnTo.districtId, position: returnTo.pos, approximate: true } : null
}
export const onItemPicked = (listener: (key: string | null) => void): (() => void) => { itemListeners.add(listener); return () => itemListeners.delete(listener) }
export const onFloorClicked = (listener: (pos: Vec2) => void): (() => void) => { floorListeners.add(listener); return () => floorListeners.delete(listener) }
export const onVehiclePicked = (listener: (id: VehicleId) => void): (() => void) => { vehicleListeners.add(listener); return () => vehicleListeners.delete(listener) }

function localHour(timezone: string): number {
  if (world.timeMode === 'day') return 13
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(Date.now())
  const part = (type: string): number => Number(parts.find(entry => entry.type === type)?.value ?? 12)
  return part('hour') + part('minute') / 60
}

export function setTimeMode(mode: 'local' | 'day'): void {
  world.timeMode = mode
  localStorage.setItem('neighbourhood-world:time', mode)
  engine?.setTime(localHour(world.timezone))
}

function refreshInRange(): void {
  const me = engine?.position
  if (!me || !world.kind) { world.inRange = 0; return }
  const radius = PROXIMITY_RADIUS[world.kind]
  world.inRange = world.members.filter(member => distance(member.pos, me) <= radius).length
}

let lastMoveSent = 0
let moveSequence = 0
function sendMove(pos: Vec2, heading: number, moving: boolean): void {
  if (!world.roomKey || vehicles.seated.value) return
  const sequence = ++moveSequence, scene = generation, target = engine, memberId = myId(), room = world.roomKey, instance = world.instance
  lastMoveSent = performance.now()
  api('room.move', { pos, heading, moving }).then(result => {
    // The service rejected an impossible jump: stand where it says we are.
    if (!result.accepted && sequence === moveSequence && scene === generation && target === engine && memberId === myId()
      && room === world.roomKey && instance === world.instance && !vehicles.seated.value) target?.snapTo(result.pos)
  }).catch(() => undefined)
  if (district && world.kind === 'district') world.street = nearestStreetName(district, pos)
  ambience.update({ playerSpeed: moving ? 1.6 : 0, indoors: world.kind !== 'district' })
  if (world.homeWalk.kind === 'walking' && engine) {
    const metres = engine.walkingDistanceRemaining
    if (metres > 0) world.homeWalk.metres = metres
    else if (!world.nearHome || world.nearHome.homeId !== world.homeWalk.homeId) world.homeWalk = { kind: 'paused', homeId: world.homeWalk.homeId, name: world.homeWalk.name }
  }
  refreshInRange()
}

export function attachCanvas(canvas: HTMLCanvasElement): void {
  const mine = ++attachGeneration
  engine?.dispose()
  engine = null
  void import('../world/engine.ts').then(({ WorldEngine }) => {
    // The stage went away, or was mounted again, while the engine was being fetched.
    if (mine !== attachGeneration) return
    startEngine(new WorldEngine(canvas, {
        local: sendMove,
        vehicleInput: intent => vehicles.drive(intent),
        vehicleHit: id => { for (const listener of vehicleListeners) listener(id) },
        nearVenue: poi => { world.nearVenue = poi },
        nearDoor: near => { world.nearDoor = near },
        nearHome: entry => {
          world.nearHome = entry
          if (entry && (world.homeWalk.kind === 'walking' || world.homeWalk.kind === 'paused') && world.homeWalk.homeId === entry.homeId) world.homeWalk = { kind: 'at-door', homeId: entry.homeId, name: entry.name }
          else if (!entry && world.homeWalk.kind === 'at-door') world.homeWalk = { kind: 'paused', homeId: world.homeWalk.homeId, name: world.homeWalk.name }
        },
        nearStation: station => { world.station = station },
        edge: edge => {
          world.edge = edge
          if (edge && edge === homeLegDirection && world.homeWalk.kind === 'walking' && !crossingHomeLeg) void crossEdge()
        },
        pickMember: id => { world.selected = id },
        pickItem: key => { for (const listener of itemListeners) listener(key) },
        floorClick: pos => { for (const listener of floorListeners) listener(pos) },
        status: status => { world.status = status },
        rescued: () => toast('You were moved to the nearest clear spot.', 'info'),
    }, { quality: app.me?.preferences.quality ?? 'auto' }))
  }).catch(error => { fail(error) })
}

function startEngine(created: WorldEngine): void {
  engine = created
  created.setPowerMode(app.me?.preferences.powerMode ?? 'balanced')
  void import('./life.ts').then(({ life }) => {
    if (engine === created && life.state) created.setPace(life.state.effects.pace)
  })
  bindVehicles()
  created.start()
  if (app.me) void created.setLocalLook(app.me.look).then(() => syncOwnFace())
  for (const waiter of engineWaiters.splice(0)) waiter()
}

export function detachCanvas(): void { discardTransfer(); vehicles.bindWorld(null); vehicles.scene(null); attachGeneration++; engine?.dispose(); engine = null; ambience.leave() }

let ownFaceVersion = -1
export async function syncOwnFace(): Promise<void> {
  const me = app.me
  if (!engine || !me) return
  const target = engine, face = me.look.face
  if (!face) { target.setLocalFace(null, 0); ownFaceVersion = -1; return }
  if (ownFaceVersion === face.version) return
  try {
    const { scan } = await api('member.face', { memberId: me.id, version: face.version })
    // A reply for the account that was open before a reset, or for a replaced stage, is never applied.
    if (me.id !== myId() || target !== engine) return
    target.setLocalFace(scan, face.version)
    ownFaceVersion = face.version
  } catch { /* the stylised face stays */ }
}

/** Apply a changed look to the local avatar. */
export async function refreshLocalAvatar(): Promise<void> {
  if (!engine || !app.me) return
  await engine.setLocalLook(app.me.look)
  ownFaceVersion = -1
  await syncOwnFace()
}

const faceRequests = new Set<string>()
function loadFaces(): void {
  const target = engine, actor = myId()
  if (!target) return
  for (const { id, version } of target.facesNeeded(world.members)) {
    const key = `${actor}:${id}:${version}`
    if (faceRequests.has(key)) continue
    faceRequests.add(key)
    api('member.face', { memberId: id, version }).then(({ scan }) => { if (actor === myId() && target === engine) target.setMemberFace(id, scan, version) }).catch(() => undefined).finally(() => faceRequests.delete(key))
  }
}

async function joinRoom(ref: RoomRef, pos: Vec2, heading: number): Promise<void> {
  if (vehicles.seated.value) return
  const me = myId(), mine = generation, target = engine
  const { snapshot, history } = await api('room.enter', { ref, pos, heading })
  if (mine !== generation || me !== myId() || target !== engine) return
  const accepted = snapshot.members.find(member => member.id === me)
  if (!accepted) throw new Error('The street entry did not include your accepted position.')
  target?.snapTo(accepted.pos, accepted.heading)
  currentRef = snapshot.ref
  world.roomKey = snapshot.room
  world.instance = snapshot.instance
  world.capacity = snapshot.capacity
  world.members = snapshot.members.filter(member => member.id !== me)
  world.chat = history
  if (engine && me) { await engine.syncRemotes(snapshot.members, me); loadFaces() }
  refreshInRange()
  await vehicles.load()
  syncVehicles()
}

function fail(error: unknown): void {
  world.state = 'error'
  world.error = messageOf(error)
  world.errorKind = error instanceof DistrictLoadError ? error.kind : (error as { code?: string }).code === 'forbidden' ? 'forbidden' : 'network'
}

function begin(label: string): number {
  discardTransfer(); vehicles.scene(null); engine?.clearVehicles()
  engine?.stop()
  world.state = 'loading'
  world.loadingLabel = label
  world.error = ''
  world.errorKind = ''
  world.selected = null
  world.nearVenue = null
  world.nearDoor = false
  world.nearHome = null
  world.homeSource = null; world.homeSceneRevision = ''
  world.station = null
  world.edge = null
  return ++generation
}

function parseParcelManifest(value: unknown): HomeParcelManifest {
  if (!value || typeof value !== 'object' || !('schemaVersion' in value) || value.schemaVersion !== 1
    || !('id' in value) || typeof value.id !== 'string' || !('dataVersion' in value) || typeof value.dataVersion !== 'string'
    || !('mapDataVersion' in value) || typeof value.mapDataVersion !== 'string' || !('sceneHash' in value) || typeof value.sceneHash !== 'string'
    || !('regionPackSha256' in value) || typeof value.regionPackSha256 !== 'string' || !('districts' in value) || !Array.isArray(value.districts)) throw new Error('The home scenery manifest is invalid.')
  const districts: HomeParcelManifest['districts'] = []
  const rows: unknown[] = value.districts
  for (const row of rows) {
    if (!row || typeof row !== 'object' || !('districtId' in row) || typeof row.districtId !== 'string'
      || !('tileSha256' in row) || typeof row.tileSha256 !== 'string' || !('parcels' in row) || typeof row.parcels !== 'number' || !Number.isInteger(row.parcels) || row.parcels < 0) throw new Error('The home scenery district record is invalid.')
    const tile = parseDistrictId(row.districtId)
    if (!tile) throw new Error('The home scenery district is invalid.')
    const districtId = districtIdOf(tileToLatLon(tile))
    if (districtId !== row.districtId || districts.some(entry => entry.districtId === districtId)) throw new Error('The home scenery district is not unique and canonical.')
    districts.push({ districtId, tileSha256: row.tileSha256, parcels: row.parcels })
  }
  return { schemaVersion: 1, id: value.id, dataVersion: value.dataVersion, mapDataVersion: value.mapDataVersion, sceneHash: value.sceneHash, regionPackSha256: value.regionPackSha256, districts }
}

function loadParcelManifest(): Promise<HomeParcelManifest> {
  parcelManifestRequest ??= Promise.resolve().then(() => parseParcelManifest(homeManifest)).catch(error => { parcelManifestRequest = null; throw error })
  return parcelManifestRequest
}

/** All anonymous solids, plus only the entry associations this member may see. */
export function refreshHomeExteriors(): Promise<void> {
  const loaded = district, target = engine, memberId = myId(), scene = generation
  if (!loaded || !target || !memberId || world.kind !== 'district') return Promise.resolve()
  if (exteriorWork?.scene === scene && exteriorWork.memberId === memberId && exteriorWork.loaded === loaded && exteriorWork.target === target) {
    exteriorWork.dirty = true
    return exteriorWork.promise
  }
  const work = { scene, memberId, loaded, target, dirty: true, promise: Promise.resolve() }
  exteriorWork = work
  const current = (): boolean => exteriorWork === work && scene === generation && target === engine && loaded === district && memberId === myId() && world.kind === 'district'
  work.promise = (async () => {
    try {
      do {
        work.dirty = false
        const manifest = await loadParcelManifest()
        if (!current()) return
        const source = homeParcelSource(manifest, loaded.id)
        if (!source) { target.setHomeExteriors([], []); world.homeSource = null; world.homeSceneRevision = ''; return }
        const proof = vehicleSceneData(loaded), tile = vehicleManifest.source.tiles.find(row => row.districtId === loaded.id)
        if (!proof || source.mapDataVersion !== loaded.dataVersion || source.mapDataVersion !== proof.mapDataVersion
          || source.tileSha256 !== tile?.sha256 || source.sceneHash !== vehicleManifest.source.sceneHash || source.regionPackSha256 !== vehicleManifest.source.regionPackSha256) throw new Error('The house scenery does not match the trusted street map. Reload this district.')
        const result = await api('home.exteriors', { districtId: loaded.id, source })
        if (!current()) return
        if (!sameParcelSource(source, result.source)) throw new Error('The house scenery source changed. Reload this district.')
        if (!target.vehicleSceneReady) throw new Error('The trusted street details are not ready for houses. Reload this district.')
        target.setHomeExteriors(result.buildings, result.entries)
        if (homeTargetDistrict === loaded.id && (world.homeWalk.kind === 'walking' || world.homeWalk.kind === 'paused' || world.homeWalk.kind === 'at-door')) {
          const entry = target.getHomeEntrance(world.homeWalk.homeId)
          if (!entry || entry.buildingId !== homeTargetBuilding) {
            target.stop(); homeLegDirection = null; homeTargetDistrict = null; homeTargetBuilding = null
            world.homeWalk = { kind: 'unavailable', message: 'This home route is no longer available. Choose Walk again to check the door.' }
          }
        }
        world.homeSource = result.source; world.homeSceneRevision = result.sceneRevision
      } while (work.dirty && current())
    } catch (error) { if (current()) throw error }
    finally { if (exteriorWork === work) exteriorWork = null }
  })()
  return work.promise
}

/** Show a district. `at` overrides the public arrival point (walking in from a neighbour, or returning from a venue). */
export async function enterDistrict(districtId: DistrictId, options: { areaLabel?: string; countryCode?: string; at?: Vec2; heading?: number; homeExit?: HomeLeft } = {}): Promise<boolean> {
  if (vehicles.seated.value) return false
  await engineReady()
  if (!engine || !app.me) return false
  world.homeWalk = { kind: 'idle' }; homeLegDirection = null; homeTargetDistrict = null; homeTargetBuilding = null
  const mine = begin('Loading streets and places…'), target = engine, memberId = app.me.id
  try {
    let loaded: District
    try { loaded = await loadVehicleDistrict(districtId) }
    catch { loaded = await loadDistrict(districtId) }
    if (mine !== generation || target !== engine || memberId !== app.me?.id) return false
    const arrival = chooseArrival(loaded)
    // Everyone arrives at the same public spot; the engine moves each member to their own walkable place beside it.
    const start = options.at ?? arrival.pos
    district = loaded
    const tile = parseDistrictId(districtId)!
    world.timezone = timezoneAt(tileToLatLon(tile))
    engine.setTime(localHour(world.timezone))
    await engine.setLocalLook(app.me.look)
    if (mine !== generation || target !== engine || memberId !== app.me?.id) return false
    const vehicleContext = vehicleDistrictContext(districtId)
    const countryCode = vehicleContext?.countryCode ?? options.countryCode ?? world.countryCode
    await engine.enterDistrict(loaded, start, options.heading ?? arrival.heading, { ...(countryCode ? { countryCode, areaLabel: vehicleContext?.areaLabel ?? options.areaLabel ?? world.areaLabel } : {}), memberId: app.me.id, spreadArrival: !options.at, authoritative: Boolean(options.homeExit) })
    if (mine !== generation || target !== engine || memberId !== app.me?.id) return false
    world.countryCode = countryCode
    void syncOwnFace()
    const current = app.me.currentArea
    world.kind = 'district'
    world.districtId = districtId
    world.inCurrentArea = Boolean(current && Date.parse(current.expiresAt) > Date.now() && current.areaId === areaOfDistrict(districtId))
    world.areaLabel = options.areaLabel ?? (world.inCurrentArea && current ? current.label : app.me.browsing?.arrivalDistrict === districtId ? app.me.browsing.label : world.areaLabel || 'This district')
    world.title = world.areaLabel
    world.coverage = loaded.coverage
    world.arrival = arrival
    world.dataVersion = loaded.dataVersion
    world.places = [...loaded.pois].sort((a, b) => Math.hypot(a.pos.x - start.x, a.pos.z - start.z) - Math.hypot(b.pos.x - start.x, b.pos.z - start.z))
    world.street = nearestStreetName(loaded, engine.position)
    world.subtitle = options.at ? '' : `Arrived at ${arrival.label}`
    world.home = null
    world.venue = null
    returnTo = null
    if (options.homeExit) {
      await acceptRoomSnapshot(options.homeExit.snapshot)
      if (mine !== generation || target !== engine) return false
      world.chat = options.homeExit.history
    } else await joinRoom({ kind: 'district', districtId }, engine.position, engine.facing)
    await refreshHomeExteriors()
    if (mine !== generation) return false
    world.state = 'ready'
    vehicles.scene(engine.vehicleSceneReady ? vehicleSceneData(loaded) : null)
    await vehicles.load()
    syncVehicles()
    ambience.enter({ countryCode: world.countryCode, areaLabel: world.areaLabel, kind: 'district', hour: localHour(world.timezone) })
    return true
  } catch (error) {
    if (mine === generation) fail(error)
    return false
  }
}

export async function enterArea(area: CoarseArea): Promise<boolean> {
  return enterDistrict(area.arrivalDistrict, { areaLabel: area.label, countryCode: area.countryCode })
}

/** A real route to a mapped street crossing of the next district, never a scene jump. */
function homeDistrictLeg(targetDistrict: DistrictId): { direction: EdgeDirection; pos: Vec2; metres: number } | null {
  if (!engine || !district || !world.districtId) return null
  const here = parseDistrictId(world.districtId), there = parseDistrictId(targetDistrict)
  if (!here || !there || here.z !== there.z || here.x === there.x && here.y === there.y) return null
  const direction: EdgeDirection = there.x !== here.x ? there.x > here.x ? 'east' : 'west' : there.y > here.y ? 'south' : 'north'
  const horizontal = direction === 'east' || direction === 'west'
  const edge = (direction === 'east' || direction === 'south' ? 1 : -1) * (district.span / 2 - 6)
  let best: { direction: EdgeDirection; pos: Vec2; metres: number } | null = null
  for (const road of district.roads) {
    if (road.tunnel || road.kind === 'rail' || road.kind === 'motorway') continue
    for (let index = 1; index < road.points.length; index++) {
      const a = road.points[index - 1]!, b = road.points[index]!
      const from = horizontal ? a.x : a.z, to = horizontal ? b.x : b.z
      if (Math.abs(to - from) < 0.01) continue
      const t = (edge - from) / (to - from)
      if (t < 0 || t > 1) continue
      const pos = { x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t }
      if (Math.abs(horizontal ? pos.z : pos.x) > district.span / 2 - 12) continue
      const route = engine.previewWalkTo(pos, { exact: true })
      if (!route) continue
      if (!best || route.length < best.metres) best = { direction, pos, metres: route.length }
    }
  }
  return best
}

/** Walk off the edge of the loaded district into the next one. */
export async function crossEdge(): Promise<void> {
  if (!engine || !world.edge || vehicles.seated.value || crossingHomeLeg) return
  const next = engine.neighbour(world.edge)
  if (!next) return
  const destination = world.homeWalk.kind === 'walking' || world.homeWalk.kind === 'paused' ? world.homeWalk.homeId : null
  crossingHomeLeg = true
  homeLegDirection = null
  try {
    if (await enterDistrict(next.districtId as DistrictId, { at: next.entry, areaLabel: world.areaLabel })) {
      if (destination) await walkToHome(destination)
    }
  } finally { crossingHomeLeg = false }
}

export async function enterVenue(poi: Poi): Promise<void> {
  if (!engine || !district || !world.districtId || vehicles.seated.value) return
  const back = { districtId: world.districtId, pos: engine.position }
  const mine = begin(`Entering ${poi.name}…`)
  try {
    const { venueLayout } = await import('../world/interior.ts')
    if (mine !== generation || !engine) return
    const layout = venueLayout(poi.category, poi.name.length)
    await engine.enterInterior({ kind: 'venue', title: poi.name, layout, illustrative: true })
    if (mine !== generation) return
    returnTo = back
    world.kind = 'venue'
    ambience.enter({ countryCode: world.countryCode, areaLabel: world.areaLabel, kind: 'venue', venueCategory: poi.category, hour: localHour(world.timezone) })
    world.venue = poi
    world.title = poi.name
    world.subtitle = 'Public venue · the room is illustrative, not the real interior'
    world.street = null
    await joinRoom({ kind: 'venue', districtId: back.districtId, placeId: poi.placeId }, engine.position, engine.facing)
    world.state = 'ready'
  } catch (error) {
    if (mine === generation) fail(error)
  }
}

export function cancelHomeWalk(): void {
  homeWalkGeneration++
  if (homeTargetDistrict || world.homeWalk.kind === 'walking' || world.homeWalk.kind === 'paused' || world.homeWalk.kind === 'at-door') engine?.stop()
  homeLegDirection = null; homeTargetDistrict = null; homeTargetBuilding = null; world.homeWalk = { kind: 'idle' }
}

async function startHomeWalk(homeId: HomeId): Promise<boolean> {
  const walk = ++homeWalkGeneration
  await engineReady()
  const target = engine, memberId = myId(), scene = generation
  if (!target || !memberId || world.state !== 'ready') return false
  if (world.kind !== 'district') { world.homeWalk = { kind: 'unavailable', message: 'Step outside before walking to another home.' }; return false }
  target.stop(); homeLegDirection = null; homeTargetDistrict = null; homeTargetBuilding = null; world.homeWalk = { kind: 'idle' }
  try {
    const [{ approach }, { home }] = await Promise.all([api('home.approach', { homeId }), api('home.get', { homeId })])
    if (walk !== homeWalkGeneration || scene !== generation || target !== engine || memberId !== myId() || vehicles.seated.value) return false
    if (approach.kind === 'unavailable') { world.homeWalk = { kind: 'unavailable', message: approach.message }; return false }
    if (approach.kind === 'travel') { world.homeWalk = { kind: 'travel', homeId: approach.homeId, to: approach.to }; return false }
    homeLegDirection = null
    homeTargetDistrict = approach.site.districtId; homeTargetBuilding = approach.site.buildingId
    if (approach.site.districtId !== world.districtId) {
      const leg = homeDistrictLeg(approach.site.districtId)
      if (!leg) { world.homeWalk = { kind: 'unavailable', message: 'No clear walking crossing was found. Walk to a nearby district edge first.' }; return false }
      const route = target.queueHomeWalk(leg.pos)
      if (route.status === 'unreachable') { world.homeWalk = { kind: 'unavailable', message: 'This walking crossing is blocked.' }; return false }
      homeLegDirection = leg.direction
      world.homeWalk = { kind: 'walking', homeId, name: home.name, metres: route.length }
      if (world.edge === leg.direction && route.status === 'arrived') queueMicrotask(() => {
        if (world.state === 'ready' && world.homeWalk.kind === 'walking' && homeLegDirection === world.edge) void crossEdge()
      })
      return true
    }
    await refreshHomeExteriors()
    if (walk !== homeWalkGeneration || scene !== generation || target !== engine || memberId !== myId()) return false
    const entry = target.getHomeEntrance(homeId)
    if (!world.homeSource || !sameParcelSource(world.homeSource, approach.site.parcel.source) || entry?.buildingId !== approach.site.buildingId) {
      world.homeWalk = { kind: 'unavailable', message: 'This house is not available in the verified street scene. Reload this district.' }
      return false
    }
    const route = target.queueHomeWalk(approach.site.parcel.standing)
    if (route.status === 'unreachable') { world.homeWalk = { kind: 'unavailable', message: 'The route to this front door is blocked. Try again when the path is clear.' }; return false }
    world.homeWalk = route.status === 'arrived' ? { kind: 'at-door', homeId, name: home.name } : { kind: 'walking', homeId, name: home.name, metres: route.length }
    return true
  } catch (error) { if (walk === homeWalkGeneration && scene === generation && memberId === myId()) world.homeWalk = { kind: 'unavailable', message: messageOf(error) }; return false }
}
setHomeWalker(startHomeWalk)

async function showEnteredHome(result: HomeEntered, scene: number): Promise<boolean> {
  const target = engine, me = app.me
  if (!target || !me || scene !== generation) return false
  await target.setLocalLook(me.look)
  if (scene !== generation || target !== engine || me.id !== myId()) return false
  await target.enterInterior({ kind: 'home', title: result.home.name, layout: result.home.layout, plan: result.home.building.plan, illustrative: false })
  if (scene !== generation || target !== engine || me.id !== myId()) return false
  target.snapTo(result.inside.pos, result.inside.heading)
  drawnPlan = result.home.building.plan.version
  const site = result.home.building.site
  world.districtId = result.stay.districtId
  if (site) { world.areaLabel = site.areaLabel; world.countryCode = site.area.countryCode; world.timezone = site.area.timezone }
  target.setTime(localHour(world.timezone))
  returnTo = site ? { districtId: site.districtId, pos: site.parcel.door } : null
  world.kind = 'home'; world.home = result.home; world.canEditHome = result.canEdit; world.venue = null
  const homeArea = site?.areaLabel ?? result.home.districtLabel
  world.title = result.home.name; world.subtitle = result.canEdit ? `Your home · ${homeArea}` : `${result.home.owner.displayName}’s home · ${homeArea}`
  world.street = null; world.nearHome = null; world.homeWalk = { kind: 'idle' }; homeLegDirection = null; homeTargetDistrict = null; homeTargetBuilding = null
  await acceptRoomSnapshot(result.snapshot)
  if (scene !== generation || target !== engine) return false
  world.chat = result.history
  void syncOwnFace()
  ambience.enter({ countryCode: world.countryCode, areaLabel: world.areaLabel, kind: 'home', hour: localHour(world.timezone) })
  world.state = 'ready'
  return true
}

/** Only the service's actual front-door entry can open a home. */
export async function enterHome(homeId: HomeId | null): Promise<boolean> {
  if (vehicles.seated.value) { toast('Step out of your vehicle before entering a home.', 'info'); return false }
  await engineReady()
  if (!engine || !app.me) return false
  if (world.kind === 'home') return homeId ? world.home?.id === homeId : world.canEditHome
  if (world.kind !== 'district' || world.state !== 'ready') return false
  const scene = begin('Opening the front door…')
  try { return await showEnteredHome(await api('home.enter', { homeId }), scene) }
  catch (error) {
    if (scene === generation) { world.state = 'ready'; world.error = messageOf(error); toast(world.error, 'info') }
    return false
  }
}

/** Redraw a furniture draft without changing its committed room plan. */
export async function showHomeLayout(layout: HomeLayout): Promise<void> { await engine?.setInteriorItems(layout.items) }

/** Apply a committed plan before its furniture so an expanded room is visible immediately. */
export async function showHome(home: Home): Promise<void> {
  if (world.kind !== 'home' || world.home?.id !== home.id) return
  if (home.building.plan.version !== drawnPlan) { drawnPlan = home.building.plan.version; engine?.setInteriorPlan(home.building.plan) }
  await engine?.setInteriorItems(home.layout.items)
}

/** Homes leave through the service-approved clear spot beside their own door. */
export async function leaveInterior(): Promise<void> {
  if (vehicles.seated.value) return
  if (world.kind === 'home') {
    if (homeLeaveRequested) return
    const actor = myId(), scene = generation
    homeLeaveRequested = true
    try {
      const result = await api('home.leave', {})
      if (actor !== myId() || scene !== generation) return
      pendingHomeExit = result
      if (await enterDistrict(result.exit.districtId, { at: result.exit.pos, heading: result.exit.heading, areaLabel: world.home?.building.site?.areaLabel ?? world.areaLabel, homeExit: result })) pendingHomeExit = null
    } catch (error) { if (actor === myId() && scene === generation) toast(messageOf(error), 'info') }
    finally { homeLeaveRequested = false }
    return
  }
  const back = returnTo
  if (back) { await enterDistrict(back.districtId, { at: back.pos, areaLabel: world.areaLabel }); return }
  const area = app.me?.browsing ?? app.me?.currentArea
  if (area) await enterArea(area)
}

/** Back to the street after watching a table: same district, same spot the avatar stood on. */
export async function rejoinStreet(): Promise<void> {
  if (vehicles.seated.value) return
  const at = engine?.position
  if (world.kind === 'district' && world.districtId && at) { await enterDistrict(world.districtId, { at, heading: engine?.facing, areaLabel: world.areaLabel }); return }
  await retryScene()
}

let arrivalTarget: CoarseArea | null = null
/** Where the avatar has just arrived, kept until that scene has loaded. */
export function setArrivalTarget(area: CoarseArea | null): void { arrivalTarget = area }

export async function retryScene(): Promise<void> {
  if (pendingHomeExit) {
    const exit = pendingHomeExit
    if (await enterDistrict(exit.exit.districtId, { at: exit.exit.pos, heading: exit.exit.heading, homeExit: exit })) pendingHomeExit = null
    return
  }
  if (homeRestorePending || world.kind === 'home') { await enterDefaultScene(); return }
  if (vehicles.seated.value) { await restoreSeatedScene(); return }
  if (arrivalTarget) { if (await enterArea(arrivalTarget)) arrivalTarget = null; return }
  if (world.districtId) { await enterDistrict(world.districtId, { areaLabel: world.areaLabel }); return }
  const area = app.me?.browsing ?? app.me?.currentArea
  if (area) await enterArea(area)
}

/** Enter the scene a returning member should see first. Returns false when an area must be chosen. */
export async function enterDefaultScene(location: CoarseArea | null = null): Promise<boolean> {
  const me = app.me
  if (!me) return false
  await engineReady()
  if (me.id !== myId()) return false
  const loadingScene = begin('Restoring your place…')
  await vehicles.load()
  if (me.id !== myId() || loadingScene !== generation) return false
  if (vehicles.seated.value) { await restoreSeatedScene(); return world.state === 'ready' }
  homeRestorePending = true
  try {
    const { stay, lastExit } = await api('home.presence', {})
    if (me.id !== myId() || loadingScene !== generation) return false
    if (stay) {
      if (stay.state === 'shown-out') {
        const left = await api('home.leave', {})
        if (me.id !== myId() || loadingScene !== generation) return false
        const shown = await enterDistrict(left.exit.districtId, { at: left.exit.pos, heading: left.exit.heading, homeExit: left })
        if (shown) homeRestorePending = false
        return shown
      }
      const scene = begin('Returning to your home…')
      try {
        const resumed = await api('home.resume', {})
        const shown = await showEnteredHome(resumed, scene)
        if (shown) homeRestorePending = false
        return shown
      } catch (error) {
        if (me.id !== myId() || scene !== generation) return false
        const presence = await api('home.presence', {})
        if (me.id !== myId() || scene !== generation) return false
        if (presence.stay?.state !== 'shown-out') throw error
        const left = await api('home.leave', {})
        if (me.id !== myId() || scene !== generation) return false
        const shown = await enterDistrict(left.exit.districtId, { at: left.exit.pos, heading: left.exit.heading, homeExit: left })
        if (shown) homeRestorePending = false
        return shown
      }
    }
    if (lastExit) {
      const left = await api('home.return', {})
      if (me.id !== myId() || loadingScene !== generation) return false
      const shown = await enterDistrict(left.exit.districtId, { at: left.exit.pos, heading: left.exit.heading, homeExit: left })
      if (shown) homeRestorePending = false
      return shown
    }
    homeRestorePending = false
  } catch (error) { if (me.id === myId()) fail(error); return false }
  // The travel service says where the avatar is; older profiles fall back to their saved area.
  const area = location ?? me.browsing ?? me.currentArea
  if (!area) { world.state = 'idle'; world.loadingLabel = ''; return false }
  return enterArea(area)
}

export async function sendChat(text: string): Promise<boolean> {
  try {
    const { message } = await api('chat.send', { text, clientId: `${Date.now()}` })
    world.chat.push(message)
    if (world.chat.length > 60) world.chat.shift()
    return true
  } catch (error) {
    toast(messageOf(error), 'bad')
    return false
  }
}

export function walkToPlace(poi: Poi): { viaStreets: boolean; length: number } | null {
  if (!engine || world.kind !== 'district' || vehicles.seated.value) return null
  return engine.walkTo(poi.pos)
}

export function returnToArrival(): void {
  if (!vehicles.seated.value && engine && world.arrival && world.kind === 'district') { engine.snapTo(world.arrival.pos); sendMove(world.arrival.pos, 0, false) }
}

function upsert(member: PresenceMember): void {
  const index = world.members.findIndex(entry => entry.id === member.id)
  if (index >= 0) world.members[index] = member; else world.members.push(member)
  void engine?.upsertMember(member).then(loadFaces)
}

onServerEvent(event => {
  if (event.type === 'presence.join' && event.room === world.roomKey) { if (event.member.id !== myId()) upsert(event.member) }
  else if (event.type === 'presence.update' && event.room === world.roomKey) { if (event.member.id !== myId()) upsert(event.member) }
  else if (event.type === 'presence.leave' && event.room === world.roomKey) {
    world.members = world.members.filter(member => member.id !== event.memberId)
    engine?.removeMember(event.memberId)
    if (world.selected === event.memberId) world.selected = null
  } else if (event.type === 'presence.move' && event.room === world.roomKey) {
    const member = world.members.find(entry => entry.id === event.memberId)
    if (member) { member.pos = event.pos; member.heading = event.heading; member.moving = event.moving }
    engine?.moveMember(event.memberId, event.pos, event.heading, event.moving)
  } else if (event.type === 'chat.message' && event.message.room === world.roomKey) {
    world.chat.push(event.message)
    if (world.chat.length > 60) world.chat.shift()
  } else if (world.kind === 'district' && ((event.type === 'home.exteriors' && event.districtId === world.districtId) || (event.type === 'social.changed' && event.scope === 'homes'))) {
    const actor = myId(), scene = generation
    void refreshHomeExteriors().catch(error => { if (actor === myId() && scene === generation) fail(error) })
  } else if (event.type === 'social.changed' && event.scope === 'homes' && world.kind === 'home' && world.home) {
    const homeId = world.home.id, memberId = myId(), scene = generation
    api('home.get', { homeId }).then(({ home, canEdit }) => {
      if (memberId !== myId() || scene !== generation || world.home?.id !== homeId) return
      world.home = home; world.canEditHome = canEdit
      void showHome(home)
    }).catch(() => {
      if (memberId !== myId() || scene !== generation || world.home?.id !== homeId) return
      toast('This home is no longer open to you.', 'info'); void leaveInterior()
    })
  }
  refreshInRange()
})

function syncVehicles(motion?: Extract<VehicleEvent, { type: 'vehicle.move' }>): void {
  engine?.syncVehicles(vehicles.state.connected ? vehicles.state.data?.vehicles ?? [] : [], vehicles.state.connected ? vehicles.self.value : null, world.roomKey ? { key: world.roomKey, instance: world.instance } : null, motion)
}
watch(() => [vehicles.state.data?.vehicles, vehicles.self.value, vehicles.state.connected, world.roomKey, world.instance], () => syncVehicles(), { deep: true, flush: 'sync' })
watch(() => app.link, link => { if (link !== 'online') { discardTransfer(); engine?.clearVehicles() } }, { flush: 'sync' })

function discardTransfer(): void {
  const pending = preparedTransfer; preparedTransfer = null
  if (pending) { clearTimeout(pending.timer); pending.disposeAbort(); pending.prepared.dispose() }
}

async function acceptRoomSnapshot(snapshot: RoomSnapshot): Promise<void> {
  const mine = generation, target = engine, me = myId()
  currentRef = snapshot.ref; world.roomKey = snapshot.room; world.instance = snapshot.instance; world.capacity = snapshot.capacity
  world.members = snapshot.members.filter(member => member.id !== me)
  if (target && me) { await target.syncRemotes(snapshot.members, me); if (mine !== generation || target !== engine) return; loadFaces() }
  syncVehicles(); refreshInRange()
}

function showTransferredDistrict(loaded: District): void {
  const tile = parseDistrictId(loaded.id), context = vehicleDistrictContext(loaded.id)
  district = loaded; world.kind = 'district'; world.districtId = loaded.id
  world.countryCode = context?.countryCode ?? world.countryCode; world.areaLabel = context?.areaLabel ?? world.areaLabel
  world.timezone = tile ? timezoneAt(tileToLatLon(tile)) : world.timezone
  world.dataVersion = loaded.dataVersion; world.coverage = loaded.coverage; world.arrival = chooseArrival(loaded)
  world.places = [...loaded.pois]; world.nearVenue = null; world.edge = null; world.nearDoor = false; world.station = null
  world.home = null; world.venue = null; returnTo = null
  const current = app.me?.currentArea
  world.inCurrentArea = Boolean(current && Date.parse(current.expiresAt) > Date.now() && current.areaId === areaOfDistrict(loaded.id))
  world.title = world.areaLabel || 'This district'; world.subtitle = ''
  world.street = engine ? nearestStreetName(loaded, engine.position) : null
  world.state = 'ready'
  engine?.setTime(localHour(world.timezone))
  vehicles.scene(engine?.vehicleSceneReady ? vehicleSceneData(loaded) : null)
}

function bindVehicles(): void {
  vehicles.bindWorld({
    async loadTransfer(event, signal) {
      discardTransfer()
      const target = engine, mine = generation
      if (!target || !app.me) throw new Error('The vehicle world is not ready.')
      const loaded = await loadVehicleDistrict(event.room.districtId, signal)
      const scene = vehicleSceneData(loaded), service = vehicles.state.data?.data
      if (!scene || !service || scene.id !== service.id || scene.dataVersion !== service.dataVersion || scene.mapDataVersion !== service.mapDataVersion) throw new Error('That district has no matching vehicle road scene.')
      const prepared = await target.prepareVehicleDistrict(loaded, event.spawn, signal)
      if (signal.aborted || mine !== generation || target !== engine) { prepared.dispose(); throw new Error('The vehicle crossing was superseded.') }
      const cancel = (): void => { queueMicrotask(() => { if (preparedTransfer?.id === event.transferId) discardTransfer() }) }
      signal.addEventListener('abort', cancel, { once: true })
      const timer = setTimeout(() => { if (preparedTransfer?.id === event.transferId) discardTransfer() }, Math.max(0, Date.parse(event.expiresAt) - Date.now()) + 100)
      preparedTransfer = { id: event.transferId, generation: mine, prepared, timer, disposeAbort: () => signal.removeEventListener('abort', cancel) }
      // The client sends ack only after this real detached scene and all its assets are ready.
    },
    transferred(event) { void commitVehicleTransfer(event) },
    resumed(snapshot, self) { void queueVehicleResume(snapshot, self) },
    exited(result) {
      syncVehicles(); engine?.syncVehicles(vehicles.state.data?.vehicles ?? [], result.self, world.roomKey ? { key: world.roomKey, instance: world.instance } : null)
      engine?.snapTo(result.pos, result.heading)
    },
    motion(event) { syncVehicles(event); refreshInRange() },
  })
}

async function commitVehicleTransfer(event: Extract<VehicleEvent, { type: 'vehicle.transferred' }>): Promise<void> {
  const pending = preparedTransfer, target = engine, me = app.me
  if (!pending || pending.id !== event.transferId || pending.generation !== generation || pending.prepared.district.id !== event.vehicle.room.districtId || !target || !me) { await queueVehicleResume(event.snapshot, event.self); return }
  preparedTransfer = null; clearTimeout(pending.timer); pending.disposeAbort()
  const mine = ++generation
  try {
    await target.enterDistrict(pending.prepared.district, event.vehicle.pos, event.vehicle.heading, { ...pending.prepared.context, memberId: me.id, authoritative: true, prepared: pending.prepared })
    if (mine !== generation || target !== engine || me.id !== app.me?.id) return
    showTransferredDistrict(pending.prepared.district)
    await acceptRoomSnapshot(event.snapshot)
    await refreshHomeExteriors()
    syncVehicles()
    ambience.enter({ countryCode: world.countryCode, areaLabel: world.areaLabel, kind: 'district', hour: localHour(world.timezone) })
  } catch (error) { vehicles.state.problem = messageOf(error) }
}

async function restoreSeatedScene(): Promise<void> {
  const target = engine, memberId = myId(), scene = generation, resumeSequence = vehicleResumeSequence, attempt = ++vehicleRestoreAttempt
  const ownsScene = (): boolean => attempt === vehicleRestoreAttempt && target === engine && memberId === myId()
    && (generation === scene || vehicleResumeSequence > resumeSequence && generation === vehicleResumeGeneration)
  try {
    await vehicles.resume()
    let pending: Promise<void> | null
    do { pending = vehicleResumeWork; await pending } while (pending !== vehicleResumeWork && target === engine && memberId === myId())
    if (ownsScene() && world.state !== 'ready' && world.state !== 'error') {
      fail(new Error(vehicles.state.problem || 'Your ride is still reconnecting. Try again to restore the street.'))
    }
  } catch (error) { if (ownsScene()) fail(error) }
}

function queueVehicleResume(snapshot: RoomSnapshot | null, self: VehicleSelf): Promise<void> {
  const target = engine, memberId = myId()
  if (!target || !memberId || (!snapshot && !self.seat && !currentRef)) return Promise.resolve()
  const sequence = ++vehicleResumeSequence, scene = ++generation
  vehicleResumeGeneration = scene
  if (self.seat) { world.state = 'loading'; world.loadingLabel = 'Restoring your ride…'; world.error = ''; world.errorKind = '' }
  const ownsRequest = (): boolean => sequence === vehicleResumeSequence && target === engine && memberId === myId()
  const previous = vehicleResumeWork
  const work = (previous ?? Promise.resolve()).catch(() => undefined).then(async () => {
    if (!ownsRequest() || scene !== generation) return
    const vehicle = self.vehicle
    if (self.seat && (!vehicle || self.seat.vehicleId !== vehicle.id || !snapshot || snapshot.ref.kind !== 'district'
      || snapshot.room !== roomKey(snapshot.ref) || snapshot.room !== vehicle.room.key
      || snapshot.instance !== vehicle.room.instance || snapshot.ref.districtId !== vehicle.room.districtId)) {
      fail(new Error('Your ride changed while reconnecting. Try again to load its current street.'))
      return
    }
    await resumeVehicleWorld(snapshot, self, ownsRequest)
  })
  vehicleResumeWork = work
  return work
}

async function resumeVehicleWorld(snapshot: RoomSnapshot | null, self: VehicleSelf, ownsRequest: () => boolean = () => true): Promise<void> {
  const target = engine, me = app.me, mine = generation
  if (!target || !me || !ownsRequest()) return
  if (!snapshot && !self.seat && currentRef?.kind === 'home') {
    let expected = mine
    try {
      const { stay } = await api('home.presence', {})
      if (!ownsRequest() || mine !== generation || target !== engine || me.id !== myId()) return
      if (!stay) throw new Error('Your saved home stay is unavailable. Reload to return to the street safely.')
      if (stay.state === 'shown-out') {
        const left = await api('home.leave', {})
        if (!ownsRequest() || mine !== generation || target !== engine || me.id !== myId()) return
        await enterDistrict(left.exit.districtId, { at: left.exit.pos, heading: left.exit.heading, homeExit: left })
      } else {
        const scene = begin('Reconnecting to your home…'); expected = scene
        await showEnteredHome(await api('home.resume', {}), scene)
      }
    } catch (error) { if (ownsRequest() && expected === generation && target === engine && me.id === myId()) fail(error) }
    return
  }
  if (!snapshot) {
    if (!self.seat && currentRef && world.state === 'ready') {
      try { await joinRoom(currentRef, target.position, target.facing); await refreshHomeExteriors() }
      catch (error) { if (ownsRequest() && mine === generation && target === engine && me.id === myId()) fail(error) }
    }
    return
  }
  if (snapshot.ref.kind !== 'district') { if (ownsRequest()) await acceptRoomSnapshot(snapshot); return }
  if (world.districtId !== snapshot.ref.districtId || world.kind !== 'district' || target.mode !== 'district') {
    try {
      const loaded = await loadVehicleDistrict(snapshot.ref.districtId)
      if (!ownsRequest() || mine !== generation || target !== engine || me.id !== app.me?.id) return
      const position = self.vehicle?.pos ?? snapshot.members.find(member => member.id === me.id)?.pos
      if (!position) throw new Error('The world did not return your safe resumed position.')
      const context = vehicleDistrictContext(loaded.id)
      if (!context) throw new Error('That district has no supported vehicle scene context.')
      await target.enterDistrict(loaded, position, self.vehicle?.heading ?? 0, { ...context, memberId: me.id, authoritative: true })
      if (!ownsRequest() || mine !== generation || target !== engine || me.id !== app.me?.id) return
      showTransferredDistrict(loaded)
    } catch (error) { if (ownsRequest() && mine === generation && target === engine && me.id === myId()) { vehicles.state.problem = messageOf(error); fail(error) }; return }
  }
  if (!ownsRequest() || mine !== generation || target !== engine || me.id !== myId()) return
  await acceptRoomSnapshot(snapshot)
  if (!ownsRequest() || mine !== generation || target !== engine || me.id !== myId()) return
  await refreshHomeExteriors()
  if (!ownsRequest() || mine !== generation || target !== engine || me.id !== myId()) return
  const presence = snapshot.members.find(member => member.id === me.id)
  if (!self.seat && presence) target.snapTo(presence.pos, presence.heading)
  syncVehicles()
  if (ownsRequest() && mine === generation && target === engine && me.id === myId()) world.state = 'ready'
}

// Reconnect is owned by vehicle.resume, whose foot result rejoins only after the service has resolved any held seat.
onAccountReset(() => {
  vehicleResumeSequence++; vehicleRestoreAttempt++; vehicleResumeGeneration = -1
  discardTransfer(); engine?.clearVehicles(); engine?.setHomeExteriors([], []); vehicles.scene(null)
  generation++; exteriorWork = null
  ambience.leave()
  district = null
  currentRef = null
  returnTo = null
  homeLegDirection = null; homeTargetDistrict = null; homeTargetBuilding = null; crossingHomeLeg = false; pendingHomeExit = null; homeRestorePending = false; homeLeaveRequested = false
  ownFaceVersion = -1
  Object.assign(world, {
    state: 'idle', error: '', kind: null, title: '', subtitle: '', districtId: null, areaLabel: '', coverage: null, arrival: null, street: null, homeSource: null, homeSceneRevision: '',
    places: [], nearVenue: null, nearDoor: false, nearHome: null, homeWalk: { kind: 'idle' }, station: null, edge: null, roomKey: null, members: [], chat: [], selected: null, home: null, venue: null, inRange: 0,
  })
})

setInterval(() => { if (engine && world.kind === 'district') engine.setTime(localHour(world.timezone)) }, 60_000)
setInterval(() => { if (world.roomKey && performance.now() - lastMoveSent > 1500) refreshInRange() }, 1500)
