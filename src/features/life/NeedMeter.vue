<script setup lang="ts">
// One meter: icon, bar, number and the level in words. Used on the dark HUD pill and on light cards.
// `compact` is the world screen's: icon and bar only, with the number appearing only when the
// meter is low or critical, so a warning is told by a mark and a number as well as by colour.
import { computed } from 'vue'
import type { NeedKey, NeedView } from '../../shared/life.ts'
import HudIcon from '../../ui/HudIcon.vue'

const props = defineProps<{ kind: NeedKey; need: NeedView; tone?: 'dark' | 'light'; words?: boolean; bare?: boolean; compact?: boolean }>()
const name = computed(() => (props.kind === 'hunger' ? 'Food' : 'Energy'))
const icon = computed(() => (props.kind === 'hunger' ? 'food' : 'energy') as 'food' | 'energy')
/** A mark beside the number, so a low meter is not told by colour alone. */
const mark = computed(() => (props.need.level === 'critical' ? '!' : props.need.level === 'low' ? '↓' : ''))
</script>

<template>
  <span
    class="meter" :class="[tone ?? 'light', need.level, { compact }]" role="meter" :aria-label="name"
    aria-valuemin="0" aria-valuemax="100" :aria-valuenow="need.value" :aria-valuetext="`${need.value} of 100, ${need.label}`"
  >
    <HudIcon v-if="!bare" class="icon" :name="icon" :size="compact ? 16 : 18" />
    <span class="track" aria-hidden="true"><span class="fill" :style="{ width: `${Math.max(4, need.value)}%` }"></span></span>
    <span v-if="!compact || mark" class="value num" aria-hidden="true">{{ need.value }}<span v-if="mark" class="mark">{{ mark }}</span></span>
    <span v-if="words" class="word" aria-hidden="true">{{ need.label }}</span>
  </span>
</template>

<style scoped>
.meter { display: flex; align-items: center; gap: 6px; min-width: 0; --level: var(--leaf); }
.meter.ok { --level: var(--accent-strong); }
.meter.low { --level: #e8742a; }
.meter.critical { --level: var(--coral); }
.meter.dark { --level: #63d696; }
.meter.dark.ok { --level: #ffc24a; }
.meter.dark.low { --level: #ff9a52; }
.meter.dark.critical { --level: #ff7a63; }
.icon { flex: none; color: var(--level); }
.compact .track { min-width: 40px; height: 6px; }
.compact .value { min-width: 0; font-size: 0.74rem; }
.track { flex: 1; min-width: 34px; height: 7px; border-radius: 999px; background: rgba(28, 26, 36, 0.1); overflow: hidden; }
.dark .track { background: rgba(255, 255, 255, 0.2); }
.fill { display: block; height: 100%; border-radius: inherit; background: var(--level); transition: width 0.6s ease, background 0.3s ease; }
.value { flex: none; min-width: 2.1em; text-align: right; font-size: 0.8rem; font-weight: 750; line-height: 1; }
.mark { margin-left: 1px; color: var(--level); font-weight: 800; }
.word { flex: none; font-size: 0.76rem; font-weight: 650; color: var(--level); white-space: nowrap; }
.light .word { filter: brightness(0.82); }
.critical .fill { animation: low-pulse 1.6s ease-in-out infinite; }
@keyframes low-pulse { 50% { opacity: 0.55; } }
</style>
