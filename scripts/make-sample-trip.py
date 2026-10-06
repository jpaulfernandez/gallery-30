#!/usr/bin/env python3
"""Generate a fake trip folder of photos for testing the editor.

Usage: python3 scripts/make-sample-trip.py [out_dir] [count]
Default out_dir: fixtures/sample-trip, count: 40.
Produces JPEGs in a mix of orientations and sizes (a few at 6000x4000 to
mimic 40 MP camera files), a couple of PNGs, EXIF orientation on some, and
a subfolder, so scan/hash/thumbnail code gets exercised.
"""
import os
import random
import sys
from datetime import datetime, timedelta

from PIL import Image, ImageDraw, ImageFont

out = sys.argv[1] if len(sys.argv) > 1 else "fixtures/sample-trip"
count = int(sys.argv[2]) if len(sys.argv) > 2 else 40
random.seed(7)
os.makedirs(os.path.join(out, "day-two"), exist_ok=True)

palettes = [
    ((240, 180, 120), (60, 40, 30)),
    ((120, 170, 220), (20, 40, 80)),
    ((170, 200, 150), (30, 60, 30)),
    ((230, 220, 200), (90, 80, 70)),
    ((200, 120, 140), (70, 20, 40)),
    ((90, 90, 110), (220, 220, 230)),
]

def gradient(w, h, c1, c2):
    img = Image.new("RGB", (w, h))
    px = img.load()
    for y in range(h):
        t = y / max(h - 1, 1)
        r = int(c1[0] + (c2[0] - c1[0]) * t)
        g = int(c1[1] + (c2[1] - c1[1]) * t)
        b = int(c1[2] + (c2[2] - c1[2]) * t)
        for x in range(w):
            px[x, y] = (r, g, b)
    return img

try:
    font = ImageFont.truetype("/System/Library/Fonts/Helvetica.ttc", 160)
except OSError:
    font = ImageFont.load_default()

start = datetime(2026, 4, 2, 9, 0)
for i in range(count):
    big = i % 8 == 0
    landscape = i % 3 != 0
    if big:
        w, h = (6000, 4000) if landscape else (4000, 6000)
    else:
        w, h = (2400, 1600) if landscape else (1600, 2400)
    c1, c2 = palettes[i % len(palettes)]
    img = gradient(w // 8, h // 8, c1, c2).resize((w, h))
    d = ImageDraw.Draw(img)
    for _ in range(12):
        x0, y0 = random.randint(0, w), random.randint(0, h)
        r = random.randint(w // 20, w // 5)
        d.ellipse((x0 - r, y0 - r, x0 + r, y0 + r), fill=(random.randint(0, 255), random.randint(0, 255), random.randint(0, 255)))
    d.text((w * 0.05, h * 0.05), f"DSCF{1000 + i}", fill=(255, 255, 255), font=font)
    sub = "day-two" if i >= count * 2 // 3 else ""
    name = f"DSCF{1000 + i}"
    ts = start + timedelta(minutes=17 * i)
    exif = img.getexif()
    exif[0x0132] = ts.strftime("%Y:%m:%d %H:%M:%S")  # DateTime
    if i % 5 == 4:
        exif[0x0112] = 6  # Orientation: rotate 90 CW
    if i % 11 == 10:
        path = os.path.join(out, sub, name + ".png")
        img.save(path)
    else:
        path = os.path.join(out, sub, name + ".jpg")
        img.save(path, quality=90 if big else 85, exif=exif.tobytes())
    os.utime(path, (ts.timestamp(), ts.timestamp()))
    print(path, w, h)
print("done", count)
