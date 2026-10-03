<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import HudIcon from './HudIcon.vue'
import { fullscreenAvailable, inFullscreen, toggleFullscreen } from './hudDevice.ts'

const available = ref(false)
const full = ref(false)
const busy = ref(false)
const help = ref(false)
const message = ref('')
const sync = (): void => {
  available.value = fullscreenAvailable(document)
  full.value = inFullscreen(document)
}
const changed = (): void => { sync(); message.value = ''; help.value = false }
const failed = (): void => { sync(); message.value = 'Full screen was not allowed. You can keep playing here or try again.' }
async function toggle(): Promise<void> {
  if (busy.value) return
  sync()
  message.value = ''
  if (!available.value && !full.value) { help.value = !help.value; return }
  busy.value = true
  // No awaited work before this call: keep the button's transient user activation.
  const result = await toggleFullscreen(document)
  busy.value = false
  sync()
  if (result === 'refused') failed()
  else if (result === 'unsupported') help.value = true
}
onMounted(() => {
  sync()
  document.addEventListener('fullscreenchange', changed)
  document.addEventListener('webkitfullscreenchange', changed)
  document.addEventListener('fullscreenerror', failed)
  document.addEventListener('webkitfullscreenerror', failed)
})
onBeforeUnmount(() => {
  document.removeEventListener('fullscreenchange', changed)
  document.removeEventListener('webkitfullscreenchange', changed)
  document.removeEventListener('fullscreenerror', failed)
  document.removeEventListener('webkitfullscreenerror', failed)
})
</script>

<template>
  <div class="fullscreen-control">
    <button class="btn fullscreen-button" type="button" :disabled="busy"
      :aria-pressed="available || full ? full : undefined" :aria-expanded="!available && !full ? help : undefined" @click="toggle">
      <HudIcon :name="full ? 'fullscreen-exit' : 'fullscreen'" :size="20" />
      {{ full ? 'Exit full screen' : available ? 'Enter full screen' : 'Full screen options' }}
    </button>
    <p v-if="message" class="small" role="status">{{ message }}</p>
    <p v-if="help" class="small fullscreen-help">
      This browser does not offer full screen here. You can keep playing in this view.
      On iPhone, open this site in Safari, choose Share → Add to Home Screen, then Open as Web App if shown.
      <a href="https://support.apple.com/guide/iphone/iphea86e5236/ios" target="_blank" rel="noopener noreferrer">Home Screen help</a>
    </p>
  </div>
</template>

<style scoped>
.fullscreen-control { min-width: 0; display: grid; gap: 8px; margin-bottom: 8px; }
.fullscreen-button { width: 100%; min-height: 44px; min-width: 44px; white-space: normal; }
.fullscreen-button :deep(svg) { flex: none; }
.fullscreen-help { overflow-wrap: anywhere; }
.fullscreen-help a { display: inline-flex; align-items: center; min-height: 44px; }
</style>
