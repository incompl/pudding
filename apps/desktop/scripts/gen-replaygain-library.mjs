#!/usr/bin/env node

/**
 * Generate a set of ReplayGain-tagged tones for the volume-normalization check
 * in test-plan.md §2 ("ReplayGain off/track/album: level changes on a tagged
 * file, untagged file unchanged, no clipping on a hot file").
 *
 * Every file is the same 440 Hz tone for the same 4 seconds; only its recorded
 * level and its REPLAYGAIN_* tags differ. Each tag set states the gain that
 * brings that file to one common target level, which turns the folder into a
 * single audible assertion:
 *
 *   ReplayGain off   -> levels lurch from row to row
 *   ReplayGain track -> every tagged file lands on the same loudness
 *   ReplayGain album -> the album set (05-07) spreads back out, keeping the
 *                       dynamics it was mastered with
 *
 * Pitch is deliberately constant. Loudness judgements across different pitches
 * are not comparable (equal-loudness contours), so the rising scale that makes
 * the format library easy to follow would make this test unreadable by ear.
 *
 * The tags are written here rather than by a tagger: macOS ships no ReplayGain
 * writer, and the exact bytes are part of the test — a malformed figure and a
 * negative peak are two of the cases. FLAC (Vorbis comments) and M4A (iTunes
 * freeform atoms) are tagged in-process, so afconvert alone covers every
 * behavioural fixture. Files 16-18 exist only to prove the tags are also found
 * in the remaining containers, and those need lame or ffmpeg.
 *
 * What this cannot check is whether Pudding agrees with a real scanner's
 * loudness analysis — the figures here are chosen, not measured. Pair it with
 * the ReplayGain-tagged files in the real library fixture.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SECONDS = 4;
const HZ = 440;
const FADE_MS = 20; // Avoids an edge click being heard as a gain artifact.
const RATE = 44_100;
const CHANNELS = 2;

// The level every correctly normalized file should come out at: enough headroom
// below full scale for a gain-up fixture to reach it, and low enough that the
// lossy encoders in 16-18 don't clip their source.
const TARGET = 0.25;

const TRACK_GAIN = "REPLAYGAIN_TRACK_GAIN";
const TRACK_PEAK = "REPLAYGAIN_TRACK_PEAK";
const ALBUM_GAIN = "REPLAYGAIN_ALBUM_GAIN";
const ALBUM_PEAK = "REPLAYGAIN_ALBUM_PEAK";

/** A gain tag: a signed dB figure, suffixed " dB" as scanners write it. */
const fmtDb = (db, unit = " dB") => `${db < 0 ? "-" : "+"}${Math.abs(db).toFixed(2)}${unit}`;
/** A peak tag: a linear sample value, six decimals as scanners write it. */
const fmtPeak = (peak) => peak.toFixed(6);
/** The dB figure that brings a file recorded at `amp` to TARGET. */
const dbFor = (amp) => 20 * Math.log10(TARGET / amp);

const trackTags = (amp) => ({ [TRACK_GAIN]: fmtDb(dbFor(amp)), [TRACK_PEAK]: fmtPeak(amp) });

// The 05-07 "album": one album figure for all three, computed from the album's
// own level rather than each track's, and one album peak taken across the set.
// That is what makes album mode keep the quiet track quiet.
const ALBUM_LEVEL = 0.5;
const ALBUM_LOUDEST = 0.99;
const albumTags = (amp) => ({
  ...trackTags(amp),
  [ALBUM_GAIN]: fmtDb(dbFor(ALBUM_LEVEL)),
  [ALBUM_PEAK]: fmtPeak(ALBUM_LOUDEST),
});

const fixtures = [
  // The headline check: three files spread over 22 dB, each tagged with the
  // figure that flattens it. Off, they lurch; track, they match.
  { file: "01 loud file tagged down.flac", amp: 0.99, tags: trackTags(0.99) },
  { file: "02 target file tagged flat.flac", amp: TARGET, tags: trackTags(TARGET) },
  // 0.08 rather than a round 0.0625: that would ask for exactly +12.04 dB,
  // which is the 4x clamp 11 tests, and a fixture sitting on another one's
  // boundary makes both ambiguous.
  { file: "03 quiet file tagged up.flac", amp: 0.08, tags: trackTags(0.08) },
  // No tags at all: must play at its recorded level in every mode, and must
  // leave the Gain column blank.
  { file: "04 loud file untagged.flac", amp: 0.99, tags: null },

  // One album, three tracks: per-track figures that flatten them and a shared
  // album figure that leaves them 18 dB apart. This set is the only way to
  // tell track mode from album mode by ear.
  { file: "05 album disc t1 loud.flac", amp: 0.99, tags: albumTags(0.99) },
  { file: "06 album disc t2 mid.flac", amp: ALBUM_LEVEL, tags: albumTags(ALBUM_LEVEL) },
  { file: "07 album disc t3 quiet.flac", amp: 0.125, tags: albumTags(0.125) },
  // Track-scanned only. Album mode has no figure of its own to use, so it must
  // fall back to the track tags rather than leave the file alone.
  { file: "08 album tags absent.flac", amp: 0.99, tags: trackTags(0.99) },

  // Clip prevention. 09 asks for +12 dB on a file already peaking at 0.99, and
  // its peak tag must cap the boost at full scale. 10 asks for less but states
  // no peak, so nothing caps it: it distorts by design, which is the control
  // proving this output chain lets you hear clipping at all.
  {
    file: "09 hot gain capped by peak.flac",
    amp: 0.99,
    tags: { [TRACK_GAIN]: "+12.00 dB", [TRACK_PEAK]: fmtPeak(0.99) },
  },
  { file: "10 hot gain clips no peak.flac", amp: 0.99, tags: { [TRACK_GAIN]: "+3.00 dB" } },
  // A figure no scanner would produce (100x), with no peak to cap it. The
  // multiplier is clamped to 4x, so this must stay clean.
  { file: "11 absurd gain clamped.flac", amp: 0.05, tags: { [TRACK_GAIN]: "+40.00 dB" } },

  // Tags to ignore rather than act on: unreadable figure, and a peak that
  // taken at face value would invert the gain and silence the file.
  { file: "12 unparsable gain ignored.flac", amp: TARGET, tags: { [TRACK_GAIN]: "not a number" } },
  // A figure with no unit. Written by enough taggers to be worth parsing.
  {
    file: "13 gain without unit.flac",
    amp: 0.99,
    tags: { [TRACK_GAIN]: fmtDb(dbFor(0.99), ""), [TRACK_PEAK]: fmtPeak(0.99) },
  },
  {
    file: "14 negative peak ignored.flac",
    amp: TARGET,
    tags: { [TRACK_GAIN]: "+0.00 dB", [TRACK_PEAK]: "-0.500000" },
  },

  // The remaining containers, all carrying the same attenuation. These check
  // only that the tags are found where each format keeps them, so landing on
  // the same level as 02 is the whole pass condition.
  { file: "15 m4a itunes atom.m4a", amp: 0.5, tags: trackTags(0.5), build: buildM4a },
  { file: "16 mp3 id3v2 txxx.mp3", amp: 0.5, tags: trackTags(0.5), build: buildMp3, needs: "mp3" },
  { file: "17 ogg vorbis comment.ogg", amp: 0.5, tags: trackTags(0.5), build: buildOgg, needs: "ffmpeg" },
  { file: "18 opus tags.opus", amp: 0.5, tags: trackTags(0.5), build: buildOpus, needs: "ffmpeg" },
];

function usage() {
  console.log(`Usage: node scripts/gen-replaygain-library.mjs [--out DIR]

Creates one short 440 Hz tone per ReplayGain case — track and album gain, a
clip-capped hot file, malformed tags, an untagged control — for the ReplayGain
check in test-plan.md §2. Every tagged file is tagged with the figure that
brings it to the same level, so "ReplayGain track" should flatten the folder.

Options:
  -o, --out DIR  Output directory
                 (default: ~/Pudding ReplayGain Fixtures)
  -h, --help     Show this help

macOS 'afconvert' covers files 01-15, which is every behaviour under test.
Files 16-18 only re-check the tag mapping in the other containers: 16 needs
'lame' or 'ffmpeg', 17 and 18 need 'ffmpeg' (brew install ffmpeg). Anything
unavailable is skipped and listed.`);
}

function parseArgs(argv) {
  let out = path.join(homedir(), "Pudding ReplayGain Fixtures");
  for (let i = 0; i < argv.length; i += 1) {
    // pnpm forwards the conventional option separator to nested workspace
    // scripts, so accept it anywhere in the argument list.
    if (argv[i] === "--") continue;
    if (argv[i] === "-h" || argv[i] === "--help") {
      usage();
      process.exit(0);
    }
    if (argv[i] === "-o" || argv[i] === "--out") {
      if (!argv[i + 1]) throw new Error(`${argv[i]} requires a directory`);
      out = argv[++i];
      continue;
    }
    if (argv[i].startsWith("-")) throw new Error(`unknown option: ${argv[i]}`);
    out = argv[i];
  }
  return { outDir: path.resolve(out) };
}

/** A 16-bit PCM sine peaking at `amp`, with short fades, as a whole WAV file. */
function makeWav(amp) {
  const frames = RATE * SECONDS;
  const fade = Math.round((FADE_MS / 1000) * RATE);
  const data = Buffer.alloc(frames * CHANNELS * 2);
  for (let i = 0; i < frames; i += 1) {
    const envelope = Math.min(1, i / fade, (frames - 1 - i) / fade);
    const sample = Math.round(Math.sin((2 * Math.PI * HZ * i) / RATE) * amp * envelope * 32767);
    for (let c = 0; c < CHANNELS; c += 1) {
      data.writeInt16LE(sample, (i * CHANNELS + c) * 2);
    }
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * CHANNELS * 2, 28); // byte rate
  header.writeUInt16LE(CHANNELS * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// --- encoders -------------------------------------------------------------

async function buildFlac(src, dest, _tools, tags) {
  await run("/usr/bin/afconvert", ["-f", "flac", "-d", "flac", src, dest]);
  if (tags) await tagFlac(dest, tags);
}

async function buildM4a(src, dest, _tools, tags) {
  await run("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac@44100", src, dest]);
  if (tags) await tagM4a(dest, tags);
}

async function buildMp3(src, dest, tools, tags) {
  if (tools.lame) {
    // lame writes TXXX frames itself, so the no-ffmpeg path keeps this fixture.
    const frames = Object.entries(tags).flatMap(([key, value]) => ["--tv", `TXXX=${key}=${value}`]);
    await run(tools.lame, ["--quiet", "-h", "--add-id3v2", ...frames, src, dest]);
    return;
  }
  await run(tools.ffmpeg, ffmpegArgs(src, ["-c:a", "libmp3lame", "-b:a", "192k"], tags, dest));
}

async function buildOgg(src, dest, tools, tags) {
  // Homebrew's ffmpeg is not always built with libvorbis; its own Vorbis
  // encoder is marked experimental, hence -strict -2.
  const codec = tools.libvorbis ? ["-c:a", "libvorbis"] : ["-c:a", "vorbis", "-strict", "-2"];
  await run(tools.ffmpeg, ffmpegArgs(src, codec, tags, dest));
}

async function buildOpus(src, dest, tools, tags) {
  await run(tools.ffmpeg, ffmpegArgs(src, ["-c:a", "libopus"], tags, dest));
}

/** ffmpeg writes unknown metadata keys as Vorbis comments / ID3v2 TXXX frames. */
function ffmpegArgs(src, codec, tags, dest) {
  const meta = Object.entries(tags ?? {}).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
  return ["-nostdin", "-loglevel", "error", "-y", "-i", src, ...codec, ...meta, dest];
}

// --- FLAC: Vorbis comments ------------------------------------------------

const VORBIS_COMMENT = 4;

/**
 * Replace the ReplayGain lines in a FLAC file's VORBIS_COMMENT block, keeping
 * the vendor string and whatever else the encoder wrote (afconvert records a
 * channel mask). Metadata blocks sit between the "fLaC" magic and the first
 * audio frame, each behind a 4-byte header: one flag/type byte, then a 24-bit
 * big-endian length.
 */
async function tagFlac(file, tags) {
  const buf = await readFile(file);
  if (buf.subarray(0, 4).toString("ascii") !== "fLaC") throw new Error("not a FLAC stream");

  const blocks = [];
  let off = 4;
  for (;;) {
    const type = buf[off] & 0x7f;
    const last = (buf[off] & 0x80) !== 0;
    const length = buf.readUIntBE(off + 1, 3);
    blocks.push({ type, payload: buf.subarray(off + 4, off + 4 + length) });
    off += 4 + length;
    if (last) break;
  }
  const audio = buf.subarray(off);

  const at = blocks.findIndex((block) => block.type === VORBIS_COMMENT);
  const existing = at === -1 ? { vendor: "", comments: [] } : readComments(blocks[at].payload);
  const comments = existing.comments.filter((comment) => !/^REPLAYGAIN_/i.test(comment));
  for (const [key, value] of Object.entries(tags)) comments.push(`${key}=${value}`);
  const block = { type: VORBIS_COMMENT, payload: writeComments(existing.vendor, comments) };
  // STREAMINFO has to stay first; anything else can follow it.
  if (at === -1) blocks.splice(1, 0, block);
  else blocks[at] = block;

  const out = [Buffer.from("fLaC", "ascii")];
  blocks.forEach((each, i) => {
    const header = Buffer.alloc(4);
    header[0] = each.type | (i === blocks.length - 1 ? 0x80 : 0);
    header.writeUIntBE(each.payload.length, 1, 3);
    out.push(header, each.payload);
  });
  out.push(audio);
  await writeFile(file, Buffer.concat(out));
}

/** Vorbis comment payload: little-endian counts, "KEY=value" strings. */
function readComments(payload) {
  let off = 0;
  const vendorLength = payload.readUInt32LE(off);
  off += 4;
  const vendor = payload.subarray(off, off + vendorLength).toString("utf8");
  off += vendorLength;
  const count = payload.readUInt32LE(off);
  off += 4;
  const comments = [];
  for (let i = 0; i < count; i += 1) {
    const length = payload.readUInt32LE(off);
    off += 4;
    comments.push(payload.subarray(off, off + length).toString("utf8"));
    off += length;
  }
  return { vendor, comments };
}

function writeComments(vendor, comments) {
  const sized = (bytes) => {
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    return [length, bytes];
  };
  const count = Buffer.alloc(4);
  count.writeUInt32LE(comments.length);
  return Buffer.concat([
    ...sized(Buffer.from(vendor, "utf8")),
    count,
    ...comments.flatMap((comment) => sized(Buffer.from(comment, "utf8"))),
  ]);
}

// --- M4A: iTunes freeform atoms -------------------------------------------

const u32 = (value) => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(value);
  return buf;
};

function mp4Box(type, ...payload) {
  const body = Buffer.concat(payload);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, "latin1");
  return Buffer.concat([header, body]);
}

/** An iTunes freeform atom: a namespace, a key, and a UTF-8 (type 1) value. */
function freeform(name, value) {
  return mp4Box(
    "----",
    mp4Box("mean", u32(0), Buffer.from("com.apple.iTunes", "latin1")),
    mp4Box("name", u32(0), Buffer.from(name, "latin1")),
    mp4Box("data", u32(1), u32(0), Buffer.from(value, "utf8")),
  );
}

// The handler iTunes-style metadata is expected to carry, byte for byte as
// afconvert writes it (the trailing zeros are an empty handler name).
const ITUNES_HDLR = mp4Box("hdlr", u32(0), u32(0), Buffer.from("mdirappl", "latin1"), Buffer.alloc(10));

/** The boxes directly inside [start, end). */
function mp4Boxes(buf, start, end) {
  const found = [];
  let off = start;
  while (off + 8 <= end) {
    const size = buf.readUInt32BE(off);
    if (size < 8 || off + size > end) break;
    const type = buf.subarray(off + 4, off + 8).toString("latin1");
    // `meta` is a full box: four bytes of version/flags before its children.
    found.push({ type, start: off, size, contentStart: off + 8 + (type === "meta" ? 4 : 0) });
    off += size;
  }
  return found;
}

/** The chain of boxes down `wanted`, outermost first, or null if absent. */
function mp4Path(buf, wanted, start = 0, end = buf.length) {
  const chain = [];
  let scope = { contentStart: start, start, size: end - start };
  for (const type of wanted) {
    const box = mp4Boxes(buf, scope.contentStart, scope.start + scope.size).find((b) => b.type === type);
    if (!box) return null;
    chain.push(box);
    scope = box;
  }
  return chain;
}

/**
 * Append ReplayGain atoms to an M4A's metadata. afconvert already writes the
 * moov/udta/meta/ilst tree (with an iTunSMPB atom for gapless), so this
 * normally just appends inside `ilst` and widens every box it grew.
 */
async function tagM4a(file, tags) {
  let buf = await readFile(file);
  // lofty looks these up case-insensitively, but every tagger writes the MP4
  // freeform keys in lower case.
  const atoms = Buffer.concat(
    Object.entries(tags).map(([key, value]) => freeform(key.toLowerCase(), value)),
  );

  const ilstChain = mp4Path(buf, ["moov", "udta", "meta", "ilst"]);
  let grown;
  let insertAt;
  let payload;
  if (ilstChain) {
    grown = ilstChain;
    const ilst = ilstChain.at(-1);
    insertAt = ilst.start + ilst.size;
    payload = atoms;
  } else {
    const moovChain = mp4Path(buf, ["moov"]);
    if (!moovChain) throw new Error("no moov box to tag");
    grown = moovChain;
    const moov = moovChain[0];
    insertAt = moov.start + moov.size;
    payload = mp4Box("udta", mp4Box("meta", u32(0), ITUNES_HDLR, mp4Box("ilst", atoms)));
  }

  const delta = payload.length;
  buf = Buffer.concat([buf.subarray(0, insertAt), payload, buf.subarray(insertAt)]);
  // Every box the atoms landed inside got bigger. All of them start before the
  // insertion point, so their headers are still at the offsets just read.
  for (const box of grown) buf.writeUInt32BE(box.size + delta, box.start);
  shiftChunkOffsets(buf, insertAt, delta);
  await writeFile(file, buf);
}

/**
 * Chunk offsets in stco/co64 are absolute file offsets, so every one past the
 * inserted bytes has moved. afconvert leaves a `free` box after `moov` that
 * could absorb the growth instead, but patching the offsets is correct whether
 * or not that padding is there — and whichever side of `moov` the audio is on.
 */
function shiftChunkOffsets(buf, insertAt, delta) {
  const moovChain = mp4Path(buf, ["moov"]);
  if (!moovChain) return;
  const moov = moovChain[0];
  const traks = mp4Boxes(buf, moov.contentStart, moov.start + moov.size).filter((b) => b.type === "trak");
  for (const trak of traks) {
    const stblChain = mp4Path(buf, ["mdia", "minf", "stbl"], trak.contentStart, trak.start + trak.size);
    if (!stblChain) continue;
    const stbl = stblChain.at(-1);
    for (const box of mp4Boxes(buf, stbl.contentStart, stbl.start + stbl.size)) {
      if (box.type !== "stco" && box.type !== "co64") continue;
      const count = buf.readUInt32BE(box.contentStart + 4); // after version/flags
      let at = box.contentStart + 8;
      for (let i = 0; i < count; i += 1) {
        if (box.type === "stco") {
          const offset = buf.readUInt32BE(at);
          if (offset >= insertAt) buf.writeUInt32BE(offset + delta, at);
          at += 4;
        } else {
          const offset = buf.readBigUInt64BE(at);
          if (offset >= BigInt(insertAt)) buf.writeBigUInt64BE(offset + BigInt(delta), at);
          at += 8;
        }
      }
    }
  }
}

// --- expected levels ------------------------------------------------------

// A mirror of replaygain_multiplier/replaygain_gain in src-tauri/src/audio.rs,
// so the printed table says what the engine should do with these exact tags.
// Keep the two in step: a row that reads wrong here is a bug in the fixture,
// not in the app.
function rgMultiplier(tags, mode) {
  if (mode === 0 || !tags) return 1;
  // A gain tag is a signed dB figure, usually suffixed " dB".
  const gainOf = (key) => {
    const raw = tags[key];
    if (raw === undefined) return null;
    const trimmed = raw.trim().replace(/[A-Za-z]+$/, "").trim();
    return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed) ? Number(trimmed) : null;
  };
  // A peak tag is a linear sample value; non-positive values are ignored.
  const peakOf = (key) => {
    const raw = tags[key];
    if (raw === undefined) return null;
    const value = /^[+-]?(\d+\.?\d*|\.\d+)$/.test(raw.trim()) ? Number(raw.trim()) : null;
    return value !== null && value > 0 ? value : null;
  };

  const album = mode === 2;
  const gainDb = album ? (gainOf(ALBUM_GAIN) ?? gainOf(TRACK_GAIN)) : gainOf(TRACK_GAIN);
  const peak = album ? (peakOf(ALBUM_PEAK) ?? peakOf(TRACK_PEAK)) : peakOf(TRACK_PEAK);
  if (gainDb === null) return 1;

  let gain = 10 ** (gainDb / 20);
  if (peak !== null) gain = Math.min(gain, 1 / peak); // never let gain*peak clip
  return Math.min(Math.max(gain, 0), 4); // guard against absurd tags
}

// --- tools ----------------------------------------------------------------

async function which(tool) {
  try {
    const { stdout } = await run("/usr/bin/which", [tool]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function detectTools() {
  const [lame, ffmpeg] = await Promise.all([which("lame"), which("ffmpeg")]);
  let libvorbis = false;
  if (ffmpeg) {
    try {
      const { stdout } = await run(ffmpeg, ["-hide_banner", "-encoders"]);
      libvorbis = /^\s*\S+\s+libvorbis\s/m.test(stdout);
    } catch {
      // Keep the native-encoder fallback; the encode step reports a real failure.
    }
  }
  return { lame, ffmpeg, libvorbis };
}

/** Why a fixture can't be built here, or null if it can. */
function missingTool(needs, tools) {
  if (needs === "mp3" && !tools.lame && !tools.ffmpeg) return "needs lame or ffmpeg";
  if (needs === "ffmpeg" && !tools.ffmpeg) return "needs ffmpeg";
  return null;
}

// --- main -----------------------------------------------------------------

async function main() {
  const { outDir } = parseArgs(process.argv.slice(2));
  const tools = await detectTools();

  await mkdir(outDir, { recursive: true });
  // Clear only this script's own names, so a rerun without a tool drops that
  // tool's stale output rather than leaving a file that no longer matches.
  await Promise.all(fixtures.map((fixture) => rm(path.join(outDir, fixture.file), { force: true })));

  const scratch = await mkdtemp(path.join(tmpdir(), "pudding-replaygain-"));
  const made = [];
  const skipped = [];
  try {
    for (const fixture of fixtures) {
      const reason = missingTool(fixture.needs, tools);
      if (reason) {
        skipped.push([fixture.file, reason]);
        continue;
      }
      const src = path.join(scratch, `${fixture.amp}.wav`);
      await writeFile(src, makeWav(fixture.amp));
      const dest = path.join(outDir, fixture.file);
      try {
        await (fixture.build ?? buildFlac)(src, dest, tools, fixture.tags);
        made.push(fixture);
      } catch (error) {
        await rm(dest, { force: true });
        const detail = (error.stderr || error.message || "encode failed").trim().split("\n").at(-1);
        skipped.push([fixture.file, detail]);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  if (made.length === 0) throw new Error("no fixtures could be generated");
  report(outDir, made, skipped, tools);
}

function report(outDir, made, skipped, tools) {
  const width = Math.max(...made.map((fixture) => fixture.file.length));
  console.log(`Created ${made.length} ReplayGain fixtures in:`);
  console.log(outDir);
  console.log("\nPeak each file should play at, by ReplayGain mode:");
  console.log(`  ${"file".padEnd(width)}  ${"off".padStart(6)}${"track".padStart(8)}${"album".padStart(8)}`);
  for (const fixture of made) {
    const cells = [0, 1, 2]
      .map((mode) => (fixture.amp * rgMultiplier(fixture.tags, mode)).toFixed(2).padStart(mode === 0 ? 6 : 8))
      .join("");
    console.log(`  ${fixture.file.padEnd(width)}  ${cells}`);
  }

  if (skipped.length > 0) {
    const skipWidth = Math.max(...skipped.map(([file]) => file.length));
    console.log(`\nSkipped ${skipped.length}:`);
    for (const [file, reason] of skipped) console.log(`  ${file.padEnd(skipWidth)}  ${reason}`);
    if (!tools.ffmpeg) console.log("\nInstall the rest with: brew install ffmpeg");
  }

  console.log(`
Add this folder to Pudding's library and play down it in each ReplayGain mode
(Playback menu). Anything above 1.00 clips, and only 10 should:

  off    nothing is touched: 01 blares, 03 is nearly inaudible
  track  every tagged file flattens to 0.25 — the exceptions are 04 (no tags),
         09/10/11 (hot files, see their names) and 12/14 (tags to ignore)
  album  05-07 spread back out, keeping the album's own dynamics, while 08
         does not move: it has only track tags for album mode to fall back to

09 is meant to land exactly at full scale: that is its peak tag capping a
boost that would otherwise have overshot. The Gain column shows the track
figure as the file states it, not the multiplier playback applies, so it must
read blank for 04 and 12 and ${fmtDb(dbFor(0.99), "")} for both 01 and 13.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
