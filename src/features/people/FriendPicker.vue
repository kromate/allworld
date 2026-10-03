<script setup lang="ts">
// Choose several friends at once: tap to toggle, or select everyone shown and clear in one go.
import { computed, ref } from 'vue'
import type { MemberId } from '../../shared/ids.ts'
import type { PublicMember } from '../../shared/model.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { isAutomaticFriend } from '../creator/creatorView.ts'
import { nameList } from './labels.ts'

const props = defineProps<{
  friends: PublicMember[]
  modelValue: MemberId[]
  /** What the group of buttons is for, read out to screen readers. */
  label: string
  /** The service's limit on how many can be chosen, when it has one. */
  max?: number
  /** Friends who cannot be chosen again, with the word that says why (for example "Invited"). */
  done?: MemberId[]
  doneLabel?: string
  /** Starts the "who is chosen" line, for example "Inviting". */
  chosenPrefix: string
}>()
const emit = defineEmits<{ 'update:modelValue': [ids: MemberId[]] }>()

const query = ref('')
const isDone = (id: MemberId): boolean => Boolean(props.done?.includes(id))
// Everything this picker is used for (a meetup, a community invitation) is between friends who
// both accepted. A friendship the service made is a friend to message, not one to invite, so it
// is never a choice here, whatever list the caller passes.
const accepted = computed(() => props.friends.filter(friend => !isAutomaticFriend(friend)))
const shown = computed(() => {
  const text = query.value.trim().toLowerCase()
  return accepted.value.filter(friend => !text || friend.displayName.toLowerCase().includes(text))
})
const selectable = computed(() => shown.value.filter(friend => !isDone(friend.id)))
const chosen = computed(() => accepted.value.filter(friend => props.modelValue.includes(friend.id)))
const full = computed(() => props.max !== undefined && props.modelValue.length >= props.max)
const allShownChosen = computed(() => selectable.value.length > 0 && selectable.value.every(friend => props.modelValue.includes(friend.id)))

function toggle(id: MemberId): void {
  if (props.modelValue.includes(id)) emit('update:modelValue', props.modelValue.filter(entry => entry !== id))
  else if (!full.value) emit('update:modelValue', [...props.modelValue, id])
}
function selectShown(): void {
  const next = [...props.modelValue]
  for (const friend of selectable.value) {
    if (props.max !== undefined && next.length >= props.max) break
    if (!next.includes(friend.id)) next.push(friend.id)
  }
  emit('update:modelValue', next)
}
</script>

<template>
  <div class="stack tight">
    <input v-if="accepted.length > 6" v-model="query" class="input" type="search" placeholder="Filter friends by name" aria-label="Filter friends by name" />
    <div class="row wrap bulk">
      <span class="small grow wrap-any" aria-live="polite">
        <template v-if="chosen.length"><strong>{{ chosenPrefix }}</strong> {{ nameList(chosen.map(friend => friend.displayName), 4) }}</template>
        <span v-else class="muted">Nobody chosen yet.</span>
      </span>
      <span class="row bulk-buttons">
        <button class="btn sm" type="button" :disabled="allShownChosen || !selectable.length || full" @click="selectShown">Select all{{ query.trim() ? ' shown' : '' }}</button>
        <button class="btn sm ghost" type="button" :disabled="!modelValue.length" @click="emit('update:modelValue', [])">Clear</button>
      </span>
    </div>
    <div v-if="shown.length" class="choices" role="group" :aria-label="label">
      <button
        v-for="friend in shown" :key="friend.id" class="choice" type="button" :aria-pressed="modelValue.includes(friend.id)"
        :disabled="isDone(friend.id) || (full && !modelValue.includes(friend.id))" @click="toggle(friend.id)"
      >
        <MemberBadge :member-id="friend.id" :look="friend.look" :size="30" />
        <span class="grow truncate">{{ friend.displayName }}</span>
        <span v-if="isDone(friend.id)" class="chip leaf">{{ doneLabel ?? 'Done' }}</span>
        <span v-else class="tick" aria-hidden="true">{{ modelValue.includes(friend.id) ? '✓' : '' }}</span>
      </button>
    </div>
    <p v-else class="muted small">No friend matches that name.</p>
    <p v-if="max !== undefined && full" class="tiny muted">That is the most you can choose at once ({{ max }}).</p>
  </div>
</template>

<style scoped>
.bulk { gap: 8px; }
.bulk-buttons { gap: 6px; flex: none; }
.choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 6px; }
.choice { display: flex; align-items: center; gap: 8px; min-height: 44px; min-width: 0; padding: 5px 9px 5px 6px; border: 1px solid var(--line-strong); border-radius: 12px; background: var(--surface); text-align: left; font-weight: 600; transition: background 0.15s ease, border-color 0.15s ease; }
.choice:hover:not(:disabled) { background: var(--surface-2); }
.choice[aria-pressed="true"] { background: var(--accent-soft); border-color: #e9b752; }
.choice:disabled { opacity: 0.6; cursor: not-allowed; }
.tick { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; border: 1.5px solid var(--line-strong); font-size: 0.74rem; font-weight: 800; flex: none; background: #fff; }
.choice[aria-pressed="true"] .tick { background: var(--accent); border-color: var(--accent-strong); color: var(--accent-ink); }
</style>
