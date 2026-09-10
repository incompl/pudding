// Cloud files whose bytes are not on this Mac yet.
//
// A file provider (iCloud Drive, Proton Drive, Dropbox) can leave a file's
// metadata on disk with none of its data: `stat` reports the real size and sets
// the `dataless` flag, and st_blocks is 0. Nothing about the path says so, and
// `File::open` succeeds — it is the first `read()` that blocks in the kernel
// while the provider downloads the file. The *whole* file: reading one byte of a
// 1.1 MB sample materialized all of it, and the wait scales with size (measured
// against a Proton Drive root: ~0.3s fixed + ~220 KB/s, so ~5s for 1 MB and ~37s
// for an 8 MB track, with no timeout of any kind).
//
// Two threads must never pay that:
//
//   * The scanner, which reads tags from every file it walks. Blocking there
//     costs half an hour on a folder of a thousand cloud files — and quietly
//     downloads the user's entire library to read four tags out of each file.
//   * The decode thread, which is also the transport's command loop (see the
//     `try_recv` drain in audio.rs). A read that blocks there is not just late
//     audio: Pause, Next and Stop stop being processed for the duration, and
//     since the ring buffer holds one second, the track currently *playing* cuts
//     to silence while the decoder waits on the next one.
//
// Both call `never_materialize_on_this_thread`, after which a dataless read
// fails immediately with EDEADLK instead of downloading. The download a user
// actually asked for then happens on a thread that has *not* called it — see
// audio.rs's fetch thread — where blocking is the entire point and nothing else
// is waiting on it.

#[cfg(target_os = "macos")]
mod imp {
    use std::path::Path;

    // <sys/resource.h>. Absent from the libc crate, and three integers do not
    // earn a dependency.
    const IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES: libc::c_int = 3;
    const IOPOL_SCOPE_THREAD: libc::c_int = 1;
    const IOPOL_MATERIALIZE_DATALESS_FILES_OFF: libc::c_int = 1;

    // <sys/stat.h>. The flag the provider stamps on a file it has not fetched.
    // Preferred over the st_blocks == 0 test it replaces: a sparse local file is
    // also zero-blocks, and calling that "not downloaded" would be a lie the UI
    // then repeats to the user.
    const SF_DATALESS: u32 = 0x4000_0000;

    extern "C" {
        fn setiopolicy_np(iotype: libc::c_int, scope: libc::c_int, policy: libc::c_int)
            -> libc::c_int;
        // Only the test below reads the policy back; declaring it unconditionally
        // would be an unused item in every real build.
        #[cfg(test)]
        fn getiopolicy_np(iotype: libc::c_int, scope: libc::c_int) -> libc::c_int;
    }

    /// What this thread's policy actually is. Only the test reads it — but it is
    /// the one thing worth asserting, since a wrong constant or a bad extern
    /// declaration fails silently as "the download is back".
    #[cfg(test)]
    pub fn materializes_on_this_thread() -> bool {
        let p = unsafe {
            getiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
            )
        };
        p & IOPOL_MATERIALIZE_DATALESS_FILES_OFF == 0
    }

    pub fn never_materialize_on_this_thread() {
        // Thread scope, so this is a property of the caller alone and cannot
        // leak into the fetch thread or anything spawned later.
        let rc = unsafe {
            setiopolicy_np(
                IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES,
                IOPOL_SCOPE_THREAD,
                IOPOL_MATERIALIZE_DATALESS_FILES_OFF,
            )
        };
        if rc != 0 {
            // Not fatal: the thread falls back to the old blocking behaviour,
            // which is slow rather than wrong. Logged because the difference
            // between "fast" and "wedged for half an hour" should not be silent.
            log::warn!(
                "could not opt this thread out of materializing cloud files: {}",
                std::io::Error::last_os_error()
            );
        }
    }

    /// For callers that already hold a `stat` — asking twice for one flag is
    /// wasteful where a list is being built a row at a time.
    pub fn is_dataless(meta: &std::fs::Metadata) -> bool {
        use std::os::macos::fs::MetadataExt;
        meta.st_flags() & SF_DATALESS != 0
    }

    /// Follows symlinks, like every other metadata read in the scanner and the
    /// engine. A path that cannot be stat'd is not dataless — it is missing,
    /// which is a different state with a different answer in the UI.
    pub fn path_is_dataless(path: &Path) -> bool {
        std::fs::metadata(path).map(|m| is_dataless(&m)).unwrap_or(false)
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::path::Path;

    // No file-provider dataless concept to opt out of: a file is on disk or it
    // is not there at all, which the existing "missing" path already covers.
    pub fn never_materialize_on_this_thread() {}
    pub fn is_dataless(_meta: &std::fs::Metadata) -> bool {
        false
    }
    pub fn path_is_dataless(_path: &Path) -> bool {
        false
    }
}

pub use imp::{is_dataless, never_materialize_on_this_thread, path_is_dataless};

/// Pull a cloud file's bytes down, by doing the one thing that triggers it: a
/// read. Only meaningful on a thread that has NOT opted out above — on an
/// opted-out thread this is precisely the error that says "not downloaded".
///
/// One byte is enough. The provider materializes the whole file before the first
/// read returns, so there is nothing to be gained by reading further, and the
/// caller reopens the finished file through the normal path anyway.
pub fn materialize(path: &std::path::Path) -> std::io::Result<()> {
    use std::io::Read;
    let mut buf = [0u8; 1];
    let mut file = std::fs::File::open(path)?;
    match file.read(&mut buf) {
        // A zero-length file reads 0 bytes and is already as materialized as it
        // will ever get; that is not a failure.
        Ok(_) => Ok(()),
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_local_file_is_not_dataless() {
        let path = std::env::temp_dir().join("pudding-dataless-probe");
        std::fs::write(&path, b"hello").expect("write");
        assert!(!path_is_dataless(&path));
        materialize(&path).expect("materialize a local file is a no-op that succeeds");
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_missing_file_is_not_dataless() {
        // Distinct states with distinct UI: "not downloaded" is a file we can
        // see and could fetch, "missing" is one that is not there. A stat that
        // fails must never come back as the former.
        let path = std::env::temp_dir().join("pudding-no-such-file-4a1c9e7d");
        assert!(!path_is_dataless(&path));
        assert!(materialize(&path).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn opting_out_takes_effect_and_leaves_ordinary_reads_alone() {
        // Read the policy back rather than trusting the call: a wrong constant
        // or a bad extern declaration would fail silently, and the symptom —
        // the scanner downloading a cloud library again — is exactly the bug
        // this module exists to prevent, only now with a test claiming it can't
        // happen. The second half guards the other direction: the scanner does
        // thousands of ordinary local reads on this same thread.
        assert!(
            imp::materializes_on_this_thread(),
            "a fresh thread should start on the default policy"
        );
        never_materialize_on_this_thread();
        assert!(
            !imp::materializes_on_this_thread(),
            "the thread should now refuse to download cloud files"
        );

        let path = std::env::temp_dir().join("pudding-dataless-after-optout");
        std::fs::write(&path, b"still readable").expect("write");
        assert_eq!(std::fs::read(&path).expect("read").len(), 14);
        let _ = std::fs::remove_file(&path);
    }
}
