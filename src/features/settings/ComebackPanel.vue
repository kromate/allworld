<script setup lang="ts">
// Come-back messages: what a member gets after being away, where, how often — with the exact
// message they would receive now and the reason behind everything that was or was not prepared.
import { computed, onBeforeUnmount, ref } from 'vue'
import { brand } from '../../brand.ts'
import {
  CHANNEL_WORD, COMEBACK_RULES, GROUP_COPY, NUDGE_GROUPS, TYPE_LABEL, WHATSAPP_TEMPLATES, startPresenceBeat,
} from '../../shared/comeback.ts'
import type { ComebackPrefs, Decision, MessageType, Nudge, NudgeGroup, NudgeId } from '../../shared/comeback.ts'
import type { ExternalChannel } from '../../shared/notify.ts'
import { api, app, attempt, onServerEvent, toast } from '../../state/app.ts'
import BrandMark from '../../ui/BrandMark.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { dateTime, relativeTime } from '../../ui/format.ts'

const status = useLoad(async () => (await api('comeback.status', {})).status)
const preview = useLoad(async () => (await api('comeback.preview', { origin: window.location.origin })).preview, [() => app.changed.notifications])
const saving = ref(false)
const rules = COMEBACK_RULES

const CHANNEL: Record<ExternalChannel, { label: string; icon: string }> = {
  email: { label: 'Email', icon: '✉️' }, whatsapp: { label: 'WhatsApp', icon: '💬' }, push: { label: 'Push', icon: '📲' },
}
const prefs = computed(() => status.data.value?.prefs ?? null)
const switchedOn = computed(() => status.data.value?.channels.filter(entry => entry.enabled) ?? [])
const allGroupsOn = computed(() => Boolean(prefs.value && NUDGE_GROUPS.every(group => prefs.value!.groups[group])))

async function save(patch: Partial<ComebackPrefs>, done?: string): Promise<boolean> {
  const current = prefs.value
  if (!current || saving.value) return false
  saving.value = true
  const result = await attempt('comeback.setPrefs', { prefs: { ...current, ...patch } }, done)
  saving.value = false
  if (!result) return false
  status.data.value = result.status
  void preview.reload()
  return true
}
async function setEnabled(enabled: boolean): Promise<void> {
  if (!(await save({ enabled }))) return
  if (enabled) toast('Come-back messages are on.', 'good')
  else toast('Come-back messages are off. Everything still reaches your inbox in the App.', 'info', { label: 'Undo', run: () => { void setEnabled(true) } })
}
const setGroup = (group: NudgeGroup, on: boolean): Promise<boolean> => save({ groups: { ...prefs.value!.groups, [group]: on } })
function setAllGroups(on: boolean): Promise<boolean> {
  const groups = { ...prefs.value!.groups }
  for (const group of NUDGE_GROUPS) groups[group] = on
  return save({ groups }, on ? 'Every kind is on.' : 'Every kind is off. Nothing will be sent outside the App.')
}
const setChannel = (channel: ExternalChannel, on: boolean): Promise<boolean> =>
  save({ channels: { ...prefs.value!.channels, [channel]: on } }, on ? `Come-back messages by ${CHANNEL_WORD[channel]} are on.` : `Come-back messages by ${CHANNEL_WORD[channel]} are off.`)
const setPrefer = (value: string): Promise<boolean> => save({ prefer: value ? value as ExternalChannel : null })
function setCap(key: 'perDay' | 'perWeek', value: number): Promise<boolean> {
  const caps = { ...prefs.value!.caps, [key]: value }
  // The week can never allow fewer than one day does.
  if (caps.perWeek < caps.perDay) caps.perWeek = caps.perDay
  return save({ caps })
}
const range = (limits: { min: number; max: number }): number[] => Array.from({ length: limits.max - limits.min + 1 }, (_unused, index) => limits.min + index)

// The consent card above this panel belongs to another component: refresh when the member comes back to this one.
let refreshedAt = 0
function refresh(): void {
  if (Date.now() - refreshedAt < 4000) return
  refreshedAt = Date.now()
  void status.reload()
}
const stopListening = onServerEvent(event => { if (event.type === 'comeback.changed') void status.reload() })
onBeforeUnmount(stopListening)

// While this panel is open the tab is on screen: tell the service, so reading here is not mistaken for being away.
// (The shell should run the same beat for the whole App; it is harmless twice.)
onBeforeUnmount(startPresenceBeat(visible => { void api('comeback.here', { visible, origin: window.location.origin }).catch(() => undefined) }))

// ── Preview ──
const shown = ref<ExternalChannel>('email')
const emailAs = ref<'designed' | 'plain'>('designed')
/** Links inside the preview must not navigate anywhere: the frame is sandboxed and opens nothing. */
const PLACE: [RegExp, string][] = [[/^\/messages/, 'the conversation'], [/^\/inbox/, 'your inbox'], [/^\/people\/meetups/, 'the meetup'], [/^\/people/, 'your requests'], [/^\/work/, 'your work page'], [/^\/travel/, 'your travel page'], [/^\/games/, 'the match']]
const pushOpens = computed(() => {
  const link = preview.data.value?.rendered.push.link ?? ''
  const path = link.replace(/^https?:\/\/[^/]+/, '')
  return PLACE.find(([pattern]) => pattern.test(path))?.[1] ?? 'the game'
})
const emailDocument = computed(() => preview.data.value?.rendered.email.html.replace('<head>', '<head><base target="_blank">') ?? '')
function onTabKey(event: KeyboardEvent): void {
  const order: ExternalChannel[] = ['email', 'whatsapp', 'push']
  const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
  if (!step) return
  event.preventDefault()
  shown.value = order[(order.indexOf(shown.value) + step + order.length) % order.length]!
  ;(event.currentTarget as HTMLElement).querySelector<HTMLElement>(`[data-tab="${shown.value}"]`)?.focus()
}

// ── History ──
const NUDGE_STATE: Record<Nudge['state'], { label: string; tone: string }> = {
  'held-quiet-hours': { label: 'Waiting for quiet hours to end', tone: 'grape' }, 'ready-not-sent': { label: 'Ready — not sent', tone: 'amber' },
  sending: { label: 'Sending', tone: 'sky' }, sent: { label: 'Sent', tone: 'leaf' }, failed: { label: 'Failed', tone: 'coral' }, cancelled: { label: 'Dropped', tone: '' },
}
const OUTCOME: Record<Decision['outcome'], { label: string; tone: string; icon: string }> = {
  prepared: { label: 'Prepared', tone: 'amber', icon: '✉️' }, held: { label: 'Held', tone: 'grape', icon: '🌙' }, waiting: { label: 'Waiting', tone: 'sky', icon: '⏳' },
  skipped: { label: 'Nothing sent', tone: '', icon: '➖' }, cancelled: { label: 'Dropped', tone: '', icon: '✖️' }, stopped: { label: 'Stopped', tone: 'coral', icon: '✋' },
  returned: { label: 'You came back', tone: 'leaf', icon: '👋' },
}
const showAll = ref(false)
const open = ref<NudgeId | null>(null)
const history = computed(() => {
  const data = status.data.value
  if (!data) return []
  const byId = new Map(data.nudges.map(nudge => [nudge.id, nudge]))
  // A message appears once, under the latest decision about it.
  const seen = new Set<NudgeId>()
  return data.decisions.map(decision => {
    const nudge = decision.nudgeId && !seen.has(decision.nudgeId) ? byId.get(decision.nudgeId) ?? null : null
    if (nudge) seen.add(nudge.id)
    return { decision, nudge }
  })
})
const visibleHistory = computed(() => (showAll.value ? history.value : history.value.slice(0, 5)))
const textOf = (nudge: Nudge): { subject: string; body: string } | null => {
  if (!nudge.preview) return null
  if (nudge.channel === 'email') return { subject: nudge.preview.email.subject, body: nudge.preview.email.text }
  if (nudge.channel === 'whatsapp') return { subject: `WhatsApp template ${nudge.preview.whatsapp.template}`, body: nudge.preview.whatsapp.preview }
  return { subject: nudge.preview.push.title, body: nudge.preview.push.body }
}

// ── Every message we can send, as the templates declare them ──
const catalogue = (Object.keys(WHATSAPP_TEMPLATES) as MessageType[]).map(type => {
  const template = WHATSAPP_TEMPLATES[type]
  return { type, label: TYPE_LABEL[type], text: template.body.replace(/\{\{(\d+)\}\}/g, (_match, index: string) => `[${template.variables[Number(index) - 1]!.toLowerCase()}]`) }
})
</script>

<template>
  <section class="comeback stack" aria-labelledby="comeback-title" @pointerenter="refresh" @focusin="refresh">
    <div class="row between">
      <h3 id="comeback-title">When you have been away</h3>
      <span v-if="status.data.value" class="muted tiny num">{{ status.data.value.usage.last7d }} of {{ status.data.value.prefs.caps.perWeek }} this week</span>
    </div>

    <StateView v-if="status.state.value !== 'ready' || !status.data.value || !prefs" :state="status.state.value === 'ready' ? 'loading' : status.state.value" :message="status.error.value" @retry="status.reload" />
    <template v-else>
      <div class="card tint-amber stack">
        <div class="row lead">
          <span class="icon-chip" aria-hidden="true">🌤</span>
          <div class="grow">
            <strong>One short message when something is waiting</strong>
            <div class="small">After a few hours away, we put what is waiting for you into a single message: who wrote, what closes soon, how your character is doing, what you earned.</div>
          </div>
          <button class="switch" type="button" role="switch" :aria-checked="prefs.enabled" aria-label="Come-back messages" :disabled="saving" @click="setEnabled(!prefs.enabled)"></button>
        </div>
        <ul class="promises small">
          <li>At most {{ prefs.caps.perDay }} a day and {{ prefs.caps.perWeek }} a week, never at night.</li>
          <li>Never the same thing twice, and never about someone you blocked.</li>
          <li>If a message brings no visit we wait {{ rules.backoffDays.join(', then ') }} days, then stop.</li>
          <li>The moment you come back, anything waiting to be sent is dropped.</li>
          <li>Back after {{ rules.welcomeMeal.afterHours }} hours or more with a hungry character? The first meal is on us: {{ rules.welcomeMeal.coins }} game coins, once a day.</li>
        </ul>
      </div>

      <!-- That nothing is sent yet is said once, at the top of the Alerts tab this panel sits in. -->
      <template v-if="prefs.enabled">
        <div class="card stack">
          <div>
            <h4>Where it may reach you</h4>
            <p class="muted small">Each one is your choice, separate from ordinary reminders.</p>
          </div>
          <ul class="plain">
            <li v-for="entry in status.data.value.channels" :key="entry.channel" class="channel">
              <span class="icon-chip" :class="entry.enabled ? 'leaf' : ''" aria-hidden="true">{{ CHANNEL[entry.channel].icon }}</span>
              <span class="grow">
                <strong>{{ CHANNEL[entry.channel].label }}</strong>
                <span v-if="entry.consented" class="muted small truncate block">{{ entry.destination }}</span>
                <span v-else class="muted small block">Allow it under “Where reminders may go” above first.</span>
                <span v-if="entry.enabled" class="chip" :class="entry.mode === 'live' ? 'leaf' : 'amber'" :title="entry.note">{{ entry.mode === 'live' ? 'Sending' : 'Prepared, not sent' }}</span>
              </span>
              <button
                class="switch" type="button" role="switch" :aria-checked="entry.enabled" :aria-label="`Come-back messages by ${CHANNEL[entry.channel].label}`"
                :disabled="saving || !entry.consented" :title="entry.consented ? '' : `Allow ${CHANNEL[entry.channel].label} above first`"
                @click="setChannel(entry.channel, !entry.enabled)"
              ></button>
            </li>
          </ul>
          <p v-if="!switchedOn.length" class="muted small">With none switched on, everything stays in your inbox in the App and you are greeted with it when you return.</p>
          <label v-if="switchedOn.length > 1" class="field">
            <span>Which one first</span>
            <select class="select" :value="prefs.prefer ?? ''" :disabled="saving" @change="setPrefer(($event.target as HTMLSelectElement).value)">
              <option value="">Choose for me — the lightest that fits the message</option>
              <option v-for="entry in switchedOn" :key="entry.channel" :value="entry.channel">Always {{ CHANNEL[entry.channel].label }}</option>
            </select>
            <small>You only ever get one message, on one channel.</small>
          </label>
        </div>

        <div class="card stack">
          <div class="row between wrap">
            <h4>What is worth a message</h4>
            <button class="btn ghost sm" type="button" :disabled="saving" @click="setAllGroups(!allGroupsOn)">{{ allGroupsOn ? 'All off' : 'All on' }}</button>
          </div>
          <ul class="plain groups">
            <li v-for="group in NUDGE_GROUPS" :key="group" class="group">
              <span class="icon-chip" :class="GROUP_COPY[group].tone === 'amber' ? '' : GROUP_COPY[group].tone" aria-hidden="true">{{ GROUP_COPY[group].icon }}</span>
              <span class="grow">
                <strong>{{ GROUP_COPY[group].label }}</strong>
                <span class="muted small block">{{ GROUP_COPY[group].detail }}</span>
                <span class="muted tiny block">{{ group === 'checkin' ? 'Only when nothing else is waiting.' : `After ${rules.leadAfterHours[group]} hours away.` }}</span>
              </span>
              <button class="switch" type="button" role="switch" :aria-checked="prefs.groups[group]" :aria-label="GROUP_COPY[group].label" :disabled="saving" @click="setGroup(group, !prefs.groups[group])"></button>
            </li>
          </ul>
        </div>

        <div class="card stack">
          <h4>How often, at most</h4>
          <div class="row wrap caps">
            <label class="field grow"><span>In one day</span>
              <select class="select" :value="prefs.caps.perDay" :disabled="saving" @change="setCap('perDay', Number(($event.target as HTMLSelectElement).value))">
                <option v-for="value in range(rules.capLimits.perDay)" :key="value" :value="value">{{ value }} {{ value === 1 ? 'message' : 'messages' }}</option>
              </select>
            </label>
            <label class="field grow"><span>In one week</span>
              <select class="select" :value="prefs.caps.perWeek" :disabled="saving" @change="setCap('perWeek', Number(($event.target as HTMLSelectElement).value))">
                <option v-for="value in range(rules.capLimits.perWeek)" :key="value" :value="value" :disabled="value < prefs.caps.perDay">{{ value }} {{ value === 1 ? 'message' : 'messages' }}</option>
              </select>
            </label>
          </div>
          <p class="muted small">Counted across email, WhatsApp and push together. Quiet hours above apply here too. After {{ rules.maxPerAbsence }} messages with no visit we stop, and after {{ rules.lapsedAfterDays }} days away we stop whatever happens. Coming back starts things again.</p>
        </div>
      </template>

      <!-- What you would get if you were away now -->
      <div class="card stack">
        <div>
          <h4>What you would get if you were away now</h4>
          <p v-if="preview.data.value" class="muted small">{{ preview.data.value.explanation }}</p>
        </div>
        <StateView v-if="preview.state.value !== 'ready' || !preview.data.value" :state="preview.state.value === 'ready' ? 'loading' : preview.state.value" :message="preview.error.value" @retry="preview.reload" />
        <template v-else>
          <div class="tabs" role="tablist" aria-label="Preview by channel" @keydown="onTabKey">
            <button v-for="channel in (['email', 'whatsapp', 'push'] as ExternalChannel[])" :key="channel" class="tab" type="button" role="tab" :data-tab="channel" :aria-selected="shown === channel" :tabindex="shown === channel ? 0 : -1" @click="shown = channel">
              <span aria-hidden="true">{{ CHANNEL[channel].icon }}</span>{{ CHANNEL[channel].label }}
            </button>
          </div>

          <div v-if="shown === 'email'" class="stack tight" role="tabpanel" aria-label="Email preview">
            <dl class="envelope small">
              <div><dt>From</dt><dd>{{ preview.data.value.rendered.email.from }}</dd></div>
              <div><dt>To</dt><dd>{{ preview.data.value.rendered.email.to || 'No address allowed yet' }}</dd></div>
              <div><dt>Subject</dt><dd><strong>{{ preview.data.value.rendered.email.subject }}</strong></dd></div>
            </dl>
            <iframe v-if="emailAs === 'designed'" class="mail" title="The email as it would look" sandbox="" :srcdoc="emailDocument"></iframe>
            <pre v-else class="plaintext">{{ preview.data.value.rendered.email.text }}</pre>
            <div class="row between wrap">
              <span class="muted tiny">Carries a one-click unsubscribe header as well as the stop link. Both open a page that needs no sign-in.</span>
              <button class="btn ghost sm" type="button" :aria-pressed="emailAs === 'plain'" @click="emailAs = emailAs === 'plain' ? 'designed' : 'plain'">{{ emailAs === 'plain' ? 'Show designed version' : 'Show plain text' }}</button>
            </div>
          </div>

          <div v-else-if="shown === 'whatsapp'" class="stack tight" role="tabpanel" aria-label="WhatsApp preview">
            <div class="chat">
              <div class="bubble">
                <p>{{ preview.data.value.rendered.whatsapp.preview }}</p>
                <p class="muted tiny">{{ preview.data.value.rendered.whatsapp.footer }}</p>
                <span v-for="button in preview.data.value.rendered.whatsapp.buttons" :key="button.text" class="chat-button">{{ button.text }}</span>
              </div>
            </div>
            <div class="row wrap" style="gap: 6px">
              <span class="chip">{{ preview.data.value.rendered.whatsapp.to || 'No number allowed yet' }}</span>
              <span class="chip" :title="'The name of the approved message this would use'">{{ preview.data.value.rendered.whatsapp.template }}</span>
              <span class="chip" :class="preview.data.value.rendered.whatsapp.category === 'UTILITY' ? 'sky' : 'grape'">{{ preview.data.value.rendered.whatsapp.category === 'UTILITY' ? 'Account notice' : 'Come-back message' }}</span>
            </div>
            <span class="muted tiny">WhatsApp only delivers wording it approved beforehand. Only these details change from one message to the next: {{ preview.data.value.rendered.whatsapp.variables.join(' · ') }}.</span>
          </div>

          <div v-else class="stack tight" role="tabpanel" aria-label="Push preview">
            <div class="push">
              <BrandMark :size="34" />
              <div class="grow">
                <div class="row between"><span class="tiny muted">{{ brand.name }}</span><span class="tiny muted">now</span></div>
                <strong class="block">{{ preview.data.value.rendered.push.title }}</strong>
                <span class="small block">{{ preview.data.value.rendered.push.body }}</span>
              </div>
            </div>
            <span class="muted tiny">Tapping it opens {{ pushOpens }}. Push has no delivery service on this platform yet.</span>
          </div>
        </template>
      </div>

      <!-- What happened, and why -->
      <div class="stack tight">
        <div class="row between"><h4>Recent messages and the reason for each</h4><button class="btn ghost sm" type="button" @click="status.reload">Refresh</button></div>
        <p v-if="!history.length" class="muted small">Nothing yet. After you have been away, every message appears here with why it was prepared, held or left out.</p>
        <ol v-else class="plain history">
          <li v-for="({ decision, nudge }, index) in visibleHistory" :key="`${decision.at}-${index}`" class="card entry">
            <div class="row wrap" style="gap: 6px">
              <span class="chip" :class="OUTCOME[decision.outcome].tone"><span aria-hidden="true">{{ OUTCOME[decision.outcome].icon }}</span>{{ OUTCOME[decision.outcome].label }}</span>
              <span class="muted tiny" :title="dateTime(decision.at)">{{ relativeTime(decision.at) }} · {{ dateTime(decision.at) }}</span>
            </div>
            <span class="small">{{ decision.text }}</span>
            <div v-if="nudge" class="nudge stack tight">
              <div class="row wrap" style="gap: 6px">
                <span class="chip ink">{{ CHANNEL[nudge.channel].label }}</span>
                <span class="chip" :class="NUDGE_STATE[nudge.state].tone">{{ NUDGE_STATE[nudge.state].label }}</span>
                <span class="muted tiny">{{ TYPE_LABEL[nudge.type] }}</span>
                <span v-if="nudge.openedAt" class="chip leaf">Opened</span>
                <span v-if="nudge.returnedAt" class="chip leaf">You came back after it</span>
              </div>
              <ul v-if="nudge.items.length" class="lines small">
                <li v-for="item in nudge.items" :key="item.link + item.line"><RouterLink :to="item.link">{{ item.line }}</RouterLink></li>
                <li v-if="nudge.more" class="muted">and {{ nudge.more }} more</li>
              </ul>
              <span v-if="nudge.state !== 'ready-not-sent'" class="muted tiny">{{ nudge.reason }}</span>
              <template v-if="textOf(nudge)">
                <button class="btn ghost sm show" type="button" :aria-expanded="open === nudge.id" @click="open = open === nudge.id ? null : nudge.id">{{ open === nudge.id ? 'Hide the message' : 'Show the message' }}</button>
                <div v-if="open === nudge.id" class="stack tight">
                  <strong class="small">{{ textOf(nudge)!.subject }}</strong>
                  <pre class="plaintext">{{ textOf(nudge)!.body }}</pre>
                </div>
              </template>
            </div>
          </li>
        </ol>
        <button v-if="history.length > 5" class="btn ghost sm" type="button" @click="showAll = !showAll">{{ showAll ? 'Show fewer' : `Show ${history.length - 5} earlier` }}</button>
      </div>

      <details class="card catalogue">
        <summary><strong>Every message we can send, word for word</strong></summary>
        <ul class="plain stack tight" style="margin-top: 10px">
          <li v-for="entry in catalogue" :key="entry.type">
            <span class="label">{{ entry.label }}</span>
            <span class="small block">{{ entry.text }}</span>
          </li>
        </ul>
        <p class="muted tiny" style="margin-top: 10px">Email and push say the same things in the same words. Nothing else is ever sent as a come-back message.</p>
      </details>
    </template>
  </section>
</template>

<style scoped>
.comeback { container-type: inline-size; }
h4 { margin: 0; font-size: 0.92rem; }
.block { display: block; }
.plain { list-style: none; margin: 0; padding: 0; }
.lead { align-items: flex-start; }
.promises { margin: 0; padding-left: 18px; color: #6f4500; display: grid; gap: 2px; }
.channel, .group { display: flex; align-items: center; gap: 12px; padding: 10px 0; min-height: 56px; }
.channel + .channel, .group + .group { border-top: 1px solid var(--line); }
.channel .chip { margin-top: 4px; }
.caps .field { min-width: 140px; }
.envelope { margin: 0; display: grid; gap: 2px; }
.envelope > div { display: flex; gap: 8px; min-width: 0; }
.envelope dt { flex: none; width: 58px; color: var(--muted); }
.envelope dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.mail { width: 100%; height: 430px; border: 1px solid var(--line); border-radius: 12px; background: #f3ede3; }
.plaintext { margin: 0; padding: 10px 12px; border-radius: 10px; background: var(--surface-2); font: inherit; font-size: 0.82rem; white-space: pre-wrap; overflow-wrap: anywhere; max-height: 430px; overflow-y: auto; }
.chat { padding: 14px 12px; border-radius: 12px; background: var(--surface-3); }
.bubble { max-width: 340px; padding: 10px 12px 4px; border-radius: 4px 14px 14px 14px; background: #fff; box-shadow: 0 1px 1px rgba(40, 30, 10, 0.12); display: grid; gap: 6px; font-size: 0.92rem; }
.chat-button { display: block; margin: 0 -12px; padding: 9px 12px; border-top: 1px solid var(--line); text-align: center; font-weight: 650; color: #1b6aa6; font-size: 0.88rem; }
.push { display: flex; gap: 10px; align-items: flex-start; padding: 12px; border-radius: 16px; background: var(--surface-2); border: 1px solid var(--line); max-width: 420px; }
.history { display: grid; gap: 8px; }
.entry { display: grid; gap: 6px; }
.nudge { padding: 10px; border-radius: 10px; background: var(--surface-2); }
.lines { margin: 0; padding-left: 18px; display: grid; gap: 2px; }
.show { justify-self: start; align-self: flex-start; }
.catalogue summary { cursor: pointer; min-height: 28px; }
.catalogue li + li { padding-top: 8px; border-top: 1px solid var(--line); }
@container (min-width: 640px) {
  .groups { display: grid; grid-template-columns: 1fr 1fr; column-gap: 22px; }
  .groups .group:nth-child(2) { border-top: 0; }
  .mail { height: 470px; }
}
</style>
