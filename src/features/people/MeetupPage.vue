<script setup lang="ts">
// One meetup: the plan as it stands, who is coming, the viewer's answer, and the organiser's tools.
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { MeetupId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import type { Meetup } from '../../shared/social.ts'
import { api, app, messageOf, myId, onAccountReset, toast } from '../../state/app.ts'
import { walkToPlace, world } from '../../state/world.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { dateTimeIn, relativeTime } from '../../ui/format.ts'
import ConfirmAction from './ConfirmAction.vue'
import MeetupForm from './MeetupForm.vue'
import PersonRow from './PersonRow.vue'
import { ANSWER, MEETUP_STATUS, keepKeysInWindow, nameList, placeKind } from './labels.ts'
import { readsDifferently, viewerZone } from './zonedTime.ts'

const route = useRoute()
const router = useRouter()
const meetupId = String(route.params.id) as MeetupId
const BACK = '/people?tab=meetups'

/** `null` means the service says there is no such meetup for this member. */
const { data, state, error, reload } = useLoad<{ meetup: Meetup | null }>(async () => {
  try { return await api('meetup.get', { meetupId }) } catch (cause) {
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid')) return { meetup: null }
    throw cause
  }
}, [() => app.changed.meetups])

const me = myId()
let closed = false
const stopReset = onAccountReset(() => { closed = true })
onBeforeUnmount(() => { closed = true; stopReset() })
const current = (): boolean => !closed && myId() === me
/** A reply that arrives after the account changed belongs to the previous account: show nothing. */
const sameAccount = (): boolean => current()
const meetup = computed(() => data.value?.meetup ?? null)
const organising = computed(() => meetup.value?.organiser.id === me)
const mine = computed(() => meetup.value?.participants.find(entry => entry.member.id === me) ?? null)
const live = computed(() => meetup.value?.status === 'proposed' || meetup.value?.status === 'agreed')
const status = computed(() => (meetup.value ? MEETUP_STATUS[meetup.value.status] : null))
const style = computed(() => categoryStyle(meetup.value?.venue.category ?? ''))
const tint = computed(() => ({ proposed: 'tint-amber', agreed: 'tint-leaf', cancelled: 'tint-coral', past: '' })[meetup.value?.status ?? 'past'])
const ownZone = viewerZone()
const ownTime = computed(() => {
  const plan = meetup.value
  return plan && readsDifferently(Date.parse(plan.startsAt), plan.timezone, ownZone) ? dateTimeIn(plan.startsAt, ownZone) : ''
})
const waitingFor = computed(() => (meetup.value?.participants ?? []).filter(entry => entry.answer === 'invited' && entry.member.id !== me).map(entry => entry.member.displayName))

const busy = ref(false)
const revising = ref(false)
const heading = ref<HTMLElement | null>(null)
/** Set when an answer was refused because the organiser changed the plan in the meantime. */
const planMoved = ref('')

async function answer(accept: boolean): Promise<void> {
  const plan = meetup.value
  if (!plan) return
  busy.value = true
  planMoved.value = ''
  try {
    const result = await api('meetup.respond', { meetupId: plan.id, accept, revision: plan.revision })
    if (!sameAccount()) return
    data.value = result
    if (sameAccount()) toast(accept ? `You are coming. ${plan.organiser.displayName} was told.` : `${plan.organiser.displayName} was told you can’t come.`, 'good')
  } catch (cause) {
    if (!sameAccount()) return
    // conflict: the plan was revised or cancelled. expired: it has passed. Either way show it fresh.
    if (cause instanceof WorldError && (cause.code === 'conflict' || cause.code === 'expired')) {
      await reload()
      planMoved.value = messageOf(cause)
    } else toast(messageOf(cause), 'bad')
  } finally {
    busy.value = false
  }
}

async function cancelMeetup(): Promise<void> {
  const plan = meetup.value
  if (!plan) return
  busy.value = true
  try {
    const result = await api('meetup.cancel', { meetupId: plan.id })
    if (!sameAccount()) return
    data.value = result
    const names = plan.participants.map(entry => entry.member.displayName)
    if (sameAccount()) {
      toast(names.length ? `Meetup cancelled. ${nameList(names)} ${names.length === 1 ? 'was' : 'were'} told.` : 'Meetup cancelled.', 'good')
      await backToPlan()
    }
  } catch (cause) {
    if (!sameAccount()) return
    if (sameAccount()) toast(messageOf(cause), 'bad')
  } finally {
    busy.value = false
  }
}

/** The form or the organiser's tools are gone; keyboard focus goes back to the plan instead of the page. */
async function backToPlan(): Promise<void> {
  revising.value = false
  await nextTick()
  heading.value?.focus()
}

function revised(next: Meetup): void {
  if (!sameAccount()) return
  data.value = { meetup: next }
  planMoved.value = ''
  toast('Plan changed. Everyone invited was asked to answer again.', 'good')
  void backToPlan()
}

/** The venue as a place in the district open in the World, when that is the venue's district. */
const place = computed(() => {
  const plan = meetup.value
  if (!plan || world.districtId !== plan.venue.districtId) return null
  return world.places.find(entry => entry.placeId === plan.venue.placeId) ?? null
})
function walkThere(): void {
  if (!place.value || !meetup.value) return
  if (!walkToPlace(place.value)) { toast('Step outside to the street first. Your avatar can only walk to a venue from the district.', 'info'); return }
  toast(`Your avatar is walking to ${meetup.value.venue.name}.`, 'info')
  void router.push('/')
}
</script>

<template>
  <PanelPage class="people-window" title="Meetup" :back="BACK" @keydown="keepKeysInWindow">
    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />

    <div v-else-if="!meetup" class="empty">
      <div class="art" aria-hidden="true">🧭</div>
      <h3>That meetup was not found</h3>
      <p class="small">It may have been removed, or you are not one of the people invited. Your other plans are unchanged.</p>
      <RouterLink class="btn primary" :to="BACK">Back to your meetups</RouterLink>
    </div>

    <MeetupForm v-else-if="revising" :meetup="meetup" @done="revised" @cancel="backToPlan" />

    <template v-else>
      <p v-if="planMoved" class="notice amber" role="alert"><span aria-hidden="true">↻</span><span><strong>Your answer was not saved.</strong> {{ planMoved }} This is the plan as it stands now.</span></p>

      <!-- The plan -->
      <section class="card stack" :class="tint" aria-labelledby="meetup-venue">
        <div class="row top">
          <span class="icon-chip" :style="{ background: `${style.color}22` }" aria-hidden="true">{{ style.icon }}</span>
          <div class="grow">
            <h2 id="meetup-venue" ref="heading" class="wrap-any" tabindex="-1">{{ meetup.venue.name }}</h2>
            <p v-if="meetup.venue.branch" class="wrap-any">{{ meetup.venue.branch }}</p>
            <p class="muted tiny">Public venue · {{ placeKind(meetup.venue.category) }}</p>
          </div>
          <span v-if="status" class="chip" :class="status.tone"><span aria-hidden="true">{{ status.icon }}</span>{{ status.label }}</span>
        </div>
        <div class="time">
          <span class="label">When, on the venue’s clock</span>
          <strong class="big wrap-any">{{ dateTimeIn(meetup.startsAt, meetup.timezone) }}</strong>
          <span v-if="ownTime" class="small">On your clock: {{ ownTime }}</span>
          <span class="muted tiny">{{ live ? `Starts ${relativeTime(meetup.startsAt)}` : meetup.status === 'cancelled' ? 'Cancelled' : `Was ${relativeTime(meetup.startsAt)}` }} · times in {{ meetup.timezone }}</span>
        </div>
        <p v-if="meetup.note" class="quote">{{ meetup.note }}</p>
        <div v-if="live" class="stack tight">
          <div v-if="place" class="row wrap">
            <button class="btn" :class="{ primary: mine?.answer !== 'invited' }" type="button" @click="walkThere"><span aria-hidden="true">🚶</span>Walk there</button>
            <span class="muted tiny hint">Walks your avatar there in the World. It is not a real-world route.</span>
          </div>
          <p v-else class="muted tiny">To walk your avatar there, open the venue’s district in the World first.</p>
        </div>
        <p class="muted tiny"><span aria-hidden="true">🔒 </span>Only the venue, time and who is invited are shared. Nobody sees where anyone is coming from.</p>
      </section>

      <!-- The viewer's answer -->
      <section v-if="mine && live" class="card stack tight" :class="mine.answer === 'invited' ? 'tint-amber' : ''" aria-labelledby="meetup-answer">
        <h2 id="meetup-answer">{{ mine.answer === 'invited' ? 'Are you coming?' : mine.answer === 'accepted' ? 'You said you are coming' : 'You said you can’t come' }}</h2>
        <p class="small">{{ mine.answer === 'invited' ? `${meetup.organiser.displayName} is waiting for your answer to this plan.` : 'You can change your answer until the meetup starts.' }}</p>
        <div class="row">
          <button v-if="mine.answer !== 'accepted'" class="btn primary" type="button" :disabled="busy" @click="answer(true)">{{ mine.answer === 'declined' ? 'I can come after all' : 'Accept' }}</button>
          <button v-if="mine.answer !== 'declined'" class="btn" type="button" :disabled="busy" @click="answer(false)">{{ mine.answer === 'accepted' ? 'I can’t come any more' : 'Decline' }}</button>
        </div>
      </section>

      <!-- Who -->
      <section class="card stack tight" aria-labelledby="meetup-people">
        <div class="section-head"><h2 id="meetup-people">Who is invited</h2></div>
        <p v-if="live && waitingFor.length" class="muted small">Waiting for {{ nameList(waitingFor) }}.</p>
        <ul class="plain-list people">
          <li>
            <PersonRow :member="meetup.organiser" subtitle="Organiser" @changed="reload">
              <template #chips><span class="chip grape">Organiser</span></template>
            </PersonRow>
          </li>
          <li v-for="entry in meetup.participants" :key="entry.member.id">
            <PersonRow :member="entry.member" :subtitle="ANSWER[entry.answer].label" @changed="reload">
              <template #chips><span class="chip" :class="ANSWER[entry.answer].tone"><span aria-hidden="true">{{ ANSWER[entry.answer].icon }}</span>{{ ANSWER[entry.answer].label }}</span></template>
            </PersonRow>
          </li>
        </ul>
      </section>

      <!-- Organiser's tools -->
      <details v-if="organising && meetup.status !== 'cancelled'" class="disclosure" :open="!live">
        <summary>You organised this <span class="muted small">{{ live ? 'Change or cancel' : 'Move to a new time' }}</span></summary>
        <div class="stack tight">
          <p class="small muted">{{ live ? 'Changing the venue or time resets everyone’s answer, and they are asked again.' : 'It has passed. You can move it to a new time, and everyone is asked again.' }}</p>
          <div class="row wrap">
            <button class="btn" type="button" :disabled="busy" @click="revising = true">{{ live ? 'Change the plan' : 'Move to a new time' }}</button>
            <ConfirmAction
              v-if="live" label="Cancel meetup" button-class="danger" confirm-label="Cancel the meetup" cancel-label="Keep it" :busy="busy"
              question="Cancel this meetup? Everyone invited is told, and a cancelled meetup cannot be brought back."
              @confirm="cancelMeetup"
            />
          </div>
        </div>
      </details>
      <RouterLink v-if="!live" class="btn" :to="BACK">Plan another meetup</RouterLink>
    </template>
  </PanelPage>
</template>

<style scoped src="./window.css"></style>
<style scoped>
.top { align-items: flex-start; }
.top h2 { font-size: 1.2rem; line-height: 1.2; }
.top h2:focus { outline: none; }
.time { display: flex; flex-direction: column; gap: 2px; }
.big { font-size: 1.12rem; }
.hint { flex: 1 1 150px; }
.people { gap: 2px; }
h2 { font-size: 1rem; }</style>
