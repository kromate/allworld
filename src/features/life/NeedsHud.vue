<script setup lang="ts">
// Food and energy at a glance, as two small bars beside the portrait and coins in the shell's player
// cluster. A low meter gains a mark and its number; a critical one also turns the outline coral. Tap
// for what each one does, how to fix it, and the nearest mapped places to eat. Every number comes
// from the world service.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { KIND_LABEL, LIFE, MEALTIMES, MEALTIME_WINDOWS, dishById } from '../../shared/life.ts'
import type { Dish } from '../../shared/life.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import { toast } from '../../state/app.ts'
import { dishLeads, foodPlaces, life, loadLife, paceSupported, roughly, walkWords } from '../../state/life.ts'
import type { DishLead, FoodPlace } from '../../state/life.ts'
import { walkToPlace, world } from '../../state/world.ts'
import { relativeTime } from '../../ui/format.ts'
import { permits, useHold } from '../../ui/gameInput.ts'
import HudIcon from '../../ui/HudIcon.vue'
import { factsOf, hotkey } from '../../ui/hudKeys.ts'
import NeedMeter from './NeedMeter.vue'

const route = useRoute()
const router = useRouter()
const root = ref<HTMLElement | null>(null)
const panel = ref<HTMLElement | null>(null)
const open = ref(false)
const retrying = ref(false)
const places = ref<FoodPlace[]>([])
const leads = ref<DishLead[]>([])
let placesTimer = 0

const state = computed(() => life.state)
const summary = computed(() => {
  const now = state.value
  if (!now) return 'Daily life'
  return `Food ${now.hunger.value} of 100, ${now.hunger.label}. Energy ${now.energy.value} of 100, ${now.energy.label}.${now.effects.onForm ? ' On form.' : ''} Open daily life.`
})
const worn = computed(() => state.value?.hunger.level === 'critical' || state.value?.energy.level === 'critical')
const clock = (iso: string): string => new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso))

/** What the two meters add up to, in a sentence. Only effects that really apply are named. */
const form = computed(() => {
  const now = state.value
  if (!now) return null
  const effects = now.effects
  if (effects.onForm) {
    return {
      tone: 'leaf', icon: '✦', title: 'On form',
      text: `Finished work shifts pay ${effects.shiftBonusPercent}% more, up to ${effects.shiftBonusCap} coins each.${effects.companyUntil ? ` You ate in good company: the lift lasts until ${clock(effects.companyUntil)}.` : ' Eat a proper meal with someone else in the room and it becomes 15% for two hours.'}`,
    }
  }
  const missing: string[] = []
  if (now.hunger.value < LIFE.bands.good) missing.push(`food to ${LIFE.bands.good} (now ${now.hunger.value})`)
  if (now.energy.value < LIFE.bands.good) missing.push(`energy to ${LIFE.bands.good} (now ${now.energy.value})`)
  const slower = worn.value && paceSupported() ? ' You also walk a little slower until then.' : ''
  return {
    tone: worn.value ? 'coral' : 'amber', icon: worn.value ? '!' : '○',
    title: now.hunger.level === 'critical' ? 'Hungry' : now.energy.level === 'critical' ? 'Exhausted' : 'Not on form yet',
    text: `Get ${missing.join(' and ')} and finished shifts pay ${LIFE.onForm.percent}% more.${slower} Nothing is locked while you wait: work, chat, games and travel all stay open.`,
  }
})

/** Today's three meals, by the local clock of the place the avatar is in. */
const dayLine = computed(() => {
  const day = state.value?.day
  if (!day) return ''
  if (day.now && !day.had.includes(day.now)) return `${MEALTIME_WINDOWS[day.now].label} time here: a proper meal now gives +${LIFE.mealtimeEnergy} energy.`
  const at = new Intl.DateTimeFormat(undefined, { timeZone: day.timezone, hour: 'numeric', minute: '2-digit' }).format(Date.parse(day.next.at))
  return `Next: ${MEALTIME_WINDOWS[day.next.which].label.toLowerCase()} from ${at} local time. Missing a meal costs nothing.`
})

const triedHere = computed<Dish[]>(() => {
  const now = state.value
  if (!now) return []
  return now.tried.filter(id => id.startsWith(`${now.region.id}.`)).flatMap(id => { const dish = dishById(id); return dish ? [dish] : [] }).reverse()
})
const note = computed(() => (life.note && Date.now() - life.noteAt < 10 * 60_000 ? life.note : ''))

function refreshPlaces(): void { places.value = foodPlaces(4); leads.value = dishLeads(3) }

function toggle(): void {
  open.value = !open.value
  if (open.value) { void loadLife(); refreshPlaces() }
}
function close(): void { open.value = false }
// Non-modal: walking carries on while it is read. It takes its turn in Escape's order (the newest open thing closes first).
useHold('life.needs', () => open.value, { role: 'panel', close })
// A modal in front (the Menu, a dialog, the account menu, the meal sheet) puts it away rather than leave it open behind.
watch(() => permits('shell'), free => { if (!free) close() })

async function retry(): Promise<void> {
  retrying.value = true
  await loadLife()
  retrying.value = false
}

function walk(place: FoodPlace): void {
  // No way there on foot from here: the map shows where it is and what is between.
  if (!place.reachable) { close(); void router.push('/map'); return }
  // Walking is foot work: not from a vehicle seat, and not behind a window or the Menu.
  if (!permits('foot')) return
  const found = walkToPlace(place.poi)
  if (!found) { toast('Step out to the street first, then you can walk there.', 'info'); return }
  toast(found.length > 0 ? `Walking to ${place.poi.name} · ${roughly(found.length)}${found.viaStreets ? ' along the streets' : ''}.` : `No clear walking route to ${place.poi.name} from here. Try walking closer first.`, 'info')
  close()
}

function goHome(): void { close(); void router.push('/home') }

function onKey(event: KeyboardEvent): void {
  // N opens daily life. Escape is the gate's. A focused button keeps its own keys; a modal in front keeps the world's.
  if (route.path !== '/' || !hotkey(factsOf(event), ['n', 'N'], permits('info'))) return
  toggle()
}
function onPointer(event: PointerEvent): void {
  if (open.value && root.value && !root.value.contains(event.target as Node)) close()
}

watch(open, value => {
  window.clearInterval(placesTimer)
  if (value) placesTimer = window.setInterval(refreshPlaces, 2000)
})
watch(() => route.path, close)

onMounted(() => {
  void loadLife()
  window.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onPointer)
})
onBeforeUnmount(() => {
  window.clearInterval(placesTimer)
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onPointer)
})
</script>

<template>
  <div ref="root" class="needs-hud">
    <button
      v-if="state" class="pill" :class="{ worn, form: state.effects.onForm }" type="button" :aria-expanded="open" aria-haspopup="dialog"
      :aria-label="summary" title="Daily life (N)" @click="toggle"
    >
      <NeedMeter kind="hunger" :need="state.hunger" tone="dark" compact />
      <NeedMeter kind="energy" :need="state.energy" tone="dark" compact />
      <span v-if="state.effects.onForm" class="badge" aria-hidden="true" title="On form"><HudIcon name="check" :size="11" :stroke-width="3" /></span>
    </button>
    <button v-else-if="life.loaded" class="pill unavailable" type="button" :disabled="retrying" @click="retry">
      <HudIcon name="food" :size="18" /><span class="small">{{ retrying ? 'Checking…' : 'Meters unavailable · try again' }}</span>
    </button>
    <span v-else class="pill loading" role="status" aria-label="Loading daily life"><span class="ghost-bar"></span><span class="ghost-bar"></span></span>

    <section v-if="open && state" ref="panel" class="panel" role="dialog" aria-label="Daily life">
      <header class="row between">
        <div class="row" style="gap: 8px">
          <h2>Daily life</h2>
          <span class="chip" :class="form?.tone">{{ form?.title }}</span>
        </div>
        <button class="btn ghost icon sm" type="button" aria-label="Close" @click="close"><HudIcon name="close" :size="18" /></button>
      </header>

      <p v-if="life.error" class="notice coral" role="alert">
        <span class="grow">The world service did not answer, so these numbers may be a little old. {{ life.error }}</span>
        <button class="btn sm" type="button" :disabled="retrying" @click="retry">Try again</button>
      </p>
      <p v-else-if="note" class="notice sky">{{ note }}</p>

      <div class="card needs">
        <div class="need">
          <span class="icon-chip" :class="state.hunger.level === 'good' ? 'leaf' : state.hunger.level === 'critical' ? 'coral' : ''" aria-hidden="true"><HudIcon name="food" :size="22" /></span>
          <div class="grow">
            <div class="row between"><strong>Food</strong><span class="chip" :class="{ leaf: state.hunger.level === 'good', amber: state.hunger.level === 'ok' || state.hunger.level === 'low', coral: state.hunger.level === 'critical' }">{{ state.hunger.label }}</span></div>
            <NeedMeter kind="hunger" :need="state.hunger" bare />
            <p class="tiny muted">Runs down slowly, and slower still while you are away. Eat out, cook at home, or have the free plain meal in your kitchen.</p>
          </div>
        </div>
        <div class="need">
          <span class="icon-chip" :class="state.energy.level === 'good' ? 'leaf' : state.energy.level === 'critical' ? 'coral' : ''" aria-hidden="true"><HudIcon name="energy" :size="22" /></span>
          <div class="grow">
            <div class="row between"><strong>Energy</strong><span class="chip" :class="{ leaf: state.energy.level === 'good', amber: state.energy.level === 'ok' || state.energy.level === 'low', coral: state.energy.level === 'critical' }">{{ state.resting ? 'Resting at home' : state.energy.label }}</span></div>
            <NeedMeter kind="energy" :need="state.energy" bare />
            <p class="tiny muted">Runs down with time and work. A minute at home, a hot drink, or time away from the game brings it back.</p>
          </div>
        </div>
      </div>

      <section class="day" aria-label="Meals today">
        <div class="row wrap meals">
          <span
            v-for="which in MEALTIMES" :key="which" class="chip" :class="{ leaf: state.day.had.includes(which), amber: state.day.now === which && !state.day.had.includes(which) }"
          ><span aria-hidden="true">{{ state.day.had.includes(which) ? '✓' : state.day.now === which ? '●' : '○' }}</span> {{ MEALTIME_WINDOWS[which].label }}<span class="sr-only">{{ state.day.had.includes(which) ? ' eaten today' : state.day.now === which ? ' now' : '' }}</span></span>
        </div>
        <p class="tiny muted">{{ dayLine }}</p>
      </section>

      <section class="stack tight" aria-label="Nearest places to eat">
        <h3>Nearest places to eat</h3>
        <ul v-if="places.length" class="plain">
          <li v-for="place in places" :key="place.poi.placeId" class="list-row">
            <span class="icon-chip" :style="{ background: `${categoryStyle(place.poi.category).color}22` }" aria-hidden="true">{{ categoryStyle(place.poi.category).icon }}</span>
            <span class="grow">
              <strong class="truncate" style="display: block">{{ place.poi.name }}</strong>
              <span class="muted tiny">{{ KIND_LABEL[place.kind] }} · {{ walkWords(place) }}{{ place.kind === 'grocery' ? ' · groceries to cook at home' : place.kind === 'market' ? ' · hot food and groceries' : place.kind === 'kiosk' ? ' · snacks and drinks' : '' }}</span>
            </span>
            <button class="btn sm" :class="{ primary: place === places[0] && place.reachable && state.hunger.level !== 'good' }" type="button" :disabled="place.reachable && !permits('foot')" :aria-label="`${place.reachable ? 'Walk to' : 'Show on the map:'} ${place.poi.name}`" @click="walk(place)">{{ place.reachable ? 'Walk there' : 'Map' }}</button>
          </li>
        </ul>
        <p v-else-if="world.kind === 'venue'" class="muted small">You are inside {{ world.title }}. Step back out to the street to walk somewhere else.</p>
        <p v-else-if="world.kind === 'home'" class="muted small">You are at home. The kitchen is right here: close this and use the Kitchen button.</p>
        <p v-else class="muted small">The map has no cafés, restaurants or food shops in this district. Your own kitchen always has a plain meal.</p>
        <div class="row between kitchen">
          <span class="small"><span aria-hidden="true">🏠</span> Kitchen at home: <strong class="num">{{ state.pantry }}</strong> of {{ LIFE.pantryMax }} cooked portions, and a free plain meal.</span>
          <button v-if="world.kind !== 'home'" class="btn sm" type="button" @click="goHome">Go home</button>
        </div>
      </section>

      <div v-if="form" class="notice form" :class="form.tone">
        <span class="form-icon" aria-hidden="true">{{ form.icon }}</span>
        <span><strong>{{ form.title }}.</strong> {{ form.text }}</span>
      </div>

      <section class="stack tight" aria-label="Food diary">
        <div class="row between"><h3>Food diary</h3><span class="chip grape num">{{ state.region.tried }} of {{ state.region.dishes }} in {{ state.region.label }}</span></div>
        <div v-if="triedHere.length" class="row wrap dishes">
          <span v-for="dish in triedHere.slice(0, 8)" :key="dish.id" class="chip"><span aria-hidden="true">{{ dish.emoji }}</span> {{ dish.name }}</span>
          <span v-if="triedHere.length > 8" class="chip">and {{ triedHere.length - 8 }} more</span>
        </div>
        <p v-else class="muted small">Nothing tried here yet. Each country has its own dishes to find{{ state.firstMealFree ? ', and your first proper meal is on the house' : '' }}.</p>
        <template v-if="leads.length">
          <h4 class="label">Next to try nearby</h4>
          <ul class="plain">
            <li v-for="lead in leads" :key="lead.dish.id" class="list-row lead">
              <span class="lead-dish" aria-hidden="true">{{ lead.dish.emoji }}</span>
              <span class="grow">
                <strong class="truncate" style="display: block">{{ lead.dish.name }}</strong>
                <span class="muted tiny">at {{ lead.place.poi.name }} · {{ walkWords(lead.place) }}</span>
              </span>
              <button class="btn sm" type="button" :disabled="lead.place.reachable && !permits('foot')" :aria-label="`Walk to ${lead.place.poi.name} for ${lead.dish.name}`" @click="walk(lead.place)">Walk there</button>
            </li>
          </ul>
        </template>
        <p v-if="state.usual" class="small"><span aria-hidden="true">⭐</span> Your usual: <strong>{{ state.usual.dish }}</strong> at {{ state.usual.place }}, where you are a regular.</p>
        <p v-if="state.together" class="small"><span aria-hidden="true">🤝</span> Meals eaten together: <strong class="num">{{ state.together }}</strong></p>
        <h4 v-if="state.meals.length" class="label">Lately</h4>
        <ul v-if="state.meals.length" class="plain recent">
          <li v-for="meal in state.meals.slice(0, 3)" :key="meal.at + meal.dishId" class="row small">
            <span aria-hidden="true">{{ meal.emoji }}</span>
            <span class="grow truncate">{{ meal.name }} <span class="muted">· {{ meal.mealtime ? `${MEALTIME_WINDOWS[meal.mealtime].label.toLowerCase()} at ` : '' }}{{ meal.where }}{{ meal.with.length ? ` · with ${meal.with.join(' and ')}` : '' }}</span></span>
            <span class="muted tiny num">{{ meal.price ? `🪙 ${meal.price}` : 'free' }} · {{ relativeTime(meal.at) }}</span>
          </li>
        </ul>
      </section>

      <p class="tiny muted">This is part of the game. Menus are not the real menus of the places on the map, nothing is ordered from them, and coins are play money.</p>
    </section>
  </div>
</template>

<style scoped>
.needs-hud { position: relative; display: inline-block; max-width: 100%; }
.pill {
  position: relative; display: flex; flex-direction: column; justify-content: center; gap: 5px; min-height: 44px; padding: 6px 10px; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 16px;
  background: rgba(28, 26, 36, 0.62); color: #fff; box-shadow: 0 2px 8px rgba(20, 14, 6, 0.22); text-align: left;
}
button.pill:hover { background: rgba(28, 26, 36, 0.8); }
.pill.worn { border-color: #ff9c8a; box-shadow: 0 0 0 1px #ff9c8a, 0 2px 8px rgba(20, 14, 6, 0.22); }
.pill.form { border-color: #8fe3b4; }
.pill :deep(.meter) { width: 82px; }
.badge { position: absolute; top: -6px; right: -6px; width: 18px; height: 18px; display: grid; place-items: center; border-radius: 50%; background: #1f6b46; border: 2px solid #8fe3b4; color: #fff; }
.pill.unavailable { flex-direction: row; align-items: center; gap: 8px; max-width: 170px; color: #ffd9d1; }
.pill.unavailable .small { white-space: normal; line-height: 1.15; font-size: 0.74rem; }
.pill.loading { width: 100px; }
.ghost-bar { display: block; width: 100%; height: 6px; border-radius: 999px; background: rgba(255, 255, 255, 0.22); animation: ghost 1.2s ease-in-out infinite; }
.ghost-bar + .ghost-bar { animation-delay: 0.2s; }
@keyframes ghost { 50% { opacity: 0.45; } }

.panel {
  position: fixed; left: calc(10px + env(safe-area-inset-left, 0px)); top: calc(var(--shell-top) + 8px); width: min(384px, calc(100vw - 20px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  max-height: calc(100dvh - var(--shell-top) - 16px - var(--safe-bottom)); overflow-y: auto; overscroll-behavior: contain; z-index: 30;
  display: flex; flex-direction: column; gap: 12px; padding: 16px; border-radius: 20px; background: var(--bg); border: 1px solid rgba(255, 255, 255, 0.7);
  box-shadow: var(--shadow-lg), 0 0 0 1px rgba(28, 26, 36, 0.08); animation: drop 0.16s ease;
}
@keyframes drop { from { transform: translateY(-6px); opacity: 0; } }
.needs { display: grid; gap: 12px; padding: 12px; }
.need { display: flex; gap: 12px; align-items: flex-start; }
.need + .need { padding-top: 12px; border-top: 1px solid var(--line); }
.need :deep(.meter) { width: 100%; margin: 5px 0 4px; }
.form { align-items: flex-start; }
.form-icon { flex: none; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; font-weight: 800; background: rgba(255, 255, 255, 0.7); }
.plain { list-style: none; margin: 0; padding: 0; }
.plain .list-row + .list-row { border-top: 1px solid var(--line); }
.kitchen { padding: 10px 12px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); gap: 10px; }
.dishes { gap: 6px; }
h4.label { margin: 6px 0 0; }
.day { display: grid; gap: 5px; }
.meals { gap: 6px; }
.lead { padding: 8px 2px; }
.lead-dish { flex: none; width: 38px; height: 38px; display: grid; place-items: center; border-radius: 12px; background: var(--grape-soft); font-size: 1.2rem; }
.recent { display: grid; gap: 6px; padding-top: 2px; }

</style>
