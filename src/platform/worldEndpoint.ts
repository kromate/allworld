import { WorldError } from '../shared/model.ts'
/** What the helper needs from a hosted world config. `endpoint` is where requests go; it defaults to `audience`. */
export interface WorldEndpointConfig { audience: string; endpoint?: string | undefined }
const unsafe = (): WorldError => new WorldError('unavailable', 'The hosted world endpoint is not configured safely.')
/** An exact https origin: no path, query, hash, default port, upper-case host or credentials. */
export function isWorldOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const url = new URL(value)
    // The URL parser tolerates `*` and other odd host characters; a wildcard is never an origin.
    return url.protocol === 'https:' && url.origin === value && !url.username && !url.password && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(url.hostname)
  } catch { return false }
}
/** The validated origin that network requests go to. The audience stays the logical scope and is not sent anywhere by this. */
export function worldEndpoint(config: WorldEndpointConfig): string {
  const endpoint = config.endpoint === undefined ? config.audience : config.endpoint
  if (!isWorldOrigin(endpoint) || !isWorldOrigin(config.audience)) throw unsafe()
  return endpoint
}
export function worldUrl(config: WorldEndpointConfig, path: string): string {
  if (!/^\/[A-Za-z0-9_\-./]*$/.test(path) || path.includes('//') || path.split('/').includes('..')) throw unsafe()
  return `${worldEndpoint(config)}${path}`
}
export function worldSocketUrl(config: WorldEndpointConfig): string {
  return `${worldEndpoint(config).replace(/^https:/, 'wss:')}/world/socket`
}
/** For requests that carry the account cookie: the endpoint must be the page's own origin. */
export function accountEndpoint(config: WorldEndpointConfig, pageOrigin: string | undefined = globalThis.location?.origin): string {
  const endpoint = worldEndpoint(config)
  if (pageOrigin !== endpoint) throw unsafe()
  return endpoint
}
