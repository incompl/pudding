// macOS system Now Playing (Control Center / lock screen / menu-bar widget) and
// hardware media-key handling, via MediaPlayer.framework.
//
// Two halves:
//   * App -> OS: MPNowPlayingInfoCenter carries the current title/artist/album,
//     artwork, duration, and the elapsed-time + playback-rate the OS uses to
//     drive its scrubber. We push at discrete moments (track change, play/pause,
//     seek) and let the OS extrapolate elapsed time between them — no per-tick
//     churn.
//   * OS -> App: MPRemoteCommandCenter handlers for play / pause / toggle /
//     seek / next / previous. Registering these is also what makes Pudding the
//     system "Now Playing" app, which is how the hardware media keys reach it.
//
// The frontend is the single driver of *what to show* (it alone resolves
// titles/art across files, external files, and radio), so metadata + playback
// state arrive through Tauri commands. next/previous have no engine concept, so
// those commands emit "remote-next" / "remote-prev" for the frontend's queue
// logic to handle — the same path a future skip button would use. play / pause /
// seek map straight onto the existing audio engine commands.
//
// Why frontend-driven, with audio.rs deliberately untouched:
//   * The engine only ever sees a path or a URL — its track-changed event is
//     {path, duration}, with no resolved title/artist/art. Pushing good metadata
//     from Rust would mean re-reading tags, re-extracting art, and re-parsing ICY
//     that the frontend already computes for its own now-playing panel. So the
//     frontend, which has the finished card, is the natural source of truth.
//   * Position/rate don't need the engine either: the OS wants elapsed+rate only
//     at discrete moments and extrapolates the rest, and the frontend already
//     receives those events. A play/pause push plus a throttled ~1 Hz refresh is
//     enough — no reaching into the engine's timing.
//   * audio.rs is the real-time, lock-free, gapless hot path where edits risk
//     glitches and races. Now Playing is a cosmetic/control surface; keeping it
//     out of that file trades a duplicated-logic + hot-path-risk design for one
//     webview->Rust IPC hop per (low-frequency) metadata change. Cheap trade.
//
// All MediaPlayer objects are main-thread-only and not Send, so they are never
// stored: every mutation is a snapshot rebuilt on the main thread via
// run_on_main_thread. The only retained state is a Send snapshot behind a Mutex.

use std::sync::Mutex;

use tauri::AppHandle;

/// The last-known now-playing snapshot. Metadata (from the frontend) and
/// playback state (play/pause/seek) merge into one struct so either update
/// rebuilds the full MPNowPlayingInfoCenter dictionary.
#[derive(Default, Clone)]
struct Snapshot {
    title: String,
    artist: Option<String>,
    album: Option<String>,
    /// Decoded image bytes (whatever NSImage can read: PNG/JPEG/…). None when the
    /// source has no art.
    art: Option<Vec<u8>>,
    duration: f64,
    elapsed: f64,
    /// 1.0 while playing, 0.0 while paused. Doubles as the OS scrubber rate.
    rate: f64,
    /// False once nothing is loaded (queue fully ended / stopped).
    has_track: bool,
}

pub struct NowPlaying {
    snap: Mutex<Snapshot>,
}

impl NowPlaying {
    fn new() -> Self {
        Self {
            snap: Mutex::new(Snapshot::default()),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Snapshot> {
        self.snap.lock().unwrap_or_else(|e| e.into_inner())
    }
}

/// Decode a frontend-supplied artwork string — either a `data:` URL or bare
/// base64 — into raw image bytes. Returns None on anything unparseable so a bad
/// image just means "no art" rather than a failure.
fn decode_art(art: Option<String>) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let s = art?;
    let b64 = match s.find("base64,") {
        Some(i) => &s[i + "base64,".len()..],
        None if s.starts_with("data:") => return None, // data URL we can't read
        None => &s[..],                                // assume bare base64
    };
    base64::engine::general_purpose::STANDARD.decode(b64).ok()
}

#[cfg(target_os = "macos")]
mod imp {
    use super::{NowPlaying, Snapshot};
    use std::ptr::NonNull;

    use block2::RcBlock;
    use objc2::rc::Retained;
    use objc2::runtime::{AnyObject, ProtocolObject};
    use objc2::AnyThread;
    use objc2_app_kit::NSImage;
    use objc2_core_foundation::CGSize;
    use objc2_foundation::{NSData, NSMutableDictionary, NSNumber, NSString};
    use objc2_media_player::{
        MPMediaItemArtwork, MPMediaItemPropertyAlbumTitle, MPMediaItemPropertyArtist,
        MPMediaItemPropertyArtwork, MPMediaItemPropertyPlaybackDuration, MPMediaItemPropertyTitle,
        MPNowPlayingInfoCenter, MPNowPlayingInfoPropertyElapsedPlaybackTime,
        MPNowPlayingInfoPropertyPlaybackRate, MPNowPlayingPlaybackState, MPRemoteCommandCenter,
        MPRemoteCommandEvent, MPRemoteCommandHandlerStatus,
    };
    use tauri::{AppHandle, Emitter, Manager};

    use crate::audio;

    /// Register the remote-command handlers once. Adding a handler is what makes
    /// the app eligible as the system Now Playing app (and routes media keys),
    /// so this runs at startup regardless of whether anything is playing yet.
    pub fn install_commands(app: &AppHandle) {
        let app = app.clone();
        let _ = app.clone().run_on_main_thread(move || unsafe {
            let center = MPRemoteCommandCenter::sharedCommandCenter();

            // play / pause are distinct commands from the widget; togglePlayPause
            // covers the keyboard play/pause key. All three funnel to the engine's
            // toggle, using the cached state to no-op when already in the wanted
            // state so a discrete "play" while playing doesn't pause.
            add_handler(&center.playCommand(), &app, |app| {
                if !is_playing(app) {
                    toggle(app);
                }
            });
            add_handler(&center.pauseCommand(), &app, |app| {
                if is_playing(app) {
                    toggle(app);
                }
            });
            add_handler(&center.togglePlayPauseCommand(), &app, |app| toggle(app));

            // next / previous have no engine concept; hand them to the frontend
            // queue logic.
            add_handler(&center.nextTrackCommand(), &app, |app| {
                let _ = app.emit("remote-next", ());
            });
            add_handler(&center.previousTrackCommand(), &app, |app| {
                let _ = app.emit("remote-prev", ());
            });

            // Scrubbing from the widget delivers an absolute target position.
            let pos_cmd = center.changePlaybackPositionCommand();
            pos_cmd.setEnabled(true);
            let handler_app = app.clone();
            let handler = RcBlock::new(move |event: NonNull<MPRemoteCommandEvent>| {
                let event = event.as_ref();
                // Only the change-position command delivers this event subclass.
                let pos_event: &objc2_media_player::MPChangePlaybackPositionCommandEvent =
                    &*(event as *const MPRemoteCommandEvent as *const _);
                let seconds = pos_event.positionTime();
                if let Some(engine) = handler_app.try_state::<audio::AudioEngine>() {
                    engine.send(audio::Command::Seek(seconds));
                }
                MPRemoteCommandHandlerStatus::Success
            });
            pos_cmd.addTargetWithHandler(&handler);
        });
    }

    /// Wire a simple (event-ignoring) action onto a remote command.
    unsafe fn add_handler(
        command: &objc2_media_player::MPRemoteCommand,
        app: &AppHandle,
        action: impl Fn(&AppHandle) + 'static,
    ) {
        command.setEnabled(true);
        let app = app.clone();
        let handler = RcBlock::new(move |_event: NonNull<MPRemoteCommandEvent>| {
            action(&app);
            MPRemoteCommandHandlerStatus::Success
        });
        command.addTargetWithHandler(&handler);
    }

    fn is_playing(app: &AppHandle) -> bool {
        app.try_state::<NowPlaying>()
            .map(|np| np.lock().rate > 0.0)
            .unwrap_or(false)
    }

    fn toggle(app: &AppHandle) {
        if let Some(engine) = app.try_state::<audio::AudioEngine>() {
            engine.send(audio::Command::TogglePause);
        }
    }

    /// Rebuild the info dictionary from a snapshot and push it to the OS. Runs
    /// the MediaPlayer calls on the main thread.
    pub fn push(app: &AppHandle, snap: Snapshot) {
        let _ = app.run_on_main_thread(move || unsafe {
            let center = MPNowPlayingInfoCenter::defaultCenter();

            if !snap.has_track {
                center.setNowPlayingInfo(None);
                center.setPlaybackState(MPNowPlayingPlaybackState::Stopped);
                return;
            }

            let info = NSMutableDictionary::<NSString, AnyObject>::new();
            set_str(&info, MPMediaItemPropertyTitle, &snap.title);
            if let Some(artist) = &snap.artist {
                set_str(&info, MPMediaItemPropertyArtist, artist);
            }
            if let Some(album) = &snap.album {
                set_str(&info, MPMediaItemPropertyAlbumTitle, album);
            }
            if snap.duration > 0.0 {
                set_num(&info, MPMediaItemPropertyPlaybackDuration, snap.duration);
            }
            set_num(
                &info,
                MPNowPlayingInfoPropertyElapsedPlaybackTime,
                snap.elapsed,
            );
            set_num(&info, MPNowPlayingInfoPropertyPlaybackRate, snap.rate);

            if let Some(bytes) = &snap.art {
                if let Some(artwork) = make_artwork(bytes) {
                    let key = ProtocolObject::from_ref(MPMediaItemPropertyArtwork);
                    info.setObject_forKey(&artwork, key);
                }
            }

            center.setNowPlayingInfo(Some(&info));
            center.setPlaybackState(if snap.rate > 0.0 {
                MPNowPlayingPlaybackState::Playing
            } else {
                MPNowPlayingPlaybackState::Paused
            });
        });
    }

    unsafe fn set_str(
        info: &NSMutableDictionary<NSString, AnyObject>,
        key: &NSString,
        value: &str,
    ) {
        let v = NSString::from_str(value);
        let k = ProtocolObject::from_ref(key);
        info.setObject_forKey(&v, k);
    }

    unsafe fn set_num(info: &NSMutableDictionary<NSString, AnyObject>, key: &NSString, value: f64) {
        let v = NSNumber::numberWithDouble(value);
        let k = ProtocolObject::from_ref(key);
        info.setObject_forKey(&v, k);
    }

    /// Build an MPMediaItemArtwork from encoded image bytes. The request handler
    /// hands back the same image for any requested size; returns None if the
    /// bytes don't decode.
    unsafe fn make_artwork(bytes: &[u8]) -> Option<Retained<MPMediaItemArtwork>> {
        let data = NSData::dataWithBytes_length(bytes.as_ptr() as *const _, bytes.len());
        let image = NSImage::initWithData(NSImage::alloc(), &data)?;
        let size = image.size();
        let handler = RcBlock::new(move |_requested: CGSize| -> NonNull<NSImage> {
            // Return a +1 reference; MediaPlayer takes ownership under ARC.
            NonNull::new_unchecked(Retained::into_raw(image.clone()))
        });
        Some(MPMediaItemArtwork::initWithBoundsSize_requestHandler(
            MPMediaItemArtwork::alloc(),
            size,
            &handler,
        ))
    }
}

// === Public API (uniform across platforms; a no-op off macOS) ===

/// Manage the shared snapshot state and, on macOS, register the media-key /
/// remote-command handlers. Call once during setup.
pub fn install(app: &AppHandle) {
    use tauri::Manager;
    app.manage(NowPlaying::new());
    #[cfg(target_os = "macos")]
    imp::install_commands(app);
}

/// Update the displayed track. `art` is a `data:` URL or bare base64, or None.
pub fn set_metadata(
    app: &AppHandle,
    title: String,
    artist: Option<String>,
    album: Option<String>,
    art: Option<String>,
    duration: f64,
) {
    use tauri::Manager;
    let Some(np) = app.try_state::<NowPlaying>() else {
        return;
    };
    let snap = {
        let mut s = np.lock();
        s.title = title;
        s.artist = artist;
        s.album = album;
        s.art = decode_art(art);
        s.duration = duration;
        s.has_track = true;
        s.clone()
    };
    push(app, snap);
}

/// Update play/pause + elapsed position. Called on state changes and after seeks.
pub fn set_playback(app: &AppHandle, playing: bool, elapsed: f64) {
    use tauri::Manager;
    let Some(np) = app.try_state::<NowPlaying>() else {
        return;
    };
    let snap = {
        let mut s = np.lock();
        s.rate = if playing { 1.0 } else { 0.0 };
        s.elapsed = elapsed;
        s.clone()
    };
    push(app, snap);
}

/// Clear the Now Playing entry (nothing loaded).
pub fn clear(app: &AppHandle) {
    use tauri::Manager;
    let Some(np) = app.try_state::<NowPlaying>() else {
        return;
    };
    let snap = {
        let mut s = np.lock();
        *s = Snapshot::default();
        s.clone()
    };
    push(app, snap);
}

#[cfg(target_os = "macos")]
fn push(app: &AppHandle, snap: Snapshot) {
    imp::push(app, snap);
}

#[cfg(not(target_os = "macos"))]
fn push(_app: &AppHandle, _snap: Snapshot) {}
