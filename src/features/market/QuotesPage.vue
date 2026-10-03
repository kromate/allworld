<script setup lang="ts">
// Every quote the member is part of: the ones they asked for and, for sellers, the ones asked of them.
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Quote } from '../../shared/market.ts'
import { api, app, messageOf, toast } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count, relativeTime } from '../../ui/format.ts'
import ModelPreview from './ModelPreview.vue'
import { quoteIsOpen, quoteNeedsMe, quoteStatus } from './labels.ts'
import type { QuoteRole } from './labels.ts'

const route = useRoute()
const router = useRouter()

const { data, state, error, reload } = useLoad(async () => {
  // Knowing whether the member sells decides if the second tab exists; the quotes still show if that check fails.
  const [quotes, seller] = await Promise.all([api('quote.list', {}), api('market.mySeller', {}).then(result => result.seller, () => null)])
  return { ...quotes, seller }
}, [() => app.changed.quotes])

const sells = computed(() => Boolean(data.value && (data.value.asSeller.length || data.value.seller)))
const tab = computed<QuoteRole>(() => (route.query.tab === 'seller' && sells.value ? 'seller' : 'buyer'))
const list = computed(() => (tab.value === 'seller' ? data.value?.asSeller : data.value?.asBuyer) ?? [])
const open = computed(() => list.value.filter(quote => quoteIsOpen(quote.status)))
const finished = computed(() => list.value.filter(quote => !quoteIsOpen(quote.status)))
const waitingOn = (role: QuoteRole): number => ((role === 'seller' ? data.value?.asSeller : data.value?.asBuyer) ?? []).filter(quote => quoteNeedsMe(quote.status, role)).length

async function show(next: QuoteRole): Promise<void> {
  confirming.value = false
  await router.replace({ path: '/market/quotes', query: next === 'seller' ? { tab: 'seller' } : {} })
}
/** Left and right arrows move between the tabs and take the focus along, as tabs should. */
async function onTabKey(event: KeyboardEvent): Promise<void> {
  if (!sells.value || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return
  event.preventDefault()
  const group = event.currentTarget as HTMLElement
  await show(tab.value === 'buyer' ? 'seller' : 'buyer')
  await nextTick()
  group.querySelector<HTMLElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
}

const withWhom = (quote: Quote): string => (tab.value === 'seller' ? quote.buyer.displayName : quote.seller.name)

// ── Withdraw every open request at once (buyer side) ──

const confirming = ref(false)
const progress = ref('')

async function withdrawAll(): Promise<void> {
  const targets = [...open.value]
  confirming.value = false
  let done = 0
  for (const quote of targets) {
    progress.value = `Withdrawing ${done + 1} of ${targets.length}…`
    try { await api('quote.withdraw', { quoteId: quote.id }); done++ } catch (cause) {
      toast(`${quote.product.name}: ${messageOf(cause)}`, 'bad')
    }
  }
  progress.value = ''
  if (done) toast(`${count(done, 'request')} withdrawn. Nothing was shared with the sellers.`, 'good')
  await reload()
}
</script>

<template>
  <PanelPage title="My quotes" subtitle="Prices you asked makers for. Nothing here takes payment." back="/market" wide>
    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />
    <template v-else-if="data">
      <div v-if="sells" class="tabs" role="tablist" aria-label="Which quotes" @keydown="onTabKey">
        <button class="tab" type="button" role="tab" :aria-selected="tab === 'buyer'" :tabindex="tab === 'buyer' ? 0 : -1" @click="show('buyer')">
          I asked <span v-if="waitingOn('buyer')" class="count num" :title="`${waitingOn('buyer')} waiting for your answer`">{{ waitingOn('buyer') }}</span>
        </button>
        <button class="tab" type="button" role="tab" :aria-selected="tab === 'seller'" :tabindex="tab === 'seller' ? 0 : -1" @click="show('seller')">
          Asked of me <span v-if="waitingOn('seller')" class="count num" :title="`${waitingOn('seller')} waiting for your offer`">{{ waitingOn('seller') }}</span>
        </button>
      </div>

      <StateView
        v-if="!list.length && tab === 'buyer'" state="empty" art="🧾" title="You have not asked for a quote yet"
        message="Open a piece in the Market and ask its maker for a price. Asking is free and orders nothing."
      >
        <RouterLink class="btn primary" to="/market">Browse the Market</RouterLink>
      </StateView>
      <StateView
        v-else-if="!list.length" state="empty" art="📮" title="No one has asked you for a quote yet"
        :message="data.seller?.status === 'approved' ? 'When a member asks for a price on one of your listed products, the request appears here.' : 'Requests appear here once your seller profile is approved and you have listed a product.'"
      >
        <RouterLink class="btn primary" to="/market/sell">Open my products</RouterLink>
      </StateView>

      <template v-else>
        <section v-if="open.length" class="stack tight" aria-labelledby="open-quotes">
          <div class="row between wrap">
            <h2 id="open-quotes">Open</h2>
            <button v-if="tab === 'buyer' && open.length > 1 && !confirming && !progress" class="btn ghost danger sm" type="button" @click="confirming = true">Withdraw all open</button>
            <span v-if="progress" class="muted small" role="status">{{ progress }}</span>
          </div>
          <div v-if="confirming" class="notice coral confirm" role="alert">
            <span class="grow">Withdraw {{ count(open.length, 'open request') }}? The sellers are no longer asked for a price, and any offers they sent are closed. This cannot be undone.</span>
            <span class="row">
              <button class="btn danger sm" type="button" @click="withdrawAll">Withdraw {{ open.length }}</button>
              <button class="btn sm" type="button" @click="confirming = false">Keep them</button>
            </span>
          </div>
          <ul class="quotes">
            <li v-for="quote in open" :key="quote.id">
              <RouterLink class="card interactive quote" :to="`/market/quotes/${quote.id}`">
                <ModelPreview class="thumb" :model="quote.product.model" :tints="quote.spec.tints" :label="`${quote.product.name} in ${quote.spec.name}`" />
                <span class="grow text">
                  <strong class="truncate">{{ quote.product.name }}</strong>
                  <span class="muted small truncate">{{ quote.spec.name }} · {{ quote.quantity }} {{ quote.quantity === 1 ? 'piece' : 'pieces' }}</span>
                  <span class="row wrap meta">
                    <span class="chip" :class="quoteStatus(quote.status, tab).tone">{{ quoteStatus(quote.status, tab).label }}</span>
                    <span class="who tiny muted"><MemberBadge v-if="tab === 'seller'" :member-id="quote.buyer.id" :look="quote.buyer.look" :size="18" /><span class="truncate">{{ tab === 'seller' ? 'From' : 'With' }} {{ withWhom(quote) }}</span></span>
                  </span>
                  <span class="tiny muted">Updated {{ relativeTime(quote.updatedAt) }} · expires {{ relativeTime(quote.expiresAt) }}</span>
                </span>
              </RouterLink>
            </li>
          </ul>
        </section>

        <section v-if="finished.length" class="stack tight" aria-labelledby="finished-quotes">
          <h2 id="finished-quotes">Finished</h2>
          <ul class="quotes">
            <li v-for="quote in finished" :key="quote.id">
              <RouterLink class="card interactive quote" :class="{ quiet: quote.status !== 'accepted' }" :to="`/market/quotes/${quote.id}`">
                <ModelPreview class="thumb" :model="quote.product.model" :tints="quote.spec.tints" :label="`${quote.product.name} in ${quote.spec.name}`" />
                <span class="grow text">
                  <strong class="truncate">{{ quote.product.name }}</strong>
                  <span class="muted small truncate">{{ quote.spec.name }} · {{ quote.quantity }} {{ quote.quantity === 1 ? 'piece' : 'pieces' }}</span>
                  <span class="row wrap meta">
                    <span class="chip" :class="quoteStatus(quote.status, tab).tone">{{ quoteStatus(quote.status, tab).label }}</span>
                    <span class="who tiny muted"><MemberBadge v-if="tab === 'seller'" :member-id="quote.buyer.id" :look="quote.buyer.look" :size="18" /><span class="truncate">{{ tab === 'seller' ? 'From' : 'With' }} {{ withWhom(quote) }}</span></span>
                  </span>
                  <span class="tiny muted">Updated {{ relativeTime(quote.updatedAt) }}</span>
                </span>
              </RouterLink>
            </li>
          </ul>
        </section>
      </template>
    </template>
  </PanelPage>
</template>

<style scoped>
.quotes { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr)); gap: 8px; }
.quotes > li { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.quote { display: flex; align-items: center; gap: 12px; padding: 10px; color: inherit; text-decoration: none; min-width: 0; }
.quote.quiet { background: var(--surface-2); }
.quote > .thumb { width: 72px; flex: none; aspect-ratio: 1; }
.text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.meta { gap: 6px; margin: 2px 0; min-width: 0; }
.who { display: inline-flex; align-items: center; gap: 5px; min-width: 0; max-width: 100%; }
.confirm { align-items: center; flex-wrap: wrap; }
.confirm > .grow { flex-basis: 220px; }
</style>
