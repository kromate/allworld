<script setup lang="ts">
import { computed } from 'vue'
import { PAY } from '../play/playText.ts'
const props = defineProps<{ cost: number; balance: number; purpose: string; requiredBalance?: number }>()
const short = computed(() => Math.max(0, props.cost - props.balance))
const earningGap = computed(() => Math.max(0, Math.max(props.cost, props.requiredBalance ?? props.cost) - props.balance))
const perShift = 5 * (PAY.ticket + PAY.speedBonus)
</script>

<template>
  <div class="cost-preview" aria-label="Payment preview">
    <p>{{ purpose }}</p>
    <dl><div><dt>Cost</dt><dd>{{ cost.toLocaleString() }} 🪙</dd></div><div><dt>Your balance</dt><dd>{{ balance.toLocaleString() }}</dd></div><div><dt>{{ short ? 'Short by' : 'Balance after' }}</dt><dd :class="{ short }">{{ (short || balance - cost).toLocaleString() }}<span v-if="short"> 🪙</span></dd></div></dl>
    <p v-if="earningGap" class="earn"><template v-if="requiredBalance">You need {{ earningGap.toLocaleString() }} more coins for the fee and retained funds. </template><RouterLink to="/work">Earn coins at work</RouterLink>. A quick, correct café shift pays up to {{ perShift }} coins; at least {{ Math.ceil(earningGap / perShift) }} {{ Math.ceil(earningGap / perShift) === 1 ? 'shift' : 'shifts' }} at that rate covers this gap.</p>
  </div>
</template>

<style scoped>
.cost-preview { border: 1px solid var(--line); border-radius: 10px; padding: 12px; background: var(--surface-2); }
p { font-size: .77rem; color: var(--ink-2); }
dl { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin: 10px 0 0; }
dt { font-size: .7rem; color: var(--muted); }
dd { margin: 3px 0 0; font-size: .93rem; font-weight: 750; font-variant-numeric: tabular-nums; }
.short { color: var(--danger); }
.earn { margin-top: 10px; line-height: 1.5; }
</style>
