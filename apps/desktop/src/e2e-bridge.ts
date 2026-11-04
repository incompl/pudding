// Dev/e2e test bridge (frontend side).
//
// When the app is launched by the e2e harness (PUDDING_E2E_PORT set, surfaced
// through the `e2e_port` Tauri command), we open a WebSocket to the harness and
// let it drive/observe the *real* running app: the actual Rust engine, real
// audio, real events, and this real DOM. The harness is the WS server; the
// webview can only dial out, so it is the client.
//
// This exists because WKWebView's DOM is not exposed to the macOS accessibility
// tree, so native drivers (XCUITest/Appium mac2) can't see it. Talking to the
// webview directly sidesteps that entirely and keeps selectors pure `#id`
// queries against the real DOM.
//
// In normal runs `e2e_port` returns null and none of this activates.

import { invoke } from "@tauri-apps/api/core";

/** A snapshot of playback-relevant state, read live from the frontend signals. */
export type Probe = () => Record<string, unknown>;

/** Named frontend entry points the harness can trigger (real UI code paths). */
export type Actions = Record<string, (arg?: unknown) => unknown>;

type Request = {
  id: number;
  cmd: string;
  args?: Record<string, unknown>;
};

/** A native dialog the app put up, as the stub below saw it go past. */
export type SeenDialog = { title: string | null; message: string; kind: string | null };

// Standing in for the native dialogs, so a test can drive a flow that is gated
// by one. `confirm()` from @tauri-apps/plugin-dialog is a single invoke of
// `plugin:dialog|message` resolving to the label of the button the user clicked,
// and `confirm` returns true iff that equals the Ok label — so answering that
// one call is answering the dialog, and no NSAlert is ever created. Which
// matters twice over: the harness has no way to dismiss one, and a modal left
// standing would outlive the test that raised it.
//
// Answered at the IPC transport rather than above it. The obvious seam,
// `window.__TAURI_INTERNALS__.invoke`, cannot be taken: Tauri defines both the
// internals object and every method on it with a bare `Object.defineProperty`,
// so they are non-writable *and* non-configurable and assigning to one throws.
// What is left underneath is the request itself — on macOS the custom protocol,
// which is a `fetch` to `ipc://localhost/<command>` whose response the protocol
// script turns back into the invoke's resolution. `window.fetch` is an ordinary
// writable global, and a dialog answered there has still gone through every line
// of the app's own code, down to the title and message it handed the plugin,
// which is what the tests read back. The alternative — a `confirmFn` threaded
// through the app for the tests' benefit — would weaken the one confirmation
// standing between the user and the last copy of someone's original.
//
// Every message dialog is answered while this is installed, not only confirms,
// so a test asserts on what `dialogs` captured rather than assuming which one it
// caught.
const DIALOG_CMD = "plugin:dialog|message";

// `convertFileSrc(cmd, "ipc")` builds `ipc://localhost/<encoded command>`, so
// the command is the last path segment and nothing else about the URL matters.
function ipcCommand(url: string): string | null {
  if (!url.startsWith("ipc:")) return null;
  try {
    return decodeURIComponent(url.slice(url.lastIndexOf("/") + 1));
  } catch {
    return null;
  }
}

const seenDialogs: SeenDialog[] = [];
let realFetch: typeof fetch | null = null;
let dialogAnswer: string | null = null;

// `answer` is the button label the plugin resolves with ("Ok" accepts a confirm,
// anything else declines it); null puts the real fetch back and lets the native
// dialogs through again. Installing resets the capture log, so each test reads
// only its own.
function answerDialogs(answer: string | null): void {
  seenDialogs.length = 0;
  dialogAnswer = answer;
  if (answer === null) {
    if (realFetch) window.fetch = realFetch;
    realFetch = null;
    return;
  }
  if (realFetch) return;
  realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const real = realFetch;
    if (!real) throw new Error("e2e dialog stub lost the real fetch");
    const url =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : String(input);
    if (dialogAnswer === null || ipcCommand(url) !== DIALOG_CMD) return real(input, init);
    // The payload the app sent, which for a plain command is the JSON body.
    let fields: Record<string, unknown> = {};
    try {
      if (typeof init?.body === "string") fields = JSON.parse(init.body) as Record<string, unknown>;
    } catch {
      // Captured as a dialog with no text rather than dropped: the test's
      // assertion on the wording is a better failure than a silent passthrough
      // that puts a real modal on screen.
    }
    seenDialogs.push({
      title: fields.title == null ? null : String(fields.title),
      message: String(fields.message ?? ""),
      kind: fields.kind == null ? null : String(fields.kind),
    });
    // Shaped the way the IPC protocol script reads a reply: `Tauri-Response`
    // picks the success callback over the error one, and the content type
    // decides how the body is parsed back into the invoke's value.
    return Promise.resolve(
      new Response(JSON.stringify(dialogAnswer), {
        headers: { "content-type": "application/json", "Tauri-Response": "ok" },
      }),
    );
  };
}

function el(selector: string): Element {
  const found = document.querySelector(selector);
  if (!found) throw new Error(`no element for selector: ${selector}`);
  return found;
}

async function handle(
  req: Request,
  probe: Probe,
  actions: Actions,
): Promise<unknown> {
  const a = req.args ?? {};
  switch (req.cmd) {
    case "ping":
      return "pong";
    case "action": {
      // Trigger a real frontend entry point (e.g. openExternalFile), so tests
      // drive the true UI code path rather than reaching past it.
      const fn = actions[String(a.name)];
      if (!fn) throw new Error(`unknown action: ${a.name}`);
      return await fn(a.arg);
    }
    case "exists":
      return document.querySelector(String(a.selector)) !== null;
    case "click":
      (el(String(a.selector)) as HTMLElement).click();
      return true;
    case "text":
      return el(String(a.selector)).textContent?.trim() ?? "";
    case "attr":
      return el(String(a.selector)).getAttribute(String(a.name));
    case "prop":
      // Read a live DOM property (disabled, value, checked, ...) rather than the
      // attribute, so state changes are reflected.
      return (el(String(a.selector)) as unknown as Record<string, unknown>)[
        String(a.name)
      ];
    case "layout": {
      // Geometry + the computed properties that decide where type lands, for a
      // batch of selectors. scripts/caliper.mjs maps these boxes onto the real
      // rasterized pixels of a screencapture, so it needs the numbers and the
      // viewport scale from the same instant.
      //
      // Missing selectors come back as null rather than throwing: one call can
      // then name elements from states that never coexist (the mini player's
      // expand button alongside the full bar's tabs).
      const out: Record<string, unknown> = {};
      for (const sel of a.selectors as string[]) {
        const found = document.querySelector(sel);
        if (!found) {
          out[sel] = null;
          continue;
        }
        const cs = getComputedStyle(found);
        out[sel] = {
          rect: found.getBoundingClientRect().toJSON(),
          font: cs.font,
          fontSize: cs.fontSize,
          fontWeight: cs.fontWeight,
          fontFamily: cs.fontFamily,
          lineHeight: cs.lineHeight,
          color: cs.color,
          paddingTop: cs.paddingTop,
          paddingBottom: cs.paddingBottom,
          borderTopWidth: cs.borderTopWidth,
          borderBottomWidth: cs.borderBottomWidth,
        };
      }
      return {
        elements: out,
        dpr: window.devicePixelRatio,
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      };
    }
    case "css": {
      // Add or remove a <style> by id. Two jobs for caliper: freezing the app
      // (transitions/animations off) so a capture is reproducible, and injecting
      // a candidate rule to A/B a fix in the real engine without a rebuild.
      // Narrow and typed rather than a generic eval, matching this bridge's
      // "pure #id selectors, never arbitrary script" design.
      const id = String(a.id);
      document.getElementById(id)?.remove();
      if (a.text != null) {
        const style = document.createElement("style");
        style.id = id;
        style.textContent = String(a.text);
        document.head.appendChild(style);
      }
      return true;
    }
    case "freeze": {
      // The CSS freeze can only reach what the cascade reaches. This reaches
      // what the engine is actually running: every CSS animation, every
      // transition already in flight, and anything script started — whatever
      // the declaration looked like, and whichever property it targets.
      // Cancelling drops each effect, so the element falls back to its
      // cascaded value rather than holding some arbitrary frame.
      //
      // Returns what it found. A capture that will not settle can then name
      // the thing still moving instead of leaving it to be guessed at from
      // pixels, which is a poor way to tell a fading opacity from a
      // interpolating color.
      const found: Record<string, unknown>[] = [];
      for (const anim of document.getAnimations()) {
        const css = anim as Animation & {
          animationName?: string;
          transitionProperty?: string;
        };
        const target = anim.effect instanceof KeyframeEffect
          ? anim.effect.target
          : null;
        found.push({
          kind: css.animationName
            ? `animation ${css.animationName}`
            : css.transitionProperty
              ? `transition ${css.transitionProperty}`
              : "script animation",
          target: target
            ? `${target.tagName.toLowerCase()}${target.id ? `#${target.id}` : ""}` +
              `${typeof target.className === "string" && target.className
                ? `.${target.className.trim().split(/\s+/).join(".")}` : ""}`
            : null,
          playState: anim.playState,
        });
        anim.cancel();
      }
      return found;
    }
    case "dialog":
      answerDialogs(a.answer == null ? null : String(a.answer));
      return true;
    case "dialogs":
      return seenDialogs.slice();
    case "probe":
      return probe();
    case "settle": {
      // Wait for assets and a paint boundary, then report actual viewport size.
      // The runner still verifies consecutive native captures for stability.
      await document.fonts.ready;
      await Promise.all(Array.from(document.images)
        .filter((img) => img.getClientRects().length && img.currentSrc)
        .map((img) => img.decode()));
      await new Promise<void>((resolve) => requestAnimationFrame(() =>
        requestAnimationFrame(() => resolve())));
      return { width: innerWidth, height: innerHeight, dpr: devicePixelRatio };
    }
    case "invoke":
      // Passthrough to a real Tauri command — same path the UI uses, so tests
      // exercise the true command -> Rust engine -> event -> signal loop.
      return await invoke(String(a.name), a.payload as Record<string, unknown>);
    default:
      throw new Error(`unknown bridge cmd: ${req.cmd}`);
  }
}

function connect(
  port: number,
  probe: Probe,
  actions: Actions,
  attempt = 0,
): void {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);

  ws.addEventListener("message", async (ev) => {
    let req: Request;
    try {
      req = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    try {
      const result = await handle(req, probe, actions);
      ws.send(JSON.stringify({ id: req.id, ok: true, result }));
    } catch (e) {
      ws.send(
        JSON.stringify({ id: req.id, ok: false, error: String(e) }),
      );
    }
  });

  // The harness starts its server before spawning us, so this should connect
  // immediately. Retry a bounded number of times to tolerate the dev workflow
  // (app started before the harness).
  ws.addEventListener("error", () => {
    ws.close();
    if (attempt < 40)
      setTimeout(() => connect(port, probe, actions, attempt + 1), 250);
  });
}

/** Activate the bridge iff a harness launched us. No-op in normal runs. */
export async function maybeStartE2eBridge(
  probe: Probe,
  actions: Actions = {},
): Promise<void> {
  let port: number | null = null;
  try {
    port = await invoke<number | null>("e2e_port");
  } catch {
    return;
  }
  if (port == null) return;
  console.info(`[e2e] bridge connecting to harness on :${port}`);
  connect(port, probe, actions);
}
