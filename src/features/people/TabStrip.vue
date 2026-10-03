<script setup lang="ts">
// A row of tabs with the keyboard behaviour people expect: arrows, Home and End move between tabs.
import { nextTick, ref } from 'vue'

const props = defineProps<{
  tabs: { id: string; label: string; icon?: string; count?: number; countLabel?: string }[]
  modelValue: string
  label: string
  /** Prefix for element ids, so the page can point its tab panel back at the selected tab. */
  name: string
}>()
const emit = defineEmits<{ 'update:modelValue': [id: string] }>()
const strip = ref<HTMLElement | null>(null)

function onKey(event: KeyboardEvent): void {
  const index = props.tabs.findIndex(tab => tab.id === props.modelValue)
  const last = props.tabs.length - 1
  let next = -1
  if (event.key === 'ArrowRight') next = index >= last ? 0 : index + 1
  else if (event.key === 'ArrowLeft') next = index <= 0 ? last : index - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = last
  const target = props.tabs[next]
  if (!target) return
  event.preventDefault()
  emit('update:modelValue', target.id)
  void nextTick(() => strip.value?.querySelector<HTMLElement>(`#${props.name}-tab-${target.id}`)?.focus())
}
</script>

<template>
  <div class="strip-wrap">
    <div ref="strip" class="tabs" role="tablist" :aria-label="label" @keydown="onKey">
      <button
        v-for="tab in tabs" :id="`${name}-tab-${tab.id}`" :key="tab.id" class="tab" type="button" role="tab"
        :aria-selected="modelValue === tab.id" :aria-controls="`${name}-panel`" :tabindex="modelValue === tab.id ? 0 : -1"
        @click="emit('update:modelValue', tab.id)"
      >
        <span v-if="tab.icon" class="tab-icon" aria-hidden="true">{{ tab.icon }}</span>
        <span>{{ tab.label }}</span>
        <span v-if="tab.count" class="count num"><span aria-hidden="true">{{ tab.count > 99 ? '99+' : tab.count }}</span><span class="sr-only">, {{ tab.countLabel ?? `${tab.count} waiting` }}</span></span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.strip-wrap { container-type: inline-size; }
.tab { min-height: 40px; padding: 0 10px; }
@container (max-width: 400px) {
  .tab { padding: 0 6px; gap: 4px; font-size: 0.84rem; }
  .tab-icon { display: none; }
}
</style>
