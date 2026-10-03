<script setup lang="ts">
import { MONK_TONES } from './skinTones.ts'
defineProps<{ modelValue: string | null; measured?: string | null }>()
const emit = defineEmits<{ 'update:modelValue': [tone: string] }>()
function custom(event: Event): void { if (event.target instanceof HTMLInputElement) emit('update:modelValue', event.target.value.toLowerCase()) }
</script>
<template>
  <div class="tone-picker stack tight">
    <div class="tones" role="radiogroup" aria-label="Confirm skin tone">
      <button v-for="(tone, index) in MONK_TONES" :key="tone" type="button" role="radio" :aria-checked="modelValue?.toLowerCase() === tone" :aria-label="`Monk skin tone ${index + 1}`" :style="{ background: tone }" @click="emit('update:modelValue', tone)"><span>{{ index + 1 }}</span></button>
    </div>
    <div class="tone-options">
      <button v-if="measured" class="btn sm" type="button" :aria-pressed="modelValue === measured" @click="emit('update:modelValue', measured)"><i :style="{ background: measured }"></i>From your photo</button>
      <label class="custom">Fine-tune <input type="color" :value="modelValue ?? measured ?? '#825c43'" aria-label="Fine-tune skin tone" @input="custom" /></label>
    </div>
    <small class="muted attribution">Monk Skin Tone Scale, Ellis Monk, 2019 · <a href="https://skintone.google/" target="_blank" rel="noreferrer">Google</a> · CC BY 4.0</small>
  </div>
</template>
<style scoped>
.tones { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; }
.tones button { min-height:44px; border:2px solid transparent; border-radius:10px; cursor:pointer; position:relative; }
.tones button[aria-checked="true"] { outline:3px solid var(--accent-strong); outline-offset:2px; }
.tones span { background:#17151b9c; color:white; border-radius:5px; font-size:11px; padding:2px 5px; }
.tone-options { display:flex; flex-wrap:wrap; align-items:center; gap:8px; }
.tone-options .btn,.custom { min-height:44px; display:flex; align-items:center; gap:8px; }
i { width:20px;height:20px;border-radius:50%;border:1px solid var(--line); }
.custom input { width:40px;height:40px;border:0;padding:0;background:transparent; }
.attribution { font-size:11px; }
a { color:inherit; }
</style>
