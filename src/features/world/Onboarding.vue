<script setup lang="ts">
// First run: choose where to start, make your character, then arrive. Starting in a place is not claiming to be there.
import { computed, inject, onBeforeUnmount, ref } from 'vue'
import { brand } from '../../brand.ts'
import { guestAccess } from '../../shared/guest.ts'
import { CURRENT_AREA_TTL_DAYS } from '../../shared/model.ts'
import type { AreaSource, AvatarLook, CoarseArea, FaceAudience } from '../../shared/model.ts'
import { countryDefaults } from '../../shared/places.ts'
import { TRAVEL } from '../../shared/travel.ts'
import { preflightArea } from './mapPreflight.ts'
import type { MapPreflight } from './mapPreflight.ts'
import { defaultLookFor, featuredOutfits, suggestedCast } from '../../config/wardrobe.ts'
import { api, app, messageOf, toast } from '../../state/app.ts'
import { social } from '../../state/social.ts'
import { useFace } from '../avatar/useFace.ts'
import type { FaceCaptureResult } from '../avatar/faceScan.ts'
import AvatarEditor from '../avatar/AvatarEditor.vue'
import AreaPicker from './AreaPicker.vue'
import BrandMark from '../../ui/BrandMark.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import type { AvatarBody } from '../../shared/model.ts'
import { GUEST_CONTROL, GUEST_LINE } from '../guest/guestView.ts'
import CreatorDisclosure from '../creator/CreatorDisclosure.vue'
import { useCreatorCard } from '../creator/useCreatorCard.ts'

defineEmits<{ done: [] }>()
// Profile data is reactive; a plain copy is what the editor works on.
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const me = app.me!
// A guest sets up with the same three steps. What differs is what the service lets a guest do:
// the device is not asked where it is until they press Check, nobody can be found nearby, and a
// photo is matched on the device but not kept.
const guestControl = inject(GUEST_CONTROL, null)
const guest = computed(() => Boolean(guestControl?.session.value))
// Where the session says this host cannot save to an account, "until you save it" has nothing to point at; the session also says whether this browser keeps it.
const guestLine = computed(() => {
  const session = guestControl?.session.value
  if (session?.signIn !== 'unavailable') return GUEST_LINE
  return session.persisted ? 'Playing as a guest. This character stays on this device.' : 'Playing as a guest. This character lasts only while this tab stays open.'
})
const { card: creator } = useCreatorCard(() => app.mode === 'hosted' && app.phase === 'ready')
const step = ref<1 | 2 | 3>(1)
// 1 where you are · 2 your character · 3 arrive
// The name a test member or a new guest starts with is the service's placeholder, not a choice.
const name = ref(me.displayName.startsWith('Test member') || (guest.value && me.displayName === 'Guest') ? '' : me.displayName)
const look = ref<AvatarLook>(copy(me.look))
const area = ref<{ area: CoarseArea; source: AreaSource } | null>(null)
const presence = ref<'here' | 'browsing'>('browsing')
const discoverable = ref(false)
const busy = ref(false)
const problem = ref('')
const face = useFace()
const clearPhotoOnSave = ref(false)
const language = navigator.language || 'en'
const nameOk = computed(() => name.value.trim().length >= 2)

async function saveCharacter(): Promise<void> {
  if (!nameOk.value || busy.value || face.busy.value) return
  busy.value = true
  problem.value = ''
  try {
    const { profile } = await api('member.saveProfile', { displayName: name.value.trim(), bio: app.me!.bio, look: look.value, expectedRevision: app.me!.revision, clearFace: clearPhotoOnSave.value })
    clearPhotoOnSave.value = false
    app.me = profile
    look.value = copy(profile.look)
    await face.load()
    step.value = 3
  } catch (error) { problem.value = messageOf(error) } finally { busy.value = false }
}

async function setFace(result: FaceCaptureResult, audience: FaceAudience, matchSkin: boolean): Promise<void> {
  pickedBody.value = true
  lookTouched.value = true
  if (result.mode === 'match') {
    clearPhotoOnSave.value = true
    look.value = { ...look.value, body: result.body, skin: matchSkin ? result.skin : look.value.skin, appearance: result.appearance, face: null }
    return
  }
  // Keeping a photo face is closed to a guest by the service. Say so here instead of sending the photo to be refused.
  const keep = guest.value ? guestAccess('member.setFace') : null
  if (keep && !keep.allowed) { toast(`The photo was not kept. ${keep.message} Match copies your look from a photo without keeping it.`, 'info'); return }
  if (busy.value) { toast('Your character is still saving. Add the photo again in a moment.', 'info'); return }
  // The picture is kept with the whole character on screen in one step, so it is never left on a look it was not chosen with.
  const chosen: AvatarLook = { ...look.value, body: result.body, appearance: result.appearance, ...(matchSkin ? { skin: result.skin } : {}) }
  look.value = chosen
  const sent = look.value
  if (!await face.save(result, audience, chosen) || !app.me) return
  clearPhotoOnSave.value = false
  // Anything changed on the editor while the answer was on its way stays for Continue to save.
  look.value = look.value === sent ? copy(app.me.look) : { ...look.value, face: app.me.look.face }
}
async function clearFace(): Promise<void> { if (await face.clear()) { clearPhotoOnSave.value = false; look.value = { ...look.value, face: null } } }
async function setFaceAudience(audience: FaceAudience): Promise<void> { if (await face.setAudience(audience) && app.me) look.value = { ...look.value, face: app.me.look.face } }

// Until the member changes something themselves, the starting look follows what is featured
// for the chosen place. It is a starting point only: every character and outfit stays available.
const lookTouched = ref(false)
function editLook(next: AvatarLook): void {
  // Choosing a character anywhere on this step counts as the pick.
  if (next.body !== look.value.body) pickedBody.value = true
  lookTouched.value = true; look.value = next
}
// New members in one place should not all step out as the same person in the same clothes:
// each starts as one of the first few featured characters and outfits, chosen by their id.
function startingLook(countryCode: string): AvatarLook {
  const base = defaultLookFor(countryCode)
  let hash = 0
  for (const char of me.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  const cast = suggestedCast(countryCode).slice(0, 6)
  const body = cast[hash % Math.max(1, cast.length)] ?? base.body
  const outfits = featuredOutfits(countryCode).filter(outfit => outfit.fits.includes(body)).slice(0, 4)
  const outfit = outfits[(hash >>> 5) % Math.max(1, outfits.length)]
  return outfit ? { ...base, body, outfit: outfit.id } : base
}
// The first thing on the character step: pick who you play as, from the people featured for the
// place. Nobody should find their face on a body they did not choose.
const starters = computed<AvatarBody[]>(() => {
  const cast = suggestedCast(area.value?.area.countryCode ?? '')
  const women = cast.filter(body => body.startsWith('f')), men = cast.filter(body => body.startsWith('m'))
  const mixed: AvatarBody[] = []
  for (let index = 0; index < 4; index++) { const man = men[index], woman = women[index]; if (man) mixed.push(man); if (woman) mixed.push(woman) }
  return mixed
})
const pickedBody = ref(false)
function pickStarter(body: AvatarBody): void {
  const outfit = featuredOutfits(area.value?.area.countryCode ?? '').find(candidate => candidate.fits.includes(body))
  pickedBody.value = true
  editLook({ ...look.value, body, outfit: outfit ? outfit.id : null })
}

// The map for a starting place is checked before it is chosen. The check reads public map data only: no profile, area,
// origin or starting coins are written until Arrive, so a failed or cancelled check leaves the member on this step with
// nothing saved. One check runs at a time; an answer for anything but the latest choice is dropped.
const checking = ref(false)
const pickProblem = ref('')
const map = ref<Extract<MapPreflight, { canCommit: true }> | null>(null)
let check: AbortController | null = null
function cancelCheck(): void { check?.abort(); check = null; checking.value = false }
onBeforeUnmount(cancelCheck)
async function chooseArea(chosen: CoarseArea, source: AreaSource): Promise<void> {
  if (checking.value || busy.value) return
  const mine = new AbortController()
  check = mine
  checking.value = true
  pickProblem.value = ''
  const result = await preflightArea(chosen, mine.signal)
  if (check !== mine || mine.signal.aborted || result.areaId !== chosen.areaId) return
  check = null
  checking.value = false
  if (!result.canCommit) {
    const why = result.status === 'unavailable' ? (result.reason === 'empty' ? `${chosen.label} has no streets on the map yet, so there is nothing to walk there.` : result.detail) : 'The map check stopped.'
    pickProblem.value = `${why} Nothing was saved. Try again or choose another place.`
    return
  }
  map.value = result
  area.value = { area: chosen, source }
  presence.value = 'browsing'
  discoverable.value = false
  if (!lookTouched.value) look.value = { ...startingLook(chosen.countryCode), face: look.value.face }
  step.value = 2
}

async function finish(): Promise<void> {
  if (!area.value || busy.value) return
  busy.value = true
  problem.value = ''
  try {
    const here = presence.value === 'here'
    if (here) await api('member.setCurrentArea', { area: area.value.area, source: area.value.source })
    else await api('member.setBrowsing', { area: area.value.area })
    const defaults = countryDefaults(area.value.area.countryCode)
    await api('member.savePreferences', { preferences: { ...app.me!.preferences, language: language.slice(0, 12), units: defaults.units, discoverable: here && discoverable.value && !guest.value } })
    const { profile } = await api('member.completeOnboarding', {})
    app.me = profile
    toast(`Welcome, ${profile.displayName}.`, 'good')
  } catch (error) { problem.value = messageOf(error) } finally { busy.value = false }
}
</script>

<template>
  <div class="onboarding">
    <div class="sheet">
      <header class="head">
        <BrandMark :size="38" />
        <div class="grow">
          <strong>{{ brand.name }}</strong>
          <div class="muted tiny">Step {{ step }} of 3</div>
        </div>
        <ol class="steps" aria-label="Progress">
          <li v-for="n in 3" :key="n" :class="{ done: n < step, now: n === step }" :aria-current="n === step ? 'step' : undefined"><span class="sr-only">Step {{ n }}</span></li>
        </ol>
      </header>
      <p v-if="guest" class="muted small guest-line">{{ guestLine }}</p>

      <section v-if="step === 1" class="stack loose">
        <div>
          <h1>Where do you want to start?</h1>
          <p class="muted">Allworld is drawn on real maps. Homes and driving are prepared in Yaba (Lagos) and Wuse (Abuja), so they are the best places to begin. Anywhere else in the world you can still walk the streets, but there are no homes or driving there yet. You arrive at a public spot, never at your address, and we do not ask for one.</p>
          <p class="muted small">Your starting place is saved when you arrive. After that, a far city is a trip with a fare, and borders can need a passport and a visa. Districts within about {{ TRAVEL.localRangeKm }} km can be walked into.</p>
        </div>
        <!-- Arrived through a friend's invite link: starting where they are is the first choice. -->
        <div v-if="social.invitation?.area" class="card tint-amber row invited">
          <span class="icon-chip" aria-hidden="true">💌</span>
          <span class="grow"><strong>{{ social.invitation.inviter.displayName }} invited you</strong><span class="muted small" style="display: block">Start in {{ social.invitation.area.label }}.{{ guest ? ' Meeting people waits until your character is saved.' : ' You can then find each other.' }}</span></span>
          <button class="btn primary sm" type="button" :disabled="checking" @click="chooseArea(social.invitation.area, 'manual')">Start there</button>
        </div>
        <AreaPicker :language="language" :auto-suggest="!guest" :busy="checking" starting @choose="chooseArea" />
        <div v-if="checking" class="row" role="status">
          <div class="spinner" aria-hidden="true"></div>
          <span class="grow muted small">Checking the map. Nothing is saved yet.</span>
          <button class="btn sm" type="button" @click="cancelCheck">Cancel</button>
        </div>
        <p v-if="pickProblem" class="notice coral" role="alert">{{ pickProblem }}</p>
      </section>

      <section v-else-if="step === 2" class="stack loose">
        <div>
          <h1>Make your character</h1>
          <p class="muted">Choose who you play as, set the skin tone and outfit you like, or put your own face on the character from a picture. You can change it whenever you want.</p>
        </div>
        <fieldset class="starters">
          <legend class="label">Who do you play as?</legend>
          <div class="starter-row">
            <button v-for="body in starters" :key="body" class="starter" :class="{ on: look.body === body && pickedBody }" type="button" :aria-pressed="look.body === body && pickedBody" :aria-label="`Character ${body.startsWith('f') ? 'woman' : 'man'} ${body.slice(1)}`" @click="pickStarter(body)">
              <MemberBadge :look="{ ...look, body, face: null }" :size="60" />
            </button>
          </div>
          <small class="muted">Pick one to start from. Clothes, skin tone, hair and your own face come next, and there are more characters below.</small>
        </fieldset>
        <label class="field" style="max-width: 320px">
          <span>Name others will see</span>
          <input v-model="name" class="input" maxlength="32" autocomplete="nickname" placeholder="For example, Tolu" />
        </label>
        <AvatarEditor
          :look="look" :face="face.scan.value" :face-busy="face.busy.value || busy" :allow-photo-face="!app.guest" :country-code="area?.area.countryCode" :place-label="area?.area.label" @update:look="editLook"
          @set-face="setFace" @set-face-audience="setFaceAudience" @clear-face="clearFace"
        />
        <p v-if="problem" class="notice coral" role="alert">{{ problem }}</p>
        <div class="foot">
          <button class="btn primary" type="button" :disabled="!nameOk || !pickedBody || busy || face.busy.value" @click="saveCharacter">{{ busy ? 'Saving…' : 'Continue' }}</button>
          <button class="btn ghost" type="button" :disabled="busy" @click="step = 1">Back</button>
          <span v-if="!pickedBody" class="muted small">Pick who you play as, at the top.</span>
          <span v-else-if="!nameOk" class="muted small">Add a name with at least 2 characters.</span>
        </div>
      </section>

      <section v-else-if="step === 3 && area" class="stack loose">
        <div>
          <span class="chip amber">Starting place</span>
          <h1>{{ area.area.label }}</h1>
          <p class="muted">{{ area.source === 'device-suggested' ? 'Suggested from your device, rounded to a wide area.' : 'Chosen by you from the list or search, not read from your device.' }} Local time there follows {{ area.area.timezone.replace('_', ' ') }}. From here your character gets around in the game: on foot nearby, and by booking trips — with a passport and visas where borders need them. {{ map?.homes.available && map.driving.available ? 'Homes and driving are prepared here.' : 'There are no homes or driving here yet; the streets and trips work.' }}</p>
          <p v-if="map && map.status === 'limited'" class="muted small">{{ map.map.summary }}</p>
        </div>
        <fieldset class="choices">
          <legend class="label">Are you physically in this area right now?</legend>
          <label class="card choice" :class="{ on: presence === 'here' }">
            <input v-model="presence" type="radio" value="here" class="sr-only" />
            <span class="icon-chip leaf" aria-hidden="true">📍</span>
            <span class="grow"><strong>Yes, I am here in real life</strong><span class="muted small">Self-reported, and we do not check it. It stays fresh for {{ CURRENT_AREA_TTL_DAYS }} days, then we ask again.</span></span>
          </label>
          <label class="card choice" :class="{ on: presence === 'browsing' }">
            <input v-model="presence" type="radio" value="browsing" class="sr-only" />
            <span class="icon-chip sky" aria-hidden="true">🔭</span>
            <span class="grow"><strong>No, I am just exploring</strong><span class="muted small">Your character starts here, but you are never shown as someone who is really nearby. This is the right choice for a place you are not in.</span></span>
          </label>
        </fieldset>
        <label v-if="presence === 'here' && !guest" class="card row">
          <span class="grow">
            <strong>Let people in this area find me</strong>
            <span class="muted small" style="display: block">Off unless you turn it on. Others see only the area name — no map position, no distance.</span>
          </span>
          <button class="switch" type="button" role="switch" :aria-checked="discoverable" aria-label="Let people in this area find me" @click="discoverable = !discoverable"></button>
        </label>
        <p v-if="guest && presence === 'here'" class="muted small">While you play as a guest, nobody can find you by area. That waits until your character is saved.</p>
        <p v-if="problem" class="notice coral" role="alert">{{ problem }}</p>
        <CreatorDisclosure :ready="Boolean(creator?.ready && creator.link !== 'self')" />
        <div class="foot">
          <button class="btn primary" type="button" :disabled="busy" @click="finish">{{ busy ? 'Arriving…' : 'Arrive' }}</button>
          <button class="btn ghost" type="button" :disabled="busy" @click="step = 2">Back to my character</button>
          <button class="btn ghost" type="button" :disabled="busy" @click="step = 1">Choose another place</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.onboarding { position: fixed; inset: 0; z-index: 40; overflow-y: auto; padding: clamp(10px, 4vw, 40px); background: radial-gradient(90% 70% at 15% 0%, #ffe9b8, transparent 60%), radial-gradient(70% 60% at 100% 10%, #cfe8fb, transparent 60%), radial-gradient(60% 50% at 60% 100%, #fbd5cb, transparent 60%), var(--bg); }
.sheet { max-width: 860px; margin: 0 auto; padding: clamp(16px, 3vw, 30px); border-radius: 24px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-lg); display: flex; flex-direction: column; gap: 22px; }
.head { display: flex; align-items: center; gap: 12px; }
/* Sits under the header, close to it: one line that says whose character this is. */
.guest-line { margin-top: -12px; }
.steps { display: flex; gap: 6px; list-style: none; margin: 0; padding: 0; }
.steps li { width: 34px; height: 6px; border-radius: 99px; background: var(--surface-3); }
.steps li.done { background: var(--leaf); }
.steps li.now { background: var(--accent-strong); }
.foot { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.invited { flex-wrap: wrap; }
.spinner { width: 22px; height: 22px; flex: none; border-radius: 50%; border: 3px solid var(--accent-soft); border-top-color: var(--accent-strong); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } }
.starters { border: 0; padding: 0; margin: 0; display: grid; gap: 8px; }
.starter-row { display: flex; gap: 10px; flex-wrap: wrap; }
.starter { padding: 3px; border-radius: 50%; border: 3px solid transparent; background: transparent; line-height: 0; }
.starter.on { border-color: var(--accent-strong); }
.starter:hover { border-color: var(--line-strong); }
.choices { border: 0; padding: 0; margin: 0; display: grid; gap: 10px; }
.choices legend { margin-bottom: 8px; }
.choice { display: flex; align-items: center; gap: 12px; cursor: pointer; border-width: 2px; }
.choice .grow { display: flex; flex-direction: column; }
.choice.on { border-color: var(--accent-strong); background: var(--accent-soft); }
</style>
