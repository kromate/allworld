<script setup lang="ts">
// Make a photo face: take a picture or upload one, check the result on the avatar, then keep it.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { AvatarBody, FaceAudience, FaceScan } from '../../shared/model.ts'
import { FaceScanError, analyseProfileFace, cameraAllowed, captureGuidance, loadImageFile, scanFace } from './faceScan.ts'
import type { FaceScanResult, FaceCaptureResult, ScanPhase } from './faceScan.ts'
import AvatarPreview from './AvatarPreview.vue'
import AppearanceControls from './AppearanceControls.vue'
import SkinTonePicker from './SkinTonePicker.vue'
import { parseAvatarAppearance } from '../../shared/appearance.ts'
import type { AvatarLook as LookWithAppearance } from '../../shared/model.ts'
import type { AvatarAppearance } from '../../shared/appearance.ts'
import { outfit } from '../../world/wardrobe.ts'

const props = withDefaults(defineProps<{ look: LookWithAppearance; audience: FaceAudience; saving: boolean; allowPhotoFace?: boolean; matchActionLabel?: string }>(), { allowPhotoFace: true, matchActionLabel: 'Use matched character' })
const emit = defineEmits<{ keep: [result: FaceCaptureResult, audience: FaceAudience, matchSkin: boolean]; cancel: [] }>()

const stage = ref<'body' | 'choose' | 'opening' | 'camera' | 'working' | 'review'>('body')
const problem = ref('')
const result = ref<FaceScanResult | null>(null)
const views = ref<{ left?: string; right?: string }>({})
const profileBusy = ref<'left' | 'right' | null>(null)
const profileIssue = ref('')
/** What the scan in progress last said it was doing. Reset whenever a scan starts or is dropped, and only ever set by the scan that is still current. */
const phase = ref<ScanPhase | null>(null)
/** Which side photo the working step is reading; null for the front photo. */
const workingSide = ref<'left' | 'right' | null>(null)
const appearance = ref<AvatarAppearance>(parseAvatarAppearance(props.look.appearance))
const audience = ref<FaceAudience>(props.audience)
const matchSkin = ref(true)
const selectedSkin = ref(props.look.skin ?? '#825c43')
const chosenBody = ref<AvatarBody>(props.look.body)
const photoFace = ref(false)
const preview = ref<InstanceType<typeof AvatarPreview> | null>(null)
const shot = ref<HTMLElement | null>(null)
/** What the preview last said about the whole character it draws. A photo face is kept only from 'ready'. */
const previewState = ref<'loading' | 'ready' | 'failed' | 'unavailable'>('loading')
const view = ref<'body' | 'face'>('face')
function chooseBody(body: AvatarBody): void { chosenBody.value = body; stage.value = 'choose' }
const video = ref<HTMLVideoElement | null>(null)
const problemElement = ref<HTMLElement | null>(null)
const profileIssueElement = ref<HTMLElement | null>(null)
const canUseCamera = cameraAllowed()
const cameraSide = ref<'front' | 'left' | 'right'>('front')
const guidance = ref('Keep your whole face in the oval.')
let guidanceTimer: ReturnType<typeof setTimeout> | null = null
let stream: MediaStream | null = null
let alive = true
let cameraRequest = 0
let analysisRequest = 0
let profileRequest = 0

// Said as it is: the tools may come from the cache or the network, so no size, percentage or time is claimed.
const TOOLS_HINT = 'First use may download them. Your photo stays on this device.'
const phaseText = computed(() => phase.value === 'tools' ? `Preparing face tools… ${TOOLS_HINT}`
  : phase.value === 'face' ? 'Reading your face on this device…'
    : phase.value === 'hair' ? 'Reading your hair on this device…' : 'Reading your picture on this device…')

async function showProblem(message: string): Promise<void> {
  problem.value = message
  await nextTick()
  problemElement.value?.focus()
}

function stopCamera(): void {
  cameraRequest++
  if (guidanceTimer) clearTimeout(guidanceTimer)
  guidanceTimer = null
  if (video.value) video.value.srcObject = null
  stream?.getTracks().forEach(track => track.stop())
  stream = null
}
onBeforeUnmount(() => { alive = false; analysisRequest++; profileRequest++; stopCamera() })

async function showCamera(): Promise<void> {
  stage.value = 'camera'
  await nextTick()
  if (!alive || !stream || !video.value) return
  video.value.srcObject = stream
  await video.value.play()
  const request = cameraRequest
  const guide = async (): Promise<void> => {
    if (!alive || request !== cameraRequest || stage.value !== 'camera' || !video.value) return
    const message = await captureGuidance(video.value, cameraSide.value)
    if (!alive || request !== cameraRequest || stage.value !== 'camera') return
    guidance.value = message
    guidanceTimer = setTimeout(() => { void guide() }, 900)
  }
  void guide()
}

async function startCamera(side: 'front' | 'left' | 'right' = 'front'): Promise<void> {
  cameraSide.value = side
  guidance.value = side === 'front' ? 'Look straight at the camera.' : `Turn your face slightly to your ${side}.`
  problem.value = ''
  stage.value = 'opening'
  const request = ++cameraRequest
  try {
    const opened = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 960 } }, audio: false })
    if (!alive || request !== cameraRequest) { opened.getTracks().forEach(track => track.stop()); return }
    stream = opened
    await showCamera()
  } catch (error) {
    if (!alive || request !== cameraRequest) return
    stopCamera()
    const name = error instanceof DOMException ? error.name : ''
    stage.value = 'choose'
    await showProblem(name === 'NotAllowedError' ? 'Camera permission was not given. You can upload a picture instead.'
      : name === 'NotFoundError' ? 'No camera was found on this device. You can upload a picture instead.'
        : 'The camera could not start. You can upload a picture instead.')
  }
}

async function analyse(source: HTMLImageElement | HTMLVideoElement): Promise<void> {
  const request = ++analysisRequest
  stage.value = 'working'
  workingSide.value = null
  phase.value = null
  problem.value = ''
  try {
    const found = await scanFace(source, chosenBody.value, step => { if (alive && request === analysisRequest) phase.value = step })
    if (!alive || request !== analysisRequest) return
    result.value = found
    selectedSkin.value = found.skin
    photoFace.value = false
    appearance.value = parseAvatarAppearance({ ...props.look.appearance, hairColour: found.hair, ...found.appearance })
    stage.value = 'review'
  } catch (error) {
    if (!alive || request !== analysisRequest) return
    const message = error instanceof FaceScanError ? error.message : 'That picture could not be used. Try another one.'
    if (stream) {
      try { await showCamera() }
      catch { stopCamera(); stage.value = 'choose'; await showProblem('The camera stopped. Open it again or upload another photo.'); return }
    } else stage.value = 'choose'
    await showProblem(message)
  }
  if (stage.value === 'review') stopCamera()
}

async function takePicture(): Promise<void> {
  if (!video.value) return
  video.value.pause()
  if (cameraSide.value === 'front') { await analyse(video.value); return }
  const side = cameraSide.value
  const request = ++profileRequest
  stage.value = 'working'
  workingSide.value = side
  phase.value = null
  try {
    const mesh = await analyseProfileFace(video.value, side, step => { if (alive && request === profileRequest) phase.value = step })
    if (!alive || request !== profileRequest) return
    views.value = { ...views.value, [side]: mesh }
    stopCamera()
    stage.value = 'review'
  } catch (error) {
    if (!alive || request !== profileRequest) return
    await showCamera()
    await showProblem(error instanceof FaceScanError ? error.message : 'That angle could not be read. Try again.')
  }
}

async function pickFile(event: Event): Promise<void> {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  const request = ++analysisRequest
  stage.value = 'working'
  workingSide.value = null
  phase.value = null
  problem.value = ''
  let image: HTMLImageElement | null = null
  try {
    image = await loadImageFile(file)
    if (!alive || request !== analysisRequest) return
    await analyse(image)
  } catch (error) {
    if (!alive || request !== analysisRequest) return
    stage.value = 'choose'
    await showProblem(error instanceof Error ? error.message : 'That picture could not be opened.')
  } finally { image?.removeAttribute('src') }
}

function retake(): void {
  analysisRequest++
  profileRequest++
  stopCamera()
  result.value = null
  views.value = {}
  photoFace.value = false
  profileBusy.value = null
  profileIssue.value = ''
  phase.value = null
  workingSide.value = null
  stage.value = 'choose'
}
function cancel(): void { analysisRequest++; profileRequest++; phase.value = null; stopCamera(); emit('cancel') }

async function pickProfile(event: Event, side: 'left' | 'right'): Promise<void> {
  const input = event.target
  if (!(input instanceof HTMLInputElement)) return
  const file = input.files?.[0]
  input.value = ''
  if (!file || profileBusy.value) return
  const request = ++profileRequest
  profileBusy.value = side
  profileIssue.value = ''
  phase.value = null
  let image: HTMLImageElement | null = null
  try {
    image = await loadImageFile(file)
    const mesh = await analyseProfileFace(image, side, step => { if (alive && request === profileRequest) phase.value = step })
    if (!alive || request !== profileRequest) return
    views.value = { ...views.value, [side]: mesh }
  } catch (error) {
    if (!alive || request !== profileRequest) return
    profileIssue.value = error instanceof FaceScanError ? error.message : 'That side photo could not be read. Try one with your face turned slightly.'
    await nextTick()
    profileIssueElement.value?.focus()
  } finally {
    image?.removeAttribute('src')
    if (alive && request === profileRequest) profileBusy.value = null
  }
}
// `photoFace` is the wish to see the photo on the character. Whether it may be kept is `allowPhotoFace`: a guest can look, never keep.
const photoChosen = computed(() => photoFace.value && result.value?.photoQuality?.eligible === true)
const guestPreview = computed(() => photoChosen.value && !props.allowPhotoFace)
// A guest who comes to hold a permission (or an account that loses it) starts again from the matched character, never from a photo they did not choose to keep.
watch(() => props.allowPhotoFace, () => { photoFace.value = false })
function backToMatched(): void {
  photoFace.value = false
  // The button goes with the photo, so the preview it was about takes the focus.
  shot.value?.focus()
}
// One object per choice: a new one on every render would make the preview start following its character again.
const previewScan = computed<FaceScan | null>(() => photoChosen.value && result.value ? { ...result.value.scan, views: views.value } : null)
const previewBody = computed(() => chosenBody.value)
const renderedAppearance = computed<AvatarAppearance>(() => {
  const chosen = appearance.value, suggested = result.value?.appearance
  if (!photoChosen.value || !suggested) return chosen
  // The photo fitter already carries the measured shape. Only the member's
  // edits are applied on top, rather than applying the automatic fit twice.
  return parseAvatarAppearance({ ...chosen, faceWidth: chosen.faceWidth / suggested.faceWidth, jaw: chosen.jaw / suggested.jaw, chin: chosen.chin / suggested.chin })
})
const previewLook = computed<LookWithAppearance>(() => {
  const selected = props.look.outfit ? outfit(props.look.outfit) : null
  return { ...props.look, body: previewBody.value, outfit: selected?.fits.includes(previewBody.value) ? selected.id : null, skin: matchSkin.value ? selectedSkin.value : props.look.skin, appearance: renderedAppearance.value, face: null }
})
// The preview is made again each time the review is shown, and reports again from the start.
watch(stage, () => { previewState.value = 'loading' })
function retryPreview(): void {
  preview.value?.retryLook()
  // The button goes while the retry runs, so the picture it was about takes the focus.
  shot.value?.focus()
}
const photoBlocked = computed(() => photoChosen.value && previewState.value !== 'ready')
const shotLabel = computed(() => previewState.value === 'loading' ? photoChosen.value ? 'Preparing photo face…' : 'Preparing character…'
  : previewState.value === 'unavailable' ? 'No preview'
    : photoChosen.value && previewState.value === 'ready' ? guestPreview.value ? 'Photo preview · not saved' : 'Photo face' : 'Matched character')
// The preview shows the reason itself; this says what it means for the choice being made.
const shotNote = computed(() => previewState.value === 'failed'
  ? guestPreview.value ? 'Your photo could not be shown on your character. Try again, or go back to your matched character.'
    : photoChosen.value ? 'Your photo face could not be shown on your character, so it cannot be used yet. Try again, or untick the photo to use your matched character.'
    : 'The preview could not finish drawing your character. Try again, or carry on: your matched character is saved from your choices, not from the preview.'
  : guestPreview.value ? 'The 3D preview could not start on this device, so your photo cannot be previewed here. Go back to your matched character.'
  : photoChosen.value ? 'The 3D preview could not start on this device, so a photo face cannot be checked or used here. Untick the photo to use your matched character.'
    : 'The 3D preview could not start on this device. You can still use your matched character: it is saved from your choices, not from the preview.')
function keep(): void {
  if (!result.value) return
  // A guest's photo is only on screen: nothing is kept until they are back on the matched character they would be using.
  if (guestPreview.value) return
  const choices = { skin: selectedSkin.value, body: previewBody.value, appearance: parseAvatarAppearance(renderedAppearance.value) }
  if (!photoFace.value || !props.allowPhotoFace) { emit('keep', { mode: 'match', ...choices }, audience.value, matchSkin.value); return }
  // A photo face is kept only once the preview has shown it on the whole character.
  if (!result.value.photoQuality?.eligible || previewState.value !== 'ready') return
  emit('keep', { ...result.value, ...choices, mode: 'photo', ...(views.value.left || views.value.right ? { views: views.value } : {}) }, audience.value, matchSkin.value)
}
</script>

<template>
  <Teleport to="body">
  <div class="capture-shade">
  <div class="capture stack" role="dialog" aria-modal="true" aria-label="Match your character" @keydown.esc="cancel">
    <header class="capture-heading"><strong>Match me</strong><button class="btn sm" type="button" aria-label="Close photo capture" :disabled="saving" @click="cancel">✕</button></header>
    <template v-if="stage === 'body'">
      <h2>Choose your character</h2>
      <p class="muted small">Pick the body you want to play as before adding a picture. Your photo will never choose this for you.</p>
      <div class="body-choices">
        <button class="body-choice" type="button" @click="chooseBody('f11')"><img src="/avatars/f11.jpg" alt="Feminine character" /><strong>Feminine body</strong></button>
        <button class="body-choice" type="button" @click="chooseBody('m12')"><img src="/avatars/m12.jpg" alt="Masculine character" /><strong>Masculine body</strong></button>
      </div>
      <button class="btn" type="button" @click="chooseBody(look.body)">Keep my current body</button>
    </template>
    <template v-else-if="stage === 'choose'">
      <div class="notice sky">
        <span aria-hidden="true">🔒</span>
        <div v-if="allowPhotoFace">Your picture is read on this device. Match me saves only editable character choices. A photo face is a separate, optional choice.</div>
        <div v-else>Your picture is read on this device. Match me saves only editable character choices. You can also preview your photo on the character; the preview is temporary.</div>
      </div>
      <p class="muted small capture-guidance">Face the camera in even light, keep a neutral expression, and hold it about an arm’s length away. Keep your whole face visible; remove glasses if you can.</p>
      <div class="options">
        <button v-if="canUseCamera" class="option card interactive" type="button" @click="startCamera('front')">
          <span class="icon-chip sky" aria-hidden="true">📷</span>
          <span class="grow"><strong>Take a photo</strong><span class="muted small">Use this device’s camera</span></span>
        </button>
        <label class="option card interactive">
          <span class="icon-chip grape" aria-hidden="true">🖼</span>
          <span class="grow"><strong>Upload a photo</strong><span class="muted small">Front-facing, even light, whole face visible</span></span>
          <input class="sr-only" type="file" accept="image/*" @change="pickFile" />
        </label>
      </div>
      <p v-if="!canUseCamera" class="muted small">Live camera is not available on this page, so pictures come from your photo library or your phone’s camera app.</p>
      <button class="btn ghost sm back" type="button" @click="stage = 'body'">← Change body choice</button>
    </template>

    <template v-else-if="stage === 'camera'">
      <div class="viewfinder">
        <video ref="video" playsinline muted aria-label="Camera preview"></video>
        <div class="guide" aria-hidden="true"></div>
      </div>
      <strong>{{ cameraSide === 'front' ? '1 · Front view' : cameraSide === 'left' ? '2 · Left view' : '3 · Right view' }}</strong>
      <p class="muted small" role="status" aria-live="polite">{{ guidance }}</p>
      <p class="muted tiny">Keep the same light and a neutral expression. Show both eyes.</p>
      <div class="row">
        <button class="btn primary grow" type="button" @click="takePicture">Take picture</button>
        <button class="btn" type="button" @click="stopCamera(); stage = result ? 'review' : 'choose'">Back</button>
      </div>
    </template>

    <div v-else-if="stage === 'opening'" class="working" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <strong>Opening your camera…</strong>
      <button class="btn sm" type="button" @click="cancel">Cancel</button>
    </div>

    <div v-else-if="stage === 'working'" class="working" role="status">
      <div class="spinner" aria-hidden="true"></div>
      <strong>{{ workingSide ? 'Reading your side view…' : 'Matching your character…' }}</strong>
      <span class="muted small">{{ phaseText }}</span>
      <button class="btn sm" type="button" @click="retake">Cancel this photo</button>
    </div>

    <template v-else-if="result">
      <div class="review">
        <div class="comparison">
          <div class="before"><span class="comparison-label">Original crop</span><img :src="result.scan.texture" alt="Small face crop made from your photo" /></div>
          <div ref="shot" class="shot" role="group" aria-label="Character preview" tabindex="-1"><span id="capture-shot-label" class="comparison-label" role="status">{{ shotLabel }}</span><AvatarPreview ref="preview" :look="previewLook" :appearance="renderedAppearance" :face="previewScan" face-key="capture" :zoom="view" controls @look-status="previewState = $event.state" /></div>
        </div>
        <!-- The whole character changes with the match, so neck, hands and body can be checked before it is used. -->
        <div class="tabs view-tabs" role="group" aria-label="Preview view">
          <button class="tab" type="button" :aria-pressed="view === 'face'" @click="view = 'face'">Face</button>
          <button class="tab" type="button" :aria-pressed="view === 'body'" @click="view = 'body'">Full body</button>
        </div>
        <div class="stack grow">
          <p class="muted small">A starting point from visible features. Colour, shape and hair suggestions can be wrong, especially in dim light. Change anything below. {{ photoFace && allowPhotoFace ? 'The selected photo face will be saved with your chosen audience.' : guestPreview ? 'You are previewing your photo. It is temporary and is not saved or shared.' : 'No photo pixels are on your matched character.' }}</p>
          <section class="stack tight">
            <strong>Confirm your skin tone</strong>
            <p class="muted small">Lighting can change the colour in a photo. Choose the tone that looks like you; it colours your face, ears, neck and body together.</p>
            <SkinTonePicker v-model="selectedSkin" :measured="result.skin" @update:model-value="matchSkin = true" />
            <div class="row between">
              <span><strong class="small">Match skin tone</strong><span class="muted tiny" style="display:block">Use <span class="swatch" :style="{ background: result.skin }"></span> from the picture for the whole body</span></span>
              <button class="switch" type="button" role="switch" :aria-checked="matchSkin" aria-label="Match skin tone to the picture" @click="matchSkin = !matchSkin"></button>
            </div>
          </section>
          <p class="match-summary"><strong>We picked:</strong> {{ appearance.hairStyle === 'auto' ? 'hair uncertain — please choose' : appearance.hairStyle.replaceAll('-', ' ') }} · {{ appearance.beard === 'off' ? 'no added beard' : appearance.beard === 'chin-strap' ? 'chin-strap beard' : 'check beard' }} · {{ appearance.faceWidth > 1.03 ? 'broader face' : appearance.faceWidth < 0.97 ? 'narrower face' : 'medium face width' }}. Build is a rough suggestion; glasses and brows are not detected.</p>
          <div v-if="result.hairSuggestion?.reason === 'uncertain'" class="stack tight">
            <strong>We could not read your hairstyle reliably</strong>
            <p class="muted small">Choose what matches your photo. A crop cannot tell us what is outside the frame.</p>
            <div class="row"><button class="btn" type="button" @click="appearance = { ...appearance, hairStyle: 'twists' }">Short twists</button><button class="btn" type="button" @click="appearance = { ...appearance, hairStyle: 'locs' }">Locs</button></div>
          </div>
          <!-- The suggestion is usable as it stands; every part of it can still be changed here or later in the editor. -->
          <details class="adjust">
            <summary>Adjust shape and hair</summary>
            <AppearanceControls v-model="appearance" />
          </details>
          <section class="photo-extra stack tight">
            <strong>Optional photo face</strong>
            <template v-if="result.photoQuality?.eligible">
              <p v-if="allowPhotoFace" class="muted small">Preview your photo on the character, then check the face and full body. You can adjust the skin tone above.</p>
              <p v-else class="muted small">Try your photo on the character, then check the face and full body. The preview is temporary: it stays on this device and is not saved or shared. Saving a photo face is not available in this session, so your matched character is what is kept.</p>
              <ul v-if="result.photoQuality.reasons.length" class="muted small"><li v-for="reason in result.photoQuality.reasons" :key="reason">{{ reason }}</li></ul>
              <label class="photo-toggle"><input v-model="photoFace" type="checkbox" /> {{ allowPhotoFace ? 'Use my photo on the face' : 'Preview my photo on the face' }}</label>
              <label v-if="photoFace && allowPhotoFace" class="field">
                <span>Who sees your photo face</span>
                <select v-model="audience" class="select">
                  <option value="friends">Friends only — others see the character’s own face</option>
                  <option value="everyone">Everyone in Allworld</option>
                </select>
              </label>
            </template>
            <template v-else>
              <p class="muted small">Your matched character is ready. {{ allowPhotoFace ? 'For a photo face:' : 'To preview your photo on the face:' }}</p>
              <ul class="muted small"><li v-for="reason in result.photoQuality?.reasons" :key="reason">{{ reason }}</li></ul>
            </template>
          </section>
          <div v-if="photoFace && allowPhotoFace" class="profile-photos stack tight">
            <strong>Optional side photos</strong>
            <p class="muted small">After the front photo, turn your face a little to each side. The photos are discarded after their landmarks are read. Only the landmark shapes are saved; side photos are not kept.</p>
            <div v-if="canUseCamera" class="row">
              <button class="btn grow" type="button" :disabled="saving" @click="startCamera('left')">{{ views.left ? 'Retake left view' : 'Take left view' }}</button>
              <button class="btn grow" type="button" :disabled="saving" @click="startCamera('right')">{{ views.right ? 'Retake right view' : 'Take right view' }}</button>
            </div>
            <div class="profile-options">
              <label class="profile-option card interactive" :class="{ disabled: profileBusy || saving }">
                <span><strong>{{ views.left ? 'Replace left view' : 'Add left view' }}</strong><small>Turn your face to your left</small></span>
                <span aria-hidden="true">{{ views.left ? '✓' : '＋' }}</span>
                <input class="sr-only" type="file" accept="image/*" :disabled="Boolean(profileBusy) || saving" aria-label="Upload a photo with your face turned to your left" @change="pickProfile($event, 'left')" />
              </label>
              <label class="profile-option card interactive" :class="{ disabled: profileBusy || saving }">
                <span><strong>{{ views.right ? 'Replace right view' : 'Add right view' }}</strong><small>Turn your face to your right</small></span>
                <span aria-hidden="true">{{ views.right ? '✓' : '＋' }}</span>
                <input class="sr-only" type="file" accept="image/*" :disabled="Boolean(profileBusy) || saving" aria-label="Upload a photo with your face turned to your right" @change="pickProfile($event, 'right')" />
              </label>
            </div>
            <p v-if="profileBusy" class="muted small" role="status">{{ phase === 'tools' ? `Preparing face tools… ${TOOLS_HINT}` : `Reading ${profileBusy} side landmarks on this device…` }}</p>
            <p v-if="profileIssue" ref="profileIssueElement" class="notice coral" role="alert" tabindex="-1">{{ profileIssue }}</p>
          </div>
        </div>
      </div>
      <div v-if="previewState === 'failed' || previewState === 'unavailable'" id="capture-shot-note" class="notice shot-note" :class="previewState === 'failed' ? 'coral' : 'amber'" role="status">
        <span>{{ shotNote }}</span>
        <button v-if="previewState === 'failed'" class="btn sm" type="button" :disabled="saving" @click="retryPreview">Try again</button>
      </div>
      <div class="row">
        <button v-if="guestPreview" class="btn primary grow wrap-label" type="button" @click="backToMatched">Back to matched character</button>
        <button v-else class="btn primary grow" type="button" :disabled="saving || Boolean(profileBusy) || photoBlocked" :aria-describedby="photoBlocked ? previewState === 'loading' ? 'capture-shot-label' : 'capture-shot-note' : undefined" @click="keep">{{ saving ? 'Saving…' : photoFace && allowPhotoFace ? 'Use photo face' : matchActionLabel }}</button>
        <button class="btn" type="button" :disabled="saving || Boolean(profileBusy)" @click="retake">Try another</button>
      </div>
    </template>

    <p v-if="problem" ref="problemElement" class="notice coral" role="alert" tabindex="-1">{{ problem }}</p>
  </div>
  </div>
  </Teleport>
</template>

<style scoped>
.body-choices { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.body-choice { display:grid; gap:8px; padding:12px; border:1px solid var(--line); border-radius:12px; background:var(--surface); color:var(--ink); cursor:pointer; }
.body-choice img { width:100%; height:160px; object-fit:contain; }
.photo-toggle { display:flex; align-items:center; gap:10px; min-height:44px; }
.photo-extra { padding-top:14px; border-top:1px solid var(--line); }
.match-summary { font-size:.85rem; line-height:1.6; }
.capture-shade { position:fixed; inset:0; z-index:1000; display:grid; place-items:center; padding:24px; background:rgba(18,16,24,.64); }
.capture { width:min(920px,100%); max-height:calc(100dvh - 48px); overflow:auto; overscroll-behavior:contain; padding:20px; background:var(--surface,#fffaf2); color:var(--ink,#201d29); border-radius:22px; box-shadow:0 18px 80px #0005; }
/* The heading stays in view while the review scrolls, so the one way out (✕) is always reachable. */
.capture-heading { position:sticky; top:0; z-index:6; display:flex; align-items:center; justify-content:space-between; gap:12px; margin:-20px -20px 0; padding:12px 20px; background:var(--surface,#fffaf2); border-bottom:1px solid var(--line); border-radius:22px 22px 0 0; }
.capture-heading strong { font-size:1.1rem; }
.back { align-self:flex-start; }
.adjust { border-top:1px solid var(--line); }
.adjust summary { min-height:44px; display:flex; align-items:center; justify-content:space-between; gap:8px; cursor:pointer; font-weight:650; list-style:none; }
.adjust summary::-webkit-details-marker { display:none; }
.adjust summary::after { content:"▾"; color:var(--muted); }
.adjust[open] > summary::after { transform:rotate(180deg); }
@media(max-width:520px) { .capture-shade { padding:0; } .capture { width:100%; height:100dvh; max-height:100dvh; border-radius:0; padding:16px; } .capture-heading { margin:-16px -16px 0; padding:10px 16px; border-radius:0; } }

.options { display: grid; gap: 10px; }
.option { display: flex; align-items: center; gap: 12px; cursor: pointer; }
.option .grow { display: flex; flex-direction: column; }
.viewfinder { position: relative; border-radius: 18px; overflow: hidden; background: #111; aspect-ratio: 4 / 3; }
.viewfinder video { width: 100%; height: 100%; object-fit: cover; transform: scaleX(-1); display: block; }
.guide { position: absolute; left: 50%; top: 50%; width: 42%; aspect-ratio: 3 / 4; transform: translate(-50%, -52%); border: 3px dashed rgba(255, 255, 255, 0.85); border-radius: 50%; box-shadow: 0 0 0 999px rgba(0, 0, 0, 0.28); }
.working { display: grid; justify-items: center; gap: 6px; padding: 28px 12px; text-align: center; }
.spinner { width: 34px; height: 34px; border-radius: 50%; border: 4px solid var(--accent-soft); border-top-color: var(--accent-strong); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.review { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
.shot { width: 100%; height: 320px; min-width: 0; }
.comparison { display: grid; grid-template-columns: minmax(100px, 0.8fr) minmax(0, 1.2fr); gap: 10px; }
.before, .shot { position: relative; overflow: hidden; border-radius: 14px; background: var(--surface-3); }
.before img { width: 100%; height: 100%; display: block; object-fit: contain; }
.comparison.three .before { aspect-ratio: 1; }
.comparison.three .shot { grid-column: 1 / -1; }
.shot:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.view-tabs .tab { min-height: 44px; }
.view-tabs .tab[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(40, 30, 10, 0.12); }
.shot-note { flex-wrap: wrap; align-items: center; }
.shot-note span { flex: 1 1 200px; }
.shot-note .btn { flex: none; }
.comparison-label { position: absolute; z-index: 1; top: 8px; left: 8px; max-width: calc(100% - 16px); padding: 4px 8px; border-radius: 8px; background: rgba(20, 18, 26, 0.82); color: #fff; font-size: 0.72rem; font-weight: 700; }
.swatch { display: inline-block; width: 12px; height: 12px; border-radius: 4px; vertical-align: -1px; border: 1px solid rgba(0, 0, 0, 0.15); }
.casting { display: flex; flex-wrap: wrap; gap: 6px; }
.casting button { min-height: 44px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); color: var(--ink); font-weight: 650; cursor: pointer; }
.casting button[aria-checked="true"] { border-color: var(--accent-strong); background: var(--accent-soft); }
.casting button:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.profile-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.profile-option { min-height: 64px; display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; }
.profile-option span:first-child { display: grid; gap: 3px; }
.profile-option small { color: var(--ink-2); }
.profile-option.disabled { opacity: 0.55; cursor: default; }
.profile-option:focus-within { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.capture .btn, .capture .select { min-height: 44px; }
/* Beside "Try another" at 360 px the return label is wider than the space left, and buttons do not wrap by default. */
.wrap-label { white-space: normal; line-height: 1.25; padding-block: 8px; }
@media (max-width: 520px) { .comparison { grid-template-columns: 1fr; } .before { height: 140px; } .shot { height: 300px; } .profile-options { grid-template-columns: 1fr; } }
</style>
