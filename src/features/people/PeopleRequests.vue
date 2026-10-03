<script setup lang="ts">
// Requests tab: introductions waiting for the viewer's answer, and the ones the viewer sent.
import { computed, ref } from 'vue'
import { WorldError } from '../../shared/model.ts'
import type { Introduction } from '../../shared/social.ts'
import { api, app, messageOf, toast } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { relativeTime } from '../../ui/format.ts'
import ConfirmAction from './ConfirmAction.vue'
import { nameList } from './labels.ts'

const props = defineProps<{
  incoming: Introduction[]
  outgoing: Introduction[]
  state: 'loading' | 'error' | 'ready'
  error: string
}>()
const emit = defineEmits<{ reload: [] }>()

const query = ref('')
const busy = ref<string | null>(null)
const bulk = ref(false)
const matches = (name: string): boolean => { const text = query.value.trim().toLowerCase(); return !text || name.toLowerCase().includes(text) }
const incomingShown = computed(() => props.incoming.filter(intro => matches(intro.from.displayName)))
const outgoingShown = computed(() => props.outgoing.filter(intro => matches(intro.to.displayName)))
const incomingNames = computed(() => nameList(incomingShown.value.map(intro => intro.from.displayName)))
const outgoingNames = computed(() => nameList(outgoingShown.value.map(intro => intro.to.displayName)))

/** Gone means it expired, was withdrawn or was already answered: nothing to do but show the fresh list. */
const gone = (cause: unknown): boolean => cause instanceof WorldError && (cause.code === 'expired' || cause.code === 'conflict' || cause.code === 'not_found')

async function respond(intro: Introduction, accept: boolean): Promise<void> {
  busy.value = intro.id
  try {
    await api('intro.respond', { introId: intro.id, accept })
    toast(accept ? `You and ${intro.from.displayName} are now friends.` : `You declined ${intro.from.displayName}’s introduction.`, 'good')
  } catch (cause) {
    toast(messageOf(cause), 'bad')
  } finally {
    busy.value = null
    emit('reload')
  }
}

async function respondAll(accept: boolean): Promise<void> {
  const targets = [...incomingShown.value]
  bulk.value = true
  const done: string[] = []
  let lapsed = 0
  let failure = ''
  for (const intro of targets) {
    try { await api('intro.respond', { introId: intro.id, accept }); done.push(intro.from.displayName) } catch (cause) {
      if (gone(cause)) lapsed++
      else { failure = messageOf(cause); break }
    }
  }
  bulk.value = false
  emit('reload')
  const parts: string[] = []
  if (done.length) parts.push(accept ? `You are now friends with ${nameList(done)}.` : `Declined ${nameList(done)}.`)
  if (lapsed) parts.push(lapsed === 1 ? 'One was no longer waiting.' : `${lapsed} were no longer waiting.`)
  if (failure) parts.push(`Stopped there: ${failure}`)
  if (parts.length) toast(parts.join(' '), failure ? 'bad' : 'good')
}

async function block(intro: Introduction): Promise<void> {
  busy.value = intro.id
  try {
    app.blocked = (await api('member.block', { memberId: intro.from.id })).blocked
    toast(`${intro.from.displayName} is blocked. Their introduction was withdrawn and you will not see or hear each other.`, 'good', {
      label: 'Unblock', run: () => { void api('member.unblock', { memberId: intro.from.id }).then(result => { app.blocked = result.blocked; toast(`${intro.from.displayName} is unblocked. The introduction stays withdrawn.`, 'info') }).catch(cause => toast(messageOf(cause), 'bad')) },
    })
  } catch (cause) {
    toast(messageOf(cause), 'bad')
  } finally {
    busy.value = null
    emit('reload')
  }
}

async function sendAgain(intro: Introduction): Promise<void> {
  try {
    await api('intro.send', { to: intro.to.id, note: intro.note })
    toast(`Introduction sent to ${intro.to.displayName} again.`, 'good')
  } catch (cause) {
    toast(messageOf(cause), 'bad')
  } finally {
    emit('reload')
  }
}

async function withdraw(intro: Introduction): Promise<void> {
  busy.value = intro.id
  try {
    await api('intro.withdraw', { introId: intro.id })
    toast(`Your introduction to ${intro.to.displayName} was withdrawn.`, 'good', { label: 'Undo', run: () => { void sendAgain(intro) } })
  } catch (cause) {
    toast(messageOf(cause), 'bad')
  } finally {
    busy.value = null
    emit('reload')
  }
}

async function withdrawAll(): Promise<void> {
  const targets = [...outgoingShown.value]
  bulk.value = true
  const done: string[] = []
  let failure = ''
  for (const intro of targets) {
    try { await api('intro.withdraw', { introId: intro.id }); done.push(intro.to.displayName) } catch (cause) {
      if (!gone(cause)) { failure = messageOf(cause); break }
    }
  }
  bulk.value = false
  emit('reload')
  if (failure) toast(`${done.length ? `Withdrew your introductions to ${nameList(done)}. ` : ''}Stopped there: ${failure}`, 'bad')
  else toast(done.length ? `Withdrew your introductions to ${nameList(done)}.` : 'Those introductions were no longer waiting.', 'good')
}
</script>

<template>
  <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="emit('reload')" />
  <StateView v-else-if="!incoming.length && !outgoing.length" state="empty" art="👋" title="No introductions waiting" message="When someone would like to connect, their introduction appears here. You become friends only when it is accepted.">
    <RouterLink class="btn primary sm" to="/people?tab=nearby">Find people nearby</RouterLink>
  </StateView>
  <div v-else class="stack loose">
    <input v-if="incoming.length + outgoing.length > 4" v-model="query" class="input" type="search" placeholder="Filter by name" aria-label="Filter introductions by name" />

    <section v-if="incoming.length" class="stack tight" aria-labelledby="requests-incoming">
      <div class="section-head"><h2 id="requests-incoming">Would like to connect</h2></div>
      <!-- Answering one by one is the main path; answering all at once waits behind a row. -->
      <details v-if="incomingShown.length > 1" class="fold">
        <summary>Answer all {{ incomingShown.length }} at once</summary>
        <div class="row wrap bulk" role="group" aria-label="Answer all introductions shown at once">
          <ConfirmAction
            label="Accept all shown" button-class="sm" confirm-class="primary" tone="leaf" :confirm-label="`Accept all ${incomingShown.length}`" cancel-label="Not now" :busy="bulk"
            :question="`Accept all ${incomingShown.length} introductions shown? You will become friends with ${incomingNames}.`"
            @confirm="respondAll(true)"
          />
          <ConfirmAction
            label="Decline all shown" button-class="sm" :confirm-label="`Decline all ${incomingShown.length}`" cancel-label="Not now" :busy="bulk"
            :question="`Decline all ${incomingShown.length} introductions shown? That is ${incomingNames}. A declined introduction cannot be brought back; they would need to send a new one.`"
            @confirm="respondAll(false)"
          />
        </div>
      </details>
      <ul v-if="incomingShown.length" class="plain-list">
        <li v-for="intro in incomingShown" :key="intro.id" class="card tint-amber stack tight">
          <div class="row top">
            <MemberBadge :member-id="intro.from.id" :look="intro.from.look" :size="44" :online="intro.from.online" />
            <div class="grow">
              <strong class="truncate block">{{ intro.from.displayName }}</strong>
              <span class="muted tiny block wrap-any">{{ intro.from.areaLabel ? `${intro.from.areaLabel} · ` : '' }}sent {{ relativeTime(intro.createdAt) }} · expires {{ relativeTime(intro.expiresAt) }}</span>
            </div>
          </div>
          <p v-if="intro.note" class="quote">{{ intro.note }}</p>
          <p v-if="intro.from.bio" class="small wrap-any"><span class="muted">About them:</span> {{ intro.from.bio }}</p>
          <div class="row wrap">
            <button class="btn primary sm" type="button" :disabled="bulk || busy === intro.id" :aria-label="`Accept ${intro.from.displayName}’s introduction`" @click="respond(intro, true)">Accept</button>
            <button class="btn sm" type="button" :disabled="bulk || busy === intro.id" :aria-label="`Decline ${intro.from.displayName}’s introduction`" @click="respond(intro, false)">Decline</button>
            <span class="grow"></span>
            <button class="btn sm ghost danger" type="button" :disabled="bulk || busy === intro.id" :aria-label="`Block ${intro.from.displayName}`" @click="block(intro)">Block</button>
          </div>
        </li>
      </ul>
      <p v-else class="muted small">No one who would like to connect matches that name.</p>
    </section>

    <section v-if="outgoing.length" class="stack tight" aria-labelledby="requests-outgoing">
      <div class="section-head">
        <h2 id="requests-outgoing">Sent by you</h2>
        <ConfirmAction
          v-if="outgoingShown.length > 1" label="Withdraw all shown" button-class="sm ghost" :confirm-label="`Withdraw all ${outgoingShown.length}`" cancel-label="Keep them" :busy="bulk"
          :question="`Withdraw your introductions to ${outgoingNames}? You can introduce yourself again later.`"
          @confirm="withdrawAll"
        />
      </div>
      <ul v-if="outgoingShown.length" class="plain-list">
        <li v-for="intro in outgoingShown" :key="intro.id" class="card stack tight">
          <div class="row top">
            <MemberBadge :member-id="intro.to.id" :look="intro.to.look" :size="40" :online="intro.to.online" />
            <div class="grow">
              <strong class="truncate block">{{ intro.to.displayName }}</strong>
              <span class="muted tiny block">Waiting for an answer · sent {{ relativeTime(intro.createdAt) }} · expires {{ relativeTime(intro.expiresAt) }}</span>
            </div>
            <button class="btn sm ghost" type="button" :disabled="bulk || busy === intro.id" :aria-label="`Withdraw your introduction to ${intro.to.displayName}`" @click="withdraw(intro)">Withdraw</button>
          </div>
          <p v-if="intro.note" class="quote">{{ intro.note }}</p>
        </li>
      </ul>
      <p v-else class="muted small">None of the introductions you sent matches that name.</p>
    </section>
  </div>
</template>

<style scoped>
.top { align-items: flex-start; }
.block { display: block; }
.bulk { gap: 8px; }
.fold > summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; font-size: 0.86rem; font-weight: 650; color: var(--accent-text); }
</style>
