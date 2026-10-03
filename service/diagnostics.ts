// Local diagnostics for load testing: event-loop delay, CPU time, memory and traffic counters.
// Served under /world/health only to loopback callers. Nothing here identifies a member.
import { PerformanceObserver, monitorEventLoopDelay, performance } from 'node:perf_hooks'

const RESOLUTION_MS = 10

export interface LoopStats { p50: number; p95: number; p99: number; max: number; mean: number }
export interface Counters {
  framesIn: number
  framesOut: number
  bytesIn: number
  bytesOut: number
  /** Socket writes actually issued (one per flush when frames are corked together). */
  writes: number
  /** Movement updates discarded for sockets whose send buffer was over the limit. */
  droppedMoves: number
  /** Connections refused because the process was at its cap. */
  refused: number
  /** Sockets closed for being silent past the idle limit. */
  idleClosed: number
}
export interface ProcessSample {
  role: string
  pid: number
  /** Milliseconds of CPU this thread (or process, for the main thread) has used since it started. */
  cpuMs: number
  /** Fraction of wall time the event loop was busy since the last sample (0–1). */
  utilization: number
  loop: LoopStats
  /** Garbage collection since the last read: total and longest pause, in ms. */
  gc: { totalMs: number; maxMs: number; count: number }
  rssMb: number
  heapMb: number
  counters: Counters
}

/** One per thread. `read()` returns figures since the previous read and starts a new window. */
export class Diagnostics {
  readonly counters: Counters = { framesIn: 0, framesOut: 0, bytesIn: 0, bytesOut: 0, writes: 0, droppedMoves: 0, refused: 0, idleClosed: 0 }
  private readonly role: string
  private readonly histogram: ReturnType<typeof monitorEventLoopDelay>
  private lastUtilization = performance.eventLoopUtilization()
  private gc = { totalMs: 0, maxMs: 0, count: 0 }
  private readonly gcObserver: PerformanceObserver

  constructor(role: string) {
    this.role = role
    this.histogram = monitorEventLoopDelay({ resolution: RESOLUTION_MS })
    this.histogram.enable()
    this.gcObserver = new PerformanceObserver(list => {
      for (const entry of list.getEntries()) { this.gc.count++; this.gc.totalMs += entry.duration; if (entry.duration > this.gc.maxMs) this.gc.maxMs = entry.duration }
    })
    this.gcObserver.observe({ entryTypes: ['gc'] })
  }

  read(reset = true): ProcessSample {
    const h = this.histogram
    // The histogram records the gap between timer fires, which includes the timer period itself.
    const ms = (ns: number): number => Math.max(0, Math.round((ns / 1e6 - RESOLUTION_MS) * 100) / 100)
    const loop: LoopStats = h.count === 0
      ? { p50: 0, p95: 0, p99: 0, max: 0, mean: 0 }
      : { p50: ms(h.percentile(50)), p95: ms(h.percentile(95)), p99: ms(h.percentile(99)), max: ms(h.max), mean: ms(h.mean) }
    const utilization = performance.eventLoopUtilization(this.lastUtilization)
    const usage = cpuUsage()
    const memory = process.memoryUsage()
    const sample: ProcessSample = {
      role: this.role, pid: process.pid, cpuMs: Math.round((usage.user + usage.system) / 1000), utilization: Math.round(utilization.utilization * 1000) / 1000,
      loop, gc: { totalMs: Math.round(this.gc.totalMs), maxMs: Math.round(this.gc.maxMs * 10) / 10, count: this.gc.count }, rssMb: Math.round(memory.rss / 1048576), heapMb: Math.round(memory.heapUsed / 1048576), counters: { ...this.counters },
    }
    if (reset) { h.reset(); this.lastUtilization = performance.eventLoopUtilization(); this.gc = { totalMs: 0, maxMs: 0, count: 0 } }
    return sample
  }

  stop(): void { this.histogram.disable(); this.gcObserver.disconnect() }
}

/** CPU time of the calling thread where the runtime can report it, else of the whole process. */
function cpuUsage(): { user: number; system: number } {
  const perThread = (process as unknown as { threadCpuUsage?: () => { user: number; system: number } }).threadCpuUsage
  try { if (typeof perThread === 'function') return perThread.call(process) } catch { /* fall through */ }
  return process.cpuUsage()
}

/** Whole-process totals (every thread), for the load harness's CPU and memory columns. */
export function processTotals(): { pid: number; cpuMs: number; rssMb: number } {
  const usage = process.cpuUsage()
  return { pid: process.pid, cpuMs: Math.round((usage.user + usage.system) / 1000), rssMb: Math.round(process.memoryUsage().rss / 1048576) }
}
