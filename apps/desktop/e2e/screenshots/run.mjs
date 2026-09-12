#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, copyFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from '../harness.ts';
import { captureStable, samePixels, differencePNG, FREEZE_CSS } from './capture.mjs';
import { decodePNG } from './png.mjs';
import { scenes, initialSettings } from './scenes.mjs';

const desktop = fileURLToPath(new URL('../../', import.meta.url));
const root = path.resolve(desktop, '../..');
const artifacts = path.join(desktop, '.screenshots');
const bundle = path.join(desktop, 'src-tauri/target/debug/bundle/macos/Pudding Screenshots.app');
const identifier = 'com.incompl.pudding.screenshots';
let harness, subprocess, runDir;
const abort = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
  abort.abort(new Error(`Interrupted by ${signal}`));
  subprocess?.kill(signal);
  void harness?.close();
});

async function run(command, args) {
  abort.signal.throwIfAborted();
  await new Promise((resolve, reject) => {
    const child = subprocess = spawn(command, args, { cwd: desktop, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      subprocess = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal ?? code})`));
    });
  });
  abort.signal.throwIfAborted();
}

function options(argv) {
  const result = { check: false, skipBuild: false, only: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') continue;
    if (arg === '--check') result.check = true;
    else if (arg === '--skip-build') result.skipBuild = true;
    else if (arg === '--only') {
      result.only = argv[++i];
      if (!scenes.some((scene) => scene.id === result.only)) throw new Error('Unknown --only scene; use desktop or mini');
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm screenshots:update [--only desktop|mini] [--skip-build]\n' +
        '       pnpm screenshots:check  [--only desktop|mini] [--skip-build]\n\n' +
        'Builds and captures the native macOS app at 2x display scale. Check mode never changes tracked images.\n' +
        '--skip-build reuses the last screenshot bundle; omit it after any app source change.');
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

async function main() {
  const opts = options(process.argv.slice(2));
  if (!opts) return;
  if (process.platform !== 'darwin') throw new Error('Screenshots require macOS with a graphical session and audio output.');
  await mkdir(artifacts, { recursive: true });
  // Separate from pnpm drive's port; lock prevents two capture builds sharing a bundle.
  const lockPath = path.join(artifacts, 'run.lock');
  let lock;
  try { lock = await open(lockPath, 'wx'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    throw new Error(`Another capture run owns ${lockPath}. If it crashed, remove that file after verifying its PID has exited.`);
  }
  await lock.writeFile(String(process.pid));
  try {
    runDir = await mkdtemp(path.join(artifacts, 'run-'));
    console.log(`Capture artifacts: ${runDir}`);
    if (!opts.skipBuild) await run('pnpm', ['exec', 'tauri', 'build', '--debug', '--bundles', 'app',
      '--config', 'src-tauri/tauri.e2e.conf.json', '--config', 'src-tauri/tauri.screenshots.conf.json']);
    const actualId = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(bundle, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
    if (actualId !== identifier) throw new Error(`Refusing to launch a non-screenshot bundle: ${actualId}`);
    const library = path.join(runDir, 'Screenshot Library');
    await run('node', ['scripts/gen-screenshot-library.mjs', '--out', library]);
    const manifest = JSON.parse(await readFile(path.join(library, 'manifest.json'), 'utf8'));
    const captured = [];
    for (const scene of scenes.filter((scene) => !opts.only || scene.id === opts.only)) {
      abort.signal.throwIfAborted();
      console.log(`Preparing ${scene.id}…`);
      const profile = path.join(runDir, `${scene.id}-profile`);
      await mkdir(profile);
      await writeFile(path.join(profile, 'settings.json'), JSON.stringify(initialSettings(library, manifest)));
      const log = await open(path.join(runDir, `${scene.id}.log`), 'w');
      try {
        harness = await startHarness({ appBin: path.join(bundle, 'Contents/MacOS/pudding'),
          port: 0, noSpawn: false, env: { PUDDING_E2E_DATA_DIR: profile }, log: log.fd });
        const d = harness.driver;
        // Fail before any fixture actions if the binary doesn't honor profile isolation.
        if (await d.invoke('settings_path') !== path.join(profile, 'settings.json')) {
          throw new Error('Screenshot bundle did not use the isolated profile. Rebuild it.');
        }
        await d.css('screenshots-freeze', FREEZE_CSS);
        await scene.prepare(d, library, manifest);
        await d.action('setWindowSize', scene.size);
        const view = await d.waitFor(async () => {
          const view = await d.settle();
          return view.width === scene.size.width && view.height === scene.size.height && view;
        }, { message: `Window did not resize to ${scene.size.width}×${scene.size.height}` });
        if (view.dpr !== 2) throw new Error(`Expected a 2x display, got ${view.dpr}x. Move the capture app to a Retina display at native scale.`);
        const state = await d.probe();
        if (state.isPlaying || Math.abs(Number(state.currentTime) - 42) >= 0.1) throw new Error(`Playback changed before capture: ${JSON.stringify(state)}`);
        const file = path.join(runDir, `${scene.id}.png`);
        const pixels = await captureStable(await d.invoke('window_number'), file, async () => {
          await d.waitFor(() => d.invoke('focus_e2e_window'), {
            message: 'Screenshot window did not become focused',
          });
          await d.settle();
        });
        if (pixels.width !== view.width * 2 || pixels.height !== view.height * 2) {
          throw new Error(`Native capture dimensions ${pixels.width}×${pixels.height} disagree with the viewport at 2x`);
        }
        captured.push({ scene, file, pixels, state, view });
        console.log(`Captured ${scene.id}: ${pixels.width}×${pixels.height}`);
      } finally {
        await harness?.close();
        harness = undefined;
        await log.close();
      }
    }
    abort.signal.throwIfAborted();
    // All recipes succeeded before any tracked assets are replaced.
    const report = [];
    for (const { scene, file, pixels, state, view } of captured) {
      for (const destination of scene.destinations) {
        const target = path.join(root, destination);
        let previous;
        try { previous = await readFile(target); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const oldPixels = previous && decodePNG(previous);
        const changed = !oldPixels || !samePixels(oldPixels, pixels);
        const index = report.length;
        if (changed && previous) {
          await writeFile(path.join(runDir, `before-${index}.png`), previous);
          await writeFile(path.join(runDir, `diff-${index}.png`), differencePNG(oldPixels, pixels));
        }
        report.push({ scene: scene.id, destination, changed, view, state });
        if (changed && !opts.check) {
          await mkdir(path.dirname(target), { recursive: true });
          await copyFile(file, target);
        }
        console.log(`${changed ? opts.check ? 'DIFF' : 'UPDATED' : 'unchanged'} ${destination}`);
      }
    }
    await writeFile(path.join(runDir, 'report.json'), JSON.stringify({
      macOS: execFileSync('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8' }).trim(),
      check: opts.check, images: report,
    }, null, 2) + '\n');
    const rows = report.map((item, index) => `<section><h2>${item.destination}</h2><p>${item.changed ? 'Changed' : 'Unchanged'}</p><div>` +
      (item.changed ? `<img alt="Previous" src="before-${index}.png" onerror="this.remove()">` : '') +
      `<img alt="Captured" src="${item.scene}.png">` +
      (item.changed ? `<img alt="Pixel differences" src="diff-${index}.png" onerror="this.remove()">` : '') + '</div></section>').join('\n');
    await writeFile(path.join(runDir, 'review.html'), '<!doctype html><meta charset="utf-8"><title>Pudding screenshot review</title>' +
      '<style>body{font:14px system-ui;background:#202020;color:white;margin:24px}h2{font-size:16px}section{margin-bottom:32px}section div{display:flex;gap:16px;align-items:start}img{max-width:31%;height:auto}</style>' +
      '<h1>Screenshot review</h1><p>Previous · Captured · Pixel differences (pink)</p>' + rows);
    console.log(`Review: ${path.join(runDir, 'review.html')}`);
    if (opts.check && report.some((item) => item.changed)) process.exitCode = 1;
    // Keep images, logs and report, but remove generated audio/profile data after app exit.
    await rm(library, { recursive: true, force: true });
    for (const { scene } of captured) await rm(path.join(runDir, `${scene.id}-profile`), { recursive: true, force: true });
  } finally {
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

main().catch((error) => {
  console.error(`screenshots: ${error.message}`);
  if (runDir) console.error(`Logs and diagnostic files: ${runDir}`);
  process.exitCode = 1;
});
