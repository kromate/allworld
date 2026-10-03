// Going to a home. The only way in from the street is on foot, to the front door of the house that
// stands there (contract v3: `home.approach`, then the walker's `home.enter` at the door). This file
// asks the service how a home is reached, says so in a sentence when it cannot be, and asks the
// world to walk. It never steps a member straight into a room: with no walker, a walker that says
// no, or a service that says the home is unplaced, too far or not shared, nothing moves and the
// answer is a sentence and a reason, so the caller can offer the right next step.
// `enterHome` is not imported here on purpose.
import type { HomeUnavailableReason } from '../../shared/homes.ts'
import type { HomeId } from '../../shared/ids.ts'
import { api, messageOf, myId } from '../../state/app.ts'
import { walkToHome, world } from '../../state/world.ts'

export type Reached =
  | { ok: true }
  /** `reason` is the service's own, or 'travel' (too far to walk: book a trip), or 'walk' (it could be reached but the walk did not start). */
  | { ok: false; message: string; reason: HomeUnavailableReason | 'travel' | 'walk' }

export const NOT_STARTED = 'The walk to the door could not start, so nothing was moved. Try again, or go to the street outside it.'

export interface EntryDeps {
  approach(homeId: HomeId | null): Promise<Awaited<ReturnType<typeof asked>>>
  walk(homeId: HomeId): Promise<boolean>
}
const asked = (homeId: HomeId | null) => api('home.approach', { homeId }).then(answer => answer.approach)
const live: EntryDeps = { approach: asked, walk: walkToHome }

/** Ask the world to walk the member to a home's door. `null` is the member's own home. */
export async function reachHome(homeId: HomeId | null, deps: EntryDeps = live, active: () => boolean = () => true): Promise<Reached> {
  const actor = myId()
  const current = (): boolean => active() && actor === myId()
  try {
    const approach = await deps.approach(homeId)
    if (!current()) return { ok: false, message: 'The walk was cancelled.', reason: 'walk' }
    if (approach.kind === 'unavailable') {
      world.homeWalk = { kind: 'unavailable', message: approach.message }
      return { ok: false, message: approach.message, reason: approach.reason }
    }
    if (approach.kind === 'travel') {
      world.homeWalk = { kind: 'travel', homeId: approach.homeId, to: approach.to }
      return { ok: false, message: approach.message, reason: 'travel' }
    }
    return (await deps.walk(approach.homeId)) ? { ok: true } : { ok: false, message: NOT_STARTED, reason: 'walk' }
  } catch (error) {
    return { ok: false, message: `${messageOf(error)} Nothing was moved.`, reason: 'walk' }
  }
}
