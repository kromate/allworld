// Boundary parsing. Every operation input arrives as `unknown` and leaves these helpers typed,
// or the request is rejected with code "invalid".
import { WorldError } from '../src/shared/model.ts'

export type Raw = Record<string, unknown>

const fail = (message: string): never => { throw new WorldError('invalid', message) }

export function obj(value: unknown, what = 'input'): Raw {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail(`${what} must be an object`)
  return value as Raw
}

export function str(raw: Raw, key: string, options: { max?: number; min?: number; trim?: boolean } = {}): string {
  const value = raw[key]
  if (typeof value !== 'string') return fail(`${key} must be text`)
  const text = options.trim === false ? value : value.trim()
  if (text.length < (options.min ?? 0)) fail(options.min === 1 ? `${key} is required` : `${key} is too short`)
  if (text.length > (options.max ?? 500)) fail(`${key} is too long (max ${options.max ?? 500})`)
  return text
}

export function optStr(raw: Raw, key: string, options: { max?: number } = {}): string | null {
  return raw[key] === null || raw[key] === undefined ? null : str(raw, key, options)
}

export function num(raw: Raw, key: string, options: { min?: number; max?: number; integer?: boolean } = {}): number {
  const value = raw[key]
  if (typeof value !== 'number' || !Number.isFinite(value)) return fail(`${key} must be a number`)
  if (options.integer && !Number.isInteger(value)) fail(`${key} must be a whole number`)
  if (value < (options.min ?? -Infinity) || value > (options.max ?? Infinity)) fail(`${key} is out of range`)
  return value
}

export function optNum(raw: Raw, key: string, options: { min?: number; max?: number; integer?: boolean } = {}): number | null {
  return raw[key] === null || raw[key] === undefined ? null : num(raw, key, options)
}

export function bool(raw: Raw, key: string): boolean {
  const value = raw[key]
  if (typeof value !== 'boolean') return fail(`${key} must be true or false`)
  return value
}

export function oneOf<const T extends readonly string[]>(raw: Raw, key: string, allowed: T): T[number] {
  const value = raw[key]
  if (typeof value !== 'string' || !allowed.includes(value)) return fail(`${key} must be one of: ${allowed.join(', ')}`)
  return value as T[number]
}

export function optOneOf<const T extends readonly string[]>(raw: Raw, key: string, allowed: T): T[number] | null {
  return raw[key] === null || raw[key] === undefined ? null : oneOf(raw, key, allowed)
}

export function list<T>(raw: Raw, key: string, each: (value: unknown, index: number) => T, options: { max?: number } = {}): T[] {
  const value = raw[key]
  if (!Array.isArray(value)) return fail(`${key} must be a list`)
  if (value.length > (options.max ?? 100)) fail(`${key} has too many entries (max ${options.max ?? 100})`)
  return value.map(each)
}

/** An identifier with the expected prefix, for example id(raw, 'memberId', 'm'). */
export function id<T extends string>(raw: Raw, key: string, prefix: string): T {
  const value = raw[key]
  if (typeof value !== 'string' || !new RegExp(`^${prefix}_[a-z0-9_-]{3,40}$`).test(value)) return fail(`${key} is not a valid id`)
  return value as T
}

export function optId<T extends string>(raw: Raw, key: string, prefix: string): T | null {
  return raw[key] === null || raw[key] === undefined ? null : id<T>(raw, key, prefix)
}

export function hexColor(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/i.test(value)) return fail(`${what} must be a #rrggbb colour`)
  return value.toLowerCase()
}

export function isoInstant(raw: Raw, key: string): number {
  const value = raw[key]
  const at = typeof value === 'string' ? Date.parse(value) : NaN
  if (!Number.isFinite(at)) return fail(`${key} must be a date and time`)
  return at
}

export const empty = (): Record<string, never> => ({})
