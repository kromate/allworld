<script setup lang="ts">
// One meetup in a list: the venue, the time on the venue's clock, who is coming, and — when the
// viewer has been asked — the answer buttons, so a plan can be answered without opening it.
import { computed, onBeforeUnmount, ref } from 'vue'
import type { PublicMember } from '../../shared/model.ts'
import type { Meetup } from '../../shared/social.ts'
import { api, messageOf, myId, onAccountReset, toast } from '../../state/app.ts'
import { categoryStyle } from '../../geo/categoryStyle.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { dateTimeIn, relativeTime } from '../../ui/format.ts'
import { MEETUP_STATUS, nameList, placeKind } from './labels.ts'
import { readsDifferently, viewerZone } from './zonedTime.ts'

const props = defineProps<{ meetup: Meetup }>()
const emit = defineEmits<{ changed: [] }>()

const me = myId()
let closed = false
const stopReset = onAccountReset(() => { closed = true })
onBeforeUnmount(() => { closed = true; stopReset() })
const current = (): boolean => !closed && myId() === me
const busy = ref(false)
const live = computed(() => props.meetup.status === 'proposed' || props.meetup.status === 'agreed')
const mine = computed(() => props.meetup.participants.find(entry => entry.member.id === me) ?? null)
const needsAnswer = computed(() => live.value && mine.value?.answer === 'invited')
const status = computed(() => MEETUP_STATUS[props.meetup.status])
const style = computed(() => categoryStyle(props.meetup.venue.category))
/** The same moment on the viewer's own clock, when that differs from the venue's. */
const ownTime = computed(() => (readsDifferently(Date.parse(props.meetup.startsAt), props.meetup.timezone, viewerZone()) ? dateTimeIn(props.meetup.startsAt, viewerZone()) : ''))
const nameOf = (member: PublicMember): string => (member.id === me ? 'you' : member.displayName)
const sentence = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1)

const people = computed(() => [
  { member: props.meetup.organiser, out: false },
  ...props.meetup.participants.map(entry => ({ member: entry.member, out: entry.answer === 'declined' })),
])
const who = computed(() => {
  const { organiser, participants } = props.meetup
  if (!live.value) {
    const invited = participants.map(entry => nameOf(entry.member))
    return [invited.length ? `${sentence(nameOf(organiser))} invited ${nameList(invited)}.` : `Organised by ${nameOf(organiser)}.`]
  }
  const names = (answer: string): string[] => participants.filter(entry => entry.answer === answer).map(entry => nameOf(entry.member))
  const coming = [nameOf(organiser), ...names('accepted')]
  const waiting = names('invited')
  const declined = names('declined')
  const lines = [`Coming: ${nameList(coming)}.`]
  if (waiting.length) lines.push(`Waiting for ${nameList(waiting)}.`)
  if (declined.length) lines.push(`${sentence(nameList(declined))} can’t come.`)
  return lines
})

async function answer(accept: boolean): Promise<void> {
  busy.value = true
  try {
    await api('meetup.respond', { meetupId: props.meetup.id, accept, revision: props.meetup.revision })
    if (current()) toast(accept ? `You are coming to ${props.meetup.venue.name}.` : `You told ${props.meetup.organiser.displayName} you can’t come.`, 'good')
  } catch (error) {
    // The plan moved, was cancelled or has passed: show what the service said and the fresh plan.
    if (current()) toast(messageOf(error), 'bad')
  } finally {
    busy.value = false
    if (current()) emit('changed')
  }
}
</script>

<template>
  <li class="card meetup" :class="{ faded: !live, 'tint-amber': needsAnswer }">
    <RouterLink class="open" :to="`/people/meetups/${meetup.id}`">
      <span class="icon-chip" :style="{ background: `${style.color}22` }" aria-hidden="true">{{ style.icon }}</span>
      <span class="grow body">
        <span class="row top">
          <strong class="grow wrap-any">{{ meetup.venue.name }}</strong>
          <span class="chip" :class="status.tone"><span aria-hidden="true">{{ status.icon }}</span>{{ status.label }}</span>
        </span>
        <span class="small muted wrap-any">{{ meetup.venue.branch || placeKind(meetup.venue.category) }}</span>
        <span class="when"><strong>{{ dateTimeIn(meetup.startsAt, meetup.timezone) }}</strong><span v-if="live" class="muted tiny"> · {{ relativeTime(meetup.startsAt) }}</span></span>
        <span v-if="ownTime" class="muted tiny">On your clock: {{ ownTime }}</span>
        <span class="row people">
          <span class="badges" aria-hidden="true">
            <span v-for="entry in people.slice(0, 6)" :key="entry.member.id" class="face" :class="{ out: entry.out }"><MemberBadge :member-id="entry.member.id" :look="entry.member.look" :size="24" /></span>
            <span v-if="people.length > 6" class="tiny muted more">+{{ people.length - 6 }}</span>
          </span>
        </span>
        <span class="small wrap-any">{{ who.join(' ') }}</span>
      </span>
    </RouterLink>
    <div v-if="needsAnswer" class="row wrap answer">
      <span class="small grow"><strong>{{ meetup.organiser.displayName }}</strong> asked if you are coming.</span>
      <span class="row buttons">
        <button class="btn primary sm" type="button" :disabled="busy" :aria-label="`Accept the meetup at ${meetup.venue.name}`" @click="answer(true)">Accept</button>
        <button class="btn sm" type="button" :disabled="busy" :aria-label="`Decline the meetup at ${meetup.venue.name}`" @click="answer(false)">Decline</button>
      </span>
    </div>
  </li>
</template>

<style scoped>
.meetup { display: flex; flex-direction: column; padding: 0; overflow: hidden; }
.open { display: flex; align-items: flex-start; gap: 12px; padding: 14px; color: inherit; text-decoration: none; border-radius: var(--radius); }
.open:hover { background: rgba(28, 26, 36, 0.03); }
.body { display: flex; flex-direction: column; gap: 3px; }
.top { gap: 8px; align-items: flex-start; }
.top .chip { flex: none; margin-top: 1px; }
.when { font-size: 0.92rem; }
.people { gap: 6px; margin-top: 2px; }
.badges { display: inline-flex; align-items: center; padding-left: 6px; }
.face { margin-left: -6px; display: inline-flex; }
.face.out { opacity: 0.4; filter: grayscale(1); }
.more { margin-left: 6px; }
.answer { padding: 0 14px 14px; gap: 8px; }
.buttons { gap: 8px; flex: none; }
.faded .open { opacity: 0.78; }
</style>
