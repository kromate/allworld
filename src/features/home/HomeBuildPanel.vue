<script setup lang="ts">
// Build mode: rooms and the house. Pick a room on the plan to change it, or choose a kind to add
// one and see where it fits; the outline is also drawn on the floor of the room behind this window.
// Nothing here costs anything until the price has been shown and agreed to (HomeQuoteSheet).
import { computed } from 'vue'
import { HOME_RULES, HOUSE_TYPES, ROOM_KINDS, roomKind } from '../../shared/homes.ts'
import type { HouseTypeId } from '../../shared/homes.ts'
import { FLOOR_SWATCHES, WALL_SWATCHES, doorPositions, frontDoorOptions, viewOf, wallOfDoor } from './homeLayout.ts'
import type { Studio } from './homeStudio.ts'
import HomePlanView from './HomePlanView.vue'
import HomeStepper from './HomeStepper.vue'
import { plotDimensions, unoccupiedGround } from './homePlots.ts'

const props = defineProps<{ studio: Studio }>()
const { state, type, planProblem, stranded, blocked, busy } = props.studio
const home = computed(() => state.home)
const site = computed(() => home.value?.building.site ?? null)
const remaining = computed(() => home.value && site.value ? unoccupiedGround(home.value.building.plan, site.value.parcel.envelope) : null)
const plan = computed(() => state.plan)
const spots = computed(() => (state.adding ? props.studio.spotsForAdding() : []))
// What is drawn is the service's own table when it has sent one.
const houses = computed(() => state.catalog?.houseTypes ?? HOUSE_TYPES)
const chosenType = computed(() => houses.value.find(entry => entry.id === state.houseTo) ?? type.value)
const view = computed(() => (plan.value ? viewOf(plan.value, chosenType.value) : { x: 0, z: 0, width: 1, depth: 1 }))
const picked = computed(() => plan.value?.rooms.find(room => room.id === state.pickedRoom) ?? null)
const full = computed(() => (plan.value?.rooms.length ?? 0) >= type.value.maxRooms)
const label = (id: string): string => { const room = plan.value?.rooms.find(entry => entry.id === id); return room ? roomKind(room.kind).label : id }
const neighbours = computed(() => {
  const room = picked.value, draft = plan.value
  if (!room || !draft) return []
  return draft.rooms.filter(other => other.id !== room.id).flatMap(other => {
    const door = draft.doors.findIndex(entry => (entry.a === room.id && entry.b === other.id) || (entry.a === other.id && entry.b === room.id))
    const wall = wallOfDoor(draft, { a: room.id, b: other.id })
    return wall && doorPositions(wall).length ? [{ other, door, wall }] : []
  })
})
const frontOptions = computed(() => (picked.value && plan.value ? frontDoorOptions(plan.value, picked.value.id) : []))
const hasFront = computed(() => plan.value?.entrance.roomId === picked.value?.id)
const summary = computed(() => {
  const draft = plan.value, now = home.value?.building.plan
  if (!draft || !now) return ''
  const added = draft.rooms.filter(room => !now.rooms.some(entry => entry.id === room.id)).length
  const removed = now.rooms.filter(room => !draft.rooms.some(entry => entry.id === room.id)).length
  const parts = [added ? `+${added} room${added === 1 ? '' : 's'}` : '', removed ? `−${removed} room${removed === 1 ? '' : 's'}` : '', stranded.value.length ? `${stranded.value.length} piece${stranded.value.length === 1 ? '' : 's'} to storage` : ''].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'Changes to rooms'
})
const problem = computed(() => planProblem.value ?? blocked.value[0] ?? null)
const upgradeCost = (id: HouseTypeId): number | null => {
  const to = houses.value.find(entry => entry.id === id)
  return to && to.tier > type.value.tier ? to.price - type.value.price : null
}

function nextSpot(): void {
  const adding = state.adding
  if (!adding || !spots.value.length) return
  const index = spots.value.findIndex(spot => spot.x === adding.x && spot.z === adding.z)
  const next = spots.value[(index + 1) % spots.value.length]!
  props.studio.moveAdding(next.x, next.z)
}
function slide(dx: number, dz: number): void { const adding = state.adding; if (adding && adding.x !== null && adding.z !== null) props.studio.moveAdding(adding.x + dx, adding.z + dz) }
function setFront(side: 'north' | 'south' | 'east' | 'west'): void {
  const draft = plan.value, room = picked.value
  if (!draft || !room) return
  const option = frontDoorOptions(draft, room.id).find(entry => entry.side === side)
  if (!option) return
  const middle = option.positions[Math.floor(option.positions.length / 2)]!
  props.studio.moveFront({ roomId: room.id, side, at: middle })
}
function slideDoor(index: number, wall: { from: number; to: number }, step: number): void {
  const door = plan.value?.doors[index]
  if (!door) return
  const at = door.at + step
  if (at >= wall.from + HOME_RULES.doorWidth / 2 + HOME_RULES.doorMargin && at <= wall.to - HOME_RULES.doorWidth / 2 - HOME_RULES.doorMargin) props.studio.moveDoor(index, at)
}
</script>

<template>
  <div v-if="plan && home" class="stack">
    <HomePlanView
      :plan="plan" :current="home.building.plan" :view="view" :picked="state.pickedRoom" :adding="state.adding" :spots="spots"
      @pick="studio.pickRoom" @spot="studio.moveAdding"
    />

    <!-- Adding a room: kind chosen, now size and place. -->
    <section v-if="state.adding" class="card stack tight" aria-label="New room">
      <div class="row between">
        <strong>New {{ roomKind(state.adding.kind).label.toLowerCase() }}</strong>
        <span class="muted small num">{{ state.adding.width }} × {{ state.adding.depth }} m</span>
      </div>
      <div class="row wrap">
        <HomeStepper label="Width" :value="state.adding.width" :min="roomKind(state.adding.kind).min.width" :max="roomKind(state.adding.kind).max.width" unit="m" @change="studio.sizeAdding($event, state.adding!.depth)" />
        <HomeStepper label="Depth" :value="state.adding.depth" :min="roomKind(state.adding.kind).min.depth" :max="roomKind(state.adding.kind).max.depth" unit="m" @change="studio.sizeAdding(state.adding!.width, $event)" />
      </div>
      <div class="row wrap" role="group" aria-label="Move the new room">
        <button class="btn icon sm" type="button" aria-label="Move west" @click="slide(-1, 0)">←</button>
        <button class="btn icon sm" type="button" aria-label="Move north" @click="slide(0, -1)">↑</button>
        <button class="btn icon sm" type="button" aria-label="Move south" @click="slide(0, 1)">↓</button>
        <button class="btn icon sm" type="button" aria-label="Move east" @click="slide(1, 0)">→</button>
        <button class="btn sm" type="button" :disabled="spots.length < 2" @click="nextSpot">Next spot</button>
      </div>
      <p v-if="state.adding.x === null" class="problem small" role="alert">No place for a room this size.<template v-if="full"> {{ type.label }}s hold {{ type.maxRooms }} {{ type.maxRooms === 1 ? 'room' : 'rooms' }}: move up to add more.</template></p>
      <div class="row">
        <button class="btn primary" type="button" :disabled="state.adding.x === null" @click="studio.confirmAdding()">Add to plan</button>
        <button class="btn" type="button" @click="studio.cancelAdding()">Cancel</button>
      </div>
    </section>

    <!-- A room picked: size, colours, doors. -->
    <section v-else-if="picked" class="card stack tight" :aria-label="`${roomKind(picked.kind).label}`">
      <div class="row between">
        <strong>{{ roomKind(picked.kind).label }}</strong>
        <button class="btn ghost sm" type="button" @click="studio.pickRoom(null)">Done</button>
      </div>
      <div class="row wrap">
        <HomeStepper label="Width" :value="picked.width" :min="roomKind(picked.kind).min.width" :max="roomKind(picked.kind).max.width" unit="m" @change="studio.resizeRoom(picked.id, $event, picked.depth)" />
        <HomeStepper label="Depth" :value="picked.depth" :min="roomKind(picked.kind).min.depth" :max="roomKind(picked.kind).max.depth" unit="m" @change="studio.resizeRoom(picked.id, picked.width, $event)" />
      </div>
      <div class="swatches" role="group" aria-label="Floor colour">
        <button v-for="colour in FLOOR_SWATCHES" :key="colour" type="button" class="swatch" :style="{ background: colour }" :aria-pressed="picked.floor === colour" :aria-label="`Floor ${colour}`" @click="studio.recolour(picked.id, { floor: colour })"></button>
      </div>
      <div class="swatches" role="group" aria-label="Wall colour">
        <button v-for="colour in WALL_SWATCHES" :key="colour" type="button" class="swatch" :style="{ background: colour }" :aria-pressed="picked.wall === colour" :aria-label="`Wall ${colour}`" @click="studio.recolour(picked.id, { wall: colour })"></button>
      </div>
      <ul v-if="neighbours.length" class="doors">
        <li v-for="entry in neighbours" :key="entry.other.id" class="row">
          <span class="grow small">{{ label(entry.other.id) }}</span>
          <template v-if="entry.door >= 0">
            <button class="btn icon sm" type="button" :aria-label="`Move the door to the ${label(entry.other.id).toLowerCase()} back`" @click="slideDoor(entry.door, entry.wall, -0.5)">◀</button>
            <button class="btn icon sm" type="button" :aria-label="`Move the door to the ${label(entry.other.id).toLowerCase()} forward`" @click="slideDoor(entry.door, entry.wall, 0.5)">▶</button>
            <button class="btn sm" type="button" @click="studio.removeDoor(entry.door)">Close door</button>
          </template>
          <button v-else class="btn sm" type="button" @click="studio.addDoor(entry.other.id, picked.id, doorPositions(entry.wall)[Math.floor(doorPositions(entry.wall).length / 2)]!)">Add door</button>
        </li>
      </ul>
      <div v-if="hasFront || frontOptions.length" class="row wrap" role="group" aria-label="Front door">
        <span class="label small">Front door</span>
        <button v-for="option in frontOptions" :key="option.side" class="btn sm" type="button" :aria-pressed="hasFront && plan.entrance.side === option.side" @click="setFront(option.side)">{{ option.side }}</button>
      </div>
      <button v-if="picked.id !== 'r1'" class="btn sm danger" type="button" style="align-self: flex-start" @click="studio.removeRoom(picked.id)">Remove this room</button>
    </section>

    <!-- Nothing picked: add one. -->
    <section v-else class="stack tight" aria-label="Add a room">
      <p class="muted small">Tap a room to change it, or add one.</p>
      <div class="row wrap">
        <button v-for="kind in ROOM_KINDS.filter(entry => entry.id !== 'main')" :key="kind.id" class="btn sm" type="button" :disabled="full" @click="studio.startAdding(kind.id)">＋ {{ kind.label }}</button>
      </div>
      <p v-if="full" class="muted small">A {{ type.label.toLowerCase() }} holds {{ type.maxRooms }} {{ type.maxRooms === 1 ? 'room' : 'rooms' }}. Move up to add more.</p>
    </section>

    <details class="disclosure" :open="state.houseTo !== null">
      <summary>House · {{ type.label }} <span class="chip num">{{ plan.rooms.length }} / {{ type.maxRooms }} rooms</span></summary>
      <div class="houses" role="radiogroup" aria-label="Type of house">
        <button
          v-for="entry in houses" :key="entry.id" type="button" class="house" role="radio" :aria-checked="chosenType.id === entry.id"
          :disabled="entry.tier < type.tier" @click="state.houseTo = entry.tier > type.tier ? entry.id : null"
        >
          <svg viewBox="0 0 60 40" class="art" aria-hidden="true">
            <rect :x="30 - (14 + entry.tier * 4)" y="18" :width="(14 + entry.tier * 4) * 2" height="18" fill="#efe5d2" stroke="#6b5d4a" stroke-width="1.2" />
            <path :d="`M ${30 - (17 + entry.tier * 4)} 18 L 30 ${8 - entry.tier} L ${30 + (17 + entry.tier * 4)} 18 Z`" :fill="entry.exterior.roof" stroke="#3a3326" stroke-width="1" />
            <rect x="27" y="26" width="6" height="10" fill="#68452f" />
            <rect v-if="entry.tier >= 1" :x="30 - (10 + entry.tier * 3)" y="23" width="5" height="5" fill="#a9d6df" />
            <rect v-if="entry.tier >= 1" :x="30 + (5 + entry.tier * 3)" y="23" width="5" height="5" fill="#a9d6df" />
            <rect v-if="entry.tier >= 3" x="6" y="22" width="8" height="14" fill="#efe5d2" stroke="#6b5d4a" stroke-width="1.2" />
          </svg>
          <strong>{{ entry.label }}</strong>
          <span class="tiny muted num">{{ entry.maxRooms }} {{ entry.maxRooms === 1 ? 'room' : 'rooms' }} · plan limit {{ entry.plot.width }}×{{ entry.plot.depth }} m · {{ entry.itemLimit }} pieces</span>
          <span v-if="entry.id === type.id" class="chip leaf">Yours</span>
          <span v-else-if="upgradeCost(entry.id) !== null" class="chip amber num">{{ upgradeCost(entry.id) }} coins</span>
          <span v-else class="chip">Moves up only</span>
        </button>
      </div>
      <p class="small muted">A house upgrade raises room, plan and furniture limits. Your street plot keeps its current size. Build extra rooms separately within that area.</p>
      <p v-if="site" class="small muted">{{ site.status === 'valid' ? 'Current plot building area' : 'Last placed plot building area' }}: {{ plotDimensions(site.parcel.envelope) }}.<template v-if="site.status === 'valid' && remaining !== null"> Ground outside your saved house's outer walls: {{ remaining }}.</template> Room shape and door position still decide what fits. Resize existing rooms or compare larger plots if you need more space.</p>
      <div v-if="state.houseTo" class="row" style="margin-top: 8px">
        <p class="grow small">The dashed outline is the {{ chosenType.label.toLowerCase() }} plan limit. Extra rooms must also fit the plot building area.</p>
        <button class="btn primary" type="button" :disabled="busy" @click="studio.askHouse(state.houseTo!)">Get price</button>
      </div>
    </details>

    <div v-if="studio.planDirty.value" class="savebar" role="status">
      <span class="grow small" :class="{ problem }">{{ problem ?? summary }}</span>
      <button class="btn sm" type="button" @click="studio.adoptPlan()">Discard</button>
      <button class="btn primary" type="button" :disabled="Boolean(problem) || busy" @click="studio.askLayout()">Get price</button>
    </div>
  </div>
  <p v-else class="muted small">Your home is loading.</p>
</template>

<style scoped>
.swatches { display: flex; flex-wrap: wrap; gap: 8px; }
.swatch { width: 36px; height: 36px; border-radius: 50%; border: 2px solid var(--line-strong); padding: 0; }
.swatch[aria-pressed="true"] { border-color: var(--ink); box-shadow: 0 0 0 2px #fff inset; }
.doors { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.label { font-weight: 650; color: var(--ink-2); }
.problem { color: var(--danger); }
@media (pointer: coarse), (max-width: 720px) { .swatch { width: 44px; height: 44px; } .swatches { gap: 6px; } }
.houses { display: flex; gap: 8px; overflow-x: auto; padding: 4px 0; scroll-snap-type: x proximity; }
.house { flex: 0 0 148px; display: flex; flex-direction: column; align-items: flex-start; gap: 4px; padding: 8px; border-radius: 12px; border: 2px solid var(--line); background: var(--surface); text-align: left; scroll-snap-align: start; }
.house[aria-checked="true"] { border-color: var(--accent-strong); background: var(--accent-soft); }
.house:disabled { opacity: 0.55; cursor: not-allowed; }
.art { width: 100%; height: 56px; background: var(--sky-soft); border-radius: 8px; }
.savebar { position: sticky; bottom: -22px; margin: auto -18px -22px; padding: 10px 18px calc(12px + var(--safe-bottom)); display: flex; align-items: center; gap: 8px; background: var(--accent-soft); border-top: 1px solid #f4dfae; z-index: 1; }
@media (max-width: 720px) { .savebar { bottom: -18px; margin: auto -16px -18px; padding-inline: 16px; } }
</style>
