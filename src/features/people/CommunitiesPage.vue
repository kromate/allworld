<script setup lang="ts">
// Communities window: the ones the member is in, the ones they can join, and starting a new one.
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { COMMUNITY_TOPICS } from '../../shared/social.ts'
import type { CommunitySummary, CommunityTopic, CommunityVisibility } from '../../shared/social.ts'
import { api, app, messageOf, onAccountReset, toast } from '../../state/app.ts'
import PanelPage from '../../ui/PanelPage.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import CommunityCard from './CommunityCard.vue'
import { keepKeysInWindow, topicMeta } from './labels.ts'

const router = useRouter()
const { data, state, error, reload } = useLoad(() => api('community.list', {}), [() => app.changed.communities])

const query = ref('')
const matches = (entry: CommunitySummary): boolean => {
  const text = query.value.trim().toLowerCase()
  return !text || [entry.name, entry.about, entry.areaLabel, topicMeta(entry.topic).label].some(value => value.toLowerCase().includes(text))
}
/** Invite-only communities only reach Discover through an invitation. */
const invited = (entry: CommunitySummary): boolean => entry.myRole === null && entry.visibility === 'invite-only'
const mine = computed(() => (data.value?.mine ?? []).filter(matches))
const discover = computed(() => (data.value?.discover ?? []).filter(matches).sort((a, b) => Number(invited(b)) - Number(invited(a))))
const total = computed(() => (data.value ? data.value.mine.length + data.value.discover.length : 0))

/** A reply that lands after the window closed (or the account changed) must not navigate, reload or report a failure into what is open now. */
let closed = false
const stopReset = onAccountReset(() => { closed = true })
onBeforeUnmount(() => { closed = true; stopReset() })

const joining = ref<string | null>(null)
async function join(entry: CommunitySummary): Promise<void> {
  if (closed || joining.value) return
  joining.value = entry.id
  try {
    await api('community.join', { communityId: entry.id })
    if (closed) return
    toast(`You joined ${entry.name}.`, 'good')
    if (!closed) void router.push(`/communities/${entry.id}`)
  } catch (cause) {
    if (closed) return
    toast(messageOf(cause), 'bad')
    void reload()
  } finally {
    joining.value = null
  }
}

// ── Start a community ──
const NAME_MIN = 3, NAME_MAX = 48, ABOUT_MAX = 240, AREA_MAX = 80
const creating = ref(false)
const saving = ref(false)
const formError = ref('')
const nameInput = ref<HTMLInputElement | null>(null)
const startButton = ref<HTMLButtonElement | null>(null)
/** With no communities at all the empty state carries the one "start" action, and the header's is not shown. */
const emptyStart = ref<HTMLButtonElement | null>(null)
const draft = ref({ name: '', about: '', topic: 'neighbours' as CommunityTopic, areaLabel: 'Global', visibility: 'public' as CommunityVisibility })
const myArea = computed(() => app.me?.currentArea?.label ?? '')
const VISIBILITY: { id: CommunityVisibility; label: string; icon: string; explain: string }[] = [
  { id: 'public', label: 'Public', icon: '🌍', explain: 'Anyone can find it in Discover and join.' },
  { id: 'invite-only', label: 'Invite-only', icon: '🔒', explain: 'Hidden from Discover. Only people a member invites can see it and join.' },
]

async function openForm(): Promise<void> {
  creating.value = true
  await nextTick()
  nameInput.value?.focus()
}
async function closeForm(): Promise<void> {
  creating.value = false
  formError.value = ''
  await nextTick()
  ;(startButton.value ?? emptyStart.value)?.focus()
}
async function create(): Promise<void> {
  if (closed || saving.value) return
  const name = draft.value.name.trim()
  if (name.length < NAME_MIN) { formError.value = `Give the community a name of at least ${NAME_MIN} letters.`; nameInput.value?.focus(); return }
  saving.value = true
  formError.value = ''
  try {
    const { community } = await api('community.create', {
      name, about: draft.value.about.trim(), topic: draft.value.topic, areaLabel: draft.value.areaLabel.trim() || 'Global', visibility: draft.value.visibility,
    })
    if (closed) return
    toast(`${community.name} is open. You are its owner.`, 'good')
    if (!closed) void router.push(`/communities/${community.id}`)
  } catch (cause) {
    if (!closed) formError.value = messageOf(cause)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <PanelPage class="people-window" title="Communities" @keydown="keepKeysInWindow">
    <template #actions>
      <button v-if="!creating && !(state === 'ready' && !total)" ref="startButton" class="btn primary sm" type="button" @click="openForm">Start one</button>
    </template>

    <form v-if="creating" class="card tint-amber stack" aria-labelledby="community-new-title" @submit.prevent="create">
      <div class="row">
        <span class="icon-chip" aria-hidden="true">🏘</span>
        <h2 id="community-new-title" class="grow">Start a community</h2>
        <button class="btn ghost icon sm" type="button" aria-label="Close this form" @click="closeForm">✕</button>
      </div>
      <label class="field">
        <span>Name</span>
        <input ref="nameInput" v-model="draft.name" class="input" type="text" :maxlength="NAME_MAX" required autocomplete="off" placeholder="For example: Bodija evening walkers" />
        <small class="num">{{ draft.name.trim().length }} / {{ NAME_MAX }} · at least {{ NAME_MIN }}</small>
      </label>
      <label class="field">
        <span>About <span class="muted">(optional)</span></span>
        <textarea v-model="draft.about" class="textarea" :maxlength="ABOUT_MAX" placeholder="Who is it for, and what happens here?"></textarea>
        <small class="num">{{ draft.about.length }} / {{ ABOUT_MAX }}</small>
      </label>
      <div class="two">
        <label class="field">
          <span>Topic</span>
          <select v-model="draft.topic" class="select">
            <option v-for="topic in COMMUNITY_TOPICS" :key="topic" :value="topic">{{ topicMeta(topic).label }}</option>
          </select>
        </label>
        <label class="field">
          <span>Area label</span>
          <input v-model="draft.areaLabel" class="input" type="text" :maxlength="AREA_MAX" autocomplete="off" placeholder="Global" />
        </label>
      </div>
      <div class="row wrap suggestions" role="group" aria-label="Area label suggestions">
        <button class="btn sm" type="button" :aria-pressed="draft.areaLabel.trim() === 'Global'" @click="draft.areaLabel = 'Global'">Global</button>
        <button v-if="myArea" class="btn sm suggestion" type="button" :aria-pressed="draft.areaLabel.trim() === myArea" @click="draft.areaLabel = myArea.slice(0, AREA_MAX)"><span class="truncate">Use {{ myArea }}</span></button>
        <small class="muted tiny note">A public label only. It does not place the community or anyone in it on a map.</small>
      </div>
      <fieldset class="group">
        <legend class="label">Who can join</legend>
        <label v-for="option in VISIBILITY" :key="option.id" class="option" :class="{ on: draft.visibility === option.id }">
          <input v-model="draft.visibility" type="radio" name="community-visibility" :value="option.id" />
          <span class="grow"><strong><span aria-hidden="true">{{ option.icon }} </span>{{ option.label }}</strong><span class="small muted block">{{ option.explain }}</span></span>
        </label>
      </fieldset>
      <p v-if="formError" class="notice coral" role="alert">{{ formError }}</p>
      <div class="row">
        <button class="btn primary" type="submit" :disabled="saving">{{ saving ? 'Opening…' : 'Start community' }}</button>
        <button class="btn ghost" type="button" @click="closeForm">Cancel</button>
      </div>
    </form>

    <StateView v-if="state !== 'ready'" :state="state" :message="error" @retry="reload" />
    <StateView v-else-if="!total" state="empty" art="🏘" title="No communities yet" message="A community is a group with its own posts, members and weekly game board. Start the first one.">
      <button v-if="!creating" ref="emptyStart" class="btn primary sm" type="button" @click="openForm">Start a community</button>
    </StateView>
    <template v-else>
      <input v-if="total > 6" v-model="query" class="input" type="search" placeholder="Filter by name, topic or area" aria-label="Filter communities by name, topic or area" />

      <section class="stack tight" aria-labelledby="communities-mine">
        <div class="section-head"><h2 id="communities-mine">Yours</h2></div>
        <ul v-if="mine.length" class="plain-list">
          <CommunityCard v-for="entry in mine" :key="entry.id" :community="entry" />
        </ul>
        <p v-else class="small muted">{{ query.trim() ? 'None of your communities matches that filter.' : 'You have not joined a community yet. Join one below, or start your own.' }}</p>
      </section>

      <section class="stack tight" aria-labelledby="communities-discover">
        <div class="section-head"><h2 id="communities-discover">Discover</h2></div>
        <ul v-if="discover.length" class="plain-list">
          <CommunityCard v-for="entry in discover" :key="entry.id" :community="entry" :invited="invited(entry)">
            <button class="btn sm" :class="{ primary: invited(entry) }" type="button" :disabled="joining !== null" :aria-label="`Join ${entry.name}`" @click="join(entry)">{{ joining === entry.id ? 'Joining…' : invited(entry) ? 'Accept and join' : 'Join' }}</button>
          </CommunityCard>
        </ul>
        <p v-else class="small muted">{{ query.trim() ? 'No other community matches that filter.' : 'Nothing else to discover right now. Public communities, and ones you are invited to, show here.' }}</p>
      </section>
    </template>
  </PanelPage>
</template>

<style scoped src="./window.css"></style>
<style scoped>
h2 { font-size: 1rem; }
.two { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; }
.suggestions { gap: 6px 8px; margin-top: -4px; }
.suggestion { min-width: 0; max-width: 100%; }
.note { flex: 1 1 100%; }
.group { display: flex; flex-direction: column; gap: 8px; min-width: 0; margin: 0; padding: 0; border: 0; }
.group legend { padding: 0; margin-bottom: 8px; }
.option { display: flex; align-items: flex-start; gap: 10px; padding: 10px 12px; border: 1px solid var(--line-strong); border-radius: 12px; background: #fff; cursor: pointer; }
.option.on { border-color: #e9b752; background: var(--accent-soft); }
.option input { margin-top: 4px; accent-color: var(--accent-strong); width: 16px; height: 16px; flex: none; }
.block { display: block; }
</style>
