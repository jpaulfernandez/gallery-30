# Photobook layout guide (4:5 page)

Companion to the layout page. Reference size is an **8 × 10 in page (203 × 254 mm)**. Spacing is also given as a percentage of page width, so it scales to any 4:5 size (for example 16 × 20 in). Type sizes and word counts do **not** scale: people read every book at about the same distance.

Maximum: **6 photos per page.** Design most pages for 1 to 4.

---

## 1. Spacing and snap rules

### Tokens

| Token | 8 × 10 in | mm | % of page width | Used for |
|---|---|---|---|---|
| Bleed | 0.125 in | 3 | 1.56% | Full-bleed photos extend this far past the trim |
| Hard margin | 0.5 in | 13 | 6.25% | Faces and text never closer to the trim than this |
| Safe margin | 0.64 in | 16 | 8% | Default frame for every photo and all text |
| Binding allowance | +0.125 in | +3 | +1.56% | Added to the spine side on non-layflat books |
| Gutter | 0.2 in | 5 | 2.5% | Standard gap between photos |
| Wide gutter | 0.4 in | 10 | 5% | Two-photo pages that need more air |
| Caption offset | 0.12 in | 3 | 1.5% | Photo edge to its own caption |
| Caption clearance | 0.3 in | 8 | 3.75% | Caption to any photo it does not describe |

### Photo to photo

| Gap the user leaves | Snaps to | Why |
|---|---|---|
| Under 0.1 in (2.5 mm) | **0** (photos join into one block) | A hairline gap reads as a printing error |
| 0.1 to 0.3 in | **0.2 in** (gutter) | Keeps gaps identical across the page |
| 0.3 to 0.5 in | **0.4 in** (wide gutter) | |
| Over 0.5 in | Left as is | Treated as intentional white space |

Use one gutter value per page. Never mix 0.2 in and 0.4 in gaps on the same page.

### Photo to trim

| Distance from trim | Snaps to | Why |
|---|---|---|
| Under 0.25 in | **Bleed** (extend 0.125 in past trim) | Trimming can shift about 1/16 in, so a thin white sliver prints unevenly |
| 0.25 to 0.64 in | **0.64 in** (safe margin) | |
| Over 0.64 in | Left as is | |

A photo either bleeds or sits inside the safe margin. Nothing in between.

### Smart guides (editor)

Besides the rules above, the editor's snapping offers two guides that keep a page's rhythm without numbers:

- **Equal spacing**: a moved photo snaps to the spot where its gaps to two neighbours in the same row or column are
  equal (centred between them, or after or before a pair at the pair's own gap). The guide reads "equal".
- **Same size**: a resized photo snaps to a neighbour's width or height. The guide reads "same width" or "same
  height".

**Tidy** (alignment toolbar) and **Fix spacing** (after a drop that leaves a row's gaps uneven) give a row one gap,
put through the photo-to-photo rule above, so a page keeps a single gutter.

### Text

- Text always sits inside the 0.64 in safe margin and never in the bleed.
- A caption sits 0.12 in from its own photo and at least 0.3 in from any other photo, so it's obvious which photo it belongs to.
- Overlay text goes only on calm areas (sky, wall, shadow, sand), never over faces, and always with a soft dark gradient behind it.
- Maximum text width: 3.5 in for captions (about 50 characters per line), 5.25 in for story paragraphs (about 65 characters).

### Photo size and resolution

| Rule | Value |
|---|---|
| Smallest photo, short side | 1.5 in (2 in if it shows a group of faces) |
| Target resolution | 300 ppi |
| Warn below | 200 ppi |
| Block below | 150 ppi |
| Full-bleed page at 300 ppi | 2475 × 3075 px (8.25 × 10.25 in including bleed) |

---

## 2. Type sizes (8 × 10 in page)

| Role | Min | Default | Max | Line spacing |
|---|---|---|---|---|
| Caption | 8 pt | 9 pt | 10 pt | 135–140% |
| Overlay caption | 10 pt | 10 pt | 12 pt | 130% |
| Numbered key entry | 8 pt | 8.5 pt | 9 pt | 130% |
| Story paragraph | 9.5 pt | 10 pt | 11 pt | 140–150% |
| Page title | 14 pt | 18 pt | 24 pt | 115% |
| Quote | 16 pt | 20 pt | 26 pt | 125% |
| Chapter title | 28 pt | 36 pt | 48 pt | 105% |

- Nothing prints smaller than 8 pt.
- No more than three type sizes on one page.
- Overlay captions use the medium weight, never regular or light.

---

## 3. Word counts

| Text | Min | Sweet spot | Max | Character cap | Lines |
|---|---|---|---|---|---|
| Caption | 2 words | 6–14 | 20 | 120 | 2 |
| Overlay caption | 2 | 3–8 | 10 | 60 | 2 |
| Numbered key entry | 2 | 3–6 | 8 | 50 | 1 |
| Page title | 1 | 2–4 | 6 | 40 | 1 |
| Chapter title | 1 | 1–3 | 4 | 28 | 2 |
| Chapter subtitle or date line | 1 | 2–5 | 8 | 50 | 1 |
| Quote | 5 | 10–20 | 25 | 160 | 4 |
| Quote attribution | 1 | 1–3 | 4 | 30 | 1 |
| Story paragraph | 30 | 50–80 | 120 | 700 | — |

When text goes over the max, suggest switching to a layout with more room (a caption that runs long belongs on a Story page).

---

## 4. Type themes

Three themes only. The user picks one per book and it applies to every page. Each theme uses at most two families with locked weights. All fonts are on Google Fonts under the SIL Open Font License, so they can be embedded in printed books and PDFs.

| Theme | Titles and quotes | Captions and body | Feels like |
|---|---|---|---|
| **Editorial** (default) | Newsreader, Medium 500 and Italic | Instrument Sans, Regular 400 and Medium 500 | Magazine, travel, family year books |
| **Classic** | Cormorant Garamond, SemiBold 600 and Italic | Source Sans 3, Regular 400 and SemiBold 600 | Weddings, anniversaries, heirloom albums |
| **Minimal** | Hanken Grotesk, Medium 500 and Italic | Hanken Grotesk, Regular 400 | Modern, gallery-like, everyday books |

- Captions and body text are always in the sans-serif family.
- Cormorant Garamond is only for text 18 pt and larger; it's too delicate below that.
- Quotes use the italic of the title family.
- Captions in 85% black on white pages, white on overlays.
- No uploaded fonts, scripts or handwriting fonts. Keeping the set closed is what keeps every book looking designed.

---

## 5. Pacing

- Follow any 5- or 6-photo page with a 1- or 2-photo page.
- Plan 8 to 12 single-photo pages per book for the true hero shots.
- On right-hand pages, use the mirrored layouts (Tall right + two, Column + tall hero) so the hero sits on the outer edge.
- Reuse layouts, but scatter them through the book rather than repeating them back to back.
- Pick one home for captions (below-left of the photo or in the outer margin) and keep it for the whole book.

---

## 6. When to use each layout

### 1 photo

| Layout | Use it when | Best photo shape |
|---|---|---|
| Full bleed | It's the strongest photo and sharp enough to print at full size. Chapter openers. | Any, cropped to 4:5 |
| Gallery mat | A portrait deserves a frame. Calm, premium books. | Portrait 4:5 |
| Tall 2:3 on white | You don't want to crop a camera portrait. | Portrait 2:3 |
| Landscape on white | You don't want to crop a horizontal photo. | Landscape 4:3 |
| Square crop | The photo is already square. | Square |
| Offset high | You want a modern, asymmetric page. Good facing a busy page. | Portrait |
| Bleed top, white foot | You want impact plus a quiet strip for a page number or later caption. | Portrait or square |
| Bleed bottom, white sky | The subject is anchored to the ground: beaches, fields, buildings. | Landscape-leaning |
| Bleed side | The subject is tall: a standing person, a tower, a tree. | Tall portrait |
| Panorama band | It's a phone panorama or a very wide crop. | 2:1 to 3:1 |
| Quiet vignette | It's a small detail (a ticket, a ring, a dish) or the reader needs a pause. | Square or detail |

**With captions**

| Layout | Use it when |
|---|---|
| Caption below | Default for a single captioned photo. |
| Side caption | A portrait needs a caption but shouldn't lose height. |
| Title above | The photo is about a named place or event. |
| Overlay on full bleed | The bottom of the photo is calm (sky, sand, shadow). Never over faces. |
| Bleed + footer line | You only need a date and place. |
| Bleed side + text column | A portrait comes with one or two sentences of story. |
| Story page | The words matter as much as the photo: letters, milestones, travel notes. |
| Panorama + paragraph | A wide view comes with a short travel note. |
| Chapter opener | A new chapter, day or month starts. |
| Quote page | Someone said something worth keeping: speeches, toasts, kids' sayings. |

### 2 photos

| Layout | Use it when | Best photo shape |
|---|---|---|
| Stacked pair | Two landscapes carry equal weight. | 2 landscape |
| Side-by-side portraits | Two verticals carry equal weight: before and after, two people. | 2 portrait |
| Wide-gap pair | The same, but in a calmer book with lots of white space. | 2 portrait |
| Hero + detail | You have a wide shot and a close-up from the same moment. | 1 landscape + 1 any |
| Portrait over landscape | Phone photos come in mixed orientations. | 1 portrait + 1 landscape |
| Staggered pair | You want an editorial page with movement. | 2 portrait |
| Diagonal squares | Two square photos, playful mood. | 2 square |
| Small pair, lots of air | Two small details, or a breather page. | 2 square or detail |
| Hero with postcard | A scene plus a keepsake: a ticket, a sign, a menu. | 1 landscape + 1 small |
| Two tall columns | Vertical phone shots or stories. | 2 tall portrait |
| Split bleed | Then and now, two places, bold contrast. | 2 landscape |

**With captions**

| Layout | Use it when |
|---|---|
| Pair + shared caption | Both photos tell one story in one sentence. |
| Captions beside each | Each photo needs its own line. |
| Hero + detail, caption in the gap | You want a title and caption in the white corner. |
| Staggered with captions | An editorial pair where each photo gets its own caption. |
| Split bleed + overlay labels | Short labels like "Then / Now" or two years, over calm areas only. |

### 3 photos

| Layout | Use it when | Best photo shape |
|---|---|---|
| Hero over two | You need the default story page. Works for almost any event. | 1 landscape + 2 any |
| Two over hero | The page builds up to a payoff: getting ready, then the moment. | 2 any + 1 landscape |
| Tall left + two | A portrait hero with two landscapes on a left-hand page. | 1 portrait + 2 landscape |
| Tall right + two | The same on a right-hand page. | 1 portrait + 2 landscape |
| Two-thirds hero | The hero is close to square. | 1 square + 2 any |
| Three strips | Three wide crops tell a sequence. | 3 landscape |
| Triptych band | Three portraits, calm page. | 3 portrait |
| Cascade | Kids, pets, motion, anything playful. | 3 square |
| Bleed column + two | A tall hero needs impact. | 1 tall portrait + 2 any |
| Bleed hero + pair | Travel: the view, then two moments. | 1 landscape + 2 any |

**With captions**

| Layout | Use it when |
|---|---|
| Journal rows | Diary style: every photo gets a line. |
| Hero over two + caption | The default page needs one line of context. |
| Triptych with heading | Three portraits share a title: three generations, the bridesmaids. |
| Three + text cell | A short story belongs inside the grid. |
| Bleed hero, overlay title | A chapter-like page with the title on the photo. |

### 4 photos

| Layout | Use it when | Best photo shape |
|---|---|---|
| Classic quad | Four moments carry equal weight. | 4 any |
| Small quad, lots of air | Four details on a calm page. | 4 portrait or square |
| Hero + strip of three | A group shot above, candids below. | 1 landscape + 3 any |
| Strip of three + hero | Details first, the big moment below. | 3 any + 1 landscape |
| Tall hero + column | A portrait hero with three details on a left-hand page. | 1 portrait + 3 landscape |
| Column + tall hero | The same on a right-hand page. | 3 landscape + 1 portrait |
| Pinwheel | A playful page where the white center gives breathing room. | Mixed |
| Offset pairs | You have a mix of wide and narrow crops. | 2 landscape + 2 portrait |
| Four strips | Four wide crops in a cinematic sequence. | 4 landscape |
| Bleed hero + three | A view plus three moments from the same day. | 1 landscape + 3 portrait |
| Edge-to-edge quad | Bold colors and single subjects. Avoid when faces are near the edges. | 4 any |

**With captions**

| Layout | Use it when |
|---|---|
| Caption under each | Each of the four photos needs its own line. |
| Quad + caption strip | One line covers the whole page. |
| Four + text cell | A short story belongs inside the grid. |
| Titled hero + strip | An event page needs a heading. |
| Quad + numbered key | Every photo needs a caption without clutter. |

### 5 photos

| Layout | Use it when | Best photo shape |
|---|---|---|
| Hero over four | An event: the moment plus reactions. | 1 landscape + 4 any |
| 2-1-2 sandwich | A wide centerpiece framed by pairs. | 1 landscape + 4 any |
| Tall + four | A full-length portrait with four details. | 1 tall portrait + 4 landscape |
| Two over three | Two lead photos above supporting shots. | 2 landscape + 3 portrait |
| Z-flow | The page should read like a sentence: lead, details, second lead. | 2 large + 3 any |

**With captions**

| Layout | Use it when |
|---|---|
| Hero over four + caption | An event page needs one line of context. |
| Five + text cell | The story fits in the corner of an L-wrap. |
| Five + numbered key | Names and places for every photo. |

### 6 photos

| Layout | Use it when | Best photo shape |
|---|---|---|
| Six grid | A month, a day in the life, a menu. | 6 landscape |
| L-wrap | A hero wrapped by five candids. | 1 square + 5 any |
| Brick | Mixed wide and narrow crops with rhythm. | Mixed |
| Hero, two, three | A pyramid: one lead, then smaller beats. | 1 landscape + 5 any |
| Masonry | Phone photos in mixed orientations. | Mixed |

**With captions**

| Layout | Use it when |
|---|---|
| Six grid + numbered key | A recap where each photo needs a caption. |
| L-wrap + caption | A busy page with one line of context. |
| Six with header | A titled recap: a month, a trip day, a menu. |
