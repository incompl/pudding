// "Save Queue as Playlist" must convert, not just export.
//
// Exercises saveQueueAsPlaylist (src/main.ts): saving an ephemeral queue writes
// the .m3u8 *and* repoints the live pool at that file, so from then on curating
// the still-playing queue autosaves to disk. The old behaviour only browsed the
// new file while the pool stayed ephemeral — so post-save edits were silently
// lost (TODO "dead-end promotion" trap).
//
// The native save picker is undrivable in e2e, so the flow runs through the
// `savePlaylistAs` action (the real post-dialog logic with an explicit path).
// The curation drives the real row ✕ via `removeRow`, and we assert the on-disk
// file — not just the in-memory queue — tracks the edit.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness, type Driver, type Harness } from "../harness.ts";

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

/** How many tracks a playlist file holds on disk (round-trips through Rust). */
async function fileTrackCount(d: Driver, plPath: string): Promise<number> {
  const data = (await d.invoke("read_playlist", { path: plPath })) as {
    tracks: unknown[];
  };
  return data.tracks.length;
}

test("saving an ephemeral queue makes it an autosaving playlist source", async () => {
  const d = h.driver;
  const plPath = path.join(os.tmpdir(), `pudding-e2e-save-${Date.now()}.m3u8`);
  try {
    // Play a hand-built queue: the ephemeral, saveable pool (no sourcePath yet).
    await d.action("playPaths", { paths: POOL, startIndex: 0 });
    await d.waitFor(
      async () => {
        const p = await d.probe();
        return p.queueIsActivePool === true && p.queueLength === 3;
      },
      { message: "ephemeral queue never became the active pool" },
    );

    // Save Queue as Playlist to an explicit path (bypasses the native picker).
    await d.action("savePlaylistAs", { path: plPath });
    await d.waitFor(async () => (await fileTrackCount(d, plPath)) === 3, {
      message: "queue was never written to the playlist file",
    });
    // Saving must not disturb the still-live pool: same length, still the pool.
    assert.equal((await d.probe()).queueIsActivePool, true);
    assert.equal((await d.probe()).queueLength, 3);

    // The conversion's whole point: curating the saved queue now autosaves. Drop
    // the last row (view idx 2) — pre-fix the pool stayed ephemeral, so this edit
    // reached neither the file nor a repointed source and was lost.
    await d.click("#queue-list li:nth-child(3) .queue-remove");
    await d.waitFor(async () => (await d.probe()).queueLength === 2, {
      message: "curation did not shrink the live pool",
    });
    await d.waitFor(async () => (await fileTrackCount(d, plPath)) === 2, {
      message: "post-save curation did not autosave to the playlist file",
    });
  } finally {
    await fs.rm(plPath, { force: true });
  }
});
