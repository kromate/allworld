<script setup lang="ts">
// Selling: apply for a seller profile, wait for a person to review it, then list real products.
// Catalog reviewers also get the queue of applications here.
import { computed, reactive, ref } from 'vue'
import { onBeforeRouteLeave, onBeforeRouteUpdate, useRoute, useRouter } from 'vue-router'
import type { Product, Seller } from '../../shared/market.ts'
import { api, app, attempt, messageOf, toast } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count, relativeTime } from '../../ui/format.ts'
import ModelPreview from './ModelPreview.vue'
import ProductEditor from './ProductEditor.vue'
import { CATEGORY, fromPrice } from './labels.ts'
import { relisted } from './drafts.ts'

const route = useRoute()
const router = useRouter()

const { data, state, error, reload } = useLoad(() => api('market.mySeller', {}))
const seller = computed(() => data.value?.seller ?? null)
const products = computed(() => data.value?.products ?? [])

// ── Editing a product (kept in the address, so Back and reload behave) ──

const editId = computed(() => (typeof route.query.edit === 'string' ? route.query.edit : null))
const creating = computed(() => route.query.new !== undefined && editId.value === null)
const editing = computed(() => seller.value?.status === 'approved' && (creating.value || editId.value !== null))
const editProduct = computed(() => products.value.find(product => product.id === editId.value) ?? null)
const lastCurrency = computed(() => products.value[0]?.variants[0]?.currency ?? '')
const dirty = ref(false)

const leaveOk = (): boolean => !dirty.value || window.confirm('Leave without saving? The changes to this product will be lost.')
onBeforeRouteLeave(() => leaveOk())
onBeforeRouteUpdate(() => { if (!leaveOk()) return false; dirty.value = false; return true })

const openEditor = (product: Product | null): void => { void router.push({ path: '/market/sell', query: product ? { edit: product.id } : { new: '1' } }) }
const closeEditor = (): void => { void router.push('/market/sell') }
async function onSaved(): Promise<void> {
  dirty.value = false
  await reload()
  closeEditor()
}

// ── Applying ──

const application = reactive({ name: '', about: '', areaLabel: '' })
const applying = ref(false)
const myArea = computed(() => app.me?.currentArea?.label ?? '')
const canApply = computed(() => application.name.trim().length >= 2 && application.areaLabel.trim().length >= 1)

async function apply(): Promise<void> {
  if (!canApply.value || applying.value) return
  applying.value = true
  const result = await attempt('market.sellerApply', { name: application.name.trim(), about: application.about.trim(), areaLabel: application.areaLabel.trim() }, 'Application sent. A reviewer will look at it.')
  applying.value = false
  if (!result) return
  // Show the waiting state straight from the answer; the full read follows.
  data.value = { seller: result.seller, products: [] }
  void reload()
}

// ── The seller's products ──

type Shelf = 'all' | 'listed' | 'hidden'
const shelf = ref<Shelf>('all')
const shown = computed(() => products.value.filter(product => shelf.value === 'all' || (shelf.value === 'listed') === (product.status === 'listed')))
const toList = computed(() => shown.value.filter(product => product.status !== 'listed'))
const toUnlist = computed(() => shown.value.filter(product => product.status === 'listed'))
const busyId = ref<string | null>(null)
const progress = ref('')
const confirmUnlist = ref(false)

const STATUS: Record<Product['status'], { label: string; tone: string }> = {
  listed: { label: 'Listed', tone: 'leaf' }, unlisted: { label: 'Not listed', tone: '' }, draft: { label: 'Draft', tone: 'amber' },
}

function replace(product: Product): void {
  const list = data.value?.products
  const index = list?.findIndex(entry => entry.id === product.id) ?? -1
  if (list && index >= 0) list[index] = product
}

async function setListed(product: Product, listed: boolean): Promise<void> {
  if (busyId.value || progress.value) return
  busyId.value = product.id
  const result = await attempt('market.productSave', relisted(product, listed), listed ? `${product.name} is listed in the Market.` : `${product.name} is no longer listed.`)
  busyId.value = null
  if (result) replace(result.product)
}

/** One save per product, in order, saying where it has got to. Stops at the first failure. */
async function setMany(targets: Product[], listed: boolean, undoable = true): Promise<void> {
  if (!targets.length || progress.value) return
  confirmUnlist.value = false
  const changed: Product[] = []
  for (const [index, product] of targets.entries()) {
    progress.value = `${listed ? 'Listing' : 'Unlisting'} ${index + 1} of ${targets.length}: ${product.name}…`
    try {
      const result = await api('market.productSave', relisted(product, listed))
      replace(result.product)
      changed.push(result.product)
    } catch (cause) {
      toast(`Stopped at ${product.name}: ${messageOf(cause)}`, 'bad')
      break
    }
  }
  progress.value = ''
  if (!changed.length) return
  const text = listed ? `${count(changed.length, 'product')} listed in the Market.` : `${count(changed.length, 'product')} no longer listed.`
  toast(text, 'good', undoable ? { label: 'Undo', run: () => { void setMany(changed, !listed, false) } } : undefined)
}

// ── Reviewer queue ──

const queue = useLoad(async () => (app.reviewer ? (await api('market.sellerQueue', {})).sellers : []))
const reviewing = ref<string | null>(null)
const rejecting = ref<string | null>(null)
const reviewProgress = ref('')

async function review(entry: Seller, approve: boolean): Promise<void> {
  if (reviewing.value || reviewProgress.value) return
  reviewing.value = entry.id
  rejecting.value = null
  const result = await attempt('market.sellerReview', { sellerId: entry.id, approve }, approve ? `${entry.name} is approved and can list products.` : `${entry.name} was not approved. They have been told.`)
  reviewing.value = null
  if (result) { await queue.reload(); if (entry.ownerId === app.me?.id) await reload() }
}

async function approveAll(): Promise<void> {
  const targets = [...(queue.data.value ?? [])]
  if (!targets.length || reviewProgress.value) return
  let done = 0
  for (const entry of targets) {
    reviewProgress.value = `Approving ${done + 1} of ${targets.length}: ${entry.name}…`
    try { await api('market.sellerReview', { sellerId: entry.id, approve: true }); done++ } catch (cause) {
      toast(`Stopped at ${entry.name}: ${messageOf(cause)}`, 'bad')
      break
    }
  }
  reviewProgress.value = ''
  if (done) toast(`${count(done, 'seller')} approved. Each one has been told.`, 'good')
  await queue.reload()
  await reload()
}
</script>

<template>
  <PanelPage
    :title="editing ? (creating ? 'New product' : 'Edit product') : 'Sell here'"
    :subtitle="editing ? undefined : 'List real pieces. Members ask you for a quote; nothing here takes payment.'"
    :back="editing ? '/market/sell' : '/market'" wide
  >
    <!-- Catalog reviewers: the applications waiting for them -->
    <section v-if="app.reviewer && !editing" class="card tint-grape stack" aria-labelledby="review-title">
      <div class="row between wrap review-head">
        <div class="grow">
          <h2 id="review-title">Seller applications to review</h2>
          <p class="small muted">You are a catalog reviewer. Approving lets a seller list products. Rejecting keeps them out of the Market.</p>
        </div>
        <span class="row">
          <button class="btn ghost sm" type="button" :disabled="Boolean(reviewProgress)" @click="queue.reload()">Refresh</button>
          <button v-if="(queue.data.value?.length ?? 0) > 1 && !reviewProgress" class="btn sm" type="button" @click="approveAll">Approve all shown</button>
        </span>
      </div>
      <p v-if="reviewProgress" class="small" role="status">{{ reviewProgress }}</p>
      <StateView v-if="queue.state.value !== 'ready'" :state="queue.state.value" :message="queue.error.value" @retry="queue.reload()" />
      <p v-else-if="!queue.data.value?.length" class="small">No applications are waiting.</p>
      <ul v-else class="applications">
        <li v-for="entry in queue.data.value" :key="entry.id" class="card stack tight">
          <div class="row wrap" style="gap: 6px">
            <strong class="grow truncate">{{ entry.name }}</strong>
            <span class="tiny muted">Applied {{ relativeTime(entry.createdAt) }}</span>
          </div>
          <p class="tiny muted">{{ entry.areaLabel }} · as they wrote it</p>
          <p v-if="entry.about" class="small about">{{ entry.about }}</p>
          <p v-else class="small muted">They did not describe what they sell.</p>
          <div v-if="rejecting === entry.id" class="notice coral confirm" role="alert">
            <span class="grow">Reject {{ entry.name }}? They are told, and they cannot list products.</span>
            <span class="row">
              <button class="btn danger sm" type="button" :disabled="reviewing !== null" @click="review(entry, false)">Reject</button>
              <button class="btn sm" type="button" @click="rejecting = null">Cancel</button>
            </span>
          </div>
          <div v-else class="row wrap">
            <button class="btn primary sm" type="button" :disabled="reviewing !== null || Boolean(reviewProgress)" @click="review(entry, true)">{{ reviewing === entry.id ? 'Saving…' : 'Approve' }}</button>
            <button class="btn danger sm" type="button" :disabled="reviewing !== null || Boolean(reviewProgress)" @click="rejecting = entry.id">Reject</button>
          </div>
        </li>
      </ul>
    </section>

    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />

    <!-- No seller profile yet -->
    <template v-else-if="!seller">
      <div class="card tint-amber stack">
        <h2>How selling works here</h2>
        <ol class="steps">
          <li><span class="icon-chip" aria-hidden="true">✍️</span><span><strong>Apply.</strong> Tell members who you are and roughly where you make or sell.</span></li>
          <li><span class="icon-chip sky" aria-hidden="true">🔎</span><span><strong>A person reviews it.</strong> You get a note in your Inbox when it is decided. Until then you cannot list anything.</span></li>
          <li><span class="icon-chip leaf" aria-hidden="true">🛋</span><span><strong>List real pieces.</strong> Members see them on the 3D models, place them at home for free, and ask you for a quote.</span></li>
        </ol>
        <p class="small muted">This App does not collect payment. When a member accepts your offer you get their delivery details, and you arrange payment and delivery with them yourselves.</p>
      </div>

      <form class="card stack" @submit.prevent="apply">
        <h2>Apply to sell</h2>
        <label class="field">
          <span>Seller or workshop name</span>
          <input v-model="application.name" class="input" type="text" minlength="2" maxlength="60" required placeholder="Oak &amp; Thread" />
          <small>Shown on every product you list.</small>
        </label>
        <label class="field">
          <span>What you make or sell</span>
          <textarea v-model="application.about" class="textarea" maxlength="500" placeholder="Materials, how it is made, how long you have been doing it"></textarea>
        </label>
        <div class="field">
          <label class="label" for="apply-area">Where you are based</label>
          <input id="apply-area" v-model="application.areaLabel" class="input" type="text" maxlength="80" required placeholder="Town or city, country" />
          <small>A town or city is enough. It is shown as you write it, never as a position on a map.</small>
          <div v-if="myArea && application.areaLabel !== myArea"><button class="btn sm use-area" type="button" @click="application.areaLabel = myArea.slice(0, 80)">Use my area: {{ myArea }}</button></div>
        </div>
        <div class="row wrap">
          <button class="btn primary" type="submit" :disabled="!canApply || applying">{{ applying ? 'Sending…' : 'Send application' }}</button>
          <RouterLink class="btn ghost" to="/market">Back to the Market</RouterLink>
        </div>
      </form>
    </template>

    <!-- Waiting for review -->
    <div v-else-if="seller.status === 'pending'" class="card tint-amber stack">
      <div class="row">
        <span class="icon-chip" aria-hidden="true">⏳</span>
        <div class="grow"><span class="chip amber">Waiting for review</span><h2 class="truncate">{{ seller.name }}</h2></div>
      </div>
      <p>Application sent {{ relativeTime(seller.createdAt) }}. A reviewer reads every application. You will get a note in your Inbox when it is decided, and you cannot add products until then.</p>
      <dl class="profile">
        <div><dt>Based in</dt><dd>{{ seller.areaLabel }}</dd></div>
        <div v-if="seller.about"><dt>About</dt><dd>{{ seller.about }}</dd></div>
      </dl>
      <div class="row wrap">
        <button class="btn" type="button" @click="reload">Check again</button>
        <RouterLink class="btn ghost" to="/inbox">Open Inbox</RouterLink>
        <RouterLink class="btn ghost" to="/market">Browse the Market</RouterLink>
      </div>
    </div>

    <!-- Not approved -->
    <div v-else-if="seller.status === 'suspended'" class="card tint-coral stack">
      <div class="row">
        <span class="icon-chip coral" aria-hidden="true">🚫</span>
        <div class="grow"><span class="chip coral">Not approved</span><h2 class="truncate">{{ seller.name }}</h2></div>
      </div>
      <p>A reviewer did not approve this seller profile, so it cannot list products and nothing of yours is shown in the Market. There is no way to ask for another review inside this App yet.</p>
      <ul v-if="products.length" class="small plain-list">
        <li v-for="product in products" :key="product.id">{{ product.name }} <span class="muted">· not shown to members</span></li>
      </ul>
      <div class="row wrap">
        <RouterLink class="btn" to="/market">Browse the Market</RouterLink>
        <RouterLink v-if="products.length" class="btn ghost" to="/market/quotes?tab=seller">Quotes asked of you</RouterLink>
      </div>
    </div>

    <!-- Approved: the product editor -->
    <template v-else-if="editing">
      <StateView v-if="editId && !editProduct" state="empty" art="🪑" title="That product is not one of yours" message="It may have been opened from an old link.">
        <button class="btn primary" type="button" @click="closeEditor">Back to my products</button>
      </StateView>
      <ProductEditor v-else :key="editId ?? 'new'" :product="editProduct" :currency="lastCurrency" @saved="onSaved" @cancel="closeEditor" @dirty="dirty = $event" />
    </template>

    <!-- Approved: the product list -->
    <template v-else>
      <div class="card tint-leaf row seller-head">
        <span class="icon-chip leaf" aria-hidden="true">🧰</span>
        <div class="grow stack tight">
          <div class="row wrap" style="gap: 6px"><h2 class="truncate">{{ seller.name }}</h2><span class="chip leaf">Approved seller</span></div>
          <p class="tiny muted">{{ seller.areaLabel }}</p>
        </div>
        <RouterLink class="btn sm" to="/market/quotes?tab=seller">Quote requests</RouterLink>
      </div>

      <StateView v-if="!products.length" state="empty" art="🛋" title="List your first piece" message="Choose the 3D piece that shows it, add its real sizes and options, and decide whether it has a price or is quote only.">
        <button class="btn primary" type="button" @click="openEditor(null)">Add a product</button>
      </StateView>

      <template v-else>
        <div class="row wrap between">
          <div class="tabs shelf" role="tablist" aria-label="Which products">
            <button class="tab" type="button" role="tab" :aria-selected="shelf === 'all'" @click="shelf = 'all'; confirmUnlist = false">All</button>
            <button class="tab" type="button" role="tab" :aria-selected="shelf === 'listed'" @click="shelf = 'listed'; confirmUnlist = false">Listed</button>
            <button class="tab" type="button" role="tab" :aria-selected="shelf === 'hidden'" @click="shelf = 'hidden'; confirmUnlist = false">Not listed</button>
          </div>
          <button class="btn primary" type="button" :disabled="products.length >= 100" :title="products.length >= 100 ? 'A seller can have up to 100 products' : undefined" @click="openEditor(null)">＋ Add a product</button>
        </div>

        <!-- Each product has its own Listed switch; changing all of them at once is the exception. -->
        <details class="bulk">
          <summary><span class="muted tiny grow" role="status">{{ progress || `${count(shown.length, 'product')} shown` }}</span><span class="small">List or unlist all</span></summary>
          <div class="row wrap bulk-acts">
            <button class="btn sm" type="button" :disabled="!toList.length || Boolean(progress)" @click="setMany(toList, true)">List all{{ toList.length ? ` ${toList.length}` : '' }}</button>
            <button class="btn sm" type="button" :disabled="!toUnlist.length || Boolean(progress)" @click="confirmUnlist = true">Unlist all{{ toUnlist.length ? ` ${toUnlist.length}` : '' }}</button>
          </div>
        </details>
        <div v-if="confirmUnlist" class="notice coral confirm" role="alert">
          <span class="grow">Unlist {{ count(toUnlist.length, 'product') }}? Members will no longer find {{ toUnlist.length === 1 ? 'it' : 'them' }} in the Market. Quotes already open stay open.</span>
          <span class="row">
            <button class="btn danger sm" type="button" @click="setMany(toUnlist, false)">Unlist {{ toUnlist.length }}</button>
            <button class="btn sm" type="button" @click="confirmUnlist = false">Keep listed</button>
          </span>
        </div>

        <p v-if="!shown.length" class="empty small">{{ shelf === 'listed' ? 'None of your products is listed. Members cannot find them yet.' : 'Every product is listed.' }}</p>
        <ul v-else class="products">
          <li v-for="product in shown" :key="product.id" class="card item">
            <ModelPreview class="thumb" :model="product.model" :tints="product.variants[0]?.tints" :icon="CATEGORY[product.category].icon" :label="product.name" />
            <div class="grow stack tight text">
              <strong class="truncate">{{ product.name }}</strong>
              <div class="row wrap chips">
                <span class="chip" :class="STATUS[product.status].tone">{{ STATUS[product.status].label }}</span>
                <span class="tiny muted">{{ CATEGORY[product.category].label }} · {{ count(product.variants.length, 'option') }} · <span class="num">{{ fromPrice(product) }}</span></span>
              </div>
              <div class="row wrap actions">
                <button class="btn sm" type="button" @click="openEditor(product)">Edit</button>
                <RouterLink class="btn ghost sm" :to="`/market/p/${product.id}`">View as a member</RouterLink>
              </div>
            </div>
            <div class="listed">
              <button
                class="switch" type="button" role="switch" :aria-checked="product.status === 'listed'" :aria-label="`${product.name} listed in the Market`"
                :disabled="busyId !== null || Boolean(progress)" @click="setListed(product, product.status !== 'listed')"
              ></button>
              <span class="tiny muted" aria-hidden="true">Listed</span>
            </div>
          </li>
        </ul>
      </template>
    </template>
  </PanelPage>
</template>

<style scoped>
.applications, .products, .steps, .plain-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.about { white-space: pre-line; }
.confirm { align-items: center; flex-wrap: wrap; }
.confirm > .grow { flex-basis: 220px; }
.steps li { display: flex; align-items: flex-start; gap: 12px; }
.profile { margin: 0; display: grid; gap: 6px; }
.profile > div { display: grid; grid-template-columns: 84px minmax(0, 1fr); gap: 10px; }
.profile dt { color: var(--muted); font-size: 0.82rem; font-weight: 650; }
.profile dd { margin: 0; white-space: pre-line; }
/* An area name can be long: the button wraps it instead of pushing the form sideways. */
.btn.use-area { max-width: 100%; padding-block: 6px; white-space: normal; text-align: left; overflow-wrap: anywhere; }
.seller-head { align-items: flex-start; flex-wrap: wrap; }
.seller-head > .grow { flex-basis: 150px; }
.review-head { align-items: flex-start; }
.review-head > .grow { flex-basis: 220px; }
.shelf { flex: 0 1 auto; }
.bulk > summary { display: flex; align-items: center; gap: 8px; min-height: 44px; cursor: pointer; font-weight: 650; color: var(--ink-2); list-style: none; }
.bulk > summary::-webkit-details-marker { display: none; }
.bulk > summary::after { content: "▾"; color: var(--muted); }
.bulk[open] > summary::after { transform: rotate(180deg); }
.bulk > summary .tiny { font-weight: 400; }
.bulk-acts { gap: 8px; padding-bottom: 4px; }
.item { display: flex; align-items: flex-start; gap: 12px; padding: 10px; }
.item > .thumb { width: 76px; flex: none; aspect-ratio: 1; }
.text { min-width: 0; }
.chips { gap: 6px; }
.actions { gap: 6px; margin-top: 2px; }
/* The switch keeps its size; the area that answers a finger is 42 px tall. */
.switch::before { content: ""; position: absolute; inset: -8px -4px; }
.listed { display: flex; flex-direction: column; align-items: center; gap: 4px; flex: none; padding-top: 2px; min-width: 46px; }
p.empty { padding: 18px; }
</style>
