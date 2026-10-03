// Evidence probe for the saved world: one owner per state file, no going backwards, nothing
// thrown away. Runs real worlds against a temporary folder. Not a test suite: prints PASS lines.
//
//   node scripts/verify-persist.ts
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { WebSocket } from 'ws'
import { createWorldServer } from '../service/server.ts'
import type { WorldServer } from '../service/server.ts'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWorld } from '../service/index.ts'
import type { World } from '../service/kernel.ts'
import { ensureMember } from '../service/members.ts'
import { WorldError } from '../src/shared/model.ts'
import { filePersistence } from '../service/persist.ts'
import type { FileStore } from '../service/persist.ts'
import type { MemberId } from '../src/shared/ids.ts'
import { DASH, buildDashCourse, replayDash } from '../src/shared/play.ts'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const base = join(tmpdir(), `nw-verify-persist-${process.pid}`)
rmSync(base, { recursive: true, force: true })
const A = 'm_local_a' as MemberId, B = 'm_local_b' as MemberId
let now = Date.UTC(2026, 9, 1, 12)
const SECOND = 1000

const pass = (name: string): void => console.log(`PASS ${name}`)
const folder = (name: string): string => { const dir = join(base, name); mkdirSync(dir, { recursive: true }); return join(dir, 'world-state.json') }
const onDisk = (path: string): { $meta?: { revision: number; writer: string; pid: number }; [slice: string]: unknown } => JSON.parse(readFileSync(path, 'utf8'))
const log = (path: string): string => { try { return readFileSync(path.replace(/\.json$/, '.log'), 'utf8') } catch { return '' } }
const quiet = <T>(run: () => T): T => { const keep = console.error; console.error = () => undefined; try { return run() } finally { console.error = keep } }

function open(path: string, options: { backupEveryMs?: number } = {}): { world: World; store: FileStore } {
  const store = filePersistence(path, { port: 0, ...options })
  const world = createWorld({ persistence: store, now: () => now })
  for (const [member, name] of [[A, 'Ada'], [B, 'Bayo']] as const) world.scoped(() => ensureMember(world, member, name))
  return { world, store }
}

/** One full work shift: five correct answers. */
function workShift(world: World, member: MemberId): void {
  now += 35 * SECOND
  let { shift } = world.call(member, 'work.start', { workplaceId: 'corner-cafe', venueName: null })
  while (shift.status === 'active') {
    now += SECOND
    shift = world.call(member, 'work.answer', { shiftId: shift.id, index: shift.current!.index, handed: [...shift.current!.wants] }).shift
  }
  assert.equal(shift.status, 'completed')
}
const points = (world: World, member: MemberId): number => world.call(member, 'work.career', {}).career.points
const shifts = (world: World, member: MemberId): number => world.call(member, 'work.career', {}).career.shifts.completed
const communities = (world: World, member: MemberId): string[] => world.call(member, 'community.list', {}).mine.map(entry => entry.name)
const jobs = (world: World, member: MemberId): string[] => world.call(member, 'listing.list', { kind: 'job', mine: true }).listings.map(entry => entry.title)
const dashScores = (world: World, member: MemberId): number => world.call(member, 'board.get', { scope: 'personal', game: 'lane-dash', communityId: null }).board.rows.length

function playDash(world: World, member: MemberId): number {
  const { attempt } = world.call(member, 'dash.begin', { matchId: null })
  const outcome = replayDash(buildDashCourse(attempt.seed), [])!
  now += outcome.endTick * DASH.tickMs + 500
  const result = world.call(member, 'dash.submit', { attemptToken: attempt.attemptToken, inputs: [] })
  assert.equal(result.accepted, true, `the run was refused: ${result.reason}`)
  return result.outcome!.score
}

/** Another process tries to open the same state file. */
function fromAnotherProcess(path: string): string {
  const code = `import { filePersistence } from ${JSON.stringify(pathToFileURL(join(root, 'service', 'persist.ts')).href)}
try { filePersistence(${JSON.stringify(path)}).load(); console.log('OPENED') } catch (error) { console.log('REFUSED ' + error.message) }`
  return spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 20_000 }).stdout.trim()
}

// (a) ── Two services, one file: the second process is refused while the first is alive ──
{
  const path = folder('a')
  const { world } = open(path)
  workShift(world, A)
  world.flush()
  const earned = points(world, A)
  const answer = fromAnotherProcess(path)
  assert.ok(answer.startsWith('REFUSED'), `a second process must be refused, got: ${answer}`)
  assert.ok(answer.includes(`process ${process.pid}`), 'the refusal names the process that owns the file')
  console.log(`     another process is told: ${answer.replace(`REFUSED `, '')}`)

  const standalone = spawnSync(process.execPath, [join(root, 'service', 'standalone.ts')], { encoding: 'utf8', timeout: 20_000, env: { ...process.env, WORLD_STATE: path, WORLD_PORT: '5391' } })
  assert.equal(standalone.status, 1, 'the standalone service exits rather than share the file')
  assert.ok(standalone.stderr.includes(`process ${process.pid}`), 'and says which process owns it')

  const env: NodeJS.ProcessEnv = { ...process.env, WORLD_PORT: '5391' }
  delete env.WORLD_STATE
  const unset = spawnSync(process.execPath, [join(root, 'service', 'standalone.ts')], { encoding: 'utf8', timeout: 20_000, env })
  assert.equal(unset.status, 1, 'the standalone service will not start without WORLD_STATE')
  assert.ok(unset.stderr.includes('WORLD_STATE is not set'))

  assert.equal(onDisk(path).$meta!.pid, process.pid, 'the file is still the first owner’s')
  assert.equal(points(world, A), earned)
  assert.ok(log(path).includes('refused-start lock held by pid='), 'the refusal is in the provenance log')
  world.close()
  assert.ok(!existsSync(`${path}.lock`), 'a clean stop releases the lock')
  assert.equal(fromAnotherProcess(path), 'OPENED', 'and then another process may open the file')
  pass('one owner: a second process is refused by name while the owner is alive; standalone needs its own WORLD_STATE; a clean stop releases the lock')

  // A lock left by a process that no longer exists is taken over.
  const gone = spawnSync(process.execPath, ['-e', 'process.exit(0)']).pid
  writeFileSync(`${path}.lock`, JSON.stringify({ pid: gone, token: 'left-behind', startedAt: new Date().toISOString() }))
  const next = open(path)
  assert.equal(points(next.world, A), earned, 'nothing was lost across the takeover')
  assert.ok(log(path).includes(`takeover from pid=${gone} (no longer running)`))
  next.world.close()
  pass('a lock left by a dead process is taken over, and the saved state is intact')
}

// (b) ── Restart inside one process (the dev server reloading the service) ──
{
  const path = folder('b')
  const old = open(path)
  workShift(old.world, A)
  const unsaved = points(old.world, A)
  assert.ok(unsaved > 0)
  assert.equal(existsSync(path) && Object.keys(onDisk(path)).includes('work'), false, 'the shift is still only in memory')
  // The newer instance arrives. The older one is asked to write first, then retired.
  const fresh = quiet(() => open(path))
  assert.equal(points(fresh.world, A), unsaved, 'the newer instance starts from everything the older one held')
  assert.equal(old.store.superseded(), true)
  assert.equal(old.world.superseded, true)
  fresh.world.call(A, 'community.create', { name: 'After the reload', about: 'probe', topic: 'neighbours', areaLabel: 'Ibadan', visibility: 'public' })
  fresh.world.flush()
  const revision = onDisk(path).$meta!.revision
  // A member still attached to the older instance tries to carry on. It refuses, rather than
  // acknowledge work it can no longer save; the App reconnects and reaches the newer instance.
  let refusal = ''
  try { old.world.call(A, 'work.start', { workplaceId: 'corner-cafe', venueName: null }) } catch (error) { refusal = error instanceof WorldError ? error.code : String(error) }
  assert.equal(refusal, 'unavailable', 'the retired instance refuses operations')
  // Its timers and its shutdown still try to write.
  ensureMember(old.world, 'm_local_stale' as MemberId, 'Stale')
  old.world.touch()
  old.world.flush()
  old.world.close()
  const after = onDisk(path)
  assert.equal(after.$meta!.revision, revision, 'the old instance’s shutdown write did not happen')
  assert.equal(after.$meta!.writer, onDisk(path).$meta!.writer)
  assert.ok(existsSync(`${path}.lock`), 'and it did not release a lock that is no longer its own')
  fresh.world.close()
  const reopened = open(path)
  assert.equal(points(reopened.world, A), unsaved)
  assert.ok(!JSON.stringify(onDisk(path)).includes('m_local_stale'), 'what the retired instance held afterwards never reached the file')
  assert.deepEqual(communities(reopened.world, A), ['After the reload'], 'the newer instance’s work is what was kept')
  reopened.world.close()
  const lines = log(path)
  assert.ok(lines.includes('takeover from pid=') && lines.includes('(same process)') && lines.includes('superseded replaced by a newer instance in this process'))
  pass('restart in process: the old instance writes first and is retired; it then refuses operations, and its later writes, including the shutdown write, are dropped')
}

// (c) ── A state file that does not parse is kept, never started over ──
{
  const path = folder('c-empty')
  const broken = '{"members":{"members":{"m_local_a":{"profile":{"displayNa'
  writeFileSync(path, broken)
  const { world } = quiet(() => open(path))
  const kept = readdirSync(dirname(path)).filter(name => name.includes('.corrupt-'))
  assert.equal(kept.length, 1, 'the unreadable file was moved aside')
  assert.equal(readFileSync(join(dirname(path), kept[0]!), 'utf8'), broken, 'byte for byte')
  assert.equal(points(world, A), 0, 'with no backup the world starts empty')
  assert.ok(log(path).includes('corrupt kept as') && log(path).includes('started-empty'))
  world.close()

  // With a backup on hand, the newest good backup is loaded instead of an empty world.
  const backed = folder('c-backup')
  const first = open(backed, { backupEveryMs: 0 })
  workShift(first.world, A)
  first.world.flush()
  const saved = points(first.world, A)
  first.world.flush()                       // the flush before this one is now in a backup
  first.world.close()
  assert.ok(readdirSync(dirname(backed)).some(name => name.includes('.backup-')))
  writeFileSync(backed, '')
  const second = quiet(() => open(backed))
  assert.equal(points(second.world, A), saved, 'the backup was loaded')
  assert.equal(readdirSync(dirname(backed)).filter(name => name.includes('.corrupt-')).length, 1)
  assert.ok(log(backed).includes('restored from world-state.backup-'))
  second.world.close()
  pass('corrupt state file: kept as world-state.corrupt-<time>.json, the newest good backup is loaded, an empty world only when there is none')
}

// (d) ── Earnings, a community, a job and a game result across three restarts ──
{
  const path = folder('d')
  let { world } = open(path)
  workShift(world, A)
  workShift(world, A)
  world.call(A, 'community.create', { name: 'Bodija Neighbours', about: 'probe', topic: 'neighbours', areaLabel: 'Ibadan', visibility: 'public' })
  world.call(A, 'listing.save', { listingId: null, kind: 'job', title: 'Workshop assistant', organisation: 'Probe Furniture', description: 'Help sand and finish frames, three days a week.', areaLabel: 'Ibadan, Nigeria', remote: false, compensation: 'Weekly' })
  const score = playDash(world, A)
  const expected = { points: points(world, A), shifts: shifts(world, A), communities: communities(world, A), jobs: jobs(world, A), dash: dashScores(world, A) }
  assert.ok(expected.points > 0 && expected.shifts === 2 && expected.dash === 1)
  const read = (target: World) => ({ points: points(target, A), shifts: shifts(target, A), communities: communities(target, A), jobs: jobs(target, A), dash: dashScores(target, A) })
  const revisions: number[] = []
  for (let restart = 1; restart <= 3; restart++) {
    world.close()
    revisions.push(onDisk(path).$meta!.revision)
    world = open(path).world
    assert.deepEqual(read(world), expected, `restart ${restart}: everything is as it was`)
    // Each life of the service adds something, so a restart that reloaded an older file would show.
    workShift(world, A)
    expected.points = points(world, A)
    expected.shifts++
  }
  world.close()
  revisions.push(onDisk(path).$meta!.revision)
  assert.ok(revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]!), `revisions only rise: ${revisions.join(' → ')}`)
  console.log(`     after three restarts: ${expected.points} coins, ${expected.shifts} shifts, community "${expected.communities[0]}", job "${expected.jobs[0]}", Lane Dash score ${score}; file revisions ${revisions.join(' → ')}`)
  pass('earnings, a community, a job listing and a game result survive three restarts; the file revision only rises')
}

// (e) ── Never backwards: a file that is ahead of this instance is not overwritten ──
{
  const path = folder('e')
  const { world, store } = open(path)
  workShift(world, A)
  world.flush()
  const mine = onDisk(path)
  const ahead = { ...mine, $meta: { ...mine.$meta!, revision: mine.$meta!.revision + 7, writer: 'someone-newer' } }
  writeFileSync(path, JSON.stringify(ahead))
  workShift(world, A)
  quiet(() => world.flush())
  assert.equal(onDisk(path).$meta!.revision, mine.$meta!.revision + 7, 'the newer file was left alone')
  assert.equal(store.superseded(), true)
  assert.ok(log(path).includes('refused-write file ahead at revision='))
  world.close()
  pass('a file at a higher revision than this instance is never overwritten: the instance is superseded instead')
}

// (f) ── A writer that ignores the lock (a service still running older code) is noticed and undone ──
{
  const path = folder('f')
  const { world } = open(path)
  workShift(world, A)
  world.flush()
  const earned = points(world, A)
  // Older code wrote the whole file with no revision and no lock.
  writeFileSync(path, JSON.stringify({ members: { members: {}, reports: [] } }))
  quiet(() => world.tick())
  await new Promise(resolve => setTimeout(resolve, 400))
  const healed = onDisk(path)
  assert.equal(healed.$meta!.pid, process.pid)
  assert.ok(JSON.stringify(healed.work).includes(String(earned)), 'the owner’s state is back on disk')
  assert.ok(log(path).includes('foreign-write'))
  world.close()
  pass('a write by something that does not hold the lock is detected within a second and the owner’s state is written again')
}

// (g) ── Rolling backups: the last six are kept ──
{
  const path = folder('g')
  const { world } = open(path, { backupEveryMs: 0 })
  for (let round = 0; round < 9; round++) { workShift(world, B); world.flush(); await new Promise(resolve => setTimeout(resolve, 15)) }
  world.close()
  const names = readdirSync(dirname(path)).filter(name => name.includes('.backup-')).sort()
  assert.deepEqual(names, [1, 2, 3, 4, 5, 6].map(slot => `world-state.backup-${slot}.json`))
  const revisions = names.map(name => (JSON.parse(readFileSync(join(dirname(path), name), 'utf8')) as { $meta: { revision: number } }).$meta.revision).sort((a, b) => a - b)
  const latest = onDisk(path).$meta!.revision
  assert.deepEqual(revisions, [6, 5, 4, 3, 2, 1].map(back => latest - back), 'the six revisions before the current one')
  console.log(`     current revision ${latest}; backups hold revisions ${revisions.join(', ')}`)
  pass('backups: world-state.backup-1…6.json hold the six most recent earlier revisions (every 10 minutes in the service)')
}

// (h) ── The file written before this change (no $meta) still loads ──
{
  const path = folder('h')
  const first = open(path)
  workShift(first.world, A)
  first.world.close()
  const { $meta: _meta, ...plain } = onDisk(path)
  writeFileSync(path, JSON.stringify(plain))
  const second = open(path)
  assert.ok(points(second.world, A) > 0, 'an existing state file with no revision is read as it is')
  second.world.close()
  assert.equal(onDisk(path).$meta!.revision, 1)
  pass('the existing state file format (no revision) is read unchanged and gains a revision on its next write')
}

// (i) ── Over real sockets: members on a replaced or stopped service are let go, so the App reconnects ──
{
  const path = folder('i')
  const serve = async (): Promise<{ service: WorldServer; server: Server; url: string }> => {
    const service = createWorldServer({ statePath: path })
    const server = createServer((request, response) => { if (!service.handle(request, response)) { response.writeHead(404); response.end() } })
    service.attach(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    return { service, server, url: `127.0.0.1:${(server.address() as AddressInfo).port}` }
  }
  const join = async (url: string): Promise<{ socket: WebSocket; closed: Promise<number>; answer(op: string, input: unknown): Promise<{ ok: boolean; code?: string }> }> => {
    const session = await (await fetch(`http://${url}/world/local-session`, { method: 'POST', body: JSON.stringify({ actor: 'a' }) })).json() as { token: string }
    const socket = new WebSocket(`ws://${url}/world/socket`)
    const waiting = new Map<number, (frame: { ok: boolean; code?: string }) => void>()
    let welcomed: () => void = () => undefined
    const welcome = new Promise<void>(resolve => { welcomed = resolve })
    socket.on('message', data => {
      const frame = JSON.parse(String(data)) as { t: string; id?: number; ok?: boolean; code?: string }
      if (frame.t === 'welcome') welcomed()
      if (frame.t === 'res') waiting.get(frame.id!)?.({ ok: frame.ok!, code: frame.code })
    })
    await new Promise<void>(resolve => socket.on('open', () => resolve()))
    socket.send(JSON.stringify({ t: 'hello', token: session.token, resume: null }))
    await welcome
    let next = 1
    return {
      socket, closed: new Promise<number>(resolve => socket.on('close', code => resolve(code))),
      answer: (op, input) => new Promise(resolve => { const id = next++; waiting.set(id, resolve); socket.send(JSON.stringify({ t: 'req', id, op, input })) }),
    }
  }
  const first = await serve()
  const member = await join(first.url)
  assert.equal((await member.answer('community.create', { name: 'Before the reload', about: 'probe', topic: 'neighbours', areaLabel: 'Ibadan', visibility: 'public' })).ok, true)
  // The dev server re-creates the service while the member's tab is still attached to the old one.
  const keep = console.error
  console.error = () => undefined
  const second = await serve()
  console.error = keep
  assert.equal(await member.closed, 4009, 'the member is disconnected from the replaced service at once')
  assert.equal((await fetch(`http://${first.url}/world/health`)).status, 404, 'the replaced service no longer answers')
  const again = await join(second.url)
  assert.equal((await again.answer('member.me', {})).ok, true)
  assert.deepEqual(communities(second.service.world, A), ['Before the reload'], 'what the member did before the reload is in the new service')
  first.service.stop()
  second.service.stop()
  assert.equal(await again.closed, 1012, 'a clean stop also lets members go')
  for (const { server } of [first, second]) server.close()
  assert.deepEqual(JSON.stringify(onDisk(path)).includes('Before the reload'), true)
  pass('over real sockets: a member attached to a replaced service is disconnected (4009) and finds their work in the new one; a clean stop disconnects too (1012)')
}

// (j) ── The App's own connection code (src/platform/gateway.ts) across a service restart ──
// Arranged as the dev server arranges it: one HTTP server that hands requests and socket upgrades
// to whichever world service is current. The gateway runs here in Node with `location` and
// relative `fetch` pointed at that server; it is the same module the browser loads.
{
  const path = folder('j')
  let current: WorldServer | null = null
  let upgrade: ((...args: unknown[]) => void) | null = null
  const front = createServer((request, response) => { if (!current || !current.handle(request, response)) { response.writeHead(404); response.end() } })
  front.on('upgrade', (...args) => upgrade?.(...args))
  await new Promise<void>(resolve => front.listen(0, '127.0.0.1', resolve))
  const host = `127.0.0.1:${(front.address() as AddressInfo).port}`
  const start = (): WorldServer => {
    const next = createWorldServer({ statePath: path })
    next.attach({
      get listening() { return front.listening }, address: () => front.address(), once: (event: string, listener: () => void) => { front.once(event, listener) },
      on: (event: string, listener: (...args: unknown[]) => void) => { if (event === 'upgrade') upgrade = listener; else front.on(event, listener) },
    } as unknown as Server)
    return next
  }
  current = start()
  const realFetch = globalThis.fetch
  Object.assign(globalThis, {
    location: { protocol: 'http:', host, hostname: '127.0.0.1' },
    fetch: (input: string | URL | Request, init?: RequestInit) => realFetch(typeof input === 'string' && input.startsWith('/') ? `http://${host}${input}` : input, init),
  })
  const { connectLocalService } = await import('../src/platform/gateway.ts')
  const gateway = connectLocalService('a')
  const states: string[] = []
  gateway.onState(state => { states.push(state) })
  const reaches = async (state: string, from: number): Promise<void> => {
    for (let waited = 0; !states.slice(from).includes(state); waited += 20) { assert.ok(waited < 15_000, `the gateway never became ${state}: ${states.join(' → ')}`); await new Promise(resolve => setTimeout(resolve, 20)) }
  }
  await reaches('online', 0)
  await gateway.call('community.create', { name: 'Kept across restarts', about: 'probe', topic: 'neighbours', areaLabel: 'Ibadan', visibility: 'public' })

  // A clean restart, as the dev server does it: stop the old service (members get 1012), start the next.
  let mark = states.length
  let began = Date.now()
  current.stop()
  current = start()
  await reaches('reconnecting', mark)
  await reaches('online', mark)
  const afterStop = Date.now() - began
  assert.deepEqual((await gateway.call('community.list', {})).mine.map(entry => entry.name), ['Kept across restarts'])

  // A takeover: the next service starts while the old one is still running (members get 4009).
  mark = states.length
  began = Date.now()
  const old = current
  current = quiet(() => start())
  await reaches('reconnecting', mark)
  await reaches('online', mark)
  const afterTakeover = Date.now() - began
  assert.deepEqual((await gateway.call('community.list', {})).mine.map(entry => entry.name), ['Kept across restarts'])
  assert.ok(!states.includes('replaced') && !states.includes('denied') && !states.includes('offline'), `only reconnecting and online are expected: ${states.join(' → ')}`)
  console.log(`     gateway states: ${states.join(' → ')}; back online ${afterStop} ms after a clean restart (1012), ${afterTakeover} ms after a takeover (4009)`)
  gateway.close()
  old.stop()
  current.stop()
  front.close()
  pass('the App’s gateway treats close codes 1012 and 4009 as a dropped connection: it shows "reconnecting", signs in again and is back online with the member’s work intact')
}

// (k) ── A module that only changes its state on the tick, through a reference it kept ──
// (The game hall did exactly this: its matches moved on in the tick and were not saved.)
{
  const path = folder('k')
  const store = filePersistence(path, { port: 0 })
  const world = createWorld({ persistence: store, now: () => now })
  world.scoped(() => ensureMember(world, A, 'Ada'))
  // Kept when the module registers, as a module would in its register function.
  const kept = world.slice<{ ticks: number; quiet: number }>('probe-kept', () => ({ ticks: 0, quiet: 0 }))
  world.onTick(() => { kept.ticks++; world.touch() })
  // Kept from inside an operation (a lazily cached reference), then changed on later ticks.
  let cached: { ticks: number } | null = null
  world.onConnect(() => { cached ??= world.slice<{ ticks: number }>('probe-cached', () => ({ ticks: 0 })) })
  world.connect(A, () => undefined, () => undefined)
  world.onTick(() => { if (cached) { cached.ticks++; world.touch() } })
  // Changed on the tick with no announcement at all.
  const silent = world.slice<{ ticks: number }>('probe-silent', () => ({ ticks: 0 }))
  world.flush()
  const settle = async (): Promise<void> => { for (let waited = 0; world.saveStats.unsaved && waited < 5000; waited += 20) await new Promise(resolve => setTimeout(resolve, 20)); await new Promise(resolve => setTimeout(resolve, 30)) }

  now += 1000; world.tick()
  await settle()
  assert.equal((onDisk(path)['probe-kept'] as { ticks: number }).ticks, 1, 'a change made on the tick through a kept reference is saved with that tick')
  // The lazily cached slice and the silent one are caught by the kernel's once-a-second check of
  // one slice at a time: every slice comes round within as many ticks as there are slices.
  const sliceCount = Object.keys(onDisk(path)).length - 1
  world.onTick(() => { silent.ticks++ })
  let ticks = 1
  for (; ticks <= sliceCount * 2 + 2; ticks++) { now += 1000; world.tick(); await settle() }
  const saved = onDisk(path)
  assert.equal((saved['probe-kept'] as { ticks: number }).ticks, kept.ticks)
  assert.equal((saved['probe-cached'] as { ticks: number }).ticks, cached!.ticks, 'a reference kept from inside an operation is caught and then saved with every change')
  assert.ok(silent.ticks - (saved['probe-silent'] as { ticks: number }).ticks <= sliceCount, `a slice changed without any announcement is never more than one round of checks (${sliceCount} s) behind`)
  assert.ok((world.stats().save.looseSlices as string[]).includes('probe-kept') && (world.stats().save.looseSlices as string[]).includes('probe-cached'))
  // And it survives a restart.
  world.close()
  const reopened = createWorld({ persistence: filePersistence(path, { port: 0 }), now: () => now })
  assert.equal(reopened.slice<{ ticks: number }>('probe-kept', () => ({ ticks: -1 })).ticks, kept.ticks)
  assert.equal(reopened.slice<{ ticks: number }>('probe-silent', () => ({ ticks: -1 })).ticks, silent.ticks, 'a clean stop saves everything, announced or not')
  reopened.close()
  console.log(`     ${sliceCount} slices; after ${ticks - 1} ticks the kept slice is at ${kept.ticks} on disk, the cached one at ${cached!.ticks}; loose slices: ${(world.stats().save.looseSlices as string[]).filter(name => name.startsWith('probe')).join(', ')}`)
  pass('tick-time changes: saved with the tick when the module kept its slice from registration; caught within one round of checks when it kept it later or announced nothing; all saved at a clean stop')
}

rmSync(base, { recursive: true, force: true })
console.log('ALL PASS')
process.exit(0)
