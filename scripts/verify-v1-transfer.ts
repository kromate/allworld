import assert from 'node:assert/strict'
import { createWorld } from '../service/index.ts'
import { registerGuests, scopeFromHosted } from '../service/guests.ts'
import { registerCreator } from '../service/creator.ts'
import { createGuestTransfers, guestTransferOrigins } from '../service/guestTransfers.ts'
const target = 'https://v1.joinallworld.com', legacy = 'https://joinallworld.com'
const original = 'https://allworld.akpananthony33.workers.dev'
assert.deepEqual(guestTransferOrigins(legacy, target), [legacy, original])
assert.deepEqual(guestTransferOrigins(original, legacy), [original])
assert.deepEqual(guestTransferOrigins('https://old.invalid', target), ['https://old.invalid'])
let saved: Record<string, unknown> | null = null
let now = Date.now()
const world = createWorld({ now: () => now, persistence: { load: () => saved, save: state => { saved = JSON.parse(JSON.stringify(state)) } } })
const scope = scopeFromHosted({ audience: 'https://audience.invalid', siteId: 'site', packageId: 'package', channel: 'test', origin: target, buildId: 'build', artifactId: 'artifact' })
const guests = registerGuests(world, scope, { entry: 'open' })
registerCreator(world, null)
const transfers = createGuestTransfers({ world, guests, legacyOrigin: legacy, targetOrigin: target, sealKey: new Uint8Array(32).fill(7), admitted: token => { guests.resume({ token, source: 'admission' }) }, sync: () => { world.flush() } })
let source = 0
const request = (path: string, origin: string, body: unknown) => transfers.respond({ path: '/world/guest-transfer/' + path, origin, method: 'POST', contentType: 'application/json', body: JSON.stringify(body), source: `test-${++source}` })
try {
  for (const origin of [legacy, original]) {
    const guest = guests.issue({ source: `issue-${++source}` })
    const start = await request('start', origin, { token: guest.session.token })
    assert.equal(start?.status, 200)
    assert.equal(start.headers['access-control-allow-origin'], origin)
    assert.equal(start.headers['access-control-allow-credentials'], undefined)
    const issued = JSON.parse(start.body!)
    assert.equal(new URL(issued.next).origin, target)
    assert.ok(!issued.next.includes(guest.session.token))
    assert.equal((await request('consume', legacy, { code: issued.code }))?.status, 403)
    const consumed = await request('consume', target, { code: issued.code })
    assert.equal(consumed?.status, 200)
    assert.equal(JSON.parse(consumed.body!).token, guest.session.token)
    assert.notEqual((await request('consume', target, { code: issued.code }))?.status, 200)
    assert.equal(guests.resume({ token: guest.session.token, source: `resume-${++source}` }).actor.memberId, guest.actor.memberId)
  }
  for (const origin of ['https://evil.invalid', 'https://joinallworld.com.evil.invalid', target]) {
    const answer = await request('start', origin, { token: 'invalid' })
    assert.equal(answer?.status, 403)
    assert.equal(answer.headers['access-control-allow-origin'], undefined)
  }
  const guest = guests.issue({ source: `expiry-${++source}` })
  const start = await request('start', legacy, { token: guest.session.token })
  now += 120001
  assert.notEqual((await request('consume', target, { code: JSON.parse(start!.body!).code }))?.status, 200)
  console.log('PASS both historical origins, strict CORS, one-use, original capability preserved, wrong origin and expired code refused')
} finally { world.close() }
