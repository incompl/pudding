#!/usr/bin/env node

/**
 * Generate one short tone per container/codec Pudding claims to play, so the
 * format-coverage checks in test-plan.md §2 are reproducible rather than
 * dependent on whatever happens to be in a personal music folder.
 *
 * Five of the eight formats on that line come out of macOS's own `afconvert`,
 * so the script always produces something. MP3 needs `lame` or `ffmpeg`; Ogg
 * Vorbis, Opus and raw ADTS need `ffmpeg`. Missing tools skip their files and
 * print an install hint instead of failing the run.
 *
 * The files carry no tags: Pudding falls back to the filename, which is the
 * point — the row reads `01 mp3` and the pitch rises with the number, so the
 * format playing is both visible and audible. These are synthetic, single
 * encoder-chain files, so they do NOT retire the "one real library (mixed
 * formats)" fixture the test plan asks for; real files in the wild carry VBR
 * headers, mixed ID3 revisions and odd channel layouts that this cannot.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SECONDS = 4;
const AMPLITUDE = 0.25; // Low enough that no lossy encoder clips on the peaks.
const FADE_MS = 20; // Avoids an edge click being read as a decode artifact.

// Stereo/44.1k unless a target says otherwise: mono/22050 sources stall or
// panic the decode pipeline (a real engine bug, noted in e2e/README.md), so
// that case is opt-in via --mono22k rather than part of a normal smoke pass.
const RATE = 44_100;
const CHANNELS = 2;

// A rising pentatonic run, one step per file, in the order test-plan.md §2
// lists the formats. Hearing the pitch climb confirms you are moving down the
// list and not replaying one row.
const targets = [
  { file: "01 mp3.mp3", hz: 220, needs: "mp3", build: encodeMp3 },
  { file: "02 flac.flac", hz: 247, needs: "afconvert", build: afconvert("flac", "flac") },
  { file: "03 wav.wav", hz: 262, needs: null, build: copySource },
  { file: "04 m4a aac.m4a", hz: 294, needs: "afconvert", build: afconvert("m4af", "aac@44100") },
  { file: "05 m4a alac.m4a", hz: 330, needs: "afconvert", build: afconvert("m4af", "alac") },
  { file: "06 ogg vorbis.ogg", hz: 349, needs: "vorbis", build: encodeVorbis },
  { file: "07 opus.opus", hz: 392, needs: "opus", build: encodeOpus },
  { file: "08 aiff.aiff", hz: 440, needs: "afconvert", build: afconvert("AIFF", "BEI16@44100") },

  // Extensions the scanner accepts (see ACCEPTED_EXTENSIONS in src-tauri/src/lib.rs)
  // that the eight-format line never exercises on its own.
  { file: "09 oga alias.oga", hz: 494, needs: "vorbis", build: encodeVorbis },
  { file: "10 aif alias.aif", hz: 523, needs: "afconvert", build: afconvert("AIFF", "BEI16@44100") },
  // Raw ADTS: no container, so no stored duration. The usual source of
  // duration and seek bugs.
  //
  // afconvert -f adts writes an MPEG-2 ADTS header (0xfff9, the ID bit set).
  // symphonia 0.5.5 registered only the MPEG-4 marker (0xfff1) and synced on
  // `sync != 0xfff1`, so this file probed to EOF and never played; 0.6 reads
  // all four ADTS markers. 15 covers the MPEG-4 flavour.
  { file: "11 aac adts.aac", hz: 587, needs: "afconvert", build: afconvert("adts", "aac@44100") },

  // For "Match Source Sample Rate on: play 44.1k then 96k".
  { file: "12 96k flac.flac", hz: 659, rate: 96_000, needs: "afconvert", build: afconvert("flac", "flac") },

  // For "A DRM/corrupt file errors with a message rather than silence or a hang".
  { file: "13 corrupt truncated.flac", hz: 698, needs: "afconvert", build: truncatedFlac },
  { file: "14 corrupt garbage.mp3", hz: 0, needs: null, build: garbageMp3 },
  // The other ADTS marker: ffmpeg writes MPEG-4 ADTS (0xfff1) where afconvert
  // writes MPEG-2 (see 11). Both occur in the wild and both must play; the
  // headers differ by one bit and carry identical AAC-LC payloads.
  { file: "15 aac adts mpeg4.aac", hz: 740, needs: "adts", build: encodeAdts },
];

// Opt-in, and last so a plain run's numbering never shifts.
const monoTarget = {
  file: "16 mono 22050.wav",
  hz: 740,
  rate: 22_050,
  channels: 1,
  needs: null,
  build: copySource,
};

function usage() {
  console.log(`Usage: node scripts/gen-format-library.mjs [--out DIR] [--mono22k]

Creates one short, untagged tone per audio format Pudding claims to play, for
the format-coverage checks in test-plan.md §2.

Options:
  -o, --out DIR  Output directory
                 (default: ~/Pudding Format Fixtures)
      --mono22k  Also write a mono/22050 file. Known to stall or panic the
                 decode pipeline, so it is left out by default.
  -h, --help     Show this help

macOS 'afconvert' covers wav, aiff, flac, m4a (AAC and ALAC) and raw AAC with
no extra tooling. MP3 needs 'lame' or 'ffmpeg'; Ogg Vorbis and Opus need
'ffmpeg' (brew install ffmpeg). Anything unavailable is skipped and listed.`);
}

function parseArgs(argv) {
  let out = path.join(homedir(), "Pudding Format Fixtures");
  let mono22k = false;
  for (let i = 0; i < argv.length; i += 1) {
    // pnpm forwards the conventional option separator to nested workspace
    // scripts, so accept it anywhere in the argument list.
    if (argv[i] === "--") continue;
    if (argv[i] === "-h" || argv[i] === "--help") {
      usage();
      process.exit(0);
    }
    if (argv[i] === "--mono22k") {
      mono22k = true;
      continue;
    }
    if (argv[i] === "-o" || argv[i] === "--out") {
      if (!argv[i + 1]) throw new Error(`${argv[i]} requires a directory`);
      out = argv[++i];
      continue;
    }
    if (argv[i].startsWith("-")) throw new Error(`unknown option: ${argv[i]}`);
    out = argv[i];
  }
  return { outDir: path.resolve(out), mono22k };
}

/** A 16-bit PCM sine with short fades, as a complete WAV file. */
function makeWav({ hz, rate = RATE, channels = CHANNELS }) {
  const frames = rate * SECONDS;
  const fade = Math.round((FADE_MS / 1000) * rate);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const envelope = Math.min(1, i / fade, (frames - 1 - i) / fade);
    const sample = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * AMPLITUDE * envelope * 32767);
    for (let c = 0; c < channels; c += 1) {
      data.writeInt16LE(sample, (i * channels + c) * 2);
    }
  }

  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28); // byte rate
  header.writeUInt16LE(channels * 2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function afconvert(container, dataFormat) {
  return async (src, dest) => {
    await run("/usr/bin/afconvert", ["-f", container, "-d", dataFormat, src, dest]);
  };
}

async function copySource(src, dest) {
  await writeFile(dest, await readFile(src));
}

async function encodeMp3(src, dest, tools) {
  if (tools.lame) {
    await run(tools.lame, ["--quiet", "-h", src, dest]);
    return;
  }
  await run(tools.ffmpeg, ffmpegArgs(src, ["-c:a", "libmp3lame", "-b:a", "192k"], dest));
}

async function encodeVorbis(src, dest, tools) {
  // Homebrew's ffmpeg is not always built with libvorbis; its own Vorbis
  // encoder is marked experimental, hence -strict -2.
  const codec = tools.libvorbis ? ["-c:a", "libvorbis"] : ["-c:a", "vorbis", "-strict", "-2"];
  await run(tools.ffmpeg, ffmpegArgs(src, codec, dest));
}

/** MPEG-4 ADTS (0xfff1). afconvert can only make the MPEG-2 flavour. */
async function encodeAdts(src, dest, tools) {
  await run(tools.ffmpeg, ffmpegArgs(src, ["-c:a", "aac"], dest));
}

async function encodeOpus(src, dest, tools) {
  await run(tools.ffmpeg, ffmpegArgs(src, ["-c:a", "libopus"], dest));
}

function ffmpegArgs(src, codec, dest) {
  return ["-nostdin", "-loglevel", "error", "-y", "-i", src, ...codec, dest];
}

/** Valid FLAC header, stream cut off mid-frame: decodes until it can't. */
async function truncatedFlac(src, dest) {
  const whole = path.join(path.dirname(dest), ".__truncate-source.flac");
  try {
    await afconvert("flac", "flac")(src, whole);
    const bytes = await readFile(whole);
    await writeFile(dest, bytes.subarray(0, Math.floor(bytes.length * 0.4)));
  } finally {
    await rm(whole, { force: true });
  }
}

/** An ID3v2 header the scanner will accept, followed by nothing decodable. */
async function garbageMp3(_src, dest) {
  const tagSize = 0x400;
  const header = Buffer.alloc(10);
  header.write("ID3", 0, "ascii");
  header[3] = 3; // v2.3
  header.writeUInt32BE(tagSize, 6); // synchsafe-clean: no byte exceeds 0x7f
  await writeFile(dest, Buffer.concat([header, Buffer.alloc(tagSize, 0x55), Buffer.alloc(2048, 0xa5)]));
}

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

/** Why a target can't be built here, or null if it can. */
function missingTool(needs, tools) {
  if (needs === "mp3" && !tools.lame && !tools.ffmpeg) return "needs lame or ffmpeg";
  if ((needs === "vorbis" || needs === "opus" || needs === "adts") && !tools.ffmpeg) {
    return "needs ffmpeg";
  }
  return null;
}

async function main() {
  const { outDir, mono22k } = parseArgs(process.argv.slice(2));
  const tools = await detectTools();
  const wanted = mono22k ? [...targets, monoTarget] : targets;

  await mkdir(outDir, { recursive: true });
  // Clear only this script's own names, so a rerun without --mono22k drops the
  // mono file and a rerun without a tool drops that tool's stale output.
  await Promise.all(
    [...targets, monoTarget].map((target) => rm(path.join(outDir, target.file), { force: true })),
  );

  const scratch = await mkdtemp(path.join(tmpdir(), "pudding-formats-"));
  const made = [];
  const skipped = [];
  try {
    for (const target of wanted) {
      const reason = missingTool(target.needs, tools);
      if (reason) {
        skipped.push([target.file, reason]);
        continue;
      }
      const src = path.join(scratch, `${target.hz}-${target.rate ?? RATE}-${target.channels ?? CHANNELS}.wav`);
      await writeFile(src, makeWav(target));
      const dest = path.join(outDir, target.file);
      try {
        await target.build(src, dest, tools);
        made.push(target);
      } catch (error) {
        await rm(dest, { force: true });
        skipped.push([target.file, (error.stderr || error.message || "encode failed").trim().split("\n").at(-1)]);
      }
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  if (made.length === 0) throw new Error("no fixtures could be generated");

  console.log(`Created ${made.length} format fixtures in:`);
  console.log(outDir);
  for (const target of made) {
    const rate = (target.rate ?? RATE) / 1000;
    const channels = (target.channels ?? CHANNELS) === 1 ? "mono" : "stereo";
    const detail = target.hz === 0 ? "undecodable by design" : `${target.hz} Hz, ${rate}k ${channels}`;
    console.log(`  ${target.file.padEnd(26)} ${detail}`);
  }
  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length}:`);
    for (const [file, reason] of skipped) console.log(`  ${file.padEnd(26)} ${reason}`);
    if (!tools.ffmpeg) console.log("\nInstall the rest with: brew install ffmpeg");
  }
  console.log("\nAdd this folder to Pudding's library, then play down the list in order.");
  console.log("Synthetic single-encoder files: still pair this with one real mixed-format library.");
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
