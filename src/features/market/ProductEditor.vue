<script setup lang="ts">
// A seller's product form: what it is, which 3D piece shows it, its options, whether members may
// share it, and whether it is listed. Saves through market.productSave and nothing else.
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { PRODUCT_CATEGORIES } from '../../shared/market.ts'
import type { Product, ProductCategory } from '../../shared/market.ts'
import { api, messageOf, toast } from '../../state/app.ts'
import { FURNITURE_GROUPS, isFurniture, materialsOf } from '../../world/interior.ts'
import ModelPreview from './ModelPreview.vue'
import VariantEditor from './VariantEditor.vue'
import { CATEGORY, modelLabel } from './labels.ts'
import { reveal } from './scroll.ts'
import { MAX_VARIANTS, blankVariant, copyVariant, productDraft, productInput, productProblems, variantProblems } from './drafts.ts'

const props = defineProps<{
  /** The product being edited, or null for a new one. */
  product: Product | null
  /** The currency this seller last priced in, to start new options with. */
  currency: string
}>()
const emit = defineEmits<{ saved: [product: Product]; cancel: []; dirty: [value: boolean] }>()

const draft = reactive(productDraft(props.product, props.currency))
const baseline = JSON.stringify(draft)
const tried = ref(false)
const saving = ref(false)
const filter = ref('')
const pruned = ref(false)
const form = ref<HTMLFormElement | null>(null)
let categoryChosen = props.product !== null

watch(draft, () => emit('dirty', JSON.stringify(draft) !== baseline), { deep: true })

const materials = computed(() => (draft.model ? materialsOf(draft.model) : []))
const problems = computed(() => productProblems(draft))
const topProblems = computed(() => problems.value.filter(problem => !problem.startsWith('Option ')))
const firstTints = computed(() => Object.fromEntries(Object.entries(draft.variants[0]?.tints ?? {}).filter(([material]) => materials.value.includes(material))))

/** Pieces a member can place, grouped as the home editor groups them, narrowed by the filter. */
const groups = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  const matches = (model: string, group: string): boolean => !needle || model === draft.model || modelLabel(model).toLowerCase().includes(needle) || group.toLowerCase().includes(needle)
  return FURNITURE_GROUPS
    .map(group => ({ id: group.id, label: group.label, models: group.models.filter(model => isFurniture(model) && matches(model, group.label)) }))
    .filter(group => group.models.length)
})
const grouped = computed(() => FURNITURE_GROUPS.some(group => group.models.includes(draft.model)))
const matchCount = computed(() => groups.value.reduce((sum, group) => sum + group.models.length, 0))

watch(() => draft.model, model => {
  // Colours only make sense on parts the new piece has.
  const allowed = materialsOf(model)
  let dropped = false
  for (const variant of draft.variants) {
    for (const material of Object.keys(variant.tints)) if (!allowed.includes(material)) { delete variant.tints[material]; dropped = true }
  }
  pruned.value = dropped
  // Until the seller picks a category themselves, it follows the kind of piece.
  const group = FURNITURE_GROUPS.find(entry => entry.models.includes(model))
  if (!categoryChosen && group && (PRODUCT_CATEGORIES as readonly string[]).includes(group.id)) draft.category = group.id as ProductCategory
})

async function focusOption(index: number): Promise<void> {
  await nextTick()
  const card = form.value?.querySelectorAll<HTMLElement>('.variants > li')[index]
  reveal(card, 'start')
  card?.querySelector<HTMLElement>('input')?.focus({ preventScroll: true })
}
function addOption(): void {
  if (draft.variants.length >= MAX_VARIANTS) return
  draft.variants.push(blankVariant(draft.variants.at(-1)?.currency ?? props.currency))
  void focusOption(draft.variants.length - 1)
}
function duplicate(index: number): void {
  const source = draft.variants[index]
  if (!source || draft.variants.length >= MAX_VARIANTS) return
  draft.variants.splice(index + 1, 0, copyVariant(source))
  void focusOption(index + 1)
}
function remove(index: number): void {
  const [removed] = draft.variants.splice(index, 1)
  if (!removed) return
  toast(`Option ${index + 1}${removed.name ? ` (${removed.name})` : ''} removed. It is gone for good once you save.`, 'info', {
    label: 'Undo', run: () => { draft.variants.splice(Math.min(index, draft.variants.length), 0, removed) },
  })
}

async function save(): Promise<void> {
  if (saving.value) return
  tried.value = true
  if (problems.value.length) {
    await nextTick()
    reveal(form.value?.querySelector<HTMLElement>('[role="alert"]'), 'center')
    return
  }
  saving.value = true
  try {
    const { product } = await api('market.productSave', productInput(props.product?.id ?? null, draft, materials.value))
    emit('dirty', false)
    toast(product.status === 'listed' ? `${product.name} is saved and listed in the Market.` : `${product.name} is saved. It is not listed, so only you can see it.`, 'good')
    emit('saved', product)
  } catch (cause) {
    toast(messageOf(cause), 'bad')
  } finally { saving.value = false }
}

function onKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && (event.key === 's' || event.key === 'Enter')) { event.preventDefault(); void save() }
}
</script>

<template>
  <form ref="form" class="editor" novalidate @submit.prevent="save" @keydown="onKey">
    <section class="card stack" aria-labelledby="ed-what">
      <h2 id="ed-what">The product</h2>
      <div class="pair">
        <label class="field"><span>Name</span><input v-model="draft.name" class="input" type="text" maxlength="80" placeholder="Three-seat weave sofa" /></label>
        <label class="field">
          <span>Category</span>
          <select v-model="draft.category" class="select" @change="categoryChosen = true">
            <option v-for="name in PRODUCT_CATEGORIES" :key="name" :value="name">{{ CATEGORY[name].label }}</option>
          </select>
        </label>
      </div>
      <label class="field">
        <span>Description</span>
        <textarea v-model="draft.description" class="textarea" maxlength="1000" placeholder="What it is, how it is made, what is and is not included"></textarea>
        <small>Say only what is true of the real piece. Members ask for quotes from this.</small>
      </label>
      <ul v-if="tried && topProblems.length" class="problems small" role="alert"><li v-for="problem in topProblems" :key="problem">{{ problem }}</li></ul>
    </section>

    <section class="card stack" aria-labelledby="ed-piece">
      <div>
        <h2 id="ed-piece">The 3D piece</h2>
        <p class="small muted">Members see your product on this piece and can place it in their home for free. Pick the closest shape; your real sizes go in the options.</p>
      </div>
      <div class="piece">
        <ModelPreview v-if="draft.model" class="shot" :model="draft.model" :tints="firstTints" :icon="CATEGORY[draft.category].icon" :label="`${modelLabel(draft.model)}, the 3D piece for this product`" />
        <div v-else class="shot none" aria-hidden="true">{{ CATEGORY[draft.category].icon }}</div>
        <div class="grow stack tight">
          <label class="field">
            <span>Find a piece</span>
            <input v-model="filter" class="input" type="search" placeholder="sofa, lamp, table…" autocomplete="off" @keydown.enter.prevent />
          </label>
          <label class="field">
            <span>Piece</span>
            <select v-model="draft.model" class="select">
              <option value="" disabled>{{ matchCount ? 'Choose a piece' : 'Nothing matches that word' }}</option>
              <option v-if="draft.model && !grouped" :value="draft.model">{{ modelLabel(draft.model) }}</option>
              <optgroup v-for="group in groups" :key="group.id" :label="group.label">
                <option v-for="model in group.models" :key="model" :value="model">{{ modelLabel(model) }}</option>
              </optgroup>
            </select>
            <small role="status">{{ filter.trim() ? `${matchCount} ${matchCount === 1 ? 'piece matches' : 'pieces match'} “${filter.trim()}”.` : `${matchCount} pieces in ${groups.length} groups.` }}</small>
          </label>
          <p v-if="pruned" class="small notice">Colours for parts this piece does not have were removed from your options.</p>
        </div>
      </div>
    </section>

    <section class="stack" aria-labelledby="ed-options">
      <div class="row between wrap">
        <div>
          <h2 id="ed-options">Options</h2>
          <p class="small muted">Each option is one real version a member can ask about: a finish, a size, a colourway.</p>
        </div>
        <span class="chip num">{{ draft.variants.length }} of {{ MAX_VARIANTS }}</span>
      </div>
      <ul class="variants">
        <li v-for="(variant, index) in draft.variants" :key="variant.key">
          <VariantEditor
            :draft="variant" :index="index" :model="draft.model" :materials="materials" :icon="CATEGORY[draft.category].icon"
            :can-remove="draft.variants.length > 1" :can-duplicate="draft.variants.length < MAX_VARIANTS" :problems="tried ? variantProblems(variant, index) : []"
            @remove="remove(index)" @duplicate="duplicate(index)"
          />
        </li>
      </ul>
      <div><button class="btn" type="button" :disabled="draft.variants.length >= MAX_VARIANTS" @click="addOption">＋ Add an option</button></div>
    </section>

    <section class="card stack" aria-labelledby="ed-share">
      <h2 id="ed-share">Sharing and listing</h2>
      <div class="row toggle">
        <button id="ed-sharing" class="switch" type="button" role="switch" :aria-checked="draft.sharingAllowed" aria-labelledby="ed-sharing-label" @click="draft.sharingAllowed = !draft.sharingAllowed"></button>
        <div class="grow" @click="draft.sharingAllowed = !draft.sharingAllowed">
          <strong id="ed-sharing-label">Members may share this listing</strong>
          <p class="small muted">Their link tells you who sent a buyer. Off means no share button at all.</p>
        </div>
      </div>
      <label v-if="draft.sharingAllowed" class="field">
        <span>Your note for people who share (optional)</span>
        <input v-model="draft.commissionNote" class="input" type="text" maxlength="200" placeholder="For example: 5% of the agreed price, paid by me after delivery" />
        <small>Shown word for word. Any commission is between you and them. This App does not pay it.</small>
      </label>
      <div class="row toggle">
        <button id="ed-listed" class="switch" type="button" role="switch" :aria-checked="draft.listed" aria-labelledby="ed-listed-label" @click="draft.listed = !draft.listed"></button>
        <div class="grow" @click="draft.listed = !draft.listed">
          <strong id="ed-listed-label">Listed in the Market</strong>
          <p class="small muted">{{ draft.listed ? 'Members can find it and ask you for a quote.' : 'Only you can see it. Quotes already open stay open.' }}</p>
        </div>
      </div>
    </section>

    <div class="save-bar">
      <p v-if="tried && problems.length" class="small problem" role="status">{{ problems.length === 1 ? 'One thing' : `${problems.length} things` }} to fix before this can be saved. They are marked above.</p>
      <div class="row wrap">
        <button class="btn primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : product ? 'Save changes' : 'Save product' }}</button>
        <button class="btn ghost" type="button" :disabled="saving" @click="emit('cancel')">Cancel</button>
        <span class="muted tiny keys"><span class="kbd">Ctrl</span> <span class="kbd">S</span> saves</span>
      </div>
    </div>
  </form>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; }
.piece { display: flex; gap: 14px; align-items: flex-start; flex-wrap: wrap; }
.piece > .shot { width: 168px; flex: none; aspect-ratio: 1; }
.piece > .grow { flex: 1 1 220px; }
.shot.none { display: grid; place-items: center; border-radius: 12px; background: var(--surface-3); font-size: 2.2rem; border: 1px dashed var(--line-strong); }
.variants { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 10px; }
.toggle { align-items: flex-start; gap: 12px; }
/* The switch keeps its size; the area that answers a finger is 42 px tall. */
.switch::before { content: ""; position: absolute; inset: -8px -4px; }
.toggle .grow { cursor: pointer; }
.problems { margin: 0; padding: 9px 12px 9px 28px; border-radius: 10px; background: var(--coral-soft); color: #8f2c19; display: flex; flex-direction: column; gap: 2px; }
.save-bar { position: sticky; bottom: 0; z-index: 3; display: flex; flex-direction: column; gap: 8px; margin: 0 -18px; padding: 12px 18px 4px; background: var(--bg); border-top: 1px solid var(--line-strong); }
/* Covers the strip of the window's bottom padding, so the form does not scroll past underneath the bar. */
.save-bar::after { content: ""; position: absolute; left: 0; right: 0; top: 100%; height: calc(23px + var(--safe-bottom)); background: var(--bg); pointer-events: none; }
.problem { color: var(--danger); font-weight: 650; }
@media (hover: none) { .keys { display: none; } }
/* The window's side padding is 16 px from here down: the bar follows it, or the form scrolls sideways. */
@media (max-width: 720px) { .save-bar { margin: 0 -16px; padding: 12px 16px 4px; } }
@media (max-width: 480px) {
  .piece > .shot { width: 112px; }
  .keys { display: none; }
}
</style>
