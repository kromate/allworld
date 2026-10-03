<script setup lang="ts">
const props = withDefaults(defineProps<{ optional?: boolean; blocked?: string; warning?: string }>(), { optional: false, blocked: '', warning: '' })
const emit = defineEmits<{ reload: []; later: [] }>()
</script>

<template>
  <div class="update-notice" role="status">
    <p class="words"><strong>{{ props.optional ? 'A game update is ready.' : 'The game was updated.' }}</strong> {{ props.optional ? 'You can keep playing and update when you are ready.' : 'Reload to carry on.' }} {{ props.blocked || props.warning || 'Saved character and progress stay with this world.' }}</p>
    <button class="btn primary sm" type="button" :disabled="Boolean(props.blocked)" @click="emit('reload')">Reload to update</button>
    <button v-if="props.optional" class="btn ghost sm" type="button" @click="emit('later')">Later</button>
  </div>
</template>

<style scoped>
.update-notice { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; max-width: 100%; padding: 10px 14px; border-radius: 16px; background: var(--ink); color: #fff; font-size: 0.84rem; line-height: 1.35; box-shadow: var(--shadow); pointer-events: auto; }
/* The words give way before the button does: at 360 px the button takes a line of its own. */
.words { flex: 1 1 220px; min-width: 0; margin: 0; overflow-wrap: anywhere; }
.btn { flex: none; }
</style>
