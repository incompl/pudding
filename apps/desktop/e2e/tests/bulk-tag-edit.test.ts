// Editing tags across a selection: what the form shows for files that disagree,
// what a save writes (and what it leaves alone), and what stopping one does.
//
// These are the first tests that write to the files they open, so they run against
// copies in a temp library on a throwaway profile — see e2e/tag-editing.ts for why
// both halves of that matter.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import type { Harness } from "../harness.ts";
import {
  digest,
  editorForm,
  editorFormOrClosed,
  editorOpen,
  makeLibrary,
  readTags,
  save,
  startIsolated,
  tempRoot,
  treeTitles,
  typeInEditor,
  useLibrary,
  writeTags,
} from "../tag-editing.ts";

let h: Harness;
let root: string;

before(async () => {
  root = await tempRoot("bulk-tags");
  h = await startIsolated(root);
});

after(async () => {
  await h?.close();
  if (root) await fs.rm(root, { recursive: true, force: true });
});

test("a bulk edit writes the fields that were typed in, and only those", async () => {
  const d = h.driver;
  const { dir, paths } = await makeLibrary(root, "three", 3);
  const [one, two, three] = paths;

  // Three files that agree about their artist, disagree about title, album and
  // year, and carry no genre at all — which is the distinction the form has to
  // draw: "they differ" and "they all have none" are both empty boxes, and only
  // the first is mixed.
  await writeTags(d, [one], {
    title: "Alpha",
    artist: "The Band",
    album: "First Album",
    year: 1999,
    comment: "sleeve note",
  });
  await writeTags(d, [two], {
    title: "Bravo",
    artist: "The Band",
    album: "First Album",
    year: 1999,
  });
  await writeTags(d, [three], {
    title: "Charlie",
    artist: "The Band",
    album: "Second Album",
    year: 2004,
  });
  await useLibrary(d, { dir, paths }, {
    [one]: "Alpha",
    [two]: "Bravo",
    [three]: "Charlie",
  });

  await d.action("editMetadata", { paths });
  const form = await editorForm(d);
  // The count is the confirmation of what is about to be rewritten.
  assert.equal(form.heading, "Editing 3 tracks");
  // Nothing said yet, so there is nothing to save: an empty patch would rewrite all
  // three files byte for byte and change only their Date Modified.
  assert.equal(form.submitDisabled, true, "Save should be dead on an untouched form");
  assert.deepEqual(
    { value: form.fields.Artist.value, mixed: form.fields.Artist.mixed },
    { value: "The Band", mixed: false },
    "the one field they agree on should show its value, not a placeholder",
  );
  for (const label of ["Title", "Album"]) {
    assert.deepEqual(
      { value: form.fields[label].value, placeholder: form.fields[label].placeholder },
      { value: "", placeholder: "Multiple values" },
      `${label} should be empty and say why`,
    );
    assert.equal(form.fields[label].mixed, true, `${label} should be marked mixed`);
  }
  // A numeric box is too narrow for "Multiple values" and says it in the space it
  // has.
  assert.equal(form.fields.Year.placeholder, "—");
  assert.equal(form.fields.Year.value, "");
  // Agreeing on nothing is not disagreeing: Genre is empty on all three, so it is
  // an ordinary empty box — and a save that doesn't touch it leaves it alone.
  assert.equal(form.fields.Genre.mixed, false);
  assert.equal(form.fields.Genre.placeholder, "");
  // Same distinction in the artwork well: none of them carry a picture.
  assert.equal(form.artwork?.placeholder, "No artwork");

  await typeInEditor(d, "Album", "One True Album");
  await save(d);
  // A save with nothing to report closes the form. Anything else — a refusal, a
  // partial batch — leaves it up with a note, so this is also the assertion that
  // all three files were written.
  await d.waitFor(async () => !(await editorOpen(d)), {
    message: "the editor stayed open, so the save had something to report",
  });

  for (const [file, title, year] of [
    [one, "Alpha", 1999],
    [two, "Bravo", 1999],
    [three, "Charlie", 2004],
  ] as const) {
    const tags = await readTags(d, file);
    assert.equal(tags.album, "One True Album", `${path.basename(file)}: album written`);
    // The whole point of the patch: three files, one album, and every other tag
    // still the file's own. Before the patch, Year alone would have made this
    // impossible — one of these two years would have been written over the other.
    assert.equal(tags.title, title, `${path.basename(file)}: title untouched`);
    assert.equal(tags.year, year, `${path.basename(file)}: year untouched`);
    assert.equal(tags.artist, "The Band");
  }
  // A field the form never sent at all, on a file that had one.
  assert.equal((await readTags(d, one)).comment, "sleeve note");

  // The corollary, and the reason this test looks at the tree: the patch describes
  // the edit, not the file. A save that handed the patch to the surfaces instead of
  // re-reading the tag would leave three rows all called "One True Album" — or
  // three rows with no title at all — over three perfectly good files.
  const titles = await treeTitles(d);
  assert.equal(titles[one], "Alpha");
  assert.equal(titles[two], "Bravo");
  assert.equal(titles[three], "Charlie");
});

test("emptying a mixed field clears that tag on every file, and says so before it does", async () => {
  const d = h.driver;
  const { dir, paths } = await makeLibrary(root, "clearing", 3);
  const [one, two, three] = paths;
  // Three files that disagree about genre and comment, and agree on an album none
  // of this is going to touch.
  await writeTags(d, [one], { title: "Alpha", genre: "Jazz", comment: "one", album: "Shared" });
  await writeTags(d, [two], { title: "Bravo", genre: "Blues", comment: "two", album: "Shared" });
  await writeTags(d, [three], { title: "Charlie", genre: "Folk", album: "Shared" });
  await useLibrary(d, { dir, paths }, { [one]: "Alpha" });

  await d.action("editMetadata", { paths });
  const seeded = await editorForm(d);
  assert.deepEqual(
    {
      value: seeded.fields.Genre.value,
      placeholder: seeded.fields.Genre.placeholder,
      dirty: seeded.fields.Genre.dirty,
    },
    { value: "", placeholder: "Multiple values", dirty: false },
    "a mixed field starts empty, explains itself, and is not yet part of the patch",
  );
  assert.equal(seeded.submitDisabled, true, "Save should be dead on an untouched form");

  // The gesture, exactly as a keyboard produces it: type a character, then delete
  // it. Two `input` events — and it has to be two, because a bare Backspace in an
  // already-empty box changes no value and so fires nothing at all. (Which is why
  // the test may not shortcut to a single empty `editorType`: that would mark the
  // field touched by a route the UI cannot reach, and would pass even if the real
  // gesture were broken.)
  await typeInEditor(d, "Genre", "x");
  await typeInEditor(d, "Genre", "");
  const armed = await editorForm(d);
  assert.deepEqual(
    {
      value: armed.fields.Genre.value,
      placeholder: armed.fields.Genre.placeholder,
      dirty: armed.fields.Genre.dirty,
    },
    { value: "", placeholder: "Clear", dirty: true },
    "an emptied mixed field should say it will be written, and what writing it does",
  );
  // Emptied is still armed: the gate counts fields that were edited, not fields
  // that ended up holding something — clearing a tag is a save like any other.
  assert.equal(armed.submitDisabled, false, "Save should wake once a field is armed");
  // And nothing else is: the mark is per field, which is the whole claim the patch
  // model makes — Comment disagrees just as much as Genre did and is going nowhere.
  assert.equal(armed.fields.Comment.dirty, false);
  assert.equal(armed.fields.Comment.placeholder, "Multiple values");
  assert.equal(armed.fields.Album.dirty, false);

  await save(d);
  await d.waitFor(async () => !(await editorOpen(d)), {
    message: "the editor stayed open, so the save had something to report",
  });

  for (const [file, comment] of [[one, "one"], [two, "two"], [three, null]] as const) {
    const tags = await readTags(d, file);
    assert.equal(tags.genre, null, `${path.basename(file)}: genre cleared`);
    // The two fields either side of it: one mixed and untouched, one agreed and
    // untouched. A clear that reached them would be the patch model failing in the
    // most expensive direction.
    assert.equal(tags.comment, comment, `${path.basename(file)}: comment untouched`);
    assert.equal(tags.album, "Shared", `${path.basename(file)}: album untouched`);
  }
});

test("stopping a large save keeps what it wrote and leaves the rest untouched", async () => {
  const d = h.driver;
  const COUNT = 400;
  const { dir, paths } = await makeLibrary(root, "many", COUNT);
  // One title for the lot, so every row has something to lose: a row still showing
  // it after the stop is a file the batch never reached. In chunks because a bridge
  // command has ten seconds to answer, and seeding is not what this is testing.
  for (let i = 0; i < paths.length; i += 100) {
    await writeTags(d, paths.slice(i, i + 100), { title: "Before" });
  }
  await useLibrary(d, { dir, paths }, { [paths[0]]: "Before" });
  // Every copy is the same bytes, so one pristine digest answers for all of them.
  const pristine = await digest(paths[0]);

  // Even-numbered files first, then the odd ones. The batch writes in the order it
  // is given, so this interleaves saved and unreached files through the top of the
  // tree — where the windowed list actually mounts rows — instead of stopping at a
  // clean line below everything on screen.
  const order = [
    ...paths.filter((_, i) => i % 2 === 0),
    ...paths.filter((_, i) => i % 2 === 1),
  ];

  await d.action("editMetadata", { paths: order });
  await typeInEditor(d, "Title", "Bulk Renamed");
  await save(d);

  // Stop as soon as the first file is through. Polled tightly because the window is
  // the length of the batch: this is racing a loop that rewrites a small file in a
  // millisecond or two.
  const outran =
    `the whole ${COUNT}-file batch finished before a Stop could land — ` +
    "raise COUNT until it doesn't";
  const during = await d.waitFor(
    async () => {
      const form = await editorFormOrClosed(d);
      if (!form) assert.fail(outran);
      return form.note && /^Saving\.\.\. [1-9]/.test(form.note) ? form : null;
    },
    { interval: 5, message: outran },
  );
  assert.match(during.note!, new RegExp(`^Saving\\.\\.\\. \\d+ of ${COUNT}$`));
  // While a batch is running the form is inert and the button beside Save changes
  // what it means — Cancel is Stop, because that is the only thing left to do.
  assert.equal(during.cancelLabel, "Stop");
  assert.equal(during.fields.Title.disabled, true);
  await d.click("#pane-editor-view .inline-editor-cancel");

  const stopped = await d.waitFor(
    async () => {
      const form = await editorFormOrClosed(d);
      if (!form) assert.fail(outran);
      return form.note?.startsWith("Stopped.") ? form.note : null;
    },
    { interval: 20, message: "the form never reported the batch as stopped" },
  );
  // Stopped is its own outcome, not a batch of failures: it counts what was saved,
  // and says nothing about failures because there were none.
  const count = stopped.match(new RegExp(`^Stopped\\. (\\d+) of ${COUNT} saved\\.$`));
  assert.ok(count, `unexpected note after Stop: ${stopped}`);
  const saved = Number(count[1]);
  assert.ok(saved > 0 && saved < COUNT, `a stop should land mid-batch, not at ${saved}`);

  // What changed on disk, byte for byte. Cancellation happens between files and
  // never inside one, so the files that changed are exactly the first `saved` of
  // the order the batch was given — and every other file is untouched, not
  // half-written.
  const changed: string[] = [];
  for (const file of order) {
    if ((await digest(file)) !== pristine) changed.push(file);
  }
  assert.deepEqual(changed, order.slice(0, saved), "the stop did not fall between files");
  assert.equal(changed.length, saved, "the note's count and the files on disk disagree");

  // And the surfaces agree with the disk, row by row: the ones that were written
  // show their new title, the ones the loop never reached still show the old one.
  const written = new Set(changed);
  const titles = await treeTitles(d);
  const rows = Object.keys(titles).filter((p) => p.startsWith(dir));
  assert.ok(rows.length > 0, "the Files tree had no rows mounted to check");
  for (const file of rows) {
    assert.equal(
      titles[file],
      written.has(file) ? "Bulk Renamed" : "Before",
      `${path.basename(file)} shows the wrong title for what the save did to it`,
    );
  }
  // The row-by-row check above is only worth something if both kinds were on
  // screen; a window holding nothing but saved rows would pass while proving half
  // of it.
  assert.ok(
    rows.some((p) => written.has(p)) && rows.some((p) => !written.has(p)),
    "the mounted rows held only one kind — saved and unreached should interleave",
  );
});

test("a mixed Title says so even when the files share a file name", async () => {
  const d = h.driver;
  // Two copies of the same file name in different folders — the everyday case is
  // "01 Intro.mp3" once per album. The selection agrees on the file name and
  // disagrees on the Title, which is the one combination where Title's own
  // placeholder (the file name it stands in for) and the mixed placeholder both
  // have something to say.
  const left = await makeLibrary(root, "samename-left", 1);
  const right = await makeLibrary(root, "samename-right", 1);
  const paths = [left.paths[0], right.paths[0]];
  assert.equal(
    path.basename(paths[0]),
    path.basename(paths[1]),
    "the fixtures must share a file name for this to test anything",
  );
  await writeTags(d, [paths[0]], { title: "Intro" });
  await writeTags(d, [paths[1]], { title: "Outro" });

  await d.action("editMetadata", { paths });
  const form = await editorForm(d);
  assert.equal(form.heading, "Editing 2 tracks");
  // The file name would be a lie here: the box is empty because the titles differ,
  // not because there is one title missing and a file name standing in for it.
  assert.deepEqual(
    {
      value: form.fields.Title.value,
      placeholder: form.fields.Title.placeholder,
      mixed: form.fields.Title.mixed,
    },
    { value: "", placeholder: "Multiple values", mixed: true },
  );
  await d.click("#pane-editor-view .inline-editor-cancel");
  await d.waitFor(async () => !(await editorOpen(d)), {
    message: "the editor never closed",
  });
});
