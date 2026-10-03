<script setup lang="ts">
// A home that is somebody else's. Looking and walking about only: nothing here edits it, and what
// the owner has built is told as it is, not changed.
import { computed } from 'vue'
import { houseType, roomKind } from '../../shared/homes.ts'
import type { Home } from '../../shared/social.ts'
import MemberBadge from '../../ui/MemberBadge.vue'

const props = defineProps<{ home: Home }>()
defineEmits<{ mine: []; leave: [] }>()
const label = (model: string): string => model.replace(/([A-Z0-9])/g, ' $1').replace(/^./, c => c.toUpperCase()).trim()
const type = computed(() => houseType(props.home.building.houseType))
const rooms = computed(() => props.home.building.plan.rooms)
</script>

<template>
  <div class="stack">
    <div class="row">
      <MemberBadge :member-id="home.owner.id" :look="home.owner.look" :size="44" :online="home.owner.online" />
      <div class="grow"><strong>{{ home.owner.displayName }}’s home</strong><div class="muted small">{{ home.policy === 'public' ? 'Open to everyone' : 'Open to friends' }} · {{ type.label }} · {{ rooms.length }} {{ rooms.length === 1 ? 'room' : 'rooms' }}</div></div>
    </div>
    <p class="muted small">You are visiting. Only {{ home.owner.displayName }} can change this home.</p>
    <div class="row wrap">
      <button class="btn primary" type="button" @click="$emit('mine')">Go to my home</button>
      <button class="btn" type="button" @click="$emit('leave')">Leave</button>
    </div>
    <details v-if="home.layout.items.length" class="disclosure">
      <summary>In this home <span class="chip num">{{ home.layout.items.length }}</span> <span class="chip">{{ rooms.map(room => roomKind(room.kind).label).join(' · ') }}</span></summary>
      <ul class="pieces">
        <li v-for="item in home.layout.items" :key="item.key" class="list-row">
          <span class="grow truncate">{{ label(item.model) }}</span>
          <RouterLink class="btn sm" :to="item.productId ? `/market/p/${item.productId}` : `/market?model=${item.model}`">{{ item.productId ? 'See this product' : 'Find real ones' }}</RouterLink>
        </li>
      </ul>
    </details>
  </div>
</template>

<style scoped>
.pieces { list-style: none; margin: 0; padding: 0; }
.pieces .list-row + .list-row { border-top: 1px solid var(--line); }
</style>
