// A seated avatar in a vehicle. The shipped `sit` clip stays the base, run by the actor's mixer as usual;
// this adds, after the mixer, what a seat needs: feet on the floor, knees and elbows inside their range,
// a torso that leans to the wheel, hands that rest on the thighs or hold the moving grips.
//
// Frame: the avatar's own. +Z is the way it faces, +Y up, +X its left, and the rig is in centimetres (the
// scaler turns that into metres and applies the height). The engine places the avatar group with its origin
// on the seat's floor point, facing the seat's forward; the seated pelvis is then (0, pelvisHeight, 0) from
// that origin, in metres, whatever the avatar's size. `seatedGroupTransform` does that from a seat's mount.
//
// Nothing here changes a mesh, a texture, a bone length or a scale. Only bone rotations (and the root's
// height) are written, after the mixer has written its own. `restore` puts the mixer's values back before
// it runs again, so a bone the pose touched is never left behind, and the same call is the exit.
import * as THREE from 'three'
import type { BuildFade } from './surfaceBuild.ts'

/** Metres from the group origin to the seated pelvis. Matches the vehicle models' `SIT_HIP`; a seat's `mount.y - position.y` may replace it. */
export const SEATED_PELVIS = 0.6

export interface VehicleAvatarPose {
  role: 'driver' | 'passenger'
  /** What the hands hold. Only a driver with `hands` holds anything; every other pose rests its hands. */
  control?: 'wheel' | 'handlebar'
  /** Live grip nodes of the steering wheel or handlebar. Their world position is read on every update. */
  hands?: { readonly left: THREE.Object3D; readonly right: THREE.Object3D }
  /** Metres from the group origin to the seated pelvis. Default `SEATED_PELVIS`. */
  pelvisHeight?: number
}

export interface SeatedBuild { shoulders: number; torso: number }

/** What the last `apply` did, for a check to read. Index 0 is the left side, 1 the right. */
export interface SeatedReport {
  /** Forward lean of the torso from the chair clip, radians, and how far the shoulders were drawn forward. */
  leanRadians: number
  protractRadians: number
  /** Metres by which a wrist could not reach its target; 0 when it did. */
  reachShortfall: [number, number]
  /** Radians the hand was held back from the ideal grip by the wrist's range. */
  wristHeld: [number, number]
  kneeBend: [number, number]
  elbowBend: [number, number]
  /** Metres from each palm to where it was asked to be, build included. */
  palmError: [number, number]
}

/** Share of the forward lean taken by the pelvis and the two spine bones; the head takes `HEAD_LEVEL` of the whole back. */
const LEAN_SHARE = [0.6, 0.25, 0.15] as const
const HEAD_LEVEL = 0.7
/** A driver sits a little more upright than the chair clip and leans no further than `LEAN_MAX`, drawing the shoulders forward as it does. */
const LEAN_MIN = 0.1
const LEAN_MAX = 0.6
const PROTRACT_MAX = 0.3
/** A passenger sits upright, which also keeps the back off a seat back set 0.22 m behind the hips. */
const PASSENGER_LEAN = 0.12
/** How much of a straight arm a grip may ask for. */
const REACH = 0.97
/** Joint ranges, radians of bend from straight. */
const KNEE = [0.17, 2.5] as const
const ELBOW = [0.12, 2.6] as const
/** The wrist may swing this far off the forearm's line, and roll this far from its resting roll. */
const WRIST_SWING = 0.7
const WRIST_ROLL = 1.3
/** Curl of the three joints of each finger: a firm wrap on a grip, a loose hand at rest. */
const GRIP_CURL = [1.15, 1.25, 0.8] as const
const REST_CURL = [0.35, 0.45, 0.3] as const
/** Feet: forward of the hips as a share of the thigh, the gap between the ankles in centimetres, and how far the toes turn out. */
const FOOT_FORWARD = 0.9
const FOOT_APART = 10.5
const TOE_OUT = 0.12
/** The right foot reaches this much further, centimetres, for a driver's pedal. */
const PEDAL_REACH = 3
/** A resting palm sits on the thigh's top: its radius and a little clearance, centimetres. */
const THIGH_RADIUS = 6.6
const REST_CLEARANCE = 0.8
/** The palm's centre is this far outside the grip's centre, metres: the rim runs under the curled fingers. */
const GRIP_CLEARANCE = 0.02

const smooth = (a: number, b: number, x: number): number => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t) }
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/**
 * The scale `surfaceBuild.ts` applies to a vertex in the mesh's own frame (x width, y depth) after skinning,
 * from the vertex's bind-pose height in centimetres. The same arithmetic as its GLSL, so that the hand a viewer
 * sees, and not only the bone under it, is what reaches a grip. Both scales are 1 from the face up.
 */
export function buildScalesAt(height: number, build: SeatedBuild, fade: BuildFade, out: [number, number] = [1, 1]): [number, number] {
  const neck = 1 - smooth(fade.from, fade.to, height)
  const torso = smooth(70, 90, height) * (1 - smooth(126, 151, height)) * neck
  const shoulders = smooth(122, 135, height) * neck
  out[0] = mix(mix(1, build.shoulders, shoulders), build.torso, torso * (1 - shoulders))
  out[1] = mix(1, build.torso, smooth(70, 90, height) * neck)
  return out
}

const UP = new THREE.Vector3(0, 1, 0)
const AXIS_X = new THREE.Vector3(1, 0, 0)
const AXIS_Z = new THREE.Vector3(0, 0, 1)

/** Where the avatar group goes so that its seated pelvis is on a seat's `mount` (world): position and yaw. The mount's local +Z is seated forward. */
export function seatedGroupTransform(mount: THREE.Object3D, pelvisHeight: number, position: THREE.Vector3, quaternion: THREE.Quaternion): void {
  mount.updateWorldMatrix(true, false)
  position.setFromMatrixPosition(mount.matrixWorld)
  const e = mount.matrixWorld.elements
  quaternion.setFromAxisAngle(UP, Math.atan2(e[8]!, e[10]!))
  position.y -= pelvisHeight
}

interface Limb { side: 1 | -1; upper: THREE.Object3D; mid: THREE.Object3D; end: THREE.Object3D }
interface Leg extends Limb { toe: THREE.Object3D; footBind: THREE.Quaternion; toeBind: THREE.Quaternion }
interface Hand extends Limb {
  clavicle: THREE.Object3D
  fingers: THREE.Object3D[]
  rollBind: number
  /** The hand bone's ideal world rotation, where the palm is to be (world, before the build), the wrist that needs, and the rotation the hand was left with. */
  ideal: THREE.Quaternion
  palm: THREE.Vector3
  wrist: THREE.Vector3
  actual: THREE.Quaternion
}

const limbNames = (side: 'L' | 'R') => ({
  thigh: `Bip01_${side}_Thigh`, calf: `Bip01_${side}_Calf`, foot: `Bip01_${side}_Foot`, toe: `Bip01_${side}_Toe0`,
  clavicle: `Bip01_${side}_Clavicle`, arm: `Bip01_${side}_UpperArm`, forearm: `Bip01_${side}_Forearm`, hand: `Bip01_${side}_Hand`,
  fingers: [1, 2, 3, 4].flatMap(n => [`Bip01_${side}_Finger${n}`, `Bip01_${side}_Finger${n}1`, `Bip01_${side}_Finger${n}2`]),
})

export class SeatedPose {
  readonly rig: THREE.Object3D
  readonly report: SeatedReport = { leanRadians: 0, protractRadians: 0, reachShortfall: [0, 0], wristHeld: [0, 0], kneeBend: [0, 0], elbowBend: [0, 0], palmError: [0, 0] }
  /** False for a rig that lacks a bone this needs: `apply` then does nothing and the avatar simply sits. */
  readonly ok: boolean
  private readonly root: THREE.Object3D
  private readonly head: THREE.Object3D
  private readonly lean: THREE.Object3D[]
  private readonly legs: Leg[] = []
  private readonly hands: Hand[] = []
  private readonly managed: THREE.Object3D[] = []
  private readonly snapshot: THREE.Quaternion[] = []
  private readonly snapshots = new Map<THREE.Object3D, THREE.Quaternion>()
  private readonly snapshotRoot = new THREE.Vector3()
  private readonly rootBind = new THREE.Vector3()
  private footHeight = 0
  private handHeight = 0
  private palmSign = 1
  private readonly palmOffset = new THREE.Vector3()
  private readonly fingerBind = new Map<THREE.Object3D, THREE.Quaternion>()
  private applied = false
  // Working values, reused: nothing is allocated while posing.
  private readonly m = new THREE.Matrix4()
  private readonly rigInverse = new THREE.Matrix4()
  private readonly rigQ = new THREE.Quaternion()
  private readonly lateral = new THREE.Vector3()
  private readonly forward = new THREE.Vector3()
  private readonly upward = new THREE.Vector3()
  private readonly qa = new THREE.Quaternion()
  private readonly qb = new THREE.Quaternion()
  private readonly qc = new THREE.Quaternion()
  private readonly qd = new THREE.Quaternion()
  private readonly va = new THREE.Vector3()
  private readonly vb = new THREE.Vector3()
  private readonly vc = new THREE.Vector3()
  private readonly vd = new THREE.Vector3()
  private readonly ve = new THREE.Vector3()
  private readonly vf = new THREE.Vector3()
  private readonly vg = new THREE.Vector3()
  private readonly vh = new THREE.Vector3()
  private readonly goal = new THREE.Vector3()
  private readonly poleDir = new THREE.Vector3()
  private readonly grips = [new THREE.Vector3(), new THREE.Vector3()]
  private readonly hub = new THREE.Vector3()
  private readonly scales: [number, number] = [1, 1]
  private bend = 0

  constructor(rig: THREE.Object3D, template: THREE.Object3D) {
    this.rig = rig
    const find = (name: string): THREE.Object3D | null => rig.getObjectByName(name) ?? null
    const root = find('Bip01'), pelvis = find('Bip01_Pelvis'), spine1 = find('Bip01_Spine1'), spine2 = find('Bip01_Spine2'), head = find('Bip01_Head')
    const sides = ([['L', 1], ['R', -1]] as const).map(([name, side]) => {
      const names = limbNames(name)
      const bones = [names.thigh, names.calf, names.foot, names.toe, names.clavicle, names.arm, names.forearm, names.hand].map(find)
      return { side: side as 1 | -1, name, names, bones, fingers: names.fingers.map(find) }
    })
    this.ok = Boolean(root && pelvis && spine1 && spine2 && head && sides.every(s => s.bones.every(Boolean) && s.fingers.every(Boolean)))
    this.root = root!; this.head = head!; this.lean = [pelvis!, spine1!, spine2!]
    if (!this.ok) return
    template.updateMatrixWorld(true)
    this.rootBind.copy(root!.position)
    const bind = (name: string): THREE.Object3D => template.getObjectByName(name)!
    const bindPoint = (name: string, out: THREE.Vector3): THREE.Vector3 => out.setFromMatrixPosition(bind(name).matrixWorld)
    const bindRotation = (name: string, out: THREE.Quaternion): THREE.Quaternion => out.setFromRotationMatrix(this.m.extractRotation(bind(name).matrixWorld))
    let palmFacing = 0
    for (const { side, name, names, bones, fingers } of sides) {
      const [thigh, calf, foot, toe, clavicle, arm, forearm, hand] = bones as THREE.Object3D[]
      this.legs.push({ side, upper: thigh!, mid: calf!, end: foot!, toe: toe!, footBind: bindRotation(names.foot, new THREE.Quaternion()), toeBind: bind(names.toe).quaternion.clone() })
      this.footHeight += bindPoint(names.foot, this.va).y / 2
      this.handHeight += bindPoint(names.hand, this.va).y / 2
      // The palm is the hand's axis that faced the body in the bind pose; its centre is half-way to the knuckles.
      bindRotation(names.hand, this.qa)
      palmFacing += Math.sign(this.va.set(0, 1, 0).applyQuaternion(this.qa).dot(this.vb.set(-side, 0, 0)) || 1)
      for (let n = 1; n <= 4; n++) this.palmOffset.addScaledVector(bind(`Bip01_${name}_Finger${n}`).position, 0.5 / 8)
      const handBind = bind(names.hand).quaternion
      this.hands.push({
        side, upper: arm!, mid: forearm!, end: hand!, clavicle: clavicle!, fingers: fingers as THREE.Object3D[], rollBind: 2 * Math.atan2(handBind.x, handBind.w),
        ideal: new THREE.Quaternion(), palm: new THREE.Vector3(), wrist: new THREE.Vector3(), actual: new THREE.Quaternion(),
      })
      names.fingers.forEach((finger, i) => this.fingerBind.set(fingers[i]!, bind(finger).quaternion.clone()))
    }
    this.palmSign = palmFacing >= 0 ? 1 : -1
    this.managed.push(...this.lean, head!)
    for (const leg of this.legs) this.managed.push(leg.upper, leg.mid, leg.end, leg.toe)
    for (const hand of this.hands) this.managed.push(hand.clavicle, hand.upper, hand.mid, hand.end, ...hand.fingers)
    for (const bone of this.managed) { const saved = bone.quaternion.clone(); this.snapshot.push(saved); this.snapshots.set(bone, saved) }
  }

  /** Puts back what the mixer last wrote. Call before the mixer runs, and on exit. */
  restore(): void {
    if (!this.applied) return
    this.applied = false
    for (let i = 0; i < this.managed.length; i++) this.managed[i]!.quaternion.copy(this.snapshot[i]!)
    this.root.position.copy(this.snapshotRoot)
  }

  /** Forgets the rig without touching it: a rig being replaced is thrown away as it is. */
  dispose(): void { this.applied = false }

  /**
   * After the mixer, and after the actor has set the root's height. The group's placement must be current,
   * since it is read here. `blend` (0 to 1) eases the pose in over the animation.
   */
  apply(pose: VehicleAvatarPose, height: number, build: SeatedBuild, fade: BuildFade, blend: number): void {
    if (!this.ok) return
    const rig = this.rig, root = this.root
    rig.updateWorldMatrix(true, false)
    root.updateMatrixWorld(true)
    for (let i = 0; i < this.managed.length; i++) this.snapshot[i]!.copy(this.managed[i]!.quaternion)
    this.snapshotRoot.copy(root.position)
    this.applied = true
    this.rigInverse.copy(rig.matrixWorld).invert()
    this.rigQ.setFromRotationMatrix(this.m.extractRotation(rig.matrixWorld))
    this.lateral.copy(AXIS_X).applyQuaternion(this.rigQ)
    this.forward.copy(AXIS_Z).applyQuaternion(this.rigQ)
    this.upward.copy(UP).applyQuaternion(this.rigQ)
    const unit = rig.matrixWorld.getMaxScaleOnAxis()
    const pelvis = (pose.pelvisHeight ?? SEATED_PELVIS) * 100 / Math.max(0.1, height)
    root.position.set(this.rootBind.x, pelvis, this.rootBind.z)
    root.updateMatrixWorld(true)
    const driving = pose.role === 'driver' && pose.hands !== undefined && this.aimHands(pose, build, fade, unit)
    let lean = PASSENGER_LEAN, protract = 0
    if (driving) {
      const share = this.reachShare()
      lean = mix(LEAN_MIN, LEAN_MAX, share)
      protract = PROTRACT_MAX * share
    }
    this.posture(lean, protract)
    this.report.leanRadians = lean
    this.report.protractRadians = protract
    for (const leg of this.legs) this.placeLeg(leg, pose.role === 'driver' && leg.side === -1 ? PEDAL_REACH : 0, unit)
    for (const hand of this.hands) {
      if (!driving) this.restHand(hand, unit)
      this.reachHand(hand, build, fade, unit)
    }
    this.curlFingers(driving)
    if (blend < 1) {
      for (let i = 0; i < this.managed.length; i++) { const bone = this.managed[i]!; this.qa.copy(bone.quaternion); bone.quaternion.copy(this.snapshot[i]!).slerp(this.qa, blend) }
      root.position.y = mix(this.snapshotRoot.y, pelvis, blend)
    }
    root.updateMatrixWorld(true)
  }

  private worldQuaternion(object: THREE.Object3D, out: THREE.Quaternion): THREE.Quaternion {
    return out.setFromRotationMatrix(this.m.extractRotation(object.matrixWorld))
  }

  /** Gives a bone the world rotation `world`; its parent's world matrix must be current. `world` must not be `qd`. */
  private setWorld(bone: THREE.Object3D, world: THREE.Quaternion): void {
    this.worldQuaternion(bone.parent!, this.qd).invert()
    bone.quaternion.copy(this.qd).multiply(world)
    bone.updateMatrixWorld()
  }

  private point(object: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 { return out.setFromMatrixPosition(object.matrixWorld) }

  /**
   * Tips the pelvis, the two spine bones and (back) the head about the avatar's lateral axis, from the
   * animation's own pose, and draws the shoulders forward. The hips are on that axis, so they stay where
   * they are; the legs are solved afterwards in any case.
   */
  private posture(lean: number, protract: number): void {
    for (const bone of this.lean) bone.quaternion.copy(this.snapshots.get(bone)!)
    this.head.quaternion.copy(this.snapshots.get(this.head)!)
    for (const hand of this.hands) hand.clavicle.quaternion.copy(this.snapshots.get(hand.clavicle)!)
    this.lean[0]!.updateMatrixWorld()
    for (let i = 0; i < this.lean.length; i++) {
      const bone = this.lean[i]!
      this.worldQuaternion(bone, this.qa).premultiply(this.qb.setFromAxisAngle(this.lateral, lean * LEAN_SHARE[i]!))
      this.setWorld(bone, this.qa)
    }
    this.worldQuaternion(this.head, this.qa).premultiply(this.qb.setFromAxisAngle(this.lateral, -lean * HEAD_LEVEL))
    this.setWorld(this.head, this.qa)
    if (protract === 0) return
    // A clavicle points out to its side: turning it about the vertical draws the shoulder forward.
    for (const hand of this.hands) {
      this.worldQuaternion(hand.clavicle, this.qa).premultiply(this.qb.setFromAxisAngle(this.upward, -hand.side * protract))
      this.setWorld(hand.clavicle, this.qa)
    }
  }

  /** The least share (0 to 1) of lean and shoulder reach at which both shoulders can reach their wrists. */
  private reachShare(): number {
    const reaches = (share: number): boolean => {
      this.posture(mix(LEAN_MIN, LEAN_MAX, share), PROTRACT_MAX * share)
      for (const hand of this.hands) {
        const shoulder = this.point(hand.upper, this.va), elbow = this.point(hand.mid, this.vb), wrist = this.point(hand.end, this.vc)
        if (shoulder.distanceTo(hand.wrist) > REACH * (shoulder.distanceTo(elbow) + elbow.distanceTo(wrist))) return false
      }
      return true
    }
    if (reaches(0)) return 0
    if (!reaches(1)) return 1
    let low = 0, high = 1
    for (let i = 0; i < 7; i++) {
      const middle = (low + high) / 2
      if (reaches(middle)) high = middle; else low = middle
    }
    return high
  }

  /**
   * Two-bone solve in world space. The upper bone is aimed at the knee or elbow; the lower bone gets its
   * bend, within `range`, about its own hinge (local +Z, negative for flexion, as the rig's bind pose has
   * it). The end bone is left to the caller. Returns the metres the target was out of reach.
   */
  private solve(limb: Limb, target: THREE.Vector3, pole: THREE.Vector3, range: readonly [number, number]): number {
    const a = this.point(limb.upper, this.va), b = this.point(limb.mid, this.vb), c = this.point(limb.end, this.vc)
    const l1 = a.distanceTo(b), l2 = b.distanceTo(c)
    const wanted = a.distanceTo(target)
    const bendFor = Math.PI - Math.acos(Math.min(1, Math.max(-1, (l1 * l1 + l2 * l2 - wanted * wanted) / (2 * l1 * l2))))
    const held = Math.min(range[1], Math.max(range[0], bendFor))
    const d = Math.sqrt(l1 * l1 + l2 * l2 + 2 * l1 * l2 * Math.cos(held))
    const toward = this.vd.subVectors(target, a).normalize()
    const along = (l1 * l1 - l2 * l2 + d * d) / (2 * d), off = Math.sqrt(Math.max(0, l1 * l1 - along * along))
    const side = this.ve.copy(pole).addScaledVector(toward, -pole.dot(toward))
    if (side.lengthSq() < 1e-8) side.copy(this.forward).addScaledVector(toward, -this.forward.dot(toward))
    side.normalize()
    const joint = this.vf.copy(a).addScaledVector(toward, along).addScaledVector(side, off)
    // Down the upper bone, down the lower one, and the normal of the plane they bend in, signed for a flexion.
    const upper = this.vg.subVectors(joint, a).normalize()
    const lower = this.vh.copy(a).addScaledVector(toward, d).sub(joint).normalize()
    const hinge = this.vb.crossVectors(lower, upper)
    if (hinge.lengthSq() < 1e-8) hinge.crossVectors(upper, pole)
    hinge.normalize()
    this.m.makeBasis(upper, this.vc.crossVectors(hinge, upper).normalize(), hinge)
    this.setWorld(limb.upper, this.qa.setFromRotationMatrix(this.m))
    limb.mid.quaternion.setFromAxisAngle(AXIS_Z, -held)
    limb.mid.updateMatrixWorld()
    this.bend = held
    return Math.abs(wanted - d)
  }

  private placeLeg(leg: Leg, extra: number, unit: number): void {
    const hip = this.point(leg.upper, this.va), knee = this.point(leg.mid, this.vb)
    const thigh = hip.distanceTo(knee) / unit
    // The ankle's target, in the rig's centimetres: across from the hips' centre, forward by a share of the thigh, at the ankle's own height.
    this.goal.set(this.rootBind.x + leg.side * FOOT_APART, this.footHeight, this.rootBind.z + thigh * FOOT_FORWARD + extra).applyMatrix4(this.rig.matrixWorld)
    this.solve(leg, this.goal, this.poleDir.set(leg.side * 0.2, 0.3, 1).applyQuaternion(this.rigQ), KNEE)
    this.report.kneeBend[leg.side === 1 ? 0 : 1] = this.bend
    this.setWorld(leg.end, this.qa.setFromAxisAngle(UP, leg.side * TOE_OUT).multiply(leg.footBind).premultiply(this.rigQ))
    leg.toe.quaternion.copy(leg.toeBind)
    leg.toe.updateMatrixWorld()
  }

  /** Where each driver's hand is to be, and the rotation it should have there. False if a grip cannot be read. */
  private aimHands(pose: VehicleAvatarPose, build: SeatedBuild, fade: BuildFade, unit: number): boolean {
    const nodes = pose.hands!
    this.point(nodes.left, this.grips[0]!)
    this.point(nodes.right, this.grips[1]!)
    const sum = this.grips[0]!.x + this.grips[0]!.y + this.grips[0]!.z + this.grips[1]!.x + this.grips[1]!.y + this.grips[1]!.z
    if (!Number.isFinite(sum)) return false
    this.hub.addVectors(this.grips[0]!, this.grips[1]!).multiplyScalar(0.5)
    for (let i = 0; i < this.hands.length; i++) {
      const hand = this.hands[i]!, grip = this.grips[i]!
      const inward = this.vd.subVectors(this.hub, grip)
      if (inward.lengthSq() < 1e-6) inward.copy(this.lateral).multiplyScalar(-hand.side)
      inward.normalize()
      const fingers = this.ve.copy(this.forward), palm = this.vf
      if (pose.control === 'handlebar') { fingers.addScaledVector(this.upward, -0.45).addScaledVector(inward, 0.2); palm.copy(this.upward).multiplyScalar(-1).addScaledVector(inward, 0.3) }
      else { fingers.addScaledVector(this.upward, 0.35).addScaledVector(inward, 0.3); palm.copy(inward) }
      this.orient(hand, fingers, palm)
      // The palm's normal is left in `vc`: the palm sits outside the grip, on the side its fingers wrap from.
      hand.palm.copy(grip).addScaledVector(this.vc, -GRIP_CLEARANCE)
      // The wrist this asks for, so that the lean can be found before the arms are solved.
      this.wristFor(hand, hand.ideal, build, fade, unit)
    }
    return true
  }

  /** The ideal hand rotation for fingers along `fingers` and the palm facing `palm`; the palm's normal is left in `vc`. */
  private orient(hand: Hand, fingers: THREE.Vector3, palm: THREE.Vector3): void {
    const x = fingers.normalize()
    const normal = this.vc.copy(palm).addScaledVector(x, -palm.dot(x)).normalize()
    const y = this.va.copy(normal).multiplyScalar(this.palmSign)
    this.m.makeBasis(x, y, this.vb.crossVectors(x, y))
    hand.ideal.setFromRotationMatrix(this.m)
  }

  /** A hand at rest: on the thigh's top, palm down, fingers forward and a little in. Needs the legs placed. */
  private restHand(hand: Hand, unit: number): void {
    const leg = this.legs[hand.side === 1 ? 0 : 1]!
    const hip = this.point(leg.upper, this.va), knee = this.point(leg.mid, this.vb)
    hand.palm.copy(hip).lerp(knee, 0.45).addScaledVector(this.upward, (THIGH_RADIUS + REST_CLEARANCE) * unit)
    const fingers = this.ve.copy(this.forward).addScaledVector(this.lateral, -hand.side * 0.25)
    this.orient(hand, fingers, this.vf.copy(this.upward).multiplyScalar(-1))
  }

  /**
   * The wrist that puts the palm of `rotation` where the hand asks, in the mesh's own build-scaled frame:
   * the mesh is scaled about the avatar's vertical axis after skinning, so the bone sits at the target
   * scaled back.
   */
  private wristFor(hand: Hand, rotation: THREE.Quaternion, build: SeatedBuild, fade: BuildFade, unit: number): void {
    buildScalesAt(this.handHeight, build, fade, this.scales)
    const bone = this.vc.copy(hand.palm).applyMatrix4(this.rigInverse)
    bone.x /= this.scales[0]; bone.z /= this.scales[1]
    bone.applyMatrix4(this.rig.matrixWorld)
    hand.wrist.copy(bone).addScaledVector(this.vd.copy(this.palmOffset).applyQuaternion(rotation), -unit)
  }

  /** Solves the arm for the hand's wrist, then sets the hand within what a wrist can do. Twice, since the wrist depends on the hand's rotation. */
  private reachHand(hand: Hand, build: SeatedBuild, fade: BuildFade, unit: number): void {
    const index = hand.side === 1 ? 0 : 1
    hand.actual.copy(hand.ideal)
    for (let pass = 0; pass < 2; pass++) {
      this.wristFor(hand, hand.actual, build, fade, unit)
      this.poleDir.set(hand.side * 0.5, -1, -0.35).normalize().applyQuaternion(this.rigQ)
      this.report.reachShortfall[index] = this.solve(hand, hand.wrist, this.poleDir, ELBOW)
      this.report.elbowBend[index] = this.bend
      this.report.wristHeld[index] = this.setWrist(hand)
    }
    // How far the palm ended from where it was asked to be, in the mesh's own build-scaled frame.
    buildScalesAt(this.handHeight, build, fade, this.scales)
    const palm = this.point(hand.end, this.vc).addScaledVector(this.vd.copy(this.palmOffset).applyQuaternion(hand.actual), unit).applyMatrix4(this.rigInverse)
    palm.x *= this.scales[0]; palm.z *= this.scales[1]
    this.report.palmError[index] = palm.applyMatrix4(this.rig.matrixWorld).distanceTo(hand.palm)
  }

  /** Sets the hand bone as near its ideal rotation as the wrist allows, from the forearm's present rotation; returns the radians held back. */
  private setWrist(hand: Hand): number {
    this.worldQuaternion(hand.mid, this.qb).invert()
    const wanted = this.qc.copy(this.qb).multiply(hand.ideal)
    if (wanted.w < 0) wanted.set(-wanted.x, -wanted.y, -wanted.z, -wanted.w)
    // Twist about the bone's own axis is the forearm's roll; what is left is the wrist's swing.
    const length = Math.hypot(wanted.x, wanted.w)
    const twist = this.qa.set(length > 1e-9 ? wanted.x / length : 0, 0, 0, length > 1e-9 ? wanted.w / length : 1)
    const swing = this.qb.copy(twist).invert().premultiply(wanted)
    // The roll nearest its resting roll, whichever turn it was found on, held within its range.
    let roll = 2 * Math.atan2(twist.x, twist.w) - hand.rollBind
    roll = Math.min(WRIST_ROLL, Math.max(-WRIST_ROLL, roll - Math.PI * 2 * Math.round(roll / (Math.PI * 2)))) + hand.rollBind
    if (swing.w < 0) swing.set(-swing.x, -swing.y, -swing.z, -swing.w)
    const swung = 2 * Math.acos(Math.min(1, swing.w))
    if (swung > WRIST_SWING) { this.qc.copy(swing); swing.set(0, 0, 0, 1).slerp(this.qc, WRIST_SWING / swung) }
    twist.setFromAxisAngle(AXIS_X, roll)
    hand.end.quaternion.copy(swing).multiply(twist)
    hand.end.updateMatrixWorld()
    return this.worldQuaternion(hand.end, hand.actual).angleTo(hand.ideal)
  }

  /** Every finger's three joints: curled about the palm's side to a grip, or loosely at rest, from the bind pose. */
  private curlFingers(driving: boolean): void {
    const curl = driving ? GRIP_CURL : REST_CURL
    for (const hand of this.hands) for (let i = 0; i < hand.fingers.length; i++) {
      const finger = hand.fingers[i]!
      finger.quaternion.copy(this.fingerBind.get(finger)!).multiply(this.qa.setFromAxisAngle(AXIS_Z, this.palmSign * curl[i % 3]!))
    }
  }
}
