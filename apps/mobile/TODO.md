# Pudding Mobile TODO

1. **Station list**
   - Seed desktop's default stations on first launch.
   - Save stations as an app setting on the native side.
   - Add a small JS ↔ Swift bridge so the web layer can read and write them.
   - Render the list.
2. **Playback**
   - Play and stop through native AVPlayer.
   - Background audio.
   - Lock-screen and Control Center controls.
   - Song title and artist from the stream, shown in the app and on the lock screen.
   - Resolve `.pls` links to the real stream URL before playing.
3. **Editing stations**
   - Add, edit, remove and reorder stations (title, image URL, stream URL).
4. **Search**
   - Custom HTML search bar at the bottom that stays above the keyboard.
   - Fall back to a native search bar if it feels bad in use.

## Deferred until needed

- Plain `http://` streams (an App Transport Security exception). Add only if a
  real station needs it.
- Ogg Vorbis/Opus streams, which AVPlayer can't play. Needs our own decoder.
