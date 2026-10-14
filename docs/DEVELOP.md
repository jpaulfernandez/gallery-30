# Develop

Develop is Photobook's photo editor: exposure, white balance, curves, colour, crop and perspective, sharpening,
AI denoise and local masks, applied to one photo at a time without touching the original file. You use it to
fix a photo before it goes on a page, then publish the book as usual.

- **Non-destructive.** The original is never written. The edit is plain data in the photo folder's library (see
  [Where edits are stored](#where-edits-are-stored)), so it survives undo, relinking a moved folder, reopening the
  book and even deleting the project file.
- **Per photo.** Every photo has its own settings, like Lightroom. A photo used on two pages is edited once, and
  two copies of the same file (same bytes) share one edit.
- **Published renders are baked in.** When you publish, the editor renders each edited photo at full size and
  the book contains that render (see [Publishing edited photos](#publishing-edited-photos)).
- **Local.** Everything, AI included, runs on your computer. Nothing is uploaded; the AI models are downloaded
  once on demand ([Models](#ai-models)).

The look is "Lightroom-like, not identical": the controls and ranges follow Lightroom's, the maths is Photobook's
own. See [Limits](#limits-and-caveats).

## Where edits are stored

Ratings, flags and develop settings live in the photo folder, in `<folder>/.photobook/library.json`, keyed by the
SHA-256 of each file's bytes rather than by its name. So:

- **They belong to the photo, not the book.** Every project on the folder shows the same ratings and edits (edit a
  photo in one project and the others show it next time they open), and a project deleted and started again on that
  folder gets them back as soon as the scan has recognised each file. A renamed or moved file keeps its edit, because
  its bytes did not change; a photo that moved into another imported folder takes its entry along into that folder's
  library.
- **Saving is automatic,** like the project file: a moment after each change the library is written through a
  temporary file and a rename, and the version it replaces is kept as `library.json.bak`. If the file is ever
  damaged or missing, the backup is put back in its place (a damaged file is kept as `library.json.corrupt`); if
  one photo's entry is invalid, the backup is used and the dev log names the photo. A library written by a newer
  Photobook is left untouched (your edits then stay in the project file only) and the dev log says why.
- **The project file only references the photos.** `project.photobook.json` names each photo by its hash, folder and
  path; the publish command reads the edit from the folder's library. A book saved by an older Photobook still carries
  each photo's `rating`, `flag` and `develop`: when you open it the two are matched field by field (a value the library
  has wins over the book's, and a value only the book has is copied into the library, so a rating in the book is kept
  even when the library only knows the photo's edit), the library is written, and the book is saved right away in the
  current format without them. A photo the scan has not recognised yet, or a folder whose library cannot be written,
  keeps its fields in the project file until it can.
- **Undo** covers library edits the same way as before: undoing an edit takes it out of the library too. Ratings and
  flags, as before, are not undo steps.
- **No project needed.** The Develop stage edits a folder's photos directly (the library's master edit); a project
  that uses the photo later, or already does, shows the edit.
- **Versions** let one photo have more than one edit ([Versions](#versions)); they live in the same library entry.
- `.photobook/` is a hidden folder; leave it with the photos when you copy or back up the folder. Removing the folder
  from Photobook does not delete it. Next to the library it holds `index.json`, a cache of what scanning found (each
  file's hash, size, date and pixel size) so a folder opens without hashing again; deleting it only costs one rescan.

## Opening Develop

From the library, no project needed:

- Click **Develop** in the top bar's stage tabs (Cull · Develop · Design), or a folder or collection in the Library
  sidebar while Develop is showing. It opens on the photo Cull showed last, and steps through the folder's (or
  collection's) photos as the filter bar above it narrows them (flag, rating, search, sort): the same filter as Cull,
  except that **All flags** hides rejects in Develop (the menu reads "All but rejects"), so by default you develop the
  picks and the unflagged photos. Choose **Rejects only** to see them.
- Press **D** in Cull. A project's own Cull (Project ▾ → Cull its photos) opens Develop over the project's photos the
  same way.

Inside a project (the Design stage), on the project's photos:

- Press **D** with a photo focused in the filmstrip, or with a photo slot selected on the canvas.
- Press **D** inside **Review** (R).
- Select a photo on the canvas and click **Develop…** in the inspector.

In the Develop stage the view fills the window under the top bar and stays open; inside a project it covers the
editor, Left and Right step through the same photos the filmstrip was showing, and **Done** (Esc) returns to the
book. Either way the edit goes to the photo's folder library. The header holds **Crop** (R), **Before / After** (\\) and **Proof** (S); the bottom
strip shows neighbouring photos and the right panel has the adjustments. An **Edited** badge marks a photo with
settings, and **Reset all** removes every adjustment from it.

Every slider: drag (hold Shift for fine control), double-click to reset, arrow keys nudge (Shift for ten steps),
click the readout to type a value. A whole drag is one undo step (Cmd+Z).

## The panel, section by section

The header row reads **Develop** (with an Edited tag once the photo is edited), the **Basic ⇄ Advanced** switch and a
**⋯** menu (Sync…, Copy, Copy…, Paste, Reset all); Looks and Presets are in the left pane. Below it seven cards run
in the order of operations, each with its own reset (the arrow in its title row): **Crop**, **Light**, **Color**,
**Detail**, **Sharpen & denoise**, **Effects**, **Masks**.

### Basic ⇄ Advanced

One switch for every card, remembered on this computer (not in the book).

- **Basic** shows each card's common rows. The rest of a card sits behind a **▸** button (for example **Curve ▸**
  under the Light sliders, **Color mix ▸** under Saturation); pressing it opens those controls in place, the card
  grows, and it stays open while you step through photos. Nothing is out of reach in Basic.
- When a control behind a ▸ is changed, the button carries an **·edited** tag, so nothing that changes the picture
  is hidden.
- **Advanced** shows every card with all its controls inline; the ▸ buttons become plain headings.

| Card | Basic | Behind its ▸ (inline in Advanced) |
| --- | --- | --- |
| Crop | **Crop & straighten** (R) and what the crop is now ("4:5 · 1.2°") | **Upright & transform** |
| Light | Exposure, Contrast, Highlights, Shadows, Whites, Blacks | **Curve**: the presets, the point curve, the parametric sliders |
| Color | White balance, Temperature, Tint, Vibrance, Saturation | **Color mix** |
| Detail | Texture, Clarity, Dehaze | nothing |
| Sharpen & denoise | Sharpening Amount, AI denoise | **Radius, detail, masking** |
| Effects | the Color grading wheels (Shadows, Midtones, Highlights), the harmony lock and the preset chips; the Vignette, Halation and Grain amounts | **Luminance, global wheel** (a luminance slider per wheel and the Global wheel); one ▸ per other group: Blending and Balance; Midpoint, Feather, Roundness; Threshold, Radius; Size, Roughness |
| Masks | the mask list, Create new mask, the components and the mask's sliders | **Range & refine** of the selected component (luminance range, colour Refine, AI Refine and depth range); making a range mask opens it |

### Light and Color

- **White balance** (the Color card). A choice of **As shot** or **Custom**.
  - JPEG, PNG and HEIC: Custom gives **Temperature** and **Tint** as shifts of -100 to 100 from the as-shot colour.
  - Camera RAW: Custom gives an absolute **Temperature** in Kelvin (2000 to 50000, on a log track; click the
    readout to type a number) and **Tint** (-150 to 150). Both start at the values the camera recorded, so
    As shot and Custom with untouched sliders look the same.
- **Light** (the Light card). Exposure (-5 to +5 EV), Contrast, Highlights, Shadows, Whites, Blacks.

### Curve

Under the Light card's **Curve ▸**. **Presets** as chips: **Linear**, **Soft S**, **Strong S**, **Matte** (lifted
blacks), **Faded** (lifted blacks, pulled whites) and **Reverse S**. A chip sets the points of the channel shown, as
if you had drawn them (one undo step); you can keep editing the points after. **Point curve**: tabs for **Luma**,
**R**, **G** and **B**. Click the curve to add a point and drag it; double-click a point (or press Delete) to remove
it. The curve works on the output-encoded values, like Lightroom's. **Parametric**: Highlights, Lights, Darks and
Shadows sliders, with draggable split points between the regions.

### Color

**Vibrance**, **Saturation**, and under **Color mix ▸**: eight bands (Red, Orange, Yellow, Green, Aqua, Blue, Purple,
Magenta), each with Hue, Saturation and Luminance (switch with the tabs). A dot on a band's swatch means it is edited.

### Crop

**Crop & straighten** (R) opens the crop tool ([Crop and straighten](#crop-and-straighten)); the line beside it says
what the crop is (aspect, angle, a turn, flipped). The card's reset puts the whole geometry back: crop, angle,
rotation, flips, Upright and the Transform sliders.

**Upright & transform ▸**: perspective and straightening of the whole picture:

- **Upright**: **Off**, **Auto**, **Level**, **Vertical**, **Full** and **Guided**.
  - Auto, Level, Vertical and Full analyse the photo's straight lines and apply the correction only when they find
    some. A line below the buttons says what ran, or why nothing did (for example "No straight lines found" or "Already level").
    **Update** analyses again, for example after a rotation.
  - **Guided**: press **Draw guides**, then drag on the photo to draw two to four lines along edges that should be
    level or plumb (each guide has a button to treat it as horizontal or vertical if it was guessed wrong).
    Drag an end to move it, Delete removes the selected guide. **Done drawing guides** ends the mode.
  - **Show structure** draws the lines automatic Upright found: yellow for the ones it used, grey for the rest.
  - Choosing an Upright mode resets the Transform sliders below, as Lightroom does; Alt-click keeps them.
- **Transform sliders**: Vertical, Horizontal, Rotate, Aspect, Scale, X Offset, Y Offset.
- **Constrain Crop** keeps the crop inside the corrected picture.

Masks and guides follow the picture when you change the perspective.

### Detail, Sharpen & denoise

- **Detail** card: **Texture**, **Clarity**, **Dehaze**.
- **Sharpen & denoise** card: **Sharpening** Amount, and Radius, Detail, Masking under its ▸. Hold **Alt** while you
  drag a Sharpening slider to see the sharpening mask (white is sharpened). Its reset puts Sharpening back and turns
  denoise off.
- **Denoise**: an AI denoise with one **Amount** slider in front, a loupe on the picture, and the rest under
  **Advanced**.
  1. Turn the switch on. Denoise starts at the amount the photo's noise suggests (see the badge below) with the
     model chosen in Settings → Models, and a **loupe** opens on the picture: a square window at 100 % (the 512 px
     crop at full size) with the photo before denoise on the left of a split line and after on the right.
  2. If the model is not installed yet, the group shows a card with its name, size and licence and one **Download**
     button (it resumes an interrupted download). The loupe waits for it.
  3. Move **Amount**. It sets how strongly the noise in brightness (luminance) is removed, and the colour noise
     follows it at 25 above (Amount 55 removes colour noise at 80, anything from 75 up at 100). Double-click Amount to
     return to the suggestion. The loupe renders again once you stop moving the slider for a little over half a
     second, never while a slider is held, so dragging stays smooth. Right after you switch denoise on it renders at
     once; when you step to another photo with the loupe open, or move it, it waits a fifth of a second, so stepping
     quickly through photos only renders the one you stop on. With the colour filter (the default, see below)
     the colour part shows at once on the picture around the loupe, because the filter runs while the picture is
     drawn; only the luminance part waits for the loupe.
  4. Use the loupe. Drag it to the part of the picture you want to judge (or click the picture there, or use the
     arrow keys while it has focus); it renders there when you let go. Drag the split line to show more of before or
     after. Press and hold the loupe, or turn on **Before / After** (\\), to see the whole square before denoise.
     **Preview at 100 %** in the group (or the cross on the loupe, or Escape) shows and hides it. The loupe shows the denoise
     alone, not your tone, colour or geometry edits.

  **Apply is a state, not a step.** The pill next to the switch says where the photo is: **Needs apply** (the
  settings have not been run at full size yet), **Queued** or **Running 37 %** (a full run is in the background job
  queue, with a progress bar and **Cancel** in the group), **Applied** (the full-size result for these settings is
  ready), or **Needs model**. You never have to press **Apply**: moving on to another photo (or closing Develop) while
  the pill reads **Needs apply** queues the full run in the background, and publishing waits for queued runs and
  denoises any used photo that still needs it. A run you cancelled is not queued again when you leave the photo until
  you change its settings, and a run that failed is not retried behind your back: press **Apply** to try again. If
  the same file is already being denoised with the same settings (for example from the library), the pill shows that
  run. **Apply** is there to start the run now; it shows the estimated time,
  worked out from the last full run of that model on this Mac (for example "Apply · ~14 s"; no estimate before a first
  run).

  **Advanced** (its summary line shows the values, for example "Luminance 55 · Colour 80 · Sharpen 25 · NAFNet ·
  Colour: filter"):
  - **Luminance** is the Amount itself. **Colour** sets the colour noise removal apart from Amount: once you move it,
    Amount no longer changes it. **Sharpen** (default 25) restores some fine detail after denoising; Amount never
    changes it either.
  - **Colour from** chooses how colour noise (blotches of false colour) is removed. **Filter** (the default) uses a
    fast colour filter guided by the denoised detail: it only smooths colour where the picture's own shading allows,
    so colour edges stay where the edges are, and it steps back in busy multicoloured textures rather than mixing
    their colours. Its strength comes from the photo's measured noise (see the noise profile below). Because it runs
    while the picture is drawn, Colour moves at once and changing it never makes the photo need a new run. **Model**
    uses the AI model's own colour instead: smoother on very heavy noise, but it can wash out patches of colour, and
    every Colour change needs a new run.
  - **Model** overrides the model for this photo: **NAFNet** (recommended, about 15 seconds for a 24 MP photo on Apple
    silicon) or **SCUNet** (slow and CPU only; see [Limits](#limits-and-caveats)). The default for new photos is set
    in Settings → Models, marked "(default)" in the list.
  - **Reset** puts Colour back on Amount's mapping and Sharpen, Colour from and the model back to their defaults,
    keeping Amount.

  **What Luminance keeps.** Below 100, Luminance does not simply mix the noisy photo back in. The photo's brightness
  is split by scale: the finest detail (one or two pixels, where grain lives) is mixed back in proportion to how far
  Luminance is below 100, while the coarser blotches the model removed stay removed from Luminance 10 up (below 10
  they fade back in, so 0 is the photo untouched). At Luminance 50 a little under half of the photo's noise comes back
  (about 0.45 of it, against 0.5 for a plain mix), almost all of it fine grain, which reads as film-like texture,
  without the mottled patches a plain mix would bring back. At 100 you get the model's result and at 0 the photo's own
  brightness, exactly as before. A denoise run before this change is run again the next time the photo needs its
  full-size result, and the picture in Develop follows; a full-size render or export already made from the old run
  keeps its old look until you change one of the photo's settings.

  **Photos that do not need it.** When a photo's noise suggests less than 15 (a clean, low-ISO photo), the group
  shows only "Not needed at ISO 200" (with the photo's ISO; "Not needed (clean at ISO 6400)" when the measured noise is
  low although the ISO is high) while denoise is off, once the noise has been measured; click it to see the badge, or turn
  the switch on anyway (it then starts gently, at 10).

  **Noise profile and the camera badge.** The line under the Denoise switch names the camera and ISO, the amount the
  photo's noise suggests (or **Not needed**), and how many of your photos taught Photobook that camera at that ISO,
  for example "Fujifilm X-T5 · ISO 6400 · suggests 55 · learned from 12 photos". Turning denoise on starts from the
  suggestion (Amount at the suggested amount, at least 10), or from Amount 50 when nothing is known. Photobook measures the noise from the photo itself the first time you open its Denoise group: it looks
  for flat patches (sky, walls, out-of-focus areas) on the 1600 px working picture and fits how the noise grows with
  brightness. A busy picture without flat areas, or one bright all over (snow, an overcast sky), gives no measurement,
  and the ISO decides instead. Every measurement of a photo with a camera make, model and ISO is also added to a
  profile of that camera at that ISO (kept apart for RAW and JPEG files, whose noise differs a lot). The profile is
  used once three of your photos at that ISO agree, so one odd photo never sets it, and later odd results are left
  out; it also covers ISOs up to two stops from ones it knows, with less weight. A photo from a camera Photobook
  already knows is read with that profile blended in, which is steadier than one photo's own measurement. Measuring
  starts a moment after you stop on a photo, so stepping through photos does not decode each one. Measurements are cached per photo and the profiles live in the app's data folder (`noise-profiles/`).
  The **Needs denoise** collection in the library uses the measured noise when a photo has one and ISO 3200 and up
  otherwise.

  **Denoise (batch).** To denoise many photos ahead of time, select them and choose **Denoise selected…** in the
  batch bar (or **Denoise…** in the Cull grid's right-click menu); with nothing selected it acts on the photo shown.
  A confirm says how many photos will be denoised, how many are skipped because they are already denoised for their
  settings, and the estimated time, worked out from the last full run on this Mac (its time per tile, times the tiles
  of each photo; there is no estimate before a first run). Photos that already have denoise on keep their settings.
  Photos with denoise off are switched on (one undo step for all) with the model chosen in Settings → Models and the
  amount their noise suggests; a photo that was never measured is measured first, so the confirm may say "Measuring
  noise…" for a moment. Hold **Shift** when you click (or tick **Run again on photos already denoised**) to denoise
  those photos again too. Each photo is its own job in the background queue: they run one at a time, and cancelling
  one in the jobs list leaves the others queued. A publish started meanwhile waits for them instead of running them
  twice, and its dialog says "N photos still denoising" before you press Publish. Nothing is queued while the model is
  not downloaded.

  **Suggestions.** A photo that would benefit from denoise and has it off carries a small grain badge at the top right
  of its thumbnail in the Cull grid and the filmstrip, and the sidebar shows how many photos the **Needs denoise**
  collection holds. Settings → Models sets the thresholds: an ISO (3200 by default) for photos without a noise
  measurement, and a suggested amount (40 by default) for photos with one; the measurement wins over the ISO, so a
  clean ISO 6400 photo gets no badge and a noisy ISO 800 one does.

### Looks

The **Looks** section sits at the top of the panel, above Basic. It shows a strip of small pictures of the photo, one
per look, with the look's name under each: **None** first, then the [built-in looks](#built-in-looks), then your looks
by name. The look the photo uses has an accent ring. Click a picture to apply that look (a built-in look starts at its
own Amount, shown below; your own looks at full strength), or press **`]`** and **`[`** to step to the next or previous one (None included). The pictures are rendered from the
photo's current edit without its look, so they follow your exposure and white balance; they are made in the
background a moment after you stop changing a slider (240 px, one render per look, about 30 to 40 ms for twelve looks
on the GPU) and cached in the app's cache folder (`cache/<hash>/looks/`), so reopening a photo shows them at once.
They show the photo's crop, and are always rendered in sRGB (they are small swatches; the photo itself follows the
book's output colour space). A look whose LUT file is not on this Mac is dimmed and marked **LUT missing**. With the
strip focused, **Left** and **Right** move to the previous or next look (the strip is one Tab stop).

A look is a kind of preset: it always holds the **Effects** section and the **Look** (LUT) section, and may also hold
Light, White balance, Curve, Color or Detail. **Amount** (0 to 100 %, under the strip) scales the look from the
defaults: each value of the sections the look holds becomes `default + amount × (look − default)`, so at 50 % a grain
of 60 becomes 30 and a saturation of −40 becomes −20 (a colour-grading wheel keeps its hue and scales its saturation;
a point curve moves towards the straight line). For a LUT look the Amount scales the LUT's strength. Applying a look
replaces the values of the sections it holds, whatever the photo had there; your other sections stay. Switching from
one look to another first puts the old look's sections back to their defaults, so a curve from the previous look
does not linger. **None** (or the section's **Reset**) takes the look off the same way; with no look applied it puts
Effects and the LUT back to their defaults. The photo records which look it uses and at what Amount, so you can change
the Amount later; if that look is deleted or the photo was edited on another Mac, the values stay and the Amount is
locked. Edits you make after applying a look are kept: once a section the look wrote has been changed by hand the
Amount is locked ("changed since"; choose the look again to start over), switching to another look or to None resets
only the sections still as the look left them, and choosing a LUT or moving its Strength by hand makes the LUT your own
rather than the look's. Sync and Copy carry which look was applied only when every section of that look is copied. Which look a photo uses is not part of its render key: two
photos with the same values share renders whether or not a look wrote them.

The **⋯** menu holds **Save current as look…** (a name and which of Light, White balance, Curve, Color and Detail to
include besides Effects and the LUT; the photo then shows the new look as chosen), **Import LUT…** (imports a `.cube`
or HALD CLUT, below, saves it as a look named after the file and applies it), **Match camera JPEG…**
([below](#match-camera-jpeg)) and **Manage looks…** (rename or delete your looks). Looks are stored with the presets
in the app's data folder (`presets/<id>.json` with `"look": true`), so they follow you between books; they are listed in
the strip, not in the Presets menu. Under the strip, **LUT** opens the LUT picker of the next section.

#### Built-in looks

Photobook ships twelve looks of its own. They are parametric: each sets the tone curve, the Color section (saturation,
vibrance and the colour mixer) and the Effects (grading, grain, vignette, and halation on two of them), with no LUT, so
they work on RAW and JPEG files alike and the Amount scales every part of them. They are named after birds; hover a
picture in the strip for what the look does. They cannot be renamed or deleted, and applying one replaces the photo's
own Curve and Color settings (like any look that holds those sections), so apply a look first and fine-tune after.

| Look | Starts at | What it is |
| --- | --- | --- |
| Oriole | 80 % | Warm negative. Golden highlights over soft, slightly lifted shadows, with gentle contrast and calm greens. |
| Heron | 80 % | Cool negative. Clean, slightly cyan shadows and blue-green foliage, with skin kept neutral. |
| Starling | 90 % | Chrome. Dense, muted color with deep blues and reds and firm contrast. |
| Kingfisher | 75 % | Slide. Vivid, saturated color with deep blues and punchy contrast. |
| Kestrel | 80 % | Cine print. Teal shadows and warm skin, a soft highlight roll-off and a glow around bright lights. |
| Rook | 100 % | Pushed black and white. Deep blacks, hard contrast, dark skies and coarse grain. |
| Magpie | 85 % | Bleach bypass. Silvery, desaturated color with hard contrast and cold shadows. |
| Dove | 80 % | Faded. Lifted blacks, softened whites and quiet, pastel color. |
| Sparrow | 85 % | Matte. A flat, lifted black with the midtone contrast kept and muted, earthy color. |
| Robin | 80 % | Portrait soft. Gentle contrast and warm, even skin, with quiet greens and reds. |
| Owl | 80 % | Night. Blue shadows, warm street lights that glow, deep contrast and visible grain. |
| Egret | 80 % | High key. Bright, airy midtones over open shadows, with clean whites and light color. |

The looks are data in `packages/shared/src/develop/looks.ts`; `photobook looks` (the publish CLI) lists them, and
`photobook looks --json` prints their settings. A photo records a built-in look as `builtin:<bird>`, and these ids never
change. For a side-by-side review, the editor's `/fixture` page has a **Looks** tab that renders every look on three
photos of the imported folders (by default `IMG_01.jpg` and `IMG_11.jpg` of `fixtures/lisbon-demo` and the synthetic
portrait `fixtures/portrait/portrait-01.jpg`, made by `scripts/make-portrait-fixture.py` and released as CC0) through
the real render, with a **Before** toggle. Without the window, `PHOTOBOOK_LOOKS_OUT=<dir> cargo test -p
photobook-develop --test effects -- --ignored look_review` writes the same set as `<look>-<photo>.jpg`.

### Look (LUTs)

The LUT picker (**LUT**, inside the Looks section) applies a 3D LUT you bring: **Import…** takes a `.cube` file (Adobe or
Resolve, 2 to 129 points per side, `DOMAIN_MIN` / `DOMAIN_MAX` honoured) or a HALD CLUT `.png`, which is converted
to `.cube` on import. 1D LUTs are refused with a message. Imported LUTs are kept in the app's data folder
(`luts/<sha256>.cube`, stored in a normalised form and named by its SHA-256, so the same LUT imported twice, as a
Windows copy or as a HALD under another name is kept once, with a small `.json` beside it holding the name), so they
follow you between books; the menu lists them, **Strength** (default 100 %) blends the LUT with the picture it gets,
and **Delete LUT file…** removes one from this Mac.

The LUT works on the finished picture: after the tone curve and the colour sliders, before colour grading and grain,
on the display values (the output's primaries with the sRGB transfer curve), with tetrahedral interpolation on both
the CPU and the GPU. A photo with a LUT and no Effects stays on the GPU.

A photo remembers its LUT by that hash and its name. When the file is not on this machine (another computer, or you
deleted it, or the stored file is damaged) the section shows **LUT missing: name** with **Locate…** (import the file again; a different file takes
its place and keeps the strength). Until then previews and cached renders leave the LUT out (the dev log says
`LUT missing`), and Publish and Export stop before rendering with one message listing the photos and their LUTs (a full render
stops with that message too) rather than writing a picture
without its look. The render key still includes the LUT's id, so a photo with a LUT never shares a render with the
same photo without one.

#### Match camera JPEG

If your camera saves a JPEG next to each RAW (RAW + JPEG mode), Photobook can learn the camera's picture style from
those pairs and make it a look: a Fujifilm film simulation, or another brand's picture profile. Click **Match camera
JPEG…** in the Looks section's ⋯ menu. The dialog lists the RAW files of the photo's folder that have a JPEG of the same name in
the same place (`DSCF0001.RAF` with `DSCF0001.JPG`) and ticks up to eight pairs near this photo that share its film
simulation (the tags are read only for those, and for any pair you tick). A pair whose RAW records a film simulation
but whose JPEG does not is greyed out as a likely edited export: only the camera's own JPEG teaches its style. Pick pairs shot with one style, in varied light and colour (a fit only knows
the colours it has seen; the rest of the colour space is filled in smoothly), give the look a name (the simulation's,
by default) and click **Fit look**. The fit runs as a job in the render queue (the status bar shows it and can cancel
it, and it carries on if you close the dialog); it takes a few seconds per pair. It works on the CPU, but the queue
has no CPU-only lane, so renders and denoising wait while it runs.

How it works: each RAW is developed with neutral settings (the defaults, without sharpening) at 1200 px and lined up
with its JPEG (a scale and offset search, then a small offset per tile, so the camera's lens corrections do not get in
the way). A JPEG that does not line up (another shot, cropped or turned in camera) is left out with a reason. Pixels
from flat areas of every pair then go into one least-squares fit of a 33³ LUT with a smoothness term. The result is
an ordinary LUT in the app's data folder, plus a look that applies it (`Classic Chrome (fitted)`, in the Looks strip).
The dialog shows each pair's mean colour difference (CIE76 ΔE; under 2 is hard to see), how much of the colour cube
the pairs covered, and **Apply to this photo**. Asking for the same fit again does not add a second look: a look
already using that LUT is kept, and one with the same name is replaced.
Because the LUT maps what the default develop produces to what the camera wrote, it matches best on photos developed
close to the defaults, with sRGB output (with Display P3 output it is applied to P3 values, so colours shift a
little). The fit compares in sRGB: a camera set to Adobe RGB writes JPEGs with colours beyond sRGB, which are clipped
to sRGB before the comparison, so the most saturated colours of such a look come out muted; set the camera to sRGB
for the pairs you fit from.

For a photo whose file records a film simulation (Fujifilm RAF or JPEG), the Looks section suggests the fitted look
with the same tag: **Suggested: Classic Chrome (fitted)** with **Apply**.

### Effects

Four groups, each with its own **Reset** (the section's **Reset** clears all four). In Basic each group shows its
wheels (grading) or its amount; the rest is under the group's ▸. Every control at its default changes nothing, so a
photo you have not touched here renders and publishes exactly as before.

- **Color grading**: three wheels, **Shadows**, **Midtones** and **Highlights**. Drag the dot: its angle is the hue (0
  red at the right, 120 green, 240 blue, counter-clockwise), its distance from the centre the saturation. Hold Shift
  to keep the hue (only the saturation moves), Alt to keep the saturation; double-click resets the wheel; the arrow
  keys nudge a focused wheel (Left / Right the hue, Up / Down the saturation, Shift ten times). The hue and saturation
  numbers under each wheel can be typed. **Harmony lock** above the wheels ties the wheels' hues: *Monochromatic* (one
  hue), *Complementary* (shadows opposite the highlights, midtones free), *Split complementary*, *Triadic* (120°
  apart), *Tetradic* (90°) or *Analogous* (±30°); dragging one wheel turns the tied ones with it, the tied angles show
  as thin spokes on each ring, and a dragged dot snaps (with a haptic tick) onto the hue of a wheel that stays put.
  With the lock on *Free*, a dragged dot snaps (with a tick, within 4°) to the harmonic angles from every other wheel
  that has a tint (saturation above 0, the Global wheel too): opposite (180°), ±120°, ±90° and ±30°; with no other
  wheel tinted it never snaps. Hold Shift to keep the hue (no snapping). Choosing a lock turns the tied wheels onto
  its angles around the most saturated one. The lock only decides what a drag writes: it is saved with the photo but
  never changes the picture or its render key. The **preset chips** under the wheels (*Teal & orange*, *Warm/cool
  split*, *Bleach*, *Golden*, *Moody blue*, *Pastel*) set the three wheels, Blending and Balance. Under **Luminance,
  global wheel** (Advanced): a **luminance** slider per wheel (−100 to +100) lightens or darkens that tonal range, and
  the smaller **Global** wheel tints and lifts every tone. **Blending** (how much the three ranges overlap, default
  50) and **Balance** (positive gives the highlights more of the tonal range) are under their own ▸. Teal shadows and
  warm highlights is the classic split tone. Grading works on the finished picture, after the tone curve; without a
  luminance offset it keeps lightness; black and white stay neutral.
- **Vignette**: **Amount** darkens (negative) or lightens (positive) the corners of the cropped picture by up to two
  stops; **Midpoint** moves the falloff towards the corners, **Feather** softens it, **Roundness** goes from a rounded
  rectangle (−100) through an ellipse that follows the frame (0) to a circle (+100).
- **Halation**: the warm red glow film gives highlights. **Threshold** (default 75) sets how bright a part must be to
  glow; **Radius** how far the glow spreads. It follows exposure and white balance, not the other tone sliders.
  Halation and the vignette work on the light before the RAW tone curve is applied, so on a RAW photo the same
  Threshold picks out a different brightness than on a JPEG.
- **Grain**: **Amount**, **Size** and **Roughness** (more fine grain). Grain is measured against the frame (as if the
  long edge were 2048 px): the preview and the full-size export sample the same grain field at their own sizes, so
  it looks the same relative to the picture (not pixel for pixel); it is strongest in the
  midtones and leaves pure black and white clean.

The GPU draws all four effects, so they keep slider changes on the preview as quick as the other sections (about
4 ms for a 1600 px preview with every effect on, against about 3 ms without them). Lightroom import does not read
Lightroom's grain, vignette or colour grading.

### Masks

Press **M** (or open the section) to edit part of a photo. **Create new mask** offers:

| Tool | How to use it |
| --- | --- |
| **Brush** | Drag to paint. **Erase**, or Alt while painting, subtracts. **Size**, **Feather**, **Flow**. `[` and `]` change the size, Shift with them the feather. |
| **Linear gradient** | Drag from where the effect starts to where it is full; drag the handles to adjust. |
| **Radial gradient** | Drag out from the centre (Shift for a circle); drag the handles to resize or rotate. **Feather** slider. |
| **Luminance range** | Click the photo to pick a tone (Shift-click extends the range); **Smoothness** softens the edges. |
| **Color range** | Click the photo to pick a colour (Shift-click adds another); **Refine** sets the tolerance. |
| **Subject**, **Sky**, **Background**, **People**, **Depth range** | AI masks, below. |

A mask can hold several components. **Add**, **Subtract** and **Intersect** start a new component; each component
has its own invert and delete. Then **Invert mask**, **Mask feather** and **Amount** (opacity) apply to the mask as a
whole. **Adjustments** are the local sliders: Temperature, Tint, Exposure, Contrast, Highlights, Shadows, Whites,
Blacks, Texture, Clarity, Dehaze, Hue, Saturation, Sharpness and Noise. **Noise** reduces noise inside the mask
without the AI model: it removes colour noise with the same colour filter as Denoise's **Filter** and smooths
luminance noise more gently, live as you drag. **Show overlay** (O) tints the selected mask red. Mask rows can be renamed (double-click), switched
off with their checkbox, **Duplicate**d or deleted with **Delete mask**. Escape ends the active tool; Delete removes
the selected component.

**AI masks.**

- **First use.** The first Subject, Sky, Background, People or Depth range mask opens "Download the models for Subject" (or Sky, People, ...),
  listing each model with its size and licence and the total. **Download** fetches them (checked against a pinned
  checksum) and then runs the mask. **Cancel** keeps a partial download for next time.
- **Running.** A status row shows the stage (loading model, running, refining) with **Cancel**. Loading a model the
  first time in a session takes a while; Subject and Background then take about 6 seconds, the others a second or less.
- **Refine.** Subject, Background and People masks have a **Refine** button: click the photo to add to the mask,
  Alt-click to remove, drag a box around what you want; Delete takes the last click back.
- **People.** When several people are found, "Found N people" offers **All people** (one component) or
  **One per person** (a component each, named Person 1, Person 2, ...) so one person can be edited alone.
- **Depth range.** A two-handled **Depth range** slider from near to far; moving it does not run the model again.
- **Regenerate.** The generated mask pictures live in the app's cache, not in the project file. If a mask says
  "Mask not generated on this computer" (you opened the book on another machine, or cleared the cache), or "A newer
  model version is available", press **Regenerate**.

AI masks follow the picture through crop, straighten, Upright, rotate and flip without regenerating.

## Crop and straighten

Press **R** (or **Crop**) to open the crop tool; the panel is titled **Crop & Straighten**.

- **Aspect**: **Original**, **Free**, 1:1, 4:5, 5:7, 2:3, 16:9 or **Custom** (type a width and height). The **Locked**
  toggle keeps the current ratio while you drag. **Swap** (X) turns portrait into landscape.
- **Angle** (-45 to 45 degrees) with **Auto** (levels the photo along its straight lines) and the **Straighten tool**
  (drag along a line that should be level or plumb; holding Cmd while dragging does the same).
- **Orientation**: rotate left, rotate right, flip horizontal, flip vertical.
- **Constrain to image** keeps the crop inside the picture when you straighten.
- **Overlay** (O) cycles the composition guides: Thirds, Grid, Diagonal, Golden ratio, Off.
- **Reset** clears the crop, angle, rotation and flips (Upright and the Transform stay).
- **Done** (Return, or R again) applies the crop; **Cancel** (Esc) discards everything since the tool opened.
  Stepping to another photo applies.

The crop is stored as fractions of the picture, so it stays valid whatever size the photo is rendered at.

## Compare, copy, presets and sync

- **Before / After** is a split button. A click (or \\) shows the original (the flip); its **▾** offers **Flip**,
  **Split** (the original left of a line you drag; not with a crop, a rotation or a transform, which the original
  would not line up with) and **Side by side** (the original left, the edit right, at the same zoom and point: click
  to zoom both to 100 %, drag to pan both). **Y** cycles side by side, split, flip and off. None of them is an edit.
- **Proof** (S) previews the edit in the other output colour space
  (sRGB or Display P3) to compare. It does not change the book's setting ([Output colour](#output-colour)).
- **Copy** and **Paste**: see [Copy and paste settings](#copy-and-paste-settings) below.
- **Presets** is a menu: the built-in **Black & white** and **Faded**, your own presets, **Save current as preset…**
  (name it and tick which of Light, White balance, Curve, Color, Detail, Effects and Look to keep) and **Export settings as XMP
  sidecar…**. Your presets are stored in the app's data folder, so they follow you between books.
- **Sync…** applies this photo's settings, or a preset, to other photos: choose the sections (Basic, Curve, Color,
  Detail, Effects, Look are on by default; Transform and Upright, and Masks, are off and can be added), tick photos in the grid
  (Select all, Select none, Shift-click for a range) and press **Sync to N photos** (**Apply preset to N photos** for a preset). The crop, rotation and flips are
  never synced. It is one undo step.

## Copy and paste settings

- **Copy** (Cmd+Shift+C) copies the photo's settings, the sections you chose last time. **Copy…** (Shift+Cmd+Alt+C)
  opens **Copy Settings** to choose them: Basic (light and white balance), Curve, Color, Detail (texture, clarity,
  dehaze, sharpening), AI denoise, Effects, Look (LUT), Crop and straighten, Transform and Upright, and Masks, with **Check all** and
  **Check none**. Everything but the crop, Transform and masks is on until you change it; with **Remember this choice**
  on, Cmd+Shift+C copies your choice from then on (kept on this computer). Rotation and flips are never copied.
- **Paste** (Cmd+Shift+V) pastes onto the photos selected in the strip, or onto the photo shown when none is; the
  panel's **Paste** button pastes onto the photo shown, and **Paste to selected** in the batch bar onto the selection.
  Only the copied sections change, and the photo you copied from is left as it is when it is in the selection. One
  paste is one undo step, however many photos it changes; pasting the same thing again changes nothing.
- **Paste from previous** (Cmd+Alt+V) takes the remembered sections from the photo just before this one in the strip
  (as sorted) and pastes them, without touching the clipboard: Lightroom's habit for a burst.
- **Cull** has the same keys on the grid (copy from the focused photo, paste onto the selection or the focused photo,
  paste from the photo before the focused one) and a right-click menu with **Copy settings**, **Copy settings…**,
  **Paste settings** and **Reset edits** for the selection (Reset asks first above five photos). Cull pastes need no
  trip to Develop.
- Masks paste at the same positions on the other photo (Copy Settings says so when Masks is ticked); AI masks are
  worked out again for the new photo when it is shown or rendered. A pasted crop is fitted to the other photo as the
  crop tool would fit it: its aspect lock (3:2, Original, …) is kept in that photo's frame and, with Constrain on, the
  straightened rectangle stays inside the picture.
- The copy goes on the system clipboard as text (JSON marked `application/x-photobook-develop`), so it survives quitting
  the app and works across projects; other text on the clipboard is ignored, and copying something else in another app
  replaces it after a restart. Inside one session the last copy is kept even if the system clipboard changes. Settings
  copied by another version of Photobook that this one cannot read, or too large to paste (more than 100 masks or
  100,000 brush points), are refused with a message in the batch bar (Develop) or under the grid (Cull).

## Selecting photos and the batch bar

The strip under the picture shows the photos Develop steps through and which of them are selected (a check; the
selection is the one Cull made, kept to the photos listed). **Click** a thumbnail to show it; **Cmd-click** adds or
removes it from the selection and **Shift-click** selects the range from the last Cmd-click (or from the photo shown),
both without changing the photo you are editing.

The **batch bar** above the strip acts on the selection. Its first action is **Apply to all ▾**:

- **Apply Light & Color to all n**: the photo shown's Light and Color cards (light, curve, white balance, color mix)
  onto the selected photos, in one click.
- **Apply these sections…** opens Sync with those photos ticked.
- **Apply look to all n** gives them the photo shown's look at its Amount.

With nothing selected the bar stays up and reads "Select photos in the strip to apply to several", and **Apply to
all in the strip ▾** does the same for every other photo the strip shows. Then:

- **Sync selected…** opens Sync (above) from the photo shown, with the selected photos already ticked.
- **Reset edits** puts every selected photo back to the original (all of its edit: crop and masks too). When it would
  reset more than five photos it asks first. It is one undo step.
- **Paste to selected** pastes the copied settings onto the selection ([above](#copy-and-paste-settings)).
- **Export…** opens the Export dialog on the selection, or on the photo shown when nothing is selected
  ([Export](#export)).
- **Denoise selected…** queues a background denoise of each selected photo after a confirm (see
  [Denoise (batch)](#detail)).
- **Apply look…** opens a small dialog: pick a look (or None) and an Amount, and **Apply to n photos** switches the
  selection (or the photo shown when nothing is selected) to that look. It is one undo step.

**Clear** empties the selection. Every batch action is one undo step for all the photos it changes.

## Versions

A version is a second edit of the same photo, a virtual copy: the B&W for the zine and the colour for the carousel,
from one file. Versions live in the photo's library entry next to its master edit, so they need no extra files and
every project on the folder can use them.

The **Versions** row under the Develop header lists **Master**, then each version (`v2`, `v3`, … unless renamed).

- **Click a chip** to show that version; every edit then goes to it (undo works as usual). Stepping to another photo
  or closing Develop goes back to the photo's own version.
- **Make a version** copies the settings shown into a new version and shows it. Inside a project the project starts
  using it at once; other projects keep what they had.
- **Use in this project** (inside a project, when the version shown is not the one the project uses) makes the project
  render that version on its pages and when it publishes. A dot marks the version the project uses, and the filmstrip
  and the strip show its name on the thumbnail.
- **Rename** (or double-click the chip) and **Delete**. Delete is refused while any project uses the version, and
  names those projects.

The master is what the library stages and every project without a choice show. Making, renaming, deleting and
choosing a version are not undo steps; editing one is. Renders are named after the settings' develop hash, so a
master and its versions never overwrite each other's cached renders, and publishing renders the version each project
uses.

## Lightroom settings

**Import Lightroom settings…** (Cmd+Shift+I in Develop; also in the inspector's photo section and above the
filmstrip, for the photos listed there) reads the `.xmp` sidecar next to the photo (`name.xmp`, or `name.ext.xmp`), or
the settings embedded in a JPEG, and shows a table of what would change (setting, now, imported) before you
apply it. It lists what was **Not imported** and what was **Imported, but unverified**. Imported: light, white
balance, curves, colour mix, texture, clarity, dehaze, sharpening, crop and angle, Upright and the Transform sliders.
Not imported: Lightroom's masks and local corrections, Lightroom's denoise (the AI denoise here is separate), spot
removal, grain, vignettes, lens profiles, colour grading, calibration, and pre-2012 sliders. The import matches
Lightroom's slider values, not its pixels. A sidecar from a JPEG Lightroom exported (its edits are already in the
pixels) is skipped.

**Export settings as XMP sidecar…** writes a sidecar next to the photo, merged into an existing one (the old one is
kept as `.bak`). Two formats:

- **Photobook (lossless)**: every setting, masks included, in Photobook's own namespace. Lightroom ignores it;
  Photobook reads it back exactly.
- **Lightroom (crs, lossy)**: slider values in Lightroom's Camera Raw fields. **This is lossy**: Lightroom renders
  them with its own maths, so the photo will look different from the preview here, and masks, AI denoise and
  settings Lightroom has no counterpart for are not written. The dialog shows this warning before you export.

## Keys

| Key | Where | Action |
| --- | --- | --- |
| D | filmstrip, canvas, Review | Open Develop |
| Left, Right | Develop | Previous or next photo |
| Cmd-click, Shift-click | Develop strip | Add or remove a photo from the selection, select a range |
| Esc | Develop | Close (ends the current tool first) |
| Cmd+Z, Shift+Cmd+Z | Develop | Undo, redo |
| \\ | Develop | Before / After (the flip) |
| Y | Develop | Cycle Before / After: side by side, split, flip, off |
| S | Develop | Soft proof in the other output colour space |
| Cmd+Shift+C, Cmd+Shift+V | Develop, Cull grid | Copy settings (the remembered sections), paste onto the selection |
| Shift+Cmd+Alt+C | Develop, Cull grid | Copy Settings: choose the sections |
| Cmd+Alt+V | Develop, Cull grid | Paste from the previous photo |
| Cmd+Shift+E | Develop, Cull | Export: the photo shown in Develop; the selection (or the focused photo) in Cull |

Copy and paste keys go by the letter typed with Cmd+Shift (so they follow the keyboard layout), and by the key's
position with Alt held (Alt changes the letter on a Mac: Alt+V types √), so Shift+Cmd+Alt+C and Cmd+Alt+V are the C and
V keys of a US layout.
| Cmd+Shift+I | Develop | Import Lightroom settings |
| R | Develop | Open or apply the crop tool |
| X, O, Return, Esc | crop tool | Swap orientation, cycle overlay, apply, cancel |
| M | Develop | Open the Masks section |
| O | Masks | Show or hide the mask overlay |
| `[`, `]`, Shift with them | brush | Brush size, feather |
| `[`, `]` | Develop (no brush tool) | Previous or next look in the Looks strip (None first) |
| Delete | Masks | Remove the selected component (undo the last Refine click while refining) |
| Alt + drag a Sharpening slider | Detail | Show the sharpening mask |

## Export

**Export** writes developed photos as new files, for a client, a lab or a feed; the original is never touched. Open
the dialog with **Cmd+Shift+E** (in Develop: the photo shown; in Cull: the selection, or the focused photo), with
**Export…** in the Develop batch bar or the Cull grid's right-click menu, or by right-clicking a folder or a
collection in the sidebar (every photo in it). It opens on the preset you used last.

**Presets.** Five are built in, and **Save as preset…** keeps your own (in the app's data folder,
`export-presets/`, one file each; **Update** and **Delete** for those). Preset names are unique (a taken name gets
` 2`), since a preset's name is its default folder:

| Preset | Size | Format | Metadata | Sharpen for screen |
| --- | --- | --- | --- | --- |
| Social | 2048 px long edge | JPEG 88, sRGB | Copyright and artist only | Low |
| Web | 1600 px long edge | JPEG 85, sRGB | None | Low |
| Full quality | the developed size | HEIC 10-bit 90, Display P3 on macOS; JPEG 95, sRGB elsewhere | All | Off |
| Original + sidecar | the source file as it is | the source's own, plus an XMP sidecar | the source's | n/a |
| Custom | the developed size | JPEG 90, sRGB | All | Off |

**Options.**

- **Format**: JPEG, PNG, WebP, AVIF, HEIC, TIFF or Original + sidecar ([Export formats](#export-formats) below). The
  lossy ones have a quality from 1 to 100, and picking one starts it at its own usual value (JPEG 90, WebP 85, AVIF
  70, HEIC 85) unless you had changed the quality by hand. PNG and TIFF are lossless.
- **Size**: the developed size (after the crop), or *Resize to fit* a long edge in pixels. A photo is never enlarged.
  The photo is developed at full resolution first, exactly as for publishing, then scaled down (Lanczos3).
- **Sharpen for screen**: Off, Low, Standard or High. The Detail panel's sharpening, run again on the final pixels
  with a radius in output pixels, to make up for the softening of the downscale.
- **Colour** (collapsed): sRGB, or Display P3, which keeps the saturated colours a camera RAW or an iPhone HEIC holds
  beyond sRGB. Display P3 is offered when a photo of the export is a RAW or a HEIC, or the book is set to Display P3
  (a JPEG with a wide profile of its own is not detected). The file is tagged with its profile. AVIF is always sRGB
  (picking it switches the colour to sRGB): its encoder cannot mark the picture as Display P3.
- **Metadata** (collapsed; JPEG, HEIC and TIFF): *All* copies the photo's Exif (camera, date, location; the orientation
  is reset since the pixels are upright), *Copyright and artist only*, or *None*. PNG, WebP and AVIF carry no Exif,
  only their colour profile. For a JPEG the Exif of a JPEG or HEIC source is copied as is; for a RAW or PNG it is
  rewritten from what can be read (TIFF-based RAW such as DNG, NEF, CR2 and ARW): camera, date, exposure, lens and
  GPS, without the maker note or the sensor layout. A HEIC gets the source's Exif, TIFF, GPS and IPTC as macOS reads
  them (RAW included). A TIFF gets the descriptive TIFF tags only (make, model, software, date, description, artist,
  copyright), not the exposure or GPS.
- **Watermark** (collapsed, off by default): one line of text in one of the book fonts (Inter, Fraunces, Instrument
  Serif, JetBrains Mono) and a colour, or a PNG with transparency (**Choose PNG…** copies it into the app's data
  folder, `watermarks/`, named by its content, so the preset keeps working if the original moves). Its size is a
  fraction of the photo's long edge (the text's em size, or the image's long edge), with an opacity, one of nine
  positions and a margin from the edges. It is drawn on the resized photo, after the sharpening, so its edges get no
  halo, and it never runs past the photo: a line too long for it is set smaller until it fits. The fonts are the
  Latin subsets the book uses, so Latin text, digits and © work, but other scripts (Cyrillic, Greek, CJK) draw as
  missing glyphs; letter pairs are not kerned. Export stays off while the watermark has no text or no image.
- **Border** (collapsed, off by default): a solid frame in pixels or in percent of the long edge, in a colour. With a
  long edge set, the photo is fitted to the long edge less both borders, so the file keeps the preset's size (a 2048 px
  Social export with a 2% border is still 2048 px wide); without one, the border is added around the developed size.
- **Destination**: by default next to each photo, in `<photo folder>/Exports/<preset name>/`. A folder's top-level
  `Exports` folder is never scanned, so exported files do not come back as photos of the folder. **Choose…** picks
  another folder. Photobook may write outside your imported folders only to a folder picked in the dialog since it
  started, so a remembered destination outside them asks to be picked again after a restart.
- **File names**: a pattern with the tokens `{name}` (the photo's file name), `{seq}` (its position in the export,
  `001`), `{date}` (`YYYY-MM-DD`, the file's date until camera dates are read) and `{rating}` (0 to 5). Characters a
  file name cannot hold become `_`, and two photos that would get the same name in one folder are numbered
  (`DSCF1001 2.jpg`).
- **Skip photos already exported with these settings**: a photo whose file is already at its destination, the same
  size as its cached export and written after it, is left alone.

The dialog's footer counts what will happen, e.g. *12 photos, 3 already exported (skipped), 2 from the cache*. An
earlier export of the same photo (another edit) is replaced without asking, but a file at the destination that is not
an export of that photo (another photo's `001.jpg` from an earlier run, an unrelated `IMG_0001.jpg`) is counted
(*1 existing file will be replaced*) and Export stays off until **Replace** is ticked; without it the app refuses to
overwrite the file.

**The export cache.** Each encoded file is kept in the photo folder's `.photobook-cache/export/<preset hash>/`, named
after the photo's content hash and develop hash, and the exported file is a copy of it. The preset hash covers only
what changes the file (format, quality, size, colour, metadata, sharpening, watermark, border; not the quality of a
PNG or TIFF, nor the metadata of a PNG, WebP or AVIF, which they ignore), and the app recomputes it from the options before writing, so exporting a folder again after
editing three of its photos encodes three files and copies the rest; renaming the preset, changing the file names or
choosing another destination encodes nothing. The three most recent edits of each photo are kept per preset hash.
The cache can be deleted at any time; it is rebuilt on the next export.

**Background work.** Each photo is one **export** job in the Jobs list (two run at a time), with its step and
Cancel; a cancelled photo leaves no file behind. Exporting the same photos to the same place again while the first
export runs joins its jobs instead of encoding twice. A photo whose denoise is on waits for its denoise job first, so
the file always has it. Each export gets a note at the bottom left saying what it did, with **Reveal in Finder**.

### Export formats

| Format | Bits | Colour | Metadata | Notes |
| --- | --- | --- | --- | --- |
| JPEG | 8 | ICC profile | Exif | 4:4:4 chroma from quality 95 |
| PNG | 8 | ICC profile (`iCCP`) | none | lossless |
| WebP | 8 | ICC profile (`ICCP`) | none | lossy; at most 16383 px a side |
| AVIF | 10-bit AV1 from the 8-bit render | sRGB only (in the AV1 header) | none | `ravif`; slow to encode: about 23 s for a 24 MP photo on an M-series Mac, against well under a second for JPEG |
| HEIC | 10-bit HEVC from a 16-bit render | ICC profile | Exif | macOS only (written by the system's ImageIO); hidden elsewhere |
| TIFF | 16 | ICC profile | descriptive TIFF tags | Deflate with the horizontal predictor; large files |
| Original + sidecar | the source's | the source's | the source's | see below |

HEIC and TIFF are developed into 16 bits per channel rather than 8, so they keep smooth gradients for further editing
or printing. That render always runs on the CPU (the GPU path writes 8 bits), so a 16-bit export of a large photo takes
a few seconds longer than a JPEG.

**Original + sidecar** hands a photo to another editor: it copies the source file byte for byte (a RAW stays a RAW)
into the destination and writes `<name>.xmp` next to it with the edit, in two parts: Photobook's own packet, which
Photobook reads back exactly when the copy is imported, and Lightroom's `crs:` fields (the tone, colour and crop
sliders, the same mapping as **Export settings as XMP sidecar…**, [Lightroom settings](#lightroom-settings)), which
Lightroom and Camera Raw read. Nothing is developed or cached; a copy already there with the same bytes and the same
sidecar is skipped. A sidecar already at the destination that is not this copy's own (yours, or another photo's) is
counted as a file to replace and needs **Replace**. Two photos of one export never share a name stem, since each gets
a `<stem>.xmp`: a RAW + JPEG pair `IMG_1.nef` and `IMG_1.jpg` export as `IMG_1.nef` and `IMG_1 2.jpg`.

## Publishing edited photos

Publishing needs no extra step on your side. Press **Publish** and the editor first runs **Denoising** for used
photos whose denoise is on but not applied, then **Render edited photos**, then starts the publish CLI.

- Each edited photo is rendered at full resolution to `.photobook-cache/develop/` inside the source (photo)
  folder, as `<content hash>-<develop hash>.jpg` (`...-p3.jpg` for a Display P3 book), and the CLI publishes that
  file instead of the original. The original is never touched; the download copy is the render too.
- The book's images, including the full-quality download copy, are made from the render.
- Camera RAW photos always publish as a JPEG render, with default settings if you never edited them.
- Re-editing a photo gives it a new render and new image URLs; **--prune** removes the old ones.
- If you run the CLI yourself and a render is missing, it stops before uploading anything with "N developed
  photo(s) have no rendered file yet ... Open the book in the editor and let it render the edited photos before
  publishing."
- The cache is inside the photo folder, so on a synced drive (iCloud, Dropbox) the renders sync with the photos
  and take space. They are safe to delete; the editor recreates them.

### Background work

Full-size renders, denoise runs and publishing are jobs in one queue. A pill in the bottom-right corner of the window
shows how many are queued or running; click it for the list, with a progress bar and **Cancel** for each one.

- Renders and denoise run one at a time (they share the GPU), and so does publishing; a job waits its turn as
  **Queued**. The queue keeps going when you switch photos or stages, or close the publish dialog.
- Publish queues the denoise and render jobs it needs and waits for them; the dialog says how many photos are
  still rendering or denoising. A denoise you already started with **Apply** is not run twice: publish waits for it.
- **Cancel** stops a job at its next step (between photos, between denoise tiles, or before a render is written).
  A cancelled job never leaves a half-written file: renders and denoise results are written under a temporary name
  and renamed when complete.
- A failed job stays in the list with its error until you dismiss it. Closing a project cancels its jobs and the
  pill says so.

### Output colour

**Output colour** in the book settings (inspector, nothing selected) chooses **sRGB** (the web standard) or
**Display P3** (richer colour on Apple displays and iPhones). Edited photos and RAW renders are rendered in it and
tagged with its profile. Switching it renders every edited photo once more. Details: [PUBLISHING.md](PUBLISHING.md#7-publish).

## AI models

No model ships with the app. **Settings → Models** lists each one with its task, download size and licence, and
**Download** (resumable), **Delete** and the folder they live in. A model is downloaded once, checked against a
pinned SHA-256 and stored in the app's data folder (`~/Library/Application Support/com.photobook.editor/models/` on
macOS). Every model has a permissive licence (MIT or Apache-2.0).

Under **Denoise** the same page holds the **Default model** that switching denoise on uses (the Denoise group's
switch and **Denoise selected…**; a photo can use another one under Denoise › Advanced) and the thresholds behind
the Needs denoise badge and collection (see [Detail](#detail)).

| Used for | Model | Size | Licence |
| --- | --- | --- | --- |
| Subject, Background | BiRefNet lite | 114.5 MB | MIT |
| Sky | SkyWater-Seg | 49.9 MB | MIT |
| People | RT-DETR v2 R50 (finds people) + SAM 2.1 tiny | 86.5 MB + 88.5 MB | Apache-2.0 |
| Refine (click and box) | SAM 2.1 tiny encoder and decoder | 88.5 MB | Apache-2.0 |
| Depth range | Depth Anything V2 Small | 49.6 MB | Apache-2.0 |
| Denoise (recommended) | NAFNet SIDD width32 | 117.1 MB | MIT |
| Denoise (slow) | SCUNet real PSNR | 76.9 MB | Apache-2.0 |
| Fast subject (listed, not used by any tool yet) | U2-Netp | 4.6 MB | Apache-2.0 |

Downloads come from Hugging Face, except NAFNet, which comes from a storage bucket of the ailia model collection
(`storage.googleapis.com`); the pinned list with URLs and checksums is `crates/develop/models.toml`. Deleting a model
also removes its compiled Core ML cache.

## Performance

- **GPU by default.** Renders run on the GPU (Metal on macOS) with the CPU path as the reference and fallback. A slider
  change on the preview takes a few milliseconds; a 24 MP export about 0.4 s on Apple silicon (about 1.2 s on the CPU).
  The editor's dev log prints `[photobook:develop] gpu available: ...` or `gpu unavailable: <reason>`.
- **Force the CPU.** Start the editor with `PHOTOBOOK_FORCE_CPU=1` (any value but empty, `0` or `false`).
- **Crash flag.** If bringing the GPU up crashes the app, the next launch stays on the CPU. The flag is the file
  `gpu-crash-flag` in the app's cache folder (`~/Library/Caches/com.photobook.editor/` on macOS); delete it to try the
  GPU again.
- Images over 64 MP, or more than 16 active masks, render on the CPU. Effects and LUTs run on the GPU too; on the
  CPU a 24 MP export with Halation on takes about 0.1 s (the glow itself about 10 ms), with all four effects about
  0.5 s.
- **Engine version.** Renders are cached under a hash of the develop settings and the render engine's version, now
  `develop-engine/4` (plan 55: the grading wheels' luminance offsets and Global wheel; `/3` was the Effects, LUT and
  GPU work). Moving from `/3` re-renders every edited photo once: previews and thumbnails redraw, full renders are
  made again before the next publish, and an edited photo's published image key changes once (its pixels do not:
  settings without a luminance offset or a Global wheel render byte-identical to `/3`). An untouched JPEG or
  HEIC keeps its key, since it is published from the original; an untouched RAW, published through its render, gets a
  new key once like an edited photo.
- **RAW** decoding reads the whole sensor (0.2 to 1.3 s a photo); the filmstrip shows the camera's embedded JPEG
  until Photobook's own render exists, and the renders are cached.
- **AI** uses Core ML on Apple silicon where the model allows it. The first load of a model can take tens of seconds
  (Core ML compiles it and caches the result); after that Sky, Depth range and Refine take a fraction of a second and
  People a second or so.

## Limits and caveats

- **Not Lightroom.** The sliders follow Lightroom's meaning and ranges, but the maths is Photobook's own, so the same
  numbers do not give identical pixels. Lightroom import copies values, not looks, and some mappings are
  marked "unverified" in the import dialog.
- **Subject and Background are slow.** BiRefNet lite does not compile for Core ML, so it runs on the CPU:
  about 6 seconds a photo (more when the machine is busy). A 4.6 MB faster model (U2-Netp, about 0.2 s) is in the
  list but no mask tool uses it yet. The quality on fine detail such as hair has not been checked on portraits.
- **SCUNet is very slow.** CPU only, about 12 minutes for a 24 MP photo. NAFNet is the one to use.
- **RAW.** Supported through the `rawler` decoder (about 870 camera models). Not done: lens corrections (distortion,
  vignetting, aberration), camera colour profiles (DCP), highlight reconstruction, 4-colour and monochrome sensors,
  Apple's RAW engine (so RAW the decoder cannot read, and ProRAW, show an error). Without a DNG exposure tag a RAW is
  brightened by one stop as a starting point. Automatic Upright works on uncorrected pixels.
- **Upright** finds straight lines (buildings, rooms, horizons); scenes without them get no or a small correction.
- **Local Noise** is disabled; use the Denoise group for the whole photo.
- **The photo filters** `bw` and `fade` on a page element (older books) still work, but Develop's **Black & white**
  and **Faded** presets replace them.
- **Platforms.** Develop is built and tested on macOS (Apple silicon). Core ML and HEIC decoding through ImageIO are
  macOS only; elsewhere AI runs on the CPU and HEIC photos are not supported in Develop. Linux and Windows are untested.
- **Edit data and cache.** The settings live in the folder's library (`.photobook/library.json`, mirrored in the
  project file). Generated mask pictures, denoise results and noise measurements live in
  the app's cache (they can always be regenerated); the learned camera noise profiles live in the app's data folder. The renders in `.photobook-cache/` live in the photo folder.
