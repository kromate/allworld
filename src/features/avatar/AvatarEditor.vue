<script setup lang="ts">
// Each choice remains the member's; place only changes the order of the catalogue.
import { computed, ref } from 'vue'
import { AVATAR_HEIGHT } from '../../shared/model.ts'
import type { AvatarBody, AvatarLook, FaceAudience, FaceScan } from '../../shared/model.ts'
import { featuredOutfits, suggestedCast } from '../../config/wardrobe.ts'
import { castMember, portraitUrl } from '../../world/avatars.ts'
import type { AvatarMotion } from '../../world/avatars.ts'
import { outfit } from '../../world/wardrobe.ts'
import type { Outfit } from '../../world/wardrobe.ts'
import AvatarPreview from './AvatarPreview.vue'
import AvatarPortrait from './AvatarPortrait.vue'
import AppearanceControls from './AppearanceControls.vue'
import SkinTonePicker from './SkinTonePicker.vue'
import { MONK_TONES } from './skinTones.ts'
import { parseAvatarAppearance } from '../../shared/appearance.ts'
import type { AvatarLook as LookWithAppearance } from '../../shared/model.ts'
import type { AvatarAppearance } from '../../shared/appearance.ts'
import FaceCapture from './FaceCapture.vue'
import type { FaceCaptureResult } from './faceScan.ts'

const props = defineProps<{
  look: LookWithAppearance
  /** The saved photo face, when one exists and has been loaded. */
  face: FaceScan | null
  faceBusy: boolean
  allowPhotoFace?: boolean
  matchActionLabel?: string
  countryCode?: string
  placeLabel?: string
}>()
const emit = defineEmits<{
  'update:look': [look: LookWithAppearance]
  setFace: [result: FaceCaptureResult, audience: FaceAudience, matchSkin: boolean]
  setFaceAudience: [audience: FaceAudience]
  clearFace: []
}>()

const SKIN = MONK_TONES
const HUES = [0, 35, 80, 130, 175, -140, -95, -45]
const MOTIONS: { id: AvatarMotion; label: string }[] = [{ id: 'idle', label: 'Stand' }, { id: 'walk', label: 'Walk' }, { id: 'wave', label: 'Wave' }, { id: 'dance', label: 'Dance' }]

const capturing = ref(false)
const motion = ref<AvatarMotion>('idle')
const view = ref<'body' | 'face'>('body')
const preview = ref<InstanceType<typeof AvatarPreview> | null>(null)
const stageView = ref<HTMLElement | null>(null)
const lookStatus = ref<{ loading: boolean; error: string | null }>({ loading: false, error: null })
/** Open at the start when a colour was already chosen; after that the member opens and closes it. */
const hueOpen = props.look.outfitHue !== 0
const castOrder = computed<AvatarBody[]>(() => suggestedCast(props.countryCode ?? ''))
const catalogue = computed<Outfit[]>(() => featuredOutfits(props.countryCode ?? '', castMember(props.look.body).sex).filter(entry => entry.fits.includes(props.look.body)))
const featured = computed<Outfit[]>(() => catalogue.value.slice(0, 2))
const moreOutfits = computed<Outfit[]>(() => catalogue.value.slice(2))
const featuredLabel = computed<string>(() => props.placeLabel ? `Featured for ${props.placeLabel}` : 'Featured outfits')
const appearance = computed<AvatarAppearance>(() => parseAvatarAppearance(props.look.appearance))

function change(patch: Partial<LookWithAppearance>): void { emit('update:look', { ...props.look, ...patch }) }
function changeAppearance(next: AvatarAppearance): void {
  change({ appearance: parseAvatarAppearance(next) })
}
function selectBody(body: AvatarBody): void {
  const selected = props.look.outfit ? outfit(props.look.outfit) : null
  change({ body, outfit: selected?.fits.includes(body) ? selected.id : null })
}
function surprise(): void {
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!
  const body = pick(castOrder.value)
  const selected = props.look.outfit ? outfit(props.look.outfit) : null
  change({ body, outfit: selected?.fits.includes(body) ? selected.id : null, skin: pick([null, ...SKIN]), outfitHue: pick(HUES), height: +(AVATAR_HEIGHT.min + Math.random() * (AVATAR_HEIGHT.max - AVATAR_HEIGHT.min)).toFixed(2) })
}
function keepFace(result: FaceCaptureResult, audience: FaceAudience, matchSkin: boolean): void {
  const refined = result
  const patch: Partial<LookWithAppearance> = {}
  if (result.body && result.body !== props.look.body) {
    const selected = props.look.outfit ? outfit(props.look.outfit) : null
    patch.body = result.body
    patch.outfit = selected?.fits.includes(result.body) ? selected.id : null
  }
  if (refined.appearance) patch.appearance = parseAvatarAppearance(refined.appearance)
  if (Object.keys(patch).length) change(patch)
  emit('setFace', result, audience, matchSkin)
  capturing.value = false
}
const heightCm = (look: AvatarLook): number => Math.round(castMember(look.body).bounds.max[2] * look.height)
const swatch = (hue: number): string => `hue-rotate(${hue}deg)`
function onLookStatus(status: { loading: boolean; error: string | null }): void { lookStatus.value = status }
function retryCharacter(): void {
  preview.value?.retryLook()
  // The button goes while the retry runs, so the preview it was about takes the focus.
  stageView.value?.focus()
}
</script>

<template>
  <div class="editor">
    <div class="stage">
      <div ref="stageView" class="stage-view" role="group" aria-label="Character preview" tabindex="-1">
        <AvatarPreview ref="preview" :look="look" :appearance="appearance" :face="face" :face-key="`saved-${look.face?.version ?? 0}`" :motion="motion" :zoom="view" controls @look-status="onLookStatus" />
        <p v-if="lookStatus.loading" class="stage-busy" role="status">Updating your character…</p>
      </div>
      <!-- Clothes, skin tone or a photo face can each fail; the preview shows which, and this tries the whole character again. -->
      <div v-if="!lookStatus.loading && lookStatus.error" class="notice coral stage-error" role="status">
        <span>Your character could not be shown completely.</span>
        <button class="btn sm" type="button" @click="retryCharacter">Try again</button>
      </div>
      <div class="stage-actions">
        <div class="tabs view-tabs" role="group" aria-label="Preview view">
          <button class="tab" type="button" :aria-pressed="view === 'body'" @click="view = 'body'">Full body</button>
          <button class="tab" type="button" :aria-pressed="view === 'face'" @click="view = 'face'">Face</button>
        </div>
        <button class="btn sm" type="button" @click="surprise">🎲 Surprise me</button>
      </div>
      <details class="tune">
        <summary>See it move</summary>
        <div class="tabs" role="tablist" aria-label="Preview movement">
          <button v-for="entry in MOTIONS" :key="entry.id" class="tab" type="button" role="tab" :aria-selected="motion === entry.id" @click="motion = entry.id">{{ entry.label }}</button>
        </div>
      </details>
    </div>

    <div class="controls stack loose">
      <section class="stack tight" aria-labelledby="avatar-body">
        <h3 id="avatar-body">Character</h3>
        <div class="bodies" role="radiogroup" aria-label="Character">
          <button
            v-for="(body, index) in castOrder" :key="body" class="body" type="button" role="radio"
            :aria-checked="look.body === body" :aria-label="`Character ${index + 1}`" @click="selectBody(body)"
          ><img :src="portraitUrl(body)" alt="" width="64" height="64" loading="lazy" /></button>
        </div>
      </section>

      <section class="stack tight" aria-labelledby="avatar-skin">
        <h3 id="avatar-skin">Skin tone</h3>
        <SkinTonePicker :model-value="look.skin" @update:model-value="change({ skin: $event })" />
        <button class="btn sm" type="button" @click="change({ skin: null })">{{ look.face ? 'Use the tone suggested by my photo' : 'Use character’s original tone' }}</button>
      </section>

      <section class="stack tight" aria-labelledby="avatar-outfit">
        <h3 id="avatar-outfit">Clothes</h3>
        <div class="stack tight" role="radiogroup" aria-label="Clothes">
        <div class="outfit-grid">
          <button class="outfit-card" type="button" role="radio" :aria-checked="!look.outfit" @click="change({ outfit: null })">
            <img :src="portraitUrl(look.body)" alt="" width="96" height="96" loading="lazy" />
            <span><strong>Original clothes</strong><small>Keep this character’s own outfit</small></span>
          </button>
        </div>
        <h4>{{ featuredLabel }}</h4>
        <div class="outfit-grid">
          <button v-for="entry in featured" :key="entry.id" class="outfit-card" type="button" role="radio" :aria-checked="look.outfit === entry.id" @click="change({ outfit: entry.id })">
            <img :src="entry.thumbnail" alt="" width="96" height="96" loading="lazy" />
            <span><strong>{{ entry.name }}</strong><small>{{ entry.description }}</small></span>
          </button>
        </div>
        <details class="more-outfits" :open="moreOutfits.some(entry => entry.id === look.outfit)">
          <summary>All other collections <span class="muted">({{ moreOutfits.length }})</span></summary>
          <div class="outfit-grid">
            <button v-for="entry in moreOutfits" :key="entry.id" class="outfit-card" type="button" role="radio" :aria-checked="look.outfit === entry.id" @click="change({ outfit: entry.id })">
              <img :src="entry.thumbnail" alt="" width="96" height="96" loading="lazy" />
              <span><strong>{{ entry.name }}</strong><small>{{ entry.description }}</small></span>
            </button>
          </div>
        </details>
        </div>
        <details v-if="!look.outfit" class="tune" :open="hueOpen">
          <summary>Original clothes colour</summary>
          <div class="stack tight">
            <div class="swatches" role="radiogroup" aria-label="Original clothes colour">
              <button
                v-for="hue in HUES" :key="hue" class="outfit-hue" type="button" role="radio" :aria-checked="look.outfitHue === hue"
                :aria-label="hue === 0 ? 'Original outfit colours' : `Outfit colours turned ${hue} degrees`" @click="change({ outfitHue: hue })"
              ><img :src="portraitUrl(look.body)" alt="" width="46" height="46" :style="{ filter: swatch(hue) }" /></button>
            </div>
            <label class="field">
              <span>Fine-tune <span class="muted num">{{ look.outfitHue }}°</span></span>
              <input type="range" min="-180" max="180" step="5" :value="look.outfitHue" aria-label="Outfit colour turn in degrees" @input="change({ outfitHue: Number(($event.target as HTMLInputElement).value) })" />
            </label>
          </div>
        </details>
      </section>

      <!-- After the body is chosen: a photo can suggest the rest, and everything it suggests stays editable below. -->
      <section class="stack tight" aria-labelledby="avatar-face">
        <h3 id="avatar-face">Match your character <span class="chip sky">Optional</span></h3>
        <FaceCapture v-if="capturing" :look="look" :audience="look.face?.audience ?? 'friends'" :saving="faceBusy" :allow-photo-face="allowPhotoFace" :match-action-label="matchActionLabel" @keep="keepFace" @cancel="capturing = false" />
        <template v-else-if="look.face">
          <div class="card row">
            <AvatarPortrait class="face-thumb" :look="look" :face="face" :face-key="`own-${look.face.version}`" :size="128" alt="Your fitted character portrait" />
            <div class="grow">
              <strong>Your face is on your character</strong>
              <div class="muted small">An approximate 3D face from your picture. The original picture was not kept.</div>
            </div>
          </div>
          <label class="field">
            <span>Who sees it</span>
            <select class="select" :value="look.face.audience" :disabled="faceBusy" @change="emit('setFaceAudience', ($event.target as HTMLSelectElement).value as FaceAudience)">
              <option value="friends">Friends only — others see the character’s own face</option>
              <option value="everyone">Everyone in Allworld</option>
            </select>
          </label>
          <div class="row">
            <button class="btn sm" type="button" :disabled="faceBusy" @click="capturing = true">Replace picture</button>
            <button class="btn sm danger" type="button" :disabled="faceBusy" @click="emit('clearFace')">Remove my face</button>
          </div>
        </template>
        <template v-else>
          <p class="muted small">Start with a photo, then edit the suggested tone, shape and hair. A photo face is optional.</p>
          <button class="btn" type="button" style="align-self: flex-start" @click="capturing = true">Match me from a photo</button>
        </template>
      </section>

      <details class="tune fine">
        <summary>Height, shape and hair <span class="muted num small">about {{ heightCm(look) }} cm</span></summary>
        <div class="stack loose">
          <section class="stack tight" aria-labelledby="avatar-height">
            <h3 id="avatar-height">Height</h3>
            <input type="range" :min="AVATAR_HEIGHT.min" :max="AVATAR_HEIGHT.max" step="0.01" :value="look.height" aria-label="Height" @input="change({ height: Number(($event.target as HTMLInputElement).value) })" />
          </section>
          <section class="stack tight" aria-labelledby="avatar-appearance">
            <h3 id="avatar-appearance">Shape and hair</h3>
            <p class="muted small">Save your character to share these details with other players.</p>
            <AppearanceControls :model-value="appearance" @update:model-value="changeAppearance" />
          </section>
        </div>
      </details>
    </div>
  </div>
</template>

<style scoped>
.editor { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 20px; align-items: start; }
.stage { position: sticky; top: 0; display: flex; flex-direction: column; gap: 10px; }
.stage :deep(.preview) { height: 400px; }
.stage-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.stage-actions .tab, .editor .btn { min-height: 44px; }
.stage-actions .view-tabs { flex: 1 1 150px; }
.stage .tune .tab { min-height: 44px; }
.view-tabs .tab[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(40, 30, 10, 0.12); }
.bodies { display: grid; grid-template-columns: repeat(auto-fill, minmax(62px, 1fr)); gap: 8px; }
.body { padding: 0; border: 3px solid transparent; border-radius: 18px; background: #23202c; overflow: hidden; aspect-ratio: 1; transition: transform 0.1s ease, border-color 0.15s ease; }
.body img { width: 100%; height: 100%; object-fit: cover; display: block; }
.body:hover { transform: translateY(-2px); }
.body[aria-checked="true"] { border-color: var(--accent-strong); box-shadow: 0 0 0 3px var(--accent-soft); }
.swatches { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.swatch { width: 44px; height: 44px; border-radius: 50%; border: 2px solid rgba(0, 0, 0, 0.12); padding: 0; position: relative; }
.swatch[aria-checked="true"] { outline: 3px solid var(--ink); outline-offset: 2px; }
.swatch.original { background: var(--surface-3); font-weight: 800; color: var(--ink-2); }
.swatch.custom { display: grid; place-items: center; background: conic-gradient(#f3d2b8, #b07449, #4a2b1a, #f3d2b8); color: #fff; font-weight: 800; cursor: pointer; overflow: hidden; }
.swatch.custom input { position: absolute; inset: 0; opacity: 0; cursor: pointer; }
.outfit-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 200px), 1fr)); gap: 8px; }
.outfit-card { min-width: 0; min-height: 88px; display: flex; align-items: center; gap: 10px; padding: 7px; border: 2px solid var(--line); border-radius: 14px; background: var(--surface); color: var(--ink); text-align: left; cursor: pointer; }
.outfit-card img { width: 72px; height: 72px; flex: none; border-radius: 9px; object-fit: cover; background: var(--surface-3); }
.outfit-card span { min-width: 0; display: grid; gap: 3px; }
.outfit-card strong { font-size: 0.9rem; }
.outfit-card small { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; color: var(--ink-2); font-size: 0.72rem; line-height: 1.3; }
.outfit-card:hover { border-color: var(--accent-strong); }
.outfit-card:focus-visible { outline: 3px solid var(--accent-strong); outline-offset: 2px; }
.outfit-card[aria-checked="true"] { border-color: var(--accent-strong); box-shadow: 0 0 0 2px var(--accent-soft); }
.more-outfits summary, .tune summary { min-height: 44px; display: flex; align-items: center; gap: 4px; cursor: pointer; font-weight: 650; }
.more-outfits .outfit-grid { margin-top: 8px; }
/* Fine-tuning opens in place, below the basics. */
.tune summary { gap: 8px; list-style: none; }
.tune summary::-webkit-details-marker { display: none; }
.tune summary::after { content: "▾"; margin-left: auto; color: var(--muted); }
.tune[open] > summary::after { transform: rotate(180deg); }
.tune.fine { border-top: 1px solid var(--line); }
.stage-view { position: relative; border-radius: 18px; }
.stage-view:focus-visible { outline: 2px solid var(--accent-strong); outline-offset: 2px; }
.stage-busy { position: absolute; top: 10px; left: 10px; margin: 0; padding: 4px 8px; border-radius: 8px; background: rgba(20, 18, 26, 0.82); color: #fff; font-size: 0.72rem; font-weight: 700; pointer-events: none; }
.stage-error { align-items: center; justify-content: space-between; }
.stage-error .btn { min-height: 44px; flex: none; }
.outfit-hue { padding: 0; width: 46px; height: 46px; border-radius: 14px; overflow: hidden; border: 3px solid transparent; background: #23202c; }
.outfit-hue img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: 50% 90%; transform: scale(1.5); }
.outfit-hue[aria-checked="true"] { border-color: var(--accent-strong); }
input[type="range"] { width: 100%; min-height: 44px; accent-color: var(--accent-strong); }
.controls .select { min-height: 44px; }
.face-thumb { border-radius: 12px; border: 1px solid var(--line); object-fit: cover; }
h3 { display: flex; align-items: center; gap: 8px; }
@media (max-width: 720px) {
  .editor { grid-template-columns: 1fr; }
  .stage { position: static; }
  /* Short enough that the first choice below the preview is on a phone's first screen. */
  .stage :deep(.preview) { height: clamp(240px, 68vw, 340px); }
}
@media (max-width: 420px) {
  .controls { min-width: 0; }
}
</style>
