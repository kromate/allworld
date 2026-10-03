<script lang="ts">
export type AccountMode = 'signin' | 'create'

/** What the form hands to its caller. The password is the exact text typed; only the email is trimmed. */
export interface AccountCredentials {
  mode: AccountMode
  email: string
  password: string
}

/** A failure the caller wants shown. `field` moves focus to that field and marks it invalid. */
export interface AccountFormError {
  message: string
  field?: 'email' | 'password'
}

/** The caller's real password policy, used only when creating an account. The service stays the authority. */
export interface AccountPasswordPolicy {
  minLength?: number
  hint?: string
}
</script>

<script setup lang="ts">
// Email and password access: create an account or sign in. This window only collects and hands over
// values. It never calls a provider, decides whether a credential is good, stores or logs a password.
// The caller sets `pending` while its request runs, and `error` when the request fails. Pending ending
// with no error is read as success and wipes the password; an error keeps both fields so a retry costs
// nothing. The inputs are left uncontrolled and read when the form is submitted, so a password
// manager's autofill is never missed and no password sits in reactive state.
import { createGoogleButton } from './googleIdentity.ts'
import type { GoogleCredentialCollector, GooglePreparedAttempt } from '../../platform/account.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'

const props = withDefaults(defineProps<{
  /** The caller's request is under way: submitting and switching are blocked, cancel stays available. */
  googlePrepare?: (signal: AbortSignal) => Promise<GooglePreparedAttempt>
  googleSignIn?: (collect: GoogleCredentialCollector, prepared?: GooglePreparedAttempt) => Promise<void>
  pending?: boolean
  /** Set in the same update that clears `pending`, or the form reads the end of the request as success. */
  error?: AccountFormError | null
  passwordPolicy?: AccountPasswordPolicy
  /** Only the first value is used. */
  initialEmail?: string
  /** Show the Cancel button. */
  cancelable?: boolean
}>(), { pending: false, error: null, passwordPolicy: undefined, initialEmail: '', cancelable: true })

const emit = defineEmits<{
  submit: [credentials: AccountCredentials]
  /** Nothing was sent, or the caller should abandon the request under way. */
  cancel: []
}>()

/** `v-model:mode`. Works without a parent binding too. */
const mode = defineModel<AccountMode>('mode', { default: 'signin' })

const MODES: { id: AccountMode; label: string }[] = [
  { id: 'signin', label: 'Sign in' },
  { id: 'create', label: 'Create account' },
]

const uid = useId()
const ids = computed(() => ({ email: `${uid}-email`, password: `${uid}-password`, emailNote: `${uid}-email-note`, passwordNote: `${uid}-password-note`, hint: `${uid}-hint` }))

const emailEl = ref<HTMLInputElement | null>(null)
const passwordEl = ref<HTMLInputElement | null>(null)
const emailDraft = ref(props.initialEmail)
const reveal = ref(false)
const googlePhase = ref<'idle' | 'loading' | 'ready' | 'active' | 'failed'>('idle')
const googleBusy = computed(() => googlePhase.value === 'active')
const googleHost = ref<HTMLElement | null>(null)
let googleButton: ReturnType<typeof createGoogleButton> | null = null
let offGoogleFocus: (() => void) | null = null
function retryGoogle(): void { googleButton?.retry() }
onMounted(() => {
  googleButton = createGoogleButton({
    host: () => googleHost.value,
    foreground: () => document.visibilityState === 'visible' && document.hasFocus(),
    enabled: () => Boolean(props.googleSignIn && props.googlePrepare && (!props.pending || googleBusy.value)),
    prepare: signal => {
      if (!props.googlePrepare) return Promise.reject(new Error('Google is not available.'))
      return props.googlePrepare(signal)
    },
    async signIn(collect, prepared) {
      if (!props.googleSignIn) throw new Error('Google is not available.')
      await props.googleSignIn(collect, prepared)
      await nextTick()
      if (props.error) throw new Error('Google sign-in did not finish.')
    },
    present: phase => { googlePhase.value = phase },
    onChoose: () => { wipe(); fieldErrors.value = {}; errorHidden.value = true },
  })
  const focus = (): void => googleButton?.foregroundChanged()
  window.addEventListener('focus', focus); window.addEventListener('blur', focus); document.addEventListener('visibilitychange', focus)
  offGoogleFocus = () => { window.removeEventListener('focus', focus); window.removeEventListener('blur', focus); document.removeEventListener('visibilitychange', focus) }
  googleButton.start()
})
watch(() => [props.googleSignIn, props.googlePrepare, props.pending], () => { void nextTick(() => googleButton?.foregroundChanged()) })
const fieldErrors = ref<{ email?: string; password?: string }>({})
const errorHidden = ref(false)
let latched = false

const creating = computed(() => mode.value === 'create')
const minLength = computed(() => (creating.value ? props.passwordPolicy?.minLength : undefined))
const hint = computed(() => (creating.value ? props.passwordPolicy?.hint : undefined))
const shownError = computed(() => (props.pending || errorHidden.value ? null : props.error))
const emailMessage = computed(() => fieldErrors.value.email ?? (shownError.value?.field === 'email' ? shownError.value.message : ''))
const passwordMessage = computed(() => fieldErrors.value.password ?? (shownError.value?.field === 'password' ? shownError.value.message : ''))
// A field message is already beside its field; the banner carries only what belongs to no field.
const bannerMessage = computed(() => (shownError.value && !shownError.value.field ? shownError.value.message : ''))
const passwordNotes = computed(() => [passwordMessage.value && ids.value.passwordNote, hint.value && ids.value.hint].filter(Boolean).join(' ') || undefined)

// A bound `value` is written back on every render and would undo what the person typed, so the carried
// email is set once, when a form's input first appears.
watch(emailEl, input => { if (input) input.value = emailDraft.value }, { flush: 'sync' })

function wipe() {
  if (passwordEl.value) passwordEl.value.value = ''
  reveal.value = false
}

function check(email: string, password: string) {
  const found: { email?: string; password?: string } = {}
  if (!email) found.email = 'Enter your email address.'
  else if (!/^[^\s@]+@[^\s@]+$/.test(email)) found.email = 'Enter an email address like name@example.com.'
  if (!password) found.password = creating.value ? 'Choose a password.' : 'Enter your password.'
  else if (minLength.value && [...password].length < minLength.value) found.password = `Use at least ${minLength.value} characters.`
  return found
}

function submit() {
  if (props.pending || googleBusy.value || latched) return
  const email = emailEl.value?.value.trim() ?? ''
  const password = passwordEl.value?.value ?? ''
  const found = check(email, password)
  fieldErrors.value = found
  errorHidden.value = true
  const first = found.email ? emailEl.value : found.password ? passwordEl.value : null
  if (first) { first.focus(); return }
  // Held until the caller's `pending` has rendered, so a second Enter in the same moment sends nothing.
  latched = true
  googleButton?.pauseIdle()
  emit('submit', { mode: mode.value, email, password })
  void nextTick(() => { latched = false })
}

function choose(next: AccountMode) {
  if (props.pending || googleBusy.value || next === mode.value) return
  mode.value = next
}

function cancel() {
  googleButton?.cancel()
  wipe()
  fieldErrors.value = {}
  emit('cancel')
}

/** Typing answers an old message; it should not stay behind. */
function edited() {
  errorHidden.value = true
  fieldErrors.value = {}
}

// Switching mode rebuilds the form (the password manager sees a fresh sign-in or sign-up form). The
// email is carried over; the password and any old message are not. Runs before the old inputs go.
watch(mode, () => {
  emailDraft.value = emailEl.value?.value ?? emailDraft.value
  wipe()
  fieldErrors.value = {}
  errorHidden.value = true
}, { flush: 'sync' })

watch(() => props.error, error => { if (error) errorHidden.value = false })

watch(() => props.pending, (now, was) => {
  if (now || !was) return
  if (!props.error) { wipe(); return }
  errorHidden.value = false
  const field = props.error.field
  if (field) void nextTick(() => (field === 'email' ? emailEl.value : passwordEl.value)?.focus())
})

onBeforeUnmount(() => { offGoogleFocus?.(); googleButton?.dispose(); wipe() })
defineExpose({ /** Wipe the password now, for a caller that learns of success another way. */ clear: wipe })
</script>

<template>
  <div class="access stack" :aria-busy="pending">
    <div class="tabs" role="group" aria-label="Account action">
      <button
        v-for="option in MODES" :key="option.id" class="tab" type="button"
        :aria-pressed="mode === option.id" :aria-disabled="pending || googleBusy || undefined" @click="choose(option.id)"
      >{{ option.label }}</button>
    </div>

    <form :key="mode" class="stack" method="post" novalidate :aria-label="creating ? 'Create account' : 'Sign in'" @submit.prevent="submit">
      <div class="field">
        <label class="label" :for="ids.email">Email</label>
        <input
          :id="ids.email" ref="emailEl" class="input" type="email" name="email" required
          :autocomplete="creating ? 'email' : 'username'" autocapitalize="off" autocorrect="off" spellcheck="false"
          :readonly="pending || googleBusy" :aria-invalid="emailMessage ? 'true' : undefined"
          :aria-describedby="emailMessage ? ids.emailNote : undefined" @input="edited"
        >
        <small v-if="emailMessage" :id="ids.emailNote" class="problem">{{ emailMessage }}</small>
      </div>

      <div class="field">
        <label class="label" :for="ids.password">Password</label>
        <div class="row">
          <input
            :id="ids.password" ref="passwordEl" class="input grow" :type="reveal ? 'text' : 'password'" name="password" required
            :autocomplete="creating ? 'new-password' : 'current-password'" autocapitalize="off" autocorrect="off" spellcheck="false"
            :readonly="pending || googleBusy" :aria-invalid="passwordMessage ? 'true' : undefined" :aria-describedby="passwordNotes" @input="edited"
          >
          <button
            class="btn sm reveal" type="button" :aria-controls="ids.password"
            :aria-label="reveal ? 'Hide password' : 'Show password'" @click="reveal = !reveal"
          >{{ reveal ? 'Hide' : 'Show' }}</button>
        </div>
        <small v-if="passwordMessage" :id="ids.passwordNote" class="problem">{{ passwordMessage }}</small>
        <small v-if="hint" :id="ids.hint">{{ hint }}</small>
      </div>

      <p v-if="bannerMessage" class="notice coral" role="alert">{{ bannerMessage }}</p>
      <div v-if="pending" class="notice sky" role="status">
        <span class="pulse" aria-hidden="true"></span>
        <strong class="grow">{{ creating ? 'Creating your account…' : 'Signing you in…' }}</strong>
      </div>

      <button class="btn primary block" type="submit" :aria-disabled="pending || googleBusy || undefined">{{ creating ? 'Create account' : 'Sign in' }}</button>
    </form>
    <section v-if="googleSignIn && googlePrepare" class="google-section stack" aria-label="Google sign-in">
      <div class="google-divider" aria-hidden="true"><span>or</span></div>
      <div ref="googleHost" class="google-host" :class="{ 'google-active': googleBusy }" @keydown.stop @keyup.stop></div>
      <p v-if="googlePhase === 'loading'" class="google-note" role="status">Loading Google…</p>
      <p v-else-if="googleBusy" class="google-note" role="status">Complete sign-in in Google. You can cancel below.</p>
      <template v-else-if="googlePhase === 'failed'">
        <p class="google-note" role="status">Google is unavailable right now. Use your password or try again.</p>
        <button class="btn ghost block" type="button" :disabled="pending" @click="retryGoogle">Try loading Google again</button>
      </template>
    </section>
    <button v-if="cancelable" class="btn ghost block" type="button" @click="cancel">Cancel</button>
  </div>
</template>

<style scoped>
.google-section { min-width: 0; gap: .65rem; }
.google-divider { display: flex; align-items: center; gap: .75rem; color: var(--muted); font-size: .85rem; }
.google-divider::before, .google-divider::after { content: ''; flex: 1; height: 1px; background: var(--line, #d7d0c4); }
.google-host { display: flex; justify-content: center; min-height: 44px; width: 100%; min-width: 0; max-width: 100%; }
.google-active { pointer-events: none; }
.google-note { margin: 0; color: var(--muted); font-size: .85rem; line-height: 1.4; }
.access { max-width: 100%; }
.tab[aria-pressed="true"] { background: var(--surface); color: var(--ink); box-shadow: 0 1px 3px rgba(40, 30, 10, 0.12); }
.tab[aria-disabled="true"], .btn[aria-disabled="true"] { opacity: 0.5; cursor: not-allowed; }
.input { min-width: 0; }
.input[aria-invalid="true"] { border-color: var(--danger); }
.input[readonly] { background: var(--surface-2); color: var(--muted); }
.reveal { flex: none; min-width: 64px; }
.problem { color: var(--danger); font-weight: 650; }
.pulse { width: 8px; height: 8px; margin-top: 6px; border-radius: 50%; background: var(--sky); animation: blink 1s ease infinite; flex: none; }
@keyframes blink { 50% { opacity: 0.3; } }
</style>
