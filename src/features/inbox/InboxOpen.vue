<script setup lang="ts">
// Opening a notification marks it read and goes straight to its record. An expired or settled
// one stops here instead and says what happened and what can still be done.
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { NotificationId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import type { Notification } from '../../shared/notify.ts'
import { api } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { relativeTime } from '../../ui/format.ts'

const route = useRoute()
const router = useRouter()
const missing = ref(false)
const { data, state, error, reload } = useLoad<Notification | null>(async () => {
  try {
    const { notification } = await api('notify.open', { notificationId: String(route.params.id) as NotificationId })
    missing.value = false
    // A live one needs no stop here: go to the thing it is about.
    if (notification.state === 'active') void router.replace(notification.link)
    return notification
  } catch (cause) {
    // A malformed link is the same thing to a member as a notification that is gone or not theirs.
    // Anything else (the service is away, the connection dropped) stays an error that can be retried.
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid' || cause.code === 'forbidden')) { missing.value = true; return null }
    throw cause
  }
})

const recovery = computed(() => {
  const item = data.value
  if (!item) return null
  const who = item.actor?.displayName ?? 'them'
  if (item.category === 'challenges' && item.actor) return { text: `The invitation ran out, but you can start a new game with ${who}.`, label: `Challenge ${who}`, to: `/games?challenge=${item.actor.id}` }
  if (item.kind.startsWith('meetup')) return { text: 'The plan has passed or changed. You can see your meetups and propose a new time.', label: 'Open meetups', to: '/people?tab=meetups' }
  if (item.kind.startsWith('intro') && item.actor) return { text: `That introduction is no longer waiting. You can find ${who} in People.`, label: 'Open People', to: '/people' }
  if (item.category === 'market') return { text: 'That quote is closed. Your quotes list shows where each one stands.', label: 'Open quotes', to: '/market/quotes' }
  if (item.category === 'work') return { text: 'That shift is finished. You can start another whenever you like.', label: 'Go to work', to: '/work' }
  return { text: 'This is no longer active.', label: 'Back to inbox', to: '/inbox' }
})
</script>

<template>
  <PanelPage title="Inbox" back="/inbox">
    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />
    <StateView v-else-if="missing" state="empty" art="📭" title="This notification is unavailable" message="The link may be incomplete, or the notification has been cleared. Everything still waiting for you is in your inbox.">
      <RouterLink class="btn primary" to="/inbox">Back to inbox</RouterLink>
    </StateView>
    <template v-else-if="data && data.state !== 'active'">
      <div class="card stack" :class="data.state === 'expired' ? 'tint-coral' : 'tint-leaf'">
        <div class="row">
          <MemberBadge v-if="data.actor" :member-id="data.actor.id" :look="data.actor.look" :size="44" />
          <div class="grow">
            <span class="chip" :class="data.state === 'expired' ? 'coral' : 'leaf'">{{ data.state === 'expired' ? 'Expired' : 'Already settled' }}</span>
            <h2>{{ data.title }}</h2>
            <p class="muted small">{{ data.body }}</p>
            <p class="muted tiny">{{ relativeTime(data.createdAt) }}</p>
          </div>
        </div>
        <p v-if="recovery">{{ recovery.text }}</p>
        <div class="row wrap">
          <RouterLink v-if="recovery" class="btn primary" :to="recovery.to">{{ recovery.label }}</RouterLink>
          <RouterLink class="btn" :to="data.link">See the record anyway</RouterLink>
        </div>
      </div>
    </template>
    <div v-else class="skeleton" style="height: 80px" role="status" aria-label="Opening"></div>
  </PanelPage>
</template>
