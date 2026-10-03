<script setup lang="ts">
// The save window as a page beside the world. Everything it shows comes from the controller the
// shell provides; without one it says there is nothing to save. Where the session says this host
// cannot save to an account, it is the guest's details instead (the chip says "Details" there), and
// a save in progress, a conflict or a saved character keep the page they always had. A save that got
// no definite answer (here or before a reload) is shown as "Save needs checking", with the one way to
// find out: the same account again. It is never shown as not saved or as a fresh save.
import { computed, inject, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import PanelPage from '../../ui/PanelPage.vue'
import GuestClaim from './GuestClaim.vue'
import { GUEST_ACCESS } from './guestControl.ts'
import { GUEST_CONTROL } from './guestView.ts'
import type { ClaimState } from './guestView.ts'

const router = useRouter()
const guest = inject(GUEST_CONTROL, null)
// The account form's state. The form is shown inside the save window, and only while it is open for a save.
const account = inject(GUEST_ACCESS, null)
const access = computed(() => (account?.access.at === 'save' ? account.access : null))
const idle: ClaimState = { kind: 'idle' }
const claim = computed(() => guest?.claim.value ?? idle)
const session = computed(() => guest?.session.value ?? null)
/** The controller's own flag: a save of this guest may have gone through. */
const uncertain = computed(() => Boolean(account?.claimUncertain.value))
/** Settled, with nothing else on screen: the page is about checking that save. */
const checking = computed(() => uncertain.value && (claim.value.kind === 'idle' || claim.value.kind === 'failed'))
/** The session's own answer is 'unavailable' and nothing else is going on. Unknown (no control, no session) keeps the save page. */
const details = computed(() => !checking.value && session.value?.signIn === 'unavailable' && (claim.value.kind === 'idle' || (claim.value.kind === 'failed' && claim.value.reason === 'sign-in-unavailable')))
const CHECK = 'A save of this character got no answer, so it may already have gone through. Check with the same account to find out; a character is never saved twice.'
/** What the window shows. An idle page with an unchecked save shows the check, not a fresh "Save my character". */
const shown = computed<ClaimState>(() => (checking.value && claim.value.kind === 'idle' ? { kind: 'failed', reason: 'offline', message: CHECK } : claim.value))
const title = computed(() => (details.value ? 'Guest details' : checking.value ? 'Save needs checking' : 'Save my character'))
const subtitle = computed(() => (details.value ? 'How long this guest session lasts, and what it keeps.'
  : checking.value ? 'Your last save may have gone through. Nothing here undoes it.' : 'Keep this character and what it has earned with your account.'))

// A finished attempt is cleared however the page is left (Close, Escape, another section), so the
// chip does not go on saying "Not saved" about something the visitor has already read.
onBeforeUnmount(() => { if (account?.access.at === 'save') account.cancelAccess(); if (claim.value.kind === 'failed' || claim.value.kind === 'claimed') guest?.reset() })
</script>

<template>
  <PanelPage :title="title" :subtitle="subtitle">
    <GuestClaim
      :session="session" :claim="shown" :busy="guest?.busy.value" :access="access" :password-policy="account?.passwordPolicy()" :google-sign-in="account?.googleAvailable.value ? account.submitGoogleAccess : undefined" :google-prepare="account?.googleAvailable.value ? account.prepareGoogleAccess : undefined" :uncertain="account?.claimUncertain.value"
      @save="guest?.save()" @retry="guest?.save()" @cancel="guest?.cancel()" @access="account?.submitAccess($event)"
      @continue-as="account?.continueAs()" @use-another="account?.useAnother()"
      @use-saved="guest?.useSaved()" @keep-guest="guest?.keepGuest()"
      @done="router.push('/')" @close="router.push('/')"
    />
  </PanelPage>
</template>
