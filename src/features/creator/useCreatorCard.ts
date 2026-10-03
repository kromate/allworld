// The creator card for one window: asked for when the window mounts and again when the service
// says a friendship or a conversation changed. Only a window that was told the host has the
// operation asks at all, and there is no timer.
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import type { CreatorCard } from '../../shared/creator.ts'
import { WorldError } from '../../shared/model.ts'
import { api, messageOf, onAccountReset, onReconnect, onServerEvent } from '../../state/app.ts'
import { isCreator } from './creatorView.ts'

/**
 * loading — asked, no answer yet.   ready — `card` is the service's answer.
 * absent  — not asked (not activated), or this host does not know the operation.
 * error   — the request failed for another reason; `error` is the service's sentence.
 */
export type CreatorCardState = 'loading' | 'ready' | 'absent' | 'error'

export function useCreatorCard(active: () => boolean) {
  const card = shallowRef<CreatorCard | null>(null)
  const state = ref<CreatorCardState>(active() ? 'loading' : 'absent')
  const error = ref('')
  let run = 0

  async function load(): Promise<void> {
    const mine = ++run
    if (!active()) { card.value = null; state.value = 'absent'; return }
    if (!card.value) state.value = 'loading'
    try {
      const { creator } = await api('creator.card', {})
      if (mine !== run) return
      card.value = creator
      state.value = 'ready'
      error.value = ''
    } catch (cause) {
      if (mine !== run) return
      // A host the creator module was never registered on does not know the operation.
      if (cause instanceof WorldError && cause.code === 'invalid') { card.value = null; state.value = 'absent'; return }
      error.value = messageOf(cause)
      // A failed refresh keeps the last real answer on screen.
      if (!card.value) state.value = 'error'
    }
  }

  const stopEvents = onServerEvent(event => {
    if (event.type === 'direct.changed' || (event.type === 'social.changed' && event.scope === 'friends')) void load()
    // The welcome arriving while the window is open: the card now has a conversation to show.
    else if (event.type === 'direct.message' && isCreator(event.conversation.peer) && !card.value?.conversationId) void load()
  })
  const stopReconnect = onReconnect(() => { void load() })
  const stopReset = onAccountReset(() => { run++; card.value = null; state.value = active() ? 'loading' : 'absent'; error.value = '' })
  watch(active, () => { void load() })
  onMounted(() => { void load() })
  onBeforeUnmount(() => { run++; stopEvents(); stopReconnect(); stopReset() })

  return { card, state, error, reload: load }
}
