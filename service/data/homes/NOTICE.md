# Home parcels

`yaba-homes.json` lists the spots where a member's house may stand in the game, in the districts
the vehicle road data covers. It is a database derived from OpenStreetMap data and carries the
same terms.

- **Map data** © OpenStreetMap contributors, Open Database License 1.0
  (<https://opendatacommons.org/licenses/odbl/1-0/>). Tiles © OpenMapTiles, served by OpenFreeMap,
  provider revision `20260927_080001_pt`.
- **Derived from** the vehicle road data (`service/data/transport/yaba-vehicles.json`, see its
  own notice) and the same five source tiles (`service/data/transport/source/*.pbf`):
  14/8345/7895, 14/8345/7896, 14/8346/7895, 14/8346/7896 and 14/8532/7777. The file
  names both by hash in `derivedFrom` and in each district's `tileSha256`.
- **Made by** `scripts/build-home-parcels.ts`, with no hand editing. Every number that decides a
  parcel is in the file under `derivedFrom.rules`. `node scripts/build-home-parcels.ts --check`
  rebuilds it and compares.
- **What it is not.** A parcel is clear ground in the game's copy of the map. It is not a real
  plot, address, property boundary or a claim that anything can be built there, and it says
  nothing about where any person lives.

`src/assets/homes/yaba-home-scene.json` carries version identifiers, source tile hashes and parcel
counts for the App. Parcel geometry and access points stay on the service. The original builder
and version-manifest code follow the repository's Apache-2.0 code license; the derived parcel
database retains ODbL 1.0.
