<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { DownloadEntry } from '../../platform/downloadEntry.ts'
import { configureBuildBase } from '../../platform/buildInfo.ts'
import { assetDownloads, configureAssetBase } from '../../assets/publicAssets.ts'
import BuildInfo from '../../ui/BuildInfo.vue'
import DownloadsPage from './DownloadsPage.vue'
import { provideGameReload } from '../../ui/gameReload.ts'

const props = defineProps<{ entry: DownloadEntry }>()
configureAssetBase(props.entry.basePath)
configureBuildBase(props.entry.basePath)
provideGameReload()
const router = useRouter()
const confirming = ref(false)
const stay = ref<HTMLButtonElement | null>(null)
const busy = (): boolean => assetDownloads.queued().length > 0 || assetDownloads.active().length > 0
function leave(): void {
  // Leaving this anonymous root re-enters the native permission boundary, rather than booting a world here.
  location.assign(props.entry.playHref)
}
const stopNavigation = router.beforeEach(to => {
  if (to.path === '/downloads' || to.path === '/downloads/') return true
  // A page change ends running downloads, so a running batch is only left by choice.
  if (busy()) { confirming.value = true; void nextTick(() => stay.value?.focus()); return false }
  leave()
  return false
})
const stopBatch = assetDownloads.subscribe(() => { if (confirming.value && !busy()) confirming.value = false })
onBeforeUnmount(() => { stopNavigation(); stopBatch() })
</script>

<template>
  <main class="public-downloads">
    <div class="public-build tiny muted"><p>Public game assets</p><BuildInfo /></div>
    <div v-if="confirming" class="notice amber leave" role="alert">
      <p>Downloads are still running. Leaving this page stops them. Finished packs stay saved; stopped packs start again from the beginning.</p>
      <div class="row wrap">
        <button ref="stay" class="btn sm primary" type="button" @click="confirming = false">Stay and keep downloading</button>
        <button class="btn sm" type="button" @click="leave">Leave and stop downloads</button>
      </div>
    </div>
    <DownloadsPage />
  </main>
</template>

<style scoped>
.public-downloads { height: 100dvh; display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.public-downloads .leave { flex-direction: column; margin: 8px max(16px, env(safe-area-inset-right, 0px)) 0 max(16px, env(safe-area-inset-left, 0px)); }
.public-downloads :deep(.panel-page) { flex: 1; }
.public-build { padding: calc(8px + env(safe-area-inset-top, 0px)) max(18px, env(safe-area-inset-right, 0px)) 0 max(18px, env(safe-area-inset-left, 0px)); }
.public-downloads :deep(.panel-head) { padding-right: max(12px, env(safe-area-inset-right, 0px)); padding-left: max(16px, env(safe-area-inset-left, 0px)); }
.public-downloads :deep(.panel-body) { padding-right: max(16px, env(safe-area-inset-right, 0px)); padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-bottom: calc(18px + env(safe-area-inset-bottom, 0px)); }
</style>
