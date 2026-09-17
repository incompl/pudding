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
// Artist/Album views are empty there):
//   - views DRILL LEFT (replace + back header); playlists OPEN RIGHT and must
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
} from "../src/types.ts";

// Imported after the module surface is known; library-nav reads `document` only
// inside functions (never at import), so importing it before we install the fake
// DOM is safe. Each test installs a fresh document in beforeEach.
import {
  initLibraryNav,
  popNavToRoot,
  refreshNavPlaylists,
  invalidateNavListCache,
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
  filesEmpty: FakeEl;
  filesEmptyLead: FakeEl;
  calls: Call[];
  leafCtx: LeafListContext[];
  // The track lists handed to each renderLeafTrackList call, in order — so a test
  // can assert what per-track metadata (e.g. albumArtist) survived into a leaf list.
  leafTracks: SearchTrack[][];
  // The most recent location the navigator persisted (render's choke point).
  saved: { steps: NavStep[] };
  deps: LibraryNavDeps;
}

// A library with two artists, a shared album to exercise the compilation branch,
// and one playlist. Every loader resolves immediately.
function setup(over: Partial<LibraryNavDeps> = {}, initial?: NavStep[]): Fixture {
  const doc = installFakeDom();
  const container = doc.registerRoot("library-nav");
  const folderTree = doc.registerRoot("folder-tree");
  const createBtn = doc.registerRoot("create-playlist-btn");
  const filesEmpty = doc.registerRoot("files-empty");
  const filesEmptyLead = doc.registerRoot("files-empty-lead");

  const calls: Call[] = [];
  const leafCtx: LeafListContext[] = [];
  const leafTracks: SearchTrack[][] = [];
  const saved: { steps: NavStep[] } = { steps: [] };
  const rec = (name: string) => (...args: unknown[]) => void calls.push({ name, args });

  const songs: SearchTrack[] = [
    { path: "/m/a1.m4a", title: "A1", artist: "Alice", album: "Debut", albumArtist: null },
    // A compilation track: its album artist ("Various") differs from the track
    // artist, the case the go-to-album fix threads through end to end.
    { path: "/m/z1.m4a", title: "Z1", artist: "Zoe", album: "Split", albumArtist: "Various" },
  ];
  const artists: SearchArtist[] = [{ name: "Alice" }, { name: "Zoe" }];
  // Alice is the 90s ambient half of the fixture, Zoe the 2020s synthwave half —
  // so a genre and a decade each pick out exactly one of the two tracks, and
  // opening either lands on a list we can name.
  const genres = ["Ambient", "Synthwave"];
  const decades = [2020, 1990];
  const albums: SearchAlbum[] = [
    { album: "Debut", artist: "Alice" },
    { album: "Split", artist: "Various" },
  ];
  const playlists: PlaylistRef[] = [{ name: "Roadtrip", path: "/pl/roadtrip.m3u8" }];

  const deps: LibraryNavDeps = {
    listAllSongs: async () => songs,
    listAllArtists: async () => artists,
    listAllAlbums: async () => albums,
    playlistIndex: () => ({ loaded: true, items: playlists }),
    // Alice appears on her own "Debut" and on the "Various"-credited "Split".
    artistAlbums: async (artist) =>
      artist === "Alice"
        ? [
            { album: "Debut", artist: "Alice" },
            { album: "Split", artist: "Various" },
          ]
        : [{ album: "Split", artist: "Various" }],
    artistTracks: async () => [],
    albumTracks: async () => songs,
    listAllGenres: async () => genres,
    genreTracks: async (genre) =>
      songs.filter((t) => (genre === "Ambient" ? t.artist === "Alice" : t.artist === "Zoe")),
    listAllDecades: async () => decades,
    decadeTracks: async (decade) =>
      songs.filter((t) => (decade === 1990 ? t.album === "Debut" : t.album === "Split")),
    libraryEmpty: () => null,
    renderLeafTrackList: (tracks, ctx) => {
      leafCtx.push(ctx);
      leafTracks.push(tracks);
      return doc.createElement("div") as unknown as HTMLElement;
    },
    openPlaylist: rec("openPlaylist"),
    playPlaylist: rec("playPlaylist"),
    openPlaylistPath: () => null,
    playingPlaylistPath: () => null,
    showArtistMenu: rec("showArtistMenu"),
    showAlbumMenu: rec("showAlbumMenu"),
    showGenreMenu: rec("showGenreMenu"),
    showDecadeMenu: rec("showDecadeMenu"),
    showPlaylistMenu: rec("showPlaylistMenu"),
    startPlaylistRename: rec("startPlaylistRename"),
    persistLocation: (steps) => void (saved.steps = steps),
    setBrowseActive: () => {},
    markNavFocused: () => {},
    clearNavSelection: () => false,
    ...over,
  };

  initLibraryNav(deps, initial);
  return {
    container,
    folderTree,
    createBtn,
    filesEmpty,
    filesEmptyLead,
    calls,
    leafCtx,
    leafTracks,
    saved,
    deps,
  };
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
  // module's navigation stack so state can't leak between tests. Likewise drop the
  // memoized view lists, or a prior test's cached loader would satisfy this test's
  // open and its fresh loader would never run.
  installFakeDom();
  invalidateNavListCache();
  // The Artists/Albums views window their rows (see windowDrillRows), which needs
  // measured row heights the fake DOM has no layout to provide. Flip the same
  // escape hatch renderLeafTrackList uses so those views render every row eagerly,
  // letting the tests assert on real drill rows.
  (globalThis as { __noWindowing?: boolean }).__noWindowing = true;
});

// The get-started prompt covers both dead ends. A configured-but-empty root gets
// recovery copy; no root gets the library-setup copy. Both suppress the springboard,
// folder tree, and create button.
test("an empty library shows the get-started prompt, not an empty springboard", async () => {
  const { container, filesEmpty, filesEmptyLead, folderTree, createBtn } = setup({
    libraryEmpty: () => "empty",
  });
  await flush();
  assert.ok(!filesEmpty.classList.contains("hidden"), "prompt must show for an empty library");
  assert.match(filesEmptyLead.textContent, /No music in your library folder/);
  assert.equal(labels(container).length, 0, "springboard must not be built");
  assert.ok(folderTree.classList.contains("hidden"), "folder tree is a dead end here");
  assert.ok(createBtn.classList.contains("hidden"), "create button is a dead end here");
});

test("no library folder shows the concise setup prompt", async () => {
  const { container, filesEmpty, filesEmptyLead } = setup({ libraryEmpty: () => "no-root" });
  await flush();
  assert.ok(!filesEmpty.classList.contains("hidden"), "setup prompt must show");
  assert.equal(filesEmptyLead.textContent, "Add a library folder in");
  assert.equal(labels(container).length, 0, "springboard must not be built");
});

// The third state: mid-refresh nothing is known yet, and main.ts reports null so
// the prompt cannot flash over the tree's own "Loading...".
test("a library with content hides the prompt and builds the springboard", async () => {
  const { container, filesEmpty } = setup();
  await flush();
  assert.ok(filesEmpty.classList.contains("hidden"), "prompt must stay hidden");
  assert.deepEqual(labels(container).slice(0, 6), ["Browse", "Songs", "Artists", "Albums", "Genres", "Decades"]);
});

test("root menu lists the six views, then the cached playlist index", async () => {
  const { container, createBtn, folderTree } = setup();
  // The views render synchronously; playlists arrive after the load.
  assert.deepEqual(labels(container).slice(0, 6), ["Browse", "Songs", "Artists", "Albums", "Genres", "Decades"]);
  await flush();
  assert.ok(labels(container).includes("Roadtrip"), "playlist row never rendered");
  // At the root the create-playlist button shows and the folder tree is hidden.
  assert.ok(!createBtn.classList.contains("hidden"), "create button shows at root");
  assert.ok(folderTree.classList.contains("hidden"), "folder tree hidden outside Browse");
});

test("a view drills in (replace + back header); back returns to the root menu", async () => {
  const { container, createBtn } = setup();
  rowByLabel(container, "Songs").fire("click");
  await flush();

  assert.ok(hasBackHeader(container), "drilling a view must leave a back header");
  assert.ok(createBtn.classList.contains("hidden"), "create button hides while drilled");
  // The root menu's view rows are gone — the pane was replaced, not stacked.
  assert.ok(!labels(container).includes("Artists"), "root menu should be replaced");

  container.queryAll("nav-back")[0].fire("click");
  await flush();
  assert.ok(!hasBackHeader(container), "back should return to the root");
  assert.deepEqual(labels(container).slice(0, 6), ["Browse", "Songs", "Artists", "Albums", "Genres", "Decades"]);
  assert.ok(!createBtn.classList.contains("hidden"), "create button returns at root");
});

test("a playlist row OPENS RIGHT without drilling — the root menu stays put", async () => {
  const { container, calls } = setup();
  await flush();
  rowByLabel(container, "Roadtrip").fire("click");

  // openPlaylist fired with the file path...
  assert.deepEqual(
    calls.filter((c) => c.name === "openPlaylist"),
    [{ name: "openPlaylist", args: ["/pl/roadtrip.m3u8"] }],
  );
  // ...and, critically, we did NOT drill: no back header, root view rows still present.
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
  const menuCall = calls.at(-1)!;
  assert.equal(menuCall.name, "showPlaylistMenu");
  assert.deepEqual(menuCall.args.slice(0, 4), [12, 34, "/pl/roadtrip.m3u8", "Roadtrip"]);
  assert.equal(typeof menuCall.args[4], "function", "menu is handed a startRename callback");
});

test("Browse un-hides the folder tree; other views hide it", async () => {
  const { container, folderTree } = setup();
  rowByLabel(container, "Browse").fire("click");
  assert.ok(!folderTree.classList.contains("hidden"), "Browse must reveal the folder tree");

  popNavToRoot();
  rowByLabel(container, "Songs").fire("click");
  assert.ok(folderTree.classList.contains("hidden"), "non-Browse views hide the folder tree");
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
  assert.deepEqual(labels(container).slice(0, 6), ["Browse", "Songs", "Artists", "Albums", "Genres", "Decades"]);
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
  const { container, leafCtx, leafTracks } = setup();
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
  // The compilation's raw album artist must ride along on the leaf tracks, so a
  // later "go to album" from the now-playing line resolves the right key rather
  // than falling back to the (differing) track artist. See the go-to-album fix.
  const tracks = leafTracks.at(-1);
  const split = tracks?.find((t) => t.album === "Split");
  assert.ok(split, "album detail leaf list is missing the compilation track");
  assert.equal(split.albumArtist, "Various");
  popNavToRoot();
});

// Genres and Decades are filters, not hierarchies: opening one lands straight on
// its tracks rather than on an index of artists or albums. These two tests pin
// that shape and — the part that actually breaks things quietly — the pool key of
// the list it lands on, which must be the one the row's own Play verb uses
// (openGenreQueue / openDecadeQueue) or the two fork into separate pools.
test("a genre opens a flat track list under openGenreQueue's pool key", async () => {
  const { container, saved, leafCtx, leafTracks } = setup();
  rowByLabel(container, "Genres").fire("click");
  await flush();
  assert.deepEqual(labels(container), ["Ambient", "Synthwave"]);

  rowByLabel(container, "Ambient").fire("click");
  await flush();
  // A leaf list, not drill rows — and a back trail that remembers we came via Genres.
  assert.deepEqual(labels(container), [], "a genre must not index its artists");
  assert.deepEqual(saved.steps, [
    { t: "view", view: "genre" },
    { t: "genre", name: "Ambient" },
  ]);
  const ctx = leafCtx.at(-1);
  assert.equal(ctx?.syntheticPath, "queue:genre:Ambient");
  assert.equal(ctx?.title, "Ambient");
  assert.deepEqual(leafTracks.at(-1)?.map((t) => t.title), ["A1"]);
  popNavToRoot();
});

test("a decade is labelled '1990s' and opens a flat track list under its own pool key", async () => {
  const { container, saved, leafCtx, leafTracks } = setup();
  rowByLabel(container, "Decades").fire("click");
  await flush();
  // Newest first, as the backend returns them, and labelled — the step stores the
  // starting year, not the label.
  assert.deepEqual(labels(container), ["2020s", "1990s"]);

  rowByLabel(container, "2020s").fire("click");
  await flush();
  assert.deepEqual(labels(container), [], "a decade must not index its albums");
  assert.deepEqual(saved.steps, [
    { t: "view", view: "decade" },
    { t: "decade", decade: 2020 },
  ]);
  // The label is what the reader sees; the key carries the year, matching
  // openDecadeQueue.
  assert.equal(leafCtx.at(-1)?.syntheticPath, "queue:decade:2020");
  assert.equal(leafCtx.at(-1)?.title, "2020s");
  assert.deepEqual(leafTracks.at(-1)?.map((t) => t.title), ["Z1"]);
  popNavToRoot();
});

test("genre and decade rows raise their injected context menus", async () => {
  const { container, calls } = setup();
  rowByLabel(container, "Genres").fire("click");
  await flush();
  rowByLabel(container, "Ambient").fire("contextmenu", { clientX: 5, clientY: 6 });
  assert.deepEqual(calls.at(-1), { name: "showGenreMenu", args: [5, 6, "Ambient"] });

  popNavToRoot();
  rowByLabel(container, "Decades").fire("click");
  await flush();
  // The menu is handed the year, not the label — it queries the backend with it.
  rowByLabel(container, "1990s").fire("contextmenu", { clientX: 7, clientY: 8 });
  assert.deepEqual(calls.at(-1), { name: "showDecadeMenu", args: [7, 8, 1990] });
  popNavToRoot();
});

test("restores a persisted decade drill on init", async () => {
  const { container, leafCtx } = setup({}, [
    { t: "view", view: "decade" },
    { t: "decade", decade: 1990 },
  ]);
  await flush();
  assert.ok(hasBackHeader(container), "restore should rebuild the decade drill");
  // The back bar names where we are, by label rather than by stored year.
  assert.equal(container.queryAll("nav-back-title")[0]?.textContent, "1990s");
  assert.equal(leafCtx.at(-1)?.syntheticPath, "queue:decade:1990");
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
  resolveSongs([{ path: "/m/a1.m4a", title: "A1", artist: "Alice", album: "Debut", albumArtist: null }]);
  await flush();

  // The guard (host.isConnected) must skip fill: rendering into a detached host is
  // wasted work and would clobber the shared navLeafTracks for the list on screen.
  assert.equal(leafCtx.length, 0, "fill ran against a detached host");
});

test("a view list is memoized: re-opening Songs reuses the cache, invalidation reloads", async () => {
  let loads = 0;
  const fixture = setup({
    listAllSongs: async () => {
      loads++;
      return [{ path: "/m/a1.m4a", title: "A1", artist: "Alice", album: "Debut", albumArtist: null }];
    },
  });
  const { container } = fixture;

  // First open pays the load.
  rowByLabel(container, "Songs").fire("click");
  await flush();
  assert.equal(loads, 1, "first open loads from the backend");

  // Leave and re-open: the resolved list is served from the cache, no reload.
  popNavToRoot();
  rowByLabel(container, "Songs").fire("click");
  await flush();
  assert.equal(loads, 1, "repeat open is served from the cache");

  // A scan / edit drops the cache, so the next open re-fetches fresh membership.
  invalidateNavListCache();
  popNavToRoot();
  rowByLabel(container, "Songs").fire("click");
  await flush();
  assert.equal(loads, 2, "invalidation forces a reload on the next open");

  popNavToRoot(); // leave the shared module stack at root for the next test
});

test("refreshNavPlaylists reloads at the root, but is a no-op while drilled", async () => {
  let loads = 0;
  const fixture = setup({
    playlistIndex: () => {
      loads++;
      return { loaded: true, items: [{ name: "Roadtrip", path: "/pl/roadtrip.m3u8" }] };
    },
  });
  const { container } = fixture;
  await flush();
  assert.equal(loads, 1, "root menu reads the playlist index once on init");

  // Drilled into a view: the playlist list isn't shown, so a refresh must not
  // re-render (and re-load) it.
  rowByLabel(container, "Songs").fire("click");
  await flush();
  refreshNavPlaylists();
  await flush();
  assert.equal(loads, 1, "refresh while drilled should not re-read playlists");

  // Back at the root, a refresh re-renders and re-reads the index.
  popNavToRoot();
  refreshNavPlaylists();
  await flush();
  assert.equal(loads, 3, "back-to-root render (2) + explicit refresh (3) each re-read");
});

test("persists the current place on every navigation (root, view, deep drill)", async () => {
  const { container, saved } = setup();
  // The root menu persists as an empty stack (restores to the springboard).
  assert.deepEqual(saved.steps, []);

  rowByLabel(container, "Artists").fire("click");
  await flush();
  assert.deepEqual(saved.steps, [{ t: "view", view: "artist" }]);

  rowByLabel(container, "Alice").fire("click"); // -> artist detail
  await flush();
  assert.deepEqual(saved.steps, [
    { t: "view", view: "artist" },
    { t: "artist", name: "Alice" },
  ]);

  rowByLabel(container, "Split").fire("click"); // -> album detail (albumArtist "Various")
  await flush();
  assert.deepEqual(saved.steps, [
    { t: "view", view: "artist" },
    { t: "artist", name: "Alice" },
    { t: "album", album: "Split", albumArtist: "Various" },
  ]);

  // back() persists the shortened stack.
  container.queryAll("nav-back")[0].fire("click");
  await flush();
  assert.deepEqual(saved.steps, [
    { t: "view", view: "artist" },
    { t: "artist", name: "Alice" },
  ]);
  popNavToRoot();
});

test("restores a persisted deep drill on init (rebuilds the stack + back header)", async () => {
  const { container, leafCtx } = setup({}, [
    { t: "view", view: "album" },
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
  // First step isn't a view — a corrupt/stale store. Restore must discard it.
  const { container } = setup({}, [{ t: "artist", name: "Alice" }]);
  await flush();
  assert.ok(!hasBackHeader(container), "malformed location must not leave a broken stack");
  assert.deepEqual(labels(container).slice(0, 6), ["Browse", "Songs", "Artists", "Albums", "Genres", "Decades"]);
  popNavToRoot();
});
