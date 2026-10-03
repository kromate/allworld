<script setup lang="ts">
// One real product: the piece in 3D, its options with honest sizes and prices, and the three things a
// member can do with it — place it at home (free, not an order), ask the maker for a quote, or save it.
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { MemberId, ProductId, VariantId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import type { PublicMember } from '../../shared/model.ts'
import type { Product } from '../../shared/market.ts'
import { api, app, attempt, messageOf, myId, toast } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import { useLoad } from '../../ui/useLoad.ts'
import ModelPreview from './ModelPreview.vue'
import { focusIn } from './scroll.ts'
import { AVAILABILITY, CATEGORY, SAMPLE_TITLE, dimensionsText, leadTimeText, materialLabel, priceText } from './labels.ts'

const route = useRoute()
const router = useRouter()
const productId = String(route.params.id) as ProductId
const refParam = typeof route.query.ref === 'string' && /^m_[a-z0-9_-]{3,40}$/.test(route.query.ref) ? (route.query.ref as MemberId) : null

const missing = ref(false)
const chosen = ref<VariantId | null>(typeof route.query.v === 'string' ? (route.query.v as VariantId) : null)
const referrer = ref<PublicMember | null>(null)
const asking = ref(false)
const quantity = ref<number | ''>(1)
const note = ref('')
const sending = ref(false)
const saving = ref(false)
const manualLink = ref('')
const noteBox = ref<HTMLTextAreaElement | null>(null)

const { data: product, state, error, reload } = useLoad<Product | null>(async () => {
  try {
    const result = await api('market.product', { productId })
    missing.value = false
    return result.product
  } catch (cause) {
    // A malformed link is the same thing to a member as a product that is gone.
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid')) { missing.value = true; return null }
    throw cause
  }
})

const variant = computed(() => product.value?.variants.find(entry => entry.id === chosen.value) ?? product.value?.variants[0] ?? null)
const mine = computed(() => product.value?.seller.ownerId === myId())
const imperial = computed(() => app.me?.preferences.units === 'imperial')
const unavailable = computed(() => variant.value?.availability === 'unavailable')
const quantityOk = computed(() => typeof quantity.value === 'number' && Number.isInteger(quantity.value) && quantity.value >= 1 && quantity.value <= 50)
const tintList = computed(() => Object.entries(variant.value?.tints ?? {}).map(([material, colour]) => ({ material, label: materialLabel(material), colour })))
const shareLink = computed(() => `${location.origin}/market/p/${productId}${mine.value || !myId() ? '' : `?ref=${myId()}`}`)

// Who shared this link, shown by name. Only counts when the maker allows sharing and it is someone else.
watch(product, async loaded => {
  // The first option is chosen until the member picks one (or when the one in the link is gone).
  if (loaded && !loaded.variants.some(entry => entry.id === chosen.value)) chosen.value = loaded.variants[0]?.id ?? null
  if (!loaded || !refParam || !loaded.sharing.allowed || refParam === myId() || referrer.value) return
  try { referrer.value = (await api('member.public', { memberId: refParam })).member } catch { referrer.value = null }
}, { immediate: true })

function step(by: number): void {
  const current = typeof quantity.value === 'number' ? quantity.value : 1
  quantity.value = Math.min(50, Math.max(1, Math.round(current) + by))
}

async function openAsk(): Promise<void> {
  asking.value = true
  await nextTick()
  focusIn(noteBox.value)
}

async function requestQuote(): Promise<void> {
  const item = product.value, option = variant.value
  if (!item || !option || !quantityOk.value || sending.value) return
  sending.value = true
  try {
    const { quote } = await api('quote.request', {
      productId: item.id, variantId: option.id, quantity: quantity.value as number, note: note.value.trim(),
      referredBy: item.sharing.allowed ? refParam : null,
    })
    toast(`Request sent to ${item.seller.name}. Nothing was ordered or charged.`, 'good')
    void router.push(`/market/quotes/${quote.id}`)
  } catch (cause) {
    toast(messageOf(cause), 'bad')
    // The option may have gone while the form was open: show what is offered now.
    void reload()
  } finally { sending.value = false }
}

async function toggleSave(): Promise<void> {
  const item = product.value
  if (!item || saving.value) return
  saving.value = true
  const result = await attempt('market.save', { productId: item.id, saved: !item.saved }, item.saved ? 'Removed from saved.' : 'Saved. Find it under Saved in the Market.')
  saving.value = false
  if (result) product.value = result.product
}

async function share(): Promise<void> {
  try {
    await navigator.clipboard.writeText(shareLink.value)
    manualLink.value = ''
    toast('Link copied. Anyone you send it to sees this piece.', 'good')
  } catch {
    // Clipboard access can be refused: show the link so it can be copied by hand.
    manualLink.value = shareLink.value
  }
}
</script>

<template>
  <PanelPage :title="product?.name ?? (missing ? 'Product not found' : 'Product')" :subtitle="product ? `By ${product.seller.name}` : undefined" back="/market" wide>
    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />

    <StateView v-else-if="!product || !variant" state="empty" art="🪑" title="That product was not found" message="Its maker may have taken it off the Market, or the link is not complete.">
      <RouterLink class="btn primary" to="/market">Browse the Market</RouterLink>
    </StateView>

    <div v-else class="product">
      <div v-if="mine" class="notice sky">
        <span aria-hidden="true">🏷</span>
        <span class="grow">This is your listing{{ product.status === 'listed' ? '.' : '. It is not listed, so only you can see it.' }}</span>
        <RouterLink class="btn sm" :to="`/market/sell?edit=${product.id}`">Edit</RouterLink>
      </div>
      <div v-else-if="referrer" class="notice sky">
        <MemberBadge :member-id="referrer.id" :look="referrer.look" :size="32" />
        <span class="grow">{{ referrer.displayName }} shared this with you. If you ask for a quote, the maker sees that they sent you.</span>
      </div>

      <div class="cols">
        <div class="view">
          <ModelPreview large :model="product.model" :tints="variant.tints" :icon="CATEGORY[product.category].icon" :label="`${product.name} in ${variant.name}`" />
        </div>

        <div class="stack">
          <div class="row wrap chips">
            <span class="chip"><span aria-hidden="true">{{ CATEGORY[product.category].icon }}</span>{{ CATEGORY[product.category].label }}</span>
            <span v-if="product.seller.sample" class="chip grape" :title="SAMPLE_TITLE">Sample — not a real merchant</span>
          </div>
          <p v-if="product.description" class="description">{{ product.description }}</p>

          <fieldset class="options">
            <legend class="label">{{ product.variants.length > 1 ? 'Choose an option' : 'Option' }}</legend>
            <label v-for="entry in product.variants" :key="entry.id" class="option" :class="{ on: entry.id === variant.id }">
              <input v-model="chosen" class="sr-only" type="radio" name="variant" :value="entry.id" />
              <span class="swatches" aria-hidden="true">
                <span v-for="(colour, material) in entry.tints" :key="material" class="swatch" :style="{ background: colour }"></span>
                <span v-if="!Object.keys(entry.tints).length" class="swatch plain"></span>
              </span>
              <span class="grow option-text">
                <strong class="truncate">{{ entry.name }}</strong>
                <span class="muted tiny truncate">{{ entry.material }}</span>
              </span>
              <span class="option-price">
                <strong class="num small">{{ priceText(entry) }}</strong>
                <span class="chip" :class="AVAILABILITY[entry.availability].tone">{{ AVAILABILITY[entry.availability].label }}</span>
              </span>
            </label>
          </fieldset>

          <dl class="facts" aria-live="polite">
            <div><dt>Size</dt><dd class="num">{{ dimensionsText(variant.dimensionsCm, imperial) }}<span class="muted tiny"> · width × depth × height</span></dd></div>
            <div><dt>Material</dt><dd>{{ variant.material }}</dd></div>
            <div v-if="tintList.length">
              <dt>Colours</dt>
              <dd class="row wrap tints"><span v-for="tint in tintList" :key="tint.material" class="tint"><span class="swatch" :style="{ background: tint.colour }" aria-hidden="true"></span>{{ tint.label }}</span></dd>
            </div>
            <div>
              <dt>Price</dt>
              <dd v-if="variant.priceMinor !== null"><strong class="num">{{ priceText(variant) }}</strong><span class="muted tiny"> · the maker’s indicative price. Ask for a quote to get a firm one.</span></dd>
              <dd v-else><strong>Quote only</strong><span class="muted tiny"> · the maker prices this option on request.</span></dd>
            </div>
            <div><dt>Lead time</dt><dd>{{ leadTimeText(variant.leadTimeDays) }}</dd></div>
          </dl>
        </div>
      </div>

      <!-- What you can do with it -->
      <div class="card tint-amber stack">
        <div class="row wrap actions">
          <RouterLink class="btn primary" :to="`/home?place=${product.id}:${variant.id}`"><span aria-hidden="true">🏠</span>Place in my home</RouterLink>
          <button v-if="!mine" class="btn dark" type="button" :aria-expanded="asking" aria-controls="ask-form" :disabled="unavailable" @click="asking ? (asking = false) : openAsk()">Request a quote</button>
          <button class="btn" type="button" :aria-pressed="product.saved" :disabled="saving" @click="toggleSave"><span aria-hidden="true">{{ product.saved ? '♥' : '♡' }}</span>{{ product.saved ? 'Saved' : 'Save' }}</button>
        </div>
        <p class="small muted">Free. Placing it does not order it.<template v-if="unavailable && !mine"> This option is unavailable right now, so it cannot be quoted — choose another option to ask for a price.</template></p>

        <form v-if="asking && !mine && !unavailable" id="ask-form" class="stack ask" @submit.prevent="requestQuote">
          <h3>Ask {{ product.seller.name }} for a quote</h3>
          <p class="small">For <strong>{{ variant.name }}</strong>, {{ dimensionsText(variant.dimensionsCm, imperial) }}. The maker answers with a price and a lead time. Asking is free and orders nothing — you share delivery details only if you later accept their offer.</p>
          <div class="ask-fields">
            <div class="field quantity">
              <label class="label" for="ask-quantity">How many</label>
              <div class="row stepper">
                <button class="btn icon" type="button" aria-label="One fewer" :disabled="quantity === '' || quantity <= 1" @click="step(-1)">−</button>
                <input id="ask-quantity" v-model.number="quantity" class="input num" type="number" inputmode="numeric" min="1" max="50" step="1" required />
                <button class="btn icon" type="button" aria-label="One more" :disabled="quantity !== '' && quantity >= 50" @click="step(1)">+</button>
              </div>
              <small :class="{ warn: !quantityOk }">Between 1 and 50.</small>
            </div>
            <label class="field grow">
              <span>Note for the maker (optional)</span>
              <textarea ref="noteBox" v-model="note" class="textarea" maxlength="500" placeholder="Anything that changes the price: delivery area, finish, timing"></textarea>
              <small>Do not put your address or phone number here. Those are asked for only if you accept an offer.</small>
            </label>
          </div>
          <div class="row wrap">
            <button class="btn primary" type="submit" :disabled="sending || !quantityOk">{{ sending ? 'Sending…' : 'Send request' }}</button>
            <button class="btn ghost" type="button" @click="asking = false">Cancel</button>
            <span class="muted tiny">Nothing is charged in this App.</span>
          </div>
        </form>
      </div>

      <!-- Sharing: only when the maker allows it -->
      <details v-if="product.sharing.allowed" class="card share">
        <summary><h3>Share this piece</h3></summary>
        <div class="stack tight share-body">
          <p class="small muted">{{ mine ? 'Copy a link to your listing.' : 'The maker allows sharing. Your link tells them you sent the person who opens it.' }}</p>
          <div><button class="btn" type="button" @click="share"><span aria-hidden="true">🔗</span>Copy link</button></div>
          <label v-if="manualLink" class="field">
            <span>Copying was not allowed here. Select the link and copy it.</span>
            <input class="input" type="text" readonly :value="manualLink" @focus="($event.target as HTMLInputElement).select()" />
          </label>
          <blockquote v-if="product.sharing.commissionNote" class="quote-note">
            <span class="label">The maker’s note for people who share</span>
            <p>{{ product.sharing.commissionNote }}</p>
          </blockquote>
          <p class="small muted">Any commission is between you and the seller. This App does not pay it.</p>
        </div>
      </details>

      <!-- The maker: a sample is labelled at the top of the page and again in words here. -->
      <div class="card row seller">
        <span class="icon-chip" aria-hidden="true">🧰</span>
        <div class="grow stack tight">
          <h3 class="truncate">{{ product.seller.name }}</h3>
          <p class="muted tiny">{{ product.seller.areaLabel }} · as the maker wrote it</p>
          <p v-if="product.seller.about" class="small">{{ product.seller.about }}</p>
          <p v-if="product.seller.sample" class="tiny muted">Sample catalog entry — not a real merchant. You can try the quote steps, but no real maker stands behind it.</p>
        </div>
      </div>
    </div>
  </PanelPage>
</template>

<style scoped>
.product { display: flex; flex-direction: column; gap: 14px; container-type: inline-size; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
.view { position: sticky; top: 0; height: 340px; }
.chips { gap: 6px; }
.description { color: var(--ink-2); white-space: pre-line; }
.options { margin: 0; padding: 0; border: 0; display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.options legend { padding: 0; margin-bottom: 6px; }
.option { display: flex; align-items: center; gap: 10px; min-height: 52px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); cursor: pointer; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.option:hover { border-color: #cfc5b3; }
.option.on { border-color: var(--accent-strong); box-shadow: 0 0 0 3px var(--accent-soft); }
.option:has(input:focus-visible) { outline: 3px solid color-mix(in srgb, var(--sky) 70%, white); outline-offset: 2px; }
.option-text { display: flex; flex-direction: column; min-width: 0; }
.option-price { display: flex; flex-direction: column; align-items: flex-end; gap: 3px; flex: none; }
.swatches { display: inline-flex; flex: none; padding-left: 6px; }
.swatch { display: inline-block; width: 20px; height: 20px; border-radius: 50%; border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--line-strong); margin-left: -6px; flex: none; }
.swatch.plain { background: repeating-linear-gradient(45deg, var(--surface-3) 0 4px, var(--surface) 4px 8px); }
.facts { margin: 0; display: grid; gap: 0; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); overflow: hidden; }
.facts > div { display: grid; grid-template-columns: 92px minmax(0, 1fr); gap: 10px; padding: 9px 12px; }
.facts > div + div { border-top: 1px solid var(--line); }
.facts dt { color: var(--muted); font-size: 0.82rem; font-weight: 650; }
.facts dd { margin: 0; min-width: 0; }
.tints { gap: 6px 12px; }
.tint { display: inline-flex; align-items: center; gap: 6px; font-size: 0.86rem; }
.tint .swatch { margin-left: 0; width: 16px; height: 16px; }
.actions .btn { flex: 1 1 auto; }
.ask { padding-top: 12px; border-top: 1px solid #f4dfae; }
.ask-fields { display: flex; gap: 12px; align-items: flex-start; }
.quantity { flex: none; width: 150px; }
.stepper { gap: 4px; }
.stepper .input { text-align: center; padding: 9px 4px; min-width: 0; }
.stepper .btn { flex: none; }
.warn { color: var(--danger) !important; font-weight: 650; }
.quote-note { margin: 0; padding: 10px 12px; border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0; background: var(--accent-soft); display: flex; flex-direction: column; gap: 3px; }
.seller { align-items: flex-start; }
.share > summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 44px; margin: -8px 0; cursor: pointer; list-style: none; }
.share > summary::-webkit-details-marker { display: none; }
.share > summary::after { content: "▾"; color: var(--muted); }
.share[open] > summary::after { transform: rotate(180deg); }
.share-body { margin-top: 12px; }
@container (max-width: 620px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .view { position: static; height: 250px; }
  .ask-fields { flex-direction: column; }
  .quantity { width: 100%; }
  .ask-fields > .grow { width: 100%; }
}
</style>
