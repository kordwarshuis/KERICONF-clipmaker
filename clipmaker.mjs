#!/usr/bin/env node

import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';

/** Local checkout, or null when files should be downloaded. */
function defaultMediaRoot() {
  const raw = process.env.KERIFOUNDATION_ROOT;
  const value = typeof raw === 'string' ? raw.trim() : '';
  return value || null;
}

function mediaRootLabel(mediaRoot) {
  return mediaRoot || 'none (download from the gallery)';
}

const USER_AGENT =
  'Mozilla/5.0 (compatible; KERICONF-clipmaker/1.0; +https://keri.foundation)';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Load KEY=value pairs from `.env`. A variable already set in the environment
 * is left unchanged, and `--media-root` still overrides KERIFOUNDATION_ROOT.
 */
function loadDotEnv(filePath) {
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return;
    throw err;
  }
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const body = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf('=');
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key]) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(__dirname, '.env'));

function usage(exitCode = 0) {
  const text = `Usage: clipmaker [clip-url] [options]
       clipmaker                 Interactive menu (asks for URL + options)

Create an MP4 (and matching .srt) from a keri.foundation gallery clip URL.

Options:
  -o, --output <path>     Output MP4 path (sidecar .srt uses the same basename)
  -q, --quality <level>   Export quality: low | medium | high (default: medium)
      --copy              Stream-copy instead of re-encoding (faster, keyframe-snapped)
      --burn-subs         Burn the clipped subtitles into the video (re-encodes)
      --media-root <dir>  Local kerifoundation checkout. Overrides KERIFOUNDATION_ROOT
                          from the environment or from .env. Without any of those,
                          index, video, and subtitles are downloaded.
      --keep-source       Keep a downloaded source file
  -i, --interactive       Force the interactive menu
  -h, --help              Show help

A non-English caption language in the URL (&lang=nl in the hash, or ?lang=nl)
selects that language's subtitles (talks/foo.nl.srt, or the index.json
subtitles map). English is used when lang is omitted.

Example:
  node clipmaker.mjs
  node clipmaker.mjs "https://keri.foundation/confs/KERI/2026/nov/#kent-bull-did-webs-why-the-s-matters-most&t=393&e=403"
  node clipmaker.mjs "https://keri.foundation/vids/2026/#it-s-keri-or-surveillance-samuel-smith&t=331&e=344&lang=nl"
  node clipmaker.mjs "<clip-url>" --burn-subs --quality high
`;
  if (exitCode === 0) console.log(text);
  else console.error(text);
  process.exit(exitCode);
}

const QUALITY_PRESETS = {
  // Signal/WhatsApp need yuv420p, no B-frames (so PTS starts at 0), and faststart.
  low: { crf: 28, preset: 'veryfast', audioBitrate: '96k', profile: 'baseline' },
  medium: { crf: 23, preset: 'medium', audioBitrate: '128k', profile: 'baseline' },
  high: { crf: 18, preset: 'slow', audioBitrate: '192k', profile: 'main' },
};

function parseQuality(raw) {
  const key = String(raw || '').trim().toLowerCase();
  if (!QUALITY_PRESETS[key]) {
    die(`Invalid --quality "${raw}". Use: low, medium, or high`);
  }
  return key;
}

function videoEncodeArgs(quality) {
  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;
  return [
    '-c:v',
    'libx264',
    '-preset',
    q.preset,
    '-crf',
    String(q.crf),
    '-profile:v',
    q.profile,
    '-level',
    '3.1',
    '-pix_fmt',
    'yuv420p',
    // B-frames delay the first PTS (~1 frame); Signal then finds no frame at t=0.
    '-bf',
    '0',
    '-force_key_frames',
    '00:00:00.000',
    '-c:a',
    'aac',
    '-b:a',
    q.audioBitrate,
    '-ac',
    '2',
    '-ar',
    '48000',
    '-movflags',
    '+faststart',
  ];
}

function parseArgs(argv) {
  const opts = {
    url: null,
    output: null,
    copy: false,
    burnSubs: false,
    quality: 'medium',
    mediaRoot: defaultMediaRoot(),
    keepSource: false,
    interactive: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') usage(0);
    else if (arg === '-i' || arg === '--interactive') opts.interactive = true;
    else if (arg === '--copy') opts.copy = true;
    else if (arg === '--burn-subs') opts.burnSubs = true;
    else if (arg === '--keep-source') opts.keepSource = true;
    else if (arg === '-o' || arg === '--output') {
      opts.output = argv[++i];
      if (!opts.output) die('Missing value for --output');
    } else if (arg === '-q' || arg === '--quality') {
      opts.quality = parseQuality(argv[++i]);
    } else if (arg === '--media-root') {
      opts.mediaRoot = argv[++i];
      if (!opts.mediaRoot || !String(opts.mediaRoot).trim()) die('Missing value for --media-root');
      opts.mediaRoot = String(opts.mediaRoot).trim();
    } else if (arg.startsWith('-')) {
      die(`Unknown option: ${arg}`);
    } else if (!opts.url) {
      opts.url = arg;
    } else {
      die(`Unexpected argument: ${arg}`);
    }
  }

  // No URL (and not forced interactive) → interactive menu.
  if (!opts.url) opts.interactive = true;

  if (!opts.interactive) {
    if (opts.copy && opts.burnSubs) {
      die('--burn-subs requires re-encoding; do not combine with --copy');
    }
    if (opts.copy && opts.quality !== 'medium') {
      console.warn('Warning: --quality has no effect with --copy (stream copy keeps source bitrate)');
    }
  }
  return opts;
}

function die(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function validateClipOpts(opts) {
  if (!opts.url) die('Clip URL is required');
  if (opts.copy && opts.burnSubs) {
    die('--burn-subs requires re-encoding; do not combine with --copy');
  }
  if (opts.copy && opts.quality !== 'medium') {
    console.warn('Warning: --quality has no effect with --copy (stream copy keeps source bitrate)');
  }
}

function encodeModeLabel(opts) {
  if (opts.burnSubs) return 're-encode + burn subtitles';
  if (opts.copy) return 'stream copy (fast)';
  return 're-encode';
}

async function promptLine(rl, question, { defaultValue = '' } = {}) {
  const suffix = defaultValue !== '' && defaultValue != null ? ` [${defaultValue}]` : '';
  const answer = (await rl.question(`${question}${suffix}: `)).trim();
  return answer === '' ? defaultValue : answer;
}

async function promptYesNo(rl, question, defaultYes = false) {
  const hint = defaultYes ? 'Y/n' : 'y/N';
  for (;;) {
    const answer = (await rl.question(`${question} (${hint}): `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    if (answer === 'y' || answer === 'yes') return true;
    if (answer === 'n' || answer === 'no') return false;
    console.log('  Please answer y or n.');
  }
}

async function promptMenu(rl, title, choices, defaultKey) {
  console.log(`\n${title}`);
  for (const choice of choices) {
    const mark = choice.key === defaultKey ? ' (default)' : '';
    console.log(`  ${choice.key}) ${choice.label}${mark}`);
  }
  const valid = new Set(choices.map((c) => c.key));
  for (;;) {
    const answer = (await rl.question(`Choice [${defaultKey}]: `)).trim().toLowerCase();
    const key = answer === '' ? defaultKey : answer;
    if (valid.has(key)) return key;
    console.log(`  Pick one of: ${[...valid].join(', ')}`);
  }
}

async function promptClipUrl(rl, initial) {
  console.log('\nPaste a keri.foundation gallery clip URL with timestamps.');
  console.log('Example:');
  console.log(
    '  https://keri.foundation/confs/KERI/2026/nov/#kent-bull-did-webs-why-the-s-matters-most&t=393&e=403',
  );
  console.log('The hash must include the video id plus &t=start and &e=end (seconds).');
  console.log('Optional &lang=nl (or ?lang=nl) selects that language\'s subtitles.\n');

  for (;;) {
    const url = await promptLine(rl, 'Clip URL', { defaultValue: initial || '' });
    if (!url) {
      console.log('  URL is required.');
      continue;
    }
    const { error, clip } = tryParseClipUrl(url);
    if (error) {
      if (error.startsWith('Invalid URL')) {
        console.log('  Invalid URL. Paste the full https://… link including the #…&t=…&e=… hash.');
      } else if (error.includes('missing a hash')) {
        console.log('  Missing hash (#video-id&t=…&e=…).');
      } else if (error.includes('video id')) {
        console.log('  Missing video id in the hash.');
      } else if (error.includes('&t=')) {
        console.log('  Missing &t= start time in the URL hash.');
      } else if (error.includes('&e=')) {
        console.log('  Missing &e= end time in the URL hash.');
      } else if (error.includes('greater')) {
        console.log('  End time must be greater than start time.');
      } else {
        console.log(`  ${error}`);
      }
      continue;
    }
    const langNote = clip.lang ? `, ${clip.lang}` : '';
    console.log(
      `  OK — ${clip.videoId} (${clip.start}s → ${clip.end}s, ${+clip.duration.toFixed(3)}s${langNote})`,
    );
    return url;
  }
}

async function runInteractiveMenu(seed = {}) {
  if (!input.isTTY || !output.isTTY) {
    die('Interactive menu needs a TTY. Pass a clip URL as an argument, or run in a terminal.');
  }

  const rl = createInterface({ input, output, terminal: true });
  try {
    console.log('KERICONF clipmaker');
    console.log('──────────────────');

    const opts = {
      url: null,
      output: seed.output || null,
      copy: Boolean(seed.copy),
      burnSubs: Boolean(seed.burnSubs),
      quality: seed.quality || 'medium',
      mediaRoot: seed.mediaRoot || null,
      keepSource: Boolean(seed.keepSource),
      interactive: true,
    };

    opts.url = await promptClipUrl(rl, seed.url || '');

    const modeDefault = opts.burnSubs ? '3' : opts.copy ? '2' : '1';
    const mode = await promptMenu(
      rl,
      'Encode mode',
      [
        { key: '1', label: 'Re-encode (H.264 + AAC, Signal-friendly)' },
        { key: '2', label: 'Stream copy (fast; may snap to keyframes)' },
        { key: '3', label: 'Re-encode and burn subtitles into the video' },
      ],
      modeDefault,
    );
    opts.copy = mode === '2';
    opts.burnSubs = mode === '3';

    if (!opts.copy) {
      const qualityKey = await promptMenu(
        rl,
        'Export quality',
        [
          { key: '1', label: 'low    — smaller file, faster encode' },
          { key: '2', label: 'medium — balanced (default)' },
          { key: '3', label: 'high   — better quality, slower encode' },
        ],
        opts.quality === 'low' ? '1' : opts.quality === 'high' ? '3' : '2',
      );
      opts.quality = qualityKey === '1' ? 'low' : qualityKey === '3' ? 'high' : 'medium';
    } else {
      opts.quality = 'medium';
    }

    const customOut = await promptYesNo(rl, 'Set a custom output path?', false);
    if (customOut) {
      opts.output = await promptLine(rl, 'Output MP4 path', {
        defaultValue: opts.output || '',
      });
      if (!opts.output) opts.output = null;
    } else {
      opts.output = null;
    }

    const useLocal = await promptYesNo(
      rl,
      opts.mediaRoot
        ? `Use local media root ${opts.mediaRoot}?`
        : 'Use a local media root?',
      Boolean(opts.mediaRoot),
    );
    if (useLocal) {
      for (;;) {
        const entered = await promptLine(rl, 'Media root', {
          defaultValue: opts.mediaRoot || '',
        });
        if (String(entered).trim()) {
          opts.mediaRoot = String(entered).trim();
          break;
        }
        console.log('  Enter a directory path.');
      }
    } else {
      opts.mediaRoot = null;
    }

    opts.keepSource = await promptYesNo(
      rl,
      'Keep downloaded source if remote fetch is needed?',
      opts.keepSource,
    );

    const parsedClip = parseClipUrl(opts.url);
    const defaultName = defaultClipBasename(parsedClip) + '.mp4';
    console.log('\nReady to clip:');
    console.log(`  URL:        ${opts.url}`);
    console.log(`  Language:   ${parsedClip.lang || 'en'}`);
    console.log(`  Mode:       ${encodeModeLabel(opts)}`);
    if (!opts.copy) console.log(`  Quality:    ${opts.quality}`);
    console.log(`  Output:     ${opts.output || `(default clips/${defaultName})`}`);
    console.log(`  Media root: ${mediaRootLabel(opts.mediaRoot)}`);
    console.log(`  Keep source:${opts.keepSource ? ' yes' : ' no'}`);

    const ok = await promptYesNo(rl, '\nStart?', true);
    if (!ok) {
      console.log('Cancelled.');
      process.exit(0);
    }
    return opts;
  } finally {
    rl.close();
  }
}

function generateVideoId(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

/** ISO 639 code from `nl`, `nl-NL`, or a percent-encoded value. `en` stays English. */
function normalizeLangCode(raw) {
  if (raw == null) return null;
  let text = String(raw).trim();
  if (!text) return null;
  try {
    text = decodeURIComponent(text);
  } catch {
    // Keep the raw token when it is not valid percent-encoding.
  }
  const match = text.toLowerCase().match(/^([a-z]{2,3})(?:-[a-z0-9]+)?$/i);
  return match ? match[1].toLowerCase() : null;
}

function parseHashParams(queryStr) {
  const result = { start: null, end: null, lang: null };
  if (!queryStr) return result;
  for (const param of queryStr.split('&')) {
    if (!param) continue;
    const eq = param.indexOf('=');
    const key = eq === -1 ? param : param.slice(0, eq);
    const rawVal = eq === -1 ? '' : param.slice(eq + 1);
    if (key === 't') {
      const n = Number.parseFloat(rawVal);
      if (!Number.isNaN(n) && n >= 0) result.start = n;
    } else if (key === 'e') {
      const n = Number.parseFloat(rawVal);
      if (!Number.isNaN(n) && n >= 0) result.end = n;
    } else if (key === 'lang') {
      result.lang = normalizeLangCode(rawVal);
    }
  }
  return result;
}

function tryParseClipUrl(raw) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { error: `Invalid URL: ${raw}` };
  }

  const hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  if (!hash) return { error: 'Clip URL is missing a hash (#video-id&t=…&e=…)' };

  const ampIndex = hash.indexOf('&');
  const videoId = ampIndex === -1 ? hash : hash.slice(0, ampIndex);
  const queryStr = ampIndex === -1 ? '' : hash.slice(ampIndex + 1);
  if (!videoId) return { error: 'Clip URL hash is missing a video id' };

  const hashParams = parseHashParams(queryStr);
  let { start, end } = hashParams;
  // Hash &lang= wins; ?lang= is the fallback, matching the gallery player.
  const lang = hashParams.lang || normalizeLangCode(parsed.searchParams.get('lang'));

  if (start === null) return { error: 'Clip URL is missing &t= start time' };
  if (end === null) return { error: 'Clip URL is missing &e= end time' };
  if (end < start) [start, end] = [end, start];
  if (!(end > start)) return { error: 'Clip end must be greater than start' };

  let pathname = parsed.pathname || '/';
  if (!pathname.endsWith('/')) pathname += '/';

  return {
    error: null,
    clip: {
      origin: parsed.origin,
      galleryUrl: new URL(pathname, parsed.origin).href,
      galleryPath: pathname,
      videoId,
      start,
      end,
      duration: end - start,
      // null means English (omitted lang, lang=en, or an unrecognized code).
      lang: lang && lang !== 'en' ? lang : null,
    },
  };
}

function parseClipUrl(raw) {
  const { error, clip } = tryParseClipUrl(raw);
  if (error) die(error);
  return clip;
}

function defaultClipBasename(clip) {
  const langSuffix = clip.lang ? `.${clip.lang}` : '';
  return `${clip.videoId}_${Math.floor(clip.start)}-${Math.floor(clip.end)}${langSuffix}`;
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function loadJson(filePathOrUrl, { preferLocalPath } = {}) {
  if (preferLocalPath && (await fileExists(preferLocalPath))) {
    const text = await readFile(preferLocalPath, 'utf8');
    return JSON.parse(text);
  }

  const res = await fetch(filePathOrUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) {
    die(`Failed to load index.json (${res.status} ${res.statusText}): ${filePathOrUrl}`);
  }
  return res.json();
}

function findVideo(index, videoId) {
  const videos = Array.isArray(index?.videos) ? index.videos : [];
  const match = videos.find((v) => generateVideoId(v.title) === videoId);
  if (!match) {
    const known = videos.map((v) => generateVideoId(v.title)).filter(Boolean);
    die(
      `No video with id "${videoId}" in gallery index.` +
        (known.length ? `\nKnown ids:\n  - ${known.join('\n  - ')}` : ''),
    );
  }
  if (!match.path) die(`Video "${videoId}" has no path in index.json`);
  return match;
}

function galleryJoin(mediaRoot, galleryPath, relPath) {
  return path.join(mediaRoot, galleryPath.replace(/^\/+/, ''), String(relPath).replace(/^\/+/, ''));
}

async function downloadToTemp(remoteUrl, basename, accept) {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'kericonf-clip-'));
  const tmpFile = path.join(tmpDir, basename || 'download.bin');
  const res = await fetch(remoteUrl, {
    headers: { 'User-Agent': USER_AGENT, Accept: accept },
  });
  if (!res.ok || !res.body) {
    await rm(tmpDir, { recursive: true, force: true });
    die(`Failed to download (${res.status} ${res.statusText}): ${remoteUrl}`);
  }
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmpFile));
  return {
    path: tmpFile,
    cleanup: async () => {
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

async function resolveSource({ clip, video, mediaRoot, keepSource }) {
  const relPath = String(video.path).replace(/^\/+/, '');
  const remoteUrl = new URL(relPath, clip.galleryUrl).href;

  if (mediaRoot) {
    const localPath = galleryJoin(mediaRoot, clip.galleryPath, relPath);
    if (await fileExists(localPath)) {
      console.log(`Source: local ${localPath}`);
      return { path: localPath, cleanup: null };
    }
    console.log(`Local miss: ${localPath}`);
  }

  console.log(`Downloading: ${remoteUrl}`);
  const downloaded = await downloadToTemp(
    remoteUrl,
    path.basename(relPath) || 'source.mp4',
    'video/mp4,*/*',
  );
  console.log(`Downloaded to ${downloaded.path}`);

  if (keepSource) {
    const keepDir = path.join(__dirname, 'tmp');
    await mkdir(keepDir, { recursive: true });
    const keepPath = path.join(
      keepDir,
      `${clip.videoId}${path.extname(downloaded.path) || '.mp4'}`,
    );
    await copyFile(downloaded.path, keepPath);
    await downloaded.cleanup();
    console.log(`Kept source: ${keepPath}`);
    return { path: keepPath, cleanup: null };
  }

  return downloaded;
}

function subtitleSrc(value) {
  if (typeof value === 'string' && value.trim()) return value.trim().replace(/^\/+/, '');
  if (value && typeof value === 'object' && value.src) {
    return String(value.src).trim().replace(/^\/+/, '');
  }
  return null;
}

/** English captions: explicit `subtitle`, else `talks/foo.mp4` → `talks/foo.srt`. */
function englishSubtitleRel(video) {
  const explicit = subtitleSrc(video?.subtitle);
  if (explicit) return explicit;
  const media = String(video?.path || '').replace(/^\/+/, '');
  if (!media || /^(https?:)?\/\//i.test(media)) return null;
  if (!/\.(mp4|mp3)$/i.test(media)) return null;
  return media.replace(/\.(mp4|mp3)$/i, '.srt');
}

function mappedSubtitle(video, code) {
  const map = video?.subtitles;
  if (!map || typeof map !== 'object') return null;
  for (const [key, value] of Object.entries(map)) {
    if (String(key).toLowerCase() !== code) continue;
    const src = subtitleSrc(value);
    if (src) return src;
  }
  return null;
}

/**
 * Caption file for a gallery language.
 * `subtitles[lang]` in index.json wins; otherwise the sibling of the English
 * file (`talks/foo.srt` → `talks/foo.nl.srt`), same as the gallery player.
 */
function languageSubtitleRel(video, lang) {
  const code = normalizeLangCode(lang);
  if (!code || code === 'en') return englishSubtitleRel(video);

  const mapped = mappedSubtitle(video, code);
  if (mapped) return mapped;

  const english = englishSubtitleRel(video);
  if (!english || !/\.srt$/i.test(english)) return null;
  if (/\.[a-z]{2,3}\.srt$/i.test(path.basename(english))) return null;
  return english.replace(/\.srt$/i, `.${code}.srt`);
}

async function loadSubtitleText(relPath, clip, mediaRoot) {
  if (!relPath) return null;
  if (/^https?:\/\//i.test(relPath)) {
    console.log(`Downloading subtitles: ${relPath}`);
    return fetchSubtitle(relPath);
  }

  const remoteUrl = new URL(relPath, clip.galleryUrl).href;
  if (mediaRoot) {
    const localPath = galleryJoin(mediaRoot, clip.galleryPath, relPath);
    if (await fileExists(localPath)) {
      console.log(`Subtitles: local ${localPath}`);
      return readFile(localPath, 'utf8');
    }
    console.log(`Local subtitle miss: ${localPath}`);
  }

  console.log(`Downloading subtitles: ${remoteUrl}`);
  return fetchSubtitle(remoteUrl);
}

async function fetchSubtitle(url) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/plain,*/*' },
    });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

async function resolveSubtitleText({ clip, video, mediaRoot }) {
  if (clip.lang) {
    const relPath = languageSubtitleRel(video, clip.lang);
    if (!relPath) die(`No ${clip.lang} subtitle path for this talk`);
    const text = await loadSubtitleText(relPath, clip, mediaRoot);
    if (text === null) {
      die(`No ${clip.lang} subtitles for this talk (expected ${relPath})`);
    }
    console.log(`Subtitle language: ${clip.lang}`);
    return text;
  }

  const relPath = englishSubtitleRel(video);
  if (!relPath) {
    console.warn('Warning: video has no subtitle field in index.json');
    return null;
  }
  const text = await loadSubtitleText(relPath, clip, mediaRoot);
  if (text === null) {
    console.warn('Warning: failed to load subtitles');
    return null;
  }
  return text;
}

function parseTimestamp(ts) {
  const m = String(ts)
    .trim()
    .match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  const seconds = Number(m[3]);
  const frac = m[4].padEnd(3, '0').slice(0, 3);
  return hours * 3600 + minutes * 60 + seconds + Number(frac) / 1000;
}

function formatTimestamp(seconds) {
  const msTotal = Math.max(0, Math.round(seconds * 1000));
  const hours = Math.floor(msTotal / 3_600_000);
  const minutes = Math.floor((msTotal % 3_600_000) / 60_000);
  const secs = Math.floor((msTotal % 60_000) / 1000);
  const ms = msTotal % 1000;
  return (
    String(hours).padStart(2, '0') +
    ':' +
    String(minutes).padStart(2, '0') +
    ':' +
    String(secs).padStart(2, '0') +
    ',' +
    String(ms).padStart(3, '0')
  );
}

function parseSrt(text) {
  const normalized = String(text).replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks = normalized.split(/\n{2,}/);
  const cues = [];

  for (const block of blocks) {
    const lines = block.split('\n').filter((line, i, arr) => !(i === arr.length - 1 && line === ''));
    if (lines.length < 2) continue;

    let idx = 0;
    if (/^\d+$/.test(lines[0].trim()) && lines[1]?.includes('-->')) idx = 1;
    const timing = lines[idx];
    if (!timing || !timing.includes('-->')) continue;

    const [startRaw, endRaw] = timing.split('-->').map((s) => s.trim().split(/\s+/)[0]);
    const start = parseTimestamp(startRaw);
    const end = parseTimestamp(endRaw);
    if (start === null || end === null || !(end > start)) continue;

    const body = lines.slice(idx + 1).join('\n').trimEnd();
    if (!body) continue;
    cues.push({ start, end, text: body });
  }

  return cues;
}

/** Re-wrap words into one or two SRT lines after boundary trimming. */
function formatTrimmedSrtText(words) {
  if (!words.length) return '';
  if (words.length <= 6) return words.join(' ');
  const mid = Math.ceil(words.length / 2);
  return `${words.slice(0, mid).join(' ')}\n${words.slice(mid).join(' ')}`;
}

/**
 * SRTs only have cue-level timing, so words outside the clip window are removed
 * by keeping the time-overlap fraction of the cue's words.
 */
function trimCueTextToOverlap(text, cueStart, cueEnd, keepStart, keepEnd) {
  const duration = cueEnd - cueStart;
  if (!(duration > 0)) return String(text).trim();

  const words = String(text)
    .replace(/\r\n/g, '\n')
    .replace(/\n/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return '';

  const fromFrac = Math.min(1, Math.max(0, (keepStart - cueStart) / duration));
  const toFrac = Math.min(1, Math.max(0, (keepEnd - cueStart) / duration));
  if (!(toFrac > fromFrac)) return '';

  let startIdx = Math.round(fromFrac * words.length);
  let endIdx = Math.round(toFrac * words.length);
  if (endIdx <= startIdx) {
    // Tiny overlap: keep one word from the overlapping side.
    startIdx = Math.min(words.length - 1, Math.floor(fromFrac * words.length));
    endIdx = startIdx + 1;
  }

  return formatTrimmedSrtText(words.slice(startIdx, endIdx));
}

function sliceSrt(cues, clipStart, clipEnd) {
  const out = [];
  for (const cue of cues) {
    if (cue.end <= clipStart || cue.start >= clipEnd) continue;
    const keepStart = Math.max(cue.start, clipStart);
    const keepEnd = Math.min(cue.end, clipEnd);
    if (!(keepEnd > keepStart)) continue;

    const fullyInside = cue.start >= clipStart && cue.end <= clipEnd;
    const text = fullyInside
      ? cue.text
      : trimCueTextToOverlap(cue.text, cue.start, cue.end, keepStart, keepEnd);
    if (!String(text).trim()) continue;

    out.push({
      start: keepStart - clipStart,
      end: keepEnd - clipStart,
      text,
    });
  }
  return out;
}

function serializeSrt(cues) {
  if (!cues.length) return '';
  return (
    cues
      .map(
        (cue, i) =>
          `${i + 1}\n${formatTimestamp(cue.start)} --> ${formatTimestamp(cue.end)}\n${cue.text}`,
      )
      .join('\n\n') + '\n'
  );
}

/** Escape a path for ffmpeg's subtitles/ass filter. */
function escapeSubtitlesFilterPath(filePath) {
  return path
    .resolve(filePath)
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/]/g, '\\]');
}

function runCmd(command, args, { inherit = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: inherit ? ['ignore', 'inherit', 'inherit'] : ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    if (!inherit) {
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
    }
    child.on('error', (err) => {
      if (err.code === 'ENOENT') {
        reject(new Error(`${command} not found on PATH`));
      } else {
        reject(err);
      }
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with code ${code}${stderr ? `\n${stderr}` : ''}`));
    });
  });
}

function runFfmpeg(args) {
  return runCmd('ffmpeg', args);
}

let _ffmpegFilters = null;
async function ffmpegHasFilter(name) {
  if (!_ffmpegFilters) {
    const { stdout, stderr } = await runCmd('ffmpeg', ['-hide_banner', '-filters'], {
      inherit: false,
    });
    _ffmpegFilters = `${stdout}\n${stderr}`;
  }
  const re = new RegExp(`\\s${name}\\s`);
  return re.test(_ffmpegFilters);
}

async function probeVideoSize(sourcePath) {
  const { stdout } = await runCmd(
    'ffprobe',
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height',
      '-of',
      'csv=p=0:s=x',
      sourcePath,
    ],
    { inherit: false },
  );
  const [w, h] = stdout
    .trim()
    .split('x')
    .map((n) => Number.parseInt(n, 10));
  if (!w || !h) throw new Error(`Could not probe video size for ${sourcePath}`);
  return { width: w, height: h };
}

function captionFontPath() {
  const candidates = [
    '/System/Library/Fonts/Supplemental/Arial Bold.ttf',
    '/System/Library/Fonts/Supplemental/Arial.ttf',
    '/System/Library/Fonts/Supplemental/Arial Unicode.ttf',
    '/Library/Fonts/Arial Bold.ttf',
    '/Library/Fonts/Arial.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
    '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/TTF/DejaVuSans.ttf',
  ];
  for (const font of candidates) {
    if (existsSync(font)) return font;
  }
  return null;
}

/** Soft-wrap cue text into centered subtitle lines. */
function wrapCaptionLines(text, maxChars) {
  const paragraphs = String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= maxChars) {
      lines.push(paragraph);
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = '';
    for (const word of words) {
      const next = current ? `${current} ${word}` : word;
      if (current && next.length > maxChars) {
        lines.push(current);
        current = word;
      } else {
        current = next;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [''];
}

async function renderCuePng({ cue, index, width, height, outDir, font }) {
  const stem = `cue-${String(index).padStart(3, '0')}`;
  const pngPath = path.join(outDir, `${stem}.png`);
  const pointSize = Math.max(36, Math.round(height * 0.05));
  const bottomPad = Math.round(height * 0.05);
  const textWidth = Math.max(320, width - Math.round(width * 0.12));
  const boxPadX = Math.max(16, Math.round(pointSize * 0.45));
  const boxPadY = Math.max(10, Math.round(pointSize * 0.3));
  // Light dilation only — enough for H.264, not cartoon-bold.
  const dilateRadius = Math.max(0.8, pointSize * 0.02);
  const maxChars = Math.max(24, Math.floor(textWidth / (pointSize * 0.52)));
  const lines = wrapCaptionLines(cue.text, maxChars);

  const linePngs = [];
  for (let i = 0; i < lines.length; i++) {
    const linePath = path.join(outDir, `${stem}-line-${i}.png`);
    const lineTxt = path.join(outDir, `${stem}-line-${i}.txt`);
    await writeFile(lineTxt, lines[i], 'utf8');
    const args = [
      '-background',
      'none',
      '-fill',
      'white',
      '-pointsize',
      String(pointSize),
      '-gravity',
      'center',
    ];
    if (font) args.push('-font', font);
    // label:@file avoids ImageMagick parsing colons in text like "did:webs".
    args.push(`label:@${lineTxt}`, linePath);
    await runCmd('magick', args, { inherit: false });
    linePngs.push(linePath);
  }

  const widths = [];
  for (const linePath of linePngs) {
    const { stdout } = await runCmd('magick', ['identify', '-format', '%w', linePath], {
      inherit: false,
    });
    widths.push(Number.parseInt(stdout.trim(), 10) || 0);
  }
  // Hug the longest line so the dark box is compact and clearly centered on the frame.
  const stackWidth = Math.max(...widths, 1);

  const centeredLines = [];
  for (let i = 0; i < linePngs.length; i++) {
    const centered = path.join(outDir, `${stem}-line-${i}-c.png`);
    await runCmd(
      'magick',
      [
        linePngs[i],
        '-gravity',
        'center',
        '-background',
        'none',
        '-extent',
        `${stackWidth}x`,
        centered,
      ],
      { inherit: false },
    );
    centeredLines.push(centered);
  }

  const textPng = path.join(outDir, `${stem}-text.png`);
  const captionPng = path.join(outDir, `${stem}-caption.png`);
  await runCmd(
    'magick',
    [
      ...centeredLines,
      '-background',
      'none',
      '-append',
      '-channel',
      'A',
      '-morphology',
      'Dilate',
      `Disk:${dilateRadius.toFixed(2)}`,
      '+channel',
      '-channel',
      'RGB',
      '-evaluate',
      'set',
      '100%',
      '+channel',
      textPng,
    ],
    { inherit: false },
  );

  // Opaque dark box behind bold white text — much more readable than a thin outline.
  await runCmd(
    'magick',
    [
      textPng,
      '-background',
      '#000000E6',
      '-gravity',
      'center',
      '-bordercolor',
      '#000000E6',
      '-border',
      `${boxPadX}x${boxPadY}`,
      captionPng,
    ],
    { inherit: false },
  );

  await runCmd(
    'magick',
    [
      '-size',
      `${width}x${height}`,
      'xc:none',
      captionPng,
      '-gravity',
      'south',
      '-geometry',
      `+0+${bottomPad}`,
      '-composite',
      pngPath,
    ],
    { inherit: false },
  );
  return pngPath;
}

async function makeClip({
  sourcePath,
  start,
  duration,
  output,
  copy,
  burnSubs,
  srtPath,
  cues,
  quality,
}) {
  await mkdir(path.dirname(output), { recursive: true });

  if (copy) {
    const args = [
      '-y',
      '-ss',
      String(start),
      '-i',
      sourcePath,
      '-t',
      String(duration),
      '-c',
      'copy',
      '-avoid_negative_ts',
      'make_zero',
      output,
    ];
    console.log(`ffmpeg ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    await runFfmpeg(args);
    return;
  }

  const encode = videoEncodeArgs(quality);
  const q = QUALITY_PRESETS[quality] || QUALITY_PRESETS.medium;
  console.log(`Quality: ${quality} (crf ${q.crf}, preset ${q.preset}, audio ${q.audioBitrate})`);

  if (!burnSubs) {
    const args = [
      '-y',
      '-ss',
      String(start),
      '-i',
      sourcePath,
      '-t',
      String(duration),
      '-vf',
      'setpts=PTS-STARTPTS',
      '-af',
      'asetpts=PTS-STARTPTS',
      ...encode,
      output,
    ];
    console.log(`ffmpeg ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    await runFfmpeg(args);
    return;
  }

  if (!cues?.length) {
    die('Cannot --burn-subs: clipped subtitle file has no cues in this range');
  }

  if (await ffmpegHasFilter('subtitles')) {
    const args = [
      '-y',
      '-ss',
      String(start),
      '-i',
      sourcePath,
      '-t',
      String(duration),
      '-vf',
      `subtitles=filename='${escapeSubtitlesFilterPath(srtPath)}',setpts=PTS-STARTPTS`,
      '-af',
      'asetpts=PTS-STARTPTS',
      ...encode,
      output,
    ];
    console.log(`Burn method: ffmpeg subtitles filter`);
    console.log(`ffmpeg ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    await runFfmpeg(args);
    return;
  }

  if (!(await ffmpegHasFilter('overlay'))) {
    die(
      'Cannot --burn-subs: this ffmpeg build has neither the subtitles nor overlay filter. Install ffmpeg with libass (subtitles) support.',
    );
  }

  const magickOk = await runCmd('magick', ['-version'], { inherit: false })
    .then(() => true)
    .catch(() => false);
  if (!magickOk) {
    die(
      'Cannot --burn-subs: ffmpeg lacks the subtitles filter, and ImageMagick (`magick`) is not available for the overlay fallback.',
    );
  }

  console.log('Burn method: ImageMagick caption PNGs + ffmpeg overlay (no libass)');
  const { width, height } = await probeVideoSize(sourcePath);
  const font = captionFontPath();
  const overlayDir = await mkdtemp(path.join(tmpdir(), 'kericonf-subs-'));
  try {
    const pngs = [];
    for (let i = 0; i < cues.length; i++) {
      pngs.push(await renderCuePng({ cue: cues[i], index: i, width, height, outDir: overlayDir, font }));
    }

    const args = ['-y', '-ss', String(start), '-i', sourcePath];
    for (const png of pngs) args.push('-i', png);
    args.push('-t', String(duration));

    let filter = '';
    let last = '[0:v]';
    for (let i = 0; i < cues.length; i++) {
      const cue = cues[i];
      const outLabel = `[v${i}]`;
      // Commas inside enable= must be escaped because filter_complex uses commas as separators.
      const enable = `between(t\\,${cue.start.toFixed(3)}\\,${cue.end.toFixed(3)})`;
      filter += `${last}[${i + 1}:v]overlay=x=0:y=0:enable=${enable}${outLabel};`;
      last = outLabel;
    }
    // Reset PTS to 0 so messaging apps can grab a poster at t=0.
    filter += `${last}setpts=PTS-STARTPTS[vout]`;

    args.push(
      '-filter_complex',
      filter,
      '-map',
      '[vout]',
      '-map',
      '0:a?',
      '-af',
      'asetpts=PTS-STARTPTS',
      ...encode,
      output,
    );

    console.log(`ffmpeg ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    await runFfmpeg(args);
  } finally {
    await rm(overlayDir, { recursive: true, force: true });
  }
}

async function main() {
  let opts = parseArgs(process.argv.slice(2));
  if (opts.interactive) {
    opts = await runInteractiveMenu(opts);
  }
  validateClipOpts(opts);
  const clip = parseClipUrl(opts.url);
  const mediaRoot = opts.mediaRoot ? path.resolve(String(opts.mediaRoot).trim()) : null;

  const localIndex = mediaRoot ? galleryJoin(mediaRoot, clip.galleryPath, 'index.json') : null;
  const remoteIndex = new URL('index.json', clip.galleryUrl).href;
  console.log(`Gallery: ${clip.galleryUrl}`);
  console.log(
    `Looking up ${clip.videoId} (${clip.start}s → ${clip.end}s${clip.lang ? `, ${clip.lang}` : ''})`,
  );

  const index = await loadJson(remoteIndex, { preferLocalPath: localIndex });
  if (localIndex && (await fileExists(localIndex))) console.log(`Index: local ${localIndex}`);
  else console.log(`Index: ${remoteIndex}`);

  const video = findVideo(index, clip.videoId);
  console.log(`Talk: ${video.title}`);

  const output = path.resolve(
    opts.output || path.join(__dirname, 'clips', `${defaultClipBasename(clip)}.mp4`),
  );
  const srtOutput = output.replace(/\.mp4$/i, '') + '.srt';

  const subtitleText = await resolveSubtitleText({ clip, video, mediaRoot });
  let clippedCues = [];
  if (subtitleText !== null) {
    clippedCues = sliceSrt(parseSrt(subtitleText), clip.start, clip.end);
    await mkdir(path.dirname(srtOutput), { recursive: true });
    await writeFile(srtOutput, serializeSrt(clippedCues), 'utf8');
    console.log(
      `Wrote ${srtOutput} (${clippedCues.length} cue${clippedCues.length === 1 ? '' : 's'})`,
    );
  } else if (opts.burnSubs) {
    die('Cannot --burn-subs: no subtitle file available for this talk');
  }

  const source = await resolveSource({
    clip,
    video,
    mediaRoot,
    keepSource: opts.keepSource,
  });

  try {
    await makeClip({
      sourcePath: source.path,
      start: clip.start,
      duration: clip.duration,
      output,
      copy: opts.copy,
      burnSubs: opts.burnSubs,
      srtPath: clippedCues.length > 0 ? srtOutput : null,
      cues: clippedCues,
      quality: opts.quality,
    });
  } finally {
    if (source.cleanup) await source.cleanup();
  }

  console.log(`Wrote ${output}`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
