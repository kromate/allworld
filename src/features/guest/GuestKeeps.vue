<script setup lang="ts">
// What a guest keeps: what stays on this device, what is still theirs after saving, and the
// limits. The limits are the service's own statement and numbers, not a paraphrase. Where the session
// says this host cannot save to an account, what a save would carry over is left out and the limits that
// end with a way to save end without it; expiry and recovery limits stay in full.
import { computed, inject } from 'vue'
import { GUEST_RECOVERY_NOTICE } from '../../shared/guest.ts'
import { CARRIES_OVER, GUEST_CAN, GUEST_CONTROL, GUEST_WAITS, STAYS_ON_DEVICE, timeLeft } from './guestView.ts'

const props = defineProps<{
  /** `GuestStatus.endsAt`: the last moment this guest can exist unsaved. Left out before a session exists. */
  endsAt?: string | null
}>()

const end = computed(() => timeLeft(props.endsAt, Date.now()))
// Only an explicit 'unavailable' counts. Before a session (the welcome) there is nothing to say yet, and the wording stays conditional ("after you save").
const guest = inject(GUEST_CONTROL, null)
const cannotSave = computed(() => guest?.session.value?.signIn === 'unavailable')
// Before a session exists (the welcome) nobody knows yet whether saving is offered, so the heading says "if".
const canSave = computed(() => guest?.session.value?.signIn === 'available')
const recovery = computed(() => (cannotSave.value ? GUEST_RECOVERY_NOTICE.replace(/ Save your character to an account to keep it\.$/, '') : GUEST_RECOVERY_NOTICE))
const waits = computed(() => (cannotSave.value ? GUEST_WAITS.replace(/ wait until the character is saved\.$/, ' need a saved character, and saving is not available on this playtest yet.') : GUEST_WAITS))
</script>

<template>
  <div class="keeps stack">
    <section>
      <h3><span aria-hidden="true">🔑</span> Stays on this device</h3>
      <ul>
        <li v-for="line in STAYS_ON_DEVICE" :key="line">{{ line }}</li>
      </ul>
    </section>
    <section v-if="!cannotSave">
      <h3><span aria-hidden="true">🧳</span> {{ canSave ? 'Still yours after you save' : 'Carries over if you save to an account' }}</h3>
      <ul>
        <li v-for="line in CARRIES_OVER" :key="line">{{ line }}</li>
      </ul>
    </section>
    <section>
      <h3><span aria-hidden="true">⏳</span> Limits</h3>
      <ul>
        <li>{{ recovery }}</li>
        <li v-if="end">This guest session {{ end.text }}, however often you play.</li>
        <li>{{ GUEST_CAN }} {{ waits }}</li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.keeps { font-size: 0.88rem; color: var(--ink-2); }
h3 { font-size: 0.86rem; color: var(--ink); margin-bottom: 4px; }
ul { margin: 0; padding-left: 18px; display: grid; gap: 4px; }
</style>
