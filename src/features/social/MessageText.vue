<script setup lang="ts">
// A message's words, unchanged. A link to a game on this app becomes a real link into it; every
// other address stays text. Nothing here is ever rendered as HTML.
import { computed } from 'vue'
import { messageParts } from './messageLinks.ts'

const props = defineProps<{ text: string }>()
const parts = computed(() => messageParts(props.text))
</script>

<template>
  <span class="text"><template v-for="(part, index) in parts" :key="index"><RouterLink v-if="part.to" class="match" :to="part.to" title="Open this game">{{ part.text }}</RouterLink><template v-else>{{ part.text }}</template></template></span>
</template>

<style scoped>
.match { color: inherit; font-weight: 700; text-decoration: underline; text-underline-offset: 2px; overflow-wrap: anywhere; }
.match:hover { text-decoration-thickness: 2px; }
</style>
