<script setup lang="ts">
// One place for the non-happy states of a list or page: loading, failed (with retry), empty.
defineProps<{ state: 'loading' | 'error' | 'empty'; message?: string; art?: string; title?: string }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="state === 'loading'" class="stack" role="status" aria-label="Loading">
    <div class="skeleton" style="height: 58px"></div>
    <div class="skeleton" style="height: 58px"></div>
    <div class="skeleton" style="height: 58px; width: 80%"></div>
  </div>
  <div v-else-if="state === 'error'" class="notice coral" role="alert">
    <div class="grow">
      <strong>That did not load.</strong>
      <div>{{ message || 'Check your connection and try again.' }}</div>
    </div>
    <button class="btn sm" type="button" @click="$emit('retry')">Try again</button>
  </div>
  <div v-else class="empty">
    <div class="art" aria-hidden="true">{{ art || '✨' }}</div>
    <h3 v-if="title">{{ title }}</h3>
    <p class="small">{{ message }}</p>
    <slot />
  </div>
</template>
