<script setup lang="ts">
// A whole section a guest may not use yet, as a page: its usual title, the reason, and the way to
// save. The shell shows this in place of the section's own page for a guest. Where this host cannot save
// to an account there is no save to offer: the page leads back to play, and to the guest details.
import { computed, inject } from 'vue'
import { useRouter } from 'vue-router'
import type { GuestGate as Gate } from '../../shared/guest.ts'
import PanelPage from '../../ui/PanelPage.vue'
import GuestGate from './GuestGate.vue'
import { GUEST_CONTROL } from './guestView.ts'

defineProps<{
  /** The section's own title, so the bar and the page still agree. */
  title: string
  gate: Gate
  /** Where "Save my character" leads. */
  saveTo?: string
}>()
const router = useRouter()
const guest = inject(GUEST_CONTROL, null)
/** The session's own answer; only an explicit 'unavailable' counts. */
const cannotSave = computed(() => guest?.session.value?.signIn === 'unavailable')
</script>

<template>
  <PanelPage :title="title">
    <GuestGate :gate="gate" @save="router.push(saveTo ?? '/save')" />
    <div v-if="cannotSave" class="stack tight">
      <button class="btn primary block" type="button" @click="router.push('/')">Keep playing</button>
      <button class="btn ghost block" type="button" @click="router.push(saveTo ?? '/save')">Guest details</button>
    </div>
  </PanelPage>
</template>
