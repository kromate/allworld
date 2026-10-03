<script setup lang="ts">
// One letter tile, drawn to fill whatever box it is put in (the box sets --tile to its side).
// Purely a picture: whoever uses it supplies the label and the behaviour.
import { computed } from 'vue'
import { tileValue } from '../../../../shared/games/words.ts'

const props = defineProps<{
  /** 'A'–'Z', or '?' for a blank that has no letter yet. */
  letter: string
  /** A blank tile standing for `letter`: worth nothing. */
  blank?: boolean
  /** 'fresh' is a tile put down this turn and not yet played; 'last' is part of the latest move. */
  tone?: 'plain' | 'fresh' | 'last' | 'faded'
}>()

const face = computed(() => (props.letter === '?' ? '' : props.letter))
const points = computed(() => (props.blank || props.letter === '?' ? null : tileValue(props.letter)))
</script>

<template>
  <span class="tile" :class="[tone ?? 'plain', { blank: blank || letter === '?' }]" aria-hidden="true">
    <span class="face">{{ face }}</span>
    <span v-if="points !== null" class="points num">{{ points }}</span>
    <span v-else class="points none">{{ letter === '?' ? 'blank' : '' }}</span>
  </span>
</template>

<style scoped>
.tile {
  position: relative; display: grid; place-items: center; width: 100%; height: 100%; border-radius: 17%;
  background: linear-gradient(175deg, #fffdf4 0%, #fbeecb 58%, #f3dfa9 100%);
  box-shadow: inset 0 -0.11em 0 #d8bd77, inset 0 0 0 1px rgba(150, 112, 30, 0.38), 0 1px 1.5px rgba(40, 30, 10, 0.28);
  color: var(--ink); font-weight: 800; font-size: calc(var(--tile, 40px) * 0.56); line-height: 1; letter-spacing: -0.02em;
  user-select: none; -webkit-user-select: none;
}
.face { transform: translate(-4%, -5%); }
.points { position: absolute; right: 9%; bottom: 9%; font-size: max(6px, 0.4em); font-weight: 750; color: #73561a; letter-spacing: 0; }
.points.none { right: 0; left: 0; bottom: 8%; text-align: center; font-size: max(6px, 0.26em); font-weight: 700; color: #9a7a3a; text-transform: uppercase; letter-spacing: 0.04em; }

/* A blank is told apart by more than colour: slanted letter, a line under it, and no points. */
.tile.blank .face { font-style: italic; color: #a5301e; text-decoration: underline dotted; text-decoration-thickness: 0.06em; text-underline-offset: 0.12em; }

.tile.fresh {
  background: linear-gradient(175deg, #fff0bd 0%, #ffd668 60%, #ffc23c 100%);
  box-shadow: inset 0 -0.11em 0 #dc9a10, inset 0 0 0 1px #e29500, 0 2px 5px rgba(180, 110, 0, 0.35);
}
.tile.last { box-shadow: inset 0 -0.11em 0 #d8bd77, inset 0 0 0 1px rgba(150, 112, 30, 0.38), 0 0 0 2px #2f8fd6, 0 1px 4px rgba(47, 143, 214, 0.45); }
.tile.faded { opacity: 0.28; }
</style>
