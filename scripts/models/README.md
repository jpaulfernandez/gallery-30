# Model files

Where the ONNX models in `crates/develop/models.toml` come from, and how to rebuild the ones we may want to host
ourselves. Every manifest entry pins a URL, a size and a SHA-256; the editor downloads into
`~/Library/Application Support/com.photobook.editor/models/<name>/<version>/` and refuses a file whose hash differs.
Only permissive licences ship (DEVELOP_PLAN section 2).

## Denoise (step D5.1)

| Manifest name | Source | Licence | File |
| --- | --- | --- | --- |
| `nafnet-sidd-width32` | ailia's export of the official NAFNet-SIDD-width32 weights: `https://storage.googleapis.com/ailia-models/nafnet/NAFNet-SIDD-width32.onnx` | MIT ([NAFNet LICENSE](https://github.com/megvii-research/NAFNet/blob/main/LICENSE)) | fp32, opset 11, 117,115,760 bytes, SHA-256 `c3af4811…bd4ead4`; input `inp` [1, 3, height, width] (dynamic, fixed to 512² through `dims`), output `3195` |
| `scunet-color-real-psnr` | Heliosoph's export of cszn/SCUNet `scunet_color_real_psnr`, `huggingface.co/Heliosoph/scunet-onnx` at commit `6d11417` | Apache-2.0 (SCUNet); the export repo ships KAIR's MIT licence | fp32, opset 17, graph 3.8 MB + external data 73 MB; input `image` [batch, 3, height, width] fixed to 1 × 512² |
| `nafnet-sidd-width64` | not in the manifest: the only ONNX export is Qualcomm AI Hub's (login required, fixed 256²); export our own with the script below | MIT | — |

Plan 26 (denoise model evaluation, `docs/design/DENOISE_EVAL.md`) added three export scripts and four candidate
files. None is in the manifest yet: our own exports are to be hosted on a GitHub Release of this repo
(`https://github.com/jpaulfernandez/gallery-30/releases/download/<tag>/<file>`), and `models.toml` carries each one
as a commented-out entry with a TODO until that release exists.

| Candidate | Script | Weights (licence) | Our export |
| --- | --- | --- | --- |
| NAFNet-SIDD-width32, fp16, static 512 | `export_nafnet.py --weights-from-onnx` | taken from the pinned ailia file (MIT) | 58,943,660 bytes, SHA-256 `5efeca7c1088bb140717e41a26b2ae8c8ccaf5b5343879f9793aa2b7f4d8af66`; matches ailia's output within 2e-4 |
| NAFNet-SIDD-width64, fp16, static 512 | `export_nafnet.py --weights` | `NAFNet-SIDD-width64.pth` (Google Drive, linked from the NAFNet README) or `mlx-community/NAFNet-SIDD-width64` (MIT, 463,995,842 bytes): both over the session's 300 MB download limit, not downloaded | random-weight export only (232 MB), for the Core ML partition count and the timing |
| SCUNet real PSNR, static 512, no Einsum | `export_scunet.py` | `scunet_color_real_psnr.pth`, KAIR v1.0 release (code Apache-2.0, KAIR MIT), 71,982,841 bytes, SHA-256 `fa78899b…f809c2e` (equal to the Hub's LFS id in `deepinv/scunet`) | fp32 77,695,966 bytes (`fe844d4e…9081a6d`), fp16 39,393,004 bytes (`90a49021…c366c4fa4`); matches Heliosoph's export within 5e-7 |
| DRUNet colour (σ-map), fp16, static 512 | `export_drunet.py` | `drunet_color.pth`, KAIR v1.0 release (KAIR and DPIR are MIT; `deepinv/drunet` card BSD-3-Clause), 130,579,305 bytes, SHA-256 `479abe3c…cee430bec4b4` (equal to the Hub's LFS id in `deepinv/drunet`) | 65,315,797 bytes, SHA-256 `c5672fb9ad0e64dbb3523948114f3405d7e0f444b4920c5bb94a729b62d78810` |

**Host fp32, not fp16.** On Core ML every fp16 conversion was slower than the fp32 graph (width32 179 against
104 ms per tile, width64 3.2 to 6.7 times, SCUNet 1203 against 499 ms, DRUNet 1.08 times), so the manifest TODO entries name static fp32
files: width32 fp32 117,085,438 bytes (`c995bbef671082ffb774e9d1b94ce74172d4159afc5938c88ce5013bfb629f7a`, not needed:
ailia's file with `dims` is as fast), SCUNet fp32 77,695,966 bytes
(`fe844d4e406db66b6f903d2a9e11d5544a79085c2333755609a7f63915798af3`), DRUNet fp32 130,589,231 bytes
(`4431b4f45be7965dec7691dc8687daeb3b238d5a687187ebc6cd76400533f5b5`). Drop `--fp16` from the commands below for those.

The exports are byte-reproducible with torch 2.14.0, onnx 1.23.2 and onnxconverter-common 1.16.0 (two runs gave
the same SHA-256), so whoever creates the release can rebuild a file and check it against the hash above before
uploading it. With other versions, take the hash the script prints.

The ailia file was pinned by downloading it once (2026-10-10): its bucket MD5 (`tGuXkeInMT4i3U6kT4PX0Q==`) matched,
its SHA-256 went into the manifest, and it loads and runs in ONNX Runtime at 512². The URL is not
content-addressed, so the hash is what protects us if the object ever changes.

### Re-exporting NAFNet (`export_nafnet.py`)

The target is our own fixed-shape export hosted on a GitHub Release of this repo (no dynamic shapes for CoreML to
specialise; plan 26 measured fp32 faster than fp16 on Core ML, so host fp32). `export_nafnet.py` contains an export-friendly copy of
NAFNet's architecture (the custom-autograd LayerNorm written as plain ops; no internal pad/crop since the shape is
fixed) and the SIDD configuration (width 32 or 64, middle 12, encoders `[2, 2, 4, 8]`, decoders `[2, 2, 2, 2]`).

1. Download the official weights `NAFNet-SIDD-width32.pth` (or `-width64.pth`) from the links in the
   [NAFNet README](https://github.com/megvii-research/NAFNet#results-and-pre-trained-models). They load with
   `torch.load(..., weights_only=True)`, so no pickled code runs.
2. `pip install torch onnx onnxconverter-common onnxruntime`, then

   ```sh
   python3 scripts/models/export_nafnet.py --weights NAFNet-SIDD-width32.pth --width 32 \
       --size 512 --opset 17 --fp16 --check --out NAFNet-SIDD-width32-512-fp16.onnx
   ```

   `--check` compares ONNX Runtime with PyTorch on a random tile (tolerance 2e-2 for fp16, 1e-4 for fp32) and the
   script prints the size and SHA-256. `--random-weights --size 64` exercises the export path without weights.
3. Load it once through the Rust runtime and read the `[photobook:ai]` compute-plan line (CoreML partitions and
   rejected ops). If CoreML splits the graph, decompose the offending op in the script (the plan mentions reflect
   pads; this architecture has none) and export again.
4. Upload the `.onnx` with NAFNet's `LICENSE` next to it to a GitHub Release of this repo (see "Hosting a model on
   a GitHub Release" below), then add or uncomment the manifest entry with the release URL, `bytes`, `sha256`,
   `input = [1, 3, 512, 512]`, no `dims`, and a new `version` (part of the install path, the CoreML cache path and
   the denoise cache key).

`--weights-from-onnx <ailia file>` re-exports the pinned width32 with the weights read from ailia's ONNX file, and
`--compare-onnx <ailia file>` runs both files on the same noisy gradient and prints the largest output difference
(plan 26: 1.8e-4 for the fp16 export) and each PSNR.

Status (plan 26): the export path ran with `onnx` and `onnxconverter-common` installed in a scratch virtualenv.
`--weights-from-onnx` re-exports the pinned ailia width32 file as fp16 at a static 512² (the file in the table); the
width64 export ran with random weights only (the official weights are 464 MB). Core ML partition counts and timings
of every candidate are in `docs/design/DENOISE_EVAL.md`.

### Re-exporting SCUNet (`export_scunet.py`)

Heliosoph's SCUNet export splits into 141 Core ML partitions (56 `Einsum`, 6-D reshapes, `Shape`/`Range`/`ScatterND`
for the window mask), so the editor runs it on the CPU. `export_scunet.py` is an export-friendly copy of SCUNet's
architecture with the official parameter names (the state dict loads strictly): the input size is fixed, the window
counts, the relative position bias and the shifted-window mask are baked in as constants (the mask as two small
additive terms, not upstream's 67 MB boolean tensor at 512²), the attention is two `MatMul`s, every tensor stays at
rank 5 or less, and LayerNorm and GELU are plain ops (`--native-ops` keeps torch's). The resulting graph has only
`Conv`, `MatMul`, `Reshape`, `Transpose`, `Slice`/`Concat` (the cyclic shift), `Softmax`, `Erf` and elementwise ops.

```sh
python3 scripts/models/export_scunet.py --weights scunet_color_real_psnr.pth --size 512 --check \
    --reference scunet_color_real_psnr.onnx --out scunet-real-psnr-512.onnx   # add --fp16 for half the size
```

`--reference` compares the output with another export (Heliosoph's, from the manifest) on a noisy gradient.

### DRUNet for the σ-map experiment (`export_drunet.py`)

DRUNet takes the noise level as a fourth input channel. `export_drunet.py` exports KAIR's `UNetRes` with the
`drunet_color.pth` weights at a fixed size: input `[1, 4, n, n]` (sRGB RGB, then σ in the same 0..1 units), output
`[1, 3, n, n]`. The editor-side code is `photobook_develop::ai::drunet` behind the crate feature `denoise-drunet`
(off by default); it builds the σ map from the plan 23 noise curve.

```sh
python3 scripts/models/export_drunet.py --weights drunet_color.pth --size 512 --fp16 --check \
    --out drunet-color-512-fp16.onnx
```

### Hosting a model on a GitHub Release

1. Build the file with the script and check its SHA-256 against the table above (or `models.toml`'s TODO entry).
2. Create a release of `jpaulfernandez/gallery-30` (for example the tag `models-2026-10`) and upload the `.onnx`
   with the upstream `LICENSE` next to it (NAFNet MIT, SCUNet Apache-2.0, KAIR MIT).
3. Uncomment the entry in `crates/develop/models.toml`, set the `url` to
   `https://github.com/jpaulfernandez/gallery-30/releases/download/<tag>/<file>`, `bytes` and `sha256` to the
   uploaded file's, and run `cargo test -p photobook-develop --lib manifest`. Release assets can be replaced, so the
   SHA-256 is what pins them.
4. Per entry, before uncommenting:
   - **SCUNet**: the static entry reuses the name `scunet-color-real-psnr`, and the manifest rejects a duplicate
     `name`, so it must *replace* the Heliosoph entry (delete that block), not sit next to it. Keep
     `scunet-color-real-psnr` in `CPU_ONLY_MODELS` (`crates/develop/src/ai/denoise.rs`) until an idle, real 24 MP
     run confirms it finishes in about a minute on Core ML (plan 26 only extrapolated 58–65 s on a loaded machine).
   - **DRUNet**: its task `denoise-sigma` does not exist yet; add a `DenoiseSigma` variant to `ai::registry::Task`
     (and whatever loads it, e.g. the editor behind `denoise-drunet`) first, or the manifest fails to parse.
   - **NAFNet width64**: the entry carries placeholders (`bytes = 0`, `sha256 = ""`, `verified = false`); fill in the
     real export's size and SHA-256 and set `verified = true`, or it stays listed but not downloadable.
