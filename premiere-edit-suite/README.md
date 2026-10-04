# Edit Suite for Premiere Pro

One Premiere Pro panel for TikTok-style edits: a 9:16 setup, beat markers from BPM, cutting on the beat, beat-synced effects, animated text, CC looks that update themselves, scenepack download and import, and Shot Exporter. It's built for Premiere Pro 2025/2026 and works back to 2022.

## Install

1. Quit Premiere Pro.
2. **Windows:** double-click `install-windows.bat`. **Mac:** in Terminal, type `bash `, drag in `install-mac.sh`, press Enter.
3. Open Premiere → **Window → Extensions → Edit Suite**.

The panel isn't signed, so the installer turns on Adobe's CEP debug mode, which lets Premiere load it. It installs next to Shot Exporter; you can keep both.

## Tabs

| Tab | What it does |
| --- | --- |
| **Setup** | Makes the open sequence 1080×1920, or a new 9:16 sequence from the clips selected in the Project panel. **Fill frame** scales each clip so it covers the frame (Fit shows bars). |
| **Beats** | Enter the BPM, put the playhead on the first beat, click **Use playhead**, then **Create beat markers**. Markers are named `Beat 1…`, and every bar's first beat is red. Your own markers are never touched. **Tap** (or press T) finds the BPM while the song plays. **Trending sounds** is an online list; click a song to use its BPM. **My songs** saves your own. |
| **Cut** | **Razor at beat markers** splits every clip on a track at each beat. **Beat montage** lays the clips selected in the Project panel one per beat (or every N beats) from the playhead. |
| **Effects** | Zoom punch, Shake, Flash, Glitch/RGB, CC flicker and Velocity punch, keyframed on every beat (or every 2nd beat, or every bar) for the selected clips or a whole track. Motion blur uses the Transform effect's shutter angle. |
| **Text** | Uses Premiere's own title templates (or any `.mogrt`). Words or lines appear one per beat, or all of the text at once at the playhead. Animations: pop-in/bounce, 3D flip, shake, glitch, fade, slide up. You can also animate clips that are already selected. |
| **Color** | One-click Lumetri looks, with intensity from 0 to 150%. Applying another look replaces the previous one on that clip. Select one adjustment layer to grade the whole edit. **CC flicker** flicks exposure, contrast and color on every beat. |
| **Scenepacks** | Searches scenepacks.com and other sites (opens in your browser). **Auto-import** watches your Downloads folder: new `.mp4/.mov` files and `.zip` packs are unzipped and imported into the bin **Scenepacks › pack name**. **Download from a link** fetches direct, Google Drive and Dropbox links, then unzips and imports them. |
| **Export** | Shot Exporter: renders every clip on V1 as its own video. |

Everything the panel does to the timeline can be undone with Ctrl/Cmd+Z.

### Speed ramps

Premiere does not let extensions change clip speed or set Time Remapping keyframes; Adobe's scripting API has no way to do it. A real velocity edit still needs Time Remapping by hand. **Velocity punch** gives the look on the beat: a scale rush with motion blur and directional blur.

## Online lists ("networks")

The trending looks, trending sounds and scenepack sites come from three JSON files in this repository:

```
feeds/looks.json      Lumetri values for each look
feeds/trending.json   songs with BPM
feeds/sites.json      scenepack sites and their search links
```

Each panel downloads these from GitHub when it opens and again every 6 hours, keeps the last copy for offline use, and falls back to the copy installed with it. **To publish new looks or trending songs, edit these files on GitHub's default branch.** Every installed panel picks up the change; nobody has to reinstall.

The trending sounds list starts empty. TikTok has no public API for trending sounds, so add songs as `{"title": "...", "artist": "...", "bpm": 128}`.

## Scenepacks

- Scenepacks are clips from films and shows that belong to their studios. They are fine for fan edits; check the site's terms before posting anything commercial.
- Big Google Drive files sometimes need a click in the browser. MEGA links are encrypted and only download in the browser. In both cases auto-import picks up the file once it lands in Downloads.
- RAR/7z packs need extracting with 7-Zip or WinRAR first.

## Files

```
CSXS/manifest.xml      panel registration (Node enabled for downloads)
index.html, css/, js/  the panel
  js/lib.js            link, feed and tap-tempo helpers
  js/nodeio.js         download, unzip, Downloads watcher
  js/suite.js          the tabs
  js/export.js         Export tab (Shot Exporter)
jsx/tiktokEditor.jsx   beats, effects, text, looks, 9:16 (ExtendScript)
jsx/shotExporter.jsx   per-clip export
jsx/scenepacks.jsx     imports downloaded clips into bins
feeds/                 the online lists
test/                  node test/tiktokEditor.test.js && node test/scenepacks.test.js
```
