// The two ends of "don't rewrite a file the decoder is holding".
//
// A save rewrites each file in place, so the engine's open handles are what it has
// to refuse — and the file the engine holds is not the file you hear. Gapless
// playback opens the next track while the current one is still playing, so a
// selection that includes the *next* track is the interesting case, and no unit
// test reaches it: it needs a real decode thread reading ahead through real audio.
//
// The other end is the same accessor saying no when it should say yes. A queue
// played to its end still names its last track (Seek and the position thread need
// it), so without the drained-queue gate, selecting that album and editing it comes
// back refusing one track with nothing playing at all. The control for that one is
// in Rust, where the accessor can be asked both ways with the same origins:
// audio.rs's `nothing_is_held_once_the_queue_is_exhausted` against
// `current_and_pending_are_both_held`.
//
// That end has a renderer half too, and it is the one a Rust test can't reach: the
// form's own gate reads currentNodePath, which a drained *queue* clears and drained
// folder playback deliberately keeps. Hence the last test here, which finishes an
// album from the tree rather than from a queue and then edits it.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { Driver, Harness } from "../harness.ts";
import {
  FIXTURES,
  digest,
  editorForm,
  editorOpen,
  makeLibrary,
  readTags,
  save,
  startIsolated,
  tempRoot,
  typeInEditor,
  useLibrary,
  writeTags,
} from "../tag-editing.ts";

const run = promisify(execFile);

let h: Harness;
let root: string;

before(async () => {
  root = await tempRoot("bulk-tags-playing");
  h = await startIsolated(root);
  // Gapless read-ahead is the whole subject here, and it only happens when the
  // engine has been handed more than one track — which is what autoadvance decides
  // (feedEngine hands it one at a time when off). Set explicitly rather than
  // trusting the default: with it off there would be no frontier to test.
  await h.driver.action("setAutoadvance", { enabled: true });
});

after(async () => {
  await h?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

// Play `file` up to the point where the decoder has read ahead into the next track,
// and pause there.
//
// The read-ahead is exactly one ring buffer — RING_BUFFER_SECONDS, 1.0s — so the
// next track is open only inside the last second of this one, and that second is
// also when playback is about to cross into it and disable Save. Pausing inside the
// window stops the clock without closing anything: the decode thread keeps its
// handles across a pause, so the next track stays held for as long as the test
// needs, and resuming crosses into it exactly as it would have.
async function pauseHoldingTheNextTrack(d: Driver, file: string): Promise<void> {
  await d.waitFor(
    async () => {
      const p = await d.probe();
      return (
        p.currentNodePath === file && (p.duration as number) > 0 && p.isPlaying === true
      );
    },
    { timeout: 20_000, message: `${file} never started playing` },
  );
  // 0.6s before the end: past the 1.0s mark where the next track is opened, with
  // room left for the pause to land before the boundary.
  await d.waitFor(
    async () => {
      const p = await d.probe();
      return (p.currentTime as number) >= (p.duration as number) - 0.6;
    },
    { timeout: 20_000, interval: 20, message: `playback never reached the tail of ${file}` },
  );
  await d.click("#play-pause-btn");
  await d.waitFor(async () => (await d.probe()).isPlaying === false, {
    message: "playback never paused",
  });
  assert.equal(
    (await d.probe()).currentNodePath,
    file,
    "the pause landed after the track boundary, not inside the read-ahead window",
  );
}

// Edit `paths`, set one album across them, and hand back the note the form came
// up with. A save that has anything to report leaves the form up — which is the
// case both of these tests are about.
async function saveAlbumAcross(
  d: Driver,
  paths: string[],
  album: string,
): Promise<string | null> {
  await d.action("editMetadata", { paths });
  await typeInEditor(d, "Album", album);
  // Save's standing block ("Can't save while one of these tracks is playing") is a
  // note too, and it is on screen before the button is ever pressed — so check the
  // button rather than reading the note twice and calling the first one an outcome.
  const ready = await editorForm(d);
  assert.equal(ready.submitDisabled, false, `Save was disabled: ${ready.note}`);
  await save(d);
  return d.waitFor(
    async () => {
      if (!(await editorOpen(d))) return "closed";
      const note = (await editorForm(d)).note;
      // Skip past the running label; what this wants is the outcome.
      return note && !note.startsWith("Saving...") ? note : null;
    },
    { interval: 20, message: "the save never reported an outcome" },
  ).then((note) => (note === "closed" ? null : note));
}

test("the track the decoder has read ahead into is refused, and playback crosses into it unbroken", async () => {
  const d = h.driver;
  const { paths } = await makeLibrary(root, "frontier", 3);
  const [a, b, c] = paths;

  await d.action("playPaths", { paths: [a, b], startIndex: 0 });
  await pauseHoldingTheNextTrack(d, a);

  const held = await digest(b);
  // b is the next track — open in the decoder, but not the track you can hear, so
  // the form's own gate (which only knows the audible track) lets the save run.
  const note = await saveAlbumAcross(d, [b, c], "Frontier Album");
  assert.equal(note, "Saved 1 of 2. 1 couldn't be written.");
  assert.equal(await digest(b), held, "the held file was rewritten under the decoder");
  assert.equal((await readTags(d, c)).album, "Frontier Album", "the free file was skipped");

  // Resume. One refused file is not a broken queue: the track the save left alone
  // is still the one the decoder was holding, and playback walks into it.
  await d.click("#play-pause-btn");
  await d.waitFor(async () => (await d.probe()).currentNodePath === b, {
    timeout: 20_000,
    message: "playback never crossed into the track the save refused",
  });
  assert.equal((await d.probe()).isPlaying, true, "playback stopped at the boundary");
  await d.click("#play-pause-btn"); // leave the engine quiet for the next test
});

test("a track opened for a sample-rate switch is refused too", async () => {
  const d = h.driver;
  const { dir, paths } = await makeLibrary(root, "rates", 2);
  const [a, c] = paths;
  // A next track at a rate the current one isn't. This is the only way to reach the
  // deferred-origin window: a track needing a rate switch is opened and then
  // returns early, so its origin isn't published until the output is rebuilt — and
  // for that stretch the decoder holds a file that neither `current` nor `pending`
  // names.
  const b48 = path.join(dir, "next-48k.m4a");
  await run("/usr/bin/afconvert", [
    "-f", "m4af", "-d", "aac@48000",
    path.join(FIXTURES, "tone-b.m4a"), b48,
  ]);

  // Briefly changes the default output device's hardware rate, as this feature
  // does in earnest — the same reason audio.rs's device-rate test is #[ignore]d.
  // Turned back off at the end, which restores the pre-matching rate.
  await d.action("setFollowSampleRate", { enabled: true });
  try {
    await d.action("playPaths", { paths: [a, b48], startIndex: 0 });
    await pauseHoldingTheNextTrack(d, a);

    const held = await digest(b48);
    const note = await saveAlbumAcross(d, [b48, c], "Rate Album");
    assert.equal(note, "Saved 1 of 2. 1 couldn't be written.");
    assert.equal(await digest(b48), held, "the rate-switch file was rewritten under the decoder");
    assert.equal((await readTags(d, c)).album, "Rate Album");

    await d.click("#play-pause-btn");
    await d.waitFor(async () => (await d.probe()).currentNodePath === b48, {
      timeout: 20_000,
      message: "playback never crossed into the rate-switched track",
    });
    assert.equal((await d.probe()).isPlaying, true, "the rate switch stopped playback");
  } finally {
    await d.click("#play-pause-btn");
    await d.action("setFollowSampleRate", { enabled: false });
  }
});

test("an album played to its end can be edited whole", async () => {
  const d = h.driver;
  const { paths } = await makeLibrary(root, "drained", 3);

  // Play the last track to its end and leave it there — no Stop, which is the
  // point: the user listens to an album, it finishes, and they select it and edit
  // its tags. The engine still names that last track; only `queue_exhausted` says
  // it has let go of the file.
  await d.action("playPaths", { paths, startIndex: paths.length - 1 });
  await d.waitFor(async () => (await d.probe()).isPlaying === true, {
    message: "the album never started playing",
  });
  const tail = ((await d.probe()).duration as number) - 0.5;
  await d.invoke("audio_seek", { seconds: tail });
  // Both halves of "the album finished": the engine stopped, and the queue let go
  // of the playhead. They arrive on separate events — the stop lands a beat before
  // the queue rests — and it is the second one that says the album is over rather
  // than merely paused.
  await d.waitFor(
    async () => {
      const p = await d.probe();
      return p.isPlaying === false && p.currentNodePath === null;
    },
    { timeout: 20_000, message: "the queue never ran out" },
  );

  const note = await saveAlbumAcross(d, paths, "Whole Album");
  // Null: the form closed, which it only does when every file was written. A
  // refusal here would read "Saved 2 of 3. 1 couldn't be written." — the exact
  // shape the two tests above assert *for*.
  assert.equal(note, null, "a drained queue still refused one of its own tracks");
  for (const file of paths) {
    assert.equal((await readTags(d, file)).album, "Whole Album", path.basename(file));
  }
});

test("an album played to its end from the tree can be edited whole", async () => {
  const d = h.driver;
  const lib = await makeLibrary(root, "folder-drained", 2);
  const [first, last] = lib.paths;
  await writeTags(d, [first], { title: "Side A" });
  await writeTags(d, [last], { title: "Side B" });
  await useLibrary(d, lib, { [first]: "Side A", [last]: "Side B" });

  // The other drained test plays a *queue*, which lets go of its playhead at the
  // end — so it never sees the half of this the renderer owns. Folder playback
  // deliberately keeps its row highlighted (play resumes the finished track), and
  // a standing playhead is not a held file: the album is over, the handles are
  // gone, and the form has no business refusing the selection.
  await d.action("treeClick", {
    selector: `.node-label[data-path="${last}"]`,
    dbl: true,
  });
  await d.waitFor(
    async () => {
      const p = await d.probe();
      return p.currentNodePath === last && (p.duration as number) > 0 && p.isPlaying === true;
    },
    { timeout: 20_000, message: "the tree row never started playing" },
  );
  const tail = ((await d.probe()).duration as number) - 0.5;
  await d.invoke("audio_seek", { seconds: tail });
  // The folder ran out: playback stopped, and the row it stopped on is still the
  // one named — which is the state this test exists for.
  await d.waitFor(async () => (await d.probe()).isPlaying === false, {
    timeout: 20_000,
    message: "the folder never ran out",
  });
  assert.equal(
    (await d.probe()).currentNodePath,
    last,
    "folder playback should keep its playhead after the last track",
  );

  const note = await saveAlbumAcross(d, lib.paths, "Whole Folder");
  assert.equal(note, null, "a finished folder still refused its own last track");
  for (const file of lib.paths) {
    assert.equal((await readTags(d, file)).album, "Whole Folder", path.basename(file));
  }
});
