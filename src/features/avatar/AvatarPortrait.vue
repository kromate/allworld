<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { MemberId } from '../../shared/ids.ts'
import type { AvatarLook, FaceScan } from '../../shared/model.ts'
import { loadMemberPortrait, portraitAccessEpoch, stockPortraitUrl } from './memberPortraits.ts'
const props = withDefaults(defineProps<{ look: AvatarLook; memberId?: MemberId; face?: FaceScan | null; faceKey?: string; size?: number; alt?: string }>(), { face: null, faceKey: 'preview', size: 128, alt: 'Character portrait' })
const root = ref<HTMLElement | null>(null)
const source = ref('')
const visible = ref(false)
let observer: IntersectionObserver | null = null
let controller: AbortController | null = null
let alive = true
async function render(): Promise<void> {
  controller?.abort()
  source.value = ''
  if (!visible.value || document.hidden) return
  const current = new AbortController()
  controller = current
  try {
    const image = await loadMemberPortrait({ look: props.look, memberId: props.memberId, face: props.face, key: props.faceKey, size: props.size, signal: current.signal })
    if (alive && !current.signal.aborted) source.value = image
  } catch { /* A stock portrait remains available while loading or if rendering is unavailable. */ }
}
onMounted(() => {
  if (typeof IntersectionObserver === 'undefined') { visible.value = true; return }
  observer = new IntersectionObserver(entries => { visible.value = entries.some(entry => entry.isIntersecting) })
  if (root.value) observer.observe(root.value)
})
watch(() => [props.look, props.face, props.faceKey, props.memberId, props.size, visible.value, portraitAccessEpoch.value], () => { void render() }, { deep: true, flush: 'sync' })
onBeforeUnmount(() => { alive = false; controller?.abort(); observer?.disconnect() })
</script>
<template><span ref="root" class="avatar-portrait"><img :src="source || stockPortraitUrl(look.body)" :alt="alt" :width="size" :height="size" /></span></template>
<style scoped>.avatar-portrait { display:inline-block; overflow:hidden; border-radius:inherit; aspect-ratio:1; flex-shrink:0; }.avatar-portrait img { display:block; width:100%; height:100%; object-fit:cover; }</style>
