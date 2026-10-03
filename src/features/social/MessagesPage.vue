<script setup lang="ts">
// Messages window: conversations with friends on the left, the open one on the right. On a phone
// it is one or the other, like a chat app. Friends who have not been written to yet are listed
// too, so there is always someone to start with.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Conversation, ConversationId } from '../../shared/direct.ts'
import type { MemberId } from '../../shared/ids.ts'
import { api, messageOf, myId, toast } from '../../state/app.ts'
import { messageMember, refreshAround, social } from '../../state/social.ts'
import PanelPage from '../../ui/PanelPage.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { CREATOR_AUTOMATIC_LABEL } from '../../shared/creator.ts'
import CreatorBadge from '../creator/CreatorBadge.vue'
import { isAutomaticWelcome } from '../creator/creatorView.ts'
import { guestMay } from '../guest/guestMay.ts'
import { keepKeysInWindow } from '../people/labels.ts'
import ConversationThread from './ConversationThread.vue'
import { inbox, loadInbox, shortTime } from './conversations.ts'

const route = useRoute()
const router = useRouter()
const openId = computed(() => (typeof route.params.id === 'string' && route.params.id ? (route.params.id as ConversationId) : null))
const current = ref<Conversation | null>(null)
const query = ref('')
const opening = ref(false)
let openGeneration = 0

const shown = computed(() => {
  const text = query.value.trim().toLowerCase()
  return inbox.list.filter(conversation => !text || conversation.peer.displayName.toLowerCase().includes(text))
})
const unread = computed(() => inbox.list.reduce((sum, conversation) => sum + conversation.unread, 0))
/** Friends with no messages yet: someone to start with. Online first, as the service orders them. */
const fresh = computed(() => {
  const talkedTo = new Set(inbox.list.map(conversation => conversation.peer.id))
  const text = query.value.trim().toLowerCase()
  return (social.around?.friends ?? []).filter(friend => !talkedTo.has(friend.member.id) && (!text || friend.member.displayName.toLowerCase().includes(text)))
})
const hasFriends = computed(() => (social.around?.friends.length ?? 0) > 0)
const title = computed(() => (openId.value ? current.value?.peer.displayName ?? inbox.list.find(entry => entry.id === openId.value)?.peer.displayName ?? 'Messages' : 'Messages'))
const subtitle = computed(() => (!openId.value && unread.value ? `${unread.value} unread` : undefined))
// A message the service wrote for its sender says so in the list too, before its words.
const preview = (conversation: Conversation): string =>
  conversation.last ? `${isAutomaticWelcome(conversation.last) ? `${CREATOR_AUTOMATIC_LABEL}: ` : conversation.last.from === myId() ? 'You: ' : ''}${conversation.last.text}` : 'No messages yet'

async function openWith(memberId: MemberId): Promise<void> {
  const generation = ++openGeneration
  opening.value = true
  try {
    const result = await api('direct.open', { memberId })
    if (generation === openGeneration) await router.replace(`/messages/${result.conversation.id}`)
  } catch (error) {
    if (generation !== openGeneration) return
    toast(messageOf(error), 'bad'); await router.replace('/messages')
  } finally { if (generation === openGeneration) opening.value = false }
}
async function readAll(): Promise<void> {
  try {
    social.unreadDirect = (await api('direct.readAll', {})).unread
    await loadInbox()
    toast('All conversations marked as read.', 'good')
  } catch (error) { toast(messageOf(error), 'bad') }
}

onMounted(() => {
  void loadInbox()
  void refreshAround()
})
// The router reuses this page between message links, so a new recipient is handled on each arrival.
watch([openId, () => route.query.to], ([id, to]) => {
  openGeneration++
  opening.value = false
  current.value = null
  if (!id && typeof to === 'string' && to) void openWith(to as MemberId)
}, { immediate: true })
onBeforeUnmount(() => { openGeneration++ })
watch(() => social.changed.direct, () => { void loadInbox() })
</script>

<template>
  <PanelPage class="messages" :title="title" :subtitle="subtitle" :back="openId ? '/messages' : undefined" wide @keydown="keepKeysInWindow">
    <div class="frame" :class="{ 'has-open': Boolean(openId) }">
      <div class="panes">
        <!-- Conversations -->
        <nav class="list" aria-label="Conversations">
          <div v-if="inbox.list.length > 6 || unread" class="row bar">
            <input v-if="inbox.list.length > 6" v-model="query" class="input grow" type="search" placeholder="Find a friend" aria-label="Find a friend by name" />
            <button v-if="unread && guestMay('direct.readAll')" class="btn sm" type="button" @click="readAll">Mark all read</button>
          </div>

          <StateView v-if="inbox.state === 'loading' || inbox.state === 'idle' || inbox.state === 'error'" :state="inbox.state === 'error' ? 'error' : 'loading'" :message="inbox.error" @retry="loadInbox" />
          <template v-else>
            <ul v-if="shown.length" class="rows">
              <li v-for="conversation in shown" :key="conversation.id">
                <RouterLink class="item" :class="{ unread: conversation.unread > 0 }" :to="`/messages/${conversation.id}`" :aria-current="conversation.id === openId ? 'page' : undefined">
                  <MemberBadge :member-id="conversation.peer.id" :look="conversation.peer.look" :size="42" :online="conversation.peer.online" />
                  <span class="grow two">
                    <span class="row top"><strong class="truncate">{{ conversation.peer.displayName }}</strong><CreatorBadge :member="conversation.peer" compact /><span class="grow"></span><span class="tiny muted num">{{ shortTime(conversation.updatedAt) }}</span></span>
                    <span class="row bottom"><span class="small preview truncate grow">{{ preview(conversation) }}</span><span v-if="conversation.unread" class="count num" :aria-label="`${conversation.unread} unread`">{{ conversation.unread > 99 ? '99+' : conversation.unread }}</span></span>
                  </span>
                </RouterLink>
              </li>
            </ul>
            <p v-else-if="query.trim() && inbox.list.length" class="small muted">No conversation matches that name. <button class="link" type="button" @click="query = ''">Show all</button></p>

            <template v-if="fresh.length">
              <h2 class="label">{{ inbox.list.length ? 'Friends you have not written to' : 'Start a conversation' }}</h2>
              <ul class="rows">
                <li v-for="friend in fresh" :key="friend.member.id">
                  <button class="item" type="button" :disabled="opening" @click="messageMember(friend.member.id)">
                    <MemberBadge :member-id="friend.member.id" :look="friend.member.look" :size="42" :online="friend.member.online" />
                    <span class="grow two">
                      <strong class="truncate">{{ friend.member.displayName }}</strong>
                      <span class="small preview truncate">{{ friend.where.hidden ? (friend.member.online ? 'Online' : 'Offline') : friend.where.words }}</span>
                    </span>
                    <span class="chip amber">Say hello</span>
                  </button>
                </li>
              </ul>
            </template>

            <div v-if="!inbox.list.length && !fresh.length" class="empty">
              <div class="art" aria-hidden="true">💬</div>
              <h3>{{ hasFriends ? 'No conversations yet' : 'Messages are between friends' }}</h3>
              <p class="small">Wave at someone in the street or in your city. When they wave back you can introduce yourself, and friends can write to each other from anywhere, online or not.</p>
              <RouterLink class="btn primary" to="/people">See who is around</RouterLink>
            </div>
          </template>
        </nav>

        <!-- The open conversation -->
        <section class="open" :aria-label="openId ? `Conversation with ${title}` : 'No conversation open'">
          <ConversationThread v-if="openId" :key="openId" :conversation-id="openId" @loaded="current = $event" @gone="router.push('/messages')" />
          <div v-else class="pick">
            <div class="art" aria-hidden="true">💬</div>
            <p class="small muted">{{ opening ? 'Opening the conversation…' : 'Choose a conversation, or start one with a friend.' }}</p>
          </div>
        </section>
      </div>
    </div>
  </PanelPage>
</template>

<style scoped>
/* The window scrolls inside its panes, not as a whole: the composer stays at the bottom. */
.messages .frame { flex: 1 1 0; min-height: 0; display: flex; container-type: inline-size; }
.panes { flex: 1; min-width: 0; min-height: 0; display: grid; grid-template-columns: minmax(230px, 280px) minmax(0, 1fr); gap: 14px; }
.list { min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: 10px; padding: 2px 4px 2px 2px; }
.open { min-height: 0; min-width: 0; display: flex; flex-direction: column; padding: 10px 12px; border-radius: 18px; background: var(--surface-2); border: 1px solid var(--line); }
.bar { gap: 8px; }
.rows { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.item { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 60px; padding: 8px 10px; border: 1px solid transparent; border-radius: 14px; background: transparent; color: var(--ink); text-decoration: none; text-align: left; }
.item:hover { background: var(--surface); border-color: var(--line); }
.item[aria-current="page"] { background: var(--accent-soft); border-color: #f0d08a; }
.two { display: flex; flex-direction: column; min-width: 0; gap: 1px; }
.top, .bottom { gap: 8px; min-width: 0; }
.preview { color: var(--muted); }
.item.unread .preview { color: var(--ink); font-weight: 600; }
.count { min-width: 20px; padding: 0 6px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 0.72rem; font-weight: 700; line-height: 20px; text-align: center; flex: none; }
.label { margin-top: 4px; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.link { border: 0; background: none; padding: 0; color: var(--accent-text); font-weight: 650; text-decoration: underline; }
.pick { margin: auto; display: grid; justify-items: center; gap: 6px; text-align: center; padding: 24px; }
.pick .art { font-size: 2rem; }
a.btn { text-decoration: none; }

/* A narrow window is a phone: the list, or the conversation, never both. */
@container (max-width: 620px) {
  .panes { grid-template-columns: minmax(0, 1fr); }
  .has-open .list { display: none; }
  .frame:not(.has-open) .open { display: none; }
  .open { padding: 0; border: 0; background: transparent; border-radius: 0; }
}
</style>
