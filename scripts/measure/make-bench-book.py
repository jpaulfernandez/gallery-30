#!/usr/bin/env python3
"""Workflow plan 36 budgets bench (scripts/measure/README.md): a legacy (version 3) book.photobook.json over every photo
of a folder, which the editor imports as a project at startup: every file as an asset, and 20 designed pages that cycle
nine layouts (the lisbon-demo book's, embedded below so the script needs no gitignored fixture).

Usage: python3 scripts/measure/make-bench-book.py <folder>

Deterministic for the same files: ids come from a fixed timestamp and a seeded generator. Sizes come from Pillow, or
from `sips` (macOS) for files Pillow cannot open, such as camera RAW.
"""
import hashlib
import json
import os
import random
import subprocess
import sys

from PIL import Image

PHOTO_EXTENSIONS = (".jpg", ".jpeg", ".png", ".heic", ".cr2", ".cr3", ".nef", ".arw", ".dng", ".raf", ".orf", ".rw2")
B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"
FIXED_MS = 1_791_800_000_000  # 2026-10-12, so ids sort the same on every run

BASE = json.loads(r'''{"template": {"name": "phone-portrait", "width": 1080, "height": 1350}, "theme": {"background": "#ffffff", "defaultPageBackground": "#ffffff", "fonts": ["Inter", "Fraunces"], "margin": 0.08, "gutter": 0.025, "wideGutter": 0.05, "bleed": 0.0156, "hardMargin": 0.0625, "captionOffset": 0.015, "captionClearance": 0.0375, "grid": 0.0139}}''')
LAYOUTS = json.loads(r'''[{"layout": "c1-chapter-opener", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0.56, "y": 0.576, "w": 0.36, "h": 0.36}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "text", "text": "Title", "style": "title", "frame": {"x": 0.08, "y": 0.288, "w": 0.72, "h": 0.088}, "align": "left", "size": 0.12}, {"type": "text", "text": "Caption", "style": "caption", "frame": {"x": 0.08, "y": 0.408, "w": 0.38, "h": 0.064}, "align": "left"}]}, {"layout": "1-full-bleed", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0, "y": 0, "w": 1, "h": 1}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}]}, {"layout": "c2-pair-shared-caption", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0.08, "y": 0.264, "w": 0.4075, "h": 0.408}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "photo", "frame": {"x": 0.5125, "y": 0.264, "w": 0.4075, "h": 0.408}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "text", "text": "Caption", "style": "caption", "frame": {"x": 0.08, "y": 0.704, "w": 0.5, "h": 0.056}, "align": "left"}]}, {"layout": "3-tall-left-two", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0.08, "y": 0.064, "w": 0.4075, "h": 0.872}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "photo", "frame": {"x": 0.5125, "y": 0.064, "w": 0.4075, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "photo", "frame": {"x": 0.5125, "y": 0.51, "w": 0.4075, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}]}, {"layout": "c1-overlay-on-full-bleed", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0, "y": 0, "w": 1, "h": 1}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "text", "text": "Caption", "style": "caption", "frame": {"x": 0, "y": 0.768, "w": 1, "h": 0.232}, "align": "left", "color": "#ffffff", "overlay": true}]}, {"layout": "4-classic-quad", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0.08, "y": 0.064, "w": 0.4075, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "photo", "frame": {"x": 0.5125, "y": 0.064, "w": 0.4075, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "photo", "frame": {"x": 0.08, "y": 0.51, "w": 0.4075, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "photo", "frame": {"x": 0.5125, "y": 0.51, "w": 0.4075, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}]}, {"layout": "c1-quote-page", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0.34, "y": 0.616, "w": 0.32, "h": 0.32}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "text", "text": "Caption", "style": "quote", "frame": {"x": 0.16, "y": 0.176, "w": 0.68, "h": 0.272}, "align": "left"}, {"type": "text", "text": "Caption", "style": "caption", "frame": {"x": 0.16, "y": 0.48, "w": 0.3, "h": 0.048}, "align": "left"}]}, {"layout": "2-stacked-pair", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0.08, "y": 0.064, "w": 0.84, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "photo", "frame": {"x": 0.08, "y": 0.51, "w": 0.84, "h": 0.426}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}]}, {"layout": "c1-caption-below", "background": "#ffffff", "elements": [{"type": "photo", "frame": {"x": 0.14, "y": 0.096, "w": 0.72, "h": 0.72}, "crop": {"x": 0, "y": 0, "scale": 1}, "rotate": 0, "filter": "none"}, {"type": "text", "text": "Caption", "style": "caption", "frame": {"x": 0.14, "y": 0.84, "w": 0.5, "h": 0.056}, "align": "left"}]}]''')


def ulid(rng):
    t, s = FIXED_MS, ""
    for _ in range(10):
        s = B32[t % 32] + s
        t //= 32
    return s + "".join(rng.choice(B32) for _ in range(16))


def size_and_orientation(path):
    try:
        with Image.open(path) as im:
            return im.size[0], im.size[1], im.getexif().get(0x0112, 1)
    except Exception:
        out = subprocess.run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], capture_output=True, text=True).stdout
        values = dict(line.split(": ") for line in (l.strip() for l in out.splitlines()) if ": " in line)
        return int(values["pixelWidth"]), int(values["pixelHeight"]), 1


def main():
    folder = os.path.abspath(sys.argv[1])
    rng = random.Random(36)
    files = []
    for root, dirs, names in os.walk(folder):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        files += [os.path.relpath(os.path.join(root, n), folder) for n in names if n.lower().endswith(PHOTO_EXTENSIONS)]
    files.sort()
    assets, ids = {}, []
    for rel in files:
        path = os.path.join(folder, rel)
        with open(path, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        w, h, orientation = size_and_orientation(path)
        aid = ulid(rng)
        ids.append(aid)
        assets[aid] = {"path": rel, "hash": digest, "width": w, "height": h, "size": os.path.getsize(path),
                       "mtime": int(os.stat(path).st_mtime * 1000), "orientation": orientation}
    pages, cursor = [], 0
    for i in range(20):
        layout = LAYOUTS[i % len(LAYOUTS)]
        elements = []
        for e in layout["elements"]:
            e = json.loads(json.dumps(e))
            e["id"] = ulid(rng)
            if e["type"] == "photo":
                e["asset"] = ids[cursor % len(ids)]
                cursor += 1
            elements.append(e)
        pages.append({"id": ulid(rng), "layout": layout["layout"], "background": layout["background"], "elements": elements})
    book = {"version": 3, "id": ulid(rng), "title": "Budgets bench (plan 36)", "sourceFolder": folder,
            "template": BASE["template"], "theme": BASE["theme"], "assets": assets, "pages": pages,
            "publish": {"slug": "budgets-bench", "visibility": "listed", "lastPublishedAt": None, "r2Prefix": "bench"},
            "customLayouts": []}
    with open(os.path.join(folder, "book.photobook.json"), "w") as f:
        json.dump(book, f, indent=1)
    print("assets", len(assets), "pages", len(pages), "placed", cursor)


if __name__ == "__main__":
    main()
