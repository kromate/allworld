// What the creator windows read from the service's records, and the words they use. Everything
// here is decided by a field the service sets: `verified` on a member, `automatic` on a member or
// a message, `link` on the creator card. A name, a bio or a look decides nothing.
import { CREATOR_FRIEND_LABEL } from '../../shared/creator.ts'
import type { CreatorCard } from '../../shared/creator.ts'

/** The one member the service bound to the creator's verified account. */
export const isCreator = (member: { verified?: 'creator' } | null | undefined): boolean => member?.verified === 'creator'
/** A friendship the service made. It can be messaged, removed and blocked; nothing friends-only is shared through it. */
export const isAutomaticFriend = (member: { automatic?: 'creator' } | null | undefined): boolean => member?.automatic === 'creator'
/** A message the service wrote for the creator. Nothing a member sends carries the mark. */
export const isAutomaticWelcome = (message: { automatic?: 'welcome' } | null | undefined): boolean => message?.automatic === 'welcome'

/**
 * How the viewer stands with the creator, as the card says it.
 *   unavailable — this world has no verified creator (or no card could be asked for).
 *   hidden      — there is a creator, and a block keeps them from the viewer.
 *   waiting     — not connected: the welcome has not been made for this member.
 */
export type CreatorStanding = 'unavailable' | 'hidden' | 'self' | 'automatic' | 'friend' | 'removed' | 'waiting'

export function standingOf(card: CreatorCard | null): CreatorStanding {
  if (!card?.ready) return 'unavailable'
  if (!card.member) return 'hidden'
  return card.link === 'none' ? 'waiting' : card.link
}

/** A connection exists, in the service's own words. Nothing else may be shown as connected. */
export const isConnected = (standing: CreatorStanding): boolean => standing === 'automatic' || standing === 'friend'

export const STANDING_TEXT: Readonly<Record<CreatorStanding, { title: string; text: string }>> = {
  unavailable: { title: 'The creator chat is not available yet', text: 'You can keep exploring and playing. There is no welcome conversation to open yet.' },
  hidden: { title: 'The creator is not available to you', text: 'A block is in place, so there is no connection and no conversation. It is not made again automatically.' },
  self: { title: 'This is you', text: 'You are the verified creator on this world.' },
  automatic: { title: CREATOR_FRIEND_LABEL, text: 'You can message each other. Nothing else is shared through it: not your photo, your home or where you are.' },
  friend: { title: 'Friend', text: 'You are friends, like any two members who accepted an introduction.' },
  removed: { title: 'Not connected', text: 'The connection with the creator was removed. It is not made again automatically.' },
  waiting: { title: 'Not connected yet', text: 'The welcome is made when you finish setting up your character. Nothing has been sent to you yet.' },
}
