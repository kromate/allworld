import type { LatLon } from '../../shared/geo.ts'

export type MapCoordinate = [longitude: number, latitude: number]

const radians = (degrees: number): number => (degrees * Math.PI) / 180
const degrees = (angle: number): number => (angle * 180) / Math.PI

/** Samples the shorter great-circle arc and keeps longitudes continuous across the dateline. */
export function greatCircleRoute(from: LatLon, to: LatLon, samples = 96): MapCoordinate[] {
  const fromLat = radians(from.lat)
  const fromLon = radians(from.lon)
  const toLat = radians(to.lat)
  const toLon = radians(to.lon)
  const start: [number, number, number] = [Math.cos(fromLat) * Math.cos(fromLon), Math.cos(fromLat) * Math.sin(fromLon), Math.sin(fromLat)]
  const end: [number, number, number] = [Math.cos(toLat) * Math.cos(toLon), Math.cos(toLat) * Math.sin(toLon), Math.sin(toLat)]
  const dot = Math.max(-1, Math.min(1, start[0] * end[0] + start[1] * end[1] + start[2] * end[2]))
  const angle = Math.acos(dot)
  let axis: [number, number, number] = [
    start[1] * end[2] - start[2] * end[1],
    start[2] * end[0] - start[0] * end[2],
    start[0] * end[1] - start[1] * end[0],
  ]
  let axisLength = Math.hypot(...axis)
  if (axisLength < 1e-8) {
    const reference: [number, number, number] = Math.abs(start[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0]
    axis = [
      start[1] * reference[2] - start[2] * reference[1],
      start[2] * reference[0] - start[0] * reference[2],
      start[0] * reference[1] - start[1] * reference[0],
    ]
    axisLength = Math.hypot(...axis)
  }
  axis = [axis[0] / axisLength, axis[1] / axisLength, axis[2] / axisLength]
  const count = Math.max(2, Math.round(samples))
  const route: MapCoordinate[] = []
  let previousLongitude = from.lon

  for (let index = 0; index <= count; index += 1) {
    const progress = index / count
    const turn = angle * progress
    const cosine = Math.cos(turn)
    const sine = Math.sin(turn)
    const axisDotStart = axis[0] * start[0] + axis[1] * start[1] + axis[2] * start[2]
    const crossX = axis[1] * start[2] - axis[2] * start[1]
    const crossY = axis[2] * start[0] - axis[0] * start[2]
    const crossZ = axis[0] * start[1] - axis[1] * start[0]
    const x = start[0] * cosine + crossX * sine + axis[0] * axisDotStart * (1 - cosine)
    const y = start[1] * cosine + crossY * sine + axis[1] * axisDotStart * (1 - cosine)
    const z = start[2] * cosine + crossZ * sine + axis[2] * axisDotStart * (1 - cosine)
    const length = Math.hypot(x, y, z) || 1
    let longitude = degrees(Math.atan2(y / length, x / length))
    const latitude = degrees(Math.atan2(z / length, Math.hypot(x / length, y / length)))

    while (longitude - previousLongitude > 180) longitude -= 360
    while (longitude - previousLongitude < -180) longitude += 360
    route.push([longitude, latitude])
    previousLongitude = longitude
  }

  return route
}

export function pointAlongRoute(route: readonly MapCoordinate[], progress: number): MapCoordinate | null {
  if (route.length === 0) return null
  if (route.length === 1) return route[0] ?? null
  const position = Math.max(0, Math.min(1, progress)) * (route.length - 1)
  const startIndex = Math.floor(position)
  const endIndex = Math.min(route.length - 1, startIndex + 1)
  const start = route[startIndex]
  const end = route[endIndex]
  if (!start || !end) return null
  const fraction = position - startIndex
  return [start[0] + (end[0] - start[0]) * fraction, start[1] + (end[1] - start[1]) * fraction]
}
