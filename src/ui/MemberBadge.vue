<script setup lang="ts">
import { computed } from 'vue'
import type { MemberId } from '../shared/ids.ts'
import type { AvatarLook } from '../shared/model.ts'
import AvatarPortrait from '../features/avatar/AvatarPortrait.vue'

const props = defineProps<{ look: AvatarLook; memberId?: MemberId; size?: number; online?: boolean }>()
const px = computed(() => props.size ?? 40)
</script>

<template>
  <span class="badge" :style="{ width: `${px}px`, height: `${px}px` }">
    <AvatarPortrait :look="look" :member-id="memberId" :size="px" alt="" />
    <span v-if="online" class="dot" title="Online now"></span>
  </span>
</template>

<style scoped>
.badge { position: relative; display: inline-block; flex: none; border-radius: 32%; }
.badge :deep(img) { display: block; border-radius: 32%; object-fit: cover; background: #23202c; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 2px 6px rgba(0, 0, 0, 0.18); }
.dot { position: absolute; right: -2px; bottom: -2px; width: 11px; height: 11px; border-radius: 50%; background: var(--leaf); border: 2px solid var(--surface); }
</style>
