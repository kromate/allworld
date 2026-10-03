<script setup lang="ts">
// Set up a game: who against, how fast, rated or casual, and who may watch. One primary action.
import { computed, ref, watch } from 'vue'
import { ARENA, ARENA_AUDIENCES, COMPUTER_LEVEL_NAME, TIME_CONTROLS } from '../../shared/arena.ts'
import type { ArenaAudience, ArenaGame, ArenaMatch, ArenaOpponent, TimeControlId } from '../../shared/arena.ts'
import type { CommunityId, MemberId } from '../../shared/ids.ts'
import type { PublicMember } from '../../shared/model.ts'
import type { CommunitySummary } from '../../shared/social.ts'
import { app, attempt, toast } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { guestMay, guestRefusal } from '../guest/guestMay.ts'
import ArenaSheet from './ArenaSheet.vue'
import { AUDIENCE, GAME, HONESTY, gameName } from './arenaText.ts'

export type OpponentKind = ArenaOpponent['kind']

const props = defineProps<{
  game: ArenaGame
  kind: OpponentKind
  friends: PublicMember[]
  communities: CommunitySummary[]
  /** Arriving from "Challenge" on a member, or from a community. */
  friendId?: MemberId | null
  communityId?: CommunityId | null
}>()
const emit = defineEmits<{ close: []; created: [match: ArenaMatch] }>()

const KINDS: { id: OpponentKind; label: string; icon: string }[] = [
  { id: 'computer', label: 'The computer', icon: '🤖' },
  { id: 'friend', label: 'A friend', icon: '🤝' },
  { id: 'queue', label: 'Find someone', icon: '🔎' },
  { id: 'community', label: 'A community', icon: '🏘' },
]
const LEVELS = [1, 2, 3] as const
const LEVEL_NOTE: Record<1 | 2 | 3, string> = { 1: 'Makes mistakes. A good first game.', 2: 'Plays sensibly and punishes blunders.', 3: 'Looks further ahead. Hard to beat.' }

// A member may set any terms. A guest's games are held to what the service opens to a guest
// (guestAccess in src/shared/guest.ts): the sheet asks that contract which opponents, rating and
// audiences are open, starts on terms it accepts, and leaves out the rest — so the action shown
// first is one that works.
const guest = computed(() => Boolean(app.guest))
const mayCreate = (opponent: OpponentKind, isRated: boolean, watchers: ArenaAudience): boolean =>
  guestMay('arena.create', { opponent: { kind: opponent }, rated: isRated, audience: watchers, communityId: null })
const audienceOpen = (opponent: OpponentKind, watchers: ArenaAudience): boolean => mayCreate(opponent, false, watchers) || mayCreate(opponent, true, watchers)
const kinds = computed(() => KINDS.filter(entry => ARENA_AUDIENCES.some(watchers => audienceOpen(entry.id, watchers))))
const firstAudience = (opponent: OpponentKind): ArenaAudience => ARENA_AUDIENCES.find(watchers => watchers !== 'community' && audienceOpen(opponent, watchers)) ?? 'anyone'
const startKind: OpponentKind = kinds.value.some(entry => entry.id === props.kind) ? props.kind : kinds.value[0]?.id ?? 'computer'

const kind = ref<OpponentKind>(startKind)
const level = ref<1 | 2 | 3>(1)
const friendId = ref<MemberId | ''>(props.friendId && props.friends.some(friend => friend.id === props.friendId) ? props.friendId : '')
const challengeCommunity = ref<CommunityId | ''>(props.communityId ?? props.communities[0]?.id ?? '')
// A word game takes longer than a race: start it on a slower clock.
const time = ref<TimeControlId>(props.game === 'words' ? '15+10' : '10+5')
const audience = ref<ArenaAudience>(firstAudience(startKind))
const rated = ref(mayCreate(startKind, true, audience.value))
const watchCommunity = ref<CommunityId | ''>(props.communityId ?? props.communities[0]?.id ?? '')
const filter = ref('')
const busy = ref(false)

const shownFriends = computed(() => {
  const query = filter.value.trim().toLowerCase()
  return query ? props.friends.filter(friend => friend.displayName.toLowerCase().includes(query)) : props.friends
})
const audiences = computed(() => ARENA_AUDIENCES.filter(entry => (entry !== 'community' || props.communities.length > 0) && audienceOpen(kind.value, entry)))
/** Rated play can be chosen for this opponent and audience. */
const ratedOpen = computed(() => kind.value !== 'computer' && mayCreate(kind.value, true, audience.value))
/** What a guest is told about the terms left out. Null for a member. */
const limits = computed(() => guestRefusal('arena.create', { opponent: { kind: 'friend' }, rated: true, audience: 'anyone', communityId: null }))
watch(() => props.communities, list => {
  if (!list.some(entry => entry.id === challengeCommunity.value)) challengeCommunity.value = list[0]?.id ?? ''
  if (!list.some(entry => entry.id === watchCommunity.value)) watchCommunity.value = list[0]?.id ?? ''
  if (audience.value === 'community' && !list.length) audience.value = firstAudience(kind.value)
})
// Changing the opponent keeps the terms inside what is open for it.
watch(kind, next => {
  if (!audienceOpen(next, audience.value)) audience.value = firstAudience(next)
  if (rated.value && !mayCreate(next, true, audience.value)) rated.value = false
})

const opponent = computed<ArenaOpponent | null>(() => {
  if (kind.value === 'computer') return { kind: 'computer', level: level.value }
  if (kind.value === 'queue') return { kind: 'queue' }
  if (kind.value === 'friend') return friendId.value ? { kind: 'friend', memberId: friendId.value } : null
  return challengeCommunity.value ? { kind: 'community', communityId: challengeCommunity.value } : null
})
const ready = computed(() => opponent.value !== null && (audience.value !== 'community' || Boolean(watchCommunity.value)))
const action = computed(() => (kind.value === 'computer' ? 'Start the game' : kind.value === 'friend' ? 'Send the challenge' : kind.value === 'queue' ? 'Find a match' : 'Post the challenge'))
const friendName = computed(() => props.friends.find(friend => friend.id === friendId.value)?.displayName ?? '')
const summary = computed(() => {
  const control = TIME_CONTROLS.find(entry => entry.id === time.value)!
  // The options below start folded away, so the terms they set are always said here, beside the action.
  const terms = `${control.label}. ${kind.value === 'computer' ? 'Practice, never rated' : rated.value ? 'Rated' : 'Casual'}. ${AUDIENCE[audience.value].short}.`
  if (kind.value === 'computer') return `You against the computer (${COMPUTER_LEVEL_NAME[level.value].toLowerCase()}). ${terms}`
  if (kind.value === 'friend') return friendName.value ? `${friendName.value} is asked to play. ${terms}` : 'Choose a friend to challenge.'
  if (kind.value === 'queue') return `You are paired with the next ${guest.value ? 'player' : 'member'} who asks for the same game. ${terms}`
  return `The first member of the community to accept plays you. ${terms}`
})

async function create(): Promise<void> {
  if (busy.value || !opponent.value || !ready.value) return
  const terms = {
    game: props.game, opponent: opponent.value, timeControl: time.value, rated: kind.value !== 'computer' && rated.value,
    audience: audience.value, communityId: audience.value === 'community' ? watchCommunity.value || null : null,
  }
  // The sheet only offers a guest what is open, so this does not arise; if it ever does, the reason is said and nothing is sent to be refused.
  const refused = guestRefusal('arena.create', terms)
  if (refused) { toast(refused.message, 'info'); return }
  busy.value = true
  const made = await attempt('arena.create', terms)
  busy.value = false
  if (made) emit('created', made.match)
}
</script>

<template>
  <ArenaSheet :title="`Play ${gameName(game)}`" @close="emit('close')">
    <div class="field">
      <span id="arena-new-kind">Play against</span>
      <div class="choices four" role="radiogroup" aria-labelledby="arena-new-kind">
        <button v-for="entry in kinds" :key="entry.id" class="choice" type="button" role="radio" :aria-checked="kind === entry.id" @click="kind = entry.id">
          <span aria-hidden="true">{{ entry.icon }}</span><span>{{ entry.label }}</span>
        </button>
      </div>
    </div>

    <div v-if="kind === 'computer'" class="field">
      <span id="arena-new-level">Level</span>
      <div class="choices three" role="radiogroup" aria-labelledby="arena-new-level">
        <button v-for="entry in LEVELS" :key="entry" class="choice" type="button" role="radio" :aria-checked="level === entry" @click="level = entry">{{ COMPUTER_LEVEL_NAME[entry] }}</button>
      </div>
      <small>{{ LEVEL_NOTE[level] }} A win pays {{ ARENA.pay.computer[level - 1] }} coins, up to {{ ARENA.pay.dailyCap.computer }} a day.</small>
    </div>

    <div v-else-if="kind === 'friend'" class="field">
      <span id="arena-new-friend">Friend</span>
      <div v-if="!friends.length" class="notice">
        <span class="grow">You have no friends here yet. Meet people nearby, or use “Find someone” to play a member you have not met.</span>
        <RouterLink class="btn sm" to="/people" @click="emit('close')">People</RouterLink>
      </div>
      <template v-else>
        <input v-if="friends.length > 6" v-model="filter" class="input" type="search" placeholder="Search your friends" aria-label="Search your friends" />
        <div class="friends" role="radiogroup" aria-labelledby="arena-new-friend">
          <button v-for="friend in shownFriends" :key="friend.id" class="friend" type="button" role="radio" :aria-checked="friendId === friend.id" @click="friendId = friend.id">
            <MemberBadge :member-id="friend.id" :look="friend.look" :size="32" :online="friend.online" />
            <span class="grow truncate">{{ friend.displayName }}</span>
            <span class="tiny muted">{{ friend.online ? 'Here now' : 'Away' }}</span>
          </button>
          <p v-if="!shownFriends.length" class="muted small">No friend matches “{{ filter }}”.</p>
        </div>
      </template>
    </div>

    <div v-else-if="kind === 'community'" class="field">
      <span>Community</span>
      <div v-if="!communities.length" class="notice">
        <span class="grow">You are not in a community yet. Join one to challenge its members.</span>
        <RouterLink class="btn sm" to="/communities" @click="emit('close')">Communities</RouterLink>
      </div>
      <select v-else v-model="challengeCommunity" class="select" aria-label="Community to challenge">
        <option v-for="entry in communities" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
      </select>
    </div>

    <p v-if="kind !== 'computer'" class="small muted">A win pays {{ ARENA.pay.human }} coins, rated or not, up to {{ ARENA.pay.dailyCap.human }} a day.</p>

    <!-- A guest's games are casual and private. The reason, and the way to the rest, sit here instead of options that would be refused. -->
    <p v-if="limits" class="notice small guest-terms">
      <span class="grow">{{ limits.message }}</span>
      <RouterLink class="btn sm" to="/save" @click="emit('close')">Save my character</RouterLink>
    </p>

    <!-- The defaults suit a first game; what they are is said beside the action below. -->
    <details class="options">
      <summary>{{ ratedOpen || audiences.length > 1 ? 'Time, rating and who can watch' : 'Time' }}</summary>
      <div class="options-body">
      <div class="field">
        <span id="arena-new-time">Time</span>
        <div class="choices times" role="radiogroup" aria-labelledby="arena-new-time">
          <button v-for="entry in TIME_CONTROLS" :key="entry.id" class="choice col" type="button" role="radio" :aria-checked="time === entry.id" :title="entry.label" @click="time = entry.id">
            <strong class="num">{{ entry.short }}</strong><span class="tiny">{{ entry.name }}</span>
          </button>
        </div>
      </div>

      <label v-if="ratedOpen" class="row rated">
        <span class="grow"><strong>Rated</strong><span class="muted small note">Counts for your rating and the standings.</span></span>
        <button class="switch" type="button" role="switch" :aria-checked="rated" aria-label="Rated" @click="rated = !rated"></button>
      </label>

      <div v-if="audiences.length > 1" class="field">
        <span>Who may watch and chat</span>
        <select v-model="audience" class="select" aria-label="Who may watch and chat">
          <option v-for="entry in audiences" :key="entry" :value="entry">{{ AUDIENCE[entry].label }}</option>
        </select>
        <select v-if="audience === 'community'" v-model="watchCommunity" class="select" aria-label="Community that may watch">
          <option v-for="entry in communities" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
        </select>
        <small>{{ AUDIENCE[audience].about }}</small>
      </div>
      </div>
    </details>

    <p class="tiny muted">{{ HONESTY }}</p>

    <template #actions>
      <span class="grow small summary"><span aria-hidden="true">{{ GAME[game].icon }}</span> {{ summary }}</span>
      <button class="btn primary go" type="button" :disabled="!ready || busy" @click="create">{{ busy ? 'Starting…' : action }}</button>
    </template>
  </ArenaSheet>
</template>

<style scoped>
.choices { display: grid; gap: 6px; }
.choices.four { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.choices.three { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.choices.times { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.choice { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 6px 8px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); font-weight: 650; color: var(--ink-2); min-width: 0; }
.choice.col { flex-direction: column; gap: 0; }
.choice:hover { background: var(--surface-2); }
.choice[aria-checked="true"] { border-color: var(--accent-strong); background: var(--accent-soft); color: var(--accent-ink); box-shadow: 0 0 0 1px var(--accent-strong) inset; }
.friends { display: flex; flex-direction: column; gap: 4px; max-height: 208px; overflow-y: auto; }
.friend { display: flex; align-items: center; gap: 10px; min-height: 46px; padding: 6px 10px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); text-align: left; }
.friend[aria-checked="true"] { border-color: var(--accent-strong); background: var(--accent-soft); box-shadow: 0 0 0 1px var(--accent-strong) inset; }
.options { border-top: 1px solid var(--line); }
.options summary { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; font-size: 0.9rem; font-weight: 650; color: var(--ink-2); list-style: none; }
.options summary::-webkit-details-marker { display: none; }
.options summary::after { content: "▾"; color: var(--muted); }
.options[open] > summary::after { transform: rotate(180deg); }
.options-body { display: flex; flex-direction: column; gap: 14px; padding-bottom: 4px; }
.rated { cursor: pointer; }
.guest-terms { flex-wrap: wrap; align-items: center; }
.guest-terms .grow { flex-basis: 200px; }
.note { display: block; }
.summary { color: var(--ink-2); }
@media (max-width: 420px) {
  .choices.times { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@media (max-width: 720px) {
  .summary { flex-basis: 100%; }
  .go { width: 100%; }
}
</style>
