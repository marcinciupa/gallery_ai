# All files access (MANAGE_EXTERNAL_STORAGE) — Play Console declaration

Filed after the rejection of 2026-09-02 ("This is not a core function" +
"MediaStore API is sufficient"). Both complaints come from the same root cause: the previous
declaration claimed file-management needs while the store listing described a plain photo
gallery. The reviewer had nothing in the listing to confirm the claim.

Fix = this declaration + the rewritten listing in `store_listing_en.md`. Submit them together;
a new declaration against the old listing will be rejected again.

---

## Form answers

**App access category:** File manager — an app whose core function is to browse, move, copy,
rename and delete files on the device.

**Which permission:** All files access (MANAGE_EXTERNAL_STORAGE)

**Core function it supports:** Moving, copying and deleting photo files between folders on the
device, individually and in batches.

**Justification (paste into the free-text field):**

```
Gallery+ is a photo gallery with a built-in file manager. Its core function, promoted in the
first paragraph and the first feature list of the store description, is organising the photo
files already on the device: moving photos between folders, copying them, creating folders,
deleting photos and folders, and restoring them from a 30-day recycle bin. Users select any
number of files at once and run one operation on all of them.

These files were created by other applications — the camera, screenshot service, downloads,
messaging apps, or copied from a computer. MediaStore is not sufficient for this function.
Deleting or modifying a file the app does not own requires MediaStore.createDeleteRequest or
createWriteRequest, which shows a system confirmation dialog for every batch. A user
reorganising a folder of several hundred photos into several destinations is interrupted by a
system dialog on every single operation, which makes batch file management unusable in
practice. All files access is the only API that allows a file manager to complete these
operations on files it does not own without interrupting the user.

The permission is used exclusively to move, copy and delete files the user has explicitly
selected in the app. Gallery+ does not scan, index, read or upload any other file on the
device. It has no ads, no analytics on file contents and no account. Photos leave the device
only when the user starts an AI edit, and only the single photo being edited is sent.
```

---

## Demo video (the form asks for one — do not skip it)

Upload as an unlisted YouTube link. Under a minute, no narration needed. It must show the file
management, because that is what is being justified.

1. Open a folder that holds camera photos — the folder list shows real photo counts.
2. Long-press a photo to enter selection, tick 5–6 more.
3. Menu → ACTION → MOVE TO → pick a target folder → the photos land there, counts update in
   both folders.
4. Select several more → DELETE → the recycle bin → RESTORE ALL → they come back.
5. End on Settings so the reviewer sees this is one app, not a wrapper.

Do not show the AI features in this video. They are not what the permission is for, and
showing them invites the "media-only app" verdict again.

---

## If it is rejected a second time

Do not appeal a third time — switch to the Storage Access Framework instead. The user grants a
folder once through the system picker and the app gets persistent write access to that tree, so
moves and deletes inside it run without any dialog. `expo-file-system` already ships the API
(`StorageAccessFramework.requestDirectoryPermissionsAsync`, `deleteAsync`, `moveAsync`,
`copyAsync`), so no new dependency is needed. It requires no declaration and no policy review.
Cost: one folder picker the first time a folder is touched, plus mapping our MediaStore
`content://` ids onto documents inside the granted tree.
