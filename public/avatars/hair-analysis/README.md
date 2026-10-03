# Local hair segmentation model

`hair-segmenter.pack.gz` is a deterministic gzip of the official [MediaPipe Hair Segmenter float32 model](https://storage.googleapis.com/mediapipe-models/image_segmenter/hair_segmenter/float32/latest/hair_segmenter.tflite), downloaded 2026-10-01. The `latest` source URL can change; this copy is fixed by its SHA-256.

- Uncompressed TFLite: 781,618 bytes, SHA-256 `2628cf3ce5f695f604cbea2841e00befcaa3624bf80caf3664bef2656d59bf84`.
- Gzip pack: 695,627 bytes, SHA-256 `b10fa4df3962272029b2dff8f882aee0fb1160f26dec0db6c5fc3791c01d7af5`.
- The [official model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20-%20Hair%20Segmentation.pdf) identifies its license as Apache-2.0; the upstream Apache notice is adjacent. The card warns that thin braids and headwear can segment unreliably. No raw training images are included.

`src/features/avatar/hairAnalysis.ts` loads this model only during creator analysis. Original capture pixels remain in the browser. It measures a hair silhouette and suggests only broad library shapes; it does not identify braids, locs, or hair texture. The player chooses the final style.
