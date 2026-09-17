import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { startHarness, type Harness } from "../harness.ts";

let h: Harness;
let scratch: string;

before(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "pudding-integrity-"));
  h = await startHarness({
    port: 0,
    env: { PUDDING_E2E_DATA_DIR: path.join(scratch, "profile") },
  });
});

after(async () => {
  await h?.close();
  if (scratch) await fs.rm(scratch, { recursive: true, force: true });
});

test("curation refuses an external edit, then saves normally after reopening", async () => {
  const d = h.driver;
  const file = path.join(scratch, "mix.m3u8");
  await fs.writeFile(file, "#EXTM3U\n#PLAYLIST:Mix\na.mp3\nb.mp3\n");
  await d.action("browsePlaylist", { path: file });

  const external = "#EXTM3U\n#PLAYLIST:Mix\na.mp3\nb.mp3\nc.mp3\n";
  await fs.writeFile(file, external);
  await d.action("removeRow", { index: 0 });
  await d.waitFor(async () => (await d.text("#toast")).includes("changed on disk"));
  assert.equal(await fs.readFile(file, "utf8"), external);

  await d.action("browsePlaylist", { path: file });
  await d.action("removeRow", { index: 2 });
  await d.action("removeRow", { index: 0 });
  await d.waitFor(async () => {
    const data = await d.invoke("read_playlist", { path: file }) as { tracks: { path: string }[] };
    return data.tracks.length === 1 && data.tracks[0].path === path.join(scratch, "b.mp3");
  }, { message: "edits after reopening did not save the latest rows" });
});
