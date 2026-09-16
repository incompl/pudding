// Shared scaffolding for the bulk tag-editing tests.
//
// These are the first tests that *write* to the files they open, which changes two
// things about how a test has to be set up:
//
//   - the fixtures are copied to a temp directory and the library is pointed at
//     the copies. Run against `e2e/fixtures` directly, a save would leave the
//     checkout dirty and the second run would start from the first run's tags;
//   - the app gets a throwaway profile (PUDDING_E2E_DATA_DIR), because pointing
//     the library somewhere is a *persisted* setting. Without it a test run would
//     repoint whoever is running it at a temp folder that no longer exists, and
//     stamp their library database with three hundred tone copies.

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startHarness, type Driver, type Harness } from "./harness.ts";

const dir = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURES = path.join(dir, "fixtures");

/** One editor field as the form is currently showing it. */
export type EditorField = {
  value: string;
  placeholder: string;
  disabled: boolean;
  /** Touched, so this field rides along in the patch — what the border says. */
  dirty: boolean;
  mixed: boolean;
  total?: { value: string; placeholder: string; disabled: boolean; dirty: boolean };
};

/** The mounted metadata form, read back through the bridge. */
export type EditorForm = {
  heading: string;
  note: string | null;
  submitDisabled: boolean;
  cancelLabel: string;
  artwork: { placeholder: string | null } | null;
  fields: Record<string, EditorField>;
};

/** The tags a file carries on disk, as the editor's own seed read sees them. */
export type FileTags = {
  title: string | null;
  artist: string | null;
  album: string | null;
  albumArtist: string | null;
  genre: string | null;
  comment: string | null;
  year: number | null;
  disc: number | null;
  track: number | null;
};

export type TagWriteReport = {
  ok: { path: string; tags: Record<string, unknown> }[];
  failed: { path: string; message: string; stale: boolean }[];
  stopped: boolean;
  // Set when the storage failed under the batch and the loop gave up on the rest.
  aborted: string | null;
};

// A temp root holding the app's profile and every library this test makes. One
// directory per test file, removed whole at the end — nothing here outlives a run.
export async function tempRoot(name: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), `pudding-e2e-${name}-`));
}

// Launch the app on a throwaway profile under `root`. Every other suite runs on
// the real one; these tests must not, because they change a persisted setting (see
// the header).
export async function startIsolated(root: string): Promise<Harness> {
  const profile = path.join(root, "profile");
  await fs.mkdir(profile, { recursive: true });
  return startHarness({ env: { PUDDING_E2E_DATA_DIR: profile } });
}

// Copy `fixture` into a new library folder under `root`, `count` times, named so
// that path order, tree order and the order a test passes them in all agree —
// `track-001.m4a` through `track-NNN.m4a`.
export async function makeLibrary(
  root: string,
  name: string,
  count: number,
  fixture = "tone-a.m4a",
): Promise<{ dir: string; paths: string[] }> {
  const libDir = path.join(root, name);
  await fs.mkdir(libDir, { recursive: true });
  const src = path.join(FIXTURES, fixture);
  const paths: string[] = [];
  for (let i = 1; i <= count; i++) {
    const file = path.join(libDir, `track-${String(i).padStart(3, "0")}.m4a`);
    await fs.copyFile(src, file);
    paths.push(file);
  }
  return { dir: libDir, paths };
}

// Point the library at one folder and wait until it is fully there — which is two
// separate things, because the Files tree draws its titles from the *database*
// (list_dir reads cached rows, never the files) while the scan that fills it runs
// on behind the first paint. So: every file has a row, and the tree has repainted
// from them. `titles` names what a row must be showing for the second half to
// count — mounted rows only, since the tree is windowed.
export async function useLibrary(
  d: Driver,
  lib: { dir: string; paths: string[] },
  titles: Record<string, string>,
): Promise<void> {
  await d.action("setLibraryRoot", { path: lib.dir });
  await d.waitFor(
    async () => {
      const rows = (await d.invoke("folder_tracks", { path: lib.dir })) as unknown[];
      return rows.length === lib.paths.length;
    },
    {
      timeout: 60_000,
      message: `the scan never indexed all ${lib.paths.length} files under ${lib.dir}`,
    },
  );
  // The Files panel opens on its root menu, and the tree builds no DOM until Browse
  // is the visible view — so a test that wants to read rows has to go there, the
  // same way "Show in Browse" does.
  await d.action("browseFolder", { path: lib.dir });
  await d.waitFor(
    async () => {
      const shown = await treeTitles(d);
      return Object.entries(titles).every(([file, title]) => shown[file] === title);
    },
    { timeout: 30_000, message: "the Files tree never repainted with the scanned tags" },
  );
}

// Tag generations are minted by the *frontend* (see editors.ts), starting at 1 and
// counting up within a session. A test that invokes write_tags itself has to mint
// its own, and it must not collide with those: a batch whose generation matches the
// one a Stop last stored is a batch that reports itself cancelled before it writes
// a thing. Start far above anything a form will reach.
let seedGeneration = 1_000_000;

// Write a patch straight through the command, bypassing the form. This is how a
// test *seeds* files with the tags it wants to edit; the tests drive the real form
// for the edit they are actually asserting on.
export async function writeTags(
  d: Driver,
  paths: string[],
  tags: Record<string, unknown>,
): Promise<TagWriteReport> {
  return (await d.invoke("write_tags", {
    paths,
    tags,
    generation: ++seedGeneration,
  })) as TagWriteReport;
}

// What one file says on disk, read back through the same command the editor seeds
// itself from. A single path agrees with itself about everything, so `common` is
// simply that file's tags.
export async function readTags(d: Driver, file: string): Promise<FileTags> {
  const seed = (await d.invoke("read_common_tags", {
    paths: [file],
    generation: ++seedGeneration,
  })) as { common: FileTags };
  return seed.common;
}

/** The mounted metadata form, or a throw if no editor is open. */
export async function editorForm(d: Driver): Promise<EditorForm> {
  return (await d.action("editorFields")) as EditorForm;
}

// The same, but null once the form has closed rather than a throw — for polling a
// running save, which ends either in a note on a form that stayed up or in a form
// that closed because there was nothing to report.
export async function editorFormOrClosed(d: Driver): Promise<EditorForm | null> {
  return (await editorOpen(d)) ? editorForm(d) : null;
}

/** Type `value` into the editor field labelled `label` (see the bridge action). */
export async function typeInEditor(
  d: Driver,
  label: string,
  value: string,
): Promise<void> {
  await d.action("editorType", { label, value });
}

/** Is a metadata editor mounted? The form leaves the DOM when a save closes it. */
export function editorOpen(d: Driver): Promise<boolean> {
  return d.exists("#pane-editor-view .inline-editor");
}

/** Press Save. The form is left to the caller: a save that isn't clean stays up. */
export async function save(d: Driver): Promise<void> {
  await d.click("#pane-editor-view .inline-editor-submit");
}

/** The titles the Files tree is showing, by path — mounted rows only. */
export async function treeTitles(d: Driver): Promise<Record<string, string>> {
  return (await d.action("treeRowTitles")) as Record<string, string>;
}

/** A file's bytes, as a hash — for asserting a file was left completely alone. */
export async function digest(file: string): Promise<string> {
  return createHash("sha256").update(await fs.readFile(file)).digest("hex");
}
