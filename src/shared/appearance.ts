// How a member has corrected their character after a photo: face shape, hair, beard and build.
// Bounded values only; the service validates them with the same parser the App uses.
export const HAIR_STYLES = ['auto', 'low-cut', 'fade', 'short-afro', 'big-afro', 'braids', 'locs', 'twists', 'bald', 'long-straight', 'bun', 'head-wrap'] as const
export type HairStyle = (typeof HAIR_STYLES)[number]
export type BeardChoice = 'auto' | 'on' | 'off' | 'chin-strap'

/** Member-controlled refinements. A missing field means the neutral value. */
export interface AvatarAppearance {
  faceWidth: number
  jaw: number
  chin: number
  hairline: number
  beard: BeardChoice
  hairStyle: HairStyle
  hairColour: string | null
  shoulders: number
  torso: number
}

export const DEFAULT_APPEARANCE: Readonly<AvatarAppearance> = Object.freeze({
  faceWidth: 1,
  jaw: 1,
  chin: 1,
  hairline: 0,
  beard: 'auto',
  hairStyle: 'auto',
  hairColour: null,
  shoulders: 1,
  torso: 1,
})

const BOUNDS = {
  faceWidth: [0.9, 1.12],
  jaw: [0.85, 1.18],
  chin: [0.9, 1.1],
  hairline: [-0.08, 0.08],
  shoulders: [0.9, 1.16],
  torso: [0.9, 1.12],
} as const

function bounded(value: unknown, [min, max]: readonly [number, number], fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback
}

/** Parse stored or detected values at the boundary before they reach the actor or controls. */
export function parseAvatarAppearance(input: unknown): AvatarAppearance {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {}
  const hairStyle = HAIR_STYLES.find(style => style === value.hairStyle) ?? 'auto'
  return {
    faceWidth: bounded(value.faceWidth, BOUNDS.faceWidth, DEFAULT_APPEARANCE.faceWidth),
    jaw: bounded(value.jaw, BOUNDS.jaw, DEFAULT_APPEARANCE.jaw),
    chin: bounded(value.chin, BOUNDS.chin, DEFAULT_APPEARANCE.chin),
    hairline: bounded(value.hairline, BOUNDS.hairline, DEFAULT_APPEARANCE.hairline),
    beard: value.beard === 'on' || value.beard === 'off' || value.beard === 'chin-strap' ? value.beard : 'auto',
    hairStyle,
    hairColour: typeof value.hairColour === 'string' && /^#[0-9a-f]{6}$/i.test(value.hairColour) ? value.hairColour.toLowerCase() : null,
    shoulders: bounded(value.shoulders, BOUNDS.shoulders, DEFAULT_APPEARANCE.shoulders),
    torso: bounded(value.torso, BOUNDS.torso, DEFAULT_APPEARANCE.torso),
  }
}
