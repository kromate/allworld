import type { HostedWorldConfig } from './hostedService.ts'
import { isWorldOrigin } from './worldEndpoint.ts'
// Where the App is running.
//
// local  – `npm run dev` on this machine: local test members and the local world service.
// hosted – a build its builder configured for one hosted world (`configureHostedWorld`). Guests and
//          this world's own accounts (account.ts) are both served from that world's endpoint.
//
// `audience` names the world: it is the stable scope its saved guests and accounts belong to, and it
// never changes when the world moves. `endpoint` is where the world is reached now. It defaults to
// the audience, which is what every build before the split meant.

export type RuntimeMode = 'local' | 'hosted' | 'unsupported'

export function runtimeMode(): RuntimeMode {
  if (configuredWorld) return 'hosted'
  if (['localhost', '127.0.0.1', '::1'].includes(location.hostname)) return 'local'
  return 'unsupported'
}

const ACTOR_KEY = 'neighbourhood-world:local-actor'

/** Local test member for this tab. Kept per tab so two tabs can be two different members. */
export function localActorKey(): string {
  const fromUrl = new URLSearchParams(location.search).get('as')
  if (fromUrl) { sessionStorage.setItem(ACTOR_KEY, fromUrl); return fromUrl }
  return sessionStorage.getItem(ACTOR_KEY) ?? 'a'
}

export function setLocalActorKey(key: string): void { sessionStorage.setItem(ACTOR_KEY, key) }

/** The reviewed public configuration, with the optional network endpoint (contract 125). */
export type HostedWorldSetup = HostedWorldConfig & { endpoint?: string }

let configuredWorld: HostedWorldSetup | null = null
/** Parent supplies reviewed public deployment metadata before boot. Contains no admission pass. */
export function configureHostedWorld(config: HostedWorldSetup): void {
  if (!isWorldOrigin(config.audience) || (config.endpoint !== undefined && !isWorldOrigin(config.endpoint)) || !config.siteId || !config.packageId || !config.buildId
    || (config.channel !== 'test' && config.channel !== 'store')
    || (config.guestAdmission !== undefined && config.guestAdmission !== 'public' && config.guestAdmission !== 'invite')) throw new Error('Invalid hosted world configuration.')
  configuredWorld = Object.freeze({ ...config, endpoint: config.endpoint ?? config.audience })
}
export function hostedWorldConfig(): HostedWorldSetup | null { return configuredWorld }

