// Leaving the home window. One decision for every way out (Play, the close button, Esc, the shell's
// number shortcuts, the outside click, a visit, going home): may the member go, and what happens to
// what they have not saved. It holds no money rule and no scene: it asks the studio and says yes or no.
//
//   a payment with no answer yet   → no. They stay and are told; the window keeps the sheet that can check it
//   a price nobody agreed to       → dropped, then as below
//   nothing unsaved                → yes
//   unsaved furniture or a plan    → a dialog: save, discard or stay. Stay keeps every draft exactly as it was
//
// What the member then plays in is the service's saved home, never a draft.
import { computed, ref } from 'vue'
import type { ComputedRef, Ref } from 'vue'
import type { Studio } from './homeStudio.ts'

export interface LeaveGuard {
  /** The dialog is open: someone is waiting for the answer. */
  open: Ref<boolean>
  error: Ref<string>
  /** Furniture and plan drafts that leaving would drop. */
  unsettled: ComputedRef<boolean>
  settle(): Promise<boolean>
  save(): Promise<void>
  discard(): void
  stay(): void
}

export function createLeaveGuard(studio: Studio, tell: (text: string) => void): LeaveGuard {
  const { state, dirty, planDirty } = studio
  const open = ref(false)
  const error = ref('')
  const unsettled = computed(() => dirty.value || planDirty.value)
  let waiting: { resolve(go: boolean): void; promise: Promise<boolean> } | null = null

  const close = (go: boolean): void => { const was = waiting; waiting = null; open.value = false; was?.resolve(go) }

  function settle(): Promise<boolean> {
    if (waiting) return waiting.promise
    if (state.flow.phase === 'committing' || state.flow.phase === 'unknown') {
      tell('A payment is waiting for its answer. Check it before you leave.')
      return Promise.resolve(false)
    }
    // A price that was asked for and not agreed to costs nothing; it goes with the window.
    studio.cancelFlow()
    if (!unsettled.value) return Promise.resolve(true)
    error.value = ''
    let resolve: (go: boolean) => void = () => undefined
    const promise = new Promise<boolean>(done => { resolve = done })
    waiting = { resolve, promise }
    open.value = true
    return promise
  }
  async function save(): Promise<void> {
    error.value = ''
    if (!(await studio.save())) { error.value = state.saveError || 'It could not be saved.'; return }
    if (planDirty.value) studio.adoptPlan()
    close(true)
  }
  function discard(): void { studio.discard(); studio.adoptPlan(); close(true) }
  const stay = (): void => close(false)

  return { open, error, unsettled, settle, save, discard, stay }
}
