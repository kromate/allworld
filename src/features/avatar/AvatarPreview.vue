<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as THREE from 'three'
import type { FaceScan } from '../../shared/model.ts'
import type { FittedSurfaceIdentity } from '../../world/avatarIdentity.ts'
import { AvatarActor } from '../../world/avatars.ts'
import type { AvatarMotion } from '../../world/avatars.ts'
import { FrameGovernor, TIER_PRESETS } from '../../world/governor.ts'
import { parseAvatarAppearance } from '../../shared/appearance.ts'
import type { AvatarLook as LookWithAppearance } from '../../shared/model.ts'
import type { AvatarAppearance } from '../../shared/appearance.ts'

const props = defineProps<{ look: LookWithAppearance; identity?: FittedSurfaceIdentity | null; appearance?: AvatarAppearance; face?: FaceScan | null; faceKey?: string; motion?: AvatarMotion; zoom?: 'body' | 'face'; controls?: boolean }>()
/**
 * One state for the whole character, clothes and picture together. `loading` lasts until both have
 * settled; `failed` carries an error that `retryLook` can try again; `unavailable` is a preview
 * that could not start, with nothing to wait for or retry. `loading` and `error` say the same thing
 * for a listener that only needs those.
 */
type LookState = 'loading' | 'ready' | 'failed' | 'unavailable'
const emit = defineEmits<{ lookStatus: [status: { state: LookState; loading: boolean; error: string | null }] }>()
const canvas = ref<HTMLCanvasElement | null>(null)
const failed = ref('')
const loading = ref(true)
let renderer: THREE.WebGLRenderer | null = null
let actor: AvatarActor | null = null
let observer: ResizeObserver | null = null
let stand: THREE.Mesh<THREE.CylinderGeometry, THREE.MeshStandardMaterial> | null = null
let governor: FrameGovernor | null = null
let shadowLight: THREE.DirectionalLight | null = null
let activeUntil = 0
let spin = props.zoom === 'face' ? 0 : 0.5
let dragging: { pointerId: number; x: number } | null = null
let autoTurn = props.zoom !== 'face' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
let alive = true
let lastBody = props.look.body
let trackRequest = 0
/** The attempt whose outcome was last reported, by the actor's own promises. */
let reported: { look: Promise<void>; face: Promise<void>; error: string | null } | null = null
const zoomLevel = ref(1)
const effectiveLook = (): LookWithAppearance => ({ ...props.look, appearance: parseAvatarAppearance(props.appearance ?? props.look.appearance) })

function frame(camera: THREE.PerspectiveCamera): void {
  const fov = props.zoom === 'face' ? 18 : 32
  if (camera.fov !== fov) { camera.fov = fov; camera.updateProjectionMatrix() }
  const height = actor?.height ?? 1.75
  const narrow = Math.max(1, 0.85 / camera.aspect)
  if (props.zoom === 'face') {
    const eye = height - 0.12
    camera.position.set(0, eye - 0.03, 1.30 * narrow / zoomLevel.value)
    camera.lookAt(0, eye - 0.03, 0)
  } else {
    const middle = height * 0.51
    camera.position.set(0, middle + 0.2, Math.max(3.5, height * 2.3) * narrow / zoomLevel.value)
    camera.lookAt(0, middle, 0)
  }
}

function lookState(state: LookState, error: string | null = null): void { emit('lookStatus', { state, loading: state === 'loading', error }) }
const reason = (error: unknown, fallback: string): string => error instanceof Error && error.message ? error.message : fallback

/**
 * Follow the actor until its look and its picture have both settled, then say what happened.
 * The actor replaces either promise when a newer paint or picture starts, so a settled promise
 * that is no longer the actor's own is waited over again and never reported. A newer call, a
 * newer actor or an unmounted preview makes this one silent. An error reported here is one the
 * actor's `retryLook` can try again; a preview that could not start reports `unavailable` instead.
 */
function track(): void {
  if (!actor || !alive) return
  const current = actor, request = ++trackRequest
  const live = (): boolean => alive && actor === current && request === trackRequest
  // An outcome stands while the actor is still on the attempt that produced it. A newer attempt is loading until it settles.
  if (reported !== null && reported.look === current.lookReady && reported.face === current.faceReady) {
    lookState(reported.error === null ? 'ready' : 'failed', reported.error)
    return
  }
  failed.value = ''
  lookState('loading')
  void (async (): Promise<void> => {
    for (let round = 0; round < 16; round++) {
      const look = current.lookReady, face = current.faceReady
      const lookError = await look.then(() => null, (error: unknown) => current.lookError || reason(error, 'The clothes could not load.'))
      if (!live()) return
      if (current.lookReady !== look) continue
      // The clothes are done or have failed; nothing is reported until the picture has settled too.
      const faceError = await face.then(() => null, (error: unknown) => reason(error, 'The picture could not be shown.'))
      if (!live()) return
      if (current.lookReady !== look || current.faceReady !== face) continue
      loading.value = false
      failed.value = lookError ?? faceError ?? ''
      reported = { look, face, error: lookError ?? faceError }
      lookState(reported.error === null ? 'ready' : 'failed', reported.error)
      return
    }
  })()
}

/** Try the failed clothes or picture again. Nothing is asked of a preview that has gone or never started. */
function retryLook(): void {
  if (!actor || !alive) return
  void actor.retryLook().catch(() => {})
  loading.value = true
  failed.value = ''
  track()
  wake()
}
defineExpose({ retryLook })

function disposePreview(): void {
  if (!alive) return
  alive = false
  governor?.dispose()
  shadowLight?.shadow.dispose()
  observer?.disconnect()
  actor?.dispose()
  stand?.geometry.dispose()
  stand?.material.dispose()
  renderer?.dispose()
}

onMounted(() => {
  const element = canvas.value
  if (!element) return
  try {
    renderer = new THREE.WebGLRenderer({ canvas: element, antialias: true, alpha: true })
    const coarse = window.matchMedia('(pointer: coarse)').matches
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, coarse ? 1.5 : 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.shadowMap.enabled = !coarse
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50)
    const key = new THREE.DirectionalLight('#fff3e0', 2.6)
    shadowLight = key
    key.position.set(3, 6, 5)
    key.castShadow = true
    key.shadow.mapSize.set(1024, 1024)
    scene.add(key, new THREE.HemisphereLight('#dcecff', '#e8c9a0', 1.25))
    stand = new THREE.Mesh(new THREE.CylinderGeometry(0.85, 0.95, 0.12, 48), new THREE.MeshStandardMaterial({ color: '#ffb020', roughness: 0.5 }))
    stand.position.y = -0.06
    stand.receiveShadow = true
    scene.add(stand)
    actor = new AvatarActor(effectiveLook())
    const currentActor = actor
    currentActor.setIdentity(props.identity ?? null)
    currentActor.setMotion(props.motion ?? 'idle')
    if (props.face) currentActor.setFace(props.face, props.faceKey ?? 'preview')
    track()
    scene.add(currentActor.group)
    const resize = (): void => {
      const width = element.clientWidth || 1, height = element.clientHeight || 1
      renderer?.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    }
    observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    governor = new FrameGovernor({
      canvas: element, maxFps: 30,
      active: () => dragging !== null || performance.now() < activeUntil || Boolean(props.motion && props.motion !== 'idle'),
      changed: tier => {
        if (!renderer) return
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, TIER_PRESETS[tier].resolutionCap))
        renderer.shadowMap.enabled = !coarse && TIER_PRESETS[tier].shadows
        resize()
      },
      frame: delta => {
        if (!alive) return
        if (dragging === null && autoTurn && props.zoom !== 'face') spin += delta * 0.25
        currentActor.group.rotation.y = spin
        currentActor.update(delta)
        frame(camera)
        renderer?.render(scene, camera)
      },
    })
    governor.start()
  } catch (error) {
    loading.value = false
    failed.value = error instanceof Error ? error.message : 'The 3D preview could not start.'
    disposePreview()
    // Nothing here can be tried again or waited for, so it is reported as neither an error nor loading.
    lookState('unavailable')
  }
})

watch(() => [props.look, props.appearance] as const, () => {
  if (!actor) return
  const look = effectiveLook()
  if (look.body !== lastBody) { loading.value = true; failed.value = ''; lastBody = look.body }
  actor.setLook(look)
  track()
  wake()
}, { deep: true })
watch(() => [props.face, props.faceKey] as const, ([face, key]) => {
  if (!actor) return
  actor.setFace(face ?? null, face ? key ?? 'preview' : '')
  track()
})
watch(() => props.identity, identity => { actor?.setIdentity(identity ?? null); track(); wake() })
watch(() => props.motion, motion => actor?.setMotion(motion ?? 'idle'))
watch(() => props.zoom, zoom => { if (zoom === 'face') { spin = 0; autoTurn = false } wake() })

onBeforeUnmount(disposePreview)

function wake(): void { activeUntil = performance.now() + 500; governor?.invalidate() }

function down(event: PointerEvent): void {
  if (dragging !== null) return
  dragging = { pointerId: event.pointerId, x: event.clientX }
  wake()
  event.currentTarget instanceof HTMLElement && event.currentTarget.setPointerCapture(event.pointerId)
}
function move(event: PointerEvent): void {
  if (dragging?.pointerId !== event.pointerId) return
  spin += (event.clientX - dragging.x) * 0.012
  dragging.x = event.clientX
  autoTurn = false
  wake()
}
function up(event: PointerEvent): void { if (dragging?.pointerId === event.pointerId) { dragging = null; wake() } }
function turn(direction: -1 | 1): void { spin += direction * Math.PI / 8; autoTurn = false; wake() }
function adjustZoom(direction: -1 | 1): void { zoomLevel.value = Math.min(1.5, Math.max(0.75, +(zoomLevel.value + direction * 0.15).toFixed(2))); wake() }
</script>

<template>
  <div class="preview">
    <canvas ref="canvas" aria-label="3D preview of your avatar. Drag to turn it." @pointerdown="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up"></canvas>
    <div v-if="controls && !failed" class="preview-controls" aria-label="Preview controls">
      <div class="control-pair">
        <button type="button" aria-label="Turn left" title="Turn left" @click="turn(-1)">↶</button>
        <button type="button" aria-label="Turn right" title="Turn right" @click="turn(1)">↷</button>
      </div>
      <div class="control-pair">
        <button type="button" aria-label="Zoom out" title="Zoom out" :disabled="zoomLevel <= 0.75" @click="adjustZoom(-1)">−</button>
        <button type="button" aria-label="Zoom in" title="Zoom in" :disabled="zoomLevel >= 1.5" @click="adjustZoom(1)">+</button>
      </div>
    </div>
    <p v-if="failed" class="notice coral" role="alert">{{ failed }}</p>
    <div v-else-if="loading" class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span class="sr-only">Loading avatar</span></div>
  </div>
</template>

<style scoped>
.preview { position: relative; width: 100%; height: 100%; min-height: 220px; border-radius: 18px; background: radial-gradient(120% 90% at 50% 8%, #3c3852, #272436 60%, #1c1a24); overflow: hidden; }
canvas { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; }
canvas:active { cursor: grabbing; }
.notice { position: absolute; inset: auto 10px 10px; }
.loading { position: absolute; inset: 0; display: grid; place-items: center; pointer-events: none; }
.spinner { width: 30px; height: 30px; border-radius: 50%; border: 4px solid rgba(255, 255, 255, 0.6); border-top-color: var(--accent-strong); animation: spin 0.8s linear infinite; }
.preview-controls { position: absolute; inset: auto 12px 12px; display: flex; justify-content: space-between; gap: 12px; pointer-events: none; }
.control-pair { display: flex; gap: 4px; padding: 4px; border-radius: 12px; background: rgba(19, 17, 26, 0.75); pointer-events: auto; }
.control-pair button { width: 44px; height: 44px; border: 0; border-radius: 9px; background: transparent; color: #fff; font-size: 1.35rem; line-height: 1; cursor: pointer; }
.control-pair button:hover, .control-pair button:focus-visible { background: rgba(255, 255, 255, 0.18); }
.control-pair button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
.control-pair button:disabled { opacity: 0.35; cursor: default; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
