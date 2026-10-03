<script setup lang="ts">
// Shown in a page, in place of something a guest may not do. The reason is the contract's own
// sentence for that gate (guestAccess in src/shared/guest.ts); the service refuses the operation
// whatever this window does. Where this host cannot save to an account, the contract's sentence (which
// ends in "Save your character…") and the Save button are replaced by the same fact without either.
import { computed, inject } from 'vue'
import { GUEST_GATE_MESSAGE } from '../../shared/guest.ts'
import type { GuestGate } from '../../shared/guest.ts'
import { GUEST_CONTROL } from './guestView.ts'

defineProps<{
  /** `guestAccess(op, input).gate` for the refused operation. */
  gate: GuestGate
  /** The service's own sentence, when the refusal came back from a call. */
  message?: string
}>()
const emit = defineEmits<{ save: [] }>()

// The session's own answer (`claimAvailable() && canSignIn()`). Only an explicit 'unavailable' counts; no control or no session keeps the Save button.
const guest = inject(GUEST_CONTROL, null)
const cannotSave = computed(() => guest?.session.value?.signIn === 'unavailable')
/** What the gate keeps closed, as the end of "Only a saved character can use …". */
const WHAT: Readonly<Record<GuestGate, string>> = {
  account: 'this', social: 'meeting and finding people', messaging: 'messaging other people', marketplace: 'the market', application: 'listings',
  moderation: 'this', competition: 'rated games, challenges, watched games or standings',
}
</script>

<template>
  <div class="notice amber gate" role="note">
    <div class="grow">
      <strong>You are playing as a guest.</strong>
      <div v-if="cannotSave">Only a saved character can use {{ WHAT[gate] }}. Saving is not available on this playtest yet.</div>
      <div v-else>{{ message || GUEST_GATE_MESSAGE[gate] }}</div>
    </div>
    <button v-if="!cannotSave" class="btn sm" type="button" @click="emit('save')">Save my character</button>
  </div>
</template>

<style scoped>
.gate { flex-wrap: wrap; align-items: center; }
.gate .grow { flex-basis: 180px; }
</style>
