// Evidence probe: real map data for controlled test places in several countries.
// Fetches live tiles from the configured provider. Prints one line per place.
import assert from 'node:assert/strict'
import { STARTER_PLACES } from '../src/shared/places.ts'
import { areaFromPlace } from '../src/geo/areas.ts'
import { DistrictLoadError, chooseArrival, loadDistrict } from '../src/geo/district.ts'
import { StreetNavigator } from '../src/world/nav.ts'
import { areaOfDistrict, coarsen, districtIdOf, tileSpanMetres, parseDistrictId } from '../src/shared/geo.ts'
import { countryDefaults } from '../src/shared/places.ts'

const countries = new Set<string>()

function assertRouteClear(label: string, nav: StreetNavigator, from: { x: number; z: number }, points: { x: number; z: number }[]): void {
  let previous = from
  for (const point of points) {
    const distance = Math.hypot(point.x - previous.x, point.z - previous.z)
    const steps = Math.max(1, Math.ceil(distance / 0.4))
    let cursor = previous
    for (let step = 1; step <= steps; step++) {
      const remaining = steps - step + 1
      const dx = (point.x - cursor.x) / remaining
      const dz = (point.z - cursor.z) / remaining
      const moved = nav.step(cursor, dx, dz)
      assert.equal(moved.blocked, false, `${label}: route is blocked at ${cursor.x.toFixed(1)},${cursor.z.toFixed(1)}`)
      assert.ok(Math.hypot(moved.pos.x - cursor.x - dx, moved.pos.z - cursor.z - dz) < 0.01, `${label}: route leaves its planned segment`)
      cursor = moved.pos
    }
    previous = point
  }
}

for (const place of STARTER_PLACES) {
  const label = place.label
  const area = areaFromPlace(place)
  assert.equal(areaOfDistrict(area.arrivalDistrict), area.areaId, 'arrival district is inside the area')
  const district = await loadDistrict(area.arrivalDistrict)
  const arrival = chooseArrival(district)
  const nav = new StreetNavigator(district)
  assert.ok(district.roads.length > 20, `${label}: has streets`)
  assert.ok(nav.walkable(arrival.pos), `${label}: arrival point is walkable`)
  assert.notEqual(arrival.basis, 'district-centre', `${label}: arrival is tied to the map`)
  if (arrival.placeId) {
    const arrivalPoi = district.pois.find(poi => poi.placeId === arrival.placeId)
    assert.ok(arrivalPoi, `${label}: arrival references an actual mapped POI`)
    const publicWay = nav.publicStreetPoint(arrivalPoi.pos)
    assert.ok(publicWay && Math.hypot(publicWay.pos.x - arrival.pos.x, publicWay.pos.z - arrival.pos.z) < 0.01, `${label}: arrival is tied to the POI's public way`)
  }
  const publicPlaces = district.pois.map(poi => nav.publicStreetPoint(poi.pos)).filter(entry => entry !== null)
  const reachableWithin400 = nav.walkingCoverage([arrival.pos], publicPlaces.map(entry => entry.pos), 400)[0] ?? 0
  assert.ok(reachableWithin400 > 0, `${label}: arrival has a mapped place within a five-minute walk`)
  const trapped = district.buildings
    .map(building => building.outer.reduce((sum, point) => ({ x: sum.x + point.x / building.outer.length, z: sum.z + point.z / building.outer.length }), { x: 0, z: 0 }))
    .find(point => !nav.walkable(point))
  if (trapped) {
    const rescued = nav.nearestWalkable(trapped)
    assert.ok(rescued && nav.walkable(rescued), `${label}: rescue finds open ground from a building`)
  }
  // Walk from the arrival point to the best-ranked named place along real streets.
  const target = [...district.pois].sort((a, b) => a.rank - b.rank)[0]
  const route = target ? nav.route(arrival.pos, nav.venueApproach(target.pos) ?? target.pos) : null
  if (route && target) {
    if (route.length >= 25) assert.equal(route.viaStreets, true, `${label}: route to ${target.name} uses the street graph`)
    assert.ok(route.points.length > 0, `${label}: route has collision-clear waypoints`)
    assertRouteClear(label, nav, arrival.pos, route.points)
  }
  if (label === 'Yaba, Lagos') {
    const cafe = district.pois.find(poi => /cafe neo/i.test(poi.name))
    assert.ok(cafe, 'Yaba has the reported Cafe Neo')
    const approach = nav.venueApproach(cafe.pos)
    assert.ok(approach, 'Cafe Neo has a public street approach')
    const cafeRoute = nav.route(arrival.pos, approach)
    assert.ok(cafeRoute.points.length > 0, 'Yaba arrival can route to Cafe Neo')
    assert.ok(cafeRoute.length <= 400, 'Cafe Neo is within a five-minute mapped walk from the Yaba arrival')
    assertRouteClear(label, nav, arrival.pos, cafeRoute.points)
    console.log(`PASS Yaba Cafe Neo public approach: ${Math.round(cafeRoute.length)}m, ${cafeRoute.points.length} waypoints`)

    const revision = nav.revision
    nav.registerObstacles('verify-flat-paint', [{ pos: arrival.pos, angle: 0, width: 4, depth: 4, height: 0.05 }])
    assert.equal(nav.obstacleCount, 0, 'flat paint metadata does not create a blocker')
    assert.ok(nav.walkable(arrival.pos), 'flat paint remains walkable')
    nav.unregisterObstacles('verify-flat-paint')

    const blockedWaypoint = cafeRoute.points[Math.floor(cafeRoute.points.length / 2)]!
    const prop = [{ pos: blockedWaypoint, angle: 0.37, width: 2.4, depth: 1.8, height: 1.2 }]
    nav.registerObstacles('verify-prop', prop)
    assert.equal(nav.revision, revision + 3, 'register and unregister update the navigation revision')
    assert.equal(nav.obstacleCount, 1, 'solid prop is indexed')
    assert.equal(nav.walkable(blockedWaypoint), false, 'solid prop blocks its footprint')
    const detour = nav.route(arrival.pos, approach)
    assert.ok(detour.points.length > 0 && detour.length > cafeRoute.length, 'route cache invalidates and finds a longer graph detour around the prop')
    assertRouteClear(`${label} prop detour`, nav, arrival.pos, detour.points)
    const stableRevision = nav.revision
    nav.registerObstacles('verify-prop', prop)
    assert.equal(nav.revision, stableRevision, 'registering an equal obstacle set is a no-op')
    nav.unregisterObstacles('verify-prop')
    assert.equal(nav.obstacleCount, 0, 'unregister removes the prop set')
    assert.ok(nav.walkable(arrival.pos), 'unregister restores the public way')
    const replay = nav.walkingRoute(arrival.pos, approach)
    assert.ok(replay.points.length > 0 && Math.abs(replay.length - cafeRoute.length) < 0.01, 'route replay is restored after unregister')
    assertRouteClear(`${label} obstacle replay`, nav, arrival.pos, replay.points)
    console.log(`PASS Yaba prop obstacle replay: revision=${nav.revision}, blockers=${nav.obstacleCount}`)
  }
  if (label === 'Osu, Accra') {
    const woodin = district.pois.find(poi => poi.name === 'Woodin')
    assert.ok(woodin, 'Osu has the mapped same-link route sample')
    const publicWay = nav.publicStreetPoint(woodin.pos)
    assert.ok(publicWay, 'Woodin has a public-way projection')
    const sameLink = nav.walkingRoute(arrival.pos, publicWay.pos)
    const alongLink = Math.hypot(publicWay.pos.x - arrival.pos.x, publicWay.pos.z - arrival.pos.z)
    assert.ok(sameLink.viaStreets && Math.abs(sameLink.length - alongLink) < 0.01, 'same-link route uses the mapped subsegment without doubling back to an endpoint')
    assertRouteClear(`${label} same-link route`, nav, arrival.pos, sameLink.points)
    console.log(`PASS Osu same-link route: ${sameLink.length.toFixed(2)}m, ${sameLink.points.length} waypoints`)
  }
  const defaults = countryDefaults(place.countryCode)
  const localTime = new Intl.DateTimeFormat('en-GB', { timeZone: area.timezone, hour: '2-digit', minute: '2-digit' }).format(Date.UTC(2026, 9, 1, 12))
  countries.add(place.countryCode)
  console.log(`PASS ${label} [${place.countryCode}] ${area.arrivalDistrict} span=${Math.round(district.span)}m data=${district.dataVersion}`)
  console.log(`     coverage=${district.coverage.level} roads=${district.coverage.roads} named=${district.coverage.namedStreets} buildings=${district.coverage.buildings} places=${district.coverage.places} graphNodes=${nav.streetNodeCount}`)
  console.log(`     arrival="${arrival.label}" (${arrival.basis}) tz=${area.timezone} 12:00Z→${localTime} units=${defaults.units} currency=${defaults.currency}`)
  console.log(`     five-minute walk: ${reachableWithin400}/${publicPlaces.length} public-way places within 400m`)
  if (route && target) console.log(`     route to "${target.name}": ${Math.round(route.length)}m, ${route.points.length} waypoints, viaStreets=${route.viaStreets}`)
}
assert.ok(countries.size >= 4, 'covers at least four countries')

// Missing data: open ocean has no streets. The loader must report it, not invent a city.
const ocean = districtIdOf({ lat: -30, lon: -140 })
try {
  const district = await loadDistrict(ocean)
  assert.equal(district.coverage.level, 'empty')
  assert.equal(chooseArrival(district).basis, 'district-centre')
  console.log(`PASS open ocean ${ocean}: coverage=empty, summary="${district.coverage.summary}"`)
} catch (error) {
  assert.ok(error instanceof DistrictLoadError)
  console.log(`PASS open ocean ${ocean}: loader reported "${error.kind}" — ${error.message}`)
}

// A device reading is reduced to its coarse cell centre before anything else sees it.
const reading = { lat: 7.44321987, lon: 3.90876543 }
const coarse = coarsen(reading)
const cell = tileSpanMetres({ z: 12, x: 2092, y: 1963 })
assert.notEqual(coarse.lat, reading.lat)
assert.ok(Math.abs(coarse.lat - reading.lat) < 0.09 && Math.abs(coarse.lon - reading.lon) < 0.09)
assert.ok(parseDistrictId(districtIdOf(coarse)))
console.log(`PASS coarsen: ${reading.lat},${reading.lon} → ${coarse.lat.toFixed(4)},${coarse.lon.toFixed(4)} (cell ≈ ${(cell / 1000).toFixed(1)} km wide)`)
