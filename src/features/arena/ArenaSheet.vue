<script setup lang="ts">
// A dialog over the hall: a centred card on a wide screen, a bottom sheet on a phone. It keeps
// focus inside while open, closes on Escape or a tap outside, and hands focus back afterwards.
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ title: string; wide?: boolean }>()
const emit = defineEmits<{ close: [] }>()
const card = ref<HTMLElement | null>(null)
let before: HTMLElement | null = null

const focusable = (): HTMLElement[] => [...(card.value?.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])') ?? [])]

// The world behind listens on `window` too (Escape closes the window, digits switch section):
// while a dialog is open its keys stop here.
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return }
  if (event.key === 'Tab') {
    const items = focusable()
    if (!items.length) return
    const first = items[0]!, last = items[items.length - 1]!
    const active = document.activeElement
    if (event.shiftKey && (active === first || !card.value?.contains(active))) { event.preventDefault(); last.focus() }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus() }
    return
  }
  event.stopPropagation()
}

onMounted(() => {
  before = document.activeElement instanceof HTMLElement ? document.activeElement : null
  window.addEventListener('keydown', onKey, true)
  void nextTick(() => card.value?.focus())
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  before?.focus?.()
})
</script>

<template>
  <Teleport to="body">
    <div class="arena-sheet-layer" @click.self="emit('close')">
      <section ref="card" class="arena-sheet" :class="{ wide }" role="dialog" aria-modal="true" :aria-label="title" tabindex="-1">
        <header class="head">
          <h2 class="grow">{{ title }}</h2>
          <button class="btn icon sm close" type="button" aria-label="Close" @click="emit('close')">✕</button>
        </header>
        <div class="body"><slot /></div>
        <footer v-if="$slots.actions" class="foot"><slot name="actions" /></footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.arena-sheet-layer { position: fixed; inset: 0; z-index: 60; display: grid; place-items: center; padding: 16px; background: rgba(28, 26, 36, 0.42); animation: fade 0.15s ease; }
.arena-sheet { width: min(480px, 100%); max-height: min(720px, calc(100dvh - 32px)); display: flex; flex-direction: column; border-radius: 22px; background: var(--bg); box-shadow: var(--shadow-lg); border: 1px solid rgba(255, 255, 255, 0.7); outline: none; animation: rise 0.18s ease; }
.arena-sheet.wide { width: min(640px, 100%); }
.head { display: flex; align-items: center; gap: 10px; padding: 16px 16px 10px 18px; }
.close { border-radius: 50%; background: var(--surface); flex: none; }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 2px 18px 18px; display: flex; flex-direction: column; gap: 14px; }
.foot { display: flex; align-items: center; gap: 10px; padding: 12px 18px calc(14px + var(--safe-bottom)); border-top: 1px solid var(--line); background: var(--surface); border-radius: 0 0 22px 22px; }
@keyframes fade { from { opacity: 0; } }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } }
@media (max-width: 720px) {
  .arena-sheet-layer { place-items: end center; padding: 0; }
  .arena-sheet, .arena-sheet.wide { width: 100%; max-height: calc(100dvh - 40px); border-radius: 22px 22px 0 0; border-bottom: 0; }
  .foot { border-radius: 0; flex-wrap: wrap; }
}
</style>
