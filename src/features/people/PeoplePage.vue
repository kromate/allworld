<script setup lang="ts">
// People window: who is around right now, friends, introductions waiting, and meetups at public venues.
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { api, app } from '../../state/app.ts'
import { social } from '../../state/social.ts'
import { world } from '../../state/world.ts'
import AroundView from '../social/AroundView.vue'
import PanelPage from '../../ui/PanelPage.vue'
import { useLoad } from '../../ui/useLoad.ts'
import PeopleFriends from './PeopleFriends.vue'
import PeopleMeetups from './PeopleMeetups.vue'
import PeopleNearby from './PeopleNearby.vue'
import PeopleRequests from './PeopleRequests.vue'
import TabStrip from './TabStrip.vue'
import { keepKeysInWindow } from './labels.ts'

const TAB_IDS = ['nearby', 'friends', 'requests', 'meetups'] as const
type TabId = (typeof TAB_IDS)[number]

const route = useRoute()
const router = useRouter()
const tab = computed<TabId>(() => TAB_IDS.find(id => id === route.query.tab) ?? 'nearby')
const withId = computed(() => (tab.value === 'meetups' && typeof route.query.with === 'string' && route.query.with ? route.query.with : null))

// Loaded here, not in the tab, so the Requests tab can show who is waiting from any tab.
const intros = useLoad(() => api('intro.list', {}), [() => app.changed.intros, () => app.changed.friends])
const waiting = computed(() => intros.data.value?.incoming.length ?? 0)
/** Waves and invitations waiting for an answer show on the Around tab. */
const reaching = computed(() => social.waves.filter(wave => wave.status === 'pending' && !wave.mine).length + social.invites.filter(invite => !invite.mine && invite.status === 'pending').length)
const one = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

// ── A quiet Around tab ──
// Quiet is what the Around view calls quiet: nobody in the room, no friend online, nobody else in
// the city. It then says so in one line and offers the one next step. Everything else that would
// only repeat "nobody" steps back: the list of people to meet folds, and the Around view's own
// Friends and city sections are hidden (by their heading ids, in the style below) when all they
// hold is that same sentence. A member with friends keeps the Friends section and its offline
// list; a member with no area keeps the city section, which is where the area is chosen.
const around = computed(() => social.around)
/** Loaded or failed: the list of people to meet waits for this so it is mounted once, folded or not. */
const aroundSettled = computed(() => Boolean(around.value) || social.aroundState === 'error')
const quiet = computed(() => {
  const info = around.value
  return Boolean(info) && !(world.state === 'ready' && world.members.length) && !info!.friends.some(friend => friend.member.online) && info!.city.online === 0
})
const quietNoFriends = computed(() => tab.value === 'nearby' && quiet.value && !around.value?.friends.length)
const quietCity = computed(() => tab.value === 'nearby' && quiet.value && Boolean(around.value?.city.label))
// The service tells only the other person when an introduction is sent or answered, so the list
// is read again each time the tab is opened.
watch(tab, value => { if (value === 'requests') void intros.reload() })

const tabs = computed(() => [
  { id: 'nearby', label: 'Around', count: reaching.value, countLabel: `${reaching.value} waiting for your answer` },
  { id: 'friends', label: 'Friends' },
  { id: 'requests', label: 'Requests', count: waiting.value, countLabel: `${waiting.value} waiting for your answer` },
  { id: 'meetups', label: 'Meetups' },
])
function show(id: string): void { void router.replace({ path: '/people', query: { tab: id } }) }
</script>

<template>
  <PanelPage class="people-window" title="People" @keydown="keepKeysInWindow">
    <template #actions>
      <RouterLink class="btn sm" to="/communities">Communities</RouterLink>
    </template>

    <TabStrip :model-value="tab" :tabs="tabs" label="People sections" name="people" @update:model-value="show" />

    <div id="people-panel" role="tabpanel" :aria-labelledby="`people-tab-${tab}`" class="panel" :class="{ 'quiet-no-friends': quietNoFriends, 'quiet-city': quietCity }">
      <template v-if="tab === 'nearby'">
        <AroundView :highlight-wave="one(route.query.wave)" :highlight-invite="one(route.query.invite)" :highlight-hangout="one(route.query.hangout)" />
        <details v-if="quiet" class="disclosure">
          <summary><span id="people-meet">People you could meet</span></summary>
          <PeopleNearby />
        </details>
        <section v-else-if="aroundSettled" class="stack" aria-labelledby="people-meet">
          <div class="section-head"><h2 id="people-meet">People you could meet</h2></div>
          <PeopleNearby />
        </section>
      </template>
      <PeopleFriends v-else-if="tab === 'friends'" />
      <PeopleRequests
        v-else-if="tab === 'requests'" :incoming="intros.data.value?.incoming ?? []" :outgoing="intros.data.value?.outgoing ?? []"
        :state="intros.state.value" :error="intros.error.value" @reload="intros.reload"
      />
      <PeopleMeetups v-else :with-id="withId" @clear-with="show('meetups')" />
    </div>
  </PanelPage>
</template>

<style scoped src="./window.css"></style>
<style scoped>
.panel { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
/* Quiet: the Around view's opening line has already said these two things (see the script). */
.panel.quiet-no-friends :deep([aria-labelledby="around-friends"]),
.panel.quiet-city :deep([aria-labelledby="around-city"]) { display: none; }
</style>
