/** Allworld service totals. No member records or request identifiers cross this contract. */
export interface LiveCountsSnapshot {
  scope: 'hosted-world'
  totalViews: number
  onlinePlayers: number
  since: number
  asOf: number
}
export interface CountsDay { day: string; views: number; onlinePeak: number }
export interface CountsHistory { since: number; totalViews: number; days: CountsDay[] }
export interface PageView { eventId: string; startedAt: number }
export interface LiveCountsOps {
  'counts.owner': { in: Record<string, never>; out: { owner: boolean } }
  'counts.history': { in: Record<string, never>; out: CountsHistory }
}
export const COUNTS_SCOPE = 'Page views for this hosted Allworld App and channel since counting began, including the welcome page. These are views, not unique visitors. Refreshes and new tabs add views; panels and socket reconnects do not. Online players are unique authenticated guest or account characters connected or recently present in this world. Scenery, NPCs and local test actors never count as players.'

export function isLiveCountsSnapshot(value: unknown): value is LiveCountsSnapshot {
  if (!value || typeof value !== 'object') return false
  return 'scope' in value && value.scope === 'hosted-world'
    && 'totalViews' in value && typeof value.totalViews === 'number' && Number.isSafeInteger(value.totalViews) && value.totalViews >= 0
    && 'onlinePlayers' in value && typeof value.onlinePlayers === 'number' && Number.isSafeInteger(value.onlinePlayers) && value.onlinePlayers >= 0
    && 'since' in value && typeof value.since === 'number' && Number.isSafeInteger(value.since)
    && 'asOf' in value && typeof value.asOf === 'number' && Number.isSafeInteger(value.asOf) && value.asOf >= value.since
}
