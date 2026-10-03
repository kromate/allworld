// Local test identities.
//
// These identities answer loopback development requests and are labelled as local test members.
// Hosted deployments use the standalone account and guest adapters instead.
import type { MemberId } from '../src/shared/ids.ts'
import { randomToken } from '../src/shared/ids.ts'

export interface LocalActor { key: string; memberId: MemberId; name: string; reviewer: boolean }

export const LOCAL_ACTORS: LocalActor[] = [
  { key: 'a', memberId: 'm_local_a' as MemberId, name: 'Test member A', reviewer: false },
  { key: 'b', memberId: 'm_local_b' as MemberId, name: 'Test member B', reviewer: false },
  { key: 'c', memberId: 'm_local_c' as MemberId, name: 'Test member C', reviewer: false },
  { key: 'd', memberId: 'm_local_d' as MemberId, name: 'Test member D', reviewer: false },
  // e–h are reserved for playtesting runs.
  { key: 'e', memberId: 'm_local_e' as MemberId, name: 'Test member E', reviewer: false },
  { key: 'f', memberId: 'm_local_f' as MemberId, name: 'Test member F', reviewer: false },
  { key: 'g', memberId: 'm_local_g' as MemberId, name: 'Test member G', reviewer: false },
  { key: 'h', memberId: 'm_local_h' as MemberId, name: 'Test member H', reviewer: false },
  { key: 'reviewer', memberId: 'm_local_reviewer' as MemberId, name: 'Catalog reviewer', reviewer: true },
]

const sessions = new Map<string, LocalActor>()

export function openLocalSession(key: string): { token: string; actor: LocalActor } | null {
  const actor = LOCAL_ACTORS.find(entry => entry.key === key)
  if (!actor) return null
  const token = `local.${randomToken(24)}`
  sessions.set(token, actor)
  return { token, actor }
}

export const actorForToken = (token: string): LocalActor | null => sessions.get(token) ?? null

// ── Load-test identities ──────────────────────────────────────────────────────────────────────
// Generated members for scripts/load-world.ts, so thousands of sockets can sign in. This path is
// local-only twice over: the caller must prove the service was started with WORLD_LOAD_TEST=1
// (`enabled`), and that the request came straight from this machine (`loopback`, with no proxy
// header on it). Either one false and the answer is null. There is no way to switch it on from a
// request. A hosted deployment replaces this whole module and never has the path.
const LOAD_KEY = /^load:(\d{1,6})$/
export const LOAD_MEMBER_LIMIT = 200_000

export function openLoadSession(key: string, proof: { enabled: boolean; loopback: boolean }): { token: string; actor: LocalActor } | null {
  if (proof.enabled !== true || proof.loopback !== true) return null
  const match = LOAD_KEY.exec(key)
  if (!match) return null
  const n = Number(match[1])
  if (n >= LOAD_MEMBER_LIMIT) return null
  const actor: LocalActor = { key, memberId: `m_load_${n}` as MemberId, name: `Load member ${n}`, reviewer: false }
  const token = `local.load.${randomToken(24)}`
  sessions.set(token, actor)
  return { token, actor }
}

/** Sessions are single-process memory. Dropping one on disconnect keeps the map bounded under churn. */
export const closeSession = (token: string): void => { if (token.startsWith('local.load.')) sessions.delete(token) }
