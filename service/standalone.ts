// Run the world service on its own port: `npm run service`.
//
//   WORLD_PORT             port to listen on (default 5188)
//   WORLD_STATE            state file — required. This service never defaults to the dev server's shared world.
//   WORLD_SHARDS=N         run sharded: one state thread, N room shards (service/cluster.ts)
//   WORLD_EDGES=M          with WORLD_SHARDS: M socket edges, on WORLD_PORT, WORLD_PORT+1, … (default 1)
//   WORLD_MAX_CONNECTIONS  refuse sockets beyond this many (per edge when sharded)
//   WORLD_DURABLE_ACKS=1   answer a state-changing operation only once the change is on disk (one process only)
//   WORLD_FAR_EVERY=N      far-away avatars are updated every N steps (default 3; 1 = every step)
//   WORLD_LOAD_TEST=1      allow generated load-test members; never set by the App's dev server
import { createServer } from 'node:http'

const port = Number(process.env.WORLD_PORT ?? 5188)
// A state file has one owner. The dev server owns .goalmatic/local/world-state.json, so a
// standalone service must be told which file is its own; it will not guess.
if (!process.env.WORLD_STATE) {
  console.error('WORLD_STATE is not set. Give this service its own state file, for example:\n  WORLD_STATE=/tmp/world/world-state.json node service/standalone.ts\nIt does not default to the dev server\'s shared world, because two services writing one file roll each other back.')
  process.exit(1)
}
const statePath = process.env.WORLD_STATE
const maxConnections = Number(process.env.WORLD_MAX_CONNECTIONS) || undefined
const loadTest = process.env.WORLD_LOAD_TEST === '1'
const shards = Number(process.env.WORLD_SHARDS) || 0

if (shards > 0) {
  const { startCluster } = await import('./cluster.ts')
  const edges = Number(process.env.WORLD_EDGES) || 1
  const cluster = startCluster({ port, statePath, shards, edges, loadTest, maxConnections })
  await cluster.ready
  console.log(`World service (local, ${shards} room shard(s), ${edges} edge(s)) on http://127.0.0.1:${port}/world/health`)
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { void cluster.stop().then(() => process.exit(0)) })
} else {
  const { createWorldServer } = await import('./server.ts')
  let worldServer: ReturnType<typeof createWorldServer>
  try { worldServer = createWorldServer({ statePath, loadTest, maxConnections, durableAcks: process.env.WORLD_DURABLE_ACKS === '1', port }) }
  catch (error) { console.error(error instanceof Error ? error.message : error); process.exit(1) }
  const server = createServer((request, response) => {
    if (!worldServer.handle(request, response)) { response.writeHead(404); response.end() }
  })
  worldServer.attach(server)
  server.listen(port, '127.0.0.1', () => console.log(`World service (local) on http://127.0.0.1:${port}/world/health`))
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { worldServer.stop(); process.exit(0) })
}
