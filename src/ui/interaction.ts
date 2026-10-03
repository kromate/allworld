// The one contextual action on the world screen. Anything that offers "do this, right here" (a door,
// a counter, a kitchen, a shift, a vehicle seat) registers a provider; the stage shows the most
// pressing one as a single button near the right thumb and keeps the rest one press behind it.
//
// This is presentation only. A provider decides when its action exists and what it does, exactly
// as it did before; the keyboard shortcut it names is still handled by whoever owns it. The
// stage's own E key runs the top action that names E, so a vehicle exit and a venue door never
// answer the same key at once.
//
// Transport integration: call `useInteraction('transport.exit', () => seated ? { …, exclusive: true } : null)`
// from the transport panel or its host. `exclusive` hides every foot action while it is offered.
// On foot, the vehicle host offers `ride.board` (get in, drive, or ask where to for a paid ride), `ride.depot` and
// `ride.details`. They are foot actions: ids that start with `transport.` are the ones the stage lets run while seated.
import { computed, getCurrentInstance, onBeforeUnmount, shallowReactive } from 'vue'
import type { HudIconName } from './hudIcons.ts'

export interface Interaction {
  /** Stable id, namespaced by owner: `world.enter`, `life.menu`, `work.shift`, `transport.exit`. */
  id: string
  /** Higher is shown first. See PRIORITY for the bands in use. */
  priority: number
  /** One or two words: what pressing it does. "Enter", "Exit", "Menu", "Start shift". */
  verb: string
  /** What it is done to, short enough for one line: a venue, a vehicle. Optional. */
  target?: string
  /** The whole sentence for screen readers and the list of other actions. */
  label: string
  icon: HudIconName
  /** Keyboard shortcut shown on a keyboard device, as the key is written: "E". The owner handles the key. */
  key?: string
  /** Looks like the one thing to do (amber) or like a quiet alternative (dark). */
  tone?: 'primary' | 'dark'
  busy?: boolean
  disabled?: boolean
  /** While offered, every action that is not exclusive is hidden: a seated passenger has no doors to open. */
  exclusive?: boolean
  run(): void
}

/** Bands, so owners that never see each other still agree on what comes first. */
export const PRIORITY = { transport: 100, vehicleHere: 90, doorHere: 80, shift: 70, meal: 60, venue: 50, depot: 45, edge: 40, work: 30, rideMore: 20, way: 10 } as const

const sources = shallowReactive(new Map<string, () => Interaction | null>())

/** Offer an action until the returned function is called. Re-registering an id replaces it. */
export function registerInteraction(id: string, source: () => Interaction | null): () => void {
  sources.set(id, source)
  return () => { if (sources.get(id) === source) sources.delete(id) }
}

/** Register for the life of the calling component. */
export function useInteraction(id: string, source: () => Interaction | null): void {
  const stop = registerInteraction(id, source)
  if (getCurrentInstance()) onBeforeUnmount(stop)
}

/** Everything on offer right now, most pressing first. An exclusive action hides the rest. */
export const interactions = computed<Interaction[]>(() => {
  const offered: Interaction[] = []
  for (const source of sources.values()) {
    const item = source()
    if (item) offered.push(item)
  }
  offered.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  const exclusive = offered.filter(item => item.exclusive)
  return exclusive.length ? exclusive : offered
})

/** The one the stage shows as the button. */
export const primaryInteraction = computed<Interaction | null>(() => interactions.value[0] ?? null)

/** The action the E key means: the most pressing one that names E and is not disabled. */
export const interactionForKey = (key: string): Interaction | null =>
  interactions.value.find(item => !item.disabled && !item.busy && item.key?.toUpperCase() === key.toUpperCase()) ?? null

/** Only for diagnostics: forget everything registered. */
export function resetInteractions(): void { sources.clear() }
