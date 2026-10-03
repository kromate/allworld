<script setup lang="ts">
// Leaving with changes that are not saved. Furniture is saved, or put back as it was; a plan of new
// rooms is kept only once it has been priced and paid for, so leaving drops it. Nothing the member
// has not agreed to ever reaches the room they play in. "Stay" keeps every draft exactly as it is.
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { trapTab } from './focusTrap.ts'

defineProps<{ furniture: boolean; plan: boolean; saving: boolean; error: string; problems: string[] }>()
const emit = defineEmits<{ save: []; discard: []; stay: [] }>()
const dialog = ref<HTMLElement | null>(null)
let returnTo: HTMLElement | null = null
onMounted(() => {
  returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
  void nextTick(() => dialog.value?.focus({ preventScroll: true }))
})
onUnmounted(() => {
  const back = returnTo
  void nextTick(() => { if (back && back.isConnected) back.focus({ preventScroll: true }) })
})
</script>

<template>
  <section ref="dialog" class="sheet" role="alertdialog" aria-modal="true" aria-labelledby="leave-title" tabindex="-1" @keydown="trapTab($event, dialog)">
    <h2 id="leave-title">Leave with changes?</h2>
    <p v-if="furniture" class="small">The furniture you moved or placed is not saved. Until it is, the room you play in keeps the last saved furniture.</p>
    <p v-if="plan" class="small">The rooms you planned are not paid for. They are kept only once you have a price and pay it; leaving drops the plan.</p>
    <ul v-if="problems.length" class="problems" role="alert"><li v-for="problem in problems" :key="problem">{{ problem }}</li></ul>
    <p v-if="error" class="notice coral" role="alert">{{ error }}</p>
    <div class="row wrap">
      <button v-if="furniture" class="btn primary" type="button" :disabled="saving || problems.length > 0" @click="emit('save')">{{ saving ? 'Saving…' : plan ? 'Save furniture, drop the plan' : 'Save and leave' }}</button>
      <button class="btn" type="button" :disabled="saving" @click="emit('discard')">Discard and leave</button>
      <button class="btn" type="button" :disabled="saving" @click="emit('stay')">Stay</button>
    </div>
  </section>
</template>

<style scoped>
.sheet { position: sticky; bottom: -22px; margin: auto -18px -22px; padding: 14px 18px calc(16px + var(--safe-bottom)); display: flex; flex-direction: column; gap: 10px; background: var(--surface); border-top: 2px solid var(--accent-strong); box-shadow: 0 -10px 30px rgba(30, 22, 8, 0.14); max-height: 78%; overflow-y: auto; z-index: 4; }
.sheet:focus { outline: none; }
.sheet h2 { font-size: 1.05rem; }
.problems { margin: 0; padding: 0 0 0 18px; color: var(--danger); font-size: 0.86rem; }
@media (max-width: 720px) { .sheet { bottom: -18px; margin: auto -16px -18px; padding-inline: 16px; } }
@media (max-height: 480px) { .sheet { max-height: 100%; } }
</style>
