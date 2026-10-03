<script setup lang="ts">
// The creator's conversation as a page in the ordinary window frame. For a guest this is what the
// Chat section is: the one conversation the service lets a guest have. It asks for the creator
// card only when told the host has one (`active`), and reads the conversation list every host
// already answers, so the unread count and the thread are the service's, not this page's.
import { computed, inject, onMounted, watch } from 'vue'
import { GUEST_GATE_MESSAGE } from '../../shared/guest.ts'
import { app } from '../../state/app.ts'
import { social } from '../../state/social.ts'
import { GUEST_CONTROL } from '../guest/guestView.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { inbox, loadInbox } from '../social/conversations.ts'
import CreatorThread from './CreatorThread.vue'
import { isCreator } from './creatorView.ts'
import { useCreatorCard } from './useCreatorCard.ts'

const props = defineProps<{
  /** The host has registered the creator module, so `creator.card` may be asked. Off by default. */
  active?: boolean
}>()

// The session's own answer; only an explicit 'unavailable' takes the save link away.
const guest = inject(GUEST_CONTROL, null)
const cannotSave = computed(() => guest?.session.value?.signIn === 'unavailable')
const { card, state, error, reload } = useCreatorCard(() => Boolean(props.active))
/** The creator's conversation in the list, told by the service's badge and nothing else. */
const conversation = computed(() => inbox.list.find(entry => isCreator(entry.peer)) ?? null)
const title = computed(() => card.value?.member?.displayName ?? conversation.value?.peer.displayName ?? 'The creator')
/** Without a card to ask, the list is the only source: wait for it, and say when it failed. */
const listOnly = computed(() => state.value === 'absent')

function refresh(): void { void reload(); void loadInbox() }
onMounted(() => { void loadInbox() })
watch(() => social.changed.direct, () => { void loadInbox() })
</script>

<template>
  <PanelPage class="creator-page" :title="title">
    <div class="frame">
      <StateView v-if="listOnly && (inbox.state === 'idle' || inbox.state === 'loading')" state="loading" />
      <StateView v-else-if="listOnly && inbox.state === 'error'" state="error" :message="inbox.error" @retry="loadInbox" />
      <CreatorThread v-else class="grow-slot" :card="card" :state="state" :error="error" :conversation="conversation" @retry="refresh" @changed="refresh" />
      <!-- A guest's messaging reaches the creator only; the rest waits for a saved character. -->
      <p v-if="app.guest && cannotSave" class="small muted guest-note">As a guest you can message the creator. Talking to other people needs a saved character, and saving is not available on this playtest yet.</p>
      <p v-else-if="app.guest" class="small muted guest-note">{{ GUEST_GATE_MESSAGE.messaging }} <RouterLink to="/save">Save my character</RouterLink></p>
    </div>
  </PanelPage>
</template>

<style scoped>
/* Like Messages: the page does not scroll as a whole, so the composer stays at the bottom. */
.creator-page .frame { flex: 1 1 0; min-height: 0; display: flex; flex-direction: column; gap: 8px; }
.grow-slot { flex: 1 1 0; min-height: 0; }
.guest-note { flex: none; }
</style>
