# Yaba/Lagos and Wuse/Abuja vehicle map data

Map data © OpenStreetMap contributors, under the Open Data Commons Open Database License (ODbL) 1.0. This derived road, place and collision database and its retained source tiles keep that license. They are not Apache-2.0 data.

- Copyright and attribution: https://www.openstreetmap.org/copyright
- Data license: https://opendatacommons.org/licenses/odbl/1-0/
- Tiles © OpenMapTiles, served by OpenFreeMap: https://openmaptiles.org/ and https://openfreemap.org/
- Exact source: https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf
- Covered tiles: 14/8345/7895, 14/8345/7896, 14/8346/7895, 14/8346/7896 and 14/8532/7777.

Wuse coverage uses the public starter anchor in `src/shared/places.ts`, 9.0765, 7.476. It does not derive from a member's private virtual position. The old region audit's longitude 7.465 refers to a different adjacent tile, which is outside this finite extension. On 2026-10-02 the public OpenFreeMap TileJSON returned the same dated revision; the source tile responded successfully and its retained bytes have SHA256 `a1a76a2dd2d67cc418f022e7dd219fd850f61a9a2dfcce8b3dd35828383041a6`.

Source bytes, exact URLs and SHA256 hashes are retained in `source/` and `yaba-vehicles.json`. Regenerate offline with `node scripts/build-vehicle-road-data.ts`. Optional `--fetch` downloads only the fixed coverage allowlist at the fixed revision. The builder projects the existing district scene, extracts road geometry, splits surface junctions, excludes ambiguous bridge/tunnel connectivity, and attaches road stops and game depots. Graph directions are inferred two-way game navigation, not legal traffic directions or surveyed access permissions. Separate cities have separate connected components; no cross-city road is invented.

`street-arrivals.json` is also an ODbL 1.0 derived database. `scripts/build-street-arrivals.ts`
decodes those same five retained source tiles and chooses public arrival points using the scene
code recorded in `yaba-vehicles.json`. The arrival database records the road data version, scene
hash and each tile's SHA256. `node scripts/build-street-arrivals.ts --check` verifies the source
hashes, road authority and generated result without writing. Its original builder code follows
Apache-2.0. Arrival coordinates and mapped place labels keep the map data's ODbL terms.

The derived home parcel database `service/data/homes/yaba-homes.json` uses the same road data,
scene sources and five retained tiles. Its provenance and ODbL notice are in
`service/data/homes/NOTICE.md`; its original builder is `scripts/build-home-parcels.ts`.

Illustrative solid street props use original project-authored Nigeria pack geometry and deterministic scene placements. Wuse uses the Abuja kit, while the four Yaba districts retain the Lagos kit. That geometry is CC0 1.0, as recorded in `public/regions/LICENSE.md`. Map-derived positions in this combined database retain ODbL. No external artwork or real people's likenesses is added.

This data is for five local game districts. It is not a real-world navigation product. Keep displayed map attribution and provide this notice, the data license link, source tiles and builder alongside distributed data. Original builder and shared DTO code follow the repository's Apache-2.0 code license. The existing service file and client manifest filenames are retained to use the existing trusted-data loader without changing authority or protocol code.
