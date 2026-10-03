<script setup lang="ts">
// "Exit?" at a building's door: two big buttons and one box, shown only while the avatar stands at the door.
// It does not take the keyboard: the member is usually walking, so focus stays where it was; Tab reaches it, E
// (the action at the lower right) also leaves, and Escape means Stay (the stage's Escape order, see WorldStage).
// The box applies to Exit only. Ticking it and pressing Stay saves nothing.
import { ref } from 'vue'
defineProps<{ place: string }>()
const emit = defineEmits<{ exit: [remember: boolean]; stay: [] }>()
const remember = ref(false)
</script>

<template>
  <section class="doorway" role="group" aria-label="Leave this place?">
    <p class="doorway-title" role="status"><strong>Exit?</strong><span v-if="place" class="doorway-place truncate">{{ place }}</span></p>
    <div class="doorway-buttons">
      <button class="btn primary" type="button" @click="emit('exit', remember)">Exit</button>
      <button class="btn" type="button" @click="emit('stay')">Stay</button>
    </div>
    <label class="doorway-remember"><input v-model="remember" type="checkbox" /><span>Don’t ask again<small>Leave by this door on my own next time. Change it in Place and view.</small></span></label>
  </section>
</template>

<style scoped>
/* Narrow on purpose: the thumb pad at the lower left is up to 124 px wide plus its 10 px edge, so on a 360 px phone the card starts to the right of it. */
.doorway { display: grid; gap: 8px; width: min(236px, calc(100% - 132px)); margin-left: auto; padding: 10px 12px 6px; border-radius: 18px; background: rgba(255, 253, 249, 0.98); box-shadow: var(--shadow-lg); color: var(--ink); animation: doorway-in 0.16s ease-out; }
.doorway-title { display: flex; align-items: baseline; gap: 8px; margin: 0; min-width: 0; }
.doorway-title strong { font-size: 1.05rem; }
.doorway-place { min-width: 0; font-size: 0.78rem; color: var(--ink-2); }
.doorway-buttons { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.doorway-buttons .btn { min-height: 44px; }
.doorway-remember { display: flex; align-items: flex-start; gap: 10px; min-height: 44px; padding: 4px 0; font-size: 0.84rem; font-weight: 650; }
.doorway-remember input { flex: none; width: 22px; height: 22px; margin: 1px 0 0; accent-color: var(--accent-strong); }
.doorway-remember small { display: block; font-size: 0.72rem; font-weight: 500; color: var(--ink-2); }
@keyframes doorway-in { from { transform: translateY(6px); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .doorway { animation: none; } }
</style>
