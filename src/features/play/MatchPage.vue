<script setup lang="ts">
// One match: an invitation to answer, a Lane Dash run to play, an Eights table to play at or
// watch, or the record of how it ended. Never a dead end — an expired match says what happened
// and offers a new one.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { MatchId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import type { DashAttempt, DashResult, Match, MatchPlayer, TableAction, TableView } from '../../shared/play.ts'
import { api, app, attempt, messageOf, myId, onReconnect, onServerEvent, refreshPoints, toast } from '../../state/app.ts'
import { getEngine, rejoinStreet, world } from '../../state/world.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count, dateTime, relativeTime } from '../../ui/format.ts'
import DashGame from './DashGame.vue'
import EightsTable from './EightsTable.vue'
import { usePlayKeys } from './keys.ts'
import { AUDIENCE, COIN_HONESTY, GAME, ago, isOpen, isSolo, matchStatus, nameList, needsAnswer, othersIn, playerOf } from './playText.ts'

const route = useRoute()
const router = useRouter()
const matchId = String(route.params.id) as MatchId

const match = ref<Match | null>(null)
const table = ref<TableView | null>(null)
const viewer = ref<'player' | 'spectator' | 'outsider'>('outsider')
/** Set when a table that was open to this member stops being open (blocked, removed from the audience). */
const closedToMe = ref('')

const { data: communityData } = useLoad(() => api('community.list', {}))
/** The link names no match this member can open: a wrong or incomplete id, or a match that is gone. */
const missing = ref(false)
const { state, error, reload } = useLoad(async () => {
  try {
    const got = await api('match.get', { matchId })
    match.value = got.match
    table.value = got.table
    viewer.value = got.viewer
    closedToMe.value = ''
    missing.value = false
    return got
  } catch (cause) {
    // Retrying cannot mend a bad link, so it gets its own plain page. Anything else (closed to
    // this member, the service away, the connection dropped) keeps its reason and Try again.
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid')) { missing.value = true; return null }
    throw cause
  }
}, [() => app.changed.matches])

const me = computed(() => myId())
const self = computed(() => (match.value ? playerOf(match.value, me.value) : null))
const status = computed(() => (match.value ? matchStatus(match.value, me.value) : null))
const game = computed(() => (match.value ? GAME[match.value.game] : null))
const solo = computed(() => Boolean(match.value && isSolo(match.value)))
const subtitle = computed(() => {
  if (!match.value) return undefined
  if (solo.value) return 'Solo practice'
  const names = nameList(othersIn(match.value, me.value).map(player => player.member.displayName))
  return viewer.value === 'player' ? `With ${names}` : `${names} are playing`
})
/** At a live table the table's own turn banner says where things stand. */
const atTable = computed(() => Boolean(match.value && match.value.game === 'eights' && match.value.status === 'active' && table.value && !closedToMe.value))
const hostName = computed(() => (match.value ? (match.value.host === me.value ? 'You' : playerOf(match.value, match.value.host)?.member.displayName ?? 'A member') : ''))
const invitedNames = computed(() => (match.value ? nameList(match.value.players.filter(player => player.member.id !== match.value!.host).map(player => (player.member.id === me.value ? 'you' : player.member.displayName))) : ''))
const ranked = computed(() => (match.value ? [...match.value.players].sort((a, b) => (a.placed ?? 99) - (b.placed ?? 99)) : []))
const awaited = computed(() => (match.value ? nameList(othersIn(match.value, me.value).filter(player => player.state === 'invited' || (match.value!.game === 'lane-dash' && player.state === 'joined')).map(player => player.member.displayName)) : ''))
const communityName = computed(() => communityData.value?.mine.find(entry => entry.id === match.value?.communityId)?.name ?? null)
const audienceText = computed(() => {
  if (!match.value) return ''
  if (match.value.audience === 'community') return communityName.value ? `Members of ${communityName.value} can watch.` : 'Members of one community can watch.'
  return AUDIENCE[match.value.audience].about
})
const watchingText = computed(() => {
  if (!match.value) return ''
  if (match.value.game !== 'eights') return 'Lane Dash has no live table, so there is nothing to watch as it happens.'
  return match.value.spectators ? `${count(match.value.spectators, 'person is', 'people are')} watching now.` : 'Nobody is watching right now.'
})
/** Someone to send a fresh challenge to: the host if you were invited, otherwise the first person you invited. */
const challengeAgain = computed(() => {
  if (!match.value || viewer.value !== 'player' || solo.value) return null
  const others = othersIn(match.value, me.value)
  const target = others.find(player => player.member.id === match.value!.host) ?? others[0]
  return target && target.member.relation === 'friend' ? target.member : null
})
const canRematch = computed(() => Boolean(match.value && match.value.status === 'finished' && viewer.value === 'player' && !solo.value && self.value && self.value.state !== 'declined'))
const playerState = (player: MatchPlayer): string => {
  if (!match.value) return ''
  if (player.state === 'invited') return isOpen(match.value) ? 'Invited — has not answered' : 'Did not answer'
  if (player.state === 'declined') return 'Declined'
  if (match.value.game === 'lane-dash') return player.state === 'played' ? 'Run counted' : isOpen(match.value) ? 'Joined — has not played yet' : 'Did not play'
  if (match.value.status === 'finished') return match.value.winner === player.member.id ? 'Won' : `Placed ${player.placed ?? '—'}`
  return match.value.status === 'active' ? 'At the table' : 'Joined'
}

// ── Answering, rematch ──

const busy = ref(false)
async function respond(accept: boolean): Promise<void> {
  if (busy.value) return
  busy.value = true
  const answered = await attempt('match.respond', { matchId, accept }, accept ? 'You are in.' : 'Challenge declined.')
  busy.value = false
  if (answered) match.value = answered.match
  void reload()
}
async function rematch(): Promise<void> {
  if (busy.value) return
  busy.value = true
  const asked = myId()
  const made = await attempt('match.rematch', { matchId })
  busy.value = false
  // A reply after this page was left, or after another player took over, must not move them.
  if (made && alive && myId() === asked) void router.push(`/games/match/${made.match.id}`)
}

// ── Lane Dash ──

const run = ref<DashAttempt | null>(null)
const beginning = ref(false)
async function play(): Promise<void> {
  if (beginning.value) return
  beginning.value = true
  const begun = await attempt('dash.begin', { matchId })
  beginning.value = false
  if (begun) run.value = begun.attempt
  else void reload()
}
function onRun(result: DashResult): void {
  match.value = result.match
  if (result.accepted) void refreshPoints()
}

// ── Eights ──

const acting = ref(false)
async function act(action: TableAction): Promise<void> {
  if (acting.value) return
  acting.value = true
  try { table.value = (await api('table.act', { matchId, action })).table } catch (cause) {
    // The table may have moved on (the turn clock ran out): say why and show where it stands now.
    toast(messageOf(cause), 'bad')
    void reload()
  } finally { acting.value = false }
}

const liveTable = computed(() => Boolean(match.value && match.value.game === 'eights' && match.value.status === 'active' && !closedToMe.value))
const spectating = computed(() => liveTable.value && viewer.value === 'spectator')
let inTableRoom = false
/** The street scene's room at the moment we stepped into the table's room. */
let enteredBeside: string | null = null
let entering = false
let pollTimer = 0
let rejoinTimer = 0
let alive = true

/**
 * Spectators only get live table pushes while they are in the table's room. The street scene
 * joins its own room whenever it loads or reloads, which takes the member out of this one, so
 * this goes back in each time that happens.
 */
async function enterTableRoom(): Promise<void> {
  if (entering) return
  entering = true
  try {
    while (alive && spectating.value && world.state !== 'loading' && !(inTableRoom && enteredBeside === world.roomKey)) {
      const beside = world.roomKey
      const engine = getEngine()
      // The avatar keeps its own spot, so the street scene does not snap it elsewhere while we watch.
      await api('room.enter', { ref: { kind: 'table', matchId }, pos: engine?.position ?? { x: 0, z: 0 }, heading: engine?.facing ?? 0 })
      inTableRoom = true
      enteredBeside = beside
    }
  } catch { /* the poll below still keeps the table current */ } finally { entering = false }
  if (!alive) leaveTableRoom()
}
function leaveTableRoom(): void {
  if (!inTableRoom) return
  inTableRoom = false
  void rejoinStreet()
}

async function poll(): Promise<void> {
  if (!liveTable.value || document.hidden || acting.value) return
  try {
    const seen = await api('table.watch', { matchId })
    if (!alive || acting.value) return
    table.value = seen.table
    match.value = seen.match
  } catch (cause) {
    if ((cause as { code?: string }).code === 'forbidden') closedToMe.value = messageOf(cause)
  }
}

watch([spectating, () => world.state, () => world.roomKey], () => { void enterTableRoom() }, { immediate: true })
watch(liveTable, live => {
  window.clearInterval(pollTimer)
  // A spectator leans on this as the fallback for pushes; a player only needs it to keep the watcher count fresh.
  if (live) pollTimer = window.setInterval(poll, viewer.value === 'spectator' ? 4000 : 8000)
}, { immediate: true })
watch(viewer, () => { if (liveTable.value) { window.clearInterval(pollTimer); pollTimer = window.setInterval(poll, viewer.value === 'spectator' ? 4000 : 8000) } })
watch(() => match.value?.status, (now, before) => { if (now === 'finished' && before && before !== 'finished') void refreshPoints() })

const stopEvents = onServerEvent(event => {
  if (event.type === 'table.state' && event.matchId === matchId) table.value = event.table
  else if (event.type === 'match.changed' && event.matchId === matchId) void reload()
})
const stopReconnect = onReconnect(() => {
  void reload()
  // The service forgot which room we were in; the street scene re-enters first, then we return to the table.
  if (inTableRoom) { inTableRoom = false; window.clearTimeout(rejoinTimer); rejoinTimer = window.setTimeout(() => { void enterTableRoom() }, 1200) }
})
onMounted(() => document.addEventListener('visibilitychange', poll))
onBeforeUnmount(() => {
  alive = false
  stopEvents()
  stopReconnect()
  window.clearInterval(pollTimer)
  window.clearTimeout(rejoinTimer)
  document.removeEventListener('visibilitychange', poll)
  leaveTableRoom()
})

usePlayKeys()
</script>

<template>
  <PanelPage :title="game ? game.name : 'Match'" :subtitle="run ? undefined : subtitle" back="/games" wide>
    <template v-if="state !== 'ready' || !match || !status || !game">
      <StateView v-if="missing" state="empty" art="🎮" title="This match is unavailable" message="The link may be incomplete, or the match is no longer kept. Matches you play in, and open tables you may watch, are listed under Games.">
        <RouterLink class="btn primary" to="/games">Back to Games</RouterLink>
      </StateView>
      <StateView v-else-if="state !== 'error'" state="loading" />
      <div v-else class="card tint-coral stack">
        <h2>This match cannot be opened</h2>
        <p>{{ error }}</p>
        <p class="small muted">It may be closed to you, or the link may be wrong. Matches you play in, and open tables you may watch, are listed under Games.</p>
        <div class="row wrap">
          <RouterLink class="btn primary" to="/games">Back to Games</RouterLink>
          <button class="btn" type="button" @click="reload">Try again</button>
        </div>
      </div>
    </template>

    <!-- A Lane Dash run takes the whole window -->
    <template v-else-if="run">
      <div class="row between">
        <span class="muted small grow">Your run for this match</span>
        <button class="btn sm" type="button" @click="run = null">{{ match.canPlay ? 'Leave run' : 'Close' }}</button>
      </div>
      <DashGame :key="run.attemptToken" :attempt="run" @result="onRun">
        <template #actions>
          <div class="row wrap">
            <button v-if="match.canPlay" class="btn primary" type="button" :disabled="beginning" @click="play">{{ beginning ? 'Setting up…' : 'Run again' }}</button>
            <button class="btn" :class="{ primary: !match.canPlay }" type="button" @click="run = null">See the match</button>
          </div>
        </template>
      </DashGame>
    </template>

    <div v-else class="match">
      <!-- Where it stands -->
      <section v-if="!atTable" class="card stack" :class="status.mine ? 'tint-amber' : match.status === 'finished' ? 'tint-leaf' : match.status === 'active' || match.status === 'invited' ? 'tint-sky' : 'tint-coral'" aria-live="polite">
        <div class="row">
          <span class="icon-chip" :class="game.tone" aria-hidden="true">{{ game.icon }}</span>
          <div class="grow">
            <span class="chip" :class="status.tone">{{ status.label }}</span>
            <h2>{{ status.text }}</h2>
          </div>
        </div>

        <!-- An invitation to answer -->
        <template v-if="needsAnswer(match, me)">
          <p>{{ hostName }} challenged you to {{ game.name }}. {{ game.about }} {{ game.pays }}</p>
          <p class="small muted">Answer by {{ dateTime(match.expiresAt) }} ({{ relativeTime(match.expiresAt) }}).</p>
          <div class="row wrap">
            <button class="btn primary" type="button" :disabled="busy" @click="respond(true)">{{ busy ? 'Answering…' : 'Accept' }}</button>
            <button class="btn" type="button" :disabled="busy" @click="respond(false)">Decline</button>
          </div>
        </template>

        <!-- Still open -->
        <template v-else-if="isOpen(match)">
          <template v-if="match.game === 'lane-dash'">
            <template v-if="match.canPlay">
              <p>One run counts for this match, on the same course as everyone else. It starts after a 3-2-1 countdown and takes under a minute. {{ game.pays }}</p>
              <div class="row wrap"><button class="btn primary" type="button" :disabled="beginning" @click="play">{{ beginning ? 'Setting up…' : 'Play your run' }}</button></div>
              <p v-if="awaited !== 'another player' && match.status === 'invited'" class="small muted">{{ awaited }} {{ awaited.includes(' and ') ? 'have' : 'has' }} until {{ dateTime(match.expiresAt) }} to answer. You do not need to wait for them.</p>
            </template>
            <p v-else-if="viewer === 'player'">Your run is in. The match ends when everyone has played, or {{ relativeTime(match.expiresAt) }} at the latest.</p>
            <p v-else>Runs are still being played. Scores appear below as the service accepts them.</p>
          </template>
          <template v-else-if="match.status === 'invited'">
            <p>The table opens as soon as everyone invited has answered, with at least two players. Invitations run out {{ relativeTime(match.expiresAt) }}.</p>
          </template>
        </template>

        <!-- Finished, expired, declined, cancelled -->
        <template v-else>
          <p v-if="match.status === 'finished' && match.game === 'lane-dash' && !solo">Highest score wins; level scores go to whoever reached theirs first. Finished {{ match.finishedAt ? ago(match.finishedAt) : '' }}.</p>
          <p v-else-if="match.status === 'finished' && solo">A practice run, finished {{ match.finishedAt ? ago(match.finishedAt) : '' }}.</p>
          <p v-else-if="match.status === 'finished'">Finished {{ match.finishedAt ? ago(match.finishedAt) : '' }}. The final table is below.</p>
          <p v-else-if="match.status === 'expired'">
            {{ hostName }} invited {{ invitedNames }} to {{ game.name }} on {{ dateTime(match.createdAt) }}.
            {{ table ? 'The game ran out of time' : 'The invitation ran out' }} on {{ dateTime(match.expiresAt) }}, so nothing was scored.
          </p>
          <p v-else-if="match.status === 'declined'">{{ hostName }} invited {{ invitedNames }} to {{ game.name }} on {{ dateTime(match.createdAt) }}, and not enough players took it up.</p>
          <p v-else>{{ hostName }} invited {{ invitedNames }} to {{ game.name }} on {{ dateTime(match.createdAt) }}. The match was cancelled.</p>

          <div class="row wrap">
            <RouterLink v-if="match.rematch" class="btn primary" :to="`/games/match/${match.rematch}`">Open the rematch</RouterLink>
            <button v-else-if="canRematch" class="btn primary" type="button" :disabled="busy" @click="rematch">{{ busy ? 'Setting up…' : 'Rematch' }}</button>
            <RouterLink v-if="challengeAgain" class="btn" :class="{ primary: !match.rematch && !canRematch }" :to="`/games?challenge=${challengeAgain.id}`">Challenge {{ challengeAgain.displayName }} again</RouterLink>
            <RouterLink v-if="solo" class="btn primary" to="/games">Practise again</RouterLink>
            <RouterLink v-else class="btn" :class="{ primary: !match.rematch && !canRematch && !challengeAgain }" to="/games">All games</RouterLink>
          </div>
          <p v-if="match.rematchOf" class="small"><RouterLink :to="`/games/match/${match.rematchOf}`">See the match this was a rematch of</RouterLink></p>
        </template>
      </section>

      <div v-if="viewer === 'spectator' && match.game !== 'eights'" class="notice sky"><span aria-hidden="true">👀</span><span><strong>You are watching.</strong> You can see the scores, and only the players can play.</span></div>
      <div v-if="closedToMe" class="notice coral" role="alert">
        <span class="grow">{{ closedToMe }}</span>
        <RouterLink class="btn sm" to="/games">Back to Games</RouterLink>
      </div>

      <!-- The Eights table -->
      <EightsTable v-if="match.game === 'eights' && table && !closedToMe" :table="table" :match="match" :me="me" :busy="acting" @act="act" />

      <!-- Players -->
      <section class="stack tight" aria-labelledby="players-title">
        <h3 id="players-title">{{ solo ? 'Player' : 'Players' }}</h3>
        <ul class="card players">
          <li v-for="player in ranked" :key="player.member.id" class="player">
            <span v-if="match.status === 'finished' && player.placed" class="place num"><span class="sr-only">Place </span>{{ player.placed }}</span>
            <MemberBadge :member-id="player.member.id" :look="player.member.look" :size="38" :online="player.member.online" />
            <span class="grow who">
              <span class="row" style="gap: 6px">
                <strong class="truncate">{{ player.member.id === me ? 'You' : player.member.displayName }}</strong>
                <span v-if="player.member.id === match.host && !solo" class="chip">Host</span>
                <span v-if="match.winner === player.member.id" class="chip leaf">Winner</span>
              </span>
              <span class="small muted">{{ playerState(player) }}</span>
            </span>
            <strong v-if="match.game === 'lane-dash' && player.score !== null" class="num score">{{ player.score }}</strong>
          </li>
        </ul>
        <p v-if="match.game === 'lane-dash'" class="tiny muted">Scores are worked out by the service from each player’s lane changes.</p>
      </section>

      <!-- Who can watch: the answer in the row, the explanation behind it -->
      <details class="disclosure audience">
        <summary><span aria-hidden="true">{{ match.audience === 'players-only' ? '🔒' : '👥' }}</span><span>Who can watch: {{ solo ? 'only you' : AUDIENCE[match.audience].label.toLowerCase() }}</span><span v-if="!solo && match.game === 'eights' && match.spectators" class="chip num">{{ match.spectators }} watching</span></summary>
        <p class="small">{{ solo ? 'Practice runs are private.' : audienceText }} {{ solo ? '' : watchingText }}</p>
      </details>
      <p class="tiny muted">{{ COIN_HONESTY }}</p>
    </div>
  </PanelPage>
</template>

<style scoped>
.match { display: flex; flex-direction: column; gap: 14px; }
.players { list-style: none; margin: 0; padding: 4px 12px; }
.player { display: flex; align-items: center; gap: 10px; padding: 9px 0; min-width: 0; }
.player + .player { border-top: 1px solid var(--line); }
.place { display: grid; place-items: center; width: 24px; height: 24px; border-radius: 50%; background: var(--surface-3); font-size: 0.78rem; font-weight: 750; flex: none; }
.who { display: flex; flex-direction: column; min-width: 0; }
.score { font-size: 1.15rem; }
h2 { margin-top: 4px; }
/* Small buttons grow to a full touch target on touch screens. */
@media (pointer: coarse) { .btn.sm { min-height: 40px; padding: 0 14px; } }
</style>
