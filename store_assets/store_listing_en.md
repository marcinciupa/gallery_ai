# Google Play store listing (EN) — Gallery+

Positioning: **photo gallery with AI editing**. Organising folders is a normal feature, not the
headline.

⚠️ Every feature bullet below was checked against the code (2026-09-04, re-checked 2026-09-21 for 0.970). Do not add a claim
without checking: the previously rejected listing promised a "rename" feature that does not exist,
and the first rewrite of this file re-introduced three more (haptics strength, screen colour,
a date row in the photo details). There is no haptics setting, the screen palette is constant
across themes (`src/theme/tokens.ts` — only the metal is themeable), and `InfoPanel` shows
resolution / file size / dimensions / format / location, never a date.

⚠️ This listing must NOT promote All files access. The permission was removed from the app in
v0.969 after two Google Play rejections (2026-09-02): a gallery is not on the list of permitted
uses for `MANAGE_EXTERNAL_STORAGE`, and for media-only apps the policy requires the MediaStore
API. Any sentence that documents or justifies "All files access" belongs to the old, rejected
version — do not restore it. Moving and deleting other apps' photos now runs through
`MediaStore.createDeleteRequest`, which shows one Android confirmation per batch — unless the user
turned on **media management** (`MANAGE_MEDIA`, 0.970, Android 12+), in which case Android approves
it silently. That permission covers media only and is NOT restricted by Play (no declaration form).

Paste into Play Console → Grow → Store presence → Main store listing (en-US).
**Update the listing BEFORE submitting the new AAB**, so the description and the manifest agree.

---

## App name (30 characters max)

```
Gallery+: Photos & AI Editor
```

## Short description (80 characters max)

```
Photo gallery with AI editing: erase objects, generative fill, upscale.
```

## Full description (4000 characters max)

```
Gallery+ is a photo gallery built to look and feel like a digital camera — a metal body, a lit screen, a joystick and physical keys instead of a flat menu. Browse everything on your phone, organise it into folders, and edit your pictures with AI without leaving the app.

BROWSE
• Folder view with a live photo count for every folder on the device.
• A continuous feed, and Moments — photos grouped by day and by place.
• Full-screen viewer with swipe, zoom and photo details (size, dimensions, format, and the place it was taken).
• Videos play in the app — tap anywhere on the progress bar to jump.
• Three display modes: clean photos, retro, or a full black-and-white phosphor screen.
• Sort any folder by date taken or file name in either direction, or by date added, newest first.
• Filter by media type, and show or hide hidden folders.

EDIT WITH AI
• Magic Erase — paint over an object and it is gone.
• Text to Image — paint an area and describe what should appear there instead.
• Generative Fill — straighten or rotate a photo and the empty corners are filled in.
• Upscale — more detail on small or old pictures.
• Crop, rotate and straighten.
AI edits change only the area you paint. The rest of the photo is kept pixel for pixel.

ORGANISE
• Move photos between folders — one photo or a whole selection at once.
• Copy photos to another folder, leaving the original where it is.
• Create new folders while moving or copying into them.
• Recycle bin: deleted photos are held for 30 days, can be restored one by one or all at once, and can be emptied on demand.
• Multi-select: pick files by touch or with the joystick, then run one operation on all of them.
Moving or deleting a photo that another app created (your camera, screenshots, downloads) needs Android's approval. Turn on media management once and Gallery+ does it without asking; otherwise Android asks you to confirm — once for the whole selection, not once per photo.

MAKE IT YOURS
Pick the colour of the metal body, switch the screen between clean, retro and phosphor, choose a layout for left or right handed use, and show icons or words on the keys.

PERMISSIONS
• Photos and videos — to show your pictures and to move, copy and delete the ones you select.
• Media management (optional, Android 12+) — lets Gallery+ move and delete the photos you select without Android asking each time. Covers photos and videos only, never other files. You turn it on yourself in Android settings.
• Location — only to name the place a photo was taken, in the Moments view and in the photo details. Read from the photo's own GPS data, never from the device's live location.
• Internet — to run the AI edits you start yourself, and to turn a photo's own GPS coordinates into a place name.
Gallery+ has no ads and no account. Your photos stay on your phone unless you start an AI edit, and then only the single photo being edited is sent.
```

---

## Checklist before resubmitting

- [ ] Paste name, short and full description above into the en-US listing.
- [ ] **Update the published privacy policy.** `store_assets/privacy_policy.html` was corrected here
      (app name after the rebrand, and the location section — the old text claimed the app collects no
      location while the manifest holds the location permission), but the URL registered in Play
      Console points at a public Google Doc. Copy the corrected wording there too, or the live policy
      still contradicts the manifest.
- [ ] Re-upload `feature_graphic_1024x500.png` — it said "Gallery_AI" and was regenerated as "Gallery+".
- [ ] Play Console → Policy and programs → App content → **withdraw the All files access
      declaration**. Removing the permission from the manifest does not clear the declaration.
- [ ] Confirm the uploaded AAB carries **no** `MANAGE_EXTERNAL_STORAGE`
      (`bundletool dump manifest` or the Play Console permission list on the release page).
- [ ] Screenshots: lead with the gallery and AI shots. The five `screenshot_files_*` frames show
      multi-select, the MOVE picker, the recycle bin, the folder list and the file menu — they are
      fine as supporting shots, but they must no longer open the set: the app is a gallery first.
- [ ] 0.970 adds `MANAGE_MEDIA` (media management). It is not a restricted permission — no declaration
      in Play Console. Confirm the AAB carries it (and still no `MANAGE_EXTERNAL_STORAGE`).
- [ ] `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` have their own **Photo and Video Permissions**
      declaration, which stays. Justification: Gallery+ is a gallery — it has to show and organise
      the user's whole library, which the system photo picker cannot do.
