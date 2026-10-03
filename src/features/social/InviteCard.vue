<script setup lang="ts">
// One join-me invitation, seen by the person invited (go there, or not now) or by the sender
// (waiting, or they are coming). Says plainly when a trip is needed.
import { computed, onBeforeUnmount, ref } from 'vue'
import type { JoinInvite } from '../../shared/direct.ts'
import { answerInvite, cancelInvite, placeWords } from '../../state/social.ts'
import MemberBadge from '../../ui/MemberBadge.vue'

const props = defineProps<{ invite: JoinInvite; compact?: boolean; highlight?: boolean }>()
const busy = ref(false)
const now = ref(Date.now())
const timer = window.setInterval(() => { now.value = Date.now() }, 15_000)
onBeforeUnmount(() => window.clearInterval(timer))

const other = computed(() => (props.invite.mine ? props.invite.to : props.invite.from))
const minutesLeft = computed(() => Math.max(0, Math.ceil((Date.parse(props.invite.expiresAt) - now.value) / 60_000)))
const lapsed = computed(() => Date.parse(props.invite.expiresAt) <= now.value)
const icon = computed(() => ({ street: '🛣', venue: '📍', home: '🏠', table: '🃏' })[props.invite.place.kind])
const REACH: Record<string, { label: string; tone: string }> = {
  walk: { label: 'Walking range', tone: 'leaf' }, door: { label: 'Open from anywhere', tone: 'sky' },
  travel: { label: 'Needs a trip', tone: 'amber' }, unavailable: { label: 'Not reachable now', tone: 'coral' },
}
const reach = computed(() => (props.invite.reach ? REACH[props.invite.reach] ?? null : null))
const goLabel = computed(() => {
  if (props.invite.reach === 'travel') return 'Accept and open Travel'
  if (props.invite.status === 'accepted') return 'Show me the way'
  return props.invite.place.kind === 'table' ? 'Open the table' : 'Go there'
})

async function answer(accept: boolean): Promise<void> { busy.value = true; await answerInvite(props.invite, accept); busy.value = false }
</script>

<template>
  <article class="invite" :class="{ compact, highlight }" :aria-label="invite.mine ? `Your invitation to ${other.displayName}` : `${other.displayName} invites you to join them`">
    <MemberBadge :member-id="other.id" :look="other.look" :size="compact ? 34 : 40" :online="other.online" />
    <div class="grow text">
      <p class="line">
        <template v-if="!invite.mine"><strong>{{ other.displayName }}</strong> {{ invite.status === 'accepted' ? 'is expecting you at' : 'invites you to' }}</template>
        <template v-else><strong>{{ other.displayName }}</strong> {{ invite.status === 'accepted' ? 'is coming to' : 'was invited to' }}</template>
        {{ ' ' }}<span class="place"><span aria-hidden="true">{{ icon }}</span> {{ placeWords(invite) }}</span>
      </p>
      <p v-if="invite.note" class="note small">“{{ invite.note }}”</p>
      <p class="row wrap meta tiny muted">
        <span v-if="reach" class="chip" :class="reach.tone">{{ reach.label }}</span>
        <span v-if="lapsed">This invitation has run out.</span>
        <span v-else class="num">{{ minutesLeft }} min left</span>
        <span v-if="invite.mine && invite.status === 'pending'">· waiting for an answer</span>
      </p>
    </div>
    <div v-if="!lapsed" class="row actions">
      <template v-if="!invite.mine">
        <button class="btn primary sm" type="button" :disabled="busy" @click="answer(true)">{{ goLabel }}</button>
        <button v-if="invite.status === 'pending'" class="btn ghost sm" type="button" :disabled="busy" @click="answer(false)">Not now</button>
      </template>
      <button v-else class="btn ghost sm" type="button" @click="cancelInvite(invite)">Take it back</button>
    </div>
  </article>
</template>

<style scoped>
.invite { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 10px 12px; border-radius: 14px; background: linear-gradient(135deg, #e3f5ea, #fffdf9 70%); border: 1px solid #c4e6d1; }
.invite.highlight { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 0 4px var(--accent-strong); }
.text { flex: 1 1 170px; display: flex; flex-direction: column; gap: 3px; }
.line { overflow-wrap: anywhere; }
.place { font-weight: 650; }
.note { color: var(--ink-2); overflow-wrap: anywhere; }
.meta { gap: 6px; }
.actions { gap: 6px; margin-left: auto; }
.invite.compact { padding: 8px 10px; }
</style>
