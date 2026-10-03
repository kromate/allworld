import { createHash } from 'node:crypto'
import type { Persistence } from '../kernel.ts'

type SqlValue = string | number | null
export interface SqlCursor {
  toArray(): Record<string, unknown>[]
  readonly rowsRead: number
  readonly rowsWritten: number
}
export interface SqliteStorage {
  readonly sql: {
    exec(query: string, ...bindings: SqlValue[]): SqlCursor
    readonly databaseSize?: number
  }
  transactionSync<T>(callback: () => T): T
  sync(): Promise<void>
}
export interface SqlitePersistenceOptions {
  /** The runtime supplies JSON.stringify([siteId, packageId, channel]). */
  scope: string
  dailyRowWriteLimit?: number
  now?: () => number
  /** At most 131072 UTF-16 units, below 512 KiB even for multibyte text. */
  chunkCharacters?: number
}
export interface SqlitePersistence extends Persistence {
  sync(): Promise<void>
  describe(): Record<string, unknown>
}

type Failure = 'unavailable' | 'corrupt' | 'scope' | 'obsolete' | 'quota' | 'capture'
class StorageFailure extends Error {
  readonly kind: Failure
  constructor(kind: Failure) { super(`World storage ${kind}.`); this.name = 'StorageFailure'; this.kind = kind }
}
interface Meta {
  revision: number; digest: string; day: string; written: number; total: number; rows: number; bytes: number
}
interface Fragment { id: number; slice: string; part: number; text: string; digest: string; bytes: number }
const SCHEMA = 1
const FREE_ROWS_PER_DAY = 100_000
const MAX_CHUNK_CHARACTERS = 131_072
const MAX_KEY_BYTES = 4096
// Native workerd counts two schema rows for each newly created table.
const BOOTSTRAP_ROW_WRITES = 5
const encode = new TextEncoder()
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const dayAt = (time: number): string => new Date(time).toISOString().slice(0, 10)
const fragmentKey = (slice: string, part: number): string => JSON.stringify([slice, part])
const manifest = (rows: Fragment[]): string => hash(JSON.stringify(rows.map(row => [row.slice, row.part, row.digest, row.bytes])))
const ordered = (rows: Fragment[]): Fragment[] => rows.sort((a, b) => a.slice < b.slice ? -1 : a.slice > b.slice ? 1 : a.part - b.part)

function parseMeta(row: Record<string, unknown>, scope: string): Meta {
  if (row.scope !== scope) throw new StorageFailure('scope')
  if (row.schema_version !== SCHEMA || !integer(row.revision) || typeof row.digest !== 'string' || !/^[a-f0-9]{64}$/.test(row.digest)
    || typeof row.quota_day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.quota_day)
    || !integer(row.quota_written) || !integer(row.total_written) || row.total_written < row.quota_written
    || !integer(row.row_count) || !integer(row.byte_count) || (row.revision === 0 && row.row_count !== 0)) throw new StorageFailure('corrupt')
  return { revision: row.revision, digest: row.digest, day: row.quota_day, written: row.quota_written, total: row.total_written, rows: row.row_count, bytes: row.byte_count }
}
function parseFragment(row: Record<string, unknown>): Fragment {
  if (!integer(row.id) || row.id === 0 || typeof row.slice !== 'string' || encode.encode(row.slice).length > MAX_KEY_BYTES
    || !integer(row.part) || typeof row.payload !== 'string' || row.payload.length > MAX_CHUNK_CHARACTERS
    || typeof row.digest !== 'string' || row.digest !== hash(row.payload) || !integer(row.byte_count)
    || row.byte_count !== encode.encode(row.payload).length) throw new StorageFailure('corrupt')
  return { id: row.id, slice: row.slice, part: row.part, text: row.payload, digest: row.digest, bytes: row.byte_count }
}

/** One database belongs to one world. INTEGER PRIMARY KEY avoids separately billed indexes. */
export function createSqlitePersistence(storage: SqliteStorage, options: SqlitePersistenceOptions): SqlitePersistence {
  const { scope, now = Date.now, dailyRowWriteLimit = 90_000, chunkCharacters = MAX_CHUNK_CHARACTERS } = options
  if (!scope || encode.encode(scope).length > MAX_KEY_BYTES || !integer(dailyRowWriteLimit) || dailyRowWriteLimit < 1 || dailyRowWriteLimit > FREE_ROWS_PER_DAY
    || !integer(chunkCharacters) || chunkCharacters < 2 || chunkCharacters > MAX_CHUNK_CHARACTERS) throw new StorageFailure('capture')
  let reads = 0
  const exec = (query: string, ...bindings: SqlValue[]): { rows: Record<string, unknown>[]; written: number } => {
    const cursor = storage.sql.exec(query, ...bindings)
    const rows = cursor.toArray()
    if (!integer(cursor.rowsWritten) || !integer(cursor.rowsRead)) throw new StorageFailure('unavailable')
    reads += cursor.rowsRead
    return { rows, written: cursor.rowsWritten }
  }
  const readMeta = (): Meta => {
    const rows = exec('SELECT * FROM world_meta WHERE id = 1').rows
    if (rows.length !== 1 || !rows[0]) throw new StorageFailure('corrupt')
    return parseMeta(rows[0], scope)
  }
  let meta: Meta
  let fragments: Fragment[]
  try {
    ;({ meta, fragments } = storage.transactionSync(() => {
      const tables = exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('world_meta', 'world_fragments')").rows
      if (tables.length !== 0 && tables.length !== 2) throw new StorageFailure('corrupt')
      if (tables.length === 0) {
        if (dailyRowWriteLimit < BOOTSTRAP_ROW_WRITES) throw new StorageFailure('quota')
        const createdMeta = exec('CREATE TABLE world_meta (id INTEGER PRIMARY KEY CHECK (id = 1), scope TEXT NOT NULL, schema_version INTEGER NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL, quota_day TEXT NOT NULL, quota_written INTEGER NOT NULL, total_written INTEGER NOT NULL, row_count INTEGER NOT NULL, byte_count INTEGER NOT NULL)')
        const createdFragments = exec('CREATE TABLE world_fragments (id INTEGER PRIMARY KEY, slice TEXT NOT NULL, part INTEGER NOT NULL, payload TEXT NOT NULL, digest TEXT NOT NULL, byte_count INTEGER NOT NULL)')
        const bootstrapWritten = createdMeta.written + createdFragments.written + 1
        if (bootstrapWritten > BOOTSTRAP_ROW_WRITES) throw new StorageFailure('unavailable')
        const result = exec('INSERT INTO world_meta VALUES (1, ?, ?, 0, ?, ?, ?, ?, 0, 0)', scope, SCHEMA, manifest([]), dayAt(now()), bootstrapWritten, bootstrapWritten)
        if (result.written !== 1) throw new StorageFailure('unavailable')
      }
      const resultMeta = readMeta()
      const resultFragments = ordered(exec('SELECT * FROM world_fragments').rows.map(parseFragment))
      if (resultFragments.length !== resultMeta.rows || resultFragments.reduce((sum, row) => sum + row.bytes, 0) !== resultMeta.bytes || manifest(resultFragments) !== resultMeta.digest) throw new StorageFailure('corrupt')
      return { meta: resultMeta, fragments: resultFragments }
    }))
  } catch (error) { throw error instanceof StorageFailure ? error : new StorageFailure('unavailable') }
  let lastSequence = 0
  let durableRevision = -1
  let superseded = false
  let failures = 0
  let quotaRefusals = 0
  let lastRowsWritten = 0
  let lastFailure: Failure | null = null
  let unavailable: Failure | null = null

  const capture = (text: string): Fragment[] => {
    const value: unknown = JSON.parse(text)
    if (!record(value)) throw new StorageFailure('capture')
    const rows: Fragment[] = []
    for (const slice of Object.keys(value).sort()) {
      if (encode.encode(slice).length > MAX_KEY_BYTES) throw new StorageFailure('capture')
      const payload = JSON.stringify(value[slice])
      if (payload === undefined) throw new StorageFailure('capture')
      for (let start = 0, part = 0; start < payload.length; part++) {
        let end = Math.min(start + chunkCharacters, payload.length)
        const last = payload.charCodeAt(end - 1)
        if (end < payload.length && last >= 0xd800 && last <= 0xdbff) end--
        const chunk = payload.slice(start, end)
        rows.push({ id: 0, slice, part, text: chunk, digest: hash(chunk), bytes: encode.encode(chunk).length })
        start = end
      }
    }
    return rows
  }
  const fail = (error: unknown): never => {
    const safe = error instanceof StorageFailure ? error : new StorageFailure('unavailable')
    failures++
    lastFailure = safe.kind
    unavailable ??= safe.kind
    if (safe.kind === 'quota') quotaRefusals++
    throw safe
  }
  const writeNow = (text: string, sequence: number): void => {
    try {
      if (unavailable !== null) throw new StorageFailure(unavailable)
      if (!integer(sequence) || sequence <= lastSequence || superseded) throw new StorageFailure('obsolete')
      const desired = capture(text)
      const previous = new Map(fragments.map(row => [fragmentKey(row.slice, row.part), row]))
      let nextId = fragments.reduce((max, row) => Math.max(max, row.id), 0) + 1
      const changed: Fragment[] = []
      for (const row of desired) {
        const key = fragmentKey(row.slice, row.part)
        const old = previous.get(key)
        row.id = old?.id ?? nextId++
        if (!old || old.text !== row.text) changed.push(row)
        previous.delete(key)
      }
      const removed = [...previous.values()]
      const result = storage.transactionSync(() => {
        const current = readMeta()
        if (current.revision !== meta.revision || current.digest !== meta.digest) { superseded = true; throw new StorageFailure('obsolete') }
        if (changed.length === 0 && removed.length === 0) return { meta: current, written: 0 }
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw new StorageFailure('unavailable')
        const day = dayAt(now()) > current.day ? dayAt(now()) : current.day
        const used = day === current.day ? current.written : 0
        const required = changed.length + removed.length + 1
        if (required > dailyRowWriteLimit - used) throw new StorageFailure('quota')
        let written = 0
        for (const row of removed) written += exec('DELETE FROM world_fragments WHERE id = ?', row.id).written
        for (const row of changed) written += exec('INSERT INTO world_fragments VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET slice = excluded.slice, part = excluded.part, payload = excluded.payload, digest = excluded.digest, byte_count = excluded.byte_count', row.id, row.slice, row.part, row.text, row.digest, row.bytes).written
        if (!Number.isSafeInteger(current.total + required)) throw new StorageFailure('unavailable')
        const next: Meta = { revision: current.revision + 1, digest: manifest(desired), day, written: used + required, total: current.total + required, rows: desired.length, bytes: desired.reduce((sum, row) => sum + row.bytes, 0) }
        written += exec('UPDATE world_meta SET revision = ?, digest = ?, quota_day = ?, quota_written = ?, total_written = ?, row_count = ?, byte_count = ? WHERE id = 1', next.revision, next.digest, next.day, next.written, next.total, next.rows, next.bytes).written
        if (written !== required) throw new StorageFailure('unavailable')
        return { meta: next, written }
      })
      meta = result.meta
      fragments = desired
      lastSequence = sequence
      lastRowsWritten = result.written
      lastFailure = null
    } catch (error) { fail(error) }
  }
  const sync = async (): Promise<void> => {
    if (unavailable !== null) throw new StorageFailure(unavailable)
    const revision = meta.revision
    try {
      await storage.sync()
      if (unavailable !== null) throw new StorageFailure(unavailable)
      durableRevision = Math.max(durableRevision, revision)
      lastFailure = null
    }
    catch (error) { fail(error) }
  }
  return {
    load() {
      try {
        const result: Record<string, unknown> = {}
        let slice: string | null = null
        let parts: string[] = []
        const finish = (): void => { if (slice !== null) Object.defineProperty(result, slice, { value: JSON.parse(parts.join('')), enumerable: true, writable: true, configurable: true }) }
        for (const row of fragments) {
          if (row.slice !== slice) { finish(); slice = row.slice; parts = [] }
          if (row.part !== parts.length) throw new StorageFailure('corrupt')
          parts.push(row.text)
        }
        finish()
        return meta.revision === 0 ? null : result
      } catch (error) { return fail(error instanceof StorageFailure ? error : new StorageFailure('corrupt')) }
    },
    save(state) {
      let text: string
      try { text = JSON.stringify(state) } catch { return fail(new StorageFailure('capture')) }
      writeNow(text, lastSequence + 1)
    },
    writeNow,
    async write(text, sequence) { writeNow(text, sequence); await sync() },
    sync,
    superseded: () => superseded,
    close() {},
    describe() {
      const currentDay = dayAt(now())
      const today = currentDay > meta.day ? 0 : meta.written
      return { kind: 'cloudflare-sqlite', schemaVersion: SCHEMA, revision: meta.revision, durableRevision, lastSequence,
        fragments: meta.rows, payloadBytes: meta.bytes, databaseBytes: storage.sql.databaseSize ?? null,
        chunkCharacters, maxFragmentBytes: chunkCharacters * 3, dailyRowWriteLimit, rowWriteDay: currentDay > meta.day ? currentDay : meta.day,
        rowsWrittenToday: today, rowsWrittenTotal: meta.total, rowsWrittenRemaining: Math.max(0, dailyRowWriteLimit - today),
        lastRowsWritten, rowsReadThisInstance: reads, failures, quotaRefusals, lastFailure, superseded, unavailable: unavailable !== null,
        budgetScope: 'this-durable-object', accountQuotaVerified: false }
    },
  }
}
