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

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h?.close();
});

async function onListFace(d: Driver): Promise<boolean> {
  return (
    (await d.attr("#now-playing-panel", "class"))
      ?.split(/\s+/)
      .includes("show-list") ?? false
  );
}

async function revealSourceFromNowPlaying(
  d: Driver,
  expectedTitle: string,
): Promise<void> {
  assert.equal(await onListFace(d), true, "source list did not open with playback");
  await d.click("#nav-bar-btn");
  await d.waitFor(async () => !(await onListFace(d)), {
    message: "Now Playing face did not open",
  });

  await d.click("#now-playing-title .marquee-inner");
  await d.waitFor(() => onListFace(d), {
    message: "clicking the Now Playing title did not reopen the source list",
  });
  assert.equal(await d.text("#queue-title-text"), expectedTitle);
}

test("Now Playing title reopens the active queue", async () => {
  const d = h.driver;
  await d.action("playPaths", { paths: [A, B], startIndex: 0 });
  await d.waitFor(async () => (await d.probe()).isPlaying === true, {
    message: "queue never started playing",
  });
  await revealSourceFromNowPlaying(d, "E2E Pool");
});

test("Now Playing title reopens the playing playlist", async () => {
  const d = h.driver;
  const playlistPath = path.join(os.tmpdir(), `pudding-e2e-context-${Date.now()}.m3u`);
  await d.invoke("write_playlist", {
    path: playlistPath,
    name: "Context Playlist",
    tracks: [{ path: A }, { path: B }],
  });

  try {
    await d.action("playPlaylist", { path: playlistPath });
    await d.waitFor(async () => (await d.probe()).isPlaying === true, {
      message: "playlist never started playing",
    });
    await revealSourceFromNowPlaying(d, "Context Playlist");
  } finally {
    await fs.rm(playlistPath, { force: true });
  }
});
