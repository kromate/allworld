# The world engine

The engine draws districts, rooms, and characters. `src/state/world.ts` selects the scene and
wires its controller. The engine does not own shared permissions or outcomes.

| Files | Responsibility |
| --- | --- |
| `engine.ts` | Renderer, camera, input, frame loop, scene switching |
| `districtScene.ts`, `facadeStyles.ts`, `facadeDetails.ts`, `streetDetail.ts`, `vegetationStyles.ts`, `sky.ts` | Map-derived streets and stylised detail |
| `nav.ts`, `cameraCollision.ts` | Walking routes and camera obstruction |
| `interior.ts`, `venueInteriors.ts`, `newinteriorFurniture.ts` | Homes and venue rooms |
| `regions/`, `regionMount.ts` | Region-specific frontages, stalls, scenery, and traffic |
| `avatars.ts`, `faces.ts`, `wardrobe.ts`, `surface*.ts` | Character geometry, animation, skin, hair, clothes |
| `governor.ts`, `gpuBudget.ts`, `surfaceMemory.ts` | Frame-time and memory budgets |
| `packs.ts` | On-demand asset packs |
| `ambience.ts`, `minimap.ts` | Street sound and corner map |

No feature-window imports enter this layer. A shared type belongs in the contract or a
framework-free engine module. Dispose every created geometry, material, texture, render
target, audio node, and listener. Detail follows the existing device tiers and includes a
cheaper form. Measure idle and active cost before claiming a phone improvement.

Map streets, names, and outlines use geographic data. Decorative scenery must not imply a
real business or member. Scenery pedestrians have no names and do not enter counts or chat.
Regional authored geometry comes from `scripts/regions/models.mjs` through
`scripts/build-regions.mjs`. Its public notice retains the existing CC0 release.

The baseline has no integrated drivable or expanded-home pipeline. Their prepared engine
entry points and dependencies are listed in [CONTRIBUTOR-MAP.md](../../docs/CONTRIBUTOR-MAP.md).
Read [scripts/README.md](../../scripts/README.md) for asset rebuild boundaries.
