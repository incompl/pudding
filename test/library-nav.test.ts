// Unit tests for the Files-pane library navigator (src/library-nav.ts).
//
// The navigator is dependency-injected and imports only *types* from main.ts, so
// it runs in isolation against a tiny fake DOM (test/fake-dom.ts) — no Tauri, no
// app build, no browser. We drive it exactly as a user does: by firing the real
// click / dblclick / contextmenu listeners the module attaches to its rows, then
// asserting the rendered DOM and which injected deps were called.
//
// The focus is the design invariants that are easy to regress and that the e2e
// suite can't reach (the e2e fixtures carry no artist/album metadata, so the
// Artist/Album lenses are empty there):
//   - lenses DRILL LEFT (replace + back header); playlists OPEN RIGHT and must
//     NOT disturb the root menu — the whole edit workflow depends on it;
//   - the async-load guard bails when a navigation detached its host;
//   - album detail's synthetic pool path stays byte-for-byte the openAlbumQueue
//     key, so playing from the nav shares Play-album's pool identity.

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { installFakeDom, type FakeEl } from "./fake-dom.ts";
import type {
  SearchTrack,
  SearchArtist,
  SearchAlbum,
  PlaylistRef,
  LeafListContext,
} from "../src/main.ts";

// Imported after the module surface is known; library-nav reads `document` only
// inside functions (never at import), so importing it before we install the fake
// DOM is safe. Each test installs a fresh document in beforeEach.
import {
  initLibraryNav,
  popNavToRoot,
  refreshNavPlaylists,
  type LibraryNavDeps,
  type NavStep,
} from "../src/library-nav.ts";

// Flush pending microtasks/timers so async list bodies (Promise .then) settle.
const flush = () => new Promise((r) => setTimeout(r, 0));

type Call = { name: string; args: unknown[] };

interface Fixture {
  container: FakeEl;
  folderTree: FakeEl;
  createBtn: FakeEl;
  calls: Call[];
  leafCtx: LeafListContext[];
  // The most recent location the navigator persisted (render's choke point).
  saved: { steps: NavStep[] };
  deps: LibraryNavDeps;
}

// A library with two artists, a shared album to exercise the compilation branch,
// and one playlist. Every loader resolves immediately.
function setup(over: Partial<LibraryNavDeps> = {}, initial?: NavStep[]): Fixture {
  const doc = installFakeDom();
  const container = doc.registerRoot("library-nav");
  doc.registerRoot("lens-footer");
  const folderTree = doc.registerRoot("folder-tree");
  const createBtn = doc.registerRoot("create-playlist-btn");

  const calls: Call[] = [];
  const leafCtx: LeafListContext[] = [];
  const saved: { steps: NavStep[] } = { steps: [] };
  const rec = (name: string) => (...args: unknown[]) => void calls.push({ name, args });

  const songs: SearchTrack[] = [
    { path: "/m/a1.m4a", title: "A1", artist: "Alice", album: "Debut" },
    { path: "/m/z1.m4a", title: "Z1", artist: "Zoe", album: "Split" },
  ];
  const artists: SearchArtist[] = [{ name: "Alice" }, { name: "Zoe" }];
  const albums: SearchAlbum[] = [
    { album: "Debut", artist: "Alice" },
    { album: "Split", artist: "Various" },
  ];
  const playlists: PlaylistRef[] = [{ name: "Roadtrip", path: "/pl/roadtrip.m3u8" }];

  const deps: LibraryNavDeps = {
    listAllSongs: async () => songs,
    listAllArtists: async () => artists,
    listAllAlbums: async () => albums,
    listAllPlaylists: async () => playlists,
    // Alice appears on her own "Debut" and on the "Various"-credited "Split".
    artistAlbums: async (artist) =>
      artist === "Alice"
        ? [
            { album: "Debut", artist: "Alice" },
            { album: "Split", artist: "Various" },
          ]
        : [{ album: "Split", artist: "Various" }],
    albumTracks: async () => songs,
    renderLeafTrackList: (_tracks, ctx) => {
      leafCtx.push(ctx);
      return doc.createElement("div") as unknown as HTMLElement;
    },
    openPlaylist: rec("openPlaylist"),
    playPlaylist: rec("playPlaylist"),
    showArtistMenu: rec("showArtistMenu"),
    showAlbumMenu: rec("showAlbumMenu"),
    showPlaylistMenu: rec("showPlaylistMenu"),
    persistLocation: (steps) => void (saved.steps = steps),
    ...over,
  };

  initLibraryNav(deps, initial);
  return { container, folderTree, createBtn, calls, leafCtx, saved, deps };
}

// Find a nav-row by its primary label, searching the whole rendered subtree.
function rowByLabel(root: FakeEl, label: string): FakeEl {
  const row = root
    .queryAll("nav-row")
    .find((r) => r.queryAll("nav-primary")[0]?.textContent === label);
  assert.ok(row, `no nav-row labelled "${label}"`);
  return row;
}

const labels = (root: FakeEl) =>
  root.queryAll("nav-row").map((r) => r.queryAll("nav-primary")[0]?.textContent);
const hasBackHeader = (container: FakeEl) => container.queryAll("nav-back").length > 0;

beforeEach(() => {
  // A fresh document per test; setup() installs it. popNavToRoot resets the
  // module's navigation stack so state can't leak between tests.
  installFakeDom();
});

test("root menu lists the four lenses, then the async-loaded playlists", async () => {
  const { container, createBtn, folderTree } = setup();
  // The four lenses render synchronously; playlists arrive after the load.
  assert.deepEqual(labels(container).slice(0, 4), ["Browse", "Songs", "Artists", "Albums"]);
  await flush();
  assert.ok(labels(container).includes("Roadtrip"), "playlist row never rendered");
  // At the root the create-playlist button shows and the folder tree is hidden.
  assert.ok(!createBtn.classList.contains("hidden"), "create button shows at root");
  assert.ok(folderTree.classList.contains("hidden"), "folder tree hidden outside Browse");
});

test("a lens drills in (replace + back header); back returns to the root menu", async () => {
  const { container, createBtn } = setup();
  rowByLabel(container, "Songs").fire("click");
  await flush();

  assert.ok(hasBackHeader(container), "drilling a lens must leave a back header");
  assert.ok(createBtn.classList.contains("hidden"), "create button hides while drilled");
  // The root lens rows are gone — the pane was replaced, not stacked.
  assert.ok(!labels(container).includes("Artists"), "root menu should be replaced");

  container.queryAll("nav-back")[0].fire("click");
  await flush();
  assert.ok(!hasBackHeader(container), "back should return to the root");
  assert.deepEqual(labels(container).slice(0, 4), ["Browse", "Songs", "Artists", "Albums"]);
  assert.ok(!createBtn.classList.contains("hidden"), "create button returns at root");
});

test("a playlist row OPENS RIGHT without drilling — the root menu stays put", async () => {
  const { container, calls } = setup();
  await flush();
  rowByLabel(container, "Roadtrip").fire("click");

  // openPlaylist fired with the file path…
  assert.deepEqual(
    calls.filter((c) => c.name === "openPlaylist"),
    [{ name: "openPlaylist", args: ["/pl/roadtrip.m3u8"] }],
  );
  // …and, critically, we did NOT drill: no back header, root lenses still present.
  assert.ok(!hasBackHeader(container), "opening a playlist must not drill the pane");
  assert.ok(labels(container).includes("Artists"), "root menu must stay put");
});

test("a playlist row plays on double-click and raises its menu on right-click", async () => {
  const { container, calls } = setup();
  await flush();
  const row = rowByLabel(container, "Roadtrip");

  row.fire("dblclick");
  assert.deepEqual(calls.at(-1), { name: "playPlaylist", args: ["/pl/roadtrip.m3u8"] });

  row.fire("contextmenu", { clientX: 12, clientY: 34 });
  assert.deepEqual(calls.at(-1), {
    name: "showPlaylistMenu",
    args: [12, 34, "/pl/roadtrip.m3u8"],
  });
});

test("Browse un-hides the folder tree; other lenses hide it", async () => {
  const { container, folderTree } = setup();
  rowByLabel(container, "Browse").fire("click");
  assert.ok(!folderTree.classList.contains("hidden"), "Browse must reveal the folder tree");

  popNavToRoot();
  rowByLabel(container, "Songs").fire("click");
  assert.ok(folderTree.classList.contains("hidden"), "non-Browse lenses hide the folder tree");
  popNavToRoot();
});

test("popNavToRoot collapses a multi-level drill back to the root menu", async () => {
  const { container } = setup();
  rowByLabel(container, "Artists").fire("click");
  await flush();
  rowByLabel(container, "Alice").fire("click"); // -> artist detail (albums)
  await flush();
  assert.ok(hasBackHeader(container), "should be drilled two levels deep");

  popNavToRoot();
  assert.ok(!hasBackHeader(container), "popNavToRoot must return to the root menu");
  assert.deepEqual(labels(container).slice(0, 4), ["Browse", "Songs", "Artists", "Albums"]);
});

test("artist detail hides the album-artist secondary only when it differs", async () => {
  const { container } = setup();
  rowByLabel(container, "Artists").fire("click");
  await flush();
  rowByLabel(container, "Alice").fire("click");
  await flush();

  const secondaryOf = (label: string) => {
    const row = rowByLabel(container, label);
    return row.queryAll("nav-secondary")[0]?.textContent;
  };
  // "Debut" is Alice's own album -> no redundant secondary. "Split" is credited to
  // "Various" -> show it so the compilation reads correctly.
  assert.equal(secondaryOf("Debut"), undefined);
  assert.equal(secondaryOf("Split"), "Various");
  popNavToRoot();
});

test("album detail builds the exact openAlbumQueue synthetic pool path", async () => {
  const { container, leafCtx } = setup();
  rowByLabel(container, "Albums").fire("click");
  await flush();
  rowByLabel(container, "Split").fire("click"); // albumArtist "Various"
  await flush();

  const ctx = leafCtx.at(-1);
  assert.ok(ctx, "album detail never rendered a leaf list");
  // Must match openAlbumQueue's key: `queue:album:<albumArtist>\0<album>`. A drift
  // here silently forks the pool identity from Play album.
  assert.equal(ctx.syntheticPath, "queue:album:Various\0Split");
  assert.equal(ctx.title, "Split");
  popNavToRoot();
});

test("an async list bails when a navigation detached its host before load resolved", async () => {
  let resolveSongs!: (v: SearchTrack[]) => void;
  const fixture = setup({
    listAllSongs: () => new Promise<SearchTrack[]>((r) => (resolveSongs = r)),
  });
  const { container, leafCtx } = fixture;

  rowByLabel(container, "Songs").fire("click"); // Songs body mounts, load pending
  popNavToRoot(); // navigate away — replaceChildren detaches the Songs host
  resolveSongs([{ path: "/m/a1.m4a", title: "A1", artist: "Alice", album: "Debut" }]);
  await flush();

  // The guard (host.isConnected) must skip fill: rendering into a detached host is
  // wasted work and would clobber the shared navLeafTracks for the list on screen.
  assert.equal(leafCtx.length, 0, "fill ran against a detached host");
});

test("refreshNavPlaylists reloads at the root, but is a no-op while drilled", async () => {
  let loads = 0;
  const fixture = setup({
    listAllPlaylists: async () => {
      loads++;
      return [{ name: "Roadtrip", path: "/pl/roadtrip.m3u8" }];
    },
  });
  const { container } = fixture;
  await flush();
  assert.equal(loads, 1, "root menu loads playlists once on init");

  // Drilled into a lens: the playlist list isn't shown, so a refresh must not
  // re-render (and re-load) it.
  rowByLabel(container, "Songs").fire("click");
  await flush();
  refreshNavPlaylists();
  await flush();
  assert.equal(loads, 1, "refresh while drilled should not reload playlists");

  // Back at the root, a refresh re-renders and re-loads.
  popNavToRoot();
  refreshNavPlaylists();
  await flush();
  assert.equal(loads, 3, "back-to-root render (2) + explicit refresh (3) each reload");
});

test("persists the current place on every navigation (root, lens, deep drill)", async () => {
  const { container, saved } = setup();
  // The root menu persists as an empty stack (restores to the springboard).
  assert.deepEqual(saved.steps, []);

  rowByLabel(container, "Artists").fire("click");
  await flush();
  assert.deepEqual(saved.steps, [{ t: "lens", lens: "artist" }]);

  rowByLabel(container, "Alice").fire("click"); // -> artist detail
  await flush();
  assert.deepEqual(saved.steps, [
    { t: "lens", lens: "artist" },
    { t: "artist", name: "Alice" },
  ]);

  rowByLabel(container, "Split").fire("click"); // -> album detail (albumArtist "Various")
  await flush();
  assert.deepEqual(saved.steps, [
    { t: "lens", lens: "artist" },
    { t: "artist", name: "Alice" },
    { t: "album", album: "Split", albumArtist: "Various" },
  ]);

  // back() persists the shortened stack.
  container.queryAll("nav-back")[0].fire("click");
  await flush();
  assert.deepEqual(saved.steps, [
    { t: "lens", lens: "artist" },
    { t: "artist", name: "Alice" },
  ]);
  popNavToRoot();
});

test("restores a persisted deep drill on init (rebuilds the stack + back header)", async () => {
  const { container, leafCtx } = setup({}, [
    { t: "lens", lens: "album" },
    { t: "album", album: "Split", albumArtist: "Various" },
  ]);
  await flush();

  // Rebuilt two levels deep: a back header is present and the album's leaf list
  // rendered under the exact openAlbumQueue pool identity.
  assert.ok(hasBackHeader(container), "restore should rebuild the drilled-in stack");
  assert.equal(leafCtx.at(-1)?.syntheticPath, "queue:album:Various\0Split");
  popNavToRoot();
});

test("a malformed persisted location falls back to the root menu", async () => {
  // First step isn't a lens — a corrupt/stale store. Restore must discard it.
  const { container } = setup({}, [{ t: "artist", name: "Alice" }]);
  await flush();
  assert.ok(!hasBackHeader(container), "malformed location must not leave a broken stack");
  assert.deepEqual(labels(container).slice(0, 4), ["Browse", "Songs", "Artists", "Albums"]);
  popNavToRoot();
});
