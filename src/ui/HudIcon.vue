<script setup lang="ts">
// The one icon set for the gameplay HUD and the menu: original line drawings on a 24 px grid, one
// stroke weight, round caps. Decorative by default (the control that holds it carries the name).
// Shapes are written as small tokens so the set stays one readable table:
//   "c:cx,cy,r"  a circle     "d:cx,cy"  a filled dot     anything else  a path.
import { computed } from 'vue'
import { SHAPES } from './hudIcons.ts'
import type { HudIconName } from './hudIcons.ts'


const props = withDefaults(defineProps<{ name: HudIconName; size?: number; strokeWidth?: number }>(), { size: 22, strokeWidth: 1.8 })
const shapes = computed(() => SHAPES[props.name].map(token => {
  if (token.startsWith('c:')) { const [cx, cy, r] = token.slice(2).split(',').map(Number); return { kind: 'c' as const, cx, cy, r } }
  if (token.startsWith('d:')) { const [cx, cy] = token.slice(2).split(',').map(Number); return { kind: 'd' as const, cx, cy, r: 1.15 } }
  return { kind: 'p' as const, d: token }
}))
</script>

<template>
  <svg class="hud-icon" :width="size" :height="size" viewBox="0 0 24 24" fill="none" stroke="currentColor" :stroke-width="strokeWidth" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
    <template v-for="(shape, index) in shapes" :key="index">
      <circle v-if="shape.kind === 'c'" :cx="shape.cx" :cy="shape.cy" :r="shape.r" />
      <circle v-else-if="shape.kind === 'd'" :cx="shape.cx" :cy="shape.cy" :r="shape.r" fill="currentColor" stroke="none" />
      <path v-else :d="shape.d" />
    </template>
  </svg>
</template>

<style scoped>
.hud-icon { flex: none; display: block; }
</style>
