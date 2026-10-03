<script setup lang="ts">
// A button that asks once, in a plain sentence, before doing something that cannot be undone.
// The question opens in place; focus lands on the safe answer and returns to the button after.
import { nextTick, ref } from 'vue'

withDefaults(defineProps<{
  /** Text of the button that starts the action. */
  label: string
  /** The one sentence that says what will happen. */
  question: string
  confirmLabel: string
  cancelLabel?: string
  busy?: boolean
  disabled?: boolean
  /** Classes for the trigger button, for example "sm ghost danger". */
  buttonClass?: string
  /** Colour of the question: coral for removing things, amber for the rest. */
  tone?: 'coral' | 'amber' | 'leaf'
  /** Classes for the confirming button. */
  confirmClass?: string
}>(), { cancelLabel: 'Keep', busy: false, disabled: false, buttonClass: 'sm', tone: 'coral', confirmClass: 'dark' })
const emit = defineEmits<{ confirm: [] }>()

const open = ref(false)
const trigger = ref<HTMLButtonElement | null>(null)
const safe = ref<HTMLButtonElement | null>(null)

async function ask(): Promise<void> {
  open.value = true
  await nextTick()
  safe.value?.focus()
}
async function close(): Promise<void> {
  open.value = false
  await nextTick()
  trigger.value?.focus()
}
function confirm(): void {
  emit('confirm')
  void close()
}
</script>

<template>
  <div class="confirm" :class="{ open }">
    <button v-if="!open" ref="trigger" class="btn" :class="buttonClass" type="button" :disabled="disabled || busy" @click="ask"><slot>{{ label }}</slot></button>
    <div v-else class="notice ask" :class="tone" role="group" :aria-label="label" @keydown.esc.stop="close">
      <p>{{ question }}</p>
      <div class="row answers">
        <button class="btn sm" :class="confirmClass" type="button" :disabled="busy" @click="confirm">{{ confirmLabel }}</button>
        <button ref="safe" class="btn sm" type="button" @click="close">{{ cancelLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.confirm { display: inline-flex; max-width: 100%; }
.confirm.open { display: flex; flex: 1 1 100%; width: 100%; }
.ask { flex: 1; flex-wrap: wrap; align-items: center; }
.ask p { flex: 1 1 190px; }
.answers { flex-wrap: nowrap; gap: 8px; }
</style>
