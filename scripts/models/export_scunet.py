#!/usr/bin/env python3
"""Export SCUNet (cszn/SCUNet, `scunet_color_real_psnr`) to a static-shape ONNX file CoreML can run (plan 26).

The published ONNX export (Heliosoph/scunet-onnx) keeps SCUNet's dynamic window partition: 56 `Einsum`, 6-D
reshapes, `Shape`/`Range`/`ScatterND` for the shifted-window mask. ONNX Runtime's CoreML EP splits it into 141
partitions and one 512² tile takes 72 s, so Photobook runs it on the CPU (about 12 min for 24 MP). This file is an
export-friendly copy of `models/network_scunet.py` (Apache-2.0; Copyright Kai Zhang et al.) with the same parameter
names, so the official state dict loads strictly, but:

- the input size is fixed (a multiple of 64), so every window count, shift mask and relative position bias is a
  constant baked into the graph (`prepare`; no `Shape`, `Range`, `ScatterND`, `Where`);
- the attention is two `MatMul`s instead of `Einsum`;
- tensors stay at rank 5 or less (Core ML's limit): batch 1 is folded away in the window partition;
- LayerNorm and GELU are written as plain ops (mean / variance, `Erf`) unless --native-ops is given;
- the shifted-window mask is added as a large negative constant (-1e4) instead of `masked_fill(-inf)`.

Weights: `scunet_color_real_psnr.pth` from the KAIR v1.0 release
(https://github.com/cszn/KAIR/releases/download/v1.0/scunet_color_real_psnr.pth, 71,982,841 bytes, SHA-256
fa78899ba2caec9d235a900e91d96c689da71c42029230c2028b00f09f809c2e, the same bytes as deepinv/scunet on Hugging Face).

Usage (Python 3.10+, torch 2.x, `onnx`; `onnxconverter-common` for --fp16, `onnxruntime` for --check/--reference):

    python3 scripts/models/export_scunet.py --weights scunet_color_real_psnr.pth --size 512 --check \\
        --reference scunet_color_real_psnr.onnx --out scunet-real-psnr-512.onnx

IO: input `input` float32 [1, 3, size, size], sRGB-encoded 0..1 (NCHW, RGB); output `output`, same shape.
"""

from __future__ import annotations

import argparse
import hashlib
import os
import sys

import torch
from torch import nn

# Set by main(): plain-op LayerNorm / GELU (default) or torch's own modules.
NATIVE_OPS = False


class LayerNorm(nn.Module):
    """LayerNorm over the last dimension with nn.LayerNorm's parameter names, written as plain ops."""

    def __init__(self, dim: int, eps: float = 1e-5) -> None:
        super().__init__()
        self.weight = nn.Parameter(torch.ones(dim))
        self.bias = nn.Parameter(torch.zeros(dim))
        self.eps = eps

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if NATIVE_OPS:
            return nn.functional.layer_norm(x, (x.shape[-1],), self.weight, self.bias, self.eps)
        mu = x.mean(-1, keepdim=True)
        var = (x - mu).pow(2).mean(-1, keepdim=True)
        return (x - mu) / (var + self.eps).sqrt() * self.weight + self.bias


class Gelu(nn.Module):
    def forward(self, x: torch.Tensor) -> torch.Tensor:
        if NATIVE_OPS:
            return nn.functional.gelu(x)
        return 0.5 * x * (1.0 + torch.erf(x * 0.7071067811865476))


class WMSA(nn.Module):
    """Window (or shifted-window) multi-head self-attention on a channels-last [1, h, w, c] tensor."""

    def __init__(self, input_dim: int, output_dim: int, head_dim: int, window_size: int, type: str) -> None:
        super().__init__()
        self.head_dim = head_dim
        self.scale = head_dim**-0.5
        self.n_heads = input_dim // head_dim
        self.window_size = window_size
        self.type = type
        self.embedding_layer = nn.Linear(input_dim, 3 * input_dim, bias=True)
        # Stored as [heads, 2p-1, 2p-1] in the released checkpoints (the upstream __init__ transposes it).
        self.relative_position_params = nn.Parameter(torch.zeros(self.n_heads, 2 * window_size - 1, 2 * window_size - 1))
        self.linear = nn.Linear(input_dim, output_dim)

    def relative_embedding(self) -> torch.Tensor:
        p = self.window_size
        cord = torch.tensor([[i, j] for i in range(p) for j in range(p)])
        relation = cord[:, None, :] - cord[None, :, :] + p - 1
        return self.relative_position_params[:, relation[:, :, 0], relation[:, :, 1]]  # [heads, p², p²]

    def prepare(self, h: int, w: int) -> None:
        """Bake the constants for a fixed [1, h, w, c] input: the relative position bias [heads, 1, 1, p², p²] and
        the shifted-window mask as two small additive terms, one for the last window row [1, hw, 1, p², p²] and one
        for the last window column [1, 1, ww, p², p²] (-1e4 between pixels from different sides of the cyclic
        shift). Upstream builds an [nw, p², p²] boolean mask per call; at 512² that would be a 67 MB constant."""
        p = self.window_size
        self.hw, self.ww = h // p, w // p
        with torch.no_grad():
            self.register_buffer("rel_bias", self.relative_embedding().detach().reshape(self.n_heads, 1, 1, p * p, p * p).clone())
            s = p - p // 2
            row = torch.zeros(p, p, p, p, dtype=torch.bool)  # (p1, p2, p3, p4) for the last window row
            row[:s, :, s:, :] = True
            row[s:, :, :s, :] = True
            col = torch.zeros(p, p, p, p, dtype=torch.bool)  # for the last window column
            col[:, :s, :, s:] = True
            col[:, s:, :, :s] = True
            neg = lambda m: torch.where(m, -1e4, 0.0).reshape(p * p, p * p)  # noqa: E731
            mask_row = torch.zeros(1, self.hw, 1, p * p, p * p)
            mask_row[0, -1, 0] = neg(row)
            mask_col = torch.zeros(1, 1, self.ww, p * p, p * p)
            mask_col[0, 0, -1] = neg(col)
        self.register_buffer("mask_row", mask_row)
        self.register_buffer("mask_col", mask_col)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        p, hw, ww, nh = self.window_size, self.hw, self.ww, self.n_heads
        h, w, c = hw * p, ww * p, x.shape[-1]
        if self.type != "W":
            x = torch.roll(x, shifts=(-(p // 2), -(p // 2)), dims=(1, 2))
        # [1, h, w, c] -> [hw, p, ww, p, c] -> [hw, ww, p, p, c] -> [nw, p², c] (rank ≤ 5 throughout).
        x = x.reshape(hw, p, ww, p, c).permute(0, 2, 1, 3, 4).reshape(hw * ww, p * p, c)
        qkv = self.embedding_layer(x)  # [nw, p², 3c]
        qkv = qkv.reshape(hw * ww, p * p, 3 * nh, self.head_dim).permute(2, 0, 1, 3)  # [3h, nw, p², d]
        q, k, v = qkv[:nh], qkv[nh : 2 * nh], qkv[2 * nh :]
        sim = torch.matmul(q, k.transpose(-1, -2)) * self.scale  # [h, nw, p², p²]
        sim = sim.reshape(nh, hw, ww, p * p, p * p) + self.rel_bias
        if self.type != "W":
            sim = sim + self.mask_row + self.mask_col
        probs = torch.softmax(sim, dim=-1).reshape(nh, hw * ww, p * p, p * p)
        out = torch.matmul(probs, v)  # [h, nw, p², d]
        out = out.permute(1, 2, 0, 3).reshape(hw * ww, p * p, nh * self.head_dim)
        out = self.linear(out)
        c_out = out.shape[-1]
        out = out.reshape(hw, ww, p, p, c_out).permute(0, 2, 1, 3, 4).reshape(1, h, w, c_out)
        if self.type != "W":
            out = torch.roll(out, shifts=(p // 2, p // 2), dims=(1, 2))
        return out


class Block(nn.Module):
    def __init__(self, input_dim: int, output_dim: int, head_dim: int, window_size: int, type: str, input_resolution: int) -> None:
        super().__init__()
        if input_resolution <= window_size:
            type = "W"
        self.ln1 = LayerNorm(input_dim)
        self.msa = WMSA(input_dim, input_dim, head_dim, window_size, type)
        self.ln2 = LayerNorm(input_dim)
        self.mlp = nn.Sequential(nn.Linear(input_dim, 4 * input_dim), Gelu(), nn.Linear(4 * input_dim, output_dim))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = x + self.msa(self.ln1(x))
        return x + self.mlp(self.ln2(x))


class ConvTransBlock(nn.Module):
    def __init__(self, conv_dim: int, trans_dim: int, head_dim: int, window_size: int, type: str, input_resolution: int) -> None:
        super().__init__()
        self.conv_dim, self.trans_dim = conv_dim, trans_dim
        if input_resolution <= window_size:
            type = "W"
        self.trans_block = Block(trans_dim, trans_dim, head_dim, window_size, type, input_resolution)
        self.conv1_1 = nn.Conv2d(conv_dim + trans_dim, conv_dim + trans_dim, 1, 1, 0, bias=True)
        self.conv1_2 = nn.Conv2d(conv_dim + trans_dim, conv_dim + trans_dim, 1, 1, 0, bias=True)
        self.conv_block = nn.Sequential(
            nn.Conv2d(conv_dim, conv_dim, 3, 1, 1, bias=False), nn.ReLU(True), nn.Conv2d(conv_dim, conv_dim, 3, 1, 1, bias=False)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        conv_x, trans_x = torch.split(self.conv1_1(x), (self.conv_dim, self.trans_dim), dim=1)
        conv_x = self.conv_block(conv_x) + conv_x
        trans_x = self.trans_block(trans_x.permute(0, 2, 3, 1)).permute(0, 3, 1, 2)
        return x + self.conv1_2(torch.cat((conv_x, trans_x), dim=1))


class SCUNet(nn.Module):
    """SCUNet with the released real-noise configuration (config [4] * 7, dim 64, input_resolution 256)."""

    def __init__(self, in_nc: int = 3, config: tuple[int, ...] = (4,) * 7, dim: int = 64, input_resolution: int = 256) -> None:
        super().__init__()
        hd, ws = 32, 8

        def blocks(n: int, d: int, res: int) -> list[nn.Module]:
            return [ConvTransBlock(d, d, hd, ws, "W" if not i % 2 else "SW", res) for i in range(n)]

        r = input_resolution
        self.m_head = nn.Sequential(nn.Conv2d(in_nc, dim, 3, 1, 1, bias=False))
        self.m_down1 = nn.Sequential(*blocks(config[0], dim // 2, r), nn.Conv2d(dim, 2 * dim, 2, 2, 0, bias=False))
        self.m_down2 = nn.Sequential(*blocks(config[1], dim, r // 2), nn.Conv2d(2 * dim, 4 * dim, 2, 2, 0, bias=False))
        self.m_down3 = nn.Sequential(*blocks(config[2], 2 * dim, r // 4), nn.Conv2d(4 * dim, 8 * dim, 2, 2, 0, bias=False))
        self.m_body = nn.Sequential(*blocks(config[3], 4 * dim, r // 8))
        self.m_up3 = nn.Sequential(nn.ConvTranspose2d(8 * dim, 4 * dim, 2, 2, 0, bias=False), *blocks(config[4], 2 * dim, r // 4))
        self.m_up2 = nn.Sequential(nn.ConvTranspose2d(4 * dim, 2 * dim, 2, 2, 0, bias=False), *blocks(config[5], dim, r // 2))
        self.m_up1 = nn.Sequential(nn.ConvTranspose2d(2 * dim, dim, 2, 2, 0, bias=False), *blocks(config[6], dim // 2, r))
        self.m_tail = nn.Sequential(nn.Conv2d(dim, in_nc, 3, 1, 1, bias=False))

    def prepare(self, size: int) -> None:
        """Bake every attention block's constants for a fixed `size` × `size` input."""
        stages = [
            (self.m_down1, 1), (self.m_down2, 2), (self.m_down3, 4), (self.m_body, 8),
            (self.m_up3, 4), (self.m_up2, 2), (self.m_up1, 1),
        ]  # fmt: skip
        for stage, f in stages:
            for block in stage:
                if isinstance(block, ConvTransBlock):
                    block.trans_block.msa.prepare(size // f, size // f)

    def forward(self, x0: torch.Tensor) -> torch.Tensor:
        # The fixed size is a multiple of 64 (checked in main), so upstream's replication pad / crop is not needed.
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
    global NATIVE_OPS
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--weights", help="official scunet_color_real_psnr.pth (KAIR v1.0 release)")
    ap.add_argument("--random-weights", action="store_true", help="random init (smoke test of the export path)")
    ap.add_argument("--size", type=int, default=512, help="fixed input size (multiple of 64)")
    ap.add_argument("--opset", type=int, default=17)
    ap.add_argument("--native-ops", action="store_true", help="export LayerNormalization / Gelu as torch does")
    ap.add_argument("--fp16", action="store_true", help="fp16 weights/activations, fp32 IO (needs onnxconverter-common)")
    ap.add_argument("--check", action="store_true", help="compare ONNX Runtime (CPU) against PyTorch")
    ap.add_argument("--reference", help="another SCUNet ONNX file (e.g. Heliosoph's) to compare outputs with")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()
    NATIVE_OPS = args.native_ops

    if args.size % 64:
        ap.error("--size must be a multiple of 64")
    if bool(args.weights) == bool(args.random_weights):
        ap.error("give exactly one of --weights and --random-weights")

    model = SCUNet()
    if args.weights:
        # weights_only: a plain tensor dict, no pickled code runs.
        state = torch.load(args.weights, map_location="cpu", weights_only=True)
        state = state.get("params", state)
        model.load_state_dict(state, strict=True)
    else:
        for name, p in model.named_parameters():
            if "relative_position_params" in name:
                nn.init.normal_(p, std=0.02)
    model.eval()
    model.prepare(args.size)

    dummy = torch.rand(1, 3, args.size, args.size)
    with torch.no_grad():
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

    import onnx

    m = onnx.load(args.out)
    ops: dict[str, int] = {}
    for node in m.graph.node:
        ops[node.op_type] = ops.get(node.op_type, 0) + 1
    print("ops:", ", ".join(f"{k}×{v}" for k, v in sorted(ops.items(), key=lambda kv: -kv[1])))
    if args.fp16:
        from onnxconverter_common import float16

        m = float16.convert_float_to_float16(m, keep_io_types=True)
        onnx.save(m, args.out)

    if args.check or args.reference:
        import numpy as np
        import onnxruntime as ort

        yy, xx = np.mgrid[0 : args.size, 0 : args.size] / args.size
        clean = np.stack([0.2 + 0.6 * xx, 0.3 + 0.4 * yy, 0.6 - 0.4 * xx * yy])[None].astype(np.float32)
        x = np.clip(clean + np.random.default_rng(1).normal(0, 0.05, clean.shape), 0, 1).astype(np.float32)
        got = ort.InferenceSession(args.out, providers=["CPUExecutionProvider"]).run(None, {"input": x})[0]
        if args.check:
            with torch.no_grad():
                ref = model(torch.from_numpy(x)).numpy()
            err = float(np.abs(got - ref).max())
            print(f"max |onnx - torch| = {err:.2e}")
            if err > (2e-2 if args.fp16 else 1e-3):
                print("mismatch", file=sys.stderr)
                return 1
        if args.reference:
            sess = ort.InferenceSession(args.reference, providers=["CPUExecutionProvider"])
            ref = sess.run(None, {sess.get_inputs()[0].name: x})[0]
            psnr = lambda u, v: 10 * np.log10(1 / np.mean((u - v) ** 2))  # noqa: E731
            print(
                f"max |onnx - reference| = {np.abs(got - ref).max():.2e}; PSNR vs clean: ours {psnr(got, clean):.2f} dB, "
                f"reference {psnr(ref, clean):.2f} dB, noisy {psnr(x, clean):.2f} dB"
            )

    print(f"{args.out}: {os.path.getsize(args.out)} bytes, sha256 {sha256(args.out)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
