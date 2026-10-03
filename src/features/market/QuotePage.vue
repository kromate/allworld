<script setup lang="ts">
// One quote, seen by its buyer or its seller: exactly what was asked for (frozen when it was asked),
// where it stands in plain words, and the one next step open to whoever is reading.
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import type { QuoteId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import { QUOTE_TTL_DAYS } from '../../shared/market.ts'
import type { Quote } from '../../shared/market.ts'
import { api, app, messageOf, myId, toast } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import MemberCard from '../people/MemberCard.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { dateTime, money, relativeTime } from '../../ui/format.ts'
import ModelPreview from './ModelPreview.vue'
import { focusIn } from './scroll.ts'
import {
  AVAILABILITY, SAMPLE_TITLE, amountFromMinor, dimensionsText, isCurrency, leadTimeText, materialLabel, minorFromAmount, priceText, quoteIsOpen, quoteStatus, readyIn,
} from './labels.ts'
import type { QuoteRole } from './labels.ts'

const route = useRoute()
const quoteId = String(route.params.id) as QuoteId
const missing = ref(false)

const { data: quote, state, error, reload } = useLoad<Quote | null>(async () => {
  try {
    const result = await api('quote.get', { quoteId })
    missing.value = false
    return result.quote
  } catch (cause) {
    // Only the buyer and the seller can open a quote; to anyone else it does not exist.
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid')) { missing.value = true; return null }
    throw cause
  }
}, [() => app.changed.quotes])

const role = computed<QuoteRole>(() => (quote.value?.buyer.id === myId() ? 'buyer' : 'seller'))
const buying = computed(() => role.value === 'buyer')
const other = computed(() => (quote.value ? (buying.value ? quote.value.seller.name : quote.value.buyer.displayName) : ''))
const status = computed(() => (quote.value ? quoteStatus(quote.value.status, role.value) : { label: '', tone: '' }))
const imperial = computed(() => app.me?.preferences.units === 'imperial')
const tints = computed(() => Object.entries(quote.value?.spec.tints ?? {}).map(([material, colour]) => ({ material, label: materialLabel(material), colour })))
const pieces = (n: number): string => (n === 1 ? '1 piece' : `${n} pieces`)

const tone = computed(() => {
  switch (quote.value?.status) {
    case 'requested': return 'tint-amber'
    case 'quoted': return 'tint-sky'
    case 'accepted': return 'tint-leaf'
    default: return ''
  }
})

/** Where the quote stands and what happens next, from the reader's side. */
const sentence = computed(() => {
  const q = quote.value
  if (!q) return ''
  const by = dateTime(q.expiresAt)
  switch (q.status) {
    case 'requested': return buying.value
      ? `Your request is with ${q.seller.name}. If they have not sent an offer by ${by}, it expires.`
      : `${q.buyer.displayName} asked you for a price. Send an offer by ${by}, or the request expires.`
    case 'quoted': return buying.value
      ? `${q.seller.name} sent you an offer. Accept or decline it by ${by}, or it expires.`
      : `Your offer is with ${q.buyer.displayName}. They have until ${by} to answer, and you can change it until they do.`
    case 'accepted': return buying.value
      ? `You accepted this offer. ${q.seller.name} now has your delivery details and reaches you on the phone number you gave, to arrange payment and delivery between you. Nothing was charged here.`
      : `${q.buyer.displayName} accepted your offer. Their delivery details are below: contact them to arrange payment and delivery between you. This App does not collect payment.`
    case 'declined': return buying.value
      ? 'You declined this offer. No delivery details were shared. You can ask again from the product page.'
      : `${q.buyer.displayName} declined this offer. No delivery details were shared. There is nothing more to do here.`
    case 'withdrawn': return buying.value
      ? 'You withdrew this request. No delivery details were shared. You can ask again from the product page.'
      : `${q.buyer.displayName} withdrew this request. There is nothing more to do here.`
    case 'expired':
      if (q.offer) return buying.value
        ? `This offer expired: ${QUOTE_TTL_DAYS} days passed without an answer. You can ask again from the product page.`
        : `This offer expired: ${q.buyer.displayName} did not answer within ${QUOTE_TTL_DAYS} days. There is nothing more to do here.`
      return buying.value
        ? `This request expired: ${QUOTE_TTL_DAYS} days passed without an offer. You can ask again from the product page.`
        : `This request expired: ${QUOTE_TTL_DAYS} days passed without an offer. There is nothing more to do here.`
  }
  return ''
})

// ── Actions ──

type Mode = 'idle' | 'accept' | 'decline' | 'withdraw' | 'offer'
const mode = ref<Mode>('idle')
const busy = ref(false)
const tried = ref(false)
const panel = ref<HTMLElement | null>(null)

const delivery = reactive({ recipient: '', phone: '', address: '', notes: '' })
const draft = reactive({ amount: '' as number | '', currency: '', leadTime: '' as number | '', note: '' })
let primed = false

watch(quote, loaded => {
  if (!loaded) return
  // An end state closes any form that was open when it changed under the reader.
  if (!quoteIsOpen(loaded.status)) mode.value = 'idle'
  if (primed) return
  primed = true
  draft.currency = loaded.offer?.currency ?? loaded.spec.currency
  draft.amount = loaded.offer ? amountFromMinor(loaded.offer.priceMinor) : ''
  draft.leadTime = loaded.offer?.leadTimeDays ?? loaded.spec.leadTimeDays ?? ''
  draft.note = loaded.offer?.note ?? ''
}, { immediate: true })

async function open(next: Mode): Promise<void> {
  mode.value = next
  tried.value = false
  await nextTick()
  // A form starts in its first field. A confirmation starts on the button that changes nothing.
  const target = next === 'decline' || next === 'withdraw'
    ? [...(panel.value?.querySelectorAll<HTMLElement>('button') ?? [])].at(-1)
    : panel.value?.querySelector<HTMLElement>('input, textarea, button')
  focusIn(target)
}

const offerMinor = computed(() => minorFromAmount(draft.amount))
const offerProblem = computed(() => {
  if (offerMinor.value === null) return 'Enter the price as a whole amount, without decimals.'
  if (!isCurrency(draft.currency)) return 'The currency is three capital letters, for example NGN.'
  if (typeof draft.leadTime !== 'number' || !Number.isInteger(draft.leadTime) || draft.leadTime < 0 || draft.leadTime > 365) return 'Lead time is a whole number of days, from 0 to 365.'
  return ''
})
const offerPreview = computed(() => {
  const q = quote.value
  if (!q || offerProblem.value || offerMinor.value === null) return ''
  return `${money(offerMinor.value, draft.currency)}${q.quantity > 1 ? ` in total for ${pieces(q.quantity)}` : ''}, ${readyIn(draft.leadTime as number).toLowerCase()}`
})
const deliveryReady = computed(() => Boolean(delivery.recipient.trim() && delivery.phone.trim() && delivery.address.trim()))

async function run(work: () => Promise<{ quote: Quote }>, done: string): Promise<void> {
  if (busy.value) return
  busy.value = true
  try {
    quote.value = (await work()).quote
    mode.value = 'idle'
    toast(done, 'good')
  } catch (cause) {
    toast(messageOf(cause), 'bad')
    // It may have expired or been answered meanwhile: show where it stands now.
    void reload()
  } finally { busy.value = false }
}

function sendOffer(): void {
  tried.value = true
  if (offerProblem.value || offerMinor.value === null) return
  const updating = quote.value?.status === 'quoted'
  void run(() => api('quote.offer', { quoteId, priceMinor: offerMinor.value as number, currency: draft.currency, leadTimeDays: draft.leadTime as number, note: draft.note.trim() }),
    updating ? `Offer updated. ${other.value} has ${QUOTE_TTL_DAYS} days to answer.` : `Offer sent to ${other.value}. They have ${QUOTE_TTL_DAYS} days to answer.`)
}
function accept(): void {
  tried.value = true
  if (!deliveryReady.value) return
  void run(() => api('quote.decide', {
    quoteId, accept: true,
    fulfilment: { recipient: delivery.recipient.trim(), phone: delivery.phone.trim(), address: delivery.address.trim(), notes: delivery.notes.trim() },
  }), `Offer accepted. ${other.value} now has your delivery details. Nothing was charged.`)
}
const decline = (): void => { void run(() => api('quote.decide', { quoteId, accept: false, fulfilment: null }), 'Offer declined. Nothing was shared.') }
const withdraw = (): void => { void run(() => api('quote.withdraw', { quoteId }), 'Request withdrawn.') }

async function copyDelivery(): Promise<void> {
  const details = quote.value?.fulfilment
  if (!details) return
  const text = [details.recipient, details.phone, details.address, details.notes].filter(Boolean).join('\n')
  try { await navigator.clipboard.writeText(text); toast('Delivery details copied.', 'good') } catch { toast('Copying was not allowed here. Select the text and copy it.', 'info') }
}
</script>

<template>
  <PanelPage
    :title="quote ? quote.product.name : missing ? 'Quote not found' : 'Quote'" :subtitle="quote ? `Quote · ${quote.spec.name} · ${pieces(quote.quantity)}` : undefined"
    :back="quote && !buying ? '/market/quotes?tab=seller' : '/market/quotes'" wide
  >
    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />

    <StateView v-else-if="!quote" state="empty" art="🧾" title="That quote was not found" message="A quote can be opened only by the member who asked and the seller who was asked.">
      <RouterLink class="btn primary" to="/market/quotes">Open my quotes</RouterLink>
    </StateView>

    <div v-else class="quote">
      <!-- Where it stands, and the next step -->
      <section class="card stack" :class="tone" aria-labelledby="quote-status">
        <div class="stack tight">
          <div><span id="quote-status" class="chip" :class="status.tone">{{ status.label }}</span></div>
          <p>{{ sentence }}</p>
        </div>

        <div v-if="quote.offer" class="offer">
          <div class="row wrap between">
            <span class="label">{{ buying ? 'Their offer' : 'Your offer' }}</span>
            <span class="tiny muted">Sent {{ dateTime(quote.offer.offeredAt) }}</span>
          </div>
          <p class="amount"><strong class="num">{{ money(quote.offer.priceMinor, quote.offer.currency) }}</strong><span v-if="quote.quantity > 1" class="muted small"> in total for {{ pieces(quote.quantity) }}</span></p>
          <p class="small">{{ readyIn(quote.offer.leadTimeDays) }}, counted from when you both agree.</p>
          <p v-if="quote.offer.note" class="note">“{{ quote.offer.note }}”</p>
        </div>

        <!-- Buyer -->
        <template v-if="buying">
          <div v-if="quote.status === 'requested' && mode === 'idle'" class="row wrap">
            <button class="btn danger" type="button" @click="open('withdraw')">Withdraw request</button>
          </div>
          <div v-else-if="quote.status === 'quoted' && mode === 'idle'" class="stack tight">
            <div class="row wrap">
              <button class="btn primary" type="button" @click="open('accept')">Accept offer</button>
              <button class="btn" type="button" @click="open('decline')">Decline</button>
            </div>
            <p class="tiny muted">Accepting asks for your delivery details and shares them with the seller. It does not pay for anything.</p>
          </div>

          <form v-if="mode === 'accept' && quote.status === 'quoted'" ref="panel" class="stack form" @submit.prevent="accept">
            <h3>Where should it go?</h3>
            <p class="notice sky"><span aria-hidden="true">🔒</span><span>Shared only with this seller, only now that you accept.</span></p>
            <div class="pair">
              <label class="field"><span>Who receives it</span><input v-model="delivery.recipient" class="input" type="text" maxlength="80" autocomplete="name" required /></label>
              <label class="field"><span>Phone</span><input v-model="delivery.phone" class="input" type="tel" maxlength="40" autocomplete="tel" required /></label>
            </div>
            <label class="field"><span>Delivery address</span><textarea v-model="delivery.address" class="textarea" maxlength="300" autocomplete="street-address" required></textarea></label>
            <label class="field"><span>Notes for delivery (optional)</span><input v-model="delivery.notes" class="input" type="text" maxlength="300" placeholder="Gate code, best time, a landmark" /></label>
            <p v-if="tried && !deliveryReady" class="problem small" role="alert">The seller needs a name, a phone number and an address to deliver.</p>
            <div class="row wrap">
              <button class="btn primary" type="submit" :disabled="busy">{{ busy ? 'Accepting…' : 'Accept and share' }}</button>
              <button class="btn ghost" type="button" :disabled="busy" @click="mode = 'idle'">Not yet</button>
            </div>
            <p class="tiny muted">Accepting does not pay for anything. You and the seller arrange payment and delivery between you.</p>
          </form>

          <div v-if="mode === 'decline' && quote.status === 'quoted'" ref="panel" class="notice coral confirm" role="alert">
            <span class="grow">Decline this offer? The quote closes and the seller is told. To get another price you would ask again.</span>
            <span class="row">
              <button class="btn danger sm" type="button" :disabled="busy" @click="decline">{{ busy ? 'Declining…' : 'Decline offer' }}</button>
              <button class="btn sm" type="button" :disabled="busy" @click="mode = 'idle'">Keep it open</button>
            </span>
          </div>
          <div v-if="mode === 'withdraw' && quote.status === 'requested'" ref="panel" class="notice coral confirm" role="alert">
            <span class="grow">Withdraw this request? The seller is no longer asked for a price. This cannot be undone.</span>
            <span class="row">
              <button class="btn danger sm" type="button" :disabled="busy" @click="withdraw">{{ busy ? 'Withdrawing…' : 'Withdraw request' }}</button>
              <button class="btn sm" type="button" :disabled="busy" @click="mode = 'idle'">Keep it</button>
            </span>
          </div>
        </template>

        <!-- Seller -->
        <template v-else>
          <div v-if="quote.status === 'quoted' && mode === 'idle'" class="row wrap">
            <button class="btn" type="button" @click="open('offer')">Change the offer</button>
          </div>
          <form v-if="quote.status === 'requested' || (quote.status === 'quoted' && mode === 'offer')" ref="panel" class="stack form" @submit.prevent="sendOffer">
            <h3>{{ quote.status === 'quoted' ? 'Change your offer' : 'Your offer' }}</h3>
            <div class="trio">
              <label class="field">
                <span>{{ quote.quantity > 1 ? `Price in total for ${pieces(quote.quantity)}` : 'Price' }}</span>
                <input v-model.number="draft.amount" class="input num" type="number" inputmode="numeric" min="0" step="1" placeholder="0" required />
              </label>
              <label class="field currency">
                <span>Currency</span>
                <input v-model="draft.currency" class="input" type="text" maxlength="3" autocapitalize="characters" spellcheck="false" required @input="draft.currency = draft.currency.toUpperCase()" />
              </label>
              <label class="field">
                <span>Ready in (days)</span>
                <input v-model.number="draft.leadTime" class="input num" type="number" inputmode="numeric" min="0" max="365" step="1" required />
              </label>
            </div>
            <p v-if="quote.spec.priceMinor !== null" class="tiny muted">Your listing showed {{ priceText(quote.spec) }} each when they asked.</p>
            <label class="field">
              <span>Note for the buyer (optional)</span>
              <textarea v-model="draft.note" class="textarea" maxlength="500" placeholder="What the price includes: delivery, finish, how you take payment"></textarea>
            </label>
            <p v-if="tried && offerProblem" class="problem small" role="alert">{{ offerProblem }}</p>
            <p v-else-if="offerPreview" class="small" role="status">The buyer will see: <strong>{{ offerPreview }}</strong>.</p>
            <div class="row wrap">
              <button class="btn primary" type="submit" :disabled="busy">{{ busy ? 'Sending…' : quote.status === 'quoted' ? 'Update offer' : 'Send offer' }}</button>
              <button v-if="quote.status === 'quoted'" class="btn ghost" type="button" :disabled="busy" @click="mode = 'idle'">Cancel</button>
            </div>
            <p class="tiny muted">An offer is a price, not a charge. You see the buyer’s delivery details only if they accept.</p>
          </form>
        </template>

        <!-- End states -->
        <div v-if="!quoteIsOpen(quote.status) && quote.status !== 'accepted'" class="row wrap">
          <RouterLink v-if="buying" class="btn primary" :to="`/market/p/${quote.product.id}`">Back to the product</RouterLink>
          <RouterLink v-else class="btn" to="/market/quotes?tab=seller">See other requests</RouterLink>
        </div>
      </section>

      <div class="cols">
        <!-- Exactly what was asked for -->
        <section class="card stack" aria-labelledby="quote-spec">
          <div>
            <h2 id="quote-spec">What was asked for</h2>
            <p class="small muted">As requested on {{ dateTime(quote.createdAt) }}. Later changes to the listing do not change this.</p>
          </div>
          <ModelPreview class="spec-shot" :model="quote.product.model" :tints="quote.spec.tints" :label="`${quote.product.name} in ${quote.spec.name}`" />
          <dl class="facts">
            <div><dt>Piece</dt><dd><RouterLink :to="`/market/p/${quote.product.id}`">{{ quote.product.name }}</RouterLink></dd></div>
            <div><dt>Option</dt><dd>{{ quote.spec.name }}</dd></div>
            <div><dt>How many</dt><dd class="num">{{ quote.quantity }}</dd></div>
            <div><dt>Size</dt><dd class="num">{{ dimensionsText(quote.spec.dimensionsCm, imperial) }}<span class="muted tiny"> · width × depth × height</span></dd></div>
            <div><dt>Material</dt><dd>{{ quote.spec.material }}</dd></div>
            <div v-if="tints.length">
              <dt>Colours</dt>
              <dd class="tints"><span v-for="tint in tints" :key="tint.material" class="tint"><span class="swatch" :style="{ background: tint.colour }" aria-hidden="true"></span>{{ tint.label }} <span class="muted tiny num">{{ tint.colour }}</span></span></dd>
            </div>
            <div><dt>Listed price</dt><dd>{{ quote.spec.priceMinor === null ? 'Quote only' : `${priceText(quote.spec)} each, indicative` }}</dd></div>
            <div><dt>Availability</dt><dd>{{ AVAILABILITY[quote.spec.availability].label }}</dd></div>
            <div><dt>Lead time</dt><dd>{{ leadTimeText(quote.spec.leadTimeDays) }}<span class="muted tiny"> · as listed</span></dd></div>
            <div v-if="quote.note"><dt>{{ buying ? 'Your note' : 'Their note' }}</dt><dd class="pre">{{ quote.note }}</dd></div>
          </dl>
        </section>

        <div class="stack">
          <!-- Private delivery details: shown only when the service returns them -->
          <section v-if="quote.fulfilment" class="card tint-leaf stack tight" aria-labelledby="quote-delivery">
            <div class="row between wrap">
              <h2 id="quote-delivery">{{ buying ? 'Delivery details you shared' : `Delivery details from ${quote.buyer.displayName}` }}</h2>
              <button v-if="!buying" class="btn sm" type="button" @click="copyDelivery">Copy</button>
            </div>
            <dl class="facts plain">
              <div><dt>Receives it</dt><dd>{{ quote.fulfilment.recipient }}</dd></div>
              <div><dt>Phone</dt><dd><a :href="`tel:${quote.fulfilment.phone.replace(/[^+\d]/g, '')}`">{{ quote.fulfilment.phone }}</a></dd></div>
              <div><dt>Address</dt><dd class="pre">{{ quote.fulfilment.address }}</dd></div>
              <div v-if="quote.fulfilment.notes"><dt>Notes</dt><dd class="pre">{{ quote.fulfilment.notes }}</dd></div>
            </dl>
            <p class="tiny muted"><span aria-hidden="true">🔒 </span>Only you and {{ other }} can see these. {{ buying ? '' : 'Use them for this delivery only.' }}</p>
          </section>

          <!-- Who is on the other side -->
          <section v-if="buying" class="card row party" aria-label="The seller">
            <span class="icon-chip" aria-hidden="true">🧰</span>
            <div class="grow stack tight">
              <h3 class="truncate">{{ quote.seller.name }}</h3>
              <p class="muted tiny">{{ quote.seller.areaLabel }} · as the seller wrote it</p>
              <p v-if="quote.seller.sample"><span class="chip grape" :title="SAMPLE_TITLE">Sample — not a real merchant</span></p>
            </div>
          </section>
          <section v-else class="card" aria-label="The buyer">
            <MemberCard :member="quote.buyer" subtitle="Asked for this quote" compact />
          </section>

          <p v-if="quote.referredBy" class="card row referred">
            <MemberBadge :member-id="quote.referredBy.id" :look="quote.referredBy.look" :size="32" />
            <span class="grow small">{{ buying ? `${quote.referredBy.displayName} shared this piece with you, and the seller can see that.` : `${quote.referredBy.displayName} shared your listing with this buyer.` }} <span class="muted">Any commission is between the seller and the member who shared. This App does not pay it.</span></span>
          </p>

          <section class="card stack tight" aria-labelledby="quote-timeline">
            <h2 id="quote-timeline">What happened</h2>
            <ol class="timeline">
              <li v-for="(entry, index) in quote.timeline" :key="index">
                <span class="tiny muted num">{{ dateTime(entry.at) }} · {{ relativeTime(entry.at) }}</span>
                <span>{{ entry.text }}.</span>
              </li>
            </ol>
          </section>
        </div>
      </div>

      <p v-if="quote.payment === 'not-collected'" class="notice amber"><span aria-hidden="true">💳</span><span><strong>Payment: not collected in this App.</strong> A quote is a conversation about price. No money moves here and nothing is owned until you and the other side settle it yourselves.</span></p>
    </div>
  </PanelPage>
</template>

<style scoped>
.quote { display: flex; flex-direction: column; gap: 14px; container-type: inline-size; }
.cols { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; align-items: start; }
.offer { padding: 12px; border-radius: 12px; background: rgba(255, 255, 255, 0.72); border: 1px solid var(--line); display: flex; flex-direction: column; gap: 4px; }
.amount strong { font-size: 1.5rem; letter-spacing: -0.02em; }
.note { color: var(--ink-2); white-space: pre-line; }
.form { padding-top: 12px; border-top: 1px solid var(--line); }
.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.trio { display: grid; grid-template-columns: minmax(0, 1.4fr) 92px minmax(0, 1fr); gap: 12px; align-items: end; }
.problem { color: var(--danger); font-weight: 650; }
.confirm { align-items: center; flex-wrap: wrap; }
.confirm > .grow { flex-basis: 220px; }
.quote > .cols .spec-shot { max-width: 320px; margin: 0 auto; }
.facts { margin: 0; display: grid; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); overflow: hidden; }
.facts > div { display: grid; grid-template-columns: 96px minmax(0, 1fr); gap: 10px; padding: 8px 12px; }
.facts > div + div { border-top: 1px solid var(--line); }
.facts.plain { background: rgba(255, 255, 255, 0.7); }
.facts dt { color: var(--muted); font-size: 0.82rem; font-weight: 650; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.pre { white-space: pre-line; }
.tints { display: flex; flex-direction: column; gap: 4px; }
.tint { display: inline-flex; align-items: center; gap: 6px; font-size: 0.88rem; }
.swatch { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--surface); box-shadow: 0 0 0 1px var(--line-strong); flex: none; }
.party, .referred { align-items: flex-start; }
.timeline { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--line-strong); display: flex; flex-direction: column; gap: 10px; }
.timeline li { position: relative; display: flex; flex-direction: column; gap: 1px; }
.timeline li::before { content: ""; position: absolute; left: -20px; top: 6px; width: 10px; height: 10px; border-radius: 50%; background: var(--surface); border: 2px solid var(--accent-strong); }
@container (max-width: 620px) {
  .cols { grid-template-columns: minmax(0, 1fr); }
  .pair { grid-template-columns: minmax(0, 1fr); }
  .trio { grid-template-columns: minmax(0, 1fr) 92px; }
  .trio > :last-child { grid-column: 1 / -1; }
}
</style>
