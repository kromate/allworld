<script setup lang="ts">
// One match in a list: the game, who it is with, and where it stands in words. The row opens the
// match; anything in the default slot (accept, decline) sits beside it.
import { computed } from 'vue'
import type { Match } from '../../shared/play.ts'
import { myId } from '../../state/app.ts'
import MemberBadge from '../../ui/MemberBadge.vue'
import { count } from '../../ui/format.ts'
import { AUDIENCE, GAME, matchStatus, nameList, othersIn, playerOf } from './playText.ts'

const props = defineProps<{ match: Match }>()

const playing = computed(() => playerOf(props.match, myId()) !== null)
// Your own matches show the other players; a table you may watch shows everyone at it.
const people = computed(() => (playing.value ? othersIn(props.match, myId()) : props.match.players))
const names = computed(() => nameList(people.value.map(player => player.member.displayName)))
const status = computed(() => matchStatus(props.match, myId()))
</script>

<template>
  <div class="card match" :class="{ mine: status.mine }">
    <RouterLink class="open" :to="`/games/match/${match.id}`" :aria-label="`${GAME[match.game].name} ${playing ? 'with' : 'between'} ${names}. ${status.text}. Open the match.`">
      <span class="faces" aria-hidden="true">
        <MemberBadge v-for="player in people.slice(0, 3)" :key="player.member.id" :member-id="player.member.id" :look="player.member.look" :size="36" :online="player.member.online" />
        <span v-if="!people.length" class="icon-chip" :class="GAME[match.game].tone">{{ GAME[match.game].icon }}</span>
      </span>
      <span class="grow text">
        <span class="row" style="gap: 6px">
          <strong class="truncate">{{ names }}</strong>
          <span class="chip" :class="status.tone">{{ status.label }}</span>
        </span>
        <span class="small">{{ status.text }}</span>
        <span class="tiny muted">
          <span aria-hidden="true">{{ GAME[match.game].icon }}</span> {{ GAME[match.game].name }} · {{ AUDIENCE[match.audience].short }}{{ match.spectators ? ` · ${count(match.spectators, 'person', 'people')} watching` : '' }}
        </span>
      </span>
    </RouterLink>
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
.text { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.acts { margin-left: auto; }
</style>
