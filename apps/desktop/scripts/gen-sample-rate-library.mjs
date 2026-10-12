#!/usr/bin/env node

/**
 * Generate one short tone per sample-rate case for the output-rate check in
 * test-plan.md §2 ("Match Source Sample Rate on: play 44.1k then 96k, device
 * rate follows, rate restored on quit").
 *
 * Every file is the same 440 Hz tone for the same 4 seconds; only the rate it
 * is recorded at differs. Constant pitch is the assertion, not a convenience:
 * a correct chain reproduces the same note whatever rate the file is in and
 * whatever rate the device ends up at, so a row that comes out high or low is
 * audio going to the device at a rate it wasn't resampled to. The rising scale
 * that makes the format library easy to follow would hide exactly that.
 *
 * The second audible signal is the gaps. A switch tears the output stream
 * down, sets the device rate and builds another, with ~200ms of pre-roll
 * silence ahead of the track — so playing down the folder you should hear a
 * pause before every row whose device rate differs from the row before, and
 * none before the rows that don't move. Files 12-15 are two deliberate joins
 * that pin that down: one continuous tone split across a same-rate pair (must
 * join clean) and the same tone split across a rate change (must not).
 *
 * Which rate each file lands on depends on what the output device advertises,
 * so the script reads the device's rate list out of Pudding's own log and
 * prints the target per file, mirroring choose_output_rate in audio.rs.
 *
 * What this cannot check is the one gate with no fixture: a container that
 * never declares its rate, which suppresses the switch entirely. Nothing
 * afconvert or ffmpeg writes leaves the rate out — that path is covered by
 * `real_files_drive_the_decision_end_to_end` in audio.rs instead.
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

const SECONDS = 4;
const HZ = 440;
const AMPLITUDE = 0.25; // Low enough that no lossy encoder clips on the peaks.
const FADE_MS = 20; // Avoids an edge click being read as a switch artifact.
const CHANNELS = 2;

// Mirrors MAX_FOLLOW_RATE in audio.rs: the ceiling on the whole-multiple rule.
const MAX_FOLLOW_RATE = 192_000;

// The rates the built-in output on an Apple-silicon Mac advertises, used when
// Pudding's log can't be read. Same list as BUILTIN in the audio.rs tests.
const FALLBACK_RATES = [44_100, 48_000, 88_200, 96_000];
const FALLBACK_DEVICE_RATE = 48_000;

const PUDDING_LOG_DIR = path.join(homedir(), "Library", "Logs", "com.incompl.pudding");

// Where the two join pairs are spliced: four seconds plus a quarter cycle, so
// the splice lands on the waveform's peak. Four whole seconds of a 440 Hz tone
// is 1760 whole cycles, which would put both sides of the join at a zero
// crossing — and the failure this join is looking for is inserted silence,
// which at a zero crossing is a transition from nothing to nothing. At the peak
// the same silence is a full-amplitude step, and so is a restart from phase
// zero. It costs the ability to hear a slip of a few samples, where the slope
// is what carries, but a few samples is not what a rate switch costs.
const SPLIT_SECONDS = SECONDS + 1 / (4 * HZ);

const fixtures = [
  // The rates an output device normally offers, so each row should put the
  // device at its own rate. The 44.1 -> 48 step in 01-02 is the one switch
  // every machine can do, and the pair the test-plan line asks for is 01 -> 04.
  { file: "01 44100 Hz.flac", rate: 44_100 },
  { file: "02 48000 Hz.flac", rate: 48_000 },
  { file: "03 88200 Hz.flac", rate: 88_200 },
  { file: "04 96000 Hz.flac", rate: 96_000 },
  // Past what built-in output does: on most Macs these fall back to the
  // device's own default rate, which is the point — an unfollowable file
  // leaves the device where its owner had it. On a DAC that offers them, they
  // are followed. The printed table says which happened here.
  { file: "05 176400 Hz.flac", rate: 176_400 },
  { file: "06 192000 Hz.flac", rate: 192_000 },

  // Rates no device offers, where the whole-multiple rule takes over. An exact
  // integer ratio keeps the content inside its own family rather than crossing
  // 44.1 <-> 48, so these must land on 44.1k and 48k respectively — not on
  // whatever the device happened to be sitting at.
  { file: "07 22050 Hz doubles.flac", rate: 22_050 },
  { file: "08 24000 Hz doubles.flac", rate: 24_000 },
  { file: "09 11025 Hz quadruples.flac", rate: 11_025 },
  // 37.8k (CD-ROM XA) has no exact match and no whole multiple on any normal
  // rate list: 75.6k, 113.4k, 151.2k and 189k are nobody's supported rates.
  { file: "10 37800 Hz no multiple.flac", rate: 37_800 },
  // 352.8k (DXD) is in the 44.1 family but its only whole multiples are above
  // the 192k cap, so the multiple rule declines it too.
  { file: "11 352800 Hz above the cap.flac", rate: 352_800 },

  // One continuous tone cut in two at the same rate. No switch happens between
  // them, so this join is the ordinary gapless join and must have no gap and no
  // click — the feature being on must not cost anything where the rate holds.
  { file: "12 same rate join a.flac", rate: 44_100, half: "a" },
  { file: "13 same rate join b.flac", rate: 44_100, half: "b", from: 44_100 },
  // The same tone cut in two across a rate change, as the control: the device
  // is reconfigured mid-tone, so this one must break. Hearing 14-15 gap and
  // 12-13 not is how you tell a rate switch from a gapless-playback bug.
  { file: "14 cross rate join a.flac", rate: 44_100, half: "a" },
  { file: "15 cross rate join b.flac", rate: 96_000, half: "b", from: 44_100 },

  // The rate read from each of the other containers. Pudding switches on what
  // the container declares, so these check the declaration is found at all —
  // landing on the rate in the name is the whole pass condition.
  { file: "16 m4a alac 96000 Hz.m4a", rate: 96_000, build: afconvert("m4af", "alac") },
  { file: "17 m4a aac 48000 Hz.m4a", rate: 48_000, build: afconvert("m4af", "aac@48000") },
  { file: "18 aiff 88200 Hz.aiff", rate: 88_200, build: afconvert("AIFF", "BEI16@88200") },
  { file: "19 wav 192000 Hz.wav", rate: 192_000, build: copySource },
  { file: "20 mp3 48000 Hz.mp3", rate: 48_000, build: encodeMp3, needs: "mp3" },
  { file: "21 ogg vorbis 96000 Hz.ogg", rate: 96_000, build: encodeVorbis, needs: "ffmpeg" },
  // Opus has no other rate: every stream decodes at 48k whatever went in. So a
  // 44.1k source must send the device to 48k, and the Sample Rate column must
  // read 48 kHz — the file's history is not what the engine follows.
  {
    file: "22 opus 48000 Hz from 44100 source.opus",
    rate: 44_100,
    declared: 48_000,
    build: encodeOpus,
    needs: "ffmpeg",
  },

  // 24-bit/96k: the hi-res case behind the bit-perfect claim in README.md, and
  // a check that the rate path doesn't disturb the sample width on the way.
  { file: "23 24 bit 96000 Hz.flac", rate: 96_000, bits: 24 },
];

function usage() {
  console.log(`Usage: node scripts/gen-sample-rate-library.mjs [--out DIR]
                                            [--rates LIST] [--device-rate HZ]

Creates one short 440 Hz tone per sample-rate case — the rates a device
offers, the rates it doesn't, two deliberate track joins and the rate as each
container declares it — for the "Match Source Sample Rate" check in
test-plan.md §2. Every file is the same note, so any row that plays sharp or
flat is audio reaching the device at a rate nothing resampled it to.

Options:
  -o, --out DIR        Output directory
                       (default: ~/Pudding Sample Rate Fixtures)
      --rates LIST     Comma-separated rates the output device supports, used
                       to predict the target rate per file. Default: read from
                       the newest 'switchable=[...]' line in
                       ~/Library/Logs/com.incompl.pudding/Pudding.log,
                       else ${FALLBACK_RATES.join(", ")}.
      --device-rate HZ Rate the device is sitting at before the first file
                       (its default, and where restore-on-quit should land).
                       Read from the same log line by default.
  -h, --help           Show this help

macOS 'afconvert' covers files 01-19 and 23, which is every rate-selection
case under test. 20 needs 'lame' or 'ffmpeg'; 21 and 22 need 'ffmpeg'
(brew install ffmpeg). Anything unavailable is skipped and listed.`);
}

function parseArgs(argv) {
  let out = path.join(homedir(), "Pudding Sample Rate Fixtures");
  let rates = null;
  let deviceRate = null;
  for (let i = 0; i < argv.length; i += 1) {
    // pnpm forwards the conventional option separator to nested workspace
    // scripts, so accept it anywhere in the argument list.
    if (argv[i] === "--") continue;
    if (argv[i] === "-h" || argv[i] === "--help") {
      usage();
      process.exit(0);
    }
    if (argv[i] === "--rates") {
      if (!argv[i + 1]) throw new Error("--rates requires a comma-separated list");
      rates = argv[++i]
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
      if (rates.length === 0) throw new Error("--rates listed no usable rates");
      continue;
    }
    if (argv[i] === "--device-rate") {
      deviceRate = Number(argv[++i]);
      if (!Number.isFinite(deviceRate) || deviceRate <= 0) {
        throw new Error("--device-rate requires a rate in Hz");
      }
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
  return { outDir: path.resolve(out), rates, deviceRate };
}

// --- the device's rate list -----------------------------------------------

/**
 * The rates the output device can be switched to, and the rate it was found
 * at. Pudding logs both at startup ("audio: device=... rate=48000 ...
 * switchable=[44100, 48000, ...]"), which beats guessing: the prediction table
 * below is only as good as this list. Last line wins — it is the most recent
 * launch, and the device may have changed since an older one.
 */
async function deviceRatesFromLog() {
  let names;
  try {
    names = (await readdir(PUDDING_LOG_DIR)).filter((name) => name.endsWith(".log"));
  } catch {
    return null;
  }
  let found = null;
  for (const name of names) {
    let text;
    try {
      text = await readFile(path.join(PUDDING_LOG_DIR, name), "utf8");
    } catch {
      continue;
    }
    const pattern = /audio: device=(.*?) rate=(\d+).*? switchable=\[([\d, ]*)\]/g;
    for (const match of text.matchAll(pattern)) {
      const rates = match[3]
        .split(",")
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isFinite(value) && value > 0)
        .sort((a, b) => a - b);
      if (rates.length > 0) {
        found = { name: match[1], deviceRate: Number(match[2]), rates };
      }
    }
  }
  return found;
}

// --- the engine's choice --------------------------------------------------

/**
 * A mirror of choose_output_rate in src-tauri/src/audio.rs, so the printed
 * table says what the engine should do with these exact files on this exact
 * device. Keep the two in step: a row that reads wrong here is a bug in the
 * fixture, not in the app.
 */
function chooseOutputRate(rates, contentRate, current, defaultRate) {
  if (rates.length === 0 || contentRate === 0) return current;
  if (rates.includes(contentRate)) return contentRate;
  const multiple = rates.find(
    (rate) => rate > contentRate && rate % contentRate === 0 && rate <= MAX_FOLLOW_RATE,
  );
  if (multiple !== undefined) return multiple;
  if (rates.includes(defaultRate)) return defaultRate;
  return rates.find((rate) => rate >= contentRate) ?? rates[rates.length - 1];
}

/** Why that rate was chosen, for the table's last column. */
function chooseReason(rates, contentRate) {
  if (rates.includes(contentRate)) return "followed";
  const multiple = rates.find(
    (rate) => rate > contentRate && rate % contentRate === 0 && rate <= MAX_FOLLOW_RATE,
  );
  if (multiple !== undefined) return `${multiple / contentRate}x multiple`;
  return "device default";
}

// --- sources --------------------------------------------------------------

const bytesPerSample = (bits) => bits / 8;

/**
 * A PCM sine at HZ, as a complete WAV file. Written as a function of absolute
 * time rather than of frame index, so a tone can be cut into two files at a
 * chosen instant and resume there at a different rate with its phase intact —
 * which is what makes the join fixtures meaningful.
 */
function makeWav({ rate, bits = 16, frames, startTime = 0, fadeIn = true, fadeOut = true }) {
  const width = bytesPerSample(bits);
  const peak = 2 ** (bits - 1) - 1;
  const fade = Math.round((FADE_MS / 1000) * rate);
  const data = Buffer.alloc(frames * CHANNELS * width);
  for (let i = 0; i < frames; i += 1) {
    const envelope = Math.min(
      1,
      fadeIn ? i / fade : Infinity,
      fadeOut ? (frames - 1 - i) / fade : Infinity,
    );
    const value = Math.sin(2 * Math.PI * HZ * (startTime + i / rate)) * AMPLITUDE * envelope;
    const sample = Math.round(value * peak);
    for (let c = 0; c < CHANNELS; c += 1) {
      const at = (i * CHANNELS + c) * width;
      if (bits === 16) data.writeInt16LE(sample, at);
      else data.writeIntLE(sample, at, width);
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
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * CHANNELS * width, 28); // byte rate
  header.writeUInt16LE(CHANNELS * width, 32); // block align
  header.writeUInt16LE(bits, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** The frame the splice falls on, for a first half recorded at `rate`. */
const splitFrames = (rate) => Math.round(SPLIT_SECONDS * rate);

/** The WAV parameters for one fixture: a whole tone, or one half of a join. */
function sourceFor(fixture) {
  const rate = fixture.rate;
  const bits = fixture.bits ?? 16;
  if (fixture.half === "a") {
    // Fades in, but not out: the tone is cut off mid-peak for its other half
    // to continue. A fade here would be an engine-independent gap.
    return { rate, bits, frames: splitFrames(rate), fadeIn: true, fadeOut: false };
  }
  if (fixture.half === "b") {
    // Resumes at the instant its own first half ended — which is a frame count
    // on the FIRST half's grid, hence `from`.
    return {
      rate,
      bits,
      frames: Math.round(SECONDS * rate),
      startTime: splitFrames(fixture.from) / fixture.from,
      fadeIn: false,
      fadeOut: true,
    };
  }
  return { rate, bits, frames: Math.round(SECONDS * rate) };
}

/** A cache key: two fixtures wanting identical PCM share one scratch file. */
const sourceKey = (source) =>
  [source.rate, source.bits, source.frames, source.startTime ?? 0, source.fadeIn !== false, source.fadeOut !== false].join("-");

// --- encoders -------------------------------------------------------------

function afconvert(container, dataFormat) {
  return async (src, dest) => {
    await run("/usr/bin/afconvert", ["-f", container, "-d", dataFormat, src, dest]);
  };
}

/** FLAC, the default: `-d flac` keeps both the source rate and its bit depth. */
const encodeFlac = afconvert("flac", "flac");

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
  // encoder is marked experimental, hence -strict -2. Both keep the input rate.
  const codec = tools.libvorbis ? ["-c:a", "libvorbis"] : ["-c:a", "vorbis", "-strict", "-2"];
  await run(tools.ffmpeg, ffmpegArgs(src, codec, dest));
}

async function encodeOpus(src, dest, tools) {
  await run(tools.ffmpeg, ffmpegArgs(src, ["-c:a", "libopus"], dest));
}

function ffmpegArgs(src, codec, dest) {
  return ["-nostdin", "-loglevel", "error", "-y", "-i", src, ...codec, dest];
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
  const args = parseArgs(process.argv.slice(2));
  const tools = await detectTools();
  const logged = args.rates && args.deviceRate ? null : await deviceRatesFromLog();
  const device = {
    rates: args.rates ?? logged?.rates ?? FALLBACK_RATES,
    deviceRate: args.deviceRate ?? logged?.deviceRate ?? FALLBACK_DEVICE_RATE,
    name: logged?.name ?? null,
    guessed: !args.rates && !logged,
  };

  await mkdir(args.outDir, { recursive: true });
  // Clear only this script's own names, so a rerun without a tool drops that
  // tool's stale output rather than leaving a file that no longer matches.
  await Promise.all(fixtures.map((fixture) => rm(path.join(args.outDir, fixture.file), { force: true })));

  const scratch = await mkdtemp(path.join(tmpdir(), "pudding-sample-rate-"));
  const made = [];
  const skipped = [];
  try {
    const sources = new Map();
    for (const fixture of fixtures) {
      const reason = missingTool(fixture.needs, tools);
      if (reason) {
        skipped.push([fixture.file, reason]);
        continue;
      }
      const source = sourceFor(fixture);
      const key = sourceKey(source);
      let src = sources.get(key);
      if (!src) {
        src = path.join(scratch, `${key}.wav`);
        await writeFile(src, makeWav(source));
        sources.set(key, src);
      }
      const dest = path.join(args.outDir, fixture.file);
      try {
        await (fixture.build ?? encodeFlac)(src, dest, tools);
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
  report(args.outDir, made, skipped, tools, device);
}

// 48000 -> "48k", 44100 -> "44.1k", 11025 -> "11.025k". Never rounded: the
// whole-multiple rows only make sense against the exact rate.
const khz = (rate) => `${Number((rate / 1000).toFixed(3))}k`;

function report(outDir, made, skipped, tools, device) {
  console.log(`Created ${made.length} sample-rate fixtures in:`);
  console.log(outDir);

  const origin = device.guessed
    ? "no Pudding log found — assuming built-in output"
    : device.name
      ? `from ${device.name} in Pudding's log`
      : "as given on the command line";
  console.log(`\nDevice rates: ${device.rates.map(khz).join(" ")} (${origin})`);
  console.log(`Sitting at:   ${khz(device.deviceRate)} — where quitting should put it back`);

  // Walk the list the way playback does, carrying the running device rate
  // forward, so the switch column marks exactly where a gap is expected.
  const width = Math.max(...made.map((fixture) => fixture.file.length));
  console.log("\nWhat each file should do, played top to bottom:");
  console.log(`  ${"file".padEnd(width)}  ${"rate".padStart(7)}  ${"device".padStart(7)}  switch  why`);
  let current = device.deviceRate;
  for (const fixture of made) {
    const content = fixture.declared ?? fixture.rate;
    const target = chooseOutputRate(device.rates, content, current, device.deviceRate);
    const moves = target !== current;
    const cells = [
      fixture.file.padEnd(width),
      khz(content).padStart(7),
      khz(target).padStart(7),
      (moves ? "yes" : "-").padStart(6),
      chooseReason(device.rates, content),
    ];
    console.log(`  ${cells.join("  ")}`);
    current = target;
  }

  if (skipped.length > 0) {
    const skipWidth = Math.max(...skipped.map(([file]) => file.length));
    console.log(`\nSkipped ${skipped.length}:`);
    for (const [file, reason] of skipped) console.log(`  ${file.padEnd(skipWidth)}  ${reason}`);
    if (!tools.ffmpeg) console.log("\nInstall the rest with: brew install ffmpeg");
  }

  console.log(`
Add this folder to Pudding's library, turn on Playback > Match Source Sample
Rate, and play down it. Every file is the same 440 Hz note, so:

  pitch   must not change, in any row. A row that plays low or high is audio
          going out at a rate nothing converted it to
  gaps    a pause before every row the switch column marks 'yes', and none
          before the rest. 12-13 are a same-rate join and must sound like one
          unbroken tone; 14-15 are the same tone across a switch and must not
  column  Sample Rate reads the rate column above, not the device column — it
          is a fact about the file. 22 is the one to look at: a 44.1k source,
          but Opus has no rate but 48k, and both the column and the device
          follow what the stream declares, not where it came from
  device  check it against the device column in Audio MIDI Setup, or against
          the 'audio: output rate X -> Y Hz' lines in Pudding's log

Then turn the setting off and play 01 and 04 again: the device must stay put
and both must still sound like the same note, now resampled. Quit while a
non-default rate is running and the device must come back to ${khz(device.deviceRate)}.

These are synthetic tones on one machine's rate list. They prove the rate is
read, chosen and switched to; they can't prove the switch is inaudible on a
device whose driver takes its time, so run the real library over a DAC too.`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
