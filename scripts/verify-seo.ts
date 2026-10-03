import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { fileURLToPath } from 'node:url'
import { pageMetadata } from '../service/pageMetadata.ts'

const root = new URL('../', import.meta.url)
const html = await readFile(new URL('index.html', root), 'utf8')
const origin = 'https://joinallworld.com'
const metadata = (name: string) => {
  const tags = [...html.matchAll(/<meta\s+(?:property|name)="([^"]+)"\s+content="([^"]*)"\s*\/>/g)]
    .filter(match => match[1] === name)
  assert.equal(tags.length, 1, `one ${name} tag`)
  const tag = tags[0]
  assert.ok(tag)
  const content = tag[2]
  assert.ok(content)
  return content
}
assert.match(html, /<title>Allworld \| A social world on real maps<\/title>/)
assert.match(html, /<link rel="canonical" href="https:\/\/joinallworld.com\/"/)
assert.equal(metadata('og:url'), `${origin}/`)
assert.equal(metadata('og:type'), 'website')
assert.equal(metadata('og:site_name'), 'Allworld')
assert.equal(metadata('og:image'), `${origin}/social/allworld-og.png`)
assert.equal(metadata('og:image:secure_url'), metadata('og:image'))
assert.equal(metadata('og:image:type'), 'image/png')
assert.equal(metadata('og:image:width'), '1200')
assert.equal(metadata('og:image:height'), '630')
assert.equal(metadata('twitter:card'), 'summary_large_image')
assert.equal(metadata('twitter:image'), metadata('og:image'))
for (const name of ['description', 'og:title', 'og:description', 'og:image:alt', 'twitter:title', 'twitter:description', 'twitter:image:alt']) assert.ok(metadata(name).length > 20)
assert.ok(!html.includes('aggregateRating'))
console.log('PASS raw HTML contains canonical, descriptive SEO and complete OG/Twitter metadata without JavaScript')

const assets = new Map<string, { body: Buffer; type: string }>()
for (const [path, type, width, height] of [
  ['/social/allworld-og.png', 'image/png', 1200, 630],
  ['/favicon.png', 'image/png', 48, 48],
  ['/apple-touch-icon.png', 'image/png', 180, 180],
] as const) {
  const body = await readFile(new URL(`public${path}`, root))
  assert.equal(body.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
  assert.equal(body.readUInt32BE(16), width)
  assert.equal(body.readUInt32BE(20), height)
  assert.ok(body.length < 1_000_000)
  assets.set(path, { body, type })
}
console.log('PASS social card and icons are real PNGs at declared dimensions within a 1 MB budget')
const sitemap = await readFile(new URL('public/sitemap.xml', root), 'utf8')
assert.deepEqual([...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map(match => match[1]), [`${origin}/`])
const robots = await readFile(new URL('public/robots.txt', root), 'utf8')
assert.match(robots, /Sitemap: https:\/\/joinallworld.com\/sitemap.xml/)
assert.ok(!/Disallow: \/(?:$|messages|home|settings|save)/m.test(robots), 'private HTML remains crawlable to read noindex')
assets.set('/robots.txt', { body: Buffer.from(robots), type: 'text/plain; charset=utf-8' })
assets.set('/sitemap.xml', { body: Buffer.from(sitemap), type: 'application/xml; charset=utf-8' })

const server = createServer(async (incoming, outgoing) => {
  const request = new Request(new URL(incoming.url ?? '/', origin), { method: incoming.method })
  const path = new URL(request.url).pathname
  const asset = assets.get(path)
  let response = asset ? new Response(new Uint8Array(asset.body), { headers: { 'content-type': asset.type } })
    : new Response(incoming.method === 'HEAD' ? null : html, { headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff',
    } })
  response = pageMetadata(request, response)
  outgoing.writeHead(response.status, Object.fromEntries(response.headers))
  outgoing.end(incoming.method === 'HEAD' ? undefined : Buffer.from(await response.arrayBuffer()))
})
try {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const local = `http://127.0.0.1:${address.port}`
  const homepage = await fetch(`${local}/`, { headers: { 'user-agent': 'facebookexternalhit/1.1' } })
  assert.equal(homepage.status, 200)
  assert.equal(homepage.headers.get('x-robots-tag'), null)
  assert.equal(await homepage.text(), html)
  for (const path of ['/messages/private-id', '/home', '/settings', '/save', '/avatar/editor', '/login', '/auth', '/index.html', '/unknown', '/?invite=private-token', '/?session=secret', '/?as=a', '/?invite=%3Cscript%3Esecret', '/messages/%70rivate', '/settings%3Fsession%3Dsecret']) {
    const response = await fetch(`${local}${path}`)
    assert.equal(response.headers.get('x-robots-tag'), 'noindex, nofollow', path)
    assert.equal(response.headers.get('cache-control'), 'no-cache')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(await response.text(), html, 'no private URL or query is interpolated into the HTML')
  }
  const head = await fetch(`${local}/settings`, { method: 'HEAD' })
  assert.equal(head.headers.get('x-robots-tag'), 'noindex, nofollow')
  assert.equal(await head.text(), '')
  for (const [path, asset] of assets) {
    const response = await fetch(`${local}${path}`)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('content-type'), asset.type)
    assert.equal(response.headers.get('x-robots-tag'), null)
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), asset.body)
  }
  console.log('PASS local crawler GET/HEAD sees raw root metadata, route/query noindex and HTTP 200 PNG/XML/text assets')
} finally {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
}
for (const [path, type, status] of [['/world/session', 'application/json', 401], ['/assets/app.js', 'text/javascript', 200], ['/missing.png', 'text/plain', 404]] as const) {
  const response = new Response('original', { status, headers: { 'content-type': type, 'cache-control': 'private' } })
  assert.equal(pageMetadata(new Request(`${origin}${path}`), response), response)
}
for (const status of [200, 404, 503]) {
  const response = new Response('original', { status, statusText: 'Preserved', headers: { 'content-type': 'text/html', 'cache-control': 'no-store', 'x-custom': 'kept' } })
  const guarded = pageMetadata(new Request(`${origin}/private`), response)
  assert.equal(guarded.status, status)
  assert.equal(guarded.statusText, 'Preserved')
  assert.equal(guarded.headers.get('cache-control'), 'no-store')
  assert.equal(guarded.headers.get('x-custom'), 'kept')
  assert.equal(await guarded.text(), 'original')
}
for (const url of ['https://preview.example/', 'https://legacy.example/', 'https://joinallworld.com/?redirect=https%3A%2F%2Fprivate.example']) {
  assert.equal(pageMetadata(new Request(url), new Response('', { headers: { 'content-type': 'text/html' } })).headers.get('x-robots-tag'), 'noindex, nofollow')
}
const streamed = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('streamed HTML')); controller.close() } })
const streamResponse = new Response(streamed, { headers: { 'content-type': 'text/html', 'content-length': '13' } })
const protectedStream = pageMetadata(new Request(`${origin}/private`), streamResponse)
assert.equal(protectedStream.body, streamed)
assert.equal(protectedStream.headers.get('content-length'), '13')
assert.equal(await protectedStream.text(), 'streamed HTML')
console.log('PASS response helper preserves bodies, statuses, cache/security headers and leaves API/static assets untouched')
console.log(`PASS SEO candidate ${fileURLToPath(root)}`)
