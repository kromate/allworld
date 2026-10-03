<script setup lang="ts">
// Save my character: one state at a time, one primary action for it. This window never decides an
// outcome. "Saved" and "already has a character" are shown only when the claim state says the
// service answered so. Signing in happens here, in the page: the form hands what was typed to the
// shell and keeps nothing; the shell says when its request is running and how it failed.
import { computed } from 'vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import AccountAccess from '../account/AccountAccess.vue'
import type { AccountCredentials, AccountFormError, AccountPasswordPolicy } from '../account/AccountAccess.vue'
import GuestConflict from './GuestConflict.vue'
import GuestKeeps from './GuestKeeps.vue'
import { NOT_PERSISTED, failureView } from './guestView.ts'
import type { ClaimState, GuestSessionView } from './guestView.ts'

const props = defineProps<{
  /** Null when the visitor is not a guest (for example straight after a save). */
  session: GuestSessionView | null
  claim: ClaimState
  /** A conflict choice is being applied. */
  busy?: 'use-saved' | 'keep-guest' | null
  /**
   * The account choice is open for this save: whether its request is running, how the last one
   * failed, and the email of an account already signed in here (offered by name, used only when
   * confirmed). Null while the shell is still checking for a session.
   */
  access?: { pending: boolean; error: AccountFormError | null; existing: string | null } | null
  passwordPolicy?: AccountPasswordPolicy
  /** The last save got no definite answer: it may have gone through. */
  uncertain?: boolean
}>()
const emit = defineEmits<{
  save: []
  cancel: []
  /** What the form collected, handed on untouched. Never kept here. */
  access: [credentials: AccountCredentials]
  /** Use the account named in `access.existing`. */
  continueAs: []
  /** Show the form instead of the named account. */
  useAnother: []
  retry: []
  useSaved: []
  keepGuest: []
  /** Leave after a save. */
  done: []
  /** Leave without changing anything; a claim under way carries on. */
  close: []
}>()

const failure = computed(() => (props.claim.kind === 'failed' ? failureView(props.claim.reason) : null))
const character = computed(() => props.session?.character ?? null)
</script>

<template>
  <div class="claim stack">
    <template v-if="claim.kind === 'claimed'">
      <div class="notice leaf done" role="status">
        <MemberBadge v-if="claim.character" :look="claim.character.look" :member-id="claim.character.memberId" :size="52" />
        <div class="grow">
          <strong>Saved. {{ claim.character ? claim.character.displayName : 'Your character' }} now belongs to your account.</strong>
          <div>Sign in to come back to this character, here or on another device.</div>
        </div>
      </div>
      <button class="btn primary block" type="button" @click="emit('done')">Back to the world</button>
    </template>

    <GuestConflict
      v-else-if="claim.kind === 'conflict'" :existing="claim.existing" :guest="character" :guest-after-switch="claim.guestAfterSwitch" :busy="busy"
      @use-saved="emit('useSaved')" @keep-guest="emit('keepGuest')"
    />

    <p v-else-if="!session" class="notice">You are not playing as a guest, so there is nothing to save here.</p>

    <template v-else>
      <div v-if="character" class="card who">
        <MemberBadge :look="character.look" :member-id="character.memberId" :size="52" />
        <span class="grow"><strong class="name">{{ character.displayName }}</strong><span class="chip amber">Guest, this device</span></span>
      </div>
      <p v-if="!session.persisted" class="notice amber" role="status">{{ NOT_PERSISTED }}</p>

      <template v-if="claim.kind === 'signing-in' && access?.existing">
        <p>Signed in on this device as <strong class="email">{{ access.existing }}</strong>. Save this character to that account?</p>
        <p v-if="access.error" class="notice coral" role="alert">{{ access.error.message }}</p>
        <div v-if="access.pending" class="notice sky" role="status"><span class="pulse" aria-hidden="true"></span><strong class="grow">Checking the account…</strong></div>
        <button class="btn primary block named" type="button" :aria-disabled="access.pending || undefined" @click="!access.pending && emit('continueAs')">Continue as {{ access.existing }}</button>
        <button class="btn block" type="button" :disabled="access.pending" @click="emit('useAnother')">Use another account</button>
        <button class="btn ghost block" type="button" @click="emit('cancel')">Cancel</button>
      </template>

      <template v-else-if="claim.kind === 'signing-in' && access">
        <p class="small">Sign in, or create an account, and this character becomes that account’s. Nothing is moved until the world has checked the account.</p>
        <AccountAccess :pending="access.pending" :error="access.error" :password-policy="passwordPolicy" @submit="emit('access', $event)" @cancel="emit('cancel')" />
      </template>

      <template v-else-if="claim.kind === 'signing-in'">
        <div class="notice sky" role="status"><span class="pulse" aria-hidden="true"></span><div class="grow"><strong>Checking for your account…</strong><div>Nothing is moved until you have signed in.</div></div></div>
        <button class="btn block" type="button" @click="emit('cancel')">Cancel</button>
      </template>

      <template v-else-if="claim.kind === 'claiming'">
        <!-- No way to dismiss this for the few seconds it takes: once sent, a save cannot be called back. -->
        <div class="notice sky" role="status"><span class="pulse" aria-hidden="true"></span><div class="grow"><strong>Saving your character…</strong><div>It becomes your account’s in one step, or not at all. Once sent it cannot be called back, so wait for the answer.</div></div></div>
      </template>

      <!-- Sent, and no definite answer: it may already belong to the account. Never said to be undone. -->
      <template v-else-if="claim.kind === 'failed' && uncertain">
        <div class="notice amber" role="alert"><div class="grow"><strong>Your save may have gone through</strong><div>{{ claim.message }}</div></div></div>
        <button class="btn primary block" type="button" @click="emit('retry')">Check with the same account</button>
        <button class="btn ghost block" type="button" @click="emit('close')">Close for now</button>
      </template>

      <template v-else-if="claim.kind === 'failed' && failure && claim.reason !== 'sign-in-unavailable'">
        <div class="notice coral" role="alert"><div class="grow"><strong>{{ failure.title }}</strong><div>{{ failure.advice }}</div><div v-if="claim.message" class="detail">{{ claim.message }}</div></div></div>
        <button v-if="failure.next === 'retry'" class="btn primary block" type="button" @click="emit('retry')">Try again</button>
        <button v-else class="btn primary block" type="button" @click="emit('close')">Keep playing as guest</button>
        <button v-if="failure.next === 'retry'" class="btn ghost block" type="button" @click="emit('close')">Keep playing as guest</button>
      </template>

      <template v-else-if="session.signIn === 'unavailable' || claim.kind === 'failed'">
        <p class="notice amber">Saving to an account is not available on this playtest yet. Your guest character stays on this device.</p>
        <button class="btn primary block" type="button" @click="emit('close')">Keep playing</button>
      </template>

      <template v-else>
        <p v-if="uncertain" class="notice amber" role="status">Your last save may have gone through. Save again with the same account to find out; a character is never saved twice.</p>
        <p v-if="!character" class="notice">Make your character first; then it can be saved.</p>
        <p class="small">Sign in, or create an account with an email and a password, and this character becomes yours to keep.</p>
        <button class="btn primary block" type="button" :disabled="!character" @click="emit('save')">Save my character</button>
      </template>

      <details v-if="claim.kind === 'idle' || claim.kind === 'failed'" class="disclosure">
        <summary>What stays, what is kept, and the limits</summary>
        <GuestKeeps :ends-at="session.status.endsAt" />
      </details>
    </template>
  </div>
</template>

<style scoped>
.who { display: flex; align-items: center; gap: 12px; }
.who .grow { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.name, .email { max-width: 100%; overflow-wrap: anywhere; }
.named { white-space: normal; overflow-wrap: anywhere; }
.done { align-items: center; }
.detail { margin-top: 4px; font-size: 0.82rem; opacity: 0.85; overflow-wrap: anywhere; }
.pulse { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--sky); animation: blink 1s ease infinite; flex: none; }
@keyframes blink { 50% { opacity: 0.3; } }
</style>
