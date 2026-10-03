<script setup lang="ts">
// A community's posts, oldest first with the newest at the bottom, and the box to write one.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CommunityDetail, CommunityPost } from '../../shared/social.ts'
import { api, messageOf, myId, onAccountReset, toast } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { relativeTime } from '../../ui/format.ts'
import ConfirmAction from './ConfirmAction.vue'

const props = defineProps<{ community: CommunityDetail }>()
const emit = defineEmits<{ update: [community: CommunityDetail] }>()

const POST_MAX = 500
/** The service sends the most recent posts only. */
const WINDOW = 60
const me = myId()
let closed = false
const stopReset = onAccountReset(() => { closed = true })
onBeforeUnmount(() => { closed = true; stopReset() })
const text = ref('')
const sending = ref(false)
const removing = ref<string | null>(null)
const log = ref<HTMLElement | null>(null)
const unseen = ref(false)
/** True while the reader is at the bottom, so new posts keep the view there. */
let pinned = true

const canModerate = computed(() => props.community.myRole === 'owner' || props.community.myRole === 'moderator')
const canRemove = (post: CommunityPost): boolean => !post.removed && (post.author.id === me || canModerate.value)
const left = computed(() => POST_MAX - text.value.length)

function onScroll(): void {
  const element = log.value
  if (!element) return
  pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 80
  if (pinned) unseen.value = false
}
async function toBottom(): Promise<void> {
  await nextTick()
  const element = log.value
  if (element) element.scrollTop = element.scrollHeight
  pinned = true
  unseen.value = false
}
watch(() => props.community.posts[props.community.posts.length - 1]?.id, (latest, before) => {
  if (latest === before) return
  if (pinned) void toBottom()
  else unseen.value = true
})
onMounted(toBottom)

async function post(): Promise<void> {
  const body = text.value.trim()
  if (closed || !body || sending.value) return
  sending.value = true
  let result
  try { result = await api('community.post', { communityId: props.community.id, text: body }) }
  catch (error) { if (!closed) toast(messageOf(error), 'bad'); return }
  finally { sending.value = false }
  if (closed) return
  // Words typed while this one was sending belong to the next post.
  if (text.value.trim() === body) text.value = ''
  pinned = true
  emit('update', result.community)
  void toBottom()
}
function onKey(event: KeyboardEvent): void {
  if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void post() }
}

async function remove(entry: CommunityPost): Promise<void> {
  if (closed || removing.value) return
  removing.value = entry.id
  try {
    const result = await api('community.removePost', { communityId: props.community.id, postId: entry.id })
    if (closed) return
    toast('Post removed.', 'good')
    emit('update', result.community)
  } catch (error) { if (!closed) toast(messageOf(error), 'bad') }
  finally { removing.value = null }
}
</script>

<template>
  <div class="posts">
    <div class="log-wrap">
      <div ref="log" class="log" role="log" tabindex="0" :aria-label="`Posts in ${community.name}, oldest first`" @scroll.passive="onScroll">
        <p v-if="community.posts.length >= WINDOW" class="muted tiny earlier">Showing the latest {{ WINDOW }} posts.</p>
        <div v-if="!community.posts.length" class="empty quiet">
          <div class="art" aria-hidden="true">💬</div>
          <p class="small">No posts yet. Say hello to start things off.</p>
        </div>
        <article v-for="entry in community.posts" :key="entry.id" class="post" :class="{ mine: entry.author.id === me, removed: entry.removed }">
          <MemberBadge :member-id="entry.author.id" :look="entry.author.look" :size="30" />
          <div class="grow">
            <div class="row meta">
              <strong class="truncate">{{ entry.author.displayName }}</strong>
              <span v-if="entry.author.id === me" class="chip ink">You</span>
              <span class="muted tiny when">{{ relativeTime(entry.at) }}</span>
            </div>
            <p v-if="entry.removed" class="muted small gone">This post was removed.</p>
            <p v-else class="text">{{ entry.text }}</p>
            <ConfirmAction
              v-if="canRemove(entry)" :label="entry.author.id === me ? 'Delete' : 'Remove'" button-class="sm ghost tiny-btn" :busy="removing !== null"
              :confirm-label="entry.author.id === me ? 'Delete post' : 'Remove post'" cancel-label="Keep"
              :question="entry.author.id === me ? 'Delete your post? It cannot be restored.' : `Remove this post by ${entry.author.displayName}? It cannot be restored.`"
              @confirm="remove(entry)"
            />
          </div>
        </article>
      </div>
      <button v-if="unseen" class="btn sm dark jump" type="button" @click="toBottom">New posts <span aria-hidden="true">↓</span></button>
    </div>

    <form class="composer stack tight" @submit.prevent="post">
      <label class="field">
        <span class="sr-only">Write a post to {{ community.name }}</span>
        <textarea v-model="text" class="textarea" :maxlength="POST_MAX" rows="2" :placeholder="`Write to ${community.name}`" @keydown="onKey"></textarea>
      </label>
      <div class="row">
        <span class="tiny num grow" :class="left <= 40 ? 'low' : 'muted'">{{ text.length }} / {{ POST_MAX }}<template v-if="left <= 40"> · {{ left }} left</template></span>
        <span class="tiny muted keys"><span class="kbd">Ctrl</span> or <span class="kbd">⌘</span> + <span class="kbd">Enter</span> posts</span>
        <button class="btn primary" type="submit" :disabled="sending || !text.trim()">{{ sending ? 'Posting…' : 'Post' }}</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
/* The log gives way before the composer does, so the box to write in stays in view on a phone. */
.posts { display: flex; flex-direction: column; gap: 12px; flex: 0 1 auto; min-height: 0; }
.log-wrap { position: relative; display: flex; flex-direction: column; flex: 0 1 auto; min-height: 150px; }
.log { display: flex; flex-direction: column; gap: 4px; flex: 0 1 auto; min-height: 0; max-height: clamp(210px, 46vh, 520px); overflow-y: auto; padding: 8px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overscroll-behavior: contain; }
.log > * { flex: none; }
.composer { flex: none; }
.earlier { text-align: center; padding: 2px 0 6px; }
.empty.quiet { border: 0; background: transparent; padding: 22px 12px; }
.post { display: flex; align-items: flex-start; gap: 10px; padding: 8px; border-radius: 12px; }
.post.mine { background: var(--accent-soft); }
.meta { gap: 6px; min-width: 0; }
.when { flex: none; }
.text { white-space: pre-wrap; overflow-wrap: anywhere; }
.gone { font-style: italic; }
.post :deep(.tiny-btn) { min-height: 28px; padding: 0 8px; margin: 2px 0 0 -8px; font-size: 0.78rem; color: var(--muted); }
.post :deep(.tiny-btn:hover), .post :deep(.tiny-btn:focus-visible) { color: var(--danger); }
.jump { position: absolute; left: 50%; bottom: 10px; transform: translateX(-50%); box-shadow: var(--shadow); }
.composer .textarea { min-height: 64px; }
.low { color: var(--danger); font-weight: 650; }
@media (hover: none) { .keys { display: none; } }
@media (pointer: coarse) { .post :deep(.tiny-btn) { min-height: 40px; } }
</style>
