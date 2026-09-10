// Persistent interactive driver for the Pudding app.
//
// Unlike the batch harness (harness.ts, one .test.ts run per slow bundle
// build), this stays up: it holds the webview's e2e-bridge WebSocket open and
// exposes a tiny HTTP control API so you can fire one command at a time and
// read state back — ideal for driving the live app by hand or from an agent.
//
//   node e2e/drive.mjs --dev           # launch `tauri dev` (HMR) and attach  [best for frontend work]
//   node e2e/drive.mjs --bundle        # launch the built .app and attach     [exact built artifact]
//   node e2e/drive.mjs                 # attach to an app you started yourself
//
// Then, from anywhere:
//   curl -s localhost:9011/probe
//   curl -s localhost:9011/health
//   curl -s 'localhost:9011/action?name=playFile&arg=/abs/path.m4a'
//   curl -s localhost:9011/cmd -d '{"cmd":"click","args":{"selector":"#play-pause-btn"}}'
//   curl -s localhost:9011/screenshot -o shot.png
//
// It always routes to the most-recent webview connection, so Vite HMR reloads
// (which reconnect the bridge) just work.

import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

const dir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(dir, "..");

const WS_PORT = Number(process.env.PUDDING_E2E_PORT ?? 9010);
const CTRL_PORT = Number(process.env.PUDDING_DRIVE_PORT ?? WS_PORT + 1);

const wantBundle = process.argv.includes("--bundle");
const wantDev = process.argv.includes("--dev");

const appBin =
  process.env.PUDDING_E2E_APP ??
  path.join(
    projectRoot,
    "src-tauri/target/debug/bundle/macos/Pudding.app/Contents/MacOS/pudding",
  );

// --- webview connection (most recent wins) --------------------------------
let sock = null;
let nextId = 1;
const pending = new Map();

const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
wss.on("connection", (ws) => {
  sock = ws;
  console.error(`[drive] webview connected on :${WS_PORT}`);
  ws.on("message", (data) => {
    let msg;
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
  ws.on("close", () => {
    if (sock === ws) sock = null;
  });
});

function bridge(cmd, args) {
  return new Promise((resolve, reject) => {
    if (!sock || sock.readyState !== sock.OPEN)
      return reject(new Error("no webview connected"));
    const id = nextId++;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, cmd, args }));
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`bridge timeout: ${cmd}`));
    }, 10_000);
  });
}

// Native full-screen grab (WKWebView isn't in the a11y tree, but the pixels are
// on screen). Enough to "see" the app; pair with #id probes for assertions.
function screenshot() {
  return new Promise((resolve, reject) => {
    const out = path.join(dir, ".drive-shot.png");
    const p = spawn("screencapture", ["-x", "-o", out]);
    p.on("exit", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`screencapture ${code}`)),
    );
  });
}

// --- HTTP control API ------------------------------------------------------
function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "content-type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const ctrl = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${CTRL_PORT}`);
  const q = url.searchParams;
  try {
    switch (url.pathname) {
      case "/health":
        return send(res, 200, { ok: true, connected: !!sock });
      case "/probe":
        return send(res, 200, await bridge("probe"));
      case "/exists":
        return send(res, 200, await bridge("exists", { selector: q.get("selector") }));
      case "/click":
        return send(res, 200, await bridge("click", { selector: q.get("selector") }));
      case "/text":
        return send(res, 200, await bridge("text", { selector: q.get("selector") }));
      case "/action":
        return send(res, 200, await bridge("action", {
          name: q.get("name"),
          arg: parseArg(q.get("arg")),
        }));
      case "/screenshot":
        return send(res, 200, await screenshot(), "text/plain");
      case "/cmd": {
        const body = await readBody(req);
        const { cmd, args } = JSON.parse(body || "{}");
        return send(res, 200, await bridge(cmd, args));
      }
      default:
        return send(res, 404, { error: `unknown path: ${url.pathname}` });
    }
  } catch (e) {
    return send(res, 500, { error: String(e?.message ?? e) });
  }
});

// arg may be a bare string or JSON (object/array/number). Try JSON, fall back.
function parseArg(raw) {
  if (raw == null) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => resolve(s));
  });
}

ctrl.listen(CTRL_PORT, "127.0.0.1", () => {
  console.error(`[drive] control API on http://127.0.0.1:${CTRL_PORT}`);
});

// --- optional app launch ---------------------------------------------------
// Launch in its own process group and tear the whole group down on exit, so
// `tauri dev`'s children (vite, cargo, the app window) don't survive us.
function launch(cmd, args, label) {
  console.error(`[drive] launching ${label}: ${cmd} ${args.join(" ")}`);
  const child = spawn(cmd, args, {
    cwd: projectRoot,
    env: { ...process.env, PUDDING_E2E_PORT: String(WS_PORT) },
    stdio: "inherit",
    detached: true,
  });
  const killGroup = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
  };
  for (const sig of ["exit", "SIGINT", "SIGTERM"]) process.on(sig, killGroup);
}

if (wantDev) {
  // Merge the e2e CSP so the loopback WebSocket is allowed; frontend edits
  // hot-reload and the bridge reconnects automatically.
  launch(
    "pnpm",
    ["tauri", "dev", "--config", "src-tauri/tauri.e2e.conf.json"],
    "tauri dev",
  );
} else if (wantBundle) {
  launch(appBin, [], "built bundle");
} else {
  console.error(
    `[drive] waiting for a webview to dial in on :${WS_PORT} ` +
      `(start the app with PUDDING_E2E_PORT=${WS_PORT})`,
  );
}
