// Wall-clock time in a named timezone ⇄ one instant. A meetup time is typed as the venue's local
// time, stored as an instant, and shown back in the venue's zone so everyone reads the same clock.

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }

const formats = new Map<string, Intl.DateTimeFormat>()
function formatFor(timeZone: string): Intl.DateTimeFormat {
  let format = formats.get(timeZone)
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    })
    formats.set(timeZone, format)
  }
  return format
}

/** What a clock on the wall in `timeZone` shows at `instant`. Throws on an unknown zone. */
export function wallClockAt(instant: number, timeZone: string): WallClock {
  const parts = formatFor(timeZone).formatToParts(instant)
  const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find(entry => entry.type === type)?.value ?? NaN)
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour') % 24, minute: part('minute'), second: part('second') }
}

/** How far the zone's wall clock is ahead of UTC at `instant`, in milliseconds. */
export function zoneOffsetMs(instant: number, timeZone: string): number {
  const wall = wallClockAt(instant, timeZone)
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instant / 1000) * 1000
}

/**
 * The instant at which a clock in `timeZone` reads `date` ("YYYY-MM-DD") and `time` ("HH:MM").
 * The offset is looked up twice: once at a first guess, then again at the corrected instant, which
 * settles times on either side of a daylight-saving change. `shifted` is true when the typed time
 * does not exist that day (clocks jump forward) and the nearest real time was used instead.
 * When clocks go back, one hour reads twice. `near` is an instant already chosen (a plan being
 * revised): if it shows the typed time, it is kept, so the repeat is not silently moved by an hour.
 */
export function zonedToInstant(date: string, time: string, timeZone: string, near?: number): { instant: number; shifted: boolean } | null {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  const t = /^(\d{2}):(\d{2})/.exec(time)
  if (!d || !t) return null
  const [year, month, day, hour, minute] = [Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2])]
  const wall = Date.UTC(year, month - 1, day, hour, minute)
  if (!Number.isFinite(wall)) return null
  try {
    if (near !== undefined && Number.isFinite(near)) {
      const seen = wallClockAt(near, timeZone)
      if (seen.year === year && seen.month === month && seen.day === day && seen.hour === hour && seen.minute === minute) return { instant: near, shifted: false }
    }
    const guess = wall - zoneOffsetMs(wall, timeZone)
    const instant = wall - zoneOffsetMs(guess, timeZone)
    const shown = wallClockAt(instant, timeZone)
    return { instant, shifted: shown.day !== day || shown.hour !== hour || shown.minute !== minute }
  } catch {
    return null
  }
}

const two = (value: number): string => String(value).padStart(2, '0')

/** The date and time inputs that show `instant` on a clock in `timeZone`. */
export function instantToZoned(instant: number, timeZone: string): { date: string; time: string } {
  let wall: WallClock
  try { wall = wallClockAt(instant, timeZone) } catch { wall = wallClockAt(instant, 'UTC') }
  return { date: `${wall.year}-${two(wall.month)}-${two(wall.day)}`, time: `${two(wall.hour)}:${two(wall.minute)}` }
}

/** The timezone of the device the App is open on. */
export function viewerZone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC' } catch { return 'UTC' }
}

/** True when clocks in the two zones show different times at `instant`. */
export function readsDifferently(instant: number, zoneA: string, zoneB: string): boolean {
  if (zoneA === zoneB) return false
  try { return zoneOffsetMs(instant, zoneA) !== zoneOffsetMs(instant, zoneB) } catch { return false }
}
