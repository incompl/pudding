// Noticing that a volume came or went.
//
// Everything downstream of a library root already copes with the folder being
// unreachable: the scan carries the rows it could not walk through the prune
// untouched (see preserve_unreadable), the tree lists the root as invalid, the
// decode thread errors on the file. What was missing was *being told*. Eject an
// external while Pudding is running and nothing in the app changed — the Settings
// row stayed black, the Files tree kept drawing the folders it had, and the dead
// watcher did not come back when the drive did.
//
// The filesystem watcher cannot answer this. notify builds its FSEvents stream
// without kFSEventStreamCreateFlagWatchRoot, so nothing is reported *about* the
// watched root itself — and a stream whose device has left has nothing to report
// anyway. Polling is the other obvious answer, and it is the wrong one here: the
// stat that would detect an unreachable network share is exactly the call that
// blocks on one.
//
// So: one NSWorkspace observer, which is the push notification macOS offers for
// this, and one event out to the frontend.
//
// Deliberately payload-free, though the notification does carry the volume's URL.
// Prefix-matching that URL against the configured roots would be wrong twice over
// — for a root reached through a symlink, and for a share that comes back at a
// different mount point — and it answers a question nobody asked. The frontend
// re-tests the roots it actually has, and acts only when that answer changed.

use tauri::AppHandle;

/// Emitted when any volume mounts, unmounts, or is renamed — not only one a
/// library root sits on. Carries no payload: see the module comment.
pub const EVENT: &str = "volumes-changed";

/// Start watching for volume changes, for the lifetime of the app.
#[cfg(target_os = "macos")]
pub fn install(app: &AppHandle) {
    imp::install(app);
}

#[cfg(not(target_os = "macos"))]
pub fn install(_app: &AppHandle) {
    // No equivalent push notification wired up elsewhere. The frontend's
    // re-check on window focus still covers a drive that came or went.
}

#[cfg(target_os = "macos")]
mod imp {
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2_app_kit::{
        NSWorkspace, NSWorkspaceDidMountNotification, NSWorkspaceDidRenameVolumeNotification,
        NSWorkspaceDidUnmountNotification,
    };
    use objc2_foundation::NSNotification;
    use tauri::{AppHandle, Emitter};

    pub fn install(app: &AppHandle) {
        let app = app.clone();
        // NSWorkspace and its notification center are main-thread objects. Setup,
        // where this is called from, already runs there — the hop is so that stays
        // true of whatever calls it next.
        let _ = app.clone().run_on_main_thread(move || unsafe {
            let center = NSWorkspace::sharedWorkspace().notificationCenter();
            // A rename moves the mount point, which is the same event as far as
            // the roots are concerned: the old path stops existing.
            for name in [
                NSWorkspaceDidMountNotification,
                NSWorkspaceDidUnmountNotification,
                NSWorkspaceDidRenameVolumeNotification,
            ] {
                let app = app.clone();
                let block = RcBlock::new(move |_: NonNull<NSNotification>| {
                    let _ = app.emit(super::EVENT, ());
                });
                // nil queue: the block runs on the thread that posted, which for
                // NSWorkspace is the main thread. Nothing in it touches AppKit,
                // and emit is safe from anywhere regardless.
                let token = center.addObserverForName_object_queue_usingBlock(
                    Some(name),
                    None,
                    None,
                    &block,
                );
                // The token is only good for removeObserver:, and these observers
                // live as long as the process does — there is nothing to pair a
                // removal with. Leaked rather than dropped so the registration's
                // lifetime does not rest on the notification center's own
                // reference to it, which is an implementation detail and not a
                // documented guarantee.
                std::mem::forget(token);
            }
        });
    }
}
