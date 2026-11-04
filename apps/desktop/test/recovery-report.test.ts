// Unit tests for the interrupted-save report (src/recovery-report.ts).
//
// Every sentence the user reads about a metadata save that a crash or a
// force-quit cut short is built there, out of nothing but a RecoveryNotice[] and
// a DiscardReport — so these run as plain functions: no DOM, no Tauri, no app
// build. Each case is named after the claim it defends, because the claims are
// the feature: the report has to word a damaged file, a copy nobody can place
// and a deletion that half-worked without ever telling the user something that
// didn't happen.
//
// The ones that would be caught nowhere else:
//   - a cause may only be named when it is the cause of every entry in the
//     group the sentence covers ("when Pudding stopped" about a save the user
//     watched fail is a lie);
//   - an entry can outlive its copy, and then there is nothing to retry, nothing
//     to keep and no advice to give;
//   - a copy whose record is unreadable names no track, and must not get an
//     Application Support path where a title goes;
//   - one closing instruction at most, and a copy that can be put back outranks
//     one nobody can place;
//   - a partial discard must never read as though nothing happened, and a mixed
//     set is counted in "entries" so neither kind stands in for the other.

import { test } from "node:test";
import assert from "node:assert/strict";
import type { DiscardReport, RecoveryNotice } from "../src/types.ts";
import {
  discardConfirmation,
  discardOutcome,
  discardRefusal,
  recoveryOffersAction,
  recoveryPanel,
} from "../src/recovery-report.ts";

const RECOVERY = "/tmp/profile/metadata-recovery";

// The three shapes an unresolved entry comes in, each with its own record path so
// the retry counting (which matches manifests) can tell two of them apart.
let seq = 0;
const slot = (): { manifest: string; backup: string } => {
  const base = `${RECOVERY}/.pudding-backup-${++seq}`;
  return { manifest: `${base}.json`, backup: base };
};

// A copy that is still on disk behind a readable record: the retryable case.
const copy = (name: string, over: Partial<RecoveryNotice> = {}): RecoveryNotice => ({
  restored: false,
  crashed: true,
  target: `/Music/${name}.mp3`,
  ...slot(),
  reason: "Another program replaced the track after the interrupted save.",
  ...over,
});

// A record that outlived its copy: still reported, but nothing left to put back.
const lost = (name: string, over: Partial<RecoveryNotice> = {}): RecoveryNotice => ({
  ...copy(name, over),
  backup: null,
  reason: "The recovery copy is missing, so the original can't be put back.",
  ...over,
});

// A copy whose record was too damaged to say which track it belongs to.
const orphan = (over: Partial<RecoveryNotice> = {}): RecoveryNotice => ({
  ...copy("unused"),
  target: null,
  reason: "Pudding couldn't read the record of which track this copy belongs to.",
  ...over,
});

// Finished business: the track holds exactly the bytes it held before the save.
const restored = (name: string, over: Partial<RecoveryNotice> = {}): RecoveryNotice => ({
  restored: true,
  crashed: true,
  target: `/Music/${name}.mp3`,
  manifest: null,
  backup: null,
  reason: null,
  ...over,
});

const labels = (notices: RecoveryNotice[], retried?: string[]): string[] =>
  recoveryPanel(notices, retried).buttons.map((button) => button.label);

const kinds = (notices: RecoveryNotice[], retried?: string[]): string[] =>
  recoveryPanel(notices, retried).buttons.map((button) => button.kind);

// === What the sweep settled by itself ===

test("a single restored track is named, and claims nothing about siblings it can't count", () => {
  const panel = recoveryPanel([restored("Night Bus")]);
  assert.equal(panel.heading, "Recovered an interrupted save");
  assert.match(
    panel.message,
    /^“Night Bus\.mp3” was being rewritten when Pudding stopped, and has been put back the way it was before that update\./,
  );
  // The hedge: a one-file save has no siblings, so the sentence has to be true
  // of that too rather than inventing them.
  assert.match(panel.message, /Any other tracks the update had already finished/);
  // Nothing is unresolved, so the only offer is to acknowledge it.
  assert.deepEqual(kinds([restored("Night Bus")]), ["dismiss"]);
  assert.deepEqual(labels([restored("Night Bus")]), ["Done"]);
  // And the one place the paths are written down.
  assert.deepEqual(panel.details, ["/Music/Night Bus.mp3 — restored"]);
});

test("several restored tracks are counted, and every one of them is still named", () => {
  const notices = [restored("Night Bus"), restored("Neon Harbor"), restored("Drift")];
  const panel = recoveryPanel(notices);
  assert.match(
    panel.message,
    /^3 tracks were being rewritten when Pudding stopped, and have been put back the way they were before those updates\./,
  );
  assert.match(panel.message, /Any other tracks those updates had already finished/);
  assert.deepEqual(panel.details, [
    "/Music/Night Bus.mp3 — restored",
    "/Music/Neon Harbor.mp3 — restored",
    "/Music/Drift.mp3 — restored",
  ]);
});

// === What it had to keep ===

test("a kept copy says the file may be incomplete and offers the retry", () => {
  const notice = copy("Night Bus");
  const panel = recoveryPanel([notice]);
  assert.equal(panel.heading, "A metadata save didn't finish");
  assert.match(panel.message, /“Night Bus\.mp3” was being rewritten when Pudding stopped/);
  assert.match(panel.message, /so that file may be incomplete\. A copy of the original is kept\./);
  assert.match(panel.message, /It's the only original, so keep it until you're sure/);
  assert.deepEqual(labels([notice]), ["Retry restore", "Discard copy", "Dismiss"]);
  // The reason and, separately, where the bytes are — nobody goes looking in
  // Application Support on a hunch.
  assert.deepEqual(panel.details, [
    `/Music/Night Bus.mp3: ${notice.reason}`,
    `Copy of the original: ${notice.backup}`,
  ]);
  // The retry is aimed at the record, which is what the command takes.
  assert.deepEqual(panel.buttons[0], {
    kind: "retry",
    label: "Retry restore",
    manifests: [notice.manifest],
  });
});

test("several kept copies are counted in the plural, originals and all", () => {
  const notices = [copy("Night Bus"), copy("Neon Harbor")];
  const panel = recoveryPanel(notices);
  assert.match(
    panel.message,
    /^2 tracks were being rewritten when Pudding stopped, and Pudding couldn't put the originals back, so those files may be incomplete\. A copy of each original is kept\./,
  );
  assert.match(panel.message, /They're the only originals, so keep them/);
  assert.deepEqual(labels(notices), ["Retry restore", "Discard copies", "Dismiss"]);
});

test("with one copy unresolved the restored tracks are context, not the headline", () => {
  const notices = [copy("Night Bus"), restored("Neon Harbor"), restored("Drift")];
  const panel = recoveryPanel(notices);
  assert.equal(panel.heading, "A metadata save didn't finish");
  assert.match(panel.message, /2 other interrupted tracks were put back the way they were\./);
  // Counted in the sentence, named only in the list — the headline belongs to
  // the file that may still be damaged.
  assert.doesNotMatch(panel.message, /Neon Harbor|Drift/);
  assert.ok(panel.details.includes("/Music/Neon Harbor.mp3 — restored"));
  assert.ok(panel.details.includes("/Music/Drift.mp3 — restored"));
  // Three entries in play, so the hedge goes plural even though one track is
  // unresolved and two were restored.
  assert.match(panel.message, /Any other tracks those updates had already finished/);
});

test("one restored track alongside a kept copy is still counted as one other", () => {
  const panel = recoveryPanel([copy("Night Bus"), restored("Drift")]);
  assert.match(panel.message, /One other interrupted track was put back the way it was\./);
});

// === Who to blame ===

test("a group Pudding was stopped under blames the stop", () => {
  const panel = recoveryPanel([copy("Night Bus"), copy("Neon Harbor")]);
  assert.match(panel.message, /rewritten when Pudding stopped/);
});

test("a save the user watched fail is not reported as a crash", () => {
  const panel = recoveryPanel([copy("Night Bus", { crashed: false })]);
  assert.match(
    panel.message,
    /rewritten when an earlier save failed and Pudding couldn't undo it/,
  );
  assert.doesNotMatch(panel.message, /when Pudding stopped/);
});

test("a group of both kinds falls back to the one thing true of all of them", () => {
  const panel = recoveryPanel([copy("Night Bus"), copy("Neon Harbor", { crashed: false })]);
  assert.match(
    panel.message,
    /2 tracks were being rewritten when earlier updates were interrupted/,
  );
  assert.doesNotMatch(panel.message, /when Pudding stopped/);
  assert.doesNotMatch(panel.message, /an earlier save failed/);
});

test("each sentence blames the cause of its own group, not of the report", () => {
  // A crashed copy and a retained record-without-copy: two sentences, two
  // causes. Hedging both to "interrupted" would throw away a cause each group
  // agrees on.
  const panel = recoveryPanel([copy("Night Bus"), lost("Neon Harbor", { crashed: false })]);
  assert.match(panel.message, /“Night Bus\.mp3” was being rewritten when Pudding stopped/);
  assert.match(
    panel.message,
    /“Neon Harbor\.mp3” was being rewritten when an earlier save failed and Pudding couldn't undo it/,
  );
});

// === The entry with nothing behind it ===

test("a record that outlived its copy is offered no retry and no advice", () => {
  const notice = lost("Night Bus");
  const panel = recoveryPanel([notice]);
  assert.match(
    panel.message,
    /its recovery copy is gone too, so Pudding has nothing left to put back\./,
  );
  // No retry: resolving needs bytes. No "keep it": there is nothing to keep,
  // and what to do with a file that may be damaged is the user's call.
  assert.deepEqual(labels([notice]), ["Clear record", "Dismiss"]);
  assert.doesNotMatch(panel.message, /Retry the restore|keep (it|them) until/);
  assert.doesNotMatch(panel.message, /A copy of the original is kept/);
  // And no copy line in the list, because there is no copy to point at.
  assert.deepEqual(panel.details, [`/Music/Night Bus.mp3: ${notice.reason}`]);
});

test("several records with no copies left are counted as such", () => {
  const panel = recoveryPanel([lost("Night Bus"), lost("Neon Harbor")]);
  assert.match(
    panel.message,
    /^2 tracks were being rewritten when Pudding stopped, so those files may be incomplete and their recovery copies are gone too/,
  );
  assert.deepEqual(labels([lost("a"), lost("b")]), ["Clear records", "Dismiss"]);
});

// === The copy nobody can place ===

test("an orphan copy gets its own sentence and no track name", () => {
  const only = orphan();
  const panel = recoveryPanel([only]);
  assert.match(
    panel.message,
    /^Pudding kept a recovery copy from an interrupted save, but couldn't read the record of which track it belongs to\./,
  );
  assert.match(panel.message, /The copy is at the path below; keep it until you've worked out/);
  // No retry — resolving means reading the record, and the record is what's
  // damaged. Discarding is all that is left.
  assert.deepEqual(labels([only]), ["Discard copy", "Dismiss"]);
  // The record's own path is a file the user has no use for; the copy is not.
  assert.deepEqual(panel.details, [
    `A recovery copy Pudding couldn't identify: ${only.reason}`,
    `Copy of the original: ${only.backup}`,
  ]);
  assert.ok(!panel.details.some((line) => line.includes(only.manifest!)));
});

test("an orphan travelling with a named copy says it kept that one also", () => {
  const panel = recoveryPanel([copy("Night Bus"), orphan()]);
  assert.match(panel.message, /Pudding also kept a recovery copy from an interrupted save/);
  // One closing instruction, and the placeable copy wins it: that is the only
  // case where the original can still get back where it belongs.
  assert.match(panel.message, /Retry the restore, or put the copy back in place yourself/);
  assert.doesNotMatch(panel.message, /keep it until you've worked out which track/);
  assert.deepEqual(labels([copy("a"), orphan()]), ["Retry restore", "Discard copies", "Dismiss"]);
});

test("several orphans are counted, and the records stay plural with them", () => {
  const panel = recoveryPanel([orphan(), orphan()]);
  assert.match(
    panel.message,
    /^Pudding kept 2 recovery copies from interrupted saves, but couldn't read the records of which tracks they belong to\./,
  );
  assert.match(panel.message, /The copies are at the paths below/);
});

test("an orphan alongside a record with no copy still owns the closing advice", () => {
  // Neither can be retried, so the only instruction left is the orphan's.
  const panel = recoveryPanel([lost("Night Bus"), orphan()]);
  assert.match(panel.message, /Pudding also kept a recovery copy/);
  assert.match(panel.message, /The copy is at the path below/);
  assert.doesNotMatch(panel.message, /Retry the restore/);
});

// === What the discard button says it will do ===

test("the discard button names copies, records, or neither", () => {
  assert.equal(labels([copy("a")])[1], "Discard copy");
  assert.equal(labels([copy("a"), copy("b")])[1], "Discard copies");
  assert.equal(labels([lost("a")])[0], "Clear record");
  assert.equal(labels([lost("a"), lost("b")])[0], "Clear records");
  // A set holding both kinds is named by neither: a count here would be one
  // kind standing in for the whole button.
  assert.equal(labels([copy("a"), lost("b")])[1], "Discard");
});

test("the discard acts on every record, including the ones past retrying", () => {
  const notices = [copy("Night Bus"), lost("Neon Harbor"), orphan()];
  const panel = recoveryPanel(notices);
  const discard = panel.buttons.find((button) => button.kind === "discard");
  assert.ok(discard?.kind === "discard");
  assert.deepEqual(
    discard.records.map((notice) => notice.manifest),
    notices.map((notice) => notice.manifest),
  );
  // While the retry is aimed only at what it can act on.
  const retry = panel.buttons.find((button) => button.kind === "retry");
  assert.ok(retry?.kind === "retry");
  assert.deepEqual(retry.manifests, [notices[0].manifest]);
});

test("a restored-only report is dismissed with Done, an unresolved one with Dismiss", () => {
  assert.equal(labels([restored("a")]).at(-1), "Done");
  assert.equal(labels([copy("a")]).at(-1), "Dismiss");
  assert.equal(labels([restored("a"), copy("b")]).at(-1), "Dismiss");
});

test("an entry whose reason the backend left empty still gets a line", () => {
  const panel = recoveryPanel([copy("Night Bus", { reason: null })]);
  assert.equal(
    panel.details[0],
    "/Music/Night Bus.mp3: Pudding couldn't put the original back.",
  );
});

// === After a retry ===

test("a retry that settled the entry says so, and the restore is the report", () => {
  // What the backend hands back: the record is gone and the entry comes back
  // restored, so the panel's own account is the restore.
  const panel = recoveryPanel([restored("Night Bus")], [`${RECOVERY}/.pudding-backup-1.json`]);
  assert.equal(panel.heading, "That entry is settled");
  assert.match(panel.message, /^“Night Bus\.mp3” was being rewritten/);
  assert.deepEqual(
    panel.buttons.map((button) => button.label),
    ["Done"],
  );
});

test("a retry that settled two of two says so in the plural", () => {
  const retried = [`${RECOVERY}/a.json`, `${RECOVERY}/b.json`];
  const panel = recoveryPanel([restored("Night Bus"), restored("Neon Harbor")], retried);
  assert.equal(panel.heading, "Those entries are settled");
});

test("a retry that changed nothing says that, and offers itself again", () => {
  const stuck = copy("Night Bus");
  const panel = recoveryPanel([stuck], [stuck.manifest!]);
  assert.equal(panel.heading, "The retry didn't help");
  assert.match(panel.message, /^That entry is in the same state as before it ran\. /);
  // The account of what is left follows the lead unchanged.
  assert.match(panel.message, /“Night Bus\.mp3” was being rewritten when Pudding stopped/);
  // Offered again: the usual cause is storage that hasn't come back yet, and
  // that can change between one press and the next.
  assert.deepEqual(labels([stuck], [stuck.manifest!]), [
    "Retry again",
    "Discard copy",
    "Dismiss",
  ]);
});

test("a retry that changed nothing for several of them stays plural", () => {
  const a = copy("Night Bus");
  const b = copy("Neon Harbor");
  const panel = recoveryPanel([a, b], [a.manifest!, b.manifest!]);
  assert.equal(panel.heading, "The retry didn't help");
  assert.match(panel.message, /^Those entries are in the same state as before it ran\./);
});

test("a partial retry counts what moved by subtraction, never by matching", () => {
  const a = copy("Night Bus");
  const b = copy("Neon Harbor");
  // Two sent, one came back stuck: the other settled, and the only evidence of
  // it is that it is no longer in the report.
  const panel = recoveryPanel([a], [a.manifest!, b.manifest!]);
  assert.equal(panel.heading, "The retry settled some of them");
  assert.match(panel.message, /^1 of 2 are resolved; the other is unchanged\./);
});

test("a partial retry with several still stuck says others, not other", () => {
  const a = copy("Night Bus");
  const b = copy("Neon Harbor");
  const c = copy("Drift");
  const panel = recoveryPanel([a, b], [a.manifest!, b.manifest!, c.manifest!]);
  assert.match(panel.message, /^1 of 3 are resolved; the others are unchanged\./);
});

test("the settled and the stuck always add up to what the retry was given", () => {
  const entries = [copy("a"), copy("b"), copy("c")];
  const retried = entries.map((notice) => notice.manifest!);
  for (let back = 0; back <= entries.length; back += 1) {
    const panel = recoveryPanel(entries.slice(0, back), retried);
    const settled = retried.length - back;
    // Read the two numbers back out of the sentence the panel chose, which is
    // the only place they surface.
    if (back === 0) assert.equal(panel.heading, "Those entries are settled");
    else if (settled === 0) assert.equal(panel.heading, "The retry didn't help");
    else {
      assert.equal(panel.heading, "The retry settled some of them");
      assert.match(panel.message, new RegExp(`^${settled} of ${retried.length} are resolved;`));
    }
  }
});

test("an entry the retry could not act on survives it, with its path intact", () => {
  // §10's case: one copy retried, an unidentifiable copy also present. The
  // orphan is still the only place its path is written down, so a retry that
  // deliberately left it alone must not drop it.
  const stuck = copy("Night Bus");
  const also = orphan();
  const panel = recoveryPanel([stuck, also], [stuck.manifest!]);
  assert.equal(panel.heading, "The retry didn't help");
  assert.match(panel.message, /Pudding also kept a recovery copy/);
  assert.ok(panel.details.includes(`Copy of the original: ${also.backup}`));
  const discard = panel.buttons.find((button) => button.kind === "discard");
  assert.ok(discard?.kind === "discard");
  assert.equal(discard.records.length, 2);
});

test("an orphan left behind by a retry that worked does not read as a failure", () => {
  // The orphan was never sent, so it is not evidence the retry achieved nothing.
  const stuck = copy("Night Bus");
  const also = orphan();
  const panel = recoveryPanel([also], [stuck.manifest!]);
  assert.equal(panel.heading, "That entry is settled");
  assert.match(panel.message, /^Pudding kept a recovery copy/);
});

// === What the discard managed ===

const report = (discarded: number, failure: string | null = null): DiscardReport => ({
  discarded,
  failure,
});

test("a discard that went through names what is gone", () => {
  assert.deepEqual(discardOutcome(report(1), [copy("a")]), {
    heading: "Recovery copy discarded",
    message: "The copy is gone.",
  });
  assert.deepEqual(discardOutcome(report(2), [copy("a"), copy("b")]), {
    heading: "Recovery copies discarded",
    message: "The copies are gone.",
  });
});

test("clearing records that held nothing is not reported as deleting copies", () => {
  assert.deepEqual(discardOutcome(report(2), [lost("a"), lost("b")]), {
    heading: "Recovery records discarded",
    message: "The records are gone.",
  });
});

test("a mixed discard counts the copies and mentions the records it also cleared", () => {
  assert.deepEqual(discardOutcome(report(3), [copy("a"), lost("b"), lost("c")]), {
    heading: "Recovery copy discarded",
    message: "The copy is gone. 2 records with no copy left were cleared too.",
  });
  assert.deepEqual(discardOutcome(report(2), [copy("a"), lost("b")]), {
    heading: "Recovery copy discarded",
    message: "The copy is gone. A record with no copy left was cleared too.",
  });
});

test("a partial discard says how many went, never that nothing did", () => {
  const refused = "Couldn't remove /tmp/profile/metadata-recovery/.pudding-backup-9: Permission denied";
  const outcome = discardOutcome(report(2, refused), [copy("a"), copy("b"), copy("c")]);
  assert.equal(outcome.heading, "Couldn't discard all of them");
  assert.equal(
    outcome.message,
    `2 of 3 recovery copies are gone for good; the rest are still in place. ${refused}`,
  );
});

test("a partial discard of a mixed set is counted in entries", () => {
  // Which kind survived a mixed set isn't knowable from a total, and calling
  // them all copies would be the overcount the copy/record split exists to
  // avoid.
  const outcome = discardOutcome(report(1, "Couldn't remove /x: Permission denied"), [
    copy("a"),
    lost("b"),
    lost("c"),
  ]);
  assert.equal(
    outcome.message,
    "1 of 3 recovery entries are gone for good; the rest are still in place. " +
      "Couldn't remove /x: Permission denied",
  );
});

test("a discard that could remove nothing is counted like the others", () => {
  const failure = "Couldn't remove /a: Permission denied; /b: Permission denied";
  assert.deepEqual(discardOutcome(report(0, failure), [copy("a"), copy("b")]), {
    // Plural, because this branch is reached with a whole selection refused
    // just as often as with one.
    heading: "Couldn't discard the recovery copies",
    message: failure,
  });
  assert.equal(
    discardOutcome(report(0, failure), [copy("a")]).heading,
    "Couldn't discard the recovery copy",
  );
});

test("a discard the command refused outright still says what didn't happen", () => {
  // No sentence came back — the call was rejected, not the unlink — so the
  // report is all there is to say.
  assert.deepEqual(discardRefusal([copy("a"), copy("b")]), {
    heading: "Couldn't discard the recovery copies",
    message: "Couldn't remove the recovery copies.",
  });
  assert.deepEqual(discardRefusal([lost("a")], "That isn't one of Pudding's recovery records."), {
    heading: "Couldn't discard the recovery record",
    message: "That isn't one of Pudding's recovery records.",
  });
});

// === An outcome mounted over the report ===
//
// A discard is partial by design and a retry can throw, and either way the
// entries the action didn't settle are still held: still unresolved, and for a
// kept copy still the only original bytes that track has. The report is opened
// once, at launch, so an outcome that replaced it would be those entries' last
// offer until the app restarts. These defend the outcome being stated *over* a
// report that still carries them.

test("an outcome keeps the report, and the report keeps its offers", () => {
  const stuck = copy("Night Bus");
  const outcome = discardOutcome(report(1, "Couldn't remove /x: Permission denied"), [
    stuck,
    copy("Neon Harbor"),
  ]);
  const panel = recoveryPanel([stuck], undefined, outcome);
  assert.equal(panel.heading, "Couldn't discard all of them");
  // Said first and in full: what the discard managed is the question the panel
  // is answering.
  assert.ok(panel.message.startsWith(`${outcome.message} `));
  // And the account of what is left follows it unchanged, down to the path the
  // surviving copy's bytes are at.
  assert.match(panel.message, /was being rewritten when Pudding stopped/);
  assert.deepEqual(
    panel.buttons.map((button) => button.kind),
    ["retry", "discard", "dismiss"],
  );
  assert.ok(panel.details.includes(`Copy of the original: ${stuck.backup}`));
});

test("an outcome the caller holds outranks the one a retry would have derived", () => {
  // The entries look the same after a call that threw as after a retry that
  // changed nothing, so the subtraction would word a failed discard as a retry.
  const stuck = copy("Night Bus");
  const retried = [stuck.manifest!];
  assert.equal(recoveryPanel([stuck], retried).heading, "The retry didn't help");
  const outcome = discardRefusal([stuck], "That isn't one of Pudding's recovery records.");
  const panel = recoveryPanel([stuck], retried, outcome);
  assert.equal(panel.heading, "Couldn't discard the recovery copy");
  assert.ok(panel.message.startsWith("That isn't one of Pudding's recovery records. "));
  // The retry is still offered, and still knows one has already run.
  assert.deepEqual(
    panel.buttons.map((button) => button.label),
    ["Retry again", "Discard copy", "Dismiss"],
  );
});

test("a report with an unresolved entry left is never safe to mount an outcome alone", () => {
  // What the caller checks before it mounts an outcome on its own. True for
  // every shape an unresolved entry comes in, including the two that can only
  // be discarded.
  for (const notice of [copy("Night Bus"), lost("Night Bus"), orphan()]) {
    assert.equal(recoveryOffersAction(recoveryPanel([notice])), true);
  }
});

test("a report that only closes asks nothing of the user", () => {
  // The discard that got through its whole list: what is left is the restores,
  // which the user has just read about and can do nothing with.
  const panel = recoveryPanel([restored("Night Bus")]);
  assert.deepEqual(
    panel.buttons.map((button) => button.kind),
    ["dismiss"],
  );
  assert.equal(recoveryOffersAction(panel), false);
});

// === The confirmation ===

test("the confirmation names the track whose only original is at stake", () => {
  assert.deepEqual(discardConfirmation([copy("Night Bus")]), {
    title: "Discard recovery copy?",
    message:
      "This deletes the recovery copy of Night Bus.mp3. " +
      "That track may still be incomplete on disk, and this is the only copy of the original.",
  });
});

test("the confirmation counts several copies and warns about all of them", () => {
  assert.deepEqual(discardConfirmation([copy("Night Bus"), copy("Neon Harbor")]), {
    title: "Discard recovery copies?",
    message:
      "This deletes 2 recovery copies. " +
      "Those tracks may still be incomplete on disk, and these are the only copies of the originals.",
  });
});

test("a copy with no track to name is described as what it is", () => {
  assert.deepEqual(discardConfirmation([orphan()]), {
    title: "Discard recovery copy?",
    message:
      "This deletes a recovery copy Pudding couldn't match to a track. " +
      "Some track may still be incomplete on disk, and this is the only copy of its original.",
  });
});

test("the confirmation also names the bare records the button clears", () => {
  // Mentioned, not warned about: these hold no bytes, so they belong in the
  // account of what goes and not in the caveat about originals.
  assert.match(
    discardConfirmation([copy("Night Bus"), lost("Neon Harbor")])!.message,
    /^This deletes the recovery copy of Night Bus\.mp3\. It also clears one record whose copy is already gone\. That track may still be incomplete/,
  );
  assert.match(
    discardConfirmation([copy("Night Bus"), lost("a"), lost("b")])!.message,
    / It also clears 2 records whose copies are already gone\. /,
  );
});

test("a set that holds no copies is not worth confirming", () => {
  // Nothing to lose, so a confirmation would protect nothing and ask the user
  // to agree to a deletion that isn't one.
  assert.equal(discardConfirmation([lost("a"), lost("b")]), null);
});
