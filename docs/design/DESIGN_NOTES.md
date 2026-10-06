# Photobook Design Notes

Oct 5, 2026. Visual direction for the editor and phone preview, drawn from the Mobbin references in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) plus a few more pulled while building phase 1. Keep this open while building UI.

## Editor shell (three panels + page strip)

Reference screens:

- [Magnific editor](https://mobbin.com/screens/34a51d49-e479-4327-b912-36f2e7ceb2f2): the layout. Assets left, canvas center, inspector right, numbered page strip bottom.
- [Klaviyo editor](https://mobbin.com/screens/00d9cdde-80c9-4acf-b097-9271262da1e8): a light inspector with titled sections (Image, Alt text, Image layout), small labeled fields, a floating vertical toolbar that sits beside the selected element (duplicate, favorite, AI, crop, delete), a Desktop / Mobile segmented toggle above the canvas, and a top bar with Preview and Exit on the right.
- [Shopify image editor](https://mobbin.com/screens/5ec9f2d9-dd23-4551-897a-653b312f0256): dark near-black canvas with a faint dot grid, photo centered with breathing room, a right column of stacked collapsible panels (Crop and transform, Resize, Draw, Color background). Save and Discard top-right.
- [Telegram web editor](https://mobbin.com/screens/27f12475-04e5-47ec-8029-bab2d008302d): dark inspector with a color picker, alignment segmented control, size slider, and a scrollable font list where each name renders in its own face.
- [Flodesk layout picker](https://mobbin.com/screens/bd2437c0-d777-4c6d-b31b-300d135ccd60): Undo, Redo and a quiet "Saved" label in the bottom-right.
- [Obvious select layout](https://mobbin.com/screens/3bdd7dc4-c938-4014-a7de-87c805cf9057): wireframe layout thumbnails with names in a grid.

Decisions:

- **Theme**: dark chrome. Canvas background `#1a1a1a` with a subtle dot grid; panels `#222` to `#262626`; borders `#333`; text `#e5e5e5` primary, `#8a8a8a` secondary. The page itself is white (or its background color) so it reads like paper on a desk. Accent `#4f8cff` for selection and focus.
- **Shell grid**: left filmstrip 280 px, right inspector 300 px, bottom page strip 120 px, top bar 44 px. Center canvas fills the rest. Panels have 1 px borders, no shadows.
- **Top bar**: book title (click to rename) left; center a segmented control `Edit | Preview`; right: Undo, Redo, Save status ("Saved" / "Saving…" in secondary text), and a disabled Publish button (phase 2).
- **Filmstrip**: search field pinned at top, sort select beside it, 3-column grid of square thumbnails with 4 px gap, used photos get a small check badge bottom-right and a dimmed overlay. Hashing progress is a 2 px bar under the search field with a count.
- **Canvas**: page centered with fit-to-window, zoom slider bottom-right of the canvas (25% to 400%). Selection is a 2 px accent outline with four corner handles for photo slots. A small floating toolbar appears beside the selection (rotate, replace, remove, open original) like Klaviyo's.
- **Inspector**: titled sections with 12 px uppercase labels. No selection: Page section (background color, layout button that opens the picker, notes textarea). Photo selected: Slot ratio segmented control, Zoom slider, Rotate button, Filter select. Text selected: Preset, Family, Size, Weight, Align, Color, Pill toggle.
- **Page strip**: horizontal scroll of page thumbnails (shared `<Page>` at ~90 px height) with the page number above each, current page outlined in accent, a `+` tile at the end. Drag to reorder.
- **Layout picker**: modal grid of wireframe tiles grouped by photo count (1 to 6), each tile drawn with the layout's frames as gray boxes on a white page, name under it, hover lifts it.

## Phone preview

Reference screens:

- [Polarsteps Travel Books](https://mobbin.com/screens/dacbba04-e74b-4b8e-9397-e439473dff48): book inside a phone, a "5-6/14" counter, prev / next.
- [Givingli card preview](https://mobbin.com/screens/4410f33e-72d0-403a-b9d9-9b6abfc320af): a single page centered on a dark textured background with a small pill "2 of 2" counter under it.
- [Fresha gallery](https://mobbin.com/screens/7a57d715-5406-4cdd-82f7-b0ac1fe69d36): "1/149" counter at the top of a full-bleed photo viewer.

Decisions:

- **Stage**: `#0d0d0d` background. iPhone frame 393 × 852 CSS px with a 47 px radius, 12 px black bezel, no notch drawn (keep it simple). A `Phone | Desktop` toggle at the top-left switches to a 1200 px wide container so the 900 px breakpoint is visible.
- **Reader**: horizontal scroll-snap track, one page per viewport, 250 ms ease. Arrow keys and trackpad swipe. Pages letterbox vertically centered on the page background color if the book ratio is shorter than the phone.
- **Counter**: pill at the bottom center, "12 / 48", tap opens a thumbnail grid overlay (3 columns, shared `<Page>` at small size), tap a thumbnail to jump and close.
- **Exit**: "Back to editor" top-right, Escape also exits. "Open in preview" from the page strip context menu lands on that page.

## Typography and fonts

Self-hosted WOFF2 in `packages/shared/fonts`: Inter (UI and body), Fraunces (titles), JetBrains Mono (date stamps), Instrument Serif (captions). UI chrome uses Inter at 13 px, labels at 11 px uppercase with 0.04 em tracking.
