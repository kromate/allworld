<script setup lang="ts">
// A guest character moved here from the world's old address. This screen asks before anything is
// written on this device, and says plainly what would be replaced. It shows only what the service
// said about the character (when it started); there is no name, look or face here to show.
import { computed, nextTick, ref, watch } from 'vue'
import { brand } from '../../brand.ts'
import BrandMark from '../../ui/BrandMark.vue'
import { claimRecovery } from '../../state/app.ts'

const props = defineProps<{
  stage: 'receiving' | 'confirm' | 'opening' | 'failed'
  /** What this device already holds that the moved character would replace. */
  replaces: { guest: boolean; account: boolean }
  /** This device changed while the question was open: it is being asked again about what is here now. */
  changed?: boolean
  startedAt: string | null
  message: string
  /** The old address. It may not be working, so it is offered without a promise. */
  retryFrom: string | null
}>()
const emit = defineEmits<{ confirm: []; leave: [] }>()

// Replacing a guest whose save may have gone through (this device keeps a note of it across reloads)
// takes away this browser's way to check that save, so the question says so before the choice.
const unfinishedSave = computed(() => props.replaces.guest && claimRecovery() !== null)
const replacing = computed(() => props.replaces.guest || props.replaces.account)
const started = computed(() => {
  const at = props.startedAt ? Date.parse(props.startedAt) : NaN
  return Number.isFinite(at) ? new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }) : ''
})
const title = ref<HTMLElement | null>(null)
// Each step is announced from its heading, so a screen reader hears what changed.
watch(() => props.stage, () => { void nextTick(() => title.value?.focus()) }, { immediate: true })
</script>

<template>
  <main class="transfer" :aria-busy="stage === 'receiving' || stage === 'opening'">
    <div class="transfer-card stack">
      <BrandMark :size="52" />
      <template v-if="stage === 'receiving'">
        <h1 ref="title" tabindex="-1">Bringing your character over…</h1>
        <p class="muted" role="status">This takes a moment. Nothing is saved on this device until you choose.</p>
      </template>

      <template v-else-if="stage === 'confirm'">
        <h1 ref="title" tabindex="-1">Continue with this character?</h1>
        <p v-if="changed" class="notice sky" role="status">Something changed on this device while you were deciding, in another tab or window. Nothing was saved. Check the question again before you choose.</p>
        <p>A guest character from the old {{ brand.name }} address is ready to play here<template v-if="started">. It was started on {{ started }}</template>.</p>
        <p v-if="replaces.guest" class="notice amber">This device already has a different guest character. If you continue, this browser opens the moved character instead and can no longer reopen the other one here, unless it was saved to an account.</p>
        <p v-if="unfinishedSave" class="notice coral">The guest character on this device has a save that may already have gone through to an account. If you replace it, this browser can no longer check that save. If it went through, the character is kept with that account and opens when you sign in; if it did not, it can no longer be reopened here.</p>
        <p v-if="replaces.account" class="notice amber">This device is set to open your account. Continuing plays the moved guest character instead. Your account is not changed and is not signed out; you can open it again later by signing in.</p>
        <p class="small muted">Nothing is saved on this device until you continue. Moving a character does not sign you in or save it to an account.</p>
        <button class="btn primary block" type="button" @click="emit('confirm')">{{ replacing ? 'Replace and continue with this character' : 'Continue with this character' }}</button>
        <button class="btn block" type="button" @click="emit('leave')">{{ replacing ? 'Keep what this device has' : 'Not now' }}</button>
        <p class="small muted">If you do not continue, nothing changes here. The world still keeps the character, and the browser you came from still holds access to it.</p>
      </template>

      <template v-else-if="stage === 'opening'">
        <h1 ref="title" tabindex="-1">Opening your character…</h1>
        <p class="muted" role="status">Wait a moment.</p>
      </template>

      <template v-else>
        <h1 ref="title" tabindex="-1">The character was not moved</h1>
        <p class="notice coral" role="alert">{{ message }}</p>
        <button class="btn primary block" type="button" @click="emit('leave')">Continue to {{ brand.name }}</button>
        <p v-if="retryFrom" class="small muted">The old address is <a :href="retryFrom" rel="noreferrer">{{ retryFrom }}</a>. It may not be working right now.</p>
      </template>
    </div>
  </main>
</template>

<style scoped>
.transfer { height: 100%; display: grid; place-items: center; padding: 20px; background: var(--bg); }
.transfer-card { width: 100%; max-width: 460px; padding: 28px; border-radius: 24px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-lg); }
h1 { margin: 0; font-size: 1.4rem; overflow-wrap: anywhere; }
h1:focus { outline: none; }
@media (max-width: 420px) { .transfer { padding: 12px; } .transfer-card { padding: 20px; } }
</style>
