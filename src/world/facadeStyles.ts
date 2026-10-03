export interface DistrictSceneContext {
  /** ISO 3166-1 alpha-2 where available. `UK` is accepted as an alias for `GB`. */
  countryCode?: string
  /** Human-readable virtual area, used only to choose a more specific illustrative kit. */
  areaLabel?: string
}

export type FacadeStyleId = 'nigeria-lagos' | 'nigeria' | 'uk' | 'neutral'
export type FacadeSurface = 'plaster' | 'brick' | 'concrete'
export type VegetationFamily = 'tropical' | 'temperate' | 'mixed'

export interface FacadeStyle {
  id: FacadeStyleId
  /** Regional parts are procedural guesses. Mapped footprint, height, base and POI names remain data. */
  basis: 'illustrative-regional-kit'
  surfaces: readonly FacadeSurface[]
  wallColours: readonly string[]
  roofColours: readonly string[]
  frameColour: string
  sillColour: string
  doorColours: readonly string[]
  groundFloorHeight: number
  storeyHeight: number
  sillHeight: readonly [number, number]
  windowWidth: readonly [number, number]
  windowHeight: number
  baySpacing: number
  barredWindowRate: number
  balconyRate: number
  pitchedRoofRate: number
  waterTankRate: number
  awningDepth: number
  drainage: 'open' | 'gutter'
  vegetation: VegetationFamily
}

const NIGERIA_COMMON = {
  basis: 'illustrative-regional-kit',
  surfaces: ['plaster', 'plaster', 'concrete', 'plaster', 'brick'],
  wallColours: ['#e6c79f', '#d4a16f', '#e8d8b7', '#c8d5b1', '#d9b5a0', '#e2ca70', '#b9c9d5'],
  roofColours: ['#8c4e42', '#9a6752', '#65717b', '#8f7562'],
  frameColour: '#e7dfcf',
  sillColour: '#d8d0c1',
  doorColours: ['#443a32', '#315349', '#713f34', '#2f465d'],
  groundFloorHeight: 3.35,
  storeyHeight: 3.05,
  sillHeight: [0.92, 1.04],
  windowWidth: [1.02, 1.18],
  windowHeight: 1.2,
  baySpacing: 2.65,
  barredWindowRate: 0.72,
  balconyRate: 0.36,
  pitchedRoofRate: 0.55,
  waterTankRate: 0.34,
  awningDepth: 1.05,
  drainage: 'open',
  vegetation: 'tropical',
} as const satisfies Omit<FacadeStyle, 'id'>

const STYLES: Record<FacadeStyleId, FacadeStyle> = {
  'nigeria-lagos': {
    ...NIGERIA_COMMON,
    id: 'nigeria-lagos',
    wallColours: ['#edcf9b', '#d78b63', '#e6d7ad', '#9fc5b2', '#dca97b', '#e5c558', '#aebfd1'],
    balconyRate: 0.44,
    pitchedRoofRate: 0.46,
  },
  nigeria: { ...NIGERIA_COMMON, id: 'nigeria' },
  uk: {
    id: 'uk',
    basis: 'illustrative-regional-kit',
    surfaces: ['brick', 'brick', 'brick', 'plaster', 'concrete'],
    wallColours: ['#bd8065', '#a66f5a', '#c09377', '#8f695c', '#d0b39a', '#b67f63'],
    roofColours: ['#48505a', '#59616b', '#4b535d', '#6a5d58'],
    frameColour: '#eee9dd',
    sillColour: '#ddd7ca',
    doorColours: ['#2e413b', '#523537', '#223a55', '#3f322b'],
    groundFloorHeight: 3.45,
    storeyHeight: 3.05,
    sillHeight: [0.88, 0.98],
    windowWidth: [0.96, 1.1],
    windowHeight: 1.28,
    baySpacing: 2.35,
    barredWindowRate: 0,
    balconyRate: 0.08,
    pitchedRoofRate: 0.68,
    waterTankRate: 0,
    awningDepth: 0.82,
    drainage: 'gutter',
    vegetation: 'temperate',
  },
  neutral: {
    id: 'neutral',
    basis: 'illustrative-regional-kit',
    surfaces: ['plaster', 'brick', 'concrete'],
    wallColours: ['#e2d2bc', '#d4bca9', '#d8d2c8', '#c4cdd2', '#d8caa6', '#c8d2c2'],
    roofColours: ['#7e6560', '#6f7780', '#8a8176', '#7c7069'],
    frameColour: '#dedbd2',
    sillColour: '#cbc7bc',
    doorColours: ['#4b4039', '#394b50', '#59443c'],
    groundFloorHeight: 3.25,
    storeyHeight: 3.05,
    sillHeight: [0.9, 1.02],
    windowWidth: [1, 1.16],
    windowHeight: 1.2,
    baySpacing: 2.55,
    barredWindowRate: 0.08,
    balconyRate: 0.16,
    pitchedRoofRate: 0.38,
    waterTankRate: 0.08,
    awningDepth: 0.9,
    drainage: 'gutter',
    vegetation: 'mixed',
  },
}

function normaliseCountry(countryCode: string | undefined): string {
  const code = countryCode?.trim().toUpperCase() ?? ''
  return code === 'UK' ? 'GB' : code
}

export function resolveFacadeStyle(context: DistrictSceneContext = {}): FacadeStyle {
  const country = normaliseCountry(context.countryCode)
  if (country === 'NG') {
    const area = context.areaLabel?.toLocaleLowerCase() ?? ''
    return /(^|[^a-z])(lagos|yaba|ikeja|lekki|surulere|ikorodu)([^a-z]|$)/.test(area) ? STYLES['nigeria-lagos'] : STYLES.nigeria
  }
  if (country === 'GB') return STYLES.uk
  return STYLES.neutral
}
