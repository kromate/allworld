// What the vehicle models promise the rest of the App. Rendering only: nothing here knows who owns
// a vehicle, who sits where, what a ride costs or how a vehicle moves.
//
// Space: metres, the vehicle's own frame. +Z is forward (the same heading the street traffic uses),
// +Y is up, +X is the vehicle's left (three.js is right-handed: facing +Z with +Y up, +X is on your left).
// The origin is on the ground halfway between the axles, which is where a bicycle-model vehicle turns about,
// so a vehicle placed at a road point with the road's heading sits flat on it. Yaw is about +Y, 0 faces
// forward, and a positive yaw turns towards the vehicle's left.
import type * as THREE from 'three'

export type VehicleKind = 'keke' | 'danfo' | 'car'
export type VehicleDetail = 'near' | 'reduced'
/** Body colours a model may carry. Keke and danfo are yellow in Lagos; a car is a plain, unbranded colour. */
export type PaintName = 'yellow' | 'silver' | 'white' | 'graphite' | 'blue' | 'maroon'

export interface Vec3 { readonly x: number; readonly y: number; readonly z: number }

/**
 * How far above the floor the sitting pose puts the seat surface, for an avatar of about 1.8 m.
 * Measured from the shipped `sit` clip: the hips drop 0.31 m from a 0.90–0.92 m standing hip, and
 * the seat surface is a hand-width below the hip joint. A taller or shorter avatar scales it by
 * height / 1.8, which is under 3 cm either way.
 */
export const SIT_DROP = 0.5
/** The tallest sitting avatar's head above the seat surface, for the 1.87 m end of the cast. */
export const SEATED_HEAD = 0.96
/** Height of the seated pelvis above the standing feet: the standing hip (0.90–0.92 m) less the 0.31 m drop of the `sit` clip. */
export const SIT_HIP = 0.6

export interface VehicleSeat {
  /** `driver`, then `passenger-1`, `passenger-2`, ... Stable; the shared vehicle specification can use these as its seat ids. */
  readonly id: string
  /** Where it is in the vehicle, for people and for tests: `rear-left`, `row2-right`, `bench-middle`. */
  readonly place: string
  readonly label: string
  readonly role: 'driver' | 'passenger'
  /** The seated pelvis: where the avatar's hips go. `position` raised by `SIT_HIP`. */
  readonly mount: Vec3
  /** Where the avatar's feet stand, i.e. where the avatar's origin goes. Play the `sit` motion there. */
  readonly position: Vec3
  /** Yaw the avatar faces. */
  readonly facing: number
  /** Top of the cushion. Always `position.y + SIT_DROP`. */
  readonly surface: number
  /** Entry ids, nearest first. */
  readonly entries: readonly string[]
  /** Floor points from an entry's threshold to `position`, in order. Empty when the seat is a step from it. */
  readonly via: readonly Vec3[]
  /** By entry id: the seats a person climbs across to reach this one from that entry. Missing means a clear approach. */
  readonly across: Readonly<Record<string, readonly string[]>>
  /** Anchor names for the hands. Only a driver has them. */
  readonly hands: readonly string[]
}

export interface VehicleEntry {
  readonly id: string
  readonly label: string
  readonly side: 'left' | 'right'
  /** The door that must be open to use it, or null where the side is open. */
  readonly door: string | null
  /** Where a person waits on the ground outside, facing `facing`. */
  readonly outside: Vec3
  /** Step tops between the ground and the threshold, lowest first. */
  readonly steps: readonly Vec3[]
  /** The opening itself, at floor height. */
  readonly threshold: Vec3
  /** Yaw a person faces when walking in. */
  readonly facing: number
}

export interface VehicleDoor {
  readonly id: string
  readonly label: string
  readonly kind: 'hinge' | 'slide'
  readonly side: 'left' | 'right'
  /** Where the door node sits when closed: the hinge line, or the panel's front edge. */
  readonly pivot: Vec3
  /** Fully open: radians for a hinge, metres of travel for a slide. */
  readonly travel: number
}

export interface VehicleWheel {
  readonly id: string
  readonly position: Vec3
  readonly radius: number
  readonly width: number
  /** Turns with `steer`. */
  readonly steered: boolean
}

export interface VehicleLayout {
  readonly kind: VehicleKind
  readonly label: string
  readonly length: number
  readonly width: number
  readonly height: number
  readonly wheelBase: number
  readonly seats: readonly VehicleSeat[]
  readonly entries: readonly VehicleEntry[]
  readonly doors: readonly VehicleDoor[]
  readonly wheels: readonly VehicleWheel[]
  readonly steering: {
    readonly kind: 'wheel' | 'handlebar'
    /** Largest visual steering angle of the road wheels, radians. */
    readonly maxSteer: number
    /** How far a steering wheel turns for each radian of road wheel. A handlebar ignores it: its angle follows from the fork's lean. */
    readonly ratio: number
  }
  /** Default body colour. */
  readonly paint: PaintName
}

/** The moving parts, all as visual positions. Whatever drives the vehicle decides the numbers. */
export interface VehicleVisualState {
  /** Road wheel angle in radians about +Y, positive to the left (+Z turns towards +X). Clamped to the model's `maxSteer`. */
  steering: number
  /** Wheel spin: an angle in radians about each axle that grows as the vehicle rolls forward. Add distance / radius. */
  wheelRotation: number
  /** Door openness by entry id, 0 closed to 1 open. A door that is not listed is closed. */
  doors: Readonly<Record<string, number>>
}

/** A named point that follows the part it belongs to. */
export interface VehicleAnchorPose {
  readonly position: THREE.Vector3
  readonly quaternion: THREE.Quaternion
}

export interface VehicleModelSeat {
  readonly id: string
  readonly role: 'driver' | 'passenger'
  /** The seated pelvis. Child of the root, so it does not move with the steering or the doors. Local +Z is seated forward. */
  readonly mount: THREE.Object3D
  /** The entry nearest the seat. A seat may name others in `layout`. */
  readonly entryId: string
}

export interface VehicleModelEntry {
  readonly id: string
  readonly side: 'left' | 'right'
  /** A standing target on the ground just outside the opening, facing in. */
  readonly outside: THREE.Object3D
  /** The door panel's node, which turns or slides. Absent where the side is open. */
  readonly doorPivot?: THREE.Object3D
}

export interface VehicleModel {
  readonly kind: VehicleKind
  /** Add this to the scene. Origin: on the ground, halfway between the axles; +Z forward, +X left. */
  readonly root: THREE.Group
  readonly anchors: {
    readonly seats: readonly VehicleModelSeat[]
    readonly entries: readonly VehicleModelEntry[]
    /** Grip targets that move with the steering wheel or handlebar. */
    readonly driverHands: { readonly left: THREE.Object3D; readonly right: THREE.Object3D }
  }
  /** Overall metres, mirrors and steps included. */
  readonly dimensions: { readonly width: number; readonly length: number; readonly height: number; readonly wheelbase: number }
  /** Plain data for the same seats, entries, doors and wheels: positions as numbers, for routes and checks. */
  readonly layout: VehicleLayout
  readonly paint: PaintName
  readonly detail: VehicleDetail
  /** The last state applied. */
  readonly state: Readonly<VehicleVisualState>
  /** Names of every moving anchor: the hands, and the door handles. */
  readonly anchorNames: readonly string[]
  /** Sets every moving part from these numbers alone: no history, no timer. A door left out is closed. */
  update(state: { steering: number; wheelRotation: number; doors?: Readonly<Record<string, number>> }): void
  /** `reduced` shows a two-draw-call silhouette with nothing animated; `near` is the full model. Anchors do not change. */
  setDetail(detail: VehicleDetail): void
  /** Pose of a moving anchor in the root's frame, written into `out`. False for an unknown name. */
  readAnchor(name: string, out: VehicleAnchorPose): boolean
  /** Entry outside → steps → threshold → via → seat, as points in the root's frame. The last leg is the sit. Empty for an unknown seat, or an entry the seat does not name: this is a path, not permission. */
  boardingRoute(seatId: string, entryId?: string): Vec3[]
  /** Takes the model out of the scene. Shared geometry and materials stay with the kit that made them. */
  dispose(): void
}

export interface VehicleKitStats {
  geometries: number
  materials: number
  triangles: Record<VehicleKind, { near: number; far: number }>
  instances: number
}

export interface VehicleKit {
  /** Builds, or reuses, the shared geometry for a kind and returns a new model that uses it. */
  create(kind: VehicleKind, options?: { paint?: PaintName; detail?: VehicleDetail }): VehicleModel
  /** Metres the authored frame was moved back so the origin is halfway between the axles. */
  originShift(kind: VehicleKind): number
  /** Dusk and night: lamps glow. 0 is day, 1 is night. */
  setNight(amount: number): void
  stats(): VehicleKitStats
  /** Releases every geometry and material the kit made. Dispose models first. */
  dispose(): void
}
