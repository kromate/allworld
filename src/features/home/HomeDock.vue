<script setup lang="ts">
// The home's edge buttons in the world: three small ones for the owner, one for a visitor. They sit
// with the other prompts at the bottom, so the room and the character stay clear until a mode is
// chosen. A mode opens the home window; closing it returns to playing.
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { app } from '../../state/app.ts'
import { world } from '../../state/world.ts'
import { useStudio } from './useStudio.ts'

const route = useRoute()
const router = useRouter()
const studio = useStudio()
const unsaved = computed(() => studio.dirty.value || studio.planDirty.value)
// A payment whose outcome is not known yet must stay visible after the window is closed.
const paying = computed(() => studio.busy.value)
const open = (mode: 'home' | 'build' | 'buy'): void => { void router.push({ path: '/home', query: { mode } }) }
</script>

<template>
  <div v-if="world.kind === 'home' && route.path === '/'" class="home-toolbar" role="toolbar" aria-label="Home">
    <template v-if="world.canEditHome">
      <button class="btn sm glass" type="button" @click="open('build')">🧱 Build</button>
      <button class="btn sm glass" type="button" @click="open('buy')">🛋 Buy<span v-if="app.points !== null" class="chip amber num">{{ app.points }}</span></button>
      <button class="btn sm glass icon" type="button" aria-label="Home settings and visitors" @click="open('home')">
        ⋯<span v-if="unsaved || paying" class="dot" aria-hidden="true"></span><span v-if="paying" class="sr-only">A payment is waiting for its answer</span><span v-else-if="unsaved" class="sr-only">Unsaved changes</span>
      </button>
    </template>
    <button v-else class="btn sm glass" type="button" @click="router.push('/home')">🏠 About this home</button>
  </div>
</template>

<style scoped>
.home-toolbar { pointer-events: auto; display: flex; gap: 6px; align-items: center; justify-content: center; }
.home-toolbar .btn { position: relative; }
.dot { position: absolute; top: 6px; right: 6px; width: 8px; height: 8px; border-radius: 50%; background: var(--coral); }
</style>
