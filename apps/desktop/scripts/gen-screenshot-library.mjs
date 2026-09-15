#!/usr/bin/env node

/**
 * Generate a deterministic, dependency-free music library for screenshots.
 *
 * The WAVs contain a short, quiet tone followed by low-rate PCM silence, so
 * their displayed durations look realistic without needing an audio encoder.
 * Each file carries ID3v2 metadata and, as its embedded album art, one of the
 * photographs tracked in apps/desktop/images: real artwork rather than
 * generated pixels, because these covers are what the published screenshots
 * show at hero size.
 */

import { constants } from "node:fs";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 8_000;
const BYTES_PER_SAMPLE = 2;
const PREVIEW_SECONDS = 4;

// Five albums share one photograph. "A Little Nugget of Universe" carries its own because the
// website's homepage screenshot is the one scene that restores that album
// (HERO_ALBUM in e2e/screenshots/scenes.mjs), precisely so the hero's cover is
// not the cover every documentation image already shows.
const ART_DIR = fileURLToPath(new URL("../images/", import.meta.url));
const DEFAULT_COVER = "sample album art 1.jpg";
const HERO_COVER = "sample album art 2.jpg";

const albums = [
  {
    artist: "Mara Venn",
    album: "Static Gardens",
    year: 2026,
    genre: "Electronic",
    tracks: [
      ["Glass Elevator", 198],
      ["Moss Circuit", 244],
      ["After Rain", 221],
      ["Soft Relay", 267],
      ["The Last Green Light", 312],
    ],
  },
  {
    artist: "North Window",
    album: "Weather for Satellites",
    year: 2025,
    genre: "Ambient",
    tracks: [
      ["Low Orbit", 286],
      ["Cloud Index", 259],
      ["Antenna Bloom", 333],
      ["Clear Night", 301],
      ["Telemetry Sleep", 378],
    ],
  },
  {
    artist: "The Small Hours Club",
    album: "Borrowed Light",
    year: 2024,
    genre: "Jazz",
    tracks: [
      ["Half Past Blue", 235],
      ["Corner Table", 272],
      ["A Minor Favor", 219],
      ["Streetlamp Standard", 291],
      ["Closing Time Again", 326],
    ],
  },
  {
    artist: "Fictional People",
    album: "A Little Nugget of Universe",
    year: 2023,
    genre: "Indie Pop",
    cover: HERO_COVER,
    tracks: [
      ["Nothingness But Shining", 203],
      ["Peach Season", 189],
      ["Almost Symmetrical", 226],
      ["Sunday Diagram", 248],
      ["Good Machine", 214],
    ],
  },
  {
    artist: "Juniper Vale",
    album: "Maps of Quiet Places",
    year: 2022,
    genre: "Folk",
    tracks: [
      ["Paper Compass", 231],
      ["Old River Road", 257],
      ["A Porch in October", 280],
      ["County Line Lullaby", 242],
      ["Home by the Long Way", 315],
    ],
  },
  {
    artist: "Paper City Collective",
    album: "Night Bus Radio",
    year: 2026,
    genre: "Alternative",
    tracks: [
      ["Last Stop Lanterns", 211, "Candle Index"],
      ["Crosswalk Constellation", 238, "Vera Halcyon"],
      ["Transfer Window", 196, "Minor Architecture"],
      ["Empty Seat Anthem", 264, "The August Lines"],
      ["First Train Home", 287, "Paper City Collective"],
    ],
  },
];

// The example playlists shown in the Files panel's index. `pick` decides
// membership as each track is generated, so both files stay deterministic.
const playlists = [
  { name: "Favorites", pick: (albumIndex, index) => (index + albumIndex) % 2 === 0 },
  { name: "Synthwave", pick: (albumIndex) => ["Electronic", "Ambient"].includes(albums[albumIndex].genre) },
];

function usage() {
  console.log(`Usage: node scripts/gen-screenshot-library.mjs [--out DIR]

Creates 30 tagged WAV files, six album covers, two playlists, and a manifest.

Options:
  -o, --out DIR  Output directory
                 (default: ~/Pudding Screenshot Library)
  -h, --help     Show this help

The artists, albums and tracks are fictional mock content. The cover art is the
project's own photography, copied from apps/desktop/images.`);
}

function parseArgs(argv) {
  let out = path.join(homedir(), "Pudding Screenshot Library");
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
  return path.resolve(out);
}

function safeName(value) {
  return value.replaceAll("/", "-").replaceAll(":", " -");
}

function synchsafe(value) {
  const out = Buffer.alloc(4);
  out[0] = (value >>> 21) & 0x7f;
  out[1] = (value >>> 14) & 0x7f;
  out[2] = (value >>> 7) & 0x7f;
  out[3] = value & 0x7f;
  return out;
}

function id3Frame(id, payload) {
  const header = Buffer.alloc(10);
  header.write(id, 0, 4, "ascii");
  synchsafe(payload.length).copy(header, 4);
  return Buffer.concat([header, payload]);
}

function textFrame(id, value) {
  return id3Frame(id, Buffer.concat([Buffer.from([3]), Buffer.from(String(value), "utf8")]));
}

function makeId3(track, cover) {
  const frames = [
    textFrame("TIT2", track.title),
    textFrame("TPE1", track.artist),
    textFrame("TALB", track.album),
    textFrame("TPE2", track.albumArtist),
    textFrame("TRCK", `${track.track}/${track.trackTotal}`),
    textFrame("TPOS", `${track.disc}/${track.discTotal}`),
    textFrame("TDRC", track.year),
    textFrame("TCON", track.genre),
    id3Frame(
      "COMM",
      Buffer.concat([
        Buffer.from([3]),
        Buffer.from("eng", "ascii"),
        Buffer.from([0]),
        Buffer.from("Fictional mock media generated for Pudding screenshots", "utf8"),
      ]),
    ),
    id3Frame(
      "APIC",
      Buffer.concat([
        Buffer.from([3]),
        Buffer.from(`${cover.mime}\0`, "ascii"),
        Buffer.from([3, 0]),
        cover.bytes,
      ]),
    ),
  ];
  // A little zero padding provides the conventional terminating frame and gives
  // metadata editors room to make small changes without rewriting the audio.
  const body = Buffer.concat([...frames, Buffer.alloc(1_024)]);
  return Buffer.concat([Buffer.from("ID3\x04\x00\x00", "binary"), synchsafe(body.length), body]);
}

function wavHeader(dataSize, id3Size) {
  const id3Padding = id3Size % 2;
  const fileSize = 44 + dataSize + 8 + id3Size + id3Padding;
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(fileSize - 8, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28);
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataSize, 40);
  return { header, fileSize, id3Padding };
}

function makePreviewTone(trackIndex) {
  const samples = SAMPLE_RATE * PREVIEW_SECONDS;
  const pcm = Buffer.alloc(samples * BYTES_PER_SAMPLE);
  const root = 110 * 2 ** ((trackIndex % 12) / 12);
  for (let i = 0; i < samples; i += 1) {
    const t = i / SAMPLE_RATE;
    const edge = Math.min(1, t / 0.08, (PREVIEW_SECONDS - t) / 0.25);
    const signal =
      Math.sin(2 * Math.PI * root * t) * 0.62 +
      Math.sin(2 * Math.PI * root * 1.5 * t) * 0.25 +
      Math.sin(2 * Math.PI * root * 2 * t) * 0.13;
    pcm.writeInt16LE(Math.round(signal * edge * 2_200), i * 2);
  }
  return pcm;
}

async function writeMockWav(file, track, cover, trackIndex) {
  const dataSize = track.duration * SAMPLE_RATE * BYTES_PER_SAMPLE;
  const id3 = makeId3(track, cover);
  const { header, fileSize, id3Padding } = wavHeader(dataSize, id3.length);
  const handle = await open(file, constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY, 0o644);
  try {
    await handle.write(header, 0, header.length, 0);
    const preview = makePreviewTone(trackIndex);
    await handle.write(preview, 0, preview.length, header.length);
    const id3Header = Buffer.alloc(8);
    id3Header.write("ID3 ", 0);
    id3Header.writeUInt32LE(id3.length, 4);
    await handle.write(id3Header, 0, id3Header.length, 44 + dataSize);
    await handle.write(id3, 0, id3.length, 52 + dataSize);
    if (id3Padding) await handle.write(Buffer.alloc(1), 0, 1, fileSize - 1);
    await handle.truncate(fileSize);
  } finally {
    await handle.close();
  }
}

async function main() {
  const outDir = parseArgs(process.argv.slice(2));
  await mkdir(outDir, { recursive: true });
  const manifest = [];
  const lists = playlists.map((list) => ({ ...list, lines: ["#EXTM3U"] }));
  let trackIndex = 0;
  // Read once and shared by every track on the album, since the same bytes go
  // into each file's APIC frame as well as the album folder's cover file.
  const covers = new Map();
  const loadCover = async (name) => {
    if (!covers.has(name)) {
      covers.set(name, {
        bytes: await readFile(path.join(ART_DIR, name)),
        mime: name.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg",
        file: `cover${path.extname(name)}`,
      });
    }
    return covers.get(name);
  };

  for (let albumIndex = 0; albumIndex < albums.length; albumIndex += 1) {
    const album = albums[albumIndex];
    const albumDir = path.join(outDir, safeName(album.artist), safeName(album.album));
    await mkdir(albumDir, { recursive: true });
    const cover = await loadCover(album.cover ?? DEFAULT_COVER);
    await writeFile(path.join(albumDir, cover.file), cover.bytes);

    for (let index = 0; index < album.tracks.length; index += 1) {
      const [title, duration, artist = album.artist] = album.tracks[index];
      const track = {
        title,
        artist,
        album: album.album,
        albumArtist: album.artist,
        year: album.year,
        genre: album.genre,
        disc: 1,
        discTotal: 1,
        track: index + 1,
        trackTotal: album.tracks.length,
        duration,
      };
      const relativeFile = path.join(
        safeName(album.artist),
        safeName(album.album),
        `${String(index + 1).padStart(2, "0")} ${safeName(title)}.wav`,
      );
      await writeMockWav(path.join(outDir, relativeFile), track, cover, trackIndex++);
      manifest.push({ file: relativeFile, ...track });
      for (const list of lists) {
        if (list.pick(albumIndex, index)) {
          list.lines.push(`#EXTINF:${duration},${artist} - ${title}`, relativeFile);
        }
      }
    }
  }

  for (const list of lists) {
    await writeFile(path.join(outDir, `${list.name}.m3u8`), `${list.lines.join("\n")}\n`);
  }
  await writeFile(
    path.join(outDir, "manifest.json"),
    `${JSON.stringify({ generatedBy: "Pudding", fictional: true, tracks: manifest }, null, 2)}\n`,
  );

  const logicalBytes = manifest.reduce(
    (sum, track) => sum + 44 + track.duration * SAMPLE_RATE * BYTES_PER_SAMPLE,
    0,
  );
  console.log(`Created ${manifest.length} tracks across ${albums.length} albums in:`);
  console.log(outDir);
  console.log(`Audio size: about ${(logicalBytes / 1024 / 1024).toFixed(1)} MB`);
  console.log("Add this folder to Pudding's library to use it in screenshots.");
}

main().catch((error) => {
  console.error(`gen-screenshot-library: ${error.message}`);
  process.exitCode = 1;
});
