<script setup lang="ts">
// Standings for one game: friends, a community, the member's home state, their country, and
// everybody. Two views of each table: by rating, and most wins this week.
import { computed, onMounted, ref, watch } from 'vue'
import { ARENA, ARENA_GAMES, STANDING_SCOPES } from '../../shared/arena.ts'
import type { ArenaGame, ArenaHome, MyStanding, StandingRow, StandingScope, StandingView, Standings } from '../../shared/arena.ts'
import type { CommunityId } from '../../shared/ids.ts'
import type { CommunitySummary } from '../../shared/social.ts'
import { STARTER_PLACES } from '../../shared/places.ts'
import { api, app, messageOf } from '../../state/app.ts'
import { arena } from '../../state/arena.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { count, dateTime, relativeTime } from '../../ui/format.ts'
import ArenaPrivacy from './ArenaPrivacy.vue'
import { GAME, HONESTY, SCOPE_LABEL, gameName } from './arenaText.ts'

const props = defineProps<{ communities: CommunitySummary[]; game?: ArenaGame; preselect?: CommunityId | null }>()
const emit = defineEmits<{ play: [game: ArenaGame] }>()

const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' }
const game = ref<ArenaGame>(props.game ?? 'chess')
const scope = ref<StandingScope>(props.preselect ? 'community' : 'global')
const view = ref<StandingView>('rating')
const communityId = ref<CommunityId | ''>('')

const table = ref<Standings | null>(null)
const mine = ref<{ standing: MyStanding; home: ArenaHome; publicStandings: boolean } | null>(null)
const state = ref<'loading' | 'error' | 'ready'>('loading')
const error = ref('')
let generation = 0

const needsCommunity = computed(() => scope.value === 'community' && !communityId.value)
/** The state and country tabs carry their names once the member's home area is known. */
const scopeLabel = (entry: StandingScope): string => {
  if (entry === 'state') return mine.value?.home.region ?? SCOPE_LABEL.state
  if (entry === 'country') return mine.value?.home.countryName ?? SCOPE_LABEL.country
  return SCOPE_LABEL[entry]
}
const where = computed(() => {
  const name = table.value?.scopeName
  if (scope.value === 'friends') return 'among you and your friends'
  if (scope.value === 'global') return 'in the world'
  return name ? `in ${name}` : ''
})
const pinned = computed(() => {
  const me = table.value?.me
  return me && !table.value!.rows.some(row => row.isMe) ? me : null
})
/**
 * A member whose area was saved before states were recorded is in the country and world tables
 * only. The service never guesses a state and this page never rewrites the area, so the way back
 * is the member choosing their place again. `named` is set only when the saved area is exactly one
 * of our hand-written starter places (same name, country and point), so the hint is a fact, not a guess.
 */
const needsState = computed(() => scope.value === 'state' && !table.value?.scopeName && mine.value !== null && !mine.value.home.region)
const savedArea = computed(() => app.me?.currentArea ?? app.me?.browsing ?? null)
const named = computed(() => {
  const area = savedArea.value
  if (!area || area.region) return null
  return STARTER_PLACES.find(place => place.label === area.label && place.countryCode === area.countryCode.toUpperCase() && place.anchor.lat === area.anchor.lat && place.anchor.lon === area.anchor.lon) ?? null
})
const places = computed(() => (mine.value?.standing.places ?? []).filter(place => place.rank !== null))
/** The rating card already says the member's place in this table, so the line above the rows need not. */
const placed = computed(() => places.value.some(place => place.scope === scope.value))
const placeName = (place: MyStanding['places'][number]): string => place.name ?? (place.scope === 'friends' ? 'friends' : place.scope === 'global' ? 'the world' : SCOPE_LABEL[place.scope])

watch(() => props.communities, list => {
  if (communityId.value && list.some(entry => entry.id === communityId.value)) return
  const wanted = props.preselect && list.find(entry => entry.id === props.preselect)
  communityId.value = wanted ? wanted.id : list[0]?.id ?? ''
}, { immediate: true })

async function load(quiet = false): Promise<void> {
  const run = ++generation
  if (!quiet) state.value = 'loading'
  const community = communityId.value || null
  try {
    const [standing, board] = await Promise.all([
      api('arena.myStanding', { game: game.value, communityId: community }),
      needsCommunity.value ? Promise.resolve(null) : api('arena.standings', { game: game.value, scope: scope.value, view: view.value, communityId: scope.value === 'community' ? community : null }),
    ])
    if (run !== generation) return
    mine.value = standing
    table.value = board?.standings ?? null
    state.value = 'ready'
  } catch (cause) {
    if (run !== generation) return
    if (quiet && table.value) return
    error.value = messageOf(cause)
    state.value = 'error'
  }
}

onMounted(load)
watch([game, scope, view, () => (scope.value === 'community' ? communityId.value : '')], () => { void load() })
watch(() => arena.changed, () => { void load(true) })
watch(() => props.game, next => { if (next) game.value = next })

const score = (row: StandingRow): string => (view.value === 'week' ? count(row.weekWins, 'win') : `${row.rating}${row.provisional ? '?' : ''}`)
const detail = (row: StandingRow): string => (view.value === 'week' ? `Rating ${row.rating}${row.provisional ? '?' : ''}` : `${count(row.played, 'rated game')} · ${row.won} won`)
</script>

<template>
  <div class="stack standings">
    <div class="row wrap" role="group" aria-label="Game">
      <button v-for="kind in ARENA_GAMES" :key="kind" class="btn sm" :class="{ dark: game === kind }" type="button" :aria-pressed="game === kind" @click="game = kind">
        <span aria-hidden="true">{{ GAME[kind].icon }}</span>{{ gameName(kind) }}
      </button>
    </div>

    <div v-if="mine" class="card tint-amber mine">
      <div class="row wrap between">
        <div>
          <span class="tiny muted">Your {{ gameName(game) }} rating</span>
          <div class="rating num">{{ mine.standing.rating }}<span v-if="mine.standing.provisional" class="q" title="Provisional">?</span></div>
        </div>
        <div class="small record">
          <template v-if="mine.standing.played">{{ count(mine.standing.played, 'rated game') }} · {{ mine.standing.won }} won · {{ mine.standing.drawn }} drawn · {{ mine.standing.lost }} lost</template>
          <template v-else>No rated games yet. Your rating starts at {{ ARENA.rating.start }}.</template>
          <span v-if="mine.standing.provisional && mine.standing.played" class="muted tiny hint">“?” means provisional: it settles after {{ ARENA.rating.provisionalGames }} rated games.</span>
        </div>
      </div>
      <div v-if="places.length" class="row wrap places">
        <span v-for="place in places" :key="place.scope" class="chip amber">#{{ place.rank }} of {{ place.of }} in {{ placeName(place) }}</span>
      </div>
    </div>

    <div class="tabs wrap" role="tablist" aria-label="Whose standings">
      <button v-for="entry in STANDING_SCOPES" :key="entry" class="tab" type="button" role="tab" :aria-selected="scope === entry" @click="scope = entry">{{ scopeLabel(entry) }}</button>
    </div>

    <div class="row wrap between">
      <div class="row" role="group" aria-label="Ranked by">
        <button class="btn sm" :class="{ dark: view === 'rating' }" type="button" :aria-pressed="view === 'rating'" @click="view = 'rating'">Rating</button>
        <button class="btn sm" :class="{ dark: view === 'week' }" type="button" :aria-pressed="view === 'week'" @click="view = 'week'">Wins this week</button>
      </div>
      <label v-if="scope === 'community' && communities.length" class="pick"><span class="sr-only">Community</span>
        <select v-model="communityId" class="select"><option v-for="entry in communities" :key="entry.id" :value="entry.id">{{ entry.name }}</option></select>
      </label>
    </div>

    <StateView v-if="needsCommunity" state="empty" art="🏘" title="No community yet" message="Join a community to see how its members rank.">
      <RouterLink class="btn sm" to="/communities">Find a community</RouterLink>
    </StateView>
    <StateView v-else-if="state !== 'ready' || !table" :state="state === 'ready' ? 'loading' : state" :message="error" @retry="load()" />
    <div v-else-if="needsState" class="notice sky state-fix" role="status">
      <div class="grow stack tight">
        <strong>Your state is not on record yet</strong>
        <template v-if="mine?.home.countryCode">
          <p class="small">
            <template v-if="savedArea">Your area, {{ savedArea.label }}, was saved before states were recorded, so you are in the {{ mine.home.countryName }} and world tables but not in a state table.</template>
            <template v-else>You are in the {{ mine.home.countryName }} and world tables but not in a state table, because no state is recorded for your area.</template>
          </p>
          <p class="small">
            <template v-if="named">Choose <strong>{{ named.label }}</strong> again in Settings → Area and your state becomes {{ named.region }}.</template>
            <template v-else>Search for your place again in Settings → Area and pick it from the results; the state comes with it.</template>
            “I am still here” keeps the saved area as it is, so it does not add one. Nothing changes until you choose.
          </p>
        </template>
        <p v-else class="small">Choose your area to join the standings for your state and your country.</p>
      </div>
      <RouterLink class="btn sm primary" to="/settings?tab=area">Open area settings</RouterLink>
    </div>
    <template v-else>
      <p v-if="table.me && (view === 'week' || !placed)" class="small you" role="status">You are <strong>#{{ table.me.rank }}</strong> of {{ table.total }} {{ where }}.</p>
      <p v-else-if="table.note" class="notice sky" role="status">
        <span class="grow">{{ table.note }}</span>
        <RouterLink v-if="scope === 'state' || (scope === 'country' && !mine?.home.countryCode)" class="btn sm" to="/settings?tab=area">Set your area</RouterLink>
      </p>

      <StateView v-if="!table.rows.length" state="empty" :art="GAME[game].icon" title="An open table"
        :message="view === 'week' ? `Nobody ${where || 'here'} has won a rated game of ${gameName(game)} this week. The first win takes the top spot.` : `Nobody ${where || 'here'} has finished a rated game of ${gameName(game)} yet. The first one goes straight to the top.`">
        <button class="btn primary sm" type="button" @click="emit('play', game)">Play {{ gameName(game) }}</button>
      </StateView>
      <ol v-else class="card rows" :aria-label="`${gameName(game)} standings ${where}`">
        <li v-for="row in table.rows" :key="row.memberId" class="board-row" :class="{ me: row.isMe }">
          <span class="rank num"><span class="sr-only">Rank {{ row.rank }}</span><span aria-hidden="true">{{ MEDAL[row.rank] ?? row.rank }}</span></span>
          <MemberBadge :member-id="row.memberId" :look="row.look" :size="34" />
          <span class="grow who">
            <span class="row name"><strong class="truncate">{{ row.displayName }}</strong><span v-if="row.isMe" class="chip amber">You</span></span>
            <span class="muted tiny truncate">{{ detail(row) }}</span>
          </span>
          <span class="result num"><strong>{{ score(row) }}</strong></span>
        </li>
        <li v-if="pinned" class="board-row me pinned">
          <span class="rank num"><span class="sr-only">Rank {{ pinned.rank }}</span><span aria-hidden="true">{{ pinned.rank }}</span></span>
          <MemberBadge :member-id="pinned.memberId" :look="pinned.look" :size="34" />
          <span class="grow who">
            <span class="row name"><strong class="truncate">{{ pinned.displayName }}</strong><span class="chip amber">You</span></span>
            <span class="muted tiny truncate">{{ detail(pinned) }}</span>
          </span>
          <span class="result num"><strong>{{ score(pinned) }}</strong></span>
        </li>
      </ol>

      <details class="about-table">
        <summary>{{ scope === 'state' || scope === 'country' || scope === 'global' ? 'How this table works, and whether you are shown' : 'How this table works' }}</summary>
        <div class="stack tight">
          <p class="muted tiny">
            {{ table.rules }}
            <template v-if="table.resetsAt"> Next reset {{ relativeTime(table.resetsAt) }} ({{ dateTime(table.resetsAt) }} your time).</template>
            <template v-if="scope === 'state' || scope === 'country'"> The table is for members whose home area is {{ table.scopeName ?? 'here' }}; it never shows where anyone is.</template>
            {{ HONESTY }}
          </p>
          <ArenaPrivacy v-if="scope === 'state' || scope === 'country' || scope === 'global'" @changed="load(true)" />
        </div>
      </details>
    </template>
  </div>
</template>

<style scoped>
.mine { display: flex; flex-direction: column; gap: 10px; }
.rating { font-size: 1.7rem; font-weight: 800; line-height: 1.1; letter-spacing: -0.02em; }
.q { color: var(--accent-text); font-size: 1.1rem; margin-left: 1px; }
.record { text-align: right; color: var(--ink-2); max-width: 30ch; }
.hint { display: block; }
.places { gap: 6px; }
.pick .select { min-height: 36px; padding: 4px 10px; width: auto; max-width: 220px; }
.you { color: var(--ink-2); }
.rows { list-style: none; margin: 0; padding: 4px 10px; }
.board-row { display: flex; align-items: center; gap: 10px; padding: 8px 4px; min-width: 0; }
.board-row + .board-row { border-top: 1px solid var(--line); }
.board-row.me { margin: 0 -6px; padding: 8px 10px; border-radius: 10px; background: var(--accent-soft); border-top-color: transparent; }
.board-row.me + .board-row { border-top-color: transparent; }
.board-row.pinned { margin-top: 6px; position: sticky; bottom: 0; box-shadow: 0 -6px 12px -8px rgba(40, 30, 10, 0.25); }
.rank { width: 26px; text-align: center; font-weight: 750; flex: none; }
.who { display: flex; flex-direction: column; min-width: 0; }
.name { gap: 6px; }
.result { white-space: nowrap; }
.result strong { font-size: 1.05rem; }
.about-table summary { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; font-size: 0.86rem; font-weight: 650; color: var(--ink-2); list-style: none; }
.about-table summary::-webkit-details-marker { display: none; }
.about-table summary::after { content: "▾"; color: var(--muted); }
.about-table[open] > summary::after { transform: rotate(180deg); }
@media (max-width: 480px) { .record { text-align: left; max-width: none; } }
</style>
