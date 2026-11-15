// Replacing a file's contents when the sandbox grants the file but not its folder.
//
// write_atomic stages a sibling next to the target and renames it over the name.
// That is the right trade whenever the directory is ours, and it is what every
// write in the app does first. But sandboxed, a file the user picked outside the
// app's container is granted as one FILE: the extension covers that path and
// nothing else, so creating the sibling is EPERM and the save is correctly refused
// with the original intact. For a stream list that meant a list Pudding could read
// after a relaunch and never edit — every station add, rename and delete refused.
//
// -[NSFileManager replaceItemAtURL:withItemAtURL:...] is the system's own answer,
// and the one NSDocument's "safe save" is built on. Two properties are why it can
// succeed where the sibling cannot:
//
//   * The replacement is staged in NSItemReplacementDirectory, asked for with
//     `appropriateForURL:` — a scratch directory the OS picks on the *target's
//     volume* (so the final step is still a rename, not a copy) and inside the
//     app's own temp area (so creating it needs no grant on the target's folder).
//   * The replacement itself goes through Foundation, which performs it against
//     the sandbox extension we hold on the file rather than as a bare creat() in
//     a directory we were never given.
//
// It keeps the guarantee the sibling dance exists for: the call is atomic from a
// reader's point of view, leaves either the old contents or the new, and (with no
// options) carries the original's metadata onto the replacement the way cloning it
// did. So this is a fallback, not a relaxation — `write_durably` reaches for it
// only once staging has been denied, and never answers a denial by truncating the
// file in place.

use std::io;
use std::path::Path;

/// Why a checked replacement did not happen. The two cases cannot be flattened:
/// the caller reaches this function only after an earlier attempt was denied, and
/// it will want to report *that* denial if the replacement also failed — but a veto
/// is not a failure of the replacement at all, and reporting it as one tells the
/// user to fix permissions over a file that was edited underneath them.
pub enum ReplaceFailure {
    /// `before_replace` said no. Carries exactly what it returned.
    Vetoed(io::Error),
    /// Staging or the replacement itself failed, on its own terms.
    Failed(io::Error),
}

/// Replace everything in `target` with `bytes`, atomically, using only the grant on
/// the file itself. `before_replace` gets a last look once the replacement is staged
/// and before it is published — the mirror of `write_atomic_checked`, so a file
/// something else rewrote during a slow save is refused here exactly as it is there
/// rather than silently clobbered by the fallback.
///
/// Failures carry `io::Error`s so the caller can treat this as one more write that
/// either worked or didn't; the Cocoa description is carried in the message, since
/// "operation couldn't be completed" with no detail is the one thing that would
/// make this unexplainable in a bug report.
pub fn replace_contents_checked(
    target: &Path,
    bytes: &[u8],
    before_replace: impl FnOnce() -> io::Result<()>,
) -> Result<(), ReplaceFailure> {
    imp::replace_contents(target, bytes, before_replace)
}

#[cfg(target_os = "macos")]
mod imp {
    use super::ReplaceFailure;
    use objc2_foundation::{
        NSFileManager, NSFileManagerItemReplacementOptions, NSSearchPathDirectory,
        NSSearchPathDomainMask, NSString, NSURL,
    };
    use std::io;
    use std::path::Path;

    fn cocoa_error(what: &str, e: &objc2_foundation::NSError) -> ReplaceFailure {
        ReplaceFailure::Failed(io::Error::other(format!(
            "{what}: {}",
            e.localizedDescription()
        )))
    }

    fn url(path: &Path) -> Result<objc2::rc::Retained<NSURL>, ReplaceFailure> {
        let text = path.to_str().ok_or_else(|| {
            ReplaceFailure::Failed(io::Error::other(format!(
                "{} is not valid UTF-8",
                path.display()
            )))
        })?;
        Ok(NSURL::fileURLWithPath(&NSString::from_str(text)))
    }

    pub(super) fn replace_contents(
        target: &Path,
        bytes: &[u8],
        before_replace: impl FnOnce() -> io::Result<()>,
    ) -> Result<(), ReplaceFailure> {
        // Resolve the link first, for the reason write_atomic_checked does it: the
        // replacement swaps a *directory entry*, so replacing a symlink would leave
        // a regular file where the link was. A path that won't resolve is used
        // unchanged — under a file-only grant that is the ordinary case, since
        // realpath() has to read the parent to answer.
        let target = &std::fs::canonicalize(target).unwrap_or_else(|_| target.to_path_buf());
        let target_url = url(target)?;
        let manager = NSFileManager::defaultManager();

        // `appropriateForURL:` is the load-bearing argument: it is what puts the
        // scratch directory on the same volume as the target, which is what keeps
        // the replacement a rename instead of a copy.
        let scratch = manager
            .URLForDirectory_inDomain_appropriateForURL_create_error(
                NSSearchPathDirectory::ItemReplacementDirectory,
                NSSearchPathDomainMask::UserDomainMask,
                Some(&target_url),
                true,
            )
            .map_err(|e| cocoa_error("could not stage the replacement", &e))?;
        let scratch_dir = scratch
            .path()
            .map(|p| std::path::PathBuf::from(p.to_string()))
            .ok_or_else(|| {
                ReplaceFailure::Failed(io::Error::other("the replacement directory has no path"))
            })?;

        // Named after the target so the file keeps its extension while it is being
        // written — the replacement inherits nothing from this name, but a sniffing
        // volume or a backup agent looking at it mid-save sees a .m3u8, not a blob.
        let staged = scratch_dir.join(
            target
                .file_name()
                .unwrap_or_else(|| std::ffi::OsStr::new("replacement")),
        );
        // Fail before touching the target, like staging a sibling does.
        let written = (|| -> io::Result<()> {
            use std::io::Write;
            let mut f = std::fs::File::create(&staged)?;
            f.write_all(bytes)?;
            // Same reasoning as write_atomic: flushed to the device before the
            // rename that publishes it, so a panic or power cut cannot land the
            // name ahead of the bytes.
            f.sync_all()
        })();
        if let Err(e) = written {
            clean_up(&staged, &scratch_dir);
            return Err(ReplaceFailure::Failed(e));
        }

        // Last look before anything is published, while the original is still whole.
        if let Err(e) = before_replace() {
            clean_up(&staged, &scratch_dir);
            return Err(ReplaceFailure::Vetoed(e));
        }

        let staged_url = url(&staged)?;
        let outcome = manager
            .replaceItemAtURL_withItemAtURL_backupItemName_options_resultingItemURL_error(
                &target_url,
                &staged_url,
                // No backup item: the original is only unlinked once the
                // replacement is in place, and a backup left in a scratch
                // directory we are about to remove would protect nothing.
                None,
                NSFileManagerItemReplacementOptions::empty(),
                None,
            )
            .map_err(|e| cocoa_error("could not replace the file", &e));
        // The call consumes the staged item on success; on failure it is still
        // there, and either way the scratch directory is ours to clean up.
        clean_up(&staged, &scratch_dir);
        outcome
    }

    /// The scratch directory is ours alone (the OS made it for this replacement),
    /// so both removals are best-effort tidying: a leftover would be invisible and
    /// temporary, and failing the save over it would help nobody.
    fn clean_up(staged: &Path, scratch_dir: &Path) {
        let _ = std::fs::remove_file(staged);
        let _ = std::fs::remove_dir(scratch_dir);
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::io;
    use std::path::Path;

    /// Nothing to fall back to: a staged write denied off macOS is denied for
    /// ordinary filesystem reasons, which no second attempt improves.
    pub(super) fn replace_contents(
        _target: &Path,
        _bytes: &[u8],
        _before_replace: impl FnOnce() -> io::Result<()>,
    ) -> Result<(), super::ReplaceFailure> {
        Err(super::ReplaceFailure::Failed(io::Error::from(
            io::ErrorKind::Unsupported,
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Unsandboxed, where staging a sibling would have worked anyway — so these pin
    // the module's own contract (does it land the bytes, does a veto hold) and not
    // the sandbox behaviour. The grant case is asserted for real in
    // examples/sandbox_check.rs, phase 8.
    fn scratch(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pudding-replace-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("mkdir");
        dir.join(name)
    }

    #[test]
    fn a_replacement_lands_the_new_contents() {
        let path = scratch("stations.m3u8");
        std::fs::write(&path, "#EXTM3U\n").expect("seed");

        replace_contents_checked(&path, b"#EXTM3U\n#EXTINF:-1,A\nhttp://ex.am/a\n", || Ok(()))
            .map_err(|e| match e {
                ReplaceFailure::Vetoed(e) | ReplaceFailure::Failed(e) => e,
            })
            .expect("replace");

        assert_eq!(
            std::fs::read_to_string(&path).expect("read"),
            "#EXTM3U\n#EXTINF:-1,A\nhttp://ex.am/a\n"
        );
        // Nothing of the staging survives next to the file it replaced.
        let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
            .expect("readdir")
            .filter_map(|e| e.ok().map(|e| e.file_name()))
            .filter(|n| n != "stations.m3u8")
            .collect();
        assert!(leftovers.is_empty(), "staging left {leftovers:?} behind");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_veto_keeps_its_own_error_and_the_old_contents() {
        let path = scratch("vetoed.m3u8");
        std::fs::write(&path, "#EXTM3U\n").expect("seed");

        let failure = replace_contents_checked(&path, b"clobbered\n", || {
            Err(io::Error::other("it changed on disk"))
        })
        .expect_err("the veto must refuse the save");

        match failure {
            ReplaceFailure::Vetoed(e) => assert_eq!(e.to_string(), "it changed on disk"),
            ReplaceFailure::Failed(e) => {
                panic!("a veto was reported as a failure of the replacement: {e}")
            }
        }
        assert_eq!(std::fs::read_to_string(&path).expect("read"), "#EXTM3U\n");
        let _ = std::fs::remove_file(&path);
    }
}
