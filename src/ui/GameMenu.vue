<script setup lang="ts">
// The Menu sheet on the world screen: every section of the App in one place, opened by the Menu
// button in the HUD's right-hand column. It replaces the always-on bar while the world is what is
// being played. It is not a pause: the world keeps running, and it says nothing about time stopping.
// It is a plain dialog, not a trap: Escape, the Close button, a tap outside or choosing a section
// all close it, and focus goes back to the Menu button.
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NAV } from './shell.ts'
import type { NavItem } from './shell.ts'
import HudIcon from './HudIcon.vue'
import { leaveInterior, world } from '../state/world.ts'
import { useMedia } from './hudDevice.ts'

defineProps<{ /** Unread counts, by section path. */ badges: Record<string, number> }>()
const open = defineModel<boolean>('open', { default: false })
const route = useRoute()
const sheet = ref<HTMLElement | null>(null)
const keyboard = useMedia('(hover: hover) and (pointer: fine)')

// Every section but the world itself, which is what is behind this sheet.
const items: readonly NavItem[] = [...NAV.filter(item => item.to !== '/'), { to: '/downloads', label: 'Downloads', glyph: 'save', key: '' }]
const badge = (count: number | undefined): string => (!count ? '' : count > 99 ? '99+' : String(count))
const indoors = computed(() => world.state === 'ready' && world.kind !== 'district')

function backToStreet(): void { open.value = false; void leaveInterior() }

watch(() => route.fullPath, () => { open.value = false })
watch(open, async value => {
  await nextTick()
  if (value) sheet.value?.querySelector<HTMLElement>('a, button')?.focus()
  // Closed without going anywhere: the keyboard goes back to the Menu button. Closed by choosing a page, it stays with the page.
  else if (route.path === '/' && (document.activeElement === document.body || sheet.value?.contains(document.activeElement))) document.querySelector<HTMLElement>('[data-hud-menu]')?.focus({ preventScroll: true })
})
</script>

<template>
  <div v-if="open" class="menu-layer" @click.self="open = false">
    <section id="shell-more" ref="sheet" class="menu-sheet" role="dialog" aria-label="Menu">
      <header class="menu-head">
        <h2>Menu</h2>
        <button class="close" type="button" aria-label="Close menu" @click="open = false"><HudIcon name="close" :size="20" /></button>
      </header>
      <ul class="menu-grid">
        <li v-for="item in items" :key="item.to">
          <RouterLink :to="item.to" class="menu-item" :aria-label="badges[item.to] ? `${item.label}, ${badges[item.to]} unread` : item.label" @click="open = false">
            <HudIcon :name="item.glyph" :size="24" />
            <span class="truncate">{{ item.label }}</span>
            <span v-if="badge(badges[item.to])" class="count num" aria-hidden="true">{{ badge(badges[item.to]) }}</span>
            <span v-if="keyboard && item.key" class="kbd" aria-hidden="true">{{ item.key }}</span>
          </RouterLink>
        </li>
      </ul>
      <button v-if="indoors" class="menu-street" type="button" @click="backToStreet"><HudIcon name="back" :size="20" /><span>Back to the street</span></button>
    </section>
  </div>
</template>

<style scoped>
.menu-layer { position: absolute; inset: 0; z-index: 30; background: rgba(28, 26, 36, 0.28); }
.menu-sheet {
  position: absolute; right: calc(8px + env(safe-area-inset-right, 0px)); top: calc(8px + env(safe-area-inset-top, 0px)); width: min(380px, calc(100% - 16px - env(safe-area-inset-left, 0px) - env(safe-area-inset-right, 0px)));
  max-height: calc(100% - 16px - env(safe-area-inset-top, 0px) - var(--safe-bottom)); overflow-y: auto; overscroll-behavior: contain; padding: 10px;
  border-radius: 20px; background: var(--surface); border: 1px solid var(--line-strong); box-shadow: var(--shadow-lg); animation: menu-in 0.16s ease-out;
}
@keyframes menu-in { from { transform: translateY(-6px); opacity: 0; } }
@keyframes menu-up { from { transform: translateY(10px); opacity: 0; } }
.menu-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 4px 8px 8px; }
.menu-head h2 { font-size: 1rem; }
.close { display: grid; place-items: center; width: 44px; height: 44px; border: 0; border-radius: 50%; background: transparent; color: var(--ink-2); }
.close:hover { background: var(--surface-2); }
.menu-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.menu-item { position: relative; display: grid; justify-items: center; align-content: center; gap: 3px; min-height: 68px; padding: 8px 4px; border-radius: 14px; color: var(--ink); text-decoration: none; font-size: 0.8rem; font-weight: 650; }
.menu-item:hover { background: var(--surface-2); }
.menu-item.router-link-active { background: var(--accent-soft); color: var(--accent-text); }
.menu-item .truncate { max-width: 100%; }
.count { position: absolute; top: 4px; right: 12%; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 0.68rem; font-weight: 700; line-height: 18px; text-align: center; box-shadow: 0 0 0 2px var(--surface); }
.menu-item .kbd { position: absolute; top: 4px; left: 6px; min-width: 0; padding: 0 4px; font-size: 0.62rem; opacity: 0.7; }
.menu-street { display: flex; align-items: center; justify-content: center; gap: 8px; width: 100%; min-height: 44px; margin-top: 6px; border: 1px solid var(--line-strong); border-radius: 14px; background: var(--surface-2); font-weight: 650; }
.menu-street:hover { background: var(--surface-3); }

/* Portrait phone: the sheet rises from the bottom edge, where the thumb is. */
@media (max-width: 600px) and (orientation: portrait) {
  .menu-sheet { right: 8px; left: 8px; top: auto; bottom: calc(8px + var(--safe-bottom)); width: auto; max-height: 70dvh; animation-name: menu-up; }
}
@media (max-height: 420px) {
  .menu-item { min-height: 60px; }
  .menu-grid { grid-template-columns: repeat(5, minmax(0, 1fr)); }
}
@media (prefers-reduced-motion: reduce) { .menu-sheet { animation: none; } }
</style>
