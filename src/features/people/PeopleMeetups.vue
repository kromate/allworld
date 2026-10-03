<script setup lang="ts">
// Meetups tab: what is coming up, what has passed, and the form to plan a new one.
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { Meetup } from '../../shared/social.ts'
import { api, app, toast } from '../../state/app.ts'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import MeetupForm from './MeetupForm.vue'
import MeetupRow from './MeetupRow.vue'
import { nameList } from './labels.ts'

const props = defineProps<{ withId: string | null }>()
const emit = defineEmits<{ clearWith: [] }>()
const router = useRouter()

const { data, state, error, reload } = useLoad(async () => (await api('meetup.list', {})).meetups, [() => app.changed.meetups])
const planning = ref(Boolean(props.withId))
const showEarlier = ref(false)
const planButton = ref<HTMLButtonElement | null>(null)
watch(() => props.withId, value => { if (value) planning.value = true })

const upcoming = computed(() => (data.value ?? []).filter(meetup => meetup.status === 'proposed' || meetup.status === 'agreed'))
const earlier = computed(() => (data.value ?? []).filter(meetup => meetup.status === 'past' || meetup.status === 'cancelled').reverse())

async function closeForm(): Promise<void> {
  planning.value = false
  if (props.withId) emit('clearWith')
  await nextTick()
  planButton.value?.focus()
}
function planned(meetup: Meetup): void {
  void closeForm()
  void reload()
  const names = meetup.participants.map(entry => entry.member.displayName)
  toast(`Meetup proposed. ${nameList(names)} ${names.length === 1 ? 'was' : 'were'} asked.`, 'good', { label: 'Open it', run: () => { void router.push(`/people/meetups/${meetup.id}`) } })
}
</script>

<template>
  <div class="stack">
    <MeetupForm v-if="planning" :with-id="withId" @done="planned" @cancel="closeForm" />
    <div v-else class="row wrap intro">
      <span class="grow small muted text">Meet friends at a public place, at a time on the venue’s clock.</span>
      <button ref="planButton" class="btn primary" type="button" @click="planning = true">Plan a meetup</button>
    </div>

    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />
    <template v-else>
      <section class="stack tight" aria-labelledby="meetups-upcoming">
        <div class="section-head"><h2 id="meetups-upcoming">Coming up</h2></div>
        <ul v-if="upcoming.length" class="plain-list">
          <MeetupRow v-for="meetup in upcoming" :key="meetup.id" :meetup="meetup" @changed="reload" />
        </ul>
        <p v-else class="muted small">{{ planning ? 'Nothing planned yet. The plan you are writing will appear here.' : 'Nothing planned yet. Your plans, and invitations from friends, appear here.' }}</p>
      </section>

      <section v-if="earlier.length" class="stack tight" aria-labelledby="meetups-earlier">
        <div class="section-head">
          <h2 id="meetups-earlier">Past and cancelled</h2>
          <button class="btn sm ghost" type="button" :aria-expanded="showEarlier" aria-controls="meetups-earlier-list" @click="showEarlier = !showEarlier">
            {{ showEarlier ? 'Hide' : 'Show' }} <span class="num">{{ earlier.length }}</span><span aria-hidden="true">{{ showEarlier ? '▴' : '▾' }}</span>
          </button>
        </div>
        <ul v-if="showEarlier" id="meetups-earlier-list" class="plain-list">
          <MeetupRow v-for="meetup in earlier" :key="meetup.id" :meetup="meetup" @changed="reload" />
        </ul>
      </section>
    </template>
  </div>
</template>

<style scoped>
.intro { gap: 10px; }
.intro .text { flex: 1 1 170px; }
</style>
