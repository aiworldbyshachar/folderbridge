# Review - FolderBridge demo film

Checked with `hyperframes check` (passes, no errors) and snapshots of every scene, its middle, each cut
(`snapshot --review`) and the QA frames in SPEC.md.

## Fixed during review
- The wordmark's "g" was clipped by its own box (line-height 1 under a clip-path wipe) -> the box is 160 px
  tall (173 px on the end card), as ClipBridge's Studio edit did.
- The stuck video card was too small to read at the wide shot -> 22 px type, 40 px icon.
- The PC's FolderBridge window was drawn at 0.6x next to a 1x File Explorer, so the close-up mixed two
  sizes of window chrome -> Explorer narrowed, FolderBridge at 0.78x, both side by side.
- The drag image covered the "FolderBridge" sidebar item it was dropped on -> it hangs below-right of the cursor.
- The busy line said "2.4 GB left"; the real app shows "Syncing 1 file" + "wedding-film.mp4 from MacBook Air"
  while a transfer runs (src/renderer/app.js) -> copied exactly.
- Device colours: "MacBook Air" uses the app's own hash colour (#0891b2), "This computer" the accent.
- Toasts rendered in a serif face outside the app window -> `.cb-toast` sets the UI face.
- Activity window was too small to read -> 640 px tall at 1.6x, the conflict at 1.9x.
- The cursor clicked just below "Keep both" -> measured from the frame and moved.
- The trash scene opened with half of the PC window cut off at the left -> the PC window arrives with the pan.
- The lock label crossed the bridge line -> "Encrypted · AES-256" fits inside the arch.
- Long activity lines ran past the card edge in the language screens -> they wrap, as the app's `.act-meta` does.
- End card: the icon passed over the "F" while the name wiped in -> the wipe starts once the icon has landed.
- Five scenes opened on one blank frame (a flash of background at the cut) -> hard cuts; the pairing scene
  overlaps the activity scene by 0.35 s so its "Same Wi-Fi network" line holds long enough.
- "Attachment too large" and "About 2 hours left" were on screen too briefly -> held 1.7 s and 1.3 s.
- A `fromTo` would have hidden the restored photo in Finder from the first frame -> `immediateRender: false`.
- Greys copied from Finder/Explorer failed contrast -> darkened (#66666e); the app's own greys are unchanged.

## Known and accepted
- `text_below_floor`: the screens are real UI at real sizes; the readable moments are close-ups (21-27 px).
- `line_unread` on UI rows during camera moves, the 30-word Settings help text, and the language screens,
  which change on each spoken language name by design (as in the ClipBridge film).
- "Syncing 1 file" holds 1.45 s ("a moment later"), under the 1.72 s floor for its detail line.
- Several `<img>` tags share the 128 px icon (menu bar, sidebars, window headers): a discovery warning only.
- Desk wall extends past the frame on purpose (camera moves); marked `data-layout-allow-overflow`.
- UI text is Segoe UI via `local()`: renders on Windows. Font files are not committed.
- The language screens are generated from src/shared/i18n.js by tools/make-languages.mjs.
- Audio: levels and timing were measured, not listened to.
