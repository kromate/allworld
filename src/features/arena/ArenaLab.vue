<script setup lang="ts">
// Practice board: one game on this device, against the computer or with both seats in your own
// hands. Nothing is saved or rated and the service is not involved — it exists so a game's rules
// and board can be played before, and apart from, the hall.
import { computed, defineAsyncComponent, ref, shallowRef, watch } from 'vue'
import type { Component } from 'vue'
import { useRoute } from 'vue-router'
import { ARENA_GAMES, RulesError } from '../../shared/arena.ts'
import type { ArenaGame, CreateRules, Rules, RulesEnv } from '../../shared/arena.ts'

type RulesModule = { createRules: CreateRules; labEnv?: () => Promise<RulesEnv> }
const rulesModules = import.meta.glob<RulesModule>('../../shared/games/*.ts')
const boards = import.meta.glob<{ default: Component }>('./games/*/Board.vue')

const route = useRoute()
const game = computed(() => String(route.params.game) as ArenaGame)
const rules = shallowRef<Rules | null>(null)
const board = shallowRef<Component | null>(null)
const state = shallowRef<unknown>(null)
const lastMove = shallowRef<{ seat: number; move: unknown } | null>(null)
const log = ref<string[]>([])
const problem = ref('')
const missing = ref('')
const opponent = ref<'computer' | 'both-hands'>('computer')
const level = ref<1 | 2 | 3>(2)
const mySeat = ref(0)
let seed = Date.now() % 2_147_483_647

async function load(): Promise<void> {
  rules.value = null; board.value = null; missing.value = ''
  if (!(ARENA_GAMES as readonly string[]).includes(game.value)) { missing.value = 'There is no game by that name.'; return }
  const rulesLoader = rulesModules[`../../shared/games/${game.value}.ts`]
  const boardLoader = boards[`./games/${game.value}/Board.vue`]
  if (!rulesLoader || !boardLoader) { missing.value = 'This game is not built yet.'; return }
  const module = await rulesLoader()
  rules.value = module.createRules(module.labEnv ? await module.labEnv() : {})
  board.value = defineAsyncComponent(boardLoader)
  restart()
}

function restart(): void {
  if (!rules.value) return
  seed = (seed * 48271) % 2_147_483_647
  state.value = rules.value.start(Math.max(2, rules.value.seats.min), seed)
  lastMove.value = null; log.value = []; problem.value = ''
  botTurn()
}

const turn = computed(() => (rules.value && state.value !== null ? rules.value.turn(state.value) : null))
const outcome = computed(() => (rules.value && state.value !== null ? rules.value.outcome(state.value) : null))
const seat = computed(() => (opponent.value === 'both-hands' ? turn.value ?? mySeat.value : mySeat.value))
const view = computed(() => (rules.value && state.value !== null ? rules.value.view(state.value, seat.value) : null))
const seatNames = computed(() => (opponent.value === 'computer' ? ['You', 'Computer'] : ['First player', 'Second player']))
const named = (text: string): string => text.replace(/\{(\d)\}/g, (_, n: string) => seatNames.value[Number(n)] ?? `Player ${Number(n) + 1}`)

function play(from: number, input: unknown): void {
  if (!rules.value || state.value === null) return
  try {
    const move = rules.value.parseMove(input)
    const line = rules.value.describe(state.value, from, move)
    state.value = rules.value.apply(state.value, from, move)
    lastMove.value = { seat: from, move }
    log.value = [...log.value, `${seatNames.value[from] ?? from}: ${line}`]
    problem.value = ''
  } catch (error) {
    problem.value = error instanceof RulesError ? error.message : 'That move could not be played.'
    if (!(error instanceof RulesError)) console.error(error)
  }
}

let random = seed
const nextRandom = (): number => { random = (random * 48271) % 2_147_483_647; return random / 2_147_483_647 }
function botTurn(): void {
  if (opponent.value !== 'computer' || !rules.value || state.value === null) return
  const current = rules.value.turn(state.value)
  if (current === null || current === mySeat.value) return
  setTimeout(() => {
    if (!rules.value || state.value === null || rules.value.turn(state.value) !== current) return
    play(current, rules.value.bot(state.value, current, level.value, nextRandom))
    botTurn()
  }, 450)
}

function onMove(move: unknown): void {
  if (turn.value === null || turn.value !== seat.value) return
  play(seat.value, move)
  botTurn()
}

watch(game, () => void load(), { immediate: true })
watch([opponent, mySeat], restart)
</script>

<template>
  <div class="lab">
    <header class="bar">
      <strong>Practice board</strong>
      <span class="chip">Not saved, not rated</span>
      <span class="grow"></span>
      <label class="pick"><span class="sr-only">Opponent</span>
        <select v-model="opponent" class="select">
          <option value="computer">Against the computer</option>
          <option value="both-hands">Play both sides</option>
        </select>
      </label>
      <label v-if="opponent === 'computer'" class="pick"><span class="sr-only">Level</span>
        <select v-model.number="level" class="select"><option :value="1">Easy</option><option :value="2">Medium</option><option :value="3">Hard</option></select>
      </label>
      <button class="btn sm" type="button" @click="restart">New game</button>
    </header>
    <p v-if="missing" class="notice">{{ missing }}</p>
    <template v-else-if="board && view !== null">
      <p v-if="outcome" class="notice leaf" role="status">{{ named(outcome.text) }}</p>
      <div class="table">
        <component :is="board" :view="view" :seat="seat" :can-move="!outcome && turn === seat" :last-move="lastMove" :seat-names="seatNames" :problem="problem" :end-text="outcome ? named(outcome.text) : null" @move="onMove" />
      </div>
      <details v-if="log.length" class="moves-box"><summary>Moves so far ({{ log.length }})</summary>
        <ol class="moves" aria-label="Moves so far"><li v-for="(line, index) in log" :key="index">{{ line }}</li></ol>
      </details>
    </template>
  </div>
</template>

<style scoped>
.lab { display: flex; flex-direction: column; gap: 12px; padding: 12px; height: 100%; overflow-y: auto; }
.bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.pick .select { min-height: 36px; padding: 4px 10px; width: auto; }
/* The board takes the height it needs and the page scrolls; it never slides under the move list. */
.table { flex: none; display: grid; justify-items: center; }
.moves-box { flex: none; font-size: 0.86rem; color: var(--ink-2); }
.moves-box summary { cursor: pointer; padding: 6px 2px; font-weight: 650; }
.moves { margin: 0; padding: 8px 8px 8px 28px; max-height: 120px; overflow-y: auto; font-size: 0.82rem; color: var(--ink-2); background: var(--surface-2); border-radius: 12px; }
</style>
