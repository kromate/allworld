import { computed, inject, provide } from 'vue'
import type { ComputedRef, InjectionKey } from 'vue'
import { app } from '../state/app.ts'

/** What the shell says stands in the way of a reload. Each field is a sentence for the member, empty when clear. */
export interface ReloadContext {
  /** Sign-in, saving to an account, or a save that may have gone through. Nothing lets a reload past this. */
  critical?: string
  /** A vehicle, a journey, an open window or an unfinished character. A hard update gives way to these; an optional one does not. */
  activity?: string
}

interface GameReload {
  blocked: ComputedRef<string>
  /** Set when a hard update is going ahead past an ordinary restriction: what reloading will not keep. Empty otherwise. */
  warning: ComputedRef<string>
  reload(): void
}
const GAME_RELOAD: InjectionKey<GameReload> = Symbol('game-reload')

const PENDING = 'Wait for the current save or action to finish.'
const UNSAVED = 'Anything not saved yet in this window is lost when you reload. Saved character and progress stay with this world.'

/**
 * This page can no longer talk to the service: it runs an older build and the link has stopped
 * trying. Whatever asks the service to finish (leave a vehicle, end a journey, save a form) can
 * only fail, so the page's own restrictions cannot be satisfied from here.
 */
const incompatible = (): boolean => app.link === 'update-required' || app.phase === 'update-required'

/** A bare sentence from an older shell is read as critical, so it keeps blocking exactly as before. */
function createGameReload(context: () => string | ReloadContext = () => ''): GameReload {
  const read = (): ReloadContext => { const value = context(); return typeof value === 'string' ? { critical: value } : value }
  const blocked = computed(() => {
    if (app.pendingCalls > 0) return PENDING
    const { critical = '', activity = '' } = read()
    return critical || (incompatible() ? '' : activity)
  })
  const warning = computed(() => {
    if (app.pendingCalls > 0 || !incompatible()) return ''
    const { critical = '', activity = '' } = read()
    return !critical && activity ? UNSAVED : ''
  })
  let reloading = false
  return { blocked, warning, reload: () => { if (reloading || blocked.value) return; reloading = true; location.reload() } }
}

/** The shell adds its sign-in and saving state as critical, and its vehicle, journey, form and onboarding restrictions as activity. */
export function provideGameReload(context: () => string | ReloadContext = () => ''): GameReload {
  const gate = createGameReload(context)
  provide(GAME_RELOAD, gate)
  return gate
}

/** Anonymous and standalone download pages still respect pending saves without loading the world. */
export function useGameReload(): GameReload { return inject(GAME_RELOAD, createGameReload()) }
