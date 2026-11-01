#!/usr/bin/env node
// Plant the artifacts an interrupted metadata save leaves behind, so the startup
// recovery report can be tested on purpose instead of by force-quitting at the
// right millisecond.
//
// The branch worth planting is the one a force-quit almost never produces: a
// recovery copy Pudding *cannot* put back, which is the case where the track on
// disk may be incomplete and the copy in Application Support is the only place
// the original bytes still exist. Startup resolves that entry the same way every
// launch, so the report returns until it is retried or discarded.
//
// This never touches a file it did not create. --track copies the file you name
// into the scratch directory and plants against the copy; the original is only
// ever read.
//
//   node apps/desktop/tools/plant-recovery-copy.mjs            # replaced: another
//                      program took the track's path, so the copy can't go back
//   node apps/desktop/tools/plant-recovery-copy.mjs --mode missing
//                      the track itself is gone
//   node apps/desktop/tools/plant-recovery-copy.mjs --mode locked
//                      the track is there but unopenable
//   node apps/desktop/tools/plant-recovery-copy.mjs --mode restorable
//                      the one case the next launch finishes by itself
//   node apps/desktop/tools/plant-recovery-copy.mjs --mode no-copy
//                      the record outlived its copy: nothing left to put back,
//                      so the report must not offer one
//   node apps/desktop/tools/plant-recovery-copy.mjs --mode unreadable
//                      the copy outlived its record: no track to name, so the
//                      report must point at the copy instead
//   node apps/desktop/tools/plant-recovery-copy.mjs --mode retained
//                      the save failed in front of the user and couldn't roll
//                      itself back, so the report must not blame a crash
//   node apps/desktop/tools/plant-recovery-copy.mjs --clean
//
// `locked` is the one that can be un-stuck: chmod the track back to 644 while
// the report is open and Retry restore then succeeds, which is the real-world
// case of a volume that wasn't reachable at launch.
//
// Then launch Pudding. Quit it first: the sweep runs once, during setup.

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MODES = new Set([
  "replaced",
  "missing",
  "locked",
  "restorable",
  "no-copy",
  "unreadable",
  "retained",
]);
const PLANT_PREFIX = ".pudding-backup-plant-";
const SCRATCH = path.join(os.tmpdir(), "pudding-recovery-test");

function parseArgs(argv) {
  const args = { mode: "replaced", appId: "com.incompl.pudding", track: null, clean: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--clean") args.clean = true;
    else if (arg === "--mode") args.mode = argv[++i];
    else if (arg === "--app-id") args.appId = argv[++i];
    else if (arg === "--track") args.track = argv[++i];
    else die(`unknown argument: ${arg}`);
  }
  if (!MODES.has(args.mode)) die(`--mode must be one of: ${[...MODES].join(", ")}`);
  return args;
}

function die(message) {
  console.error(`plant-recovery-copy: ${message}`);
  process.exit(1);
}

const recoveryDir = (appId) =>
  path.join(os.homedir(), "Library", "Application Support", appId, "metadata-recovery");

// Only ever removes what this script planted: the prefix is its own, so a real
// interrupted save sitting in the same directory is left alone.
function clean(dir) {
  let removed = 0;
  if (fs.existsSync(dir)) {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(PLANT_PREFIX)) continue;
      fs.rmSync(path.join(dir, name), { force: true });
      removed += 1;
    }
  }
  // The locked mode leaves a 000-mode file behind; the directory's own
  // permissions are what unlink needs, so this still removes it.
  fs.rmSync(SCRATCH, { recursive: true, force: true });
  console.log(`Removed ${removed} planted file(s) from ${dir}`);
  console.log(`Removed ${SCRATCH}`);
}

function plantTrack(source) {
  fs.mkdirSync(SCRATCH, { recursive: true });
  const target = path.join(
    SCRATCH,
    source ? `Interrupted Save Test - ${path.basename(source)}` : "Interrupted Save Test.mp3",
  );
  // The scratch name is reused across plants, and `locked` leaves its track at
  // mode 000, so without this every plant after a locked one dies on EACCES
  // until --clean. Unlink answers to the directory's permissions rather than the
  // file's, so this removes a file that no write could have opened.
  fs.rmSync(target, { force: true });
  // A throwaway stand-in by default: the report names a path and compares file
  // identity, and neither cares whether the bytes decode.
  if (source) fs.copyFileSync(source, target);
  else fs.writeFileSync(target, Buffer.from("original bytes, as they were before the update\n"));
  return target;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dir = recoveryDir(args.appId);
  if (args.clean) return clean(dir);
  if (args.track && !fs.existsSync(args.track)) die(`no such track: ${args.track}`);

  fs.mkdirSync(dir, { recursive: true });
  const target = plantTrack(args.track);
  const original = fs.readFileSync(target);

  // The copy and its record, exactly as a save makes them before it touches the
  // track: same naming, the digest and the file identity of the track as it
  // stood. `retained` is the state a save moves the record to when its own
  // rollback has already failed and it has told the user so.
  const state = args.mode === "retained" ? "retained" : "prepared";
  const backup = path.join(dir, `${PLANT_PREFIX}${Date.now()}`);
  fs.writeFileSync(backup, original);
  const stat = fs.statSync(target, { bigint: true });
  const digest = createHash("sha256").update(original).digest("hex");
  // Hand-built so the nanosecond stamp keeps every digit: it is a u128 on the
  // Rust side and JSON.stringify would round it away through a double.
  const manifest = [
    "{",
    '"version":1,',
    `"state":${JSON.stringify(state)},`,
    `"target":${JSON.stringify(target)},`,
    `"backup":${JSON.stringify(backup)},`,
    '"original_stamp":{',
    `"size":${stat.size},`,
    `"modified_ns":${stat.mtimeNs},`,
    `"device":${stat.dev},`,
    `"inode":${stat.ino}`,
    "},",
    `"original_sha256":${JSON.stringify(digest)}`,
    "}",
  ].join("");
  fs.writeFileSync(`${backup}.json`, manifest);

  // Now the interruption itself, left in the state the next launch will find.
  if (args.mode === "no-copy") {
    // The record alone. There is no original anywhere, so the report has nothing
    // to keep and nothing to retry — only the record to clear.
    fs.rmSync(backup);
    fs.writeFileSync(target, Buffer.from("half-writt"));
  } else if (args.mode === "unreadable") {
    // The record truncated the way a crash mid-write truncates it, with the copy
    // intact behind it: nothing names the track, so the copy is all there is.
    fs.writeFileSync(`${backup}.json`, Buffer.from('{"version":1,"state":"prep'));
    fs.writeFileSync(target, Buffer.from("half-writt"));
  } else if (args.mode === "replaced" || args.mode === "retained") {
    // Unlink and recreate: a new inode under the same path is what a sync client
    // or another tagger does, and it is newer information than the record, so
    // recovery must refuse to overwrite it and keep the copy.
    fs.rmSync(target);
    fs.writeFileSync(target, Buffer.from("replaced by another program after the save started\n"));
  } else if (args.mode === "missing") {
    fs.rmSync(target);
  } else if (args.mode === "locked") {
    // Half-written and unopenable: the inode is still the right one, so this is
    // the entry a retry can finish once the track becomes readable again.
    fs.writeFileSync(target, Buffer.from("half-writt"));
    fs.chmodSync(target, 0o000);
  } else {
    // Same inode, half-written content: this one Pudding can and will put back.
    fs.writeFileSync(target, Buffer.from("half-writt"));
  }

  console.log(`Planted a ${args.mode} interrupted save.`);
  console.log(`  track:    ${target}`);
  console.log(`  copy:     ${backup}`);
  console.log(`  record:   ${backup}.json`);
  console.log("");
  const nextStep = {
    restorable: "Launch Pudding: it should restore the track and report it once.",
    locked: `Launch Pudding: it should keep the copy and report it. Then run\n  chmod 644 ${JSON.stringify(target)}\nand press Retry restore — that one should succeed.`,
    "no-copy":
      "Launch Pudding: the report should say the copy is gone too and offer only\nto clear the record — never to put an original back.",
    unreadable:
      "Launch Pudding: the report should name no track, point at the copy's path,\nand offer only to discard it.",
    retained:
      'Launch Pudding: the report should blame an earlier failed save, not a crash\n(no "when Pudding stopped").',
  };
  console.log(
    nextStep[args.mode] ??
      "Launch Pudding: it should keep the copy and report it, at this and every launch until you retry or discard it.",
  );
  console.log("Undo with: node apps/desktop/tools/plant-recovery-copy.mjs --clean");
}

main();
