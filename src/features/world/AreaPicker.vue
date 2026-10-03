<script setup lang="ts">
// Choose an area by name, by an optional one-time device suggestion, or from starter places.
// The result is always a named public place; an exact position is never produced here.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CoarseArea, AreaSource } from '../../shared/model.ts'
import { STARTER_PLACES } from '../../shared/places.ts'
import { providers } from '../../config/providers.ts'
import { supportsVehicleDistrict } from '../../world/vehicles/provenance.ts'
import { areaFromPlace } from '../../geo/areas.ts'
import { DeviceSuggestionError, GeocodeError, searchPlaces, suggestFromDevice } from '../../geo/geocode.ts'
import type { PlaceResult } from '../../geo/geocode.ts'

const props = defineProps<{ language: string; busy?: boolean; /** Ask the device straight away instead of waiting for a tap. */ autoSuggest?: boolean; /** First start: the starter places are grouped by where homes and driving are prepared. */ starting?: boolean }>()
const emit = defineEmits<{ choose: [area: CoarseArea, source: AreaSource] }>()

const query = ref('')
const results = ref<PlaceResult[]>([])
const searching = ref(false)
const searched = ref(false)
const searchedFor = ref('')
const problem = ref('')
const suggesting = ref(false)
const suggestion = ref<(PlaceResult & { coarseWidthKm: number }) | null>(null)
const deviceNote = ref('')

// The geocoder calls cannot be cancelled, so each request keeps the run it started in and ignores its own answer once
// a newer run, a choice, a language change or unmount has ended it.
let searchRun = 0
let deviceRun = 0
let autoRun = false // the pending device run started on mount, not from a tap
function dropSearch(): void { searchRun++; searching.value = false }
function dropDevice(): void { deviceRun++; suggesting.value = false; autoRun = false }

async function search(): Promise<void> {
  const text = query.value.trim()
  if (text.length < 2 || searching.value) return
  const run = ++searchRun
  searching.value = true
  problem.value = ''
  results.value = []
  searched.value = false
  try {
    const found = await searchPlaces(text, props.language)
    if (run !== searchRun) return
    results.value = found
    searchedFor.value = text
    searched.value = true
  } catch (error) {
    if (run !== searchRun) return
    problem.value = error instanceof GeocodeError ? error.message : 'The place search failed. Try again.'
  } finally {
    if (run === searchRun) searching.value = false
  }
}

async function useDevice(): Promise<void> {
  if (suggesting.value) return
  const run = ++deviceRun
  suggesting.value = true
  deviceNote.value = ''
  suggestion.value = null
  try {
    const found = await suggestFromDevice(props.language)
    if (run !== deviceRun) return
    suggestion.value = found
  } catch (error) {
    if (run !== deviceRun) return
    deviceNote.value = error instanceof DeviceSuggestionError || error instanceof GeocodeError ? error.message : 'The device could not suggest an area. Choose one by name.'
  } finally {
    if (run === deviceRun) { suggesting.value = false; autoRun = false }
  }
}

onMounted(() => { if (props.autoSuggest) { autoRun = true; void useDevice() } })
onBeforeUnmount(() => { dropSearch(); dropDevice() })
// Answers and wording tied to the previous language, or to a device ask that is no longer allowed, are not kept.
watch(() => props.language, () => {
  dropSearch(); dropDevice()
  results.value = []; searched.value = false; problem.value = ''; suggestion.value = null; deviceNote.value = ''
})
watch(() => props.autoSuggest, allowed => { if (!allowed && autoRun) dropDevice() })

// A choice settles the question: a late answer must not offer another area after it.
const pick = (place: { label: string; countryCode: string; anchor: { lat: number; lon: number } }, source: AreaSource): void => { dropSearch(); dropDevice(); emit('choose', areaFromPlace(place), source) }
// Homes and driving are prepared only in the districts the vehicle map supports; the map is checked again, read-only, once a place is chosen.
const featured = STARTER_PLACES.filter(place => supportsVehicleDistrict(areaFromPlace(place).arrivalDistrict))
const further = STARTER_PLACES.filter(place => !featured.includes(place))
const flag = (code: string): string => (/^[A-Z]{2}$/.test(code) && code !== 'ZZ' ? String.fromCodePoint(...[...code].map(c => 127397 + c.charCodeAt(0))) : '📍')
</script>

<template>
  <div class="stack">
    <div class="device card tint-sky">
      <div class="row device-head">
        <span class="icon-chip sky" aria-hidden="true">🧭</span>
        <div class="grow">
          <strong>{{ suggesting ? 'Checking where you are…' : suggestion ? 'Your device suggests' : 'Use this device’s location' }}</strong>
          <div class="muted small">Asked once. The reading is rounded to an area several kilometres wide before anything else sees it, and you can always choose a place by name instead.</div>
        </div>
        <button class="btn sm" type="button" :disabled="suggesting || busy" @click="useDevice">{{ suggesting ? 'Asking…' : suggestion || deviceNote ? 'Check again' : 'Check' }}</button>
      </div>
      <div v-if="suggestion" class="suggestion">
        <div class="grow">
          <strong>Around {{ suggestion.label }}</strong>
          <div class="muted small">{{ suggestion.detail }} · approximate to about {{ suggestion.coarseWidthKm }} km</div>
        </div>
        <button class="btn primary sm" type="button" :disabled="busy" @click="pick(suggestion, 'device-suggested')">Use this area</button>
      </div>
      <p v-if="deviceNote" class="small device-note" role="status">{{ deviceNote }}</p>
    </div>

    <form class="row" role="search" @submit.prevent="search">
      <label class="grow">
        <span class="sr-only">Search for a neighbourhood, town or city</span>
        <input v-model="query" class="input" type="search" placeholder="Neighbourhood, town or city" autocomplete="off" enterkeyhint="search" :disabled="busy" />
      </label>
      <button class="btn dark" type="submit" :disabled="searching || busy || query.trim().length < 2">{{ searching ? 'Searching…' : 'Search' }}</button>
    </form>

    <p v-if="problem" class="notice coral" role="alert">{{ problem }}</p>

    <ul v-if="results.length" class="results" aria-label="Matching places">
      <li v-for="place in results" :key="`${place.label}-${place.anchor.lat}`">
        <button class="card interactive result" type="button" :disabled="busy" @click="pick(place, 'manual')">
          <span class="flag" aria-hidden="true">{{ flag(place.countryCode) }}</span>
          <span class="grow"><strong>{{ place.label }}</strong><span class="muted small">{{ place.detail }}</span></span>
          <span class="chip amber">Choose</span>
        </button>
      </li>
    </ul>
    <p v-else-if="searched && !searching" class="notice">No place matched “{{ searchedFor }}”. Try the name of a wider area, such as the town or city.</p>

    <div v-if="starting" class="stack tight">
      <span id="starters-ready" class="label">Best prepared: homes and driving work here</span>
      <div class="row wrap" role="group" aria-labelledby="starters-ready">
        <button v-for="place in featured" :key="place.label" class="btn sm primary" type="button" :disabled="busy" @click="pick(place, 'manual')">
          <span aria-hidden="true">{{ flag(place.countryCode) }}</span>{{ place.label }}
        </button>
      </div>
      <span id="starters-more" class="label">Other well-known places: streets and trips, no homes or driving yet</span>
      <div class="row wrap" role="group" aria-labelledby="starters-more">
        <button v-for="place in further" :key="place.label" class="btn sm" type="button" :disabled="busy" @click="pick(place, 'manual')">
          <span aria-hidden="true">{{ flag(place.countryCode) }}</span>{{ place.label }}
        </button>
      </div>
      <p class="muted tiny">Search above finds any place in the world.</p>
    </div>
    <div v-else class="stack tight">
      <span class="label">Or start somewhere well known</span>
      <div class="row wrap">
        <button v-for="place in STARTER_PLACES" :key="place.label" class="btn sm" type="button" :disabled="busy" @click="pick(place, 'manual')">
          <span aria-hidden="true">{{ flag(place.countryCode) }}</span>{{ place.label }}
        </button>
      </div>
    </div>

    <p class="muted tiny">Place search by {{ providers.geocoder.name }}. {{ providers.tiles.attribution }}.</p>
  </div>
</template>

<style scoped>
.results { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.result { display: flex; align-items: center; gap: 12px; }
.result .grow { display: flex; flex-direction: column; }
.flag { font-size: 1.4rem; }
.suggestion { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #c9e2f5; }
.device-note { margin-top: 10px; color: #1c4f78; }
/* On a narrow screen the button drops under the text instead of squeezing it into a thin column. */
@media (max-width: 520px) {
  .device-head { flex-wrap: wrap; align-items: flex-start; }
  .device-head .grow { flex-basis: calc(100% - 48px); }
  .device-head .btn { margin-left: 48px; }
  .suggestion { flex-wrap: wrap; }
}
</style>
