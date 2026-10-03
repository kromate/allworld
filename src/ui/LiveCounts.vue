<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { liveCounts, retainLiveCounts } from '../state/liveCounts.ts'
import { COUNTS_SCOPE } from '../shared/liveCounts.ts'
import { useHold } from './gameInput.ts'

const details = ref(false)
const root = ref<HTMLElement | null>(null)
const detailsId = useId()
useHold('shell.counts', () => details.value, { role: 'panel', close: () => { details.value = false } })
function outside(event: PointerEvent): void {
  if (details.value && event.target instanceof Node && !root.value?.contains(event.target)) details.value = false
}
let release: (() => void) | null = null
onMounted(() => { release = retainLiveCounts(); document.addEventListener('pointerdown', outside) })
onUnmounted(() => { release?.(); document.removeEventListener('pointerdown', outside) })
const number = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 })
const label = computed(() => liveCounts.value.kind === 'ready'
  ? `${liveCounts.value.snapshot.totalViews.toLocaleString()} page views, ${liveCounts.value.snapshot.onlinePlayers.toLocaleString()} online players. Show count details.`
  : `World counts ${liveCounts.value.kind === 'loading' ? 'loading' : 'unavailable'}. Show count details.`)
</script>

<template>
  <div ref="root" class="live-counts">
    <button type="button" class="counts-button" :aria-label="label" :aria-expanded="details" :aria-controls="details ? detailsId : undefined" @click="details = !details">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>
      <span>{{ liveCounts.kind === 'ready' ? number.format(liveCounts.snapshot.totalViews) : '—' }}</span>
      <span class="online-dot" :class="{ available: liveCounts.kind === 'ready' }" aria-hidden="true"/>
      <span>{{ liveCounts.kind === 'ready' ? number.format(liveCounts.snapshot.onlinePlayers) : '—' }}</span>
    </button>
    <div v-if="details" :id="detailsId" class="counts-details" role="status">
      <p>{{ COUNTS_SCOPE }}</p>
      <p v-if="liveCounts.kind === 'ready'">{{ liveCounts.snapshot.totalViews.toLocaleString() }} page views since {{ new Date(liveCounts.snapshot.since).toLocaleDateString() }} · {{ liveCounts.snapshot.onlinePlayers.toLocaleString() }} online players. Updated {{ new Date(liveCounts.snapshot.asOf).toLocaleTimeString() }}. Presence expires after 60 seconds; disconnects have up to 15 seconds of grace.</p>
      <p v-else>{{ liveCounts.kind === 'loading' ? 'Loading counts.' : 'Counts are unavailable. No zero is assumed.' }}</p>
    </div>
  </div>
</template>

<style scoped>
.live-counts { position:relative; flex:none; }
.counts-button { display:flex; align-items:center; gap:.32rem; min-height:44px; border:1px solid #ffffff4d; border-radius:16px; padding:.3rem .5rem; color:#f5f7fa; background:rgba(28,26,36,.62); font:inherit; font-size:.72rem; font-weight:650; white-space:nowrap; cursor:pointer; }
.counts-button:focus-visible { outline:2px solid #fff; outline-offset:3px; }
svg { width:1rem; height:1rem; fill:none; stroke:currentColor; stroke-width:1.8; }
.online-dot { width:.4rem; height:.4rem; border-radius:50%; background:#aeb5bf; margin-left:.15rem; }
.online-dot.available { background:#76dc99; }
.counts-details { position:fixed; left:calc(10px + env(safe-area-inset-left, 0px)); top:calc(var(--shell-top) + 8px); width:min(19rem, calc(100vw - 20px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px))); max-height:calc(100dvh - var(--shell-top) - 16px - var(--safe-bottom)); overflow-y:auto; padding:.7rem; border:1px solid #ffffff30; border-radius:.6rem; background:#17202bf5; color:#f5f7fa; font-size:.78rem; line-height:1.45; z-index:20; }
.counts-details p { margin:0; }
.counts-details p + p { margin-top:.5rem; }
</style>
