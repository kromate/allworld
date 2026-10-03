<script setup lang="ts">
// Who is in a community, what each person's role is, and — for the owner and moderators — the
// controls the service allows them. Members can invite friends and leave from here.
import { computed, onBeforeUnmount, ref } from 'vue'
import type { MemberId } from '../../shared/ids.ts'
import type { PublicMember } from '../../shared/model.ts'
import type { CommunityDetail, CommunityMember, CommunityRole } from '../../shared/social.ts'
import { api, messageOf, myId, onAccountReset, toast } from '../../state/app.ts'
import StateView from '../../ui/StateView.vue'
import { relativeTime } from '../../ui/format.ts'
import { isAutomaticFriend } from '../creator/creatorView.ts'
import ConfirmAction from './ConfirmAction.vue'
import FriendPicker from './FriendPicker.vue'
import PersonRow from './PersonRow.vue'
import { ROLE, nameList } from './labels.ts'

const props = defineProps<{ community: CommunityDetail }>()
const emit = defineEmits<{ update: [community: CommunityDetail]; left: []; reload: [] }>()

const me = myId()
/** Replies and loops that outlive this page (closed, or the account changed) stop instead of acting on what is open now. */
let closed = false
const stopReset = onAccountReset(() => { closed = true })
onBeforeUnmount(() => { closed = true; stopReset() })
const myRole = computed(() => props.community.myRole)
const RANK: Record<CommunityRole, number> = { owner: 0, moderator: 1, member: 2 }
const query = ref('')
const roster = computed(() => {
  const text = query.value.trim().toLowerCase()
  return props.community.members
    .filter(entry => !text || entry.member.displayName.toLowerCase().includes(text))
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => RANK[a.entry.role] - RANK[b.entry.role] || a.index - b.index)
    .map(item => item.entry)
})

// ── Roles ──
const busy = ref<string | null>(null)
const leaving = ref(false)
/** One change at a time, so a second request never races the first and neither answer unlocks the other. */
const locked = computed(() => busy.value !== null || leaving.value)
/** What the viewer may do to this person, following the service's rules. */
function powers(entry: CommunityMember): { promote: boolean; demote: boolean; handOver: boolean; remove: boolean } {
  const other = entry.member.id !== me && entry.role !== 'owner'
  const owner = myRole.value === 'owner' && other
  return {
    promote: owner && entry.role === 'member',
    demote: owner && entry.role === 'moderator',
    handOver: owner,
    remove: owner || (myRole.value === 'moderator' && other && entry.role === 'member'),
  }
}
const canManage = (entry: CommunityMember): boolean => Object.values(powers(entry)).some(Boolean)
const managing = computed(() => props.community.members.some(canManage))

async function setRole(entry: CommunityMember, role: CommunityRole | 'removed', done: string, undo?: CommunityRole): Promise<void> {
  if (closed || locked.value) return
  busy.value = entry.member.id
  try {
    const { community } = await api('community.setRole', { communityId: props.community.id, memberId: entry.member.id, role })
    if (closed) return
    emit('update', community)
    const name = entry.member.displayName
    toast(done, 'good', undo ? { label: 'Undo', run: () => { void setRole(entry, undo, `${name} is a ${ROLE[undo].label.toLowerCase()} again.`) } } : undefined)
  } catch (cause) {
    if (closed) return
    toast(messageOf(cause), 'bad')
    emit('reload')
  } finally {
    busy.value = null
  }
}
const removeQuestion = (entry: CommunityMember): string =>
  `Remove ${entry.member.displayName} from ${props.community.name}? They lose the posts and the board. ${props.community.visibility === 'public' ? 'Because this community is public, they can join again.' : 'They would need a new invitation to come back.'}`

// ── Invite friends ──
const inviting = ref(false)
const friends = ref<PublicMember[] | null>(null)
const friendsState = ref<'loading' | 'error' | 'ready'>('loading')
const friendsError = ref('')
const chosen = ref<MemberId[]>([])
const invitedNow = ref<MemberId[]>([])
const sending = ref(false)
let friendsLoad = 0
const candidates = computed(() => (friends.value ?? []).filter(friend => !props.community.members.some(entry => entry.member.id === friend.id)))

async function loadFriends(): Promise<void> {
  const mine = ++friendsLoad
  friendsState.value = 'loading'
  try {
    // "Invite friends" means friends who both accepted. A friendship the service made is for
    // messages, and is not offered an invitation from here.
    const list = (await api('friends.list', {})).friends.filter(friend => !isAutomaticFriend(friend))
    if (closed || mine !== friendsLoad) return
    friends.value = list
    friendsState.value = 'ready'
  } catch (cause) {
    if (closed || mine !== friendsLoad) return
    friendsError.value = messageOf(cause)
    friendsState.value = 'error'
  }
}
function toggleInvite(): void {
  inviting.value = !inviting.value
  if (inviting.value) void loadFriends()
  else friendsLoad++
}
async function sendInvites(): Promise<void> {
  const targets = candidates.value.filter(friend => chosen.value.includes(friend.id))
  if (closed || !targets.length || sending.value) return
  sending.value = true
  const done: string[] = []
  let failure = ''
  for (const friend of targets) {
    if (closed) break
    try {
      await api('community.invite', { communityId: props.community.id, memberId: friend.id })
      done.push(friend.displayName)
      invitedNow.value = [...invitedNow.value, friend.id]
    } catch (cause) { failure = messageOf(cause); break }
  }
  sending.value = false
  chosen.value = chosen.value.filter(id => !invitedNow.value.includes(id))
  if (!closed && done.length) toast(`${nameList(done)} ${done.length === 1 ? 'was' : 'were'} invited to ${props.community.name}.`, 'good')
  if (failure && !closed) toast(`The rest were not invited: ${failure}`, 'bad')
}

// ── Leave ──
const leaveQuestion = computed(() => {
  const { name, memberCount, visibility } = props.community
  if (memberCount <= 1) return `You are the only member. Leaving closes ${name} and deletes its posts for good.`
  if (myRole.value === 'owner') return `Leave ${name}? You own it, so ownership passes to the longest-standing moderator, or to the longest-standing member if there is no moderator.`
  if (visibility === 'invite-only') return `Leave ${name}? It is invite-only, so you would need a new invitation to come back.`
  return `Leave ${name}? You can join again later.`
})
async function leave(): Promise<void> {
  if (closed || locked.value) return
  const { id, name, memberCount, visibility } = props.community
  leaving.value = true
  try {
    await api('community.leave', { communityId: id })
    if (closed) return
    const canReturn = visibility === 'public' && memberCount > 1
    toast(memberCount <= 1 ? `You left ${name}, and it is now closed.` : `You left ${name}.`, 'good', canReturn ? {
      label: 'Rejoin', run: () => { if (myId() !== me) return; void api('community.join', { communityId: id }).then(() => { if (myId() === me) toast(`You are back in ${name} as a member.`, 'good') }).catch(cause => { if (myId() === me) toast(messageOf(cause), 'bad') }) },
    } : undefined)
    emit('left')
  } catch (cause) {
    if (!closed) toast(messageOf(cause), 'bad')
  } finally {
    leaving.value = false
  }
}
</script>

<template>
  <div class="stack">
    <!-- Invite -->
    <section v-if="myRole" class="card stack tight" :class="{ 'tint-sky': inviting }">
      <div class="row wrap">
        <span class="icon-chip sky" aria-hidden="true">✉</span>
        <span class="grow small invite-text">Invite friends. They get a note in their inbox and choose whether to join.</span>
        <button class="btn sm" type="button" :aria-expanded="inviting" aria-controls="community-invite" @click="toggleInvite">{{ inviting ? 'Close' : 'Invite friends' }}</button>
      </div>
      <div v-if="inviting" id="community-invite" class="stack tight">
        <StateView v-if="friendsState !== 'ready'" :state="friendsState" :message="friendsError" @retry="loadFriends" />
        <div v-else-if="!friends?.length" class="notice stack tight">
          <span>You have no friends to invite yet. Friends are people whose introduction was accepted.</span>
          <RouterLink class="btn sm" to="/people?tab=nearby">Find people</RouterLink>
        </div>
        <p v-else-if="!candidates.length" class="notice leaf">All of your friends are already in this community.</p>
        <template v-else>
          <FriendPicker v-model="chosen" :friends="candidates" :done="invitedNow" done-label="Invited" label="Friends to invite to this community" chosen-prefix="Inviting" />
          <div class="row">
            <button class="btn primary sm" type="button" :disabled="sending || !chosen.length" @click="sendInvites">{{ sending ? 'Inviting…' : 'Send invitations' }}</button>
            <span v-if="!chosen.length" class="muted tiny">Choose who to invite first.</span>
          </div>
        </template>
      </div>
    </section>

    <!-- Roster -->
    <section class="card stack tight" aria-labelledby="community-roster">
      <div class="section-head"><h2 id="community-roster">{{ myRole ? 'Members' : 'Who is here' }}</h2></div>
      <p v-if="managing" class="muted small">Open a member to change their role or remove them.</p>
      <input v-if="community.members.length > 8" v-model="query" class="input" type="search" placeholder="Filter members by name" aria-label="Filter members by name" />
      <ul v-if="roster.length" class="plain-list roster">
        <li v-for="entry in roster" :key="entry.member.id">
          <PersonRow :member="entry.member" :subtitle="ROLE[entry.role].label" :hint="canManage(entry) ? 'Show actions and role controls' : undefined" @changed="emit('reload')">
            <template #chips>
              <span class="chip" :class="ROLE[entry.role].tone">{{ ROLE[entry.role].label }}</span>
              <span class="muted tiny">Joined {{ relativeTime(entry.joinedAt) }}</span>
            </template>
            <div v-if="canManage(entry)" class="manage stack tight">
              <span class="label">Role in {{ community.name }}: {{ ROLE[entry.role].label }}</span>
              <div class="row wrap">
                <button v-if="powers(entry).promote" class="btn sm" type="button" :disabled="locked" @click="setRole(entry, 'moderator', `${entry.member.displayName} is now a moderator.`, 'member')">Make moderator</button>
                <button v-if="powers(entry).demote" class="btn sm" type="button" :disabled="locked" @click="setRole(entry, 'member', `${entry.member.displayName} is now an ordinary member.`, 'moderator')">Make ordinary member</button>
                <ConfirmAction
                  v-if="powers(entry).handOver" label="Hand over ownership" button-class="sm" tone="amber" confirm-label="Hand over" cancel-label="Stay owner" :busy="locked"
                  :question="`Make ${entry.member.displayName} the owner of ${community.name}? You become a moderator, and only they can hand it back.`"
                  @confirm="setRole(entry, 'owner', `${entry.member.displayName} now owns ${community.name}. You are a moderator.`)"
                />
                <ConfirmAction
                  v-if="powers(entry).remove" label="Remove from community" button-class="sm ghost danger" confirm-label="Remove" cancel-label="Keep" :busy="locked"
                  :question="removeQuestion(entry)"
                  @confirm="setRole(entry, 'removed', `${entry.member.displayName} was removed from ${community.name}.`)"
                />
              </div>
              <p v-if="powers(entry).promote || powers(entry).demote" class="muted tiny">Moderators can remove posts and ordinary members.</p>
            </div>
          </PersonRow>
        </li>
      </ul>
      <p v-else class="muted small">{{ query.trim() ? 'No member matches that name.' : 'No members to show.' }}</p>
    </section>

    <!-- Leave -->
    <div v-if="myRole" class="row leave">
      <ConfirmAction label="Leave community" button-class="sm ghost danger" confirm-label="Leave" cancel-label="Stay" :busy="locked" :question="leaveQuestion" @confirm="leave" />
    </div>
  </div>
</template>

<style scoped>
h2 { font-size: 1rem; }
.invite-text { flex: 1 1 150px; }
.roster { gap: 2px; }
.manage { padding-top: 10px; border-top: 1px dashed var(--line-strong); }
.leave { justify-content: flex-end; }
</style>
