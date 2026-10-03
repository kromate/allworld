<script setup lang="ts">
// One product in a grid: the piece itself in 3D, who makes it, what it costs to ask about, and a save heart.
import { computed } from 'vue'
import type { Product } from '../../shared/market.ts'
import ModelPreview from './ModelPreview.vue'
import { AVAILABILITY, CATEGORY, SAMPLE_TITLE, availabilityOf, fromPrice, swatchesOf } from './labels.ts'

const props = defineProps<{ product: Product; saving?: boolean }>()
defineEmits<{ save: [] }>()

const first = computed(() => props.product.variants[0])
const availability = computed(() => AVAILABILITY[availabilityOf(props.product)])
const options = computed(() => props.product.variants.map(variant => ({ id: variant.id, colour: swatchesOf(variant)[0] ?? null })))
</script>

<template>
  <article class="card product-card">
    <ModelPreview
      class="shot" :model="product.model" :tints="first?.tints" :icon="CATEGORY[product.category].icon"
      :label="first ? `${product.name} in ${first.name}` : product.name"
    />
    <div class="text">
      <RouterLink class="name" :to="`/market/p/${product.id}`">{{ product.name }}</RouterLink>
      <p class="muted tiny maker">{{ product.seller.name }} · {{ product.seller.areaLabel }}</p>
      <p class="price">
        <strong class="num">{{ fromPrice(product) }}</strong>
        <span v-if="options.length > 1" class="options" :title="`${options.length} options`">
          <span v-for="option in options.slice(0, 4)" :key="option.id" class="dot" :style="{ background: option.colour ?? 'var(--surface-3)' }" aria-hidden="true"></span>
          <span class="sr-only">{{ options.length }} options</span>
        </span>
      </p>
      <div class="row wrap chips">
        <span class="chip" :class="availability.tone">{{ availability.label }}</span>
        <span v-if="product.seller.sample" class="chip grape" :title="SAMPLE_TITLE">Sample<span class="sr-only"> catalog entry, not a real merchant</span></span>
      </div>
    </div>
    <button
      class="heart" :class="{ on: product.saved }" type="button" :aria-pressed="product.saved" :disabled="saving"
      :aria-label="product.saved ? `Remove ${product.name} from saved` : `Save ${product.name}`" :title="product.saved ? 'Saved. Tap to remove.' : 'Save for later'"
      @click="$emit('save')"
    ><span aria-hidden="true">{{ product.saved ? '♥' : '♡' }}</span></button>
  </article>
</template>

<style scoped>
.product-card { position: relative; display: flex; flex-direction: column; gap: 10px; padding: 10px; transition: transform 0.1s ease, box-shadow 0.15s ease, border-color 0.15s ease; }
.product-card:hover { border-color: var(--line-strong); box-shadow: var(--shadow); transform: translateY(-1px); }
.product-card:has(.name:focus-visible) { outline: 3px solid color-mix(in srgb, var(--sky) 70%, white); outline-offset: 2px; }
.text { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 0 2px 2px; }
.name { font-weight: 700; color: var(--ink); text-decoration: none; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; outline: none; }
/* The whole card opens the product; the heart sits above this layer. */
.name::after { content: ""; position: absolute; inset: 0; border-radius: var(--radius); }
.maker { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.price { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 2px; }
.options { display: inline-flex; flex: none; }
.dot { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--line-strong); margin-left: -4px; }
.chips { gap: 5px; margin-top: 3px; }
.heart {
  position: absolute; top: 14px; right: 14px; z-index: 1; display: grid; place-items: center; width: 40px; height: 40px; padding: 0;
  border: 1px solid var(--line); border-radius: 50%; background: rgba(255, 253, 249, 0.92); color: var(--ink-2); font-size: 1.15rem; line-height: 1;
  transition: transform 0.1s ease, color 0.15s ease, background 0.15s ease;
}
.heart:hover:not(:disabled) { transform: scale(1.06); color: var(--coral); }
.heart.on { color: var(--coral); background: var(--coral-soft); border-color: #f5cdc3; }
.heart:disabled { opacity: 0.6; cursor: progress; }
@media (pointer: coarse) { .heart { width: 44px; height: 44px; } }

/* On a phone the card lies down: the piece on the left, the words beside it. */
@container market (max-width: 430px) {
  .product-card { flex-direction: row; align-items: stretch; gap: 12px; }
  .product-card > .shot { width: 116px; flex: none; align-self: flex-start; aspect-ratio: 1; }
  .text { flex: 1; padding: 2px 0; }
  /* The heart sits over the first two lines of words: both stop short of it, at either heart size. */
  .name, .maker { padding-right: 46px; }
  .price { justify-content: flex-start; }
  .heart { top: 8px; right: 8px; }
}
</style>
