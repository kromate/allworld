<script setup lang="ts">
// One community: what it is about, then posts, members and this week's board for the people in
// it. Someone who has not joined a public community sees what it is and how to join.
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CommunityId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import type { CommunityDetail } from '../../shared/social.ts'
import { api, app, messageOf, onAccountReset, toast } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count } from '../../ui/format.ts'
import CommunityBoard from './CommunityBoard.vue'
import CommunityMembers from './CommunityMembers.vue'
import CommunityPosts from './CommunityPosts.vue'
import TabStrip from './TabStrip.vue'
import { ROLE, keepKeysInWindow, topicMeta } from './labels.ts'

const TAB_IDS = ['posts', 'members', 'board'] as const
type TabId = (typeof TAB_IDS)[number]
const BACK = '/communities'

const route = useRoute()
const router = useRouter()
const communityId = String(route.params.id) as CommunityId

/** `null` means the service says there is no such community for this member (or it is invite-only). */
const { data, state, error, reload } = useLoad<{ community: CommunityDetail | null }>(async () => {
  try { return await api('community.get', { communityId }) } catch (cause) {
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid')) return { community: null }
    throw cause
  }
}, [() => app.changed.communities])

const community = computed(() => data.value?.community ?? null)
const topic = computed(() => topicMeta(community.value?.topic ?? 'other'))
const isMember = computed(() => Boolean(community.value?.myRole))
/** An invite-only community only opens for a non-member who holds an invitation. */
const invited = computed(() => Boolean(community.value) && !isMember.value && community.value?.visibility === 'invite-only')
const tab = computed<TabId>(() => TAB_IDS.find(id => id === route.query.tab) ?? 'posts')
const tabs = computed(() => [
  { id: 'posts', label: 'Posts', icon: '💬' },
  { id: 'members', label: 'Members', icon: '👥' },
  { id: 'board', label: 'Board', icon: '🏆' },
])
function show(id: string): void { void router.replace({ path: route.path, query: { tab: id } }) }
function update(next: CommunityDetail): void { data.value = { community: next } }

/** Members come here for the posts, so a long description folds to two lines until asked for. */
const aboutOpen = ref(false)
const longAbout = computed(() => { const about = community.value?.about ?? ''; return about.length > 70 || about.includes('\n') })

let closed = false
const stopReset = onAccountReset(() => { closed = true })
onBeforeUnmount(() => { closed = true; stopReset() })
const joining = ref(false)
async function join(): Promise<void> {
  if (closed || joining.value) return
  joining.value = true
  try {
    const result = await api('community.join', { communityId })
    if (closed) return
    update(result.community)
    toast(`You joined ${result.community.name}.`, 'good')
  } catch (cause) {
    if (closed) return
    toast(messageOf(cause), 'bad')
    void reload()
  } finally {
    joining.value = false
  }
}
</script>

<template>
  <PanelPage class="people-window" :title="community?.name ?? 'Community'" :back="BACK" @keydown="keepKeysInWindow">
    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />

    <div v-else-if="!community" class="empty">
      <div class="art" aria-hidden="true">🧭</div>
      <h3>That community was not found</h3>
      <p class="small">It may have closed, or it is invite-only and you have not been invited. Ask a member to invite you.</p>
      <RouterLink class="btn primary" :to="BACK">Back to communities</RouterLink>
    </div>

    <template v-else>
      <section class="card stack tight" :class="invited ? 'tint-amber' : ''" aria-label="About this community">
        <div class="row top">
          <span class="icon-chip" :class="topic.tone" aria-hidden="true">{{ topic.icon }}</span>
          <div class="grow">
            <p v-if="community.about" :id="`about-${community.id}`" class="about" :class="{ clamp: isMember && longAbout && !aboutOpen }">{{ community.about }}</p>
            <p v-else class="muted small">No description yet.</p>
            <button v-if="isMember && longAbout" class="more" type="button" :aria-expanded="aboutOpen" :aria-controls="`about-${community.id}`" @click="aboutOpen = !aboutOpen">{{ aboutOpen ? 'Show less' : 'Show more' }}</button>
          </div>
        </div>
        <div class="row wrap chips">
          <span v-if="community.myRole" class="chip" :class="ROLE[community.myRole].tone">You: {{ ROLE[community.myRole].label }}</span>
          <span v-else-if="invited" class="chip coral"><span aria-hidden="true">✉</span>You’re invited</span>
          <span class="tiny muted wrap-any">{{ topic.label }} · {{ community.areaLabel }} · {{ count(community.memberCount, 'member') }} · {{ community.visibility === 'public' ? 'public' : 'invite-only' }}</span>
        </div>
        <template v-if="!isMember">
          <p class="small">{{ invited ? 'A member invited you. Join to read and write posts, see who is here and play for the weekly board.' : 'Join to read and write posts and play for the weekly board. Posts are only shown to members.' }}</p>
          <div class="row">
            <button class="btn primary" type="button" :disabled="joining" @click="join">{{ joining ? 'Joining…' : invited ? 'Accept and join' : 'Join this community' }}</button>
          </div>
        </template>
      </section>

      <template v-if="isMember">
        <TabStrip :model-value="tab" :tabs="tabs" label="Community sections" name="community" @update:model-value="show" />
        <div id="community-panel" role="tabpanel" :aria-labelledby="`community-tab-${tab}`" class="panel" :class="{ fill: tab === 'posts' }">
          <CommunityPosts v-if="tab === 'posts'" :community="community" @update="update" />
          <CommunityMembers v-else-if="tab === 'members'" :community="community" @update="update" @reload="reload" @left="router.push(BACK)" />
          <CommunityBoard v-else :community-id="community.id" :community-name="community.name" />
        </div>
      </template>
      <CommunityMembers v-else-if="community.members.length" :community="community" @update="update" @reload="reload" @left="router.push(BACK)" />
    </template>
  </PanelPage>
</template>

<style scoped src="./window.css"></style>
<style scoped>
.top { align-items: flex-start; }
.about { overflow-wrap: anywhere; white-space: pre-line; }
.about.clamp { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.more { padding: 4px 0; border: 0; background: none; color: var(--accent-text); font-size: 0.82rem; font-weight: 650; }
@media (pointer: coarse) { .more { min-height: 40px; } }
.chips { gap: 6px; }
.panel { display: flex; flex-direction: column; gap: 14px; min-width: 0; flex: none; }
/* Posts: the list of posts shrinks to what is left so the composer stays in view. */
.panel.fill { flex: 0 1 auto; min-height: 290px; }
</style>
