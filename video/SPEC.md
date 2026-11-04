# FolderBridge - film spec

GOAL:    The viewer feels how awkward it is to move a big file between a Mac and a PC, then the relief of one
         shared folder - and knows it's free, that pairing is one code, both must share a Wi-Fi, and nothing is lost.
OUTPUT:  HyperFrames, 1920 x 1080, 30 fps.
TIME:    98.0 s x 30 = 2940 frames. Narration (ElevenLabs, George, video/narration.json) starts at 0.5 s and is the
         clock: every beat starts on its anchor word (timings.json + 0.5 s). Music (ElevenLabs Music) 98.1 s, groove
         opens at ~28 s (the reveal).
STORY:   Storyline A (STORYLINES.md): a 2.4 GB wedding video on the Mac, needed on the PC for editing.

LOOK:    The ClipBridge film's two worlds, same palette, same objects (assets/ui.css started from its kit).
         - The desk: wall #F3EFE8, desk top #E4D8C7, 2% grain, daylight from upper left; contact shadows
           0 18px 40px rgba(60,40,20,.18). The "old way" (15.2-24.0 s) drops to 70% saturation, 92% brightness.
         - The product: FolderBridge's light theme quoted from src/renderer/style.css (ground #f5f5f8, surface #fff,
           border #e3e3eb, ink #191923, muted #676778, accent #5550d8, ok #16925a, warn #b87108).
         - Accent #5550d8 rationed: the bridge stroke, the one key element per shot, the end card button.
         - UI face Segoe UI (local) 400/600/700, as the app renders on Windows. Display face for the wordmark:
           Segoe UI 700, -2% tracking (as shipped in ClipBridge). Quiet labels 30-36 px Segoe UI 600.
OBJECTS: - MacBook Air (left) and 27" PC monitor (right): exactly the ClipBridge film's.
         - The object: the file `wedding-film.mp4` (2.4 GB) with a violet film-strip file icon, inside the folder
           `Wedding - edit`. It travels through the whole film.
         - The folder: the FolderBridge folder in Finder (Mac) and File Explorer (PC).
         - The bridge: the 12 px accent arc from the Mac's screen to the PC's, round caps; it carries the folder.
         - Keycaps (white, 5 px bottom edge #D3D4DA, 18 px radius), macOS cursor 64 px - as in ClipBridge.
MOTION:  Arrivals expo.out 0.4-0.6 s; camera power2.inOut 0.8-1.2 s; exits power3.in 0.25 s; the folder rides the
         bridge power2.inOut 0.75 s; clicks are instant with a 4-frame press (scale 0.95). List stagger 70 ms,
         typed letters 55 ms. Titles land and hold still.
SHOTS:   (film seconds)
  S1  0.0-15.2  desk.html. Settle 1.14->1.1 on the pair. "Mac" 3.50 the Mac screen wakes: Finder, `Wedding - edit`
                open with `wedding-film.mp4  2.4 GB` and photos. "PC" 4.93 the PC wakes: a video editor, empty,
                "Drop media here". "wedding video" 6.38 camera to the Mac, the file selected. "editing" 8.47 camera to
                the PC's empty editor. "Two point four gigabytes" 10.14 wide again, a file card "wedding-film.mp4
                2.4 GB" lifts off the Mac; "wrong computer" 12.86 it slides to the Mac's bezel and bumps.
  S2  15.2-24.0 detours.html over the desk, desaturated, ~2.9 s each: "USB stick" 16.64 a drawer of cables and
                adapters, no stick; "Email" 17.73 a mail with the video attached, "too big" 19.66 red bar "Attachment
                too large (25 MB limit)"; "cloud" 21.85 an upload "wedding-film.mp4 - 3%", "two hours" 23.12 "About 2
                hours left".
  S3  24.0-30.2 desk.html, full colour. "both computers" 25.11 wide; "shared" 26.41 the bridge draws (0.9 s);
                "one folder" 27.06 a folder rides across; "FolderBridge" 29.28 the apex blooms into the app icon, the
                wordmark wipes in (riser peaks one frame after).
  S4  30.2-41.6 desk.html, close on the screens. "Mac" 31.32 Mac: Finder with "FolderBridge" in the sidebar;
                "PC" 32.87 PC: File Explorer, FolderBridge folder (empty) and the FolderBridge window. "Put a file in"
                33.70 the cursor drags `wedding-film.mp4` onto the FolderBridge folder (click); "moment later" 36.79
                the PC's FolderBridge window: "Syncing 1 file - 2.4 GB left", progress runs; "other computer" 38.24 the
                file appears in Explorer (pop); "this big" 40.39 "Up to date".
  S5  41.6-51.0 pair.html. Real Settings at 1.7x. "code" 43.46 code K7QM-4XRT-P9WE; "Type it" 44.10 typed on the Mac
                (key ticks), Apply (click); "find each other" 46.55 pill "Connected to Shachar-PC" (pop). "only rule"
                48.24 back to both computers under one Wi-Fi mark; "same Wi-Fi" 49.92 label "Same Wi-Fi network".
  S6  51.0-61.0 activity.html. The real window at 1.6x: changes drop in from both computers from 51.94; "both
                computers" 53.35 "MacBook Air" and "This computer" light up; "same file on both" 55.70 the conflict
                banner "edit-notes.docx was changed on both computers"; "lets you choose" 59.91 the cursor clicks Keep
                both (click), toast "Done ✓".
  S7  61.0-69.8 trash.html. "Deleted" 61.06 a row "IMG_2041.jpg - deleted - in the trash"; "One click" 64.23 the bin
                icon opens the Trash sheet (click), the item with Restore; "back" 66.56 Restore (click), toast
                "Restored IMG_2041.jpg"; "on both" 67.24 the file reappears in Finder and Explorer; "Nothing is ever
                lost" 67.77 the trash help line highlights.
  S8  69.8-79.4 privacy.html. Network world: "cloud" 71.55 a cloud above the two computers is crossed out and lifts
                away; "No account" 73.05, "no storage limit" 74.47 two quiet labels; "directly" 76.64 the bridge
                carries a folder; "encrypted" 77.44 a lock seals the bridge.
  S9  79.4-84.6 languages.html. The app's header and folder card at 1.6x, switching language on each spoken name:
                English 80.32, Hebrew 80.91 (flips right-to-left), Spanish 81.63, French 82.63, Russian 83.26,
                Arabic 83.86 (right-to-left).
  S10 84.6-89.9 payoff.html. The desk, warm. "USB stick away" 85.74 a USB stick slides out of frame; "save" 87.96 on
                the PC the editor opens `wedding-film.mp4`; "open" 88.90 it plays (scrubber moving) - the payoff.
  S11 89.9-98.0 endcard.html on #f5f5f8. The bridge folds into the icon, wordmark wipes in, "Save on one. Open on the
                other."; "Free" 90.93 "Free & open source", "Mac" 93.24, "Windows" 93.77; CTA "Download free" +
                github.com/aiworldbyshachar/folderbridge, held 3 s.
SOUND:   Clicks only on real clicks, soft key ticks on typing, a whoosh on each detour change and on the bridge ride,
         pops on arrivals, one riser into the reveal (SFX reused from the ClipBridge film).
BANNED:  dark void grounds; glow, bloom, particles; purple/blue gradient grounds (the gradient lives only inside the
         icon); glass cards; three feature cards in a row; titles that drift after landing; everything fading and
         sliding up; the logo docked in a corner; invented product UI (every FolderBridge screen copies src/renderer);
         named competitor brands or real cloud/email logos; long dashes in any on-screen text; "seamless",
         "effortless", "unlock".
QA:      frame 0 (desk, both computers); 7.0 (video selected on the Mac); 13.0 (file card stuck at the bezel); 20.0
         ("Attachment too large"); 23.5 ("About 2 hours left"); 29.8 (icon + wordmark); 35.0 (dragged onto the
         FolderBridge folder); 38.5 (file in Explorer, progress); 46.9 (Connected pill); 50.2 ("Same Wi-Fi network");
         56.5 (conflict banner); 60.6 (Done toast); 66.8 (Restored toast); 72.5 (cloud crossed); 78.0 (lock); 81.2
         (Hebrew RTL); 84.2 (Arabic RTL); 89.4 (video playing on the PC); 95.0 (end card with URL).
