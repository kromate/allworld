// What the game hall keeps for the whole App: a counter that says "your games changed", the
// service's clock (so countdowns never trust the device), and the hall-sound switch, which is the
// shared "ui" sound channel.
import { reactive } from 'vue'
import { ARENA_GAME_NAME } from '../shared/arena.ts'
import type { ArenaMatch } from '../shared/arena.ts'
import { onAccountReset, onServerEvent, toast } from './app.ts'
import { channels, setChannelMuted } from './sound.ts'

export const arena = reactive({
  /** Bumped when one of the member's own lists changed, so open pages reload them. */
  changed: 0,
  /** Service clock minus device clock, in ms. */
  skewMs: 0,
  /** Hall cues (your turn, low time, chat). Off until the member switches it on. Reads the shared "ui" channel. */
  get sound(): boolean { return !channels.ui.muted },
  /** Matches this member opened as a search ("find me someone"). An ended match no longer says which kind it was. */
  searched: new Set<string>(),
})

export const serverNow = (): number => Date.now() + arena.skewMs
/** Every match answer carries the service's time: keep the difference. */
export function syncClock(now: string): void {
  const at = Date.parse(now)
  if (Number.isFinite(at)) arena.skewMs = at - Date.now()
}
export function setSound(on: boolean): void { setChannelMuted('ui', !on) }

/** Pages with a router hand it over, so a toast's "Open" can go to the match without reloading the App. */
let navigate: (path: string) => void = path => { window.location.assign(path) }
export function setArenaNavigator(go: (path: string) => void): void { navigate = go }

/** "Game started" toasts waiting out their short delay. An account reset drops them: they belong to the member who left. */
const startedToasts = new Set<number>()

const otherName = (match: ArenaMatch): string => match.players.find(player => player.seat !== match.me.seat)?.name ?? 'your opponent'

onServerEvent(event => {
  if (event.type === 'arena.changed') { arena.changed++; return }
  if (event.type !== 'arena.match') return
  syncClock(event.now)
  const match = event.match
  // A game against another member just started (a challenge was accepted, or someone was found).
  // If the member is somewhere else in the App, say so — the clock may already be running.
  if (match.status !== 'active' || event.from !== 0 || match.moveCount !== 0 || match.me.role !== 'player' || match.players.some(player => player.computer)) return
  const path = `/arena/match/${match.id}`
  const timer = window.setTimeout(() => {
    startedToasts.delete(timer)
    if (window.location.pathname === path) return
    toast(`Your ${ARENA_GAME_NAME[match.game]} game with ${otherName(match)} has started.`, 'good', { label: 'Open', run: () => navigate(path) })
  }, 700)
  startedToasts.add(timer)
})

onAccountReset(() => {
  arena.changed = 0; arena.searched.clear()
  for (const timer of startedToasts) window.clearTimeout(timer)
  startedToasts.clear()
})
