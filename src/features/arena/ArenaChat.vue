<script setup lang="ts">
// The talk beside a game: players and watchers in one stream, each line marked with which the
// speaker is. Sending, older lines, the players' "focus" switch and reporting a line.
import { computed, nextTick, ref, watch } from 'vue'
import { ARENA } from '../../shared/arena.ts'
import type { ArenaChatLine } from '../../shared/arena.ts'
import { REPORT_REASONS } from '../../shared/model.ts'
import type { ReportReason } from '../../shared/model.ts'
import { attempt } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { relativeTime } from '../../ui/format.ts'

const props = defineProps<{
  lines: ArenaChatLine[]
  more: boolean
  /** The member may write here (a player, or inside the audience). */
  mayChat: boolean
  /** Players only: null hides the switch. */
  focus: boolean | null
  busy: boolean
  /** Why writing is closed, when it is. */
  closedText: string
}>()
const emit = defineEmits<{ send: [text: string]; older: []; focus: [on: boolean] }>()

const REASON: Record<ReportReason, string> = { harassment: 'Harassment', spam: 'Spam', impersonation: 'Pretending to be someone', 'unsafe-meetup': 'Unsafe meetup', other: 'Something else' }
const text = ref('')
const scroller = ref<HTMLElement | null>(null)
const reporting = ref<ArenaChatLine | null>(null)
const reason = ref<ReportReason>('harassment')
const left = computed(() => ARENA.chat.maxLength - text.value.length)

function send(): void {
  const value = text.value.trim()
  if (!value || props.busy) return
  emit('send', value)
  text.value = ''
}

// New lines keep the latest in view, unless the member has scrolled up to read.
watch(() => props.lines.length, async (now, before) => {
  const box = scroller.value
  const nearEnd = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 80
  await nextTick()
  if (box && (nearEnd || before === 0) && now > before) box.scrollTop = box.scrollHeight
}, { flush: 'pre' })
const toEnd = (): void => { void nextTick(() => { if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight }) }
defineExpose({ toEnd })

async function report(): Promise<void> {
  const line = reporting.value
  if (!line) return
  const sent = await attempt('member.report', { memberId: line.memberId, reason: reason.value, detail: `Game chat: “${line.text.slice(0, 400)}”`, room: null }, 'Report received. Thank you.')
  if (sent) reporting.value = null
}
</script>

<template>
  <div class="chat">
    <label v-if="focus !== null" class="row focus">
      <span class="grow small"><strong>Focus</strong><span class="muted"> — hide what watchers say</span></span>
      <button class="switch" type="button" role="switch" :aria-checked="focus" aria-label="Focus: hide what watchers say" @click="emit('focus', !focus)"></button>
    </label>

    <div ref="scroller" class="lines" role="log" aria-label="Game chat" aria-live="polite">
      <button v-if="more" class="btn sm ghost older" type="button" @click="emit('older')">Show earlier messages</button>
      <p v-if="!lines.length" class="muted small empty-chat">{{ mayChat ? 'Nobody has said anything yet. Say hello.' : 'Nobody has said anything yet.' }}</p>
      <div v-for="line in lines" :key="line.id" class="line" :class="{ mine: line.mine }">
        <MemberBadge :member-id="line.memberId" :look="line.look" :size="26" />
        <div class="grow bubble">
          <div class="who">
            <strong class="truncate">{{ line.mine ? 'You' : line.displayName }}</strong>
            <span class="chip" :class="line.role === 'player' ? 'amber' : 'sky'">{{ line.role === 'player' ? 'Player' : 'Watching' }}</span>
            <span class="tiny muted time">{{ relativeTime(line.at) }}</span>
            <button v-if="!line.mine" class="flag" type="button" :aria-label="`Report this message from ${line.displayName}`" title="Report" @click="reporting = line">⚑</button>
          </div>
          <p class="said">{{ line.text }}</p>
        </div>
      </div>
    </div>

    <div v-if="reporting" class="notice coral report" role="group" aria-label="Report a message">
      <div class="grow stack tight">
        <span>Report “{{ reporting.text.slice(0, 80) }}” from {{ reporting.displayName }}?</span>
        <select v-model="reason" class="select" aria-label="Reason"><option v-for="entry in REPORT_REASONS" :key="entry" :value="entry">{{ REASON[entry] }}</option></select>
        <div class="row"><button class="btn sm danger" type="button" @click="report">Send report</button><button class="btn sm ghost" type="button" @click="reporting = null">Cancel</button></div>
      </div>
    </div>

    <form v-if="mayChat" class="row write" @submit.prevent="send">
      <input v-model="text" class="input grow" type="text" :maxlength="ARENA.chat.maxLength" placeholder="Say something" aria-label="Message" autocomplete="off" enterkeyhint="send" />
      <span v-if="left < 40" class="tiny muted num" aria-hidden="true">{{ left }}</span>
      <button class="btn primary" type="submit" :disabled="!text.trim() || busy">Send</button>
    </form>
    <p v-else class="muted small">{{ closedText }}</p>
  </div>
</template>

<style scoped>
.chat { display: flex; flex-direction: column; gap: 8px; min-height: 0; flex: 1; }
.focus { padding: 2px 2px 6px; border-bottom: 1px solid var(--line); cursor: pointer; }
.lines { flex: 1; min-height: 120px; max-height: 320px; overflow-y: auto; display: flex; flex-direction: column; gap: 8px; padding: 2px; overscroll-behavior: contain; }
.older { align-self: center; }
.empty-chat { margin: auto; text-align: center; padding: 12px; }
.line { display: flex; gap: 8px; align-items: flex-start; }
.bubble { min-width: 0; padding: 6px 10px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); }
.line.mine .bubble { background: var(--accent-soft); border-color: #f4dfae; }
.who { display: flex; align-items: center; gap: 6px; min-width: 0; }
.who strong { font-size: 0.84rem; }
.who .chip { font-size: 0.68rem; padding: 1px 7px; }
.time { margin-left: auto; white-space: nowrap; }
.flag { border: 0; background: transparent; color: var(--muted); padding: 0 4px; min-width: 28px; min-height: 28px; border-radius: 8px; }
.flag:hover { color: var(--danger); background: var(--coral-soft); }
.said { font-size: 0.92rem; overflow-wrap: anywhere; }
.write .input { min-width: 0; }
.report .select { min-height: 38px; }
</style>
