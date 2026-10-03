<script setup lang="ts">
// A number the member nudges up or down by one: a size, a quantity.
defineProps<{ label: string; value: number; min: number; max: number; unit?: string }>()
defineEmits<{ change: [value: number] }>()
</script>

<template>
  <div class="stepper" role="group" :aria-label="label">
    <span class="label">{{ label }}</span>
    <button class="btn icon sm" type="button" :disabled="value <= min" :aria-label="`${label}: less`" @click="$emit('change', value - 1)">−</button>
    <output class="num value" :aria-label="`${label} ${value}${unit ? ' ' + unit : ''}`">{{ value }}{{ unit ? ` ${unit}` : '' }}</output>
    <button class="btn icon sm" type="button" :disabled="value >= max" :aria-label="`${label}: more`" @click="$emit('change', value + 1)">＋</button>
  </div>
</template>

<style scoped>
.stepper { display: inline-flex; align-items: center; gap: 6px; }
.label { font-size: 0.82rem; font-weight: 650; color: var(--ink-2); min-width: 44px; }
.value { min-width: 44px; text-align: center; font-weight: 700; }
</style>
