// What the placement control shows for an answer of `home.sites`, as plain data: a sentence, whether
// the first plot that fits can be asked for, and a row for each plot the service lists. Only the
// service's own plots, in the district it says the character is in, are ever offered; a plot that
// is taken or that the rooms do not fit is listed but cannot be chosen. No position is carried.
import { planShell, shellFits } from '../../shared/homes.ts'
import type { HomeEnvelope, HomePlan, HomeParcelOption, HomeSite, HomeUnavailableReason } from '../../shared/homes.ts'

export const UNAVAILABLE_TEXT: Record<HomeUnavailableReason, string> = {
  unplaced: 'Your home is not on the map yet.',
  'no-coverage': 'There are no plots in this area yet. Try another area.',
  'source-missing': 'The map data for this area is not available right now. Try again later.',
  'source-stale': 'The map data for this area has changed. Look at the plots again.',
  'no-live-position': 'The game cannot place homes at this moment. Try again in a little while.',
  'not-shared': 'This home is not shown to you.',
}
export const STATUS_TEXT: Record<HomeSite['status'], string> = {
  valid: 'On the map.',
  'source-missing': 'Kept, but not showing now: the map data for its area is not available. It comes back when the data does, or place it again.',
  'source-stale': 'Kept, but not showing now: the map data for its area has changed. Look at the plots here and place it again to put it back on the map.',
}

export interface SitesAnswer { here: { districtId: string; areaLabel: string } | null; reason: string; unavailable: HomeUnavailableReason | null; parcels: HomeParcelOption[] }
export interface PlotRow { parcelId: string; label: string; state: 'free' | 'taken' | 'tight'; choosable: boolean; dimensions: string }
export interface PlotView { message: string; area: string | null; free: number; firstFits: boolean; rows: PlotRow[] }

export function plotView(answer: SitesAnswer): PlotView {
  if (!answer.here || answer.unavailable) {
    return { message: answer.unavailable ? UNAVAILABLE_TEXT[answer.unavailable] : answer.reason || 'You are not in an area where a home can be placed.', area: null, free: 0, firstFits: false, rows: [] }
  }
  const rows = answer.parcels.map((parcel): PlotRow => {
    const state = parcel.taken ? 'taken' : parcel.fits ? 'free' : 'tight'
    return { parcelId: parcel.parcelId, label: parcel.label, state, choosable: state === 'free', dimensions: plotDimensions(parcel.envelope) }
  })
  const free = rows.filter(row => row.choosable).length
  return { message: '', area: answer.here.areaLabel, free, firstFits: free > 0, rows }
}

const measure = (value: number): string => Number(value.toFixed(2)).toString()
/** Building bounds from the service's plot envelope, never map coordinates. */
export const plotDimensions = (envelope: HomeEnvelope): string => `${measure(envelope.xMax - envelope.xMin)} × ${measure(envelope.depth)} m`
/** Ground outside the saved shell. This does not predict whether another room will fit. */
export function unoccupiedGround(plan: Pick<HomePlan, 'rooms' | 'entrance'>, envelope: HomeEnvelope): string | null {
  if (!shellFits(plan, envelope)) return null
  const occupied = planShell(plan).reduce((area, box) => area + box.width * box.depth, 0)
  return `${measure(Math.max(0, (envelope.xMax - envelope.xMin) * envelope.depth - occupied))} m²`
}
