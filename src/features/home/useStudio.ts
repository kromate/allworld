// The home studio wired to the App: the service link, the engine and the session. One studio for
// the whole session; it is emptied when the account changes.
import { api, app, onAccountReset, onReconnect } from '../../state/app.ts'
import { getEngine, showHome, world } from '../../state/world.ts'
import { footprint, isFurniture } from '../../world/interior.ts'
import { createStudio } from './homeStudio.ts'
import type { Studio } from './homeStudio.ts'

let studio: Studio | null = null
const atOwnHome = (): boolean => world.kind === 'home' && world.canEditHome

function requestId(): string {
  const bytes = new Uint8Array(16)
  crypto.getRandomValues(bytes)
  return `hr${[...bytes].map(byte => byte.toString(16).padStart(2, '0')).join('')}`
}

export function useStudio(): Studio {
  if (studio) return studio
  const made = createStudio({
    api,
    newRequestId: requestId,
    newItemKey: () => `i${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
    footprint,
    isFurniture,
    stage: {
      // The member's own home only, and only while they are in it: never the room of a home they are visiting.
      showItems(items, selected) { const engine = getEngine(); if (!engine || !atOwnHome()) return; void engine.setInteriorItems(items); engine.highlightItem(selected) },
      async showHome(home) { if (!atOwnHome() || world.home?.id !== home.id) return; world.home = home; world.title = home.name; await showHome(home) },
      ghost(ghost) { getEngine()?.setInteriorGhost(ghost) },
      where() { return getEngine()?.position ?? null },
    },
    online: () => app.link === 'online',
    coins(balance) { app.points = balance },
    now: () => Date.now(),
  })
  studio = made
  const stopReset = onAccountReset(() => made.reset())
  // After a dropped link the answer to a payment may be waiting in the receipts: look, never assume.
  const stopReconnect = onReconnect(() => {
    if (made.state.load !== 'ready') return
    void made.refresh().then(() => made.reconcile())
  })
  if (import.meta.hot) import.meta.hot.dispose(() => { stopReset(); stopReconnect(); studio = null })
  return made
}
