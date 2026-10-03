<script setup lang="ts">
// The neighbourhood noticeboard: where a member suggests an idea or reports a problem, and reads
// and votes on what others asked for. The notes themselves live on the App's public board on
// Feedback Studio (src/config/feedback.ts); this page is the way there and says plainly what goes
// with the member (nothing). It shows no notes, votes or counts of its own, because it has none.
//
// The game adds nothing to the board's address: no name, character, guest session, place, photo,
// chat or diagnostics. A label for the note is the member's choice, and it travels only if they
// copy it into what they write.
import { computed, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { resolveFeedbackBoard } from '../../config/feedback.ts'
import PanelPage from '../../ui/PanelPage.vue'
import { FEEDBACK_KINDS, FEEDBACK_TITLE, FEEDBACK_TOPICS, KIND, TOPIC, isTopic, starterLine } from './feedbackText.ts'
import type { FeedbackKind, FeedbackTopic } from './feedbackText.ts'

const route = useRoute()
const board = resolveFeedbackBoard()

const kind = ref<FeedbackKind>('idea')
const topic = ref<FeedbackTopic | null>(null)
/** The part of the game the sign stood beside. It is offered first in the list, never chosen for the member. */
const beside = computed<FeedbackTopic | null>(() => (isTopic(route.query.about) ? route.query.about : null))
const topics = computed<readonly FeedbackTopic[]>(() => (beside.value ? [beside.value, ...FEEDBACK_TOPICS.filter(entry => entry !== beside.value)] : FEEDBACK_TOPICS))
const target = computed(() => (board ? (kind.value === 'idea' ? board.idea : board.problem) : null))
const line = computed(() => starterLine(kind.value, topic.value))

/** The board inside this page is fetched only when the member asks for it. */
const showing = ref(false)

const copied = ref<'' | 'done' | 'manual'>('')
async function copyLine(): Promise<void> {
  try { await navigator.clipboard.writeText(line.value); copied.value = 'done' } catch { copied.value = 'manual' }
}
watch([kind, topic], () => { copied.value = '' })
</script>

<template>
  <PanelPage :title="FEEDBACK_TITLE">
    <section class="cork" aria-labelledby="feedback-heading">
      <span class="pin" aria-hidden="true"></span>
      <h2 id="feedback-heading">Help shape Allworld</h2>
      <p class="small">What gets built next is talked over on a public board. Read what other players have asked for, vote for what you want, or pin a note of your own.</p>
    </section>

    <fieldset class="kinds">
      <legend class="label">What would you like to pin?</legend>
      <label v-for="entry in FEEDBACK_KINDS" :key="entry" class="choice" :class="{ on: kind === entry }">
        <input v-model="kind" class="sr-only" type="radio" name="feedback-kind" :value="entry" />
        <span aria-hidden="true">{{ KIND[entry].icon }}</span><span>{{ KIND[entry].label }}</span>
      </label>
    </fieldset>
    <p class="small help">{{ KIND[kind].help }}</p>

    <!-- The one action. Where the board can be shown here, it is; otherwise it opens beside the game. -->
    <template v-if="board && target">
      <template v-if="board.embed">
        <button v-if="!showing" class="btn primary go" type="button" @click="showing = true">Show the board here</button>
        <iframe
          v-else class="frame" :src="board.embed" title="Allworld feedback board on Feedback Studio" loading="lazy"
          referrerpolicy="no-referrer" sandbox="allow-scripts allow-forms allow-same-origin allow-popups"
        ></iframe>
        <a class="small out" :href="target" target="_blank" rel="noopener noreferrer">Open the board in a new tab instead<span aria-hidden="true"> ↗</span></a>
      </template>
      <a v-else class="btn primary go" :href="target" target="_blank" rel="noopener noreferrer">{{ KIND[kind].action }}<span aria-hidden="true">↗</span><span class="sr-only"> (opens in a new tab)</span></a>
      <p class="tiny muted">
        {{ board.embed ? 'The board is' : 'Opens' }} {{ board.host }}{{ board.embed ? '.' : ' in a new tab. The game stays open here.' }}
        <template v-if="board.guestPosting === true"> You can post there without signing in.</template>
        <template v-else-if="board.guestPosting === false"> The board asks you to sign in before you post.</template>
      </p>
    </template>
    <div v-else class="notice amber" role="status">
      <span aria-hidden="true">🪧</span>
      <span><strong>The board is not up yet.</strong> Its address has not been added to this build, so nothing can be read or posted from here. It will open from this page once it is.</span>
    </div>

    <details class="disclosure">
      <summary>Add a label to your note <span class="muted small">optional</span></summary>
      <fieldset class="topics">
        <legend class="small">Say which part of the game it is about, if you like. The label is only words for you to copy: it is not sent anywhere.</legend>
        <label class="choice" :class="{ on: topic === null }">
          <input v-model="topic" class="sr-only" type="radio" name="feedback-topic" :value="null" /><span>No label</span>
        </label>
        <label v-for="entry in topics" :key="entry" class="choice" :class="{ on: topic === entry }">
          <input v-model="topic" class="sr-only" type="radio" name="feedback-topic" :value="entry" />
          <span aria-hidden="true">{{ TOPIC[entry].icon }}</span><span>{{ TOPIC[entry].label }}</span><span v-if="entry === beside" class="chip">where you were</span>
        </label>
      </fieldset>
      <div class="row wrap starter">
        <code class="grow">{{ line }}</code>
        <button class="btn sm" type="button" @click="copyLine">Copy label</button>
      </div>
      <p class="tiny muted" role="status">
        <template v-if="copied === 'done'">Copied. Paste it at the start of your note on the board.</template>
        <template v-else-if="copied === 'manual'">Copying was not allowed here. Type the label at the start of your note instead.</template>
        <template v-else>Start your note on the board with this, so others can see at a glance what it is about.</template>
      </p>
    </details>

    <details class="disclosure">
      <summary>What goes with you to the board</summary>
      <ul class="small plain">
        <li><strong>Nothing from the game.</strong> No name, character, guest session, place, photo, chat or device details are added to the link. The board sees only what you write there.</li>
        <li><strong>The board is public.</strong> Other players can read your note, so leave out names, addresses, phone numbers and pictures of people.</li>
        <li><strong>To report a person,</strong> use Report on their card in the game. That is not public; the board is.</li>
      </ul>
    </details>
  </PanelPage>
</template>

<style scoped>
/* A strip of cork with one pinned heading: the page's sign, not a list of notes. */
.cork { position: relative; padding: 18px 16px 14px; border-radius: var(--radius); background: #d9b680; border: 4px solid #7a5230; color: #2a1b0c; display: grid; gap: 6px; box-shadow: 0 1px 0 rgba(255, 255, 255, 0.35) inset; }
.cork h2 { font-size: 1.2rem; }
.pin { position: absolute; left: 50%; top: 5px; width: 9px; height: 9px; margin-left: -4px; border-radius: 50%; background: var(--coral); box-shadow: 0 1px 2px rgba(60, 36, 14, 0.5); }

.kinds, .topics { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: 8px; }
.kinds { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.kinds legend, .topics legend { padding: 0; margin-bottom: 8px; }
.topics { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.topics legend { color: var(--ink-2); }
.choice { display: flex; align-items: center; gap: 8px; min-height: 48px; padding: 8px 12px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); font-weight: 650; color: var(--ink-2); cursor: pointer; min-width: 0; }
.choice:hover { background: var(--surface-2); }
.choice.on { border-color: var(--accent-strong); background: var(--accent-soft); color: var(--accent-ink); box-shadow: 0 0 0 1px var(--accent-strong) inset; }
.choice:has(input:focus-visible) { outline: 3px solid color-mix(in srgb, var(--sky) 70%, white); outline-offset: 2px; }
.help { color: var(--ink-2); }

.go { min-height: 48px; text-decoration: none; }
.out { display: inline-flex; align-items: center; min-height: 44px; align-self: flex-start; }
.frame { width: 100%; height: min(70dvh, 640px); border: 1px solid var(--line-strong); border-radius: var(--radius); background: var(--surface); }

.starter { gap: 8px; }
.starter code { padding: 9px 12px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); font: inherit; font-size: 0.9rem; overflow-wrap: anywhere; }
.plain { list-style: none; padding: 0; display: grid; gap: 8px; color: var(--ink-2); }
@media (max-width: 360px) { .kinds { grid-template-columns: minmax(0, 1fr); } }
</style>
