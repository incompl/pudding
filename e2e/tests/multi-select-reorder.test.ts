// Dragging a multi-selection within a list reorders the whole selection.
//
// Regression: a list-row reorder drag carried only the single grabbed row's
// index, ignoring listSelection. Selecting rows 3 and 4 and dragging them moved
// only the grabbed row (3), leaving 4 behind. attachRowReorder now carries the
// whole selection when the grabbed row is part of it (like the tree drag), and
// reorderCuratedTracks moves the block by object identity. This drives the real
// pointer-drag end to end and asserts the autosaved file order.

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
const D = fixture("tone.m4a");

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

test("dragging a multi-selection reorders the whole block, not just the grabbed row", async () => {
  const d = h.driver;
  const P = path.join(os.tmpdir(), `pudding-e2e-msreorder-${Date.now()}.m3u`);
  await d.invoke("write_playlist", { path: P, name: "List P", tracks: [A, B, C, D] });

  try {
    // Play P: it becomes the active, curated (autosaving) pool.
    await d.action("playPlaylist", { path: P });
    await d.waitFor(async () => (await d.probe()).queueLength === 4, {
      message: "P never became the active 4-track pool",
    });

    // Select rows 3 and 4 (indices 2 and 3) via Cmd-click.
    await d.action("listClick", { index: 2, meta: true });
    await d.action("listClick", { index: 3, meta: true });
    await d.waitFor(async () => (await d.probe()).listSelectionSize === 2, {
      message: "the two rows were not both selected",
    });

    // Grab the selected row 3 and drag it between rows 1 and 2 (drop before
    // index 1). The whole selection [C, D] must travel, not just C.
    await d.action("dragRow", { from: 2, to: 1 });

    await d.waitFor(
      async () => JSON.stringify(await filePaths(d, P)) === JSON.stringify([A, C, D, B]),
      { message: "multi-selection reorder did not move both rows as a block" },
    );
  } finally {
    await fs.rm(P, { force: true });
  }
});
