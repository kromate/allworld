<script setup lang="ts">
// One player beside the board: portrait, name, rating, whether they are here, and their clock.
import { computed } from 'vue'
import type { ArenaPlayer } from '../../shared/arena.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { clockText, ratingText } from './arenaText.ts'

const props = defineProps<{
  player: ArenaPlayer
  /** Time left right now, counted from the service's clock. */
  leftMs: number
  daily: boolean
  /** This player's clock is the one running. */
  running: boolean
  /** It is this player's turn (the clock may not be counting yet). */
  turn: boolean
  me: boolean
  /** Set once the game is over. */
  result: 'won' | 'lost' | 'draw' | null
  showClock: boolean
  /** A game against the computer: no rating is at stake, so none is shown. */
  practice?: boolean
}>()

const low = computed(() => props.running && !props.daily && props.leftMs < 20_000)
const change = computed(() => {
  const value = props.player.ratingChange
  return value === null ? '' : value > 0 ? `+${value}` : String(value)
})
</script>

<template>
  <div class="bar" :class="{ turn, me }" :aria-label="player.name">
    <MemberBadge v-if="player.member" :member-id="player.member.id" :look="player.member.look" :size="38" :online="player.connected" />
    <span v-else class="icon-chip grape bot" aria-hidden="true">🤖</span>
    <div class="grow who">
      <span class="row name">
        <strong class="sr-only">{{ player.name }}</strong>
        <span v-if="me" class="chip amber">You</span>
        <span v-if="result === 'won'" class="chip leaf">Won</span>
        <span v-else-if="result === 'draw'" class="chip">Draw</span>
        <span v-if="player.member && !player.connected && !result" class="chip coral">Away</span>
      </span>
      <span class="tiny muted truncate">
        <template v-if="player.computer">Practice opponent</template>
        <template v-else-if="practice">Practice game — not rated</template>
        <template v-else>
          Rating {{ ratingText(player) }}<span v-if="change" class="num" :class="player.ratingChange! >= 0 ? 'up' : 'down'"> {{ change }}</span>
        </template>
      </span>
    </div>
    <div v-if="showClock" class="clock num" :class="{ running, low }" role="timer" :aria-label="`${player.name}: ${clockText(leftMs, daily)} left`">
      <span class="dot" aria-hidden="true"></span>{{ clockText(leftMs, daily) }}
    </div>
  </div>
</template>

<style scoped>
.bar { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 14px; border: 1px solid transparent; min-width: 0; }
.bar.turn { background: var(--surface); border-color: var(--line); box-shadow: var(--shadow); }
.bot { width: 38px; height: 38px; border-radius: 32%; }
.who { display: flex; flex-direction: column; min-width: 0; }
.name { gap: 6px; min-width: 0; }
.up, .down { margin-left: 4px; }
.up { color: #1f7447; font-weight: 700; }
.down { color: var(--danger); font-weight: 700; }
.clock { display: inline-flex; align-items: center; gap: 6px; padding: 6px 11px; border-radius: 11px; background: var(--surface-3); color: var(--ink-2); font-weight: 750; font-size: 1.08rem; white-space: nowrap; flex: none; }
.clock .dot { width: 7px; height: 7px; border-radius: 50%; background: #c9c0af; }
.clock.running { background: var(--ink); color: #fff; }
.clock.running .dot { background: var(--accent); animation: tick 1s steps(2, start) infinite; }
.clock.low { background: var(--danger); }
.clock.low .dot { background: #fff; }
@keyframes tick { 50% { opacity: 0.2; } }
</style>
