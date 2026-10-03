// Native storage for the one migration import (root C13, worldImport.ts revision 4). The module owns the protocol:
// readiness, accept, the PREPARED -> VERIFIED transition and every check. This adapter owns storage only.
//
// The receipt is kept in the existing schema, as the reserved fragment slice `worldImport` of the same world rows,
// so `commitPrepared` writes world + receipt in one `writeNow` transaction and `markVerified` rewrites only the
// receipt fragment (unchanged world fragments are not written). The World never sees it: `domainPersistence`
// filters it out of `load()` and appends the stored receipt last to every save, so gameplay can neither erase nor
// rewrite it. No new table, row kind or barrier policy.
import { WorldError } from '../../src/shared/model.ts'
import type { Persistence } from '../kernel.ts'
import { createSqlitePersistence } from './persistence.ts'
import type { SqlitePersistence, SqliteStorage } from './persistence.ts'
import type { ImportReceipt, ImportStore } from './worldImport.ts'

/** The reserved, target-only slice. `worldImport.ts` refuses any source that already carries it. */
export const RECEIPT_SLICE = 'worldImport'
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const receiptOf = (value: unknown): ImportReceipt | null =>
  object(value) && (value.phase === 'prepared' || value.phase === 'verified') && typeof value.importId === 'string' ? value as unknown as ImportReceipt : null
const domainOnly = (state: Record<string, unknown>): Record<string, unknown> => { const rest = { ...state }; delete rest[RECEIPT_SLICE]; return rest }

export function createNativeImportStore(storage: SqliteStorage, options: { scope: string }) {
  /** Any failed write or sync in this instance closes import and opening until the object restarts and reads storage again. */
  let latched = false
  const tables = (): number => storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('world_meta', 'world_fragments')").toArray().length
  // A fresh reader or writer each time: each phase starts from what storage holds, never from another instance's memory.
  const fresh = (): SqlitePersistence => createSqlitePersistence(storage, { scope: options.scope })
  /** Reads nothing into existence: with no tables, no table is created. */
  const read = (): Record<string, unknown> | null => tables() === 0 ? null : fresh().load()
  function write(state: Record<string, unknown>): void {
    if (latched) throw new WorldError('unavailable', 'The import store failed earlier. Restart before retrying.')
    try {
      const target = fresh()
      if (!target.writeNow) throw new Error('No transactional writer.')
      target.writeNow(JSON.stringify(state), 1)
    } catch { latched = true; throw new WorldError('unavailable', 'The import could not be stored.') }
  }
  const store: ImportStore = {
    async loadText() {
      const state = read()
      return state ? JSON.stringify(domainOnly(state)) : null
    },
    async receipt() { const state = read(); return state ? receiptOf(state[RECEIPT_SLICE]) : null },
    async commitPrepared(text, receipt) {
      const slices: unknown = JSON.parse(text)
      if (!object(slices) || RECEIPT_SLICE in slices || receipt.phase !== 'prepared') throw new Error('Refused.')
      // Conditional: only into a target with no state at all. A prepared, verified or foreign target is never overwritten.
      const current = read()
      if (current && Object.keys(current).length > 0) throw new WorldError('conflict', 'The target already holds state.')
      write({ ...slices, [RECEIPT_SLICE]: receipt })
    },
    async markVerified(receipt) {
      const current = read()
      const held = current ? receiptOf(current[RECEIPT_SLICE]) : null
      // Only the receipt changes, and only for the import that is prepared here.
      if (!current || !held || held.phase !== 'prepared' || receipt.phase !== 'verified' || held.importId !== receipt.importId
        || held.sha256 !== receipt.sha256 || held.sliceDigest !== receipt.sliceDigest) throw new Error('Refused.')
      write({ ...current, [RECEIPT_SLICE]: receipt })
    },
    async sync() {
      if (latched) throw new WorldError('unavailable', 'The import store failed earlier. Restart before retrying.')
      try { await storage.sync() } catch { latched = true; throw new WorldError('unavailable', 'The import could not be made durable.') }
    },
  }
  return {
    store,
    /** State without a receipt: never imported into and never opened. */
    foreign: (): boolean => { const state = read(); return state !== null && Object.keys(state).length > 0 && !receiptOf(state[RECEIPT_SLICE]) },
    get latched() { return latched },
    /**
     * The World's persistence, only once the module reports a VERIFIED receipt. The receipt is filtered from every
     * load and appended last to every save: a domain slice of the same name could never win over it.
     */
    domainPersistence(): SqlitePersistence {
      const inner = fresh()
      const stored = inner.load()
      const receipt = stored ? receiptOf(stored[RECEIPT_SLICE]) : null
      if (!receipt || receipt.phase !== 'verified') throw new Error('The import is not verified.')
      const tail = JSON.stringify(receipt)
      const withReceipt = (text: string): string => {
        if (!text.startsWith('{') || !text.endsWith('}')) throw new WorldError('unavailable', 'Refused a world text that is not an object.')
        return text === '{}' ? `{${JSON.stringify(RECEIPT_SLICE)}:${tail}}` : `${text.slice(0, -1)},${JSON.stringify(RECEIPT_SLICE)}:${tail}}`
      }
      const writeNow = inner.writeNow
      const wrapped: SqlitePersistence = {
        ...inner,
        load: () => { const state = inner.load(); return state ? domainOnly(state) : null },
        save: state => inner.save({ ...domainOnly(state), [RECEIPT_SLICE]: receipt }),
        ...(writeNow ? { writeNow: (text: string, sequence: number) => writeNow(withReceipt(text), sequence) } : {}),
        ...(inner.write ? { write: (text: string, sequence: number) => inner.write!(withReceipt(text), sequence) } : {}),
      }
      return wrapped satisfies Persistence
    },
  }
}
