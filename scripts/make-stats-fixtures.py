#!/usr/bin/env python3
"""Generate the synthetic photo-stats fixtures (plan 38; reused by plans 41 and 53).

Usage: python3 scripts/make-stats-fixtures.py [out_dir]
Default out_dir: crates/develop/tests/fixtures/stats/

Writes eight 960x640 JPEGs drawn here from shapes and noise (no photograph, no download), each standing for one kind
of frame the cull's stats must tell apart:

- sharp.jpg: a busy scene of shapes at every angle and scale, fine grain on top (the reference).
- defocused.jpg: the same scene, Gaussian blur radius 4 (missed focus).
- panned.jpg: the same scene, 25 px horizontal box blur (camera pan / motion blur).
- bokeh-portrait.jpg: a sharp oval subject in the middle, the scene behind it blurred radius 12.
- blown.jpg: the scene pushed +110 levels (wide clipped highlights).
- dark.jpg: the scene at 12 % (median luma below 0.1).
- silhouette.jpg: a clipped sky over a near-black foreground and figure (dark and clipped at once).
- high-key.jpg: the scene squeezed into 190-245 (bright on purpose, median above 0.75, little clipping).

Each carries Exif (Make, Model, LensModel, FocalLength, DateTimeOriginal one second apart, SubSecTimeOriginal), so a
folder of them also exercises the index fields. reference.json holds, per file, the clip shares and the median luma
computed here from the decoded JPEG with the definitions of crates/develop/src/stats.rs (any channel >= 250; every
channel <= 5; Rec. 709 luma with integer weights 54/183/19), which tests/stats.rs checks to within 1 %.

Deterministic (fixed seed). Licence: the script and its output are released under CC0 1.0 (public domain dedication).
Needs numpy and Pillow.
"""
import json
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from PIL.TiffImagePlugin import IFDRational

OUT = sys.argv[1] if len(sys.argv) > 1 else "crates/develop/tests/fixtures/stats"
W, H = 960, 640
rng = np.random.default_rng(38)


def scene():
    """Shapes at every angle and scale on a mid-grey ground, plus fine grain: isotropic detail everywhere."""
    img = Image.new("RGB", (W, H), (118, 112, 104))
    draw = ImageDraw.Draw(img)
    for _ in range(900):
        size = float(rng.uniform(4, 90)) * float(rng.uniform(0.3, 1.0))
        cx, cy = float(rng.uniform(-40, W + 40)), float(rng.uniform(-40, H + 40))
        color = tuple(int(c) for c in rng.integers(20, 235, 3))
        kind = rng.integers(0, 3)
        if kind == 0:
            draw.ellipse([cx - size, cy - size * 0.7, cx + size, cy + size * 0.7], fill=color)
        else:
            sides = 3 if kind == 1 else 4
            angle = float(rng.uniform(0, 2 * np.pi))
            pts = [
                (cx + size * np.cos(angle + 2 * np.pi * k / sides), cy + size * np.sin(angle + 2 * np.pi * k / sides))
                for k in range(sides)
            ]
            draw.polygon(pts, fill=color)
    a = np.asarray(img).astype(np.float32)
    return a + rng.normal(0, 2.0, (H, W, 1)).astype(np.float32)


def blur(a, radius):
    img = Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
    return np.asarray(img.filter(ImageFilter.GaussianBlur(radius))).astype(np.float32)


def pan(a, length):
    """Horizontal box blur of `length` px (edge-clamped)."""
    pad = length // 2
    p = np.pad(a, ((0, 0), (pad, length - pad - 1), (0, 0)), mode="edge")
    c = np.cumsum(np.pad(p, ((0, 0), (1, 0), (0, 0))), axis=1)
    return (c[:, length:, :] - c[:, :-length, :]) / length


def oval_mask(cx, cy, rx, ry):
    yy, xx = np.mgrid[0:H, 0:W]
    return (((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2 <= 1.0)[..., None]


def silhouette():
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    sky = np.stack([255 - yy * 0.05, 252 - yy * 0.08, 246 - yy * 0.12], axis=-1)
    sun = ((xx - 700) ** 2 + (yy - 120) ** 2 < 70**2)[..., None]
    sky = np.where(sun, 255.0, sky)
    ground = (yy > H * 0.38)[..., None]
    figure = oval_mask(380, 250, 55, 70) | (oval_mask(380, 470, 110, 190) & (yy > 300)[..., None])
    dark = np.full((H, W, 3), 6.0, np.float32) + rng.normal(0, 1.5, (H, W, 1)).astype(np.float32)
    return np.where(ground | figure, dark, sky)


def reference(path):
    rgb = np.asarray(Image.open(path).convert("RGB")).astype(np.int32)
    mx = rgb.max(axis=2)
    luma = (54 * rgb[..., 0] + 183 * rgb[..., 1] + 19 * rgb[..., 2] + 128) >> 8
    hist = np.bincount(luma.ravel(), minlength=256)
    half = (luma.size + 1) // 2
    median = int(np.searchsorted(np.cumsum(hist), half))
    return {
        "clipHigh": round(float((mx >= 250).mean()), 4),
        "clipLow": round(float((mx <= 5).mean()), 4),
        "medianLum": round(median / 255, 4),
    }


def save(name, a, i):
    exif = Image.Exif()
    exif[0x010F] = "Photobook"
    exif[0x0110] = "Synthetic"
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = f"2026:10:13 10:00:{i:02d}"
    ifd[0x9291] = "05"
    ifd[0x920A] = IFDRational(35, 1)
    ifd[0xA434] = "Fixture 35mm F2"
    path = os.path.join(OUT, name)
    Image.fromarray(np.clip(a, 0, 255).round().astype(np.uint8)).save(path, quality=90, exif=exif)
    return path


def main():
    os.makedirs(OUT, exist_ok=True)
    sharp = scene()
    portrait = np.where(oval_mask(W / 2, H / 2, 150, 210), sharp, blur(sharp, 12))
    frames = [
        ("sharp.jpg", sharp),
        ("defocused.jpg", blur(sharp, 4)),
        ("panned.jpg", pan(sharp, 25)),
        ("bokeh-portrait.jpg", portrait),
        ("blown.jpg", sharp + 110),
        ("dark.jpg", sharp * 0.12),
        ("silhouette.jpg", silhouette()),
        ("high-key.jpg", 190 + sharp * (55 / 255)),
    ]
    refs = {}
    for i, (name, a) in enumerate(frames):
        refs[name] = reference(save(name, a, i))
    with open(os.path.join(OUT, "reference.json"), "w") as f:
        json.dump(refs, f, indent=2)
        f.write("\n")
    for name, r in refs.items():
        print(f"{name:20} {r}")


if __name__ == "__main__":
    main()
