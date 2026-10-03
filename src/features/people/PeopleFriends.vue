<script setup lang="ts">
// Friends tab: who is online first and where they are (in words), what you can do together, and
// removing a friend. The list is the service's: friends both accepted, and a friendship the
// service made (the creator's), which is listed and counted but marked as what it is.
import { computed, onMounted, ref } from 'vue'
import { FRIENDS_AUTOMATIC_LISTED } from '../../shared/creator.ts'
import type { PublicMember } from '../../shared/model.ts'
import { api, app, messageOf, myId, toast } from '../../state/app.ts'
import { refreshAround, social } from '../../state/social.ts'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count } from '../../ui/format.ts'
import { isAutomaticFriend } from '../creator/creatorView.ts'
import ConfirmAction from './ConfirmAction.vue'
import MemberCard from './MemberCard.vue'

const { data, state, error, reload } = useLoad(() => api('friends.list', {}), [() => app.changed.friends])
const query = ref('')
const removing = ref<string | null>(null)
/** A friend blocked here is gone at once, even when the list could not be read again yet. */
const friends = computed(() => (data.value?.friends ?? []).filter(friend => !app.blocked.some(entry => entry.id === friend.id)))
/** How many friends there are, as the service counts them. The list can be shorter: see `unlisted`. */
const total = computed(() => data.value?.total ?? 0)
/** Friends who exist and are not in this answer: the service lists a bounded number of automatic friendships. */
const unlisted = computed(() => Math.max(0, total.value - (data.value?.friends.length ?? 0)))
const shown = computed(() => {
  const text = query.value.trim().toLowerCase()
  return friends.value.filter(friend => !text || friend.displayName.toLowerCase().includes(text))
})
const online = computed(() => shown.value.filter(friend => friend.online))
const offline = computed(() => shown.value.filter(friend => !friend.online))
onMounted(() => { void refreshAround() })
/** Where a friend's character is, as the friend chose to share it, and unread messages from them. */
const presence = computed(() => new Map((social.around?.friends ?? []).map(entry => [entry.member.id, entry])))
function whereWords(friend: PublicMember): string | undefined {
  const entry = presence.value.get(friend.id)
  if (!entry || entry.where.hidden) return friend.online ? 'Online now' : undefined
  const words = entry.where.words
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** What removing means differs: an accepted friendship needs a new introduction; an automatic one is simply not made again. */
const removeQuestion = (friend: PublicMember): string => (isAutomaticFriend(friend)
  ? `Remove ${friend.displayName} from your friends? You will not be connected again automatically. What you wrote to each other stays readable.`
  : `Remove ${friend.displayName} from your friends? This cannot be undone here: becoming friends again needs a new introduction, and friends-only homes close to each other.`)

async function remove(friend: PublicMember): Promise<void> {
  if (removing.value) return
  const actor = myId()
  removing.value = friend.id
  try {
    const result = await api('friends.remove', { memberId: friend.id })
    // The session changed hands while this was on its way: its answer is not this member's to show.
    if (actor !== myId()) return
    data.value = result
    // A list read that began before this answer could still land after it and bring the friend back: read again.
    void reload()
    toast(isAutomaticFriend(friend) ? `${friend.displayName} is no longer in your friends. You will not be connected again automatically.` : `${friend.displayName} is no longer in your friends.`, 'good')
  } catch (cause) {
    if (actor === myId()) toast(messageOf(cause), 'bad')
  } finally {
    removing.value = null
  }
}
</script>

<template>
  <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />
  <StateView v-else-if="!total && !friends.length" state="empty" art="🤝" title="No friends yet" message="Friends are people who accepted an introduction, or whose introduction you accepted. Start with someone nearby.">
    <RouterLink class="btn primary sm" to="/people?tab=nearby">Find people nearby</RouterLink>
  </StateView>
  <div v-else class="stack">
    <!-- The service's own count. When the list is shorter, say so: nobody was removed. -->
    <p class="small muted" role="status">
      <strong class="num">{{ count(total, 'friend') }}</strong>
      <template v-if="unlisted"> · {{ friends.length }} listed here. Everyone you accepted is listed, with the {{ FRIENDS_AUTOMATIC_LISTED }} newest automatic friendships. The other {{ unlisted }} are still your friends; they are only left out of this list.</template>
    </p>
    <input v-if="friends.length > 6" v-model="query" class="input" type="search" :placeholder="unlisted ? 'Filter the listed friends by name' : 'Filter friends by name'" :aria-label="unlisted ? 'Filter the listed friends by name' : 'Filter friends by name'" />
    <StateView v-if="!shown.length" state="empty" art="🔎" :message="unlisted ? 'No listed friend matches that name.' : 'No friend matches that name.'">
      <button class="btn sm" type="button" @click="query = ''">Show all friends</button>
    </StateView>
    <section v-for="group in [{ id: 'online', title: 'Online now', list: online }, { id: 'offline', title: 'Not online', list: offline }]" v-show="group.list.length" :key="group.id" class="stack tight" :aria-labelledby="`friends-${group.id}`">
      <div class="section-head"><h2 :id="`friends-${group.id}`"><span v-if="group.id === 'online'" class="live-dot" aria-hidden="true"></span>{{ group.title }}</h2></div>
      <ul class="plain-list">
        <li v-for="friend in group.list" :key="friend.id" class="card stack tight">
          <RouterLink v-if="presence.get(friend.id)?.unread" class="chip coral unread" :to="`/messages/${presence.get(friend.id)!.conversationId}`">{{ presence.get(friend.id)!.unread }} unread {{ presence.get(friend.id)!.unread === 1 ? 'message' : 'messages' }}</RouterLink>
          <!-- Removing a friend is rare and final, so it waits under More with block and report. -->
          <MemberCard :member="{ ...friend, areaLabel: null }" :subtitle="whereWords(friend)" compact @changed="reload">
            <template #more>
              <ConfirmAction
                label="Remove friend" button-class="sm ghost danger" confirm-label="Remove friend" cancel-label="Keep" :busy="removing === friend.id" :disabled="removing !== null && removing !== friend.id"
                :tone="isAutomaticFriend(friend) ? 'amber' : 'coral'" :question="removeQuestion(friend)"
                @confirm="remove(friend)"
              />
            </template>
          </MemberCard>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.unread { align-self: flex-start; text-decoration: none; }
.live-dot { display: inline-block; width: 9px; height: 9px; margin-right: 7px; border-radius: 50%; background: var(--leaf); }
</style>
