// Library navigator: the left-pane browser that lives under the Files tab. Its
// home is an in-pane root menu listing the library lenses (Browse / Songs /
// Artists / Albums) *and*, below them, every playlist — Apple-Music-style
// sidebar shape.
//
// Two open behaviors, split by what the thing IS:
//   - Lenses are read-only views of the library, so they DRILL LEFT (Replace +
//     back): artist → album → tracks, iPod-style, replacing the pane and leaving a
//     thin back header. Browse drills to the real folder tree.
//   - Playlists are editable documents, so they OPEN RIGHT (deps.openPlaylist →
//     the right-pane list face) WITHOUT drilling. The root menu stays put, so you
//     can then drill a lens on the left and drag its tracks onto the open playlist.
//     That left-source + right-target split is the whole editing workflow. See
//     plan.md and the design discussion.

import type {
  SearchTrack,
  SearchArtist,
  SearchAlbum,
  PlaylistRef,
  LeafListContext,
} from "./types";
import { h } from "./dom";
import { windowedList } from "./windowed-list";

type IconKind = "browse" | "songs" | "playlist" | "artist" | "album";

// The library lenses — the read-only views that drill left. Playlists are NOT a
// lens (they're editable documents that open right), so they're absent here and
// listed as their own root-menu section instead.
export type Lens = "browse" | "songs" | "artist" | "album";
const DRILL_LENSES: Lens[] = ["browse", "songs", "artist", "album"];

// A serializable description of one level in the drill stack, so the user's place
// in the Files tab survives an app restart. The bottom step is always a lens; the
// drill-downs above it are the artist/album we descended into. Rebuilt into live
// Views by restoreLocation, persisted by deps.persistLocation on every nav change.
export type NavStep =
  | { t: "lens"; lens: Lens }
  | { t: "artist"; name: string }
  | { t: "album"; album: string; albumArtist: string };
const LENS_LABEL: Record<Lens, string> = {
  browse: "Browse",
  songs: "Songs",
  artist: "Artists",
  album: "Albums",
};

// The bits of the app the navigator borrows: backend loaders, the shared leaf-row
// list builder, the artist/album/playlist row context menus, and the play/open
// paths for playlists. Injected (not imported) so this module never has to import
// back into the main entry module — see initLibraryNav's call site.
export interface LibraryNavDeps {
  listAllSongs: () => Promise<SearchTrack[]>;
  listAllArtists: () => Promise<SearchArtist[]>;
  listAllAlbums: () => Promise<SearchAlbum[]>;
  // The current playlist index, read synchronously from the in-memory cache
  // (app.playlistIndex) — NOT a per-render filesystem walk. `loaded` is false until
  // the first walk lands so the root menu can show "Loading…" rather than a false
  // "No playlists yet". refreshNavPlaylists() re-renders the root when the cache
  // updates (fs watcher / our own writes), keeping this in step.
  playlistIndex: () => { loaded: boolean; items: PlaylistRef[] };
  artistAlbums: (artist: string) => Promise<SearchAlbum[]>;
  // Every track by an artist, ordered album by album — backs the "Tracks" section
  // of the artist-detail view (a flat list of the artist's whole catalog).
  artistTracks: (artist: string) => Promise<SearchTrack[]>;
  albumTracks: (album: string, albumArtist: string) => Promise<SearchTrack[]>;
  renderLeafTrackList: (tracks: SearchTrack[], ctx: LeafListContext) => HTMLElement;
  // A playlist row: single-click opens it in the right pane (the editable target),
  // double-click plays it. Both reuse the app's existing playlist paths.
  openPlaylist: (path: string) => void;
  playPlaylist: (path: string) => void;
  // Right-click menus for the Artists / Albums / Playlists rows. main.ts owns the
  // menu construction (Play / Add to queue / Add to playlist), the navigator only
  // supplies the click coordinates and the artist/album/playlist identity.
  showArtistMenu: (x: number, y: number, name: string) => void;
  showAlbumMenu: (x: number, y: number, album: string, albumArtist: string) => void;
  showPlaylistMenu: (x: number, y: number, path: string) => void;
  // Persist the user's current place in the Files tab (the serialized drill stack)
  // so it can be restored on the next launch. Fire-and-forget; called on every
  // navigation change from render().
  persistLocation: (steps: NavStep[]) => void;
  // Whether a library folder has been configured. When false the panel shows a
  // get-started prompt (#files-empty) instead of the lens springboard; main.ts
  // re-renders (renderNav) whenever this flips.
  libraryRootSet: () => boolean;
  // Tell the Browse folder tree whether it's the active lens. The tree defers its
  // (costly) DOM build while hidden, so entering Browse flushes any pending build.
  // Injected rather than imported so this module never pulls in tree-view/main.
  setBrowseActive: (active: boolean) => void;
}

let deps: LibraryNavDeps;

// A view is a title (for the back header) and a body-builder. The stack gives us
// Replace + back: an empty stack is the root menu; push replaces the visible body
// and back() pops. The bottom view (stack[0]) carries its `lens` tag so we can name
// the current lens and reveal the folder tree only inside Browse.
interface View {
  title: string;
  build: () => HTMLElement;
  lens?: Lens;
  // The serializable identity of this drill level (see NavStep). Present on every
  // view that lives in the stack; the root menu (never stacked) has none.
  step?: NavStep;
}

let container: HTMLElement;
let folderTree: HTMLElement;
let createBtn: HTMLElement;
let filesEmpty: HTMLElement;
const stack: View[] = [];
// Set for a single navigateTo when the caller wants the landing detail's Back-bar
// title to flash — the "here it is" cue for album/artist search hits, which (unlike
// a browsed-to track) have no persistent row highlight to say where you arrived.
// Consumed and cleared by the next render() so unrelated renders (push/back) don't
// re-flash a stale title.
let pendingFlashTitle = false;

function list(): HTMLElement {
  return h("div", { class: "nav-list" });
}

// ---- lens list cache -------------------------------------------------------

// Memoize the resolved lens lists (Songs / Artists / Albums and the artist/album
// detail loads) so repeat opens are instant: the O(N) whole-library loads
// (list_all_songs et al.) only pay their invoke + IPC + parse cost once per scan.
// First open is unchanged (a cache miss), and the full resolved array is preserved
// verbatim — playing a leaf row still builds its pool from the whole list, so the
// playback-pool model is untouched.
//
// We cache the Promise, not the resolved array, so concurrent opens of the same
// lens share one in-flight load, and a resolved entry replays with no visible
// "Loading…" flash (asyncListBody's host is still connected on the next microtask).
// Playlists are deliberately absent — they aren't a lens and have their own
// refreshNavPlaylists cache path.
//
// Correctness hinges on invalidation covering BOTH ways the library changes under
// us, or a stale list flashes: background scans (library-scanned → main.ts calls
// invalidateNavListCache) and explicit metadata edits (editors.ts → reloadNavView).
// See invalidateNavListCache.
const listCache = new Map<string, Promise<unknown>>();

function cached<T>(key: string, load: () => Promise<T[]>): Promise<T[]> {
  const hit = listCache.get(key) as Promise<T[]> | undefined;
  if (hit) return hit;
  const p = load().catch((e) => {
    // Don't cache failures — a transient load error shouldn't stick until the next
    // scan/edit; drop the entry so the next open retries.
    listCache.delete(key);
    throw e;
  });
  listCache.set(key, p);
  return p;
}

// Drop every memoized lens list. Called whenever the library changes on disk (scan)
// or via an edit, so the next open re-fetches. Clearing wholesale is intentional: a
// scan can touch any lens, and the lists are cheap to rebuild lazily on next open.
export function invalidateNavListCache(): void {
  listCache.clear();
}

// ---- navigation entry points -----------------------------------------------

// Active-tab accelerator (iOS-style "tap the active tab to pop home"): pop any
// drill-down back to the root menu. Called by the tab switcher when the Files
// tab is clicked while already active; a no-op when already at the root.
export function popNavToRoot(): void {
  if (stack.length === 0) return;
  stack.length = 0;
  render();
}

// Drill into a lens from the root: the lens becomes the bottom of a fresh stack.
function enterLens(lens: Lens): void {
  stack.length = 0;
  stack.push(lensView(lens));
  render();
}

// Jump straight to a drill location from outside (the "Go to artist/album"
// verbs on track menus and search hits). Rebuilds the stack from `steps` — the
// same mechanism restoreLocation uses on launch — so the steps also set the back
// trail: [Artists, artist] lands on the artist detail with Back → Artists. The
// caller is responsible for making the Files tab active first.
export function navigateTo(steps: NavStep[], opts?: { flashTitle?: boolean }): void {
  restoreLocation(steps);
  pendingFlashTitle = opts?.flashTitle ?? false;
  render();
}

// The current drill location (top of the stack), or null at the root menu. Lets
// a track menu hide a "Go to artist/album" that would just re-open the view it's
// already sitting in (the artist/album detail lists its own tracks).
export function currentNavStep(): NavStep | null {
  return stack.length === 0 ? null : (stack[stack.length - 1].step ?? null);
}

// ---- views -----------------------------------------------------------------

// The lens's drill view. Browse's body is empty — render() un-hides the real
// #folder-tree when Browse is the current view; the others build their own bodies.
function lensView(lens: Lens): View {
  let base: View;
  switch (lens) {
    case "browse":
      base = { title: "Browse", build: () => list() };
      break;
    case "songs":
      base = songsView();
      break;
    case "artist":
      base = artistsView();
      break;
    case "album":
      base = albumsView();
      break;
  }
  base.lens = lens;
  base.step = { t: "lens", lens };
  return base;
}

// The root menu: the library lenses as drill rows, then a Playlists section
// listing every playlist. Lens rows drill left; playlist rows open right (single
// click) / play (double click) and never disturb this menu, so it stays as the
// springboard for the edit workflow.
function rootMenuView(): View {
  return { title: "Files", build: rootMenuBody };
}

function rootMenuBody(): HTMLElement {
  const host = list();
  for (const lens of DRILL_LENSES) {
    host.appendChild(
      drillRow({
        icon: lens,
        primary: LENS_LABEL[lens],
        onOpen: () => enterLens(lens),
      }),
    );
  }

  host.appendChild(h("div", { class: "nav-section", text: "Playlists" }));

  // Playlist rows are built synchronously from the in-memory index (no per-render
  // filesystem walk — that walk froze the UI for ~1s on large libraries). The cache
  // is kept fresh by refreshPlaylistIndex (fs watcher + our own writes), which calls
  // refreshNavPlaylists() to re-render this root when it changes. Until the first
  // walk lands, show "Loading…" rather than a false "No playlists yet".
  const plHost = list();
  const { loaded, items } = deps.playlistIndex();
  if (!loaded) {
    plHost.appendChild(h("div", { class: "nav-placeholder-row", text: "Loading…" }));
  } else if (items.length === 0) {
    plHost.appendChild(h("div", { class: "nav-placeholder-row", text: "No playlists yet" }));
  } else {
    for (const p of items) {
      plHost.appendChild(
        drillRow({
          icon: "playlist",
          primary: p.name,
          onOpen: () => deps.openPlaylist(p.path),
          onPlay: () => deps.playPlaylist(p.path),
          onMenu: (x, y) => deps.showPlaylistMenu(x, y, p.path),
        }),
      );
    }
  }
  host.appendChild(plHost);
  return host;
}

// A list body that loads asynchronously. build() must return synchronously, so
// this shows a "Loading…" line at once and swaps in the real rows (or an empty /
// error line) when `load` resolves. Every drill view — Songs, Artists, artist and
// album detail — shares this shell so loading / empty / failure handling lives in
// one place. `fill` receives the resolved items and the host to append rows to
// (the loading line is cleared first).
function asyncListBody<T>(opts: {
  load: () => Promise<T[]>;
  empty: string;
  errorLabel: string;
  fill: (items: T[], host: HTMLElement) => void;
}): HTMLElement {
  const host = list();
  const loading = h("div", { class: "nav-coming-soon", text: "Loading…" });
  host.appendChild(loading);
  opts
    .load()
    .then((items) => {
      // A navigation before this load resolved detached our host (render's
      // replaceChildren). Bail: filling a superseded list is wasted DOM work, and
      // for leaf lists it would clobber the shared navLeafTracks the selection
      // painter maps rows through — mismatching the list actually on screen.
      if (!host.isConnected) return;
      if (items.length === 0) {
        loading.textContent = opts.empty;
        return;
      }
      host.replaceChildren();
      opts.fill(items, host);
    })
    .catch((e) => {
      if (!host.isConnected) return;
      console.error(opts.errorLabel, e);
      loading.textContent = "Couldn't load";
    });
  return host;
}

// A drill-down row (a lens, an artist, an album, or a playlist): a gutter icon, a
// primary label, an optional dimmed inline suffix, and a hover highlight. Left-click
// drills / opens via `onOpen`; double-click plays via `onPlay` (playlists only);
// right-click raises the injected context menu via `onMenu`.
function drillRow(opts: {
  icon: IconKind;
  primary: string;
  // An optional subtitle (e.g. an album's artist) shown inline after the primary,
  // dimmed and after a separator (see .nav-secondary). Every row is a single line
  // whether or not this is present, so the windowed lenses (Artists/Albums) keep the
  // uniform row height they position by — no blank line needs reserving.
  secondary?: string;
  onOpen: () => void;
  onPlay?: () => void;
  onMenu?: (x: number, y: number) => void;
}): HTMLElement {
  const cell = h(
    "span",
    { class: "nav-cell" },
    h("span", { class: "nav-primary", text: opts.primary }),
    opts.secondary && h("span", { class: "nav-secondary", text: opts.secondary }),
  );
  const row = h(
    "div",
    { class: "nav-row" },
    h("span", { class: `nav-icon nav-${opts.icon}` }),
    cell,
  );
  row.addEventListener("click", opts.onOpen);
  if (opts.onPlay) row.addEventListener("dblclick", opts.onPlay);
  if (opts.onMenu) {
    row.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      opts.onMenu?.(e.clientX, e.clientY);
    });
  }
  return row;
}

// Window a whole-library drill list (Artists / Albums) the way renderLeafTrackList
// windows Songs: mount only the on-screen row slice over a full-height spacer. The
// asymmetry this fixes — entering was "instant" (the eager per-item build ran
// behind asyncListBody's "Loading…" line, read as loading) but Back froze for ~1s,
// because render()'s container.replaceChildren() had to tear down one .nav-row per
// artist/album synchronously in the click handler. A screenful of nodes builds and
// tears down cheaply on both sides. Rows must be uniform height (the window places
// row i at i * rowHeight); the single-line drillRow is uniform by construction —
// its optional subtitle sits inline, so a row with one is no taller than a row
// without (see drillRow / .nav-secondary). The artist/album *detail* views aren't
// windowed here — one artist's albums is a short list, and their Tracks section is
// already a windowed leaf list, so windowing the small album section would only add
// a second window fighting for the same scroll pane.
function windowDrillRows<T>(
  items: T[],
  host: HTMLElement,
  makeRow: (item: T) => HTMLElement,
): void {
  // Same debug/test escape hatch renderLeafTrackList uses: render every row eagerly
  // when `__noWindowing` is set. The fake-DOM unit tests set it so they can assert on
  // real drill rows without faking layout (windowing needs measured row heights);
  // the console A/B toggle uses it to compare against the pre-windowing path.
  if ((globalThis as { __noWindowing?: boolean }).__noWindowing) {
    for (const item of items) host.appendChild(makeRow(item));
    return;
  }

  const win = windowedList({
    count: items.length,
    renderRow: (i) => makeRow(items[i]),
  });
  win.el.classList.add("nav-window");
  host.appendChild(win.el);
}

// Songs: the whole library as one flat, playable list through the shared leaf-row
// builder. Each row plays the list as a queue from that track (see
// renderLeafTrackList's play semantics). The list is windowed (renderLeafTrackList
// mounts only the on-screen row slice), so the whole library stays cheap to scroll.
function songsView(): View {
  return {
    title: "Songs",
    build: () =>
      asyncListBody<SearchTrack>({
        load: () => cached("songs", deps.listAllSongs),
        empty: "No songs in the library",
        errorLabel: "list_all_songs failed",
        fill: (tracks, host) => {
          host.appendChild(
            deps.renderLeafTrackList(tracks, {
              title: "Songs",
              syntheticPath: "queue:songs",
              // Songs is the flat "just play a track" list — if you're here you've
              // already passed over the Albums lens, so drop the per-row album and
              // show only title · artist, keeping the rows uncluttered.
              hideAlbum: true,
            }),
          );
        },
      }),
  };
}

// Artists: the library's distinct artists as drill rows. Opening one pushes the
// artist detail (their albums); right-click plays / queues the whole artist through
// the injected menu. Windowed (see windowDrillRows) so a whole-library artist list
// stays a screenful of DOM — building and, crucially, tearing down on Back are both
// cheap.
function artistsView(): View {
  return {
    title: "Artists",
    build: () =>
      asyncListBody<SearchArtist>({
        load: () => cached("artists", deps.listAllArtists),
        empty: "No artists in the library",
        errorLabel: "list_all_artists failed",
        fill: (artists, host) => {
          windowDrillRows(artists, host, (a) =>
            drillRow({
              icon: "artist",
              primary: a.name,
              onOpen: () => push(artistDetailView(a.name)),
              onMenu: (x, y) => deps.showArtistMenu(x, y, a.name),
            }),
          );
        },
      }),
  };
}

// Artist detail: the artist's albums as drill rows under an "Albums" section
// header, then every track by the artist as a flat playable leaf list under a
// "Tracks" header. The section headers match the Files panel elsewhere. Opening an
// album pushes the album detail (its tracks); right-click plays / queues the album.
// The album carries its own album-artist key (from artist_albums), so a compilation
// this artist merely appears on drills through correctly. The Tracks list is the
// artist's whole catalog (in-album songs included), so it deliberately overlaps the
// albums above — a scannable "play any song without drilling" view.
function artistDetailView(name: string): View {
  // Load albums and the flat track list together so the shared loading / empty /
  // error shell still applies, then render each under its own section header.
  type Detail = { albums: SearchAlbum[]; tracks: SearchTrack[] };
  return {
    title: name,
    step: { t: "artist", name },
    build: () =>
      asyncListBody<Detail>({
        load: async () => {
          const [albums, tracks] = await Promise.all([
            cached(`artistAlbums\0${name}`, () => deps.artistAlbums(name)),
            cached(`artistTracks\0${name}`, () => deps.artistTracks(name)),
          ]);
          // Single-element list: the shell treats an empty array as "empty", so
          // return nothing when the artist has neither albums nor tracks.
          return albums.length || tracks.length ? [{ albums, tracks }] : [];
        },
        empty: "No tracks",
        errorLabel: "artist detail load failed",
        fill: ([detail], host) => {
          if (detail.albums.length) {
            host.appendChild(h("div", { class: "nav-section", text: "Albums" }));
            for (const al of detail.albums) {
              host.appendChild(
                drillRow({
                  icon: "album",
                  primary: al.album,
                  // Show the album artist only when it differs from the artist we
                  // drilled from — e.g. a compilation credited to someone else.
                  secondary:
                    al.artist && al.artist !== name ? al.artist : undefined,
                  onOpen: () => push(albumDetailView(al.album, al.artist)),
                  onMenu: (x, y) => deps.showAlbumMenu(x, y, al.album, al.artist),
                }),
              );
            }
          }
          if (detail.tracks.length) {
            host.appendChild(h("div", { class: "nav-section", text: "Tracks" }));
            host.appendChild(
              deps.renderLeafTrackList(detail.tracks, {
                title: name,
                syntheticPath: `queue:artist:${name}`,
                // The album is redundant here: the Albums section above enumerates
                // them and this list is ordered album by album, so the tag would
                // just repeat in runs. Leave bare titles.
                hideAlbum: true,
              }),
            );
          }
        },
      }),
  };
}

// Albums: the library's distinct albums as drill rows, each grouped by
// ALBUM_ARTIST_EXPR so its album-artist key matches album_tracks / openAlbumQueue.
// Opening one pushes the same album detail the Artists lens uses (albumDetailView);
// right-click plays / queues the whole album through the injected menu. Windowed
// like the Artists lens (see windowDrillRows); rows reserve the album-artist line so
// they stay uniform height for the window.
function albumsView(): View {
  return {
    title: "Albums",
    build: () =>
      asyncListBody<SearchAlbum>({
        load: () => cached("albums", deps.listAllAlbums),
        empty: "No albums in the library",
        errorLabel: "list_all_albums failed",
        fill: (albums, host) => {
          windowDrillRows(albums, host, (al) =>
            drillRow({
              icon: "album",
              primary: al.album,
              secondary: al.artist || undefined,
              onOpen: () => push(albumDetailView(al.album, al.artist)),
              onMenu: (x, y) => deps.showAlbumMenu(x, y, al.album, al.artist),
            }),
          );
        },
      }),
  };
}

// Album detail: the album's tracks through the shared leaf-row list, so play /
// queue / select / context / drag all behave as everywhere else. The synthetic pool
// path mirrors openAlbumQueue's key (albumArtist NUL album) so playing a row here
// plays the album in context, under the same pool identity as Play album.
function albumDetailView(album: string, albumArtist: string): View {
  return {
    title: album,
    step: { t: "album", album, albumArtist },
    build: () =>
      asyncListBody<SearchTrack>({
        load: () =>
          cached(`albumTracks\0${albumArtist}\0${album}`, () =>
            deps.albumTracks(album, albumArtist),
          ),
        empty: "No tracks",
        errorLabel: "album_tracks failed",
        fill: (tracks, host) => {
          host.appendChild(
            deps.renderLeafTrackList(tracks, {
              title: album,
              syntheticPath: `queue:album:${albumArtist}\0${album}`,
            }),
          );
        },
      }),
  };
}

// ---- render / navigation ---------------------------------------------------

// Drill in: replace the visible body with `view` and leave a back header to
// return. The stack is the Replace + back history (see back()).
function push(view: View): void {
  stack.push(view);
  render();
}

function back(): void {
  stack.pop();
  render();
}

// Re-render just the root menu when the playlist index changes (fs watcher / our
// own writes) — that's the only place the playlist list is shown, so there's
// nothing to refresh while drilled into a lens.
export function refreshNavPlaylists(): void {
  if (stack.length === 0) render();
}

// Force a re-render from outside — main.ts calls this when the library-root-set
// state flips so render() can swap between the get-started prompt and the lenses.
export function renderNav(): void {
  render();
}

// Reload the current drill view from the backend — main.ts calls this after a
// metadata edit. Rebuilding re-runs the view's load(), so a track edited out of
// this album/artist drops away and the list re-sorts (membership here is derived
// from the tags just written). Scroll resets, which reads as intentional since
// the list's contents changed. A no-op-ish refresh at the root (Browse/tree self-
// refresh by other means) but harmless.
export function reloadNavView(): void {
  // An edit rewrote tags, so every memoized lens list is potentially stale (a track
  // may have moved artist/album, or its title changed). Drop the cache before
  // re-rendering so the rebuilt view re-fetches fresh membership.
  invalidateNavListCache();
  render();
}

// A background library scan finished and changed what's on disk: reflect it in the
// open lens/detail view so the user doesn't have to leave and re-enter to see new
// tracks. The Browse tree refreshes itself (refreshLibrary → renderTree), so skip it
// here. Unlike reloadNavView (an explicit edit, where a scroll reset reads as
// intentional), this is an unprompted background event, so the scroll position is
// preserved — a scan completing shouldn't yank the user back to the top. The current
// view reloads asynchronously and its windowed leaf list sizes its full-height spacer
// a frame later, so the restore is retried briefly until the content is tall enough
// to hold the saved offset (we can't hook the async fill from out here).
export function refreshNavViewAfterScan(): void {
  const top = stack[stack.length - 1];
  if (top?.lens === "browse") return;
  const scroller = document.getElementById("tab-files") as HTMLElement | null;
  const savedTop = scroller?.scrollTop ?? 0;
  render();
  if (!scroller || savedTop <= 0) return;
  let tries = 0;
  const restore = (): void => {
    if (!scroller.isConnected) return;
    const max = scroller.scrollHeight - scroller.clientHeight;
    scroller.scrollTop = Math.min(savedTop, max);
    // Keep chasing while the list is still shorter than the saved offset (its rows
    // are still loading / the spacer isn't sized yet); bounded so a genuinely
    // shorter list doesn't spin forever.
    if (max < savedTop && tries++ < 60) requestAnimationFrame(restore);
  };
  requestAnimationFrame(restore);
}

function render(): void {
  container.replaceChildren();

  // No library folder yet: the whole panel is a get-started prompt. Every lens
  // and the folder tree would be dead ends, so hide them and bail before the
  // springboard is built.
  const hasRoot = deps.libraryRootSet();
  filesEmpty.classList.toggle("hidden", hasRoot);
  if (!hasRoot) {
    folderTree.classList.add("hidden");
    createBtn.classList.add("hidden");
    return;
  }

  // Consume the one-shot flash request up front so it fires for this render only,
  // whatever branch we take below (including the early root return that has no header).
  const flashTitle = pendingFlashTitle;
  pendingFlashTitle = false;

  const atRoot = stack.length === 0;
  const top = atRoot ? null : stack[stack.length - 1];
  const inBrowse = top?.lens === "browse";

  // The real folder tree belongs to the Browse lens; the create-playlist button
  // lives with the root menu's Playlists section. Entering Browse also flushes any
  // tree DOM build deferred while it was hidden (see tree-view's renderTree).
  folderTree.classList.toggle("hidden", !inBrowse);
  deps.setBrowseActive(inBrowse);
  createBtn.classList.toggle("hidden", !atRoot);

  if (!atRoot && top) {
    // iPod-style: the bar carries the current location (not the word "Back") and
    // the whole strip is the up-one-level control.
    const title = h("span", { class: "nav-back-title", text: top.title });
    const header = h(
      "button",
      { class: "nav-back", attrs: { type: "button" }, on: { click: back } },
      h("span", { class: "nav-back-chev", text: "‹" }),
      title,
    );
    container.appendChild(header);
    // One-shot flash to mark where a search hit landed (see pendingFlashTitle). Washes
    // the whole Back bar; the class is dropped on animationend so a later re-render of
    // the same view is clean.
    if (flashTitle) {
      header.classList.add("flash");
      header.addEventListener("animationend", () => header.classList.remove("flash"), {
        once: true,
      });
    }
  }

  const view = atRoot ? rootMenuView() : top!;
  container.appendChild(view.build());

  // render() is the single choke point every navigation flows through (enterLens,
  // push, back, popNavToRoot), so persist the current place here. An empty stack
  // (root menu) persists as [], which restores to the springboard.
  deps.persistLocation(stack.map((v) => v.step).filter((s): s is NavStep => s != null));
}

// Rebuild the drill stack from a persisted location. The bottom step must be a
// lens for the stack to be well-formed; anything else (a corrupt or stale store)
// is discarded, leaving the root menu. Does not render — the caller renders once.
function restoreLocation(steps: NavStep[]): void {
  stack.length = 0;
  if (steps.length === 0 || steps[0].t !== "lens") return;
  for (const step of steps) {
    switch (step.t) {
      case "lens":
        stack.push(lensView(step.lens));
        break;
      case "artist":
        stack.push(artistDetailView(step.name));
        break;
      case "album":
        stack.push(albumDetailView(step.album, step.albumArtist));
        break;
    }
  }
}

// Wire the navigator into the live Files pane. Renders the root menu and hooks the
// active-tab accelerator (tap the active Files tab to pop home).
export function initLibraryNav(d: LibraryNavDeps, initial?: NavStep[]): void {
  deps = d;
  container = document.getElementById("library-nav") as HTMLElement;
  folderTree = document.getElementById("folder-tree") as HTMLElement;
  createBtn = document.getElementById("create-playlist-btn") as HTMLElement;
  filesEmpty = document.getElementById("files-empty") as HTMLElement;

  // Restore the last place (empty / malformed → root menu), then render once.
  if (initial) restoreLocation(initial);
  render();
}
