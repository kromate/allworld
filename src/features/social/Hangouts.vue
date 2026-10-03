<script setup lang="ts">
// Open hangouts in the member's city: a time and a public place in the game that anyone in the
// city can say they are coming to. Also the short form to announce one where the member stands.
import { computed, onMounted, ref, watch } from 'vue'
import { HANGOUT } from '../../shared/direct.ts'
import type { Hangout, HangoutId } from '../../shared/direct.ts'
import { api } from '../../state/app.ts'
import { cancelHangout, goToHangout, hostHangout, rsvpHangout, social } from '../../state/social.ts'
import { world } from '../../state/world.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { count, relativeTime } from '../../ui/format.ts'
import ConfirmAction from '../people/ConfirmAction.vue'
import { wallClockAt, zonedToInstant } from '../people/zonedTime.ts'

const props = defineProps<{ highlight?: string | null }>()
const hangouts = computed(() => social.around?.hangouts ?? [])
/** A hangout opened from a reminder may be in another city: it is fetched by itself. */
const linked = ref<Hangout | null>(null)
async function loadLinked(): Promise<void> {
  const id = props.highlight
  if (!id || hangouts.value.some(entry => entry.id === id)) { linked.value = null; return }
  try { linked.value = (await api('hangout.get', { hangoutId: id as HangoutId })).hangout } catch { linked.value = null }
}
onMounted(loadLinked)
watch(() => [props.highlight, hangouts.value.length], loadLinked)
const shown = computed(() => (linked.value && !hangouts.value.some(entry => entry.id === linked.value!.id) ? [linked.value, ...hangouts.value] : hangouts.value))

const canHost = computed(() => world.state === 'ready' && (world.kind === 'district' || world.kind === 'venue'))
const hereName = computed(() => (world.kind === 'venue' ? world.venue?.name : `the streets of ${world.areaLabel}`) || 'here')
const hosting = ref(false)
const busy = ref<string | null>(null)
const note = ref('')
const choice = ref('30')
const date = ref('')
const time = ref('19:00')
const zone = computed(() => world.timezone || 'UTC')

/** A few times most people would pick, on the place's own clock. */
const choices = computed(() => {
  const now = Date.now(), wall = wallClockAt(now, zone.value)
  const day = (offset: number): string => new Date(Date.UTC(wall.year, wall.month - 1, wall.day + offset)).toISOString().slice(0, 10)
  const at = (offset: number, clock: string): number => zonedToInstant(day(offset), clock, zone.value)?.instant ?? 0
  const out = [{ id: '30', label: 'In 30 minutes', at: now + 30 * 60_000 }]
  if (at(0, '19:00') > now + 45 * 60_000) out.push({ id: 'tonight', label: 'Tonight at 7 pm', at: at(0, '19:00') })
  out.push({ id: 'tomorrow', label: 'Tomorrow at 7 pm', at: at(1, '19:00') })
  return out
})
const startsAt = computed(() => (choice.value === 'other' ? zonedToInstant(date.value, time.value, zone.value)?.instant ?? 0 : choices.value.find(entry => entry.id === choice.value)?.at ?? 0))
const problem = computed(() => {
  if (!startsAt.value) return choice.value === 'other' ? 'Choose a day and a time.' : ''
  if (startsAt.value < Date.now() + HANGOUT.minMinutesAhead * 60_000) return `Choose a time at least ${HANGOUT.minMinutesAhead} minutes from now.`
  if (startsAt.value > Date.now() + HANGOUT.maxDaysAhead * 86_400_000) return `Choose a time within the next ${HANGOUT.maxDaysAhead} days.`
  return ''
})
const when = (hangout: Hangout): string => new Intl.DateTimeFormat(undefined, { timeZone: hangout.timezone, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).format(Date.parse(hangout.startsAt))
const soon = (hangout: Hangout): boolean => hangout.status === 'now' || Date.parse(hangout.startsAt) - Date.now() < HANGOUT.remindMinutes * 60_000

async function announce(): Promise<void> {
  if (problem.value || !startsAt.value) return
  busy.value = 'host'
  if (await hostHangout(startsAt.value, note.value)) { hosting.value = false; note.value = '' }
  busy.value = null
}
async function run(key: string, action: () => Promise<unknown>): Promise<void> { busy.value = key; try { await action() } finally { busy.value = null } }
</script>

<template>
  <section class="stack tight" aria-labelledby="hangouts-title">
    <div class="row between wrap">
      <h2 id="hangouts-title" class="head">Hangouts</h2>
      <button v-if="canHost && !hosting" class="btn sm" type="button" @click="hosting = true">Host one here</button>
    </div>

    <form v-if="hosting" class="card tint-amber stack tight" @submit.prevent="announce">
      <p class="small"><strong>A hangout at {{ hereName }}.</strong> Anyone in the city can say they are coming, and gets a reminder. Characters meet here in the game; it is not a real-world meetup.</p>
      <div class="row wrap times" role="group" aria-label="When">
        <button v-for="entry in choices" :key="entry.id" class="btn sm" :class="{ dark: choice === entry.id }" type="button" :aria-pressed="choice === entry.id" @click="choice = entry.id">{{ entry.label }}</button>
        <button class="btn sm" :class="{ dark: choice === 'other' }" type="button" :aria-pressed="choice === 'other'" @click="choice = 'other'">Another time</button>
      </div>
      <div v-if="choice === 'other'" class="row wrap">
        <label class="field grow"><span>Day</span><input v-model="date" class="input" type="date" /></label>
        <label class="field grow"><span>Time ({{ zone }})</span><input v-model="time" class="input" type="time" /></label>
      </div>
      <label class="field"><span>A line about it (optional)</span><input v-model="note" class="input" type="text" :maxlength="HANGOUT.noteMax" placeholder="Eights at the back table, all welcome" /></label>
      <p v-if="problem" class="tiny problem" role="alert">{{ problem }}</p>
      <div class="row">
        <button class="btn primary sm" type="submit" :disabled="Boolean(problem) || !startsAt || busy === 'host'">{{ busy === 'host' ? 'Announcing…' : 'Announce it' }}</button>
        <button class="btn sm ghost" type="button" @click="hosting = false">Cancel</button>
      </div>
    </form>

    <ul v-if="shown.length" class="plain">
      <li v-for="hangout in shown" :key="hangout.id" class="card item" :class="{ highlight: hangout.id === props.highlight, live: hangout.status === 'now' }">
        <span class="icon-chip" :class="hangout.status === 'now' ? 'leaf' : 'grape'" aria-hidden="true">{{ hangout.status === 'now' ? '🎉' : '🗓' }}</span>
        <div class="grow lines">
          <strong class="wrap-any">{{ hangout.place.name }}</strong>
          <span class="small">
            <template v-if="hangout.status === 'now'"><span class="chip leaf">Going on now</span> started {{ relativeTime(hangout.startsAt) }}</template>
            <template v-else-if="hangout.status === 'upcoming'">{{ when(hangout) }} · {{ relativeTime(hangout.startsAt) }}</template>
            <template v-else>{{ hangout.status === 'cancelled' ? 'Cancelled' : 'This hangout is over' }}</template>
          </span>
          <span v-if="hangout.note" class="small note wrap-any">“{{ hangout.note }}”</span>
          <span class="row wrap tiny muted who">
            <MemberBadge :member-id="hangout.host.id" :look="hangout.host.look" :size="20" /> {{ hangout.mine ? 'You are hosting' : `Hosted by ${hangout.host.displayName}` }} · {{ count(hangout.going, 'person', 'people') }} coming
            <span v-if="hangout.friendsGoing.length" class="friends">· {{ hangout.friendsGoing.map(friend => friend.displayName).join(', ') }} {{ hangout.friendsGoing.length === 1 ? 'is' : 'are' }} coming</span>
          </span>
        </div>
        <div v-if="hangout.status === 'upcoming' || hangout.status === 'now'" class="row actions">
          <button v-if="soon(hangout)" class="btn primary sm" type="button" :disabled="busy === hangout.id" @click="run(hangout.id, () => goToHangout(hangout))">Go there</button>
          <ConfirmAction v-if="hangout.mine" label="Cancel" button-class="sm ghost danger" confirm-label="Cancel the hangout" cancel-label="Keep it" :question="`Cancel the hangout at ${hangout.place.name}? Everyone who said they are coming is told.`" @confirm="cancelHangout(hangout)" />
          <button v-else-if="hangout.iAmGoing" class="btn sm ghost" type="button" :disabled="busy === hangout.id" @click="run(hangout.id, () => rsvpHangout(hangout, false))">Not coming</button>
          <button v-else class="btn sm" :class="{ primary: !soon(hangout) }" type="button" :disabled="busy === hangout.id" @click="run(hangout.id, () => rsvpHangout(hangout, true))">I’m in</button>
          <span v-if="hangout.iAmGoing && !hangout.mine" class="chip leaf">You are in</span>
        </div>
      </li>
    </ul>
    <p v-else-if="!hosting" class="small muted">Nothing is planned in your city yet. {{ canHost ? 'Host one and people have a reason to come.' : 'Step into a street or a venue to host one.' }}</p>
  </section>
</template>

<style scoped>
.head { font-size: 1rem; }
.plain { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; }
.item { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 8px 10px; padding: 10px 12px; }
.item.live { border-color: #c4e6d1; background: linear-gradient(135deg, #e3f5ea, #fffdf9 70%); }
.item.highlight { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 0 4px var(--accent-strong); }
.lines { display: flex; flex-direction: column; gap: 3px; flex: 1 1 170px; }
.wrap-any { overflow-wrap: anywhere; }
.note { color: var(--ink-2); }
.who { gap: 5px; align-items: center; }
.friends { color: #1f7447; font-weight: 650; }
.actions { gap: 6px; flex-wrap: wrap; margin-left: auto; align-items: center; }
.times { gap: 6px; }
.problem { color: var(--danger); }
@media (pointer: coarse) { .btn.sm { min-height: 40px; } }
</style>
