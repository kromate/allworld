<script setup lang="ts">
// The mark beside the creator's name. It is shown for the one member the service marked
// `verified: 'creator'` and for nobody else: a display name never earns it.
import { brand } from '../../brand.ts'
import { isCreator } from './creatorView.ts'

defineProps<{
  member: { verified?: 'creator' } | null | undefined
  /** Just the mark, where there is no room for the word (a list row). The words stay for a screen reader. */
  compact?: boolean
}>()
</script>

<template>
  <span v-if="isCreator(member)" class="chip creator" :class="{ compact }" :title="`Verified: the creator of ${brand.name}`">
    <span aria-hidden="true">✓</span>
    <span :class="{ 'sr-only': compact }">Creator</span>
    <span class="sr-only">of {{ brand.name }}, verified</span>
  </span>
</template>

<style scoped>
.creator { background: var(--grape-soft); color: #5a43ad; flex: none; }
.creator.compact { padding: 2px 6px; }
</style>
