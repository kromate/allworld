<script setup lang="ts">
// A playing card face (rank and suit mark, red or black) or a face-down back. Purely visual:
// whoever uses it supplies the words for screen readers.
import type { Card } from '../../shared/play.ts'
import { SUIT, rankName } from './playText.ts'

defineProps<{ card?: Card | null; size?: 'sm' | 'md' | 'lg'; back?: boolean }>()
</script>

<template>
  <span class="pc" :class="[size ?? 'md', { back: back || !card, red: Boolean(card && !back && SUIT[card.suit].red) }]" aria-hidden="true">
    <template v-if="card && !back">
      <span class="corner"><b>{{ rankName(card.rank) }}</b><i>{{ SUIT[card.suit].mark }}</i></span>
      <span class="pip">{{ SUIT[card.suit].mark }}</span>
    </template>
  </span>
</template>

<style scoped>
.pc { position: relative; display: inline-block; flex: none; width: 54px; height: 76px; border-radius: 9px; background: #fff; border: 1px solid var(--line-strong); box-shadow: 0 2px 0 rgba(40, 30, 10, 0.14); color: var(--ink); font-family: var(--font); user-select: none; }
.pc.red { color: var(--danger); }
.corner { position: absolute; top: 4px; left: 6px; display: flex; flex-direction: column; align-items: center; line-height: 1; }
.corner b { font-size: 1.12rem; font-weight: 800; letter-spacing: -0.03em; }
.corner i { font-style: normal; font-size: 0.92rem; margin-top: 1px; }
.pip { position: absolute; right: 6px; bottom: 3px; font-size: 1.7rem; line-height: 1; }
.pc.lg { width: 80px; height: 112px; border-radius: 12px; }
.pc.lg .corner { top: 7px; left: 9px; }
.pc.lg .corner b { font-size: 1.6rem; }
.pc.lg .corner i { font-size: 1.2rem; }
.pc.lg .pip { right: 9px; bottom: 6px; font-size: 2.7rem; }
.pc.sm { width: 20px; height: 28px; border-radius: 5px; box-shadow: none; }
.pc.back { border-color: #fff; background: repeating-linear-gradient(45deg, var(--grape) 0 5px, #6a51bd 5px 10px); box-shadow: 0 0 0 1px rgba(28, 26, 36, 0.25), 0 2px 0 rgba(40, 30, 10, 0.14); }
.pc.back.sm { box-shadow: 0 0 0 1px rgba(28, 26, 36, 0.25); border-width: 1px; }
</style>
