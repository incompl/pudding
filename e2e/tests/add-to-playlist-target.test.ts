// "Add to playlist ▸ P" while a *different* playlist is browsed (bugs.md #3).
//
// addTracksToPlaylist (src/main.ts) routes through the in-memory list only when
// the target is the *curated* list — browsedPlaylist ?? activeQueue. So with
// playlist P playing (the active pool) and a different playlist Q browsed,
// curatedList() is Q, `open.sourcePath === P` is false, and the add falls to the
// closed-file branch: it appends to P's file on disk but never touches the live
// activeQueue that still holds P. The just-added rows are then live only on disk.
//
// The harm is data loss: a later curation of P (once the browse is closed and the
// active pool is the curated list again) autosaves the *stale* in-memory list,
// rewriting P's file without the tracks that were added to it — silently dropping
// them. This drives the real entry points end to end and asserts the added track
// survives both in memory and on disk.

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

test("Add to playlist targets the playing pool while another is browsed", async () => {
  const d = h.driver;
  const stamp = Date.now();
  // P is the playlist we'll play *and* add to; Q is an unrelated one we browse so
  // that the curated list is Q (not P) at add time — the regression trigger.
  const P = path.join(os.tmpdir(), `pudding-e2e-target-P-${stamp}.m3u`);
  const Q = path.join(os.tmpdir(), `pudding-e2e-target-Q-${stamp}.m3u`);
  await d.invoke("write_playlist", { path: P, name: "List P", tracks: [A, B] });
  await d.invoke("write_playlist", { path: Q, name: "List Q", tracks: [C] });

  try {
    // Play P: it becomes the active pool (in memory + engine).
    await d.action("playPlaylist", { path: P });
    await d.waitFor(
      async () =>
        (await d.probe()).isPlaying === true &&
        (await d.probe()).queueLength === 2,
      { message: "P never started playing as the active pool" },
    );

    // Browse a *different* playlist Q, so curatedList() is Q, not P.
    await d.action("browsePlaylist", { path: Q });

    // "Add to playlist ▸ P" — add C to P while Q is the browsed/curated list.
    await d.action("addToPlaylist", { path: P, paths: [C] });

    // The file write always happens; the defect is that the live active pool P is
    // left stale. Assert the addition landed in *both* places (buggy: queueLength
    // stays 2 because activeQueue was never updated).
    assert.deepEqual(await filePaths(d, P), [A, B, C]);
    assert.equal(
      (await d.probe()).queueLength,
      3,
      "the live active pool did not reflect the add — it will be autosaved stale",
    );

    // Close Q's browse and return to P's own list (real nav path), making the
    // active pool the curated list again.
    await d.action("showSourceList");

    // Curate P: a real pointer-drag reorder (row 0 -> end). Count is invariant, so
    // it isolates the data-loss cleanly — the autosave rewrites P from the live
    // in-memory list. Buggy: that list is stale [A, B], so C is dropped from disk.
    await d.action("dragRow", { from: 0, to: 3 });

    await d.waitFor(async () => (await filePaths(d, P)).length === 3, {
      message: "curating P after the add dropped the added track from disk",
    });
    // C survived the autosave (order may have changed; membership must not).
    assert.ok(
      (await filePaths(d, P)).includes(C),
      "the added track was lost when the stale in-memory pool was autosaved",
    );
  } finally {
    await fs.rm(P, { force: true });
    await fs.rm(Q, { force: true });
  }
});
