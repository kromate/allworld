<script setup lang="ts">
// My home, in three modes, in the same room the character stands in. Home: its name, who may visit,
// what was bought. Build: rooms, doors and the kind of house. Buy: furniture to look through, buy
// and place. Play is closing this window. The small buttons that open a mode are in the world
// (HomeDock), so with the window closed the room and the character have the screen to themselves.
// A visitor to somebody else's home gets a different, read-only window.
//
// While a price or a leave dialog is open everything behind it is inert, and the engine is told to
// freeze the room: no keys, no taps, drag, pinch or wheel. The engine is locked by the shell whenever
// any window is open; this window only ever opens the pointer on the room, for planning, and only
// when nothing is open over it.
//
// One route guard covers every way out (Play, the close button, Esc, the shell's number shortcuts,
// the outside click, a visit): a payment waiting for its answer keeps the window; unsaved furniture
// or an unpaid room plan asks save, discard or stay, and Stay keeps every draft as it is. What the
// member plays in is never a draft.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { onBeforeRouteLeave, useRoute, useRouter } from 'vue-router'
import { roomAt } from '../../shared/homes.ts'
import type { HomeId, ProductId } from '../../shared/ids.ts'
import { api, app, messageOf, toast } from '../../state/app.ts'
import { cancelHomeWalk, getEngine, leaveInterior, onFloorClicked, onItemPicked, retryScene, world } from '../../state/world.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { SHEET } from '../../ui/shell.ts'
import HomeBuildPanel from '../home/HomeBuildPanel.vue'
import HomeBuyPanel from '../home/HomeBuyPanel.vue'
import HomeLeaveSheet from '../home/HomeLeaveSheet.vue'
import HomeQuoteSheet from '../home/HomeQuoteSheet.vue'
import HomeSettings from '../home/HomeSettings.vue'
import HomeVisitor from '../home/HomeVisitor.vue'
import { reachHome } from '../home/homeEntry.ts'
import { createLeaveGuard } from '../home/homeLeave.ts'
import type { StudioMode } from '../home/homeStudio.ts'
import { useStudio } from '../home/useStudio.ts'

const route = useRoute()
const router = useRouter()
const sheet = inject(SHEET, null)
const studio = useStudio()
const { state, dirty, modal, planDirty } = studio

const checking = computed(() => world.state === 'idle' || world.state === 'loading')
const mine = computed(() => world.state === 'ready' && world.kind === 'home' && world.canEditHome)
const visiting = computed(() => world.state === 'ready' && world.kind === 'home' && !world.canEditHome)
const asked = computed<StudioMode>(() => (route.query.mode === 'build' || route.query.mode === 'buy' ? route.query.mode : 'home'))
// Building changes the rooms the character stands in: it is only offered from inside the home.
const mode = computed<StudioMode>(() => (asked.value === 'build' && !mine.value ? 'home' : asked.value))
const MODES = [['build', '🧱', 'Build'], ['buy', '🛋', 'Buy'], ['home', '🏠', 'Home']] as const
const going = ref(false)
let walkRequest = 0
let leavingForWalk = false
const walkNote = ref('')
/** Why the walk did not start, so the right next step is offered. */
const walkReason = ref<'' | 'unplaced' | 'travel' | 'other'>('')
// A product page sent a piece to place. It waits here until the member is inside their home.
const pending = ref<string | null>(typeof route.query.place === 'string' ? route.query.place : null)

// Leaving with changes: one guard for every way out (see homeLeave.ts).
const guard = createLeaveGuard(studio, text => toast(text, 'info'))
const { unsettled } = guard
/** Something is open over the room: a price, or the leave dialog. */
const frozen = computed(() => modal.value || guard.open.value)

const planning = computed(() => mine.value && !frozen.value && (mode.value === 'build' || mode.value === 'buy'))
const editing = computed(() => planning.value && (mode.value === 'build' || state.selected !== null))
const building = computed(() => mine.value && mode.value === 'build')

function setMode(next: StudioMode): void { void router.replace({ path: '/home', query: next === 'home' ? {} : { mode: next } }) }
/** Play: the window closes, the room and the character have the screen, and the keys and stick work again. The route guard asks first when there is something unsaved. */
function play(): void { void router.push('/') }

/** Every way out of this window goes through the guard; changing mode stays on the page and is not a way out. */
onBeforeRouteLeave(to => (to.path === '/home' ? true : guard.settle()))

/**
 * Ask for the walk to a front door. It starts or it says why not, and the window stays open to say it:
 * it closes only once a walk has started, never before. The member is never moved any other way.
 */
async function walkTo(homeId: HomeId | null): Promise<boolean> {
  if (going.value || !(await guard.settle())) return false
  const request = ++walkRequest, actor = app.me?.id
  const active = (): boolean => request === walkRequest && actor === app.me?.id
  going.value = true
  walkNote.value = ''; walkReason.value = ''
  const reached = await reachHome(homeId, undefined, active)
  going.value = false
  if (!active()) return false
  if (reached.ok) {
    leavingForWalk = true
    const refused = await router.push('/')
    if (refused) { leavingForWalk = false; cancelHomeWalk(); return false }
    return true
  }
  walkNote.value = reached.message
  walkReason.value = reached.reason === 'unplaced' ? 'unplaced' : reached.reason === 'travel' ? 'travel' : 'other'
  return false
}
const goHome = (): Promise<boolean> => walkTo(null)

async function applyPending(): Promise<void> {
  const wanted = pending.value
  if (!wanted || !mine.value || state.load !== 'ready') return
  pending.value = null
  const [productId, variantId] = wanted.split(':')
  void router.replace({ path: '/home', query: { mode: 'buy' } })
  try {
    const { product } = await api('market.product', { productId: productId as ProductId })
    const variant = product.variants.find(entry => entry.id === variantId) ?? product.variants[0]
    const placed = studio.place(product.model, { productId: product.id, variantId: variant?.id ?? null, tints: variant?.tints ?? {} })
    if (placed.ok) toast(`${product.name} is in your room. Placing it is free to try and is not an order.`, 'good')
    else toast(placed.reason, 'info')
  } catch (error) { toast(messageOf(error), 'bad') }
}

async function visit(homeId: HomeId): Promise<void> { if (!(await walkTo(homeId)) && walkNote.value) toast(walkNote.value, 'info') }

const stopPick = onItemPicked(key => { if (planning.value && mode.value === 'buy' && key) studio.select(key) })
const stopFloor = onFloorClicked(point => {
  if (!planning.value) return
  if (mode.value === 'buy') { studio.moveTo(point); return }
  if (!state.plan) return
  const adding = state.adding
  if (adding) { studio.moveAdding(Math.round(point.x - adding.width / 2), Math.round(point.z - adding.depth / 2)); return }
  studio.pickRoom(roomAt(state.plan.rooms, point)?.id ?? null)
})

function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  const typing = Boolean(target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))
  // The leave dialog: Escape is Stay; nothing reaches the room behind it, nor the shell's own Escape.
  if (guard.open.value) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); guard.stay() }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'r', 'R'].includes(event.key) && !typing) event.stopPropagation()
    return
  }
  // A price on the screen takes the keyboard: Escape closes it (or, while paying, waits), and nothing reaches the room behind it or the shell's own Escape.
  if (state.flow.phase !== 'idle') {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); studio.cancelFlow() }
    else if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'r', 'R'].includes(event.key) && !typing) event.stopPropagation()
    return
  }
  if (!mine.value || mode.value !== 'buy' || !studio.selectedItem.value || typing) return
  const moves: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
  if (moves[event.key]) { event.preventDefault(); event.stopPropagation(); studio.nudge(...moves[event.key]!) }
  else if (event.key === 'r' || event.key === 'R') studio.turn()
  else if (event.key === 'Delete' || event.key === 'Backspace') studio.putAway(studio.selectedItem.value.key)
}

/** Closing the tab or reloading with something unsaved, or a payment unanswered, asks first. */
function onUnload(event: BeforeUnloadEvent): void {
  if (unsettled.value || state.flow.phase === 'committing' || state.flow.phase === 'unknown') { event.preventDefault(); event.returnValue = '' }
}

// The scene follows the mode: taps on the room edit only while planning, the ceiling lifts to plan,
// the outline of what is being planned is drawn on the floor.
watch(planning, on => getEngine()?.setEditPointer(on), { immediate: true })
// A price or a dialog over the room freezes it: a drag or pinch already in progress ends, and taps, drag, pinch and wheel are ignored until it closes.
watch(frozen, on => getEngine()?.setSceneFrozen(on), { immediate: true })
watch(editing, on => getEngine()?.setEditing(on), { immediate: true })
watch([mode, mine], ([next, here]) => {
  state.mode = next
  const engine = getEngine()
  engine?.setInteriorCutaway(here && next !== 'home')
  engine?.setInteriorOverview(here && next === 'build')
  engine?.setInteriorGhost(here && next === 'build' ? studio.ghostNow() : null)
}, { immediate: true })
watch(() => [state.plan, state.adding, state.pickedRoom], () => { if (building.value) getEngine()?.setInteriorGhost(studio.ghostNow()) }, { deep: true })
watch(() => app.changed.homes, () => { if (!visiting.value) void studio.refresh() })
watch([mine, () => state.load], () => { void applyPending() })

// On a phone a price needs the whole screen, so its button is never behind a scroll in a half sheet.
let grew = false
watch(frozen, open => {
  if (!sheet) return
  if (open && sheet.half.value) { grew = true; sheet.toggle() }
  else if (!open && grew) { grew = false; if (!sheet.half.value) sheet.toggle() }
}, { immediate: true })

// The shop and the estate are the owner's. A visitor asks for neither; stepping into one's own home from a visit loads them then.
watch(visiting, here => { if (!here && state.load === 'idle') void studio.load().then(() => applyPending()) })
onMounted(() => {
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('beforeunload', onUnload)
  if (!visiting.value) void studio.load().then(() => applyPending())
})
onBeforeUnmount(() => {
  walkRequest++
  if (!leavingForWalk && going.value) cancelHomeWalk()
  window.removeEventListener('keydown', onKey, true)
  window.removeEventListener('beforeunload', onUnload)
  stopPick(); stopFloor()
  // If the page is torn down some way that did not ask (the account changed), nothing is left waiting on the dialog.
  if (guard.open.value) guard.stay()
  // A price nobody agreed to is dropped with the window; a payment in flight stays, and the dock says so.
  studio.cancelFlow()
  const engine = getEngine()
  engine?.setEditing(false); engine?.setEditPointer(false); engine?.setSceneFrozen(false); engine?.setInteriorCutaway(false); engine?.setInteriorOverview(false); engine?.setInteriorGhost(null)
})
</script>

<template>
  <PanelPage :title="visiting ? world.title : 'My home'" :subtitle="visiting ? `Visiting · ${world.home?.districtLabel}` : undefined">
    <div v-if="walkNote" class="notice coral walk-note" role="alert">
      <span class="grow">{{ walkNote }}</span>
      <button v-if="walkReason === 'unplaced' && !visiting" class="btn sm" type="button" @click="setMode('home')">Place my home</button>
      <RouterLink v-else-if="walkReason === 'travel'" class="btn sm" to="/travel">Plan the trip</RouterLink>
      <button v-else class="btn sm" type="button" :disabled="going" @click="walkNote = ''; walkReason = ''">Dismiss</button>
    </div>

    <StateView v-if="world.state === 'error'" state="error" :message="world.error" @retry="retryScene()" />

    <HomeVisitor v-else-if="visiting && world.home" :home="world.home" @mine="goHome" @leave="leaveInterior(); router.push('/')" />

    <StateView v-else-if="state.load === 'error' && !state.home" state="error" :message="state.loadError" @retry="studio.load()" />

    <template v-else-if="state.home">
      <!-- Everything behind an open price is inert: not focusable, not clickable. -->
      <div class="stack" :inert="frozen ? true : undefined">
        <section v-if="checking" class="notice sky stack tight" role="status">
          <strong>{{ world.loadingLabel || 'Checking where you are…' }}</strong>
          <p class="small">Wait for your place to load before building or placing furniture.</p>
        </section>
        <section v-else-if="!mine" class="card tint-amber stack tight" aria-label="You are outside">
          <strong>You are not at home.</strong>
          <p class="muted small">Walk to your front door to go in. You can look at the shop from here; pieces wait in storage until you are inside.</p>
          <button class="btn primary" type="button" style="align-self: flex-start" :disabled="going" @click="goHome">{{ going ? 'Starting…' : walkNote ? 'Try again' : 'Walk to my front door' }}</button>
        </section>

        <p v-if="state.catalogOld" class="notice amber" role="status">The shop has newer prices than this page knows. Reload the game before you buy; the price you are shown at the end is always the right one.</p>

        <div class="modes">
          <div class="tabs" role="tablist" aria-label="What to do at home">
            <button
              v-for="[id, icon, text] in MODES" :key="id" class="tab" type="button" role="tab" :aria-selected="mode === id"
              :disabled="id === 'build' && !mine" :title="id === 'build' && !mine ? checking ? 'Wait for your place to load' : 'Go into your home to build' : undefined" @click="setMode(id)"
            ><span aria-hidden="true">{{ icon }}</span> {{ text }}</button>
          </div>
          <button class="btn play" type="button" title="Close this window and play (Esc)" @click="play">▶ Play</button>
        </div>

        <HomeSettings v-if="mode === 'home'" :studio="studio" @visit="visit" />
        <template v-else-if="mode === 'build'">
          <p v-if="dirty" class="notice amber" role="status">
            <span class="grow">Furniture changes are not saved. Save or discard them before you change the rooms.</span>
            <button class="btn sm" type="button" :disabled="state.saving" @click="studio.discard()">Discard</button>
            <button class="btn sm primary" type="button" :disabled="state.saving" @click="studio.save()">Save</button>
          </p>
          <HomeBuildPanel :studio="studio" />
        </template>
        <HomeBuyPanel v-else :studio="studio" :can-place="mine" :checking="checking" @notice="(text, tone) => toast(text, tone)" />
      </div>

      <HomeQuoteSheet :studio="studio" />
      <HomeLeaveSheet v-if="guard.open.value" :furniture="dirty" :plan="planDirty" :saving="state.saving" :error="guard.error.value" :problems="studio.itemProblems.value" @save="guard.save()" @discard="guard.discard()" @stay="guard.stay()" />
    </template>

    <StateView v-else state="loading" />
  </PanelPage>
</template>

<style scoped>
/* At 360 px the three tabs and Play fit one row; if a longer font or a translation makes them not fit, Play drops to its own row instead of clipping. */
.modes { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.modes .tabs { flex: 1 1 220px; min-width: 0; }
.play { flex: none; margin-left: auto; }
@media (max-width: 420px) { .modes .tab { padding: 0 8px; gap: 4px; } .play { padding: 0 12px; } }
</style>
