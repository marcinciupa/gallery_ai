# Release notes (EN) — Google Play "What's new"

Google Play limit: **500 characters per language**. Paste the block below into
Play Console → testing track → "What's new in this release" (en-US).

## 0.9635 (versionCode 9635) — Play block

> Covers everything since 0.958. If 0.959–0.9625 already went out on this track,
> drop the last paragraph — it repeats what those releases delivered.

```
AI edits now stay inside your selection. Magic Erase, Text to Image and Generative Fill change only the area you paint — the rest of the photo is left untouched, pixel for pixel, with a soft blended edge and matched colour.

Generative Fill no longer leaves a black corner after straightening a photo.

Also new: icons on every key, place names and AI/RAW badges in Moments, and the app is now Gallery+.
```

## 0.9635 — full changelog

**Fixed — the big one**

- **AI edits no longer spill outside your selection.** The area you paint with the brush is now
  sent along with the photo, and only that area is replaced. Everything outside it comes straight
  from the original, unchanged. Applies to **Magic Erase**, **Text to Image** (inpainting) and
  **Generative Fill**.
  - The edit runs on a crop around your selection, so the model spends its detail where it matters.
  - The seam is feathered and the patch's brightness and colour are matched to the surrounding
    photo, so the edited area doesn't read as a lighter or warmer blob.
- **Generative Fill actually fills.** Straightening a photo used to leave a black corner: the empty
  area was handed to the model as black and came back as black. The gap is now pre-filled from the
  surrounding pixels before the model sees it, and only the gap is repainted.
- **Selecting with the eraser only no longer starts an edit.** If every brush stroke was
  "remove from select", there is nothing selected — APPLY stays inactive instead of quietly editing
  the whole photo.
- **Edits can no longer be lost before you save them.** Work-in-progress edits were held in the
  system cache, which Android is free to wipe at any moment — on a nearly full phone an edit could
  vanish between finishing it and pressing SAVE, and saving then failed. They now live in the app's
  own storage and are cleaned up after a day.
- **Magic Erase tells you when something goes wrong** instead of just stopping.
- Version number shown in Settings was stale (0.930); it now matches the installed build.

**Changed**

- Brush strokes are stored relative to the photo instead of to the screen, so a selection stays put
  when the view is resized (device ⇄ fullscreen).
- Edited photos are saved with the correct file type again (the result of a masked edit is a JPEG).

## 0.958 (versionCode 9580) — Play block

```
MOMENTS: a new view that groups your photos by date and place. Cycle Folders → Feed → Moments; choose which albums it draws from.

New selection mode: pick photos with the joystick or by touch, then delete or restore from the menu, with a clear confirm-and-undo flow.

Redesigned menus and dialogs that stay readable over any photo.

Much smoother feed scrolling, plus a fresh app icon and splash screen.
```

## 0.958 — full changelog

**New**
- **MOMENTS view** — a third view in the key cycle (FOLDERS → FEED → MOMENTS). Photos are
  grouped by the day they were taken, each group headed with the date and the place (city,
  resolved from the photo's GPS). By default it reads only your camera albums
  (Camera / DCIM / Screenshots); you can manage the list in Settings → MOMENTS FOLDERS.
- **Redesigned selection mode** — the menu now branches SELECTION · SELECT · ACTION. Press
  SELECT to hand the joystick to the grid: move between tiles, press to tick, CONFIRM returns
  to the menu. Selection shows as a checkbox; the frame on a tile is the cursor again.
- **Per-item DELETE in the menu** — delete a single photo straight from the context menu in
  any file view (feed / moments / inside a folder). High-risk actions are marked in red.
- **Redesigned delete flow** — a red confirm panel, hold to delete, then a phosphor "deleted"
  state with UNDO, and a matching restore animation.
- **New app icon and splash screen** — icon and matrix straight from Figma, with themed
  (monochrome) icon support; the splash is now the glowing glyph on a dark background.

**Changed**
- **Context menu** now shows only the items that apply to the current view, dims the content
  behind it, and blocks stray taps while open. Opening the menu over a photo no longer reloads
  the image.
- **Dialogs** are repainted on a solid accent background with dark text, so they stay readable
  over any photo instead of blending into it.
- **Multi-level menus** reveal the second level only after you confirm the first, so the panel
  isn't crowded up front.

**Performance**
- **Much smoother feed** — enlarged tiles use a two-layer LQIP so a big tile scrolling into
  view no longer stalls a frame. Measured min-fps dip on enlarged tiles: 24 → ~76 (S25 Ultra).
- **Better joystick scrolling** — a tap moves one row, holding glides smoothly; the view now
  stays put while the selected tile is on screen and only shifts by the minimum needed.
- **Progressive resistance haptics** on the joystick, with a gentle pulse back to centre.
- **Matrix overlay** rendered at native density (no more layer scaling), so the screen pattern
  is crisp on high-density displays.

**Fixed**
- Restored the gap between the status bar and the photo in the immersive viewer.
- A selection made right after the joystick stopped could land off-screen; it now always
  lands inside the visible area.
- Swipe-down in the immersive viewer now closes the view once the info panel is hidden.
