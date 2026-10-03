<script setup lang="ts">
import type { AvatarAppearance, HairStyle } from '../../shared/appearance.ts'
import { DEFAULT_APPEARANCE, HAIR_STYLES, parseAvatarAppearance } from '../../shared/appearance.ts'

const props = defineProps<{ modelValue: AvatarAppearance }>()
const emit = defineEmits<{ 'update:modelValue': [appearance: AvatarAppearance] }>()

const sliders = [
  { key: 'faceWidth', label: 'Face width', min: 0.9, max: 1.12, step: 0.01 },
  { key: 'jaw', label: 'Jaw', min: 0.85, max: 1.18, step: 0.01 },
  { key: 'chin', label: 'Chin', min: 0.9, max: 1.1, step: 0.01 },
  { key: 'hairline', label: 'Hairline', min: -0.08, max: 0.08, step: 0.01 },
  { key: 'shoulders', label: 'Shoulders', min: 0.9, max: 1.16, step: 0.01 },
  { key: 'torso', label: 'Torso', min: 0.9, max: 1.12, step: 0.01 },
] as const
type SliderKey = (typeof sliders)[number]['key']

const hairNames: Record<HairStyle, string> = {
  auto: 'Character’s own hair',
  'low-cut': 'Low cut',
  fade: 'Fade',
  'short-afro': 'Short afro',
  'big-afro': 'Big afro',
  braids: 'Braids',
  locs: 'Locs',
  twists: 'Short twists',
  bald: 'Bald',
  'long-straight': 'Long straight',
  bun: 'Bun',
  'head-wrap': 'Head wrap',
}

function change(patch: Partial<AvatarAppearance>): void {
  emit('update:modelValue', parseAvatarAppearance({ ...props.modelValue, ...patch }))
}
function changeSlider(key: SliderKey, event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) change({ [key]: Number(target.value) })
}
function changeHair(event: Event): void {
  const target = event.target
  if (target instanceof HTMLSelectElement) change({ hairStyle: HAIR_STYLES.find(style => style === target.value) ?? 'auto' })
}
function changeBeard(event: Event): void {
  const target = event.target
  if (target instanceof HTMLSelectElement) change({ beard: target.value === 'on' || target.value === 'off' || target.value === 'chin-strap' ? target.value : 'auto' })
}
function changeColour(event: Event): void {
  const target = event.target
  if (target instanceof HTMLInputElement) change({ hairColour: target.value })
}
function percentage(key: SliderKey): string {
  const difference = Math.round((props.modelValue[key] - (key === 'hairline' ? 0 : 1)) * 100)
  return difference === 0 ? 'Natural' : `${difference > 0 ? '+' : ''}${difference}%`
}
</script>

<template>
  <div class="appearance-controls stack tight">
    <div class="sliders">
      <label v-for="item in sliders" :key="item.key" class="slider field">
        <span>{{ item.label }} <span class="muted num small">{{ percentage(item.key) }}</span></span>
        <input type="range" :min="item.min" :max="item.max" :step="item.step" :value="modelValue[item.key]" :aria-label="item.label" @input="changeSlider(item.key, $event)" />
      </label>
    </div>
    <div class="choices">
      <label class="field">
        <span>Hair style</span>
        <select class="select" :value="modelValue.hairStyle" @change="changeHair">
          <option v-for="style in HAIR_STYLES" :key="style" :value="style">{{ hairNames[style] }}</option>
        </select>
      </label>
      <label class="field">
        <span>Beard</span>
        <select class="select" :value="modelValue.beard" @change="changeBeard">
          <option value="auto">Character’s own</option>
          <option value="on">Short full beard</option>
          <option value="chin-strap">Chin-strap beard</option>
          <option value="off">Hide</option>
        </select>
      </label>
      <div class="field">
        <span>Hair colour</span>
        <div class="colour-row">
          <button class="btn sm" type="button" :aria-pressed="modelValue.hairColour === null" @click="change({ hairColour: null })">Character’s own</button>
          <label class="colour-picker">
            <span>Custom</span>
            <input type="color" :value="modelValue.hairColour ?? '#352820'" aria-label="Custom hair colour" @input="changeColour" />
          </label>
        </div>
      </div>
    </div>
    <button class="btn sm reset" type="button" @click="emit('update:modelValue', { ...DEFAULT_APPEARANCE })">Reset these details</button>
  </div>
</template>

<style scoped>
.sliders, .choices { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 14px; }
.slider { min-width: 0; }
.slider > span { display: flex; justify-content: space-between; gap: 8px; }
input[type="range"] { width: 100%; min-height: 44px; accent-color: var(--accent-strong); }
.select { min-height: 44px; }
.colour-row { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.colour-row .btn, .colour-picker { min-height: 44px; }
.colour-row .btn[aria-pressed="true"] { border-color: var(--accent-strong); background: var(--accent-soft); }
.colour-picker { display: inline-flex; align-items: center; gap: 7px; padding: 4px 8px; border: 1px solid var(--line); border-radius: 10px; cursor: pointer; }
.colour-picker input { width: 36px; height: 36px; padding: 0; border: 0; background: transparent; cursor: pointer; }
.reset { align-self: flex-start; min-height: 44px; }
@media (max-width: 420px) { .sliders, .choices { grid-template-columns: 1fr; } }
</style>
