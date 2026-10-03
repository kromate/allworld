<script setup lang="ts">
// The home tab: its name, who may visit, where it is said to be, other homes to visit, and the
// receipts of what was bought. None of it changes the rooms or costs anything.
import type { HomeId } from '../../shared/ids.ts'
import type { VisitPolicy } from '../../shared/social.ts'
import { api, app, attempt } from '../../state/app.ts'
import { world } from '../../state/world.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import StateView from '../../ui/StateView.vue'
import { useLoad } from '../../ui/useLoad.ts'
import HomePlacement from './HomePlacement.vue'
import type { Studio } from './homeStudio.ts'

const props = defineProps<{ studio: Studio }>()
const emit = defineEmits<{ visit: [homeId: HomeId] }>()
const { state, dirty } = props.studio

const POLICY: Record<VisitPolicy, { label: string; about: string }> = {
  private: { label: 'Only me', about: 'Nobody else can come in. Anyone inside is shown out.' },
  friends: { label: 'Friends', about: 'People you have accepted as friends.' },
  public: { label: 'Everyone', about: 'Anyone can visit while you allow it.' },
}
const POLICIES = Object.keys(POLICY) as VisitPolicy[]
const visitable = useLoad(() => api('home.visitable', {}), [() => app.changed.homes, () => app.changed.friends])

async function setPolicy(policy: VisitPolicy): Promise<void> {
  const result = await attempt('home.setPolicy', { policy }, policy === 'private' ? 'Your home is private. Visitors inside were shown out.' : policy === 'friends' ? 'Friends can visit your home.' : 'Anyone can visit your home.')
  if (result) {
    state.home = result.home
    // The scene's own copy is replaced only when it is this very home: from a visit or the street it is somebody else's, or nobody's.
    if (world.kind === 'home' && world.home?.id === result.home.id) world.home = result.home
  }
}
const when = (iso: string): string => new Date(iso).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
</script>

<template>
  <div v-if="state.home" class="stack">
    <label class="field">
      <span>Home name</span>
      <input v-model="state.name" class="input" maxlength="48" />
    </label>
    <div v-if="dirty" class="row">
      <span class="grow small muted">Not saved yet</span>
      <button class="btn sm" type="button" :disabled="state.saving" @click="studio.discard()">Discard</button>
      <button class="btn primary sm" type="button" :disabled="state.saving" @click="studio.save()">{{ state.saving ? 'Saving…' : 'Save home' }}</button>
    </div>
    <p v-if="state.saveError" class="notice coral" role="alert">{{ state.saveError }}</p>

    <fieldset class="policy">
      <legend class="label">Who can visit</legend>
      <label v-for="policy in POLICIES" :key="policy" class="card choice" :class="{ on: state.home.policy === policy }">
        <input type="radio" class="sr-only" name="policy" :checked="state.home.policy === policy" @change="setPolicy(policy)" />
        <span class="grow"><strong>{{ POLICY[policy].label }}</strong><span class="muted small">{{ POLICY[policy].about }}</span></span>
      </label>
    </fieldset>

    <HomePlacement :studio="studio" />

    <details v-if="state.estate?.receipts.length" class="disclosure">
      <summary>Recent purchases <span class="chip num">{{ state.estate.receipts.length }}</span></summary>
      <ul class="receipts">
        <li v-for="receipt in state.estate.receipts" :key="receipt.id" class="list-row">
          <span class="grow"><strong class="small" style="display: block">{{ receipt.summary }}</strong><span class="muted tiny">{{ when(receipt.at) }}</span></span>
          <span class="num small">{{ receipt.total }} coins</span>
        </li>
      </ul>
    </details>

    <details class="disclosure">
      <summary>Visit other homes <span v-if="visitable.data.value?.homes.length" class="chip num">{{ visitable.data.value.homes.length }}</span></summary>
      <StateView v-if="visitable.state.value !== 'ready'" :state="visitable.state.value" :message="visitable.error.value" @retry="visitable.reload" />
      <p v-else-if="!visitable.data.value?.homes.length" class="muted small">No open doors yet. Homes of friends, and homes their owners opened to everyone, appear here. <RouterLink to="/people">Find people</RouterLink></p>
      <ul v-else class="receipts">
        <li v-for="home in visitable.data.value.homes" :key="home.homeId" class="list-row">
          <MemberBadge :member-id="home.owner.id" :look="home.owner.look" :size="40" :online="home.owner.online" />
          <span class="grow"><strong class="truncate" style="display: block">{{ home.name }}</strong><span class="muted tiny">{{ home.owner.displayName }} · {{ home.districtLabel }} · {{ home.policy === 'public' ? 'open to everyone' : 'friends' }}</span></span>
          <button class="btn sm" type="button" @click="emit('visit', home.homeId)">Visit</button>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.receipts { list-style: none; margin: 0; padding: 0; }
.receipts .list-row + .list-row { border-top: 1px solid var(--line); }
.policy { border: 0; margin: 0; padding: 0; display: grid; gap: 8px; }
.policy legend { margin-bottom: 6px; }
.choice { display: flex; cursor: pointer; border-width: 2px; }
.choice .grow { display: flex; flex-direction: column; }
.choice.on { border-color: var(--accent-strong); background: var(--accent-soft); }
</style>
