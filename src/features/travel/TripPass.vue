<script setup lang="ts">
import { computed } from 'vue'
import type { Trip, TravelMode } from '../../shared/travel.ts'
import { visaFreeBetween } from '../../shared/travel.ts'
import { dateTimeIn } from '../../ui/format.ts'
import type { HubResult } from './hubs.ts'

const props = defineProps<{ trip: Trip; homeCountry: string | null; now: number; hub: HubResult | null }>()
const icon: Record<TravelMode, string> = { local: '🚶', bus: '🚌', rail: '🚆', flight: '✈' }
const elapsed = computed(() => Math.max(0, props.now - Date.parse(props.trip.departedAt)))
const left = computed(() => Math.max(0, Math.ceil((Date.parse(props.trip.arrivesAt) - props.now) / 1000)))
const progress = computed(() => Math.min(1, elapsed.value / Math.max(1, Date.parse(props.trip.arrivesAt) - Date.parse(props.trip.departedAt))))
const stage = computed(() => props.trip.status === 'arrived' ? 3 : elapsed.value < 4000 ? 0 : left.value > 4 ? 1 : 2)
const stageNames = ['Departing', 'In transit', 'Arrival checks', 'Arrived']
const borderLine = computed(() => {
  if (props.trip.from.countryCode === props.trip.to.countryCode) return 'Domestic arrival · no border documents needed'
  if (props.homeCountry === props.trip.to.countryCode) return 'Passport checked · returning home'
  const bloc = props.homeCountry ? visaFreeBetween(props.homeCountry, props.trip.to.countryCode) : null
  return bloc?.free ? `Passport checked · visa-free within ${bloc.bloc}` : 'Passport checked · visa checked'
})
</script>

<template>
  <section class="trip-pass" :aria-label="trip.status === 'arrived' ? 'Arrival receipt' : 'Journey in progress'">
    <div class="pass-band"><span>{{ icon[trip.mode] }} {{ stageNames[stage] }}</span><strong class="num">{{ trip.status === 'arrived' ? 'Welcome' : left ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Confirming…' }}</strong></div>
    <div class="pass-body">
      <ol v-if="trip.status !== 'arrived'" class="stages" aria-label="Journey stages"><li v-for="(label, index) in stageNames.slice(0, 3)" :key="label" :class="{ done: index < stage, active: index === stage }" :aria-current="index === stage ? 'step' : undefined"><span aria-hidden="true">{{ index < stage ? '✓' : index + 1 }}</span>{{ label }}</li></ol>
      <div class="pass-route"><div><small>{{ trip.from.countryCode }} · From</small><h2>{{ trip.from.label }}</h2></div><span aria-hidden="true">→</span><div><small>{{ trip.to.countryCode }} · To</small><h2>{{ trip.to.label }}</h2></div></div>
      <p v-if="hub?.kind === 'found'" class="hub"><span>From <strong>{{ hub.name }}</strong></span><a :href="hub.source" target="_blank" rel="noopener">Mapped {{ hub.category }}</a></p>
      <p v-else class="hub muted">{{ hub?.kind === 'missing' ? hub.reason : 'Departure hub was not confirmed. Route shown from the city.' }}</p>
      <div class="pass-times"><div><small>Departed · origin time</small><strong>{{ dateTimeIn(trip.departedAt, trip.from.timezone) }}</strong></div><div><small>{{ trip.status === 'arrived' ? 'Arrived' : 'Arrival' }} · destination time</small><strong>{{ dateTimeIn(trip.arrivesAt, trip.to.timezone) }}</strong></div></div>
      <progress v-if="trip.status !== 'arrived'" :value="progress" max="1" aria-label="Journey progress"></progress>
      <p class="border-check" :class="{ checked: stage >= 2 }"><span aria-hidden="true">{{ stage >= 2 ? '✓' : '◇' }}</span> {{ stage < 2 ? (trip.from.countryCode === trip.to.countryCode ? 'No border documents needed' : 'Documents cleared for arrival') : borderLine }}</p>
      <p v-if="stage < 2" class="small muted">Your journey continues when you close this window.</p>
      <p v-else-if="stage === 2" class="small muted">{{ left ? 'Preparing to enter your destination.' : 'Waiting for the service to confirm arrival.' }}</p>
    </div>
    <div class="pass-stub"><span>One traveller · fictional game ticket</span><strong>{{ trip.fare }} 🪙 paid</strong></div>
  </section>
</template>

<style scoped>
.trip-pass { flex: none; border: 1px solid var(--line-strong); border-radius: 14px; overflow: hidden; background: var(--surface); }
.pass-band { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 12px 16px; background: var(--ink); color: var(--accent); font-weight: 750; }
.pass-band strong { color: white; font-size: 1.16rem; }
.pass-body { padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.stages { list-style: none; padding: 0; margin: 0; display: flex; gap: 8px; justify-content: space-between; }
.stages li { display: flex; align-items: center; gap: 5px; font-size: .72rem; color: var(--muted); }
.stages span { display: grid; place-items: center; width: 21px; height: 21px; border-radius: 50%; background: var(--surface-3); font-weight: 750; }
.stages .active { color: var(--ink); font-weight: 750; }
.stages .active span { background: var(--accent); }
.stages .done span { color: #1f7447; background: var(--leaf-soft); }
.pass-route { display: grid; grid-template-columns: 1fr 20px 1fr; gap: 10px; align-items: center; }
.pass-route h2 { font-size: 1.12rem; overflow-wrap: anywhere; }
.pass-route small, .pass-times small { font-size: .72rem; color: var(--muted); display: block; margin-bottom: 4px; }
.pass-route > span { color: var(--muted); }
.hub { padding: 10px 12px; background: var(--surface-2); border-radius: 8px; font-size: .8rem; display: flex; flex-direction: column; gap: 4px; }
.hub a { font-size: .7rem; align-self: flex-start; }
.pass-times { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.pass-times strong { font-size: .77rem; font-weight: 650; display: block; }
progress { width: 100%; height: 8px; border: 0; border-radius: 5px; overflow: hidden; accent-color: var(--accent-strong); }
progress::-webkit-progress-bar { background: var(--surface-3); }
progress::-webkit-progress-value { background: var(--accent-strong); }
.border-check { font-size: .8rem; color: var(--ink-2); }
.border-check.checked { color: #1f7447; font-weight: 650; }
.pass-stub { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 6px; padding: 12px 16px; border-top: 1px dashed var(--line-strong); font-size: .72rem; background: var(--surface-2); }
@media(max-width:540px) { .pass-body { padding: 14px; gap: 13px; } .pass-route h2 { font-size: 1rem; } .stages { gap: 4px; } .stages li { font-size: .65rem; gap: 4px; } }
</style>
