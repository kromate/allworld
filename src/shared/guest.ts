// Guest play and later claim: what the App and the service agree on.
//
// A guest is a real visitor holding an opaque capability the service issued. The capability is
// the only way back to the guest's character until an account claims it. What a guest may do is
// decided by `guestAccess` below; the service applies the same function before any handler runs
// (service/guests.ts), so a window that hides a button is being polite, not enforcing anything.
import type { Iso, MemberId } from './ids.ts'
import type { AvatarLook } from './model.ts'
import type { OpName } from './protocol.ts'

/** The guest numbers. One source for the service (which applies them) and the App (which explains them). */
export const GUEST = {
  /** A capability not resumed for this long expires. */
  idleDays: 30,
  /** And it ends this long after it was issued, however often it is used. */
  maxDays: 90,
  /** How long a repeated claim with the old capability is still answered with the first result. */
  claimRetryHours: 24,
  /** How long an expired or revoked record is kept before it is dropped. */
  recordKeptDays: 30,
  /** Guests one world holds at a time. */
  maxActive: 20_000,
  /** New guests: per caller, and for the whole world. */
  issue: { perSource: 5, perSourceWindowMs: 600_000, overall: 120, overallWindowMs: 60_000 },
  /** Capabilities presented (resume, claim, revoke), right or wrong, per caller. */
  attempts: { perSource: 30, windowMs: 60_000 },
} as const

/** `gst_` and 43 base64url characters: 256 random bits. Anything else is refused before it is looked up. */
export const GUEST_TOKEN_PATTERN = /^gst_[A-Za-z0-9_-]{43}$/
export const isGuestToken = (value: unknown): value is string => typeof value === 'string' && value.length === 47 && GUEST_TOKEN_PATTERN.test(value)

export type GuestChannel = 'test' | 'store'
/** What a guest capability is bound to. Set by the service's own configuration, never by a request. */
export interface GuestScope { appId: string; packageId: string; siteId: string; channel: GuestChannel }

export interface GuestStatus {
  state: 'guest'
  memberId: MemberId
  createdAt: Iso
  lastSeenAt: Iso
  /** When the capability stops working unless it is resumed first. Resuming moves it, never past `endsAt`. */
  expiresAt: Iso
  /** The last moment this guest can exist unclaimed. */
  endsAt: Iso
}

/** Returned once, when the guest is created. `token` is the capability: the only way back to this character. */
export interface GuestSession { token: string; status: GuestStatus }

/** The character an account already owns, as shown in a claim conflict. Never carries a photo face. */
export interface SavedCharacter { memberId: MemberId; displayName: string; look: AvatarLook; createdAt: Iso; onboarded: boolean }

export type GuestClaimResult =
  /** The same member, look and progress now belong to the account. `repeated` is true when this claim had already happened. */
  | { outcome: 'claimed'; memberId: MemberId; claimedAt: Iso; repeated: boolean }
  /** The account already owns a character. Nothing changed; the guest capability still works. */
  | { outcome: 'conflict'; existing: SavedCharacter; choices: readonly ['use-saved', 'keep-guest'] }

/** Plain statement of what a guest can lose. Show it where the guest chooses to play or to save. */
export const GUEST_RECOVERY_NOTICE = `You are playing as a guest on this device. Your character is kept only while this device keeps your guest session: if the App's data is cleared, or you do not come back for ${GUEST.idleDays} days, or ${GUEST.maxDays} days pass, the character cannot be recovered by anyone. Save your character to an account to keep it.`

// ── What a guest may do ───────────────────────────────────────────────────────────────────────
// Deny by default. An operation is open to a guest only when it is listed here; one added to the
// protocol later is closed to guests until someone lists it.

/**
 * 'play' is the game hall: against the computer, or a casual game with whoever else is looking
 * ("Find a match"). 'practice' is a run of one's own.
 */
export type GuestGroup = 'explore' | 'customise' | 'work' | 'practice' | 'play' | 'creator'
export type GuestGate = 'account' | 'social' | 'messaging' | 'marketplace' | 'application' | 'moderation' | 'competition'

export const GUEST_OPS = {
  explore: [
    'member.me', 'member.public', 'member.face', 'member.setCurrentArea', 'member.clearCurrentArea', 'member.setBrowsing',
    'member.completeOnboarding', 'member.block', 'member.unblock', 'member.report',
    'room.enter', 'room.leave', 'room.move', 'home.visitable', 'home.approach',
    'home.exteriors', 'home.enter', 'home.resume', 'home.leave', 'home.presence', 'home.return',
    'travel.state', 'travel.quote', 'travel.book', 'travel.passportApply', 'travel.visaApply',
    'life.state', 'life.menu', 'life.eat',
    'notify.list', 'notify.open', 'notify.readAll', 'notify.prefs', 'comeback.here',
    // Vehicles: a guest borrows, drives, rides, is invited and pays a charter from the same coins as anyone.
    // What the vehicle's borrower or driver allows is decided by the service for guests and accounts alike.
    'vehicle.state', 'vehicle.inspect', 'vehicle.loan', 'vehicle.return', 'vehicle.board', 'vehicle.enter', 'vehicle.cycleSeat', 'vehicle.exit', 'vehicle.input',
    'vehicle.access', 'vehicle.invite', 'vehicle.respondInvite', 'vehicle.offerDriver', 'vehicle.acceptDriver',
    'vehicle.quote', 'vehicle.book', 'vehicle.depart', 'vehicle.cancelTrip', 'vehicle.destination', 'vehicle.ackTransfer', 'vehicle.resume',
  ],
  customise: [
    'member.saveProfile', 'member.savePreferences', 'member.clearFace', 'home.get', 'home.save', 'home.move',
    'home.catalog', 'home.estate', 'home.quote', 'home.commit', 'home.sites', 'home.setSite',
  ],
  work: ['work.places', 'work.start', 'work.answer', 'work.leave', 'work.career'],
  practice: ['dash.begin', 'dash.submit'],
  play: [
    'arena.games', 'arena.mine', 'arena.create', 'arena.respond', 'arena.get', 'arena.move', 'arena.resign', 'arena.draw',
    'arena.cancel', 'arena.rematch', 'arena.watch', 'arena.unwatch',
  ],
  // The one friend and conversation a guest has: the creator (src/shared/creator.ts). See GUEST_CREATOR_OPS.
  creator: ['creator.card', 'friends.list', 'direct.list', 'direct.open', 'direct.get', 'direct.send', 'direct.read', 'friends.remove'],
} as const satisfies Record<GuestGroup, readonly OpName[]>

/**
 * Operations that name a member or a conversation. Listed in GUEST_OPS; open to a guest only when
 * that member is the creator this world has verified, or the conversation is the guest's own with
 * them. The service decides that from its own records (service/guests.ts): nothing the request
 * says about who the creator is counts. A window can tell the thread by
 * `conversation.peer.verified === 'creator'`, which the service also sets.
 */
export const GUEST_CREATOR_OPS: readonly OpName[] = ['direct.open', 'direct.get', 'direct.send', 'direct.read', 'friends.remove']

/**
 * The only matches a guest may be in: unrated, open to nobody but the players, outside any
 * community. `guestAccess` holds a new game to these terms from the request. For an operation on
 * an existing match the service checks them against the match's own record, so a match id is
 * never a way into another kind of game; a window can ask the same of the `ArenaMatch` it holds.
 */
export const guestMayEnterMatch = (match: { rated: boolean; audience: string; communityId: string | null }): boolean =>
  match.rated === false && match.audience === 'players' && match.communityId === null

/** Operations on one existing match. Listed in GUEST_OPS; open to a guest only for a match `guestMayEnterMatch` accepts. */
export const GUEST_MATCH_OPS: readonly OpName[] = ['arena.respond', 'arena.get', 'arena.move', 'arena.resign', 'arena.draw', 'arena.cancel', 'arena.rematch', 'arena.watch']

/** The inputs here are untrusted and unparsed: anything that is not the expected shape is `undefined`. */
const field = (value: unknown, key: string): unknown =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined

/** A listed operation with an entry here is open only when the input passes. */
const CONDITIONS: Partial<Record<OpName, (input: unknown) => boolean>> = {
  // Streets, venues and homes. A game table is a room for a match between members.
  'room.enter': input => { const kind = field(field(input, 'ref'), 'kind'); return kind === 'district' || kind === 'venue' || kind === 'home' },
  // A guest cannot opt in to being found by people nearby.
  'member.savePreferences': input => field(field(input, 'preferences'), 'discoverable') === false,
  // With nobody watching and outside any community: against the computer, or an unrated game from the queue.
  // No friend or community challenge. A queue request has to say `rated: false` itself.
  'arena.create': input => {
    if (field(input, 'audience') !== 'players' || (field(input, 'communityId') ?? null) !== null) return false
    const kind = field(field(input, 'opponent'), 'kind')
    return kind === 'computer' || (kind === 'queue' && field(input, 'rated') === false)
  },
  // A run of one's own, not an entry in a match.
  'dash.begin': input => (field(input, 'matchId') ?? null) === null,
}

/** Why a refused operation is refused. The first prefix that matches wins; nothing matching is 'account'. */
const GATES: readonly (readonly [prefix: string, gate: GuestGate])[] = [
  ['direct.report', 'moderation'], ['market.sellerQueue', 'moderation'], ['market.sellerReview', 'moderation'], ['comeback.stats', 'moderation'],
  ['chat.', 'messaging'], ['voice.', 'messaging'], ['direct.', 'messaging'], ['wave.', 'messaging'], ['join.', 'messaging'], ['emote.', 'messaging'],
  ['arena.chat', 'messaging'], ['arena.invite', 'messaging'], ['arena.focus', 'messaging'],
  ['market.', 'marketplace'], ['quote.', 'marketplace'],
  ['listing.', 'application'], ['application.', 'application'],
  ['nearby.', 'social'], ['intro.', 'social'], ['friends.', 'social'], ['community.', 'social'], ['meetup.', 'social'], ['hangout.', 'social'],
  ['link.', 'social'], ['around.', 'social'], ['life.peek', 'social'], ['home.setPolicy', 'social'], ['member.savePreferences', 'social'],
  ['match.', 'competition'], ['table.', 'competition'], ['board.', 'competition'], ['arena.', 'competition'], ['dash.', 'competition'], ['room.enter', 'competition'],
]

export const GUEST_GATE_MESSAGE: Readonly<Record<GuestGate, string>> = {
  account: 'Save your character to an account to use this.',
  social: 'Save your character to an account to meet and find other people.',
  messaging: 'As a guest you can message the creator. Save your character to an account to talk to other people.',
  marketplace: 'Save your character to an account to use the market.',
  application: 'Save your character to an account to post or answer listings.',
  moderation: 'Save your character to an account to use this. You can report or block a person without one.',
  competition: 'As a guest you can play the computer or find a casual match. Save your character to an account for rated games, challenges, watched games and standings.',
}

const GROUP_OF = new Map<string, GuestGroup>()
for (const group of Object.keys(GUEST_OPS) as GuestGroup[]) for (const op of GUEST_OPS[group]) GROUP_OF.set(op, group)

export type GuestAccess = { allowed: true; group: GuestGroup } | { allowed: false; gate: GuestGate; message: string }

/**
 * May an unclaimed guest run this operation with this input? The service applies the same
 * function, and then checks its own records: for GUEST_MATCH_OPS the match itself
 * (`guestMayEnterMatch`), for GUEST_CREATOR_OPS that the member or conversation is the creator's.
 */
export function guestAccess(op: string, input?: unknown): GuestAccess {
  const group = GROUP_OF.get(op)
  const condition = (CONDITIONS as Record<string, ((input: unknown) => boolean) | undefined>)[op]
  if (group && (!condition || condition(input))) return { allowed: true, group }
  const gate = GATES.find(([prefix]) => op.startsWith(prefix))?.[1] ?? 'account'
  return { allowed: false, gate, message: GUEST_GATE_MESSAGE[gate] }
}
