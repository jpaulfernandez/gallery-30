#!/usr/bin/env python3
"""Generate the synthetic portrait fixture used to review the built-in looks (workflow plan 21).

Usage: python3 scripts/make-portrait-fixture.py [out_file]
Default out_file: fixtures/portrait/portrait-01.jpg (1600x2000, 4:5).

The picture is drawn here from shapes and noise (no photograph, no model, no download): a head-and-shoulders
figure lit from the upper left in front of an out-of-focus warm background with bright bokeh discs. It is not
photo-real; it gives the looks what the street fixtures lack: a large area of skin from highlight to shadow, dark
hair, eyes and lips, a saturated garment and bright out-of-focus highlights (for halation). Deterministic (fixed
seed). Licence: the script and its output are released under CC0 1.0 (public domain dedication).

Needs numpy and Pillow.
"""
import os
import sys

import numpy as np
from PIL import Image

OUT = sys.argv[1] if len(sys.argv) > 1 else "fixtures/portrait/portrait-01.jpg"
W, H = 1600, 2000
rng = np.random.default_rng(21)

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)


def box_blur(a, r):
    """Box blur of radius r along both axes (cumulative sums); three passes approximate a Gaussian."""
    if r < 1:
        return a
    r = int(r)
    for axis in (0, 1):
        pad = [(0, 0)] * a.ndim
        pad[axis] = (r + 1, r)
        p = np.pad(a, pad, mode="edge")
        c = np.cumsum(p, axis=axis, dtype=np.float64)
        n = a.shape[axis]
        hi = np.take(c, np.arange(2 * r + 1, 2 * r + 1 + n), axis=axis)
        lo = np.take(c, np.arange(0, n), axis=axis)
        a = ((hi - lo) / (2 * r + 1)).astype(np.float32)
    return a


def blur(a, sigma):
    r = max(1, int(round(sigma * 0.9)))
    for _ in range(3):
        a = box_blur(a, r)
    return a


def smooth(edge, width=1.5):
    """0 outside, 1 inside, from a signed distance-like value (positive inside), anti-aliased."""
    return np.clip(edge / width + 0.5, 0.0, 1.0)


def ellipse(cx, cy, rx, ry):
    """Signed distance (approx., pixels) to an ellipse, positive inside."""
    d = np.sqrt(((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2)
    return (1.0 - d) * min(rx, ry)


def noise(sigma, amp=1.0):
    n = blur(rng.standard_normal((H, W)).astype(np.float32), sigma)
    return n / (n.std() + 1e-6) * amp


def paint(img, mask, colour):
    m = mask[..., None]
    return img * (1 - m) + np.asarray(colour, np.float32) * m


# --- background: warm, out of focus, with bokeh discs (linear light)
t = yy / H
bg = np.stack(
    [0.30 - 0.20 * t, 0.26 - 0.18 * t, 0.13 - 0.09 * t],
    axis=-1,
).astype(np.float32)
bg *= (1 + 0.25 * noise(120))[..., None]
# a bright window glow at the upper right
glow = np.exp(-(((xx - 1450) / 380) ** 2 + ((yy - 260) / 300) ** 2))
bg += glow[..., None] * np.array([0.9, 0.75, 0.45], np.float32)
discs = np.zeros((H, W, 3), np.float32)
for _ in range(34):
    cx, cy = rng.uniform(0, W), rng.uniform(0, H * 0.75)
    r = rng.uniform(25, 110)
    bright = rng.choice([0.25, 0.45, 0.8, 1.6], p=[0.35, 0.3, 0.2, 0.15])
    hue = rng.choice([0, 1, 2])
    col = [(1.0, 0.78, 0.42), (0.75, 0.85, 0.40), (1.0, 0.92, 0.75)][hue]
    m = smooth(ellipse(cx, cy, r, r), 3.0)
    discs += m[..., None] * np.asarray(col, np.float32) * bright * 0.6
bg = blur(bg + discs, 6)

img = bg.copy()

# --- shirt (muted blue) with a V neck showing skin
cx = W / 2
shoulder_top = 1395 + 0.00085 * (xx - cx) ** 2
torso = smooth(yy - shoulder_top, 2.0)
folds = 1 + 0.08 * noise(40) + 0.04 * noise(5)
shirt_shade = np.clip(1.15 - 0.55 * ((xx - 600) / 900) ** 2 - 0.25 * (yy - 1400) / 600, 0.3, 1.2) * folds
shirt = np.stack([0.06 * shirt_shade, 0.12 * shirt_shade, 0.24 * shirt_shade], axis=-1)
img = img * (1 - torso[..., None]) + shirt * torso[..., None]

# --- skin albedo and shading helpers
SKIN = np.array([0.62, 0.38, 0.27], np.float32)
light = np.array([-0.5, -0.45, 0.74], np.float32)
light /= np.linalg.norm(light)
pores = 1 + 0.025 * noise(1.2) + 0.03 * noise(8)


def skin_shade(nx, ny, nz):
    n = np.stack([nx, ny, nz], axis=-1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True) + 1e-6
    diffuse = np.clip(n @ light, 0, 1)
    fill = np.clip(n @ np.array([0.7, 0.1, 0.7], np.float32), 0, 1) * 0.12
    shade = 0.07 + 1.05 * diffuse + fill
    # redder in the shadows (light scattered under the skin)
    tint = np.stack([np.ones_like(shade), 0.90 + 0.10 * diffuse, 0.84 + 0.16 * diffuse], axis=-1)
    spec = np.clip(n @ (light + np.array([0, 0, 1], np.float32)) / np.linalg.norm(light + [0, 0, 1]), 0, 1) ** 40
    return SKIN * tint * (shade * pores)[..., None] + spec[..., None] * 0.35


# neck: a cylinder with a shadow under the chin
neck = smooth(np.minimum(150 - np.abs(xx - cx), np.minimum(yy - 1080, 1700 - yy)), 2.0)
vneck = smooth(np.minimum((yy - 1390) * 0.42 - np.abs(xx - cx) + 150, 1640 - yy), 2.0)
neck = np.maximum(neck * (yy < 1420), vneck)
u = np.clip((xx - cx) / 160, -0.99, 0.99)
neck_col = skin_shade(u, np.full_like(u, 0.1), np.sqrt(1 - u**2))
chin_shadow = 1 - 0.55 * np.exp(-(((yy - 1200) / 70) ** 2)) * (yy > 1150)
neck_col *= chin_shadow[..., None]
img = img * (1 - neck[..., None]) + neck_col * neck[..., None]

# --- hair behind the head (long, to the shoulders)
HX, HY, RX, RY = cx, 820.0, 330.0, 430.0
back_hair = smooth(np.minimum(ellipse(cx, 840, 420, 560), 1450 - yy), 3.0)
# strands: noise stretched along the fall of the hair
streak = 0.12 * noise(1.2) + np.repeat(blur(rng.standard_normal((1, W)).astype(np.float32), 2.0), H, axis=0) * 0.6
hair_shade = np.clip(1 + streak, 0.5, 1.6)
sheen = np.exp(-(((xx - 650) / 120) ** 2 + ((yy - 500) / 160) ** 2)) * 2.2
hair_col = np.stack([0.030, 0.018, 0.011]) * (hair_shade + sheen)[..., None]
img = img * (1 - back_hair[..., None]) + hair_col * back_hair[..., None]

# --- face: an ellipsoid lit from the upper left
head = smooth(ellipse(HX, HY, RX, RY), 2.0)
fu = (xx - HX) / RX
fv = (yy - HY) / RY
fz = np.sqrt(np.clip(1 - fu**2 - fv**2, 0.02, 1))
face = skin_shade(fu, fv * 0.8, fz)
# cheek colour
blush = np.exp(-(((np.abs(fu) - 0.45) / 0.16) ** 2 + ((fv - 0.22) / 0.12) ** 2))
face = face * (1 + blush[..., None] * np.array([0.10, -0.05, -0.04], np.float32))
# nose: a shadow to its right, a highlight on the bridge, nostrils
nose_shadow = np.exp(-(((fu - 0.11) / 0.05) ** 2)) * np.clip((fv + 0.05) / 0.3, 0, 1) * (fv < 0.36)
face *= (1 - 0.35 * nose_shadow)[..., None]
bridge = np.exp(-(((fu + 0.02) / 0.03) ** 2)) * (np.abs(fv - 0.12) < 0.2) * 0.15
face += bridge[..., None] * SKIN
for s in (-1, 1):
    nostril = smooth(ellipse(HX + s * 0.085 * RX, HY + 0.34 * RY, 15, 9), 2)
    face *= (1 - 0.6 * nostril)[..., None]
# eyes
for s in (-1, 1):
    ex, ey = HX + s * 0.38 * RX, HY - 0.08 * RY
    socket = np.exp(-(((xx - ex) / 75) ** 2 + ((yy - ey + 8) / 45) ** 2))
    face *= (1 - 0.25 * socket)[..., None]
    white = smooth(ellipse(ex, ey, 58, 24), 1.5)
    face = paint(face, white, (0.55, 0.52, 0.50))
    iris = smooth(ellipse(ex + s * 4, ey, 21, 21), 1.2) * white
    face = paint(face, iris, (0.09, 0.045, 0.02))
    pupil = smooth(ellipse(ex + s * 4, ey, 9, 9), 1.0) * white
    face = paint(face, pupil, (0.005, 0.004, 0.004))
    catch = smooth(ellipse(ex + s * 4 - 7, ey - 7, 4, 4), 1.0)
    face = paint(face, catch, (1.0, 1.0, 1.0))
    lid = smooth(np.minimum(5 - np.abs(yy - (ey - 22 + 0.004 * (xx - ex) ** 2)), 62 - np.abs(xx - ex)), 1.5)
    face = paint(face, lid, (0.04, 0.02, 0.015))
    brow_y = ey - 70 + 0.006 * (xx - ex - s * 10) ** 2
    brow = smooth(np.minimum(9 - np.abs(yy - brow_y), 78 - np.abs(xx - ex - s * 8)), 2.0)
    face = paint(face, brow * 0.9, (0.05, 0.03, 0.02))
# mouth
mu = (xx - HX) / (0.28 * RX)
my = HY + 0.56 * RY
upper = smooth(np.minimum((yy - (my - 22 + 14 * mu**2)), my - yy), 1.5) * (np.abs(mu) < 1)
lower = smooth(np.minimum(yy - my, (my + 32 - 24 * mu**2) - yy), 1.5) * (np.abs(mu) < 1)
lips = np.maximum(upper, lower)
lip_col = np.stack([0.40, 0.13, 0.11]) * (0.7 + 0.5 * lower)[..., None]
face = face * (1 - lips[..., None]) + lip_col * lips[..., None]
lip_line = smooth(2 - np.abs(yy - my), 1.0) * (np.abs(mu) < 1.02)
face = paint(face, lip_line, (0.05, 0.015, 0.012))
img = img * (1 - head[..., None]) + face * head[..., None]

# --- hair over the forehead and the sides of the face
# a side parting: the fringe sweeps down from the upper left
hairline = fv < (-0.62 + 0.22 * np.clip(-fu, -1, 1) + 0.1 * fu**2)
fringe = smooth(ellipse(HX - 10, HY - 40, RX + 30, RY + 10), 2.0) * hairline
sides = smooth(ellipse(HX, HY - 30, RX + 40, RY + 40), 2.0) * (1 - smooth(ellipse(HX, HY + 20, RX - 18, RY), 3.0))
front_hair = np.clip(np.maximum(fringe, sides * (yy < 1180)), 0, 1)
img = img * (1 - front_hair[..., None]) + hair_col * front_hair[..., None]

# --- sensor noise, encode to sRGB
img = np.clip(img, 0, None)
srgb = np.where(img <= 0.0031308, img * 12.92, 1.055 * np.power(img, 1 / 2.4) - 0.055)
srgb += rng.normal(0, 0.006, srgb.shape).astype(np.float32)
out = (np.clip(srgb, 0, 1) * 255 + 0.5).astype(np.uint8)
os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
Image.fromarray(out, "RGB").save(OUT, quality=90, subsampling=0)
print(f"wrote {OUT} ({W}x{H})")
