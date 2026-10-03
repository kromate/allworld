<script setup lang="ts">
// Where the house stands. The owner asks, in the street of the area their character is in, for it to
// be put on a plot the service offers (home.sites), or taken off (home.setSite). Nothing here is a
// label: the plots are the service's own, in the district it says the character is in, and a plot
// the rooms do not fit or that another home holds is not offered as a choice. Nothing is shown of
// where anyone is: a plot has a name, never a position. A home that is not on the map cannot be
// walked into, so this is where a member starts.
import { computed, ref } from 'vue'
import type { Home } from '../../shared/social.ts'
import { api, messageOf } from '../../state/app.ts'
import { world } from '../../state/world.ts'
import { STATUS_TEXT, plotDimensions, plotView, unoccupiedGround } from './homePlots.ts'
import type { Studio } from './homeStudio.ts'

const props = defineProps<{ studio: Studio }>()
const { state } = props.studio
const site = computed(() => state.home?.building.site ?? null)
const remaining = computed(() => site.value && state.home ? unoccupiedGround(state.home.building.plan, site.value.parcel.envelope) : null)
const busy = ref(false)
const note = ref('')
type Sites = Awaited<ReturnType<typeof api<'home.sites'>>>
const options = ref<Sites | null>(null)

const view = computed(() => (options.value ? plotView(options.value) : null))
const shown = (home: Home): boolean => world.kind === 'home' && world.home?.id === home.id

async function look(): Promise<void> {
  busy.value = true; note.value = ''
  try { options.value = await api('home.sites', {}) } catch (error) { note.value = messageOf(error) } finally { busy.value = false }
}
/** `parcelId` is one the service offered; null asks the service for the first free plot that fits. Only ever from a press. */
async function place(parcelId: string | null): Promise<void> {
  busy.value = true; note.value = ''
  try {
    const { home } = await api('home.setSite', { place: { parcelId } })
    state.home = home
    if (shown(home)) world.home = home
    options.value = null
    await props.studio.refresh()
  } catch (error) { note.value = messageOf(error) } finally { busy.value = false }
}
async function remove(): Promise<void> {
  busy.value = true; note.value = ''
  try {
    const { home } = await api('home.setSite', { place: null })
    state.home = home
    if (shown(home)) world.home = home
    await props.studio.refresh()
  } catch (error) { note.value = messageOf(error) } finally { busy.value = false }
}
</script>

<template>
  <details class="disclosure" :open="!site || site.status !== 'valid'">
    <summary>On the map <span class="chip" :class="site?.status === 'valid' ? 'leaf' : site ? 'amber' : 'coral'">{{ site ? (site.status === 'valid' ? site.areaLabel : 'Not showing') : 'Not placed' }}</span></summary>
    <div class="stack tight">
      <p v-if="site" class="small">{{ STATUS_TEXT[site.status] }}<template v-if="site.status === 'valid'"> It stands in {{ site.areaLabel }}. People who may visit can walk to its door.</template></p>
      <p v-else class="small">Your home is not on the map, so nobody can walk to it, you included. Stand in the street of the area you want, then choose a plot. Nothing says where anyone really lives.</p>

      <p v-if="site" class="muted small">{{ site.status === 'valid' ? 'Current plot building area' : 'Last placed plot building area' }}: {{ plotDimensions(site.parcel.envelope) }}.<template v-if="site.status === 'valid' && remaining !== null"> Ground outside your saved house's outer walls: {{ remaining }}.</template></p>

      <button class="btn sm" type="button" style="align-self: flex-start" :disabled="busy" @click="look">{{ options ? 'Look again' : site ? 'Look at plots here' : 'See plots here' }}</button>

      <template v-if="view">
        <p v-if="view.area === null" class="notice amber" role="status">{{ view.message }}</p>
        <template v-else>
          <p class="small muted">You are in {{ view.area }}. {{ view.free }} {{ view.free === 1 ? 'plot fits' : 'plots fit' }} your saved rooms. Compare building dimensions if you want room to expand.</p>
          <button class="btn primary sm" type="button" style="align-self: flex-start" :disabled="busy || !view.firstFits" @click="place(null)">{{ site ? 'Move to the first plot that fits' : 'Place on the first plot that fits' }}</button>
          <ul v-if="view.rows.length" class="plots" aria-label="Plots in this area">
            <li v-for="row in view.rows" :key="row.parcelId" class="list-row">
              <span class="grow"><strong class="small">{{ row.label }}</strong>
                <span class="plot-size muted tiny">{{ row.dimensions }} building area</span>
                <span v-if="row.state === 'taken'" class="chip">Taken</span>
                <span v-else-if="row.state === 'tight'" class="chip coral">Your rooms do not fit</span>
                <span v-else class="chip leaf">Free</span>
              </span>
              <button class="btn sm" type="button" :disabled="busy || !row.choosable" :aria-label="`${site ? 'Move' : 'Place'} the home on ${row.label}`" @click="place(row.parcelId)">{{ site ? 'Move here' : 'Place here' }}</button>
            </li>
          </ul>
        </template>
      </template>

      <button v-if="site" class="btn sm" type="button" style="align-self: flex-start" :disabled="busy" @click="remove">Take it off the map</button>
      <p v-if="note" class="notice coral" role="alert">{{ note }}</p>
    </div>
  </details>
</template>

<style scoped>
.plots { list-style: none; margin: 0; padding: 0; max-height: 240px; overflow-y: auto; border: 1px solid var(--line); border-radius: 12px; padding-inline: 10px; }
.plots .list-row + .list-row { border-top: 1px solid var(--line); }
.plot-size { flex-basis: 100%; }
.plots .grow { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; min-width: 0; }
</style>
