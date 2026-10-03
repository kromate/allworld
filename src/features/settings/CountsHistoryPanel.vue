<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { api, messageOf } from '../../state/app.ts'
import type { CountsHistory } from '../../shared/liveCounts.ts'
const owner = ref(false), history = ref<CountsHistory | null>(null), failure = ref(''), busy = ref(false)
onMounted(async () => { try { owner.value = (await api('counts.owner', {})).owner } catch { owner.value = false } })
async function load(): Promise<void> {
  if (busy.value) return
  busy.value = true; failure.value = ''
  try { history.value = await api('counts.history', {}) } catch (error) { history.value = null; failure.value = messageOf(error) }
  finally { busy.value = false }
}
</script>
<template>
  <section v-if="owner" aria-label="World aggregate counts">
    <h3>World counts</h3>
    <p>Hosted world totals. Daily online peaks count unique authenticated players, including brief reconnect grace.</p>
    <button type="button" :disabled="busy" @click="load">{{ busy ? 'Loading…' : 'View count history' }}</button>
    <p v-if="failure" role="status">{{ failure }}</p>
    <template v-if="history">
      <p>{{ history.totalViews.toLocaleString() }} page views since {{ new Date(history.since).toLocaleDateString() }}. Last 90 UTC days.</p>
      <table><caption>Daily aggregate history</caption><thead><tr><th scope="col">UTC day</th><th scope="col">Views</th><th scope="col">Online peak</th></tr></thead>
        <tbody><tr v-for="day in history.days" :key="day.day"><th scope="row">{{ day.day }}</th><td>{{ day.views.toLocaleString() }}</td><td>{{ day.onlinePeak.toLocaleString() }}</td></tr></tbody>
      </table>
    </template>
  </section>
</template>
