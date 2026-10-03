<script setup lang="ts">
// How to play one game, and how a match in the hall works. A game that brings its own how-to
// (games/<game>/HowTo.vue) is shown as it is; otherwise the hall's short written steps.
import { computed } from 'vue'
import { ARENA } from '../../shared/arena.ts'
import type { ArenaGame } from '../../shared/arena.ts'
import ArenaSheet from './ArenaSheet.vue'
import { howToFor } from './arenaGames.ts'
import { GAME, HONESTY, gameName } from './arenaText.ts'

const props = defineProps<{ game: ArenaGame }>()
defineEmits<{ close: [] }>()
const own = computed(() => howToFor(props.game))
</script>

<template>
  <ArenaSheet :title="`How to play ${gameName(game)}`" wide @close="$emit('close')">
    <component :is="own" v-if="own" />
    <ol v-else class="steps">
      <li v-for="(step, index) in GAME[game].steps" :key="step.title" class="step">
        <span class="n num" aria-hidden="true">{{ index + 1 }}</span>
        <div><h3>{{ step.title }}</h3><p class="small">{{ step.text }}</p></div>
      </li>
    </ol>

    <div class="card stack tight hall">
      <h3>In the hall</h3>
      <ul class="small plain">
        <li><strong>The clock.</strong> Each player has their own time. In a live game it starts once both have made a first move; make yours within {{ ARENA.firstMoveSeconds / 60 }} minutes or the game is called off. Run out of time and you lose. A daily game gives a full day for every move.</li>
        <li><strong>Ending early.</strong> You can resign, or offer a draw the other player may accept. A game that ends before both players have moved twice is called off and counts for nothing.</li>
        <li><strong>Rated or casual.</strong> Rated games between two members move your rating (it starts at {{ ARENA.rating.start }} and is marked “?” for your first {{ ARENA.rating.provisionalGames }}). Games against the computer are practice and never rated.</li>
        <li><strong>Watching.</strong> You choose who may watch and chat: anyone, friends, one community, or nobody. Players can switch watcher chat off for themselves.</li>
        <li><strong>If you drop out.</strong> In a live game against a member you have {{ ARENA.disconnectGraceSeconds }} seconds to come back before the game is given up.</li>
      </ul>
      <p class="tiny muted">{{ HONESTY }}</p>
    </div>
  </ArenaSheet>
</template>

<style scoped>
.steps { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 12px; }
.step { display: flex; gap: 12px; align-items: flex-start; }
.n { display: grid; place-items: center; width: 28px; height: 28px; border-radius: 50%; background: var(--accent-soft); color: var(--accent-text); font-weight: 750; flex: none; }
.step p { color: var(--ink-2); margin-top: 2px; }
.plain { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; color: var(--ink-2); }
.hall { background: var(--surface-2); }
</style>
