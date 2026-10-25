// Unit test for setText (src/dom.ts) — the guard that keeps a repainted label
// from eating the press that lands on it.
//
// Assigning textContent replaces an element's text node, and WebKit dispatches a
// click only if the release lands on the node the press remembered. A label
// rewritten on every progress event therefore swallows presses aimed at its
// lettering: that is how the metadata editor's Stop button came to work only when
// clicked on its padding. The invariant worth pinning down is the narrow one —
// an unchanged value is not written at all — so this asserts the write count
// rather than the resulting text, which was never what broke.
//
// A hand-rolled stub, not the fake DOM: that fake models textContent as own text
// rather than a child node, so the one thing under test here (whether the setter
// ran) is only observable on something that counts its own writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { setText } from "../src/dom.ts";

function countingElement(initial: string): { el: Element; writes: () => number } {
  let value = initial;
  let writes = 0;
  const el = {
    get textContent(): string {
      return value;
    },
    set textContent(next: string) {
      writes += 1;
      value = next;
    },
  };
  return { el: el as unknown as Element, writes: () => writes };
}

test("an unchanged label is never rewritten", () => {
  const { el, writes } = countingElement("Stop");
  // What a bulk tag write does ~12 times a second for the length of the batch.
  for (let i = 0; i < 12; i++) setText(el, "Stop");
  assert.equal(writes(), 0);
  assert.equal(el.textContent, "Stop");
});

test("a changed label is written once, then left alone", () => {
  const { el, writes } = countingElement("Cancel");
  setText(el, "Stop");
  assert.equal(writes(), 1);
  assert.equal(el.textContent, "Stop");
  setText(el, "Stop");
  assert.equal(writes(), 1);
});

test("clearing to empty still counts as a change", () => {
  const { el, writes } = countingElement("Play next");
  setText(el, "");
  assert.equal(writes(), 1);
  assert.equal(el.textContent, "");
  setText(el, "");
  assert.equal(writes(), 1);
});
