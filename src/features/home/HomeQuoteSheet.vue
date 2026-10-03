<script setup lang="ts">
// The one place a price is shown and agreed to. The figures are the service's quote, word for word;
// the button names the amount; and every way it can stop (too few coins, an old price, a lost
// answer, a refusal) says plainly whether anything was taken.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { roomKind } from '../../shared/homes.ts'
import { trapTab } from './focusTrap.ts'
import type { Studio } from './homeStudio.ts'

const props = defineProps<{ studio: Studio }>()
const { state, stale, affordable } = props.studio
const flow = computed(() => state.flow)
const quote = computed(() => flow.value.quote)
const shortBy = computed(() => (quote.value ? quote.value.total - (state.estate?.balance ?? quote.value.balance) : 0))
const label = (model: string): string => props.studio.label(model)

// The price runs out; the sheet notices without being asked.
const tick = ref(props.studio.now())
let timer: ReturnType<typeof setInterval> | undefined
watch(() => flow.value.phase, phase => {
  clearInterval(timer)
  if (phase === 'review' && typeof window !== 'undefined') timer = setInterval(() => { tick.value = props.studio.now() }, 15_000)
}, { immediate: true })
onBeforeUnmount(() => clearInterval(timer))
const expired = computed(() => flow.value.phase === 'review' && Boolean(quote.value && Date.parse(quote.value.expiresAt) <= tick.value))
const until = computed(() => (quote.value ? new Date(quote.value.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''))
const canPay = computed(() => flow.value.phase === 'review' && !stale.value && !expired.value && affordable.value)
const review = computed(() => quote.value?.review ?? null)

// The sheet takes the keyboard when it opens and gives it back to where it was when it closes.
const dialog = ref<HTMLElement | null>(null)
let returnTo: HTMLElement | null = null
watch(() => flow.value.phase !== 'idle', open => {
  if (typeof document === 'undefined' || typeof HTMLElement === 'undefined') return
  if (open) {
    returnTo = document.activeElement instanceof HTMLElement ? document.activeElement : null
    void nextTick(() => dialog.value?.focus({ preventScroll: true }))
  } else {
    const back = returnTo
    returnTo = null
    void nextTick(() => { if (back && back.isConnected) back.focus({ preventScroll: true }) })
  }
}, { immediate: true })
</script>

<template>
  <section v-if="flow.phase !== 'idle'" ref="dialog" class="sheet" role="dialog" aria-modal="true" aria-label="Review and pay" aria-live="polite" tabindex="-1" @keydown="trapTab($event, dialog)">
    <header class="row between">
      <h2>{{ flow.phase === 'done' ? 'Done' : flow.title || 'Home' }}</h2>
      <button v-if="flow.phase !== 'committing' && flow.phase !== 'unknown'" class="btn ghost icon sm" type="button" aria-label="Close" @click="studio.cancelFlow()">✕</button>
    </header>

    <p v-if="flow.phase === 'quoting'" class="muted" role="status">Getting the price…</p>

    <template v-else-if="(flow.phase === 'review' || flow.phase === 'committing' || flow.phase === 'unknown') && quote">
      <ul class="lines">
        <li v-for="line in quote.lines" :key="line.label" class="row between"><span>{{ line.label }}</span><span class="num">{{ line.coins }}</span></li>
        <li v-if="!quote.lines.length" class="muted small">Nothing to pay for.</li>
        <li class="row between total"><strong>Total</strong><strong class="num">{{ quote.total }} coins</strong></li>
        <li class="row between muted small"><span>You have</span><span class="num">{{ state.estate?.balance ?? quote.balance }} coins</span></li>
        <li v-if="affordable" class="row between muted small"><span>After</span><span class="num">{{ (state.estate?.balance ?? quote.balance) - quote.total }} coins</span></li>
      </ul>

      <details v-if="review && (review.rooms.added.length || review.rooms.removed.length || review.rooms.resized.length || review.items.length || review.houseType)" class="disclosure" open>
        <summary>What changes</summary>
        <ul class="changes">
          <li v-if="review.houseType">House: {{ review.houseType.from }} → {{ review.houseType.to }}</li>
          <li v-for="room in review.rooms.added" :key="room.id">Adds a {{ roomKind(room.kind).label.toLowerCase() }}, {{ room.width }} × {{ room.depth }} m</li>
          <li v-for="room in review.rooms.removed" :key="room.id">Removes the {{ roomKind(room.kind).label.toLowerCase() }}, {{ room.width }} × {{ room.depth }} m. No coins come back.</li>
          <li v-for="room in review.rooms.resized" :key="room.id">Resizes {{ room.id }} to {{ room.to.width }} × {{ room.to.depth }} m</li>
          <li v-for="piece in review.items" :key="piece.key">{{ label(piece.model) }}: {{ piece.to === 'storage' ? 'goes to storage (you keep it)' : 'moves' }}</li>
        </ul>
      </details>

      <p v-if="stale" class="notice amber" role="alert">Your home changed since this price. Nothing was charged.</p>
      <p v-else-if="expired" class="notice amber" role="alert">This price ran out. Nothing was charged.</p>
      <p v-else-if="flow.phase === 'review' && !affordable" class="notice coral" role="alert">You have {{ state.estate?.balance ?? quote.balance }} coins; this costs {{ quote.total }}. {{ shortBy }} short. Nothing was charged. <RouterLink to="/work">Earn coins</RouterLink></p>
      <p v-if="flow.problem && flow.problem.kind !== 'funds' && !stale && !expired" class="notice" :class="flow.phase === 'unknown' ? 'amber' : 'coral'" role="alert">{{ flow.problem.message }}</p>
      <p v-else-if="flow.phase === 'review' && !flow.problem" class="muted tiny">Price held until {{ until }}. Nothing is taken until you press the button.</p>

      <div class="row wrap">
        <button v-if="flow.phase === 'unknown'" class="btn primary" type="button" @click="studio.reconcile()">Check now</button>
        <button v-else-if="stale || expired || flow.problem?.retry === 'requote'" class="btn primary" type="button" @click="studio.retry()">Get a new price</button>
        <button v-else class="btn primary" type="button" :disabled="!canPay || flow.phase === 'committing'" @click="studio.confirm()">
          {{ flow.phase === 'committing' ? 'Paying…' : quote.total === 0 ? 'Confirm · free' : `Pay ${quote.total} coins` }}
        </button>
        <button v-if="flow.phase === 'review'" class="btn" type="button" @click="studio.cancelFlow()">Back</button>
      </div>
    </template>

    <template v-else-if="flow.phase === 'done' && flow.receipt">
      <p class="notice leaf" role="status">
        {{ flow.receipt.summary }}.
        <template v-if="flow.receipt.total > 0">Paid {{ flow.receipt.total }} coins.</template><template v-else>Nothing to pay.</template>
        You have {{ flow.receipt.balanceAfter }} coins.
        <template v-if="flow.repeated"> This had already gone through: you were not charged again.</template>
      </p>
      <button class="btn primary" type="button" @click="studio.cancelFlow()">Done</button>
    </template>

    <template v-else-if="flow.phase === 'failed' && flow.problem">
      <p class="notice" :class="flow.problem.kind === 'funds' ? 'coral' : 'amber'" role="alert">{{ flow.problem.message }}</p>
      <div class="row wrap">
        <button v-if="flow.problem.retry !== 'none'" class="btn primary" type="button" @click="studio.retry()">{{ flow.problem.retry === 'requote' ? 'Get a new price' : 'Try again' }}</button>
        <button class="btn" type="button" @click="studio.cancelFlow()">Close</button>
      </div>
    </template>
  </section>
</template>

<style scoped>
.sheet { position: sticky; bottom: -22px; margin: auto -18px -22px; padding: 14px 18px calc(16px + var(--safe-bottom)); display: flex; flex-direction: column; gap: 10px; background: var(--surface); border-top: 2px solid var(--accent-strong); box-shadow: 0 -10px 30px rgba(30, 22, 8, 0.14); max-height: 78%; overflow-y: auto; z-index: 3; }
.sheet:focus { outline: none; }
.sheet h2 { font-size: 1.05rem; }
.lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.total { border-top: 1px solid var(--line); padding-top: 6px; margin-top: 2px; }
.changes { margin: 0; padding: 0 0 0 18px; font-size: 0.88rem; display: grid; gap: 2px; }
@media (max-width: 720px) { .sheet { bottom: -18px; margin: auto -16px -18px; padding-inline: 16px; } }
@media (max-height: 480px) { .sheet { max-height: 100%; } }
</style>
