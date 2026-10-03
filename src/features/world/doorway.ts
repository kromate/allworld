// The doorway question on the world screen: "Exit?" when the avatar walks up to the way out of a building.
// doorwayIntent.ts is the rule; this file feeds it the world's door signal and carries out what it says.
//
// Intent is forgotten (and the door has to settle again) whenever the scene changes, the member changes or
// the account is reset, so a door met on arrival never answers for the last visit. The saved "Don't ask
// again" is a preference of this browser for this member; the exit it enables is the same `leaveInterior()`
// the Leave button calls, so the service still decides whether the member goes anywhere.
import { computed, getCurrentInstance, onBeforeUnmount, reactive, watch } from 'vue'
import { app, onAccountReset } from '../../state/app.ts'
import { leaveInterior, world } from '../../state/world.ts'
import { permits, seated } from '../../ui/gameInput.ts'
import { createDoorway, readDoorPreference, writeDoorPreference } from './doorwayIntent.ts'
import type { DoorEffect, DoorPhase, DoorPreference, PreferenceStore } from './doorwayIntent.ts'

const store = (): PreferenceStore | null => { try { return window.localStorage } catch { return null } }

/** What the stage shows. Read-only for components: they act through the functions below. */
export const doorway = reactive({ phase: 'settling' as DoorPhase, preference: 'ask' as DoorPreference, resets: 0 })

const machine = createDoorway()
const now = (): number => performance.now()
/** One value per scene the member could be standing in; a change of any part is a new scene. */
const sceneScope = (): string => `${app.me?.id ?? ''}|${world.kind ?? ''}|${world.roomKey ?? ''}|${world.state}|${doorway.resets}`
const inBuilding = (): boolean => world.state === 'ready' && world.kind !== null && world.kind !== 'district'

function apply(effect: DoorEffect): void {
  doorway.phase = machine.phase
  if (effect !== 'leave') return
  // Same call, same authority as the Leave button. If the scene is still this one afterwards, the exit did not happen.
  const scope = machine.scope
  void leaveInterior().finally(() => { if (machine.scope === scope && machine.phase === 'leaving') { machine.failed(); doorway.phase = machine.phase } })
}

function sense(): void {
  if (!inBuilding()) { doorway.phase = machine.phase; return }
  apply(machine.step(now(), { near: world.nearDoor, allowed: permits('foot') && !seated.value, preference: doorway.preference }))
}

function restart(): void {
  machine.reset(now(), sceneScope())
  doorway.phase = machine.phase
  doorway.preference = readDoorPreference(store(), app.me?.id ?? null)
}

/** The question is on screen. */
export const asking = computed(() => doorway.phase === 'asking' && inBuilding())

/** Exit from the question. `remember` is the "Don't ask again" box: it is stored only with an Exit. */
export function answerExit(remember: boolean): void {
  if (remember) doorway.preference = writeDoorPreference(store(), app.me?.id ?? null, 'auto')
  apply(machine.answer(now(), 'exit'))
}
export function answerStay(): void { apply(machine.answer(now(), 'stay')) }
/** The member pressed Leave (button or E) themselves. */
export function leaveNow(): void { apply(machine.explicit(now())) }
/** The setting in "View and controls". Turning it off brings the question back; it never needs the member to be at a door. */
export function setAutoExit(on: boolean): void { doorway.preference = writeDoorPreference(store(), app.me?.id ?? null, on ? 'auto' : 'ask') }

/** Start following the door for the life of the calling component. Call once, from the world stage. */
export function useDoorway(): void {
  restart()
  const stops = [
    watch(sceneScope, restart, { flush: 'sync' }),
    // The door signal, a window opening over the world, or boarding a vehicle: decide again.
    watch(() => [world.nearDoor, permits('foot'), seated.value, doorway.preference] as const, sense, { flush: 'sync' }),
    onAccountReset(() => { doorway.resets++ }),
  ]
  // The engine only says when the door changes. Settling and re-arming pass with time, so look again now and then while it matters.
  const timer = window.setInterval(() => { if (doorway.phase === 'settling' || doorway.phase === 'declined' || doorway.phase === 'leaving') sense() }, 250)
  if (getCurrentInstance()) onBeforeUnmount(() => { window.clearInterval(timer); for (const stop of stops) stop() })
}
