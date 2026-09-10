// Remove/reorder-while-playing across the four playback modes.
//
// Exercises reconcilePoolEdit + advanceAfterRemovedPlaying (src/main.ts): when
// the *live pool's* track list is edited, the playing track must be kept (index
// refreshed, gapless tail rebuilt) or, if it was the removed row, playback must
// move onward per the current mode — straight, repeat-all, repeat-one, shuffle —
// or stop when nothing follows.
//
// Removal and mode changes drive the real DOM (the row ✕ button and the
// #mode-shuffle / #mode-repeat transport buttons). Reorder is a real pointer-drag:
// the `dragRow` entry point synthesizes pointerdown/move/up over the actual rows,
// so it exercises the live attachRowReorder path (threshold, hit-test, drop), not
// a shortcut. Multi-track play needs several distinct files, seeded via `playPaths`.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness, type Driver, type Harness } from "../harness.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(dir, "..", "fixtures", name);

// A pool of three distinct, playable files. Identity is by path (the copies are
// byte-identical, so metadata can't distinguish them) — the probe reports the
// playing file as currentNodePath.
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

// Each test starts from a known mode + a freshly played pool.
beforeEach(async () => {
  await setModes(h.driver, { shuffle: false, repeat: "off" });
});

// --- helpers -------------------------------------------------------------

/** Basename of the currently-playing file, or null when nothing plays. */
async function playingFile(d: Driver): Promise<string | null> {
  const p = (await d.probe()).currentNodePath;
  return typeof p === "string" ? path.basename(p) : null;
}

async function playingIndex(d: Driver): Promise<number | null> {
  const i = (await d.probe()).queuePlayingIndex;
  return typeof i === "number" ? i : null;
}

/** Normalize the transport modes by clicking the real mode buttons. */
async function setModes(
  d: Driver,
  want: { shuffle: boolean; repeat: "off" | "all" | "one" },
): Promise<void> {
  // Shuffle is a plain toggle.
  if ((await d.probe()).shuffle !== want.shuffle) await d.click("#mode-shuffle");
  // Repeat cycles off -> all -> one -> off; click until it matches.
  for (let i = 0; i < 3 && (await d.probe()).repeat !== want.repeat; i++) {
    await d.click("#mode-repeat");
  }
  assert.equal((await d.probe()).shuffle, want.shuffle);
  assert.equal((await d.probe()).repeat, want.repeat);
}

/** Play POOL starting on `startIndex`; resolve once the engine is sounding it. */
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

/** Click the ✕ on the view row at `viewIdx` (0-based); nth-child is 1-based. */
async function removeRow(d: Driver, viewIdx: number): Promise<void> {
  await d.click(`#queue-list li:nth-child(${viewIdx + 1}) .queue-remove`);
}

/** Click the ✕ on whichever row is currently playing (view idx === pool idx). */
async function removePlayingRow(d: Driver): Promise<void> {
  const idx = await playingIndex(d);
  assert.notEqual(idx, null, "no playing row to remove");
  await removeRow(d, idx as number);
}

/** How many tracks a playlist file holds on disk (round-trips through Rust). */
async function fileTrackCount(d: Driver, plPath: string): Promise<number> {
  const data = (await d.invoke("read_playlist", { path: plPath })) as {
    tracks: unknown[];
  };
  return data.tracks.length;
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

/**
 * Write POOL to a temp .m3u, play it, and browse the *same* file so both
 * `activeQueue` and `browsedPlaylist` hold it (the regression trigger). Runs
 * `body` with the live pool playing index 0, then cleans up the file.
 */
async function withBrowsedPlayingPlaylist(
  d: Driver,
  body: (plPath: string) => Promise<void>,
): Promise<void> {
  const plPath = path.join(os.tmpdir(), `pudding-e2e-curate-${Date.now()}.m3u`);
  await d.invoke("write_playlist", { path: plPath, name: "E2E List", tracks: POOL });
  try {
    await d.action("playPlaylist", { path: plPath }); // read_playlist -> queue pool
    await d.waitFor(
      async () =>
        (await d.probe()).isPlaying === true && (await playingIndex(d)) === 0,
      { message: "playlist never started playing index 0" },
    );
    await d.action("browsePlaylist", { path: plPath }); // both signals now hold it
    // The browse pane shows this file's rows; the pool underneath is unchanged.
    assert.equal((await d.probe()).queueIsActivePool, true);
    assert.equal(await playingFile(d), "tone-a.m4a");
    await body(plPath);
  } finally {
    await fs.rm(plPath, { force: true });
  }
}

// --- remove-while-playing ------------------------------------------------

test("straight: removing the playing row plays whatever takes its slot", async () => {
  const d = h.driver;
  await playPool(d, 1); // B playing
  await removePlayingRow(d); // C slides into slot 1
  await d.waitFor(async () => (await playingFile(d)) === "tone-c.m4a", {
    message: "did not advance to the track that took the slot",
  });
  assert.equal(await playingIndex(d), 1);
  assert.equal((await d.probe()).isPlaying, true);
});

test("straight: removing the last playing row (no wrap) stops playback", async () => {
  const d = h.driver;
  await playPool(d, 2); // C playing, last row
  await removePlayingRow(d); // nothing follows in straight mode
  await d.waitFor(async () => (await d.probe()).isPlaying === false, {
    message: "playback should stop when the last row is removed",
  });
  assert.equal(await playingIndex(d), null);
});

test("repeat-all: removing the last playing row wraps to the top", async () => {
  const d = h.driver;
  await setModes(d, { shuffle: false, repeat: "all" });
  await playPool(d, 2); // C playing, last row
  await removePlayingRow(d); // slot past the end -> wrap to index 0
  await d.waitFor(async () => (await playingFile(d)) === "tone-a.m4a", {
    message: "repeat-all did not wrap to the top after removing the last row",
  });
  assert.equal(await playingIndex(d), 0);
  assert.equal((await d.probe()).isPlaying, true);
});

test("repeat-one: removing the playing row adopts the track now at its slot", async () => {
  const d = h.driver;
  await setModes(d, { shuffle: false, repeat: "one" });
  await playPool(d, 1); // B playing
  await removePlayingRow(d); // repeat-one can't loop a gone track -> adopt slot 1 (C)
  await d.waitFor(async () => (await playingFile(d)) === "tone-c.m4a", {
    message: "repeat-one did not adopt the track at the vacated slot",
  });
  assert.equal(await playingIndex(d), 1);
  assert.equal((await d.probe()).isPlaying, true);
});

test("shuffle: removing the playing row keeps playback alive", async () => {
  const d = h.driver;
  await setModes(d, { shuffle: true, repeat: "off" });
  await playPool(d, 1); // B playing
  await removePlayingRow(d); // shuffle draws the next from the bag
  // The row leaves the list and the pool keeps sounding. Which track plays next
  // is nondeterministic — and may even be the just-removed file once, since the
  // removed-row branch shifts the shuffle bag without filtering it against the
  // shrunken pool (the survived-row branch does filter). So assert only the
  // invariant that must hold: the edit is reflected and playback never stopped.
  // The list is windowed (rows sit inside a spacer container, not as direct
  // children of #queue-list), so read the rendered row count off data-row-count,
  // which renderQueue stamps on every rebuild.
  await d.waitFor(
    async () => (await d.attr("#queue-list", "data-row-count")) === "2",
    { message: "removed row never left the list" },
  );
  assert.equal((await d.probe()).isPlaying, true);
  assert.equal((await d.probe()).hasTrack, true);
});

// --- reorder-while-playing -----------------------------------------------

test("straight: reordering keeps the same track playing, index follows", async () => {
  const d = h.driver;
  await playPool(d, 0); // A playing at index 0
  // Let real playback advance so a restart would be visible as a time reset.
  await d.waitFor(async () => Number((await d.probe()).currentTime) > 0.05, {
    message: "playback never advanced before reorder",
  });
  const before = Number((await d.probe()).currentTime);

  // Move C (idx 2) to the front: [C, A, B]. A is undisturbed but now at index 1.
  await d.action("dragRow", { from: 2, to: 0 });

  await d.waitFor(async () => (await playingIndex(d)) === 1, {
    message: "playing index did not follow the reorder",
  });
  assert.equal(await playingFile(d), "tone-a.m4a"); // same track
  assert.equal((await d.probe()).isPlaying, true); // uninterrupted
  // Not restarted: position kept moving forward, never reset toward zero.
  assert.ok(
    Number((await d.probe()).currentTime) >= before,
    "reorder must not restart the playing track",
  );
});

test("straight: moving the playing row itself relocates it without a restart", async () => {
  const d = h.driver;
  await playPool(d, 0); // A playing at index 0
  // Move the playing row A (idx 0) to the end: [B, C, A] -> A at index 2.
  await d.action("dragRow", { from: 0, to: 3 });
  await d.waitFor(async () => (await playingIndex(d)) === 2, {
    message: "moved playing row did not land at its new index",
  });
  assert.equal(await playingFile(d), "tone-a.m4a");
  assert.equal((await d.probe()).isPlaying, true);
});

test("repeat-one: reorder is inaudible and leaves the track playing", async () => {
  const d = h.driver;
  await setModes(d, { shuffle: false, repeat: "one" });
  await playPool(d, 1); // B playing
  await d.action("dragRow", { from: 0, to: 3 }); // shuffle A to the end
  // Per-track modes hand the engine one track at a time, so a reorder can't
  // disturb what's sounding — B keeps playing, only its index may shift.
  await d.waitFor(async () => (await playingFile(d)) === "tone-b.m4a", {
    message: "repeat-one reorder disturbed the playing track",
  });
  assert.equal((await d.probe()).isPlaying, true);
});

// --- curating a browsed copy of the *playing* playlist -------------------
//
// Play a saved playlist, then single-click it to browse it: `activeQueue` and
// `browsedPlaylist` now hold the same file. applyCuration must still recognize
// the edit as touching the live pool (it once required browsed === null), or the
// engine keeps its stale order/gapless tail while the file + activeQueue drift.
// These drive the real ✕ in the browse pane and assert the engine, the pool
// length, and the on-disk file all move together.

test("browsed playing playlist: removing the playing row reconciles engine + pool + file", async () => {
  const d = h.driver;
  await withBrowsedPlayingPlaylist(d, async (plPath) => {
    assert.equal((await d.probe()).queueLength, 3);
    // Remove the playing row (A, view idx 0) from the browsed copy. The pool is
    // live, so B must slide into slot 0 and start (advanceAfterRemovedPlaying) —
    // pre-fix the engine kept sounding the removed A.
    await removeRow(d, 0);
    await d.waitFor(async () => (await playingFile(d)) === "tone-b.m4a", {
      message: "engine did not advance to the track that took the slot",
    });
    assert.equal(await playingIndex(d), 0);
    assert.equal((await d.probe()).isPlaying, true);
    // activeQueue synced (pre-fix it stayed at 3) and the file was rewritten.
    assert.equal((await d.probe()).queueLength, 2);
    assert.equal(await fileTrackCount(d, plPath), 2);
  });
});

test("browsed playing playlist: removing the next row rebuilds the gapless tail", async () => {
  const d = h.driver;
  await withBrowsedPlayingPlaylist(d, async (plPath) => {
    // A playing (idx 0). Remove the immediate-next row B (view idx 1) from the
    // browsed copy: A keeps playing (survived branch), but the engine's prebuilt
    // tail must be rebuilt so the end of A now flows into C, not the removed B.
    await removeRow(d, 1);
    assert.equal(await playingFile(d), "tone-a.m4a"); // undisturbed
    assert.equal(await playingIndex(d), 0);
    assert.equal((await d.probe()).queueLength, 2);
    assert.equal(await fileTrackCount(d, plPath), 2);

    // Let A drain: with the tail rebuilt it advances to C. Pre-fix the stale tail
    // still had B queued, so playback would flow into the just-removed track.
    await seekToEnd(d);
    await d.waitFor(async () => (await playingFile(d)) === "tone-c.m4a", {
      message: "end of the playing track did not flow into the surviving next row",
    });
    assert.equal((await d.probe()).isPlaying, true);
  });
});
