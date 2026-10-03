# Assets, data and licences

Original project code uses Apache-2.0. This inventory records third-party code, data, and
assets under their own terms. The root licence does not relicense them. Companion notices
beside the shipped files remain authoritative for each item.

This inventory covers the retained runtime assets and explicitly marked historical or proposed
work. The export manifest records the distributed subset. Retain companion notices with every
distributed asset. Source authoring archives are outside the runnable export.

| What | Used for | Source | Licence | Where it lives |
| --- | --- | --- | --- | --- |
| Microsoft Rocketbox avatar library (14 adults, 22 animations) | Characters and their movement | https://github.com/microsoft/Microsoft-Rocketbox | MIT (copy in `public/wardrobe/ROCKETBOX-LICENSE.md`) | `public/avatars/*.pack.gz`, built by `scripts/build-avatars.mjs` |
| Kenney Furniture Kit 2.0 (140 models) | Home and venue furniture | https://kenney.nl/assets/furniture-kit | CC0 1.0 | `public/packs/furniture.pack.gz`; source in `assets-src/kenney-furniture-kit/` |
| Kenney Mini Characters 1.0 | First character set — **no longer used at runtime** | https://kenney.nl/assets/mini-characters | CC0 1.0 | Historical project files only; excluded from the runnable source export |
| Outfit fabrics and prints | Regional wardrobe | Original work generated for this project by `scripts/build-wardrobe.mjs` (see `public/wardrobe/LICENSE.md`) | Project-owned | `public/wardrobe/*.pack.gz` |
| MediaPipe Face Landmarker (model + WASM) | Reading a face from a photo, on the device | https://developers.google.com/mediapipe · model at `storage.googleapis.com/mediapipe-models/face_landmarker/…` | Apache-2.0 | npm `@mediapipe/tasks-vision`, pinned at exactly `0.10.35`: later versions report usage metrics to the publisher (see `src/features/avatar/README.md`); model fetched at runtime |
| three.js | 3D rendering | https://threejs.org | MIT | npm `three` |
| MapLibre GL | 2D world map | https://maplibre.org | BSD-3-Clause | npm `maplibre-gl` |
| tz-lookup | Timezone of a place | https://github.com/darkskyapp/tz-lookup | CC0 1.0 | npm `tz-lookup` |
| Vue, Vue Router, Vite | App framework and build | https://vuejs.org | MIT | npm |
| OpenStreetMap data | Streets, building outlines, water, parks, places | https://www.openstreetmap.org/copyright | ODbL 1.0 — attribution shown in the world and travel views | Fetched live as vector tiles |
| OpenMapTiles schema / OpenFreeMap tiles | Vector tiles of the above | https://openmaptiles.org · https://openfreemap.org | Attribution required; OpenFreeMap public instance, no key, no SLA | `tiles.openfreemap.org` at runtime |
| Nominatim | Place search and naming the coarse area | https://operations.osmfoundation.org/policies/nominatim/ | Usage policy: ≤ 1 request/s, no autocomplete, attribution | `nominatim.openstreetmap.org` at runtime |

## Things to know

- **Reference and test photographs are not source assets.** Exclude all photos, face crops,
  owner-specific fits, and rendered personal evidence from a source export.
- **Optional photo faces are personal data.** Match me saves editable appearance choices
  without photo pixels. An account can separately choose a reduced crop, up to 512 px, and shape
  points stored by the service, with friends-only visibility by default and removal available.
  Guest photo projection is a temporary preview and is not saved. The original full photo
  remains on the device; saying that no photo data is uploaded would be inaccurate.
- The public map and geocoding endpoints are fine for development. Before real traffic they
  need a provider arrangement or self-hosting (see the capability matrix).
- Nothing here is a brand, a merchant's catalogue or a real person's likeness. The sample
  market sellers are marked as samples.


## Likeness lab candidates, 2026-10-01

Proposed components only. The lab did not install them into product source or public assets, and the complete likeness/phone gate has not passed. These proposed components do not establish an accepted likeness pipeline.

| Proposed item | Code and model grant | Source and required notices | Intended use |
| --- | --- | --- | --- |
| Google GNM Head v3 identity basis | Apache-2.0 for code and model weights, explicit in the [model card](https://huggingface.co/google/gnm-v3). The [source licence](https://github.com/google/GNM/blob/a740b328f6494f13dd90ac5efb47c38def996dfc/LICENSE) also includes the MIT tongue-component notice. | [Google GNM](https://github.com/google/GNM), model-card revision `c01e90d298d82301f9fd18f54806be751775cb7c`. Retain its full licence and attribution; record modifications. Raw training scans were not independently licensed/audited by the lab. | Creator-only local fit. Lab reduction keeps 24 identity components and removes expressions; 2,193,736 raw bytes, 1,324,315 gzip bytes. |
| XR Blocks browser GNM evaluator, fitter and correspondence; assets-gnm export | Apache-2.0 in both [code licence](https://github.com/google/xrblocks/blob/c737bdfd0968777dcd3a2c8e213d71340b951fa1/LICENSE) and [asset licence](https://github.com/xrblocks/assets-gnm/blob/134feb02b11fa642a43ff5e7e880246255a74e86/LICENSE). | [Fitter source](https://github.com/google/xrblocks/tree/c737bdfd0968777dcd3a2c8e213d71340b951fa1/samples/avatar_lab/gnm). Retain notices and mark the lab's shared-frame solver and data reduction changes. | Local, bounded identity fit; no model inference during crowd rendering. |
| MediaPipe SelfieMulticlass 256×256, optional | Its [model-specific card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf) explicitly lists Apache License, Version 2.0. SDK already listed above. | [Fixed float32/1 artifact](https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/1/selfie_multiclass_256x256.tflite), 16,371,837 bytes. Retain Apache/model notices. Training data are not redistributed. | Optional creator-only background/clothing mask; about 15.13 MB compressed download. Dark-skin/accessory quality needs preview and device checks. |

SFace/YuNet evaluation weights, NASA/government portraits, rejected ICT replacement heads and rejected hairstyle-transfer results are not proposed product assets. No private owner image or derived model is included in the product.

## Word Yard word lists, 2026-10-01

Used by the service only (`service/arena/words/`); the App never downloads the full list. Full statements, hashes and build steps are in `service/arena/words/SOURCES.txt`.

| Item | Licence | Source | Use |
| --- | --- | --- | --- |
| ENABLE (Enhanced North American Benchmark Lexicon), 172,823 words, by Alan Beale and M. Cooper | Public domain by the authors' release ("formally released into the Public Domain… Game designers may feel free to incorporate the WORD.LST into their games. Please mention the source and credit us as originators"). The list itself may not be restricted by us | [enable1.txt, National Puzzlers' League copy (Internet Archive)](https://web.archive.org/web/20160118193139/http://www.puzzlers.org/pub/wordlists/enable1.txt) | `enable.txt.gz` (415 KB): 160,085 of its words (2–13 letters, 147 slurs removed) — the list every played word is checked against. Credit shown in the game's how-to-play |
| SCOWL 2020.12.07 (Kevin Atkinson) frequency classes | SCOWL's own permissive notice (use, copy, modify, distribute with the notice kept); used only to choose which ENABLE words count as everyday — it adds no words | [SCOWL readme](https://wordlist.aspell.net/scowl_v1-readme/) | `everyday.txt.gz` (11 KB) for the easy computer player; the short practice list in `src/features/arena/games/words/practice-words.ts` |
| Blocklist of slurs removed from play | Authored here | `service/arena/words/blocklist.ts` | Words never accepted or played by the computer |

## Cast foundry foundation, 2026-10-01

Experimental exports only, excluded from the runnable source export. The live character pipeline has not been replaced. The fictional cast exports require separate art and runtime acceptance.

| Item | Licence and source | Local use and modifications |
| --- | --- | --- |
| MPFB 2.0.17 / MakeHuman bundled base mesh, targets, GameEngine rig and weights | Graphical assets CC0 1.0; tool code GPLv3. [Pinned licence and output statement](https://github.com/makehumancommunity/mpfb2/blob/v2.0.17/LICENSE.md), [full asset statement](https://github.com/makehumancommunity/mpfb2/blob/v2.0.17/LICENSE.ASSETS.md) | 24 fictional adult casts, reduced near/far meshes and projected morph targets in `public/cast/`. GPL addon is a local generation tool, not shipped runtime code. |
| MakeHuman system assets: African skins, low-poly eyes, eyebrow001, teeth_base, afro01, braid01 | CC0 in the [official pack table](https://static.makehumancommunity.org/assets/assetpacks/makehuman_system_assets.html) and each selected `.mhclo` / `.mhmat` header. Copyright holders at release: Data Collection AB, Joel Palmius, Jonas Hauquier. | Reduced textures/meshes, skin luminance and scalp edits, iris colour/catchlight edits, hair LOD. Notices and full CC0 statement in `public/cast/LICENSES.md` and `CC0-LICENSE.md`. |
| Monk Skin Tone Scale, Ellis Monk, 2019 | [Skin Tone Research](https://skintone.google/), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) | Ten reference swatches in the standalone preview. Rendered materials depend on lighting; attribution retained. |
| Rocketbox-derived kaftan/fila and kitenge bodice proof fits | Existing Microsoft MIT licence, retained in `public/cast/ROCKETBOX-LICENSE.md`; [source](https://github.com/microsoft/Microsoft-Rocketbox) | Existing project wardrobe meshes refitted to MPFB. Ankara skirt and fabric adaptations are original project work. These fits remain experimental. |
| Procedural cast hair and facial hair | Original project work | Separate near/far meshes and generated thumbnails. Not artist-approved replacements. |

The private owner feedback screenshot and public portrait reference photographs are not shipped or sampled into textures, meshes or fit data. Reference URLs are recorded only for visual research. No real person's likeness is represented by the fictional seed list.

## Additional shipped notices

These entries record provenance already present beside the assets. They introduce no new
licence grant and do not replace the exact per-file notices.

| Item | Terms and existing source | Retained notice |
| --- | --- | --- |
| Poly Haven surface textures, foliage atlas, and interior models | CC0 1.0. Exact item URLs, authors, and reductions are listed in the pack notice | `public/packs/NOTICE.md` |
| MakeHuman afro01, braid01, and long01 hair adapted for the Rocketbox cast | CC0 1.0 from the MakeHuman system assets inventory, with source and pack hashes | `public/avatars/hair/LICENSE.md` |
| MediaPipe Hair Segmenter | Apache-2.0 in its model card. Exact retained model hash and download source are recorded locally | `public/avatars/hair-analysis/README.md` and `Apache-2.0-MediaPipe.txt` beside it |
| Experimental reduced GNM identity model and XR Blocks fitter | Separate upstream Apache-2.0 grants, including GNM Webcam Puppet credit. These are experimental, not the accepted likeness pipeline | `public/avatars/identity/README.md` and its four adjacent Apache notice files |
| Original regional geometry | CC0 1.0 as already released by the project, not reclassified as Apache artwork | `public/regions/LICENSE.md` |
| Fonts | No font binaries or downloaded web fonts were found in the reviewed baseline. CSS names local installed fonts and system fallbacks | `src/ui/base.css`. A font added later needs its own source and redistribution terms |

## Map-derived vehicle data

Runtime 089 includes a derived road, place, and collision database plus retained
OpenStreetMap source tiles. These data keep ODbL 1.0. Its builder and original shared DTO code
use Apache-2.0. Project-authored region geometry in that pipeline keeps its existing CC0 terms;
map-derived placements retain ODbL.

Before distributing the driving track, retain service/data/transport/NOTICE.md, its exact source
tiles and hashes, and the data licence link. Keep displayed map attribution. The database is
not Apache code and is not a surveyed real-world navigation product. The retained database,
source tiles, notice, and builder are included in this runtime 089 export.

## Derived arrivals and home parcels

| File | Source and terms | Rebuild and notice |
| --- | --- | --- |
| `service/data/transport/street-arrivals.json` | ODbL 1.0. Public arrival coordinates and mapped place labels derived from `yaba-vehicles.json`, its recorded scene sources and the same five retained OpenStreetMap tiles at provider revision `20260927_080001_pt` | `scripts/build-street-arrivals.ts`; `service/data/transport/NOTICE.md`. The data records road, scene and source tile hashes |
| `service/data/homes/yaba-homes.json` | ODbL 1.0, declared in `derivedFrom`. Game parcel geometry and access points derived from the same road authority, scene sources and five retained tiles; these are virtual game placements, not real property boundaries | `scripts/build-home-parcels.ts`; `service/data/homes/NOTICE.md` and `service/data/transport/NOTICE.md`. The data records source versions, hashes and generation rules |

The five source tiles are 14/8345/7895, 14/8345/7896, 14/8346/7895, 14/8346/7896 and
14/8532/7777. The original builders and version-manifest code use the repository's Apache-2.0
code license. Existing regional geometry keeps its recorded CC0 terms. These data additions
introduce no new image, character pack or third-party media license.

## Social previews and icons

`public/social/allworld-og.png`, `public/favicon.png` and `public/apple-touch-icon.png` are original project artwork under Apache-2.0. The icons and social image reuse the project mark from `src/ui/BrandMark.vue`. The illustrated map is original schematic artwork, not OpenStreetMap data or a gameplay screenshot. Editable SVG sources are `scripts/seo/allworld-og.svg` and `scripts/seo/favicon.svg`. See `public/social/NOTICE.md` for production details. No third-party artwork, photographs, member information or ratings are included.
