<script setup lang="ts">
// Boards: your own best results, this week among friends, this week in a community.
import { computed, onMounted, ref, watch } from 'vue'
import type { CommunityId } from '../../shared/ids.ts'
import type { Board, BoardScope, GameKind } from '../../shared/play.ts'
import type { CommunitySummary } from '../../shared/social.ts'
import { api, app, messageOf } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { dateTime, relativeTime } from '../../ui/format.ts'
import { GAME } from './playText.ts'

const props = defineProps<{
  /** Communities the member belongs to. */
  communities: CommunitySummary[]
  preselect?: CommunityId | null
}>()

const SCOPES: { id: BoardScope; label: string }[] = [{ id: 'personal', label: 'Personal' }, { id: 'friends', label: 'Friends' }, { id: 'community', label: 'Community' }]
const GAMES: GameKind[] = ['lane-dash', 'eights']
const MEDAL: Record<number, string> = { 1: '🥇', 2: '🥈', 3: '🥉' }

const scope = ref<BoardScope>(props.preselect ? 'community' : 'friends')
const game = ref<GameKind>('lane-dash')
const communityId = ref<CommunityId | ''>('')
const board = ref<Board | null>(null)
const state = ref<'loading' | 'error' | 'ready'>('loading')
const error = ref('')
let generation = 0

const needsCommunity = computed(() => scope.value === 'community' && !communityId.value)
const unit = computed(() => (game.value === 'eights' ? 'wins' : 'score'))
const emptyText = computed(() => {
  const what = game.value === 'eights' ? 'won a game of Eights' : 'finished a Lane Dash run'
  if (scope.value === 'personal') return `You have not ${what} yet. Your results will be kept here.`
  return `Nobody ${scope.value === 'friends' ? 'among you and your friends' : 'in this community'} has ${what} this week.`
})

// Keep the picked community valid as the member's communities load or change.
watch(() => props.communities, list => {
  if (communityId.value && list.some(entry => entry.id === communityId.value)) return
  const wanted = props.preselect && list.find(entry => entry.id === props.preselect)
  communityId.value = wanted ? wanted.id : list[0]?.id ?? ''
}, { immediate: true })

async function load(quiet = false): Promise<void> {
  const mine = ++generation
  if (needsCommunity.value) { board.value = null; state.value = 'ready'; return }
  if (!quiet) state.value = 'loading'
  try {
    const result = await api('board.get', { scope: scope.value, game: game.value, communityId: scope.value === 'community' ? communityId.value || null : null })
    if (mine !== generation) return
    board.value = result.board
    state.value = 'ready'
  } catch (cause) {
    if (mine !== generation) return
    // A quiet refresh that fails keeps the board that is already showing.
    if (quiet && board.value) return
    error.value = messageOf(cause)
    state.value = 'error'
  }
}

onMounted(load)
watch([scope, game, () => (scope.value === 'community' ? communityId.value : '')], () => { void load() })
watch(() => app.changed.matches, () => { void load(true) })
</script>

<template>
  <div class="stack">
    <div class="row wrap">
      <div class="tabs grow" role="tablist" aria-label="Whose results">
        <button v-for="entry in SCOPES" :key="entry.id" class="tab" type="button" role="tab" :aria-selected="scope === entry.id" @click="scope = entry.id">{{ entry.label }}</button>
      </div>
      <div class="row" role="group" aria-label="Game">
        <button v-for="kind in GAMES" :key="kind" class="btn sm" :class="{ dark: game === kind }" type="button" :aria-pressed="game === kind" @click="game = kind">
          <span aria-hidden="true">{{ GAME[kind].icon }}</span>{{ GAME[kind].name }}
        </button>
      </div>
    </div>

    <label v-if="scope === 'community' && communities.length" class="field">
      <span>Community</span>
      <select v-model="communityId" class="select">
        <option v-for="entry in communities" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
      </select>
    </label>

    <StateView v-if="needsCommunity" state="empty" art="🏘" title="No community yet" message="Join a community to see its weekly board.">
      <RouterLink class="btn sm" to="/communities">Find a community</RouterLink>
    </StateView>
    <StateView v-else-if="state !== 'ready' || !board" :state="state === 'ready' ? 'loading' : state" :message="error" @retry="load()" />
    <template v-else>
      <StateView v-if="!board.rows.length" state="empty" art="🏁" :title="scope === 'personal' ? 'Nothing here yet' : 'An open board'" :message="emptyText" />
      <ol v-else class="card rows" :aria-label="`${GAME[board.game].name} board`">
        <li v-for="row in board.rows" :key="`${row.member.id}:${row.rank}`" class="board-row" :class="{ me: row.isMe }">
          <span class="rank num"><span class="sr-only">Rank {{ row.rank }}</span><span aria-hidden="true">{{ scope !== 'personal' && MEDAL[row.rank] ? MEDAL[row.rank] : row.rank }}</span></span>
          <MemberBadge :member-id="row.member.id" :look="row.member.look" :size="34" />
          <span class="grow who">
            <span class="row" style="gap: 6px"><strong class="truncate">{{ row.member.displayName }}</strong><span v-if="row.isMe" class="chip amber">You</span></span>
            <span class="muted tiny">{{ relativeTime(row.achievedAt) }}</span>
          </span>
          <span class="result num"><strong>{{ row.score.toLocaleString() }}</strong> <span class="muted tiny">{{ row.score === 1 && unit === 'wins' ? 'win' : unit }}</span></span>
        </li>
      </ol>
      <p class="muted tiny">
        {{ board.rules }}
        <template v-if="board.resetsAt"> Next reset {{ relativeTime(board.resetsAt) }} ({{ dateTime(board.resetsAt) }} your time).</template>
      </p>
    </template>
  </div>
</template>

<style scoped>
.rows { list-style: none; margin: 0; padding: 4px 10px; }
.board-row { display: flex; align-items: center; gap: 10px; padding: 8px 4px; min-width: 0; }
.board-row + .board-row { border-top: 1px solid var(--line); }
.board-row.me { margin: 0 -6px; padding: 8px 10px; border-radius: 10px; background: var(--accent-soft); border-top-color: transparent; }
.board-row.me + .board-row { border-top-color: transparent; }
.rank { width: 26px; text-align: center; font-weight: 750; flex: none; }
.who { display: flex; flex-direction: column; min-width: 0; }
.result { white-space: nowrap; }
.result strong { font-size: 1.05rem; }
/* Small buttons grow to a full touch target on touch screens. */
@media (pointer: coarse) { .btn.sm { min-height: 40px; padding: 0 14px; } }
</style>
