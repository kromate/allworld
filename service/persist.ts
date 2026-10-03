// File store for the world state: one JSON file with exactly one owner at a time.
//
// The kernel decides when to save and turns the state into text (service/kernel.ts, `capture`).
// This module puts that text on disk without holding the event loop — and makes sure the file
// can never be taken backwards by a second writer:
//
//   Lock        `<file>.lock` names the owner { pid, token, startedAt }. A second process is
//               refused while the owner's process is alive. A dead owner's lock is taken over.
//               A new instance in the same process (the dev server reloading the service) takes
//               over too: the instance it replaces is asked to write what it holds first, and is
//               then retired — every later write from it is dropped.
//   Every write re-reads the lock. If the token is no longer ours the write does not happen,
//               it is logged once, and this instance is marked superseded.
//   Revision    the file carries `$meta.revision`, rising by one per write. If the file on disk
//               is ahead of what this instance last loaded or wrote, this instance is superseded
//               instead of overwriting it.
//   Corrupt     a file that exists but does not parse is never started over: it is moved to
//               `<name>.corrupt-<time>.json` and kept. The newest good backup is loaded in its
//               place when there is one.
//   Backups     at most every 10 minutes the current good file is copied to
//               `<name>.backup-<1…6>.json`; the six most recent are kept.
//   Provenance  `<name>.log` gets one line per start, stop, takeover, refusal and recovery.
//
// Durability window: a change is on disk within the kernel's save gap (250 ms for a small state,
// longer as the state grows — the current figure is on /world/health) plus the write itself.
// A crash inside that window loses those changes. A clean stop loses nothing: `writeNow` runs
// first. A write that fails is reported by the kernel and retried; it is never dropped quietly.
import { randomUUID } from 'node:crypto'
import {
  appendFileSync, closeSync, constants, copyFileSync, existsSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, renameSync, statSync,
  unlinkSync, writeFileSync,
} from 'node:fs'
import { copyFile, open } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import type { Persistence } from './kernel.ts'

const PIECE = 512 * 1024
const BACKUP_EVERY_MS = 10 * 60_000
const BACKUPS_KEPT = 6
const LOG_LIMIT_BYTES = 256 * 1024

export interface FileStoreOptions {
  /** Shown in the provenance log. */
  port?: number | null
  backupEveryMs?: number
  /** Wall clock, replaceable in checks. */
  now?: () => number
}
export interface FileStore extends Persistence {
  superseded(): boolean
  foreign(): boolean
  bind(flush: () => void, retired?: () => void): void
  close(): void
  describe(): { revision: number; superseded: boolean; owner: boolean; lock: string; log: string }
  /** Set once the port is known (the dev server learns it after it starts listening). */
  setPort(port: number): void
}

interface Lock { pid: number; token: string; startedAt: string; port?: number | null }
interface Live { token: string; flush: (() => void) | null; retired: (() => void) | null; retire(reason: string): void; done: boolean }

// One register per process, shared even if this module is loaded twice (a dev-server reload).
const REGISTER = Symbol.for('neighbourhood-world.state-files')
const holder = globalThis as unknown as Record<symbol, Map<string, Live> | undefined>
const register: Map<string, Live> = (holder[REGISTER] ??= new Map<string, Live>())

const alive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

export function filePersistence(file: string, options: FileStoreOptions = {}): FileStore {
  const path = resolve(file)
  const stem = path.endsWith('.json') ? path.slice(0, -5) : path
  const lockPath = `${path}.lock`
  const logPath = `${stem}.log`
  const clock = options.now ?? Date.now
  const backupEvery = options.backupEveryMs ?? BACKUP_EVERY_MS
  const token = randomUUID()
  let port = options.port ?? null
  let owner = false
  let superseded = false
  let closed = false
  let revision = 0
  /** Highest capture that has replaced the file. An older one must never replace a newer one. */
  let onDisk = 0
  let lastBackupAt = 0
  /** Who wrote the file as this instance last saw it: itself after a write, the previous writer after a load. */
  let lastWriter: string | null = null
  let foreignNotedAt = 0

  const stamp = (): string => new Date(clock()).toISOString()
  const note = (event: string): void => {
    try {
      mkdirSync(dirname(path), { recursive: true })
      try { if (statSync(logPath).size > LOG_LIMIT_BYTES) renameSync(logPath, `${logPath}.1`) } catch { /* no log yet */ }
      appendFileSync(logPath, `${stamp()} pid=${process.pid} port=${port ?? '-'} revision=${revision} ${event}\n`)
    } catch { /* the log must never stop the service */ }
  }
  const readLock = (): Lock | null => {
    try {
      const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as Lock
      return typeof lock.pid === 'number' && typeof lock.token === 'string' ? lock : null
    } catch { return null }
  }
  const retire = (reason: string): void => {
    if (superseded) return
    superseded = true
    note(`superseded ${reason}`)
    console.error(`[world] this instance no longer owns ${path} (${reason}). It has stopped writing and will refuse operations.`)
    // Tell the World at once, so it stops answering members before it can acknowledge anything it cannot save.
    try { live.retired?.() } catch (error) { console.error('[world] the retired instance did not stop cleanly', error) }
  }
  const live: Live = { token, flush: null, retired: null, retire, done: false }

  /** Become the one owner of the file, or throw. */
  function acquire(): void {
    if (owner) return
    mkdirSync(dirname(path), { recursive: true })
    // An earlier instance in this process writes what it holds, then stops for good.
    const earlier = register.get(path)
    if (earlier && earlier !== live && !earlier.done) {
      try { earlier.flush?.() } catch (error) { console.error('[world] the instance being replaced could not write its state', error) }
      earlier.retire('replaced by a newer instance in this process')
    }
    const held = readLock()
    if (held && held.pid !== process.pid && alive(held.pid)) {
      note(`refused-start lock held by pid=${held.pid}`)
      throw new Error(`The world state ${path} is in use by process ${held.pid} (started ${held.startedAt}${held.port ? `, port ${held.port}` : ''}). Stop that process, or give this one its own WORLD_STATE.`)
    }
    const lock: Lock = { pid: process.pid, token, startedAt: stamp(), port }
    writeFileSync(`${lockPath}.${token}.tmp`, JSON.stringify(lock))
    renameSync(`${lockPath}.${token}.tmp`, lockPath)
    owner = true
    register.set(path, live)
    note(held ? `takeover from pid=${held.pid} (${held.pid === process.pid ? 'same process' : 'no longer running'})` : 'start')
  }

  /** `$meta` is always the first key, so the first bytes of the file say who wrote it and at which revision. */
  function onDiskMeta(): { revision: number; writer: string | null } | null {
    let descriptor: number
    try { descriptor = openSync(path, 'r') } catch { return null }
    try {
      const head = Buffer.alloc(320)
      const text = head.toString('utf8', 0, readSync(descriptor, head, 0, head.length, 0))
      const found = /^\{"\$meta":\{"revision":(\d+),"writer":"([^"]+)"/.exec(text)
      return found ? { revision: Number(found[1]), writer: found[2]! } : { revision: 0, writer: null }
    } finally { closeSync(descriptor) }
  }

  /** May this instance replace the file right now? */
  function mayWrite(): boolean {
    // After a clean stop the file belongs to whoever opens it next; this instance writes no more.
    if (superseded || closed) return false
    if (!owner) acquire()
    const lock = readLock()
    if (!lock || lock.token !== token) { retire(lock ? `the lock is held by pid=${lock.pid}` : 'the lock is gone'); note('refused-write lock not ours'); return false }
    const disk = onDiskMeta()
    if (disk && disk.revision > revision) {
      retire(`the file is at revision ${disk.revision}, this instance is at ${revision}`)
      note(`refused-write file ahead at revision=${disk.revision}`)
      return false
    }
    return true
  }

  /**
   * Has the file been replaced or removed by something that does not hold the lock (a service
   * instance still running older code)? This instance holds the lock and the newer state, so the
   * kernel answers by writing its state again at once — and it is logged, at most once a minute.
   */
  function foreign(): boolean {
    if (!owner || superseded || closed) return false
    const disk = onDiskMeta()
    const changed = disk ? disk.revision <= revision && (disk.revision !== revision || disk.writer !== lastWriter) : revision > 0 || onDisk > 0
    if (!changed) return false
    if (clock() - foreignNotedAt >= 60_000) {
      foreignNotedAt = clock()
      note(`foreign-write ${disk ? `found revision=${disk.revision}` : 'file missing'}; writing this instance's state again`)
      console.error(`[world] ${path} was ${disk ? 'replaced' : 'removed'} by something that does not hold its lock (a service still running older code?). Writing the current state again.`)
    }
    // Forget what was on disk: the next write goes ahead whatever is there.
    lastWriter = disk?.writer ?? null
    return true
  }

  const stamped = (text: string, next: number): string => {
    const meta = `{"$meta":{"revision":${next},"writer":"${token}","pid":${process.pid},"savedAt":"${stamp()}"}`
    return text.length <= 2 ? `${meta}}` : `${meta},${text.slice(1)}`
  }

  const backups = (): { path: string; at: number }[] => {
    const prefix = `${basename(stem)}.backup-`
    try {
      return readdirSync(dirname(path)).filter(name => name.startsWith(prefix) && name.endsWith('.json'))
        .map(name => { const full = join(dirname(path), name); return { path: full, at: statSync(full).mtimeMs } })
        .sort((a, b) => b.at - a.at)
    } catch { return [] }
  }
  /** Which backup file to (over)write next: an unused slot, else the oldest. */
  function backupTarget(): string {
    const existing = backups()
    for (let slot = 1; slot <= BACKUPS_KEPT; slot++) {
      const candidate = `${stem}.backup-${slot}.json`
      if (!existing.some(entry => entry.path === candidate)) return candidate
    }
    return existing[existing.length - 1]!.path
  }
  const backupDue = (): boolean => clock() - lastBackupAt >= backupEvery && existsSync(path)

  function parse(text: string): Record<string, unknown> | null {
    try {
      const value = JSON.parse(text) as unknown
      return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null
    } catch { return null }
  }
  const takeMeta = (state: Record<string, unknown>): number => {
    const meta = state.$meta as { revision?: unknown; writer?: unknown } | undefined
    delete state.$meta
    lastWriter = typeof meta?.writer === 'string' ? meta.writer : null
    return typeof meta?.revision === 'number' ? meta.revision : 0
  }

  const writeNow = (text: string, sequence: number): void => {
    if (!mayWrite()) return
    if (backupDue()) { try { copyFileSync(path, backupTarget(), constants.COPYFILE_FICLONE); lastBackupAt = clock() } catch (error) { console.error('[world] could not back up the state file', error) } }
    const next = revision + 1
    const temporary = `${path}.${token}.${sequence}.tmp`
    writeFileSync(temporary, stamped(text, next))
    renameSync(temporary, path)
    revision = next
    lastWriter = token
    onDisk = Math.max(onDisk, sequence)
  }

  return {
    load() {
      acquire()
      let text: string
      try { text = readFileSync(path, 'utf8') } catch { return null }
      let state = parse(text)
      if (!state) {
        // Never start empty over a file that is there but unreadable: keep it, and say so.
        const kept = `${stem}.corrupt-${stamp().replace(/[:.]/g, '-')}.json`
        renameSync(path, kept)
        console.error(`[world] ${path} could not be read as world state. It has been kept as ${kept}.`)
        note(`corrupt kept as ${basename(kept)}`)
        for (const backup of backups()) {
          try { state = parse(readFileSync(backup.path, 'utf8')) } catch { state = null }
          if (!state) continue
          copyFileSync(backup.path, path)
          revision = takeMeta(state)
          console.error(`[world] loaded the newest good backup instead: ${backup.path} (revision ${revision}).`)
          note(`restored from ${basename(backup.path)}`)
          return state
        }
        console.error('[world] there is no backup to load. Starting with an empty world.')
        note('started-empty no readable backup')
        return null
      }
      revision = takeMeta(state)
      const newest = backups()[0]
      lastBackupAt = newest ? newest.at : 0
      if (backupDue()) { try { copyFileSync(path, backupTarget(), constants.COPYFILE_FICLONE); lastBackupAt = clock() } catch { /* tried */ } }
      note('loaded')
      return state
    },
    save(state) { writeNow(JSON.stringify(state), onDisk + 1) },
    writeNow,
    async write(text, sequence) {
      if (!mayWrite()) return
      const next = revision + 1
      const body = stamped(text, next)
      const temporary = `${path}.${token}.${sequence}.tmp`
      const file = await open(temporary, 'w')
      try {
        for (let at = 0; at < body.length;) {
          let end = Math.min(body.length, at + PIECE)
          // Do not cut a character that is stored as two units in half.
          const last = body.charCodeAt(end - 1)
          if (end < body.length && last >= 0xd800 && last <= 0xdbff) end--
          await file.write(body.slice(at, end))
          at = end
        }
        await file.sync()
      } finally {
        await file.close()
      }
      if (backupDue()) { try { await copyFile(path, backupTarget(), constants.COPYFILE_FICLONE); lastBackupAt = clock() } catch (error) { console.error('[world] could not back up the state file', error) } }
      // The rename is the commit. The checks and the rename run in one uninterrupted step, so
      // neither a newer write from this instance nor a takeover can be overwritten by this one.
      if (sequence > onDisk && mayWrite()) { renameSync(temporary, path); revision = next; lastWriter = token; onDisk = sequence }
      else { try { unlinkSync(temporary) } catch { /* already gone */ } }
    },
    superseded: () => superseded,
    foreign,
    bind(flush, retired) { live.flush = flush; live.retired = retired ?? null },
    setPort(value) {
      port = value
      // Keep the lock's description current, so a refusal can say which port the owner is on.
      const lock = owner && !superseded && !closed ? readLock() : null
      if (lock?.token === token) { try { writeFileSync(`${lockPath}.${token}.tmp`, JSON.stringify({ ...lock, port })); renameSync(`${lockPath}.${token}.tmp`, lockPath) } catch { /* cosmetic */ } }
    },
    describe: () => ({ revision, superseded, owner: owner && !superseded, lock: lockPath, log: logPath }),
    close() {
      if (closed) return
      closed = true
      live.done = true
      if (register.get(path) === live) register.delete(path)
      if (!owner || superseded) return
      // Release the lock only if it is still ours.
      if (readLock()?.token === token) { try { unlinkSync(lockPath) } catch { /* already gone */ } }
      note('stop')
    },
  }
}
