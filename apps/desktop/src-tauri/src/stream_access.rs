// Holding the sandbox grant for the stream list, for as long as it is the stream list.
//
// Same problem as a library root, one file instead of a folder: sandboxed, the
// grant the picker hands over dies with the process, so a stream list stored as a
// path alone comes back dead on the next launch — `read_stream_list` gets EPERM and
// the pane says "Invalid stream list path" over a file that never moved. Only a
// security-scoped bookmark survives, which is what this mints and resolves.
//
// Why its own single-slot state rather than a row in `root_access`:
//
//   * There is exactly one stream list. `RootAccess::hold` takes the whole
//     configured set and releases everything not in it, so a stream list parked in
//     that map would be dropped by the next roots change (Settings adding a folder)
//     and the file would go unreadable mid-session.
//   * It cannot share `recent_access`'s slot either: that one deliberately holds
//     only the item being reopened and is replaced by every Open Recent, which
//     would evict the stream list's grant at an unrelated moment.
//
// Like a root, the grant is held for the whole session rather than per operation:
// the list is read at startup and rewritten by every station add, edit, move and
// delete, and those all open a plain path.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::bookmarks::{Bookmark, Error, ScopedAccess};
use crate::root_access::mint;

/// The live grant, or `None` when the list needs none (remote, unsandboxed, or a
/// path inside the container). Managed state, so the guard lives as long as the app
/// does unless a path change replaces it.
#[derive(Default)]
pub struct StreamListAccess {
    held: Mutex<Option<ScopedAccess>>,
}

/// What the frontend must write down now that access has been taken.
#[derive(Serialize)]
pub struct HeldStreamList {
    /// Where the file actually is now. A bookmark follows a file the user renamed
    /// or moved, so this can differ from the path that was stored; the caller
    /// re-persists it and reads the list from here.
    pub path: String,
    /// A blob to write down, when one was minted or refreshed. `None` means "keep
    /// whatever is stored" — deliberately not "drop it", since resolution also
    /// fails for reasons that come back on their own.
    pub bookmark: Option<String>,
}

impl StreamListAccess {
    /// Take — and keep — the grant for `path`, replacing whatever was held before.
    /// Must run before anything reads or writes the file.
    ///
    /// Two callers, one shape: at startup with the persisted blob, and the instant
    /// the picker returns with no blob at all. The second is the only moment a
    /// bookmark can be minted, so "no blob" means mint rather than fail.
    pub fn hold(&self, path: String, bookmark: Option<String>) -> Result<HeldStreamList, String> {
        // A remote list is fetched over HTTP and has no sandbox grant to hold. Drop
        // whatever a previous local path left held — nothing else will.
        if path.starts_with("http://") || path.starts_with("https://") {
            self.replace(None)?;
            return Ok(HeldStreamList {
                path,
                bookmark: None,
            });
        }

        let Some(bm) = bookmark.as_deref().and_then(Bookmark::from_base64) else {
            // No usable blob: the picker just handed this over (mint now, while the
            // grant exists), a path typed by hand, the seeded default inside the
            // container, or a list configured before any of this existed. Nothing to
            // hold if minting fails — the list either reads or shows as invalid.
            return Ok(HeldStreamList {
                bookmark: mint(&path),
                path,
            });
        };

        match bm.resolve() {
            Ok(access) => {
                let resolved = access.path().to_string_lossy().into_owned();
                // Re-mint while `access` is still alive — create freezes the grant
                // being held right now, and after the drop there is none to freeze.
                let refreshed = if access.is_stale() || resolved != path {
                    mint(&resolved)
                } else {
                    None
                };
                self.replace(Some(access))?;
                Ok(HeldStreamList {
                    path: resolved,
                    bookmark: refreshed,
                })
            }
            // Not macOS. The path is just a path here and always was.
            Err(Error::Unsupported) => Ok(HeldStreamList {
                path,
                bookmark: None,
            }),
            Err(e) => {
                // Keep the blob: an unmounted volume or a down network share comes
                // back on its own, and discarding the grant would turn an outage
                // into a permanent re-pick.
                log::warn!("stream list {} is unreachable: {}", path, e);
                self.replace(None)?;
                Ok(HeldStreamList {
                    path,
                    bookmark: None,
                })
            }
        }
    }

    /// Swap first, drop after, for the reason `RootAccess::hold` spells out: the
    /// same file held briefly twice (start is refcounted, so it settles at one)
    /// rather than briefly not held at all.
    fn replace(&self, access: Option<ScopedAccess>) -> Result<(), String> {
        let previous =
            std::mem::replace(&mut *self.held.lock().map_err(|e| e.to_string())?, access);
        drop(previous);
        Ok(())
    }
}

#[tauri::command]
pub fn hold_stream_list(
    path: String,
    bookmark: Option<String>,
    access: State<StreamListAccess>,
) -> Result<HeldStreamList, String> {
    access.hold(path, bookmark)
}

#[cfg(test)]
mod tests {
    use super::*;

    // As in root_access's tests: this runs outside the signed sandboxed .app, so it
    // exercises the bookkeeping — which path and which blob come back, and whether a
    // guard is kept — rather than the grant itself. tools/sandbox-check.sh is the
    // integration check for the grant.
    fn held_path(access: &StreamListAccess) -> Option<String> {
        access
            .held
            .lock()
            .unwrap()
            .as_ref()
            .map(|a| a.path().to_string_lossy().into_owned())
    }

    #[test]
    fn a_remote_list_is_left_alone_and_releases_a_local_one() {
        let access = StreamListAccess::default();
        let url = "https://example.invalid/stations.m3u8".to_string();
        let held = access.hold(url.clone(), None).expect("hold");

        assert_eq!(held.path, url);
        assert!(held.bookmark.is_none(), "a URL has no grant to freeze");
        assert!(held_path(&access).is_none());
    }

    #[test]
    fn a_list_with_no_blob_gets_one_minted() {
        let access = StreamListAccess::default();
        let path = std::env::temp_dir().join("stations.m3u8");
        std::fs::write(&path, "#EXTM3U\n").expect("write");
        let stored = path.to_string_lossy().into_owned();

        let held = access.hold(stored.clone(), None).expect("hold");

        assert_eq!(held.path, stored, "minting must not move the path");
        if let Some(blob) = held.bookmark {
            assert!(
                Bookmark::from_base64(&blob).is_some(),
                "minted blob should be persisted as base64"
            );
        }
        // Minting takes no access, and the file was already reachable without it.
        assert!(held_path(&access).is_none());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_blob_that_is_not_a_bookmark_falls_back_to_the_stored_path() {
        // Settings edited by hand, or a key that predates this. The path still has
        // to come back usable: the file is very often reachable anyway (the seeded
        // default lives in the container), and refusing it here would blank the
        // stream pane over a cache miss.
        let access = StreamListAccess::default();
        let stored = "/not/a/real/list.m3u8".to_string();

        let held = access
            .hold(stored.clone(), Some("not base64!!".into()))
            .expect("hold");

        assert_eq!(held.path, stored);
        assert!(held_path(&access).is_none());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires macOS security-scoped bookmark support in the test process"]
    fn a_resolvable_blob_is_held_and_not_re_minted() {
        let path = std::env::temp_dir().join("stations-held.m3u8");
        std::fs::write(&path, "#EXTM3U\n").expect("write");
        let blob = Bookmark::create(&path).expect("create").to_base64();
        // /tmp is a symlink to /private/tmp, so store the resolved form or this
        // looks like the file moved.
        let resolved = Bookmark::from_base64(&blob)
            .unwrap()
            .resolve()
            .expect("resolve")
            .path()
            .to_string_lossy()
            .into_owned();

        let access = StreamListAccess::default();
        let held = access.hold(resolved.clone(), Some(blob)).expect("hold");

        assert_eq!(held.path, resolved);
        assert!(
            held.bookmark.is_none(),
            "an unchanged list should not re-persist"
        );
        assert_eq!(
            held_path(&access).as_deref(),
            Some(resolved.as_str()),
            "the guard must be kept alive for the session"
        );
        let _ = std::fs::remove_file(&path);
    }
}
