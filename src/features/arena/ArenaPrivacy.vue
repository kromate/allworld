<script setup lang="ts">
// "Show me in public standings". Mounted in the hall's Standings and offered to Settings → Privacy.
// Off removes the member from the state, country and global tables; friends and community tables,
// and the member's own rating, are unchanged.
import { computed, ref } from 'vue'
import { api, attempt } from '../../state/app.ts'
import { useLoad } from '../../ui/useLoad.ts'

const emit = defineEmits<{ changed: [shown: boolean] }>()
const { data, state } = useLoad(() => api('arena.privacy', {}))
const busy = ref(false)
const shown = computed(() => data.value?.publicStandings ?? true)
const where = computed(() => {
  const home = data.value?.home
  if (!home?.countryName) return 'Choose your area to join the standings for your state and your country.'
  if (!home.region) return `Your tables: ${home.countryName} and Global. Set your area again to join your state’s standings.`
  return `Your tables: ${home.region}, ${home.countryName} and Global.`
})

async function toggle(): Promise<void> {
  if (busy.value || !data.value) return
  busy.value = true
  const next = !shown.value
  const result = await attempt('arena.setPrivacy', { publicStandings: next }, next ? 'You are shown in public standings.' : 'You are hidden from public standings.')
  busy.value = false
  if (!result) return
  data.value = result
  emit('changed', result.publicStandings)
}
</script>

<template>
  <div class="card privacy">
    <div class="row">
      <span class="grow">
        <strong id="arena-privacy-label">Show me in public standings</strong>
        <span class="muted small note">Game standings by state, country and the whole world show your name, character and rating — never where you are. Off hides you from those three tables; friends and communities still see you, and you keep your rating.</span>
      </span>
      <button class="switch" type="button" role="switch" :aria-checked="shown" aria-labelledby="arena-privacy-label" :disabled="busy || state !== 'ready'" @click="toggle"></button>
    </div>
    <p v-if="state === 'ready'" class="tiny muted">{{ where }} <RouterLink v-if="!data?.home.region" to="/settings?tab=area">Set your area</RouterLink></p>
  </div>
</template>

<style scoped>
.privacy { display: flex; flex-direction: column; gap: 8px; }
.note { display: block; }
</style>
