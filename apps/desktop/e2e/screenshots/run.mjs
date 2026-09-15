#!/usr/bin/env node
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, writeFile, copyFile, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startHarness } from '../harness.ts';
import { captureStable, samePixels, differencePNG, FREEZE_CSS } from './capture.mjs';
import { decodePNG } from './png.mjs';
import { scenes, initialSettings, restoredSession, LIVE_STATION } from './scenes.mjs';
import { startStation } from './station.mjs';

const desktop = fileURLToPath(new URL('../../', import.meta.url));
const root = path.resolve(desktop, '../..');
const artifacts = path.join(desktop, '.screenshots');
// Settings shows the library folder and the stream list as absolute paths, and
// that panel ships in a public documentation image. So the fixtures every scene
// points at live here rather than under the run directory: a location that reads
// the same on every Mac, with no home directory or checkout in it. The themes
// scene asserts no other path reaches the panel.
const fixtures = '/Users/Shared/Pudding Screenshots';
const bundle = path.join(desktop, 'src-tauri/target/debug/bundle/macos/Pudding Screenshots.app');
const identifier = 'com.incompl.pudding.screenshots';
let harness, subprocess, runDir, station;
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
      if (!scenes.some((scene) => scene.id === result.only)) {
        throw new Error(`Unknown --only scene. Known scenes: ${scenes.map((scene) => scene.id).join(', ')}`);
      }
    } else if (arg === '--help' || arg === '-h') {
      console.log('Usage: pnpm screenshots:update [--only SCENE] [--skip-build]\n' +
        '       pnpm screenshots:check  [--only SCENE] [--skip-build]\n\n' +
        `Scenes: ${scenes.map((scene) => scene.id).join(', ')}\n` +
        'Builds and captures the native macOS app at 2x display scale. Check mode never changes tracked images.\n' +
        '--skip-build reuses the last screenshot bundle; omit it after any app source change.');
      return null;
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return result;
}

// The fixture directory is outside the checkout, so it is only ever removed when
// it is one this suite generated — a leftover from a crashed run, or the one this
// run just used. Anything else there is somebody's own folder and stops the run.
async function clearFixtures() {
  let entries;
  try { entries = await readdir(fixtures); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const ours = new Set(['Music', 'Stations.m3u8', '.DS_Store']);
  const foreign = entries.filter((entry) => !ours.has(entry));
  if (foreign.length) {
    throw new Error(`${fixtures} holds files this suite did not create (${foreign.join(', ')}). ` +
      'Move that folder aside; the suite needs this exact path so no capture machine\'s home directory reaches a published image.');
  }
  await rm(fixtures, { recursive: true, force: true });
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
    const library = path.join(fixtures, 'Music');
    await clearFixtures();
    await run('node', ['scripts/gen-screenshot-library.mjs', '--out', library]);
    const manifest = JSON.parse(await readFile(path.join(library, 'manifest.json'), 'utf8'));
    // One of the fixture stations is on the air for the length of the run, so
    // the streams scene can capture the app connected to real radio rather than
    // an imitation of it. Its loopback URLs go into the stream list each scene's
    // fixture writes; only that scene ever dials them.
    station = await startStation({ ...LIVE_STATION, audioFile: path.join(desktop, 'pudding sample.mp3') });
    const captured = [];
    for (const scene of scenes.filter((scene) => !opts.only || scene.id === opts.only)) {
      abort.signal.throwIfAborted();
      console.log(`Preparing ${scene.id}…`);
      const profile = path.join(runDir, `${scene.id}-profile`);
      await mkdir(profile);
      // Fixtures a scene needs beyond the shared music library (the stream list)
      // sit beside it in the fixture directory, never inside the library folder
      // itself: a .m3u8 under a library root would show up as a third playlist in
      // every other scene's Files panel.
      await scene.fixture?.(profile, library, station);
      // Per-scene settings layer over the shared restored session, so a scene can
      // choose a theme, a hero view, or where the Files panel is drilled to
      // without restating the whole thing.
      const settings = { ...initialSettings(library, manifest), ...scene.settings?.(library, manifest, profile) };
      await writeFile(path.join(profile, 'settings.json'), JSON.stringify(settings));
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
        await scene.prepare(d, library, manifest, station);
        await d.action('setWindowSize', scene.size);
        // Focus before waiting on any paint. macOS stops a fully occluded
        // window's requestAnimationFrame, and settle waits on two frames — so a
        // window that came up behind another app hangs settle until the bridge's
        // timeout, even though the app is perfectly responsive. captureStable
        // focuses before each shutter for the same reason.
        await d.waitFor(() => d.invoke('focus_e2e_window'), {
          message: 'Screenshot window did not become focused',
        });
        const view = await d.waitFor(async () => {
          const view = await d.settle();
          return view.width === scene.size.width && view.height === scene.size.height && view;
        }, { message: `Window did not resize to ${scene.size.width}×${scene.size.height}` });
        if (view.dpr !== 2) throw new Error(`Expected a 2x display, got ${view.dpr}x. Move the capture app to a Retina display at native scale.`);
        const state = await d.probe();
        const expected = (scene.playback ?? restoredSession)(state);
        if (expected) throw new Error(`Expected ${expected} before capture, got: ${JSON.stringify(state)}`);
        const file = path.join(runDir, `${scene.id}.png`);
        // Re-run before every shutter, not once: cancelling an animation does
        // not stop the cascade from starting it again, and a scene can reach
        // the shutter with one still in flight.
        let running = [], reported = false;
        const pixels = await captureStable(await d.invoke('window_number'), file, async () => {
          await d.waitFor(() => d.invoke('focus_e2e_window'), {
            message: 'Screenshot window did not become focused',
          });
          running = await d.freeze();
          // Said once per scene, and only when there was something to cancel:
          // anything named here reached the shutter despite FREEZE_CSS, which is
          // worth knowing even on a run that goes on to succeed.
          if (running.length && !reported) {
            reported = true;
            console.log(`  cancelled at the shutter: ${running.map((a) => `${a.kind} on ${a.target ?? '?'}`).join('; ')}`);
          }
          await d.settle();
        }, {
          diagnostics: path.join(runDir, `${scene.id}-unsettled`),
          // Whatever was still live on the final attempt, named. An animation
          // that keeps reappearing here is one the cascade keeps restarting.
          stillRunning: () => running.map((a) => `${a.kind} on ${a.target ?? '?'} (${a.playState})`),
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
    await clearFixtures();
    for (const { scene } of captured) await rm(path.join(runDir, `${scene.id}-profile`), { recursive: true, force: true });
  } finally {
    await station?.close();
    await lock.close();
    await rm(lockPath, { force: true });
  }
}

main().catch((error) => {
  console.error(`screenshots: ${error.message}`);
  if (runDir) console.error(`Logs and diagnostic files: ${runDir}`);
  process.exitCode = 1;
});
