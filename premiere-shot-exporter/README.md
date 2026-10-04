# Shot Exporter for Premiere Pro

A Premiere Pro panel that renders every clip on V1 as its own video file. The cut points come from your timeline: each clip's start and end are the in and out of one export. It doesn't do scene detection, run FFmpeg, or analyse any frames.

```
V1   | Shot 001 | Shot 002 | Shot 003 | ...
        ↓          ↓          ↓
   shot_001.mp4 shot_002.mp4 shot_003.mp4
```

## Install

Premiere Pro 2020 (14.0) or newer, on macOS or Windows. The panel isn't signed, so the installer turns on Adobe's CEP debug mode, which lets Premiere load it.

- **macOS:** run `./install-mac.sh` in Terminal.
- **Windows:** double-click `install-windows.bat`.

Restart Premiere, then open **Window → Extensions → Shot Exporter**.

To install by hand, copy this folder into `~/Library/Application Support/Adobe/CEP/extensions/` (macOS) or `%APPDATA%\Adobe\CEP\extensions\` (Windows), and set `PlayerDebugMode` to `1` for `com.adobe.CSXS.<version>`.

## Use

1. Open the movie sequence in the Timeline.
2. Click **Read timeline**. Every clip on V1 shows up with its in/out timecode and frame count. You can pick another track from the dropdown if the cuts are somewhere else.
3. Tick the shots to export. **All**, **None** and **Timeline selection** (the clips you've selected in the Timeline) are shortcuts.
4. Choose an output folder and an export preset. The dropdown lists Premiere's built-in presets and your own Media Encoder presets. **Browse** takes any `.epr` file, such as one you saved from Premiere's Export dialog.
5. Set the file name pattern. Tokens: `{n}` shot number (001, 002, …), `{seq}` sequence name, `{clip}` clip name, `{in}` start timecode.
6. Click **Export**.

Renderers:

- **Queue in Media Encoder** (the default) adds one AME job per shot, and you can keep working while it renders. The panel marks each shot green as AME finishes it.
- **Render in Premiere** renders one shot after another inside Premiere. It doesn't need AME, but Premiere is busy until it's done.

## How it works

For each shot, the panel sets the sequence In point to `clip.start` and the Out point to `clip.end`, using exact tick values with no rounding to seconds. It then exports the sequence **In to Out** with your preset. Your original In/Out marks are put back afterwards. If the sequence had no marks, In/Out end up spanning the whole sequence.

What that means for the output:

- Each file is the finished sequence for that shot's time range. Everything on the tracks above V1 and all audio tracks in that range is included (titles, grades, adjustment layers, mix), exactly as Premiere would export it.
- Only V1 decides where the cuts are. Clips on other tracks never create extra shots.
- A gap on V1 is not a shot. Disabled V1 clips are skipped unless you untick **Advanced → Skip disabled clips**.
- Existing files are never overwritten unless you tick **Overwrite**. Otherwise the new file gets `_v2`, `_v3`, and so on.
- Before rendering, the panel reads the timeline again. If the number of clips changed since you clicked **Read timeline**, it stops and asks you to check the list.

**Check the first shot.** The Out point is set to the end of the clip, so a 72-frame clip should export as 72 frames. If your first test file has one frame of the next shot at the end, set **Advanced → Out-point adjust** to `-1`.

## Files

```
CSXS/manifest.xml        panel registration (host PPRO 14.0+)
index.html, css/, js/    the panel UI
jsx/shotExporter.jsx     ExtendScript: reads V1 clips, sets In/Out, renders
test/                    tests against a mock Premiere object model: node test/shotExporter.test.js
```
