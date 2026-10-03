# Characters and photo analysis

The avatar window edits appearance. Rendering belongs to `src/world/avatars.ts`, `src/world/faces.ts`,
`src/world/wardrobe.ts`, and the surface modules. Shared appearance validation is in
`src/shared/appearance.ts`; optional photo storage and audience checks are in `service/members.ts`.

| File | Responsibility |
| --- | --- |
| `AvatarEditor.vue`, `AppearanceControls.vue`, `SkinTonePicker.vue` | Editable body, tone, shape, hair, and clothing choices |
| `AvatarPreview.vue`, `AvatarPortrait.vue` | Character preview and small portrait |
| `FaceCapture.vue` | Camera or chosen image, analysis result, match choices, optional photo preview |
| `faceScan.ts`, `hairAnalysis.ts` | On-device face landmarks, crop quality, broad hair suggestions |
| `useFace.ts` | Save, reload, audience change, deletion through the service |
| `skinTones.ts` | Monk Skin Tone swatches, with CC BY 4.0 attribution |
| `identityFit.ts`, `identityWorker.ts`, `identity/gnm/` | Parked experimental GNM fitter and upstream code; not the accepted likeness pipeline |

Match me saves editable appearance without photo pixels. An account can separately save a
reduced photo crop and shape points with a chosen audience. Friends-only is the default.
Guests can preview photo projection but cannot save it. The original full photo remains on
the device; the optional saved crop is photo data sent to the service.

No model generates an image or character. No generation provider is connected. The current
MediaPipe package is pinned at `0.10.35`. A version change requires an outgoing-request audit
and a browser check of model downloads, analysis, cancellation, and resource cleanup.
Do not infer ethnicity, nationality, age, or gender. Every suggestion stays editable.

Close camera streams, model sessions, and workers on cancellation or unmount. Treat no-face,
blur, framing, failed model loading, and failed rendering as recoverable states. Check the
whole character before enabling saved photo projection. Never commit photographs, face
crops, owner-specific fits, or renders of real people, including as fixtures or evidence.

Licence provenance is in [ASSETS-LICENSES.md](../../../docs/ASSETS-LICENSES.md) and the notices
beside `public/avatars/` assets. Read [the contributor map](../../../docs/CONTRIBUTOR-MAP.md)
for the service and UI boundaries.
