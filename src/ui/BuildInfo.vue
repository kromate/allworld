<script setup lang="ts">
import { brand } from '../brand.ts'
import { assetRevision, buildInfo, checkBuild, pageBuild } from '../platform/buildInfo.ts'
</script>
<template>
  <div class="build-info stack tight">
    <strong>{{ brand.name }} · v{{ brand.version }}</strong>
    <span class="muted small">This page: <code>{{ pageBuild?.id ?? 'Build ID unavailable' }}</code></span>
    <span class="muted tiny">Game files: <code>{{ assetRevision.slice(0, 12) }}</code></span>
    <template v-if="pageBuild">
      <span v-if="buildInfo.latest && buildInfo.latest.id !== pageBuild.id" class="small" role="status">Update {{ buildInfo.latest.id }} is ready. Close this window and reload when you have finished.</span>
      <span v-else-if="buildInfo.unavailable" class="muted small" role="status">Could not check for an update. Your current game stays open.</span>
      <span v-else-if="buildInfo.checked" class="muted small" role="status">This page matches the server build.</span>
      <button class="btn ghost sm" type="button" :disabled="buildInfo.checking" @click="checkBuild">{{ buildInfo.checking ? 'Checking…' : 'Check for updates' }}</button>
    </template>
  </div>
</template>
<style scoped>
.build-info { overflow-wrap: anywhere; }
code { font-size: 0.9em; }
.btn { align-self: flex-start; }
</style>
