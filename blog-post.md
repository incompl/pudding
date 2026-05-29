# Debugging a silent-after-idle bug in a Tauri music player

Draft / working notes — chronological history of an ongoing debugging session, intended as the source material for a real post later.

## The app

Pudding is a small Tauri 2 + WKWebView music player I've been building. The gapless engine ([src/audio-engine.ts](src/audio-engine.ts)) landed in May (`1b8b381 — gapless playback (new engine)`). It uses the Web Audio API: fetch the MP3 bytes, `decodeAudioData` to a Float32 PCM buffer, schedule each track at the exact `ctx.currentTime` of the previous track's boundary so there's zero gap between tracks. Web Audio is the right tool for that — you can't get sample-accurate gapless from `<audio>` elements alone.

## The bug

A user report, in spirit: "when I let playback end naturally, leave the app alone for a long time, then come back and click play on a new track, no audio. The UI thinks it's playing. Hard restart fixes it."

Hours-of-idle reproduction. Not deterministic. Easy to miss in dev because dev sessions are short.

## Day 0: a rule

> "I don't want you to try to speculate what the bug might be. I want you to consider a good logging solution so i can look at the logs and diagnose what is happening when the bug appears."

This turned out to be the most useful constraint of the whole investigation. Every time I caught myself drifting toward "what if it's X", I instead asked "what would the log show if it were X?" and added the instrumentation, not the fix.

## Layer 1: getting any logs at all

The first problem with a heisenbug-after-hours is that you can't watch devtools for hours. So the first work was log infrastructure, not the bug itself.

- Added [`tauri-plugin-log`](https://github.com/tauri-apps/plugins-workspace/tree/v2/plugins/log) to the Rust side ([src-tauri/Cargo.toml](src-tauri/Cargo.toml)).
- Added `@tauri-apps/plugin-log` to the JS side and a tiny `alog/awarn/aerr` wrapper that funnels diagnostics to disk and the console at once ([src/audio-engine.ts](src/audio-engine.ts)).
- Configured rotation: `Target::new(TargetKind::LogDir { … })`, 8 MB per file, `RotationStrategy::KeepAll`, and a 7-day prune in `setup()` ([src-tauri/src/lib.rs](src-tauri/src/lib.rs)) so disk doesn't accumulate forever.
- Added `"log:default"` to the capability ([src-tauri/capabilities/default.json](src-tauri/capabilities/default.json)).

No flag-guarding. The user explicitly accepted the disk cost in exchange for not having to remember to enable logging when the bug fires.

## Layer 2: state-transition logging

What's true at any given moment in the audio graph? The hypothesis space was huge so we logged everything that could conceivably matter, every time it could conceivably change:

- `play()`, `togglePause()`, `seekTo()`, `stop()` — entry log with ctx state.
- `ctx.statechange` — every transition through `running` / `suspended` / `interrupted` / `closed`.
- `visibilitychange` — WKWebView throttles JS timers when the window is hidden, so we want to know when that started and stopped.
- `navigator.mediaDevices.devicechange` — audio routing changes (Bluetooth pair/unpair, AirPods sleep) were a prime suspect.
- 30-second heartbeat with full state snapshot: ctx state, currentTime, current path, position, decode generation, visibility.
- Per-event output snapshot: gain value, destination channel count, sinkId.

This was the first build the user actually shipped to themselves and lived with.

## Layer 3: measuring the silence

State transitions tell you when something happened. They don't tell you whether audio is *actually flowing* through the graph. The next instrumentation answered "is the engine producing signal right now?"

- Added an `AnalyserNode` tapped in parallel with the destination:

```ts
gain.connect(ctx.destination);
gain.connect(analyser);   // dead-end branch
```

- A small RMS helper reads `getFloatTimeDomainData` and computes `sqrt(mean(s²))` over the most recent `fftSize` samples.
- The RMS is included in every `play.started`, `ctx.statechange`, and heartbeat log.
- A `play.rmsCheck+250ms` callback samples RMS 250 ms after each play starts — by then any music track should reliably show RMS > 0.

The point: when the bug fires, the RMS reading distinguishes *graph-side silence* (RMS ≈ 0 — the engine is dead) from *OS-side silence* (RMS > 0, the user still hears nothing — the routing layer is the problem).

This would turn out to be the most important diagnostic in the whole investigation, and also the one that misled us most.

## Layer 4: who am I

Two more lightweight markers that paid off:

- `SESSION_ID`: a `crypto.randomUUID().slice(0,8)` generated once per JS module evaluation, stamped on every log line. Same `sid` across two log lines means same JS execution context. Different `sid` means the WebView re-evaluated the bundle (a background reload, navigation, whatever).
- `app.boot version=… pid=…`: emitted from Rust `setup()` exactly once per process start.

The four-way grid these enable:

| `app.boot` between two events? | `sid` changed? | What happened |
|---|---|---|
| no | no | normal continuous session |
| no | yes | WebView reloaded JS (process survived) |
| yes | yes | full app relaunch |
| yes | no | (impossible — a fresh Rust process can't share a JS module) |

You can answer "did the page reload silently?" instantly from any reproduction.

## First reproduction: ambiguity

The user hit the bug. The log showed RMS ≈ 0.00026 for a play of "Coat Hangers" after a long idle. RMS = 0 means graph-side silence — the AnalyserNode was reading nothing coming out of the gain node.

Except. The next play (immediately after) showed RMS ≈ 0.048 — quiet but real. The user said *both* were silent. The data and the user disagreed.

We added more instrumentation rather than guess:

- `bufferSampleSum` — sum |sample| over the first 1024 samples of the decoded buffer, logged in `play.decoded`. Confirms `decodeAudioData` produced real PCM and not a dead buffer.
- Multi-offset RMS checks: +250 / +500 / +1000 / +3000 ms after `play.started`. Distinguishes "silent at start, recovers" from "permanently dead".
- `ctx.getOutputTimestamp()` on every heartbeat — comparing `contextTime` delta to wall-clock delta tells us if the audio clock is frozen under a context that still reports "running".
- Source counters: every `source.start()` bumps `sourcesStarted`, every `onended` bumps `sourcesEnded`. If sources start but never end, that's a clue.
- A Rust-side power heartbeat thread: every 60 s the Rust process logs a tick; if `SystemTime` advanced way more than the thread slept for, the OS suspended us and we emit `power.resumed gap_seconds=N`. Not subject to WKWebView's hidden-page timer throttling.

## A real reproduction, finally

Second time the user hit it, the log told a clear story:

```
play.decoded   sampleSum=0
play.rmsCheck+250ms   rms=0.00336
play.rmsCheck+1000ms  rms=0.0000127
```

`sampleSum=0` was the loud signal. I went to the actual file with macOS's `afconvert` + Python and confirmed: the track ("tunng — Sixes") **does** have a ~1.5 second of effectively silent intro. False alarm.

But the user had seeked to position 47.8 s — well into the loud part of the song — and still heard nothing. The heartbeat captured right after pause showed RMS = 0.0033 at position 50.04 s, where the file is full-volume. The engine was producing essentially nothing where the file has loud audio. That's the bug, not the file.

Verified Coat Hangers the same way: file has 34,000 nonzero samples in the first second. The earlier RMS = 0.00026 reading was the real bug, not file content. The next play "happening to work" was a coincidence of which `idleMs` had elapsed.

## A nasty diagnostic bug of my own

We were tracking `lastPlaybackAt` for an idle gate. To keep it fresh during long tracks, the heartbeat updated it whenever RMS > 0.0001. Problem: when the ctx is *suspended*, the AnalyserNode's ring buffer still holds the last samples before suspension. So during a long pause, every heartbeat read stale-but-loud audio and bumped `lastPlaybackAt`. The idle gate never tripped.

Fix:

```ts
if (ctx?.state === "running" && typeof rms === "number" && rms > 0.0001) {
  this.lastPlaybackAt = now;
}
```

Lesson: telemetry that drives behavior needs to be checked for the same edge cases that any other dependency would be.

## Mode 1 vs Mode 2

By this point we had clean reproductions of two distinct failure shapes:

| Mode | Signature | Smoking gun |
|---|---|---|
| **1** "graph dead" | RMS ≈ 0 with ctx reporting "running" | First post-restart Coat Hangers play, RMS = 0.0003 |
| **2** "OS muted" | RMS at music-volume levels, but user hears nothing | Down to the Graveyard after long idle, RMS = 0.19–0.36, user heard silence |

Mode 1 is detectable from inside the app. Mode 2 isn't — the AnalyserNode tap is upstream of the OS routing layer, so by definition it can't see what the OS does (or doesn't do) with the samples.

Also accumulated by this point:

- **The bug persists across full app restart.** Coat Hangers at 20:38:41 was the very first play after a clean `app.boot`, with no shared JS state from before. Silent. So the broken state lives below our process — in WebKit's WebContent renderer or in the OS audio session itself.
- **The bug self-heals after ~15 minutes.** Two reproductions showed the engine quietly returning to working state after the user left it alone.

## Hitting the literature

Until this point I'd been treating the bug as "something specific to our code that needs more diagnosis". When the user asked me to actually search for this, the picture changed immediately. Selected matches:

- **Apple Developer Forum 658375** — "WKWebView Web Audio API can't play after locking screen." Exact same symptom, exact same trigger. Documented community workaround: try `suspend()`/`resume()` first, and if that's not enough, **`close()` + recreate the AudioContext**.
- **WebKit bug #231105** — AudioContext stopped when minimizing Safari window. Fixed March 2022, but shows WebKit *was* aggressively killing audio sessions during dormancy; related state issues outlived the headline fix.
- **WebKit bug #237878** — iOS variant of the same; users reported "subsequent calls to the audioContext don't produce any sound, despite seeming to work" — Mode 2 from the literature.
- **Mozilla bug #1657246** — Same pattern in Firefox. So this is fundamentally a **Web Audio ↔ OS audio session** boundary issue, not specifically a WebKit bug.

The diagnosis stopped being "find the bug" and started being "the bug is documented, what's the right fix for it in our setting." That's a much different problem.

## Fix attempt 1: idle-gated `ctx.close()` + recreate

The community-converged fix is to close the AudioContext and build a fresh one. A new context creates a new AUHAL audio unit and a fresh client of the OS audio session, sidestepping whatever stale state had accumulated.

The user's spec: be aggressive about when to recreate, since the cost of a recreate is low and the cost of a media player that doesn't play media is total.

What got built:

- `staleMarked` flag with a `markStale(reason)` method.
- Gates: `visibilitychange → visible`, `window.focus`, `mediaDevices.devicechange`, and a 5-minute idle threshold inside `play()`.
- Eager recreate when staleness fires *and* nothing is playing.
- Lazy recreate inside `play()` when staleness was flagged while a track was playing.
- Invariant: never recreate while a source is potentially live — buffers are tied to a specific context and would be invalidated.

First test: 16.6 hours of idle (overnight, through multiple system sleeps logged by the Rust power heartbeat). Click play. The log showed the gates firing, the recreate firing, and `play.rmsCheck+3000ms rms=0.333`. The user heard the track. Best evidence we could get.

## Fix attempt 1: also doesn't work

Second test, same day. After ~25 minutes of background idle, two plays in a row reported silence to the user. The log showed:

- `engine.markStale` fired
- `ctx.recreate.start` → `ctx.recreate.done` ran
- Post-recreate `play.rmsCheck+500ms: rms=0.181`, `+1000ms: 0.249`
- `seekTo` to a loud position: `rmsCheck+250ms: rms=0.309`

The graph was producing full-volume music. The user heard nothing. That's the Mode 2 we couldn't detect from inside the app. Recreate was real, but it wasn't enough — whatever's broken survives `ctx.close()` within the same WebContent process.

Critical user-driven tests:

- **Other apps still play audio** → not system mute.
- **Switching macOS audio output devices and switching back** → no effect on Pudding.
- **Locking the screen for 60 seconds** → did not trigger the bug, did not fix it.
- **Quit Pudding and relaunch** → first play after relaunch worked.

The relaunch fix matters: it confirms that the broken state lives in the WebContent process's audio plumbing (or its OS-level audio session), not in our JS state, and not deeper than the process itself. A new WebContent process gets a clean slate; a new AudioContext within the *same* WebContent process doesn't.

## Fix attempt 2: silent `<audio>` keep-alive + MediaSession

Working hypothesis: macOS classifies WKWebView's audio session somewhere between "media app" and "ambient web page", and once that classification slides toward "ambient" the OS feels free to park the session and drop output. The classification is sticky within a WebContent process — relaunch resets it.

The standard trick to pin the classification on the media-app side is to have an HTMLMediaElement continuously playing. `<audio>` elements go through a different WebKit path than Web Audio and are treated as "real media" by macOS.

Implementation:

- A tiny in-code generator for a ~150-byte 8 kHz silent WAV as a `data:` URL.
- An `HTMLAudioElement` set to `loop=true`, `volume=0.001`, kicked off at engine construction and re-kicked on the first `play()` call (autoplay restrictions often require a user gesture).
- `navigator.mediaSession.setActionHandler('play'/'pause', …)` — registering handlers signals to macOS that we're a controllable media app, independent of the keep-alive.

Result on test: every keep-alive attempt rejected with `NotSupportedError: The operation is not supported.` The bug recurred.

## A Tauri CSP gotcha

`NotSupportedError` on `audio.play()` for a valid format usually means the source couldn't load. Checked the Tauri config:

```jsonc
"csp": "… img-src 'self' data: asset: http://asset.localhost;
        media-src 'self' asset: http://asset.localhost https: http: …"
```

`img-src` allows `data:`. `media-src` doesn't. So `<audio src="data:audio/wav;base64,…">` is blocked by CSP before WebKit ever looks at the bytes. Added `data:` to `media-src`. Rebuilt.

Not the WAV's fault; not WKWebView's fault. Just a config gap that ate a whole iteration.

## After the rebuild: three clean recoveries

The next build came up with `keepAlive.started duration=0.1` logged exactly once at boot — no more `NotSupportedError`. Three subsequent reproductions, all with the same shape:

| Time | Idle gap | Trigger that fired markStale | Post-recreate RMS | Audible? |
|---|---|---|---|---|
| 18:22:11 | 56.5 min | `visibilitychange:visible` | 0.193 → 0.353 | yes |
| 20:27:05 | 25.1 min | `window:focus` | 0.054 → 0.097 | yes |
| 01:46:05 | 52.6 min | `window:focus` | 0.044 → 0.114 | yes |

Each one: gate fires, `engine.markStale (eager: false)` queues the recreate, next `play()` consumes the flag, `ctx.recreate.start` → `ctx.created` → `ctx.recreate.done` → `ctx.statechange: closed → running` → decoded → started, RMS healthy within a second.

Three in a row is the most consecutive successes we've had. Cautious optimism only — Mode 2 was always intermittent, so absence of failure for a day doesn't prove fixed.

## Catching `interrupted` in the wild

The 01:46:05 reproduction is the one that earned its keep. Working backwards from it:

- **00:53:30** — user paused playback (`ctx → suspended`, expected).
- **00:55:17** — `ctx.statechange { state: "interrupted" }`. The WebKit-specific, non-spec state we've been theorizing about since the literature search. Captured in a log, in production, for the first time.
- **01:03:00** — `ctx.statechange { state: "suspended" }`. ctx came out of `interrupted` but landed in `suspended`, not `running`. Stuck.
- **01:03:24** — Rust logs `power.resumed gap_seconds=443`. The laptop slept for ~7 minutes. The `interrupted → suspended` transition lined up almost exactly with system wake.

The user walks back to the laptop somewhere around 01:46:00. `window.focus` fires. `engine.markStale (reason: "window:focus")` queues the recreate. User clicks play. `ctx.recreate.start` runs, new ctx comes up `running`, track decodes, plays, RMS is healthy, user hears audio.

This is the first reproduction where the log shows the bug condition (`interrupted`), the bug aftermath (stuck `suspended`), the fix path engaging, *and* the user hearing audio — all on a single timeline. Until this run, "interrupted" was a theory pulled from WebKit source and forum posts. Now it's a log line.

What this refines about the model:

- **Keep-alive doesn't prevent `interrupted` on system sleep.** The silent `<audio>` element was looping the whole time and ctx still flipped. Sleep is a stronger interruption than idle.
- **What keep-alive *does* do** is plausibly suppress the idle-induced path to the same broken state. In ~3 hours of session time with multiple long gaps, no `interrupted` outside the sleep window.
- **`window.focus` is the load-bearing gate for sleep-recovery.** It's the very first event the user generates after waking; it sets the stale flag before they can possibly click play. The visibility and devicechange gates are belt-and-suspenders.
- **Recreate is sufficient for recovery once the gate fires.** Three for three so far. The "broken state lives in WebContent and survives `ctx.close()`" hypothesis from earlier was either wrong, or only true under conditions we haven't reproduced since the keep-alive landed.

## Where we are right now

Shipped to the live build:

- All the diagnostic instrumentation (RMS checks, source counters, output timestamps, Rust power heartbeat, session ID, app boot marker).
- Recreate-on-staleness, triggered by `visibilitychange:visible` and `window.focus`.
- Silent `<audio>` keep-alive (working since the CSP fix).

Open questions:

- Will Mode 2 recur? The previous "ctx says it's running, RMS is healthy, user hears nothing" mode hasn't shown up since the keep-alive landed. Could be fixed; could be lucky.
- Is the keep-alive doing real work, or just along for the ride? Hard to tell without an A/B build. Leaving it in — it's cheap.

## Pruning what didn't earn its keep

Once it became clear that the fix was holding, I went back through the fixes-in-flight and asked which were actually load-bearing and which were just dead weight that the log had never validated. Cut three:

- **5-minute idle threshold inside `play()`.** Designed as a catch-all in case no focus/visibility event fired before play. In practice focus or visibility *always* fired first and set the stale flag before `play()` ran. The idle check never tripped alone. (Kept `lastPlaybackAt` and the `idleMs` field — they're still useful diagnostic context in the heartbeat log.)
- **`mediaDevices.devicechange` gate.** Bluetooth pair/unpair and AirPods sleep were once a prime suspect, but the user explicitly tested switching audio outputs and saw no effect on the bug. The gate has never been the one that fired in a successful recovery.
- **`navigator.mediaSession.setActionHandler` setup.** Added on the theory that registering handlers signals macOS "treat me as a media app" and elevates audio session priority. No evidence it was doing anything; no evidence its absence would hurt. Pure cargo cult once the keep-alive proved out.

Two gates left, both of them validated by reproductions: `visibilitychange:visible` and `window.focus`. About 50 lines of code gone, one fewer constant, one fewer hidden codepath to reason about. The diagnostic instrumentation stays — without it we can't tell next time whether a recurrence is the same bug or a new one.

The temptation when you finally fix a bug is to keep every fix you tried, on the theory that maybe one of them is secretly the load-bearing one. The log is what makes it possible to be more honest than that: if a gate has never fired in a log line that mattered, it's not load-bearing, it's furniture.

## Crossing the original threshold: a 10-hour idle recovery

The next day brought the recovery that mattered most. A single session, multiple sleep/wake cycles by the laptop, the engine sat untouched, then:

```
16:41:16  visibilitychange  visible
16:41:49  window.focus
16:41:52  play()   idleMs=36,483,805
          ctx.recreate.start (reason: window:focus)
          ctx.recreate.done
16:41:53  play.rmsCheck+1000ms   rms=0.283
```

`idleMs=36,483,805` is ~10.1 hours. The original bug report was hours-of-idle. This is hours-of-idle. The recreate fired, the new context produced audible audio in under a second, the user heard the track.

The same session also caught the bug condition firing four separate times — `ctx.statechange { state: "interrupted" }` at 03:10, 06:37, 15:58, and 16:02. Three of the four resolved themselves: ctx went `interrupted → running` on its own, without intervention, sometimes within seconds, sometimes after 40 minutes. That's new. The first reproduction of `interrupted` we ever caught went `interrupted → suspended` and stuck. This session's four cases all flipped back to `running` eventually.

I don't have a confident explanation for the difference yet. Hypotheses:

- The keep-alive's continuously-running `<audio>` element is giving WebKit a path to re-establish the audio session that wasn't there before. The first ever observed `interrupted` happened before the CSP fix that made the keep-alive actually work; every subsequent `interrupted` happened with the keep-alive looping.
- The sleeps in this session might just be of different kinds. macOS distinguishes "system sleep", "display sleep", "app nap", and "audio session interruption", and they probably have different recovery paths. The Rust power heartbeat catches system sleep but not the subtler ones.

What I'm more confident about: even in the cases where ctx self-recovered, the recreate-on-stale path was still defensive insurance. The user's first action on return — clicking back into the window — fires `window.focus`, which fires `markStale`, which makes the *next* play() recreate, regardless of what state the ctx self-recovered to. Belt and suspenders, and the day's reproductions show both are doing work.

## What I'd write about

A few themes worth tightening in the eventual post:

1. **Diagnose, don't speculate.** The single most useful constraint was the user's "no speculation, just log it" rule. The temptation to skip to a fix is huge; every time we skipped, we burned an iteration and learned less than the build that just added more measurements.
2. **The instrument has to be honest.** The `lastPlaybackAt` heartbeat updating from a stale AnalyserNode buffer is a tiny bug with a huge multiplier — it silently invalidated the idle gate across every long pause. Telemetry that drives control flow gets the same scrutiny as the control flow it drives.
3. **Look before you measure further.** Two whole iterations were spent staring at WebKit's behavior before searching for the problem in the literature. The exact symptom is a well-documented WebKit bug from 2020 with a community-known workaround. The fix wasn't the hard part once we knew this was Bug X. The diagnosis was.
4. **"Graph alive but OS-mute" is a mode you can't see from your graph.** The AnalyserNode lives upstream of the OS routing layer. There's a class of media bugs where every internal indicator says you're playing audio and you simply aren't. That mode is real and the instrumentation has to acknowledge it can't see it (or you escalate to a separate signal, like the user's ears).
5. **Process boundaries matter on macOS.** The same JS, same buffer, same `ctx.close()+recreate` produces audio after a process restart and silence within the same process. The unit of clean-slate isn't the AudioContext, it's the WebContent process. Anything that lives in WKWebView inherits that. *(Update: still partially true, but the keep-alive build has not so far reproduced the within-process unrecoverability — see below.)*
6. **Log the named state, don't infer it.** "Interrupted" was a theoretical state pulled from WebKit source for months. Once we logged `ctx.statechange` directly, the first reproduction that hit `interrupted` made the entire causal chain — sleep → interrupt → stuck-suspended → no audio → focus event → recreate → recovery — readable from the file. Inferring "the ctx is probably stuck" from RMS readings would have stayed circumstantial forever.
7. **Cross-language telemetry caught what either side alone couldn't.** The JS heartbeat couldn't see system sleep (WKWebView throttles hidden-page timers); the Rust process couldn't see Web Audio state. Both logging into the same file with synchronized wall-clock timestamps is what let me line up `power.resumed gap_seconds=443` with `ctx.statechange interrupted` from two different log sources. The win wasn't either log; it was the join.

## Cast of characters

- **Pudding** — small Tauri 2 + WKWebView macOS music player. Reads MP3s from a folder, displays metadata, gapless playback via Web Audio.
- **The user** — also the developer and project owner; reported the bug, ran every reproduction, made the calls on aggressiveness vs. UX tradeoffs.
- **tauri-plugin-log** — made all the after-the-fact diagnosis possible.
- **The AnalyserNode** — both hero and villain; gave us the cleanest signal we had, but also the false confidence that we were measuring what mattered.
- **WebKit bugs #231105 / #237878 and Apple Forum #658375** — the documents that turned this from "find the bug" into "implement Bug X's known fix."
