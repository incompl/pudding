import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startHarness, FIXTURE_TONE, type Harness } from "../harness.ts";

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h?.close();
});

test("transport label always reflects the isPlaying signal", async () => {
  const d = h.driver;
  // Pure #id selector against the real DOM — the whole point of the bridge.
  assert.equal(await d.exists("#play-pause-btn"), true);
  const s = await d.probe();
  assert.equal(
    await d.attr("#play-pause-btn", "aria-label"),
    s.isPlaying ? "Pause" : "Play",
  );
});

test("play -> pause: real engine and UI stay in agreement", async () => {
  const d = h.driver;

  // Drive the real UI entry point (openExternalFile): it sets now-playing state
  // and calls the GaplessEngine, exactly as the app does — so the transport
  // button becomes live and hasTrack flips, just like a real play.
  await d.action("playFile", FIXTURE_TONE);

  // Engine state flows back via audio:* events -> GaplessEngine -> signals -> DOM.
  await d.waitFor(async () => (await d.probe()).isPlaying === true, {
    message: "engine never reported playing",
  });
  assert.equal(await d.attr("#play-pause-btn", "aria-label"), "Pause");
  assert.equal(await d.prop("#play-pause-btn", "disabled"), false);
  assert.equal((await d.probe()).hasTrack, true);

  // Playback actually advances (position events flowing into the UI signal).
  const t0 = Number((await d.probe()).currentTime);
  await d.waitFor(async () => Number((await d.probe()).currentTime) > t0, {
    message: "playback position never advanced",
  });

  // Pause via the real transport button; engine + UI must both settle to paused.
  await d.click("#play-pause-btn");
  await d.waitFor(async () => (await d.probe()).isPlaying === false, {
    message: "engine never reported paused",
  });
  assert.equal(await d.attr("#play-pause-btn", "aria-label"), "Play");
});
