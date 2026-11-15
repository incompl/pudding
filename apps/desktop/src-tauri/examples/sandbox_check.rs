// The sandboxed half of tools/sandbox-check.sh. Run by that script only — it needs
// to be inside a signed .app with sandbox entitlements to mean anything, and it
// reads its paths from the environment the script sets up.
//
// Phases, run as separate processes so that "the grant survived a relaunch" is
// actually being tested rather than assumed:
//
//   deny     $PUDDING_UNGRANTED_DIR/secret.txt must fail with PermissionDenied.
//   create   bookmark $PUDDING_GRANTED_DIR and persist the blob into the app
//            container (never into the granted directory — that becomes
//            unreadable in phase 3 and the blob would go with it).
//   resolve  read the blob back, hold the root, and read a file through the grant.
//   bookmark-file  freeze a grant on one FILE under that directory, and persist it.
//   save     with the directory denied again, resolve that file bookmark alone and
//            write to it through the shipping save path.
//   socket   where tauri-plugin-single-instance's rendezvous socket can live.
//   network  connect to $PUDDING_PROBE_ADDR, expecting $PUDDING_EXPECT_NET.
//
// The deny phase distinguishes PermissionDenied from NotFound on purpose. A probe
// that accepts any error passes for free against a mistyped path, and then the
// whole run proves nothing at all.
//
// This drives root_access rather than bookmarks directly — the same two entry
// points the app itself uses, `bookmark_root` at the picker and `RootAccess::hold`
// at startup — so what passes here is the shipping path and not a parallel one
// written to be testable.

use pudding_lib::bookmarks::Bookmark;
use pudding_lib::root_access::{bookmark_root, RootAccess, StoredRoot};
use std::io::ErrorKind;
use std::net::TcpStream;
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::PathBuf;
use std::process::exit;

fn env_dir(key: &str) -> PathBuf {
    PathBuf::from(env_var(key))
}

fn env_var(key: &str) -> String {
    std::env::var(key)
        .unwrap_or_else(|_| fail(&format!("{} is not set — run tools/sandbox-check.sh", key)))
}

fn fail(msg: &str) -> ! {
    eprintln!("  FAIL: {}", msg);
    exit(1);
}

/// Where the bookmark blob lives between phases. Inside the sandbox $HOME is the
/// app container, which stays readable no matter which entitlements are stripped.
fn blob_path() -> PathBuf {
    container().join("sandbox-check.bookmark")
}

/// The file bookmark's blob, kept apart from the directory's so the save phase
/// cannot pass by accidentally resolving a grant on the whole folder.
fn file_blob_path() -> PathBuf {
    container().join("sandbox-check.file-bookmark")
}

fn container() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| fail("HOME is not set"));
    PathBuf::from(home)
}

fn phase_deny() {
    let probe = env_dir("PUDDING_UNGRANTED_DIR").join("secret.txt");
    match std::fs::read_to_string(&probe) {
        Ok(_) => fail(&format!(
            "read {} — the sandbox is not enforcing, so nothing else here proves anything",
            probe.display()
        )),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            println!("  ok: {} is denied", probe.display());
        }
        Err(e) if e.kind() == ErrorKind::NotFound => fail(&format!(
            "{} does not exist — the probe path is wrong, so this check would have \
             passed for the wrong reason",
            probe.display()
        )),
        Err(e) => fail(&format!("unexpected error on {}: {e}", probe.display())),
    }
}

fn phase_create() {
    let granted = env_dir("PUDDING_GRANTED_DIR");

    // Sanity: we must actually be able to reach it right now, or the bookmark we
    // freeze is a bookmark to a denial.
    if let Err(e) = std::fs::read_to_string(granted.join("canary.txt")) {
        fail(&format!(
            "cannot read the granted dir before bookmarking it ({e}) — the music \
             entitlement is missing or the path is outside ~/Music"
        ));
    }

    // Exactly what browseLibraryRoot does the moment the picker returns.
    let Some(blob) = bookmark_root(granted.to_string_lossy().into_owned()) else {
        fail("bookmark_root returned nothing — the grant could not be frozen");
    };
    if let Err(e) = std::fs::write(blob_path(), &blob) {
        fail(&format!("persisting the blob to the container: {e}"));
    }
    println!(
        "  ok: bookmarked {} ({} base64 chars), blob in the container",
        granted.display(),
        blob.len()
    );
}

fn phase_resolve() {
    let blob = std::fs::read_to_string(blob_path())
        .unwrap_or_else(|e| fail(&format!("reading the persisted blob: {e}")));
    // The stored path is deliberately the one from before: in the app this comes
    // out of settings.json, and holding it is what has to make it readable again.
    let stored = env_dir("PUDDING_GRANTED_DIR")
        .to_string_lossy()
        .into_owned();

    let access = RootAccess::default();
    let held = access
        .hold(vec![StoredRoot {
            path: stored,
            bookmark: Some(blob.trim().to_string()),
        }])
        .unwrap_or_else(|e| fail(&format!("hold: {e}")));

    let root = &held[0];
    if let Some(e) = &root.error {
        fail(&format!("hold reported the root unreachable: {e}"));
    }
    if root.bookmark.is_some() {
        println!("  note: a refreshed blob came back (stale or moved) — app re-persists");
    }

    let canary = PathBuf::from(&root.path).join("canary.txt");
    match std::fs::read_to_string(&canary) {
        Ok(s) if s.trim() == "hello-from-the-test" => {
            println!(
                "  ok: read {} through the held grant alone",
                canary.display()
            );
        }
        Ok(s) => fail(&format!("canary has unexpected contents: {s:?}")),
        Err(e) => fail(&format!("held {} but could not read it: {e}", root.path)),
    }

    // Prove the grant is load-bearing rather than incidental: releasing every root
    // must put the path back out of reach. If this still succeeds, access is coming
    // from somewhere else and the bookmark was never what granted it. This is also
    // the exact teardown a roots change performs, so it is worth knowing it works —
    // a root the user removes must actually lose access.
    let path = PathBuf::from(&root.path);
    drop(access);
    match std::fs::read_to_string(path.join("canary.txt")) {
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            println!("  ok: access ended when the roots were released");
        }
        Ok(_) => fail(
            "still readable after release — access is coming from somewhere \
             other than the bookmark",
        ),
        Err(e) => fail(&format!("unexpected error after release: {e}")),
    }
}

/// Freeze a grant on ONE FILE, the way browseStreamListPath does the moment the
/// file picker returns. Runs while the music entitlement still reaches the folder,
/// because that is what stands in for the picker here.
fn phase_bookmark_file() {
    let file = env_var("PUDDING_GRANTED_FILE");
    if let Err(e) = std::fs::read_to_string(&file) {
        fail(&format!(
            "cannot read {file} before bookmarking it ({e}) — the probe file is \
             missing or outside ~/Music"
        ));
    }
    let Some(blob) = bookmark_root(file.clone()) else {
        fail("bookmarking the file returned nothing — the grant could not be frozen");
    };
    if let Err(e) = std::fs::write(file_blob_path(), &blob) {
        fail(&format!("persisting the file blob to the container: {e}"));
    }
    println!("  ok: bookmarked the file {file}");
}

/// Saving into a file the sandbox grants while its FOLDER is denied.
///
/// This is the case a stream list parked outside the container actually lands in,
/// and the one that cannot be reproduced unsandboxed or by granting a folder: the
/// picker extends the sandbox to the chosen file and nothing around it. Three
/// things are asserted, and the middle one is what keeps the other two honest:
///
///   * the file itself reads through the bookmark alone;
///   * staging a sibling next to it — what write_atomic does first, and all it
///     ever did — is DENIED, so the fallback below is not passing for free;
///   * write_durably still lands the new bytes, via the system's atomic
///     replacement (item_replace.rs).
///
/// Deliberately the shipping entry point rather than replace_contents directly:
/// what has to be true is that a station edit saves, and that runs through
/// write_durably's denial check, its fallback, and its error mapping.
fn phase_save() {
    let blob = std::fs::read_to_string(file_blob_path())
        .unwrap_or_else(|e| fail(&format!("reading the persisted file blob: {e}")));
    let bookmark = Bookmark::from_base64(blob.trim())
        .unwrap_or_else(|| fail("the persisted file blob is not a bookmark"));
    let access = bookmark
        .resolve()
        .unwrap_or_else(|e| fail(&format!("resolving the file bookmark: {e}")));
    let path = access.path().to_path_buf();

    let before = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        fail(&format!(
            "reading {} through the grant: {e}",
            path.display()
        ))
    });
    println!(
        "  ok: read the file through its own bookmark ({} bytes)",
        before.len()
    );

    // The first syscall write_atomic makes, in isolation. If the folder lets this
    // through, the grant is wider than a picked file's and the save below would
    // prove nothing about the case this phase exists for.
    let sibling = path.with_file_name(".sandbox-check-sibling");
    match std::fs::write(&sibling, b"x") {
        Ok(()) => {
            let _ = std::fs::remove_file(&sibling);
            fail(&format!(
                "staged a sibling at {} — the folder is reachable, so this phase \
                 says nothing about a file-only grant",
                sibling.display()
            ));
        }
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            println!("  ok: staging a sibling in the same folder is denied");
        }
        Err(e) => fail(&format!(
            "staging a sibling failed as {:?} rather than PermissionDenied — this \
             would pass for the wrong reason",
            e.kind()
        )),
    }

    let body = "#EXTM3U\n#EXTINF:-1,Saved under the sandbox\nhttp://example.invalid/s\n";
    if let Err(e) = pudding_lib::write_durably(&path, body.as_bytes()) {
        fail(&format!(
            "write_durably could not save through the file grant alone: {e} — a \
             stream list outside the container is readable but not editable"
        ));
    }
    match std::fs::read_to_string(&path) {
        Ok(after) if after == body => {
            println!("  ok: write_durably replaced the file through the grant alone");
        }
        Ok(after) => fail(&format!(
            "the save reported success but the file holds {after:?}"
        )),
        // Worth distinguishing: the replacement lands a new inode, and if the
        // sandbox extension did not follow the name, the app would save once and
        // then lose the file it is editing.
        Err(e) => fail(&format!(
            "saved, but the file is no longer readable ({e}) — the grant did not \
             survive the replacement"
        )),
    }

    // The validated form, which every playlist save uses. The check has to keep its
    // veto inside the fallback: it is the only thing standing between a slow save
    // and an edit that landed underneath it, and a fallback that published anyway
    // would clobber the file rather than report a conflict.
    let refused = pudding_lib::write_durably_checked(&path, b"clobbered\n", || {
        Err(std::io::Error::other("a conflicting edit landed"))
    });
    match refused {
        Ok(()) => fail("the check was ignored — a conflicting save would overwrite the file"),
        Err(e) if e.to_string().contains("a conflicting edit landed") => {
            println!("  ok: a refusing check still vetoes the replacement");
        }
        Err(e) => fail(&format!(
            "refused, but as {e} rather than the check's own error — the conflict \
             would reach the user as a permissions problem"
        )),
    }
    match std::fs::read_to_string(&path) {
        Ok(after) if after == body => println!("  ok: the vetoed save left the file untouched"),
        Ok(after) => fail(&format!(
            "the vetoed save still changed the file: {after:?}"
        )),
        Err(e) => fail(&format!("the file is gone after a vetoed save: {e}")),
    }

    // And once more with a check that passes, since a veto that always fires would
    // satisfy the assertion above while making every save impossible.
    let second = "#EXTM3U\n#EXTINF:-1,Saved again\nhttp://example.invalid/t\n";
    if let Err(e) = pudding_lib::write_durably_checked(&path, second.as_bytes(), || Ok(())) {
        fail(&format!(
            "a validated save through the file grant failed: {e}"
        ));
    }
    match std::fs::read_to_string(&path) {
        Ok(after) if after == second => println!("  ok: a passing check saves through the grant"),
        Ok(after) => fail(&format!("the validated save left {after:?}")),
        Err(e) => fail(&format!("unreadable after the validated save: {e}")),
    }
}

/// What the sandbox does to the single-instance plugin.
///
/// The plugin puts its rendezvous socket in /tmp, which a sandboxed process cannot
/// write. Two things have to be true for that to be merely inert rather than fatal,
/// and both are asserted here:
///
///   * connect() must never succeed. On success the plugin hands off its argv and
///     calls exit(0) — under the sandbox that would be a launch that silently does
///     nothing, which is the one outcome that matters.
///   * bind() fails, so the plugin logs and launches normally. The container's own
///     tmp is checked alongside it because that is where the socket would have to
///     move to bring single-instance back: every instance of a sandboxed app shares
///     one container, so no app group is needed for the same-app case.
///
/// The two use different /tmp paths on purpose. The connect probe wants the real
/// socket, and is only strengthened if a `tauri dev` run left one lying there. The
/// bind probe wants a name that provably does not exist yet: a leftover socket makes
/// bind fail with AddrInUse, which is not the denial being tested, and the sandbox
/// will not let this process unlink it to find out.
fn phase_socket() {
    // Passed in rather than hardcoded: the script derives it from the real bundle
    // identifier in tauri.conf.json the same way the plugin does, so renaming the
    // app cannot leave this probing a path nothing would ever use.
    let plugin_path = env_var("PUDDING_SI_SOCKET");
    let fresh_path = env_var("PUDDING_SI_SOCKET_FRESH");

    match UnixStream::connect(&plugin_path) {
        Ok(_) => fail(&format!(
            "connected to {plugin_path} — the plugin would hand off and exit(0), so a \
             sandboxed launch would silently do nothing"
        )),
        Err(e) => println!("  ok: connect to the plugin socket fails ({:?})", e.kind()),
    }

    match UnixListener::bind(&fresh_path) {
        Ok(_) => fail(&format!(
            "bound {fresh_path} — /tmp is writable, so this check is not running \
             under a sandbox at all"
        )),
        Err(e) if e.kind() == ErrorKind::PermissionDenied => {
            println!("  ok: bind in /tmp is denied — single-instance is inert, by design");
        }
        Err(e) => fail(&format!("unexpected error binding {fresh_path}: {e}")),
    }

    // Where it would have to go instead. Kept as an assertion rather than a note so
    // that if single-instance is ever wanted under the sandbox, the path is known to
    // work rather than guessed at.
    let container = std::env::temp_dir().join("single-instance-probe.sock");
    let _ = std::fs::remove_file(&container);
    match UnixListener::bind(&container) {
        Ok(_) => println!(
            "  ok: the container's tmp accepts a socket ({})",
            container.display()
        ),
        Err(e) => fail(&format!(
            "the container tmp rejected a socket too ({e}) — there is nowhere for a \
             sandboxed rendezvous socket to live"
        )),
    }
    let _ = std::fs::remove_file(&container);
}

/// Whether com.apple.security.network.client is load-bearing.
///
/// The target is a plain loopback listener the script starts outside the sandbox,
/// not a real host: the entitlement gates loopback exactly as it gates the internet,
/// so this proves the same thing without making the check depend on a network.
fn phase_network() {
    let addr = env_var("PUDDING_PROBE_ADDR");
    let expect = env_var("PUDDING_EXPECT_NET");
    let result = TcpStream::connect(&addr);

    match (expect.as_str(), result) {
        ("allow", Ok(_)) => println!("  ok: connected to {addr} with network.client"),
        ("allow", Err(e)) => fail(&format!(
            "could not connect to {addr} despite network.client ({e}) — the radio \
             streams would not play"
        )),
        ("deny", Err(e)) if e.kind() == ErrorKind::PermissionDenied => {
            println!("  ok: {addr} is denied without network.client");
        }
        ("deny", Ok(_)) => fail(&format!(
            "connected to {addr} without network.client — the sandbox is not gating \
             the network, so granting the entitlement proves nothing"
        )),
        ("deny", Err(e)) => fail(&format!(
            "connect to {addr} failed, but as {:?} rather than PermissionDenied — the \
             listener is probably not running, so this would pass for the wrong reason",
            e.kind()
        )),
        (other, _) => fail(&format!(
            "PUDDING_EXPECT_NET must be allow|deny, got {other:?}"
        )),
    }
}

fn main() {
    match std::env::args().nth(1).as_deref() {
        Some("deny") => phase_deny(),
        Some("create") => phase_create(),
        Some("resolve") => phase_resolve(),
        Some("bookmark-file") => phase_bookmark_file(),
        Some("save") => phase_save(),
        Some("socket") => phase_socket(),
        Some("network") => phase_network(),
        other => fail(&format!(
            "expected deny|create|resolve|bookmark-file|save|socket|network, got {:?}",
            other.unwrap_or("nothing")
        )),
    }
}
