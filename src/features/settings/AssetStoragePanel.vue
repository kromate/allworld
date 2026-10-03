<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ASSET_MANIFEST, ASSET_REVISION, assetDownloads, assetStoreInventory, assetStoreReport, clearAssetStore, subscribeAssetStore } from '../../assets/publicAssets.ts'
import { assetProgress } from '../../assets/assetProgress.ts'
import type { AssetFileReport, AssetStoreReport } from '../../assets/assetStore.ts'
import { app } from '../../state/app.ts'
import { useGameReload } from '../../ui/gameReload.ts'

const report = ref<AssetStoreReport | null>(null)
const files = ref<readonly AssetFileReport[]>([])
const selected = ref<readonly string[]>([])
const queued = ref<readonly string[]>(assetDownloads.queued())
const active = ref<readonly string[]>(assetDownloads.active())
const stopped = ref<readonly string[]>(assetDownloads.stopped())
const activity = ref(assetProgress.activity())
const removing = ref(false)
const removeReady = ref(false)
const refreshing = ref(false)
const notice = ref('')
let disposed = false
let refreshRequested = false
let stopStore = (): void => {}
let stopBatch = (): void => {}
let stopProgress = (): void => {}
const GROUPS: Readonly<Record<string, string>> = { street: 'Streets & scenery', character: 'Characters', movement: 'Movement', hair: 'Hair', clothes: 'Clothes', room: 'Rooms & furniture', photo: 'Photo analysis models (optional)' }
const size = (bytes: number): string => !Number.isFinite(bytes) || bytes < 0 ? 'Size unknown' : bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(1)} KB`
const bytesFor = (paths: readonly string[]): number => paths.reduce((sum, path) => sum + (ASSET_MANIFEST[path]?.bytes ?? 0), 0)
const groups = computed(() => [...new Set(Object.values(ASSET_MANIFEST).map(entry => entry.group))].map(group => ({
  id: group, label: GROUPS[group] ?? group,
  files: files.value.filter(file => ASSET_MANIFEST[file.path]?.group === group),
})))
const kept = computed(() => report.value?.state === 'kept' ? report.value : null)
const missing = computed(() => files.value.filter(file => file.state !== 'cached' && !queued.value.includes(file.path) && file.state !== 'downloading').map(file => file.path))
const selectedMissing = computed(() => selected.value.filter(path => missing.value.includes(path)))
const busy = computed(() => queued.value.length > 0 || active.value.length > 0)
const allBytes = bytesFor(Object.keys(ASSET_MANIFEST))
const needsUpdate = computed(() => app.link === 'update-required' || files.value.some(file => file.failure?.kind === 'changed'))
const unavailable = computed(() => report.value?.state === 'unavailable')
const { blocked: reloadBlocked, reload } = useGameReload()
const name = (path: string): string => path.split('/').at(-1)?.replace('.pack.gz', '').replaceAll('-', ' ') ?? path
function status(file: AssetFileReport): string {
  if (file.state === 'cached') return 'Cached'
  if (queued.value.includes(file.path)) return 'Waiting'
  if (file.state === 'downloading' || active.value.includes(file.path)) return 'Downloading / checking'
  if (stopped.value.includes(file.path) || file.failure?.kind === 'stopped') return 'Stopped'
  if (file.failure?.kind === 'storage') return 'Not saved'
  if (file.state === 'failed') return 'Failed'
  return file.previousVersion ? 'Update available' : 'Missing'
}
function toggle(path: string): void {
  selected.value = selected.value.includes(path) ? selected.value.filter(item => item !== path) : [...selected.value, path]
}
function selectGroup(paths: readonly string[]): void {
  selected.value = [...new Set([...selected.value, ...paths.filter(path => missing.value.includes(path))])]
}
function syncBatch(): void {
  queued.value = assetDownloads.queued()
  active.value = assetDownloads.active()
  stopped.value = assetDownloads.stopped()
  void refresh()
}
async function refresh(): Promise<void> {
  refreshRequested = true
  if (refreshing.value || disposed) return
  refreshing.value = true
  try {
    do {
      refreshRequested = false
      const [nextReport, nextFiles] = await Promise.all([assetStoreReport(), assetStoreInventory()])
      if (disposed) return
      report.value = nextReport
      files.value = nextFiles
    } while (refreshRequested)
  } catch { notice.value = 'Storage could not be checked. Try refreshing the list.' }
  finally { refreshing.value = false }
}
async function download(paths: readonly string[]): Promise<void> {
  if (!paths.length || removing.value || needsUpdate.value) return
  removeReady.value = false
  notice.value = ''
  await assetDownloads.download(paths)
  await refresh()
  if (disposed) return
  notice.value = 'Batch finished. Check each pack below: failed or unsaved packs can be retried.'
}
async function remove(): Promise<void> {
  if (busy.value || activity.value.active > 0 || removing.value) return
  removing.value = true
  try {
    const removed = await clearAssetStore()
    removeReady.value = false
    await refresh()
    notice.value = removed ? 'Downloaded packs removed. They download again when needed.' : 'No cache was removed. Refresh the list to check this browser’s storage.'
  } finally { removing.value = false }
}
onMounted(() => {
  stopStore = subscribeAssetStore(() => { void refresh() })
  stopBatch = assetDownloads.subscribe(syncBatch)
  stopProgress = assetProgress.subscribe(next => { activity.value = next })
  void refresh()
})
onUnmounted(() => { disposed = true; stopStore(); stopBatch(); stopProgress() })
</script>

<template>
  <div class="downloads stack">
    <p class="small">Download packs now to avoid fetching them during later visits. This build has {{ Object.keys(ASSET_MANIFEST).length }} packs · {{ size(allBytes) }} compressed in total. Opening this screen does not download packs.</p>
    <p class="small muted">The game world still needs a connection for streets, people, chat and saved progress. These packs contain public game files and analysis models, never your photos, face crops, landmarks, account or messages.</p>
    <div v-if="needsUpdate" class="notice amber" role="status">
      <p>The game was updated. Reload before downloading this build’s packs. Save changes or copy unsaved text first.</p>
      <p v-if="reloadBlocked" class="small" role="status">{{ reloadBlocked }}</p>
      <button class="btn sm" type="button" :disabled="Boolean(reloadBlocked)" @click="reload">Reload to update</button>
    </div>
    <p v-else class="tiny muted">Build {{ ASSET_REVISION }}. Update notices use the game’s connection and file checks; this screen does not check for a new release separately.</p>
    <p v-if="unavailable" class="notice amber" role="status">This browser cannot keep packs between visits. Downloading them here will not prepare storage. The game can still load files when needed.</p>
    <dl v-if="kept" class="facts">
      <dt>Saved in this browser</dt><dd>{{ kept.files }} packs · {{ size(kept.bytes) }}</dd>
      <dt>Game cache limit</dt><dd>48 MiB ({{ size(kept.limit) }})</dd>
      <dt>Browser free-space estimate</dt><dd>{{ kept.free === null ? 'Not available' : `About ${size(kept.free)}` }}</dd>
    </dl>
    <p v-if="kept?.declined" class="notice amber" role="status">{{ kept.declined }} files could not be saved this visit because storage was full or unavailable. A completed download can still be missing below. Free space, then retry.</p>
    <div class="batch-actions">
      <button class="btn primary" type="button" :disabled="!selectedMissing.length || unavailable || needsUpdate || removing" @click="download(selectedMissing)">Download selected · {{ size(bytesFor(selectedMissing)) }}</button>
      <button class="btn" type="button" :disabled="!missing.length || unavailable || needsUpdate || removing" @click="download(missing)">Download all missing · {{ size(bytesFor(missing)) }}</button>
      <button v-if="busy" class="btn" type="button" @click="assetDownloads.cancel()">Cancel batch</button>
      <button class="btn ghost sm" type="button" :disabled="refreshing" @click="refresh">{{ refreshing ? 'Checking storage…' : 'Refresh list' }}</button>
    </div>
    <p class="tiny muted">Sizes are compressed estimates from this build. The browser may expand files while receiving them. Packs stopped part-way restart from the beginning; completed packs are reused. Downloads keep running if you close this screen. Cancelling the batch leaves packs needed by the live world loading.</p>
    <p v-if="busy" class="small" role="status">{{ active.length }} loading · {{ queued.length }} waiting. {{ activity.checking ? 'Checking received files…' : `${size(activity.loaded)} received in the current game download burst` }}.</p>
    <p v-if="notice" class="small" role="status">{{ notice }}</p>
    <p v-if="!report" class="small" role="status">Checking saved packs…</p>
    <details v-for="group in groups" :key="group.id" class="pack-group" :open="group.id === 'street'">
      <summary><strong>{{ group.label }}</strong><span class="tiny muted">{{ group.files.filter(file => file.state === 'cached').length }}/{{ group.files.length }} cached · {{ size(bytesFor(group.files.map(file => file.path))) }}</span></summary>
      <button class="btn ghost sm group-select" type="button" :disabled="busy || unavailable" @click="selectGroup(group.files.map(file => file.path))">Select missing in this category</button>
      <ul class="pack-list">
        <li v-for="file in group.files" :key="file.path" class="pack">
          <label class="pack-choice"><input type="checkbox" :checked="selected.includes(file.path)" :disabled="file.state === 'cached' || file.state === 'downloading' || queued.includes(file.path) || unavailable" @change="toggle(file.path)" /><span><strong>{{ name(file.path) }}</strong><span class="tiny muted pack-path">{{ file.path }}</span></span></label>
          <div class="pack-meta"><span class="tiny">{{ size(ASSET_MANIFEST[file.path]?.bytes ?? Number.NaN) }} compressed · {{ status(file) }}</span><button v-if="queued.includes(file.path) || active.includes(file.path)" class="btn ghost sm" type="button" @click="assetDownloads.cancel([file.path])">Cancel</button><button v-else-if="file.state !== 'cached'" class="btn sm" type="button" :disabled="unavailable || needsUpdate || removing || file.state === 'downloading'" @click="download([file.path])">{{ status(file) === 'Stopped' ? 'Resume' : file.state === 'failed' ? 'Retry' : 'Download' }}</button></div>
          <p v-if="file.failure && file.state !== 'cached'" class="tiny failure">{{ file.failure.message }}</p>
          <details class="pack-version"><summary class="tiny muted">Exact version</summary><code>{{ ASSET_MANIFEST[file.path]?.sha256 }}</code></details>
        </li>
      </ul>
    </details>
    <div class="storage-clear">
      <p class="small muted">Remove only this game’s downloaded packs. Your character, photos and progress are kept. The browser may also evict packs on its own when space is low.</p>
      <button v-if="!removeReady" class="btn sm" type="button" :disabled="busy || activity.active > 0 || !kept?.files || removing" @click="removeReady = true">Remove downloaded packs…</button>
      <div v-else class="row wrap"><button class="btn sm" type="button" :disabled="busy || activity.active > 0 || removing" @click="remove">{{ removing ? 'Removing…' : `Remove ${kept?.files ?? 0} packs` }}</button><button class="btn ghost sm" type="button" :disabled="removing" @click="removeReady = false">Keep packs</button></div>
      <p v-if="busy || activity.active > 0" class="tiny muted">Finish or cancel downloads before clearing storage.</p>
    </div>
  </div>
</template>

<style scoped>
.downloads { min-width: 0; }
.facts { display: grid; grid-template-columns: minmax(0, auto) minmax(0, 1fr); gap: 6px 14px; margin: 0; font-size: 0.9rem; }
.facts dt { color: var(--ink-2); font-weight: 600; }
.facts dd { margin: 0; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
.batch-actions { display: flex; flex-wrap: wrap; gap: 8px; }
.batch-actions .btn { white-space: normal; text-align: left; min-height: 44px; }
.pack-group { border-top: 1px solid var(--line); padding-top: 12px; }
.pack-group > summary { cursor: pointer; min-height: 44px; display: flex; flex-wrap: wrap; justify-content: space-between; gap: 4px 12px; align-items: center; }
.group-select { margin: 4px 0 10px; min-height: 44px; }
.pack-list { margin: 0; padding: 0; list-style: none; }
.pack { padding: 12px 0; border-top: 1px solid var(--line); min-width: 0; }
.pack-choice { display: flex; align-items: flex-start; gap: 10px; cursor: pointer; overflow-wrap: anywhere; }
.pack-choice input { width: 20px; height: 20px; flex: none; margin: 2px 0; accent-color: var(--accent); }
.pack-choice > span { min-width: 0; }
.pack-path { display: block; }
.pack-meta { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 6px; margin: 8px 0 0 30px; font-variant-numeric: tabular-nums; }
.pack-meta .btn { min-height: 44px; }
.pack-version { margin: 8px 0 0 30px; }
.pack-version summary { cursor: pointer; padding: 4px 0; }
.pack-version code { display: block; overflow-wrap: anywhere; font-size: 0.75rem; user-select: all; }
.failure { margin: 8px 0 0 30px; color: var(--ink-2); }
.storage-clear { border-top: 1px solid var(--line); padding-top: 14px; }
@media (max-width: 420px) { .facts { grid-template-columns: minmax(0, 1fr); gap: 2px; } .facts dd + dt { margin-top: 8px; } .batch-actions { flex-direction: column; align-items: stretch; } }
</style>
