<script setup lang="ts">
// Settings: character, area, privacy, reminders, display. Each tab is linkable (?tab=…).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { EXTERNAL_CHANNELS, NOTIFY_CATEGORIES } from '../../shared/notify.ts'
import type { Channel, ExternalChannel, NotifyCategory, NotifyPrefs } from '../../shared/notify.ts'
import { WorldError } from '../../shared/model.ts'
import type { AreaSource, AvatarLook, CoarseArea, FaceAudience, MemberPreferences, MemberProfile } from '../../shared/model.ts'
import type { OpName, Ops } from '../../shared/protocol.ts'
import { api, app, messageOf, onAccountReset, toast } from '../../state/app.ts'
import { getEngine, refreshLocalAvatar, setTimeMode, world } from '../../state/world.ts'
import { useFace } from '../avatar/useFace.ts'
import type { FaceCaptureResult } from '../avatar/faceScan.ts'
import AvatarEditor from '../avatar/AvatarEditor.vue'
import AreaPicker from '../world/AreaPicker.vue'
import ComebackPanel from './ComebackPanel.vue'
import CountsHistoryPanel from './CountsHistoryPanel.vue'
import ArenaPrivacy from '../arena/ArenaPrivacy.vue'
import { CHANNEL_INFO, channelNote, channels, playTestCue, setChannelMuted, setChannelVolume, voiceVolumeAdjustable } from '../../state/sound.ts'
import PanelPage from '../../ui/PanelPage.vue'
import BuildInfo from '../../ui/BuildInfo.vue'
import StateView from '../../ui/StateView.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { dateTime, relativeTime } from '../../ui/format.ts'

const TABS = [['character', 'Character'], ['area', 'Area'], ['privacy', 'Privacy'], ['notifications', 'Alerts'], ['display', 'Display']] as const
type Tab = (typeof TABS)[number][0]
const route = useRoute()
const router = useRouter()
const tab = computed<Tab>(() => (TABS.some(([id]) => id === route.query.tab) ? (route.query.tab as Tab) : 'character'))
const go = (next: Tab): void => { void router.replace({ path: '/settings', query: { tab: next } }) }
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T
const me = computed(() => app.me!)

// An answer belongs to the member and session that asked. After an account or session change it is dropped, not shown to whoever is here now.
let session = 0
const stopReset = onAccountReset(() => { session++ })
onBeforeUnmount(stopReset)
function asker(): () => boolean {
  const id = app.me?.id, at = session
  return () => id !== undefined && at === session && app.me?.id === id
}
/** Like `attempt`, but a reply or refusal for a session that has ended writes nothing and shows nothing. Null also means failed. */
async function ask<K extends OpName>(op: K, input: Ops[K]['in'], success?: string): Promise<Ops[K]['out'] | null> {
  const mine = asker()
  try {
    const result = await api(op, input)
    if (!mine()) return null
    if (success) toast(success, 'good')
    return result
  } catch (error) {
    if (mine()) toast(messageOf(error), 'bad')
    return null
  }
}
/** Puts an answer's profile in place unless this page already holds a newer one, or the answer is for someone else. */
function keepProfile(profile: MemberProfile): void { if (app.me && profile.id === app.me.id && profile.revision >= app.me.revision) app.me = profile }
/** After a refused or unanswered save the service may hold the change, or a newer one from elsewhere. Read it again so a retry names the revision it will replace. Edits on screen stay. */
async function reread(mine: () => boolean): Promise<void> {
  if (!mine()) return
  try { const { profile } = await api('member.me', {}); if (mine()) keepProfile(profile) } catch { /* the next try says so */ }
}

// ── Character ──
const look = ref<AvatarLook>(copy(me.value.look))
const displayName = ref(me.value.displayName)
const bio = ref(me.value.bio)
const savingProfile = ref(false)
const face = useFace()
const clearPhotoOnSave = ref(false)
const profileDirty = computed(() => clearPhotoOnSave.value || displayName.value !== me.value.displayName || bio.value !== me.value.bio || JSON.stringify({ ...look.value, face: null }) !== JSON.stringify({ ...me.value.look, face: null }))
async function saveProfile(): Promise<void> {
  if (savingProfile.value || face.busy.value || !app.me) return
  const mine = asker(), sentLook = look.value, sentName = displayName.value.trim(), sentBio = bio.value.trim()
  savingProfile.value = true
  try {
    const result = await api('member.saveProfile', { displayName: sentName, bio: sentBio, look: sentLook, expectedRevision: me.value.revision, clearFace: clearPhotoOnSave.value })
    if (!mine()) return
    keepProfile(result.profile)
    clearPhotoOnSave.value = false
    // Anything changed on the page while the answer was on its way stays an unsaved change.
    look.value = look.value === sentLook ? copy(me.value.look) : { ...look.value, face: me.value.look.face }
    if (displayName.value.trim() === sentName) displayName.value = me.value.displayName
    if (bio.value.trim() === sentBio) bio.value = me.value.bio
    toast('Character saved.', 'good')
    try { await face.load(); await refreshLocalAvatar() } catch (error) { if (mine()) toast(messageOf(error), 'bad') }
  } catch (error) {
    if (!mine()) return
    toast(messageOf(error), 'bad')
    if (error instanceof WorldError && (error.code === 'conflict' || error.code === 'unavailable')) await reread(mine)
  } finally { savingProfile.value = false }
}
function discardProfile(): void { look.value = copy(me.value.look); displayName.value = me.value.displayName; bio.value = me.value.bio; clearPhotoOnSave.value = false }
async function setFace(result: FaceCaptureResult, audience: FaceAudience, matchSkin: boolean): Promise<void> {
  if (result.mode === 'match') {
    clearPhotoOnSave.value = true
    look.value = { ...look.value, body: result.body, skin: matchSkin ? result.skin : look.value.skin, appearance: result.appearance, face: null }
    await saveProfile()
    return
  }
  if (savingProfile.value) { toast('Your character is still saving. Add the photo again in a moment.', 'info'); return }
  // The body, skin, shape, hair, clothes and height on screen are one decision with the picture, so the service keeps them in one step or keeps none.
  // The name and the line about you are not part of it: they stay as unsaved changes.
  const chosen: AvatarLook = { ...look.value, body: result.body, appearance: result.appearance, ...(matchSkin ? { skin: result.skin } : {}) }
  look.value = chosen
  const sent = look.value, mine = asker()
  if (!await face.save(result, audience, chosen)) { void reread(mine); return }
  if (!app.me || !mine()) return
  clearPhotoOnSave.value = false
  // Anything changed on the editor while the answer was on its way stays as an unsaved change.
  look.value = look.value === sent ? copy(app.me.look) : { ...look.value, face: app.me.look.face }
}
async function clearFace(): Promise<void> { if (await face.clear()) { clearPhotoOnSave.value = false; look.value = { ...look.value, face: null } } }
async function setFaceAudience(audience: FaceAudience): Promise<void> { if (await face.setAudience(audience)) look.value = { ...look.value, face: app.me?.look.face ?? null } }

// ── Area ──
const areaBusy = ref(false)
const areaFresh = computed(() => Boolean(me.value.currentArea && Date.parse(me.value.currentArea.expiresAt) > Date.now()))
async function setArea(area: CoarseArea, source: AreaSource): Promise<void> {
  areaBusy.value = true
  const result = await ask('member.setCurrentArea', { area, source }, `Your current area is ${area.label}.`)
  areaBusy.value = false
  if (result) keepProfile(result.profile)
}
async function reconfirm(): Promise<void> { const area = me.value.currentArea; if (area) await setArea(area, area.source) }
async function clearArea(): Promise<void> {
  const result = await ask('member.clearCurrentArea', {}, 'Your current area was removed. You are no longer shown as nearby to anyone.')
  if (result) keepProfile(result.profile)
}

const POWER_MODES: { value: MemberPreferences['powerMode']; label: string; icon: string; about: string; done: string }[] = [
  { value: 'battery', label: 'Battery saver', icon: '🔋', about: 'Fewer frames, softer picture, no shadows. Best for older phones and long sessions.', done: 'Battery saver is on.' },
  { value: 'balanced', label: 'Balanced', icon: '⚖️', about: 'Adapts to this device and eases off when nothing is moving.', done: 'Balanced mode is on.' },
  { value: 'quality', label: 'Best looking', icon: '✨', about: 'Sharpest picture and smoothest motion. Uses the most power.', done: 'Best looking mode is on.' },
]
// ── Privacy and display share one preferences record ──
let preferenceSaves: Promise<void> = Promise.resolve()
function savePreferences(patch: Partial<MemberPreferences>, done: string): Promise<void> {
  // The record is replaced whole, so each save starts from the preferences the service last answered: quick changes do not undo each other.
  const mine = asker()
  const next = preferenceSaves.then(async () => {
    if (!mine() || !app.me) return
    const result = await ask('member.savePreferences', { preferences: { ...me.value.preferences, ...patch } }, done)
    if (!result) return
    keepProfile(result.profile)
    if (patch.quality) getEngine()?.setQuality(patch.quality)
    if (patch.powerMode) getEngine()?.setPowerMode(patch.powerMode)
  })
  preferenceSaves = next.catch(() => {})
  return next
}
async function unblock(memberId: (typeof app.blocked)[number]['id'], name: string): Promise<void> {
  const result = await ask('member.unblock', { memberId }, `${name} is unblocked.`)
  if (result) app.blocked = result.blocked
}
async function unblockAll(): Promise<void> {
  if (!confirm(`Unblock all ${app.blocked.length} people?`)) return
  const mine = asker()
  for (const person of [...app.blocked]) {
    const result = await ask('member.unblock', { memberId: person.id })
    if (!result) return
    app.blocked = result.blocked
  }
  if (mine()) toast('Everyone is unblocked.', 'good')
}

// ── Reminders ──
const CATEGORY_LABEL: Record<NotifyCategory, string> = { replies: 'Replies and posts', challenges: 'Game challenges and turns', events: 'Meetups, trips and documents', work: 'Work and applications', social: 'Introductions and invites', market: 'Quotes and selling' }
const CHANNEL_LABEL: Record<Channel, string> = { 'in-app': 'In the App', email: 'Email', whatsapp: 'WhatsApp', push: 'Push' }
const CHANNEL_ICON: Record<Channel, string> = { 'in-app': '🔔', email: '✉️', whatsapp: '💬', push: '📲' }
const prefs = useLoad(() => api('notify.prefs', {}))
const deliveries = useLoad(() => api('notify.deliveries', {}), [() => app.changed.notifications])
const destination = ref<Record<ExternalChannel, string>>({ email: '', whatsapp: '', push: '' })
const adapterNote = (channel: ExternalChannel): string => prefs.data.value?.adapters.find(entry => entry.channel === channel)?.note ?? ''
function adopt(next: NotifyPrefs): void { if (prefs.data.value) prefs.data.value = { ...prefs.data.value, prefs: next } }
async function toggle(category: NotifyCategory, channel: Channel, enabled: boolean): Promise<void> {
  const result = await ask('notify.setCategory', { category, channel, enabled })
  if (result) adopt(result.prefs)
}
async function setAll(channel: Channel, enabled: boolean): Promise<void> {
  for (const category of NOTIFY_CATEGORIES) { const result = await ask('notify.setCategory', { category, channel, enabled }); if (!result) return; adopt(result.prefs) }
}
async function consent(channel: ExternalChannel, granted: boolean): Promise<void> {
  const result = await ask('notify.setConsent', { channel, granted, destination: granted ? destination.value[channel].trim() : '' }, granted ? `${CHANNEL_LABEL[channel]} reminders allowed.` : `${CHANNEL_LABEL[channel]} consent withdrawn and the destination forgotten.`)
  if (result) { adopt(result.prefs); destination.value[channel] = '' }
}
async function saveQuiet(patch: Partial<NotifyPrefs['quietHours']>): Promise<void> {
  if (!prefs.data.value) return
  const result = await ask('notify.setQuietHours', { quietHours: { ...prefs.data.value.prefs.quietHours, ...patch } })
  if (result) adopt(result.prefs)
}
async function saveDelay(minutes: number): Promise<void> { const result = await ask('notify.setReminderDelay', { minutes }); if (result) adopt(result.prefs) }
const STATE_TEXT: Record<string, { label: string; tone: string }> = {
  scheduled: { label: 'Waiting', tone: 'sky' }, 'held-quiet-hours': { label: 'Held for quiet hours', tone: 'grape' }, 'ready-not-sent': { label: 'Ready — not sent', tone: 'amber' },
  'suppressed-read': { label: 'Cancelled: read in the App', tone: 'leaf' }, 'suppressed-expired': { label: 'Cancelled', tone: '' }, 'suppressed-duplicate': { label: 'Folded into another', tone: '' },
  sent: { label: 'Sent', tone: 'leaf' }, failed: { label: 'Failed', tone: 'coral' },
}
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
/** The columns of the reminder table: the App, then each outside channel the member has allowed. */
const shownChannels = computed<Channel[]>(() => ['in-app', ...EXTERNAL_CHANNELS.filter(channel => prefs.data.value?.prefs.consent[channel].granted)])
const allowedCount = computed(() => shownChannels.value.length - 1)
/** Folded sections that load their own data are mounted only once opened. */
const opened = ref({ comeback: false, prepared: false, files: false })
const isOpen = (event: Event): boolean => (event.target as HTMLDetailsElement).open
watch(() => app.me?.look, value => { if (value && !profileDirty.value) look.value = copy(value) })
</script>

<template>
  <PanelPage title="Settings" wide>
    <div class="tabs sections" role="tablist" aria-label="Settings sections">
      <button v-for="[id, text] in TABS" :key="id" class="tab" type="button" role="tab" :aria-selected="tab === id" @click="go(id)">{{ text }}</button>
    </div>

    <!-- Character -->
    <template v-if="tab === 'character'">
      <div class="row wrap">
        <label class="field grow" style="min-width: 180px"><span>Name others see</span><input v-model="displayName" class="input" maxlength="32" /></label>
        <label class="field grow" style="min-width: 220px"><span>About you (optional)</span><input v-model="bio" class="input" maxlength="160" placeholder="A line others can read" /></label>
      </div>
      <AvatarEditor v-model:look="look" :face="face.scan.value" :face-busy="face.busy.value || savingProfile" :allow-photo-face="!app.guest" :country-code="(me.browsing ?? me.currentArea)?.countryCode" :place-label="(me.browsing ?? me.currentArea)?.label" @set-face="setFace" @set-face-audience="setFaceAudience" @clear-face="clearFace" />
      <div class="savebar" :class="{ dirty: profileDirty }">
        <span class="grow small">{{ profileDirty ? 'Unsaved changes to your character' : 'Your character is saved' }}</span>
        <button class="btn sm" type="button" :disabled="!profileDirty || savingProfile || face.busy.value" @click="discardProfile">Discard</button>
        <button class="btn primary sm" type="button" :disabled="!profileDirty || savingProfile || face.busy.value || displayName.trim().length < 2" @click="saveProfile">{{ savingProfile ? 'Saving…' : 'Save character' }}</button>
      </div>
    </template>

    <!-- Area -->
    <template v-else-if="tab === 'area'">
      <div v-if="me.currentArea" class="card" :class="areaFresh ? 'tint-leaf' : 'tint-coral'">
        <div class="row">
          <span class="icon-chip" :class="areaFresh ? 'leaf' : 'coral'" aria-hidden="true">📍</span>
          <div class="grow">
            <strong>{{ me.currentArea.label }}</strong>
            <div class="muted small">{{ me.currentArea.source === 'device-suggested' ? 'Suggested by your device, rounded to a wide area' : 'You told us' }} · confirmed {{ relativeTime(me.currentArea.confirmedAt) }}</div>
            <div class="small">{{ areaFresh ? `Stays fresh until ${dateTime(me.currentArea.expiresAt)}.` : 'This needs confirming again. Until then you are not shown as nearby to anyone.' }}</div>
          </div>
        </div>
        <div class="row wrap" style="margin-top: 10px">
          <button class="btn sm" :class="{ primary: !areaFresh }" type="button" :disabled="areaBusy" @click="reconfirm">I am still here</button>
          <button class="btn sm danger" type="button" :disabled="areaBusy" @click="clearArea">Remove my area</button>
        </div>
      </div>
      <p v-else class="notice amber">You have not said where you are. People nearby cannot find you, and you cannot find them.</p>
      <div class="notice sky">
        <span aria-hidden="true">ℹ️</span>
        <div>This is the area you are physically in, used only to find people near you. It does not move your character: to take your character to another city, use <RouterLink to="/travel">Travel</RouterLink>.</div>
      </div>
      <h3>Change your area</h3>
      <AreaPicker :language="me.preferences.language" :busy="areaBusy" @choose="setArea" />
    </template>

    <!-- Privacy -->
    <template v-else-if="tab === 'privacy'">
      <label v-if="!app.guest" class="card row">
        <span class="grow"><strong>Let people in my area find me</strong><span class="muted small" style="display: block">They see your name, character and area name. Never a map position or a distance. Needs a confirmed area.</span></span>
        <button class="switch" type="button" role="switch" :aria-checked="me.preferences.discoverable" aria-label="Let people in my area find me" @click="savePreferences({ discoverable: !me.preferences.discoverable }, me.preferences.discoverable ? 'You are hidden from nearby lists.' : 'People in your area can find you.')"></button>
      </label>
      <p v-else class="notice">Guest characters stay out of nearby lists. Save your character to an account to change who can find you.</p>
      <ArenaPrivacy v-if="!app.guest" />
      <div class="card stack tight">
        <strong>Your face from a photo</strong>
        <template v-if="me.look.face">
          <span class="muted small">{{ me.look.face.audience === 'friends' ? 'Only friends see it. Everyone else sees the character’s own face.' : 'Other players in Allworld can see it.' }}</span>
          <div class="row wrap">
            <button class="btn sm" type="button" :disabled="face.busy.value" @click="setFaceAudience(me.look.face.audience === 'friends' ? 'everyone' : 'friends')">{{ me.look.face.audience === 'friends' ? 'Show it to everyone in Allworld' : 'Show it to friends only' }}</button>
            <button class="btn sm danger" type="button" :disabled="face.busy.value" @click="clearFace">Remove and delete it</button>
          </div>
        </template>
        <span v-else class="muted small">You have not added one. <button class="linklike" type="button" @click="go('character')">Add it under Character</button>.</span>
      </div>
      <div class="stack tight">
        <div class="row between"><h3>Blocked people</h3><button v-if="app.blocked.length > 1" class="btn sm" type="button" @click="unblockAll">Unblock all</button></div>
        <p v-if="!app.blocked.length" class="muted small">Nobody is blocked. Blocking hides you and the other person from each other everywhere: streets, chat, voice, homes and games.</p>
        <ul v-else class="plain">
          <li v-for="person in app.blocked" :key="person.id" class="list-row">
            <MemberBadge :member-id="person.id" :look="person.look" :size="36" /><span class="grow truncate">{{ person.displayName }}</span>
            <button class="btn sm" type="button" @click="unblock(person.id, person.displayName)">Unblock</button>
          </li>
        </ul>
      </div>
    </template>

    <!-- Reminders -->
    <template v-else-if="tab === 'notifications'">
      <StateView v-if="prefs.state.value !== 'ready' || !prefs.data.value" :state="prefs.state.value === 'ready' ? 'loading' : prefs.state.value" :message="prefs.error.value" @retry="prefs.reload" />
      <template v-else>
        <p class="notice amber"><span aria-hidden="true">✋</span><span>Email, WhatsApp and push are prepared and previewed here but <strong>nothing is sent yet</strong>: sending is switched off until a real sender and destination test are authorised. The inbox inside the App works now.</span></p>

        <div class="card stack">
          <div>
            <h3>What to tell me about</h3>
            <p v-if="!allowedCount" class="muted small">These reach your inbox in the App. A channel you allow below gets its own column here.</p>
          </div>
          <!-- Only channels that can be switched are shown: the App, and each outside channel allowed below. -->
          <div class="matrix" role="table" aria-label="Reminders by kind and channel" :style="{ '--channels': shownChannels.length }">
            <div class="mrow head" role="row">
              <span role="columnheader">Kind</span>
              <span v-for="channel in shownChannels" :key="channel" role="columnheader" class="channel" :title="CHANNEL_LABEL[channel]">
                <span aria-hidden="true">{{ CHANNEL_ICON[channel] }}</span><span class="channel-name">{{ CHANNEL_LABEL[channel] }}</span>
              </span>
            </div>
            <div v-for="category in NOTIFY_CATEGORIES" :key="category" class="mrow" role="row">
              <span role="rowheader">{{ CATEGORY_LABEL[category] }}</span>
              <span v-for="channel in shownChannels" :key="channel" role="cell">
                <button
                  class="switch" type="button" role="switch" :aria-checked="prefs.data.value.prefs.categories[category][channel]"
                  :aria-label="`${CATEGORY_LABEL[category]} by ${CHANNEL_LABEL[channel]}`"
                  :disabled="channel !== 'in-app' && !prefs.data.value.prefs.consent[channel].granted"
                  :title="channel !== 'in-app' && !prefs.data.value.prefs.consent[channel].granted ? `Give consent for ${CHANNEL_LABEL[channel]} below first` : ''"
                  @click="toggle(category, channel, !prefs.data.value.prefs.categories[category][channel])"
                ></button>
              </span>
            </div>
            <div class="mrow foot" role="row">
              <span class="muted tiny" role="rowheader">All kinds</span>
              <span v-for="channel in shownChannels" :key="channel" role="cell" class="bulk">
                <button class="btn ghost sm" type="button" :disabled="channel !== 'in-app' && !prefs.data.value.prefs.consent[channel].granted" @click="setAll(channel, true)">On</button>
                <button class="btn ghost sm" type="button" @click="setAll(channel, false)">Off</button>
              </span>
            </div>
          </div>
        </div>

        <details class="card fold">
          <summary><span class="grow"><strong>Where reminders may go</strong><span class="muted small sub">Email, WhatsApp and push · {{ allowedCount ? `${allowedCount} allowed` : 'none allowed' }}</span></span></summary>
          <div class="stack fold-body">
          <div v-for="channel in EXTERNAL_CHANNELS" :key="channel" class="consent">
            <div class="grow">
              <strong>{{ CHANNEL_LABEL[channel] }}</strong>
              <span v-if="prefs.data.value.prefs.consent[channel].granted" class="chip leaf">Allowed · {{ prefs.data.value.prefs.consent[channel].destination }}</span>
              <span v-else class="chip">Not allowed</span>
              <div class="muted tiny">{{ adapterNote(channel) }}</div>
            </div>
            <form v-if="!prefs.data.value.prefs.consent[channel].granted" class="row" @submit.prevent="consent(channel, true)">
              <input v-if="channel !== 'push'" v-model="destination[channel]" class="input" :type="channel === 'email' ? 'email' : 'tel'" :placeholder="channel === 'email' ? 'you@example.com' : '+2348012345678'" :aria-label="`${CHANNEL_LABEL[channel]} destination`" required />
              <button class="btn sm" type="submit">I consent</button>
            </form>
            <button v-else class="btn sm danger" type="button" @click="consent(channel, false)">Withdraw</button>
          </div>
          </div>
        </details>

        <details class="card fold">
          <summary><span class="grow"><strong>Quiet hours</strong><span class="muted small sub">{{ prefs.data.value.prefs.quietHours.enabled ? `${prefs.data.value.prefs.quietHours.start} to ${prefs.data.value.prefs.quietHours.end}` : 'Off' }}</span></span></summary>
          <div class="stack fold-body">
          <label class="row between"><span class="small">Hold reminders overnight</span>
            <button class="switch" type="button" role="switch" :aria-checked="prefs.data.value.prefs.quietHours.enabled" aria-label="Quiet hours" @click="saveQuiet({ enabled: !prefs.data.value.prefs.quietHours.enabled })"></button>
          </label>
          <div class="row wrap">
            <label class="field"><span>From</span><input class="input" type="time" :value="prefs.data.value.prefs.quietHours.start" @change="saveQuiet({ start: ($event.target as HTMLInputElement).value })" /></label>
            <label class="field"><span>Until</span><input class="input" type="time" :value="prefs.data.value.prefs.quietHours.end" @change="saveQuiet({ end: ($event.target as HTMLInputElement).value })" /></label>
            <div class="field" style="flex: 1 1 100%; min-width: 0"><span>Timezone</span>
              <div class="row wrap"><span class="input grow" style="display: flex; align-items: center; min-width: 0">{{ prefs.data.value.prefs.quietHours.timezone }}</span>
                <button v-if="prefs.data.value.prefs.quietHours.timezone !== zone" class="btn sm" type="button" @click="saveQuiet({ timezone: zone })">Use {{ zone }}</button></div>
            </div>
          </div>
          <label class="field" style="max-width: 260px"><span>Wait before reminding me outside the App</span>
            <select class="select" :value="prefs.data.value.prefs.reminderDelayMinutes" @change="saveDelay(Number(($event.target as HTMLSelectElement).value))">
              <option v-for="minutes in [1, 5, 10, 30, 60, 180]" :key="minutes" :value="minutes">{{ minutes < 60 ? `${minutes} minutes` : `${minutes / 60} hour${minutes > 60 ? 's' : ''}` }}</option>
            </select>
            <small>If you read it in the App first, the reminder is cancelled.</small>
          </label>
          </div>
        </details>

        <!-- Nudges for members who have been away, from the come-back track. Loaded when opened. -->
        <details class="fold open-fold" @toggle="opened.comeback = isOpen($event)">
          <summary><span class="grow"><strong>Come-back messages</strong><span class="muted small sub">One short message after you have been away: what, where and how often</span></span></summary>
          <div v-if="opened.comeback" class="fold-body"><ComebackPanel /></div>
        </details>

        <details class="card fold" @toggle="opened.prepared = isOpen($event)">
          <summary><span class="grow"><strong>Prepared reminders</strong><span class="muted small sub">What would be sent, and why it was held or left unsent{{ deliveries.data.value?.deliveries.length ? ` · ${deliveries.data.value.deliveries.length}` : '' }}</span></span></summary>
          <div v-if="opened.prepared" class="stack tight fold-body">
            <div class="row between"><span class="muted small" role="status">{{ deliveries.data.value?.deliveries.length ? '' : 'None yet. When something happens and a channel above is allowed, it appears here.' }}</span><button class="btn ghost sm" type="button" @click="deliveries.reload">Refresh</button></div>
            <ul v-if="deliveries.data.value?.deliveries.length" class="plain deliveries">
              <li v-for="item in deliveries.data.value.deliveries" :key="item.id" class="delivery">
                <div class="row wrap" style="gap: 6px"><span class="chip ink">{{ CHANNEL_LABEL[item.channel] }}</span><span class="chip" :class="STATE_TEXT[item.state]?.tone">{{ STATE_TEXT[item.state]?.label ?? item.state }}</span><span class="muted tiny">to {{ item.preview.to }} · {{ relativeTime(item.updatedAt) }}</span></div>
                <strong class="small">{{ item.preview.subject }}</strong>
                <pre class="preview">{{ item.preview.text }}</pre>
                <span class="muted tiny">{{ item.reason }}</span>
              </li>
            </ul>
          </div>
        </details>
      </template>
    </template>

    <!-- Display -->
    <template v-else>
      <fieldset class="power">
        <legend class="label">Battery and smoothness</legend>
        <div class="tabs wrap" role="radiogroup" aria-label="Battery and smoothness">
          <button v-for="mode in POWER_MODES" :key="mode.value" class="tab" type="button" role="radio" :aria-checked="(me.preferences.powerMode ?? 'balanced') === mode.value" :aria-selected="(me.preferences.powerMode ?? 'balanced') === mode.value" @click="savePreferences({ powerMode: mode.value }, mode.done)">
            <span aria-hidden="true">{{ mode.icon }}</span>{{ mode.label }}
          </button>
        </div>
        <small class="muted">{{ POWER_MODES.find(mode => mode.value === (me.preferences.powerMode ?? 'balanced'))?.about }}</small>
      </fieldset>
      <section class="card stack tight sound" style="max-width: 460px" aria-labelledby="sound-title">
        <h3 id="sound-title" class="label">Sound</h3>
        <p class="muted small">Saved on this device. Every sound is made in the App; there are no recordings or music files.</p>
        <div v-for="row in CHANNEL_INFO" :key="row.channel" class="stack tight sound-row">
          <label class="row"><span class="grow"><strong>{{ row.label }}</strong><span class="muted small" style="display: block">{{ channelNote(row.channel) }}</span></span>
            <button v-if="row.available" class="switch" type="button" role="switch" :aria-checked="!channels[row.channel].muted" :aria-label="row.label" @click="setChannelMuted(row.channel, !channels[row.channel].muted)"></button></label>
          <template v-if="row.available">
            <label class="field"><span>{{ row.label }} volume</span>
              <input type="range" min="0" max="1" step="0.05" :value="channels[row.channel].volume" :disabled="channels[row.channel].muted || (row.channel === 'voice' && !voiceVolumeAdjustable)" :aria-label="`${row.label} volume`" @input="setChannelVolume(row.channel, Number(($event.target as HTMLInputElement).value))" />
              <small v-if="row.channel === 'voice' && !voiceVolumeAdjustable">This browser plays voices at a fixed volume. You can still turn them off.</small>
            </label>
            <button v-if="(row.channel === 'effects' || row.channel === 'ui') && !channels[row.channel].muted" class="btn sm ghost" type="button" @click="playTestCue(row.channel)">Play a test sound</button>
          </template>
        </div>
      </section>
      <label class="card row" style="max-width: 460px"><span class="grow"><strong>Reduce motion</strong><span class="muted small" style="display: block">Fewer animated transitions in windows and games.</span></span>
        <button class="switch" type="button" role="switch" :aria-checked="me.preferences.reducedMotion" aria-label="Reduce motion" @click="savePreferences({ reducedMotion: !me.preferences.reducedMotion }, 'Motion preference saved.')"></button></label>

      <!-- The battery choice above already sets these sensibly; they are here for members who want to override it. -->
      <details class="card fold" style="max-width: 460px">
        <summary><span class="grow"><strong>More display options</strong><span class="muted small sub">Graphics quality, daylight, units and language</span></span></summary>
        <div class="stack fold-body">
          <label class="field"><span>Graphics quality</span>
            <select class="select" :value="me.preferences.quality" @change="savePreferences({ quality: ($event.target as HTMLSelectElement).value as MemberPreferences['quality'] }, 'Graphics quality changed.')">
              <option value="auto">Automatic — adapts to this device</option><option value="low">Low — smoothest on phones</option><option value="medium">Medium</option><option value="high">High</option>
            </select>
            <small v-if="world.status">Now: {{ world.status.fps }} frames a second at {{ world.status.quality }} quality{{ world.status.degraded ? ', lowered automatically to stay smooth' : '' }}.</small>
          </label>
          <label class="row"><span class="grow"><strong>Always daytime</strong><span class="muted small" style="display: block">Otherwise light follows the local time of the place shown.</span></span>
            <button class="switch" type="button" role="switch" :aria-checked="world.timeMode === 'day'" aria-label="Always daytime" @click="setTimeMode(world.timeMode === 'day' ? 'local' : 'day')"></button></label>
          <label class="field"><span>Units</span>
            <select class="select" :value="me.preferences.units" @change="savePreferences({ units: ($event.target as HTMLSelectElement).value as MemberPreferences['units'] }, 'Units changed.')"><option value="metric">Metric (m, cm)</option><option value="imperial">Imperial (ft, in)</option></select></label>
          <label class="field"><span>Language for dates and numbers</span>
            <select class="select" :value="me.preferences.language" @change="savePreferences({ language: ($event.target as HTMLSelectElement).value }, 'Language changed.')">
              <option v-for="code in [...new Set([me.preferences.language, 'en', 'en-GB', 'en-NG', 'fr', 'es', 'pt', 'sw', 'ha', 'yo', 'ig', 'ar', 'hi'])]" :key="code" :value="code">{{ code }}</option>
            </select><small>The App’s own text is in English for now.</small></label>
        </div>
      </details>

      <!-- What this device keeps so later visits start faster. Read from the device when opened. -->
      <details class="card fold" style="max-width: 460px" @toggle="opened.files = isOpen($event)">
        <summary><span class="grow"><strong>Downloaded game files</strong><span class="muted small sub">Choose packs to download, check versions and free space</span></span></summary>
        <div v-if="opened.files" class="fold-body"><RouterLink class="btn sm" to="/downloads">Open downloads &amp; storage</RouterLink></div>
      </details>
      <CountsHistoryPanel />
      <details class="card fold" style="max-width: 460px">
        <summary><strong>About this build</strong></summary>
        <div class="fold-body"><BuildInfo /></div>
      </details>
    </template>
  </PanelPage>
</template>

<style scoped>
/* Five sections fit a 360 px phone without scrolling the strip. */
@media (max-width: 420px) { .sections { gap: 2px; padding: 3px; } .sections .tab { padding: 0 5px; font-size: 0.82rem; letter-spacing: -0.01em; } }
.sound-row + .sound-row { border-top: 1px solid var(--line); padding-top: 10px; }
.sound input[type="range"] { width: 100%; min-height: 32px; }
.power { border: 0; padding: 0; margin: 0; display: grid; gap: 6px; max-width: 460px; }
.savebar { position: sticky; bottom: -22px; margin: auto -18px -22px; padding: 10px 18px calc(12px + var(--safe-bottom)); display: flex; align-items: center; gap: 8px; background: var(--surface); border-top: 1px solid var(--line); z-index: 2; }
.savebar.dirty { background: var(--accent-soft); border-top-color: #f4dfae; }
.plain { list-style: none; margin: 0; padding: 0; }
.plain .list-row + .list-row { border-top: 1px solid var(--line); }
.linklike { border: 0; background: none; padding: 0; color: var(--accent-text); text-decoration: underline; }
.matrix { display: grid; gap: 2px; container-type: inline-size; }
.mrow { display: grid; grid-template-columns: minmax(0, 1.6fr) repeat(var(--channels, 4), minmax(48px, 88px)); align-items: center; gap: 6px; padding: 6px 0; min-height: 44px; }
.channel { flex-direction: column; align-items: center; gap: 1px; text-align: center; line-height: 1.15; }
@container (max-width: 430px) {
  .mrow { grid-template-columns: minmax(0, 1fr) repeat(var(--channels, 4), 48px); gap: 4px; font-size: 0.86rem; }
  .channel-name { font-size: 0.62rem; }
  .bulk .btn { padding: 0 3px; font-size: 0.74rem; min-height: 32px; }
}
.mrow + .mrow { border-top: 1px solid var(--line); }
.mrow.head { font-size: 0.78rem; font-weight: 700; color: var(--ink-2); }
.mrow > span:not(:first-child) { display: flex; justify-content: center; }
.bulk { gap: 0; flex-direction: column; }
.bulk .btn { padding: 0 6px; min-height: 28px; }
.consent { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; padding: 8px 0; }
.consent + .consent { border-top: 1px solid var(--line); }
.consent form { flex: 1; min-width: 220px; }
.deliveries { display: grid; gap: 0; }
.delivery { display: grid; gap: 4px; padding: 10px 0; }
.delivery + .delivery { border-top: 1px solid var(--line); }
/* A section that opens in place: its name and where it stands now, then its controls. */
.fold > summary { display: flex; align-items: center; gap: 10px; min-height: 44px; cursor: pointer; list-style: none; }
.fold > summary::-webkit-details-marker { display: none; }
.fold > summary::after { content: "▾"; color: var(--muted); flex: none; }
.fold[open] > summary::after { transform: rotate(180deg); }
.fold .sub { display: block; }
/* The come-back panel brings its own cards, so its section is not one. */
.open-fold { padding: 0 14px; }
.open-fold[open] { padding: 0; }
.open-fold[open] > summary { padding: 0 14px; }
.fold-body { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
.preview { margin: 0; padding: 8px 10px; border-radius: 10px; background: var(--surface-2); font: inherit; font-size: 0.82rem; white-space: pre-wrap; word-break: break-word; }
</style>
