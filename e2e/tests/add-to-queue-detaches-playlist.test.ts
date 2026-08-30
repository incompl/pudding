// "Add to queue" while a playlist is playing must never modify the playlist file.
//
// A playing playlist is the active pool (a real playlist source, sourcePath set) and
// curation autosaves it. The rule: the queue is never the playlist. A playlist is
// never a queue, so there is nothing for "Add to queue" to append *to* — the add
// collapses to the same gesture as "Create queue": a fresh, ephemeral "Queue" (no
// sourcePath) holding only the added tracks, installed at rest. The queue no longer
// carries the playlist's tail, the pool is no longer a playlist source, and every
// later curation stays in memory — so the .m3u8 on disk is left exactly as it was.
// This drives the real entry points and asserts the file never changes.

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

test("Add to queue while a playlist plays collapses to a fresh Queue — the file never changes", async () => {
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
          p.activePoolIsPlaylist === true &&
          // Gate on the playhead landing on row 0 too: it's set by the engine's
          // initial advance event, which trails the isPlaying flip. Without this
          // the add can race ahead of it and read queuePlayingIndex still null.
          p.queuePlayingIndex === 0
        );
      },
      { message: "P never started playing as a playlist-source pool" },
    );

    // Add C to the queue via the real "Add to queue" entry point. A playlist is never
    // a queue, so there is nothing to append to: the add collapses to "Create queue" —
    // a fresh Queue of exactly [C], holding none of P's tail — and the pool is no
    // longer a playlist source.
    // Create queue installs the queue at rest, so also gate on the engine settling to
    // stopped: engine.stop() is async, so isPlaying trails the collapse by an event.
    await d.action("addToQueue", { paths: [C] });
    await d.waitFor(
      async () => {
        const p = await d.probe();
        return (
          p.queueLength === 1 &&
          p.activePoolIsPlaylist === false &&
          p.isPlaying === false
        );
      },
      { message: "Add to queue did not collapse to a fresh, resting non-playlist Queue" },
    );

    // Nothing sounds until the user presses play, and there is no playhead. (The
    // playlist left behind is simply stopped.)
    const afterAdd = await d.probe();
    assert.equal(
      afterAdd.queuePlayingIndex,
      null,
      "a resting queue has no playhead",
    );
    // The add itself must not have touched the file P left behind on disk.
    assert.deepEqual(
      await filePaths(d, P),
      [A, B],
      "adding to the queue wrote the playlist file",
    );

    // The real regression guard: curating the new (non-playlist) queue must never
    // autosave into P. Grow it back to a few rows, then remove one via the real
    // curation path — when queues and playlists were still conflated this baked queue
    // edits straight into the .m3u8.
    await d.action("addToQueue", { paths: [A, B] });
    await d.waitFor(async () => (await d.probe()).queueLength === 3, {
      message: "appending to the collapsed queue did not grow it",
    });
    await d.action("removeRow", { index: 1 });
    await d.waitFor(async () => (await d.probe()).queueLength === 2, {
      message: "removing a queue row did not shrink the pool",
    });

    assert.deepEqual(
      await filePaths(d, P),
      [A, B],
      "curating the detached queue rewrote the playlist file",
    );
  } finally {
    await fs.rm(P, { force: true });
  }
});
