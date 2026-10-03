<script setup lang="ts">
// One wave: someone waved at you (wave back, or not now), or the two of you waved at each other
// and the next step is an introduction. Used on the HUD and in People.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import type { Wave } from '../../shared/direct.ts'
import { dismissWave, introduceAfterWave, messageMember, waveBack } from '../../state/social.ts'
import MemberBadge from '../../ui/MemberBadge.vue'

const props = defineProps<{ wave: Wave; compact?: boolean; highlight?: boolean }>()
const router = useRouter()
const busy = ref(false)
const other = computed(() => (props.wave.mine ? props.wave.to : props.wave.from))
const mutual = computed(() => props.wave.status === 'returned')

async function back(): Promise<void> { busy.value = true; await waveBack(props.wave); busy.value = false }
async function introduce(): Promise<void> { busy.value = true; await introduceAfterWave(props.wave); busy.value = false }
</script>

<template>
  <article class="wave" :class="{ compact, highlight }" :aria-label="mutual ? `You and ${other.displayName} waved at each other` : `${other.displayName} waved at you`">
    <MemberBadge :member-id="other.id" :look="other.look" :size="compact ? 34 : 40" :online="other.online" />
    <div class="grow text">
      <p class="line"><strong>{{ other.displayName }}</strong> {{ mutual ? 'and you waved at each other' : 'waved at you' }} <span aria-hidden="true">👋</span></p>
      <p class="muted tiny">
        <template v-if="!mutual">{{ wave.contextText }}</template>
        <template v-else-if="other.relation === 'intro-sent'">Your introduction is waiting for their answer.</template>
        <template v-else-if="other.relation === 'intro-received'">They sent you an introduction.</template>
        <template v-else>Introduce yourself to become friends and message each other.</template>
      </p>
    </div>
    <div class="row actions">
      <template v-if="!mutual">
        <button class="btn primary sm" type="button" :disabled="busy" @click="back">Wave back</button>
        <button v-if="other.relation === 'friend'" class="btn sm" type="button" @click="messageMember(other.id); dismissWave(wave)">Message</button>
        <button v-if="other.relation === 'friend'" class="btn ghost icon sm" type="button" :aria-label="`Put away the wave from ${other.displayName}`" @click="dismissWave(wave)">✕</button>
        <button v-else class="btn ghost sm" type="button" :aria-label="`Not now: put away the wave from ${other.displayName}`" @click="dismissWave(wave)">Not now</button>
      </template>
      <template v-else>
        <button v-if="other.relation === 'none'" class="btn primary sm" type="button" :disabled="busy" @click="introduce">Introduce yourself</button>
        <button v-else-if="other.relation === 'intro-received'" class="btn primary sm" type="button" @click="router.push('/people?tab=requests')">Answer</button>
        <button class="btn ghost icon sm" type="button" :aria-label="`Put away the wave with ${other.displayName}`" @click="dismissWave(wave)">✕</button>
      </template>
    </div>
  </article>
</template>

<style scoped>
.wave { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 10px; padding: 10px 12px; border-radius: 14px; background: linear-gradient(135deg, #fff6df, #fffdf9 70%); border: 1px solid #f4dfae; }
.text { flex: 1 1 150px; }
.line { overflow-wrap: anywhere; }
.actions { gap: 6px; margin-left: auto; }
.wave.compact { padding: 8px 10px; }
.wave.highlight { box-shadow: 0 0 0 3px var(--accent-soft), 0 0 0 4px var(--accent-strong); }
</style>
