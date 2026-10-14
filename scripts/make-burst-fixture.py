#!/usr/bin/env python3
"""Generate the burst fixture folder (plan 39): one scene, twelve frames, for looking at cull groups by eye.

Usage: python3 scripts/make-burst-fixture.py [out_dir]
Default out_dir: fixtures/burst (git-ignored, like fixtures/sample-trip). Import it as a folder in the editor, next
to the lisbon fixture, and open Cull: the burst should be one group cell.

The frames, all 1600x1067 JPEGs of one synthetic scene (shapes, a subject that moves a little, camera shake):

- DSCF2001.jpg to DSCF2009.jpg: a burst from camera A (Fujifilm X-T5, XF33mm, 33 mm), 200 ms apart, with
  subsecond capture times (SubSecTimeOriginal). DSCF2005 is the sharpest; DSCF2003 missed focus; DSCF2007 is
  motion-blurred. The suggested best should be DSCF2005.
- IMG_0001.jpg: camera B (Canon EOS R6, RF35mm, 35 mm) firing mid-burst, 700 ms in. Two cameras never share a
  group, so it stays a single photo and does not break the burst.
- DSCF2010.jpg, DSCF2011.jpg: the subject re-shot on camera A 20 s after the burst: they join it as a re-shoot.

Expected in Cull with Group on: one group of eleven frames (camera A) and IMG_0001 on its own. The Vitest grouping test
(packages/shared/src/cull/groups.test.ts) uses synthetic entries of the same shape, so CI never needs these files.

Deterministic (fixed seed). Licence: the script and its output are released under CC0 1.0 (public domain dedication).
Needs numpy and Pillow.
"""
import os
import sys
from datetime import datetime, timedelta, timezone

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from PIL.TiffImagePlugin import IFDRational

OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures/burst"
W, H = 1600, 1067
rng = np.random.default_rng(39)
START = datetime(2026, 10, 13, 10, 0, 0, tzinfo=timezone.utc)

CAMERA_A = {"make": "Fujifilm", "model": "X-T5", "lens": "XF33mmF1.4 R LM WR", "focal": 33}
CAMERA_B = {"make": "Canon", "model": "EOS R6", "lens": "RF35mm F1.8 MACRO IS STM", "focal": 35}


def background():
    """Shapes at every angle and scale on a warm ground: the scene behind the subject."""
    img = Image.new("RGB", (W + 40, H + 40), (132, 120, 104))
    draw = ImageDraw.Draw(img)
    for _ in range(700):
        size = float(rng.uniform(6, 120)) * float(rng.uniform(0.3, 1.0))
        cx, cy = float(rng.uniform(-40, W + 80)), float(rng.uniform(-40, H + 80))
        color = tuple(int(c) for c in rng.integers(30, 225, 3))
        if rng.integers(0, 2) == 0:
            draw.ellipse([cx - size, cy - size * 0.7, cx + size, cy + size * 0.7], fill=color)
        else:
            angle = float(rng.uniform(0, 2 * np.pi))
            pts = [(cx + size * np.cos(angle + np.pi * k / 2), cy + size * np.sin(angle + np.pi * k / 2)) for k in range(4)]
            draw.polygon(pts, fill=color)
    return img


def frame(bg, subject_x, shake, blur=0.0, pan=0, warm=False):
    """The background shifted by the camera shake, the subject (a figure) at `subject_x`, then the lens or motion."""
    dx, dy = shake
    img = bg.crop((20 + dx, 20 + dy, 20 + dx + W, 20 + dy + H))
    draw = ImageDraw.Draw(img)
    x, y = subject_x, H * 0.55
    draw.ellipse([x - 70, y - 260, x + 70, y - 110], fill=(232, 196, 160))
    draw.rectangle([x - 110, y - 110, x + 110, y + 260], fill=(40, 70, 140))
    draw.rectangle([x - 90, y - 60, x + 90, y - 30], fill=(240, 240, 235))
    if blur > 0:
        img = img.filter(ImageFilter.GaussianBlur(blur))
    a = np.asarray(img).astype(np.float32)
    if pan > 0:
        pad = pan // 2
        p = np.pad(a, ((0, 0), (pad, pan - pad - 1), (0, 0)), mode="edge")
        c = np.cumsum(np.pad(p, ((0, 0), (1, 0), (0, 0))), axis=1)
        a = (c[:, pan:, :] - c[:, :-pan, :]) / pan
    if warm:
        a = a * np.array([1.06, 1.0, 0.92], np.float32)
    a = a + rng.normal(0, 2.0, (H, W, 1)).astype(np.float32)
    return np.clip(a, 0, 255).round().astype(np.uint8)


def save(name, pixels, at, camera):
    exif = Image.Exif()
    exif[0x010F] = camera["make"]
    exif[0x0110] = camera["model"]
    exif[0x0132] = at.strftime("%Y:%m:%d %H:%M:%S")  # DateTime
    ifd = exif.get_ifd(0x8769)
    ifd[0x9003] = at.strftime("%Y:%m:%d %H:%M:%S")  # DateTimeOriginal
    ifd[0x9291] = f"{at.microsecond // 10000:02d}"  # SubSecTimeOriginal, hundredths
    ifd[0x920A] = IFDRational(camera["focal"], 1)  # FocalLength
    ifd[0xA434] = camera["lens"]  # LensModel
    path = os.path.join(OUT, name)
    Image.fromarray(pixels).save(path, quality=90, exif=exif)
    ts = at.timestamp()
    os.utime(path, (ts, ts))
    print(path, at.isoformat(timespec="milliseconds"), camera["model"])


def main():
    os.makedirs(OUT, exist_ok=True)
    bg = background()
    # The burst: nine frames 200 ms apart, the subject walking a little, the camera shaking a couple of pixels.
    for i in range(9):
        blur = 0.0 if i == 4 else 1.2
        if i == 2:
            blur = 4.0  # missed focus
        pan = 21 if i == 6 else 0  # motion blur
        shake = (int(rng.integers(-3, 4)), int(rng.integers(-3, 4)))
        pixels = frame(bg, 700 + i * 6, shake, blur=blur, pan=pan)
        save(f"DSCF{2001 + i}.jpg", pixels, START + timedelta(milliseconds=200 * i), CAMERA_A)
    # Camera B, mid-burst, from a step to the side (a slightly different crop and colour).
    save("IMG_0001.jpg", frame(bg, 760, (12, -8), blur=1.0, warm=True), START + timedelta(milliseconds=700), CAMERA_B)
    # The re-shoot: 20 s after the last burst frame, the subject back where it started.
    last = START + timedelta(milliseconds=200 * 8)
    for j in range(2):
        shake = (int(rng.integers(-3, 4)), int(rng.integers(-3, 4)))
        pixels = frame(bg, 702 + j * 6, shake, blur=1.2)
        save(f"DSCF{2010 + j}.jpg", pixels, last + timedelta(seconds=20, milliseconds=200 * j), CAMERA_A)
    print("done", 12)


if __name__ == "__main__":
    main()
