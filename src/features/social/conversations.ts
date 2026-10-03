// The conversation list, kept in memory between visits to the Messages window so it opens at once
// and then catches up, instead of flashing empty every time a conversation is picked.
import { reactive } from 'vue'
import type { Conversation } from '../../shared/direct.ts'
import { api, messageOf, onAccountReset } from '../../state/app.ts'
import { social } from '../../state/social.ts'

export const inbox = reactive({
  list: [] as Conversation[],
  state: 'idle' as 'idle' | 'loading' | 'ready' | 'error',
  error: '',
})

let generation = 0
export async function loadInbox(): Promise<void> {
  const mine = ++generation
  if (inbox.state === 'idle') inbox.state = 'loading'
  try {
    const result = await api('direct.list', {})
    if (mine !== generation) return
    inbox.list = result.conversations
    social.unreadDirect = result.unread
    inbox.state = 'ready'
    inbox.error = ''
  } catch (error) {
    if (mine !== generation) return
    inbox.error = messageOf(error)
    if (inbox.state !== 'ready') inbox.state = 'error'
  }
}

/** Put one conversation's newest state into the list without waiting for a reload. */
export function patchConversation(conversation: Conversation): void {
  if (!conversation.last) return
  inbox.list = [conversation, ...inbox.list.filter(entry => entry.id !== conversation.id)]
    .sort((x, y) => Date.parse(y.updatedAt) - Date.parse(x.updatedAt))
}

/** "14:05" today, "Mon" this week, "3 Oct" before that. */
export function shortTime(iso: string, now = Date.now()): string {
  const at = Date.parse(iso)
  const sameDay = new Date(at).toDateString() === new Date(now).toDateString()
  if (sameDay) return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(at)
  if (now - at < 6 * 86_400_000) return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(at)
  return new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' }).format(at)
}

/** "Today", "Yesterday", "Monday 28 September". */
export function dayLabel(iso: string, now = Date.now()): string {
  const day = new Date(Date.parse(iso)), today = new Date(now)
  if (day.toDateString() === today.toDateString()) return 'Today'
  const yesterday = new Date(now - 86_400_000)
  if (day.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' }).format(day)
}

onAccountReset(() => { generation++; inbox.list = []; inbox.state = 'idle'; inbox.error = '' })
