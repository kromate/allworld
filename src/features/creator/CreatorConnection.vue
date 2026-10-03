<script setup lang="ts">
// The creator, and how the viewer stands with them, on one compact card. Everything on it is the
// service's answer: who the creator is (the verified badge), whether they are online, whether a
// connection exists, and what can be done about it. Before there is an answer it says it is
// loading; when there cannot be one it says why. Remove and block are the same operations every
// member has for any friend, and nothing here connects anyone again.
import { computed, ref } from 'vue'
import type { CreatorCard } from '../../shared/creator.ts'
import type { ConversationId } from '../../shared/direct.ts'
import { api, app, attempt, messageOf, toast } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { guestMay } from '../guest/guestMay.ts'
import ConfirmAction from '../people/ConfirmAction.vue'
import CreatorBadge from './CreatorBadge.vue'
import { STANDING_TEXT, isConnected, standingOf } from './creatorView.ts'
import type { CreatorCardState } from './useCreatorCard.ts'

const props = defineProps<{
  /** The service's `creator.card` answer. Null before it arrives and where there is none. */
  card: CreatorCard | null
  state: CreatorCardState
  /** The service's sentence when the card could not be loaded. */
  error?: string
  /** Unread messages in the creator's conversation, from the conversation itself. Left out when not known. */
  unread?: number | null
  /** The conversation is already on screen below: no button to open it. */
  threadShown?: boolean
}>()
const emit = defineEmits<{
  retry: []
  /** Open this conversation. */
  open: [conversationId: ConversationId]
  /** A removal, a block or an introduction went through: ask the service again. */
  changed: []
}>()

const standing = computed(() => standingOf(props.card))
const words = computed(() => STANDING_TEXT[standing.value])
const member = computed(() => props.card?.member ?? null)
const connected = computed(() => isConnected(standing.value))
const offline = computed(() => app.link !== 'online')
const busy = ref<'' | 'open' | 'remove' | 'block' | 'intro'>('')

async function open(): Promise<void> {
  const creator = member.value
  if (!creator || busy.value) return
  if (props.card?.conversationId) { emit('open', props.card.conversationId); return }
  busy.value = 'open'
  try { emit('open', (await api('direct.open', { memberId: creator.id })).conversation.id) }
  catch (cause) { toast(messageOf(cause), 'bad') }
  finally { busy.value = '' }
}

/** After a removal the history is still the viewer's to read. */
function read(): void { if (props.card?.conversationId) emit('open', props.card.conversationId) }

async function remove(): Promise<void> {
  const creator = member.value
  if (!creator || busy.value) return
  busy.value = 'remove'
  try {
    await api('friends.remove', { memberId: creator.id })
    toast(`${creator.displayName} is no longer in your friends. You will not be connected again automatically.`, 'good')
    emit('changed')
  } catch (cause) { toast(messageOf(cause), 'bad') } finally { busy.value = '' }
}

async function block(): Promise<void> {
  const creator = member.value
  if (!creator || busy.value) return
  busy.value = 'block'
  try {
    app.blocked = (await api('member.block', { memberId: creator.id })).blocked
    toast(`${creator.displayName} is blocked. You will not see or hear each other, and the conversation is closed.`, 'good')
    emit('changed')
  } catch (cause) { toast(messageOf(cause), 'bad') } finally { busy.value = '' }
}

/** After a removal, the ordinary way back: an introduction the creator may accept. An account's, not a guest's. */
async function introduce(): Promise<void> {
  const creator = member.value
  if (!creator || busy.value) return
  busy.value = 'intro'
  const sent = await attempt('intro.send', { to: creator.id, note: '' }, `Introduction sent to ${creator.displayName}. You become friends if they accept.`)
  busy.value = ''
  if (sent) emit('changed')
}
</script>

<template>
  <section class="card creator-card stack tight" aria-label="The creator">
    <div v-if="state === 'loading'" class="row" role="status" aria-label="Loading the creator connection">
      <div class="skeleton" style="width: 44px; height: 44px; border-radius: 32%"></div>
      <div class="grow stack tight"><div class="skeleton" style="height: 14px; width: 50%"></div><div class="skeleton" style="height: 12px; width: 80%"></div></div>
    </div>

    <div v-else-if="state === 'error'" class="notice coral" role="alert">
      <div class="grow"><strong>The creator connection did not load.</strong><div>{{ error || 'Check your connection and try again.' }}</div></div>
      <button class="btn sm" type="button" @click="emit('retry')">Try again</button>
    </div>

    <template v-else>
      <div v-if="member" class="row who">
        <MemberBadge :member-id="member.id" :look="member.look" :size="44" :online="member.online" />
        <div class="grow names">
          <span class="row name-row"><strong class="truncate">{{ member.displayName }}</strong><CreatorBadge :member="member" /></span>
          <!-- Online or offline as the service reports it. Nothing more is known, and nothing more is said. -->
          <span class="tiny" :class="member.online ? 'online' : 'muted'">{{ member.online ? 'Online' : 'Offline' }}</span>
        </div>
        <span v-if="unread" class="chip coral" role="status">{{ unread }} unread</span>
      </div>

      <div class="standing">
        <span class="chip" :class="connected ? 'amber' : ''">{{ words.title }}</span>
        <p class="small">{{ words.text }}<template v-if="standing === 'removed' && card?.conversationId"> What was said stays readable.</template></p>
        <p v-if="connected && card?.hangout" class="small muted">The welcome names a public hangout in the game: {{ card.hangout.name }}<template v-if="card.hangout.areaLabel"> in {{ card.hangout.areaLabel }}</template>.</p>
      </div>

      <p v-if="offline" class="notice" role="status">You are offline. This is what was last loaded; it catches up when the connection returns.</p>

      <div v-if="member && standing !== 'self'" class="row wrap actions">
        <button v-if="connected && !threadShown" class="btn primary sm" type="button" :disabled="offline || Boolean(busy)" @click="open">{{ busy === 'open' ? 'Opening…' : card?.conversationId ? 'Open the conversation' : 'Start a conversation' }}</button>
        <button v-else-if="standing === 'removed' && card?.conversationId && !threadShown" class="btn sm" type="button" @click="read">Read the conversation</button>
        <template v-if="standing === 'removed' && guestMay('intro.send', { to: member.id })">
          <button v-if="member.relation === 'none'" class="btn sm" type="button" :disabled="offline || Boolean(busy)" @click="introduce">{{ busy === 'intro' ? 'Sending…' : 'Send an introduction' }}</button>
          <span v-else-if="member.relation === 'intro-sent'" class="chip amber">Introduction sent</span>
        </template>
        <ConfirmAction
          v-if="connected && guestMay('friends.remove', { memberId: member.id })" label="Remove" button-class="sm ghost" confirm-label="Remove" cancel-label="Keep" tone="amber"
          :busy="busy === 'remove'" :disabled="offline || Boolean(busy)"
          :question="`Remove ${member.displayName} from your friends? You will not be connected again automatically. What was said stays readable.`"
          @confirm="remove"
        />
        <ConfirmAction
          v-if="guestMay('member.block', { memberId: member.id })" label="Block" button-class="sm ghost danger" confirm-label="Block" cancel-label="Keep"
          :busy="busy === 'block'" :disabled="offline || Boolean(busy)"
          :question="`Block ${member.displayName}? You will not see or hear each other anywhere, and the conversation closes for both of you for good.`"
          @confirm="block"
        />
      </div>
    </template>
  </section>
</template>

<style scoped>
.who { gap: 12px; }
.names { display: flex; flex-direction: column; min-width: 0; line-height: 1.3; }
.name-row { gap: 6px; min-width: 0; }
.online { color: #1f7447; font-weight: 650; }
.standing { display: grid; gap: 4px; justify-items: start; }
.actions { gap: 6px; }
@media (pointer: coarse) { .actions :deep(.btn.sm) { min-height: 44px; } }
</style>
