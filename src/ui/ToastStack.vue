<script setup lang="ts">
import { app, dismissToast } from '../state/app.ts'
</script>

<template>
  <div v-if="app.toasts.length" class="toast-stack" aria-live="polite">
    <div v-for="item in app.toasts" :key="item.id" class="toast" :class="item.tone" role="status">
      <span class="grow">{{ item.text }}</span>
      <button v-if="item.action" class="btn sm" type="button" @click="item.action.run(); dismissToast(item.id)">{{ item.action.label }}</button>
      <button class="btn ghost icon sm" type="button" aria-label="Dismiss" @click="dismissToast(item.id)">✕</button>
    </div>
  </div>
</template>

<style scoped>
.toast-stack { display: grid; gap: 8px; }
.toast { pointer-events: auto; display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 14px; border-radius: 14px; background: var(--ink); color: #fff; box-shadow: var(--shadow); font-size: 0.9rem; }
.toast.good { background: #1f6b46; }
.toast.bad { background: #a5301e; }
.toast .btn { color: var(--ink); }
.toast .btn.ghost { color: #fff; }
</style>
