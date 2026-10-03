<script setup lang="ts">
// The plan of the home on a bounded grid: the rooms, their doors, the front door, and the corners
// where a new room can go. It draws what the studio holds and says what was tapped; it decides nothing.
import { computed } from 'vue'
import { roomKind } from '../../shared/homes.ts'
import type { HomePlan, HomePlanDraft } from '../../shared/homes.ts'
import { wallOfDoor } from './homeLayout.ts'

const props = defineProps<{
  plan: HomePlanDraft
  /** The plan as the service has it: rooms not in it are new. */
  current: HomePlan
  /** The ground a house of this type may fill, in plan metres. */
  view: { x: number; z: number; width: number; depth: number }
  picked: string | null
  adding: { kind: string; width: number; depth: number; x: number | null; z: number | null } | null
  spots: { x: number; z: number }[]
}>()
const emit = defineEmits<{ pick: [roomId: string | null]; spot: [x: number, z: number] }>()

const known = computed(() => new Set(props.current.rooms.map(room => room.id)))
const doors = computed(() => props.plan.doors.flatMap(door => {
  const wall = wallOfDoor(props.plan, door)
  return wall ? [{ along: wall.along, x: wall.along === 'x' ? door.at : wall.line, z: wall.along === 'x' ? wall.line : door.at }] : []
}))
const front = computed(() => {
  const room = props.plan.rooms.find(entry => entry.id === props.plan.entrance.roomId)
  if (!room) return null
  const { side, at } = props.plan.entrance
  const x = side === 'north' || side === 'south' ? at : side === 'west' ? room.x : room.x + room.width
  const z = side === 'west' || side === 'east' ? at : side === 'north' ? room.z : room.z + room.depth
  const angle = { south: 0, west: 90, north: 180, east: -90 }[side]
  return { x, z, angle }
})
const ghostFits = computed(() => props.adding !== null && props.adding.x !== null && props.adding.z !== null)
const pad = 1.5
const box = computed(() => `${props.view.x - pad} ${props.view.z - pad} ${props.view.width + pad * 2} ${props.view.depth + pad * 2}`)
const aspect = computed(() => (props.view.width + pad * 2) / (props.view.depth + pad * 2))

function tapped(event: MouseEvent): void {
  const svg = event.currentTarget as SVGSVGElement
  const rect = svg.getBoundingClientRect()
  const viewWidth = props.view.width + pad * 2, viewDepth = props.view.depth + pad * 2
  // The drawing keeps its proportions inside the box: work out where the plan sits in it.
  const scale = Math.min(rect.width / viewWidth, rect.height / viewDepth)
  const left = rect.left + (rect.width - viewWidth * scale) / 2, top = rect.top + (rect.height - viewDepth * scale) / 2
  const x = (event.clientX - left) / scale + props.view.x - pad, z = (event.clientY - top) / scale + props.view.z - pad
  if (props.adding) { emit('spot', Math.round(x - props.adding.width / 2), Math.round(z - props.adding.depth / 2)); return }
  const room = props.plan.rooms.find(entry => x >= entry.x && x <= entry.x + entry.width && z >= entry.z && z <= entry.z + entry.depth)
  emit('pick', room ? room.id : null)
}
</script>

<template>
  <svg
    class="plan" :viewBox="box" :style="{ aspectRatio: aspect }" role="group" aria-label="Plan of your home. Each room is a button."
    preserveAspectRatio="xMidYMid meet" @click="tapped"
  >
    <defs>
      <pattern id="plan-grid" width="1" height="1" patternUnits="userSpaceOnUse"><path d="M 1 0 L 0 0 0 1" fill="none" stroke="#d9d1c2" stroke-width="0.04" /></pattern>
    </defs>
    <rect :x="view.x" :y="view.z" :width="view.width" :height="view.depth" fill="url(#plan-grid)" stroke="#bfb5a2" stroke-width="0.08" stroke-dasharray="0.5 0.35" rx="0.3" />
    <g v-if="adding">
      <circle v-for="spot in spots" :key="`${spot.x},${spot.z}`" :cx="spot.x" :cy="spot.z" r="0.14" fill="#3fae7a" opacity="0.55" />
    </g>
    <g v-for="room in plan.rooms" :key="room.id">
      <rect
        :x="room.x" :y="room.z" :width="room.width" :height="room.depth" :fill="room.floor"
        :stroke="picked === room.id ? '#f39a00' : known.has(room.id) ? '#6b5d4a' : '#3fae7a'" :stroke-width="picked === room.id ? 0.24 : 0.14"
        :stroke-dasharray="known.has(room.id) ? undefined : '0.4 0.25'" tabindex="0" role="button"
        :aria-label="`${roomKind(room.kind).label}, ${room.width} by ${room.depth} metres${known.has(room.id) ? '' : ', new'}`"
        :aria-pressed="picked === room.id" class="room" @keydown.enter.prevent.stop="emit('pick', room.id)" @keydown.space.prevent.stop="emit('pick', room.id)"
      />
      <text :x="room.x + room.width / 2" :y="room.z + room.depth / 2" class="name" text-anchor="middle" dominant-baseline="middle" :font-size="Math.min(0.9, room.width / 5)">{{ roomKind(room.kind).label }}</text>
      <text :x="room.x + room.width / 2" :y="room.z + room.depth / 2 + Math.min(0.9, room.width / 5) * 1.1" class="size" text-anchor="middle" dominant-baseline="middle" :font-size="Math.min(0.7, room.width / 6)">{{ room.width }} × {{ room.depth }}</text>
    </g>
    <rect
      v-if="adding && adding.x !== null && adding.z !== null" :x="adding.x" :y="adding.z" :width="adding.width" :height="adding.depth"
      fill="#3fae7a" fill-opacity="0.35" stroke="#3fae7a" stroke-width="0.2" stroke-dasharray="0.4 0.25" pointer-events="none"
    />
    <g v-for="(door, index) in doors" :key="index" pointer-events="none">
      <rect :x="door.along === 'x' ? door.x - 0.6 : door.x - 0.16" :y="door.along === 'x' ? door.z - 0.16 : door.z - 0.6" :width="door.along === 'x' ? 1.2 : 0.32" :height="door.along === 'x' ? 0.32 : 1.2" fill="#fffdf9" stroke="#6b5d4a" stroke-width="0.06" />
    </g>
    <g v-if="front" :transform="`translate(${front.x} ${front.z}) rotate(${front.angle})`" pointer-events="none">
      <rect x="-0.6" y="-0.16" width="1.2" height="0.32" fill="#f39a00" />
      <path d="M -0.45 0.35 L 0 1 L 0.45 0.35 Z" fill="#f39a00" />
    </g>
    <text v-if="adding && !ghostFits" :x="view.x + view.width / 2" :y="view.z + view.depth / 2" text-anchor="middle" class="none" font-size="0.9">No place for this size</text>
  </svg>
</template>

<style scoped>
.plan { width: 100%; max-height: min(30vh, 240px); display: block; background: var(--surface-2); border-radius: 12px; border: 1px solid var(--line); touch-action: manipulation; }
.room { cursor: pointer; fill-opacity: 0.9; }
.room:focus-visible { outline: none; stroke: #2f8fd6; stroke-width: 0.3; }
.name { fill: #3a3326; font-weight: 700; pointer-events: none; }
.size { fill: #5b523f; pointer-events: none; }
.none { fill: var(--danger); font-weight: 700; }
@media (max-height: 480px) { .plan { max-height: 150px; } }
</style>
