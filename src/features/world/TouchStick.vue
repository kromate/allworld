<script setup lang="ts">
// The thumb pad at the lower left of a touch screen. It is a quiet ring until touched. The rules for
// letting go live in touchStick.ts; this draws the pad, hands it the pointer events, and tells it
// to release when it is disabled, when the page loses focus or is hidden, when the phone is turned,
// and when it leaves the screen. Walking has keyboard and pointer routes as well (WASD, a tap on the
// ground, the places list), which is why the pad itself is hidden from assistive technology.
import { onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { getEngine } from '../../state/world.ts'
import { createStick, releaseOnLoss } from './touchStick.ts'
import type { StickView } from './touchStick.ts'

const props = defineProps<{ disabled?: boolean }>()
const view = reactive<StickView>({ x: 0, y: 0, active: false })
const pad = ref<HTMLElement | null>(null)
const stick = createStick((x, z) => getEngine()?.setJoystick(x, z), next => { view.x = next.x; view.y = next.y; view.active = next.active })
let stopWatching: (() => void) | null = null

function down(event: PointerEvent): void {
  if (props.disabled || !pad.value) return
  const box = pad.value.getBoundingClientRect()
  if (!stick.start(event.pointerId, event.clientX, event.clientY, { left: box.left, top: box.top, width: box.width, height: box.height })) return
  try { pad.value.setPointerCapture(event.pointerId) } catch { stick.release() }
}
const move = (event: PointerEvent): void => stick.move(event.pointerId, event.clientX, event.clientY)
const up = (event: PointerEvent): void => stick.end(event.pointerId)

watch(() => props.disabled, off => { if (off) stick.release() })
onMounted(() => { stopWatching = releaseOnLoss(stick, { window, document, orientation: screen.orientation ?? null }) })
onBeforeUnmount(() => { stopWatching?.(); stopWatching = null; stick.release() })
</script>

<template>
  <div ref="pad" class="stick" :class="{ held: view.active, off: disabled }" aria-hidden="true" @pointerdown.prevent="down" @pointermove="move" @pointerup="up" @pointercancel="up" @lostpointercapture="up">
    <span class="knob" :style="{ '--kx': view.x, '--ky': view.y }"></span>
  </div>
</template>

<style scoped>
.stick { --size: clamp(92px, 26vh, 124px); --travel: calc(var(--size) * 0.29); position: relative; width: var(--size); height: var(--size); border-radius: 50%; display: grid; place-items: center; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; background: rgba(28, 26, 36, 0.28); border: 1.5px solid rgba(255, 255, 255, 0.5); box-shadow: 0 2px 10px rgba(20, 14, 6, 0.18); transition: background 0.15s ease; }
.stick.held { background: rgba(28, 26, 36, 0.4); }
.stick.off { opacity: 0.4; pointer-events: none; }
.knob { width: 42%; height: 42%; border-radius: 50%; background: rgba(255, 176, 32, 0.92); box-shadow: 0 2px 6px rgba(0, 0, 0, 0.3); transform: translate(calc(var(--kx, 0) * var(--travel)), calc(var(--ky, 0) * var(--travel))); }
.stick:not(.held) .knob { transition: transform 0.12s ease-out; }
</style>
