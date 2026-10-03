<script setup lang="ts">
// Things to do for the body, right where the member stands: the menu inside a food venue, the
// shelf inside a food shop, the kitchen and a rest at home, and a nudge towards the nearest place
// to eat when hungry on the street. The one button for "do this here" is the stage's contextual
// action (src/ui/interaction.ts); this registers it and keeps its hints short and dismissible.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KIND_LABEL, LIFE, MEALTIME_WINDOWS, TIERS, venueKindOf } from '../../shared/life.ts'
import type { Menu, MenuItem, Receipt } from '../../shared/life.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import { app, messageOf, toast } from '../../state/app.ts'
import { foodPlaces, life, loadLife, loadMenu, orderItem, roughly, walkWords } from '../../state/life.ts'
import type { FoodPlace } from '../../state/life.ts'
import { getEngine, walkToPlace, world } from '../../state/world.ts'
import HudIcon from '../../ui/HudIcon.vue'
import type { HudIconName } from '../../ui/hudIcons.ts'
import { permits, seated as inVehicle, useHold } from '../../ui/gameInput.ts'
import { factsOf, hotkey } from '../../ui/hudKeys.ts'
import { PRIORITY, useInteraction } from '../../ui/interaction.ts'
import NeedMeter from './NeedMeter.vue'
import WorkTrip from './WorkTrip.vue'
import { STATION_WORDS, approach, stationAt, stationsFor } from './stations.ts'
import type { InteriorStation, InteriorStationKind } from './stations.ts'
import { work } from './workTrip.ts'

/** Where an order is taken: a seat for something eaten here, the till or a stall for groceries. */
const EAT_AT: InteriorStationKind[] = ['table', 'bench', 'stall', 'till']
const SHOP_AT: InteriorStationKind[] = ['till', 'stall', 'shelf']

const route = useRoute()
const router = useRouter()
const open = ref(false)
const loading = ref(false)
const failed = ref('')
const refused = ref('')
const menu = ref<Menu | null>(null)
const nowhere = ref('')
const receipt = ref<Receipt | null>(null)
/** An order asked for again after its answer was lost, which had gone through the first time: said in a sentence, as it has no receipt. */
const settled = ref('')
/** An order from this room is still unanswered, so "nothing was charged" cannot be said. */
const inDoubt = computed(() => Boolean(life.unanswered && life.unanswered.room === world.roomKey))
const busy = ref('')
/** A dish chosen and not ordered yet: the avatar is walking to where it will be had. */
const pending = ref<{ item: MenuItem; station: InteriorStation; cancel(): void } | null>(null)
/** A walk to a seat stopped short in this room, so orders are taken where the member stands. */
const standing = ref(false)
/** Where the last order was taken, "at a table". Empty when it was taken standing. */
const servedAt = ref('')
/** Where a choice from this menu will be walked to, "a table". Empty when it is had on the spot. */
const seatWords = ref('')
const sheet = ref<HTMLElement | null>(null)
/** Undefined until the district has been looked at; null when it has no food place. */
const nearest = ref<FoodPlace | null | undefined>(undefined)
const dismissed = ref('')
const clock = ref(Date.now())
/** Someone in this room sat down to eat in the last minute and a half, and this place has something to eat. */
const invite = computed(() => (life.table && clock.value - life.table.heardAt < 90_000 && spot.value && !open.value ? life.table : null))
let nearTimer = 0, restTimer = 0

const ready = computed(() => world.state === 'ready' && route.path === '/')
const venueKind = computed(() => (world.kind === 'venue' && world.venue ? venueKindOf(world.venue.category, world.venue.subclass) : null))
const atHome = computed(() => world.kind === 'home' && world.canEditHome)
/** What this spot offers, if anything. `verb` is the one or two words on the action button; `label` is the whole sentence. */
const spot = computed<{ glyph: HudIconName; verb: string; label: string; title: string } | null>(() => {
  if (!ready.value) return null
  if (venueKind.value === 'grocery') return { glyph: 'basket', verb: 'Shop', label: 'Buy groceries', title: world.venue?.name ?? '' }
  if (venueKind.value === 'market') return { glyph: 'dining', verb: 'Stalls', label: 'Food stalls and groceries', title: world.venue?.name ?? '' }
  if (venueKind.value === 'kiosk') return { glyph: 'dining', verb: 'Snacks', label: 'Snacks and drinks', title: world.venue?.name ?? '' }
  if (venueKind.value) return { glyph: 'dining', verb: 'Menu', label: 'See the menu', title: world.venue?.name ?? '' }
  if (atHome.value) return { glyph: 'home', verb: 'Kitchen', label: 'Kitchen', title: 'Your kitchen' }
  return null
})
const state = computed(() => life.state)
const hungerLow = computed(() => state.value?.hunger.level === 'low' || state.value?.hunger.level === 'critical')
const energyLow = computed(() => state.value?.energy.level === 'critical')
/** One key per level, so a dismissed nudge comes back only when things get worse. */
const nudgeKey = computed(() => `${state.value?.hunger.level}|${state.value?.energy.level}`)
const nudge = computed<'eat' | 'rest' | null>(() => {
  // One thing at a time in the prompt stack: a walk to work or a shift still open comes before a nudge.
  const working = Boolean(work.trip) || Boolean(work.active && Date.parse(work.active.expiresAt) > clock.value)
  if (!ready.value || world.kind !== 'district' || !state.value || dismissed.value === nudgeKey.value || working) return null
  if (hungerLow.value) return 'eat'
  return energyLow.value ? 'rest' : null
})
/** The free first meal is waiting, and the nearest place is somewhere that serves meals. */
const welcome = computed(() => Boolean(state.value?.firstMealFree && nearest.value && nearest.value.kind !== 'kiosk' && nearest.value.kind !== 'grocery'))
/** The nearest food place is the one whose door the member is already standing at. */
const atDoor = computed(() => Boolean(nearest.value && world.nearVenue?.placeId === nearest.value.poi.placeId))
const onTheHouse = computed(() => Boolean(menu.value?.items.some(item => item.price === 0 && item.listPrice > 0)))
const subtitle = computed(() => {
  const now = menu.value
  if (!now) return ''
  if (now.place === 'home') return `Home cooking · ${now.regionLabel}`
  return `${now.kind === 'home' ? '' : KIND_LABEL[now.kind]} · ${now.regionLabel === 'Everyday' ? 'everyday menu' : `the cooking of ${now.regionLabel}`}`
})

const restores = (item: MenuItem): string[] => {
  if (item.portions) return [`${item.portions} portions for the kitchen`]
  const parts: string[] = []
  if (item.hunger) parts.push(`+${item.hunger} food`)
  if (item.energy) parts.push(`+${item.energy} energy`)
  if (item.tier === 'staple') parts.push(`up to ${LIFE.stapleCeiling}`)
  return parts
}
/** What the last order did, as whole sentences. Joined here so each one keeps its space. */
const receiptText = computed(() => {
  const paid = receipt.value
  if (!paid) return ''
  const bought = paid.pantry.to > paid.pantry.from
  const parts: string[] = []
  if (servedAt.value) parts.push(`${bought ? 'Bought' : 'Had'} ${servedAt.value}.`)
  if (bought) parts.push(`In the kitchen: ${paid.pantry.to} portions to cook at home.`)
  else {
    if (paid.hunger.to !== paid.hunger.from) parts.push(`Food ${paid.hunger.from} → ${paid.hunger.to}.`)
    if (paid.energy.to !== paid.energy.from) parts.push(`Energy ${paid.energy.from} → ${paid.energy.to}.`)
  }
  if (paid.onTheHouse) parts.push('On the house.')
  else if (paid.charged) parts.push(`${paid.charged} coins.`)
  if (paid.mealtime) parts.push(`Eaten at ${paid.mealtime} time: +${LIFE.mealtimeEnergy} energy.`)
  if (paid.newDish) parts.push('A new dish for your food diary.')
  if (paid.with.length) parts.push(`You ate with ${paid.with.join(' and ')}: it is in both your food diaries.`)
  if (paid.shared) parts.push(`Eaten in good company: shifts pay ${LIFE.company.percent}% more for ${LIFE.company.hours} hours while you are on form.`)
  if (paid.nowRegular) parts.push(`You are a regular here now: your usual is remembered and everything is ${LIFE.regular.percentOff}% off.`)
  if (state.value?.effects.onForm && !paid.shared) parts.push(`You are on form: finished shifts pay ${state.value.effects.shiftBonusPercent}% more.`)
  return parts.join(' ')
})
/** What ordering here is worth right now, one short line each, in place of a stack of notices. */
const perks = computed(() => {
  const now = menu.value
  if (!now || receipt.value) return []
  const lines: { icon: string; text: string }[] = []
  if (onTheHouse.value) lines.push({ icon: '🎁', text: 'Your first meal is on the house.' })
  else if (state.value?.firstMealFree && now.place === 'venue') lines.push({ icon: '🎁', text: 'Your first proper meal is free, but this place only has snacks and drinks. Try a café, restaurant or market stall.' })
  if (now.eating.length) lines.push({ icon: '🤝', text: `${now.eating.join(' and ')} ${now.eating.length === 1 ? 'is' : 'are'} eating here. A proper meal together: shifts pay ${LIFE.company.percent}% more for ${LIFE.company.hours} hours.` })
  if (now.mealtime) lines.push({ icon: '🕒', text: `${MEALTIME_WINDOWS[now.mealtime].label} time: a proper meal gives +${LIFE.mealtimeEnergy} energy.` })
  if (now.regular) lines.push({ icon: '⭐', text: `You are a regular here: ${LIFE.regular.percentOff}% off, after ${now.visits} visits.` })
  return lines
})
const priceLabel = (item: MenuItem): string => (item.price ? `${item.price}` : 'Free')

async function fetchMenu(): Promise<void> {
  loading.value = true
  failed.value = ''
  try {
    const result = await loadMenu()
    menu.value = result.menu
    nowhere.value = result.reason
  } catch (error) { failed.value = messageOf(error) }
  loading.value = false
}

// The menu and a walk to a seat each hold the controls through src/ui/gameInput.ts; only the walk keeps the
// avatar moving. Neither unlocks the engine itself: closing one cannot undo a window, the Menu, a vehicle seat or
// the chat field, which hold it too. Escape is the gate's: it closes the menu, or calls the order off.
useHold('life.sheet', () => open.value, { role: 'modal', close: () => hide() })
useHold('life.order', () => Boolean(pending.value), { role: 'order', preserveWalking: true, close: () => cancelPending() })

/** The stations an order from this menu is taken at, best first. None at home, or once a walk to one has failed here. */
const seatsFor = (item: MenuItem | null): InteriorStation[] =>
  (atHome.value || standing.value ? [] : stationsFor(item?.portions || (!item && venueKind.value === 'grocery') ? SHOP_AT : EAT_AT))

async function focusSheet(): Promise<void> {
  await nextTick()
  const first = sheet.value?.querySelector<HTMLElement>('.item .buy:not(:disabled)') ?? sheet.value?.querySelector<HTMLElement>('.close')
  first?.focus()
}

async function show(): Promise<void> {
  // Ordering food is foot work: not from a vehicle seat, and not behind a window or the Menu.
  if (!spot.value || open.value || pending.value || !permits('foot')) return
  open.value = true
  receipt.value = null
  settled.value = ''
  refused.value = ''
  menu.value = null
  const seat = seatsFor(null)[0]
  seatWords.value = seat && stationAt()?.id !== seat.id ? STATION_WORDS[seat.kind].the : ''
  await fetchMenu()
  await focusSheet()
}
function hide(): void {
  if (!open.value) return
  open.value = false
}

// The button for it is the stage's: a dish on its way has its own card with Cancel, so no second action is offered meanwhile.
useInteraction('life.menu', () => {
  const here = spot.value
  if (!here || pending.value || inVehicle.value) return null
  return { id: 'life.menu', priority: PRIORITY.meal, verb: here.verb, target: here.title && here.title !== here.verb ? here.title : undefined, label: here.title ? `${here.label}: ${here.title}` : here.label, icon: here.glyph, key: 'F', tone: 'primary', run: () => { void show() } }
})

// Guidance shares the existing action menu instead of covering the road with another card.
useInteraction('life.need', () => {
  if (spot.value || pending.value || !nudge.value || inVehicle.value || !state.value) return null
  const food = nudge.value === 'eat'
  if (food && nearest.value === undefined) return null
  const place = food ? nearest.value : null
  return { id: 'life.need', priority: PRIORITY.way - 1, verb: food ? 'Find food' : 'Rest',
    target: place?.poi.name ?? 'Home', label: place ? `Find food: ${place.poi.name}` : food ? 'Free meal at home' : 'Rest at home',
    icon: food ? 'food' as const : 'energy' as const, tone: 'dark' as const, disabled: !permits('foot'),
    run: () => { if (place) walk(); else void router.push('/home') } }
})

/** Order with the service, where the member now is. It decides the price and what the dish does. */
async function order(item: MenuItem): Promise<void> {
  busy.value = item.id
  settled.value = ''
  try {
    const result = await orderItem(item.id)
    menu.value = result.menu ?? menu.value
    receipt.value = result.receipt
    if (result.repeated) settled.value = `${item.name} had already gone through when the connection dropped, so it was not ordered again. It counts once; your meters and coins here are up to date.`
    // Eaten standing, the avatar mimes it. Seated, the chair is the picture: the standing mime would lift it out of the seat.
    if (result.receipt && result.receipt.pantry.to <= result.receipt.pantry.from && stationAt()?.pose !== 'sit') getEngine()?.gesture('work')
  } catch (error) {
    // No answer is not a refusal: the service may have taken the order. Choosing it again sends the same order.
    refused.value = life.unanswered?.itemId === item.id && inDoubt.value
      ? `No answer came back for ${item.name}, so it may or may not have gone through. Choose it again: it is the same order, and it cannot be charged twice.`
      : messageOf(error)
    // The offer may have changed (coins spent elsewhere, a meter moved): show what is true now.
    void fetchMenu()
  }
  busy.value = ''
}

/**
 * Choose a dish. In a room with seats the order waits until the avatar has walked to one: the menu
 * steps aside so the walk can be seen, and nothing is asked of the service before arrival.
 */
async function buy(item: MenuItem): Promise<void> {
  if (busy.value || pending.value || !item.can) return
  refused.value = ''
  const seats = seatsFor(item)
  const here = stationAt()
  const seated = here && seats.some(seat => seat.id === here.id) ? here : null
  if (!seats.length || seated) { servedAt.value = seated ? STATION_WORDS[seated.kind].at : ''; await order(item); return }
  const walk = approach(seats, (end, station) => { void arrive(end, station) })
  // No way to any seat from here: the order is taken standing, as it always was.
  if (!walk) { standing.value = true; servedAt.value = ''; await order(item); return }
  // The menu lets go before the order takes hold, so the engine is never told "locked, do not keep walking" in between.
  open.value = false
  pending.value = { item, station: walk.station, cancel: walk.cancel }
}

async function arrive(end: 'arrived' | 'stalled' | 'left', station: InteriorStation): Promise<void> {
  const chosen = pending.value
  pending.value = null
  if (!chosen || end === 'left') return
  open.value = true
  receipt.value = null
  settled.value = ''
  if (end === 'arrived') {
    servedAt.value = STATION_WORDS[station.kind].at
    seatWords.value = ''
    await order(chosen.item)
  } else {
    standing.value = true
    seatWords.value = ''
    refused.value = `The way to ${STATION_WORDS[station.kind].the} was blocked, so ${chosen.item.name} was not ordered and nothing was charged. Choose it again to have it where you stand.`
  }
  await focusSheet()
}

function cancelPending(): void {
  if (!pending.value) return
  pending.value.cancel()
  pending.value = null
}

/** The place changed, or a window opened over it: close the menu and call off an order still on its way. */
function leave(): void {
  if (pending.value) { cancelPending(); toast('Your order was called off before you sat down. Nothing was charged.', 'info') }
  hide()
}

function toWork(): void { hide(); void router.push('/work') }

function walk(): void {
  const place = nearest.value
  if (!place || !permits('foot')) return
  if (!place.reachable) { void router.push('/map'); return }
  const found = walkToPlace(place.poi)
  if (found) toast(found.length > 0 ? `Walking to ${place.poi.name} · ${roughly(found.length)}${found.viaStreets ? ' along the streets' : ''}.` : `No clear walking route to ${place.poi.name} from here. Try walking closer first.`, 'info')
  dismissed.value = nudgeKey.value
}

function findNearest(): void { nearest.value = nudge.value === 'eat' && getEngine() ? foodPlaces(1)[0] ?? null : undefined }

function onKey(event: KeyboardEvent): void {
  if (open.value && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
    const buttons = [...(sheet.value?.querySelectorAll<HTMLElement>('.item .buy:not(:disabled)') ?? [])]
    if (!buttons.length) return
    event.preventDefault()
    const at = buttons.indexOf(document.activeElement as HTMLElement)
    buttons[(at + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus()
    return
  }
  // F opens or closes the menu. It is foot work, so it is the world's only when the avatar is free (not seated, no window or
  // Menu in front); its own open menu can close itself unless something else is in front of it. Typing, a held key and a focused button's own keys are left alone.
  if (!ready.value || !spot.value || !hotkey(factsOf(event), ['f', 'F'], permits('foot', open.value ? ['life.sheet'] : []))) return
  event.preventDefault()
  if (open.value) hide(); else void show()
}

// Leaving the place closes its menu.
watch(() => [world.roomKey, route.path, app.phase], leave)
watch(() => world.roomKey, () => { standing.value = false; servedAt.value = '' })
// At home the energy meter climbs second by second on the service; look often enough to show it.
watch(() => atHome.value && ready.value && Boolean(state.value?.resting), resting => {
  window.clearInterval(restTimer)
  if (resting) restTimer = window.setInterval(() => { void loadLife() }, 3000)
}, { immediate: true })
watch(() => world.roomKey, () => { life.table = null; if (world.state === 'ready') void loadLife() })
watch(() => [nudge.value, world.roomKey, world.places.length], findNearest, { immediate: true })

onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  nearTimer = window.setInterval(() => { clock.value = Date.now(); findNearest() }, 2500)
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey, true)
  window.clearInterval(nearTimer)
  window.clearInterval(restTimer)
  pending.value?.cancel()
  // The holds are released with the component; the engine's lock follows from whatever else still holds it.
})
</script>

<template>
  <div class="life-actions">
    <!-- Home: resting is automatic, so it is shown as a state, not a chore to press. -->
    <span v-if="atHome && ready && state?.resting" class="rest glass" role="status">
      <HudIcon name="home" :size="18" />
      <span>Resting · energy <strong class="num">{{ state.energy.value }}</strong> and rising</span>
    </span>

    <!-- The walk to work, a shift left open, or a job this room can host. -->
    <WorkTrip />

    <!-- A dish chosen and on its way: it is ordered when the avatar gets to the seat, not before. -->
    <div v-if="pending" class="nudge glass" role="status">
      <span class="nudge-icon" aria-hidden="true">{{ pending.item.emoji }}</span>
      <span class="grow nudge-text">
        <strong class="truncate">{{ pending.item.name }}</strong>
        <span class="truncate">&nbsp;· walking to {{ STATION_WORDS[pending.station.kind].the }}. Not charged yet</span>
      </span>
      <button class="btn sm" type="button" @click="cancelPending">Cancel</button>
    </div>



    <!-- Someone here has sat down to eat: an opening to eat together. -->
    <div v-if="invite" class="nudge glass" role="status">
      <span class="nudge-icon" aria-hidden="true">{{ invite.dish.emoji }}</span>
      <span class="grow nudge-text"><strong class="truncate">{{ invite.from.name }}</strong><span class="truncate">&nbsp;is having {{ invite.dish.name }} here</span></span>
      <button class="btn sm primary" type="button" @click="show">Eat together</button>
      <button class="btn ghost icon sm" type="button" aria-label="Dismiss" @click="life.table = null"><HudIcon name="close" :size="16" /></button>
    </div>

    <Teleport to="body">
      <div v-if="open" class="life-scrim" @click.self="hide">
        <section ref="sheet" class="life-sheet" role="dialog" aria-modal="true" aria-labelledby="life-sheet-title">
          <header class="row head">
            <span class="icon-chip" :style="world.venue ? { background: `${categoryStyle(world.venue.category).color}22` } : undefined" aria-hidden="true"><HudIcon :name="spot?.glyph ?? 'dining'" :size="22" /></span>
            <div class="grow">
              <h2 id="life-sheet-title" class="truncate">{{ menu?.title ?? spot?.title ?? 'Menu' }}</h2>
              <p class="muted small truncate">{{ subtitle || (failed ? 'No answer from the world service' : loading ? 'Looking at what is on today…' : '') }}</p>
            </div>
            <button class="btn ghost icon sm close" type="button" aria-label="Close" @click="hide"><HudIcon name="close" :size="18" /></button>
          </header>

          <div v-if="state" class="you">
            <NeedMeter kind="hunger" :need="state.hunger" words />
            <NeedMeter kind="energy" :need="state.energy" words />
            <span class="coins num" title="Coins: play money earned by working and playing. Not credits, not real money."><HudIcon name="coin" :size="16" /> {{ state.balance.toLocaleString() }}<span class="sr-only"> coins</span></span>
          </div>

          <p v-if="receipt" class="notice leaf receipt" role="status">
            <span class="receipt-icon" aria-hidden="true">{{ receipt.emoji }}</span>
            <span><strong>{{ receipt.name }}.</strong> {{ receiptText }}</span>
          </p>
          <p v-else-if="settled" class="notice leaf" role="status">{{ settled }}</p>
          <p v-if="refused" class="notice coral" role="alert">{{ refused }}</p>
          <!-- What ordering here is worth right now: one quiet list, not a notice for each. -->
          <ul v-if="perks.length" class="perks">
            <li v-for="perk in perks" :key="perk.icon"><span aria-hidden="true">{{ perk.icon }}</span><span>{{ perk.text }}</span></li>
          </ul>
          <p v-if="seatWords && menu && !receipt" class="tiny muted"><span aria-hidden="true">🪑 </span>You walk to {{ seatWords }} for what you choose. Nothing is ordered or charged until you get there.</p>

          <div v-if="loading && !menu" class="stack" role="status" aria-label="Loading the menu">
            <div class="skeleton" style="height: 64px"></div><div class="skeleton" style="height: 64px"></div><div class="skeleton" style="height: 64px; width: 82%"></div>
          </div>
          <div v-else-if="failed" class="notice coral" role="alert">
            <div class="grow"><strong>The menu did not load.</strong><div>{{ failed }}{{ inDoubt ? '' : ' Nothing was ordered or charged.' }}</div></div>
            <button class="btn sm" type="button" @click="fetchMenu">Try again</button>
          </div>
          <div v-else-if="!menu" class="empty">
            <div class="art" aria-hidden="true">🚪</div>
            <p class="small">{{ nowhere || 'There is nothing to eat here.' }}</p>
          </div>
          <ul v-else class="items">
            <li v-for="item in menu.items" :key="item.id" class="item" :class="{ off: !item.can }">
              <span class="dish" aria-hidden="true">{{ item.emoji }}</span>
              <div class="grow">
                <div class="row name-row">
                  <strong>{{ item.name }}</strong>
                  <span v-if="item.usual" class="chip amber">Your usual</span>
                  <span v-if="item.special" class="chip coral">House special</span>
                  <span v-if="item.isNew" class="chip grape">New</span>
                </div>
                <p class="gains tiny"><span class="tier">{{ TIERS[item.tier].label }}</span><template v-if="restores(item).length"> · {{ restores(item).join(' · ') }}</template></p>
                <p class="muted tiny about">{{ item.about }}</p>
                <p v-if="!item.can" class="why tiny">
                  <template v-if="item.short">{{ item.short }} {{ item.short === 1 ? 'coin' : 'coins' }} short. A work shift pays about 100. <button class="link" type="button" @click="toWork">Go to work</button></template>
                  <template v-else>{{ item.why }}</template>
                </p>
              </div>
              <button
                class="buy btn" :class="{ primary: item.can }" type="button" :disabled="!item.can || Boolean(busy)"
                :aria-label="`${item.portions ? 'Buy' : 'Have'} ${item.name}, ${item.price ? `${item.price} coins` : 'free'}`" @click="buy(item)"
              >
                <template v-if="busy === item.id">…</template>
                <template v-else>
                  <s v-if="item.price < item.listPrice" class="was num">{{ item.listPrice }}</s>
                  <HudIcon v-if="item.price" name="coin" :size="16" /><span class="num">{{ priceLabel(item) }}</span>
                </template>
              </button>
            </li>
          </ul>

          <p class="tiny muted foot">
            Part of the game: {{ menu && menu.place !== 'home' ? `this is not ${menu.title}’s real menu, and nothing is ordered from it.` : 'nothing here is a real purchase.' }} Coins are play money.
          </p>
        </section>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.life-actions { display: contents; }
/* One-line hints in the stage's hint column: dark, short, dismissible. Their long text lives in the Daily life panel. */
.rest, .nudge { pointer-events: auto; display: flex; align-items: center; gap: 8px; border: 0; background: rgba(28, 26, 36, 0.84); color: #fff; box-shadow: 0 2px 10px rgba(20, 14, 6, 0.3); backdrop-filter: none; -webkit-backdrop-filter: none; }
.rest { padding: 7px 14px; border-radius: 999px; font-size: 0.86rem; max-width: 100%; }
.nudge { padding: 5px 5px 5px 14px; border-radius: 999px; font-size: 0.86rem; width: max-content; max-width: min(520px, 100%); }
.nudge .btn.ghost, .nudge .btn.ghost:hover:not(:disabled) { color: #fff; }
.nudge .btn:not(.primary):not(.ghost) { color: var(--ink); }
.nudge-icon { flex: none; }
.nudge-text { display: flex; min-width: 0; white-space: nowrap; }
.nudge-text .truncate { min-width: 0; }

.life-scrim { position: fixed; inset: 0; z-index: 40; display: flex; align-items: flex-end; justify-content: center; padding: 12px 12px calc(12px + var(--safe-bottom)); background: rgba(28, 26, 36, 0.28); }
.life-sheet {
  width: min(460px, 100%); max-height: min(640px, 100%); overflow-y: auto; display: flex; flex-direction: column; gap: 12px; padding: 16px;
  border-radius: 24px; background: var(--bg); border: 1px solid rgba(255, 255, 255, 0.7); box-shadow: var(--shadow-lg); animation: lift 0.2s ease;
}
@keyframes lift { from { transform: translateY(16px); opacity: 0; } }
.head { align-items: flex-start; }
.head h2 { font-size: 1.12rem; }
.you { display: grid; grid-template-columns: 1fr 1fr auto; align-items: center; gap: 8px 14px; padding: 10px 12px; border-radius: 14px; background: var(--surface); border: 1px solid var(--line); }
.coins { font-weight: 750; color: var(--accent-text); white-space: nowrap; }
.receipt { align-items: flex-start; }
.receipt-icon { font-size: 1.3rem; line-height: 1.1; }
.items { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.item { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border-radius: 16px; background: var(--surface); border: 1px solid var(--line); }
.item.off { background: var(--surface-2); }
.item.off .dish { filter: grayscale(0.6); opacity: 0.75; }
.dish { flex: none; width: 44px; height: 44px; display: grid; place-items: center; border-radius: 14px; background: var(--accent-soft); font-size: 1.5rem; }
.name-row { gap: 6px; flex-wrap: wrap; }
.gains { margin-top: 2px; color: #1c5c39; font-weight: 650; }
.tier { color: var(--ink-2); }
.about { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.perks { list-style: none; margin: 0; padding: 8px 12px; display: grid; gap: 4px; border-radius: 12px; background: var(--accent-soft); border: 1px solid #f4dfae; font-size: 0.84rem; color: #6f4500; }
.perks li { display: flex; gap: 8px; }
.why { margin-top: 4px; color: #8f2c19; }
.link { border: 0; background: none; padding: 0; color: var(--accent-text); font-weight: 700; text-decoration: underline; text-underline-offset: 3px; }
.buy { flex: none; min-width: 74px; min-height: 44px; border-radius: 14px; gap: 5px; }
.was { color: var(--muted); font-size: 0.8rem; margin-right: 2px; }
.foot { text-align: center; }

@media (max-width: 720px) {
  .life-scrim { padding: 0; align-items: flex-end; z-index: 40; }
  .life-sheet { width: 100%; max-height: 82dvh; border-radius: 24px 24px 0 0; padding: 14px 14px calc(16px + var(--safe-bottom)); border-bottom: 0; }
  .you { grid-template-columns: 1fr auto; }
  .you :deep(.meter):nth-child(2) { grid-row: 2; }
  .coins { grid-row: 1 / span 2; grid-column: 2; }
  .nudge { border-radius: 18px; padding: 7px 5px 7px 12px; width: 100%; max-width: 100%; align-items: center; }
  .nudge-text { white-space: normal; display: block; line-height: 1.3; overflow-wrap: anywhere; }
  .nudge-text strong { display: block; }
  .nudge .btn { flex: none; }
  .nudge-text .truncate { white-space: normal; }
}
</style>
