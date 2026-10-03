// Small formatting helpers shared by pages.
import { app } from '../state/app.ts'

const locale = (): string => app.me?.preferences.language || navigator.language || 'en'

/** "5 min ago", "in 2 days". */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((Date.parse(iso) - now) / 1000)
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto' })
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [['year', 31_536_000], ['month', 2_592_000], ['day', 86_400], ['hour', 3600], ['minute', 60]]
  for (const [unit, size] of steps) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit)
  return format.format(Math.round(seconds), 'second')
}

/** A date and time in a specific timezone, with the zone named, so everyone reads the same moment. */
export function dateTimeIn(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat(locale(), { timeZone: timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(Date.parse(iso))
}

export function dateTime(iso: string): string {
  return new Intl.DateTimeFormat(locale(), { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(Date.parse(iso))
}

/** Money as the seller wrote it. Display only — nothing in this App collects payment. */
export function money(minor: number, currency: string): string {
  try {
    // Minor units differ by currency (two for NGN or GBP, none for JPY).
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
    const amount = minor / 10 ** digits
    return new Intl.NumberFormat(locale(), { style: 'currency', currency, maximumFractionDigits: Number.isInteger(amount) ? 0 : digits }).format(amount)
  } catch { return `${(minor / 100).toFixed(0)} ${currency}` }
}

export const count = (value: number, one: string, many = `${one}s`): string => `${value.toLocaleString(locale())} ${value === 1 ? one : many}`
