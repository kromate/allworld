<script setup lang="ts">
// One real listing. A member reads it and applies; its owner edits it, closes it, and answers the
// applications. An application is read by exactly two people: who sent it and who posted the listing.
import { computed, nextTick, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ListingId } from '../../shared/ids.ts'
import { WorldError } from '../../shared/model.ts'
import type { Application, ApplicationStatus, Listing, ListingStatus } from '../../shared/market.ts'
import { api, app, attempt, messageOf, myId, toast } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import MemberBadge from '../../ui/MemberBadge.vue'
import MemberCard from '../people/MemberCard.vue'
import { useLoad } from '../../ui/useLoad.ts'
import { count, dateTime, relativeTime } from '../../ui/format.ts'
import ListingForm from './ListingForm.vue'
import { KIND, LISTING_STATUS, applicationStatus, placeText } from './labels.ts'

const route = useRoute()
const router = useRouter()
const listingId = String(route.params.id) as ListingId
const missing = ref(false)

interface Loaded { listing: Listing; applications: Application[]; mine: Application | null }

const { data, state, error, reload } = useLoad<Loaded | null>(async () => {
  try {
    const { listing } = await api('listing.get', { listingId })
    const owned = listing.owner.id === myId()
    const [applications, mine] = await Promise.all([
      owned ? api('application.forListing', { listingId }).then(result => result.applications) : Promise.resolve([]),
      // The newest application the member sent to this listing, so they can read it back and withdraw it.
      !owned && listing.myApplication ? api('application.mine', {}).then(result => result.applications.find(entry => entry.listing.id === listingId) ?? null) : Promise.resolve(null),
    ])
    missing.value = false
    return { listing, applications, mine }
  } catch (cause) {
    if (cause instanceof WorldError && (cause.code === 'not_found' || cause.code === 'invalid')) { missing.value = true; return null }
    throw cause
  }
}, [() => app.changed.listings])

const listing = computed(() => data.value?.listing ?? null)
const owner = computed(() => listing.value?.owner.id === myId())
const editing = computed(() => owner.value && route.query.edit !== undefined)
const busy = ref(false)

// ── Applying (anyone but the owner) ──

const form = reactive({ message: '', contact: '' })
const tried = ref(false)
const confirmWithdraw = ref(false)
const myStatus = computed(() => listing.value?.myApplication ?? null)
const canApply = computed(() => !owner.value && listing.value?.status === 'open' && (myStatus.value === null || myStatus.value === 'withdrawn'))
const applyProblem = computed(() => {
  if (form.message.trim().length < 10) return 'Write a message of at least 10 characters.'
  if (form.contact.trim().length < 3) return 'Give a contact of at least 3 characters, so they can reach you.'
  return ''
})

const mySentence = computed(() => {
  const who = listing.value?.owner.displayName ?? 'The owner'
  switch (myStatus.value) {
    case 'submitted': return `Your application is with ${who}. You will get a note in your Inbox when they answer.`
    case 'shortlisted': return `You are on ${who}’s shortlist. They may reach you on the contact you gave.`
    case 'accepted': return `${who} accepted your application and has the contact you gave. Agree the details, and any pay, between you. This App does not pay or hold money.`
    case 'declined': return `${who} declined your application. There is nothing more to do on this listing.`
    case 'withdrawn': return listing.value?.status === 'open' ? 'You withdrew your application. You can apply again below.' : 'You withdrew your application.'
    default: return ''
  }
})

async function apply(): Promise<void> {
  tried.value = true
  if (applyProblem.value || busy.value) return
  busy.value = true
  const result = await attempt('application.submit', { listingId, message: form.message.trim(), contact: form.contact.trim() }, `Application sent to ${listing.value?.owner.displayName ?? 'the owner'}.`)
  busy.value = false
  if (result) { form.message = ''; form.contact = ''; tried.value = false; showMine(result.application) }
  // On failure the listing may have closed meanwhile; either way, read where things stand now.
  void reload()
}

/** Shows the answer the service just gave, without waiting for the next full read on a slow connection. */
function showMine(application: Application): void {
  if (!data.value) return
  data.value.mine = application
  data.value.listing.myApplication = application.status
}

async function withdraw(): Promise<void> {
  const mine = data.value?.mine
  if (!mine || busy.value) return
  busy.value = true
  const result = await attempt('application.decide', { applicationId: mine.id, status: 'withdrawn' }, 'Application withdrawn.')
  busy.value = false
  confirmWithdraw.value = false
  if (result) showMine(result.application)
  void reload()
}

// ── Owning ──

const STATUS_SENTENCE: Record<ListingStatus, { owner: string; reader: string }> = {
  open: { owner: 'Open. Members can find it and apply.', reader: 'Open for applications.' },
  filled: { owner: 'Marked filled. It is off the lists and takes no new applications. People who applied can still open it.', reader: 'This listing has been filled and is not taking applications.' },
  closed: { owner: 'Closed. It is off the lists and takes no new applications. People who applied can still open it.', reader: 'This listing is closed and is not taking applications.' },
}

async function setStatus(status: ListingStatus, undoTo?: ListingStatus): Promise<void> {
  const current = listing.value
  if (!current || busy.value) return
  const before = current.status
  busy.value = true
  try {
    const result = await api('listing.setStatus', { listingId, status })
    if (data.value) data.value.listing = result.listing
    const text = status === 'open' ? 'Reopened. Members can apply again.' : status === 'filled' ? 'Marked filled. It is off the lists.' : 'Closed. It is off the lists.'
    toast(text, 'good', undoTo === undefined ? { label: 'Undo', run: () => { void setStatus(before, before) } } : undefined)
  } catch (cause) { toast(messageOf(cause), 'bad') } finally { busy.value = false }
}

type Filter = 'all' | 'new' | 'shortlisted' | 'decided'
const filter = ref<Filter>('all')
const FILTERS: { id: Filter; label: string }[] = [{ id: 'all', label: 'All' }, { id: 'new', label: 'New' }, { id: 'shortlisted', label: 'Shortlisted' }, { id: 'decided', label: 'Answered' }]
const inFilter = (application: Application, which: Filter): boolean => which === 'all'
  || (which === 'new' && application.status === 'submitted')
  || (which === 'shortlisted' && application.status === 'shortlisted')
  || (which === 'decided' && (application.status === 'accepted' || application.status === 'declined' || application.status === 'withdrawn'))
const applications = computed(() => data.value?.applications ?? [])
const shown = computed(() => applications.value.filter(application => inFilter(application, filter.value)))
const countIn = (which: Filter): number => applications.value.filter(application => inFilter(application, which)).length
/** "Not shortlisted" means still unanswered: new applications that were neither shortlisted nor decided. */
const toDecline = computed(() => shown.value.filter(application => application.status === 'submitted'))
const deciding = ref<string | null>(null)
const confirmDecline = ref(false)
const progress = ref('')

function put(application: Application): void {
  const list = data.value?.applications
  const index = list?.findIndex(entry => entry.id === application.id) ?? -1
  if (list && index >= 0) list[index] = application
}

async function decide(application: Application, status: Exclude<ApplicationStatus, 'submitted' | 'withdrawn'>, undo = true): Promise<void> {
  if (deciding.value || progress.value) return
  const before = application.status
  const name = application.applicant.displayName
  deciding.value = application.id
  try {
    const result = await api('application.decide', { applicationId: application.id, status })
    put(result.application)
    const text = status === 'accepted' ? `${name} is accepted and has been told. Reach them on the contact they gave.` : status === 'shortlisted' ? `${name} is on your shortlist and has been told.` : `${name} was declined and has been told.`
    // A decline can be taken back to where it was, unless it was still unanswered (there is no "unanswered" to return to).
    const back = undo && status === 'declined' && (before === 'shortlisted' || before === 'accepted') ? before : null
    if (back) toast(text, 'good', { label: 'Undo', run: () => { void decide(result.application, back, false) } })
    else if (status === 'accepted' && listing.value?.status === 'open') toast(text, 'good', { label: 'Mark filled', run: () => { void setStatus('filled') } })
    else toast(text, 'good')
  } catch (cause) {
    toast(messageOf(cause), 'bad')
    void reload()
  } finally { deciding.value = null }
}

async function declineAll(): Promise<void> {
  const targets = [...toDecline.value]
  confirmDecline.value = false
  if (!targets.length || progress.value || deciding.value) return
  let done = 0
  for (const application of targets) {
    progress.value = `Declining ${done + 1} of ${targets.length}: ${application.applicant.displayName}…`
    try { put((await api('application.decide', { applicationId: application.id, status: 'declined' })).application); done++ } catch (cause) {
      toast(`Stopped at ${application.applicant.displayName}: ${messageOf(cause)}`, 'bad')
      break
    }
  }
  progress.value = ''
  if (done) toast(`${count(done, 'application')} declined. Each applicant has been told.`, 'good')
}

async function copyContact(application: Application): Promise<void> {
  try { await navigator.clipboard.writeText(application.contact); toast(`${application.applicant.displayName}’s contact copied.`, 'good') } catch { toast('Copying was not allowed here. Select the text and copy it.', 'info') }
}

const startEdit = (): void => { void router.push({ path: `/jobs/${listingId}`, query: { edit: '1' } }) }
async function stopEdit(saved?: Listing): Promise<void> {
  if (saved && data.value) data.value.listing = saved
  await router.push(`/jobs/${listingId}`)
  await nextTick()
}
</script>

<template>
  <PanelPage
    :title="listing ? (editing ? 'Edit listing' : listing.title) : missing ? 'Listing not found' : 'Listing'"
    :subtitle="listing && !editing ? `${KIND[listing.kind].label}${listing.organisation ? ` · ${listing.organisation}` : ''}` : undefined"
    :back="editing ? `/jobs/${listingId}` : owner ? '/jobs?tab=mine' : '/jobs'" wide
  >
    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />

    <StateView v-else-if="!listing" state="empty" art="📋" title="That listing was not found" message="It may have been closed or filled, or it is not open to you.">
      <RouterLink class="btn primary" to="/jobs">Browse jobs and tasks</RouterLink>
    </StateView>

    <ListingForm v-else-if="editing" :listing="listing" @saved="stopEdit($event)" @cancel="stopEdit()" />

    <div v-else class="job">
      <!-- The listing itself -->
      <section class="card stack" :class="listing.status === 'open' ? '' : 'closed'" aria-label="The listing">
        <div class="row wrap chips">
          <span class="chip" :class="KIND[listing.kind].tone"><span aria-hidden="true">{{ KIND[listing.kind].icon }}</span>{{ KIND[listing.kind].label }}</span>
          <span class="chip" :class="LISTING_STATUS[listing.status].tone">{{ LISTING_STATUS[listing.status].label }}</span>
          <span class="tiny muted">Posted {{ relativeTime(listing.createdAt) }}</span>
        </div>
        <p v-if="listing.status !== 'open' || owner" class="small" :class="{ muted: listing.status === 'open' }">{{ STATUS_SENTENCE[listing.status][owner ? 'owner' : 'reader'] }}</p>
        <dl class="facts">
          <div v-if="listing.organisation"><dt>{{ listing.kind === 'job' ? 'Organisation' : 'For' }}</dt><dd>{{ listing.organisation }}</dd></div>
          <div><dt>Where</dt><dd>{{ placeText(listing) }}<span v-if="listing.areaLabel" class="muted tiny"> · {{ owner ? 'as you wrote it' : 'as the owner wrote it' }}</span></dd></div>
          <div><dt>Compensation</dt><dd>{{ listing.compensation || 'Not stated' }}<span class="muted tiny"> · agreed between you. This App does not pay or hold money.</span></dd></div>
        </dl>
        <p class="description">{{ listing.description }}</p>

        <div v-if="owner" class="row wrap owner-actions">
          <button class="btn" type="button" @click="startEdit">Edit</button>
          <template v-if="listing.status === 'open'">
            <button class="btn" type="button" :disabled="busy" @click="setStatus('filled')">Mark filled</button>
            <button class="btn danger" type="button" :disabled="busy" @click="setStatus('closed')">Close</button>
          </template>
          <button v-else class="btn primary" type="button" :disabled="busy" @click="setStatus('open')">Reopen</button>
        </div>
      </section>

      <!-- Owner: the applications -->
      <section v-if="owner" class="stack" aria-labelledby="applications-title">
        <div class="row between wrap">
          <h2 id="applications-title">Applications</h2>
          <button v-if="toDecline.length > 1 && !confirmDecline && !progress" class="btn ghost danger sm" type="button" :disabled="deciding !== null" @click="confirmDecline = true">Decline all not shortlisted ({{ toDecline.length }})</button>
        </div>
        <p class="tiny muted">Only you and each applicant can read an application. Nothing about their game level or points is shown here.</p>

        <StateView v-if="!applications.length" state="empty" art="✉️" title="No applications yet" :message="listing.status === 'open' ? 'When a member applies, you get a note in your Inbox and their message appears here.' : 'This listing is not open, so no one can apply. Reopen it to take applications.'" />
        <template v-else>
          <div class="row wrap" role="group" aria-label="Filter applications">
            <button v-for="entry in FILTERS" :key="entry.id" class="btn sm" :class="{ dark: filter === entry.id }" type="button" :aria-pressed="filter === entry.id" @click="filter = entry.id; confirmDecline = false">
              {{ entry.label }}<span class="num tiny">{{ countIn(entry.id) }}</span>
            </button>
          </div>
          <p v-if="progress" class="small" role="status">{{ progress }}</p>
          <div v-if="confirmDecline" class="notice coral confirm" role="alert">
            <span class="grow">Decline {{ count(toDecline.length, 'application') }} that {{ toDecline.length === 1 ? 'is' : 'are' }} not shortlisted? Each applicant is told. You can still shortlist or accept one afterwards.</span>
            <span class="row">
              <button class="btn danger sm" type="button" :disabled="deciding !== null" @click="declineAll">Decline {{ toDecline.length }}</button>
              <button class="btn sm" type="button" @click="confirmDecline = false">Cancel</button>
            </span>
          </div>

          <p v-if="!shown.length" class="empty small">No applications under “{{ FILTERS.find(entry => entry.id === filter)?.label }}”.</p>
          <ul v-else class="applications">
            <li v-for="application in shown" :key="application.id" class="card stack tight" :class="{ quiet: application.status === 'declined' || application.status === 'withdrawn' }">
              <div class="row">
                <MemberBadge :member-id="application.applicant.id" :look="application.applicant.look" :size="40" :online="application.applicant.online" />
                <div class="grow who">
                  <strong class="truncate">{{ application.applicant.displayName }}</strong>
                  <span class="tiny muted">Applied {{ dateTime(application.createdAt) }}</span>
                </div>
                <span class="chip" :class="applicationStatus(application.status, 'owner').tone">{{ applicationStatus(application.status, 'owner').label }}</span>
              </div>
              <p class="message">{{ application.message }}</p>
              <div class="row wrap contact">
                <span class="label">Contact</span>
                <span class="grow value">{{ application.contact }}</span>
                <button class="btn ghost sm" type="button" @click="copyContact(application)">Copy</button>
              </div>
              <p v-if="application.status === 'withdrawn'" class="small muted">Withdrawn by the applicant{{ application.decidedAt ? ` ${relativeTime(application.decidedAt)}` : '' }}. There is nothing to answer.</p>
              <div v-else class="row wrap">
                <button v-if="application.status !== 'accepted'" class="btn primary sm" type="button" :disabled="deciding !== null || Boolean(progress)" @click="decide(application, 'accepted')">Accept</button>
                <button v-if="application.status !== 'shortlisted'" class="btn sm" type="button" :disabled="deciding !== null || Boolean(progress)" @click="decide(application, 'shortlisted')">{{ application.status === 'accepted' ? 'Move to shortlist' : 'Shortlist' }}</button>
                <button v-if="application.status !== 'declined'" class="btn danger sm" type="button" :disabled="deciding !== null || Boolean(progress)" @click="decide(application, 'declined')">Decline</button>
              </div>
              <details v-if="application.applicant.relation !== 'self'" class="more">
                <summary class="small">More about {{ application.applicant.displayName }}</summary>
                <MemberCard :member="application.applicant" compact />
              </details>
            </li>
          </ul>
        </template>
      </section>

      <!-- Everyone else: who posted it, and applying -->
      <template v-else>
        <section class="card" aria-label="Who posted this">
          <MemberCard :member="listing.owner" subtitle="Posted this listing" compact />
        </section>

        <section v-if="myStatus" class="card stack" :class="myStatus === 'accepted' ? 'tint-leaf' : myStatus === 'shortlisted' ? 'tint-sky' : myStatus === 'submitted' ? 'tint-amber' : ''" aria-labelledby="mine-title">
          <div class="row wrap between">
            <h2 id="mine-title">Your application</h2>
            <span class="chip" :class="applicationStatus(myStatus, 'applicant').tone">{{ applicationStatus(myStatus, 'applicant').label }}</span>
          </div>
          <p>{{ mySentence }}</p>
          <dl v-if="data?.mine" class="facts plain">
            <div><dt>You wrote</dt><dd class="pre">{{ data.mine.message }}</dd></div>
            <div><dt>Your contact</dt><dd>{{ data.mine.contact }}<span class="muted tiny"> · seen only by {{ listing.owner.displayName }}</span></dd></div>
            <div><dt>Sent</dt><dd>{{ dateTime(data.mine.createdAt) }}</dd></div>
          </dl>
          <template v-if="data?.mine && (myStatus === 'submitted' || myStatus === 'shortlisted' || myStatus === 'accepted')">
            <div v-if="confirmWithdraw" class="notice coral confirm" role="alert">
              <span class="grow">Withdraw your application? {{ listing.owner.displayName }} is told.{{ listing.status === 'open' ? ' You can apply again while the listing is open.' : ' The listing is not open, so you could not apply again.' }}</span>
              <span class="row">
                <button class="btn danger sm" type="button" :disabled="busy" @click="withdraw">{{ busy ? 'Withdrawing…' : 'Withdraw' }}</button>
                <button class="btn sm" type="button" :disabled="busy" @click="confirmWithdraw = false">Keep it</button>
              </span>
            </div>
            <div v-else class="row wrap"><button class="btn danger" type="button" @click="confirmWithdraw = true">Withdraw application</button></div>
          </template>
          <div v-else-if="myStatus === 'declined'" class="row wrap"><RouterLink class="btn" to="/jobs">Browse other listings</RouterLink></div>
        </section>

        <form v-if="canApply" class="card tint-amber stack" @submit.prevent="apply">
          <h2>{{ myStatus === 'withdrawn' ? 'Apply again' : listing.kind === 'job' ? 'Apply for this job' : 'Offer to do this task' }}</h2>
          <label class="field">
            <span>Your message</span>
            <textarea v-model="form.message" class="textarea tall" maxlength="1000" placeholder="Why you are a good fit, and when you are free"></textarea>
            <small class="num">{{ form.message.trim().length }} of 1000 · at least 10</small>
          </label>
          <label class="field">
            <span>How they can reach you</span>
            <input v-model="form.contact" class="input" type="text" maxlength="120" placeholder="An email, a phone number or a handle" autocomplete="off" />
            <small>Seen only by the person who posted this.</small>
          </label>
          <p v-if="tried && applyProblem" class="problem small" role="alert">{{ applyProblem }}</p>
          <div class="row wrap">
            <button class="btn primary" type="submit" :disabled="busy">{{ busy ? 'Sending…' : 'Send application' }}</button>
            <span class="tiny muted">Your game level and points are not sent.</span>
          </div>
        </form>
        <p v-else-if="!myStatus && listing.status !== 'open'" class="notice">{{ STATUS_SENTENCE[listing.status].reader }} <RouterLink to="/jobs">Browse open listings</RouterLink></p>
      </template>
    </div>
  </PanelPage>
</template>

<style scoped>
.job { display: flex; flex-direction: column; gap: 14px; }
.closed { background: var(--surface-2); }
.chips { gap: 6px; }
.facts { margin: 0; display: grid; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); overflow: hidden; }
.facts > div { display: grid; grid-template-columns: 108px minmax(0, 1fr); gap: 10px; padding: 8px 12px; }
.facts > div + div { border-top: 1px solid var(--line); }
.facts.plain { background: rgba(255, 255, 255, 0.7); }
.facts dt { color: var(--muted); font-size: 0.82rem; font-weight: 650; }
.facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; }
.description, .message, .pre { white-space: pre-line; overflow-wrap: anywhere; }
.owner-actions { padding-top: 4px; }
.applications { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(330px, 100%), 1fr)); gap: 8px; align-items: start; }
.applications > li { min-width: 0; }
.applications > li.quiet { background: var(--surface-2); }
.who { display: flex; flex-direction: column; min-width: 0; }
.contact { padding: 6px 6px 6px 10px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); gap: 8px; }
.contact .value { overflow-wrap: anywhere; font-weight: 600; }
.confirm { align-items: center; flex-wrap: wrap; }
.confirm > .grow { flex-basis: 220px; }
.more summary { cursor: pointer; color: var(--accent-text); font-weight: 650; padding: 4px 0; min-height: 32px; display: flex; align-items: center; }
.more[open] summary { margin-bottom: 8px; }
.tall { min-height: 120px; }
.problem { color: var(--danger); font-weight: 650; }
p.empty { padding: 18px; }
@media (pointer: coarse) { .more summary { min-height: 44px; } }
@media (max-width: 420px) {
  .facts > div { grid-template-columns: 92px minmax(0, 1fr); }
}
</style>
