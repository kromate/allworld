// Words and small rules shared by the hall's windows.
import { ARENA, ARENA_GAME_NAME, timeControl } from '../../shared/arena.ts'
import type { ArenaAudience, ArenaGame, ArenaMatch, ArenaPlayer, StandingScope } from '../../shared/arena.ts'

export type Tone = 'amber' | 'sky' | 'leaf' | 'grape' | 'coral'

export const HONESTY = 'Ratings and standings are for play only. Coins are play money, not real money, and cannot be transferred.'

export interface GameCard {
  icon: string; tone: Tone; tagline: string; about: string; length: string
  /** Shown when the game has not brought its own how-to-play. */
  steps: { title: string; text: string }[]
}

export const GAME: Record<ArenaGame, GameCard> = {
  walls: {
    icon: '🧱', tone: 'coral',
    tagline: 'Race to the far side. Spend your ten walls to make the other route longer.',
    about: 'A race for two on a nine-by-nine board. Each turn you step one square or place a wall. You can slow the other pawn down, but you may never shut it in.',
    length: '5 to 10 minutes',
    steps: [
      { title: 'Race to the far row', text: 'Your pawn starts in the middle of your own edge. Reach any square of the far row before the other pawn reaches yours.' },
      { title: 'One step or one wall', text: 'Each turn, move one square up, down, left or right, or place one of your ten walls. You cannot pass.' },
      { title: 'Walls block everyone', text: 'A wall is two squares long and sits between squares. Walls cannot overlap or cross, and nobody steps through one.' },
      { title: 'Always leave a way', text: 'A wall that leaves either pawn with no way to its goal is not allowed.' },
      { title: 'Jump the other pawn', text: 'When the pawns are face to face you may jump over the other one, or step to its side when a wall or the edge is behind it.' },
    ],
  },
  chess: {
    icon: '♟️', tone: 'grape',
    tagline: 'The classic. Trap the other king.',
    about: 'The full game: castling, taking in passing, promotion, and every draw rule. Legal moves are shown as you pick a piece up.',
    length: '10 to 20 minutes',
    steps: [
      { title: 'White moves first', text: 'Players take turns. Pick up a piece to see where it may go, then choose a square.' },
      { title: 'Check and checkmate', text: 'A king under attack is in check and must get out of it. If it cannot, that is checkmate and the game is over.' },
      { title: 'Special moves', text: 'Castle your king to safety, take a pawn in passing, and promote a pawn that reaches the far row.' },
      { title: 'Draws', text: 'Stalemate, the same position three times, fifty moves each with no capture or pawn move, too few pieces to mate, or by agreement.' },
      { title: 'The clock', text: 'Each player has their own time. Run out and you lose, unless the other side has too little left to mate.' },
    ],
  },
  words: {
    icon: '🔤', tone: 'leaf',
    tagline: 'Seven tiles, one board. Build words that cross.',
    about: 'Draw letter tiles and build interlocking words on a thirteen-by-thirteen board. Premium squares double and triple letters and words, and using your whole rack earns a bonus.',
    length: '15 to 25 minutes',
    steps: [
      { title: 'Seven tiles each', text: 'The first word goes across the centre square. After each turn you draw back up to seven.' },
      { title: 'Every word must connect', text: 'Lay tiles in one row or column, touching what is already there. Every run of touching letters has to be a real word.' },
      { title: 'Scoring', text: 'Add up the letters of each word you made. Premium squares count the first time a tile lands on them. Playing all seven tiles earns a bonus.' },
      { title: 'Swap or pass', text: 'Instead of playing you may swap tiles while the bag has enough left, or pass.' },
      { title: 'The end', text: 'The game ends when the bag is empty and someone plays their last tile, or when nobody scores for two rounds. Tiles left on your rack count against you.' },
    ],
  },
}

export const gameName = (game: ArenaGame): string => ARENA_GAME_NAME[game]

export const AUDIENCE: Record<ArenaAudience, { label: string; short: string; about: string }> = {
  anyone: { label: 'Anyone', short: 'Open to everyone', about: 'Any member can watch and join the chat.' },
  friends: { label: 'Friends', short: 'Friends can watch', about: 'Friends of either player can watch and join the chat.' },
  community: { label: 'A community', short: 'A community can watch', about: 'Members of one community can watch and join the chat.' },
  players: { label: 'Players only', short: 'Private', about: 'Nobody else can open this game.' },
}

export const SCOPE_LABEL: Record<StandingScope, string> = { friends: 'Friends', community: 'Community', state: 'State', country: 'Country', global: 'Global' }

/** "3 + 2 · Rated" */
export const termsOf = (match: ArenaMatch): string =>
  `${timeControl(match.timeControl).short} · ${match.players.some(player => player.computer) ? 'Practice' : match.forFun ? 'For fun' : match.rated ? 'Rated' : 'Casual'}`

/** A clock face: "4:07", "0:08.4" in the last ten seconds, "23 h 10 min" for a daily game. */
export function clockText(ms: number, daily: boolean): string {
  const left = Math.max(0, ms)
  if (daily && left >= 3_600_000) return `${Math.floor(left / 3_600_000)} h ${Math.floor((left % 3_600_000) / 60_000)} min`
  if (left < 10_000 && !daily) return `0:0${(Math.floor(left / 100) / 10).toFixed(1)}`
  const total = Math.floor(left / 1000)
  const minutes = Math.floor(total / 60), seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

export const ratingText = (player: Pick<ArenaPlayer, 'rating' | 'provisional'>): string => (player.rating === null ? '' : `${player.rating}${player.provisional ? '?' : ''}`)

export const opponentOf = (match: ArenaMatch): ArenaPlayer | null => match.players.find(player => player.seat !== match.me.seat) ?? null

/** Where a match stands, for a row in a list. `mine` marks the ones waiting on this member. */
export function rowStatus(match: ArenaMatch): { label: string; tone: Tone | ''; text: string; mine: boolean } {
  const playing = match.me.role === 'player' && match.me.seat !== null
  const other = opponentOf(match)
  if (match.status === 'waiting') {
    if (match.me.canAccept) return { label: 'Challenge', tone: 'amber', text: match.open === 'community' ? `Open to ${match.communityName ?? 'a community'} — take the seat` : 'Waiting for your answer', mine: true }
    if (match.open === 'queue') return { label: 'Looking', tone: 'sky', text: 'Looking for someone to play', mine: false }
    if (match.open === 'community') return { label: 'Open', tone: 'sky', text: `Open to ${match.communityName ?? 'a community'}`, mine: false }
    return { label: 'Sent', tone: 'sky', text: `Waiting for ${match.invited?.displayName ?? 'an answer'}`, mine: false }
  }
  if (match.status === 'active') {
    if (!playing) return { label: 'Live', tone: 'leaf', text: `Move ${match.moveCount + 1}`, mine: false }
    if (match.drawOffer !== null && match.drawOffer !== match.me.seat) return { label: 'Draw offered', tone: 'amber', text: `${other?.name ?? 'Your opponent'} offers a draw`, mine: true }
    return match.turn === match.me.seat
      ? { label: 'Your move', tone: 'amber', text: `Move ${match.moveCount + 1}`, mine: true }
      : { label: 'Their move', tone: 'sky', text: `Waiting for ${other?.name ?? 'the other player'}`, mine: false }
  }
  if (match.status === 'finished' && match.outcome) {
    if (!playing) return { label: 'Finished', tone: '', text: match.outcome.text, mine: false }
    if (match.outcome.draw) return { label: 'Draw', tone: '', text: match.outcome.text, mine: false }
    return match.outcome.winners.includes(match.me.seat!) ? { label: 'Won', tone: 'leaf', text: match.outcome.text, mine: false } : { label: 'Lost', tone: 'coral', text: match.outcome.text, mine: false }
  }
  const label = match.status === 'aborted' ? 'Called off' : match.status === 'declined' ? 'Declined' : match.status === 'cancelled' ? 'Withdrawn' : 'Lapsed'
  return { label, tone: '', text: match.endText ?? '', mine: false }
}

export const coinLine = (player: ArenaPlayer): string | null => {
  if (player.coins === null) return null
  return player.coins > 0 ? `+${player.coins} coins` : 'No coins: today’s limit is reached'
}

export const NUMBERS = ARENA
