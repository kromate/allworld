// The sharded world service: one state thread, N room shards, M edges, in one process.
//
//   members ── WebSocket ──▶ edge ──(movement, chat, voice)──▶ room shard
//                              └────(everything else)───────▶ state ──(enter / leave / cards)──▶ room shard
//
// This file only starts the threads and connects them. Each edge listens on its own port
// (port, port+1, …), standing in for instances behind a load balancer. See docs/SCALE.md for
// what is proven here and what is not.
import { MessageChannel, Worker } from 'node:worker_threads'
import type { MessagePort } from 'node:worker_threads'
import type { WorkerPorts } from './cluster-wire.ts'
import { processTotals } from './diagnostics.ts'
import type { ProcessSample } from './diagnostics.ts'
import { DEFAULT_MAX_CONNECTIONS } from './transport.ts'

export interface ClusterOptions { port: number; statePath: string; shards: number; edges: number; loadTest: boolean; maxConnections?: number }
export interface Cluster { ready: Promise<void>; stop(): Promise<void> }

interface Reply { kind: string; id?: number; sample?: ProcessSample; extra?: Record<string, unknown>; connections?: number; sockets?: number; reset?: boolean }

export function startCluster(options: ClusterOptions): Cluster {
  const shards = Math.max(1, options.shards), edges = Math.max(1, options.edges)
  // One channel for every pair of threads that talk.
  const edgeState = Array.from({ length: edges }, () => new MessageChannel())
  const shardState = Array.from({ length: shards }, () => new MessageChannel())
  const edgeShard = Array.from({ length: edges }, () => Array.from({ length: shards }, () => new MessageChannel()))
  const common = { statePath: options.statePath, loadTest: options.loadTest, maxConnections: options.maxConnections ?? DEFAULT_MAX_CONNECTIONS }

  const workers: { role: string; worker: Worker }[] = []
  const start = (file: string, data: WorkerPorts, ports: MessagePort[]): Worker => {
    const worker = new Worker(new URL(file, import.meta.url), { workerData: data, transferList: ports })
    workers.push({ role: `${data.role}-${data.index}`, worker })
    // A thread that dies takes rooms or sockets with it. This prototype does not rebuild them: it stops.
    worker.on('error', error => { console.error(`[cluster] ${data.role}-${data.index} failed`, error); process.exit(1) })
    worker.on('exit', code => { if (!stopping) { console.error(`[cluster] ${data.role}-${data.index} stopped unexpectedly (code ${code})`); process.exit(1) } })
    return worker
  }

  let stopping = false
  const statePorts = { edges: edgeState.map(channel => channel.port1), shards: shardState.map(channel => channel.port1) }
  start('./cluster-state.ts', { role: 'state', index: 0, port: options.port, ...common, ...statePorts }, [...statePorts.edges, ...statePorts.shards])
  for (let shard = 0; shard < shards; shard++) {
    const ports = { state: shardState[shard]!.port2, edges: edgeShard.map(row => row[shard]!.port1) }
    start('./cluster-shard.ts', { role: 'shard', index: shard, port: options.port, ...common, ...ports }, [ports.state, ...ports.edges])
  }
  for (let edge = 0; edge < edges; edge++) {
    const ports = { state: edgeState[edge]!.port2, shards: edgeShard[edge]!.map(channel => channel.port2) }
    start('./cluster-edge.ts', { role: 'edge', index: edge, port: options.port + edge, ...common, ...ports }, [ports.state, ...ports.shards])
  }

  // Diagnostics: an edge asks, every thread answers, the edge gets one combined reading.
  const collecting = new Map<number, { from: Worker; askedId: number; waiting: number; replies: Reply[] }>()
  let nextCollection = 1
  let readyCount = 0
  let markReady: () => void = () => undefined
  let markStopped: () => void = () => undefined
  let stoppedCount = 0
  const ready = new Promise<void>(resolve => { markReady = resolve })

  for (const { worker } of workers) {
    worker.on('message', (message: Reply) => {
      if (message.kind === 'ready') { if (++readyCount === workers.length) markReady(); return }
      if (message.kind === 'stopped') { if (++stoppedCount === workers.length) markStopped(); return }
      if (message.kind === 'diag') {
        const id = nextCollection++
        collecting.set(id, { from: worker, askedId: message.id!, waiting: workers.length, replies: [] })
        for (const other of workers) other.worker.postMessage({ kind: 'diag?', id, reset: message.reset })
        return
      }
      if (message.kind === 'diag!') {
        const collection = collecting.get(message.id!)
        if (!collection) return
        collection.replies.push(message)
        if (--collection.waiting > 0) return
        collecting.delete(message.id!)
        const threads = collection.replies.map(reply => reply.sample!).sort((a, b) => a.role.localeCompare(b.role))
        const state = collection.replies.find(reply => reply.sample!.role === 'state')
        const extra: Record<string, unknown> = { ...(state?.extra ?? {}) }
        extra.shards = collection.replies.filter(reply => reply.sample!.role.startsWith('shard')).map(reply => ({ role: reply.sample!.role, ...reply.extra }))
        collection.from.postMessage({
          kind: 'diag.result', id: collection.askedId,
          diagnostics: {
            loadTest: options.loadTest, connections: state?.connections ?? 0, sockets: collection.replies.reduce((sum, reply) => sum + (reply.sockets ?? 0), 0),
            shards, edges, process: processTotals(), threads, extra,
          },
        })
      }
    })
  }

  return {
    ready,
    async stop() {
      stopping = true
      const stopped = new Promise<void>(resolve => { markStopped = resolve })
      for (const { worker } of workers) worker.postMessage({ kind: 'stop' })
      // The state thread writes everything before it answers.
      await Promise.race([stopped, new Promise<void>(resolve => setTimeout(resolve, 5000))])
      await Promise.all(workers.map(({ worker }) => worker.terminate()))
    },
  }
}
