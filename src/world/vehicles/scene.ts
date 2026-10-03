import * as THREE from 'three'
import type { MemberId, VehicleId } from '../../shared/ids.ts'
import type { VehicleSnapshot } from '../../shared/vehicles.ts'
import type { AvatarActor } from '../avatars.ts'
import type { VehicleAvatarPose } from '../avatarVehiclePose.ts'
import { seatedGroupTransform } from '../avatarVehiclePose.ts'
import { createVehicleKit } from './models.ts'
import type { VehicleModel } from './models.ts'

interface RenderedVehicle {
  snapshot: VehicleSnapshot
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

  sync(snapshots: readonly VehicleSnapshot[]): void {
    const wanted = new Set(snapshots.map(snapshot => snapshot.id))
    for (const [id, rendered] of this.vehicles) if (!wanted.has(id)) {
      this.clearActors(); rendered.model.dispose(); this.vehicles.delete(id)
    }
    this.seats.clear()
    for (const snapshot of snapshots) {
      let rendered = this.vehicles.get(snapshot.id)
      if (rendered && (rendered.snapshot.epoch !== snapshot.epoch || rendered.snapshot.kind !== snapshot.kind || rendered.snapshot.room.key !== snapshot.room.key || rendered.snapshot.room.instance !== snapshot.room.instance)) {
        this.clearActors(); rendered.model.dispose(); this.vehicles.delete(snapshot.id); rendered = undefined
      }
      if (!rendered) {
        const model = this.kit.create(snapshot.kind, { detail: 'near' })
        model.root.position.set(snapshot.pos.x, 0.105, snapshot.pos.z)
        model.root.rotation.y = snapshot.heading
        this.root.add(model.root)
        rendered = { snapshot, model, steering: snapshot.steering, wheelRotation: 0, doors: {}, poses: new Map() }
        this.vehicles.set(snapshot.id, rendered)
      }
      if (rendered.snapshot.epoch === snapshot.epoch && rendered.snapshot.revision > snapshot.revision) continue
      rendered.snapshot = snapshot
      for (const seat of snapshot.seats) if (seat.occupant?.kind === 'member' && !this.seats.has(seat.occupant.memberId)) this.seats.set(seat.occupant.memberId, { vehicle: rendered, seatId: seat.id })
    }
  }

  update(delta: number, focus: { x: number; z: number }): void {
    const ease = 1 - Math.exp(-14 * Math.max(0, delta))
    for (const rendered of this.vehicles.values()) {
      const { model, snapshot } = rendered
      const root = model.root, oldX = root.position.x, oldZ = root.position.z
      const gap = Math.hypot(snapshot.pos.x - oldX, snapshot.pos.z - oldZ)
      root.position.x += (snapshot.pos.x - oldX) * (gap > 20 ? 1 : ease)
      root.position.z += (snapshot.pos.z - oldZ) * (gap > 20 ? 1 : ease)
      const yaw = Math.atan2(Math.sin(snapshot.heading - root.rotation.y), Math.cos(snapshot.heading - root.rotation.y))
      root.rotation.y += yaw * ease
      rendered.steering += (snapshot.steering - rendered.steering) * ease
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
            this.clearActor(actor)
            this.transitionPoint.set(a.x, a.y, a.z).lerp(this.position.set(b.x, b.y, b.z), along - index)
            rendered.model.root.localToWorld(this.transitionPoint)
            if (transition.kind === 'exit' && footPosition && progress > .8) this.transitionPoint.lerp(this.position.set(footPosition.x, .15, footPosition.z), (progress - .8) / .2)
            actor.group.position.copy(this.transitionPoint)
            actor.group.rotation.y = rendered.model.root.rotation.y + Math.atan2(b.x - a.x, b.z - a.z)
            actor.group.updateMatrixWorld(true)
            actor.setMotion('walk'); actor.setTravelSpeed(1.2)
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
    actor.group.quaternion.copy(this.quaternion)
    actor.group.updateMatrixWorld(true)
    let pose = binding.vehicle.poses.get(anchor.id)
    if (!pose) { pose = { role: anchor.role, pelvisHeight, ...(anchor.role === 'driver' ? { control: binding.vehicle.model.layout.steering.kind, hands: binding.vehicle.model.anchors.driverHands } : {}) }; binding.vehicle.poses.set(anchor.id, pose) }
    actor.setVehiclePose(pose)
    actor.setTravelSpeed(0)
    this.mounted.add(actor)
    return true
  }

  hasSeat(id: MemberId): boolean { return this.seats.has(id) }
  clearActor(actor: AvatarActor): void { if (this.mounted.delete(actor)) actor.setVehiclePose(null) }
  clearActors(): void { for (const actor of this.mounted) actor.setVehiclePose(null); this.mounted.clear() }
  clear(): void { this.clearActors(); for (const rendered of this.vehicles.values()) rendered.model.dispose(); this.vehicles.clear(); this.seats.clear() }
  dispose(): void { this.clear(); this.root.removeFromParent(); this.kit.dispose() }
}
