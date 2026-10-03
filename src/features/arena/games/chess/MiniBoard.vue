<script setup lang="ts">
// A small still picture of part of a chess board, for the how-to. `rows` are written from the top
// rank down, one character per square ('.' is empty, upper case is White); `origin` names the
// bottom-left square so the colours and the marks line up with a real board.
import { computed } from 'vue'
import ChessPiece from './ChessPiece.vue'

export type Mark = 'dot' | 'take' | 'last' | 'check'
const props = withDefaults(defineProps<{ rows: string[]; origin?: string; marks?: Record<string, Mark>; label: string }>(), { origin: 'a1', marks: () => ({}) })

const cols = computed(() => props.rows[0]?.length ?? 0)
const cells = computed(() => {
  const file0 = props.origin.charCodeAt(0) - 97, rank0 = Number(props.origin[1]) - 1, height = props.rows.length
  return props.rows.flatMap((row, r) => [...row].map((char, c) => {
    const file = file0 + c, rank = rank0 + (height - 1 - r), name = 'abcdefgh'[file]! + String(rank + 1)
    return { name, piece: char === '.' ? '' : char, dark: (file + rank) % 2 === 0, mark: props.marks[name] ?? '' }
  }))
})
</script>

<template>
  <div class="mini-board" role="img" :aria-label="label" :style="{ gridTemplateColumns: `repeat(${cols}, 1fr)`, aspectRatio: `${cols} / ${rows.length}` }">
    <span v-for="cell in cells" :key="cell.name" class="cell" :class="[cell.dark ? 'dark' : 'light', cell.mark]">
      <ChessPiece v-if="cell.piece" :piece="cell.piece" />
    </span>
  </div>
</template>

<style scoped>
.mini-board { display: grid; width: 100%; border-radius: 8px; overflow: hidden; box-shadow: 0 0 0 3px #6b452b, 0 3px 8px rgba(60, 36, 14, 0.2); margin: 3px; width: calc(100% - 6px); }
.cell { position: relative; background: #f0dcb6; min-width: 0; aspect-ratio: 1; }
.cell.dark { background: #b98b60; }
.cell > :deep(svg) { position: relative; z-index: 1; padding: 2%; filter: drop-shadow(0 1px 0.5px rgba(40, 22, 8, 0.35)); }
.cell::before, .cell::after { content: ""; position: absolute; pointer-events: none; }
.cell.last::before { inset: 0; background: rgba(255, 208, 64, 0.55); }
.cell.check::before { inset: 0; background: radial-gradient(circle, rgba(226, 48, 28, 0.95) 0%, rgba(226, 48, 28, 0.6) 40%, rgba(226, 48, 28, 0) 72%); }
.cell.dot::after { left: 50%; top: 50%; width: 32%; height: 32%; transform: translate(-50%, -50%); border-radius: 50%; background: rgba(28, 26, 36, 0.3); }
.cell.take::after { inset: 5%; border-radius: 50%; border: 3px solid rgba(28, 26, 36, 0.36); z-index: 2; }
</style>
