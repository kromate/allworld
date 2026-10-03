<script setup lang="ts">
// The creator's conversation with what the viewer needs to know about the connection above it.
// The conversation is the ordinary one (ConversationThread): the same messages, read marks,
// composer and block as any other, with the creator badge and the automatic-welcome label the
// thread shows for every viewer. This adds no store of its own.
import { computed, ref, watch } from 'vue'
import type { CreatorCard } from '../../shared/creator.ts'
import type { Conversation, ConversationId } from '../../shared/direct.ts'
import ConversationThread from '../social/ConversationThread.vue'
import CreatorConnection from './CreatorConnection.vue'
import { STANDING_TEXT, isConnected, standingOf } from './creatorView.ts'
import type { CreatorCardState } from './useCreatorCard.ts'

const props = defineProps<{
  card: CreatorCard | null
  state: CreatorCardState
  error?: string
  /**
   * The creator's conversation as the conversation list has it (`peer.verified === 'creator'`),
   * when there is one. It gives the real unread count, and the thread itself on a host where the
   * card cannot be asked for.
   */
  conversation?: Conversation | null
}>()
const emit = defineEmits<{ retry: []; changed: [] }>()

const standing = computed(() => standingOf(props.card))
/** A conversation the viewer chose to open from the card (a new one, or the history after a removal). */
const opened = ref<ConversationId | null>(null)
watch(() => props.card?.member?.id ?? null, () => { opened.value = null })
/** The conversation to show: only one the service named, in the card or in the list. */
const conversationId = computed<ConversationId | null>(() => {
  if (props.state === 'ready' && props.card) {
    if (isConnected(standing.value)) return props.card.conversationId ?? opened.value
    return standing.value === 'removed' ? opened.value : null
  }
  return props.state === 'absent' ? props.conversation?.id ?? null : null
})
/** Connected and on screen: one line says what kind of connection it is; the thread's own header does the rest. */
const settled = computed(() => props.state === 'ready' && isConnected(standing.value) && conversationId.value !== null)
</script>

<template>
  <div class="creator-thread">
    <p v-if="settled" class="small muted line"><span class="chip amber">{{ STANDING_TEXT[standing].title }}</span> {{ STANDING_TEXT[standing].text }}</p>
    <CreatorConnection
      v-else-if="!(state === 'absent' && conversationId)" :card="card" :state="state" :error="error" :unread="conversation?.unread ?? null" :thread-shown="conversationId !== null"
      @retry="emit('retry')" @open="opened = $event" @changed="emit('changed')"
    />
    <ConversationThread v-if="conversationId" :key="conversationId" class="thread-slot" :conversation-id="conversationId" @gone="emit('changed')" @changed="emit('changed')" />
  </div>
</template>

<style scoped>
.creator-thread { display: flex; flex-direction: column; gap: 8px; min-height: 0; height: 100%; }
.line { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.thread-slot { flex: 1 1 0; min-height: 0; }
</style>
