import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlaylistAccess } from "../src/playlist-file.ts";

function fixture() {
  let revision = "original";
  let mtime = 1;
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const access = createPlaylistAccess(async <T>(command: string, args: Record<string, unknown>) => {
    calls.push({ command, args });
    if (command === "read_playlist") {
      return { name: "Mix", path: "/mix.m3u8", tracks: [], revision, mtime } as T;
    }
    if (!args.overwrite && args.expectedRevision !== revision) throw "changed on disk";
    revision = String(args.name);
    return { revision, mtime: ++mtime } as T;
  }, () => {});
  return { access, calls, externalEdit: () => { revision = "external"; }, revision: () => revision };
}

test("rapid autosaves use the preceding successful revision, in order", async () => {
  const f = fixture();
  const data = await f.access.read("/mix.m3u8");
  const a = f.access.write(data.path, "first", [], data.fileSession);
  const b = f.access.write(data.path, "second", [], data.fileSession);
  await Promise.all([a, b]);
  assert.deepEqual(f.calls.filter((c) => c.command === "write_playlist").map((c) => c.args.expectedRevision), ["original", "first"]);
  assert.equal(f.revision(), "second");
  assert.equal(data.fileSession.revision, "second");
});

test("an incidental fresh read cannot authorize a stale view to overwrite it", async () => {
  const f = fixture();
  const old = await f.access.read("/mix.m3u8");
  f.externalEdit();
  const fresh = await f.access.read(old.path);
  assert.notEqual(fresh.fileSession, old.fileSession);
  await assert.rejects(f.access.write(old.path, "stale", [], old.fileSession));
  await assert.rejects(f.access.write(old.path, "stale again", [], old.fileSession));
  assert.equal(f.revision(), "external");
  await f.access.write(fresh.path, "fresh edit", [], fresh.fileSession);
  assert.equal(f.revision(), "fresh edit");
});

test("reads wait for pending saves and reuse the current session", async () => {
  const f = fixture();
  const first = await f.access.read("/mix.m3u8");
  const save = f.access.write(first.path, "saved", [], first.fileSession);
  const read = f.access.read(first.path);
  await save;
  const second = await read;
  assert.equal(second.revision, "saved");
  assert.equal(second.fileSession, first.fileSession);
});

test("replacement of an unread existing file requires explicit overwrite", async () => {
  const f = fixture();
  await assert.rejects(f.access.write("/mix.m3u8", "implicit overwrite", []));
  assert.equal(f.revision(), "original");
  const saved = await f.access.write("/mix.m3u8", "confirmed replacement", [], undefined, true);
  assert.equal(saved.revision, "confirmed replacement");
});

test("failed saves leave subsequent queued edits on the stale revision", async () => {
  const f = fixture();
  const data = await f.access.read("/mix.m3u8");
  f.externalEdit();
  const saves = await Promise.allSettled([
    f.access.write(data.path, "first", [], data.fileSession),
    f.access.write(data.path, "second", [], data.fileSession),
  ]);
  assert.deepEqual(saves.map((s) => s.status), ["rejected", "rejected"]);
  assert.equal(f.revision(), "external");
  assert.equal(data.fileSession.revision, "original");
});

test("simultaneous closed-playlist appends preserve both additions", async () => {
  let tracks: { path: string }[] = [];
  let revision = "0";
  const access = createPlaylistAccess(async <T>(command: string, args: Record<string, unknown>) => {
    if (command === "read_playlist") {
      return { name: "Mix", path: "/mix.m3u8", tracks: tracks.slice(), revision, mtime: 1 } as T;
    }
    assert.equal(args.expectedRevision, revision);
    tracks = args.tracks as { path: string }[];
    revision = String(Number(revision) + 1);
    return { revision, mtime: 1 } as T;
  }, () => {});
  await Promise.all([
    access.append("/mix.m3u8", [{ path: "/a.mp3" }]),
    access.append("/mix.m3u8", [{ path: "/b.mp3" }]),
  ]);
  assert.deepEqual(tracks.map((t) => t.path), ["/a.mp3", "/b.mp3"]);
});

test("a tree rename follows pending autosaves and returns the saved session", async () => {
  const f = fixture();
  const data = await f.access.read("/mix.m3u8");
  const save = f.access.write(data.path, "curation", [], data.fileSession);
  const rename = f.access.rename(data.path, "renamed");
  await save;
  const renamed = await rename;
  assert.equal(renamed.revision, "renamed");
  assert.equal(renamed.fileSession, data.fileSession);
  await f.access.write(data.path, "next edit", [], renamed.fileSession);
  assert.equal(f.revision(), "next edit");
});
