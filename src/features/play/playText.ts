// Words and small rules shared by the work and games windows.
import type { MemberId } from '../../shared/ids.ts'
import type { Audience, Card, GameKind, Match, MatchPlayer, RejectReason, Skill, Suit } from '../../shared/play.ts'
import { count, relativeTime } from '../../ui/format.ts'

/**
 * What play pays, in coins. The service decides every payment; these mirror its constants
 * (service/work.ts: CORRECT_POINTS, SPEED_BONUS_MAX; service/games.ts: WIN_POINTS and
 * floor(score / 10) for Lane Dash) so a window can say what a shift or a win is worth.
 */
import { PAY } from '../../shared/play.ts'
export { PAY }

export const coins = (value: number): string => count(value, 'coin')
/** "just now", "5 minutes ago", "in 2 days" — relativeTime, without the bare "now" for the first moments. */
export const ago = (iso: string): string => (Math.abs(Date.parse(iso) - Date.now()) < 45_000 ? 'just now' : relativeTime(iso))
export const dashCoins = (score: number): number => Math.floor(score / PAY.dashScorePerCoin)

export const COIN_HONESTY = 'Coins are play money, not real money, and cannot be transferred.'

export type Tone = 'amber' | 'sky' | 'leaf' | 'grape' | 'coral'

export const SKILL: Record<Skill, { label: string; icon: string; tone: Tone }> = {
  service: { label: 'Service', icon: '☕', tone: 'amber' },
  logistics: { label: 'Logistics', icon: '📦', tone: 'sky' },
  craft: { label: 'Craft', icon: '🎨', tone: 'grape' },
}

export const GAME: Record<GameKind, { name: string; icon: string; tone: Tone; about: string; pays: string }> = {
  'lane-dash': {
    name: 'Lane Dash', icon: '🏃', tone: 'sky',
    about: 'Switch lanes to dodge the barriers. Everyone in a match runs the same course, and the best score wins.',
    pays: `A counted run pays 1 coin for every ${PAY.dashScorePerCoin} score.`,
  },
  eights: {
    name: 'Eights', icon: '🃏', tone: 'grape',
    about: 'A card game for 2 to 4. Match the top card by suit or rank, eights are wild, first to empty their hand wins.',
    pays: `The winner gets ${PAY.eightsWin} coins.`,
  },
}

export const AUDIENCE: Record<Audience, { label: string; short: string; about: string }> = {
  'players-only': { label: 'Players only', short: 'players only', about: 'Nobody else can watch.' },
  friends: { label: 'Friends', short: 'friends can watch', about: 'Friends of the players can watch.' },
  community: { label: 'A community', short: 'a community can watch', about: 'Members of one community you belong to can watch.' },
}

export const REJECT_TEXT: Record<RejectReason, string> = {
  'already-submitted': 'This run was already handed in, so it was not counted a second time.',
  'illegal-inputs': 'The service could not replay this run as a legal game, so it was not counted.',
  'too-fast': 'The run arrived sooner than it could have been played, so it was not counted.',
  'too-late': 'The run arrived after its deadline, so it was not counted.',
  'not-your-match': 'This attempt belongs to another member, so it was not counted.',
  'match-closed': 'The match closed before your run arrived, so it was not counted.',
}

// ── Cards ──

// The variation selector keeps the suit marks as text glyphs instead of emoji.
export const SUIT: Record<Suit, { mark: string; name: string; red: boolean }> = {
  hearts: { mark: '♥︎', name: 'hearts', red: true },
  diamonds: { mark: '♦︎', name: 'diamonds', red: true },
  clubs: { mark: '♣︎', name: 'clubs', red: false },
  spades: { mark: '♠︎', name: 'spades', red: false },
}
const RANK_SHORT: Record<number, string> = { 1: 'A', 11: 'J', 12: 'Q', 13: 'K' }
const RANK_WORD: Record<number, string> = { 1: 'ace', 8: 'eight', 11: 'jack', 12: 'queen', 13: 'king' }
export const rankName = (rank: number): string => RANK_SHORT[rank] ?? String(rank)
const rankWord = (rank: number): string => RANK_WORD[rank] ?? String(rank)
/** "an ace", "a 7", "an eight". */
export const aRank = (rank: number): string => `${rank === 1 || rank === 8 ? 'an' : 'a'} ${rankWord(rank)}`
/** "7 of hearts", "queen of spades". */
export const cardLabel = (card: Card): string => `${rankWord(card.rank)} of ${SUIT[card.suit].name}`
/** "7♥". */
export const cardShort = (card: Card): string => `${rankName(card.rank)}${SUIT[card.suit].mark}`
export const sameCard = (a: Card, b: Card): boolean => a.suit === b.suit && a.rank === b.rank

// ── Matches ──

export function nameList(names: string[]): string {
  if (names.length === 0) return 'another player'
  if (names.length === 1) return names[0]!
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]!}`
}

export const playerOf = (match: Match, memberId: MemberId | null): MatchPlayer | null => match.players.find(player => player.member.id === memberId) ?? null
export const othersIn = (match: Match, memberId: MemberId | null): MatchPlayer[] => match.players.filter(player => player.member.id !== memberId)
export const isOpen = (match: Match): boolean => (match.status === 'invited' || match.status === 'active') && Date.parse(match.expiresAt) > Date.now()
/** An invitation the member has not answered and still can. */
export const needsAnswer = (match: Match, memberId: MemberId | null): boolean => playerOf(match, memberId)?.state === 'invited' && isOpen(match)
export const isSolo = (match: Match): boolean => match.players.length === 1 && match.players[0]!.member.id === match.host

const nameOf = (match: Match, memberId: MemberId | null): string => playerOf(match, memberId)?.member.displayName ?? 'Another player'
const waitingOn = (match: Match, me: MemberId | null, states: MatchPlayer['state'][]): string =>
  nameList(othersIn(match, me).filter(player => states.includes(player.state)).map(player => player.member.displayName))

/** A match's state in words, from one member's side. `mine` marks the ones waiting on that member. */
export function matchStatus(match: Match, me: MemberId | null): { label: string; text: string; tone: Tone | ''; mine: boolean } {
  const self = playerOf(match, me)
  if (match.status === 'finished') {
    const won = match.winner !== null && match.winner === me
    const scores = match.game === 'lane-dash'
      ? match.players.filter(player => player.score !== null).sort((a, b) => (a.placed ?? 99) - (b.placed ?? 99))
        .map(player => `${player.member.id === me ? 'You' : player.member.displayName} ${player.score}`).join(' · ')
      : ''
    const head = match.winner === null ? 'Finished' : won ? 'You won' : `${nameOf(match, match.winner)} won`
    return { label: won ? 'Won' : 'Finished', text: scores ? `${head} · ${scores}` : head, tone: won ? 'leaf' : '', mine: false }
  }
  if (match.status === 'expired') return { label: 'Expired', text: `Ran out of time ${ago(match.expiresAt)}`, tone: 'coral', mine: false }
  if (match.status === 'declined') return { label: 'Declined', text: self?.state === 'declined' ? 'You declined this one' : 'Nobody took it up', tone: '', mine: false }
  if (match.status === 'cancelled') return { label: 'Cancelled', text: 'This match was cancelled', tone: '', mine: false }
  if (!isOpen(match)) return { label: 'Closing', text: 'Out of time', tone: 'coral', mine: false }
  if (self?.state === 'invited') {
    return { label: 'Invitation', text: `${nameOf(match, match.host)} challenged you · expires ${relativeTime(match.expiresAt)}`, tone: 'amber', mine: true }
  }
  if (match.game === 'lane-dash') {
    if (match.canPlay) return { label: 'Your run', text: 'Your run is waiting', tone: 'amber', mine: true }
    if (self?.state === 'played') return { label: 'Waiting', text: `You scored ${self.score ?? 0}. Waiting for ${waitingOn(match, me, ['invited', 'joined'])}`, tone: 'sky', mine: false }
    return { label: 'In play', text: 'Runs are being played', tone: 'sky', mine: false }
  }
  if (match.status === 'invited') return { label: 'Waiting', text: `Waiting for ${waitingOn(match, me, ['invited'])} to answer`, tone: 'sky', mine: false }
  return { label: 'Game on', text: self ? 'The table is open — take your seat' : 'A game is being played', tone: 'amber', mine: Boolean(self) }
}
