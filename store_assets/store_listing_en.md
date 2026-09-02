# Google Play store listing (EN) — Gallery+

Positioning: **photo gallery with a built-in file manager**. File management is a core
function, not an add-on, and this listing must say so — Google Play requires that any
function relying on All files access be "visibly documented and promoted in the store
description" (rejection of 2026-09-02).

Paste into Play Console → Grow → Store presence → Main store listing (en-US).

---

## App name (30 characters max)

```
Gallery+: Photo & File Manager
```

## Short description (80 characters max)

```
Gallery and file manager: sort, move, copy and clean up photos on your phone.
```

## Full description (4000 characters max)

```
Gallery+ is a photo gallery and a file manager in one app. Browse your pictures, then move,
copy, rename the order, empty the clutter and reorganise the folders they live in — without
leaving for a separate file app. On top of that it edits photos with AI.

MANAGE YOUR PHOTO FILES
This is what Gallery+ is built for.
• Move photos between folders — one photo or hundreds in a single batch.
• Copy photos to another folder, leaving the original where it is.
• Create new folders on the device while moving or copying into them.
• Delete photos and whole folders permanently.
• Recycle bin: deleted photos are held for 30 days, can be restored one by one or all at once,
  and can be emptied on demand.
• Multi-select: pick files by touch or with the joystick, then run one operation on all of them.
• Sort any folder by date taken, date added or file name, ascending or descending.
• Show or hide hidden folders and filter by media type.
• See every folder on the device with a live photo count, not just your camera roll.

Every one of these operations works on files created by other apps — your camera, screenshots,
downloads, files copied from a computer, photos saved by messaging apps. That is why Gallery+
asks for the All files access permission: without it Android interrupts every single move and
every single delete with a system confirmation dialog, which makes batch operations on a
hundred files unusable. The permission is used only to move, copy and delete the photo files
you select. Nothing is uploaded, scanned or read in the background.

BROWSE
• Folder view, a continuous feed, and Moments — photos grouped by day and place.
• Full-screen viewer with swipe, zoom and photo details (size, dimensions, date, location).
• Three display modes: clean photos, retro, or a full black-and-white phosphor screen.

EDIT WITH AI
• Magic Erase — paint over an object and it is gone.
• Text to Image — paint an area and describe what should appear there instead.
• Generative Fill — straighten or rotate a photo and the empty corners are filled in.
• Upscale — more detail on small or old pictures.
• Crop, rotate and straighten.
AI edits change only the area you paint. The rest of the photo is kept pixel for pixel.

BUILT LIKE A CAMERA
Gallery+ is styled after a digital camera: a metal body, a lit screen, a joystick and physical
keys instead of a flat menu. It is fully themeable — pick the colour of the metal and the
screen, choose the layout for left or right handed use, and turn the haptics up or down.

PERMISSIONS
• All files access — to move, copy and delete photo files that other apps created. This is the
  app's file management function; without it those features do not work in any practical way.
• Photos and media — to show your photos.
• Location — only to name the place a photo was taken in the Moments view. Read from the
  photo's own GPS data.
• Internet — only to run the AI edits you start yourself.
Gallery+ has no ads and no account. Your photos stay on your phone unless you start an AI edit.
```

---

## Checklist before resubmitting

- [ ] Paste name, short and full description above into the en-US listing.
- [ ] Screenshots: upload `screenshot_files_1..5_1080x1920.png` FIRST, before the four AI ones —
      the reviewer must see file management without scrolling. They show, in order: multi-select
      with MOVE/COPY/DELETE, the MOVE TO folder picker, the 30-day recycle bin, the folder list
      with live counts, and the file menu. Captured from the real app (v0.966) on a Pixel 7
      emulator; regenerate with `node store_assets/compose_file_shots.mjs <dir-with-adb-screencaps>`.
- [ ] Feature graphic caption should mention file management if it carries any text.
- [ ] Fill in the All files access declaration — see `all_files_access_declaration.md`.
- [ ] Upload the demo video described there.
