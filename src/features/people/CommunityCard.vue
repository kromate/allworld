<script setup lang="ts">
// A community in a list: what it is about, where it says it is, how many are in it and the
// viewer's place in it. The whole card opens the community; a slot holds an action such as Join.
import type { CommunitySummary } from '../../shared/social.ts'
import { count } from '../../ui/format.ts'
import { ROLE, topicMeta } from './labels.ts'

defineProps<{ community: CommunitySummary; invited?: boolean }>()
</script>

<template>
  <li class="card community" :class="{ 'tint-amber': invited }">
    <RouterLink class="open" :to="`/communities/${community.id}`">
      <span class="icon-chip" :class="topicMeta(community.topic).tone" aria-hidden="true">{{ topicMeta(community.topic).icon }}</span>
      <span class="grow body">
        <strong class="wrap-any">{{ community.name }}</strong>
        <span v-if="community.about" class="small muted about">{{ community.about }}</span>
        <!-- One line of facts; a chip only for what concerns the viewer. -->
        <span class="tiny muted wrap-any">{{ topicMeta(community.topic).label }} · {{ community.areaLabel }} · {{ count(community.memberCount, 'member') }}{{ community.visibility === 'invite-only' ? ' · invite-only' : '' }}</span>
        <span v-if="invited || (community.myRole && community.myRole !== 'member')" class="row wrap chips">
          <span v-if="invited" class="chip coral"><span aria-hidden="true">✉</span>You’re invited</span>
          <span v-if="community.myRole && community.myRole !== 'member'" class="chip" :class="ROLE[community.myRole].tone">You: {{ ROLE[community.myRole].label }}</span>
        </span>
      </span>
      <span v-if="!$slots.default" class="chevron" aria-hidden="true">›</span>
    </RouterLink>
    <div v-if="$slots.default" class="row actions"><slot /></div>
  </li>
</template>

<style scoped>
.community { padding: 0; overflow: hidden; }
.open { display: flex; align-items: flex-start; gap: 12px; padding: 14px; color: inherit; text-decoration: none; border-radius: var(--radius); }
.open:hover { background: rgba(28, 26, 36, 0.03); }
.body { display: flex; flex-direction: column; gap: 4px; }
.about { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.chips { gap: 6px; margin-top: 2px; }
.chevron { color: var(--muted); font-size: 1.3rem; line-height: 1; align-self: center; }
.actions { padding: 0 14px 14px 64px; }
</style>
