<script setup lang="ts">
// One conversation between two friends: the messages, whether each of yours was delivered and
// read, a composer, and the things friends do together (wave, join, play). Report and block are
// here too, because this is where someone would need them.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CREATOR_AUTOMATIC_LABEL } from '../../shared/creator.ts'
import { DIRECT_MAX_LENGTH } from '../../shared/direct.ts'
import type { Conversation, ConversationId, DirectMessage } from '../../shared/direct.ts'
import type { Iso } from '../../shared/ids.ts'
import { REPORT_REASONS, WorldError } from '../../shared/model.ts'
import type { ReportReason } from '../../shared/model.ts'
import { api, app, attempt, messageOf, myId, onReconnect, onServerEvent, toast } from '../../state/app.ts'
import { goToFriend, inviteToJoin, sendWave, social } from '../../state/social.ts'
import { world } from '../../state/world.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import CreatorBadge from '../creator/CreatorBadge.vue'
import { isAutomaticFriend, isAutomaticWelcome, isCreator } from '../creator/creatorView.ts'
import { guestMay } from '../guest/guestMay.ts'
import { dayLabel, patchConversation, shortTime } from './conversations.ts'
import MessageText from './MessageText.vue'

const props = defineProps<{ conversationId: ConversationId }>()
const emit = defineEmits<{ loaded: [conversation: Conversation]; gone: []; /** A connection with the peer was removed from here. */ changed: [] }>()
const router = useRouter()

interface Shown extends DirectMessage { pending?: boolean; failed?: string; clientId?: string }
const conversation = ref<Conversation | null>(null)
const messages = ref<Shown[]>([])
const more = ref(false)
const state = ref<'loading' | 'ready' | 'missing' | 'error'>('loading')
const error = ref('')
const draft = ref('')
const log = ref<HTMLElement | null>(null)
const input = ref<HTMLTextAreaElement | null>(null)
const unseen = ref(0)
const loadingEarlier = ref(false)
const menu = ref<'none' | 'open' | 'report' | 'block' | 'remove'>('none')
const reason = ref<ReportReason>('harassment')
const detail = ref('')
const busy = ref(false)
const coarse = window.matchMedia('(pointer: coarse)').matches
const REASON_LABEL: Record<ReportReason, string> = { harassment: 'Harassment or abuse', spam: 'Spam', impersonation: 'Pretending to be someone else', 'unsafe-meetup': 'Unsafe meetup behaviour', other: 'Something else' }
const STARTERS = ['Hello 👋', 'Where are you now?', 'Want to play a game?', 'Come and join me']

const me = computed(() => myId())
const peer = computed(() => conversation.value?.peer ?? null)
/**
 * What friends do together is offered for a friendship both accepted, to a member. A friendship
 * the service made (`automatic`) is for messaging, removing and blocking only, and a guest has
 * no other kind: the rest is left out rather than sent to be refused.
 */
const serviceMade = computed(() => isAutomaticFriend(peer.value))
const asFriends = computed(() => !serviceMade.value && !app.guest)
const starters = computed(() => (asFriends.value ? STARTERS : STARTERS.slice(0, 1)))
/** The friend is standing in the same room as the viewer. */
const together = computed(() => Boolean(peer.value) && world.state === 'ready' && world.members.some(member => member.id === peer.value!.id))
const canInviteHere = computed(() => !together.value && world.state === 'ready' && (world.kind === 'district' || world.kind === 'venue' || (world.kind === 'home' && world.canEditHome)))
const lastMine = computed(() => [...messages.value].reverse().find(message => message.from === me.value && !message.pending && !message.failed) ?? null)
const remaining = computed(() => DIRECT_MAX_LENGTH - draft.value.length)

/** How far a message of mine got: stored, on their device, or read. */
function mark(message: Shown): 'sending' | 'failed' | 'sent' | 'delivered' | 'read' {
  if (message.failed) return 'failed'
  if (message.pending) return 'sending'
  const about = conversation.value
  if (about && message.seq <= about.peerReadSeq) return 'read'
  if (about && message.seq <= about.peerDeliveredSeq) return 'delivered'
  return 'sent'
}
const MARK_WORDS = { sending: 'Sending', failed: 'Not sent', sent: 'Sent', delivered: 'Delivered', read: 'Read' } as const
const MARK_TICKS = { sending: '…', failed: '!', sent: '✓', delivered: '✓✓', read: '✓✓' } as const

/** Messages with a heading wherever the day changes. */
const rows = computed(() => {
  const out: ({ kind: 'day'; key: string; label: string } | { kind: 'message'; key: string; message: Shown; joined: boolean })[] = []
  let day = '', previous: Shown | null = null
  for (const message of messages.value) {
    const label = dayLabel(message.at)
    if (label !== day) { day = label; out.push({ kind: 'day', key: `day:${label}:${message.id}`, label }); previous = null }
    const joined = Boolean(previous && previous.from === message.from && Date.parse(message.at) - Date.parse(previous.at) < 4 * 60_000)
    out.push({ kind: 'message', key: message.id, message, joined })
    previous = message
  }
  return out
})

const nearBottom = (): boolean => { const el = log.value; return !el || el.scrollHeight - el.scrollTop - el.clientHeight < 90 }
async function toBottom(): Promise<void> { await nextTick(); if (log.value) log.value.scrollTop = log.value.scrollHeight; unseen.value = 0 }

async function markRead(): Promise<void> {
  const about = conversation.value
  const latest = [...messages.value].reverse().find(message => !message.pending && !message.failed)
  if (!about || !latest || document.visibilityState !== 'visible' || (about.unread === 0 && about.readSeq >= latest.seq)) return
  try {
    social.unreadDirect = (await api('direct.read', { conversationId: props.conversationId, upTo: latest.seq })).unread
    about.unread = 0
    about.readSeq = latest.seq
    patchConversation({ ...about })
  } catch { /* the next message or visit marks it */ }
}

async function load(): Promise<void> {
  try {
    const result = await api('direct.get', { conversationId: props.conversationId, before: null })
    conversation.value = result.conversation
    // Keep anything still on its way out.
    messages.value = [...result.messages, ...messages.value.filter(message => message.pending || message.failed)]
    more.value = result.more
    state.value = 'ready'
    emit('loaded', result.conversation)
    await toBottom()
    void markRead()
  } catch (cause) {
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid')) { state.value = 'missing'; return }
    error.value = messageOf(cause)
    if (state.value !== 'ready') state.value = 'error'
  }
}

/** The friend's status line and whether messages can still be sent, without touching the messages on screen. */
async function refreshHeader(): Promise<void> {
  if (state.value !== 'ready') return
  try {
    const result = await api('direct.get', { conversationId: props.conversationId, before: null })
    conversation.value = result.conversation
    emit('loaded', result.conversation)
  } catch (cause) {
    if (cause instanceof WorldError && cause.code === 'not_found') state.value = 'missing'
  }
}

async function loadEarlier(): Promise<void> {
  const oldest = messages.value[0]
  const el = log.value
  if (!oldest || loadingEarlier.value) return
  loadingEarlier.value = true
  const heightBefore = el?.scrollHeight ?? 0
  try {
    const result = await api('direct.get', { conversationId: props.conversationId, before: oldest.seq })
    messages.value = [...result.messages, ...messages.value]
    more.value = result.more
    await nextTick()
    // Stay on the message that was at the top.
    if (el) el.scrollTop += el.scrollHeight - heightBefore
  } catch (cause) { toast(messageOf(cause), 'bad') } finally { loadingEarlier.value = false }
}

async function deliver(message: Shown): Promise<void> {
  message.pending = true
  message.failed = undefined
  try {
    const result = await api('direct.send', { conversationId: props.conversationId, text: message.text, clientId: message.clientId! })
    const index = messages.value.findIndex(entry => entry.id === message.id)
    if (index >= 0) messages.value.splice(index, 1)
    if (!messages.value.some(entry => entry.id === result.message.id)) messages.value.push(result.message)
    messages.value.sort((x, y) => x.seq - y.seq)
    conversation.value = result.conversation
    patchConversation(result.conversation)
    emit('loaded', result.conversation)
  } catch (cause) {
    const index = messages.value.findIndex(entry => entry.id === message.id)
    if (index >= 0) messages.value[index] = { ...message, pending: false, failed: messageOf(cause) }
  }
}

async function send(text = draft.value): Promise<void> {
  const body = text.trim()
  if (!body || !conversation.value?.canSend) return
  const clientId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const message: Shown = { id: `local-${clientId}`, conversationId: props.conversationId, seq: Number.MAX_SAFE_INTEGER, from: me.value!, text: body, at: new Date().toISOString() as Iso, pending: true, clientId }
  messages.value.push(message)
  if (text === draft.value) { draft.value = ''; void nextTick(grow) }
  void toBottom()
  await deliver(message)
  void toBottom()
}
function retry(message: Shown): void { const index = messages.value.findIndex(entry => entry.id === message.id); if (index >= 0) void deliver(messages.value[index]!) }
function discard(message: Shown): void { messages.value = messages.value.filter(entry => entry.id !== message.id) }

function grow(): void {
  const el = input.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${Math.min(132, el.scrollHeight + 2)}px`
}
function onEnter(event: KeyboardEvent): void {
  // On a phone the return key makes a new line and the button sends; with a keyboard, Enter sends.
  if (coarse || event.shiftKey || event.isComposing) return
  event.preventDefault()
  void send()
}

const stopEvents = onServerEvent(event => {
  if (event.type === 'direct.message' && event.conversation.id === props.conversationId) {
    const stick = nearBottom()
    if (!messages.value.some(message => message.id === event.message.id)) messages.value.push(event.message)
    conversation.value = event.conversation
    emit('loaded', event.conversation)
    if (stick && document.visibilityState === 'visible') { void toBottom(); void markRead() } else unseen.value++
  } else if (event.type === 'direct.state' && event.conversationId === props.conversationId && conversation.value) {
    conversation.value.peerDeliveredSeq = Math.max(conversation.value.peerDeliveredSeq, event.peerDeliveredSeq)
    conversation.value.peerReadSeq = Math.max(conversation.value.peerReadSeq, event.peerReadSeq)
  } else if (event.type === 'direct.changed' || (event.type === 'social.changed' && event.scope === 'friends') || event.type === 'around.changed') {
    // A block, a friendship ending, or the friend moving somewhere else: read the header again.
    void refreshHeader()
  }
})
const stopReconnect = onReconnect(() => { void load() })
function onVisible(): void { if (document.visibilityState === 'visible' && nearBottom()) { unseen.value = 0; void markRead() } }
function onScroll(): void { if (nearBottom() && unseen.value) { unseen.value = 0; void markRead() } }

onMounted(() => {
  social.openConversation = props.conversationId
  document.addEventListener('visibilitychange', onVisible)
  void load().then(() => { if (!coarse) input.value?.focus() })
})
onBeforeUnmount(() => {
  if (social.openConversation === props.conversationId) social.openConversation = null
  document.removeEventListener('visibilitychange', onVisible)
  stopEvents()
  stopReconnect()
})
watch(draft, () => { void nextTick(grow) })

// ── Report and block ──
async function report(): Promise<void> {
  busy.value = true
  const result = await attempt('direct.report', { conversationId: props.conversationId, reason: reason.value, detail: detail.value.trim() }, 'Report received with the recent messages attached. Thank you.')
  busy.value = false
  if (result) { menu.value = 'none'; detail.value = '' }
}
async function block(): Promise<void> {
  const other = peer.value
  if (!other) return
  busy.value = true
  try {
    app.blocked = (await api('member.block', { memberId: other.id })).blocked
    toast(`${other.displayName} is blocked. This conversation is closed for both of you.`, 'good', {
      label: 'Unblock', run: () => { void api('member.unblock', { memberId: other.id }).then(result => { app.blocked = result.blocked; toast(`${other.displayName} is unblocked. The old conversation stays closed.`, 'info') }) },
    })
    emit('gone')
  } catch (cause) { toast(messageOf(cause), 'bad') } finally { busy.value = false }
}
/** End a friendship the service made. The service records it and does not make it again; the history stays. */
async function removeConnection(): Promise<void> {
  const other = peer.value
  if (!other) return
  busy.value = true
  try {
    await api('friends.remove', { memberId: other.id })
    toast(`${other.displayName} is no longer in your friends. You will not be connected again automatically.`, 'good')
    menu.value = 'none'
    void refreshHeader()
    emit('changed')
  } catch (cause) { toast(messageOf(cause), 'bad') } finally { busy.value = false }
}
async function reintroduce(): Promise<void> {
  const other = peer.value
  if (!other) return
  await attempt('intro.send', { to: other.id, note: '' }, `Introduction sent to ${other.displayName}.`)
  void refreshHeader()
}
</script>

<template>
  <div class="thread">
    <StateView v-if="state === 'loading' || state === 'error'" :state="state" :message="error" @retry="load" />

    <div v-else-if="state === 'missing'" class="empty">
      <div class="art" aria-hidden="true">💬</div>
      <h3>That conversation is not available</h3>
      <p class="small">It may have been closed by a block, or the link is for another member.</p>
      <RouterLink class="btn primary" to="/messages">Back to messages</RouterLink>
    </div>

    <template v-else-if="conversation && peer">
      <!-- Who, where, and what you can do together -->
      <header class="who">
        <MemberBadge :member-id="peer.id" :look="peer.look" :size="34" :online="peer.online" />
        <span class="grow two">
          <!-- Only the member the service verified carries the mark; a name never does. -->
          <CreatorBadge v-if="isCreator(peer)" :member="peer" class="mark" />
          <span class="tiny" :class="peer.online ? 'online' : 'muted'">{{ together ? 'Here with you' : conversation.peerWhere.hidden ? (peer.online ? 'Online' : 'Offline') : conversation.peerWhere.words.replace(/^./, letter => letter.toUpperCase()) }}</span>
          <span v-if="!together && conversation.peerWhere.sameCity === false && peer.online" class="tiny muted">Another city · a trip is needed to meet</span>
        </span>
        <div class="row tools">
          <button v-if="asFriends && conversation.peerWhere.canJoin && !together" class="btn sm" type="button" @click="goToFriend(peer)">Go to them</button>
          <button v-else-if="asFriends && conversation.canSend && peer.online && canInviteHere" class="btn sm" type="button" @click="inviteToJoin(peer, 'here')">Join me</button>
          <button class="btn ghost icon sm" type="button" :aria-label="asFriends ? 'More: wave, play, meet, report or block' : 'More: remove, report or block'" :aria-expanded="menu !== 'none'" @click="menu = menu === 'none' ? 'open' : 'none'">⋯</button>
        </div>
      </header>

      <div v-if="menu === 'open'" class="card menu row wrap">
        <template v-if="asFriends">
          <button v-if="conversation.canSend" class="btn sm" type="button" @click="sendWave(peer); menu = 'none'"><span aria-hidden="true">👋</span> Wave</button>
          <button class="btn sm" type="button" @click="router.push(`/arena?challenge=${peer.id}`)">🎮 Challenge to a game</button>
          <button v-if="conversation.canSend" class="btn sm" type="button" @click="inviteToJoin(peer, 'home'); menu = 'none'">🏠 Invite to my home</button>
          <button class="btn sm" type="button" @click="router.push(`/people?tab=meetups&with=${peer.id}`)">📅 Plan a meetup</button>
        </template>
        <button v-if="serviceMade && conversation.canSend" class="btn sm ghost" type="button" @click="menu = 'remove'">Remove from friends</button>
        <button v-if="guestMay('direct.report', { conversationId })" class="btn sm ghost danger" type="button" @click="menu = 'report'">Report</button>
        <button class="btn sm ghost danger" type="button" @click="menu = 'block'">Block</button>
      </div>
      <div v-else-if="menu === 'remove'" class="notice amber ask" role="group" :aria-label="`Remove ${peer.displayName} from your friends`">
        <p class="grow">Remove {{ peer.displayName }} from your friends? You will not be connected again automatically. What was said stays readable.</p>
        <div class="row"><button class="btn dark sm" type="button" :disabled="busy" @click="removeConnection">Remove</button><button class="btn sm" type="button" @click="menu = 'none'">Keep</button></div>
      </div>
      <form v-else-if="menu === 'report'" class="card stack tight" @submit.prevent="report">
        <label class="field"><span>What happened?</span>
          <select v-model="reason" class="select"><option v-for="entry in REPORT_REASONS" :key="entry" :value="entry">{{ REASON_LABEL[entry] }}</option></select>
        </label>
        <label class="field"><span>Details (optional)</span>
          <textarea v-model="detail" class="textarea" maxlength="400" placeholder="Anything that helps a reviewer understand"></textarea>
          <small>The last messages of this conversation are attached for the reviewer.</small>
        </label>
        <div class="row"><button class="btn dark sm" type="submit" :disabled="busy">{{ busy ? 'Sending…' : 'Send report' }}</button><button class="btn sm ghost" type="button" @click="menu = 'none'">Cancel</button></div>
      </form>
      <div v-else-if="menu === 'block'" class="notice coral ask" role="group" :aria-label="`Block ${peer.displayName}`">
        <p class="grow">Block {{ peer.displayName }}? You will not see or hear each other anywhere, and this conversation closes for both of you for good.</p>
        <div class="row"><button class="btn dark sm" type="button" :disabled="busy" @click="block">Block</button><button class="btn sm" type="button" @click="menu = 'none'">Keep</button></div>
      </div>

      <!-- Messages -->
      <div ref="log" class="log" role="log" aria-live="polite" :aria-label="`Messages with ${peer.displayName}`" tabindex="0" @scroll.passive="onScroll">
        <button v-if="more" class="btn sm earlier" type="button" :disabled="loadingEarlier" @click="loadEarlier">{{ loadingEarlier ? 'Loading…' : 'Show earlier messages' }}</button>
        <div v-if="!messages.length" class="hello">
          <MemberBadge :member-id="peer.id" :look="peer.look" :size="64" :online="peer.online" />
          <h3>Say hello to {{ peer.displayName }}</h3>
          <p class="small muted">{{ peer.online ? 'They are online now.' : 'They are offline. Your message waits for them.' }}</p>
          <div v-if="conversation.canSend" class="row wrap starters">
            <button v-for="text in starters" :key="text" class="btn sm" type="button" @click="send(text)">{{ text }}</button>
          </div>
        </div>
        <template v-for="row in rows" :key="row.key">
          <p v-if="row.kind === 'day'" class="day"><span>{{ row.label }}</span></p>
          <div v-else class="bubble-row" :class="{ mine: row.message.from === me, joined: row.joined }">
            <div class="bubble" :class="{ failed: row.message.failed, pending: row.message.pending, automatic: isAutomaticWelcome(row.message) }">
              <!-- Written by the service for the sender, not typed just now: said in words, above the text. -->
              <span v-if="isAutomaticWelcome(row.message)" class="auto tiny">{{ CREATOR_AUTOMATIC_LABEL }}</span>
              <MessageText class="body" :text="row.message.text" />
              <span class="meta tiny num">
                <span>{{ shortTime(row.message.at) }}</span>
                <span v-if="row.message.from === me" class="ticks" :class="mark(row.message)" :aria-label="MARK_WORDS[mark(row.message)]" role="img">{{ MARK_TICKS[mark(row.message)] }}</span>
              </span>
            </div>
            <p v-if="row.message.failed" class="tiny problem" role="alert">
              Not sent. {{ row.message.failed }}
              <button class="link" type="button" @click="retry(row.message)">Try again</button>
              <button class="link" type="button" @click="discard(row.message)">Remove</button>
            </p>
            <p v-else-if="lastMine && row.message.id === lastMine.id" class="tiny muted status">{{ MARK_WORDS[mark(row.message)] }}</p>
          </div>
        </template>
      </div>
      <button v-if="unseen" class="btn dark sm jump" type="button" @click="toBottom(); markRead()">{{ unseen === 1 ? 'New message' : `${unseen} new messages` }} ↓</button>

      <!-- Composer -->
      <div v-if="!conversation.canSend" class="notice amber closed">
        <div class="grow">You and {{ peer.displayName }} are no longer friends, so new messages are not sent. What was said stays here.<template v-if="isCreator(peer)"> You are not connected again automatically.</template></div>
        <button v-if="peer.relation === 'none' && guestMay('intro.send', { to: peer.id })" class="btn sm" type="button" @click="reintroduce">Send an introduction</button>
        <span v-else-if="peer.relation === 'intro-sent'" class="chip amber">Introduction sent</span>
        <RouterLink v-else-if="peer.relation === 'intro-received'" class="btn sm" to="/people?tab=requests">Answer their introduction</RouterLink>
      </div>
      <!-- The composer is only the composer: waving, joining and playing are in the header and its menu. -->
      <form v-else class="composer" @submit.prevent="send()">
        <div class="row entry">
          <textarea
            ref="input" v-model="draft" class="textarea box" rows="1" :maxlength="DIRECT_MAX_LENGTH" :placeholder="`Message ${peer.displayName}`"
            :aria-label="`Message to ${peer.displayName}`" enterkeyhint="send" @keydown.enter="onEnter" @input="grow"
          ></textarea>
          <button class="btn primary send" type="submit" :disabled="!draft.trim()" aria-label="Send message">Send</button>
        </div>
        <p v-if="remaining <= 100" class="tiny num" :class="remaining <= 20 ? 'problem' : 'muted'">{{ remaining }} characters left</p>
      </form>
    </template>
  </div>
</template>

<style scoped>
.thread { position: relative; display: flex; flex-direction: column; gap: 8px; min-height: 0; height: 100%; }
.who { display: flex; align-items: center; gap: 10px; padding: 6px 2px 8px; border-bottom: 1px solid var(--line); }
.two { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.online { color: #1f7447; font-weight: 650; }
.tools { gap: 6px; flex: none; }
.menu { gap: 6px; padding: 10px; }
.ask { flex-wrap: wrap; align-items: center; }
.ask p { flex: 1 1 200px; }

.log { flex: 1 1 0; min-height: 120px; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; padding: 6px 4px 4px; overscroll-behavior: contain; border-radius: 12px; }
.earlier { align-self: center; }
.hello { margin: auto; display: grid; justify-items: center; gap: 8px; text-align: center; padding: 18px 8px; }
.starters { justify-content: center; gap: 6px; }
.day { display: flex; justify-content: center; margin: 8px 0 2px; }
.day span { padding: 2px 10px; border-radius: 999px; background: var(--surface-3); color: var(--ink-2); font-size: 0.74rem; font-weight: 650; }
.bubble-row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; }
.bubble-row.mine { align-items: flex-end; }
.bubble-row.joined { margin-top: -3px; }
.bubble { max-width: min(82%, 520px); padding: 8px 12px 6px; border-radius: 18px 18px 18px 6px; background: var(--surface); border: 1px solid var(--line); display: flex; flex-wrap: wrap; align-items: flex-end; justify-content: flex-end; gap: 2px 10px; box-shadow: 0 1px 1px rgba(40, 30, 10, 0.04); }
.mine .bubble { border-radius: 18px 18px 6px 18px; background: linear-gradient(180deg, #ffe7ae, #ffdc8a); border-color: #f0c869; color: var(--accent-ink); }
.bubble.pending { opacity: 0.7; }
.bubble.failed { background: var(--coral-soft); border-color: #f1b9ad; color: #7d2414; }
.body { flex: 1 1 auto; white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0; }
/* The automatic label takes the bubble's first line to itself, so it is read before the words. */
.auto { flex: 1 1 100%; font-weight: 700; letter-spacing: 0.02em; color: #5a43ad; }
.bubble.automatic { border-style: dashed; border-color: #cfc3f3; }
.mark { align-self: flex-start; }
.meta { display: inline-flex; align-items: center; gap: 5px; color: rgba(28, 26, 36, 0.55); flex: none; }
.ticks { font-weight: 800; letter-spacing: -1px; }
.ticks.read { color: #1b6aa6; }
.status { padding: 0 6px; }
.problem { color: var(--danger); }
.link { border: 0; background: none; padding: 0 0 0 6px; color: inherit; font-weight: 700; text-decoration: underline; }
.jump { position: absolute; left: 50%; bottom: 72px; transform: translateX(-50%); border-radius: 999px; box-shadow: var(--shadow-lg); }

.closed { align-items: center; flex-wrap: wrap; }
.composer { display: flex; flex-direction: column; gap: 6px; padding-top: 4px; }
.entry { align-items: flex-end; gap: 8px; }
.box { min-height: 44px; height: 44px; max-height: 132px; resize: none; border-radius: 22px; padding: 10px 16px; line-height: 1.35; }
.send { border-radius: 22px; min-height: 44px; flex: none; }
@media (pointer: coarse) { .btn.sm { min-height: 44px; } .btn.icon.sm { width: 44px; } }
</style>
