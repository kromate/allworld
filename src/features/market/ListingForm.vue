<script setup lang="ts">
// Post or edit a real job or task. Compensation is the owner's own words: this App neither pays nor holds money.
import { computed, reactive, ref } from 'vue'
import type { Listing, ListingKind } from '../../shared/market.ts'
import { api, app, messageOf, toast } from '../../state/app.ts'
import { KIND } from './labels.ts'

const props = defineProps<{
  /** The listing being edited, or null to post a new one. */
  listing: Listing | null
  /** Which kind a new listing starts as. */
  kind?: ListingKind
}>()
const emit = defineEmits<{ saved: [listing: Listing]; cancel: [] }>()

const draft = reactive({
  kind: props.listing?.kind ?? props.kind ?? 'job' as ListingKind,
  title: props.listing?.title ?? '',
  organisation: props.listing?.organisation ?? '',
  description: props.listing?.description ?? '',
  areaLabel: props.listing?.areaLabel ?? '',
  remote: props.listing?.remote ?? false,
  compensation: props.listing?.compensation ?? '',
})
const tried = ref(false)
const saving = ref(false)

const KIND_HELP: Record<ListingKind, string> = {
  job: 'Ongoing work with a person or an organisation.',
  task: 'A one-off piece of help, big or small.',
}
/** The member's own coarse area, offered as a suggestion and never filled in for them. */
const myArea = computed(() => (app.me?.currentArea?.label ?? '').slice(0, 80))
const problems = computed(() => {
  const found: string[] = []
  if (draft.title.trim().length < 3) found.push('Give it a title of at least 3 characters.')
  if (draft.description.trim().length < 10) found.push('Describe the work in at least 10 characters.')
  return found
})

async function save(): Promise<void> {
  if (saving.value) return
  tried.value = true
  if (problems.value.length) return
  saving.value = true
  try {
    const { listing } = await api('listing.save', {
      listingId: props.listing?.id ?? null, kind: draft.kind, title: draft.title.trim(), organisation: draft.organisation.trim(), description: draft.description.trim(),
      areaLabel: draft.areaLabel.trim(), remote: draft.remote, compensation: draft.compensation.trim(),
    })
    toast(props.listing ? 'Listing updated.' : `Your ${draft.kind} is posted. Members can apply now.`, 'good')
    emit('saved', listing)
  } catch (cause) {
    toast(messageOf(cause), 'bad')
  } finally { saving.value = false }
}

function onKey(event: KeyboardEvent): void {
  if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void save() }
}
</script>

<template>
  <form class="card stack" novalidate @submit.prevent="save" @keydown="onKey">
    <div class="kinds" role="group" aria-label="What are you posting?">
      <button
        v-for="(entry, name) in KIND" :key="name" class="kind" :class="{ on: draft.kind === name }" type="button" :aria-pressed="draft.kind === name"
        @click="draft.kind = name"
      >
        <span class="icon-chip" :class="entry.tone" aria-hidden="true">{{ entry.icon }}</span>
        <span class="grow"><strong>{{ entry.label }}</strong><span class="tiny muted">{{ KIND_HELP[name] }}</span></span>
      </button>
    </div>

    <label class="field">
      <span>Title</span>
      <input v-model="draft.title" class="input" type="text" maxlength="100" :placeholder="draft.kind === 'job' ? 'Workshop assistant' : 'Help me move a sofa'" />
    </label>
    <label class="field">
      <span>{{ draft.kind === 'job' ? 'Organisation (optional)' : 'Who it is for (optional)' }}</span>
      <input v-model="draft.organisation" class="input" type="text" maxlength="80" placeholder="Leave empty to post under your own name" />
    </label>
    <label class="field">
      <span>Description</span>
      <textarea v-model="draft.description" class="textarea tall" maxlength="2000" placeholder="What the work is, when, and what you are looking for"></textarea>
      <small class="num">{{ draft.description.length }} of 2000</small>
    </label>

    <div class="pair">
      <div class="field">
        <label class="label" for="listing-area">Area</label>
        <input id="listing-area" v-model="draft.areaLabel" class="input" type="text" maxlength="80" placeholder="Town or city" />
        <small>Shown as you write it. Keep it coarse — never a street address.</small>
        <div v-if="myArea && draft.areaLabel !== myArea"><button class="btn sm use-area" type="button" @click="draft.areaLabel = myArea">Use my area: {{ myArea }}</button></div>
      </div>
      <div class="row remote">
        <button class="switch" type="button" role="switch" :aria-checked="draft.remote" aria-labelledby="listing-remote" @click="draft.remote = !draft.remote"></button>
        <div class="grow" @click="draft.remote = !draft.remote"><strong id="listing-remote" class="small">Can be done remotely</strong><p class="tiny muted">Shown as “Remote” on the listing.</p></div>
      </div>
    </div>

    <label class="field">
      <span>Compensation</span>
      <input v-model="draft.compensation" class="input" type="text" maxlength="160" placeholder="For example: weekly, agreed in person — or: unpaid, lunch provided" />
      <small>In your own words. This App does not pay or hold money.</small>
    </label>

    <ul v-if="tried && problems.length" class="problems small" role="alert"><li v-for="problem in problems" :key="problem">{{ problem }}</li></ul>

    <div class="row wrap">
      <button class="btn primary" type="submit" :disabled="saving">{{ saving ? 'Saving…' : listing ? 'Save changes' : `Post this ${draft.kind}` }}</button>
      <button class="btn ghost" type="button" :disabled="saving" @click="emit('cancel')">Cancel</button>
    </div>
    <p class="tiny muted">This is a real listing that members can answer. It is separate from the simulated work in Go to work.</p>
  </form>
</template>

<style scoped>
.kinds { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(210px, 100%), 1fr)); gap: 8px; }
.kind { display: flex; align-items: center; gap: 10px; min-height: 56px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); text-align: left; transition: border-color 0.15s ease, box-shadow 0.15s ease; }
.kind .grow { display: flex; flex-direction: column; }
.kind.on { border-color: var(--accent-strong); box-shadow: 0 0 0 3px var(--accent-soft); }
.tall { min-height: 130px; }
.pair { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 12px; align-items: start; }
/* An area name can be long: the button wraps it instead of pushing the form sideways. */
.btn.use-area { max-width: 100%; padding-block: 6px; white-space: normal; text-align: left; overflow-wrap: anywhere; }
.remote { align-items: flex-start; gap: 12px; padding-top: 24px; }
/* The switch keeps its size; the area that answers a finger is 42 px tall. */
.switch::before { content: ""; position: absolute; inset: -8px -4px; }
.remote .grow { cursor: pointer; }
.problems { margin: 0; padding: 9px 12px 9px 28px; border-radius: 10px; background: var(--coral-soft); color: #8f2c19; display: flex; flex-direction: column; gap: 2px; }
@media (max-width: 520px) { .remote { padding-top: 0; } }
</style>
