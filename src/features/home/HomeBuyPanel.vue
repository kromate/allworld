<script setup lang="ts">
// Buy mode: furniture. Look through the catalogue, place a piece in the room, or put coins on one
// that is not free. Free pieces are placed without paying; a bought piece waits in storage until it
// is placed; a price is only ever the service's quote, shown before anything is taken.
import { computed, ref } from 'vue'
import type { Studio } from './homeStudio.ts'

const props = defineProps<{ studio: Studio; /** The character is in the home, so a piece can be put in a room. */ canPlace: boolean; checking?: boolean }>()
const emit = defineEmits<{ notice: [text: string, tone: 'info' | 'good' | 'bad'] }>()
const { state, dirty, selectedItem, itemProblems, busy } = props.studio

const group = ref('all')
const filter = ref<'all' | 'free' | 'owned' | 'sale'>('all')
const search = ref('')
const FILTERS = [['all', 'All'], ['free', 'Free'], ['owned', 'In storage'], ['sale', 'To buy']] as const

const listings = computed(() => state.catalog?.furniture ?? [])
const groups = computed(() => state.catalog?.groups ?? [])
const shown = computed(() => {
  const words = search.value.trim().toLowerCase()
  return listings.value.filter(entry => {
    if (group.value !== 'all' && entry.group !== group.value) return false
    if (words && !props.studio.label(entry.model).toLowerCase().includes(words)) return false
    if (filter.value === 'free') return entry.free
    if (filter.value === 'owned') return !entry.free && (props.studio.spare(entry.model) ?? 0) > 0
    if (filter.value === 'sale') return !entry.free
    return true
  })
})
const stored = computed(() => (state.estate?.inventory ?? []).filter(entry => (props.studio.spare(entry.model) ?? 0) > 0))
const cartLines = computed(() => Object.entries(state.cart).filter(([, quantity]) => quantity > 0))
const cartCount = computed(() => cartLines.value.reduce((total, [, quantity]) => total + quantity, 0))
const cartListed = computed(() => cartLines.value.reduce((total, [model, quantity]) => total + (listings.value.find(entry => entry.model === model)?.price ?? 0) * quantity, 0))

function place(model: string): void {
  const result = props.studio.place(model)
  if (!result.ok) emit('notice', result.reason, 'info')
}
const spare = (model: string): number | null => props.studio.spare(model)
</script>

<template>
  <div v-if="state.catalog && state.estate" class="stack">
    <!-- The piece in hand. -->
    <section v-if="selectedItem" class="card tint-amber stack tight" aria-label="Piece in hand">
      <div class="row">
        <strong class="truncate grow">{{ studio.label(selectedItem.model) }}</strong>
        <button class="btn ghost sm danger" type="button" @click="studio.putAway(selectedItem.key)">Put away</button>
        <button class="btn ghost icon sm" type="button" aria-label="Let go of the piece" @click="studio.select(null)">✕</button>
      </div>
      <div class="controls" role="group" aria-label="Move or turn the piece">
        <button class="btn icon" type="button" aria-label="Move west" @click="studio.nudge(-1, 0)">←</button>
        <button class="btn icon" type="button" aria-label="Move north" @click="studio.nudge(0, -1)">↑</button>
        <button class="btn icon" type="button" aria-label="Move south" @click="studio.nudge(0, 1)">↓</button>
        <button class="btn icon" type="button" aria-label="Move east" @click="studio.nudge(1, 0)">→</button>
        <button class="btn icon" type="button" aria-label="Turn" title="Turn (R)" @click="studio.turn()">↻</button>
        <select v-if="(studio.state.home?.building.plan.rooms.length ?? 0) > 1" class="select room-pick" aria-label="Send to a room" @change="studio.sendToRoom(($event.target as HTMLSelectElement).value); ($event.target as HTMLSelectElement).value = ''">
          <option value="">To room…</option>
          <option v-for="room in studio.state.home!.building.plan.rooms" :key="room.id" :value="room.id">{{ room.id === 'r1' ? 'Main room' : `${room.kind} ${room.id}` }}</option>
        </select>
      </div>
      <p class="muted tiny">Tap the floor to move it there. <RouterLink :to="selectedItem.productId ? `/market/p/${selectedItem.productId}` : `/market?model=${selectedItem.model}`">{{ selectedItem.productId ? 'See this product' : 'Find real ones like this' }}</RouterLink></p>
    </section>

    <p v-if="!canPlace && !checking" class="notice sky">You are not in your home, so pieces cannot be placed. You can still buy them: they wait in storage.</p>

    <div class="row between wrap">
      <span class="chip amber num" aria-label="Your coins">🪙 {{ state.estate.balance }}</span>
      <span class="chip num" :class="{ coral: (state.draft?.items.length ?? 0) >= state.estate.itemLimit }">{{ state.draft?.items.length ?? 0 }} / {{ state.estate.itemLimit }} pieces</span>
    </div>

    <div class="tabs" role="tablist" aria-label="Kind of furniture">
      <button class="tab" type="button" role="tab" :aria-selected="group === 'all'" @click="group = 'all'">All</button>
      <button v-for="entry in groups" :key="entry.id" class="tab" type="button" role="tab" :aria-selected="group === entry.id" @click="group = entry.id">{{ entry.label }}</button>
    </div>
    <div class="row wrap">
      <input v-model="search" class="input find" type="search" placeholder="Find a piece" aria-label="Find a piece" />
      <div class="row filters" role="group" aria-label="Show">
        <button v-for="[id, text] in FILTERS" :key="id" class="btn sm" type="button" :aria-pressed="filter === id" @click="filter = id">{{ text }}</button>
      </div>
    </div>

    <ul class="catalogue" aria-label="Furniture">
      <li v-for="entry in shown" :key="entry.model" class="tile">
        <strong class="name">{{ studio.label(entry.model) }}</strong>
        <span v-if="entry.free" class="chip leaf">Free</span>
        <span v-else-if="(spare(entry.model) ?? 0) > 0" class="chip sky num">{{ spare(entry.model) }} in storage</span>
        <span v-else class="chip amber num">{{ entry.price }} coins</span>
        <div class="row actions">
          <button v-if="entry.free || (spare(entry.model) ?? 0) > 0" class="btn sm" type="button" :disabled="!canPlace" @click="place(entry.model)">Place</button>
          <template v-if="!entry.free">
            <button v-if="!(entry.model in state.cart)" class="btn sm" type="button" :aria-label="`Buy a ${studio.label(entry.model)}`" @click="studio.setQuantity(entry.model, 1)">Buy</button>
            <template v-else>
              <button class="btn icon sm" type="button" :aria-label="`Fewer ${studio.label(entry.model)}`" @click="studio.setQuantity(entry.model, (state.cart[entry.model] ?? 1) - 1)">−</button>
              <output class="num" :aria-label="`${state.cart[entry.model]} in the basket`">{{ state.cart[entry.model] }}</output>
              <button class="btn icon sm" type="button" :aria-label="`More ${studio.label(entry.model)}`" @click="studio.setQuantity(entry.model, (state.cart[entry.model] ?? 0) + 1)">＋</button>
            </template>
          </template>
        </div>
      </li>
    </ul>
    <p v-if="!shown.length" class="muted small">Nothing matches. {{ filter === 'owned' ? 'Pieces you buy wait here until you place them.' : 'Try another kind or clear the search.' }}</p>

    <details v-if="state.draft?.items.length" class="disclosure">
      <summary>In the rooms <span class="chip num">{{ state.draft.items.length }}</span></summary>
      <ul class="stored">
        <li v-for="item in state.draft.items" :key="item.key" class="list-row">
          <button class="btn ghost sm grow piece-name" type="button" :aria-pressed="state.selected === item.key" @click="studio.select(item.key)">{{ studio.label(item.model) }}<span v-if="item.productId" class="chip sky">Real product</span></button>
          <button class="btn ghost sm danger" type="button" :aria-label="`Put away ${studio.label(item.model)}`" @click="studio.putAway(item.key)">Put away</button>
        </li>
      </ul>
    </details>

    <details v-if="stored.length" class="disclosure">
      <summary>In storage <span class="chip num">{{ stored.reduce((total, entry) => total + (spare(entry.model) ?? 0), 0) }}</span></summary>
      <ul class="stored">
        <li v-for="entry in stored" :key="entry.model" class="list-row">
          <span class="grow truncate">{{ studio.label(entry.model) }} <span class="muted small num">× {{ spare(entry.model) }}</span></span>
          <button class="btn sm" type="button" :disabled="!canPlace" @click="place(entry.model)">Place</button>
        </li>
      </ul>
    </details>

    <ul v-if="itemProblems.length" class="problems" role="alert">
      <li v-for="problem in itemProblems" :key="problem">{{ problem }}</li>
    </ul>

    <!-- One bar at the bottom: the basket when there is one, otherwise the save. -->
    <div v-if="cartCount" class="savebar" role="status">
      <span class="grow small num">{{ cartCount }} to buy · list price {{ cartListed }} coins</span>
      <button class="btn sm" type="button" @click="state.cart = {}">Clear</button>
      <button class="btn primary" type="button" :disabled="busy" @click="studio.askFurniture()">Get price</button>
    </div>
    <div v-else-if="dirty" class="savebar" role="status">
      <span class="grow small">Unsaved changes</span>
      <button class="btn sm" type="button" :disabled="state.saving" @click="studio.discard()">Discard</button>
      <button class="btn primary" type="button" :disabled="state.saving || itemProblems.length > 0" @click="studio.save()">{{ state.saving ? 'Saving…' : 'Save home' }}</button>
    </div>
    <p v-if="state.saveError" class="notice coral" role="alert">{{ state.saveError }}</p>
  </div>
  <p v-else class="muted small">The shop is loading.</p>
</template>

<style scoped>
.controls { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.controls .btn.icon { width: 44px; min-height: 44px; }
.room-pick { width: auto; min-height: 44px; }
.find { flex: 1 1 140px; min-width: 0; }
.filters { gap: 4px; flex-wrap: wrap; }
.filters .btn[aria-pressed="true"] { background: var(--accent-soft); border-color: var(--accent-strong); }
.catalogue { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 8px; }
.tile { display: flex; flex-direction: column; align-items: flex-start; gap: 6px; padding: 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
.name { font-size: 0.9rem; line-height: 1.2; overflow-wrap: anywhere; }
.actions { gap: 6px; margin-top: auto; flex-wrap: wrap; }
.stored { list-style: none; margin: 0; padding: 0; }
.piece-name { justify-content: flex-start; gap: 8px; min-width: 0; }
.piece-name[aria-pressed="true"] { background: var(--accent-soft); }
.stored .list-row + .list-row { border-top: 1px solid var(--line); }
.problems { margin: 0; padding: 0 0 0 18px; color: var(--danger); font-size: 0.86rem; }
.savebar { position: sticky; bottom: -22px; margin: auto -18px -22px; padding: 10px 18px calc(12px + var(--safe-bottom)); display: flex; align-items: center; gap: 8px; background: var(--accent-soft); border-top: 1px solid #f4dfae; z-index: 1; }
@media (max-width: 720px) { .savebar { bottom: -18px; margin: auto -16px -18px; padding-inline: 16px; } }
@media (max-height: 480px) { .catalogue { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); } }
</style>
