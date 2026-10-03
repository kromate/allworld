<script setup lang="ts">
// The bar along the bottom while a page is open over the world: five sections, and More for the rest.
// On the world screen itself the bar is not drawn; GameMenu (the Menu button's sheet) lists the same sections. Where the
// screen is wide enough for every section, they sit on the bar and More steps aside.
import { computed, nextTick, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { NAV, sectionOf } from './shell.ts'
import HudIcon from './HudIcon.vue'
import FullscreenControl from './FullscreenControl.vue'

const props = defineProps<{ /** Unread counts, by section path. */ badges: Record<string, number> }>()
/** The More menu. The shell owns it so that Escape closes one thing at a time. */
const open = defineModel<boolean>('open', { default: false })
const route = useRoute()
const sheet = ref<HTMLElement | null>(null)
const moreButton = ref<HTMLButtonElement | null>(null)

const bar = NAV.filter(item => !item.menuOnly)
const rest = NAV.filter(item => !item.primary)
const section = computed(() => sectionOf(route.path, route.meta.nav))
const inMore = computed(() => rest.some(item => item.to === section.value))
const waiting = computed(() => rest.reduce((sum, item) => sum + (props.badges[item.to] ?? 0), 0))
const badge = (count: number | undefined): string => (!count ? '' : count > 99 ? '99+' : String(count))

watch(() => route.fullPath, () => { open.value = false })
watch(open, async value => {
  await nextTick()
  if (value) sheet.value?.querySelector<HTMLElement>('a')?.focus()
  // Closed without going anywhere: the keyboard goes back to the button that opened it.
  else if (document.activeElement === document.body) moreButton.value?.focus({ preventScroll: true })
})
</script>

<template>
  <!-- `dock` is the name the width probes in scripts/qa look for. -->
  <nav class="shell-nav dock" aria-label="Sections">
    <!-- Pressing the section that is open closes it, back to the world. -->
    <RouterLink
      v-for="item in bar" :key="item.to" :to="section === item.to && item.to !== '/' ? '/' : item.to" class="nav-item" :class="{ active: section === item.to, extra: !item.primary }"
      :aria-current="section === item.to ? 'page' : undefined" :title="`${item.label} (${item.key})`"
    >
      <HudIcon class="nav-icon" :name="item.glyph" :size="22" />
      <span class="nav-label">{{ item.label }}</span>
      <span v-if="badge(badges[item.to])" class="count-badge num" :aria-label="`${badges[item.to]} unread`">{{ badge(badges[item.to]) }}</span>
    </RouterLink>
    <button ref="moreButton" class="nav-item more" :class="{ active: inMore || open }" type="button" :aria-expanded="open" aria-controls="shell-more" @click="open = !open">
      <HudIcon class="nav-icon" name="menu" :size="22" />
      <span class="nav-label">More</span>
      <span v-if="badge(waiting)" class="count-badge num" :aria-label="`${waiting} unread`">{{ badge(waiting) }}</span>
    </button>
  </nav>

  <div v-if="open" class="more-layer" @click.self="open = false">
    <section id="shell-more" ref="sheet" class="more-sheet" role="dialog" aria-label="More sections">
      <FullscreenControl />
      <ul class="more-grid">
        <li v-for="item in rest" :key="item.to">
          <RouterLink :to="item.to" class="more-item" :class="{ active: section === item.to }" :aria-current="section === item.to ? 'page' : undefined" @click="open = false">
            <HudIcon class="more-icon" :name="item.glyph" :size="24" />
            <span class="truncate">{{ item.label }}</span>
            <span v-if="badge(badges[item.to])" class="count-badge num" :aria-label="`${badges[item.to]} unread`">{{ badge(badges[item.to]) }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.shell-nav { position: absolute; left: 50%; bottom: calc(12px + var(--safe-bottom)); transform: translateX(-50%); z-index: 18; display: flex; gap: 4px; padding: 6px; border-radius: 22px; background: rgba(28, 26, 36, 0.84); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); border: 1px solid rgba(255, 255, 255, 0.16); box-shadow: var(--shadow-lg); max-width: calc(100% - 16px); }
.nav-item { position: relative; display: grid; justify-items: center; align-content: center; gap: 1px; min-width: 62px; min-height: 50px; padding: 6px 6px 4px; border: 0; border-radius: 16px; background: transparent; color: rgba(255, 255, 255, 0.82); text-decoration: none; font-size: 0.7rem; font-weight: 650; transition: background 0.15s ease, transform 0.1s ease; flex: none; }
.nav-item:hover { background: rgba(255, 255, 255, 0.12); color: #fff; }
.nav-item:active { transform: scale(0.95); }
.nav-item.active { background: linear-gradient(180deg, #ffbe3d, var(--accent)); color: var(--accent-ink); }
.nav-icon { margin-bottom: 1px; }
.nav-label { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.count-badge { position: absolute; top: 2px; right: 6px; min-width: 18px; padding: 0 5px; border-radius: 999px; background: var(--coral); color: #fff; font-size: 0.68rem; font-weight: 700; line-height: 18px; text-align: center; box-shadow: 0 0 0 2px rgba(28, 26, 36, 0.9); }
.more { display: none; }

.more-layer { position: absolute; inset: 0; z-index: 17; background: rgba(28, 26, 36, 0.3); }
.more-sheet { position: absolute; left: 8px; right: 8px; bottom: calc(var(--shell-nav) + 8px); max-width: 420px; max-height: calc(100dvh - var(--shell-nav) - 24px - env(safe-area-inset-top, 0px)); overflow-y: auto; overscroll-behavior: contain; margin: 0 auto; padding: 8px; border-radius: 20px; background: var(--surface); border: 1px solid var(--line-strong); box-shadow: var(--shadow-lg); animation: more-rise 0.16s ease; }
@keyframes more-rise { from { transform: translateY(10px); opacity: 0; } }
.more-grid { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 4px; }
.more-item { position: relative; display: grid; justify-items: center; align-content: center; gap: 2px; min-height: 64px; padding: 8px 4px; border-radius: 14px; color: var(--ink); text-decoration: none; font-size: 0.8rem; font-weight: 650; }
.more-item:hover { background: var(--surface-2); }
.more-item.active { background: var(--accent-soft); color: var(--accent-text); }
.more-item .truncate { max-width: 100%; }
.more-icon { margin-bottom: 2px; }
.more-item .count-badge { right: 14%; box-shadow: 0 0 0 2px var(--surface); }

/* Not enough room for every section: five stay, the rest go under More. */
@media (max-width: 860px), (pointer: coarse) {
  .extra { display: none; }
  .more { display: grid; }
}
@media (min-width: 861px) and (pointer: fine) { .more-layer { display: none; } }
/* On a phone the bar is the bottom edge of the screen, and pages stop above it. Its height is --shell-nav. */
@media (max-width: 720px) {
  .shell-nav { left: 0; right: 0; bottom: 0; transform: none; max-width: none; gap: 2px; padding: 4px 6px calc(4px + var(--safe-bottom)); border: 0; border-radius: 0; background: #1c1a24; box-shadow: 0 -1px 0 rgba(255, 255, 255, 0.12); backdrop-filter: none; -webkit-backdrop-filter: none; }
  .nav-item { flex: 1 1 0; min-width: 0; }
}
</style>
