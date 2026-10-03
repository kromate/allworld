<script setup lang="ts">
// One option of a product while its seller edits it: what it is called and made of, the colours it
// puts on the 3D piece (shown live beside the colour pickers), its real size, price and availability.
// The draft object belongs to the product editor's list; this component edits its fields in place.
import { computed } from 'vue'
import { money } from '../../ui/format.ts'
import ModelPreview from './ModelPreview.vue'
import { AVAILABILITY, isCurrency, materialLabel, minorFromAmount } from './labels.ts'
import type { VariantDraft } from './drafts.ts'

const props = defineProps<{
  draft: VariantDraft
  index: number
  model: string
  materials: string[]
  icon: string
  canRemove: boolean
  canDuplicate: boolean
  /** Sentences to show once the seller has tried to save. */
  problems: string[]
}>()
defineEmits<{ remove: []; duplicate: [] }>()

const uid = `option-${props.draft.key}`
const title = computed(() => `Option ${props.index + 1}${props.draft.name.trim() ? ` · ${props.draft.name.trim()}` : ''}`)
/** Only the colours this piece can actually wear are shown on it. */
const shown = computed(() => Object.fromEntries(Object.entries(props.draft.tints).filter(([material]) => props.materials.includes(material))))
const seen = computed(() => {
  if (props.draft.quoteOnly) return 'Quote only'
  const minor = minorFromAmount(props.draft.amount)
  return minor !== null && isCurrency(props.draft.currency) ? money(minor, props.draft.currency) : ''
})

function setTint(material: string, event: Event): void {
  props.draft.tints[material] = (event.target as HTMLInputElement).value.toLowerCase()
}
function clearTint(material: string): void {
  delete props.draft.tints[material]
}
</script>

<template>
  <fieldset class="card variant stack" :class="{ flagged: problems.length }">
    <legend class="sr-only">{{ title }}</legend>
    <div class="row wrap head">
      <strong class="grow truncate" aria-hidden="true">{{ title }}</strong>
      <button class="btn ghost sm" type="button" :disabled="!canDuplicate" :title="canDuplicate ? 'Start another option from this one' : 'A product has at most 8 options'" @click="$emit('duplicate')">Duplicate</button>
      <button class="btn ghost danger sm" type="button" :disabled="!canRemove" :title="canRemove ? 'Remove this option' : 'A product needs at least one option'" @click="$emit('remove')">Remove</button>
    </div>

    <div class="pair">
      <label class="field"><span>Option name</span><input v-model="draft.name" class="input" type="text" maxlength="60" placeholder="Cream weave" /></label>
      <label class="field"><span>Material</span><input v-model="draft.material" class="input" type="text" maxlength="40" placeholder="iroko and cotton" /></label>
    </div>

    <div class="look">
      <ModelPreview v-if="model" class="shot" :model="model" :tints="shown" :icon="icon" :label="`${title} on the 3D piece`" />
      <div class="grow stack tight">
        <span class="label">Colours on the 3D piece</span>
        <p v-if="!model" class="small muted">Choose a 3D piece above to set its colours.</p>
        <p v-else-if="!materials.length" class="small muted">This piece has no parts that take a colour.</p>
        <ul v-else class="tints">
          <li v-for="material in materials" :key="material" class="row">
            <input :id="`${uid}-${material}`" class="colour" type="color" :value="draft.tints[material] ?? '#c8beae'" @input="setTint(material, $event)" />
            <label class="grow" :for="`${uid}-${material}`">
              <span class="small">{{ materialLabel(material) }}</span>
              <span class="tiny muted num">{{ draft.tints[material] ?? 'The piece’s own colour' }}</span>
            </label>
            <button v-if="draft.tints[material]" class="btn ghost sm" type="button" :aria-label="`Use the piece’s own colour for ${materialLabel(material).toLowerCase()}`" @click="clearTint(material)">Reset</button>
          </li>
        </ul>
      </div>
    </div>

    <fieldset class="group">
      <legend class="label">Real size in centimetres</legend>
      <div class="three">
        <label class="field"><span>Width</span><input v-model.number="draft.width" class="input num" type="number" inputmode="decimal" min="1" max="1000" step="any" /></label>
        <label class="field"><span>Depth</span><input v-model.number="draft.depth" class="input num" type="number" inputmode="decimal" min="1" max="1000" step="any" /></label>
        <label class="field"><span>Height</span><input v-model.number="draft.height" class="input num" type="number" inputmode="decimal" min="1" max="1000" step="any" /></label>
      </div>
    </fieldset>

    <fieldset class="group">
      <legend class="label">Price</legend>
      <div class="row wrap price">
        <div class="row quote-only">
          <button class="switch" type="button" role="switch" :aria-checked="draft.quoteOnly" :aria-label="`Quote only for ${title}`" @click="draft.quoteOnly = !draft.quoteOnly"></button>
          <span class="small" aria-hidden="true" @click="draft.quoteOnly = !draft.quoteOnly">Quote only</span>
        </div>
        <label v-if="!draft.quoteOnly" class="field amount"><span class="sr-only">Indicative price, whole amount</span><input v-model.number="draft.amount" class="input num" type="number" inputmode="numeric" min="0" step="1" placeholder="Price" /></label>
        <label class="field currency"><span class="sr-only">Currency, three letters</span><input v-model="draft.currency" class="input" type="text" maxlength="3" placeholder="NGN" autocapitalize="characters" spellcheck="false" @input="draft.currency = draft.currency.toUpperCase()" /></label>
      </div>
      <p class="tiny muted">
        <template v-if="draft.quoteOnly">Members see “Quote only” and ask you for a price. The currency is what your offers start in.</template>
        <template v-else>An indicative price in whole units. It is shown, never charged.</template>
        <template v-if="seen"> Members see: <strong class="num">{{ seen }}</strong>.</template>
      </p>
    </fieldset>

    <div class="pair">
      <label class="field">
        <span>Availability</span>
        <select v-model="draft.availability" class="select">
          <option v-for="(entry, value) in AVAILABILITY" :key="value" :value="value">{{ entry.label }}</option>
        </select>
      </label>
      <label class="field">
        <span>Lead time in days (optional)</span>
        <input v-model.number="draft.leadTime" class="input num" type="number" inputmode="numeric" min="0" max="365" step="1" placeholder="Ask the maker" />
      </label>
    </div>

    <ul v-if="problems.length" class="problems small" role="alert">
      <li v-for="problem in problems" :key="problem">{{ problem }}</li>
    </ul>
  </fieldset>
</template>

<style scoped>
.variant { margin: 0; min-width: 0; }
.variant.flagged { border-color: #f1b9ad; }
.head { gap: 6px; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(190px, 100%), 1fr)); gap: 12px; }
.three { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; }
.group { margin: 0; padding: 0; border: 0; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.group legend { padding: 0; margin-bottom: 6px; }
.look { display: flex; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.look > .shot { width: 132px; flex: none; aspect-ratio: 1; }
.look > .grow { flex: 1 1 190px; }
.tints { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.tints label { display: flex; flex-direction: column; min-width: 0; cursor: pointer; }
.colour { width: 44px; height: 40px; padding: 2px; border: 1px solid var(--line-strong); border-radius: 10px; background: #fff; flex: none; cursor: pointer; }
@media (pointer: coarse) { .colour { height: 44px; } }
.price { gap: 10px; }
/* The switch keeps its size; the area that answers a finger is 42 px tall. */
.switch::before { content: ""; position: absolute; inset: -8px -4px; }
.quote-only { gap: 8px; min-height: 42px; cursor: pointer; }
.amount { flex: 1 1 120px; }
.currency { flex: 0 0 84px; }
.problems { margin: 0; padding: 9px 12px 9px 28px; border-radius: 10px; background: var(--coral-soft); color: #8f2c19; display: flex; flex-direction: column; gap: 2px; }
</style>
