<script setup lang="ts">
// The first screen for a visitor with no account in hand: play now, save later. It asks for
// nothing, except on a private playtest host, where the pass that host issued is the way in.
// Signing in is offered quietly to someone who already saved a character, and only where this page can start it.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { brand } from '../../brand.ts'
import BrandMark from '../../ui/BrandMark.vue'
import GuestKeeps from './GuestKeeps.vue'
import { GUEST_KEPT_LINE } from './guestView.ts'
import type { GuestEnded, GuestSignIn } from './guestView.ts'
import { readPlaytestFragment, withoutPlaytestFragment } from './playtestInvite.ts'
import type { PlaytestPass } from './playtestInvite.ts'

const props = defineProps<{
  signIn: GuestSignIn
  /** From the host's configuration: 'pass' on a private playtest, where a guest needs one to enter. */
  admission?: 'open' | 'pass'
  /** The guest session is being requested. */
  pending?: boolean
  /** Account sign-in is opening. */
  signingIn?: boolean
  /** The service's or the platform's own sentence when starting failed. */
  problem?: string
  /** An earlier guest session in this browser can no longer be opened. */
  ended?: GuestEnded | null
  /** This browser still holds a guest session: Play reopens that character, and no pass is asked for again. */
  returning?: boolean
}>()
const emit = defineEmits<{
  /** `pass` is present only on a private playtest: the one typed, or the one a shared link carried. It is handed on and kept nowhere but this screen's memory. */
  play: [pass?: string]
  signIn: []
  cancelSignIn: []
}>()

const router = useRouter()
const pass = ref('')
const needsPass = computed(() => props.admission === 'pass' && !props.returning)
const waiting = computed(() => Boolean(props.pending || props.signingIn))
// Whether this host can save a guest to an account, and whether this browser can keep the session, are not known until the session opens, so nothing is promised here:
// the chip and the guest details say what holds once the visitor is in. `signIn` is only whether Allworld sign-in exists in this page, which the button below answers.
const PLAY_LINE = 'No account needed. Start playing now.'
// Allworld is a game drawn on real maps. Playing a place is not being there, and a guest shares nothing about where they are.
const WORLD_LINE = 'A game world on real maps. Explore streets, travel, work and play from wherever you are. Your exact real-world location is never saved or shown to other players.'
// `signIn` decides whether this page may point at signing in; a refused session says so only where that is true.
const endedLine = (kind: GuestEnded): string => kind === 'expired'
  ? 'Your guest character has expired. The guest session on this device ran out before it was saved, so that character cannot be reopened by anyone.'
  : `Your guest character can no longer be opened here: the world ended or refused its guest session.${props.signIn === 'available' ? ' If you saved that character to an account, sign in to open it.' : ''}`

// ── The invitation in a shared link ──
// A private playtest link can carry the pass as `#playtest=…`. It is read once as text, held in
// this component only, and taken out of the address. It is an invitation to this test world, not a
// sign-in: nothing is sent until Play is pressed, the service decides, and a guest character this
// browser already holds is continued without it (`needsPass` is false for one).
const INVITE_FOUND = 'Your link carries a playtest invitation. It is used when you press play, and the world checks it then. It is not an account.'
const INVITE_FAILED = 'The invitation from your link did not get you in. You can try again, or enter a different pass.'
const LINK_BROKEN = 'The invitation in your link is incomplete, so it was not used. Enter the pass you were given.'
/** The one place the invitation is held. Cleared when this screen goes away. */
const invite = ref<PlaytestPass | null>(null)
const linkBroken = ref(false)
/** The masked field is showing, by choice or because there is no invitation. */
const typing = ref(true)
const inviteTried = ref(false)
const field = ref<HTMLInputElement | null>(null)
const start = ref<HTMLButtonElement | null>(null)
/** The invitation Play would send. Null while the field is showing, and for anyone who needs no pass. */
const offered = computed(() => (needsPass.value && !typing.value ? invite.value : null))
const inviteFailed = computed(() => inviteTried.value && !props.pending && Boolean(props.problem))
const canPlay = computed(() => !waiting.value && (!needsPass.value || offered.value !== null || pass.value.trim().length > 0))

// The router keeps the whole address, fragment included, in its history state and in memory, and
// writes both back on its next push; a bare history.replaceState is undone by that. So the fragment
// is taken out through the router, which replaces the same history entry: same page, same query,
// no reload, nothing added to history.
function forgetFragment(): void {
  // The address as the router holds it, whether or not its first navigation has finished.
  const here = router.options.history.location
  const clean = withoutPlaytestFragment(here)
  if (clean !== here) void router.replace(clean).catch(() => undefined)
}

/** Reads an address fragment, takes a recognized one out of the address, and (only when idle and
 * needing a pass) holds it. A returning guest, or a start already in flight, keeps what it has: the
 * fragment is dropped unused. Anything that is not a playtest fragment is left alone. */
function takeFragment(hash: string): void {
  if (props.admission !== 'pass') return
  const found = readPlaytestFragment(hash)
  if (found.kind === 'none') return
  forgetFragment()
  if (props.returning || waiting.value) return
  inviteTried.value = false
  if (found.kind === 'invite') {
    invite.value = found.pass
    linkBroken.value = false
    typing.value = false
    pass.value = ''
  } else {
    invite.value = null
    linkBroken.value = true
    typing.value = true
  }
}
// The first read is of the address itself, since the router's first navigation may not be done. When
// it finishes it reports that same fragment once more; that one is not a new invitation.
const first = window.location.hash
let echo: string | null = readPlaytestFragment(first).kind === 'none' ? null : first
takeFragment(first)
// A link opened later in this same page (route or native hash change) is noticed without a reload.
// Stripping it makes the hash empty, which reads as 'none', so the watch cannot loop.
const stopWatching = watch(() => router.currentRoute.value.hash, (hash) => {
  if (echo !== null && hash === echo) { echo = null; forgetFragment(); return }
  echo = null
  takeFragment(hash)
})
onBeforeUnmount(() => { stopWatching(); invite.value = null; pass.value = ''; linkBroken.value = false })

async function typeInstead(): Promise<void> {
  typing.value = true
  inviteTried.value = false
  await nextTick()
  field.value?.focus()
}
async function useInvite(): Promise<void> {
  typing.value = false
  pass.value = ''
  await nextTick()
  start.value?.focus()
}

function play(): void {
  if (!canPlay.value) return
  if (!needsPass.value) { emit('play'); return }
  const fromLink = offered.value
  if (fromLink) { inviteTried.value = true; emit('play', fromLink) }
  else emit('play', pass.value.trim())
}
</script>

<template>
  <main class="welcome">
    <form class="welcome-card" @submit.prevent="play">
      <BrandMark :size="52" />
      <div class="stack tight">
        <h1>{{ brand.name }}</h1>
        <p class="muted">{{ WORLD_LINE }}</p>
      </div>

      <p v-if="ended" class="notice amber" role="alert">{{ endedLine(ended) }}</p>
      <p v-else-if="returning" class="notice leaf" role="status">{{ GUEST_KEPT_LINE }}</p>

      <template v-if="needsPass">
        <p v-if="offered" class="notice sky" role="status">{{ inviteFailed ? INVITE_FAILED : INVITE_FOUND }}</p>
        <template v-else>
          <p v-if="linkBroken" class="notice amber" role="status">{{ LINK_BROKEN }}</p>
          <label class="field">
            <span>Playtest pass</span>
            <input ref="field" v-model="pass" class="input" type="password" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" maxlength="200" :disabled="waiting" />
            <small>This is a private playtest. Enter the pass you were given; it is checked once and is not an account.</small>
          </label>
        </template>
      </template>

      <div class="stack tight play">
        <button ref="start" class="btn primary block start" type="submit" :disabled="!canPlay" :aria-busy="pending">
          {{ pending ? 'Starting…' : returning ? 'Continue as my guest character' : ended ? 'Play as a new guest' : 'Play as guest' }}
        </button>
        <p class="muted small">{{ PLAY_LINE }}</p>
        <p v-if="pending" class="sr-only" role="status">Opening your world…</p>
      </div>

      <p v-if="problem" class="notice coral" role="alert">{{ problem }}</p>

      <template v-if="needsPass && invite">
        <button v-if="offered" class="btn ghost block" type="button" :disabled="waiting" @click="typeInstead">Enter a different pass</button>
        <button v-else class="btn ghost block" type="button" :disabled="waiting" @click="useInvite">Use the invitation from my link instead</button>
      </template>

      <template v-if="signIn === 'available'">
        <button v-if="signingIn" class="btn ghost block" type="button" @click="emit('cancelSignIn')">Waiting for sign-in… Cancel</button>
        <button v-else class="btn ghost block" type="button" :disabled="waiting" @click="emit('signIn')">I saved a character — sign in</button>
      </template>

      <details class="disclosure">
        <summary>What is kept if I play as a guest?</summary>
        <GuestKeeps />
      </details>
    </form>
  </main>
</template>

<style scoped>
/* A whole screen of its own, before the world exists; it scrolls when the disclosure is open. */
.welcome { position: fixed; inset: 0; z-index: 40; overflow-y: auto; display: flex; padding: clamp(12px, 4vw, 40px); background: radial-gradient(90% 70% at 15% 0%, #ffe9b8, transparent 60%), radial-gradient(70% 60% at 100% 10%, #cfe8fb, transparent 60%), var(--bg); }
.welcome-card { width: min(460px, 100%); margin: auto; display: grid; gap: 14px; padding: clamp(18px, 5vw, 28px); border-radius: 24px; background: var(--surface); border: 1px solid var(--line); box-shadow: var(--shadow-lg); }
.play { text-align: center; }
.start { min-height: 52px; font-size: 1.05rem; }
/* The sign-in line is a sentence; it wraps on a narrow screen instead of pushing the card wider. */
.btn.ghost { white-space: normal; min-height: 44px; padding-block: 8px; }
</style>
