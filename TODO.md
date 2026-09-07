### Mac App Store readiness

Assessed against the guidelines most likely to bite a local-file media player:
2.1 (completeness), 4.2 (minimum functionality), 4.3 (duplication). **4.2 and 4.3
are not a problem** — see "Assessed, no action" at the bottom. Everything below is
2.1, plus the sandbox work that 2.1 failures would actually be reported as.

#### Done — Help ▸ Licenses

Third-party attribution panel generated from the dependency tree by
`scripts/gen-licenses.mjs` into `public/licenses.json` (gitignored, rebuilt by
`pnpm dev` / `pnpm build`), with hand-written entries in
`scripts/licenses-supplement` for deps whose metadata is missing or wrong. Covers
the attribution obligations of the MIT/Apache deps we ship and removes an easy
reviewer question.

#### Not done — App Sandbox + file access (the real blocker)

The Mac App Store requires the app be sandboxed. There is currently **no**
security-scoped bookmark handling anywhere (`grep -ri bookmark src src-tauri/src`
returns nothing), and library roots persist as plain path strings. Under the
sandbox that means access works for the session in which the user picks a folder
and is gone on relaunch — the library comes back empty and playback fails. A
reviewer restarting the app sees a broken app, which gets written up as 2.1, not
as a sandbox note. Users hit the same thing on second launch, so this is worth
doing regardless of whether we ever ship to the store.

Three grant paths, and only the third needs bookmarks:

- **`~/Music` for free.** The entitlement `com.apple.security.assets.music.read-write`
  grants recursive read/write to the user's Music folder with no picker, no prompt,
  and no bookmark. It's a standard sandbox entitlement, not a temporary exception,
  so it needs no special justification. Defaulting the library root to `~/Music` on
  first run means most users never see a file picker. We have no `~/Music` default
  today.
- **Finder drag-and-drop.** Files and folders dropped on the window carry an
  implicit Powerbox grant, same as a picker, no dialog. The window already has
  `dragDropEnabled: true` (see the header comment in `src/drag-drop.ts`) but
  nothing subscribes to `onDragDropEvent`, so a dropped folder does nothing today.
  Wiring it to "add as library root" is small and buys a second zero-friction path.
- **Everything else → picker + bookmarks.** `com.apple.security.files.user-selected.read-write`
  for the pick, `com.apple.security.files.bookmarks.app-scope` to persist it. Store
  the bookmark blob instead of (alongside) the path string, resolve at startup, and
  wrap `startAccessingSecurityScopedResource` / `stop` around every filesystem
  consumer: the scanner, the `notify` watcher, the lofty tag writer, and the
  `.m3u8` playlist writer.

Because roots are already normalized and handled as a set (`src-tauri/src/lib.rs`
~L490, ~L592), this is closer to a storage-shape change than an architecture
change.

Also needs checking under the sandbox:

- `tauri-plugin-single-instance` — its rendezvous socket typically has to move into
  the container or an app group. File associations depend on single-instance, so
  this failing takes "double-click a file in Finder" down with it.
- Apple Music's own downloaded tracks under `~/Music/Music/Media.localized` are
  DRM-protected. Skip them or fail gracefully rather than surfacing unplayable rows.
- `com.apple.security.network.client` for the radio streams (ureq).
- Show in Finder via NSWorkspace is allowed under the sandbox — no work expected.

#### Not done — first run has nothing to play (2.1)

A reviewer launches on a machine with no music library and gets an empty tree
behind the prompt at `index.html` L75, and an empty Streams tab —
`ensure_default_stream_list` (`src-tauri/src/lib.rs` L852) seeds a header-only
`#EXTM3U\n` file. Nothing in the app makes a sound without the reviewer sourcing
audio themselves. That is a textbook "we were unable to review your app"
rejection.

Note this is a *review theater* problem, separable from the sandbox work above:
it's solved by making one thing audible on launch, not by solving file access.

- **Seed a few radio stations** on first run, from stations whose terms permit it.
  Get a written OK by email rather than relying on a TOS reading, and quote it in
  the App Review Notes — that also closes any 5.2.1 question about shipping
  third-party branded streams. SomaFM has historically been friendly to third-party
  players.
- **Bundle a short sample track** we own outright, surfaced as a "Play a sample"
  affordance in the empty state. Rights-clean, works with no network (reviewers
  sometimes test with restricted connectivity), and useful to real users. Reading
  from our own bundle is fine under the sandbox.
- **Make the empty state an invitation, not a sentence.** `index.html` L75 is
  currently one line of text with a link to settings — factually correct, reads
  like an error. A real first-run panel with a prominent "Choose your music folder"
  button pre-pointed at `~/Music` reads as a finished app waiting for input, which
  is the bar 2.1 is actually measuring. Every other player does this: VLC's empty
  window is itself a drop target plus Open File / Open Network Stream; Doppler runs
  an onboarding wizard defaulting to the Music folder; Vox always has radio to play.
- **Write the App Review Notes** with explicit test steps.

#### Not done — store metadata and signing

- Privacy policy URL and support URL are both required, even though we collect
  nothing.
- Version mismatch: `package.json` says `0.1.0`, `src-tauri/tauri.conf.json` says
  `1.0.0`. Cosmetic, but pick one.
- MAS builds use a different signing identity (3rd Party Mac Developer) and need a
  provisioning profile embedded in the bundle. Tauri's bundler does not do this for
  us; expect a custom signing step.

#### Assessed, no action — 4.2, 4.3, 2.5.1

Recording these so they don't get re-litigated:

- **4.2 minimum functionality — passes easily.** Native Rust audio engine
  (symphonia + cpal) with gapless output and sinc resampling, 10-band biquad EQ,
  ReplayGain, ICY metadata parser, SQLite metadata cache with live FSEvents
  watching, tag writing via lofty, MPNowPlayingInfoCenter / MPRemoteCommandCenter
  integration. 4.2.3 targets apps that are only a web view onto a website; running
  our own UI in WKWebView doesn't make us one.
- **4.3 duplication — low risk.** 4.3 targets one developer shipping many
  near-identical binaries, or commodity template apps. Third-party players already
  exist on the store (Doppler, Vox, Marvis). The one thing to get right is that the
  differentiation (no-import watched folders, autosaved `.m3u8` playlists,
  first-class queue, ICY radio) lands in the screenshots and description, not only
  in the README — 4.3 rejections in this category tend to hit apps whose listing
  reads generic.
- **2.5.1 public APIs only.** `src-tauri/src/now_playing.rs` uses
  MPNowPlayingInfoCenter and MPRemoteCommandCenter via objc2, both public. No event
  taps, no private selectors.
