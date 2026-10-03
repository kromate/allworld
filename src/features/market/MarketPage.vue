<script lang="ts">
// What the member was browsing, kept while the App is open so that coming back from a product
// returns to the same shelf. Cleared when the account changes.
import { reactive } from 'vue'
import type { ProductCategory } from '../../shared/market.ts'
import { onAccountReset } from '../../state/app.ts'

const filters = reactive({ category: null as ProductCategory | null, query: '', savedOnly: false })
onAccountReset(() => { filters.category = null; filters.query = ''; filters.savedOnly = false })
</script>

<script setup lang="ts">
// The Market: real pieces from makers, shown on the same 3D models members place at home.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PRODUCT_CATEGORIES } from '../../shared/market.ts'
import type { Product } from '../../shared/market.ts'
import { api, attempt, messageOf, toast } from '../../state/app.ts'
import { isFurniture } from '../../world/interior.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count } from '../../ui/format.ts'
import ModelPreview from './ModelPreview.vue'
import { focusIn } from './scroll.ts'
import ProductCard from './ProductCard.vue'
import { CATEGORY, modelLabel } from './labels.ts'

const route = useRoute()
const router = useRouter()
const search = ref<HTMLInputElement | null>(null)
const typed = ref(filters.query)
const refreshing = ref(false)
const stale = ref('')
// Every product whose save is in flight: one id would let A's reply re-enable B while B is still sending.
const saving = reactive(new Set<string>())
/** Which question the shelf on screen answers: a furniture model, or '' for the catalog. */
const answered = ref<string | null>(null)
let debounce = 0
let attemptNo = 0

/** Set when the member arrived by tapping a furnishing in a home. */
const model = computed(() => (typeof route.query.model === 'string' && route.query.model ? route.query.model : null))
const filtered = computed(() => filters.category !== null || filters.query !== '' || filters.savedOnly)

const { data, state, error, reload } = useLoad(async () => {
  const mine = ++attemptNo
  const asked = model.value ?? ''
  try {
    const result = model.value
      ? await api('market.byModel', { model: model.value })
      : await api('market.catalog', { category: filters.category, query: filters.query, savedOnly: filters.savedOnly })
    if (mine === attemptNo) { stale.value = ''; answered.value = asked }
    return result
  } catch (cause) {
    // The shelf on screen no longer matches what was asked for: say so instead of passing it off as the answer.
    if (mine === attemptNo) stale.value = messageOf(cause)
    throw cause
  }
})
const products = computed(() => data.value?.products ?? [])
// Pieces for one model and the whole catalog are different questions: never show one under the other's heading.
const view = computed<'loading' | 'error' | 'ready'>(() => {
  if (state.value !== 'ready' || answered.value === (model.value ?? '')) return state.value
  return stale.value ? 'error' : 'loading'
})

async function refresh(): Promise<void> {
  refreshing.value = true
  await reload()
  refreshing.value = false
}
watch([model, () => filters.category, () => filters.query, () => filters.savedOnly], () => { void refresh() })

watch(typed, value => {
  window.clearTimeout(debounce)
  debounce = window.setTimeout(() => { filters.query = value.trim() }, 300)
})
function submit(): void {
  window.clearTimeout(debounce)
  filters.query = typed.value.trim()
}
function clearFilters(): void {
  window.clearTimeout(debounce)
  typed.value = ''
  filters.query = ''
  filters.category = null
  filters.savedOnly = false
}

async function setSaved(product: Product, saved: boolean): Promise<void> {
  if (saving.has(product.id)) return
  saving.add(product.id)
  const result = await attempt('market.save', { productId: product.id, saved })
  saving.delete(product.id)
  const list = data.value?.products
  if (!result || !list) return
  const index = list.findIndex(entry => entry.id === product.id)
  if (!saved && filters.savedOnly && !model.value) {
    if (index >= 0) list.splice(index, 1)
    toast(`${product.name} is no longer saved.`, 'info', { label: 'Undo', run: () => { void setSaved(product, true).then(refresh) } })
  } else if (index >= 0) list[index] = result.product
}

// "/" jumps to the search box, as it does in most catalogs.
function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey || !search.value) return
  if (target && (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) || target.isContentEditable)) return
  event.preventDefault()
  focusIn(search.value)
  search.value.select()
}
onMounted(() => window.addEventListener('keydown', onKey))
onBeforeUnmount(() => { window.removeEventListener('keydown', onKey); window.clearTimeout(debounce) })
</script>

<template>
  <PanelPage title="Market" wide>
    <template #actions>
      <RouterLink class="btn sm" to="/market/quotes">My quotes</RouterLink>
    </template>

    <!-- Arrived from a furnishing in a home -->
    <div v-if="model" class="card tint-sky row for-piece">
      <ModelPreview v-if="isFurniture(model)" class="piece" :model="model" :label="modelLabel(model)" />
      <div class="grow stack tight">
        <h2>Products for this piece</h2>
        <p class="small muted">Makers who offer the {{ modelLabel(model).toLowerCase() }} you tapped. Looking does not order anything.</p>
        <div><RouterLink class="btn sm" to="/market" replace>Show the whole Market</RouterLink></div>
      </div>
    </div>

    <template v-else>
      <form class="row" role="search" @submit.prevent="submit">
        <label class="grow search">
          <span class="sr-only">Search the Market</span>
          <input ref="search" v-model="typed" class="input" type="search" maxlength="80" placeholder="Search pieces, makers or materials" enterkeyhint="search" autocomplete="off" />
          <span v-if="!typed" class="kbd hint" aria-hidden="true">/</span>
        </label>
        <button class="btn saved" :class="{ on: filters.savedOnly }" type="button" :aria-pressed="filters.savedOnly" @click="filters.savedOnly = !filters.savedOnly">
          <span aria-hidden="true">{{ filters.savedOnly ? '♥' : '♡' }}</span>Saved
        </button>
      </form>

      <div class="cats" role="group" aria-label="Filter by kind of piece">
        <button class="btn sm" :class="{ dark: filters.category === null }" type="button" :aria-pressed="filters.category === null" @click="filters.category = null">Everything</button>
        <button
          v-for="name in PRODUCT_CATEGORIES" :key="name" class="btn sm" :class="{ dark: filters.category === name }" type="button" :aria-pressed="filters.category === name"
          @click="filters.category = filters.category === name ? null : name"
        ><span aria-hidden="true">{{ CATEGORY[name].icon }}</span>{{ CATEGORY[name].label }}</button>
      </div>
    </template>

    <StateView v-if="view !== 'ready'" :state="view" :message="stale || error" @retry="refresh" />
    <template v-else>
      <div v-if="stale" class="notice coral" role="alert">
        <div class="grow"><strong>That did not load.</strong> {{ stale }} The pieces below are from before.</div>
        <button class="btn sm" type="button" @click="refresh">Try again</button>
      </div>

      <StateView
        v-if="!products.length && model" state="empty" art="🪑" title="No maker has listed this piece yet"
        message="You can still place it at home for free. Other pieces in the Market come with makers you can ask for a quote."
      >
        <RouterLink class="btn primary" to="/market" replace>Browse the Market</RouterLink>
      </StateView>
      <StateView
        v-else-if="!products.length && filters.savedOnly && !filters.query && !filters.category" state="empty" art="♡" title="Nothing saved yet"
        message="Tap the heart on a piece to keep it here. Saved pieces are only visible to you."
      >
        <button class="btn primary" type="button" @click="filters.savedOnly = false">Browse everything</button>
      </StateView>
      <StateView v-else-if="!products.length && filtered" state="empty" art="🔎" title="Nothing matches" message="No piece fits that search. Try another word, or clear the filters.">
        <button class="btn primary" type="button" @click="clearFilters">Clear filters</button>
      </StateView>
      <StateView v-else-if="!products.length" state="empty" art="🛋" title="The Market is empty" message="No maker has listed a piece yet. If you make or sell furniture, you can be the first.">
        <RouterLink class="btn primary" to="/market/sell">Sell here</RouterLink>
      </StateView>

      <template v-else>
        <div v-if="!model" class="row between wrap summary">
          <span class="muted tiny" role="status">
            {{ count(products.length, 'piece') }}{{ filters.savedOnly ? ' saved' : '' }}{{ filters.category ? ` in ${CATEGORY[filters.category].label.toLowerCase()}` : '' }}{{ filters.query ? ` matching “${filters.query}”` : '' }}<template v-if="products.length >= 100">. Showing the first 100 — search to narrow it down</template>
          </span>
          <button v-if="filtered" class="btn ghost sm" type="button" @click="clearFilters">Clear filters</button>
        </div>
        <ul class="grid" :class="{ refreshing }" :aria-busy="refreshing">
          <li v-for="product in products" :key="product.id">
            <ProductCard :product="product" :saving="saving.has(product.id)" @save="setSaved(product, !product.saved)" />
          </li>
        </ul>
      </template>
    </template>

    <p class="notice promise tiny"><span aria-hidden="true">🏠</span><span class="grow">Real pieces from makers. Placing one in your home is free and is not a purchase. Nothing here takes payment.</span><RouterLink class="sell" to="/market/sell">Sell here</RouterLink></p>
  </PanelPage>
</template>

<style scoped>
.for-piece { align-items: flex-start; gap: 14px; }
.for-piece > .piece { width: 96px; flex: none; aspect-ratio: 1; }
.search { position: relative; display: block; }
.search .input { padding-right: 38px; }
.hint { position: absolute; right: 10px; top: 50%; transform: translateY(-50%); pointer-events: none; }
.saved { flex: none; }
.saved.on { background: var(--coral-soft); border-color: #f5cdc3; color: #b63a22; }
.cats { display: flex; gap: 6px; overflow-x: auto; scrollbar-width: none; margin: 0 -18px; padding: 2px 18px; }
.cats::-webkit-scrollbar { display: none; }
.cats .btn { flex: none; }
.summary { min-height: 32px; margin-bottom: -6px; }
.grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(204px, 1fr)); gap: 10px; container: market / inline-size; transition: opacity 0.15s ease; }
.grid.refreshing { opacity: 0.6; }
.grid > li { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.promise { position: sticky; bottom: 0; z-index: 2; margin-top: auto; align-items: center; padding: 8px 12px; background: #fff7e6; border-color: #f4dfae; color: #6f4500; box-shadow: 0 -8px 14px 4px var(--bg); }
.sell { flex: none; display: inline-flex; align-items: center; min-height: 44px; margin: -8px 0; padding: 0 4px; font-weight: 650; white-space: nowrap; }
/* Covers the strip of the window's bottom padding, so nothing scrolls past underneath the notice. */
.promise::after { content: ""; position: absolute; left: -18px; right: -18px; top: 100%; height: calc(23px + var(--safe-bottom)); background: var(--bg); pointer-events: none; }
/* The window's side padding is 16 px from here down: the strips that reach its edges follow it, or the page scrolls sideways. */
@media (max-width: 720px) {
  .cats { margin: 0 -16px; padding: 2px 16px; }
  .promise::after { left: -16px; right: -16px; }
}
@media (max-width: 420px) {
  .hint { display: none; }
}
/* On a phone the promise is the page's last line, not a bar held over the shelf. */
@media (max-width: 540px) {
  .promise { position: static; box-shadow: none; }
  .promise::after { display: none; }
}
</style>
