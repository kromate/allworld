import type { Vec2 } from '../shared/geo.ts'

export type HomeFurnitureFeedback = 'selected' | 'valid' | 'invalid'

/** A home editor owns a furniture drag; the engine still owns hit testing and camera gestures. */
export interface HomeFurniturePointer {
  begin(key: string, point: Vec2, pointerId: number): boolean
  move(point: Vec2, pointerId: number): boolean
  end(pointerId: number): boolean
  cancel(pointerId?: number): void
  owns(pointerId: number): boolean
  feedback(): HomeFurnitureFeedback
}
export interface FurniturePlacementEdit {
  begin(key: string, point: Vec2): boolean
  move(point: Vec2): void
  finish(): boolean
  cancel(): void
  feedback?(): HomeFurnitureFeedback
}

/** One pointer per gesture. Repeated release/cancel never applies an edit twice. */
export function createHomeFurniturePointer(edit: FurniturePlacementEdit): HomeFurniturePointer {
  let pointer: number | null = null
  return {
    begin(key, point, pointerId) {
      if (pointer !== null || !Number.isFinite(point.x) || !Number.isFinite(point.z) || !edit.begin(key, point)) return false
      pointer = pointerId
      return true
    },
    move(point, pointerId) {
      if (pointer !== pointerId) return false
      if (Number.isFinite(point.x) && Number.isFinite(point.z)) edit.move(point)
      return true
    },
    end(pointerId) {
      if (pointer !== pointerId) return false
      pointer = null
      edit.finish()
      return true
    },
    cancel(pointerId) {
      if (pointer === null || (pointerId !== undefined && pointerId !== pointer)) return
      pointer = null
      edit.cancel()
    },
    owns: pointerId => pointer === pointerId,
    feedback: () => edit.feedback?.() ?? 'selected',
  }
}

const editors = new WeakMap<object, HomeFurniturePointer>()
export function bindHomeFurniturePointer(engine: object, editor: HomeFurniturePointer | null): void {
  const previous = editors.get(engine)
  if (previous !== editor) previous?.cancel()
  if (editor) editors.set(engine, editor)
  else editors.delete(engine)
}
export const homeFurniturePointerFor = (engine: object): HomeFurniturePointer | null => editors.get(engine) ?? null
