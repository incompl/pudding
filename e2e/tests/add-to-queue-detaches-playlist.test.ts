// "Add to queue" while a playlist is playing must never modify the playlist file.
//
// A playing playlist is the active pool (kind "playlist" + sourcePath), and
// curation autosaves it. Before the fix, "Add to queue" appended straight into
// that playlist-source pool: the added tracks weren't written immediately, but the
// next curation autosaved the whole in-memory list — silently baking the queue
// additions into the .m3u8. The queue was conflated with the playlist.
//
// The rule: the queue is never the playlist. Adding to the queue detaches the pool
// from its file first — it becomes a plain, ephemeral "Queue" (no sourcePath) — so
// this add and every later curation stay in memory and the file on disk is left as
// it was. This drives the real entry points and asserts the file never changes.

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

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h?.close();
});

/** The path list a playlist file holds on disk (round-trips through Rust). */
async function filePaths(d: Driver, plPath: string): Promise<string[]> {
  const data = (await d.invoke("read_playlist", { path: plPath })) as {
    tracks: { path: string }[];
  };
  return data.tracks.map((t) => t.path);
}

test("Add to queue while a playlist plays detaches it — the file never changes", async () => {
  const d = h.driver;
  const P = path.join(os.tmpdir(), `pudding-e2e-detach-${Date.now()}.m3u`);
  await d.invoke("write_playlist", { path: P, name: "List P", tracks: [A, B] });

  try {
    // Play P: it becomes the active pool, a real playlist source.
    await d.action("playPlaylist", { path: P });
    await d.waitFor(
      async () => {
        const p = await d.probe();
        return (
          p.isPlaying === true &&
          p.queueLength === 2 &&
          p.activePoolIsPlaylist === true
        );
      },
      { message: "P never started playing as a playlist-source pool" },
    );

    // Add C to the queue via the real "Add to queue" entry point.
    await d.action("addToQueue", { paths: [C] });
    await d.waitFor(async () => (await d.probe()).queueLength === 3, {
      message: "the queue did not grow by the added track",
    });

    // The pool detached: it's now a plain queue, no longer a playlist source, so
    // curation can no longer autosave it. Playback is uninterrupted.
    const afterAdd = await d.probe();
    assert.equal(
      afterAdd.activePoolIsPlaylist,
      false,
      "adding to the queue did not detach the pool from its playlist file",
    );
    assert.equal(afterAdd.isPlaying, true, "the add interrupted playback");
    assert.equal(
      afterAdd.queuePlayingIndex,
      0,
      "the add moved the playhead off the playing track",
    );
    // The add itself must not have touched the file.
    assert.deepEqual(
      await filePaths(d, P),
      [A, B],
      "adding to the queue wrote the playlist file",
    );

    // The real regression: a curation of the (now detached) pool must leave the
    // playlist file untouched. Remove the non-playing row B via the real curation
    // path — before the fix this autosaved [A, C] back into P.
    await d.action("removeRow", { index: 1 });
    await d.waitFor(async () => (await d.probe()).queueLength === 2, {
      message: "removing a queue row did not shrink the pool",
    });

    assert.deepEqual(
      await filePaths(d, P),
      [A, B],
      "curating the detached queue rewrote the playlist file",
    );
    assert.equal(
      (await d.probe()).isPlaying,
      true,
      "curating the detached queue interrupted playback",
    );
  } finally {
    await fs.rm(P, { force: true });
  }
});
