// The startup half of the interrupted-save report: the sweep running against the
// app's real app-data root during `setup()`, the notices being *held* rather than
// emitted, and the frontend fetching and rendering them at boot.
//
// That wiring is the one thing neither the Rust tests (which call the sweep
// directly) nor the TypeScript tests (which build notices by hand) can reach, so
// this suite asserts nothing about wording or counting that those already own —
// only that a plant on disk before launch becomes a panel on screen after it, and
// that its buttons are wired to the commands behind them.
//
// Each case needs its own launch, because the sweep runs once per process and a
// plant has to be on disk before it does. So unlike the other suites this one
// starts and stops the app per test, with its own temp profile each time: the
// plant lives inside that profile (`--profile`), so the real Application Support
// recovery folder is never opened and nothing outlives the run.
//
// Discard is driven from here too, through the bridge's dialog stub
// (`answerDialogs`): the plugin's native `confirm()` is one invoke of
// `plugin:dialog|message` resolving to the clicked button's label, so the stub
// answers it without an NSAlert the harness would have no way to dismiss. The
// app's own code path is untouched, which is the point — the title and message
// asserted below are the ones `discardRecovery` really handed the plugin.
//
// What that adds over the suites either side of it is only the glue, and the
// tests are scoped to it. The wording is recovery-report.ts's and is asserted in
// full in test/recovery-report.test.ts; the filesystem outcomes are lib.rs's and
// are asserted in its own tests over the same two refusals planted here. What
// nothing else can see is that the button's records are the ones that reach the
// confirmation and the command, that declining really stops the deletion, and
// that a real DiscardReport over really-stuck files renders as the right panel.
// So each case below drives a button, reads the dialog, and then looks at the
// disk — never at a sentence another suite owns.
//
// One case does raise the real alert, through `native-ui.ts` and the macOS
// accessibility tree, because what the stub steps over is worth one test: that
// `confirm()` puts something on screen at all, that it says what the stub only
// saw it being handed, and that Escape, Cancel and Ok are each honoured. It is
// the only test here that needs the developer's machine to allow one process to
// read another's UI, so it skips where that isn't granted.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {
  cleanPlants,
  clickPanelButton,
  operationPanel,
  operationPanelOrNone,
  startPlanted,
  tempRoot,
  type OperationPanel,
  type Planted,
} from "../tag-editing.ts";
import type { Driver } from "../harness.ts";
import {
  escapeAlert,
  pressAlertButton,
  unavailableReason,
  waitForAlert,
} from "../native-ui.ts";

// Launch on a freshly planted profile, run the body, and take the whole thing
// down again — including the app, because the next case needs its own sweep.
async function launched(
  name: string,
  plants: string[][],
  body: (ctx: {
    d: Driver;
    profile: string;
    planted: Planted[];
    /** The app process, for the one test that drives its native UI from outside. */
    pid: number;
  }) => Promise<void>,
): Promise<void> {
  const root = await tempRoot(name);
  const { harness, profile, planted, pid } = await startPlanted(root, plants);
  try {
    if (pid === null) throw new Error("the harness attached to an app it didn't spawn");
    await body({ d: harness.driver, profile, planted, pid });
  } finally {
    await harness.close();
    // Ahead of the rm, which two of the plant flags below defeat: `--stick`
    // leaves the copy carrying uchg and `--lock-folder` leaves the recovery
    // directory at mode 500, and neither yields to `fs.rm`, `force` or not.
    // Best-effort so a failure here can't stand in for the body's own — the rm
    // is the thing that throws if anything was actually left behind.
    try {
      cleanPlants(profile);
    } catch (error) {
      console.error(`couldn't undo the plant in ${profile}:`, error);
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}

// The report is kicked off at boot but deliberately not awaited (it opens the
// right pane, and a player must never wait on it), so it arrives whenever it
// arrives.
async function reportedPanel(d: Driver): Promise<OperationPanel> {
  return d.waitFor(() => operationPanelOrNone(d), {
    timeout: 20_000,
    message: "the interrupted-save report never reached the pane",
  });
}

test("a copy the sweep could not put back is reported at launch", async () => {
  await launched("recovery-kept", [["--mode", "replaced", "--name", "Night Bus"]], async ({
    d,
    profile,
    planted,
  }) => {
    const panel = await reportedPanel(d);

    assert.equal(panel.heading, "A metadata save didn't finish");
    // The track, and the fact that the file on disk may not be whole. Both
    // sentences are asserted in full in the unit suite; here they only have to
    // have come from this plant.
    assert.match(panel.message, /“Night Bus\.mp3” was being rewritten when Pudding stopped/);
    assert.match(panel.message, /that file may be incomplete/);

    // The path the copy's bytes are actually at, under this test's own profile —
    // which is also the assertion that the sweep ran against the app-data root
    // the harness handed it and not the real one.
    assert.ok(
      planted[0].copy.startsWith(profile),
      `the plant should be inside the test profile: ${planted[0].copy}`,
    );
    assert.ok(
      panel.details.includes(`Copy of the original: ${planted[0].copy}`),
      `the report should point at the copy. Details:\n${panel.details.join("\n")}`,
    );
    assert.ok(
      panel.details.some((line) => line.startsWith(`${planted[0].track}: `)),
      `and name the track and why it was kept. Details:\n${panel.details.join("\n")}`,
    );

    assert.deepEqual(panel.buttons, ["Retry restore", "Discard copy", "Dismiss"]);

    // Dismissing takes the report down. It is the only offer here with nothing
    // behind it, and the report stays until it is taken: a kept copy is not a
    // transient, so nothing else may close this.
    await clickPanelButton(d, "Dismiss");
    await d.waitFor(async () => (await operationPanelOrNone(d)) === null, {
      message: "Dismiss left the report on screen",
    });
  });
});

test("a copy the sweep could put back is finished silently and reported once", async () => {
  await launched("recovery-restored", [["--mode", "restorable"]], async ({ d, planted }) => {
    const panel = await reportedPanel(d);

    assert.equal(panel.heading, "Recovered an interrupted save");
    // The restore itself: the planted track was left half-written, and the copy
    // is the only place its original bytes were.
    assert.equal(
      await fs.readFile(planted[0].track, "utf8"),
      "original bytes, as they were before the update\n",
    );
    // Both halves consumed, so the next launch has nothing to report — the one
    // outcome in this feature that is once-only.
    assert.equal(await exists(planted[0].copy), false, "the copy is spent");
    assert.equal(await exists(planted[0].record), false, "and so is its record");

    // Nothing is unresolved, so there is nothing to offer but an acknowledgement.
    assert.deepEqual(panel.buttons, ["Done"]);
    assert.ok(
      panel.details.includes(`${planted[0].track} — restored`),
      `the file that moved under the user is named. Details:\n${panel.details.join("\n")}`,
    );
  });
});

test("Retry restore settles a copy whose track has become readable", async () => {
  await launched("recovery-retry", [["--mode", "locked", "--name", "Night Bus"]], async ({
    d,
    planted,
  }) => {
    const panel = await reportedPanel(d);
    assert.equal(panel.heading, "A metadata save didn't finish");
    assert.ok(panel.buttons.includes("Retry restore"));

    // The real-world case the button exists for: storage that wasn't reachable
    // at launch and is now. `locked` is the only mode whose answer a retry can
    // change, which is why this is the one flow driven end to end.
    await fs.chmod(planted[0].track, 0o644);
    await clickPanelButton(d, "Retry restore");

    const settled = await d.waitFor(
      async () => {
        const next = await operationPanelOrNone(d);
        // "Putting the original back" is the progress panel this replaces.
        return next && next.heading !== panel.heading && next.buttons.length > 0 ? next : null;
      },
      { timeout: 20_000, message: "the retry never reported an outcome" },
    );

    assert.equal(settled.heading, "That entry is settled");
    assert.equal(
      await fs.readFile(planted[0].track, "utf8"),
      "original bytes, as they were before the update\n",
    );
    assert.equal(await exists(planted[0].copy), false, "the copy is spent");
    assert.equal(await exists(planted[0].record), false, "and so is its record");

    // And the held report is now the merged one, so a second fetch agrees with
    // the panel rather than replaying the launch's snapshot.
    const held = (await d.invoke("metadata_recovery_notices")) as { restored: boolean }[];
    assert.deepEqual(
      held.map((notice) => notice.restored),
      [true],
    );
  });
});

// The outcome panel a discard leaves behind, mounted over the report in place.
// Waited for rather than read, because the command runs a filesystem operation
// per pair and the click returns before any of it has happened.
//
// Keyed on the heading alone: whether the buttons change depends on whether
// anything survived the discard, which is what two of the cases below are for.
async function discardOutcomePanel(
  d: Driver,
  from: OperationPanel,
  timeout = 20_000,
): Promise<OperationPanel> {
  return d.waitFor(
    async () => {
      const next = await operationPanelOrNone(d);
      return next && next.heading !== from.heading ? next : null;
    },
    { timeout, message: "the discard never reported an outcome" },
  );
}

// One copy and one record whose copy is already gone — the mixed set, which is
// the only one where the button, the confirmation and the outcome each have to
// describe two kinds of thing at once. Both halves of the gate are driven here
// rather than in two launches: declining has to leave the copy where it is, and
// the only way to know that it did is to then accept and watch it go.
test("the confirmation gates a mixed discard, and accepting clears both kinds", async () => {
  await launched(
    "recovery-discard-mixed",
    [
      ["--mode", "replaced", "--name", "Night Bus"],
      ["--mode", "no-copy", "--name", "Stray"],
    ],
    async ({ d, planted }) => {
      const [copy, stray] = planted;
      const panel = await reportedPanel(d);

      // Neither noun fits the pair, so the button goes without a count and the
      // confirmation is where what-goes is spelled out. The record with no copy
      // left is past retrying, so only the copy is offered one.
      assert.deepEqual(panel.buttons, ["Retry restore", "Discard", "Dismiss"]);

      // Declining. The dialog is the app's own, read back as it was handed to
      // the plugin: it names the track whose copy would go, and says that it
      // also clears the record that has none.
      await d.answerDialogs("Cancel");
      await clickPanelButton(d, "Discard");
      const asked = await d.waitFor(async () => (await d.dialogs()).at(0), {
        message: "Discard never asked before deleting the only copy of an original",
      });
      assert.equal(asked.title, "Discard recovery copy?");
      assert.equal(asked.kind, "warning", "the last original is not an informational dialog");
      assert.match(asked.message, /This deletes the recovery copy of Night Bus\.mp3\./);
      assert.match(asked.message, /It also clears one record whose copy is already gone\./);

      // Nothing may have moved. Given time to have gone wrong rather than read
      // straight back: the dialog has been answered by this point, so a decline
      // that wasn't honoured would have the command running already, and the
      // files would be checked while it was still deleting them.
      await assert.rejects(
        () => discardOutcomePanel(d, panel, 2_000),
        /never reported an outcome/,
        "a declined discard went ahead and reported one",
      );
      assert.equal((await operationPanel(d)).heading, panel.heading, "the report still stands");
      assert.equal(await exists(copy.copy), true, "the copy survives a declined discard");
      assert.equal(await exists(copy.record), true, "and so does its record");
      assert.equal(await exists(stray.record), true, "and so does the stray record");
      // And the backend was never asked, so both entries are still held.
      assert.equal(((await d.invoke("metadata_recovery_notices")) as unknown[]).length, 2);

      // Accepting.
      await d.answerDialogs("Ok");
      await clickPanelButton(d, "Discard");
      const outcome = await discardOutcomePanel(d, panel);
      assert.equal(outcome.heading, "Recovery copy discarded");
      assert.match(outcome.message, /A record with no copy left was cleared too\./);
      assert.deepEqual(outcome.buttons, ["Done"]);

      assert.equal(await exists(copy.copy), false, "the copy is gone");
      assert.equal(await exists(copy.record), false, "with its record");
      assert.equal(await exists(stray.record), false, "and the stray record went too");
      // The one thing a discard must never touch. Both tracks may be incomplete
      // on disk, and that is the user's to deal with — throwing away the copy is
      // not consent to throw away the file it was a copy of.
      assert.equal(await exists(copy.track), true, "the track itself is untouched");
      assert.equal(await exists(stray.track), true, "and so is the stray's");

      // Nothing left to report, so the next fetch agrees with the panel.
      assert.deepEqual(await d.invoke("metadata_recovery_notices"), []);
    },
  );
});

// Two copies, one of which the filesystem will not give up (uchg). The partial
// is the outcome that matters most and the one a unit test cannot stage: bytes
// that were the last original of a track are already unlinked, so a report that
// read as though nothing happened would be the worst thing this panel could say.
test("a discard one copy refuses says how many went, and keeps the rest", async () => {
  await launched(
    "recovery-discard-stuck",
    [
      ["--mode", "replaced", "--name", "Night Bus"],
      ["--mode", "replaced", "--name", "Extreme Drift", "--stick"],
    ],
    async ({ d, planted }) => {
      const [went, stuck] = planted;
      const panel = await reportedPanel(d);
      assert.ok(panel.buttons.includes("Discard copies"), `buttons: ${panel.buttons.join(", ")}`);

      await d.answerDialogs("Ok");
      await clickPanelButton(d, "Discard copies");
      const outcome = await discardOutcomePanel(d, panel);

      assert.equal(outcome.heading, "Couldn't discard all of them");
      assert.match(
        outcome.message,
        /1 of 2 recovery copies are gone for good; the rest are still in place\./,
      );
      // And names the one that refused, which is the only way the user can go
      // and look at it.
      assert.ok(
        outcome.message.includes(stuck.copy),
        `the refusal should name the copy still on disk. Message:\n${outcome.message}`,
      );
      // And the panel still offers it. The report is opened once, at launch, so
      // an outcome mounted in place of it rather than over it would leave this
      // copy — the only original bytes that track has left — with no button in
      // the window until the app restarts.
      assert.ok(
        outcome.buttons.includes("Discard copy"),
        `the copy that refused keeps its offer. Buttons: ${outcome.buttons.join(", ")}`,
      );

      assert.equal(await exists(went.copy), false, "the copy that went is gone");
      assert.equal(await exists(went.record), false, "with its record");
      // Still joined, so the next launch can offer it again — a copy whose
      // record went would be bytes no later sweep could name.
      assert.equal(await exists(stuck.copy), true, "the stuck copy stays");
      assert.equal(await exists(stuck.record), true, "and keeps its record");

      // So exactly one entry is still held, and it is that one.
      const held = (await d.invoke("metadata_recovery_notices")) as { backup: string | null }[];
      assert.deepEqual(
        held.map((notice) => notice.backup),
        [stuck.copy],
      );
    },
  );
});

// The floor: the recovery directory itself refuses every unlink, so nothing can
// go at all. Worth its own case because it is the outcome most easily told as a
// partial, and a count over a discard that removed nothing would send the user
// looking for bytes that are all still there.
test("a discard that could remove nothing claims no partial", async () => {
  await launched(
    "recovery-discard-locked",
    [["--mode", "replaced", "--name", "Night Bus", "--lock-folder"]],
    async ({ d, planted }) => {
      const panel = await reportedPanel(d);
      assert.ok(panel.buttons.includes("Discard copy"), `buttons: ${panel.buttons.join(", ")}`);

      await d.answerDialogs("Ok");
      await clickPanelButton(d, "Discard copy");
      const outcome = await discardOutcomePanel(d, panel);

      assert.equal(outcome.heading, "Couldn't discard the recovery copy");
      assert.ok(
        outcome.message.includes(planted[0].copy),
        `the refusal should name what wouldn't go. Message:\n${outcome.message}`,
      );
      assert.doesNotMatch(
        outcome.message,
        /\d+ of \d+/,
        "nothing went, so nothing may be counted as having gone",
      );
      // Nothing went, so every offer the report made is still owed.
      assert.ok(
        outcome.buttons.includes("Discard copy"),
        `a refused discard keeps the report's offers. Buttons: ${outcome.buttons.join(", ")}`,
      );

      assert.equal(await exists(planted[0].copy), true, "the copy is still there");
      assert.equal(await exists(planted[0].record), true, "and so is its record");
      // Unpruned, so the entry comes back at the next launch.
      const held = (await d.invoke("metadata_recovery_notices")) as unknown[];
      assert.equal(held.length, 1);
    },
  );
});

// The real thing, once, with the stub out of the way: that `confirm()` actually
// puts an alert on screen, that the alert says what the stub above only saw it
// being handed, and that each of its three answers is honoured. Everything else
// about discarding is asserted through the stub, because this is the only test
// in the suite that needs the user's machine to allow one process to read
// another's UI — hence the skip rather than a failure where it doesn't.
//
// All three answers in one launch: a declined confirmation leaves the report
// standing, so the next one can be raised from the same panel. Escape goes
// first and Ok last, since Ok is the one that consumes the copy.
test("the real confirmation appears, and Escape, Cancel and Ok each answer it", {
  skip: unavailableReason() ?? false,
}, async () => {
  await launched(
    "recovery-discard-native",
    [["--mode", "replaced", "--name", "Night Bus"]],
    async ({ d, planted, pid }) => {
      const panel = await reportedPanel(d);
      assert.ok(panel.buttons.includes("Discard copy"));

      for (const answer of ["Escape", "Cancel", "Ok"] as const) {
        await clickPanelButton(d, "Discard copy");
        const alert = await waitForAlert(pid);

        // The same two sentences the stub reads off the payload, now as AppKit
        // laid them out — which is what makes the stubbed assertions above
        // claims about the dialog and not just about a function call.
        assert.equal(alert.title, "Discard recovery copy?");
        assert.match(alert.message, /This deletes the recovery copy of Night Bus\.mp3\./);
        assert.deepEqual(alert.buttons, ["Cancel", "OK"]);

        if (answer === "Escape") await escapeAlert(pid);
        else await pressAlertButton(pid, answer === "Cancel" ? "Cancel" : "OK");

        if (answer === "Ok") break;
        // A declined confirmation is the whole guard: the copy is the last place
        // this track's original bytes exist, so Escape and Cancel both have to
        // leave it, and the report, exactly as they were.
        await assert.rejects(
          () => discardOutcomePanel(d, panel, 2_000),
          /never reported an outcome/,
          `${answer} went ahead and discarded the copy`,
        );
        assert.equal((await operationPanel(d)).heading, panel.heading);
        assert.equal(await exists(planted[0].copy), true, `${answer} left the copy in place`);
        assert.equal(await exists(planted[0].record), true, "and its record");
      }

      // And Ok goes through to the same command the stubbed cases drive.
      const outcome = await discardOutcomePanel(d, panel);
      assert.equal(outcome.heading, "Recovery copy discarded");
      assert.equal(await exists(planted[0].copy), false, "the copy is gone");
      assert.equal(await exists(planted[0].record), false, "with its record");
      assert.equal(await exists(planted[0].track), true, "and the track is untouched");
    },
  );
});

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
