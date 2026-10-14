#!/usr/bin/env python3
"""Export DRUNet (colour, from DPIR / KAIR) to a fixed-shape ONNX file for Photobook's σ-map experiment (plan 26).

DRUNet is a plain U-Net with residual blocks that takes the noise level as a fourth input channel, so it can be told
how noisy each pixel is (Photobook feeds the plan 23 noise profile σ, per pixel through the σ(L) curve) instead of
estimating it. The architecture below is KAIR's `models/network_unet.py` `UNetRes` (MIT; Copyright Kai Zhang) with
DRUNet's configuration (nc [64, 128, 256, 512], 4 residual blocks per level, ReLU, strided-conv down,
transposed-conv up, no bias) and the same parameter names, so the official state dict loads strictly.

Weights: `drunet_color.pth` from the KAIR v1.0 release
(https://github.com/cszn/KAIR/releases/download/v1.0/drunet_color.pth, 130,579,305 bytes, SHA-256
479abe3c5327dfd10ff54a80ec7d4098ca80752a5c9492cdff31cee430bec4b4, the same bytes as deepinv/drunet on Hugging Face).

Usage (Python 3.10+, torch 2.x, `onnx`; `onnxconverter-common` for --fp16, `onnxruntime` for --check):

    python3 scripts/models/export_drunet.py --weights drunet_color.pth --size 512 --fp16 --check \\
        --out drunet-color-512-fp16.onnx

IO: input `input` float32 [1, 4, size, size]: channels 0-2 sRGB-encoded 0..1 (RGB), channel 3 the noise σ in the
same 0..1 units (DRUNet was trained on additive Gaussian noise with σ up to 50/255); output `output` float32
[1, 3, size, size], the denoised sRGB image.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys

import torch
from torch import nn


class ResBlock(nn.Module):
    def __init__(self, c: int) -> None:
        super().__init__()
        self.res = nn.Sequential(nn.Conv2d(c, c, 3, 1, 1, bias=False), nn.ReLU(inplace=True), nn.Conv2d(c, c, 3, 1, 1, bias=False))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return x + self.res(x)


class DRUNet(nn.Module):
    def __init__(self, in_nc: int = 4, out_nc: int = 3, nc: tuple[int, ...] = (64, 128, 256, 512), nb: int = 4) -> None:
        super().__init__()

        def res(c: int) -> list[nn.Module]:
            return [ResBlock(c) for _ in range(nb)]

        self.m_head = nn.Conv2d(in_nc, nc[0], 3, 1, 1, bias=False)
        self.m_down1 = nn.Sequential(*res(nc[0]), nn.Conv2d(nc[0], nc[1], 2, 2, 0, bias=False))
        self.m_down2 = nn.Sequential(*res(nc[1]), nn.Conv2d(nc[1], nc[2], 2, 2, 0, bias=False))
        self.m_down3 = nn.Sequential(*res(nc[2]), nn.Conv2d(nc[2], nc[3], 2, 2, 0, bias=False))
        self.m_body = nn.Sequential(*res(nc[3]))
        self.m_up3 = nn.Sequential(nn.ConvTranspose2d(nc[3], nc[2], 2, 2, 0, bias=False), *res(nc[2]))
        self.m_up2 = nn.Sequential(nn.ConvTranspose2d(nc[2], nc[1], 2, 2, 0, bias=False), *res(nc[1]))
        self.m_up1 = nn.Sequential(nn.ConvTranspose2d(nc[1], nc[0], 2, 2, 0, bias=False), *res(nc[0]))
        self.m_tail = nn.Conv2d(nc[0], out_nc, 3, 1, 1, bias=False)

    def forward(self, x0: torch.Tensor) -> torch.Tensor:
        # Three 2× downsamplings: the fixed size is a multiple of 8 (checked in main), so no pad / crop.
        x1 = self.m_head(x0)
        x2 = self.m_down1(x1)
        x3 = self.m_down2(x2)
        x4 = self.m_down3(x3)
        x = self.m_body(x4)
        x = self.m_up3(x + x4)
        x = self.m_up2(x + x3)
        x = self.m_up1(x + x2)
        return self.m_tail(x + x1)


def sha256(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", help="official drunet_color.pth (KAIR v1.0 release)")
    ap.add_argument("--random-weights", action="store_true", help="random init (smoke test of the export path)")
    ap.add_argument("--size", type=int, default=512, help="fixed input size (multiple of 8)")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--fp16", action="store_true", help="fp16 weights/activations, fp32 IO (needs onnxconverter-common)")
    ap.add_argument("--check", action="store_true", help="compare ONNX Runtime (CPU) against PyTorch")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if args.size % 8:
        ap.error("--size must be a multiple of 8")
    if bool(args.weights) == bool(args.random_weights):
        ap.error("give exactly one of --weights and --random-weights")

    model = DRUNet()
    if args.weights:
        # weights_only: a plain tensor dict, no pickled code runs.
        state = torch.load(args.weights, map_location="cpu", weights_only=True)
        model.load_state_dict(state.get("params", state), strict=True)
    model.eval()

    dummy = torch.rand(1, 4, args.size, args.size)
    with torch.no_grad():
        torch.onnx.export(
            model,
            (dummy,),
            args.out,
            input_names=["input"],
            output_names=["output"],
            opset_version=args.opset,
            do_constant_folding=True,
            dynamo=False,
        )
    if args.fp16:
        import onnx
        from onnxconverter_common import float16

        m = onnx.load(args.out)
        onnx.save(float16.convert_float_to_float16(m, keep_io_types=True), args.out)

    if args.check:
        import numpy as np
        import onnxruntime as ort

        yy, xx = np.mgrid[0 : args.size, 0 : args.size] / args.size
        clean = np.stack([0.2 + 0.6 * xx, 0.3 + 0.4 * yy, 0.6 - 0.4 * xx * yy])[None].astype(np.float32)
        sigma = 0.05
        noisy = np.clip(clean + np.random.default_rng(1).normal(0, sigma, clean.shape), 0, 1).astype(np.float32)
        x = np.concatenate([noisy, np.full((1, 1, args.size, args.size), sigma, np.float32)], axis=1)
        got = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"]).run(None, {"input": x})[0]
        with torch.no_grad():
            ref = model(torch.from_numpy(x)).numpy()
        err = float(np.abs(got - ref).max())
        psnr = lambda u, v: 10 * np.log10(1 / np.mean((u - v) ** 2))  # noqa: E731
        print(f"max |onnx - torch| = {err:.2e}; PSNR vs clean {psnr(got, clean):.2f} dB (noisy {psnr(noisy, clean):.2f})")
        if err > (2e-2 if args.fp16 else 1e-3):
            print("mismatch", file=sys.stderr)
            return 1

    print(f"{args.out}: {os.path.getsize(args.out)} bytes, sha256 {sha256(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
