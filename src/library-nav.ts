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
} from "./main";

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
  listAllPlaylists: () => Promise<PlaylistRef[]>;
  artistAlbums: (artist: string) => Promise<SearchAlbum[]>;
  // Tracks by an artist that belong to no album — listed under the albums in the
  // artist-detail view so loose singles aren't stranded.
  artistAlbumlessTracks: (artist: string) => Promise<SearchTrack[]>;
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
let footer: HTMLElement;
let folderTree: HTMLElement;
let createBtn: HTMLElement;
let filesEmpty: HTMLElement;
const stack: View[] = [];

function list(): HTMLElement {
  const ul = document.createElement("div");
  ul.className = "nav-list";
  return ul;
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

  const header = document.createElement("div");
  header.className = "nav-section";
  header.textContent = "Playlists";
  host.appendChild(header);

  // Playlists load asynchronously; show a placeholder line and swap in the rows.
  const plHost = list();
  const loading = document.createElement("div");
  loading.className = "nav-coming-soon";
  loading.textContent = "Loading…";
  plHost.appendChild(loading);
  host.appendChild(plHost);
  deps
    .listAllPlaylists()
    .then((playlists) => {
      plHost.replaceChildren();
      if (playlists.length === 0) {
        const empty = document.createElement("div");
        empty.className = "nav-coming-soon";
        empty.textContent = "No playlists yet";
        plHost.appendChild(empty);
        return;
      }
      for (const p of playlists) {
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
    })
    .catch((e) => {
      console.error("list_all_playlists failed", e);
      loading.textContent = "Couldn't load playlists";
    });
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
  const loading = document.createElement("div");
  loading.className = "nav-coming-soon";
  loading.textContent = "Loading…";
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
// primary label, an optional secondary line, and a hover highlight. Left-click
// drills / opens via `onOpen`; double-click plays via `onPlay` (playlists only);
// right-click raises the injected context menu via `onMenu`.
function drillRow(opts: {
  icon: IconKind;
  primary: string;
  secondary?: string;
  onOpen: () => void;
  onPlay?: () => void;
  onMenu?: (x: number, y: number) => void;
}): HTMLElement {
  const row = document.createElement("div");
  row.className = "nav-row";
  const icon = document.createElement("span");
  icon.className = `nav-icon nav-${opts.icon}`;
  const cell = document.createElement("span");
  cell.className = "nav-cell";
  const primary = document.createElement("span");
  primary.className = "nav-primary";
  primary.textContent = opts.primary;
  cell.appendChild(primary);
  if (opts.secondary) {
    const secondary = document.createElement("span");
    secondary.className = "nav-secondary";
    secondary.textContent = opts.secondary;
    cell.appendChild(secondary);
  }
  row.append(icon, cell);
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

// Songs: the whole library as one flat, playable list through the shared leaf-row
// builder. Each row plays the list as a queue from that track (see
// renderLeafTrackList's play semantics). Virtualization for very large libraries is
// deferred to Phase 7.
function songsView(): View {
  return {
    title: "Songs",
    build: () =>
      asyncListBody<SearchTrack>({
        load: deps.listAllSongs,
        empty: "No songs in the library",
        errorLabel: "list_all_songs failed",
        fill: (tracks, host) => {
          host.appendChild(
            deps.renderLeafTrackList(tracks, {
              title: "Songs",
              syntheticPath: "queue:songs",
            }),
          );
        },
      }),
  };
}

// Artists: the library's distinct artists as drill rows. Opening one pushes the
// artist detail (their albums); right-click plays / queues the whole artist through
// the injected menu.
function artistsView(): View {
  return {
    title: "Artists",
    build: () =>
      asyncListBody<SearchArtist>({
        load: deps.listAllArtists,
        empty: "No artists in the library",
        errorLabel: "list_all_artists failed",
        fill: (artists, host) => {
          for (const a of artists) {
            host.appendChild(
              drillRow({
                icon: "artist",
                primary: a.name,
                onOpen: () => push(artistDetailView(a.name)),
                onMenu: (x, y) => deps.showArtistMenu(x, y, a.name),
              }),
            );
          }
        },
      }),
  };
}

// Artist detail: the albums that contain a track by this artist as drill rows,
// followed by any albumless tracks by this artist as a playable leaf list — so an
// artist's loose singles aren't stranded (artist_albums drops them). Opening an
// album pushes the album detail (its tracks); right-click plays / queues the
// album. The album carries its own album-artist key (from artist_albums), so a
// compilation this artist merely appears on drills through correctly.
function artistDetailView(name: string): View {
  // One heterogeneous list so the shared loading / empty / error shell still
  // applies: album drill rows first, then a single leaf list of loose tracks.
  type Entry =
    | { kind: "album"; album: SearchAlbum }
    | { kind: "loose"; tracks: SearchTrack[] };
  return {
    title: name,
    step: { t: "artist", name },
    build: () =>
      asyncListBody<Entry>({
        load: async () => {
          const [albums, loose] = await Promise.all([
            deps.artistAlbums(name),
            deps.artistAlbumlessTracks(name),
          ]);
          const entries: Entry[] = albums.map((album) => ({ kind: "album", album }));
          if (loose.length) entries.push({ kind: "loose", tracks: loose });
          return entries;
        },
        empty: "No tracks",
        errorLabel: "artist detail load failed",
        fill: (entries, host) => {
          for (const entry of entries) {
            if (entry.kind === "album") {
              const al = entry.album;
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
            } else {
              // Loose tracks fall below the albums as a plain leaf list; the row
              // icons distinguish them, so no section label is needed.
              host.appendChild(
                deps.renderLeafTrackList(entry.tracks, {
                  title: name,
                  syntheticPath: `queue:artist-loose:${name}`,
                }),
              );
            }
          }
        },
      }),
  };
}

// Albums: the library's distinct albums as drill rows, each grouped by
// ALBUM_ARTIST_EXPR so its album-artist key matches album_tracks / openAlbumQueue.
// Opening one pushes the same album detail the Artists lens uses (albumDetailView);
// right-click plays / queues the whole album through the injected menu.
function albumsView(): View {
  return {
    title: "Albums",
    build: () =>
      asyncListBody<SearchAlbum>({
        load: deps.listAllAlbums,
        empty: "No albums in the library",
        errorLabel: "list_all_albums failed",
        fill: (albums, host) => {
          for (const al of albums) {
            host.appendChild(
              drillRow({
                icon: "album",
                primary: al.album,
                secondary: al.artist || undefined,
                onOpen: () => push(albumDetailView(al.album, al.artist)),
                onMenu: (x, y) => deps.showAlbumMenu(x, y, al.album, al.artist),
              }),
            );
          }
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
        load: () => deps.albumTracks(album, albumArtist),
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

function render(): void {
  container.replaceChildren();
  footer.replaceChildren();

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

  const atRoot = stack.length === 0;
  const top = atRoot ? null : stack[stack.length - 1];
  const inBrowse = top?.lens === "browse";

  // The real folder tree belongs to the Browse lens; the create-playlist button
  // lives with the root menu's Playlists section.
  folderTree.classList.toggle("hidden", !inBrowse);
  createBtn.classList.toggle("hidden", !atRoot);

  if (!atRoot && top) {
    const header = document.createElement("button");
    header.type = "button";
    header.className = "nav-back";
    const chev = document.createElement("span");
    chev.className = "nav-back-chev";
    chev.textContent = "‹";
    // iPod-style: the bar carries the current location (not the word "Back") and
    // the whole strip is the up-one-level control.
    const label = document.createElement("span");
    label.className = "nav-back-title";
    label.textContent = top.title;
    header.append(chev, label);
    header.addEventListener("click", back);
    container.appendChild(header);
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
  footer = document.getElementById("lens-footer") as HTMLElement;
  folderTree = document.getElementById("folder-tree") as HTMLElement;
  createBtn = document.getElementById("create-playlist-btn") as HTMLElement;
  filesEmpty = document.getElementById("files-empty") as HTMLElement;

  // Restore the last place (empty / malformed → root menu), then render once.
  if (initial) restoreLocation(initial);
  render();
}
