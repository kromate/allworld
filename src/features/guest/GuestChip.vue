<script setup lang="ts">
// The one guest element over the world: says "guest" and opens the save window. It sits in the
// flow of the player row's column, so it has no offset of its own and covers nothing. Where this host
// cannot save to an account it says "Details" instead of "Save": the window it opens then shows how long
// the guest character is kept, and offers no save. A save that got no definite answer, on this page or
// before a reload, says "Save needs checking" until a definite answer: never "Not saved" or a plain
// "Save", which would read as if nothing had happened.
import { computed, inject } from 'vue'
import { GUEST_ACCESS } from './guestControl.ts'
import { GUEST_CONTROL, timeLeft } from './guestView.ts'
import type { ClaimState } from './guestView.ts'

const props = defineProps<{
  claim: ClaimState
  /** `GuestStatus.endsAt`. The chip says when the end is under a day and a half away. */
  endsAt?: string | null
  /** This browser could not keep the guest session, so it lasts for this tab only. */
  tabOnly?: boolean
}>()
const emit = defineEmits<{ open: [] }>()

// The session's own answer (`claimAvailable() && canSignIn()`, guestControl.ts). Only an explicit 'unavailable' counts:
// no control or no session yet is not an answer, and keeps the chip as it was.
const guest = inject(GUEST_CONTROL, null)
const cannotSave = computed(() => guest?.session.value?.signIn === 'unavailable')
// The controller's own flag: a save of this guest may have gone through. Read only; no account or capability here.
const access = inject(GUEST_ACCESS, null)
const checking = computed(() => Boolean(access?.claimUncertain.value))
const end = computed(() => timeLeft(props.endsAt, Date.now()))
const view = computed<{ tone: '' | 'busy' | 'bad' | 'good' | 'check'; short: string; long: string; idle?: boolean }>(() => {
  const details = { tone: '' as const, short: 'Details', long: 'Guest details', idle: true }
  const check = { tone: 'check' as const, short: 'Save needs checking', long: 'Save needs checking', idle: true }
  switch (props.claim.kind) {
    case 'signing-in': return { tone: 'busy', short: 'Signing in…', long: 'Signing in…' }
    case 'claiming': return { tone: 'busy', short: 'Saving…', long: 'Saving your character…' }
    case 'claimed': return { tone: 'good', short: 'Saved', long: 'Character saved' }
    case 'conflict': return { tone: 'bad', short: 'Choose', long: 'Choose a character' }
    // A save that could not start because this host has no sign-in is not a failure of the character: nothing was lost or half done.
    case 'failed': return checking.value ? check : props.claim.reason === 'sign-in-unavailable' && cannotSave.value ? details : { tone: 'bad', short: 'Not saved', long: 'Not saved — see why' }
    default: return checking.value ? check : cannotSave.value ? details : { tone: '', short: 'Save', long: 'Save my character', idle: true }
  }
})
/** The one thing worth saying beside "Save": it will not outlast this tab, or it ends soon. */
const warning = computed(() => (props.tabOnly ? 'this tab only' : end.value?.soon ? end.value.text : ''))
const label = computed(() => `Playing as a guest${props.tabOnly ? '; this browser could not keep the guest session, so it lasts for this tab only' : end.value?.soon ? `; the guest session ${end.value.text}` : ''}. ${view.value.long}`)
</script>

<template>
  <button class="guest-chip" :class="view.tone" type="button" :aria-label="label" :aria-busy="view.tone === 'busy' || undefined" @click="emit('open')">
    <span class="tag">Guest</span>
    <span v-if="view.tone === 'busy'" class="pulse" aria-hidden="true"></span>
    <span class="act short">{{ view.short }}</span>
    <span class="act long">{{ view.long }}</span>
    <span v-if="view.idle && warning" class="soon">{{ warning }}</span>
    <span class="go" aria-hidden="true">›</span>
  </button>
</template>

<style scoped>
.guest-chip { position: relative; pointer-events: auto; display: inline-flex; align-items: center; gap: 6px; max-width: 100%; min-height: 28px; padding: 0 10px 0 3px; border: 1px solid rgba(255, 255, 255, 0.3); border-radius: 999px; background: rgba(28, 26, 36, 0.62); color: #fff; font-size: 0.78rem; font-weight: 650; box-shadow: 0 2px 8px rgba(20, 14, 6, 0.22); white-space: nowrap; }
.guest-chip::after { content: ""; position: absolute; inset: -8px -4px; }
.guest-chip:hover { background: rgba(28, 26, 36, 0.8); }
.tag { padding: 2px 8px; border-radius: 999px; background: var(--accent); color: var(--accent-ink); font-size: 0.72rem; }
.act { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.long { display: none; }
.soon { min-width: 0; color: var(--accent); font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.go { color: rgba(255, 255, 255, 0.7); }
.bad .act { color: #ffc2b6; }
.good .act { color: #a8e6c2; }
.check .act { color: var(--accent); }
.pulse { width: 8px; height: 8px; border-radius: 50%; background: var(--accent-strong); animation: blink 1s ease infinite; flex: none; }
@keyframes blink { 50% { opacity: 0.3; } }
/* The chip stays small; the touch target is the 44 px the ::after reaches around it. */
@media (min-width: 721px) {
  .short { display: none; }
  .long { display: inline; }
}
</style>
