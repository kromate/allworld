<script setup lang="ts">
// The Eights table, drawn from one TableView. A player's view carries only their own hand; a
// spectator's carries none — this never shows, guesses or asks for anybody else's cards.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MemberId } from '../../shared/ids.ts'
import { SUITS, TABLE_TURN_SECONDS } from '../../shared/play.ts'
import type { Card, Match, Suit, TableAction, TableView } from '../../shared/play.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { count } from '../../ui/format.ts'
import PlayingCard from './PlayingCard.vue'
import { usePlayKeys } from './keys.ts'
import { PAY, SUIT, aRank, cardLabel, cardShort, sameCard } from './playText.ts'

const props = defineProps<{ table: TableView; match: Match; me: MemberId | null; busy: boolean }>()
const emit = defineEmits<{ act: [action: TableAction] }>()

const now = ref(Date.now())
const choosing = ref<Card | null>(null)
const hint = ref('')
const logEl = ref<HTMLOListElement | null>(null)
const mineEl = ref<HTMLDivElement | null>(null)
const pickerEl = ref<HTMLDivElement | null>(null)

const live = computed(() => props.match.status === 'active' && props.table.turn !== null)
const player = computed(() => props.table.role === 'player' && props.table.hand !== null)
const myTurn = computed(() => live.value && player.value && props.table.turn === props.me)
const turnName = computed(() => props.table.seats.find(seat => seat.member.id === props.table.turn)?.member.displayName ?? 'Another player')
// While playing, your own seat is your hand below; once it is over everyone is listed with their result.
const seats = computed(() => (player.value && live.value ? props.table.seats.filter(seat => seat.member.id !== props.me) : props.table.seats))
const winnerName = computed(() => (props.match.winner === props.me && props.me ? 'You' : props.table.seats.find(seat => seat.member.id === props.match.winner)?.member.displayName ?? 'Someone'))

/** The service appends a drawn card last, so that is the one that may be played after drawing. */
const drawn = computed(() => (props.table.drewThisTurn && props.table.hand?.length ? props.table.hand[props.table.hand.length - 1]! : null))
const SUIT_ORDER: Suit[] = ['spades', 'hearts', 'clubs', 'diamonds']
const hand = computed(() => [...(props.table.hand ?? [])].sort((a, b) => SUIT_ORDER.indexOf(a.suit) - SUIT_ORDER.indexOf(b.suit) || a.rank - b.rank))
const fits = (card: Card): boolean => card.rank === 8 || card.suit === props.table.activeSuit || card.rank === props.table.topCard?.rank
const canPlay = (card: Card): boolean => myTurn.value && fits(card) && (!drawn.value || sameCard(card, drawn.value))
const anyPlayable = computed(() => hand.value.some(canPlay))
const suitChanged = computed(() => Boolean(props.table.topCard && props.table.activeSuit && props.table.topCard.suit !== props.table.activeSuit))
const needs = computed(() => {
  const suit = props.table.activeSuit, top = props.table.topCard
  if (!suit || !top) return 'a card that fits'
  return top.rank === 8 ? `${SUIT[suit].mark} ${SUIT[suit].name} or an eight` : `${SUIT[suit].mark} ${SUIT[suit].name}, ${aRank(top.rank)} or an eight`
})
const secondsLeft = computed(() => (props.table.turnEndsAt ? Math.min(TABLE_TURN_SECONDS, Math.max(0, Math.ceil((Date.parse(props.table.turnEndsAt) - now.value) / 1000))) : null))
const inHand = (suit: Suit): number => hand.value.filter(card => card.suit === suit && card.rank !== 8).length

function whyNot(card: Card): string {
  if (!live.value) return 'The game is over.'
  if (!myTurn.value) return `Wait for your turn — ${turnName.value} is playing.`
  if (drawn.value && !sameCard(card, drawn.value)) return 'After drawing you can only play the card you drew, or pass.'
  return `${cardShort(card)} does not fit. This turn needs ${needs.value}.`
}

/** Send a move, remembering whether the keyboard focus was in the player's own area. */
let focusWasMine = false
function send(action: TableAction): void {
  focusWasMine = Boolean(mineEl.value?.contains(document.activeElement))
  emit('act', action)
}

function tap(card: Card): void {
  if (props.busy) return
  choosing.value = null
  if (!canPlay(card)) { hint.value = whyNot(card); return }
  hint.value = ''
  // An eight is wild: ask which suit follows before it is played.
  if (card.rank === 8) {
    choosing.value = card
    void nextTick(() => pickerEl.value?.querySelector('button')?.focus())
    return
  }
  send({ kind: 'play', card })
}
function choose(suit: Suit): void {
  if (!choosing.value || props.busy) return
  send({ kind: 'play', card: choosing.value, chooseSuit: suit })
  choosing.value = null
}

// Escape backs out of the suit choice instead of closing the whole window.
usePlayKeys(event => {
  if (event.key !== 'Escape' || !choosing.value) return false
  choosing.value = null
  return true
})

// The button that was pressed often disappears with the move (a played card, Draw, Pass). Keep a
// keyboard player in their own area instead of dropping them back to the top of the page.
watch(() => props.table, () => {
  if (!focusWasMine) return
  focusWasMine = false
  void nextTick(() => { if (!document.activeElement || document.activeElement === document.body) mineEl.value?.focus() })
})
const cardWords = (card: Card): string => `${cardLabel(card)}${drawn.value && sameCard(card, drawn.value) ? ', just drawn' : ''}${myTurn.value ? (canPlay(card) ? ', can be played' : ', does not fit') : ''}`

watch(() => [props.table.turn, props.table.topCard?.suit, props.table.topCard?.rank, props.table.drewThisTurn], () => { hint.value = ''; choosing.value = null })
watch(() => props.table.log[props.table.log.length - 1], () => { void nextTick(() => { if (logEl.value) logEl.value.scrollTop = logEl.value.scrollHeight }) }, { immediate: true })

let timer = 0
onMounted(() => { timer = window.setInterval(() => { now.value = Date.now() }, 500) })
onBeforeUnmount(() => window.clearInterval(timer))
</script>

<template>
  <div class="eights">
    <div v-if="table.role === 'spectator'" class="notice sky watching">
      <span aria-hidden="true">👀</span>
      <span><strong>You are watching.</strong> Hands stay hidden from spectators, and only the players can play.</span>
    </div>

    <div v-if="live" class="turn" :class="{ mine: myTurn, urgent: secondsLeft !== null && secondsLeft <= 10 }">
      <div class="row between">
        <strong role="status" aria-live="polite">{{ myTurn ? 'Your turn' : `${turnName}’s turn` }}</strong>
        <span v-if="secondsLeft !== null" class="num small" :aria-label="`${secondsLeft} seconds left in this turn`">{{ secondsLeft }} s</span>
      </div>
      <div v-if="secondsLeft !== null" class="clock" aria-hidden="true"><div class="clock-fill" :style="{ width: `${(secondsLeft / TABLE_TURN_SECONDS) * 100}%` }"></div></div>
    </div>
    <div v-else-if="match.status === 'finished'" class="notice leaf" role="status">
      <span aria-hidden="true">🏆</span>
      <span><strong>{{ winnerName }} played the last card</strong> and {{ winnerName === 'You' ? 'earn' : 'earns' }} {{ PAY.eightsWin }} coins. A penalty is what was left in each hand: 50 for an eight, 10 for a jack, queen or king, face value for the rest.</span>
    </div>
    <div v-else-if="match.status === 'expired'" class="notice coral" role="status">The game ran out of time before anyone played their last card, so nobody won.</div>

    <div class="layout">
      <div class="main">
        <ul class="seats" aria-label="Players at the table">
          <li v-for="seat in seats" :key="seat.member.id" class="seat" :class="{ active: live && seat.member.id === table.turn }">
            <MemberBadge :member-id="seat.member.id" :look="seat.member.look" :size="36" :online="seat.connected" />
            <div class="grow who">
              <span class="row" style="gap: 6px">
                <strong class="truncate">{{ seat.member.id === me ? 'You' : seat.member.displayName }}</strong>
                <span v-if="live && seat.member.id === table.turn" class="chip amber">Playing</span>
                <span v-if="live && !seat.connected" class="chip">Away</span>
                <span v-if="match.winner === seat.member.id" class="chip leaf">Winner</span>
              </span>
              <span class="row backs">
                <span class="fan" aria-hidden="true"><PlayingCard v-for="n in Math.min(seat.cardCount, 7)" :key="n" back size="sm" /></span>
                <span class="tiny muted num">{{ count(seat.cardCount, 'card') }}{{ seat.penalty !== null ? ` · ${seat.penalty} penalty` : '' }}</span>
              </span>
            </div>
          </li>
        </ul>

        <div class="card tint-leaf felt">
          <div class="pile">
            <span class="deck" aria-hidden="true"><PlayingCard back /><PlayingCard v-if="table.drawPileCount > 1" back class="under" /></span>
            <span class="tiny num">Draw pile · {{ table.drawPileCount }}</span>
          </div>
          <div class="pile">
            <PlayingCard :card="table.topCard" size="lg" />
            <span class="tiny">Top card<span v-if="table.topCard" class="sr-only">: {{ cardLabel(table.topCard) }}</span></span>
          </div>
          <div v-if="table.activeSuit" class="follow">
            <span class="tiny muted">Suit to follow</span>
            <span class="mark" :class="{ red: SUIT[table.activeSuit].red }" aria-hidden="true">{{ SUIT[table.activeSuit].mark }}</span>
            <strong class="suit-name">{{ SUIT[table.activeSuit].name }}</strong>
            <span v-if="suitChanged" class="chip grape">Chosen with an eight</span>
          </div>
        </div>

        <div v-if="player" ref="mineEl" class="mine" tabindex="-1" aria-label="Your moves and your hand">
          <div v-if="choosing" ref="pickerEl" class="card tint-grape picker" role="group" aria-label="Choose the suit that follows your eight">
            <span class="small"><strong>Your eight is wild.</strong> Which suit should follow?</span>
            <div class="row wrap">
              <button v-for="suit in SUITS" :key="suit" class="btn suit-btn" type="button" :disabled="busy" @click="choose(suit)">
                <span class="mark sm" :class="{ red: SUIT[suit].red }" aria-hidden="true">{{ SUIT[suit].mark }}</span>{{ SUIT[suit].name }}<span class="tiny muted num">{{ inHand(suit) }} in hand</span>
              </button>
              <button class="btn ghost" type="button" @click="choosing = null">Cancel</button>
            </div>
          </div>
          <div v-else-if="myTurn && drawn" class="row wrap actions">
            <button v-if="canPlay(drawn)" class="btn primary" type="button" :disabled="busy" @click="tap(drawn)">Play {{ cardShort(drawn) }}</button>
            <button class="btn" :class="{ primary: !canPlay(drawn) }" type="button" :disabled="busy" @click="send({ kind: 'pass' })">Pass</button>
            <span class="small grow">You drew the {{ cardLabel(drawn) }}. {{ canPlay(drawn) ? 'It fits — play it or pass.' : 'It does not fit, so pass.' }}</span>
          </div>
          <div v-else-if="myTurn" class="row wrap actions">
            <button class="btn" :class="{ primary: !anyPlayable }" type="button" :disabled="busy" @click="send({ kind: 'draw' })">Draw a card</button>
            <span class="small grow">{{ anyPlayable ? 'Tap a raised card to play it, or draw one.' : `Nothing in your hand fits ${needs}. Draw a card.` }}</span>
          </div>
          <p v-else-if="live" class="small muted actions">Waiting for {{ turnName }}. You can tap a card to see whether it fits.</p>

          <div class="row between">
            <h3>Your hand</h3>
            <span class="tiny muted num">{{ count(hand.length, 'card') }}</span>
          </div>
          <ul v-if="hand.length" class="hand">
            <li v-for="card in hand" :key="`${card.suit}${card.rank}`">
              <button
                class="card-btn" type="button" :class="{ playable: canPlay(card), dim: myTurn && !canPlay(card), chosen: choosing !== null && sameCard(choosing, card) }"
                :aria-disabled="!canPlay(card)" :aria-label="cardWords(card)" @click="tap(card)"
              >
                <PlayingCard :card="card" />
                <span v-if="drawn && sameCard(card, drawn)" class="tag">Drawn</span>
              </button>
            </li>
          </ul>
          <p v-else class="small muted">Your hand is empty.</p>
          <p class="small why" role="status" aria-live="polite">{{ hint }}</p>
        </div>
      </div>

      <aside class="side">
        <section class="stack tight">
          <h3>What happened</h3>
          <ol ref="logEl" class="log" role="log" aria-label="What happened at the table">
            <li v-for="(line, index) in table.log" :key="`${index}:${line}`">{{ line }}</li>
          </ol>
        </section>
        <details class="rules">
          <summary>How to play Eights</summary>
          <ul class="small">
            <li>Play a card that matches the top card by suit or by rank.</li>
            <li>Eights are wild: play one on anything and choose the suit that follows.</li>
            <li>Nothing fits? Draw one card. Play it if it fits, otherwise pass.</li>
            <li>A turn lasts {{ TABLE_TURN_SECONDS }} seconds. Out of time, the table draws and passes for you.</li>
            <li>The first to play their last card wins {{ PAY.eightsWin }} coins.</li>
          </ul>
        </details>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.eights { display: flex; flex-direction: column; gap: 12px; container-type: inline-size; }
.watching { align-items: center; }
.turn { padding: 10px 13px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--line); display: flex; flex-direction: column; gap: 6px; }
.turn.mine { background: var(--accent-soft); border-color: #f0c463; box-shadow: 0 0 0 3px rgba(255, 176, 32, 0.18); }
.turn.mine strong { font-size: 1.1rem; }
.clock { height: 6px; border-radius: 999px; background: rgba(28, 26, 36, 0.1); overflow: hidden; }
.clock-fill { height: 100%; border-radius: 999px; background: var(--sky); transition: width 0.5s linear; }
.turn.mine .clock-fill { background: var(--accent-strong); }
.turn.urgent .clock-fill { background: var(--coral); }

.layout { display: grid; gap: 14px; }
.main, .side { display: flex; flex-direction: column; gap: 12px; min-width: 0; }
@container (min-width: 620px) { .layout { grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr); align-items: start; } }

.seats { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.seat { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); min-width: 0; }
.seat.active { border-color: var(--accent-strong); box-shadow: 0 0 0 2px var(--accent-soft); }
.who { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.backs { gap: 8px; }
.fan { display: inline-flex; padding-left: 12px; }
.fan > * { margin-left: -12px; }

.felt { display: flex; align-items: center; justify-content: center; gap: 18px; flex-wrap: wrap; padding: 16px 12px; }
.pile { display: flex; flex-direction: column; align-items: center; gap: 6px; }
.deck { position: relative; display: inline-block; }
.deck .under { position: absolute; left: 3px; top: 3px; z-index: -1; }
.deck { z-index: 0; }
.follow { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 96px; }
.mark { font-size: 2.4rem; line-height: 1; color: var(--ink); }
.mark.red { color: var(--danger); }
.mark.sm { font-size: 1.2rem; }
.suit-name { text-transform: capitalize; }

.mine { display: flex; flex-direction: column; gap: 12px; min-width: 0; border-radius: 12px; }
.picker { display: flex; flex-direction: column; gap: 10px; }
.suit-btn { text-transform: capitalize; flex-direction: column; gap: 0; min-height: 62px; padding: 6px 12px; flex: 1; min-width: 68px; }
.suit-btn .tiny { text-transform: none; font-weight: 500; }
.actions { min-height: 40px; align-items: center; }

.hand { list-style: none; margin: 0; padding: 8px 0 0; display: flex; flex-wrap: wrap; gap: 8px 6px; }
.card-btn { position: relative; display: block; padding: 0; border: 0; background: transparent; border-radius: 10px; transition: transform 0.12s ease, opacity 0.15s ease; }
.card-btn.playable { transform: translateY(-7px); }
.card-btn.playable :deep(.pc) { border-color: var(--accent-strong); box-shadow: 0 0 0 2px var(--accent), 0 6px 12px rgba(243, 154, 0, 0.3); }
.card-btn.playable:hover { transform: translateY(-11px); }
.card-btn.chosen { transform: translateY(-13px); }
.card-btn.dim { opacity: 0.5; }
.card-btn[aria-disabled="true"] { cursor: help; }
.tag { position: absolute; left: 50%; bottom: -7px; transform: translateX(-50%); padding: 0 6px; border-radius: 999px; background: var(--ink); color: #fff; font-size: 0.64rem; font-weight: 700; line-height: 16px; }
.why { min-height: 1.4em; color: var(--accent-text); font-weight: 600; }

.log { list-style: none; margin: 0; padding: 8px 10px; max-height: 176px; overflow-y: auto; border-radius: 12px; background: var(--surface); border: 1px solid var(--line); font-size: 0.84rem; color: var(--ink-2); display: flex; flex-direction: column; gap: 4px; }
.log li:last-child { color: var(--ink); font-weight: 650; }
.rules { padding: 10px 12px; border-radius: 12px; background: var(--surface-2); border: 1px solid var(--line); }
.rules summary { cursor: pointer; font-weight: 650; }
.rules ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 4px; color: var(--ink-2); }
/* Small buttons grow to a full touch target on touch screens. */
@media (pointer: coarse) { .btn.sm { min-height: 40px; padding: 0 14px; } }
</style>
