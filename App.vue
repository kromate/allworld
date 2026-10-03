<script setup lang="ts">
// Game shell: the world fills the screen. Over it sit a small player cluster (portrait, coins, meters),
// the world's own quiet HUD (src/features/world/WorldStage.vue), the Menu sheet, and floating windows.
// While a page is open over the world its section bar returns, so pages stay one press apart.
// Also owns the startup states that are not the happy path.
import { computed, defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { brand } from './src/brand.ts'
import { api, app, boot, confirmTransfer, leaveTransfer, messageOf, onServerEvent, setSeatedOperationGuard, switchLocalActor, transfer } from './src/state/app.ts'
import { social } from './src/state/social.ts'
import { retainLiveCounts } from './src/state/liveCounts.ts'
import LiveCounts from './src/ui/LiveCounts.vue'
import { NUDGE_PARAM, startPresenceBeat } from './src/shared/comeback.ts'
import type { NudgeId, NudgeItem } from './src/shared/comeback.ts'
import { guestAccess } from './src/shared/guest.ts'
import { enterDefaultScene, world } from './src/state/world.ts'
import { loadTravel, onArrival, secondsLeft, travel } from './src/state/travel.ts'
import { providers } from './src/config/providers.ts'
import BrandMark from './src/ui/BrandMark.vue'
import MemberBadge from './src/ui/MemberBadge.vue'
import GameMenu from './src/ui/GameMenu.vue'
import { permits, useHold, onNeutralize } from './src/ui/gameInput.ts'
import { vehicles } from './src/state/vehicles.ts'
import type { DistrictId, PlaceId } from './src/shared/ids.ts'
import type { Vec2 } from './src/shared/geo.ts'
import type { VehicleDestination } from './src/shared/vehicles.ts'
import TransportHud from './src/features/transport/TransportHud.vue'
import { PRIORITY, useInteraction } from './src/ui/interaction.ts'
import { factsOf, hotkey } from './src/ui/hudKeys.ts'
import HudIcon from './src/ui/HudIcon.vue'
import ShellNav from './src/ui/ShellNav.vue'
import ToastStack from './src/ui/ToastStack.vue'
import UpdateNotice from './src/ui/UpdateNotice.vue'
import BuildInfo from './src/ui/BuildInfo.vue'
import { buildInfo, pageBuild, startBuildChecks } from './src/platform/buildInfo.ts'
import { provideGameReload } from './src/ui/gameReload.ts'
import { NAV, SHEET } from './src/ui/shell.ts'
import NeedsHud from './src/features/life/NeedsHud.vue'
import { work } from './src/features/life/workTrip.ts'
import GuestChip from './src/features/guest/GuestChip.vue'
import { GUEST_ACCESS, createGuestControl } from './src/features/guest/guestControl.ts'
import { guestHooks } from './src/features/guest/guestHooks.ts'
import { GUEST_CONTROL, routeGate } from './src/features/guest/guestView.ts'
import { withoutPlaytestFragment } from './src/features/guest/playtestInvite.ts'

// The 3D stage and the first-run screens are fetched when they are needed, so the first paint stays small.
const WorldStage = defineAsyncComponent(() => import('./src/features/world/WorldStage.vue'))
const Onboarding = defineAsyncComponent(() => import('./src/features/world/Onboarding.vue'))
const GuestWelcome = defineAsyncComponent(() => import('./src/features/guest/GuestWelcome.vue'))
const GuestGatePage = defineAsyncComponent(() => import('./src/features/guest/GuestGatePage.vue'))
const AccountAccess = defineAsyncComponent(() => import('./src/features/account/AccountAccess.vue'))
const GuestTransfer = defineAsyncComponent(() => import('./src/features/guest/GuestTransfer.vue'))
const CreatorPage = defineAsyncComponent(() => import('./src/features/creator/CreatorPage.vue'))

const offSeatedGuard = setSeatedOperationGuard(() => Boolean(vehicles.seated.value))
const offVehicleNeutralize = onNeutralize(() => vehicles.stopDriving())
onBeforeUnmount(() => { offSeatedGuard(); offVehicleNeutralize() })
useInteraction('transport.exit', () => vehicles.seated.value ? {
  id: 'transport.exit', priority: PRIORITY.transport, verb: 'Exit', target: 'vehicle', label: 'Exit this vehicle safely', icon: 'exit', key: 'E', exclusive: true,
  busy: Boolean(vehicles.state.pending), disabled: !vehicles.state.connected || vehicles.state.uncertain || Boolean(vehicles.state.transfer),
  run: () => { void vehicles.exit() },
} : null)

const route = useRoute()
const router = useRouter()

const mapTransport = computed(() => {
  const seat = vehicles.seated.value, vehicle = vehicles.selected.value, mode = vehicles.state.destinationMode
  const canRoute = Boolean(vehicles.driver.value || (!seat && vehicle?.source === 'service' && !vehicles.state.paidRide))
  if (!seat && !mode && !vehicles.state.paidRide && !vehicles.state.uncertain && !vehicles.state.problem && !vehicles.state.pending && !vehicles.state.retryLabel && !canRoute) return undefined
  const busy = !vehicles.state.connected || Boolean(vehicles.state.pending) || vehicles.state.uncertain
  const role = seat ? seat.seatId === 'driver' ? 'driver' : 'passenger' : null
  return {
    role, connected: vehicles.state.connected, busy,
    canChooseDestination: !busy && (role === 'passenger' || mode === 'preview' || (canRoute && !vehicles.capabilityReason.value)),
    canStopRide: Boolean(vehicles.state.paidRide),
    status: !vehicles.state.connected ? 'Reconnecting. Your ride will be checked.' : vehicle?.trip ? `${vehicle.trip.label} · ${vehicle.trip.state}` : vehicles.state.paidRide ? 'Your paid ride can be checked even after your seat is released.' : role ? 'Explore the map while you ride.' : 'Choose a place or street point to check the route.',
    pending: vehicles.state.pending, problem: vehicles.state.problem, retryLabel: vehicles.state.retryLabel,
  }
})
async function chooseVehicleMapDestination(selection: { districtId: DistrictId; pos: Vec2; label: string; placeId?: PlaceId }): Promise<void> {
  if (!mapTransport.value?.canChooseDestination) return
  const actor = app.me?.id
  const vehicle = vehicles.selected.value
  if (!vehicles.state.destinationMode && vehicle) vehicles.openMapDestination(vehicle.id)
  const mode = vehicles.state.destinationMode
  const target: VehicleDestination = selection.placeId ? { kind: 'place', districtId: selection.districtId, placeId: selection.placeId } : { kind: 'point', districtId: selection.districtId, pos: { ...selection.pos } }
  try {
    await vehicles.mapDestination(target)
    if (actor === app.me?.id && route.path === '/map' && mode !== 'preview' && !vehicles.state.problem) await router.push('/')
  } catch (error) { vehicles.state.problem = messageOf(error) }
}
async function stopVehicleMapRide(): Promise<void> {
  try { await vehicles.cancelTrip() } catch (error) { vehicles.state.problem = messageOf(error) }
}
async function retryVehicleMapAction(): Promise<void> {
  try { await vehicles.retryLast() } catch (error) { vehicles.state.problem = messageOf(error) }
}


// ── Playing as a guest ──
// The session controller says who is a guest and takes the claim; this only places the windows.
// `guest.session` is null for a signed-in member and for a local test member.
const guest = createGuestControl(guestHooks, path => { void router.push(path) })
onBeforeUnmount(guest.dispose)
provide(GUEST_CONTROL, guest)
// The account form's state for the save window. The form on the first screen below reads the same state.
provide(GUEST_ACCESS, guest)
/** The section this route belongs to is closed whole to a guest: its page is not mounted, so it asks the service nothing. */
const closedTo = computed(() => (guest.session.value ? routeGate(route.meta.gate) : null))
// Returning players skip the welcome screen; remove an unused invitation without switching them.
watch(() => [app.phase, route.fullPath] as const, ([phase, path]) => {
  if (phase !== 'ready' || app.mode !== 'hosted' || guest.admission() !== 'pass') return
  const clean = withoutPlaytestFragment(path)
  if (clean !== path) void router.replace(clean).catch(() => undefined)
})
const accountOpen = ref(false)
const aboutOpen = ref(false)
const moreOpen = ref(false)

const SHORTCUTS = NAV.filter(item => item.key)

const onboarded = computed(() => Boolean(app.me?.onboardedAt))
/** Unread inbox items and messages: the Menu button shows a dot for them, since its sheet is where they are. */
const waiting = computed(() => app.unread + social.unreadDirect)
const badges = computed(() => ({ '/inbox': app.unread, '/messages': social.unreadDirect }))
const panelOpen = computed(() => route.path !== '/')
const wide = computed(() => Boolean(route.meta.wide))
const linkLabel = computed(() => ({ connecting: 'Connecting', online: 'Connected', reconnecting: 'Reconnecting', offline: 'Offline and retrying', denied: 'Signed out', replaced: 'Opened elsewhere', 'update-required': 'Update ready' })[app.link])
// The service moved to a newer build while this page was playing. The page is left as it is, with
// whatever is open in it, and says so until the member reloads: nothing here reloads by itself.
const serverUpdate = computed(() => Boolean(pageBuild && buildInfo.latest && buildInfo.latest.id !== pageBuild.id))
const updateRequired = computed(() => app.link === 'update-required' || (serverUpdate.value && buildInfo.dismissed !== buildInfo.latest?.id))
// `critical` holds even against a hard update: something is being decided with the service right now
// (a guest being issued, sign-in, a save, an account switch, a character being moved here). `activity`
// is what a hard update may go past, with a warning: an open window, a form, a vehicle, a journey.
const { blocked: updateBlocked, warning: updateWarning, reload: reloadToUpdate } = provideGameReload(() => {
  // Guest, account, save and transfer rules are the guest controller's (guestControl.ts `reloadBlockers`).
  const journey = guest.reloadBlockers()
  if (journey.critical || journey.activity) return journey
  if (vehicles.seated.value || vehicles.state.pending || vehicles.state.transfer) return { activity: 'Park and leave the vehicle before updating.' }
  if (transit.value) return { activity: 'Finish your journey before updating.' }
  if (panelOpen.value && app.phase === 'ready') return { activity: 'Save your changes and close this window before updating.' }
  if (!onboarded.value && app.phase === 'ready') return { activity: 'Finish creating and saving your character before updating.' }
  return {}
})
const deferUpdate = (): void => { buildInfo.dismissed = buildInfo.latest?.id ?? '' }
let stopBuildChecks: (() => void) | null = null

async function arrive(): Promise<void> {
  const memberId = app.me?.id
  const state = await loadTravel()
  if (!memberId || memberId !== app.me?.id) return
  // Mid-trip there is no street to stand in yet; the arrival handler enters it when the trip ends.
  if (state?.trip) { void router.push('/travel'); return }
  const area = state?.location ?? app.me.browsing ?? app.me.currentArea
  // The world restores actual held seats, saved home stays and captured exits before choosing a street.
  const entered = await enterDefaultScene(area)
  if (memberId !== app.me?.id) return
  if (!entered && world.state !== 'error' && !area) void router.push('/settings?tab=area')
}
const stopArrival = onArrival(() => { void router.push('/') })
const tick = ref(0)
// The countdown only ticks while there is a trip to count down and someone is looking.
const ticker = window.setInterval(() => { if (travel.state?.trip && !document.hidden) tick.value++ }, 1000)
const transit = computed(() => { void tick.value; return travel.state?.trip ? { to: travel.state.trip.to.label, seconds: secondsLeft(), mode: travel.state.trip.mode } : null })
const phoneQuery = window.matchMedia('(max-width: 720px)')
const phoneLayout = ref(phoneQuery.matches)
const updatePhoneLayout = (event: MediaQueryListEvent): void => { phoneLayout.value = event.matches }
// A shift worked at a place is played with the worker in view: while it is open and the avatar
// stands in that very venue, Work is a half-height sheet on a phone. Finding work, results, practice
// and a shift picked up somewhere else are ordinary pages.
const shiftSheet = computed(() => {
  const site = route.path === '/work' ? work.active?.site : null
  return Boolean(site && world.state === 'ready' && world.kind === 'venue' && world.venue?.placeId === site.placeId && world.districtId === site.districtId)
})
const sheetCapable = computed(() => phoneLayout.value && panelOpen.value && (Boolean(route.meta.half) || shiftSheet.value))
/** The member grew the sheet to full height. Each page starts as a half again. */
const sheetGrown = ref(false)
watch(() => route.path, () => { sheetGrown.value = false })
/** The one condition: the window's class, the stage's framing and whether the world is drawn all read it. */
const half = computed(() => sheetCapable.value && !sheetGrown.value)
provide(SHEET, { capable: sheetCapable, half, toggle: () => { sheetGrown.value = !sheetGrown.value } })
// An open window can cover the player row, so the update notice goes inside it; a half sheet leaves the row in view.
const updateInWindow = computed(() => panelOpen.value && !half.value)
// The 3D world stops drawing when it cannot be seen: during a trip, and on a phone whenever a
// full-height window covers it. Side windows on a desktop and a half-height sheet leave it running.
const suspendWorld = computed(() => Boolean(transit.value) || (phoneLayout.value && panelOpen.value && !half.value))

// The player row can grow (the connection notice joins it), so its lower edge is measured here and
// everything under it reads --shell-top instead of keeping an offset of its own.
const game = ref<HTMLElement | null>(null)
const topbar = ref<HTMLElement | null>(null)
let topWatch: ResizeObserver | null = null
watch(topbar, bar => {
  topWatch?.disconnect(); topWatch = null
  if (!bar || !('ResizeObserver' in window)) return
  topWatch = new ResizeObserver(() => { game.value?.style.setProperty('--shell-top', `${bar.offsetTop + bar.offsetHeight}px`) })
  topWatch.observe(bar)
})
watch(() => [app.phase, onboarded.value] as const, ([phase, ready], previous) => {
  if (phase === 'ready' && ready && !(previous && previous[0] === 'ready' && previous[1])) setTimeout(arrive, 0)
})

async function chooseActor(key: string): Promise<void> {
  accountOpen.value = false
  void router.push('/')
  await switchLocalActor(key)
}

// Escape closes the newest open overlay (src/ui/gameInput.ts handles it first, once). What is left for the shell is
// the page open over the world: Escape goes back to the world, unless someone is typing.
function onKey(event: KeyboardEvent): void {
  const target = event.target as HTMLElement | null
  if (event.key === 'Escape') {
    if (panelOpen.value && !(target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) void router.push('/')
    return
  }
  // The section shortcuts are the shell's own. A dialog or the Menu in front holds them; a page that is itself a section does not.
  if (!onboarded.value || !hotkey(factsOf(event), SHORTCUTS.map(item => item.key), permits('shell'))) return
  const entry = SHORTCUTS.find(item => item.key === event.key)
  if (entry) { event.preventDefault(); void router.push(entry.to) }
}
const playerBox = ref<HTMLElement | null>(null)
const portraitButton = ref<HTMLButtonElement | null>(null)
/** A press outside the account menu closes it. */
function onPointerDown(event: PointerEvent): void {
  if (accountOpen.value && playerBox.value && !playerBox.value.contains(event.target as Node)) accountOpen.value = false
}
// Closed with the keyboard inside it (or nowhere), focus goes back to the portrait button.
watch(accountOpen, open => {
  if (open) return
  void nextTick(() => { if (document.activeElement === document.body || playerBox.value?.contains(document.activeElement)) portraitButton.value?.focus({ preventScroll: true }) })
})

// ── Coming back after time away ──
// The service says once what happened while the member was gone; it is shown as a card, not a pile of toasts.
const welcome = ref<{ awayHours: number; total: number; items: NudgeItem[] } | null>(null)
// Who holds the input while a dialog or menu is in front of the world: one hold each, newest closes first on Escape.
// A hold stops this client's walking and the world's keys; the Menu is not a pause, and the world and service keep running.
useHold('shell.welcome', () => Boolean(welcome.value), { role: 'modal', close: () => { welcome.value = null } })
useHold('shell.about', () => aboutOpen.value, { role: 'modal', close: () => { aboutOpen.value = false } })
useHold('shell.menu', () => moreOpen.value, { role: 'modal', close: () => { moreOpen.value = false } })
useHold('shell.account', () => accountOpen.value, { role: 'modal', close: () => { accountOpen.value = false } })
const awayWords = computed(() => {
  const hours = welcome.value?.awayHours ?? 0
  return hours >= 48 ? `${Math.round(hours / 24)} days` : hours >= 2 ? `${Math.round(hours)} hours` : 'a little while'
})
// "Here" means the tab is on screen, not merely open: the service is told when that changes and every couple of minutes while it is.
let stopBeat: (() => void) | null = null
watch(() => app.phase === 'ready' && onboarded.value, ready => {
  stopBeat?.(); stopBeat = null
  if (ready) stopBeat = startPresenceBeat(visible => { void api('comeback.here', { visible, origin: location.origin }).catch(() => undefined) })
}, { immediate: true })
const stopEvents = onServerEvent(event => { if (event.type === 'comeback.welcome' && event.items.length) welcome.value = { awayHours: event.awayHours, total: event.total, items: event.items } })
function openWelcomeItem(item: NudgeItem): void { welcome.value = null; void router.push(item.link) }
// A link in an email or message carries ?nudge=<id>. Reporting it is how "did this bring anyone back" is measured.
watch(() => [route.query[NUDGE_PARAM], app.phase] as const, ([value, phase]) => {
  const id = typeof value === 'string' ? value : ''
  if (phase !== 'ready' || !/^ng_[a-z0-9_-]{3,40}$/.test(id)) return
  // Come-back links are an account's; a guest has none to report.
  if (!guest.session.value || guestAccess('comeback.opened').allowed) void api('comeback.opened', { nudgeId: id as NudgeId }).catch(() => undefined)
  const { [NUDGE_PARAM]: _used, ...rest } = route.query
  void router.replace({ path: route.path, query: rest })
}, { immediate: true })

let releaseCounts: (() => void) | null = null
onMounted(() => { stopBuildChecks = startBuildChecks(); window.addEventListener('keydown', onKey); document.addEventListener('pointerdown', onPointerDown); phoneQuery.addEventListener('change', updatePhoneLayout); void boot(); releaseCounts = retainLiveCounts() })
onBeforeUnmount(() => { stopBuildChecks?.(); releaseCounts?.(); window.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onPointerDown); phoneQuery.removeEventListener('change', updatePhoneLayout); stopArrival(); stopEvents(); stopBeat?.(); topWatch?.disconnect(); window.clearInterval(ticker) })
</script>

<template>
  <!-- A visitor with no account in hand, where the host has opened guest play: play first, save later. -->
  <!-- Signing in from the first screen, in the page. It stays up until its request is answered or the visitor cancels; a guest this device holds is saved to the account before any account world opens. -->
  <!-- A guest character moved from the old address: asked first, before anything is written here. -->
  <GuestTransfer
    v-if="transfer.stage !== 'none'" :stage="transfer.stage" :replaces="transfer.replaces" :changed="transfer.changed" :started-at="transfer.startedAt"
    :message="transfer.message" :retry-from="transfer.retryFrom" @confirm="confirmTransfer" @leave="leaveTransfer"
  />

  <main v-else-if="guest.access.at === 'welcome'" class="gate">
    <div class="gate-card access-card">
      <BrandMark :size="52" />
      <h1>Your {{ brand.name }} account</h1>
      <p v-if="guest.storedGuest.value" class="muted">This device holds a guest character. Signing in saves it to your account first; if the account already has a character, you choose which one to play and neither is changed.</p>
      <p v-else class="muted">Sign in to open your saved character, or create an account to start one you keep.</p>
      <!-- An account already signed in here is named and used only when confirmed. -->
      <template v-if="guest.access.existing">
        <p>Signed in on this device as <strong class="access-email">{{ guest.access.existing }}</strong>.</p>
        <p v-if="guest.access.error" class="notice coral" role="alert">{{ guest.access.error.message }}</p>
        <div v-if="guest.access.pending" class="notice sky" role="status"><strong>Checking the account…</strong></div>
        <button class="btn primary block access-email" type="button" :aria-disabled="guest.access.pending || undefined" @click="!guest.access.pending && guest.continueAs()">Continue as {{ guest.access.existing }}</button>
        <button class="btn block" type="button" :disabled="guest.access.pending" @click="guest.useAnother">Use another account</button>
        <button class="btn ghost block" type="button" @click="guest.cancelAccess">Cancel</button>
      </template>
      <AccountAccess v-else class="access-form" :pending="guest.access.pending" :error="guest.access.error" :password-policy="guest.passwordPolicy()" :google-sign-in="guest.googleAvailable.value ? guest.submitGoogleAccess : undefined" @submit="guest.submitAccess" @cancel="guest.cancelAccess" />
    </div>
  </main>

  <GuestWelcome
    v-else-if="guest.welcome.value" :sign-in="guest.canSignIn() ? 'available' : 'unavailable'" :admission="guest.admission()"
    :pending="guest.start.pending" :signing-in="guest.start.signingIn" :ended="guest.ended.value" :returning="guest.storedGuest.value"
    :problem="guest.start.problem || (guest.ended.value ? '' : app.failure)"
    @play="guest.play" @sign-in="guest.signIn" @cancel-sign-in="guest.cancelSignIn"
  />

  <!-- Startup and recovery states -->
  <main v-else-if="app.phase !== 'ready'" class="gate">
    <div class="gate-card">
      <BrandMark :size="52" />
      <template v-if="app.phase === 'booting'">
        <h1>{{ brand.name }}</h1>
        <p class="muted">Opening your world…</p>
        <div class="skeleton" style="height: 10px; width: 180px"></div>
      </template>
      <template v-else-if="app.phase === 'service-down'">
        <h1>The world service is not answering</h1>
        <p class="muted">{{ app.failure }}</p>
        <p class="small">On a local build, start it with <code>npm run dev</code> and reload. Nothing you saved is lost.</p>
        <button class="btn primary" type="button" @click="boot">Try again</button>
      </template>
      <template v-else-if="app.phase === 'replaced'">
        <h1>Opened in another tab</h1>
        <p class="muted">This member is now active somewhere else, so this tab was paused. Each member can be in the world from one place at a time.</p>
        <button class="btn primary" type="button" @click="boot">Use this tab instead</button>
      </template>
      <template v-else-if="app.phase === 'unsupported'">
        <h1>This page cannot open the world</h1>
        <p class="muted">This address is not set up as a {{ brand.name }} world, so there is no world or account to open from it. Use the link you were given.</p>
      </template>
      <!-- The service runs a newer build than this page. Trying again here cannot help; the member reloads when ready. -->
      <template v-else-if="app.phase === 'update-required'">
        <h1>The game was updated</h1>
        <p>This page is the older version, so it cannot open the world. Reload to get the new one.</p>
        <p class="muted">Your saved character and progress are kept.</p>
        <p v-if="updateBlocked" class="muted" role="status">{{ updateBlocked }}</p>
        <button class="btn primary" type="button" :disabled="Boolean(updateBlocked)" @click="reloadToUpdate">Reload to update</button>
      </template>
      <!-- The service saved the guest's character to the account; opening the account's world is a separate step that failed. -->
      <template v-else-if="guest.savedUnopened.value">
        <h1>Your character is saved</h1>
        <p>It belongs to your account now. The world could not open it on this screen yet.</p>
        <p class="muted">{{ app.failure }}</p>
        <button class="btn primary" type="button" :disabled="Boolean(guest.busy.value)" @click="guest.openSaved">Open my saved character</button>
      </template>
      <!-- "Use my saved character" did not open it. Nothing was merged or moved, and the guest is still held. -->
      <template v-else-if="guest.switchFailed.value">
        <h1>Your saved character could not be opened</h1>
        <p class="muted">{{ app.failure }}</p>
        <p v-if="guest.storedGuest.value" class="small">Your guest character is unchanged and still kept on this device.</p>
        <button class="btn primary" type="button" :disabled="Boolean(guest.busy.value)" @click="guest.useSaved">Try again</button>
        <button v-if="guest.storedGuest.value" class="btn" type="button" :disabled="Boolean(guest.busy.value)" @click="guest.keepGuest">Keep playing as guest</button>
      </template>
      <template v-else>
        <h1>We could not sign you in</h1>
        <p class="muted">{{ app.failure }}</p>
        <button class="btn primary" type="button" @click="boot">Try again</button>
        <button v-if="guest.storedGuest.value" class="btn" type="button" :disabled="Boolean(guest.busy.value)" @click="guest.returnToGuest">Play as my guest character instead</button>
      </template>
    </div>
  </main>

  <Onboarding v-else-if="!onboarded" />

  <div v-else ref="game" class="game" :class="{ 'window-open': panelOpen, playing: !panelOpen }">
    <!-- Transport: render the vehicle panel with `<template #transport>` and pass `:seated`; see docs/ux/GAMEPLAY-HUD-030.md. -->
    <WorldStage :dimmed="panelOpen" :suspended="suspendWorld" :sheet="half" :menu-open="moreOpen" :menu-badge="waiting" :seated="Boolean(vehicles.seated.value)" @menu="moreOpen = !moreOpen">
      <template #transport="{ overlayOpen: transportBlocked }"><TransportHud compact-driver :input-blocked="transportBlocked" @drive-intent="moreOpen = false; router.push('/')" @boarded="moreOpen = false; router.push('/')" /></template>
    </WorldStage>

    <!-- Player cluster: portrait (opens the account menu), coins, meters. Names, places and counts are on demand. -->
    <header ref="topbar" class="topbar">
     <div class="topbar-row">
      <div ref="playerBox" class="player">
      <button ref="portraitButton" class="portrait-btn" type="button" :aria-expanded="accountOpen" aria-haspopup="menu" :aria-label="`${app.me?.displayName ?? 'Your character'}: account and character`" title="Account and character" @click="accountOpen = !accountOpen">
        <MemberBadge v-if="app.me" :member-id="app.me.id" :look="app.me.look" :size="40" />
      </button>
      <div v-if="accountOpen" class="menu" role="menu">
        <p class="menu-head truncate"><strong>{{ app.me?.displayName }}</strong></p>
        <RouterLink v-if="guest.session.value" class="menu-item" role="menuitem" to="/save" @click="accountOpen = false"><HudIcon name="save" :size="20" /><span class="grow">Save my character</span><span class="chip amber">Guest</span></RouterLink>
        <button v-else-if="guest.returnable.value" class="menu-item" type="button" role="menuitem" @click="accountOpen = false; guest.returnToGuest()"><HudIcon name="back" :size="20" /><span class="grow">Back to my guest character</span></button>
        <RouterLink class="menu-item" role="menuitem" to="/settings?tab=character" @click="accountOpen = false"><HudIcon name="user" :size="20" /><span class="grow">My character</span></RouterLink>
        <RouterLink class="menu-item" role="menuitem" to="/settings" @click="accountOpen = false"><HudIcon name="sliders" :size="20" /><span class="grow">Settings</span><span class="kbd">,</span></RouterLink>
        <button class="menu-item" type="button" role="menuitem" @click="accountOpen = false; aboutOpen = true"><HudIcon name="info" :size="20" /><span class="grow">About · v{{ brand.version }}</span></button>
        <!-- Ends this device's session, through the session controller: the world closes here first. -->
        <button v-if="guest.account.value" class="menu-item" type="button" role="menuitem" @click="accountOpen = false; guest.signOut()"><HudIcon name="exit" :size="20" /><span class="grow">Sign out</span></button>
        <template v-if="app.mode === 'local'">
          <p class="menu-note"><span class="chip ink">Local build</span> Test members on this machine, not real accounts.</p>
          <button
            v-for="actor in app.actors" :key="actor.key" class="menu-item" type="button" role="menuitemradio" :aria-checked="actor.key === app.actorKey"
            @click="chooseActor(actor.key)"
          >
            <span class="radio" aria-hidden="true"></span>
            <span class="grow">{{ actor.name }}</span>
            <span v-if="actor.reviewer" class="chip grape">Reviewer</span>
          </button>
          <p class="menu-note muted">Open a second tab with <code>?as=b</code> to be two members at once.</p>
        </template>
      </div>
      </div>
      <span class="coins num" title="Coins: play money earned by working and playing. Not credits, not real money.">
        <HudIcon name="coin" :size="16" /><span aria-hidden="true">{{ app.points === null ? '…' : app.points.toLocaleString() }}</span>
        <span class="sr-only">{{ app.points === null ? 'Coins not loaded yet' : `${app.points} coins` }}</span>
      </span>

      <!-- Daily-life meters: two small bars; the life track owns what is inside. -->
      <div class="needs"><NeedsHud /></div>
      <LiveCounts />
     </div>

     <!-- The one guest element over the world: in the cluster's own flow, so nothing is placed over it. -->
     <GuestChip v-if="guest.session.value" :claim="guest.claim.value" :ends-at="guest.session.value.status.endsAt" :tab-only="!guest.session.value.persisted" @open="router.push('/save')" />

     <!-- Not a connection that will come back: said apart from the retrying notice, with the one thing that fixes it. -->
     <UpdateNotice :optional="serverUpdate && app.link !== 'update-required'" :blocked="updateBlocked" :warning="updateWarning" @reload="reloadToUpdate" @later="deferUpdate" v-if="updateRequired && !updateInWindow" />
     <div v-else-if="app.link !== 'online' && !updateRequired" class="link-banner" role="status"><span class="pulse" aria-hidden="true"></span><span>{{ linkLabel }}. Actions and saving are paused. Unanswered actions may not be saved.</span></div>
    </header>

    <RouterLink v-if="transit && !panelOpen" to="/travel" class="transit" role="status">
      <span class="transit-icon" aria-hidden="true"><HudIcon :name="transit.mode === 'flight' ? 'plane' : 'car'" :size="30" /></span>
      <span><strong>On the way to {{ transit.to }}</strong><span class="muted small" style="display: block">Arriving in {{ transit.seconds }} s · open Travel to follow the trip</span></span>
    </RouterLink>

    <!-- A page is open: its section bar is back (five sections, the rest under More). On the world screen the Menu button's sheet lists them all. -->
    <ShellNav v-if="panelOpen" v-model:open="moreOpen" :badges="badges" />
    <GameMenu v-else v-model:open="moreOpen" :badges="badges" />

    <!-- Game window. On a phone it is the page between the top edge and the bar; a half-height sheet leaves the world live above it. -->
    <div v-if="panelOpen" class="window-layer" :class="{ half }" @click.self="router.push('/')">
      <section class="window" :class="{ wide, half, full: Boolean(route.meta.full) }">
        <!-- Above the page, not in place of it: what is being edited stays mounted and readable. -->
        <UpdateNotice :optional="serverUpdate && app.link !== 'update-required'" :blocked="updateBlocked" :warning="updateWarning" @reload="reloadToUpdate" @later="deferUpdate" v-if="updateRequired && updateInWindow" class="window-update" />
        <CreatorPage v-if="closedTo === 'messaging'" active />
        <GuestGatePage v-else-if="closedTo" :key="route.path" :title="typeof route.meta.title === 'string' ? route.meta.title : ''" :gate="closedTo" />
        <RouterView v-else v-slot="{ Component }">
          <Suspense>
            <component :is="Component" v-if="route.path === '/map'" :key="route.path" :transport="mapTransport" @transport-destination="chooseVehicleMapDestination" @transport-stop="stopVehicleMapRide" @transport-retry="retryVehicleMapAction" />
            <component :is="Component" v-else :key="route.path" />
            <template #fallback><div class="panel-loading"><div class="skeleton" style="height: 26px; width: 50%"></div><div class="skeleton" style="height: 70px"></div><div class="skeleton" style="height: 70px"></div></div></template>
          </Suspense>
        </RouterView>
      </section>
    </div>

    <div v-if="welcome" class="scrim" role="dialog" aria-modal="true" aria-labelledby="welcome-title" @click.self="welcome = null">
      <div class="dialog stack">
        <div class="row">
          <span class="icon-chip" aria-hidden="true"><HudIcon name="smile" :size="22" /></span>
          <div class="grow"><h2 id="welcome-title">Welcome back</h2><span class="muted small">You were away for {{ awayWords }}. Here is what happened.</span></div>
          <button class="btn ghost icon sm" type="button" aria-label="Close" @click="welcome = null"><HudIcon name="close" :size="18" /></button>
        </div>
        <ul class="welcome-list">
          <li v-for="(item, index) in welcome.items" :key="index">
            <span class="grow">{{ item.line }}</span>
            <button class="btn sm" :class="{ primary: index === 0 }" type="button" @click="openWelcomeItem(item)">{{ item.cta }}</button>
          </li>
        </ul>
        <p v-if="welcome.total > welcome.items.length" class="muted small">And {{ welcome.total - welcome.items.length }} more in your <RouterLink to="/inbox" @click="welcome = null">inbox</RouterLink>.</p>
        <button class="btn block" type="button" @click="welcome = null">Back to the world</button>
      </div>
    </div>

    <div v-if="aboutOpen" class="scrim" role="dialog" aria-modal="true" aria-labelledby="about-title" @click.self="aboutOpen = false">
      <div class="dialog stack">
        <div class="row"><BrandMark :size="44" /><div class="grow"><h2 id="about-title">{{ brand.name }}</h2><span class="chip amber">Working title</span></div><button class="btn ghost icon sm" type="button" aria-label="Close" @click="aboutOpen = false"><HudIcon name="close" :size="18" /></button></div>
        <dl class="about">
          <dt>Version</dt><dd><BuildInfo /></dd>
          <dt>Running</dt><dd>{{ app.mode === 'local' ? 'Local build with the local world service' : 'Hosted world' }}</dd>
          <dt>Map data</dt><dd>{{ providers.tiles.attribution }}{{ world.dataVersion ? ` · tileset ${world.dataVersion}` : '' }}</dd>
          <dt>3D models</dt><dd>Characters from Microsoft Rocketbox (MIT). Furniture by Kenney (CC0). Face shape reading by MediaPipe (Apache-2.0).</dd>
          <dt>Street life</dt><dd>People without a name tag are street life, not members. They are scenery: they are not counted, listed or shown on the map, and they do not chat. Vehicles, stalls and shop names are illustrative.</dd>
          <dt>Coins</dt><dd>Coins are play money earned by working and playing in the game. They are not credits of any kind and cannot be exchanged for real money.</dd>
        </dl>
      </div>
    </div>
  </div>

  <!-- The first-run screens have no player row to carry the notice, so it sits over them. -->
  <UpdateNotice :optional="serverUpdate && app.link !== 'update-required'" :blocked="updateBlocked" :warning="updateWarning" @reload="reloadToUpdate" @later="deferUpdate" v-if="updateRequired && app.phase === 'ready' && !onboarded" class="first-run-update" />

  <ToastStack v-if="!(app.phase === 'ready' && phoneLayout && panelOpen && !half)" class="toasts" :class="{ 'over-nav': app.phase === 'ready' && panelOpen }" />
</template>

<style scoped>
.gate { height: 100%; display: grid; place-items: center; padding: 20px; background: radial-gradient(90% 70% at 15% 0%, #ffe9b8, transparent 60%), radial-gradient(70% 60% at 100% 10%, #cfe8fb, transparent 60%), var(--bg); }
.access-card { width: 100%; }
.access-form { width: 100%; }
.access-email { white-space: normal; overflow-wrap: anywhere; max-width: 100%; }
.gate-card { max-width: 460px; display: grid; justify-items: start; gap: 12px; padding: 28px; border-radius: 24px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-lg); }
code { padding: 1px 6px; border-radius: 6px; background: var(--surface-3); font-size: 0.86em; }

.game { position: relative; height: 100%; overflow: hidden; background: #1c1a24; }
/* On the world screen there is no bar along the bottom: the world's own controls own the edges. */
.game.playing { --shell-nav: var(--safe-bottom); }

/* The player cluster: one short row in normal flow at the upper left. The guest chip and the connection
   notice take lines under it. It stops short of the world's right-hand button column (44 px + gaps), so
   a notice never covers those buttons. Clicks between the pieces fall through to the world. */
.topbar { position: absolute; top: calc(10px + env(safe-area-inset-top, 0px)); left: calc(10px + env(safe-area-inset-left, 0px)); right: calc(64px + env(safe-area-inset-right, 0px)); z-index: 12; display: flex; flex-direction: column; align-items: flex-start; gap: 6px; pointer-events: none; }
.topbar-row { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; max-width: 100%; }
.topbar-row > *, .link-banner { pointer-events: auto; }
.player { position: relative; flex: 0 0 auto; }
.portrait-btn { display: grid; place-items: center; width: 46px; height: 46px; padding: 0; border: 0; border-radius: 15px; background: transparent; }
.portrait-btn:hover :deep(img) { filter: brightness(1.08); }
.coins { display: inline-flex; align-items: center; gap: 5px; min-height: 28px; padding: 0 10px; border-radius: 999px; background: rgba(28, 26, 36, 0.62); border: 1px solid rgba(255, 255, 255, 0.3); box-shadow: 0 2px 8px rgba(20, 14, 6, 0.22); color: var(--accent); font-size: 0.84rem; font-weight: 750; }
.menu { position: absolute; left: 0; top: calc(100% + 6px); width: min(300px, calc(100vw - 20px)); z-index: 20; padding: 8px; border-radius: 18px; background: var(--surface); border: 1px solid var(--line-strong); box-shadow: var(--shadow-lg); display: grid; gap: 2px; max-height: calc(100dvh - 90px - var(--safe-bottom)); overflow-y: auto; overscroll-behavior: contain; }
.menu-head { padding: 6px 8px 8px; border-bottom: 1px solid var(--line); margin-bottom: 4px; font-size: 1rem; }
.menu-note { padding: 8px 8px 4px; font-size: 0.78rem; color: var(--ink-2); border-top: 1px solid var(--line); margin-top: 4px; }
.menu-note + .menu-item ~ .menu-note { border-top: 0; margin-top: 0; }
.menu-item { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 8px; border: 0; border-radius: 10px; background: transparent; text-align: left; color: var(--ink); text-decoration: none; font-weight: 600; }
.menu-item:hover { background: var(--surface-2); }
.radio { width: 16px; height: 16px; border-radius: 50%; border: 2px solid var(--line-strong); flex: none; }
.menu-item[aria-checked="true"] .radio { border-color: var(--accent-strong); background: radial-gradient(circle, var(--accent-strong) 45%, transparent 50%); }

.needs { flex: none; }

.link-banner { display: flex; align-items: center; gap: 8px; padding: 6px 12px; border-radius: 16px; background: var(--ink); color: #fff; font-size: 0.8rem; line-height: 1.3; box-shadow: var(--shadow); max-width: min(100%, 420px); }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-strong); animation: blink 1s ease infinite; flex: none; }
@keyframes blink { 50% { opacity: 0.3; } }

.transit { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 12; display: flex; align-items: center; gap: 14px; padding: 16px 22px; border-radius: 22px; background: var(--surface); color: var(--ink); text-decoration: none; box-shadow: var(--shadow-lg); max-width: calc(100% - 24px); }
.transit-icon { display: grid; place-items: center; color: var(--accent-text); animation: drift 2.4s ease-in-out infinite; }
@keyframes drift { 50% { transform: translateX(8px); } }

.window-layer { position: absolute; inset: 0; z-index: 13; display: flex; justify-content: flex-end; align-items: stretch; padding: calc(12px + env(safe-area-inset-top, 0px)) 12px var(--shell-nav); pointer-events: none; }
.window { min-width: 0; min-height: 0; pointer-events: auto; width: min(470px, 100%); max-height: 100%; display: flex; flex-direction: column; border-radius: 24px; background: var(--bg); border: 1px solid rgba(255, 255, 255, 0.7); box-shadow: var(--shadow-lg), 0 0 0 1px rgba(28, 26, 36, 0.08); overflow: hidden; animation: pop 0.2s ease; }
.window.wide { width: min(780px, 100%); }
.window.full { width: min(1180px, 100%); }
@keyframes pop { from { transform: translateY(14px) scale(0.985); opacity: 0; } }
.window-update { flex: none; margin: 10px 12px 0; }
.panel-loading { padding: 22px 18px; display: grid; gap: 12px; }

.scrim { position: fixed; inset: 0; z-index: 50; display: grid; place-items: center; padding: 16px; background: rgba(28, 26, 36, 0.45); }
.dialog { max-height: calc(100dvh - 32px - env(safe-area-inset-top, 0px) - var(--safe-bottom)); overflow-y: auto; overscroll-behavior: contain; width: min(520px, 100%); padding: 20px; border-radius: 20px; background: var(--surface); box-shadow: var(--shadow-lg); }
.about { display: grid; grid-template-columns: auto 1fr; gap: 8px 14px; margin: 0; font-size: 0.9rem; }
.about dt { color: var(--muted); font-weight: 600; }
.about dd { margin: 0; }
.welcome-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; max-height: 46vh; overflow-y: auto; }
.welcome-list li { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--line); }
.welcome-list li .grow { flex-basis: 180px; }

.toasts { position: fixed; left: 50%; bottom: calc(48px + var(--safe-bottom)); transform: translateX(-50%); z-index: 60; display: grid; gap: 8px; width: min(440px, calc(100% - 24px)); pointer-events: none; }
/* A page is open and its section bar is back: messages stand on it. */
.toasts.over-nav { bottom: var(--shell-nav); }
.first-run-update { position: fixed; left: 50%; top: calc(10px + env(safe-area-inset-top, 0px)); transform: translateX(-50%); z-index: 55; width: min(440px, calc(100% - 24px)); }

@media (max-width: 720px) {
  /* A page is the whole screen above the section bar, which stays in reach. The world behind it is not drawn. */
  .window-layer { inset: 0 0 var(--shell-nav); padding: env(safe-area-inset-top, 0px) 0 0; align-items: flex-end; pointer-events: auto; background: var(--bg); z-index: 15; }
  .window, .window.wide, .window.full { width: 100%; max-height: 100%; height: 100%; border: 0; border-radius: 0; box-shadow: none; }
  /* A sheet that works on the 3D scene leaves the rest of the screen showing it, live. */
  .window-layer.half { background: none; pointer-events: none; }
  .window.half { height: calc(100% * var(--sheet-share)); border-radius: 22px 22px 0 0; box-shadow: var(--shadow-lg); }
}
/* Portrait: counts keep their accessible label and details behind a touch-sized icon. */
@media (max-width: 720px) and (orientation: portrait) {
  .topbar-row { gap: 6px; }
  .topbar-row :deep(.counts-button) { width: 44px; min-height: 44px; padding: 0; justify-content: center; }
  .topbar-row :deep(.counts-button span:not(.online-dot)) { display: none; }
  .toasts:not(.over-nav) { bottom: calc(142px + var(--safe-bottom)); top: auto; }
}
</style>
