<script setup lang="ts">
// The account that signed in already has a character. Both are shown; the visitor picks one of the
// two choices the service offers. Nothing is merged and nothing is overwritten, and the window says so.
import type { SavedCharacter } from '../../shared/guest.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import ConfirmAction from '../people/ConfirmAction.vue'
import type { GuestCharacter } from './guestView.ts'

defineProps<{
  /** The character the account already owns. */
  existing: SavedCharacter
  /** The guest character being played now. */
  guest: GuestCharacter | null
  /** Whether this browser keeps the guest session if the visitor takes the saved character. */
  guestAfterSwitch: 'kept' | 'ended'
  /** The choice being applied. */
  busy?: 'use-saved' | 'keep-guest' | null
}>()
const emit = defineEmits<{ useSaved: []; keepGuest: [] }>()
</script>

<template>
  <div class="conflict stack">
    <div>
      <h2 id="guest-conflict-title">Your account already has a character</h2>
      <p class="muted small">They stay separate. Coins and progress are not combined, and neither character is changed.</p>
    </div>

    <ul class="pair" aria-labelledby="guest-conflict-title">
      <li class="card who">
        <MemberBadge :look="existing.look" :member-id="existing.memberId" :size="52" />
        <span class="grow"><span class="chip leaf">Saved to your account</span><strong class="name">{{ existing.displayName }}</strong><span v-if="!existing.onboarded" class="muted small">Not set up yet</span></span>
      </li>
      <li v-if="guest" class="card who">
        <MemberBadge :look="guest.look" :member-id="guest.memberId" :size="52" />
        <span class="grow"><span class="chip amber">Guest, this device</span><strong class="name">{{ guest.displayName }}</strong></span>
      </li>
    </ul>

    <p class="small">
      <template v-if="guestAfterSwitch === 'kept'">If you use the saved character, the guest one is not moved to your account. It stays a guest on this device until its session ends.</template>
      <template v-else>If you use the saved character, the guest one is left behind and cannot be reopened.</template>
    </p>

    <div class="choices">
      <ConfirmAction
        v-if="guestAfterSwitch === 'ended'" :label="busy === 'use-saved' ? 'Switching…' : 'Use my saved character'" button-class="primary block" tone="amber"
        :question="`Switch to ${existing.displayName}? ${guest ? guest.displayName : 'Your guest character'} and what it earned will be left behind for good.`"
        confirm-label="Switch" cancel-label="Stay a guest" :busy="Boolean(busy)" @confirm="emit('useSaved')"
      />
      <button v-else class="btn primary block" type="button" :disabled="Boolean(busy)" :aria-busy="busy === 'use-saved'" @click="emit('useSaved')">{{ busy === 'use-saved' ? 'Switching…' : 'Use my saved character' }}</button>
      <button class="btn block" type="button" :disabled="Boolean(busy)" :aria-busy="busy === 'keep-guest'" @click="emit('keepGuest')">Keep playing as guest</button>
    </div>
  </div>
</template>

<style scoped>
.pair { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 10px; }
.who { display: flex; align-items: center; gap: 12px; min-width: 0; }
.who .grow { display: flex; flex-direction: column; align-items: flex-start; gap: 4px; }
.name { max-width: 100%; overflow-wrap: anywhere; }
.choices { display: grid; gap: 8px; }
.choices :deep(.confirm) { display: flex; }
.choices :deep(.confirm > .btn) { width: 100%; }
</style>
