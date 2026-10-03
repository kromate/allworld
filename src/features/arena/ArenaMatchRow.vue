<script setup lang="ts">
// One match in a list: who is playing, which game on what terms, and where it stands in words.
// The row opens the match; anything in the default slot (accept, decline, cancel) sits beside it.
import { computed } from 'vue'
import type { ArenaMatch } from '../../shared/arena.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { GAME, gameName, opponentOf, ratingText, rowStatus, termsOf } from './arenaText.ts'

const props = defineProps<{ match: ArenaMatch }>()

const mine = computed(() => props.match.me.role === 'player' || props.match.me.role === 'invited')
const status = computed(() => rowStatus(props.match))
/** Your own games show who you are playing; a game you may watch shows both players. */
const people = computed(() => {
  const match = props.match
  if (match.status === 'waiting') return match.me.role === 'player' ? [] : match.players
  if (!mine.value || match.me.seat === null) return match.players
  const other = opponentOf(match)
  return other ? [other] : []
})
const title = computed(() => {
  const match = props.match
  if (match.status === 'waiting' && match.me.role === 'player') {
    if (match.invited) return match.invited.displayName
    return match.open === 'community' ? match.communityName ?? 'A community' : 'Anyone'
  }
  return people.value.map(player => player.name).join(' and ')
})
/**
 * The sentence under the name, only where it adds to the chip beside it: how a game ended, a draw
 * offer, or which community a seat is open to. "Sent" under the invited member's name needs no
 * "Waiting for …" as well; the link's own label still carries the full sentence.
 */
const line = computed(() => {
  const match = props.match
  if (match.status === 'active') return match.drawOffer !== null && status.value.mine ? status.value.text : ''
  if (match.status === 'waiting') return match.me.canAccept && match.open === 'community' ? status.value.text : ''
  return status.value.text
})
const watching = computed(() => props.match.watchers)
</script>

<template>
  <div class="card match" :class="{ mine: status.mine }">
    <RouterLink class="open" :to="`/arena/match/${match.id}`" :aria-label="`${gameName(match.game)}, ${title}. ${status.label}. ${status.text}. Open the game.`">
      <span class="faces" aria-hidden="true">
        <template v-for="player in people.slice(0, 2)" :key="player.seat">
          <MemberBadge v-if="player.member" :member-id="player.member.id" :look="player.member.look" :size="36" :online="player.member.online" />
          <span v-else class="icon-chip grape bot">🤖</span>
        </template>
        <MemberBadge v-if="!people.length && match.invited" :member-id="match.invited.id" :look="match.invited.look" :size="36" :online="match.invited.online" />
        <span v-else-if="!people.length" class="icon-chip" :class="GAME[match.game].tone">{{ GAME[match.game].icon }}</span>
      </span>
      <span class="grow text">
        <span class="row top">
          <strong class="truncate">{{ title }}</strong>
          <span class="chip" :class="status.tone">{{ status.label }}</span>
        </span>
        <span v-if="line" class="small line">{{ line }}</span>
        <span class="tiny muted">
          <span aria-hidden="true">{{ GAME[match.game].icon }}</span> {{ gameName(match.game) }} · {{ termsOf(match) }}<template v-if="match.status === 'active'"> · move {{ match.moveCount + 1 }}</template>
          <template v-if="people.length === 2 && people[0]!.rating !== null && people[1]!.rating !== null"> · {{ ratingText(people[0]!) }} v {{ ratingText(people[1]!) }}</template>
        </span>
      </span>
    </RouterLink>
    <span v-if="watching.count" class="watchers" :aria-label="`${watching.count} watching`">
      <span class="faces small-faces" aria-hidden="true"><MemberBadge v-for="member in watching.first.slice(0, 3)" :key="member.id" :member-id="member.id" :look="member.look" :size="22" /></span>
      <span class="tiny muted num" aria-hidden="true">{{ watching.count }} watching</span>
    </span>
    <div v-if="$slots.default" class="row acts"><slot /></div>
  </div>
</template>

<style scoped>
.match { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 12px; }
.match.mine { border-color: #f0c463; background: linear-gradient(135deg, #fff6df, #fffdf9 70%); }
.open { display: flex; align-items: center; gap: 12px; flex: 1 1 220px; min-width: 0; color: inherit; text-decoration: none; border-radius: 10px; }
.open:hover strong { text-decoration: underline; text-underline-offset: 3px; }
.faces { display: inline-flex; flex: none; padding-left: 10px; }
.faces > * { margin-left: -10px; }
.small-faces { padding-left: 6px; }
.small-faces > * { margin-left: -6px; }
.bot { width: 36px; height: 36px; border-radius: 32%; box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85); }
.text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.top { gap: 6px; }
.line { overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.watchers { display: inline-flex; align-items: center; gap: 6px; }
.acts { margin-left: auto; }
</style>
