# Portrait fixture

`portrait-01.jpg` (1600×2000) is a synthetic head-and-shoulders picture for reviewing the built-in looks (workflow
plan 21). It is drawn from shapes and noise by `scripts/make-portrait-fixture.py`; no photograph or downloaded asset is
involved.

Licence: CC0 1.0 (public domain dedication), for the script and the image.

Regenerate it from the repository root with:

```sh
python3 scripts/make-portrait-fixture.py
```

The committed file was made with Python 3.12, Pillow 12.3.0 and numpy 2.5.0; with those versions the output is
byte-identical (fixed seed). Other versions may differ slightly in the JPEG encoding.
