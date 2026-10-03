interface TimerExtension { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/** Asynchronous elapsed GPU time; never waits for the GPU or assumes support. */
export class GpuBudget {
  private readonly gl: WebGL2RenderingContext | null
  private readonly extension: TimerExtension | null
  private pending: WebGLQuery | null = null
  private drawing = false
  private frames = 0
  private readonly sample: (milliseconds: number) => void

  constructor(gl: WebGLRenderingContext | WebGL2RenderingContext, sample: (milliseconds: number) => void) {
    this.gl = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext ? gl : null
    this.sample = sample
    const extension: unknown = this.gl?.getExtension('EXT_disjoint_timer_query_webgl2')
    this.extension = extension && typeof extension === 'object' && 'TIME_ELAPSED_EXT' in extension && typeof extension.TIME_ELAPSED_EXT === 'number' && 'GPU_DISJOINT_EXT' in extension && typeof extension.GPU_DISJOINT_EXT === 'number'
      ? { TIME_ELAPSED_EXT: extension.TIME_ELAPSED_EXT, GPU_DISJOINT_EXT: extension.GPU_DISJOINT_EXT } : null
  }

  get supported(): boolean { return this.extension !== null }

  begin(): void {
    const { gl, extension } = this
    if (!gl || !extension || gl.isContextLost()) return
    if (this.pending && gl.getQueryParameter(this.pending, gl.QUERY_RESULT_AVAILABLE)) {
      const nanoseconds: unknown = gl.getQueryParameter(this.pending, gl.QUERY_RESULT)
      if (!gl.getParameter(extension.GPU_DISJOINT_EXT) && typeof nanoseconds === 'number') this.sample(nanoseconds / 1e6)
      gl.deleteQuery(this.pending)
      this.pending = null
    }
    if (this.pending || ++this.frames % 20 !== 0) return
    this.pending = gl.createQuery()
    if (!this.pending) return
    gl.beginQuery(extension.TIME_ELAPSED_EXT, this.pending)
    this.drawing = true
  }

  end(): void {
    if (!this.drawing || !this.extension || !this.gl) return
    this.gl.endQuery(this.extension.TIME_ELAPSED_EXT)
    this.drawing = false
  }

  dispose(): void {
    this.end()
    if (this.pending) this.gl?.deleteQuery(this.pending)
    this.pending = null
  }
}
