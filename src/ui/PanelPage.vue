<script setup lang="ts">
// Frame for every page that opens beside the world: title, optional back link, close, body.
// On a phone a page that works on the scene is a half-height sheet; its header carries the button
// that grows it to full height and back.
import { inject } from 'vue'
import { useRouter } from 'vue-router'
import { SHEET } from './shell.ts'
import ToastStack from './ToastStack.vue'

defineProps<{ title: string; subtitle?: string; back?: string; wide?: boolean }>()
const router = useRouter()
const sheet = inject(SHEET, null)
</script>

<template>
  <section class="panel-page" :class="{ wide, sheet: sheet?.half.value }" :aria-label="title">
    <header class="panel-head">
      <button v-if="back" class="btn ghost icon sm" type="button" aria-label="Back" @click="router.push(back)">←</button>
      <div class="grow">
        <h1>{{ title }}</h1>
        <p v-if="subtitle" class="muted small subtitle">{{ subtitle }}</p>
      </div>
      <slot name="actions" />
      <button
        v-if="sheet?.capable.value" class="btn icon sm round" type="button" :aria-pressed="!sheet.half.value"
        :aria-label="sheet.half.value ? 'Make this page full height' : 'Shrink this page to show the world'" :title="sheet.half.value ? 'Full height' : 'Show the world'" @click="sheet.toggle()"
      >{{ sheet.half.value ? '⤢' : '⤡' }}</button>
      <button class="btn icon sm round close" type="button" aria-label="Close and return to the world" title="Close (Esc)" @click="router.push('/')">✕</button>
    </header>
    <ToastStack class="panel-notices" />
    <div class="panel-body"><slot /></div>
  </section>
</template>

<style scoped>
.panel-page { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.panel-head { display: flex; align-items: flex-start; gap: 10px; padding: 18px 18px 12px; }
.panel-head h1 { font-size: 1.35rem; }
.round { border-radius: 50%; background: var(--surface); flex: none; }
.panel-notices { display: none; }
.panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 4px 18px calc(22px + var(--safe-bottom)); display: flex; flex-direction: column; gap: 14px; }
/* Content scrolls; it must never be squeezed to fit. */
.panel-body > :deep(*) { flex-shrink: 0; }

@media (max-width: 720px) {
  /* The section bar is under the page, so the safe area is already spoken for. */
  .panel-head { align-items: center; gap: 8px; padding: 10px 12px 8px 16px; }
  .panel-head h1 { font-size: 1.2rem; overflow-wrap: anywhere; }
  .subtitle { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .panel-body { padding: 4px 16px 18px; gap: 12px; }
  .panel-notices { display: grid; flex: none; margin: 0 16px 8px; max-height: 28vh; overflow-y: auto; }
  .sheet .panel-notices { display: none; }
  /* Half height: the title alone, so what the sheet is for gets the room. */
  .sheet .panel-head { padding-top: 8px; padding-bottom: 6px; }
  .sheet .panel-head h1 { font-size: 1.05rem; }
  .sheet .subtitle { display: none; }
  .sheet .panel-body { gap: 10px; padding-bottom: 12px; }
}
</style>
