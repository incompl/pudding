// Unit tests for the one aside a track row wears (src/row-status.ts).
//
// Four markers share a single slot, and all four come out of one function, so
// what is worth pinning down here is the priority between them and which of them
// are wordless. The glyph states are the delicate pair: cloud and spinner are the
// same fact at two moments, they carry their words only as a tooltip and an
// accessible name, and the engine walks a row from one to the other and out
// again as it works through a queue of cloud files.
//
// Two things these tests deliberately do NOT cover.
//
// paintStatus's span reuse — that a row flipping cloud → spinner sheds the class
// it had, rather than ending up with both and rotating a cloud — needs a DOM:
// querySelector, and a classList that agrees with className. The fake DOM
// (test/fake-dom.ts) has neither, by design, and growing it for this is a change
// to shared test infrastructure rather than to this module. The invariant is held
// in the code's shape instead: paintStatus toggles *both* glyph classes with an
// explicit boolean on every paint, so there is no one-way path through it.
//
// And placement: the glyphs' sub-pixel seat in the 14px cap band is real-WebKit
// pixel work, which is what `pnpm caliper` is for, not node.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

import { rowStatus, type StatusRow } from "../src/row-status.ts";
import { downloadedPaths } from "../src/state.ts";

const PATH = "/m/a.flac";
const track = (over: Partial<StatusRow> = {}): StatusRow => ({ path: PATH, ...over });

beforeEach(() => {
  downloadedPaths.clear();
});

test("the row the engine is parked on wears the spinner, wordless", () => {
  assert.deepEqual(rowStatus(track({ notDownloaded: true }), PATH), {
    label: "Downloading",
    glyph: "spinner",
  });
});

test("a cloud file nobody is fetching rests as the cloud", () => {
  assert.deepEqual(rowStatus(track({ notDownloaded: true }), null), {
    label: "Not downloaded",
    glyph: "cloud",
  });
});

test("the spinner is for the fetched path only, not every cloud row in the list", () => {
  // One path at a time: the engine parks on exactly one track, and the rest of a
  // cloud-backed list must stay resting.
  assert.equal(rowStatus(track({ notDownloaded: true }), "/m/other.flac")?.glyph, "cloud");
});

test("a local file the engine is parked on still says it is downloading", () => {
  // No notDownloaded flag — the scan cache can be a step behind the provider, and
  // the engine parking on a path is the first-hand fact about it.
  assert.deepEqual(rowStatus(track(), PATH), { label: "Downloading", glyph: "spinner" });
});

test("the two faults keep their words, and no glyph", () => {
  assert.deepEqual(rowStatus(track({ missing: true }), null), { label: "(Missing file)" });
  assert.deepEqual(rowStatus(track({ stream: true }), null), { label: "(Stream)" });
});

test("missing outranks a download in flight, which outranks the cloud", () => {
  // Missing wins because there is nothing to download; its words must not be
  // replaced by a spinner that promises the file is on its way.
  assert.deepEqual(rowStatus(track({ notDownloaded: true, missing: true }), PATH), {
    label: "(Missing file)",
  });
  assert.equal(rowStatus(track({ notDownloaded: true }), PATH)?.glyph, "spinner");
});

test("a download that landed this session beats the flag the row was built with", () => {
  downloadedPaths.add(PATH);
  assert.equal(rowStatus(track({ notDownloaded: true }), null), null);
});

test("an ordinary local track wears nothing", () => {
  assert.equal(rowStatus(track(), null), null);
});

test("every wordless marker still carries its words for a pointer and a reader", () => {
  for (const fetching of [PATH, null]) {
    const s = rowStatus(track({ notDownloaded: true }), fetching);
    assert.ok(s?.glyph, "expected a glyph");
    assert.ok(s!.label.length > 0, "a glyph with no words answers nothing");
    assert.doesNotMatch(s!.label, /[()]/, "brackets are for the drawn markers only");
  }
});
