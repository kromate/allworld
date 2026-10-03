// Load-on-mount with explicit loading, failed and ready states, reloadable on demand.
import { onMounted, onUnmounted, ref, watch } from 'vue'
import type { Ref, WatchSource } from 'vue'
import { messageOf } from '../state/app.ts'

export function useLoad<T>(load: () => Promise<T>, reloadOn: WatchSource[] = []): { data: Ref<T | null>; state: Ref<'loading' | 'error' | 'ready'>; error: Ref<string>; reload(): Promise<void> } {
  const data = ref<T | null>(null) as Ref<T | null>
  const state = ref<'loading' | 'error' | 'ready'>('loading')
  const error = ref('')
  let generation = 0
  let unmounted = false
  const reload = async (): Promise<void> => {
    if (unmounted) return
    const mine = ++generation
    if (data.value === null) state.value = 'loading'
    try {
      const result = await load()
      if (mine !== generation) return
      data.value = result
      error.value = ''
      state.value = 'ready'
    } catch (cause) {
      if (mine !== generation) return
      error.value = messageOf(cause)
      // Keep showing what we had if a background refresh fails.
      if (data.value === null) state.value = 'error'
    }
  }
  onMounted(reload)
  onUnmounted(() => { unmounted = true; generation++ })
  if (reloadOn.length) watch(reloadOn, () => { void reload() })
  return { data, state, error, reload }
}
