// Security-scoped bookmarks: persisting a user's grant to a folder across launches.
//
// Only matters under the App Sandbox, which is mandatory for the Mac App Store.
// Sandboxed, a path string is just text and carries no permission. The user picks
// a folder, the system extends our sandbox for the life of the process, and on the
// next launch open() on that same path is EPERM. A library root stored as a path
// therefore comes back dead: empty tree, playback fails. A security-scoped bookmark
// is the only supported way to persist the grant.
//
// Two entitlements are load-bearing and easy to confuse:
//   * files.user-selected.read-write — lets the picker/drop grant work at all,
//     for this process only.
//   * files.bookmarks.app-scope     — lets that grant be frozen into a bookmark.
// With only the first you get the broken-on-second-launch behaviour above.
//
// Note this is a different gate from Tauri's own fs scope, which is a JS-side
// allowlist deciding whether the frontend may *ask* for a path. Satisfying one
// says nothing about the other, which is why tauri-plugin-persisted-scope does not
// solve this: it restores the allowlist, and the kernel still says no.
//
// The shape of the API is forced by how the sandbox accounts for access:
//
//   * start/stop are refcounted per URL and there is a hard per-process cap on
//     outstanding grants. Leak them and the app loses its ability to reach outside
//     the sandbox *entirely* until relaunch — a failure that shows up far from its
//     cause. So access is an RAII guard: `ScopedAccess` holds the NSURL and its
//     Drop is the only place stop is ever called. There is no public stop().
//   * Resolution reports staleness (the folder moved, or the OS changed the
//     bookmark format across an OS upgrade). A stale bookmark still resolves and
//     still grants access, but it should be re-created from the resolved URL or it
//     will eventually stop resolving. Hence `is_stale()` rather than swallowing it.
//   * Resolve is used at startup to restore roots, so it must never block on a
//     mount or authentication prompt: WithoutUI.
//
// Attribution: the FFI sequence here follows apple-scoped-bookmarks (MIT OR
// Apache-2.0, https://github.com/CrispStrobe/apple-scoped-bookmarks) — in
// particular the ordering in resolve() and the iOS creation-flag carve-out.
// Reimplemented rather than taken as a dependency: it is a 0.1.0 with no
// maintenance history, and this is ~150 lines against objc2, which we already
// bind directly for now_playing.rs. Its live-sandbox test methodology is worth
// more than its code and is what tools/sandbox-check.sh reproduces.

use std::fmt;
use std::path::{Path, PathBuf};

/// Why a bookmark could not be created, resolved, or accessed.
#[derive(Debug)]
pub enum Error {
    /// The path was not valid UTF-8, so it cannot become an NSString.
    InvalidPath(PathBuf),
    /// Cocoa refused, carrying its own localized description.
    Cocoa(String),
    /// The bookmark resolved, but the sandbox declined to extend access to it.
    AccessDenied(PathBuf),
    /// Compiled for a platform with no such concept.
    Unsupported,
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidPath(p) => write!(f, "path is not valid UTF-8: {}", p.display()),
            Error::Cocoa(msg) => write!(f, "{}", msg),
            Error::AccessDenied(p) => write!(
                f,
                "startAccessingSecurityScopedResource was refused for {} — the app is \
                 probably missing com.apple.security.files.bookmarks.app-scope, or the \
                 bookmark was made by a different signing identity",
                p.display()
            ),
            Error::Unsupported => write!(f, "security-scoped bookmarks are macOS/iOS only"),
        }
    }
}

impl std::error::Error for Error {}

/// A frozen grant: the opaque blob Foundation hands back, to be stored alongside
/// (not instead of) the path. Deliberately not Deref/AsRef to a path — a bookmark
/// is not a location, and the resolved path can differ from the one it was made
/// from once the user moves the folder.
#[derive(Clone, PartialEq, Eq)]
pub struct Bookmark {
    data: Vec<u8>,
}

// The blob is long and means nothing to a human; printing it would bury real
// context in log lines. Length is the only useful part.
impl fmt::Debug for Bookmark {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Bookmark({} bytes)", self.data.len())
    }
}

impl Bookmark {
    /// Freeze the current grant on `path`. Must be called while the path is
    /// actually reachable — right after the picker or drop hands it over, or from
    /// inside an existing `ScopedAccess`. Calling it on a path we cannot reach
    /// produces a bookmark that resolves to a denial later.
    pub fn create(path: impl AsRef<Path>) -> Result<Self, Error> {
        imp::create(path.as_ref())
    }

    /// Resolve and immediately begin access. Access ends when the returned guard
    /// drops, so hold it for exactly as long as the filesystem work: a scan, a tag
    /// write, an .m3u8 save, or the lifetime of a watcher.
    pub fn resolve(&self) -> Result<ScopedAccess, Error> {
        imp::resolve(&self.data)
    }

    pub fn from_bytes(data: impl Into<Vec<u8>>) -> Self {
        Self { data: data.into() }
    }

    // Only examples/sandbox_check.rs and the tests read the raw blob — the app
    // stores base64 — and an example does not count as a use, so this would warn.
    #[allow(dead_code)]
    pub fn as_bytes(&self) -> &[u8] {
        &self.data
    }

    /// Base64 for the JSON store, where roots are persisted by the frontend.
    pub fn to_base64(&self) -> String {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD.encode(&self.data)
    }

    /// Round-trips `to_base64`. A malformed string is `None` rather than an error:
    /// the only caller is restoring persisted state, where the answer is always to
    /// fall back to re-prompting rather than to fail the launch.
    pub fn from_base64(s: &str) -> Option<Self> {
        use base64::Engine;
        base64::engine::general_purpose::STANDARD
            .decode(s)
            .ok()
            .map(Self::from_bytes)
    }
}

/// Live access to a security-scoped path. Dropping it releases the grant, which is
/// why it must be held rather than discarded: `let _ = bm.resolve()?;` drops
/// immediately and the very next open() fails, while `let _guard = ...` holds.
pub struct ScopedAccess {
    path: PathBuf,
    stale: bool,
    // Field order is the release order. `inner` last means the stop call happens
    // after the path/stale fields, which is harmless, but keeping the handle last
    // documents that nothing here may outlive it.
    // Held for its Drop; never read, hence the allow.
    #[allow(dead_code)]
    inner: imp::AccessHandle,
}

impl ScopedAccess {
    /// Where the bookmark actually resolved, which is not necessarily where it was
    /// created: bookmarks follow a folder the user renames or moves. Always use
    /// this rather than the stored path once resolved.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// True when the bookmark still works but should be re-created from `path()`
    /// and persisted again — the folder moved, or an OS upgrade changed the format.
    /// Ignoring it works until it abruptly doesn't.
    pub fn is_stale(&self) -> bool {
        self.stale
    }
}

impl fmt::Debug for ScopedAccess {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ScopedAccess")
            .field("path", &self.path)
            .field("stale", &self.stale)
            .finish()
    }
}

#[cfg(any(target_os = "macos", target_os = "ios"))]
mod imp {
    use super::{Bookmark, Error, ScopedAccess};
    use objc2::rc::Retained;
    use objc2::runtime::Bool;
    use objc2_foundation::{
        NSData, NSString, NSURLBookmarkCreationOptions, NSURLBookmarkResolutionOptions, NSURL,
    };
    use std::path::{Path, PathBuf};

    // WithSecurityScope is macOS-only. On iOS a document-picker URL is already
    // security-scoped and passing the macOS creation flag is rejected outright.
    #[cfg(target_os = "macos")]
    const CREATE_OPTS: NSURLBookmarkCreationOptions =
        NSURLBookmarkCreationOptions::WithSecurityScope;
    #[cfg(target_os = "ios")]
    const CREATE_OPTS: NSURLBookmarkCreationOptions = NSURLBookmarkCreationOptions(0);

    // WithoutUI because resolve() runs during startup while restoring library
    // roots: a bookmark pointing at an unmounted volume must fail fast, not stall
    // the launch behind a system mount/auth panel.
    #[cfg(target_os = "macos")]
    const RESOLVE_OPTS: NSURLBookmarkResolutionOptions = NSURLBookmarkResolutionOptions(
        NSURLBookmarkResolutionOptions::WithSecurityScope.0
            | NSURLBookmarkResolutionOptions::WithoutUI.0,
    );
    #[cfg(target_os = "ios")]
    const RESOLVE_OPTS: NSURLBookmarkResolutionOptions = NSURLBookmarkResolutionOptions::WithoutUI;

    /// Owns the "currently accessing" state for one URL and releases it exactly
    /// once. Constructed only on the success path in `resolve`, so Drop can call
    /// stop unconditionally.
    pub(super) struct AccessHandle {
        url: Retained<NSURL>,
    }

    impl Drop for AccessHandle {
        fn drop(&mut self) {
            unsafe { self.url.stopAccessingSecurityScopedResource() };
        }
    }

    fn ns_string(path: &Path) -> Result<Retained<NSString>, Error> {
        let s = path
            .to_str()
            .ok_or_else(|| Error::InvalidPath(path.to_path_buf()))?;
        Ok(NSString::from_str(s))
    }

    pub(super) fn create(path: &Path) -> Result<Bookmark, Error> {
        let ns_path = ns_string(path)?;
        let url = NSURL::fileURLWithPath(&ns_path);
        let data = url
            .bookmarkDataWithOptions_includingResourceValuesForKeys_relativeToURL_error(
                CREATE_OPTS,
                None,
                None,
            )
            .map_err(|e| Error::Cocoa(e.localizedDescription().to_string()))?;
        Ok(Bookmark {
            data: data.to_vec(),
        })
    }

    pub(super) fn resolve(bytes: &[u8]) -> Result<ScopedAccess, Error> {
        let data = NSData::with_bytes(bytes);
        let mut stale = Bool::NO;
        let url = unsafe {
            NSURL::URLByResolvingBookmarkData_options_relativeToURL_bookmarkDataIsStale_error(
                &data,
                RESOLVE_OPTS,
                None,
                &mut stale,
            )
        }
        .map_err(|e| Error::Cocoa(e.localizedDescription().to_string()))?;

        let path = url
            .path()
            .map(|p| PathBuf::from(p.to_string()))
            .unwrap_or_default();

        // Order matters: the grant must be taken BEFORE the handle exists. If this
        // were done after construction, a refusal would leave an AccessHandle whose
        // Drop calls stop against a start that never happened — an unbalanced
        // release, which is exactly the accounting bug that burns the per-process
        // grant budget.
        if !unsafe { url.startAccessingSecurityScopedResource() } {
            return Err(Error::AccessDenied(path));
        }

        Ok(ScopedAccess {
            path,
            stale: stale.as_bool(),
            inner: AccessHandle { url },
        })
    }
}

#[cfg(not(any(target_os = "macos", target_os = "ios")))]
mod imp {
    use super::{Bookmark, Error, ScopedAccess};
    use std::path::Path;

    pub(super) struct AccessHandle;

    pub(super) fn create(_path: &Path) -> Result<Bookmark, Error> {
        Err(Error::Unsupported)
    }

    pub(super) fn resolve(_bytes: &[u8]) -> Result<ScopedAccess, Error> {
        Err(Error::Unsupported)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trips() {
        let bm = Bookmark::from_bytes(vec![0, 1, 2, 253, 254, 255]);
        let restored = Bookmark::from_base64(&bm.to_base64()).expect("valid base64");
        assert_eq!(bm, restored);
    }

    #[test]
    fn malformed_base64_is_none() {
        assert!(Bookmark::from_base64("not base64 !!!").is_none());
    }

    #[test]
    fn debug_hides_the_blob() {
        let bm = Bookmark::from_bytes(vec![7; 300]);
        assert_eq!(format!("{:?}", bm), "Bookmark(300 bytes)");
    }

    // These tests run outside the signed sandboxed .app, so they are only live FFI
    // smoke tests and not the proof that bookmarks do their job. On some macOS
    // hosts, an ordinary cargo test process cannot create app-scope security
    // bookmarks at all. Keep them out of the default suite; tools/sandbox-check.sh
    // is the real integration check.
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires macOS security-scoped bookmark support in the test process"]
    fn create_and_resolve_a_real_directory() {
        let dir = std::env::temp_dir();
        let bm = Bookmark::create(&dir).expect("create");
        assert!(!bm.as_bytes().is_empty());

        let access = bm.resolve().expect("resolve");
        // Compare canonicalized: /tmp is a symlink to /private/tmp, and the
        // resolved URL reports the real path.
        assert_eq!(
            access.path().canonicalize().ok(),
            dir.canonicalize().ok(),
            "bookmark resolved somewhere else"
        );
        assert!(access.path().read_dir().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires macOS security-scoped bookmark support in the test process"]
    fn create_rejects_a_nonexistent_path() {
        // A bookmark to nothing cannot be made; this must surface as an error
        // rather than an empty blob that fails mysteriously at resolve time.
        let missing = std::env::temp_dir().join("pudding-no-such-dir-9d3f1a2b");
        assert!(Bookmark::create(&missing).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn resolving_garbage_is_an_error_not_a_panic() {
        assert!(Bookmark::from_bytes(vec![0xde, 0xad, 0xbe, 0xef])
            .resolve()
            .is_err());
    }
}
