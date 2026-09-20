// Persistent sandbox access for a file in Open Recent.
//
// A picker or Finder "Open With" event grants a sandbox extension only for this
// run. Recent items outlive the process, so save a security-scoped bookmark when
// the file is opened and resolve it before reopening the item later. Unlike a
// library root, this state deliberately holds only the one item being reopened:
// the audio engine may need the grant after the command returns, while retaining
// every historical recent would waste the process-wide security-scope budget.

use std::sync::Mutex;

use serde::Serialize;
use tauri::State;

use crate::bookmarks::{Bookmark, Error, ScopedAccess};

#[derive(Default)]
pub struct RecentAccess {
    held: Mutex<Option<ScopedAccess>>,
}

/// The location and durable grant to store for a recent item. Bookmark resolution
/// follows moves, so `path` is intentionally allowed to differ from the path the
/// frontend supplied.
#[derive(Serialize)]
pub struct AccessedRecent {
    pub path: String,
    pub bookmark: String,
}

/// Capture the temporary grant the system just handed us. Unsupported platforms
/// do not need a bookmark, so `None` preserves their existing path-only behavior.
#[tauri::command]
pub fn bookmark_recent_item(path: String) -> Result<Option<String>, String> {
    match Bookmark::create(&path) {
        Ok(bookmark) => Ok(Some(bookmark.to_base64())),
        Err(Error::Unsupported) => Ok(None),
        Err(e) => Err(format!("Couldn't retain access to this file: {}", e)),
    }
}

/// Reopen a persisted recent item and hold its grant for the file's active use.
/// No caller invokes this during hydration: resolving a bookmark can touch a
/// sleeping volume, and an unavailable item is still useful history rather than
/// something to silently discard.
#[tauri::command]
pub fn resolve_recent_item(
    bookmark: String,
    access: State<RecentAccess>,
) -> Result<AccessedRecent, String> {
    let bookmark = Bookmark::from_base64(&bookmark).ok_or_else(|| {
        "Couldn't reopen this recent file because its saved permission is invalid.".to_string()
    })?;
    let scoped = bookmark
        .resolve()
        .map_err(|e| format!("Couldn't reopen this recent file: {}", e))?;
    let path = scoped.path().to_string_lossy().into_owned();

    // A stale bookmark still works today, but refreshing it now avoids a later
    // surprise. Keep the old blob if refresh fails: losing a usable grant would
    // turn a recoverable condition into a permanent reauthorization request.
    let stored_bookmark = if scoped.is_stale() {
        match Bookmark::create(&path) {
            Ok(fresh) => fresh.to_base64(),
            Err(e) => {
                log::warn!("could not refresh recent-file bookmark {}: {}", path, e);
                bookmark.to_base64()
            }
        }
    } else {
        bookmark.to_base64()
    };

    let previous = std::mem::replace(
        &mut *access.held.lock().map_err(|e| e.to_string())?,
        Some(scoped),
    );
    drop(previous);

    Ok(AccessedRecent {
        path,
        bookmark: stored_bookmark,
    })
}
