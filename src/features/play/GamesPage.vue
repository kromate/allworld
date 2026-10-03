<script setup lang="ts">
// Games: practise Lane Dash, challenge friends, answer invitations, watch open tables, and the boards.
import { computed, inject, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { CommunityId, MemberId } from '../../shared/ids.ts'
import { DASH, MATCH_INVITE_HOURS } from '../../shared/play.ts'
import type { Audience, DashAttempt, GameKind, Match } from '../../shared/play.ts'
import { api, app, attempt, myId, onReconnect, toast } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count } from '../../ui/format.ts'
import { isAutomaticFriend } from '../creator/creatorView.ts'
import GuestGate from '../guest/GuestGate.vue'
import { guestMay } from '../guest/guestMay.ts'
import { GUEST_CONTROL } from '../guest/guestView.ts'
import BoardList from './BoardList.vue'
import DashGame from './DashGame.vue'
import MatchRow from './MatchRow.vue'
import { usePlayKeys } from './keys.ts'
import { AUDIENCE, COIN_HONESTY, GAME, isOpen, matchStatus, nameList, needsAnswer } from './playText.ts'

const route = useRoute()
const router = useRouter()
const MAX_INVITES = 3
const GAMES: GameKind[] = ['lane-dash', 'eights']
const AUDIENCES: Audience[] = ['players-only', 'friends', 'community']

// What a guest may ask for is the contract's call (guestAccess, which the service applies too), not this page's: a guest is not sent requests the
// service would refuse, and is told why instead of being shown an error or an empty list. Challenges, matches with other people, open tables and
// boards are an account's; the solo run is the guest's and is untouched.
const guest = inject(GUEST_CONTROL, null)
const mayChallenge = computed(() => guestMay('match.create'))
const mayList = computed(() => guestMay('match.list'))
const mayWatch = computed(() => guestMay('match.open'))
const mayCommunities = computed(() => guestMay('community.list'))
const mayBoards = computed(() => guestMay('board.get'))
/** The one signal the save page and the welcome use: saving is offered only where the host can take it. */
const canSave = computed(() => guest?.session.value?.signIn === 'available')

// Whatever is asked is tagged with who asked. An answer that arrives after the player has changed (a guest was saved, another account opened)
// is never shown to the new one, and the lists are asked again for whoever plays now.
const who = computed(() => (app.guest ? `guest:${app.guest.memberId}` : `member:${myId() ?? ''}`))
interface Asked<T> { by: string; data: T | null }
async function asking<T>(allowed: boolean, ask: () => Promise<T>): Promise<Asked<T>> {
  const by = who.value
  return { by, data: allowed ? await ask() : null }
}
const answeredFor = <T,>(box: Asked<T> | null): T | null => (box && box.by === who.value ? box.data : null)
// A reply that lands after the page was left, or after the player changed, answers a request nobody is waiting on: it must not move them.
let alive = true
const stillAsking = (by: string): boolean => alive && by === who.value

const { data: friendBox, state: friendState, error: friendError, reload: reloadFriends } = useLoad(() => asking(mayChallenge.value, () => api('friends.list', {})), [() => app.changed.friends, who])
const { data: communityBox } = useLoad(() => asking(mayCommunities.value, () => api('community.list', {})), [() => app.changed.communities, who])
const { data: matchBox, state: matchState, error: matchError, reload: reloadMatches } = useLoad(() => asking(mayList.value, () => api('match.list', {})), [() => app.changed.matches, who])
const { data: tableBox, state: tableState, error: tableError, reload: reloadTables } = useLoad(() => asking(mayWatch.value, () => api('match.open', {})), [() => app.changed.matches, who])
const friendData = computed(() => answeredFor(friendBox.value))
const communityData = computed(() => answeredFor(communityBox.value))
const matchData = computed(() => answeredFor(matchBox.value))
const tableData = computed(() => answeredFor(tableBox.value))

const one = (value: unknown): string => (Array.isArray(value) ? String(value[0] ?? '') : typeof value === 'string' ? value : '')
const challengeParam = computed(() => one(route.query.challenge) as MemberId | '')
const communityParam = computed(() => one(route.query.community) as CommunityId | '')

// ── Solo practice ──

const practice = ref<DashAttempt | null>(null)
const practiceBusy = ref(false)
async function startPractice(): Promise<void> {
  if (practiceBusy.value) return
  practiceBusy.value = true
  const asked = who.value
  const begun = await attempt('dash.begin', { matchId: null })
  practiceBusy.value = false
  if (begun && who.value === asked) practice.value = begun.attempt
}
// A run belongs to the player who began it.
watch(who, () => { practice.value = null })

// ── Challenge a friend ──

const game = ref<GameKind>('lane-dash')
const picked = ref<MemberId[]>([])
const audience = ref<Audience>('players-only')
const communityId = ref<CommunityId | ''>('')
const filter = ref('')
const sending = ref(false)

// A challenge needs a friendship both accepted; one the service made (the creator's) is not offered here.
const friends = computed(() => (friendData.value?.friends ?? []).filter(friend => !isAutomaticFriend(friend)))
const mine = computed(() => communityData.value?.mine ?? [])
const shownFriends = computed(() => {
  const query = filter.value.trim().toLowerCase()
  return query ? friends.value.filter(friend => friend.displayName.toLowerCase().includes(query)) : friends.value
})
const pickedNames = computed(() => nameList(friends.value.filter(friend => picked.value.includes(friend.id)).map(friend => friend.displayName)))
const full = computed(() => picked.value.length >= MAX_INVITES)
/** The member named in the link is not a friend, so the service would refuse the challenge. */
const strangerAsked = computed(() => Boolean(challengeParam.value && friendData.value && !friends.value.some(friend => friend.id === challengeParam.value)))
const canSend = computed(() => picked.value.length > 0 && !sending.value && (audience.value !== 'community' || Boolean(communityId.value)))

// Arriving from "Challenge" on a member, or from a community: start with them chosen.
watch([friendData, challengeParam], () => {
  const wanted = challengeParam.value
  if (wanted && friends.value.some(friend => friend.id === wanted) && !picked.value.includes(wanted) && !full.value) picked.value.push(wanted)
  // Someone who stopped being a friend cannot stay picked.
  picked.value = picked.value.filter(id => friends.value.some(friend => friend.id === id))
}, { immediate: true })
watch([communityData, communityParam], () => {
  const list = mine.value
  const wanted = communityParam.value && list.find(entry => entry.id === communityParam.value)
  if (wanted) { audience.value = 'community'; communityId.value = wanted.id }
  else if (!list.some(entry => entry.id === communityId.value)) communityId.value = list[0]?.id ?? ''
  if (audience.value === 'community' && communityData.value && !list.length) audience.value = 'players-only'
}, { immediate: true })

async function send(): Promise<void> {
  if (!canSend.value) return
  sending.value = true
  const asked = who.value
  const made = await attempt('match.create', {
    game: game.value, invite: [...picked.value], audience: audience.value, communityId: audience.value === 'community' ? communityId.value || null : null,
  }, `Challenge sent to ${pickedNames.value}.`)
  sending.value = false
  if (made && stillAsking(asked)) void router.push(`/games/match/${made.match.id}`)
}

// ── Your matches ──

const matches = computed(() => matchData.value?.matches ?? [])
const invitations = computed(() => matches.value.filter(match => needsAnswer(match, myId())))
const current = computed(() => matches.value.filter(match => isOpen(match) && !needsAnswer(match, myId()))
  .sort((a, b) => Number(matchStatus(b, myId()).mine) - Number(matchStatus(a, myId()).mine)))
const past = computed(() => matches.value.filter(match => !isOpen(match)))
const answering = ref('')
const confirmDeclineAll = ref(false)

// ── Folded sections ──
// The challenge form opens by itself for a member or community named in the link; the boards load when opened.
const challengeOpen = ref(Boolean(challengeParam.value || communityParam.value))
const boardsOpen = ref(Boolean(communityParam.value))
watch([challengeParam, communityParam], ([member, community]) => { if (member || community) challengeOpen.value = true })

async function respond(match: Match, accept: boolean): Promise<void> {
  if (answering.value) return
  answering.value = match.id
  const asked = who.value
  const answered = await attempt('match.respond', { matchId: match.id, accept }, accept ? undefined : 'Challenge declined.')
  answering.value = ''
  if (!stillAsking(asked)) return
  if (answered && accept) void router.push(`/games/match/${match.id}`)
  else void reloadMatches()
}

/** Answer every invitation on show with one action. */
async function respondAll(accept: boolean): Promise<void> {
  if (answering.value) return
  const targets = [...invitations.value]
  const asked = who.value
  answering.value = 'all'
  let done = 0
  for (const match of targets) {
    // Another player's session must not answer the previous player's invitations.
    if (who.value !== asked) break
    try { await api('match.respond', { matchId: match.id, accept }); done++ } catch { /* reported in the summary below */ }
  }
  answering.value = ''
  confirmDeclineAll.value = false
  if (who.value !== asked) return
  const verb = accept ? 'Accepted' : 'Declined'
  if (done === targets.length) toast(`${verb} ${count(done, 'challenge')}.`, 'good')
  else toast(`${verb} ${done} of ${targets.length}. The others could not be answered — they may have just expired.`, 'bad')
  void reloadMatches()
}

// Tables to watch change without any event reaching a spectator, so look again now and then.
let tablesTimer = 0
const stopReconnect = onReconnect(() => {
  void reloadMatches()
  void reloadTables()
})
onMounted(() => { tablesTimer = window.setInterval(() => { if (!document.hidden && !practice.value && mayWatch.value) void reloadTables() }, 15_000) })
onBeforeUnmount(() => { alive = false; stopReconnect(); window.clearInterval(tablesTimer) })

usePlayKeys()
</script>

<template>
  <PanelPage :title="practice ? 'Lane Dash' : 'Games'" :subtitle="practice ? undefined : mayChallenge ? 'Play, challenge friends and watch' : 'Practise and play'" wide>
    <!-- A practice run takes the whole window -->
    <template v-if="practice">
      <div class="row between">
        <span class="muted small grow">Practice run · {{ mayBoards ? 'counts on your boards and ' : '' }}pays coins</span>
        <button class="btn sm" type="button" @click="practice = null">Leave run</button>
      </div>
      <DashGame :key="practice.attemptToken" :attempt="practice">
        <template #actions>
          <div class="row wrap">
            <button class="btn primary" type="button" :disabled="practiceBusy" @click="startPractice">{{ practiceBusy ? 'Setting up…' : 'Play again' }}</button>
            <button class="btn" type="button" @click="practice = null">Back to games</button>
          </div>
        </template>
      </DashGame>
    </template>

    <div v-else class="games">
      <!-- What can be played this minute comes first: games waiting on this member, then a new one. -->
      <StateView v-if="mayList && matchState === 'error'" state="error" :message="matchError" @retry="reloadMatches" />
      <section v-else-if="invitations.length || current.length" class="stack" aria-labelledby="your-matches">
        <h2 id="your-matches">Your matches</h2>
        <div v-if="invitations.length" class="stack tight">
          <div class="row between wrap">
            <h3>Invitations <span class="chip coral num">{{ invitations.length }}</span></h3>
            <div v-if="invitations.length > 1 && !confirmDeclineAll" class="row">
              <button class="btn sm" type="button" :disabled="Boolean(answering)" @click="respondAll(true)">Accept all {{ invitations.length }}</button>
              <button class="btn sm ghost danger" type="button" :disabled="Boolean(answering)" @click="confirmDeclineAll = true">Decline all</button>
            </div>
          </div>
          <div v-if="confirmDeclineAll" class="notice coral confirm" role="alertdialog" aria-label="Decline every invitation">
            <span class="grow">Decline all {{ invitations.length }} invitations? This cannot be undone, though anyone can challenge you again.</span>
            <div class="row">
              <button class="btn sm danger" type="button" :disabled="Boolean(answering)" @click="respondAll(false)">{{ answering === 'all' ? 'Declining…' : 'Decline all' }}</button>
              <button class="btn sm" type="button" @click="confirmDeclineAll = false">Keep them</button>
            </div>
          </div>
          <MatchRow v-for="match in invitations" :key="match.id" :match="match">
            <button class="btn sm primary" type="button" :disabled="Boolean(answering)" @click="respond(match, true)">{{ answering === match.id ? 'Answering…' : 'Accept' }}</button>
            <button class="btn sm" type="button" :disabled="Boolean(answering)" @click="respond(match, false)">Decline</button>
          </MatchRow>
        </div>

        <div v-if="current.length" class="stack tight">
          <h3>Open matches</h3>
          <MatchRow v-for="match in current" :key="match.id" :match="match">
            <RouterLink class="btn sm" :class="{ primary: matchStatus(match, myId()).mine }" :to="`/games/match/${match.id}`">{{ matchStatus(match, myId()).mine ? 'Play' : 'Open' }}</RouterLink>
          </MatchRow>
        </div>
      </section>

      <section class="stack" aria-labelledby="play-now">
        <h2 id="play-now">Play now</h2>
        <div class="now">
          <div class="card tint-sky stack solo">
            <div class="row">
              <span class="icon-chip sky" aria-hidden="true">{{ GAME['lane-dash'].icon }}</span>
              <div class="grow"><h3>Lane Dash</h3><span class="muted tiny">Solo practice · under a minute</span></div>
            </div>
            <p class="small grow">Switch between three lanes to dodge the barriers. {{ DASH.rows }} rows, getting faster. {{ GAME['lane-dash'].pays }}</p>
            <button class="btn primary block" type="button" :disabled="practiceBusy" @click="startPractice">{{ practiceBusy ? 'Setting up…' : 'Practise Lane Dash' }}</button>
          </div>

          <!-- The challenge form opens in place; it arrives open from "Challenge" on a member or a community. -->
          <details v-if="mayChallenge" class="disclosure challenge" :open="challengeOpen" @toggle="challengeOpen = ($event.target as HTMLDetailsElement).open">
            <summary>
              <span class="icon-chip grape" aria-hidden="true">🤝</span>
              <span class="grow"><strong id="challenge-title">Challenge a friend</strong><span class="muted tiny line">Lane Dash or Eights · they have {{ MATCH_INVITE_HOURS }} hours to answer</span></span>
            </summary>
          <form class="stack" aria-labelledby="challenge-title" @submit.prevent="send">
            <StateView v-if="friendState !== 'ready'" :state="friendState" :message="friendError" @retry="reloadFriends" />
            <StateView v-else-if="!friends.length" state="empty" art="👋" title="No friends to challenge yet" message="You can challenge someone once you are friends. Introduce yourself in People, and when they accept they will appear here.">
              <RouterLink class="btn sm primary" to="/people">Open People</RouterLink>
            </StateView>
            <template v-else>
              <p v-if="strangerAsked" class="notice">
                <span>That member is not in your friends list, so they cannot be challenged yet. <RouterLink to="/people">Introduce yourself in People</RouterLink> first.</span>
              </p>

              <div class="stack tight" role="group" aria-label="Game">
                <span class="label">Game</span>
                <div class="options">
                  <button v-for="kind in GAMES" :key="kind" class="option" type="button" :aria-pressed="game === kind" @click="game = kind">
                    <span class="row" style="gap: 6px"><span aria-hidden="true">{{ GAME[kind].icon }}</span><strong>{{ GAME[kind].name }}</strong><span v-if="game === kind" class="chip ink">Chosen</span></span>
                    <span class="tiny muted">{{ GAME[kind].about }} {{ GAME[kind].pays }}</span>
                  </button>
                </div>
              </div>

              <div class="stack tight">
                <div class="row between">
                  <span id="friends-label" class="label">Friends to invite <span class="muted num">· {{ picked.length }} of {{ MAX_INVITES }}</span></span>
                  <button class="btn ghost sm" type="button" :disabled="!picked.length" @click="picked = []">Clear</button>
                </div>
                <input v-if="friends.length > 6" v-model="filter" class="input" type="search" placeholder="Find a friend" aria-label="Find a friend" />
                <ul class="friends" aria-labelledby="friends-label">
                  <li v-for="friend in shownFriends" :key="friend.id">
                    <label class="friend" :class="{ on: picked.includes(friend.id), off: full && !picked.includes(friend.id) }">
                      <input v-model="picked" type="checkbox" :value="friend.id" :disabled="full && !picked.includes(friend.id)" />
                      <MemberBadge :member-id="friend.id" :look="friend.look" :size="32" :online="friend.online" />
                      <span class="grow truncate">{{ friend.displayName }}</span>
                      <span v-if="friend.online" class="chip leaf">Online</span>
                    </label>
                  </li>
                  <li v-if="!shownFriends.length" class="muted small none">No friend matches “{{ filter }}”.</li>
                </ul>
                <span v-if="full" class="tiny muted">That is the most one match can hold. Untick someone to swap.</span>
              </div>

              <fieldset class="watch">
                <legend class="label">Who can watch</legend>
                <label v-for="kind in AUDIENCES" :key="kind" class="radio" :class="{ off: kind === 'community' && !mine.length }">
                  <input v-model="audience" type="radio" name="audience" :value="kind" :disabled="kind === 'community' && !mine.length" />
                  <span><strong>{{ AUDIENCE[kind].label }}</strong> <span class="muted small">{{ kind === 'community' && !mine.length ? 'Join a community to use this.' : AUDIENCE[kind].about }}</span></span>
                </label>
                <label v-if="audience === 'community' && mine.length" class="field">
                  <span>Community</span>
                  <select v-model="communityId" class="select">
                    <option v-for="entry in mine" :key="entry.id" :value="entry.id">{{ entry.name }}</option>
                  </select>
                </label>
              </fieldset>

              <button class="btn primary block" type="submit" :disabled="!canSend">
                {{ sending ? 'Sending…' : picked.length ? `Challenge ${pickedNames} to ${GAME[game].name}` : 'Pick a friend to challenge' }}
              </button>
            </template>
          </form>
          </details>
          <!-- A guest cannot challenge, join a table or see a board. Saving is offered only where it can work. -->
          <GuestGate v-else-if="canSave" gate="competition" @save="router.push('/save')" />
          <div v-else class="notice amber guest-note" role="note">
            <div class="grow">
              <strong>You are playing as a guest.</strong>
              <div>Challenges, open tables and boards need a saved character. Saving to an account is not available on this host yet, so practise Lane Dash here, or play the computer or a casual match in the Game hall.</div>
            </div>
          </div>
        </div>
      </section>

      <!-- The newer games live in the hall: one line, not a banner. -->
      <RouterLink to="/arena" class="card interactive tint-grape hall-link">
        <span class="icon-chip grape" aria-hidden="true">♟️</span>
        <span class="grow"><strong>Game hall</strong><span class="muted small line">Ten Walls, Chess and Word Yard</span></span>
        <span aria-hidden="true">→</span>
      </RouterLink>

      <section v-if="mayWatch" class="stack tight" aria-labelledby="watch-title">
        <h2 id="watch-title">Watch</h2>
        <StateView v-if="tableState === 'error'" state="error" :message="tableError" @retry="reloadTables" />
        <p v-else-if="tableState !== 'ready'" class="small muted" role="status">Looking for open tables…</p>
        <p v-else-if="!tableData?.matches.length" class="small muted">No tables to watch right now. An open Eights table of a friend, or of a community you belong to, appears here while its game is on.</p>
        <div v-else class="stack tight">
          <MatchRow v-for="match in tableData.matches" :key="match.id" :match="match">
            <RouterLink class="btn sm" :to="`/games/match/${match.id}`">Watch</RouterLink>
          </MatchRow>
        </div>
      </section>

      <!-- History and the boards: there when wanted, folded until then. -->
      <details v-if="past.length" class="disclosure">
        <summary>Finished and expired matches <span class="chip num">{{ past.length }}</span></summary>
        <div class="stack tight">
          <MatchRow v-for="match in past" :key="match.id" :match="match" />
        </div>
      </details>
      <p v-else-if="mayList && matchState === 'ready' && !matches.length" class="small muted">No matches yet. Challenges you send and invitations you receive are listed at the top of this page.</p>

      <details v-if="mayBoards" class="disclosure" :open="boardsOpen" @toggle="boardsOpen = ($event.target as HTMLDetailsElement).open">
        <summary><span id="boards-title">Boards</span></summary>
        <BoardList v-if="boardsOpen" :communities="mine" :preselect="communityParam || null" />
      </details>

      <p class="tiny muted">Games pay coins. {{ COIN_HONESTY }}</p>
    </div>
  </PanelPage>
</template>

<style scoped>
.hall-link { display: flex; align-items: center; gap: 12px; min-height: 44px; padding-block: 10px; text-decoration: none; color: inherit; }
.line { display: block; }
.challenge > summary { padding-block: 10px; }
.challenge > summary strong { font-weight: 700; }
.games { display: flex; flex-direction: column; gap: 22px; container-type: inline-size; }
.games .notice { align-items: center; }
.now { display: grid; gap: 12px; align-items: start; }
@container (min-width: 620px) { .now { grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr); } }
.solo { min-width: 0; }
.guest-note { flex-wrap: wrap; align-items: center; }
.guest-note .grow { flex-basis: 180px; }

.options { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 8px; }
.option { display: flex; flex-direction: column; gap: 4px; text-align: left; padding: 10px 12px; border-radius: 12px; border: 1px solid var(--line-strong); background: var(--surface); transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.option:hover { background: var(--surface-2); }
.option[aria-pressed="true"] { border-color: var(--accent-strong); box-shadow: 0 0 0 3px var(--accent-soft); background: #fff; }

.friends { list-style: none; margin: 0; padding: 4px; max-height: 212px; overflow-y: auto; border-radius: 12px; border: 1px solid var(--line); background: #fff; display: grid; gap: 2px; }
.friend { display: flex; align-items: center; gap: 10px; min-height: 44px; padding: 5px 8px; border-radius: 9px; cursor: pointer; }
.friend:hover { background: var(--surface-2); }
.friend.on { background: var(--accent-soft); }
.friend.off { opacity: 0.55; cursor: not-allowed; }
.friend input, .radio input { width: 18px; height: 18px; flex: none; accent-color: var(--accent-strong); }
.none { padding: 10px 8px; }

.watch { margin: 0; padding: 0; border: 0; display: grid; gap: 4px; min-width: 0; }
.watch legend { padding: 0; margin-bottom: 4px; }
.radio { display: flex; align-items: flex-start; gap: 10px; min-height: 40px; padding: 8px; border-radius: 9px; cursor: pointer; }
.radio:hover { background: var(--surface-2); }
.radio.off { opacity: 0.6; cursor: not-allowed; }
.radio input { margin: 2px 0 0; }

.confirm { align-items: center; flex-wrap: wrap; }
h3 { display: flex; align-items: center; gap: 8px; }
/* Small buttons grow to a full touch target on touch screens. */
@media (pointer: coarse) { .btn.sm { min-height: 40px; padding: 0 14px; } }
</style>
