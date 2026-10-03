<script setup lang="ts">
// One chess piece, drawn for this game: flat ivory or charcoal shapes with a dark outline and a
// few inner lines. An original set (no outside artwork). `piece` is a letter: upper case for
// White, lower case for Black — p n b r q k.
import { computed } from 'vue'

const props = defineProps<{ piece: string }>()
const kind = computed(() => props.piece.toLowerCase())
const white = computed(() => props.piece !== kind.value)
</script>

<template>
  <svg class="chess-piece" :class="white ? 'white' : 'black'" viewBox="0 0 100 100" aria-hidden="true" focusable="false">
    <g class="shape">
      <template v-if="kind === 'p'">
        <path d="M42 50 C42 62 33 68 31 81 H69 C67 68 58 62 58 50 Z" />
        <rect x="35.5" y="43.5" width="29" height="7.5" rx="3.75" />
        <circle cx="50" cy="31.5" r="11.5" />
      </template>

      <template v-else-if="kind === 'r'">
        <path d="M36.5 40 L33 81 H67 L63.5 40 Z" />
        <path d="M29 17 h9.5 v6.5 h7 v-6.5 h9 v6.5 h7 v-6.5 h9.5 v15 l-5 8 h-32 l-5 -8 Z" />
        <path class="line" d="M31 32 H69" />
        <path class="line" d="M35.5 70 H64.5" />
      </template>

      <template v-else-if="kind === 'n'">
        <path d="M31 81 C32 68 44 63 45 52 C40 56 34 61 27.5 59 C22 57.5 20.5 51 24 46.5 C29 40 34 31 41 25.5 L42.5 12.5 L51 21 C67 25 75 46 70 81 Z" />
        <path class="line" d="M54.5 27 C63.5 36 67 54 63.5 74" />
        <circle class="dot" cx="40.5" cy="34" r="2.6" />
        <circle class="dot" cx="26.5" cy="51.5" r="1.5" />
      </template>

      <template v-else-if="kind === 'b'">
        <path d="M43 56 C44 67 35 71 32 81 H68 C65 71 56 67 57 56 Z" />
        <path d="M50 19.5 C61.5 28.5 65.5 40 58 51.5 H42 C34.5 40 38.5 28.5 50 19.5 Z" />
        <rect x="35.5" y="50" width="29" height="7.5" rx="3.75" />
        <circle cx="50" cy="15" r="4.8" />
        <path class="line" d="M55.5 27.5 L47.5 38.5" />
      </template>

      <template v-else-if="kind === 'q'">
        <path d="M35 66 C36 73 32 76 31 81 H69 C68 76 64 73 65 66 Z" />
        <path d="M23.5 33 L33 62 H67 L76.5 33 L63.5 49 L62 26 L55.5 47 L50 21 L44.5 47 L38 26 L36.5 49 Z" />
        <rect x="30.5" y="59.5" width="39" height="7.5" rx="3.75" />
        <circle cx="23.5" cy="30.5" r="4.2" />
        <circle cx="38" cy="23.5" r="4.2" />
        <circle cx="50" cy="18.5" r="4.2" />
        <circle cx="62" cy="23.5" r="4.2" />
        <circle cx="76.5" cy="30.5" r="4.2" />
      </template>

      <template v-else>
        <path d="M35 66 C36 73 32 76 31 81 H69 C68 76 64 73 65 66 Z" />
        <path d="M46.8 7.5 h6.4 v6 h6 v6.4 h-6 v9 h-6.4 v-9 h-6 v-6.4 h6 Z" />
        <path d="M27.5 37 C27 27 44 24.5 50 34 C56 24.5 73 27 72.5 37 L66 62 H34 Z" />
        <rect x="30.5" y="59.5" width="39" height="7.5" rx="3.75" />
        <path class="line" d="M50 34 V59.5" />
      </template>

      <path d="M25.5 89.5 v-2 q0 -6.5 6.5 -6.5 h36 q6.5 0 6.5 6.5 v2 Z" />
    </g>
  </svg>
</template>

<style scoped>
.chess-piece { display: block; width: 100%; height: 100%; overflow: visible; }
.shape > * { stroke-width: 3.2; stroke-linejoin: round; stroke-linecap: round; }
.white .shape > * { fill: #fdf8ec; stroke: #2a2430; }
.black .shape > * { fill: #37313f; stroke: #141118; }
.shape > .line { fill: none; stroke-width: 2.6; }
.white .shape > .line { fill: none; }
.black .shape > .line { fill: none; stroke: #b3aabd; }
.white .shape > .dot { fill: #2a2430; stroke: none; }
.black .shape > .dot { fill: #c9c1d2; stroke: none; }
</style>
