<script setup lang="ts">
// One person in a list. The row stays short; opening it shows the full member card (introduce,
// challenge, visit, block, report) plus whatever the page adds for that person.
import { nextTick, ref } from 'vue'
import type { PublicMember } from '../../shared/model.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import MemberCard from './MemberCard.vue'

const props = defineProps<{
  member: PublicMember
  /** The same words as the chips, for the member card and for screen readers. */
  subtitle?: string
  /** What opening the row offers, read out after the name. */
  hint?: string
}>()
const emit = defineEmits<{ changed: [] }>()

const open = ref(false)
const toggle = ref<HTMLButtonElement | null>(null)
const isSelf = props.member.relation === 'self'

async function close(): Promise<void> {
  open.value = false
  await nextTick()
  toggle.value?.focus()
}
</script>

<template>
  <div class="person">
    <div v-if="isSelf" class="summary">
      <MemberBadge :member-id="member.id" :look="member.look" :size="36" />
      <span class="grow lines">
        <strong class="truncate">{{ member.displayName }}</strong>
        <span class="row wrap chips"><span class="chip ink">You</span><slot name="chips" /></span>
      </span>
    </div>
    <button v-else-if="!open" ref="toggle" class="summary" type="button" aria-expanded="false" :aria-label="`${member.displayName}${subtitle ? `, ${subtitle}` : ''}${member.online ? ', online' : ''}. ${hint ?? 'Show what you can do together'}`" @click="open = true">
      <MemberBadge :member-id="member.id" :look="member.look" :size="36" :online="member.online" />
      <span class="grow lines">
        <strong class="truncate">{{ member.displayName }}</strong>
        <span class="row wrap chips"><slot name="chips" /><span v-if="member.online" class="tiny muted">Online</span></span>
      </span>
      <span class="chevron" aria-hidden="true">›</span>
    </button>
    <div v-else class="detail stack">
      <MemberCard :member="member" :subtitle="subtitle" compact closable @close="close" @changed="emit('changed')" />
      <slot :close="close" />
    </div>
  </div>
</template>

<style scoped>
.summary { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 54px; padding: 7px 8px; border: 0; border-radius: 12px; background: transparent; text-align: left; }
button.summary:hover { background: rgba(28, 26, 36, 0.05); }
.lines { display: flex; flex-direction: column; gap: 3px; }
.chips { gap: 6px; }
.chevron { color: var(--muted); font-size: 1.3rem; line-height: 1; flex: none; }
.detail { padding: 12px; border: 1px solid var(--line); border-radius: 12px; background: var(--surface); }
</style>
