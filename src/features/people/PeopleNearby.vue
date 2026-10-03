<script setup lang="ts">
// Nearby tab: members who chose to be found in or next to the viewer's coarse area, plus people
// from shared communities. A reason is shown for each; a distance or position never is.
import { computed, ref } from 'vue'
import type { NearbyMember } from '../../shared/social.ts'
import { api, app } from '../../state/app.ts'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import MemberCard from './MemberCard.vue'
import type { Tone } from './labels.ts'

type Reason = NearbyMember['reason']
const { data, state, error, reload } = useLoad(() => api('nearby.list', {}), [() => app.changed.friends, () => app.changed.intros, () => app.changed.communities])

const REASON: Record<Reason, { filter: string; icon: string; tone: Tone }> = {
  'same-area': { filter: 'In your area', icon: '📍', tone: 'leaf' },
  'neighbouring-area': { filter: 'Next to your area', icon: '🧭', tone: 'sky' },
  'shared-community': { filter: 'Your communities', icon: '🏘', tone: 'grape' },
}
const REASONS = Object.keys(REASON) as Reason[]
const reasonText = (member: NearbyMember): string =>
  member.reason === 'shared-community' ? `In ${member.sharedCommunities.join(', ') || 'a community you share'}` : REASON[member.reason].filter

const only = ref<Reason | null>(null)
const query = ref('')
/** A member blocked here is gone at once, even when the list could not be read again yet. */
const members = computed(() => (data.value?.members ?? []).filter(member => !app.blocked.some(entry => entry.id === member.id)))
const reasonsPresent = computed(() => REASONS.filter(reason => members.value.some(member => member.reason === reason)))
const shown = computed(() => {
  const text = query.value.trim().toLowerCase()
  return members.value.filter(member => (!only.value || member.reason === only.value) && (!text || member.displayName.toLowerCase().includes(text)))
})

/** Which truth about discovery the header card states. */
const situation = computed(() => {
  const info = data.value
  if (!info) return null
  if (info.stale) return 'stale' as const
  if (!info.areaLabel) return 'no-area' as const
  if (!info.discoverable) return 'hidden' as const
  return 'open' as const
})
function clearFilters(): void { only.value = null; query.value = '' }
</script>

<template>
  <StateView v-if="state !== 'ready' || !data" :state="state === 'ready' ? 'loading' : state" :message="error" @retry="reload" />
  <div v-else class="stack">
    <!-- Something to put right gets a notice with its one action; when all is well it is a single quiet line. -->
    <div v-if="situation === 'no-area' || situation === 'stale'" class="notice amber state">
      <span class="grow">
        <strong>{{ situation === 'stale' ? 'Your area needs confirming.' : 'You have not said where you are.' }}</strong>
        {{ situation === 'stale' ? 'Until you confirm it you are left out of nearby lists.' : 'Choose a public place name to find members there. It is a coarse area you pick, never your position.' }}
        <template v-if="!data.discoverable"> Others cannot find you either: see <RouterLink to="/settings?tab=privacy">privacy settings</RouterLink>.</template>
      </span>
      <RouterLink class="btn primary sm" to="/settings?tab=area">{{ situation === 'stale' ? 'Confirm your area' : 'Choose your area' }}</RouterLink>
    </div>
    <div v-else-if="situation === 'hidden'" class="notice state">
      <span class="grow wrap-any"><strong>Others cannot find you.</strong> You are not discoverable, so members in {{ data.areaLabel }} do not see you, and you see only people from your communities.</span>
      <RouterLink class="btn sm" to="/settings?tab=privacy">Privacy settings</RouterLink>
    </div>
    <p v-else class="tiny muted wrap-any"><span aria-hidden="true">📍 </span>You can be found in {{ data.areaLabel }}. You see members who chose to be found in or next to it, and people from your communities. Nobody sees a distance or a position.</p>

    <template v-if="members.length">
      <div v-if="reasonsPresent.length > 1" class="row wrap" role="group" aria-label="Show members by reason">
        <button class="btn sm" :class="{ dark: only === null }" type="button" :aria-pressed="only === null" @click="only = null">Everyone</button>
        <button v-for="reason in reasonsPresent" :key="reason" class="btn sm" :class="{ dark: only === reason }" type="button" :aria-pressed="only === reason" @click="only = only === reason ? null : reason">
          <span aria-hidden="true">{{ REASON[reason].icon }}</span>{{ REASON[reason].filter }}
        </button>
      </div>
      <input v-if="members.length > 8" v-model="query" class="input" type="search" placeholder="Filter by name" aria-label="Filter members by name" />
      <ul v-if="shown.length" class="plain-list">
        <!-- Why each person is shown rides on their card as words, not as a chip above it. -->
        <li v-for="member in shown" :key="member.id" class="card">
          <MemberCard :member="member" :subtitle="`${REASON[member.reason].icon} ${reasonText(member)}${member.online ? ' · online now' : ''}`" compact @changed="reload" />
        </li>
      </ul>
      <StateView v-else state="empty" art="🔎" message="Nobody matches that filter.">
        <button class="btn sm" type="button" @click="clearFilters">Show everyone</button>
      </StateView>
    </template>
    <StateView
      v-else state="empty" art="🏘" title="Nobody to show yet"
      :message="situation === 'open' ? 'No one else has chosen to be found around here so far. Join a community to meet people who share an interest.' : 'Join a community to meet people who share an interest. They appear here as soon as you are in one together.'"
    >
      <RouterLink class="btn primary sm" to="/communities">Browse communities</RouterLink>
    </StateView>
  </div>
</template>

<style scoped>
.state { align-items: center; flex-wrap: wrap; }
.state .grow { flex-basis: 180px; }
</style>
