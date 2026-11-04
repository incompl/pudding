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
// The modes above describe the interruption. Two further flags describe what
// happens when the user then tries to throw the copy away, which is a separate
// axis and so a separate flag:
//
//   --stick         the copy this run plants refuses to be unlinked, while the
//                   folder stays writable. Plant several entries and stick one,
//                   and the discard is a partial: some pairs go, that one does
//                   not, and the report has to say how many went.
//   --lock-folder   the recovery folder itself refuses every unlink, so no pair
//                   can go at all. Also the state in which a *save* can't stage
//                   its recovery copy, which the save must report as its own
//                   failure rather than as a problem with the track. It stops
//                   this script writing too, so it has to be the last plant of
//                   a run.
//
// --name labels the scratch track, so several entries can be planted in a row
// and the report names them apart:
//
//   node apps/desktop/tools/plant-recovery-copy.mjs --name "Night Bus"
//   node apps/desktop/tools/plant-recovery-copy.mjs --name "Extreme Drift" --stick
//   node apps/desktop/tools/plant-recovery-copy.mjs --name "Neon Harbor"
//
// Then launch Pudding. Quit it first: the sweep runs once, during setup.
//
// --clean undoes all of it, including a stuck copy and a locked folder. Run it
// before planting too: a leftover entry from a previous plant is a real entry in
// the next report, and it will throw off any count the test is checking.
//
// --profile plants into a throwaway app-data root instead of the real
// Application Support profile, which is what the e2e suite does: the same root it
// hands the app as PUDDING_E2E_DATA_DIR, so the sweep at startup finds the plant
// and the user's own recovery folder is never opened. The scratch track goes
// under it too, so the whole plant disappears with the test's temp directory and
// --clean is never needed between cases.
//
//   node apps/desktop/tools/plant-recovery-copy.mjs --profile /tmp/x/profile \
//     --mode replaced --name "Night Bus"
//
// This is also the only safe way to plant --lock-folder or --stick from an
// automated test: both leave the folder or the copy refusing writes, and under
// --profile the folder they refuse is one nothing else will ever look in.

import { execFileSync } from "node:child_process";
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

function parseArgs(argv) {
  const args = {
    mode: "replaced",
    appId: "com.incompl.pudding",
    profile: null,
    track: null,
    name: null,
    stick: false,
    lockFolder: false,
    clean: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--clean") args.clean = true;
    else if (arg === "--stick") args.stick = true;
    else if (arg === "--lock-folder") args.lockFolder = true;
    else if (arg === "--mode") args.mode = argv[++i];
    else if (arg === "--app-id") args.appId = argv[++i];
    else if (arg === "--profile") args.profile = path.resolve(argv[++i]);
    else if (arg === "--track") args.track = argv[++i];
    else if (arg === "--name") args.name = argv[++i];
    else die(`unknown argument: ${arg}`);
  }
  if (!MODES.has(args.mode)) die(`--mode must be one of: ${[...MODES].join(", ")}`);
  return args;
}

function die(message) {
  console.error(`plant-recovery-copy: ${message}`);
  process.exit(1);
}

// Where the sweep will look. `--profile` is the app-data root a harnessed app was
// launched on (PUDDING_E2E_DATA_DIR), so the directory name has to be the one
// Rust joins onto it — METADATA_RECOVERY_DIR in lib.rs. Without it, the real
// Application Support profile, which is what a manual pass plants into.
const recoveryDir = (args) =>
  args.profile
    ? path.join(args.profile, "metadata-recovery")
    : path.join(os.homedir(), "Library", "Application Support", args.appId, "metadata-recovery");

// Where the track being "interrupted" lives. Under the profile when there is
// one, so the whole plant disappears with the temp root the test removes and two
// tests can never see each other's leftovers — which the shared tmpdir path
// below cannot promise, and which is why --clean exists for a manual pass.
const scratchDir = (args) =>
  args.profile
    ? path.join(args.profile, "recovery-test-tracks")
    : path.join(os.tmpdir(), "pudding-recovery-test");

// Only ever removes what this script planted: the prefix is its own, so a real
// interrupted save sitting in the same directory is left alone.
//
// Order matters, and it is the whole reason this is not three rm calls. --stick
// and --lock-folder both make unlink fail, and the folder's mode outranks the
// file's flag, so the mode goes back first and the flags come off second. A
// clean that skipped either would leave the folder refusing writes, which is not
// a visible failure anywhere — until the next metadata save can't stage its
// recovery copy and reports a permission error against the user's own track.
function clean(dir, scratch) {
  let removed = 0;
  const stuck = [];
  if (fs.existsSync(dir)) {
    // Whatever --lock-folder did, undone before anything inside is touched.
    fs.chmodSync(dir, 0o700);
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(PLANT_PREFIX)) continue;
      const planted = path.join(dir, name);
      // Whatever --stick did. Best-effort: a copy that was never stuck has no
      // flag to clear, and chflags says so on stderr, which is not news.
      try {
        execFileSync("chflags", ["nouchg", planted], { stdio: "ignore" });
      } catch {
        // The unlink below is the real test of whether this mattered.
      }
      try {
        fs.rmSync(planted, { force: true });
        removed += 1;
      } catch (error) {
        stuck.push(`${planted}: ${error.message}`);
      }
    }
  }
  // The locked mode leaves a 000-mode file behind; the directory's own
  // permissions are what unlink needs, so this still removes it.
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log(`Removed ${removed} planted file(s) from ${dir}`);
  console.log(`Removed ${scratch}`);
  if (fs.existsSync(dir)) console.log(`Recovery folder left writable: ${dir}`);
  // Never silent. A planted file this could not remove is a real entry in the
  // next launch's report, and the folder may still be refusing writes.
  if (stuck.length > 0) {
    console.error("");
    console.error("plant-recovery-copy: could NOT remove:");
    for (const line of stuck) console.error(`  ${line}`);
    process.exitCode = 1;
  }
}

function plantTrack(scratch, source, name) {
  fs.mkdirSync(scratch, { recursive: true });
  // One scratch track per name, so a second plant does not unlink the first
  // one's track and silently turn that entry into a `replaced` of its own.
  const basename = name
    ? `${name}.mp3`
    : source
      ? `Interrupted Save Test - ${path.basename(source)}`
      : "Interrupted Save Test.mp3";
  const target = path.join(scratch, basename);
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
  const dir = recoveryDir(args);
  const scratch = scratchDir(args);
  if (args.clean) return clean(dir, scratch);
  if (args.track && !fs.existsSync(args.track)) die(`no such track: ${args.track}`);

  fs.mkdirSync(dir, { recursive: true });
  // A --lock-folder plant leaves the folder refusing writes, so the next plant
  // cannot write its own copy there. Say which state this is and what undoes it,
  // rather than dying on a bare EACCES against a path the caller didn't name —
  // which is the same confusion an unwritable recovery folder causes in the app.
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    die(
      `${dir} is not writable, which is what --lock-folder leaves behind.\n` +
        "  --lock-folder has to be the last plant of a run. Start over with --clean.",
    );
  }
  const target = plantTrack(scratch, args.track, args.name);
  const original = fs.readFileSync(target);

  // The copy and its record, exactly as a save makes them before it touches the
  // track: same naming, the digest and the file identity of the track as it
  // stood. `retained` is the state a save moves the record to when its own
  // rollback has already failed and it has told the user so.
  const state = args.mode === "retained" ? "retained" : "prepared";
  let backup = path.join(dir, `${PLANT_PREFIX}${Date.now()}`);
  for (let n = 1; fs.existsSync(backup); n += 1) {
    backup = path.join(dir, `${PLANT_PREFIX}${Date.now()}-${n}`);
  }
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

  // Now what the discard will run into. Both go last: each one makes the folder
  // or the copy refuse the writes the plant above still needed.
  if (args.stick && args.mode !== "no-copy") {
    // The user immutable flag, which unlink answers to even in a folder the user
    // owns and can write. The codebase's own unit test stands a directory in the
    // copy's place for this; a flag is the same refusal without a copy that is
    // the wrong kind of file.
    try {
      execFileSync("chflags", ["uchg", backup], { stdio: "pipe" });
    } catch (error) {
      // Loudly. A copy that is not actually stuck makes the discard succeed, and
      // the test would read that as the report wording being right.
      die(`couldn't make ${backup} refuse deletion: ${error.message}`);
    }
  } else if (args.stick) {
    die("--stick needs a copy to stick, and --mode no-copy removes it");
  }
  if (args.lockFolder) fs.chmodSync(dir, 0o500);

  console.log(`Planted a ${args.mode} interrupted save.`);
  console.log(`  track:    ${target}`);
  console.log(`  copy:     ${backup}${args.stick ? "  (uchg: will refuse to be discarded)" : ""}`);
  console.log(`  record:   ${backup}.json`);
  if (args.lockFolder) console.log(`  folder:   ${dir}  (mode 500: refuses every unlink)`);
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
  if (args.lockFolder) {
    console.log(
      "Launch Pudding and press Discard: nothing can go, so the report must say\n" +
        "that plainly and name what refused. A metadata save is also impossible in\n" +
        "this state, and must fail as its own recovery-copy problem rather than as a\n" +
        "permission error against the track the user was editing.",
    );
  } else if (args.stick) {
    console.log(
      "Plant the other entries you want, then launch Pudding and press Discard:\n" +
        "this copy stays and the rest go, so the report must count what went instead\n" +
        "of reading as though nothing did. The record stays beside this copy, so the\n" +
        "next launch offers it again.",
    );
  } else {
    console.log(
      nextStep[args.mode] ??
        "Launch Pudding: it should keep the copy and report it, at this and every launch until you retry or discard it.",
    );
  }
  console.log(
    "Undo with: node apps/desktop/tools/plant-recovery-copy.mjs --clean" +
      (args.profile ? ` --profile ${JSON.stringify(args.profile)}` : "") +
      (args.profile ? "\n  (or just remove the profile directory — the whole plant is inside it)" : ""),
  );
}

main();
