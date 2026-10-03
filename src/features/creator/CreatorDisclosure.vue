<script setup lang="ts">
// Said during onboarding, before the connection is made: who the new member will be connected
// to, what that does and does not share, and that it can be removed. Shown only when the service
// has said a verified creator exists, so nobody is told about a connection that will not be made.
import { CREATOR_DISCLOSURE } from '../../shared/creator.ts'

defineProps<{
  /** `CreatorCard.ready`, from the service. */
  ready: boolean
}>()
</script>

<template>
  <p v-if="ready" class="notice sky creator-disclosure">
    <span aria-hidden="true">👋</span>
    <span class="grow">{{ CREATOR_DISCLOSURE }}</span>
  </p>
</template>
