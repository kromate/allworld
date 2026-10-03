<script setup lang="ts">
// The world view: the 3D canvas and a deliberately quiet heads-up display around it.
//
// What is always on screen is only what is needed to play: the mini-map at the upper left (under the
// player cluster the shell draws), a short column of icon buttons at the right edge (Menu, Place,
// People, Gestures, Chat), the thumb pad at the lower left on a touch screen, and ONE contextual
// action at the lower right. The centre of the screen is left to the avatar and the road.
// Everything else opens on demand, one panel at a time, and goes away again: place details, the
// places list, view and controls, people, gestures, chat, a selected person. Short facts that are
// worth a moment (where you are now, a walk under way, hunger) appear as a one-line hint and fade.
//
// Integration slots (see docs/ux/GAMEPLAY-HUD-030.md):
//  - Contextual action: any component calls `useInteraction(id, () => Interaction | null)` from
//    src/ui/interaction.ts. The most pressing one is the button; the rest are behind its arrow.
//  - Decisions: `<template #transport="{ driveAllowed, overlayOpen }">` renders in the decision slot, for a
//    fare quote, a destination, a consent, an error or a result. It stays on screen when a page opens over
//    the world (above the page, compact), because a pending decision is not idle HUD. The slot props say
//    whether a held driving input may steer (`driveAllowed`) or something has taken the input (`overlayOpen`).
//  - `seated`: the avatar is in a vehicle. Foot input is held, the thumb pad is hidden, and only actions
//    whose id starts with `transport.` are offered. Chat, gestures sent to others and opening panels stay.
//  - Doorway: inside a building, walking up to the door asks "Exit?" (src/features/world/doorway.ts) with a "Don't ask
//    again" box that makes later exits automatic. The question is a small card above the action, shown only at the door.
// Who may steer or use the world's keys is decided in one place, src/ui/gameInput.ts: this stage, the Menu,
// route windows, the meal sheet, an order on its way and the chat field each take a hold there, and the
// engine's lock is derived from all of them. Nothing in the HUD calls the engine's lock directly.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { PROXIMITY_RADIUS } from '../../shared/model.ts'
import type { PresenceMember } from '../../shared/model.ts'
import { providers } from '../../config/providers.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import { app } from '../../state/app.ts'
import {
  attachCanvas, crossEdge, detachCanvas, engineReady, enterHome, enterVenue, getEngine, retryScene, returnToArrival, sendChat, setTimeMode, walkToHome, walkToPlace, world,
} from '../../state/world.ts'
import { voice, setVoice } from '../../platform/voice.ts'
import { channelLevel, channels, setChannelMuted } from '../../state/sound.ts'
import AssetProgress from '../../ui/AssetProgress.vue'
import HudIcon from '../../ui/HudIcon.vue'
import { driveAllowed, footBlocked, keysBlocked, overlayOpen, permits, seated, syncEngine, useHold } from '../../ui/gameInput.ts'
import { fullscreenAvailable, inFullscreen, toggleFullscreen, useMedia } from '../../ui/hudDevice.ts'
import { factsOf, isTyping, worldKey } from '../../ui/hudKeys.ts'
import { PRIORITY, interactionForKey, interactions, useInteraction } from '../../ui/interaction.ts'
import type { Interaction } from '../../ui/interaction.ts'
import { assetProgress } from '../../assets/assetProgress.ts'
import MemberCard from '../people/MemberCard.vue'
import LifeActions from '../life/LifeActions.vue'
import SocialHud from '../social/SocialHud.vue'
import FeedbackEntry from '../feedback/FeedbackEntry.vue'
import HomeDock from '../home/HomeDock.vue'
import { work } from '../life/workTrip.ts'
import TouchStick from './TouchStick.vue'
import { useGameReload } from '../../ui/gameReload.ts'
import DoorwayPrompt from './DoorwayPrompt.vue'
import { answerExit, answerStay, asking, doorway, leaveNow, setAutoExit, useDoorway } from './doorway.ts'

const props = defineProps<{
  dimmed: boolean
  /** The world is covered or not there to see: stop drawing it. */
  suspended: boolean
  /** A half-height page covers the lower part of a phone screen: the scene is framed in what is left above it. */
  sheet?: boolean
  /** The avatar is in a vehicle: foot controls are locked and hidden. See the integration note above. */
  seated?: boolean
  /** The shell's Menu sheet is open: the stage puts its own panels away. The Menu's hold on the input is the shell's (App.vue). */
  menuOpen?: boolean
  /** Unread messages and inbox items waiting behind the Menu: a dot on its button, the count in its name. */
  menuBadge?: number
}>()
const emit = defineEmits<{ menu: [] }>()
defineSlots<{ transport?(props: { driveAllowed: boolean; overlayOpen: boolean }): unknown }>()
const router = useRouter()
const canvas = ref<HTMLCanvasElement | null>(null)
const draft = ref('')
const chatLog = ref<HTMLElement | null>(null)
const chatInput = ref<HTMLInputElement | null>(null)
const chatFocused = ref(false)
const chatUnseen = ref(0)
const peopleAttention = ref(false)
const placeQuery = ref('')
const walking = ref('')
const minimap = ref<HTMLCanvasElement | null>(null)
const stage = ref<HTMLElement | null>(null)
const panelRoot = ref<HTMLElement | null>(null)
/** Where SocialHud draws the People and Gestures panels. An element of its own with no Vue-rendered children, because Teleport should not target an element Vue also patches. */
const panelHost = ref<HTMLElement | null>(null)
/** The "other actions" list and the map credits: small popovers that take their turn in Escape's order. */
const moreOpen = ref(false)
const dock = ref<HTMLElement | null>(null)
const creditsOpen = ref(false)
const credits = ref<HTMLElement | null>(null)

// ── What the device is ──
const coarse = useMedia('(pointer: coarse)')
const keyboard = useMedia('(hover: hover) and (pointer: fine)')
const portraitLayout = useMedia('(max-width: 720px) and (orientation: portrait)')

// ── Panels: one at a time ──
type PanelKind = 'none' | 'place' | 'people' | 'emotes' | 'chat'
const panel = ref<PanelKind>('none')
const placeTab = ref<'places' | 'view'>('view')
/** The button that opened the panel, so closing it gives the keyboard back. */
let opener: HTMLElement | null = null
const selected = computed<PresenceMember | null>(() => world.members.find(member => member.id === world.selected) ?? null)
const active = computed<PanelKind | 'member'>(() => (selected.value ? 'member' : panel.value))
const panelTitle = computed(() => ({ none: '', member: 'Person', place: world.title || 'Here', people: 'People', emotes: 'Gestures', chat: 'Nearby chat' })[active.value])
const socialPanel = computed<'none' | 'around' | 'emotes'>({
  get: () => (panel.value === 'people' ? 'around' : panel.value === 'emotes' ? 'emotes' : 'none'),
  // The social panels close themselves after an action ("Walk over", a phrase sent); a person they just selected stays.
  set: value => { if (value === 'none') { if (panel.value === 'people' || panel.value === 'emotes') closePanel(true) } else panel.value = value === 'around' ? 'people' : 'emotes' },
})

function openPanel(kind: Exclude<PanelKind, 'none'>, from?: Event | null, tab?: 'places' | 'view'): void {
  // The same button, or the same shortcut for the same tab, closes what it opened.
  if (panel.value === kind && !selected.value && (!tab || kind !== 'place' || placeTab.value === tab)) { closePanel(); return }
  moreOpen.value = false
  if (tab) placeTab.value = tab
  world.selected = null
  const button = from?.currentTarget
  if (button instanceof HTMLElement) opener = button
  panel.value = kind
  if (kind === 'chat') chatUnseen.value = 0
  void nextTick(() => { if (kind === 'chat' && keyboard.value) chatInput.value?.focus(); else panelRoot.value?.focus({ preventScroll: true }) })
}
const usable = (el: HTMLElement | null): el is HTMLElement => Boolean(el && el.isConnected && el.getClientRects().length)
/**
 * Close the open panel. When the keyboard was inside it (or nowhere), it goes back to a control that can
 * take it: the button that opened the panel if that is still on screen, otherwise that panel's own rail
 * button, otherwise the canvas. A panel put away because a page or the Menu opened does not move focus.
 */
function closePanel(keepSelection = false, restore = true): void {
  chatInput.value?.blur()
  chatFocused.value = false
  const kind = selected.value ? 'member' : panel.value
  const wasOpen = kind !== 'none'
  const inside = document.activeElement === document.body || Boolean(panelRoot.value?.contains(document.activeElement))
  panel.value = 'none'
  if (!keepSelection) world.selected = null
  if (wasOpen && restore && inside) {
    const previous = opener
    void nextTick(() => {
      const rail = stage.value?.querySelector<HTMLElement>(`[data-hud-rail="${kind}"]`) ?? null
      const actions = dock.value?.querySelector<HTMLElement>('[data-hud-actions]') ?? null
      const target = usable(previous) ? previous : usable(rail) ? rail : usable(actions) ? actions : canvas.value
      target?.focus({ preventScroll: true })
    })
  }
  opener = null
}
// Opening the shell's Menu puts everything else away.
watch(() => props.menuOpen, open => { if (open) closePanel(false, false) })
// A person selected in the world takes the panel; closing them shows what was open before.
watch(() => world.selected, id => { if (id) panel.value = 'none' })
// Leaving the place, or a window opening over the world, closes what was open there.
watch(() => world.roomKey, () => { closePanel(false, false); placeQuery.value = ''; creditsOpen.value = false })
watch(() => props.dimmed, covered => { if (covered) { closePanel(false, false); creditsOpen.value = false; moreOpen.value = false } })

// ── Who holds the input (see src/ui/gameInput.ts) ──
// Each of these takes a hold while it is true; the engine's lock is derived from every hold at once, so
// closing one can never unlock the world under another. The Menu, the account menu, welcome and about
// dialogs, the meal sheet and an order on its way hold from their own files.
const engineHere = ref(false)
useHold('window', () => props.dimmed, { role: 'window', preserveWalking: () => router.currentRoute.value.path === '/map' || Boolean(work.trip) })
useHold('seated', () => Boolean(props.seated), { role: 'seated' })
useHold('typing', () => chatFocused.value, { role: 'typing' })
// Non-modal pieces still take their turn in Escape's order: the newest opened closes first.
useHold('stage.panel', () => active.value !== 'none', { role: 'panel', close: () => closePanel() })
useHold('stage.actions', () => moreOpen.value, { role: 'panel', close: () => { moreOpen.value = false } })
useHold('stage.credits', () => creditsOpen.value, { role: 'panel', close: () => { creditsOpen.value = false } })
// "Exit?" at a door: Escape means Stay. It is a non-modal question, so it holds neither the keys nor the avatar.
useHold('stage.doorway', () => asking.value, { role: 'panel', close: answerStay })
useDoorway()
/** One answer for "is the thumb pad out of reach": the same one drives the pad's release and the CSS class that hides it. */
const bottomPanel = computed(() => portraitLayout.value && active.value !== 'none')
const stickOff = computed(() => footBlocked.value || bottomPanel.value)
/** Walking-type buttons in panels are disabled while a vehicle, a window or a menu holds the avatar. */
const footOk = computed(() => !footBlocked.value)

// ── The mini-map ──
let mapTimer = 0
// A game file that no longer matches this build means the game was updated: trying again cannot help, loading the new version does.
const updated = computed(() => {
  const failure = world.state === 'error' ? assetProgress.activity().failure : null
  return failure?.kind === 'changed' && failure.message === world.error
})
const { blocked: reloadBlocked, reload: reloadGame } = useGameReload()

onMounted(() => {
  if (canvas.value) attachCanvas(canvas.value)
  // The engine arrives a moment after the canvas; what the stage already knows is applied when it does.
  void engineReady().then(() => {
    engineHere.value = true
    getEngine()?.setSuspended(props.suspended || world.state !== 'ready')
    syncEngine()
  })
  // The mini-map redraws five times a second from the engine's own cached district map, and not at all when it cannot be seen.
  mapTimer = window.setInterval(() => {
    const target = minimap.value
    if (document.hidden || props.suspended || !target?.getClientRects().length) return
    if (world.state !== 'ready' || world.kind !== 'district') return
    if (target.width !== 320) target.width = target.height = 320
    getEngine()?.drawMinimap(target, { radius: 130, headingUp: false })
  }, 200)
})
watch(() => props.suspended || world.state !== 'ready', paused => { getEngine()?.setSuspended(paused) })

const radius = computed(() => (world.kind ? PROXIMITY_RADIUS[world.kind] : 0))
const localTime = computed(() => {
  void world.status
  return new Intl.DateTimeFormat(undefined, { timeZone: world.timezone, hour: 'numeric', minute: '2-digit' }).format(Date.now())
})
const places = computed(() => {
  const text = placeQuery.value.trim().toLowerCase()
  return world.places.filter(place => !text || place.name.toLowerCase().includes(text) || place.category.includes(text)).slice(0, 60)
})
const edgeLabel = computed(() => (world.edge ? { north: 'north', south: 'south', east: 'east', west: 'west' }[world.edge] : ''))
const streetLine = computed(() => (world.kind === 'district' ? (world.street ? `On ${world.street}` : world.subtitle || 'Open ground') : world.subtitle))

// ── Chat ──
watch(() => world.chat.length, async () => {
  await nextTick()
  if (chatLog.value) chatLog.value.scrollTop = chatLog.value.scrollHeight
  const latest = world.chat[world.chat.length - 1]
  // A message from someone else, while the chat is shut, is a dot on the chat button. It is counted from what arrived, nothing more.
  if (latest && latest.from !== app.me?.id && active.value !== 'chat') chatUnseen.value++
})
async function send(): Promise<void> {
  const text = draft.value.trim()
  if (!text) return
  draft.value = ''
  if (!(await sendChat(text))) draft.value = text
}

function walk(place: (typeof world.places)[number]): void {
  if (!permits('foot')) return
  const route = walkToPlace(place)
  if (!route) return
  walking.value = route.length > 0
    ? `Walking to ${place.name} · about ${Math.round(route.length)} m${route.viaStreets ? ' along the streets' : ''}`
    : `No clear walking route to ${place.name} from here. Try walking closer first.`
  closePanel()
  window.clearTimeout(walkingTimer)
  walkingTimer = window.setTimeout(() => { walking.value = '' }, 6000)
}
let walkingTimer = 0

// ── One contextual action ──
// The stage offers the doors and the way out. Meals, work and vehicles register theirs from their own components.
const foot = (): boolean => world.state === 'ready' && !seated.value
useInteraction('world.home-door', (): Interaction | null => {
  const home = world.nearHome
  if (!foot() || world.kind !== 'district' || !home) return null
  return { id: 'world.home-door', priority: PRIORITY.doorHere, verb: 'Enter', target: home.name, label: `Enter ${home.name}`, icon: 'enter', key: 'E', tone: 'primary', run: () => { void enterHome(home.homeId) } }
})
useInteraction('world.home-walk', (): Interaction | null => {
  const route = world.homeWalk
  if (!foot() || world.kind !== 'district' || route.kind !== 'paused') return null
  return { id: 'world.home-walk', priority: PRIORITY.way, verb: 'Resume walk', target: route.name, label: `Resume walking to ${route.name}`, icon: 'walk', tone: 'dark', run: () => { void walkToHome(route.homeId) } }
})
useInteraction('world.enter', (): Interaction | null => {
  const venue = world.nearVenue
  if (!foot() || world.kind !== 'district' || !venue) return null
  return { id: 'world.enter', priority: PRIORITY.venue, verb: 'Enter', target: venue.name, label: `Enter ${venue.name}`, icon: 'enter', key: 'E', tone: 'primary', run: () => { void enterVenue(venue) } }
})
useInteraction('world.edge', (): Interaction | null => {
  if (!foot() || world.kind !== 'district' || !world.edge) return null
  return { id: 'world.edge', priority: PRIORITY.edge, verb: 'Continue', target: edgeLabel.value, label: `Continue ${edgeLabel.value} to the next district`, icon: 'compass', key: 'E', tone: 'dark', run: () => { void crossEdge() } }
})
useInteraction('world.door', (): Interaction | null => {
  if (!foot() || world.kind === 'district' || !world.nearDoor) return null
  return { id: 'world.door', priority: PRIORITY.doorHere, verb: 'Leave', target: 'to the street', label: 'Leave to the street', icon: 'exit', key: 'E', tone: 'dark', run: leaveNow }
})
useInteraction('world.way', (): Interaction | null => {
  if (!foot() || world.kind === 'district' || world.nearDoor) return null
  return { id: 'world.way', priority: PRIORITY.way, verb: 'Street', label: 'Back to the street', icon: 'back', tone: 'dark', run: leaveNow }
})
const offered = computed(() => (seated.value ? interactions.value.filter(item => item.id.startsWith('transport.')) : interactions.value))
const primary = computed(() => offered.value[0] ?? null)
const others = computed(() => offered.value.slice(1))

/** A vehicle action may run while seated; anything else is foot work and needs the avatar free. */
const allowedAction = (item: Interaction): boolean => item.id.startsWith('transport.') || permits('foot')
function act(item: Interaction): void { moreOpen.value = false; if (!item.disabled && !item.busy && allowedAction(item)) item.run() }

// ── Where you are, said once ──
const placeHint = ref('')
let placeHintTimer = 0
let placeHintAt = 0
function sayPlace(): void {
  if (world.state !== 'ready' || !world.title) return
  placeHint.value = streetLine.value ? `${world.title} · ${streetLine.value}` : world.title
  placeHintAt = Date.now()
  window.clearTimeout(placeHintTimer)
  placeHintTimer = window.setTimeout(() => { placeHint.value = '' }, 4500)
}
watch(() => [world.state, world.title, world.kind] as const, sayPlace)
// Crossing into another street is worth a line, but not every few seconds.
watch(() => world.street, () => { if (Date.now() - placeHintAt > 12_000) sayPlace() })

// ── Full screen: only from a press, only where the browser has it ──
const fullscreenOk = ref(false)
const full = ref(false)
const syncFullscreen = (): void => { fullscreenOk.value = fullscreenAvailable(document); full.value = inFullscreen(document) }
async function fullscreen(): Promise<void> { await toggleFullscreen(document, screen); syncFullscreen() }

// ── Map credits ──

// ── Keyboard and pointer outside the stage ──
// Escape is the gate's (it closes the newest thing that can close). Everything else is the world's only when
// nothing in front holds the keys, nobody is typing, no other listener handled it, and a focused button or
// link keeps its own Enter and Space.
function onKey(event: KeyboardEvent): void {
  const facts = factsOf(event)
  if (event.key === 'Escape') { if (isTyping(facts)) (event.target as HTMLElement | null)?.blur(); return }
  const intent = worldKey(facts, { covered: keysBlocked.value, ready: world.state === 'ready' })
  if (!intent) return
  if (intent === 'chat') { event.preventDefault(); openPanel('chat') }
  else if (intent === 'interact') {
    const item = interactionForKey('E')
    if (item && allowedAction(item)) { event.preventDefault(); item.run() }
  } else if (intent === 'places') { if (world.kind === 'district') openPanel('place', null, 'places') }
  else if (intent === 'people') openPanel('people')
  else if (intent === 'help') openPanel('place', null, 'view')
  else if (intent === 'wave') { if (permits('foot')) getEngine()?.gesture('wave') }
}
function onPointer(event: PointerEvent): void {
  const target = event.target as Node
  if (moreOpen.value && dock.value && !dock.value.contains(target)) moreOpen.value = false
  if (creditsOpen.value && credits.value && !credits.value.contains(target)) creditsOpen.value = false
}
onMounted(() => {
  window.addEventListener('keydown', onKey)
  document.addEventListener('pointerdown', onPointer)
  document.addEventListener('fullscreenchange', syncFullscreen)
  document.addEventListener('webkitfullscreenchange', syncFullscreen)
  syncFullscreen()
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  document.removeEventListener('pointerdown', onPointer)
  document.removeEventListener('fullscreenchange', syncFullscreen)
  document.removeEventListener('webkitfullscreenchange', syncFullscreen)
  window.clearInterval(mapTimer)
  window.clearTimeout(walkingTimer)
  window.clearTimeout(placeHintTimer)
  // The chat field gives the keyboard back before it goes (its hold is released with the component).
  chatFocused.value = false
  detachCanvas()
})

const contextLabel = (member: PresenceMember): string => (member.context === 'current-area' ? 'In this area' : 'Exploring here')
const peopleLabel = computed(() => (peopleAttention.value ? 'People, something is waiting' : 'People'))
const chatLabel = computed(() => (chatUnseen.value ? `Nearby chat, ${chatUnseen.value} new` : 'Nearby chat'))
</script>

<template>
  <div ref="stage" class="stage" :class="{ dimmed, sheet, coarse, home: world.kind === 'home', 'panel-bottom': bottomPanel }">
    <canvas ref="canvas" class="canvas" tabindex="0" :aria-label="`3D view of ${world.title || 'the world'}. Use W A S D or the arrow keys to walk, or open the places list with L.`"></canvas>

    <!-- Loading and failure -->
    <div v-if="world.state === 'loading' || world.state === 'idle'" class="veil" role="status">
      <div class="veil-card glass">
        <div class="spinner" aria-hidden="true"></div>
        <strong>{{ world.state === 'loading' ? world.loadingLabel : 'Getting the game ready…' }}</strong>
        <!-- Shown only while files are downloading: a place whose files are already on this device has nothing to show here. -->
        <AssetProgress blocking />
        <span class="muted small">Real streets and places are drawn from open map data.</span>
      </div>
    </div>
    <div v-else-if="world.state === 'error'" class="veil" role="alert">
      <div class="veil-card glass">
        <span class="art" aria-hidden="true"><HudIcon :name="world.errorKind === 'forbidden' ? 'door' : 'map'" :size="34" /></span>
        <strong>{{ world.errorKind === 'forbidden' ? 'That door is closed' : 'This place did not load' }}</strong>
        <span class="muted small">{{ world.error }}</span>
        <div class="row wrap" style="justify-content: center">
          <button v-if="updated" class="btn primary sm" type="button" :disabled="Boolean(reloadBlocked)" @click="reloadGame">Reload</button>
          <button v-else class="btn primary sm" type="button" @click="retryScene">Try again</button>
          <button class="btn sm" type="button" @click="router.push('/travel')">Open Travel</button>
        </div>
        <span class="muted tiny">Travel is how your character goes to another place. Settings only records where you are in real life and does not move your character.</span>
        <p v-if="updated && reloadBlocked" class="muted small" role="status">{{ reloadBlocked }}</p>
      </div>
    </div>

    <template v-if="world.state === 'ready'">
      <!-- Mini-map: under the player cluster. Pressing it opens the full map. -->
      <button v-if="world.kind === 'district'" class="minimap" type="button" aria-label="Mini-map of nearby streets, people and places; north is up. Open the full map." @click="router.push('/map')">
        <canvas ref="minimap" width="320" height="320" aria-hidden="true"></canvas>
        <span class="north" aria-hidden="true">N</span>
      </button>

      <!-- Everything below is put away while a page is open over the world. It stays mounted: its owners keep their own state. -->
      <div v-show="!dimmed" class="hud-live">
        <!-- One-line hints: where you are, a walk under way, hunger, a shift, something to answer. They fade or are dismissed; none is idle chrome. -->
        <div class="hints">
          <p v-if="world.homeWalk.kind === 'walking'" class="hint" role="status"><HudIcon name="walk" :size="18" /><span class="hint-text truncate">{{ Math.ceil(world.homeWalk.metres) }} m to {{ world.homeWalk.name }}</span></p>
          <RouterLink v-else-if="world.homeWalk.kind === 'travel'" class="hint" to="/travel"><HudIcon name="compass" :size="18" /><span class="hint-text">Travel to {{ world.homeWalk.to.label }} to walk home</span></RouterLink>
          <p v-else-if="world.homeWalk.kind === 'unavailable'" class="hint" role="status"><span class="hint-text">{{ world.homeWalk.message }}</span></p>
          <p v-if="walking && world.homeWalk.kind === 'idle'" class="hint" role="status"><HudIcon name="walk" :size="18" /><span class="hint-text">{{ walking }}</span></p>
        <LifeActions />
          <SocialHud v-model:panel="socialPanel" :panel-host="panelHost" @attention="peopleAttention = $event" />
        </div>

        <div class="home-tools"><HomeDock /></div>

        <!-- Keep the movement view clear: Menu and Chat; other tools live in Nearby actions. -->
        <nav class="rail" aria-label="World">
          <button class="rail-btn" type="button" data-hud-menu data-hud-rail="menu" :aria-expanded="menuOpen" aria-controls="shell-more" aria-haspopup="dialog" :aria-label="menuBadge ? `Menu, ${menuBadge} unread` : 'Menu'" title="Menu" @click="emit('menu')">
            <HudIcon name="menu" /><span v-if="menuBadge" class="dot" aria-hidden="true"></span>
          </button>
          <button class="rail-btn" type="button" data-hud-rail="chat" :aria-pressed="active === 'chat'" :aria-label="chatLabel" :title="keyboard ? 'Nearby chat (Enter)' : 'Nearby chat'" @click="openPanel('chat', $event)">
            <HudIcon name="chat" /><span v-if="chatUnseen && active !== 'chat'" class="dot" aria-hidden="true"></span>
          </button>
        </nav>

        <!-- The one open panel. -->
        <section v-show="active !== 'none'" ref="panelRoot" class="hud-panel glass" :class="`panel-${active}`" role="dialog" :aria-label="panelTitle || 'Panel'" tabindex="-1">
          <header v-if="active !== 'member'" class="hud-panel-head">
            <div class="grow">
              <h2 class="truncate">{{ panelTitle }}</h2>
              <p v-if="active === 'place' && streetLine" class="muted small truncate">{{ streetLine }}</p>
            </div>
            <button class="hud-close" type="button" aria-label="Close panel" @click="closePanel()"><HudIcon name="close" :size="20" /></button>
          </header>
          <div class="hud-panel-body">
            <!-- The person you selected in the world. -->
            <MemberCard v-if="selected" :member="selected" :subtitle="world.kind === 'district' ? contextLabel(selected) : 'In this room'" closable @close="closePanel()" />

            <!-- Place, the places list, view and controls -->
            <template v-else-if="panel === 'place'">
              <div class="row wrap chips">
                <template v-if="world.kind === 'district'">
                  <span v-if="world.inCurrentArea" class="chip leaf" title="You said this is where you are. Self-reported.">Your current area</span>
                  <span v-else class="chip sky" title="You are looking around. This says nothing about where you are.">Exploring</span>
                  <span class="chip num" :title="`Local time in ${world.timezone}`">{{ localTime }}</span>
                  <span v-if="world.coverage && world.coverage.level !== 'detailed'" class="chip coral">{{ world.coverage.level === 'streets-only' ? 'Few buildings mapped' : 'Thinly mapped' }}</span>
                </template>
                <span v-else-if="world.kind === 'venue'" class="chip grape">Public venue</span>
                <span v-else-if="world.kind === 'home'" class="chip coral">{{ world.canEditHome ? 'Your home' : 'Visiting' }}</span>
                <span class="chip num" title="People in this room with you">{{ world.members.length + 1 }}<template v-if="world.capacity"> / {{ world.capacity }}</template> here</span>
              </div>
              <p v-if="world.kind === 'district' && world.coverage && world.coverage.level !== 'detailed'" class="tiny muted">{{ world.coverage.summary }}</p>
              <AssetProgress class="place-downloads" />

              <div v-if="world.kind === 'district'" class="tabs" role="tablist" aria-label="Place sections">
                <button class="tab" type="button" role="tab" :aria-selected="placeTab === 'places'" @click="placeTab = 'places'">Places</button>
                <button class="tab" type="button" role="tab" :aria-selected="placeTab === 'view'" @click="placeTab = 'view'">View and controls</button>
              </div>

              <section v-if="world.kind === 'district' && placeTab === 'places'" class="stack tight" aria-label="Places in this district">
                <input v-model="placeQuery" class="input" type="search" placeholder="Filter places" aria-label="Filter places" />
                <ul v-if="places.length" class="plain">
                  <li v-for="place in places" :key="place.placeId" class="list-row">
                    <span class="pin-chip" :style="{ color: categoryStyle(place.category).color }" aria-hidden="true"><HudIcon name="pin" :size="20" /></span>
                    <span class="grow"><strong class="truncate" style="display: block">{{ place.name }}</strong><span class="muted tiny">{{ place.category.replace(/_/g, ' ') }}</span></span>
                    <button class="btn sm" type="button" :disabled="!footOk" :aria-label="`Walk to ${place.name}`" @click="walk(place)">Walk</button>
                  </li>
                </ul>
                <p v-else class="muted small">{{ world.places.length ? 'No place matches that filter.' : 'The map has no named public places in this district yet.' }}</p>
                <button class="btn sm ghost" type="button" :disabled="!footOk" @click="returnToArrival(); closePanel()"><HudIcon name="back" :size="18" /> Back to the arrival point{{ world.arrival ? ` (${world.arrival.label})` : '' }}</button>
              </section>

              <section v-else class="stack" aria-label="View and controls">
                <div class="view-tools" role="group" aria-label="Camera">
                  <button class="tool" type="button" aria-label="Zoom in" @click="getEngine()?.zoom(0.8)"><HudIcon name="zoom-in" /></button>
                  <button class="tool" type="button" aria-label="Zoom out" @click="getEngine()?.zoom(1.25)"><HudIcon name="zoom-out" /></button>
                  <button class="tool" type="button" aria-label="Turn the camera left" @click="getEngine()?.rotate(-0.5)"><HudIcon name="turn-left" /></button>
                  <button class="tool" type="button" aria-label="Turn the camera right" @click="getEngine()?.rotate(0.5)"><HudIcon name="turn-right" /></button>
                </div>
                <label class="row between setting">
                  <span class="row"><HudIcon :name="channels.master.muted ? 'mute' : 'sound'" :size="20" /><strong class="small">All sound</strong></span>
                  <button class="switch" type="button" role="switch" :aria-checked="!channels.master.muted" aria-label="All sound" @click="setChannelMuted('master', !channels.master.muted)"></button>
                </label>
                <label class="row between setting">
                  <span><span class="row"><HudIcon :name="channelLevel('ambience') > 0 ? 'sound' : 'mute'" :size="20" /><strong class="small">Street sound</strong></span><span v-if="channels.master.muted && !channels.ambience.muted" class="muted tiny" style="display: block">Silenced while All sound is off.</span></span>
                  <button class="switch" type="button" role="switch" :aria-checked="!channels.ambience.muted" aria-label="Street sound" @click="setChannelMuted('ambience', !channels.ambience.muted)"></button>
                </label>
                <label class="row between setting">
                  <span><strong class="small">Always daytime</strong><span class="muted tiny" style="display: block">Otherwise the light follows local time here.</span></span>
                  <button class="switch" type="button" role="switch" :aria-checked="world.timeMode === 'day'" aria-label="Always daytime" @click="setTimeMode(world.timeMode === 'day' ? 'local' : 'day')"></button>
                </label>
                <label class="row between setting">
                  <span><strong class="small">Leave by the door on my own</strong><span class="muted tiny" style="display: block">Otherwise you are asked at the door.</span></span>
                  <button class="switch" type="button" role="switch" :aria-checked="doorway.preference === 'auto'" aria-label="Leave by the door on my own" @click="setAutoExit(doorway.preference !== 'auto')"></button>
                </label>
                <button v-if="fullscreenOk" class="btn sm" type="button" :aria-pressed="full" @click="fullscreen"><HudIcon :name="full ? 'fullscreen-exit' : 'fullscreen'" :size="18" /> {{ full ? 'Leave full screen' : 'Full screen' }}</button>
                <dl v-if="keyboard" class="keys">
                  <dt><span class="kbd">W</span><span class="kbd">A</span><span class="kbd">S</span><span class="kbd">D</span> or arrows</dt><dd>Walk</dd>
                  <dt><span class="kbd">Shift</span></dt><dd>Run</dd>
                  <dt>Click the ground</dt><dd>Walk there along the streets</dd>
                  <dt>Drag · scroll</dt><dd>Turn and zoom the camera</dd>
                  <dt><span class="kbd">[</span><span class="kbd">]</span></dt><dd>Turn the camera</dd>
                  <dt><span class="kbd">E</span></dt><dd>The action at the lower right</dd>
                  <dt><span class="kbd">Enter</span></dt><dd>Type a nearby message</dd>
                  <dt><span class="kbd">L</span> · <span class="kbd">P</span></dt><dd>Places · people</dd>
                  <dt><span class="kbd">G</span></dt><dd>Wave</dd>
                  <dt><span class="kbd">F</span> · <span class="kbd">J</span></dt><dd>Menu or kitchen · work</dd>
                  <dt><span class="kbd">N</span></dt><dd>Daily life</dd>
                  <dt><span class="kbd">1</span>–<span class="kbd">9</span></dt><dd>Open a section</dd>
                </dl>
                <dl v-else class="keys">
                  <dt>Left thumb pad</dt><dd>Walk</dd>
                  <dt>Drag the view</dt><dd>Turn the camera</dd>
                  <dt>Pinch</dt><dd>Zoom</dd>
                  <dt>Tap the ground</dt><dd>Walk there along the streets</dd>
                  <dt>Button at the lower right</dt><dd>Enter, leave, eat, work</dd>
                </dl>
                <p v-if="world.status" class="tiny muted num">{{ world.status.fps }} fps · {{ world.status.quality }} quality{{ world.status.degraded ? ' (lowered to keep it smooth)' : '' }} · {{ world.status.triangles.toLocaleString() }} triangles</p>
              </section>
              <FeedbackEntry variant="row" :context="world.kind === 'district' ? 'street' : 'indoors'" />
              <!-- The credits are also here, so they stay reachable while a bottom panel has put the ⓘ button away. -->
              <p v-if="world.kind === 'district'" class="tiny muted panel-credits">
                <a v-for="link in providers.tiles.attributionLinks" :key="link.href" :href="link.href" target="_blank" rel="noopener">© {{ link.label }}</a>
                · Buildings and trees are stylised. Player homes are fictional buildings on generated plots. People without a name tag are street life, not members.
              </p>
            </template>

            <!-- Nearby chat -->
            <template v-else-if="panel === 'chat'">
              <div class="row between">
                <span class="chip" :class="world.inRange ? 'leaf' : ''">{{ world.inRange === 0 ? 'Nobody in range' : `${world.inRange} in range` }}</span>
                <span class="row voice-controls" style="gap: 6px">
                  <button class="btn sm" :class="voice.state === 'live' ? 'primary' : ''" type="button" :disabled="!voice.available || voice.starting" :title="voice.available ? 'Talk to people within range' : voice.unavailableReason" :aria-pressed="voice.state !== 'off'" @click="setVoice(voice.state === 'off' ? 'live' : 'off')"><HudIcon name="mic" :size="18" /> {{ voice.state === 'off' ? 'Voice' : `On · ${voice.peers.length}` }}</button>
                  <button v-if="voice.state !== 'off'" class="btn sm" type="button" :aria-pressed="voice.state === 'muted'" @click="setVoice(voice.state === 'muted' ? 'live' : 'muted')">{{ voice.state === 'muted' ? 'Muted' : 'Mute' }}</button>
                </span>
              </div>
              <p class="tiny muted">Text{{ voice.state !== 'off' ? ' and voice' : '' }} reach avatars within {{ radius }} m of yours in this room. Nothing is sent by real-world distance.</p>
              <p v-if="voice.problem" class="tiny problem" role="alert">{{ voice.problem }}</p>
              <p v-if="voice.state === 'live' && channelLevel('voice') === 0" class="tiny problem" role="status">You cannot hear nearby voices, but your microphone is still on. Use Mute to stop being heard; Settings brings the voices back.</p>
              <div ref="chatLog" class="log" role="log" aria-live="polite">
                <p v-if="!world.chat.length" class="muted small">No messages yet. Walk up to someone and say hello.</p>
                <p v-for="message in world.chat" :key="message.id" class="line" :class="{ mine: message.from === app.me?.id }">
                  <strong>{{ message.from === app.me?.id ? 'You' : message.fromName }}</strong>
                  <span>{{ message.text }}</span>
                  <span v-if="message.from === app.me?.id" class="tiny muted">{{ message.audience === 0 ? 'nobody was in range' : `reached ${message.audience}` }}</span>
                </p>
              </div>
              <form class="row" @submit.prevent="send">
                <input ref="chatInput" v-model="draft" class="input" maxlength="280" placeholder="Say something to people nearby" aria-label="Message to people nearby" enterkeyhint="send" @focus="chatFocused = true" @blur="chatFocused = false" />
                <button class="btn dark" type="submit" :disabled="!draft.trim()">Send</button>
              </form>
            </template>
            <div ref="panelHost" class="panel-host"></div>
          </div>
        </section>

        <!-- The one contextual action, at the right thumb. -->
        <div ref="dock" class="dock" role="group" aria-label="Action here">
          <div v-if="moreOpen" class="more-list" role="group" aria-label="Other actions here">
            <button v-for="item in others" :key="item.id" class="more-item" type="button" :disabled="item.disabled || item.busy" @click="act(item)">
              <HudIcon :name="item.icon" :size="20" /><span class="grow">{{ item.label }}</span><span v-if="keyboard && item.key" class="kbd">{{ item.key }}</span>
            </button>
            <button class="more-item" type="button" @click="openPanel('place', $event)"><HudIcon name="pin" :size="20" /><span>Place and view</span></button>
            <button class="more-item" type="button" :aria-label="peopleLabel" @click="openPanel('people', $event)"><HudIcon name="people" :size="20" /><span>People nearby</span><span v-if="peopleAttention" class="dot" aria-hidden="true"></span></button>
            <button class="more-item" type="button" @click="openPanel('emotes', $event)"><HudIcon name="smile" :size="20" /><span>Gestures and phrases</span></button>
          </div>
          <button class="more-btn" type="button" data-hud-actions :aria-expanded="moreOpen" aria-label="Nearby actions and options" @click="moreOpen = !moreOpen">
            <HudIcon name="chevron" :size="20" /><span v-if="others.length" class="more-count num" aria-hidden="true">{{ others.length }}</span>
          </button>
          <button v-if="primary" class="act" :class="primary.tone ?? 'primary'" type="button" :disabled="primary.disabled || primary.busy" :aria-label="primary.label" :aria-keyshortcuts="primary.key" @click="act(primary)">
            <HudIcon :name="primary.icon" :size="24" :stroke-width="2" />
            <span class="act-words"><strong>{{ primary.busy ? 'Wait…' : primary.verb }}</strong><span v-if="primary.target" class="act-target truncate">{{ primary.target }}</span></span>
            <span v-if="keyboard && primary.key" class="kbd" aria-hidden="true">{{ primary.key }}</span>
          </button>
        </div>

        <!-- Thumb pad. Only on a touch screen; walking has keyboard and pointer routes too. -->
        <div v-if="coarse && !seated" v-show="!stickOff" class="stick-slot"><TouchStick :disabled="stickOff" /></div>
      </div>

      <!-- Decisions: a fare, a destination, a consent, an error, a result. Supplied by the host. It is outside the part of the HUD
           that is put away under a page, so a pending decision stays reviewable above the page, compact, until it is answered. -->
      <div v-if="$slots.transport || asking" class="decision" :class="{ over: dimmed }" role="group" aria-label="Needs your decision">
        <DoorwayPrompt v-if="asking" :place="world.title" @exit="answerExit" @stay="answerStay" />
        <slot name="transport" :drive-allowed="driveAllowed" :overlay-open="overlayOpen" />
      </div>

      <!-- Map credits: small, always reachable, never in the way. -->
      <div v-if="world.kind === 'district'" ref="credits" class="credits">
        <div v-if="creditsOpen" id="map-credits" class="credits-card" role="group" aria-label="Map credits">
          <a v-for="link in providers.tiles.attributionLinks" :key="link.href" :href="link.href" target="_blank" rel="noopener">© {{ link.label }}</a>
          <span class="tiny muted">Buildings and trees are stylised. Player homes are fictional buildings on generated plots. People without a name tag are street life, not members.</span>
        </div>
        <button class="credits-btn" type="button" :aria-expanded="creditsOpen" aria-controls="map-credits" aria-label="Map credits" @click="creditsOpen = !creditsOpen"><HudIcon name="info" :size="16" /></button>
      </div>
    </template>
  </div>
</template>

<style scoped>
.stage {
  --edge: 10px; --tap: 44px;
  --pad-l: calc(var(--edge) + env(safe-area-inset-left, 0px)); --pad-r: calc(var(--edge) + env(safe-area-inset-right, 0px));
  --pad-t: calc(var(--edge) + env(safe-area-inset-top, 0px)); --pad-b: calc(var(--edge) + var(--safe-bottom));
  --map: clamp(68px, min(24vw, 20dvh), 120px); --cluster: 236px;
  position: relative; width: 100%; height: 100%; overflow: hidden; background: #d7ecf7;
}
.canvas { width: 100%; height: 100%; display: block; touch-action: none; outline: none; }
.stage.dimmed .canvas { filter: saturate(0.9); }
.veil { position: absolute; inset: 0; display: grid; place-items: center; padding: 20px; background: linear-gradient(180deg, rgba(215, 236, 247, 0.55), rgba(243, 237, 227, 0.75)); }
.veil-card { display: grid; justify-items: center; gap: 8px; padding: 22px 26px; border-radius: 20px; text-align: center; max-width: 360px; }
.veil-card .art { color: var(--ink-2); }
.spinner { width: 34px; height: 34px; border-radius: 50%; border: 4px solid var(--accent-soft); border-top-color: var(--accent-strong); animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.hud-live { display: contents; }

/* ── Mini-map: under the player cluster the shell draws at the upper left ── */
.minimap { position: absolute; left: var(--pad-l); top: calc(var(--shell-top) + 6px); z-index: 2; width: var(--map); height: var(--map); padding: 0; border-radius: 50%; overflow: hidden; border: 2.5px solid rgba(255, 255, 255, 0.9); background: #dfe7dc; box-shadow: 0 2px 10px rgba(20, 14, 6, 0.28); }
.minimap canvas { width: 100%; height: 100%; display: block; }
.minimap .north { position: absolute; top: 3px; left: 50%; transform: translateX(-50%); font-size: 0.6rem; font-weight: 800; color: #fff; background: var(--coral); border-radius: 999px; padding: 0 5px; line-height: 14px; }

/* ── Hints: one short line each, top centre, above nothing that matters ── */
.hints { position: absolute; z-index: 4; top: var(--pad-t); left: calc(var(--pad-l) + var(--cluster) + 8px); right: calc(var(--pad-r) + var(--tap) + 10px); display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; }
.hints > * { pointer-events: auto; }
.hint { display: flex; align-items: center; gap: 8px; max-width: 100%; padding: 6px 8px 6px 12px; border-radius: 999px; background: rgba(28, 26, 36, 0.8); color: #fff; font-size: 0.86rem; font-weight: 600; line-height: 1.25; box-shadow: 0 2px 10px rgba(20, 14, 6, 0.28); animation: hint-in 0.18s ease-out; }
.hint-text { min-width: 0; }
.home-tools { position: absolute; z-index: 4; top: calc(var(--shell-top) + 6px); left: var(--pad-l); right: calc(var(--pad-r) + var(--tap) + 10px); display: flex; justify-content: flex-start; pointer-events: none; }
.stage.home .hints { top: calc(var(--shell-top) + 58px); left: var(--pad-l); align-items: flex-start; }
.hint-x { display: grid; place-items: center; width: var(--tap); height: var(--tap); margin: -10px -8px -10px 0; border: 0; border-radius: 50%; background: transparent; color: rgba(255, 255, 255, 0.85); }
.hint-x:hover { background: rgba(255, 255, 255, 0.12); }
@keyframes hint-in { from { transform: translateY(-4px); opacity: 0; } }

/* ── Right edge: five icon buttons ── */
.rail { position: absolute; z-index: 5; top: var(--pad-t); right: var(--pad-r); display: flex; flex-direction: column; gap: 6px; }
.rail-btn { position: relative; display: grid; place-items: center; width: var(--tap); height: var(--tap); padding: 0; border: 1px solid rgba(255, 255, 255, 0.28); border-radius: 50%; background: rgba(28, 26, 36, 0.62); color: #fff; box-shadow: 0 2px 8px rgba(20, 14, 6, 0.22); transition: background 0.15s ease, transform 0.08s ease; }
.rail-btn:hover { background: rgba(28, 26, 36, 0.78); }
.rail-btn:active { transform: scale(0.94); }
.rail-btn[aria-pressed="true"], .rail-btn[aria-expanded="true"] { background: var(--accent); border-color: var(--accent-strong); color: var(--accent-ink); }
.dot { position: absolute; top: 5px; right: 5px; width: 11px; height: 11px; border-radius: 50%; background: var(--coral); border: 2px solid #fff; }

/* ── The one open panel: right of the rail, below the top edge, above the action ── */
.hud-panel { position: absolute; z-index: 6; top: var(--pad-t); right: calc(var(--pad-r) + var(--tap) + 10px); width: min(360px, calc(100% - var(--pad-l) - var(--pad-r) - var(--tap) - 20px)); max-height: calc(100% - var(--pad-t) - var(--pad-b) - 70px); display: flex; flex-direction: column; border-radius: 20px; outline: none; overflow: hidden; background: rgba(255, 253, 249, 0.97); animation: panel-in 0.16s ease-out; }
@keyframes panel-in { from { transform: translateY(-6px); opacity: 0; } }
.hud-panel-head { flex: none; display: flex; align-items: center; gap: 8px; padding: 6px 6px 2px 14px; }
.hud-panel-head h2 { font-size: 1.02rem; }
.hud-close { display: grid; place-items: center; flex: none; width: var(--tap); height: var(--tap); border: 0; border-radius: 50%; background: transparent; color: var(--ink-2); }
.hud-close:hover { background: var(--surface-3); }
.hud-panel-body { display: flex; flex-direction: column; gap: 10px; padding: 8px 14px 14px; overflow-y: auto; overscroll-behavior: contain; min-height: 0; }
.panel-member .hud-panel-body { padding: 14px; }
.panel-host { display: contents; }
.chips { gap: 6px; }
.place-downloads { padding: 0; }
.panel-credits { display: flex; flex-wrap: wrap; gap: 2px 10px; }
.panel-credits a { color: var(--ink-2); display: inline-flex; align-items: center; min-height: 24px; }
.plain { list-style: none; margin: 0; padding: 0; }
.plain .list-row + .list-row { border-top: 1px solid var(--line); }
.pin-chip { display: grid; place-items: center; width: 34px; height: 34px; flex: none; }
.view-tools { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; }
.tool { display: grid; place-items: center; min-height: var(--tap); border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); color: var(--ink); }
.tool:hover { background: var(--surface-2); }
.setting { min-height: var(--tap); gap: 12px; }
.keys { display: grid; grid-template-columns: auto 1fr; gap: 6px 12px; margin: 0; font-size: 0.84rem; }
.keys dt { display: flex; gap: 3px; align-items: center; flex-wrap: wrap; color: var(--ink-2); }
.keys dd { margin: 0; }
.log { max-height: 32dvh; min-height: 40px; overflow-y: auto; display: flex; flex-direction: column; gap: 5px; }
.line { display: flex; flex-wrap: wrap; gap: 0 6px; font-size: 0.9rem; }
.line.mine strong { color: var(--accent-text); }
.problem { color: var(--danger); }

/* ── Decisions: above the action, right-aligned, bounded, scrolls inside ── */
.decision { position: absolute; z-index: 7; right: var(--pad-r); bottom: calc(var(--pad-b) + 66px); width: min(380px, calc(100% - var(--pad-l) - var(--pad-r))); max-height: 46dvh; overflow-y: auto; overscroll-behavior: contain; display: flex; flex-direction: column; gap: 8px; pointer-events: none; }
.decision > * { pointer-events: auto; }
/* Nothing to decide (the transport slot rendered nothing and no door question is open): take no room and leave no empty group for a screen reader. */
.decision:empty { display: none; }
/* A page is open over the world: the decision rises above the page, lower left on a wide screen and full width on a phone, and stays compact. */
.decision.over { z-index: 16; left: var(--pad-l); right: auto; bottom: calc(var(--shell-nav) + 8px); width: min(420px, calc(100% - var(--pad-l) - var(--pad-r))); max-height: 34dvh; }
/* The decision area owns scrolling, so fare and seat controls have one scrollable surface. */
.decision :deep(.transport-content) { max-height: none; overflow-y: visible; overscroll-behavior: auto; }

/* ── The one contextual action, lower right ── */
.dock { position: absolute; z-index: 5; right: var(--pad-r); bottom: var(--pad-b); display: flex; align-items: flex-end; gap: 8px; max-width: calc(100% - var(--pad-l) - var(--pad-r) - 150px); pointer-events: none; }
.dock > * { pointer-events: auto; }
.act { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 58px; padding: 0 20px 0 16px; border-radius: 29px; border: 1px solid transparent; font-weight: 700; box-shadow: 0 4px 14px rgba(20, 14, 6, 0.32); transition: transform 0.08s ease, filter 0.15s ease; animation: act-in 0.18s ease-out; }
.act.primary { background: linear-gradient(180deg, #ffbe3d, var(--accent)); border-color: #e59700; color: var(--accent-ink); }
.act.dark { background: rgba(28, 26, 36, 0.9); border-color: rgba(255, 255, 255, 0.3); color: #fff; }
.act:hover:not(:disabled) { filter: brightness(1.05); }
.act:active:not(:disabled) { transform: scale(0.97); }
.act:disabled { opacity: 0.6; cursor: not-allowed; }
.act-words { display: flex; flex-direction: column; align-items: flex-start; min-width: 0; line-height: 1.15; }
.act-words strong { font-size: 1rem; }
.act-target { max-width: 17ch; font-size: 0.74rem; font-weight: 650; opacity: 0.85; }
.act .kbd { margin-left: 2px; background: rgba(255, 255, 255, 0.85); }
@keyframes act-in { from { transform: translateY(6px) scale(0.97); opacity: 0; } }
.more-btn { flex: none; position: relative; display: grid; place-items: center; width: var(--tap); height: var(--tap); padding: 0; margin-bottom: 7px; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 50%; background: rgba(28, 26, 36, 0.7); color: #fff; box-shadow: 0 2px 8px rgba(20, 14, 6, 0.22); }
.more-btn[aria-expanded="true"] svg { transform: rotate(180deg); }
.more-count { position: absolute; top: -4px; right: -4px; min-width: 18px; padding: 0 4px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: 0.68rem; font-weight: 800; line-height: 18px; text-align: center; }
.more-list { position: absolute; right: 0; bottom: calc(100% + 8px); width: min(300px, calc(100vw - 24px)); max-height: min(50dvh, 320px); overflow-y: auto; display: flex; flex-direction: column; gap: 2px; padding: 6px; border-radius: 18px; background: rgba(255, 253, 249, 0.98); box-shadow: var(--shadow-lg); }
.more-item { display: flex; align-items: center; gap: 10px; min-height: var(--tap); padding: 0 12px; border: 0; border-radius: 12px; background: transparent; text-align: left; font-weight: 650; }
.more-item:hover:not(:disabled) { background: var(--surface-2); }
.more-item:disabled { opacity: 0.5; }

/* ── Thumb pad: lower left ── */
.stick-slot { position: absolute; z-index: 4; left: var(--pad-l); bottom: var(--pad-b); }

/* ── Map credits: bottom centre ── */
.credits { position: absolute; z-index: 4; left: 50%; bottom: calc(var(--edge) / 2 + var(--safe-bottom)); transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; pointer-events: none; }
.credits > * { pointer-events: auto; }
.credits-btn { position: relative; display: grid; place-items: center; width: 26px; height: 26px; padding: 0; border: 0; border-radius: 50%; background: rgba(255, 253, 249, 0.72); color: var(--ink-2); }
.credits-btn::after { content: ""; position: absolute; inset: -9px; }
.credits-btn:hover, .credits-btn[aria-expanded="true"] { background: #fff; }
.credits-card { display: flex; flex-wrap: wrap; justify-content: center; gap: 4px 10px; max-width: min(340px, calc(100vw - 24px)); padding: 8px 12px; border-radius: 14px; background: rgba(255, 253, 249, 0.97); box-shadow: var(--shadow); font-size: 0.78rem; text-align: center; }
.credits-card a { color: var(--ink); min-height: 24px; display: inline-flex; align-items: center; }

/* A half-height page covers the lower part of the screen: the scene is drawn in what is left above it. */
@media (max-width: 720px) {
  .stage.sheet .canvas, .stage.sheet .veil { bottom: auto; height: calc((100% - var(--shell-nav)) * (1 - var(--sheet-share)) + 22px); }
  .stage.sheet .hud-live, .stage.sheet .credits { display: none; }
}

/* ── Portrait phone: the cluster, then the minimap, then hints under it; panels rise from the bottom ── */
@media (max-width: 720px) and (orientation: portrait) {
  .stage { --cluster: 0px; --map: 68px; }
  .hints { top: calc(var(--shell-top) + var(--map) + 14px); left: var(--pad-l); }
  .hud-panel { top: auto; left: var(--pad-l); right: var(--pad-r); bottom: var(--pad-b); width: auto; max-height: min(64dvh, calc(100% - var(--shell-top) - var(--pad-b) - 12px)); }
}
/* The class comes from the same computed that releases the thumb pad (bottomPanel), so the pad is never hidden without being let go. */
.stage.panel-bottom .dock, .stage.panel-bottom .stick-slot, .stage.panel-bottom .credits, .stage.panel-bottom .home-tools, .stage.panel-bottom .hints { display: none; }
@media (max-width: 720px) and (orientation: portrait) {
  .decision { max-height: min(40dvh, calc(100% - var(--shell-top) - 148px)); }
  .act { padding: 0 12px; gap: 6px; }
  .dock { max-width: calc(100% - var(--pad-l) - var(--pad-r) - 134px); gap: 6px; }
  .act-target { max-width: 12ch; }
  .decision.over { left: var(--pad-l); right: var(--pad-r); width: auto; }
}
/* ── Short landscape (a phone on its side): everything tightens, targets stay 44 px ── */
@media (max-height: 460px) and (orientation: landscape) {
  .stage { --edge: 8px; --cluster: 224px; }
  .rail { display: grid; grid-template-columns: repeat(2, var(--tap)); gap: 4px; }
  .hints { top: calc(var(--shell-top) + 6px); left: calc(var(--pad-l) + var(--map) + 14px); right: calc(var(--pad-r) + 2 * var(--tap) + 14px); }
  .hud-panel { right: calc(var(--pad-r) + 2 * var(--tap) + 14px); }
  .home-tools { right: calc(var(--pad-r) + 2 * var(--tap) + 14px); }
  .act { min-height: 54px; }
  .hud-panel { max-height: calc(100% - var(--pad-t) - var(--pad-b) - 62px); }
  .log { max-height: 24dvh; }
}
@media (prefers-reduced-motion: reduce) { .hint, .hud-panel, .act { animation: none; } }
</style>
