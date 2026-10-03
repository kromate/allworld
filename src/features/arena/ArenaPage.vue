<script setup lang="ts">
// The game hall: three games to play against the computer, a friend, a community or whoever is
// looking; your own games (your move first); games to watch now; and the standings.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ARENA_GAMES } from '../../shared/arena.ts'
import type { ArenaGame, ArenaMatch } from '../../shared/arena.ts'
import type { CommunityId, MemberId } from '../../shared/ids.ts'
import { api, app, attempt, toast } from '../../state/app.ts'
import { arena, setArenaNavigator } from '../../state/arena.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { count } from '../../ui/format.ts'
import { useLoad } from '../../ui/useLoad.ts'
import { usePlayKeys } from '../play/keys.ts'
import { isAutomaticFriend } from '../creator/creatorView.ts'
import { guestMay } from '../guest/guestMay.ts'
import ArenaHowTo from './ArenaHowTo.vue'
import ArenaMatchRow from './ArenaMatchRow.vue'
import ArenaNewMatch from './ArenaNewMatch.vue'
import type { OpponentKind } from './ArenaNewMatch.vue'
import ArenaStandings from './ArenaStandings.vue'
import { hasBoard } from './arenaGames.ts'
import { GAME, HONESTY, gameName, rowStatus } from './arenaText.ts'

const ALL_TABS = [['play', 'Play'], ['games', 'Your games'], ['watch', 'Watch'], ['standings', 'Standings']] as const
type Tab = (typeof ALL_TABS)[number][0]

const route = useRoute()
const router = useRouter()
setArenaNavigator(path => { void router.push(path) })
usePlayKeys()

// A guest plays the computer and casual games; watching other people's games, standings, friends
// and communities are an account's. What is closed to whoever is here is neither asked for nor shown.
const canWatch = computed(() => guestMay('arena.live'))
const canRank = computed(() => guestMay('arena.standings'))
const TABS = computed(() => ALL_TABS.filter(([id]) => (id !== 'watch' || canWatch.value) && (id !== 'standings' || canRank.value)))

const one = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '')
const tab = computed<Tab>(() => TABS.value.find(([id]) => id === route.query.tab)?.[0] ?? 'play')
const go = (next: Tab): void => { void router.replace({ path: '/arena', query: next === 'play' ? {} : { tab: next } }) }
const isGame = (value: string): value is ArenaGame => (ARENA_GAMES as readonly string[]).includes(value)

const gamesLoad = useLoad(() => api('arena.games', {}), [() => arena.changed])
const mineLoad = useLoad(() => api('arena.mine', {}), [() => arena.changed])
const liveLoad = useLoad(async () => (canWatch.value ? (await api('arena.live', { game: null })).matches : []), [() => arena.changed])
// Friends to challenge: a challenge needs a friendship both accepted, so one the service made
// (the creator's) is not a choice here. It is still a friend in the Friends list and in Messages.
const friendLoad = useLoad(async () => (guestMay('friends.list') ? (await api('friends.list', {})).friends.filter(friend => !isAutomaticFriend(friend)) : []), [() => app.changed.friends])
const communityLoad = useLoad(async () => (guestMay('community.list') ? (await api('community.list', {})).mine : []), [() => app.changed.communities])

const friends = computed(() => friendLoad.data.value ?? [])
const communities = computed(() => communityLoad.data.value ?? [])
const matches = computed(() => mineLoad.data.value?.matches ?? [])
const openChallenges = computed(() => mineLoad.data.value?.open ?? [])

/** A game can be played when the service has its rules and this build has its board. */
const playable = (game: ArenaGame): boolean => hasBoard(game) && Boolean(gamesLoad.data.value?.games.find(entry => entry.game === game)?.available)
const liveCount = (game: ArenaGame): number => gamesLoad.data.value?.games.find(entry => entry.game === game)?.live ?? 0
const firstPlayable = computed(() => ARENA_GAMES.find(playable) ?? null)

// ── Your games ──

const invitations = computed(() => [...matches.value.filter(match => match.status === 'waiting' && match.me.canAccept), ...openChallenges.value])
const friendInvitations = computed(() => matches.value.filter(match => match.status === 'waiting' && match.me.role === 'invited'))
const going = computed(() => matches.value.filter(match => match.status === 'active'))
const sent = computed(() => matches.value.filter(match => match.status === 'waiting' && match.me.role === 'player'))
const done = computed(() => matches.value.filter(match => match.status !== 'active' && match.status !== 'waiting'))
const needMe = computed(() => [...invitations.value, ...going.value.filter(match => rowStatus(match).mine)])
const busyId = ref('')

async function answer(match: ArenaMatch, accept: boolean): Promise<void> {
  if (busyId.value) return
  busyId.value = match.id
  const result = await attempt('arena.respond', { matchId: match.id, accept }, accept ? undefined : 'Challenge declined.')
  busyId.value = ''
  if (result && accept && result.match.status === 'active') { void router.push(`/arena/match/${match.id}`); return }
  void mineLoad.reload()
}
async function declineAll(): Promise<void> {
  const list = friendInvitations.value
  if (!confirm(`Decline all ${list.length} challenges?`)) return
  for (const match of list) await api('arena.respond', { matchId: match.id, accept: false }).catch(() => undefined)
  toast(`${count(list.length, 'challenge')} declined.`, 'good')
  void mineLoad.reload()
}
async function cancel(match: ArenaMatch): Promise<void> {
  if (busyId.value) return
  busyId.value = match.id
  await attempt('arena.cancel', { matchId: match.id }, match.open === 'queue' ? 'You stopped looking.' : 'Challenge withdrawn.')
  busyId.value = ''
  void mineLoad.reload()
}

// ── Watch ──

const watchGame = ref<ArenaGame | null>(null)
const liveMatches = computed(() => (liveLoad.data.value ?? []).filter(match => !watchGame.value || match.game === watchGame.value))
// Games other people start are not pushed to this member, so the list is asked for again while it is open.
let poll = 0
watch(tab, next => {
  window.clearInterval(poll)
  if (next === 'watch') { void liveLoad.reload(); poll = window.setInterval(() => { void liveLoad.reload() }, 15_000) }
}, { immediate: true })
onBeforeUnmount(() => window.clearInterval(poll))

// ── Starting a game ──

const setup = ref<{ game: ArenaGame; kind: OpponentKind; friendId: MemberId | null; communityId: CommunityId | null } | null>(null)
const howTo = ref<ArenaGame | null>(null)
function newGame(game: ArenaGame, kind: OpponentKind, friendId: MemberId | null = null, communityId: CommunityId | null = null): void {
  setup.value = { game, kind, friendId, communityId }
}
function created(match: ArenaMatch): void {
  setup.value = null
  void router.push(`/arena/match/${match.id}`)
}

// Arriving from "Challenge" on a member, from a community, or from a link to one game.
const linkGame = computed(() => { const value = one(route.query.game); return isGame(value) ? value : null })
const standingsGame = ref<ArenaGame | undefined>(undefined)
watch([() => route.query.challenge, () => route.query.community, gamesLoad.data, friendLoad.data, communityLoad.data], () => {
  if (setup.value || !gamesLoad.data.value) return
  const game = (linkGame.value && playable(linkGame.value) ? linkGame.value : null) ?? firstPlayable.value
  const friendId = one(route.query.challenge) as MemberId | ''
  const communityId = one(route.query.community) as CommunityId | ''
  if (!game || (!friendId && !communityId)) return
  // A challenge link is for an account's friends and communities; a guest simply lands in the hall.
  if (!guestMay('friends.list')) { void router.replace({ path: '/arena', query: {} }); return }
  if (friendId && !friendLoad.data.value) return
  if (communityId && !communityLoad.data.value) return
  if (friendId && !friends.value.some(friend => friend.id === friendId)) toast('You can only challenge your friends. Use “Find someone” to play a member you have not met.', 'info')
  if (friendId) newGame(game, 'friend', friendId, null)
  else if (communities.value.some(entry => entry.id === communityId)) newGame(game, 'community', null, communityId as CommunityId)
  void router.replace({ path: '/arena', query: {} })
}, { immediate: true })
function playFromStandings(game: ArenaGame): void {
  if (playable(game)) newGame(game, 'queue')
  else go('play')
}
</script>

<template>
  <PanelPage title="Game hall" wide>
    <div class="tabs" role="tablist" aria-label="Game hall sections">
      <button v-for="[id, label] in TABS" :key="id" class="tab" type="button" role="tab" :aria-selected="tab === id" @click="go(id)">
        {{ label }}<span v-if="id === 'games' && needMe.length" class="count num" :aria-label="`${needMe.length} waiting for you`">{{ needMe.length }}</span>
      </button>
    </div>

    <!-- Play -->
    <template v-if="tab === 'play'">
      <div v-if="needMe.length" class="stack tight">
        <h2 class="sr-only">Waiting for you</h2>
        <ArenaMatchRow v-for="match in needMe.slice(0, 3)" :key="match.id" :match="match">
          <template v-if="match.me.canAccept">
            <button class="btn sm primary" type="button" :disabled="busyId === match.id" @click="answer(match, true)">Accept</button>
            <button v-if="match.me.role === 'invited'" class="btn sm" type="button" :disabled="busyId === match.id" @click="answer(match, false)">Decline</button>
          </template>
          <RouterLink v-else class="btn sm primary" :to="`/arena/match/${match.id}`">Play</RouterLink>
        </ArenaMatchRow>
        <button v-if="needMe.length > 3" class="btn sm ghost more" type="button" @click="go('games')">See all {{ needMe.length }} waiting for you</button>
      </div>

      <StateView v-if="gamesLoad.state.value !== 'ready'" :state="gamesLoad.state.value === 'error' ? 'error' : 'loading'" :message="gamesLoad.error.value" @retry="gamesLoad.reload()" />
      <div v-else class="cards">
        <article v-for="game in ARENA_GAMES" :key="game" class="card game" :class="`tint-${GAME[game].tone}`" :aria-label="gameName(game)">
          <header class="row top">
            <span class="icon-chip big" :class="GAME[game].tone" aria-hidden="true">{{ GAME[game].icon }}</span>
            <div class="grow">
              <h2>{{ gameName(game) }}</h2>
              <p class="small tagline">{{ GAME[game].tagline }}</p>
            </div>
            <span v-if="!playable(game)" class="chip">Coming soon</span>
            <button v-else-if="liveCount(game) && canWatch" class="chip leaf live" type="button" @click="watchGame = game; go('watch')"><span class="pulse" aria-hidden="true"></span>{{ liveCount(game) }} live now</button>
          </header>
          <!-- One way in: the sheet that opens asks who to play (computer, friend, anyone, a community). -->
          <div class="row acts">
            <button v-if="playable(game)" class="btn primary" type="button" :aria-label="`Play ${gameName(game)}`" @click="newGame(game, 'computer')">Play</button>
            <button class="btn ghost" type="button" :aria-label="`How to play ${gameName(game)}`" @click="howTo = game">How to play</button>
          </div>
          <details class="more">
            <summary>{{ canRank ? 'About, practice and standings' : 'About and practice' }}</summary>
            <div class="stack tight">
              <p class="small about">{{ GAME[game].about }}</p>
              <p class="tiny muted"><span aria-hidden="true">⏱</span> A game takes {{ GAME[game].length }} · two players · live or one move a day</p>
              <p v-if="!playable(game)" class="small muted">This game is being built. It will open here when it is ready.</p>
              <div class="row wrap links">
                <RouterLink v-if="hasBoard(game)" class="btn sm" :to="`/arena/lab/${game}`">Practice board</RouterLink>
                <button v-if="canRank" class="btn sm" type="button" @click="standingsGame = game; go('standings')">Standings</button>
              </div>
            </div>
          </details>
        </article>
      </div>
      <p class="tiny muted">{{ HONESTY }}</p>
      <p class="muted small" style="text-align: center">Looking for Lane Dash or Eights? <RouterLink to="/games">Quick games</RouterLink></p>
    </template>

    <!-- Your games -->
    <template v-else-if="tab === 'games'">
      <StateView v-if="mineLoad.state.value !== 'ready'" :state="mineLoad.state.value === 'error' ? 'error' : 'loading'" :message="mineLoad.error.value" @retry="mineLoad.reload()" />
      <StateView v-else-if="!matches.length && !openChallenges.length" state="empty" art="♟️" title="No games yet" message="Your first game can start right now: the computer is always ready, and nothing rides on it.">
        <button v-if="firstPlayable" class="btn primary" type="button" @click="newGame(firstPlayable, 'computer')">Play the computer</button>
      </StateView>
      <template v-else>
        <section v-if="invitations.length" class="stack tight" aria-label="Challenges for you">
          <div class="row between"><h2>Challenges for you</h2><button v-if="friendInvitations.length > 1" class="btn sm" type="button" @click="declineAll">Decline all {{ friendInvitations.length }}</button></div>
          <ArenaMatchRow v-for="match in invitations" :key="match.id" :match="match">
            <button class="btn sm primary" type="button" :disabled="busyId === match.id" @click="answer(match, true)">Accept</button>
            <button v-if="match.me.role === 'invited'" class="btn sm" type="button" :disabled="busyId === match.id" @click="answer(match, false)">Decline</button>
          </ArenaMatchRow>
        </section>
        <section v-if="going.length" class="stack tight" aria-label="Games being played">
          <h2>Being played</h2>
          <ArenaMatchRow v-for="match in going" :key="match.id" :match="match" />
        </section>
        <section v-if="sent.length" class="stack tight" aria-label="Waiting for an opponent">
          <h2>Waiting for an opponent</h2>
          <ArenaMatchRow v-for="match in sent" :key="match.id" :match="match">
            <button class="btn sm" type="button" :disabled="busyId === match.id" @click="cancel(match)">{{ match.open === 'queue' ? 'Stop looking' : 'Withdraw' }}</button>
          </ArenaMatchRow>
        </section>
        <section v-if="done.length" class="stack tight" aria-label="Finished games">
          <h2>Finished</h2>
          <ArenaMatchRow v-for="match in done" :key="match.id" :match="match" />
        </section>
        <button v-if="firstPlayable && !going.length" class="btn" type="button" @click="go('play')">Start another game</button>
      </template>
    </template>

    <!-- Watch -->
    <template v-else-if="tab === 'watch'">
      <div class="row wrap" role="group" aria-label="Game">
        <button class="btn sm" :class="{ dark: watchGame === null }" type="button" :aria-pressed="watchGame === null" @click="watchGame = null">All games</button>
        <button v-for="game in ARENA_GAMES" :key="game" class="btn sm" :class="{ dark: watchGame === game }" type="button" :aria-pressed="watchGame === game" @click="watchGame = game">
          <span aria-hidden="true">{{ GAME[game].icon }}</span>{{ gameName(game) }}
        </button>
      </div>
      <StateView v-if="liveLoad.state.value !== 'ready'" :state="liveLoad.state.value === 'error' ? 'error' : 'loading'" :message="liveLoad.error.value" @retry="liveLoad.reload()" />
      <StateView v-else-if="!liveMatches.length" state="empty" art="👀" title="Nothing to watch right now"
        :message="watchGame ? `Nobody is playing ${gameName(watchGame)} where you can watch. Games open to everyone, to friends or to your communities show up here while they are played.` : 'Games open to everyone, to friends or to your communities show up here while they are played. Start one yourself and others can watch you.'">
        <button v-if="firstPlayable" class="btn primary sm" type="button" @click="newGame(watchGame && playable(watchGame) ? watchGame : firstPlayable, 'computer')">Play the computer</button>
      </StateView>
      <div v-else class="stack tight">
        <p class="small muted">Being played now, most watched first. Watching is free and you can join the chat.</p>
        <ArenaMatchRow v-for="match in liveMatches" :key="match.id" :match="match">
          <RouterLink class="btn sm" :to="`/arena/match/${match.id}`">Watch</RouterLink>
        </ArenaMatchRow>
      </div>
    </template>

    <!-- Standings -->
    <ArenaStandings v-else-if="tab === 'standings'" :communities="communities" :game="standingsGame ?? linkGame ?? firstPlayable ?? undefined" @play="playFromStandings" />

    <ArenaNewMatch
      v-if="setup" :game="setup.game" :kind="setup.kind" :friends="friends" :communities="communities" :friend-id="setup.friendId" :community-id="setup.communityId"
      @close="setup = null" @created="created"
    />
    <ArenaHowTo v-if="howTo" :game="howTo" @close="howTo = null" />
  </PanelPage>
</template>

<style scoped>
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 12px; }
.game { display: flex; flex-direction: column; gap: 10px; }
.top { align-items: flex-start; }
.icon-chip.big { width: 46px; height: 46px; font-size: 1.5rem; border-radius: 14px; }
.tagline { color: var(--ink-2); font-weight: 600; }
.about { color: var(--ink-2); }
.acts { gap: 8px; margin-top: auto; }
.acts .btn { min-height: 44px; }
.acts .btn.primary { flex: 1 1 auto; }
.more { margin-bottom: -6px; }
.more summary { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 8px; cursor: pointer; font-size: 0.86rem; font-weight: 650; color: var(--ink-2); list-style: none; }
.more summary::-webkit-details-marker { display: none; }
.more summary::after { content: "▾"; color: var(--muted); }
.more[open] > summary::after { transform: rotate(180deg); }
.more[open] { margin-bottom: 0; }
.links { gap: 8px; margin-top: 2px; }
.live { border: 0; cursor: pointer; min-height: 26px; }
.pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--leaf); animation: beat 1.6s ease infinite; }
@keyframes beat { 50% { opacity: 0.35; } }
.more { align-self: flex-start; }
h2 { font-size: 1.02rem; }
section + section { margin-top: 4px; }
</style>
