// External geographic services. Each is a public endpoint with its own terms; none is a paid or
// contracted provider yet. Swap these in one place when a provider arrangement exists, and list
// every host under `externalDomains` in .goalmatic/app.json.
export const providers = {
  tiles: {
    /** OpenFreeMap serves OpenMapTiles-schema vector tiles of OpenStreetMap data, no key required. */
    name: 'OpenFreeMap',
    tileJson: 'https://tiles.openfreemap.org/planet',
    /** Used only if the TileJSON request fails; the dated path changes roughly weekly. */
    fallbackTemplate: 'https://tiles.openfreemap.org/planet/20260927_080001_pt/{z}/{x}/{y}.pbf',
    attribution: 'Map data © OpenStreetMap contributors · Tiles © OpenMapTiles, served by OpenFreeMap',
    attributionLinks: [
      { label: 'OpenStreetMap', href: 'https://www.openstreetmap.org/copyright' },
      { label: 'OpenMapTiles', href: 'https://www.openmaptiles.org/' },
      { label: 'OpenFreeMap', href: 'https://openfreemap.org' },
    ],
  },
  geocoder: {
    /** Nominatim usage policy: at most one request per second, no autocomplete, attribution required. */
    name: 'Nominatim (OpenStreetMap)',
    search: 'https://nominatim.openstreetmap.org/search',
    reverse: 'https://nominatim.openstreetmap.org/reverse',
    minIntervalMs: 1100,
  },
  face: {
    /** MediaPipe Face Landmarker (Apache-2.0). Runs in the browser; the photo is not uploaded. */
    name: 'MediaPipe Face Landmarker',
    model: 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  },
} as const

export const externalHosts = ['tiles.openfreemap.org', 'nominatim.openstreetmap.org', 'storage.googleapis.com'] as const
