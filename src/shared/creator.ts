// The creator connection and welcome: what the App and the service agree on.
//
// A member who finishes onboarding is connected to the creator's real member and gets one
// automatic welcome message from them. Who the creator is, is decided by the service from a
// verified account: `PublicMember.verified` and `DirectMessage.automatic` are set by the service
// and by nothing a member can send. A display name is never identity.
import type { ConversationId } from './direct.ts'
import type { Iso } from './ids.ts'
import type { PublicMember } from './model.ts'

/** A public place in the game that the creator's welcome may name. Words only, from configuration; never read from anyone's location. */
export interface CreatorHangout { name: string; areaLabel: string | null }

const WELCOME = 'Hey, welcome to Allworld! I’m Kromit, the creator. Thanks for checking out the game. Message me here if you need help, or drop an idea on the Allworld noticeboard. I’d love to hear what you want us to build next.'

/** The welcome as it is stored. It promises nothing about when the creator is around. */
export function creatorWelcomeText(hangout: CreatorHangout | null): string {
  if (!hangout) return WELCOME
  return `${WELCOME} There is a public hangout in the game at ${hangout.name}${hangout.areaLabel ? ` in ${hangout.areaLabel}` : ''}.`
}

/**
 * `friends.list` carries at most this many service-made friendships, newest first, after every
 * accepted one. Only the creator has more than one; `total` is always the full count.
 */
export const FRIENDS_AUTOMATIC_LISTED = 500
/** Shown beside a friend whose card has `automatic: 'creator'`. */
export const CREATOR_FRIEND_LABEL = 'Automatic friendship with the creator'

/** Shown with a message whose `automatic` is 'welcome', so nobody takes it for something just typed. */
export const CREATOR_AUTOMATIC_LABEL = 'Automatic welcome message'
/** Shown during onboarding, before the connection is made. */
export const CREATOR_DISCLOSURE = 'When you finish, you are connected to Kromit, the creator of Allworld, and get one automatic welcome message from him. He cannot see your photo, your home or where you are because of it. You can remove or block him at any time.'

/**
 * How the viewer stands with the creator.
 *   automatic — the connection the service made: the two can message each other, nothing else.
 *   friend    — an introduction both accepted, like any friendship.
 *   removed   — the viewer removed or blocked the creator, or was removed. It is not made again.
 *   none      — not connected (not onboarded yet, or the welcome has not reached them).
 */
export type CreatorLink = 'self' | 'automatic' | 'friend' | 'removed' | 'none'

export interface CreatorCard {
  /** False until the verified creator has finished character onboarding. Nothing below is set before that. */
  ready: boolean
  /** The creator as the viewer may see them, `verified: 'creator'`. Null when not ready or blocked. */
  member: PublicMember | null
  link: CreatorLink
  /** The conversation with the creator, when there is one the viewer can open. */
  conversationId: ConversationId | null
  /** When the viewer's welcome was delivered. */
  welcomedAt: Iso | null
  hangout: CreatorHangout | null
}

export interface CreatorOps {
  /** Who the creator is in this world and how the member stands with them. */
  'creator.card': { in: Record<string, never>; out: { creator: CreatorCard } }
}
