// The one part of the app the webview bridge cannot reach: native AppKit UI.
//
// Everything else in this suite talks to the real DOM over the bridge, because
// WKWebView's contents are not in the macOS accessibility tree. A native alert
// is the mirror image of that problem — it has no DOM at all, and it *is* in the
// accessibility tree. So this module drives it the way the README says native
// drivers would have to: through System Events.
//
// It is deliberately the only place that does. Reading the UI of another process
// needs two separate grants from the user (Automation → System Events for
// whatever runs the tests, and Accessibility for System Events itself), so a
// suite built on this would be unrunnable on a fresh machine and in CI. One test
// uses it, for the one claim nothing else can make: that an alert is really put
// on screen and that its own buttons answer it. `available()` is how that test
// skips instead of failing where the grants are missing.
//
// Dialogs are reached as a *sheet* of the app's window rather than as a window
// of their own, which is what tauri-plugin-dialog produces: it sets the webview
// window as the parent, so rfd uses `beginSheetModalForWindow`. That also makes
// them non-blocking — the main thread keeps running, so the bridge stays
// responsive while a sheet is up and a test can assert on the DOM underneath it.

import { execFileSync } from "node:child_process";

/** A native alert as the accessibility tree describes it. */
export type NativeAlert = { title: string; message: string; buttons: string[] };

function osascript(script: string): string {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8" }).trim();
}

// Addressed by pid, never by name: the e2e bundle's executable is called
// `pudding` exactly like the shipping one, so a process name would just as
// happily match the Pudding the developer has open — and then drive *their* app.
function tell(pid: number, body: string): string {
  return osascript(
    `tell application "System Events" to tell ` +
      `(first application process whose unix id is ${Number(pid)})\n${body}\nend tell`,
  );
}

// Why this machine can't be driven, or null when it can. Probed through a UI
// read rather than a bare connection, because the two grants are separate and
// only the second one lets anything here work.
export function unavailableReason(): string | null {
  try {
    osascript(
      'tell application "System Events" to tell (first application process whose frontmost is true) ' +
        "to return count of windows",
    );
    return null;
  } catch (error) {
    const said = (error as { stderr?: string }).stderr ?? String(error);
    return (
      "System Events can't read this machine's UI, so a native dialog can't be driven " +
      "(grant Automation → System Events to your terminal, and Accessibility to System Events). " +
      `It said: ${said.trim()}`
    );
  }
}

const sheetCount = (pid: number): number =>
  Number(tell(pid, "return count of sheets of window 1"));

async function until(pred: () => boolean, message: string, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Wait for an alert on the app's window and read it back. */
export async function waitForAlert(pid: number, timeout = 10_000): Promise<NativeAlert> {
  await until(() => sheetCount(pid) > 0, "no native alert appeared", timeout);
  // The alert's own two labels, in the order AppKit lays them out: the bold
  // heading first, then the body. The warning *level* is not in the tree at all
  // — only the icon carries it — so what the app asked for is asserted on the
  // stubbed side instead, where the payload is readable.
  const texts = tell(pid, "return value of every static text of sheet 1 of window 1");
  const [title, ...rest] = texts.split(", ");
  return {
    title,
    message: rest.join(", "),
    buttons: tell(pid, "return name of every button of sheet 1 of window 1").split(", "),
  };
}

/** Press one of the alert's buttons by its label, and wait for it to close. */
export async function pressAlertButton(pid: number, label: string): Promise<void> {
  tell(pid, `click button ${JSON.stringify(label)} of sheet 1 of window 1`);
  await until(() => sheetCount(pid) === 0, `the alert stayed up after ${label}`);
}

/**
 * Dismiss the alert with the Escape key, and wait for it to close.
 *
 * Unlike the rest of this module this has to bring the app forward first: a
 * synthesised keystroke goes wherever the keyboard focus is, not to a process
 * you name. So it takes focus from whatever the developer is doing — which is
 * the price of testing the one answer that is a key equivalent rather than a
 * button.
 */
export async function escapeAlert(pid: number): Promise<void> {
  tell(pid, "set frontmost to true");
  await new Promise((resolve) => setTimeout(resolve, 300));
  osascript('tell application "System Events" to key code 53');
  await until(() => sheetCount(pid) === 0, "the alert stayed up after Escape");
}
