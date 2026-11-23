# KERICONF clipmaker

Turn a [keri.foundation](https://keri.foundation) gallery **clip URL** into an MP4 plus a matching `.srt`.

```bash
# Interactive menu (asks for the clip URL + options)
node clipmaker.mjs

# Or pass the URL directly
node clipmaker.mjs "https://keri.foundation/confs/KERI/2026/nov/#kent-bull-did-webs-why-the-s-matters-most&t=393&e=403"
```

Writes:

- `clips/<videoId>_<t>-<e>.mp4`
- `clips/<videoId>_<t>-<e>.srt` — cues overlapping the range, timestamps shifted so the clip starts at `00:00:00,000`. Cues that straddle the clip edges are word-trimmed to the overlapping time (SRT has no word-level timings, so this is proportional).

When the URL asks for another language, both files include that code (`clips/<videoId>_<t>-<e>.nl.mp4` and `.nl.srt`) so they do not overwrite the English clip.

## Requirements

- Node.js 18+
- [`ffmpeg`](https://ffmpeg.org/) on `PATH`
- For `--burn-subs`: ffmpeg built with **libass** (`subtitles` filter), **or** ImageMagick (`magick`) for the PNG-overlay fallback

## How it works

1. Parse the gallery path, video id, `&t=` / `&e=` range, and optional language from the URL.
2. Load that gallery’s `index.json` (a local checkout when one is configured, otherwise HTTP) and match the talk by title slug.
3. Use a local MP4 / SRT under the media root when that root is set and the file is there; otherwise download it. `&lang=` (or `?lang=`) other than `en` selects that language’s captions.
4. Slice the SRT to the clip window and rewrite cue times relative to the clip start.
5. Trim the video with ffmpeg (re-encode by default). Optionally burn the clipped SRT into the picture.

## Media root

Copy `.env.example` to `.env` and set your kerifoundation checkout:

```bash
KERIFOUNDATION_ROOT=/path/to/kerifoundation
```

`.env` is gitignored. Clipmaker reads it on startup. A `KERIFOUNDATION_ROOT` already set in the shell is left as-is, and `--media-root` overrides both for that run.

Without a media root, the index, video, and subtitles are downloaded from the gallery URL.

Gallery URL `/confs/KERI/2026/nov/` maps to `{mediaRoot}/confs/KERI/2026/nov/`.

## Clip URL

The tool expects a gallery deep-link whose hash has a **video id** plus start/end times in seconds:

```text
https://keri.foundation/confs/KERI/2026/nov/#<video-id>&t=<start>&e=<end>&lang=<code>
```

Example:

```text
https://keri.foundation/confs/KERI/2026/nov/#kent-bull-did-webs-why-the-s-matters-most&t=393&e=403
https://keri.foundation/vids/2026/#it-s-keri-or-surveillance-samuel-smith&t=331&e=344&lang=nl
```

| Part | Meaning |
| ---- | ------- |
| path | Gallery folder (`/confs/KERI/2026/nov/`) |
| `#<video-id>` | Title slug from the gallery `index.json` |
| `&t=` | Clip start (seconds) |
| `&e=` | Clip end (seconds) |
| `&lang=` | Caption language (`nl`, `es`, …). Omitted or `en` uses the English `.srt`. A code in `?lang=` is used when the hash has none. |

English captions come from the talk’s `subtitle` field, or `talks/foo.srt` beside `talks/foo.mp4` when that field is omitted. Another language uses `subtitles.<code>` from `index.json` when set, otherwise the sibling file (`talks/foo.nl.srt`). A requested language with no file is an error.

## Interactive menu

Run with no URL (needs a terminal / TTY):

```bash
node clipmaker.mjs
# or
node clipmaker.mjs -i
```

The menu walks through:

1. **Clip URL** — paste the full gallery URL with `#…&t=…&e=…`. Invalid URLs or missing timestamps are rejected until the hash parses cleanly. `&lang=` / `?lang=` selects the subtitle file.
2. **Encode mode**
   - `1` Re-encode (H.264 + AAC, Signal-friendly) — default
   - `2` Stream copy (fast; may snap to keyframes)
   - `3` Re-encode and burn subtitles into the video
3. **Quality** — `low` / `medium` / `high` (skipped for stream copy)
4. **Custom output path** — optional; default is `clips/<videoId>_<t>-<e>.mp4` (`.nl` before the extension when the URL language is not English)
5. **Media root** — optional local kerifoundation checkout. Skipped unless you opt in (a value from `.env`, the environment, or `--media-root` is offered as the default)
6. **Keep downloaded source** — optional; only matters when the MP4 is fetched remotely
7. **Confirm** — prints a summary, then starts clipping on yes

Flags passed before `-i` (for example `--burn-subs` or `--quality high`) seed the menu defaults.

## CLI usage

```bash
node clipmaker.mjs
node clipmaker.mjs -i
node clipmaker.mjs "<clip-url>"
node clipmaker.mjs "<clip-url>" -o ./out/kent-s.mp4
node clipmaker.mjs "<clip-url>" --burn-subs
node clipmaker.mjs "<clip-url>" --quality high
node clipmaker.mjs "<clip-url>" --copy
node clipmaker.mjs "<clip-url>" --media-root /path/to/kerifoundation
node clipmaker.mjs "<clip-url>" --keep-source
```

| Flag | Meaning |
| ---- | ------- |
| `-o`, `--output` | Output MP4 path (sidecar `.srt` shares the basename) |
| `-q`, `--quality` | Export quality: `low`, `medium` (default), or `high` |
| `--burn-subs` | Burn clipped subtitles into the video (forces re-encode; uses libass when available, otherwise ImageMagick overlays) |
| `--copy` | Fast stream copy (may snap to nearby keyframes; incompatible with `--burn-subs`) |
| `--media-root` | Local kerifoundation checkout for this run. Overrides `.env` and `KERIFOUNDATION_ROOT` |
| `--keep-source` | Keep a downloaded source instead of deleting the temp file |
| `-i`, `--interactive` | Force the interactive menu |
| `-h`, `--help` | Help |

Without `--copy`, the clip is re-encoded with H.264 + AAC and `+faststart`. Quality presets:

| Level | CRF | x264 preset | AAC |
| ----- | --- | ----------- | --- |
| `low` | 28 | veryfast | 96k |
| `medium` | 23 | medium | 128k |
| `high` | 18 | slow | 192k |

Re-encodes always use `yuv420p`, no B-frames (`-bf 0`), a keyframe at `t=0`, reset timestamps, and `+faststart` so apps like Signal can show a poster frame.

## Example

```bash
# Interactive
node clipmaker.mjs

# One-shot
node clipmaker.mjs \
  "https://keri.foundation/confs/KERI/2026/nov/#kent-bull-did-webs-why-the-s-matters-most&t=393&e=403"
# → clips/kent-bull-did-webs-why-the-s-matters-most_393-403.mp4
# → clips/kent-bull-did-webs-why-the-s-matters-most_393-403.srt

node clipmaker.mjs \
  "https://keri.foundation/vids/2026/#it-s-keri-or-surveillance-samuel-smith&t=331&e=344&lang=nl"
# → clips/it-s-keri-or-surveillance-samuel-smith_331-344.nl.mp4
# → clips/it-s-keri-or-surveillance-samuel-smith_331-344.nl.srt

node clipmaker.mjs \
  "https://keri.foundation/confs/KERI/2026/nov/#kent-bull-did-webs-why-the-s-matters-most&t=393&e=403" \
  --burn-subs
```
