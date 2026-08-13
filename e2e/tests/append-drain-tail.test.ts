// Regression for bug #6: "Add to queue" must not chop the still-audible tail
// when the decode frontier has just drained (audio.rs Command::Append).
//
// The engine decodes ~RING_BUFFER_SECONDS (1s) ahead of what's audible. When the
// last track of a pool finishes *decoding*, the frontier goes None while a full
// ring's worth of its audio is still playing out. In that window "Add to queue"
// reaches the engine as Command::Append with frontier.is_none() && stream.is_none(),
// whose branch does reset_for_new_playback -> flush_and_wait -> it drains the ring,
// silencing the audible tail and starting the appended track early. The comment's
// "nothing is currently audible" assumption is false at the decode-end boundary.
//
// We reproduce it with a lone-track pool: seek near the end so the frontier drains
// while >0.5s of tail is still sounding, then Add-to-queue a distinct track inside
// that window and assert the first track plays out to its natural end before the
// appended one takes over.

import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness, type Driver, type Harness } from "../harness.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) => path.join(dir, "..", "fixtures", name);

const A = fixture("tone-a.m4a");
const B = fixture("tone-b.m4a");

// Fire the append this far before A's end. Must be > RING_BUFFER_SECONDS-worth
// into the tail (so the frontier has already drained: audible > dur-1s) yet leave
// enough tail after it that a chop is unmistakable.
const FIRE_BEFORE_END = 0.6;
// Under a correct fix A keeps sounding to (near) its end before B starts; the bug
// flushes it away at ~FIRE_BEFORE_END, so it never reaches this.
const TAIL_REACHED = 0.1;

let h: Harness;

before(async () => {
  h = await startHarness();
});

after(async () => {
  await h?.close();
});

// Straight mode + autoadvance on is what routes Add-to-queue through engine.append
// (appendTracksToActiveQueue's gapless branch) rather than a per-track hand-off.
beforeEach(async () => {
  await setModes(h.driver, { shuffle: false, repeat: "off" });
  await setAutoadvance(h.driver, "playlists", true);
});

// --- helpers -------------------------------------------------------------

async function playingFile(d: Driver): Promise<string | null> {
  const p = (await d.probe()).currentNodePath;
  return typeof p === "string" ? path.basename(p) : null;
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

async function setAutoadvance(
  d: Driver,
  which: "files" | "playlists",
  enabled: boolean,
): Promise<void> {
  await d.action("setAutoadvance", { which, enabled });
  const key = which === "files" ? "autoadvanceFiles" : "autoadvancePlaylists";
  assert.equal((await d.probe())[key], enabled);
}

// --- test ----------------------------------------------------------------

test("Add to queue at the decode-end boundary preserves the audible tail", async () => {
  const d = h.driver;

  // A lone-track pool: when A finishes decoding, the frontier drains to None with
  // nothing behind it — the exact single-track hand-off the bug describes. The
  // "queue:" pool makes it the active queue so Add-to-queue appends to it.
  await d.action("playPaths", { paths: [A], startIndex: 0 });
  await d.waitFor(
    async () =>
      (await d.probe()).isPlaying === true && (await playingFile(d)) === "tone-a.m4a",
    { message: "lone-track pool never started playing" },
  );

  const dur = await d.waitFor(
    async () => {
      const v = Number((await d.probe()).duration);
      return v > 0 ? v : false;
    },
    { message: "track duration never became known" },
  );

  // Seek so ~1.5s of tail remains: past RING_BUFFER_SECONDS, so once the ring
  // fills, the frontier reaches A's end (goes None) while ~1s is still audible.
  await d.invoke("audio_seek", { seconds: Math.max(0, dur - 1.5) });

  // Wait until we're inside the drain window: audible position past dur-1s means a
  // full ring has been consumed, so the frontier has already run off the end.
  // Poll tightly so we fire the append while a healthy tail remains.
  await d.waitFor(
    async () => {
      const p = await d.probe();
      return p.isPlaying === true && Number(p.currentTime) >= dur - FIRE_BEFORE_END;
    },
    { interval: 40, message: "playback never entered the decode-end drain window" },
  );

  // Sanity: at fire time the still-sounding track is A, short of its end — a later
  // A-at-end reading can only mean the tail played through, not a stale sample.
  const atFire = await d.probe();
  assert.equal(await playingFile(d), "tone-a.m4a", "expected A still audible at fire");
  assert.ok(
    Number(atFire.currentTime) < dur - TAIL_REACHED,
    "fired too late; window collapsed before the append",
  );

  // Add-to-queue B during the window. queueEnded is still false (queue-ended fires
  // only at full drain), so this routes to engine.append — Command::Append with the
  // frontier already None, the buggy flush path.
  await d.action("addToQueue", { paths: [B] });

  // The fix keeps A audible to its natural end before B starts. The bug flushes the
  // ring here, so A never gets past ~FIRE_BEFORE_END and B takes over immediately —
  // this wait then times out on B being current instead of A near its end.
  await d.waitFor(
    async () => {
      const p = await d.probe();
      return (
        path.basename(String(p.currentNodePath)) === "tone-a.m4a" &&
        Number(p.currentTime) >= dur - TAIL_REACHED
      );
    },
    {
      timeout: 4000,
      message:
        "A's audible tail was cut short — Add to queue flushed the still-playing ring (bug #6)",
    },
  );

  // And B does eventually take over once A's tail has drained.
  await d.waitFor(async () => (await playingFile(d)) === "tone-b.m4a", {
    message: "appended track B never played after A's tail drained",
  });
  assert.equal((await d.probe()).isPlaying, true);
});
