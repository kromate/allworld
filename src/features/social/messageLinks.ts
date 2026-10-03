// Preserve the message and turn only local game addresses into navigation.
import type { ArenaMatchId } from '../../shared/arena.ts'

export type MessagePart = { text: string; to?: undefined } | { text: string; to: string; matchId: ArenaMatchId }

const CANDIDATE = /(?:https?:\/\/|(?<![\w:/])\/arena\/match\/)[^\s<>"'`]+/gi
/** Punctuation that ends a sentence rather than an address. */
const TRAILING = /[.,;:!?)\]}”’]+$/
const MATCH_PATH = /^\/arena\/match\/(am_[a-z0-9_-]{3,40})\/?$/

function matchIdOf(candidate: string, origin: string): ArenaMatchId | null {
  let url: URL
  try { url = new URL(candidate, origin) } catch { return null }
  if (url.origin !== origin || url.username || url.password) return null
  return (MATCH_PATH.exec(url.pathname)?.[1] as ArenaMatchId | undefined) ?? null
}

export function messageParts(text: string, origin: string = window.location.origin): MessagePart[] {
  const parts: MessagePart[] = []
  let from = 0
  for (const found of text.matchAll(CANDIDATE)) {
    const start = found.index
    const address = found[0].replace(TRAILING, '')
    const matchId = matchIdOf(address, origin)
    if (!matchId) continue
    if (start > from) parts.push({ text: text.slice(from, start) })
    parts.push({ text: address, to: `/arena/match/${matchId}`, matchId })
    from = start + address.length
  }
  if (from < text.length) parts.push({ text: text.slice(from) })
  return parts
}
