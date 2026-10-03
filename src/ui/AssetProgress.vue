<script setup lang="ts">
// What is being downloaded right now, in bytes where the sizes are known. It renders nothing when
// nothing is downloading, so a visit that already has its files never shows a download.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { assetProgress } from '../assets/assetProgress.ts'
import type { AssetActivity } from '../assets/assetProgress.ts'

const props = defineProps<{
  /** The member is waiting on these files: show at once, and offer a way to stop. */
  blocking?: boolean
}>()

const activity = shallowRef<AssetActivity>(assetProgress.activity())
const unsubscribe = assetProgress.subscribe(next => { activity.value = next })

// Behind the game, a download that is over in a moment is not worth a line on screen.
const visible = ref(false)
let showTimer = 0
watch(() => activity.value.active > 0, busy => {
  window.clearTimeout(showTimer)
  if (!busy) { visible.value = false; return }
  if (props.blocking) visible.value = true
  else showTimer = window.setTimeout(() => { visible.value = true }, 500)
}, { immediate: true })

// A file that did not arrive behind the game is said once, then the line goes away.
const missed = ref(false)
let missedTimer = 0
watch(() => activity.value.failure, failure => {
  window.clearTimeout(missedTimer)
  missed.value = Boolean(failure && failure.kind !== 'stopped' && !props.blocking)
  if (missed.value) missedTimer = window.setTimeout(() => { missed.value = false }, 8000)
})

onBeforeUnmount(() => { unsubscribe(); window.clearTimeout(showTimer); window.clearTimeout(missedTimer) })

const WHAT: Record<string, string> = { character: 'characters', movement: 'characters', hair: 'hair', clothes: 'clothes', street: 'street details', room: 'furniture', photo: 'photo tools' }
const what = computed(() => {
  const names = [...new Set(activity.value.groups.map(group => WHAT[group] ?? 'game files'))]
  return names.length > 2 ? `${names[0]}, ${names[1]} and more` : names.join(' and ')
})
const size = (bytes: number): string => (bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.round(bytes / 1e3)} KB`)
/** A bar is drawn to scale only while bytes are arriving and their total is known. */
const measured = computed(() => activity.value.total !== null && !activity.value.checking)
const amount = computed(() => {
  const { loaded, total, checking } = activity.value
  if (checking) return total === null ? '' : size(total)
  if (total !== null) return `${size(loaded)} of ${size(total)}`
  return loaded > 0 ? `${size(loaded)} so far` : ''
})
const fraction = computed(() => (activity.value.total ? Math.min(1, activity.value.loaded / activity.value.total) : 0))
</script>

<template>
  <div v-if="visible" class="asset-progress" :class="{ blocking }">
    <span class="what">{{ activity.checking ? `Unpacking ${what}…` : `Downloading ${what}` }}</span>
    <div
      class="bar" :class="{ unknown: !measured }" role="progressbar" :aria-label="`Downloading ${what}`" aria-valuemin="0"
      :aria-valuemax="measured ? activity.total ?? undefined : undefined" :aria-valuenow="measured ? activity.loaded : undefined" :aria-valuetext="amount || undefined"
    ><span class="fill" :style="measured ? { transform: `scaleX(${fraction})` } : undefined"></span></div>
    <div class="foot">
      <!-- The bar carries the numbers for a screen reader; read out as text they would interrupt on every update. -->
      <span class="amount num" aria-hidden="true">{{ amount }}</span>
      <button v-if="blocking" class="btn ghost sm" type="button" @click="assetProgress.stopAll()">Stop</button>
    </div>
  </div>
  <p v-else-if="missed" class="asset-missed tiny" role="status">{{ activity.failure?.kind === 'changed' ? 'The game was updated. Reload to get the new version.' : 'Some details did not download. They are tried again the next time they are needed.' }}</p>
</template>

<style scoped>
.asset-progress { display: grid; gap: 6px; width: 100%; min-width: 0; text-align: left; }
.what { font-size: 0.86rem; font-weight: 600; color: var(--ink-2); overflow-wrap: anywhere; }
.bar { height: 6px; border-radius: 999px; background: var(--surface-3); overflow: hidden; }
.fill { display: block; height: 100%; border-radius: inherit; background: var(--accent-text); transform-origin: left center; transition: transform 0.2s ease-out; }
.bar.unknown .fill { width: 40%; animation: asset-slide 1.2s ease-in-out infinite; }
@keyframes asset-slide { from { transform: translateX(-100%); } to { transform: translateX(250%); } }
.foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.amount { font-size: 0.78rem; color: var(--ink-2); }
/* A full-size target that does not make the card taller than its text. */
.blocking .foot .btn { min-height: 44px; margin: -6px -8px -10px 0; }
.asset-missed { margin: 0; color: var(--ink-2); }
@media (prefers-reduced-motion: reduce) {
  .fill { transition: none; }
  .bar.unknown .fill { width: 100%; opacity: 0.45; animation: none; }
}
</style>
