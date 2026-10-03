import { app } from '../../state/app.ts'
import type { HubResult } from './hubs.ts'

export interface JourneyContext { tripId: string; hub: HubResult }
/** Scoped to the signed-in member. With none there is no key: `app.actorKey` is one constant for every hosted session. */
const key = (): string | null => app.me ? `nw-travel-hub:${app.me.id}` : null

export function saveJourney(context: JourneyContext): void {
  const at = key()
  if (!at) return
  try { sessionStorage.setItem(at, JSON.stringify(context)) } catch { /* A hub label is optional; the service still owns the trip. */ }
}

export function readJourney(): JourneyContext | null {
  const at = key()
  if (!at) return null
  try {
    const raw: unknown = JSON.parse(sessionStorage.getItem(at) ?? 'null')
    if (!raw || typeof raw !== 'object' || !('tripId' in raw) || typeof raw.tripId !== 'string' || !('hub' in raw)) return null
    const hub = raw.hub
    if (!hub || typeof hub !== 'object' || !('kind' in hub)) return null
    if (hub.kind === 'missing' && 'reason' in hub && typeof hub.reason === 'string') return { tripId: raw.tripId, hub: { kind: 'missing', reason: hub.reason } }
    if (hub.kind !== 'found' || !('name' in hub) || typeof hub.name !== 'string' || !('distance' in hub) || typeof hub.distance !== 'number' || !Number.isFinite(hub.distance)
      || !('source' in hub) || typeof hub.source !== 'string' || !hub.source.startsWith('https://www.openstreetmap.org/')
      || !('category' in hub) || typeof hub.category !== 'string' || !('anchor' in hub)) return null
    const anchor = hub.anchor
    if (!anchor || typeof anchor !== 'object' || !('lat' in anchor) || typeof anchor.lat !== 'number' || !Number.isFinite(anchor.lat) || Math.abs(anchor.lat) > 90
      || !('lon' in anchor) || typeof anchor.lon !== 'number' || !Number.isFinite(anchor.lon) || Math.abs(anchor.lon) > 180) return null
    return { tripId: raw.tripId, hub: { kind: 'found', name: hub.name, distance: hub.distance, source: hub.source, category: hub.category, anchor: { lat: anchor.lat, lon: anchor.lon } } }
  } catch { return null }
}
