// Return notifications: a durable in-App inbox plus external reminders that are prepared,
// suppressed and previewed here but only sent by an adapter that has been authorized.
import type { DeliveryId, Iso, NotificationId } from './ids.ts'
import type { PublicMember } from './model.ts'

export const NOTIFY_CATEGORIES = ['replies', 'challenges', 'events', 'work', 'social', 'market'] as const
export type NotifyCategory = (typeof NOTIFY_CATEGORIES)[number]

export const EXTERNAL_CHANNELS = ['email', 'whatsapp', 'push'] as const
export type ExternalChannel = (typeof EXTERNAL_CHANNELS)[number]
export type Channel = 'in-app' | ExternalChannel

export type NotificationState = 'active' | 'expired' | 'resolved'

export interface Notification {
  id: NotificationId
  category: NotifyCategory
  /** Machine name of the event, for example "challenge.invited". */
  kind: string
  title: string
  body: string
  /** App route that opens the record this is about. */
  link: string
  actor: PublicMember | null
  createdAt: Iso
  updatedAt: Iso
  expiresAt: Iso | null
  readAt: Iso | null
  state: NotificationState
  /** How many identical events were folded into this one. */
  count: number
}

export interface QuietHours {
  enabled: boolean
  /** Local wall-clock "HH:MM". */
  start: string
  end: string
  timezone: string
}

export interface ChannelConsent {
  granted: boolean
  /** Masked on read, for example "an•••@example.com". The full value never returns to a client. */
  destination: string
  grantedAt: Iso | null
}

export interface NotifyPrefs {
  categories: Record<NotifyCategory, Record<Channel, boolean>>
  quietHours: QuietHours
  consent: Record<ExternalChannel, ChannelConsent>
  /** Minutes an unread in-App event waits before an external reminder is prepared. */
  reminderDelayMinutes: number
}

export type DeliveryState =
  | 'scheduled'
  | 'held-quiet-hours'
  | 'ready-not-sent'
  | 'suppressed-read'
  | 'suppressed-expired'
  | 'suppressed-duplicate'
  | 'sent'
  | 'failed'

export interface Delivery {
  id: DeliveryId
  notificationId: NotificationId
  channel: ExternalChannel
  state: DeliveryState
  scheduledFor: Iso
  updatedAt: Iso
  /** Exactly what the adapter would send. */
  preview: { to: string; subject: string; text: string }
  /** Plain reason for the current state. */
  reason: string
}

/** Whether each external adapter may actually send. All false until a destination test is authorized. */
export interface AdapterStatus { channel: ExternalChannel; mode: 'dry-run' | 'live'; note: string }

export const DEFAULT_REMINDER_DELAY_MINUTES = 10
