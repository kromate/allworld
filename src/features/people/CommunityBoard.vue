<script setup lang="ts">
// This week's community boards for both games. Scores are for play only.
import type { CommunityId } from '../../shared/ids.ts'
import type { GameKind } from '../../shared/play.ts'
import { api, app } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count, dateTime, relativeTime } from '../../ui/format.ts'
import { GAME } from './labels.ts'

const props = defineProps<{ communityId: CommunityId; communityName: string }>()
const GAMES: GameKind[] = ['lane-dash', 'eights']
const TINT: Record<GameKind, string> = { 'lane-dash': 'tint-grape', eights: 'tint-sky' }

const { data, state, error, reload } = useLoad(
  () => Promise.all(GAMES.map(async game => (await api('board.get', { scope: 'community', game, communityId: props.communityId })).board)),
  [() => app.changed.matches, () => app.changed.communities],
)
/** "2026-W40" → "Week 40". */
const weekLabel = (week: string | null): string => { const number = week ? /W(\d+)$/.exec(week)?.[1] : null; return number ? `Week ${Number(number)}` : 'This week' }
</script>

<template>
  <StateView v-if="state !== 'ready' || !data" :state="state === 'ready' ? 'loading' : state" :message="error" @retry="reload" />
  <div v-else class="stack">
    <section v-for="board in data" :key="board.game" class="card stack tight" :class="TINT[board.game]" :aria-labelledby="`board-${board.game}`">
      <div class="row wrap head">
        <span class="icon-chip" :class="board.game === 'eights' ? 'sky' : 'grape'" aria-hidden="true">{{ GAME[board.game].icon }}</span>
        <div class="grow title">
          <h2 :id="`board-${board.game}`">{{ GAME[board.game].label }}</h2>
          <p class="muted tiny">{{ weekLabel(board.week) }}<template v-if="board.resetsAt"> · resets {{ dateTime(board.resetsAt) }} on your clock ({{ relativeTime(board.resetsAt) }})</template></p>
        </div>
        <RouterLink class="btn primary sm" :to="`/games?community=${communityId}`" :aria-label="`Play ${GAME[board.game].label} for the ${communityName} board`">Play</RouterLink>
      </div>

      <ol v-if="board.rows.length" class="rows">
        <li v-for="row in board.rows" :key="`${row.member.id}-${row.rank}`" class="rank-row" :class="{ me: row.isMe }">
          <span class="rank num" :class="{ first: row.rank === 1 }"><span class="sr-only">Rank </span>{{ row.rank }}</span>
          <MemberBadge :member-id="row.member.id" :look="row.member.look" :size="32" />
          <span class="grow name"><strong class="truncate">{{ row.member.displayName }}</strong><span v-if="row.isMe" class="chip ink">You</span></span>
          <span class="score num"><strong>{{ count(row.score, GAME[board.game].unit[0], GAME[board.game].unit[1]) }}</strong></span>
        </li>
      </ol>
      <p v-else class="notice">Nobody is on this week’s board yet. Play a round to put the first name on it.</p>

      <p class="muted tiny">{{ board.rules }}</p>
    </section>
    <p class="muted tiny note"><span aria-hidden="true">🎲 </span>Boards are for play only. Game points and wins have no cash value.</p>
  </div>
</template>

<style scoped>
h2 { font-size: 1.05rem; }
.head { align-items: flex-start; }
.title { flex: 1 1 150px; }
.rows { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 4px; }
.rank-row { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 6px 8px; border-radius: 12px; background: rgba(255, 255, 255, 0.7); border: 1px solid var(--line); }
.rank-row.me { border-color: #e9b752; background: var(--accent-soft); }
.rank { display: grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--surface-3); font-size: 0.82rem; font-weight: 700; flex: none; }
.rank.first { background: var(--accent); color: var(--accent-ink); }
.name { display: flex; align-items: center; gap: 6px; }
.score { flex: none; font-size: 0.92rem; }
.note { text-align: center; }
</style>
