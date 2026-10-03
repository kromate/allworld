<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, shallowRef, watch } from 'vue'
import type { DriverIntent } from './transportView.ts'
import { STOPPED_INPUT } from './transportView.ts'
const props = defineProps<{ enabled: boolean }>()
const emit = defineEmits<{ input: [intent: DriverIntent] }>()
type Direction = 'forward' | 'backward' | 'left' | 'right' | 'brake'
interface PointerHold { direction: Direction; target: HTMLElement }
const pointers = shallowRef<ReadonlyMap<number, PointerHold>>(new Map())
const keyboard = shallowRef<ReadonlyMap<string, Direction>>(new Map())
const held = computed(() => new Set([...pointers.value.values()].map(item => item.direction).concat([...keyboard.value.values()])))
const keys: Record<string, Direction | undefined> = { w: 'forward', ArrowUp: 'forward', s: 'backward', ArrowDown: 'backward', a: 'left', ArrowLeft: 'left', d: 'right', ArrowRight: 'right', ' ': 'brake' }
const intent = computed<DriverIntent>(() => {
  const forward = held.value.has('forward'), backward = held.value.has('backward')
  const brake = held.value.has('brake') || (forward && backward) || !held.value.size
  return {
    throttle: brake || forward === backward ? 0 : forward ? 1 : -1,
    steer: held.value.has('left') === held.value.has('right') ? 0 : held.value.has('left') ? -1 : 1,
    brake,
  }
})
const mode = computed(() => !held.value.size ? 'Stopped' : intent.value.brake ? 'Braking' : intent.value.throttle < 0 ? 'Reversing' : intent.value.throttle > 0 ? 'Accelerating' : 'Coasting')
const labels: Record<Direction, string> = { left: 'Steer left', forward: 'Accelerate', brake: 'Brake', backward: 'Reverse', right: 'Steer right' }
const groups: readonly (readonly Direction[])[] = [['left', 'right'], ['forward', 'brake', 'backward']]
const shapes: Record<Direction, string> = { left: 'M15 5l-7 7 7 7', right: 'M9 5l7 7-7 7', forward: 'M6 14l6-7 6 7M12 7v13', backward: 'M6 10l6 7 6-7M12 4v13', brake: 'M7 4h10l3 3v10l-3 3H7l-3-3V7zM9 9v6M15 9v6' }
let resetting = false
watch(intent, next => { if (!resetting) emit('input', props.enabled ? next : STOPPED_INPUT) }, { flush: 'sync' })
function uncapture(pointerId: number, target: HTMLElement): void {
  try { if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId) } catch { /* The browser may already have released it. */ }
}
function release(): void {
  const captures = [...pointers.value]
  resetting = true
  pointers.value = new Map()
  keyboard.value = new Map()
  resetting = false
  for (const [id, item] of captures) uncapture(id, item.target)
  emit('input', STOPPED_INPUT)
}
watch(() => props.enabled, enabled => { if (!enabled) release() }, { immediate: true, flush: 'sync' })
function keyHold(event: KeyboardEvent, direction: Direction, down: boolean, activation = false): void {
  if (!props.enabled && down) return
  const source = `${activation ? `button:${direction}` : 'key'}:${event.code || event.key.toLowerCase()}`
  if (down === keyboard.value.has(source)) return
  const next = new Map(keyboard.value)
  if (down) next.set(source, direction); else next.delete(source)
  keyboard.value = next
}
function key(event: KeyboardEvent, down: boolean): void {
  const direction = keys[event.key.length === 1 ? event.key.toLowerCase() : event.key]
  if (!direction || (down && (event.metaKey || event.ctrlKey || event.altKey || event.isComposing))) return
  event.preventDefault(); event.stopPropagation(); keyHold(event, direction, down)
}
function pointer(event: PointerEvent, direction: Direction): void {
  if (!props.enabled || pointers.value.has(event.pointerId) || (event.pointerType === 'mouse' && event.button !== 0) || !(event.currentTarget instanceof HTMLElement)) return
  const target = event.currentTarget
  try { target.setPointerCapture(event.pointerId) } catch { return }
  const next = new Map(pointers.value)
  next.set(event.pointerId, { direction, target })
  pointers.value = next
}
function pointerEnd(event: PointerEvent): void {
  const item = pointers.value.get(event.pointerId)
  if (!item || item.target !== event.currentTarget) return
  const next = new Map(pointers.value)
  next.delete(event.pointerId)
  pointers.value = next
  uncapture(event.pointerId, item.target)
}
function focusOut(event: FocusEvent): void {
  if (!(event.currentTarget instanceof HTMLElement) || !(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) release()
}
const visibility = (): void => { if (document.hidden) release() }
onMounted(() => {
  window.addEventListener('blur', release)
  window.addEventListener('pagehide', release)
  window.addEventListener('orientationchange', release)
  document.addEventListener('visibilitychange', visibility)
})
onBeforeUnmount(() => {
  window.removeEventListener('blur', release)
  window.removeEventListener('pagehide', release)
  window.removeEventListener('orientationchange', release)
  document.removeEventListener('visibilitychange', visibility)
  release()
})
</script>

<template>
  <div class="driver-controls" :data-drive-mode="mode" role="group" aria-label="Driver controls" tabindex="0" @keydown="key($event, true)" @keyup="key($event, false)" @focusout="focusOut">
    <span class="sr-only" aria-live="polite">{{ mode }}</span>
    <div class="driver-pad">
      <div v-for="(group, index) in groups" :key="index" class="driver-zone" :class="index === 0 ? 'steering' : 'pedals'" role="group" :aria-label="index === 0 ? 'Steering' : 'Pedals'">
        <button v-for="direction in group" :key="direction" type="button" class="drive-key" :class="[direction, { held: held.has(direction) }]" :data-driver-action="direction" :disabled="!enabled" :aria-label="labels[direction]" :aria-pressed="held.has(direction)" @pointerdown.prevent="pointer($event, direction)" @pointerup="pointerEnd" @pointercancel="pointerEnd" @lostpointercapture="pointerEnd" @keydown.enter.stop.prevent="keyHold($event, direction, true, true)" @keyup.enter.stop.prevent="keyHold($event, direction, false, true)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="shapes[direction]" /></svg>
          <span v-if="direction === 'forward'">Go</span><span v-else-if="direction === 'brake'">Brake</span><span v-else-if="direction === 'backward'">Rev</span>
        </button>
      </div>
    </div>
    <p class="driver-help">WASD / arrows · Space brakes</p>
  </div>
</template>

<style scoped>
.driver-controls { display: grid; gap: 4px; min-width: 0; max-width: 100%; padding: 8px; box-sizing: border-box; border: 1px solid var(--line-strong); border-radius: 16px; background: var(--surface); color: var(--ink); }
.driver-pad { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); gap: 12px; min-width: 0; }
.driver-zone { display: grid; gap: 4px; min-width: 0; }.steering { grid-template-columns: repeat(2, minmax(44px, 1fr)); }.pedals { grid-template-columns: repeat(3, minmax(44px, 1fr)); }
.drive-key { display: grid; justify-items: center; align-content: center; gap: 2px; width: 100%; min-width: 44px; min-height: 56px; padding: 4px 2px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface-2); color: var(--ink); touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; font-size: .68rem; font-weight: 650; }
.drive-key svg { width: 24px; height: 24px; pointer-events: none; }.drive-key span { pointer-events: none; }.drive-key:hover:not(:disabled) { background: var(--surface-3); }.drive-key:disabled { opacity: .45; cursor: not-allowed; }.drive-key.held { background: var(--accent); color: var(--accent-ink); border-color: var(--accent-strong); }.drive-key.brake.held { background: var(--coral-soft); color: var(--danger); border-color: var(--coral); }.drive-key.backward.held { background: var(--sky-soft); color: var(--ink); border-color: var(--sky); }
.driver-help { margin: 0; font-size: .68rem; color: var(--ink-2); }
@media (hover: none) and (pointer: coarse) { .driver-help { display: none; } }
@media (max-height: 420px) { .driver-controls { padding: 6px; }.drive-key { min-height: 52px; }.driver-help { display: none; } }
</style>
