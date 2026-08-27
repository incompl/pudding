// Dev/e2e test harness (Node side).
//
// Hosts a WebSocket server, launches the real built app pointed at it, and
// exposes a small `Driver` for tests to drive/observe the running webview by
// `#id`. This is the counterpart to src/e2e-bridge.ts.

import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";

const dir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dir, "..");

const PORT = Number(process.env.PUDDING_E2E_PORT ?? 9010);

// The built binary inside the .app bundle. We spawn it directly (not `open`) so
// the PUDDING_E2E_PORT env var reaches the process. Build it first with
// `pnpm build:e2e` (a debug bundle whose CSP permits the loopback WebSocket).
// Override with PUDDING_E2E_APP for a release bundle / CI.
const appBin =
  process.env.PUDDING_E2E_APP ??
  path.join(
    projectRoot,
    "src-tauri/target/debug/bundle/macos/Pudding.app/Contents/MacOS/pudding",
  );

export const FIXTURE_TONE = path.join(dir, "fixtures/tone.m4a");

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
};

export type Driver = {
  exists(selector: string): Promise<boolean>;
  click(selector: string): Promise<void>;
  text(selector: string): Promise<string>;
  attr(selector: string, name: string): Promise<string | null>;
  prop(selector: string, name: string): Promise<unknown>;
  probe(): Promise<Record<string, unknown>>;
  invoke(name: string, payload?: Record<string, unknown>): Promise<unknown>;
  /** Trigger a named frontend entry point (real UI code path). */
  action(name: string, arg?: unknown): Promise<unknown>;
  /** Poll `pred` until it returns truthy or the timeout elapses. */
  waitFor<T>(
    pred: () => Promise<T> | T,
    opts?: { timeout?: number; interval?: number; message?: string },
  ): Promise<T>;
};

export type Harness = {
  driver: Driver;
  close(): Promise<void>;
};

function makeDriver(ws: WebSocket): Driver {
  let nextId = 1;
  const pending = new Map<number, Pending>();

  ws.on("message", (data) => {
    let msg: { id: number; ok: boolean; result?: unknown; error?: string };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(msg.error ?? "bridge error"));
  });

  function send(cmd: string, args?: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, cmd, args }));
      setTimeout(() => {
        if (pending.delete(id)) reject(new Error(`bridge timeout: ${cmd}`));
      }, 10_000);
    });
  }

  return {
    exists: (selector) => send("exists", { selector }) as Promise<boolean>,
    click: async (selector) => void (await send("click", { selector })),
    text: (selector) => send("text", { selector }) as Promise<string>,
    attr: (selector, name) =>
      send("attr", { selector, name }) as Promise<string | null>,
    prop: (selector, name) => send("prop", { selector, name }),
    probe: () => send("probe") as Promise<Record<string, unknown>>,
    invoke: (name, payload) => send("invoke", { name, payload }),
    action: (name, arg) => send("action", { name, arg }),
    async waitFor(pred, opts) {
      const timeout = opts?.timeout ?? 5_000;
      const interval = opts?.interval ?? 100;
      const deadline = Date.now() + timeout;
      for (;;) {
        const v = await pred();
        if (v) return v;
        if (Date.now() > deadline)
          throw new Error(opts?.message ?? "waitFor timed out");
        await new Promise((r) => setTimeout(r, interval));
      }
    },
  };
}

/** Start the WS server, launch the app, and resolve once the bridge connects. */
export function startHarness(): Promise<Harness> {
  const wss = new WebSocketServer({ port: PORT, host: "127.0.0.1" });
  let child: ChildProcess | undefined;

  return new Promise<Harness>((resolve, reject) => {
    const timer = setTimeout(() => {
      wss.close();
      child?.kill();
      reject(
        new Error(
          `app did not connect on :${PORT} within 60s (built? library configured?)`,
        ),
      );
    }, 60_000);

    // Only spawn the app once we own the port. Spawning before the server is
    // listening lets the app dial in to *another* process holding :PORT (a stale
    // `pnpm drive` reuses this same default port), so it never reaches us.
    wss.once("listening", () => {
      if (process.env.PUDDING_E2E_NO_SPAWN !== "1") {
        child = spawn(appBin, [], {
          env: { ...process.env, PUDDING_E2E_PORT: String(PORT) },
          stdio: "inherit",
        });
      }
    });

    wss.once("connection", (ws) => {
      clearTimeout(timer);
      const driver = makeDriver(ws);
      resolve({
        driver,
        async close() {
          ws.close();
          wss.close();
          child?.kill();
          // give the app a moment to exit cleanly
          await new Promise((r) => setTimeout(r, 200));
        },
      });
    });

    wss.on("error", (e) => {
      clearTimeout(timer);
      wss.close();
      child?.kill();
      // A raw EADDRINUSE here is almost always a leftover `pnpm drive` (it binds
      // this same default port) or an orphaned test app still holding :PORT.
      // Surface that instead of the bare errno so the fix is obvious.
      const code = (e as NodeJS.ErrnoException).code;
      reject(
        code === "EADDRINUSE"
          ? new Error(
              `e2e port :${PORT} is already in use — a \`pnpm drive\` session or a ` +
                `leftover test app is still running. Free it with ` +
                `\`lsof -nP -iTCP:${PORT}\` then kill the PID, or set PUDDING_E2E_PORT ` +
                `to another port.`,
            )
          : e,
      );
    });
  });
}
