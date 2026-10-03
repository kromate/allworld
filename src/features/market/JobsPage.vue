<script setup lang="ts">
// Real jobs and member tasks: browse what is open, see your own listings and the applications you sent.
// Kept apart from the simulated careers on purpose.
import { computed, nextTick, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { Listing, ListingKind } from '../../shared/market.ts'
import { api, app } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count, relativeTime } from '../../ui/format.ts'
import ListingForm from './ListingForm.vue'
import { KIND, LISTING_STATUS, applicationStatus, placeText } from './labels.ts'

const route = useRoute()
const router = useRouter()

const TABS = [
  { id: 'jobs', label: 'Jobs' }, { id: 'tasks', label: 'Tasks' }, { id: 'mine', label: 'Mine' }, { id: 'applications', label: 'My applications' },
] as const
type Tab = (typeof TABS)[number]['id']

const tab = computed<Tab>(() => TABS.find(entry => entry.id === route.query.tab)?.id ?? 'jobs')
const posting = computed<ListingKind | null>(() => (route.query.new === 'task' ? 'task' : route.query.new !== undefined ? 'job' : null))
const typed = ref('')
const remoteOnly = ref(false)

const { data, state, error, reload } = useLoad(async () => {
  const [jobs, tasks, mine, applications] = await Promise.all([
    api('listing.list', { kind: 'job', mine: false }), api('listing.list', { kind: 'task', mine: false }),
    api('listing.list', { kind: null, mine: true }), api('application.mine', {}),
  ])
  return { jobs: jobs.listings, tasks: tasks.listings, mine: mine.listings, applications: applications.applications }
}, [() => app.changed.listings])

const browsing = computed(() => tab.value === 'jobs' || tab.value === 'tasks')
const all = computed<Listing[]>(() => (tab.value === 'jobs' ? data.value?.jobs : tab.value === 'tasks' ? data.value?.tasks : data.value?.mine) ?? [])
const shown = computed(() => {
  if (!browsing.value) return all.value
  const needle = typed.value.trim().toLowerCase()
  return all.value.filter(listing => (!remoteOnly.value || listing.remote)
    && (!needle || [listing.title, listing.organisation, listing.areaLabel, listing.compensation, listing.description, listing.owner.displayName].some(text => text.toLowerCase().includes(needle))))
})
const filtered = computed(() => browsing.value && (typed.value.trim() !== '' || remoteOnly.value))
/** An empty state has its own amber action, so the header button steps back… */
const nothingHere = computed(() => state.value === 'ready' && (tab.value === 'applications' ? !data.value?.applications.length : !shown.value.length))
/** …and when that action is posting, the header button would only say it twice, so it is not shown. */
const postInEmpty = computed(() => nothingHere.value && tab.value !== 'applications' && !filtered.value)
const waiting = computed(() => (data.value?.mine ?? []).reduce((sum, listing) => sum + (listing.status === 'open' ? listing.applicationCount ?? 0 : 0), 0))

async function show(next: Tab): Promise<void> { await router.replace({ path: '/jobs', query: next === 'jobs' ? {} : { tab: next } }) }
/** Left and right arrows move between the tabs and take the focus along, as tabs should. */
async function onTabKey(event: KeyboardEvent): Promise<void> {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const index = TABS.findIndex(entry => entry.id === tab.value)
  const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]
  if (!next) return
  const group = event.currentTarget as HTMLElement
  await show(next.id)
  await nextTick()
  const chosen = group.querySelector<HTMLElement>('[aria-selected="true"]')
  if (!chosen) return
  chosen.focus({ preventScroll: true })
  // On a phone the tab strip scrolls sideways: keep the chosen tab inside it, without moving anything else.
  const strip = group.getBoundingClientRect(), box = chosen.getBoundingClientRect()
  if (box.left < strip.left) group.scrollLeft += box.left - strip.left - 4
  else if (box.right > strip.right) group.scrollLeft += box.right - strip.right + 4
}
const post = (kind: ListingKind): void => { void router.push({ path: '/jobs', query: { new: kind } }) }
function clearFilters(): void { typed.value = ''; remoteOnly.value = false }
</script>

<template>
  <PanelPage :title="posting ? 'Post a listing' : 'Jobs and tasks'" :subtitle="posting ? undefined : 'Real listings from members, apart from game work'" :back="posting ? '/jobs' : undefined" wide>
    <template v-if="!posting" #actions>
      <button v-if="!postInEmpty" class="btn sm" :class="{ primary: !nothingHere }" type="button" aria-label="Post a listing" @click="post(tab === 'tasks' ? 'task' : 'job')"><span aria-hidden="true">＋</span><span class="long">Post a listing</span><span class="short">Post</span></button>
    </template>

    <!-- Said in full where it matters: when posting. Browsing carries the short form under the title, and a listing says what is and is not sent when applying. -->
    <p v-if="posting" class="notice sky"><span aria-hidden="true">📋</span><span>Real listings posted by members. Separate from the simulated work in Go to work — a game level is never shown to a listing owner.</span></p>

    <ListingForm v-if="posting" :listing="null" :kind="posting" @saved="router.replace(`/jobs/${$event.id}`)" @cancel="router.push('/jobs')" />

    <template v-else>
      <div class="tabs" role="tablist" aria-label="Jobs and tasks" @keydown="onTabKey">
        <button v-for="entry in TABS" :key="entry.id" class="tab" type="button" role="tab" :aria-selected="tab === entry.id" :tabindex="tab === entry.id ? 0 : -1" @click="show(entry.id)">
          {{ entry.label }}<span v-if="entry.id === 'mine' && waiting" class="count num" :title="`${waiting} applications on your open listings`">{{ waiting }}</span>
        </button>
      </div>

      <form v-if="browsing && (all.length || filtered)" class="row filters" role="search" @submit.prevent>
        <label class="grow">
          <span class="sr-only">Search {{ tab }}</span>
          <input v-model="typed" class="input" type="search" maxlength="80" :placeholder="tab === 'jobs' ? 'Search jobs by title, organisation or area' : 'Search tasks by title or area'" autocomplete="off" />
        </label>
        <button class="btn" :class="{ dark: remoteOnly }" type="button" :aria-pressed="remoteOnly" @click="remoteOnly = !remoteOnly">Remote</button>
      </form>

      <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />

      <!-- My applications -->
      <template v-else-if="tab === 'applications'">
        <StateView v-if="!data?.applications.length" state="empty" art="✉️" title="You have not applied to anything yet" message="When you apply to a job or a task, it appears here with its answer.">
          <button class="btn primary" type="button" @click="show('jobs')">Browse jobs</button>
        </StateView>
        <ul v-else class="rows">
          <li v-for="application in data.applications" :key="application.id">
            <RouterLink class="card interactive listing" :class="{ quiet: application.status === 'declined' || application.status === 'withdrawn' }" :to="`/jobs/${application.listing.id}`">
              <span class="icon-chip" :class="KIND[application.listing.kind].tone" aria-hidden="true">{{ KIND[application.listing.kind].icon }}</span>
              <span class="grow text">
                <strong class="title">{{ application.listing.title }}</strong>
                <span class="muted small truncate">{{ KIND[application.listing.kind].label }}{{ application.listing.organisation ? ` · ${application.listing.organisation}` : '' }}</span>
                <span class="row wrap meta">
                  <span class="chip" :class="applicationStatus(application.status, 'applicant').tone">{{ applicationStatus(application.status, 'applicant').label }}</span>
                  <span class="tiny muted">Applied {{ relativeTime(application.createdAt) }}{{ application.decidedAt ? ` · answered ${relativeTime(application.decidedAt)}` : '' }}</span>
                </span>
              </span>
            </RouterLink>
          </li>
        </ul>
      </template>

      <!-- Listings -->
      <template v-else>
        <StateView v-if="!shown.length && filtered" state="empty" art="🔎" title="Nothing matches" message="No open listing fits that search. Try another word, or clear the filters.">
          <button class="btn primary" type="button" @click="clearFilters">Clear filters</button>
        </StateView>
        <StateView
          v-else-if="!shown.length && tab === 'mine'" state="empty" art="📌" title="You have not posted anything"
          message="Post a job or a task and members can apply. You read each application and decide."
        >
          <button class="btn primary" type="button" @click="post('job')">Post a listing</button>
        </StateView>
        <StateView
          v-else-if="!shown.length" state="empty" :art="tab === 'jobs' ? '💼' : '🧰'" :title="tab === 'jobs' ? 'No jobs are open right now' : 'No tasks are open right now'"
          :message="tab === 'jobs' ? 'When a member posts a job it appears here. You can post one yourself.' : 'When a member needs a hand it appears here. You can ask for help yourself.'"
        >
          <button class="btn primary" type="button" @click="post(tab === 'tasks' ? 'task' : 'job')">{{ tab === 'jobs' ? 'Post a job' : 'Post a task' }}</button>
        </StateView>

        <template v-else>
          <div v-if="filtered" class="row between wrap summary">
            <span class="tiny muted" role="status">{{ count(shown.length, 'listing') }} of {{ all.length }}</span>
            <button class="btn ghost sm" type="button" @click="clearFilters">Clear filters</button>
          </div>
          <ul class="rows">
            <li v-for="listing in shown" :key="listing.id">
              <RouterLink class="card interactive listing" :class="{ quiet: listing.status !== 'open' }" :to="`/jobs/${listing.id}`">
                <span class="icon-chip" :class="KIND[listing.kind].tone" aria-hidden="true">{{ KIND[listing.kind].icon }}</span>
                <span class="grow text">
                  <strong class="title">{{ listing.title }}</strong>
                  <span class="muted small truncate">{{ listing.organisation || `Posted by ${listing.owner.displayName}` }}</span>
                  <span class="facts small">
                    <span><span aria-hidden="true">📍 </span><span class="sr-only">Where: </span>{{ placeText(listing) }}</span>
                    <span><span aria-hidden="true">🤝 </span><span class="sr-only">Compensation: </span>{{ listing.compensation || 'Compensation not stated' }}</span>
                  </span>
                  <span class="row wrap meta">
                    <span v-if="tab === 'mine'" class="chip" :class="LISTING_STATUS[listing.status].tone">{{ LISTING_STATUS[listing.status].label }}</span>
                    <span v-if="tab === 'mine'" class="chip" :class="KIND[listing.kind].tone">{{ KIND[listing.kind].label }}</span>
                    <span v-if="listing.applicationCount !== null" class="chip" :class="listing.applicationCount ? 'amber' : ''">{{ listing.applicationCount ? count(listing.applicationCount, 'application') : 'No applications yet' }}</span>
                    <span v-if="listing.myApplication" class="chip" :class="applicationStatus(listing.myApplication, 'applicant').tone">Applied · {{ applicationStatus(listing.myApplication, 'applicant').label }}</span>
                    <span class="tiny muted">Posted {{ relativeTime(listing.createdAt) }}</span>
                  </span>
                </span>
              </RouterLink>
            </li>
          </ul>
          <p v-if="all.length >= 100" class="tiny muted">Showing the newest 100.</p>
        </template>
      </template>
    </template>
  </PanelPage>
</template>

<style scoped>
.short { display: none; }
.filters { gap: 8px; }
.rows { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(320px, 100%), 1fr)); gap: 8px; }
.rows > li { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr); }
.listing { display: flex; align-items: flex-start; gap: 12px; color: inherit; text-decoration: none; min-width: 0; }
.listing.quiet { background: var(--surface-2); }
.text { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.title { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.facts { display: flex; flex-direction: column; gap: 1px; color: var(--ink-2); }
.facts > span { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.meta { gap: 6px; margin-top: 2px; min-width: 0; }
.meta .chip { display: inline-block; max-width: 100%; overflow: hidden; text-overflow: ellipsis; }
.summary { min-height: 32px; margin-bottom: -6px; }
@media (max-width: 480px) {
  .long { display: none; }
  .short { display: inline; }
  /* All four tabs fit a 360 px sheet without scrolling sideways. */
  .tabs .tab { padding: 0 8px; }
}
</style>
