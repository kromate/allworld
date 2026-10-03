<script setup lang="ts">
// One member, and what you can do with them: wave, introduce yourself, message, invite them to
// join you, play or watch their game in the hall, visit, block or report. For a friend it also
// says how they are doing, in the daily-life track's own words.
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { CREATOR_FRIEND_LABEL } from '../../shared/creator.ts'
import type { MemberId } from '../../shared/ids.ts'
import { REPORT_REASONS } from '../../shared/model.ts'
import type { AvatarLook, Relation, ReportReason } from '../../shared/model.ts'
import { INTRO_NOTE_MAX } from '../../shared/social.ts'
import { api, app, attempt, messageOf, toast } from '../../state/app.ts'
import { followToHome, inviteToJoin, messageMember, peekMood, refreshWatchable, relationNow, sendWave, social } from '../../state/social.ts'
import { world } from '../../state/world.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import CreatorBadge from '../creator/CreatorBadge.vue'
import { isAutomaticFriend } from '../creator/creatorView.ts'

const props = defineProps<{
  /** `automatic` and `verified` are the service's marks on a `PublicMember`; they are shown, never guessed from a name. */
  member: { id: MemberId; displayName: string; look: AvatarLook; relation: Relation; bio?: string; areaLabel?: string | null; online?: boolean; automatic?: 'creator'; verified?: 'creator' }
  subtitle?: string
  closable?: boolean
  compact?: boolean
}>()
const emit = defineEmits<{ close: []; changed: [] }>()
const router = useRouter()

const mode = ref<'idle' | 'intro' | 'report'>('idle')
const moreOpen = ref(false)
const note = ref('')
const reason = ref<ReportReason>('harassment')
const detail = ref('')
const busy = ref(false)
/** What this card itself changed (an introduction just sent), until the service's own answer arrives. */
const local = ref<Relation | null>(null)
/**
 * A friendship the service made (the creator's welcome). It is a friend in the friends list, and
 * it can be messaged, removed and blocked; what friends share and do together is not offered
 * through it. The who-is-around list does not carry it, so the member's own record is what counts.
 */
const serviceMade = computed(() => isAutomaticFriend(props.member) && props.member.relation === 'friend')
const relation = computed<Relation>({
  get: () => {
    if (serviceMade.value) return 'friend'
    const now = relationNow(props.member)
    return now === 'friend' || now === 'self' ? now : local.value ?? now
  },
  set: value => { local.value = value },
})
const REASON_LABEL: Record<ReportReason, string> = { harassment: 'Harassment or abuse', spam: 'Spam', impersonation: 'Pretending to be someone else', 'unsafe-meetup': 'Unsafe meetup behaviour', other: 'Something else' }
/** Standing somewhere a friend could be invited to, and they are not already here. */
const canInvite = computed(() => world.state === 'ready' && (world.kind === 'district' || world.kind === 'venue' || (world.kind === 'home' && world.canEditHome))
  && !world.members.some(entry => entry.id === props.member.id) && props.member.online !== false)
const hereName = computed(() => (world.kind === 'venue' ? world.venue?.name : world.kind === 'home' ? 'your home' : world.areaLabel) || 'where you are')
const waving = ref(false)
async function wave(): Promise<void> { waving.value = true; await sendWave(props.member); waving.value = false }
// What the other tracks know about a friend. Both are asked rarely and shared between cards.
/** Friends both accepted: the only kind that shares a mood, a game to watch, a home, a meeting. */
const closeFriend = computed(() => relation.value === 'friend' && !serviceMade.value)
watch(closeFriend, value => { if (value) { peekMood(props.member.id); refreshWatchable() } }, { immediate: true })
const mood = computed(() => (closeFriend.value ? social.moods[props.member.id] ?? null : null))
const watching = computed(() => (closeFriend.value ? social.watchable[props.member.id] ?? null : null))
const relationLabel = computed(() => (serviceMade.value ? CREATOR_FRIEND_LABEL : { self: 'You', friend: 'Friend', 'intro-sent': 'Introduction sent', 'intro-received': 'Wants to connect', none: '' }[relation.value]))

async function sendIntro(): Promise<void> {
  busy.value = true
  const result = await attempt('intro.send', { to: props.member.id, note: note.value.trim() }, `Introduction sent to ${props.member.displayName}.`)
  busy.value = false
  if (result) { relation.value = 'intro-sent'; mode.value = 'idle'; note.value = ''; emit('changed') }
}

async function block(): Promise<void> {
  busy.value = true
  try {
    app.blocked = (await api('member.block', { memberId: props.member.id })).blocked
    toast(`${props.member.displayName} is blocked. You will not see or hear each other.`, 'good', {
      label: 'Undo', run: () => { void api('member.unblock', { memberId: props.member.id }).then(result => { app.blocked = result.blocked; emit('changed') }) },
    })
    emit('changed')
    emit('close')
  } catch (error) { toast(messageOf(error), 'bad') } finally { busy.value = false }
}

async function report(): Promise<void> {
  busy.value = true
  const result = await attempt('member.report', { memberId: props.member.id, reason: reason.value, detail: detail.value.trim(), room: world.roomKey }, 'Report received. Thank you.')
  busy.value = false
  if (result) { mode.value = 'idle'; detail.value = '' }
}

async function visit(): Promise<void> {
  try {
    const { homes } = await api('home.visitable', {})
    const home = homes.find(entry => entry.owner.id === props.member.id)
    if (!home) { toast(`${props.member.displayName}’s home is not open to you right now.`, 'info'); return }
    void router.push('/')
    // On foot to the front door, by the route the service verifies; the door itself is the member's to use.
    await followToHome(home.homeId, home.name)
  } catch (error) { toast(messageOf(error), 'bad') }
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <MemberBadge :member-id="member.id" :look="member.look" :size="compact ? 40 : 48" :online="member.online" />
      <div class="grow">
        <span class="row" style="gap: 6px; min-width: 0"><strong class="truncate">{{ member.displayName }}</strong><CreatorBadge :member="member" /></span>
        <div class="row wrap" style="gap: 6px">
          <span v-if="relationLabel" class="chip" :class="relation === 'friend' ? 'amber' : relation === 'intro-received' ? 'coral' : ''">{{ relationLabel }}</span>
          <span v-if="subtitle" class="muted tiny">{{ subtitle }}</span>
          <span v-if="member.areaLabel" class="muted tiny">· {{ member.areaLabel }}</span>
        </div>
      </div>
      <button v-if="closable" class="btn ghost icon sm" type="button" aria-label="Close" @click="emit('close')">✕</button>
    </div>
    <p v-if="mood" class="tiny mood"><span aria-hidden="true">🍲</span> {{ mood }}</p>
    <p v-if="member.bio && !compact" class="small">{{ member.bio }}</p>

    <!-- One main thing to do with this person, at most one more beside it, and the rest behind More. -->
    <template v-if="mode === 'idle' && relation !== 'self'">
      <div class="row wrap actions">
        <template v-if="relation === 'none'">
          <button class="btn primary sm" type="button" @click="mode = 'intro'">Introduce yourself</button>
          <button class="btn sm" type="button" :disabled="waving" title="A wordless hello. If they wave back, you can introduce yourself." @click="wave"><span aria-hidden="true">👋</span> Wave</button>
        </template>
        <button v-else-if="relation === 'intro-received'" class="btn primary sm" type="button" @click="router.push('/people?tab=requests')">Answer their introduction</button>
        <template v-else-if="relation === 'friend'">
          <button class="btn primary sm" type="button" @click="messageMember(member.id)"><span aria-hidden="true">💬</span> Message</button>
          <button v-if="watching" class="btn sm" type="button" :title="`${member.displayName} is in a game you can watch`" @click="router.push(`/arena/match/${watching}`)"><span aria-hidden="true">👀</span> Watch their game</button>
          <button v-else-if="canInvite && closeFriend" class="btn sm" type="button" :title="`Invite ${member.displayName} to ${hereName}`" @click="inviteToJoin(member, 'here')"><span aria-hidden="true">📍</span> Join me</button>
        </template>
        <button class="btn sm ghost more" type="button" :aria-expanded="moreOpen" :aria-label="`More to do with ${member.displayName}`" @click="moreOpen = !moreOpen">More <span aria-hidden="true">{{ moreOpen ? '▴' : '▾' }}</span></button>
        <div v-if="moreOpen" class="row wrap more-list">
          <template v-if="closeFriend">
            <button v-if="watching && canInvite" class="btn sm" type="button" @click="inviteToJoin(member, 'here')"><span aria-hidden="true">📍</span> Join me</button>
            <button class="btn sm" type="button" @click="router.push(`/arena?challenge=${member.id}`)"><span aria-hidden="true">🎮</span> Challenge</button>
            <button class="btn sm" type="button" @click="visit"><span aria-hidden="true">🏠</span> Visit home</button>
            <button class="btn sm" type="button" @click="router.push(`/people?tab=meetups&with=${member.id}`)"><span aria-hidden="true">📅</span> Plan a meetup</button>
            <button class="btn sm" type="button" :disabled="waving" @click="wave"><span aria-hidden="true">👋</span> Wave</button>
          </template>
          <button class="btn sm ghost" type="button" :disabled="busy" @click="block">Block</button>
          <button class="btn sm ghost danger" type="button" @click="mode = 'report'">Report</button>
          <slot name="more" />
        </div>
      </div>
    </template>

    <form v-else-if="mode === 'intro'" class="stack tight" @submit.prevent="sendIntro">
      <label class="field">
        <span>Add a short note (optional)</span>
        <textarea v-model="note" class="textarea" :maxlength="INTRO_NOTE_MAX" placeholder="Say how you know them or why you would like to connect"></textarea>
        <small>You become friends only if they accept. They do not see where you are.</small>
      </label>
      <div class="row">
        <button class="btn primary sm" type="submit" :disabled="busy">{{ busy ? 'Sending…' : 'Send introduction' }}</button>
        <button class="btn sm ghost" type="button" @click="mode = 'idle'">Cancel</button>
      </div>
    </form>

    <form v-else-if="mode === 'report'" class="stack tight" @submit.prevent="report">
      <label class="field">
        <span>What happened?</span>
        <select v-model="reason" class="select"><option v-for="entry in REPORT_REASONS" :key="entry" :value="entry">{{ REASON_LABEL[entry] }}</option></select>
      </label>
      <label class="field">
        <span>Details (optional)</span>
        <textarea v-model="detail" class="textarea" maxlength="500" placeholder="Anything that helps a reviewer understand"></textarea>
      </label>
      <div class="row">
        <button class="btn dark sm" type="submit" :disabled="busy">{{ busy ? 'Sending…' : 'Send report' }}</button>
        <button class="btn sm ghost" type="button" @click="mode = 'idle'">Cancel</button>
      </div>
    </form>
  </div>
</template>

<style scoped>
.mood { color: var(--ink-2); margin-top: -6px; }
.actions { gap: 6px; }
/* More sits on the row as a small button; opened, its list takes the row below. */
.more[aria-expanded="true"] { background: rgba(28, 26, 36, 0.06); }
.more-list { flex: 1 1 100%; gap: 6px; padding-top: 2px; }
@media (pointer: coarse) { .btn.sm { min-height: 44px; } }
</style>
