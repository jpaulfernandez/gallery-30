#!/usr/bin/env python3
"""Export NAFNet (SIDD, width 32 or 64) to a fixed-shape ONNX file for Photobook's denoise (step D5.1).

The architecture below is a faithful, export-friendly copy of megvii-research/NAFNet's
`basicsr/models/archs/NAFNet_arch.py` (MIT; Copyright (c) 2022 megvii-model): the custom autograd LayerNorm is
written out as plain ops, and the internal pad-to-16 / crop is dropped because the input shape is fixed to a multiple
of 16. Weights are the official `NAFNet-SIDD-width32.pth` / `NAFNet-SIDD-width64.pth` from the NAFNet README
(Google Drive / Baidu links; state dict under `params`).

Usage (Python 3.10+, torch 2.x; `onnx` + `onnxconverter-common` for --fp16, `onnxruntime` for --check):

    python3 scripts/models/export_nafnet.py --weights NAFNet-SIDD-width32.pth --width 32 \
        --size 512 --opset 17 --fp16 --check --out NAFNet-SIDD-width32-512-fp16.onnx

    # Smoke test of the export path without weights (random init, nothing downloaded):
    python3 scripts/models/export_nafnet.py --random-weights --width 32 --size 64 --out /tmp/nafnet-smoke.onnx

IO of the result: input `input` float32 [1, 3, size, size], sRGB-encoded 0..1 (NCHW, RGB); output `output` float32,
same shape. With --fp16 the weights and activations are float16 and the IO stays float32 (`keep_io_types`), which is
what `photobook_develop::ai::denoise` feeds either way.

Re-export the pinned width32 from ailia's file and check it against that file (plan 26):

    python3 scripts/models/export_nafnet.py --weights-from-onnx NAFNet-SIDD-width32.onnx --width 32 \
        --size 512 --compare-onnx NAFNet-SIDD-width32.onnx --out NAFNet-SIDD-width32-512-fp32.onnx

After exporting: SHA-256 the file, upload it (with NAFNet's LICENSE next to it) to a GitHub Release of this repo
(https://github.com/jpaulfernandez/gallery-30/releases/download/<tag>/<file>), and add or uncomment the `[[model]]`
entry in crates/develop/models.toml with that URL, `bytes`, `sha256`, `input = [1, 3, size, size]` and a new
`version` (the version is part of the install path and the cache keys). See scripts/models/README.md.
"""

from __future__ import annotations

import argparse
import hashlib
import sys

import torch
from torch import nn


class LayerNorm2d(nn.Module):
    """Channel LayerNorm over NCHW, as NAFNet's LayerNormFunction computes it (biased variance, eps inside sqrt)."""

    def __init__(self, channels: int, eps: float = 1e-6) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(channels))
        self.bias = nn.Parameter(torch.zeros(channels))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        mu = x.mean(1, keepdim=True)
        var = (x - mu).pow(2).mean(1, keepdim=True)
        y = (x - mu) / (var + self.eps).sqrt()
        return self.weight.view(1, -1, 1, 1) * y + self.bias.view(1, -1, 1, 1)


class SimpleGate(nn.Module):
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x1, x2 = x.chunk(2, dim=1)
        return x1 * x2


class NAFBlock(nn.Module):
    def __init__(self, c: int, dw_expand: int = 2, ffn_expand: int = 2) -> None:
        super().__init__()
        dw = c * dw_expand
        self.conv1 = nn.Conv2d(c, dw, 1, padding=0, stride=1, groups=1, bias=True)
        self.conv2 = nn.Conv2d(dw, dw, 3, padding=1, stride=1, groups=dw, bias=True)
        self.conv3 = nn.Conv2d(dw // 2, c, 1, padding=0, stride=1, groups=1, bias=True)
        # Simplified channel attention. With a fixed input size the global pool exports as ReduceMean (CoreML runs it).
        self.sca = nn.Sequential(nn.AdaptiveAvgPool2d(1), nn.Conv2d(dw // 2, dw // 2, 1, padding=0, stride=1, bias=True))
        self.sg = SimpleGate()
        ffn = ffn_expand * c
        self.conv4 = nn.Conv2d(c, ffn, 1, padding=0, stride=1, groups=1, bias=True)
        self.conv5 = nn.Conv2d(ffn // 2, c, 1, padding=0, stride=1, groups=1, bias=True)
        self.norm1 = LayerNorm2d(c)
        self.norm2 = LayerNorm2d(c)
        # Dropout is 0 in every released model (Identity), so it is left out.
        self.beta = nn.Parameter(torch.zeros((1, c, 1, 1)))
        self.gamma = nn.Parameter(torch.zeros((1, c, 1, 1)))

    def forward(self, inp: torch.Tensor) -> torch.Tensor:
        x = self.norm1(inp)
        x = self.conv2(self.conv1(x))
        x = self.sg(x)
        x = x * self.sca(x)
        x = self.conv3(x)
        y = inp + x * self.beta
        x = self.conv5(self.sg(self.conv4(self.norm2(y))))
        return y + x * self.gamma


class NAFNet(nn.Module):
    def __init__(self, width: int, middle_blk_num: int, enc_blk_nums: list[int], dec_blk_nums: list[int]) -> None:
        super().__init__()
        self.intro = nn.Conv2d(3, width, 3, padding=1, stride=1, groups=1, bias=True)
        self.ending = nn.Conv2d(width, 3, 3, padding=1, stride=1, groups=1, bias=True)
        self.encoders = nn.ModuleList()
        self.decoders = nn.ModuleList()
        self.ups = nn.ModuleList()
        self.downs = nn.ModuleList()
        chan = width
        for num in enc_blk_nums:
            self.encoders.append(nn.Sequential(*[NAFBlock(chan) for _ in range(num)]))
            self.downs.append(nn.Conv2d(chan, 2 * chan, 2, 2))
            chan *= 2
        self.middle_blks = nn.Sequential(*[NAFBlock(chan) for _ in range(middle_blk_num)])
        for num in dec_blk_nums:
            self.ups.append(nn.Sequential(nn.Conv2d(chan, chan * 2, 1, bias=False), nn.PixelShuffle(2)))
            chan //= 2
            self.decoders.append(nn.Sequential(*[NAFBlock(chan) for _ in range(num)]))
        self.padder_size = 2 ** len(self.encoders)

    def forward(self, inp: torch.Tensor) -> torch.Tensor:
        # The input is fixed and a multiple of `padder_size` (checked in main), so NAFNet's pad/crop is not needed.
        x = self.intro(inp)
        skips = []
        for encoder, down in zip(self.encoders, self.downs):
            x = encoder(x)
            skips.append(x)
            x = down(x)
        x = self.middle_blks(x)
        for decoder, up, skip in zip(self.decoders, self.ups, skips[::-1]):
            x = decoder(up(x) + skip)
        return self.ending(x) + inp


# NAFNet-SIDD-width{32,64}.yml (options/test/SIDD/).
SIDD_CONFIG = {"middle_blk_num": 12, "enc_blk_nums": [2, 2, 4, 8], "dec_blk_nums": [2, 2, 2, 2]}


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", help="official NAFNet-SIDD-width{32,64}.pth")
    ap.add_argument("--random-weights", action="store_true", help="random init (smoke test of the export path)")
    ap.add_argument(
        "--weights-from-onnx",
        help="take the weights from an existing NAFNet ONNX export whose initializers keep the PyTorch names "
        "(ailia's NAFNet-SIDD-width32.onnx does), e.g. to re-export the pinned fp32 file as static fp16",
    )
    ap.add_argument("--width", type=int, choices=[32, 64], default=32)
    ap.add_argument("--size", type=int, default=512, help="fixed input size (multiple of 16)")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--fp16", action="store_true", help="fp16 weights/activations, fp32 IO (needs onnxconverter-common)")
    ap.add_argument("--check", action="store_true", help="compare ONNX Runtime (CPU) against PyTorch")
    ap.add_argument(
        "--compare-onnx",
        help="another NAFNet ONNX file (e.g. ailia's, the manifest's) to compare outputs with on a noisy gradient "
        "(both on the CPU EP; prints the max difference and each PSNR against the clean gradient)",
    )
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.size % 16:
        ap.error("--size must be a multiple of 16")
    if sum(map(bool, (args.weights, args.random_weights, args.weights_from_onnx))) != 1:
        ap.error("give exactly one of --weights, --weights-from-onnx and --random-weights")

    model = NAFNet(width=args.width, **SIDD_CONFIG)
    if args.weights:
        # weights_only: a plain tensor dict, no pickled code runs.
        state = torch.load(args.weights, map_location="cpu", weights_only=True)
        state = state.get("params", state)
        missing, unexpected = model.load_state_dict(state, strict=False)
        if missing or unexpected:
            print(f"state dict mismatch: missing {missing[:5]}..., unexpected {unexpected[:5]}...", file=sys.stderr)
            return 1
    if args.weights_from_onnx:
        import onnx
        from onnx import numpy_helper

        src = onnx.load(args.weights_from_onnx)
        inits = {i.name: torch.from_numpy(numpy_helper.to_array(i).copy()) for i in src.graph.initializer}
        wanted = model.state_dict()
        state = {k: inits[k] for k in wanted if k in inits}
        missing = [k for k in wanted if k not in state]
        if missing:
            print(f"{len(missing)} weights missing from the ONNX file: {missing[:5]}...", file=sys.stderr)
            return 1
        bad = [k for k in wanted if tuple(state[k].shape) != tuple(wanted[k].shape)]
        if bad:
            print(f"shape mismatch (wrong --width?): {bad[:5]}", file=sys.stderr)
            return 1
        model.load_state_dict(state)
    model.eval()

    dummy = torch.rand(1, 3, args.size, args.size)
    torch.onnx.export(
        model,
        (dummy,),
        args.out,
        input_names=["input"],
        output_names=["output"],
        opset_version=args.opset,
        do_constant_folding=True,
        dynamo=False,  # the TorchScript exporter: static shapes, no onnxscript dependency
    )

    if args.fp16:
        import onnx
        from onnxconverter_common import float16

        m = onnx.load(args.out)
        m = float16.convert_float_to_float16(m, keep_io_types=True)
        onnx.save(m, args.out)

    if args.check:
        import numpy as np
        import onnxruntime as ort

        x = torch.rand(1, 3, args.size, args.size)
        with torch.no_grad():
            ref = model(x).numpy()
        sess = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"])
        got = sess.run(None, {"input": x.numpy()})[0]
        err = float(np.abs(got - ref).max())
        print(f"max |onnx - torch| = {err:.2e}")
        if err > (2e-2 if args.fp16 else 1e-4):
            print("mismatch", file=sys.stderr)
            return 1

    if args.compare_onnx:
        import numpy as np
        import onnxruntime as ort

        # Plan 26's check: ours against ailia's within 2e-4 (fp16) on a σ 0.05 noisy gradient.
        yy, xx = np.mgrid[0 : args.size, 0 : args.size] / args.size
        clean = np.stack([0.2 + 0.6 * xx, 0.3 + 0.4 * yy, 0.6 - 0.4 * xx * yy])[None].astype(np.float32)
        x = np.clip(clean + np.random.default_rng(1).normal(0, 0.05, clean.shape), 0, 1).astype(np.float32)
        outs = []
        for path in (args.compare_onnx, args.out):
            sess = ort.InferenceSession(path, providers=["CPUExecutionProvider"])
            outs.append(sess.run(None, {sess.get_inputs()[0].name: x})[0])
        psnr = lambda u, v: 10 * np.log10(1 / np.mean((u - v) ** 2))  # noqa: E731
        print(
            f"max |ours - reference| = {np.abs(outs[1] - outs[0]).max():.2e}; PSNR vs clean: reference "
            f"{psnr(outs[0], clean):.2f} dB, ours {psnr(outs[1], clean):.2f} dB, noisy {psnr(x, clean):.2f} dB"
        )

    import os

    print(f"{args.out}: {os.path.getsize(args.out)} bytes, sha256 {sha256(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
