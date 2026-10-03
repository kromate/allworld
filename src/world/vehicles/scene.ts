import * as THREE from 'three'
import type { MemberId, VehicleId } from '../../shared/ids.ts'
import { VEHICLE_RULES } from '../../shared/vehicles.ts'
import type { VehicleSnapshot, VehicleEvent } from '../../shared/vehicles.ts'
import type { AvatarActor } from '../avatars.ts'
import type { VehicleAvatarPose } from '../avatarVehiclePose.ts'
import { seatedGroupTransform } from '../avatarVehiclePose.ts'
import { createVehicleKit } from './models.ts'
import type { VehicleModel } from './models.ts'

const PRESENTATION_DELAY_MS = 100
const MAX_SAMPLE_GAP_MS = 250
const MAX_POSE_SAMPLES = 8

interface VehiclePoseSample {
  at: number
  x: number
  z: number
  heading: number
  steering: number
  clocked: boolean
}

function poseSample(snapshot: VehicleSnapshot, at: number): VehiclePoseSample {
  return { at, x: snapshot.pos.x, z: snapshot.pos.z, heading: snapshot.heading, steering: snapshot.steering, clocked: false }
}

function sameControl(a: VehicleSnapshot['control'], b: VehicleSnapshot['control']): boolean {
  switch (a.kind) {
    case 'none': return b.kind === 'none'
    case 'member': return b.kind === 'member' && a.driverId === b.driverId && a.controlEpoch === b.controlEpoch
    case 'service': return b.kind === 'service' && a.bookingMemberId === b.bookingMemberId
  }
}

interface RenderedVehicle {
  snapshot: VehicleSnapshot
  samples: VehiclePoseSample[]
  clockOrigin: number | null
  motionTick: number
  receivedAt: number
  presentationAt: number
  delayMs: number
  model: VehicleModel
  steering: number
  wheelRotation: number
  doors: Record<string, number>
  poses: Map<string, VehicleAvatarPose>
}

/** An authoritative vehicle is one transform, shared by every visible seated actor. */
export class VehicleScene {
  readonly root = new THREE.Group()
  private readonly kit = createVehicleKit()
  private readonly vehicles = new Map<VehicleId, RenderedVehicle>()
  private readonly seats = new Map<MemberId, { vehicle: RenderedVehicle; seatId: string }>()
  private readonly mounted = new Set<AvatarActor>()
  private readonly position = new THREE.Vector3()
  private readonly quaternion = new THREE.Quaternion()
  private readonly transitionPoint = new THREE.Vector3()

  sync(snapshots: readonly VehicleSnapshot[], motion?: Extract<VehicleEvent, { type: 'vehicle.move' }>): void {
    const now = performance.now()
    const wanted = new Set(snapshots.map(snapshot => snapshot.id))
    for (const [id, rendered] of this.vehicles) if (!wanted.has(id)) {
      this.clearActors(); rendered.model.dispose(); this.vehicles.delete(id)
    }
    this.seats.clear()
    for (const incoming of snapshots) {
      let snapshot = incoming
      let rendered = this.vehicles.get(snapshot.id)
      if (rendered && (rendered.snapshot.epoch !== snapshot.epoch || rendered.snapshot.kind !== snapshot.kind || rendered.snapshot.room.key !== snapshot.room.key || rendered.snapshot.room.instance !== snapshot.room.instance)) {
        this.clearActors(); rendered.model.dispose(); this.vehicles.delete(snapshot.id); rendered = undefined
      }
      if (!rendered) {
        const model = this.kit.create(snapshot.kind, { detail: 'near' })
        model.root.position.set(snapshot.pos.x, 0.105, snapshot.pos.z)
        model.root.rotation.y = snapshot.heading
        this.root.add(model.root)
        rendered = { snapshot, samples: [poseSample(snapshot, now)], clockOrigin: null, motionTick: -1, receivedAt: now, presentationAt: now - PRESENTATION_DELAY_MS, delayMs: PRESENTATION_DELAY_MS, model, steering: snapshot.steering, wheelRotation: 0, doors: {}, poses: new Map() }
        this.vehicles.set(snapshot.id, rendered)
      }
      const timed = motion?.vehicleId === snapshot.id && motion.epoch === snapshot.epoch && motion.room === snapshot.room.key && motion.pos.x === snapshot.pos.x && motion.pos.z === snapshot.pos.z && motion.heading === snapshot.heading && motion.steering === snapshot.steering && motion.speed === snapshot.speed ? motion : undefined
      if (rendered.snapshot.revision > snapshot.revision || timed && timed.tick <= rendered.motionTick) snapshot = rendered.snapshot
      const previous = rendered.snapshot
      const latest = rendered.samples.at(-1)
      const changed = snapshot.pos.x !== previous.pos.x || snapshot.pos.z !== previous.pos.z || snapshot.heading !== previous.heading || snapshot.steering !== previous.steering
      const reset = snapshot.speed === 0 || snapshot.phase !== previous.phase || !sameControl(snapshot.control, previous.control)
        || snapshot.transitions.length > 0 || snapshot.openEntries.length > 0
        || Math.hypot(snapshot.pos.x - previous.pos.x, snapshot.pos.z - previous.pos.z) > 20
        || changed && now - rendered.receivedAt > MAX_SAMPLE_GAP_MS
      if (reset) {
        rendered.samples = [poseSample(snapshot, now)]
        rendered.clockOrigin = null
        rendered.presentationAt = now
        rendered.delayMs = PRESENTATION_DELAY_MS
        rendered.model.root.position.set(snapshot.pos.x, 0.105, snapshot.pos.z)
        rendered.model.root.rotation.y = snapshot.heading
        rendered.steering = snapshot.steering
        rendered.model.root.updateMatrixWorld(true)
      } else if (changed) {
        rendered.samples.push(poseSample(snapshot, now))
        if (rendered.samples.length > MAX_POSE_SAMPLES) rendered.samples.shift()
      }
      if (changed) rendered.receivedAt = now
      if (timed && timed.tick > rendered.motionTick && snapshot === incoming) {
        rendered.motionTick = timed.tick
        if (!reset) {
          rendered.clockOrigin ??= now - timed.tick * VEHICLE_RULES.stepMs
          let at = rendered.clockOrigin + timed.tick * VEHICLE_RULES.stepMs
          const sample = poseSample(snapshot, at)
          sample.clocked = true
          // The synchronous state watch may already have appended this same pose before the motion callback.
          const pending = rendered.samples.at(-1)
          if (pending && !pending.clocked && pending.x === sample.x && pending.z === sample.z && pending.heading === sample.heading && pending.steering === sample.steering) rendered.samples.pop()
          const before = rendered.samples.at(-1)
          if (before && (before.at >= at || before.at < now - rendered.delayMs) || at < rendered.presentationAt || at > now) {
            const shift = now - at
            rendered.clockOrigin += shift
            // Keep the displayed pose at this frame's target while rebasing the service clock.
            const anchorAt = Math.max(rendered.presentationAt, now - rendered.delayMs)
            const root = rendered.model.root
            rendered.samples = [
              { at: anchorAt, x: root.position.x, z: root.position.z, heading: root.rotation.y, steering: rendered.steering, clocked: false },
              ...rendered.samples
                .filter(pose => pose.clocked && pose.at + shift > anchorAt && pose.at + shift < now)
                .map(pose => ({ ...pose, at: pose.at + shift })),
            ]
            rendered.presentationAt = anchorAt
            at = now
            sample.at = at
          }
          rendered.delayMs = Math.max(rendered.delayMs, THREE.MathUtils.clamp(PRESENTATION_DELAY_MS + now - at, PRESENTATION_DELAY_MS, MAX_SAMPLE_GAP_MS))
          rendered.samples.push(sample)
          if (rendered.samples.length > MAX_POSE_SAMPLES) rendered.samples.shift()
        }
      }
      rendered.snapshot = snapshot
      for (const seat of snapshot.seats) if (seat.occupant?.kind === 'member' && !this.seats.has(seat.occupant.memberId)) this.seats.set(seat.occupant.memberId, { vehicle: rendered, seatId: seat.id })
    }
  }

  update(delta: number, focus: { x: number; z: number }): void {
    const now = performance.now()
    for (const rendered of this.vehicles.values()) {
      const { model, snapshot } = rendered
      const root = model.root, oldX = root.position.x, oldZ = root.position.z
      const gap = Math.hypot(snapshot.pos.x - oldX, snapshot.pos.z - oldZ)
      const samples = rendered.samples
      const latest = samples.at(-1)
      const renderAt = Math.min(latest?.at ?? now, Math.max(rendered.presentationAt, now - rendered.delayMs))
      rendered.presentationAt = renderAt
      while (samples.length > 2 && samples[1] && samples[1].at <= renderAt) samples.shift()
      const a = samples[0], b = samples[1] ?? a
      if (a && b) {
        const fraction = b.at > a.at ? THREE.MathUtils.clamp((renderAt - a.at) / (b.at - a.at), 0, 1) : 1
        root.position.x = THREE.MathUtils.lerp(a.x, b.x, fraction)
        root.position.z = THREE.MathUtils.lerp(a.z, b.z, fraction)
        const yaw = Math.atan2(Math.sin(b.heading - a.heading), Math.cos(b.heading - a.heading))
        root.rotation.y = a.heading + yaw * fraction
        rendered.steering = THREE.MathUtils.lerp(a.steering, b.steering, fraction)
      }
      const radius = model.layout.wheels[0]?.radius ?? 0.3
      if (gap <= 20) rendered.wheelRotation += Math.hypot(root.position.x - oldX, root.position.z - oldZ) * Math.sign(snapshot.speed) / radius
      for (const entry of model.layout.entries) {
        const open = snapshot.openEntries.includes(entry.id) ? 1 : 0
        rendered.doors[entry.id] = (rendered.doors[entry.id] ?? open) + (open - (rendered.doors[entry.id] ?? open)) * (1 - Math.exp(-10 * delta))
      }
      const occupied = snapshot.seats.some(seat => seat.occupant !== null)
      model.setDetail(occupied || Math.hypot(root.position.x - focus.x, root.position.z - focus.z) < 50 ? 'near' : 'reduced')
      model.update({ steering: rendered.steering, wheelRotation: rendered.wheelRotation, doors: rendered.doors })
      root.updateMatrixWorld(true)
    }
  }

  isTransitioning(id: MemberId): boolean { return [...this.vehicles.values()].some(vehicle => vehicle.snapshot.transitions.some(transition => transition.member.kind === 'member' && transition.member.memberId === id && Date.parse(transition.endsAt) > Date.now())) }

  mount(id: MemberId, actor: AvatarActor, footPosition?: { x: number; z: number }): boolean {
    const binding = this.seats.get(id)
    const rendered = binding?.vehicle ?? [...this.vehicles.values()].find(vehicle => vehicle.snapshot.transitions.some(transition => transition.kind === 'exit' && transition.member.kind === 'member' && transition.member.memberId === id && Date.parse(transition.endsAt) > Date.now()))
    const transition = rendered?.snapshot.transitions.find(transition => transition.member.kind === 'member' && transition.member.memberId === id && Date.parse(transition.endsAt) > Date.now())
    if (rendered && transition) {
      const start = Date.parse(transition.startedAt), end = Date.parse(transition.endsAt)
      const progress = THREE.MathUtils.clamp((Date.now() - start) / Math.max(1, end - start), 0, 1)
      if (transition.kind === 'exit' || progress < .82) {
        const route = rendered.model.boardingRoute(transition.seatId, transition.entryId)
        if (transition.kind === 'exit') route.reverse()
        if (route.length) {
          const along = (transition.kind === 'board' ? progress / .82 : progress) * (route.length - 1)
          const index = Math.min(route.length - 1, Math.floor(along)), a = route[index], b = route[Math.min(route.length - 1, index + 1)]
          if (a && b) {
            this.transitionPoint.set(a.x, a.y, a.z).lerp(this.position.set(b.x, b.y, b.z), along - index)
            rendered.model.root.localToWorld(this.transitionPoint)
            if (transition.kind === 'exit' && footPosition && progress > .8) this.transitionPoint.lerp(this.position.set(footPosition.x, .15, footPosition.z), (progress - .8) / .2)
            actor.group.position.copy(this.transitionPoint)
            actor.group.rotation.set(0, rendered.model.root.rotation.y + Math.atan2(b.x - a.x, b.z - a.z), 0)
            const entry = rendered.model.layout.entries.find(entry => entry.id === transition.entryId)
            const thresholdIndex = entry ? route.findIndex(point => point === entry.threshold) : -1
            const inside = rendered.snapshot.kind === 'car' && thresholdIndex >= 0 && (transition.kind === 'board' ? along >= thresholdIndex - .5 : along <= thresholdIndex + .5)
            const pose = inside ? this.seatPose(rendered, transition.seatId) : undefined
            if (pose) {
              const seat = rendered.model.layout.seats.find(seat => seat.id === transition.seatId)!
              actor.group.rotation.set(0, rendered.model.root.rotation.y + seat.facing, 0)
              actor.setVehiclePose(pose); this.mounted.add(actor)
              actor.setMotion('idle'); actor.setTravelSpeed(0)
            } else { this.clearActor(actor); actor.setMotion('walk'); actor.setTravelSpeed(1.2) }
            actor.group.updateMatrixWorld(true)
            return true
          }
        }
      }
    }
    const anchor = binding?.vehicle.model.anchors.seats.find(seat => seat.id === binding.seatId)
    const layout = binding?.vehicle.model.layout.seats.find(seat => seat.id === binding.seatId)
    if (!binding || !anchor || !layout) { this.clearActor(actor); return false }
    const pelvisHeight = layout.mount.y - layout.position.y
    seatedGroupTransform(anchor.mount, pelvisHeight, this.position, this.quaternion)
    actor.group.position.copy(this.position)
    // Keep yaw in its own Euler component. The engine reads rotation.y on exit.
    actor.group.rotation.set(0, 2 * Math.atan2(this.quaternion.y, this.quaternion.w), 0)
    actor.group.updateMatrixWorld(true)
    actor.setVehiclePose(this.seatPose(binding.vehicle, anchor.id)!)
    actor.setTravelSpeed(0)
    this.mounted.add(actor)
    return true
  }

  private seatPose(rendered: RenderedVehicle, seatId: string): VehicleAvatarPose | undefined {
    let pose = rendered.poses.get(seatId)
    if (pose) return pose
    const anchor = rendered.model.anchors.seats.find(seat => seat.id === seatId)
    const layout = rendered.model.layout.seats.find(seat => seat.id === seatId)
    if (!anchor || !layout) return undefined
    pose = { role: anchor.role, pelvisHeight: layout.mount.y - layout.position.y, ...(anchor.role === 'driver' ? { control: rendered.model.layout.steering.kind, hands: rendered.model.anchors.driverHands } : {}) }
    rendered.poses.set(seatId, pose)
    return pose
  }

  hasSeat(id: MemberId): boolean { return this.seats.has(id) }
  clearActor(actor: AvatarActor): void { if (this.mounted.delete(actor)) actor.setVehiclePose(null) }
  clearActors(): void { for (const actor of this.mounted) actor.setVehiclePose(null); this.mounted.clear() }
  clear(): void { this.clearActors(); for (const rendered of this.vehicles.values()) rendered.model.dispose(); this.vehicles.clear(); this.seats.clear() }
  dispose(): void { this.clear(); this.root.removeFromParent(); this.kit.dispose() }
}
