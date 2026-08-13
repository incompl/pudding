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
      // Read a live DOM property (disabled, value, checked, …) rather than the
      // attribute, so state changes are reflected.
      return (el(String(a.selector)) as unknown as Record<string, unknown>)[
        String(a.name)
      ];
    case "probe":
      return probe();
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
