// Holding the sandbox grants for the library roots, for as long as they are roots.
//
// bookmarks.rs is the primitive; this is the policy, and the policy is the part
// that was actually in question. Creating and resolving a bookmark is mechanical.
// Deciding *who holds the guard* is not: every filesystem consumer in the app sits
// downstream of a library root — the scanner (run_scan), the notify debouncers, the
// lofty tag writer, the .m3u8 playlist writer, and the decode thread that opens the
// file to play it. Several of those run on their own threads and have no idea which
// root a path came from. Threading a ScopedAccess through all of them would mean
// putting a lifetime into each one and getting the release right in each one, and a
// single missed release burns the process-wide grant budget.
//
// So the guard is held per *root*, for exactly as long as that folder is configured
// as a library root: one resolve when the set changes, one HashMap, and every
// consumer goes on opening plain paths the way it always has. Access is refcounted
// per URL with a hard per-process cap, and the count here is bounded by the number
// of folders the user configured — a handful — rather than by files, scans, or
// threads.
//
// Storage lives on the frontend, next to the root paths in settings.json, so the
// two commands are shaped around that: `bookmark_root` mints a blob at the one
// moment a grant exists to freeze (right as the picker returns), and
// `hold_library_roots` takes the whole persisted set, takes access, and reports
// back what the frontend has to write down — a refreshed blob, a folder the user
// moved out from under us, or a root that could not be reached at all.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::bookmarks::{Bookmark, Error, ScopedAccess};

/// The live grants, keyed by the path each bookmark actually resolved to. Managed
/// state, so the guards live as long as the app does unless a roots change
/// replaces them; dropping a `ScopedAccess` is what ends the OS-level access.
#[derive(Default)]
pub struct RootAccess {
    held: Mutex<HashMap<PathBuf, ScopedAccess>>,
}

/// One row of the persisted library-roots setting, as the frontend stores it.
#[derive(Deserialize)]
pub struct StoredRoot {
    pub path: String,
    /// Base64 from `Bookmark::to_base64`. Absent for a root configured before any
    /// of this existed, or one we were never able to mint a blob for.
    pub bookmark: Option<String>,
}

/// What the frontend must do about one root now that access has been taken.
#[derive(Serialize)]
pub struct HeldRoot {
    /// Where the folder actually is now. A bookmark follows a folder the user
    /// renamed or moved, so this can differ from the path that was stored; the
    /// caller re-persists it, and the next scan re-keys the tracks, since
    /// `tracks.root` is this string (see normalize_root).
    pub path: String,
    /// A blob to write down, when one was minted or refreshed. `None` means "keep
    /// whatever is stored" — deliberately not "drop it".
    pub bookmark: Option<String>,
    /// Why this root is currently unreachable, or `None`. Advisory: the root stays
    /// configured, and the folder simply fails to list, which is the same state
    /// Settings already renders for a missing folder.
    pub error: Option<String>,
}

/// Freeze the current grant on `path`, or `None` if it cannot be frozen.
///
/// Failure is not an error the UI should raise. Unsandboxed there is no grant to
/// freeze and nothing needs one; sandboxed, the consequence is that this root will
/// not survive the next launch, which surfaces then as a folder that won't open.
/// Logged either way so a sandboxed failure is findable rather than silent.
fn mint(path: &str) -> Option<String> {
    match Bookmark::create(path) {
        Ok(bm) => Some(bm.to_base64()),
        Err(Error::Unsupported) => None,
        Err(e) => {
            log::warn!("could not bookmark library root {}: {}", path, e);
            None
        }
    }
}

/// Called the instant the folder picker hands a path over, because that instant is
/// the only one where the grant exists to be captured: it dies with the process and
/// cannot be re-derived later without asking the user again.
#[tauri::command]
pub fn bookmark_root(path: String) -> Option<String> {
    mint(&path)
}

impl RootAccess {
    /// Resolve and take access for the whole configured set, replacing whatever was
    /// held before. Must run before anything reads the folders — the tree listing,
    /// the scan, the watchers — or those all see an unreadable directory.
    ///
    /// The whole-set shape mirrors `watch_libraries`: passing the new set is also
    /// how roots get released, and passing `[]` releases everything. Dropping the
    /// `RootAccess` itself releases everything too, which is the property
    /// examples/sandbox_check.rs leans on.
    ///
    /// Split out from the command so it can be driven from a plain binary: the
    /// only honest test of this runs inside a signed, sandboxed .app, where there
    /// is no Tauri `State` to hand it.
    pub fn hold(&self, roots: Vec<StoredRoot>) -> Result<Vec<HeldRoot>, String> {
        let mut next = HashMap::new();
        let report = roots
            .into_iter()
            .map(|root| hold_one(root, &mut next))
            .collect();

        // Swap first, drop after. A root present in both sets is briefly held twice
        // — start is refcounted, so this is balanced and settles at one — rather
        // than briefly not held at all, which a concurrent scan would notice.
        let previous = std::mem::replace(&mut *self.held.lock().map_err(|e| e.to_string())?, next);
        drop(previous);

        Ok(report)
    }
}

#[tauri::command]
pub fn hold_library_roots(
    roots: Vec<StoredRoot>,
    access: State<RootAccess>,
) -> Result<Vec<HeldRoot>, String> {
    access.hold(roots)
}

fn hold_one(root: StoredRoot, next: &mut HashMap<PathBuf, ScopedAccess>) -> HeldRoot {
    let stored = root.path;

    let Some(bm) = root.bookmark.as_deref().and_then(Bookmark::from_base64) else {
        // No usable blob: a root configured before bookmarks existed, a path the
        // user typed by hand, or one under ~/Music that the assets entitlement
        // reaches without one. Mint now if the folder is reachable, so the next
        // launch doesn't depend on this one having been unsandboxed. Nothing to
        // hold if that fails — the folder either opens or shows as invalid.
        return HeldRoot {
            bookmark: mint(&stored),
            path: stored,
            error: None,
        };
    };

    match bm.resolve() {
        Ok(access) => {
            let path = access.path().to_string_lossy().into_owned();
            // Re-mint when the OS says the blob is aging out, or when the folder
            // moved and the stored path no longer describes it. This has to happen
            // while `access` is still alive: create freezes the grant we are
            // holding right now, and after the drop there is no grant to freeze.
            let refreshed = if access.is_stale() || path != stored {
                mint(&path)
            } else {
                None
            };
            next.insert(PathBuf::from(&path), access);
            HeldRoot {
                path,
                bookmark: refreshed,
                error: None,
            }
        }
        // Not macOS. The path is just a path here and always was.
        Err(Error::Unsupported) => HeldRoot {
            path: stored,
            bookmark: None,
            error: None,
        },
        Err(e) => {
            // Keep the blob. Resolution also fails for reasons that come back on
            // their own — an unmounted volume, a network share that is down — and
            // discarding the grant would turn an outage into a permanent re-pick.
            let msg = e.to_string();
            log::warn!("library root {} is unreachable: {}", stored, msg);
            HeldRoot {
                path: stored,
                bookmark: None,
                error: Some(msg),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(path: &str, bookmark: Option<&str>) -> StoredRoot {
        StoredRoot {
            path: path.to_string(),
            bookmark: bookmark.map(str::to_string),
        }
    }

    // Everything below runs unsandboxed, so it exercises the bookkeeping — which
    // roots end up held, which blobs come back — and not the grant itself. What
    // proves the grant does anything is tools/sandbox-check.sh.

    #[test]
    fn a_root_with_no_blob_gets_one_minted() {
        let mut held = HashMap::new();
        let dir = std::env::temp_dir();
        let row = hold_one(stored(&dir.to_string_lossy(), None), &mut held);

        assert!(row.error.is_none());
        if cfg!(target_os = "macos") {
            assert!(row.bookmark.is_some(), "should have minted a blob");
            // Nothing to hold: minting does not take access, and the path was
            // already reachable without it.
            assert!(held.is_empty());
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_resolvable_blob_is_held_and_not_re_minted() {
        let dir = std::env::temp_dir();
        let blob = Bookmark::create(&dir).expect("create").to_base64();
        // Resolution reports the real path, and /tmp is a symlink to /private/tmp,
        // so store the resolved form or this looks like a move.
        let resolved = Bookmark::from_base64(&blob)
            .unwrap()
            .resolve()
            .expect("resolve")
            .path()
            .to_string_lossy()
            .into_owned();

        let mut held = HashMap::new();
        let row = hold_one(stored(&resolved, Some(&blob)), &mut held);

        assert!(row.error.is_none());
        assert_eq!(row.path, resolved);
        assert!(
            row.bookmark.is_none(),
            "unchanged root should not re-persist"
        );
        assert_eq!(held.len(), 1, "the guard must be kept alive");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_moved_folder_reports_its_new_path_and_a_fresh_blob() {
        // Standing in for the user renaming the folder: the stored path is wrong,
        // the bookmark still resolves, and both facts have to reach the caller or
        // the root silently keeps pointing at a name that no longer exists.
        let dir = std::env::temp_dir();
        let blob = Bookmark::create(&dir).expect("create").to_base64();

        let mut held = HashMap::new();
        let row = hold_one(stored("/somewhere/it/used/to/be", Some(&blob)), &mut held);

        assert_ne!(row.path, "/somewhere/it/used/to/be");
        assert!(
            row.bookmark.is_some(),
            "the new location must be re-persisted"
        );
        assert_eq!(held.len(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_unresolvable_blob_leaves_the_root_configured() {
        // The failure has to be reported without dropping the root or the blob: an
        // unplugged drive comes back, and a re-pick prompt would be wrong.
        let mut held = HashMap::new();
        let row = hold_one(stored("/Volumes/gone", Some("3q2+7w==")), &mut held);

        assert_eq!(row.path, "/Volumes/gone");
        assert!(row.error.is_some());
        assert!(row.bookmark.is_none(), "must not clobber the stored blob");
        assert!(held.is_empty());
    }

    #[test]
    fn a_corrupt_blob_falls_back_to_minting() {
        // Unparseable base64 is not a transient failure, so it is treated as no
        // blob at all rather than reported — the fresh mint replaces it.
        let mut held = HashMap::new();
        let dir = std::env::temp_dir();
        let row = hold_one(
            stored(&dir.to_string_lossy(), Some("not base64 !!!")),
            &mut held,
        );

        assert!(row.error.is_none());
        if cfg!(target_os = "macos") {
            assert!(row.bookmark.is_some());
        }
    }
}
