<script lang="ts">
// The live budget shared by every preview on screen. Each live preview owns a WebGL context, and a
// browser only hands out a few, so cards take turns: at most MAX_LIVE draw at once, the rest show
// the last picture they drew (or a coloured placeholder until they have had a first turn).
interface PoolClient {
  /** Visible large previews get the next available turn. */
  readonly priority: boolean
  startedAt: number
  eligible(): boolean
  start(): void
  stop(): void
  /** Has a drawn picture to show while it waits. */
  hasStill(): boolean
  /** Hovered or being dragged: its turn is not taken away. */
  busy(): boolean
}

const MAX_LIVE = 6
const live = new Set<PoolClient>()
const waiting: PoolClient[] = []

function begin(client: PoolClient): void {
  live.add(client)
  client.startedAt = performance.now()
  client.start()
}

function pump(): void {
  if (document.hidden) return
  for (let i = waiting.length - 1; i >= 0; i--) if (!waiting[i]?.eligible()) waiting.splice(i, 1)
  while (waiting.length && live.size < MAX_LIVE) {
    // Previews that have never drawn go first.
    const priority = waiting.findIndex(client => client.priority)
    const starved = priority >= 0 ? priority : waiting.findIndex(client => !client.hasStill())
    const [next] = waiting.splice(Math.max(0, starved), 1)
    if (!next) break
    begin(next)
  }
}

/** The longest-running card that already has a picture and is not in use gives up its turn. */
function handOver(): boolean {
  let giving: PoolClient | undefined
  for (const client of live) {
    if (client.priority || !client.hasStill() || client.busy()) continue
    if (!giving || client.startedAt < giving.startedAt) giving = client
  }
  if (!giving) return false
  live.delete(giving)
  giving.stop()
  waiting.push(giving)
  return true
}

function balance(): void {
  while (live.size >= MAX_LIVE && waiting.some(client => !client.hasStill())) {
    if (!handOver()) break
    pump()
  }
  pump()
}

function request(client: PoolClient, urgent = false): void {
  if (!client.eligible() || live.has(client)) return
  if (!waiting.includes(client)) waiting.push(client)
  if ((urgent || client.priority) && live.size >= MAX_LIVE && handOver()) {
    waiting.splice(waiting.indexOf(client), 1)
    begin(client)
    return
  }
  balance()
}

function release(client: PoolClient): void {
  const index = waiting.indexOf(client)
  if (index >= 0) waiting.splice(index, 1)
  if (live.delete(client)) pump()
}
</script>

<script setup lang="ts">
// One furniture model with a variant's colours, on a soft floor, turning slowly. Large previews can
// be dragged. When WebGL or the model is not available it says so in words instead.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import { app } from '../../state/app.ts'
import { createFurniture, isFurniture } from '../../world/interior.ts'

const props = withDefaults(defineProps<{
  model: string
  /** Furniture material name → #rrggbb, as a variant carries them. */
  tints?: Record<string, string>
  /** What the picture shows, for people who cannot see it. */
  label: string
  /** Emoji for the placeholder shown before, or instead of, the 3D view. */
  icon?: string
  /** Large and draggable, with priority in the shared live budget. */
  large?: boolean
}>(), { tints: () => ({}), icon: '🛋', large: false })

interface Rig {
  canvas: HTMLCanvasElement
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  key: THREE.DirectionalLight
  floor: THREE.Mesh<THREE.CircleGeometry, THREE.MeshStandardMaterial>
  floorTexture: THREE.CanvasTexture
  pivot: THREE.Group
  piece: THREE.Object3D | null
  radius: number
  height: number
  flat: boolean
  sizer: ResizeObserver
  raf: number
  resume: ReturnType<typeof setTimeout> | null
  wake(): void
  onLost(): void
}

const host = ref<HTMLElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const phase = ref<'idle' | 'loading' | 'live' | 'failed'>('idle')
const still = ref('')
const failure = ref('')

let rig: Rig | null = null
let watcher: IntersectionObserver | null = null
let generation = 0
let visible = false
let hovered = false
let angle = -0.62
let dirty = false
let odd = false
let lastTime = 0
let lastTurn = -Infinity
let retint = 0
let motionQuery: MediaQueryList | null = null
let dragging: { pointerId: number; x: number } | null = null

const tone = computed(() => Object.values(props.tints)[0] ?? '#d9cbb3')
const tintKey = computed(() => JSON.stringify(props.tints))
const alt = computed(() => {
  if (phase.value === 'failed') return `${props.label}. The 3D view is not available.`
  return props.large ? `${props.label}. 3D view. Drag, or use the turn buttons, to see it from another side.` : props.label
})

const client: PoolClient = {
  priority: props.large,
  startedAt: 0,
  eligible: () => visible && !document.hidden && phase.value !== 'failed',
  start,
  stop: () => stop(),
  hasStill: () => still.value !== '',
  busy: () => hovered || dragging !== null,
}

// ── Scene ──

/** A disc that fades out at its edge, so the piece stands on light rather than on a plate. */
function softFloor(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 128
  const paint = canvas.getContext('2d')
  if (paint) {
    const fade = paint.createRadialGradient(64, 64, 0, 64, 64, 64)
    fade.addColorStop(0, 'rgba(255,255,255,0.95)')
    fade.addColorStop(0.55, 'rgba(255,255,255,0.8)')
    fade.addColorStop(1, 'rgba(255,255,255,0)')
    paint.fillStyle = fade
    paint.fillRect(0, 0, 128, 128)
  }
  const texture = new THREE.CanvasTexture(canvas)
  texture.colorSpace = THREE.SRGBColorSpace
  return texture
}

function createRig(mount: HTMLElement): Rig {
  const canvas = document.createElement('canvas')
  canvas.style.cssText = 'display:block;width:100%;height:100%'
  canvas.setAttribute('aria-hidden', 'true')
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  renderer.outputColorSpace = THREE.SRGBColorSpace
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  // A product shot: a little brighter than a room, so dark finishes still read as their colour.
  renderer.toneMappingExposure = 1.28
  renderer.shadowMap.enabled = true

  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 60)
  const key = new THREE.DirectionalLight('#fff4e0', 2.4)
  key.castShadow = true
  key.shadow.mapSize.set(props.large ? 1024 : 512, props.large ? 1024 : 512)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.02
  key.shadow.radius = 4
  const floorTexture = softFloor()
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 48), new THREE.MeshStandardMaterial({ color: '#fff8ea', map: floorTexture, transparent: true, roughness: 1, depthWrite: false }))
  floor.rotation.x = -Math.PI / 2
  floor.receiveShadow = true
  const pivot = new THREE.Group()
  // A soft light from the viewer's side lifts the faces the key light leaves in shade.
  const fill = new THREE.DirectionalLight('#eef3ff', 0.9)
  fill.position.set(-1.2, 0.9, 2.4)
  scene.add(key, key.target, fill, new THREE.HemisphereLight('#dcecff', '#e8cfa8', 1.35), floor, pivot)

  const made: Rig = {
    canvas, renderer, scene, camera, key, floor, floorTexture, pivot, piece: null, radius: 1, height: 1, flat: false, raf: 0, resume: null, wake: () => {},
    sizer: new ResizeObserver(() => fit(made)),
    onLost: () => fail('The 3D view stopped.'),
  }
  canvas.addEventListener('webglcontextlost', made.onLost)
  mount.appendChild(canvas)
  made.sizer.observe(mount)
  fit(made)
  return made
}

function fit(target: Rig): void {
  const box = target.canvas.parentElement
  const width = box?.clientWidth || 1, height = box?.clientHeight || 1
  target.renderer.setSize(width, height, false)
  target.camera.aspect = width / height
  if (!target.piece) { target.camera.updateProjectionMatrix(); return }
  frame(target)
  // Resizing clears the canvas, so draw straight away rather than leave an empty frame.
  if (client.eligible()) draw(target)
}

/** Pulls the camera back until the whole piece fits, whatever its size or the canvas shape. */
function frame(target: Rig): void {
  const { camera, key, radius, height, flat } = target
  const vertical = THREE.MathUtils.degToRad(camera.fov) / 2
  const horizontal = Math.atan(Math.tan(vertical) * camera.aspect)
  const distance = (radius / Math.sin(Math.min(vertical, horizontal))) * 1.06
  // Rugs and other flat pieces are looked at from higher up, or they would be a thin line.
  const elevation = THREE.MathUtils.degToRad(flat ? 40 : 20)
  const lookAt = height * 0.46
  camera.position.set(0, lookAt + Math.sin(elevation) * distance, Math.cos(elevation) * distance)
  camera.lookAt(0, lookAt, 0)
  camera.near = Math.max(distance - radius * 2.5, 0.05)
  camera.far = distance + radius * 6
  camera.updateProjectionMatrix()
  key.position.set(radius * 1.5, radius * 3.2 + height, radius * 2.1)
  key.target.position.set(0, height * 0.4, 0)
  const reach = radius * 2.2
  Object.assign(key.shadow.camera, { left: -reach, right: reach, top: reach, bottom: -reach, near: 0.05, far: radius * 9 + height })
  key.shadow.camera.updateProjectionMatrix()
}

function draw(target: Rig): void {
  target.pivot.rotation.y = angle
  target.renderer.render(target.scene, target.camera)
}

/** Keeps the frame just drawn, to show while this preview is not live. */
function capture(target: Rig): void {
  if (target.canvas.width < 16) return
  try { still.value = target.canvas.toDataURL('image/webp', 0.86) } catch { /* the placeholder stays */ }
}

const texturesOf = (material: THREE.Material): [string, THREE.Texture][] =>
  Object.entries(material).filter((entry): entry is [string, THREE.Texture] => entry[1] instanceof THREE.Texture)

/** A material of this preview's own, with its own handles on the (shared) images. */
function ownMaterial(shared: THREE.Material): THREE.Material {
  const copy = shared.clone()
  for (const [key, texture] of texturesOf(copy)) (copy as unknown as Record<string, THREE.Texture>)[key] = texture.clone()
  return copy
}

/**
 * The furniture cache is shared with the rooms in the world. This preview draws through its own
 * geometry shells (same vertex data, no copy), materials and texture handles (same images), so that
 * letting go of them frees this renderer's GPU memory and listeners without touching what the world
 * is drawing.
 */
function own(source: THREE.Object3D): THREE.Object3D {
  const piece = source.parent ? source.clone(true) : source
  piece.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    const shared = mesh.geometry
    const shell = new THREE.BufferGeometry()
    shell.setIndex(shared.index)
    for (const [name, attribute] of Object.entries(shared.attributes)) shell.setAttribute(name, attribute)
    for (const group of shared.groups) shell.addGroup(group.start, group.count, group.materialIndex)
    shell.morphAttributes = shared.morphAttributes
    shell.morphTargetsRelative = shared.morphTargetsRelative
    shell.setDrawRange(shared.drawRange.start, shared.drawRange.count)
    mesh.geometry = shell
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(ownMaterial) : ownMaterial(mesh.material)
    mesh.castShadow = true
    mesh.receiveShadow = true
  })
  return piece
}

function discard(piece: THREE.Object3D): void {
  piece.removeFromParent()
  piece.traverse(child => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh) return
    mesh.geometry.dispose()
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      for (const [, texture] of texturesOf(material)) texture.dispose()
      material.dispose()
    }
  })
}

function setPiece(target: Rig, piece: THREE.Object3D): void {
  if (target.piece) discard(target.piece)
  // Stand the piece on the floor, centred on the turntable.
  const holder = new THREE.Group()
  holder.add(piece)
  const box = new THREE.Box3().setFromObject(holder)
  const centre = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3())
  piece.position.x -= centre.x
  piece.position.z -= centre.z
  piece.position.y -= box.min.y
  target.pivot.add(holder)
  target.piece = holder
  target.radius = Math.max(size.length() / 2, 0.12)
  target.height = size.y
  target.flat = size.y < 0.25 * Math.max(size.x, size.z)
  target.floor.scale.setScalar(Math.max(Math.hypot(size.x, size.z) * 0.95, 0.3))
  frame(target)
}

function destroyRig(): void {
  const target = rig
  if (!target) return
  rig = null
  cancelAnimationFrame(target.raf)
  if (target.resume !== null) clearTimeout(target.resume)
  target.sizer.disconnect()
  target.canvas.removeEventListener('webglcontextlost', target.onLost)
  if (target.piece) discard(target.piece)
  target.floor.geometry.dispose()
  target.floor.material.dispose()
  target.floorTexture.dispose()
  target.key.dispose()
  target.renderer.dispose()
  target.renderer.forceContextLoss()
  target.canvas.remove()
}

// ── Life cycle: the pool calls start and stop ──

async function load(target: Rig, mine: number): Promise<void> {
  try {
    const piece = await createFurniture({ model: props.model, tints: { ...props.tints } })
    if (mine !== generation || rig !== target) return
    setPiece(target, own(piece))
    phase.value = 'live'
    draw(target)
    capture(target)
    target.wake()
    // Someone who has not drawn yet may be waiting for this turn.
    balance()
  } catch {
    if (mine === generation) fail('The 3D model did not load.')
  }
}

function start(): void {
  const mount = stage.value
  if (!mount || rig || !client.eligible()) return
  const mine = ++generation
  phase.value = 'loading'
  let made: Rig
  try { made = createRig(mount) } catch { fail('This device could not start the 3D view.'); return }
  rig = made
  lastTime = performance.now()
  const tick = (time: number): void => {
    made.raf = 0
    if (rig !== made || !client.eligible() || !made.piece) return
    const delta = Math.min((time - lastTime) / 1000, 0.1)
    lastTime = time
    if (!dragging && !calm() && time - lastTurn >= 2500) { angle += delta * 0.32; dirty = true }
    odd = !odd
    if (dirty && (props.large || !odd || calm())) { dirty = false; draw(made) }
    made.wake()
  }
  made.wake = (): void => {
    if (rig !== made || !client.eligible() || !made.piece || made.raf) return
    if (made.resume !== null) { clearTimeout(made.resume); made.resume = null }
    if (dirty || (!dragging && !calm() && performance.now() - lastTurn >= 2500)) {
      made.raf = requestAnimationFrame(tick)
    } else if (!dragging && !calm()) {
      made.resume = setTimeout(() => { made.resume = null; lastTime = performance.now(); made.wake() }, Math.max(0, 2500 - (performance.now() - lastTurn)))
    }
  }
  void load(made, mine)
}

/** `keep` holds on to the last frame, so the piece is still shown while this preview waits for its next turn. */
function stop(keep = true): void {
  generation++
  cancelAnimationFrame(retint)
  retint = 0
  if (keep && rig?.piece && phase.value === 'live' && !document.hidden) { draw(rig); capture(rig) }
  destroyRig()
  dragging = null
  if (phase.value !== 'failed') phase.value = 'idle'
}

function fail(message: string): void {
  generation++
  destroyRig()
  phase.value = 'failed'
  failure.value = message
  release(client)
}

function ask(urgent = false): void {
  if (!client.eligible()) return
  request(client, urgent)
}

function retry(): void {
  failure.value = ''
  phase.value = 'idle'
  ask()
}

function check(): boolean {
  if (isFurniture(props.model)) return true
  phase.value = 'failed'
  failure.value = 'This piece has no 3D model in this world.'
  return false
}

function calm(): boolean { return Boolean(app.me?.preferences.reducedMotion) || Boolean(motionQuery?.matches) }
function motionChanged(): void {
  if (!rig) return
  cancelAnimationFrame(rig.raf); rig.raf = 0
  if (rig.resume !== null) { clearTimeout(rig.resume); rig.resume = null }
  rig.wake()
}
function visibilityChanged(): void {
  if (client.eligible()) ask()
  else { release(client); stop() }
}

onMounted(() => {
  check()
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  motionQuery.addEventListener('change', motionChanged)
  document.addEventListener('visibilitychange', visibilityChanged)
  if (typeof IntersectionObserver === 'undefined') { visible = true; ask(); return }
  watcher = new IntersectionObserver(entries => {
    const entry = entries.at(-1)
    if (!entry) return
    visible = entry.isIntersecting && entry.intersectionRatio > 0
    visibilityChanged()
  })
  if (host.value) watcher.observe(host.value)
})

watch(() => app.me?.preferences.reducedMotion, motionChanged)

onBeforeUnmount(() => {
  watcher?.disconnect()
  document.removeEventListener('visibilitychange', visibilityChanged)
  motionQuery?.removeEventListener('change', motionChanged)
  cancelAnimationFrame(retint)
  visible = false
  release(client)
  stop(false)
})

watch(() => props.model, () => {
  release(client)
  stop(false)
  still.value = ''
  failure.value = ''
  phase.value = 'idle'
  if (check()) ask()
})

// A colour input fires many times a second while it is dragged: recolour at most once per frame.
watch(tintKey, () => {
  if (!rig) { still.value = ''; ask(); return }
  cancelAnimationFrame(retint)
  retint = requestAnimationFrame(() => { if (rig) void load(rig, ++generation) })
})

// ── Turning by hand (large previews) ──

function down(event: PointerEvent): void {
  if (!props.large || !rig?.piece || dragging) return
  dragging = { pointerId: event.pointerId, x: event.clientX }
  if (event.currentTarget instanceof HTMLElement) event.currentTarget.setPointerCapture(event.pointerId)
}
function move(event: PointerEvent): void {
  if (dragging?.pointerId !== event.pointerId) return
  angle += (event.clientX - dragging.x) * 0.012
  dragging.x = event.clientX
  lastTurn = performance.now()
  dirty = true
  rig?.wake()
}
function up(event: PointerEvent): void {
  if (dragging?.pointerId !== event.pointerId) return
  dragging = null
  lastTurn = performance.now()
  rig?.wake()
}
function turn(direction: -1 | 1): void {
  angle += direction * (Math.PI / 6)
  lastTurn = performance.now()
  dirty = true
  rig?.wake()
}
function enter(): void { hovered = true; if (!props.large && phase.value === 'idle') ask(true) }
function leave(): void { hovered = false }
</script>

<template>
  <div ref="host" class="preview" :class="{ large, live: phase === 'live' }" :style="{ '--tone': tone }" @pointerenter="enter" @pointerleave="leave">
    <div
      ref="stage" class="stage" role="img" :aria-label="alt"
      @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up"
    ></div>
    <template v-if="phase !== 'live'">
      <img v-if="still" class="still" :src="still" alt="" />
      <div v-else-if="!(large && phase === 'loading')" class="placeholder" aria-hidden="true">
        <span class="emoji">{{ icon }}</span>
        <span v-if="phase === 'failed'" class="tiny">No 3D view</span>
      </div>
    </template>
    <div v-if="large && phase === 'loading' && !still" class="waiting" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading the 3D view</span></div>
    <div v-if="large && phase === 'failed'" class="fallback" role="status">
      <span class="grow small">{{ failure }} The details below still describe it.</span>
      <button class="btn sm" type="button" @click="retry">Try again</button>
    </div>
    <div v-if="large && phase === 'live'" class="turn">
      <button type="button" aria-label="Turn left" title="Turn left" @click="turn(-1)">↶</button>
      <button type="button" aria-label="Turn right" title="Turn right" @click="turn(1)">↷</button>
    </div>
  </div>
</template>

<style scoped>
.preview {
  position: relative; width: 100%; aspect-ratio: 4 / 3; border-radius: 12px; overflow: hidden; container-type: inline-size;
  background:
    radial-gradient(90% 70% at 50% 100%, color-mix(in srgb, var(--tone) 22%, #f1e7d6), transparent 70%),
    linear-gradient(180deg, color-mix(in srgb, var(--tone) 9%, #fffaf1), color-mix(in srgb, var(--tone) 16%, #f3eadb));
}
.preview.large { aspect-ratio: auto; height: 100%; min-height: 220px; border-radius: 18px; }
.stage { position: absolute; inset: 0; }
.large .stage { touch-action: pan-y; cursor: grab; }
.large .stage:active { cursor: grabbing; }
.still { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; pointer-events: none; }
.placeholder { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; pointer-events: none; color: var(--ink-2); }
.emoji { font-size: clamp(1.2rem, 24cqw, 3rem); line-height: 1.1; filter: saturate(0.9); }
.waiting { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.spinner { width: 28px; height: 28px; border-radius: 50%; border: 3px solid rgba(28, 26, 36, 0.14); border-top-color: var(--accent-strong); animation: turn 0.8s linear infinite; }
@keyframes turn { to { transform: rotate(360deg); } }
.fallback { position: absolute; inset: auto 10px 10px; display: flex; align-items: center; gap: 10px; padding: 9px 11px; border-radius: 12px; background: rgba(255, 253, 249, 0.92); border: 1px solid var(--line); color: var(--ink-2); }
.turn { position: absolute; right: 10px; bottom: 10px; display: flex; gap: 2px; padding: 3px; border-radius: 12px; background: rgba(255, 253, 249, 0.86); border: 1px solid var(--line); box-shadow: var(--shadow); }
.turn button { width: 40px; height: 40px; border: 0; border-radius: 9px; background: transparent; font-size: 1.3rem; font-weight: 700; line-height: 1; color: var(--ink); }
.turn button:hover { background: rgba(28, 26, 36, 0.07); color: var(--ink); }
</style>
