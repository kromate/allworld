<script setup lang="ts">
// The in-App inbox: every reply, challenge, event and work update, each opening its own record.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { NOTIFY_CATEGORIES } from '../../shared/notify.ts'
import type { Notification, NotifyCategory } from '../../shared/notify.ts'
import { api, app, attempt } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { relativeTime } from '../../ui/format.ts'

const router = useRouter()
const filter = ref<'unread' | 'all'>('unread')
const category = ref<NotifyCategory | null>(null)
const { data, state, error, reload } = useLoad(() => api('notify.list', { includeRead: true }), [() => app.changed.notifications])

const CATEGORY: Record<NotifyCategory, { label: string; icon: string; tone: string }> = {
  replies: { label: 'Replies', icon: '💬', tone: 'sky' }, challenges: { label: 'Challenges', icon: '🎮', tone: 'grape' }, events: { label: 'Events', icon: '📅', tone: 'leaf' },
  work: { label: 'Work', icon: '💼', tone: 'amber' }, social: { label: 'People', icon: '👋', tone: 'coral' }, market: { label: 'Market', icon: '🛋', tone: 'sky' },
}
const visible = computed(() => (data.value?.notifications ?? []).filter(item =>
  (filter.value === 'all' || (!item.readAt && item.state === 'active')) && (!category.value || item.category === category.value)))
const unreadIn = (name: NotifyCategory): number => (data.value?.notifications ?? []).filter(item => item.category === name && !item.readAt && item.state === 'active').length

function open(item: Notification): void { void router.push(`/inbox/${item.id}`) }
async function readAll(): Promise<void> {
  const result = await attempt('notify.readAll', { category: category.value }, category.value ? `${CATEGORY[category.value].label} marked as read.` : 'Everything marked as read.')
  if (result) { app.unread = result.unread; await reload() }
}
</script>

<template>
  <PanelPage title="Inbox">
    <div class="tabs" role="tablist" aria-label="Show">
      <button class="tab" type="button" role="tab" :aria-selected="filter === 'unread'" @click="filter = 'unread'">Unread <span v-if="data?.unread" class="count num">{{ data.unread }}</span></button>
      <button class="tab" type="button" role="tab" :aria-selected="filter === 'all'" @click="filter = 'all'">All</button>
    </div>

    <!-- One row: which kind, and the one bulk action for what is shown. -->
    <div class="row tools">
      <label class="grow kind"><span class="sr-only">Filter by kind</span>
        <select class="select" :value="category ?? ''" @change="category = (($event.target as HTMLSelectElement).value || null) as NotifyCategory | null">
          <option value="">Everything</option>
          <option v-for="name in NOTIFY_CATEGORIES" :key="name" :value="name">{{ CATEGORY[name].label }}{{ unreadIn(name) ? ` (${unreadIn(name)} unread)` : '' }}</option>
        </select>
      </label>
      <button class="btn sm" type="button" :disabled="!data?.unread" @click="readAll">Mark {{ category ? CATEGORY[category].label.toLowerCase() : 'all' }} read</button>
    </div>

    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />
    <StateView v-else-if="!visible.length" state="empty" art="🌤" :title="filter === 'unread' ? 'You are all caught up' : 'Nothing here yet'" :message="filter === 'unread' ? 'New replies, challenges, meetups and work updates will appear here.' : 'When friends reply, challenge you or plan something, you will see it here.'">
      <button v-if="filter === 'unread' && data?.notifications.length" class="btn sm" type="button" @click="filter = 'all'">Show earlier ones</button>
    </StateView>
    <ul v-else class="items">
      <li v-for="item in visible" :key="item.id">
        <button class="card interactive item" :class="{ read: Boolean(item.readAt) || item.state !== 'active' }" type="button" @click="open(item)">
          <MemberBadge v-if="item.actor" :member-id="item.actor.id" :look="item.actor.look" :size="40" />
          <span v-else class="icon-chip" :class="CATEGORY[item.category].tone" aria-hidden="true">{{ CATEGORY[item.category].icon }}</span>
          <span class="grow">
            <span class="row" style="gap: 6px">
              <strong class="truncate">{{ item.title }}</strong>
              <span v-if="item.count > 1" class="chip num" :title="`${item.count} similar updates folded into one`">×{{ item.count }}</span>
            </span>
            <span class="muted small body">{{ item.body }}</span>
            <span class="row wrap tiny muted" style="gap: 6px">
              <span>{{ CATEGORY[item.category].label }} · {{ relativeTime(item.updatedAt) }}</span>
              <span v-if="item.state === 'expired'" class="chip coral">Expired</span>
              <span v-else-if="item.state === 'resolved'" class="chip leaf">Done</span>
            </span>
          </span>
          <span v-if="!item.readAt && item.state === 'active'" class="unread-dot" aria-label="Unread"></span>
        </button>
      </li>
    </ul>
    <p class="small muted settings-link"><RouterLink to="/settings?tab=notifications">Reminder settings</RouterLink></p>
  </PanelPage>
</template>

<style scoped>
.tools { gap: 8px; }
.kind { min-width: 0; }
.tools .select, .tools .btn { min-height: 44px; }
.tools .btn { flex: none; }
.settings-link { text-align: center; }
.settings-link a { display: inline-flex; align-items: center; min-height: 44px; }
.items { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.item { display: flex; align-items: flex-start; gap: 12px; }
.item .grow { display: flex; flex-direction: column; gap: 2px; }
.item.read { opacity: 0.72; }
.body { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.unread-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--coral); flex: none; margin-top: 6px; }
</style>
