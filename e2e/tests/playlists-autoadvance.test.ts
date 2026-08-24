// Autoadvance, Add-to-queue, and playlist playback — the engine-facing behaviors
// this branch introduced, asserted against the real engine + DOM.
//
// These exercise paths the existing suites don't: feedEngine's one-track hand-off
// when autoadvance is off (src/main.ts), applyAutoadvanceChange's mid-play engine
// reconcile, appendTracksToActiveQueue's live engine.append, and playPlaylistPath
// reading a real M3U from disk into the queue pool. Autoadvance is one global
// setting — it governs track ends everywhere the same way.
//
// To stay fast we seek to just before a track's end and let the real engine drain
// into handleEnded, rather than playing a full ~5s tone.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness, FIXTURE_TONE, type Driver, type Harness } from "../harness.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(dir, "..", "fixtures", name);

const A = fixture("tone-a.m4a");
const B = fixture("tone-b.m4a");
const C = fixture("tone-c.m4a");
const POOL = [A, B, C];

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h?.close();
});

// Each test starts from straight mode with autoadvance on (the defaults).
// Autoadvance is persisted, so it survives across tests in the running app —
// reset it explicitly rather than trusting the previous test's teardown.
beforeEach(async () => {
  await setModes(h.driver, { shuffle: false, repeat: "off" });
  await setAutoadvance(h.driver, true);
});

// --- helpers -------------------------------------------------------------

async function playingFile(d: Driver): Promise<string | null> {
  const p = (await d.probe()).currentNodePath;
  return typeof p === "string" ? path.basename(p) : null;
}

async function playingIndex(d: Driver): Promise<number | null> {
  const i = (await d.probe()).queuePlayingIndex;
  return typeof i === "number" ? i : null;
}

async function setModes(
  d: Driver,
  want: { shuffle: boolean; repeat: "off" | "all" | "one" },
): Promise<void> {
  if ((await d.probe()).shuffle !== want.shuffle) await d.click("#mode-shuffle");
  for (let i = 0; i < 3 && (await d.probe()).repeat !== want.repeat; i++) {
    await d.click("#mode-repeat");
  }
}

async function setAutoadvance(d: Driver, enabled: boolean): Promise<void> {
  await d.action("setAutoadvance", { enabled });
  assert.equal((await d.probe()).autoadvance, enabled);
}

/** Play POOL from `startIndex` via the real queue path; resolve once sounding it. */
async function playPool(d: Driver, startIndex: number): Promise<void> {
  await d.action("playPaths", { paths: POOL, startIndex });
  await d.waitFor(
    async () =>
      (await d.probe()).isPlaying === true &&
      (await playingIndex(d)) === startIndex,
    { message: `pool never started playing index ${startIndex}` },
  );
  assert.equal(await playingFile(d), path.basename(POOL[startIndex]));
}

/** Seek to just before the current track's end so the engine drains promptly. */
async function seekToEnd(d: Driver): Promise<void> {
  const dur = await d.waitFor(
    async () => {
      const v = Number((await d.probe()).duration);
      return v > 0 ? v : false;
    },
    { message: "track duration never became known" },
  );
  await d.invoke("audio_seek", { seconds: Math.max(0, dur - 0.3) });
}

// --- autoadvance ---------------------------------------------------------

test("autoadvance off: a track ends into a stop, but manual Next still advances", async () => {
  const d = h.driver;
  await playPool(d, 0); // A playing; queue is the active pool
  assert.equal((await d.probe()).queueIsActivePool, true);
  await setAutoadvance(d, false);

  // Manual Next still moves on — autoadvance governs only track *ends*, not the
  // transport. skipNext feeds the engine the one next track (feedEngine).
  await d.click("#next-btn");
  await d.waitFor(async () => (await playingIndex(d)) === 1, {
    message: "manual Next did not advance while autoadvance was off",
  });
  assert.equal(await playingFile(d), "tone-b.m4a");
  assert.equal((await d.probe()).isPlaying, true);

  // But letting B run out stops instead of sliding into C: with autoadvance off
  // the engine was only ever handed B, so its end drains to stopAtQueueEnd.
  await seekToEnd(d);
  await d.waitFor(async () => (await d.probe()).isPlaying === false, {
    message: "playback should stop at the track end when autoadvance is off",
  });
  assert.equal(await playingIndex(d), null); // drained queue rests with no playhead
});

test("turning autoadvance off mid-track drops the gapless tail and stops at end", async () => {
  const d = h.driver;
  await playPool(d, 0); // autoadvance on: the engine holds the whole pool for gapless
  await d.waitFor(async () => Number((await d.probe()).currentTime) > 0.05, {
    message: "playback never advanced before the toggle",
  });

  // Flip it off while sounding: applyAutoadvanceChange must clearUpcoming so the
  // engine's queued tail (B, C) is dropped and the current track becomes the last.
  await setAutoadvance(d, false);
  await seekToEnd(d);
  await d.waitFor(async () => (await d.probe()).isPlaying === false, {
    message: "the tail was not dropped — playback continued past the track end",
  });
  assert.equal(await playingIndex(d), null);
});

// --- add to queue --------------------------------------------------------

test("Add to queue appends to the live pool without interrupting playback", async () => {
  const d = h.driver;
  await playPool(d, 0); // A playing, queue holds [A, B, C]
  assert.equal((await d.probe()).queueLength, 3);
  await d.waitFor(async () => Number((await d.probe()).currentTime) > 0.05, {
    message: "playback never advanced before the append",
  });
  const before = Number((await d.probe()).currentTime);

  // Append a distinct fourth track. appendTracksToActiveQueue grows the pool and
  // (straight + autoadvance on) calls engine.append — the audible track is
  // untouched, so its position keeps climbing rather than resetting.
  await d.action("addToQueue", { paths: [FIXTURE_TONE] });
  await d.waitFor(async () => Number((await d.probe()).queueLength) === 4, {
    message: "appended track never joined the queue",
  });
  assert.equal(await playingFile(d), "tone-a.m4a"); // still the same track
  assert.equal((await d.probe()).isPlaying, true);
  assert.ok(
    Number((await d.probe()).currentTime) >= before,
    "Add to queue must not restart or interrupt the playing track",
  );
});

// --- playlist playback ---------------------------------------------------

test("a saved playlist plays from disk and auto-advances", async () => {
  const d = h.driver;
  const plPath = path.join(os.tmpdir(), `pudding-e2e-${Date.now()}.m3u`);
  // Rust writes the real M3U (same command the app's autosave/Save-as-Playlist use).
  await d.invoke("write_playlist", { path: plPath, name: "E2E List", tracks: POOL });
  try {
    await d.action("playPlaylist", { path: plPath }); // read_playlist -> queue pool
    await d.waitFor(
      async () =>
        (await d.probe()).isPlaying === true && (await playingFile(d)) === "tone-a.m4a",
      { message: "playlist never started playing" },
    );
    assert.equal((await d.probe()).queueIsActivePool, true);

    // With autoadvance on, the playlist flows to the next track at each end.
    await seekToEnd(d);
    await d.waitFor(async () => (await playingFile(d)) === "tone-b.m4a", {
      message: "playlist did not auto-advance from disk",
    });
    assert.equal(await playingIndex(d), 1);
    assert.equal((await d.probe()).isPlaying, true);
  } finally {
    await fs.rm(plPath, { force: true });
  }
});
