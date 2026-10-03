<script setup lang="ts">
// The way in to the noticeboard: a small wooden sign with a pinned note, or a plain row for a
// menu. It is one link and nothing more. It shows no count, no badge and no activity, because it
// knows none; it never opens by itself; and it sits in the flow of whatever holds it, so it has
// no offset of its own and covers nothing.
import { computed } from 'vue'
import { SIGN, feedbackLink } from './feedbackText.ts'
import type { FeedbackContext, FeedbackTopic } from './feedbackText.ts'

const props = withDefaults(defineProps<{
  /** `sign` is the noticeboard to stand in the world's own action area; `row` is the same link as a menu row. */
  variant?: 'sign' | 'row'
  /** Where it is standing, for its wording. */
  context?: FeedbackContext
  /** The part of the game it stands beside. The page offers it as a label; it does not choose it for the member. */
  topic?: FeedbackTopic | null
}>(), { variant: 'sign', context: 'arrival', topic: null })

const words = computed(() => SIGN[props.context])
</script>

<template>
  <RouterLink class="feedback-entry" :class="`as-${variant}`" :to="feedbackLink(topic)" :aria-label="`${words.title}. ${words.line}.`">
    <span class="board" aria-hidden="true"><span class="pin"></span><span class="note"></span><span class="note second"></span></span>
    <span class="words">
      <strong class="title">{{ words.title }}</strong>
      <span class="line">{{ words.line }}</span>
    </span>
    <span class="go" aria-hidden="true">›</span>
  </RouterLink>
</template>

<style scoped>
.feedback-entry { pointer-events: auto; display: inline-flex; align-items: center; gap: 10px; max-width: 100%; min-height: 44px; text-decoration: none; color: inherit; }
.words { display: flex; flex-direction: column; min-width: 0; line-height: 1.2; }
.title { font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.line { font-size: 0.78rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.go { flex: none; }

/* The little board itself: a cork panel in a wooden frame, two paper notes and a pin. */
.board { position: relative; flex: none; width: 34px; height: 30px; border-radius: 6px; background: #c9a36b; border: 3px solid #7a5230; box-shadow: 0 1px 0 rgba(255, 255, 255, 0.35) inset; }
.note { position: absolute; left: 4px; top: 4px; width: 12px; height: 13px; border-radius: 2px; background: #fffdf4; box-shadow: 0 1px 1px rgba(60, 36, 14, 0.35); transform: rotate(-6deg); }
.note.second { left: 15px; top: 7px; width: 10px; height: 11px; background: var(--accent-soft); transform: rotate(5deg); }
.pin { position: absolute; left: 8px; top: 2px; z-index: 1; width: 5px; height: 5px; border-radius: 50%; background: var(--coral); box-shadow: 0 1px 1px rgba(60, 36, 14, 0.4); }

/* A sign: painted wood, standing in the world's action area. */
.as-sign { padding: 6px 12px 6px 8px; border-radius: 12px; border: 1px solid #5d3d22; background: linear-gradient(180deg, #8a5d37, #73492a); color: #fff8ec; box-shadow: 0 1px 0 rgba(255, 255, 255, 0.22) inset, var(--shadow); }
.as-sign:hover { background: linear-gradient(180deg, #946640, #7b4f2e); }
.as-sign .line { color: #f3dfc2; }
.as-sign .go { color: #f3dfc2; }
.as-sign:focus-visible { outline-offset: 3px; border-radius: 12px; }

/* A row: the same link among other menu rows, on the surface it is given. */
.as-row { display: flex; width: 100%; padding: 8px 12px; border-radius: 12px; }
.as-row:hover { background: rgba(28, 26, 36, 0.06); }
.as-row .words { flex: 1; }
.as-row .line, .as-row .go { color: var(--muted); }
</style>
