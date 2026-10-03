// One authority for who may steer the avatar and who may use the world's keys. Every UI that covers
// the world, holds the avatar, or takes the keyboard registers a hold here instead of calling the
// engine or listening for keys on its own; the engine's lock is derived from all holds together, so
// closing one panel can never unlock the world while another still holds it (a menu, a window, a
// vehicle seat, a typing field, an order on its way).
//
// This is presentation-side gating. It keeps the client from issuing conflicting movement or foot
// intents; it is not authority. The service must still refuse foot movement and foot work for a seated
// member, and the parent-owned engine and state hooks that would enforce it centrally are listed in
// docs/ux/GAMEPLAY-HUD-030.md ("Proposed hooks for the parent").
//
// The Menu is not a pause. A hold stops this client's walking and keys; the world and the service
// keep running, and nothing here says otherwise.
import { computed, getCurrentInstance, onBeforeUnmount, shallowReactive, watch } from 'vue'
import { getEngine } from '../state/world.ts'

export type HoldRole =
  /** A sheet, dialog or menu in front of the world: foot input and every world key are held. */
  | 'modal'
  /** A page open over the world. Held like a modal for the world's keys, but the shell's section shortcuts still work. */
  | 'window'
  /** A text field has the keyboard. */
  | 'typing'
  /** The avatar is in a vehicle: foot input is held, social keys (chat) are not. */
  | 'seated'
  /** An order or walk under way that must carry on: foot input is held, walking is preserved, keys are not. */
  | 'order'
  /** A non-modal panel: it only takes part in Escape ordering. */
  | 'panel'

export interface HoldOptions {
  role: HoldRole
  /** Called by Escape when this hold is the most recently opened one that can close. */
  close?: () => void
  /** For a hold that locks foot input: the engine may carry on an automatic walk meanwhile. A getter is read each time. */
  preserveWalking?: boolean | (() => boolean)
}
interface Hold extends HoldOptions { id: string; seq: number }

const holds = shallowReactive(new Map<string, Hold>())
let seq = 0
const BLOCKS_FOOT: ReadonlySet<HoldRole> = new Set(['modal', 'window', 'typing', 'seated', 'order'])
const BLOCKS_KEYS: ReadonlySet<HoldRole> = new Set(['modal', 'window', 'typing'])

/** Take a hold until the returned function is called. Taking the same id again replaces it and makes it the newest. */
export function hold(id: string, options: HoldOptions): () => void {
  const entry: Hold = { ...options, id, seq: ++seq }
  holds.set(id, entry)
  if (options.close) ensureEscape()
  return () => { if (holds.get(id) === entry) holds.delete(id) }
}

/**
 * Hold while `active()` is true, for the life of the calling component. The watch is synchronous so
 * the engine never sees a half-way state between two components changing in one tick.
 */
export function useHold(id: string, active: () => boolean, options: HoldOptions): void {
  let release: (() => void) | null = null
  const apply = (on: boolean): void => {
    if (on && !release) release = hold(id, options)
    else if (!on && release) { release(); release = null }
  }
  watch(active, apply, { immediate: true, flush: 'sync' })
  if (getCurrentInstance()) onBeforeUnmount(() => apply(false))
}

const list = (): Hold[] => [...holds.values()]
export const footBlocked = computed(() => list().some(entry => BLOCKS_FOOT.has(entry.role)))
/** The world's own keys (E, Enter for chat, L, P, ?, G, F, J, N) are held by something in front. */
export const keysBlocked = computed(() => list().some(entry => BLOCKS_KEYS.has(entry.role)))
export const seated = computed(() => holds.has('seated'))
export const typing = computed(() => holds.has('typing'))
/** A modal, window or typing field has taken over from the world: the signal a held driving input must neutralize on. */
export const overlayOpen = computed(() => list().some(entry => BLOCKS_KEYS.has(entry.role)))
/** A seated driver's keys and buttons may steer only while nothing in front has the input. */
export const driveAllowed = computed(() => seated.value && !overlayOpen.value)

export type Use = 'foot' | 'social' | 'info' | 'shell'
/**
 * Whether a kind of use is open right now.
 *  foot    walking, a held pad, automatic walks, foot actions (enter, eat, work, wave with the body)
 *  social  chat, gestures sent to others, invitations: allowed seated
 *  info    opening a list or panel: allowed seated
 *  shell   the App's section shortcuts: held by modals but not by a page that is itself a section
 */
export function permits(use: Use, except: readonly string[] = []): boolean {
  // `except` lets a hold ask "is anything ELSE in the way?", for example a meal sheet closing itself on its own key.
  const others = except.length ? list().filter(entry => !except.includes(entry.id)) : null
  const some = (set: ReadonlySet<HoldRole>): boolean => (others ?? list()).some(entry => set.has(entry.role))
  if (use === 'foot') return !some(BLOCKS_FOOT)
  if (use === 'shell') return !(others ?? list()).some(entry => entry.role === 'modal')
  return !some(BLOCKS_KEYS)
}

/** The engine's lock, derived from every hold. Walking is preserved only when every foot hold allows it. */
export const lock = computed(() => {
  const feet = list().filter(entry => BLOCKS_FOOT.has(entry.role))
  const keep = feet.length > 0 && feet.every(entry => (typeof entry.preserveWalking === 'function' ? entry.preserveWalking() : entry.preserveWalking === true))
  return { locked: feet.length > 0, preserveWalking: keep }
})
/** Push the derived lock to the engine. The stage calls it when the engine arrives; a change calls it by itself. */
export function syncEngine(): void {
  const engine = getEngine()
  engine?.lockInput(lock.value.locked, { preserveWalking: lock.value.preserveWalking })
  engine?.setVehicleInputBlocked(overlayOpen.value)
}
// Only a real change reaches the engine: adding a non-blocking hold recomputes `lock` but must not poke it again.
watch(() => `${lock.value.locked}|${lock.value.preserveWalking}|${overlayOpen.value}`, syncEngine, { flush: 'sync' })

// ── Neutralize: for a held input that lives outside the engine (a vehicle's throttle and steer) ──
const neutralizers = new Set<() => void>()
/** Called each time a modal, window or typing field takes the input. A transport adapter sends neutral/brake from it. Returns its remover. */
export function onNeutralize(listener: () => void): () => void {
  neutralizers.add(listener)
  if (getCurrentInstance()) onBeforeUnmount(() => neutralizers.delete(listener))
  return () => neutralizers.delete(listener)
}
watch(overlayOpen, now => { if (now) for (const listener of [...neutralizers]) listener() }, { flush: 'sync' })

// ── Escape: the most recently opened thing that can close, closes, and nothing else hears the key ──
let escapeInstalled = false
export function closeTopmost(): boolean {
  const top = list().filter(entry => entry.close).sort((a, b) => b.seq - a.seq)[0]
  if (!top) return false
  top.close?.()
  return true
}
function ensureEscape(): void {
  if (escapeInstalled || typeof window === 'undefined') return
  escapeInstalled = true
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
    if (closeTopmost()) event.stopImmediatePropagation()
  }, true)
}

/** Only for diagnostics: forget every hold and let Escape's listener be installed again. */
export function resetHolds(): void { holds.clear(); escapeInstalled = false }
