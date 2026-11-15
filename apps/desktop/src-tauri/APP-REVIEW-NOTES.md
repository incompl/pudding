# App Review notes

Copy the text below into App Store Connect and adjust the version/build numbers
for the submitted binary.

---

Pudding is a standalone macOS music player for user-selected local audio files
and internet radio stations — a short default station list included with the
operators’ permission, plus any stream URL the user adds. It has no account,
login, purchases, subscriptions, advertising, analytics, or cloud service. The
app ships no commercial or licensed third-party music. The bundled “Pudding
Sample” track is a public-domain spoken-word recording of Lewis Carroll’s
“Through the Looking-Glass,” read by Peter Yearsley, and its cover artwork is
public domain as well. It is included so playback can be tested on a clean Mac.

### Test local playback and first-run folder access

1. Launch Pudding with a clean container.
2. The bundled "Pudding Sample" track is already loaded in Now Playing. Press
   Play in the transport, then pause, seek, and resume.
3. Click **Choose Music Folder** and select a folder containing one or more
   supported, non-DRM audio files: MP3, WAV, FLAC, M4A/AAC/ALAC, Ogg Vorbis,
   Opus, or AIFF.
4. Double-click a track to play it. The Files views, search field, transport,
   queue, equalizer, visualizer, and mini player are then available.
5. Quit and relaunch Pudding. The same folder should remain available without a
   second picker prompt. This tests the app-scoped security-scoped bookmark used
   to restore the sandbox grant.

Pudding never asks for broad disk access. It can read and write only folders or
files the reviewer explicitly selects in a system picker. Files opened outside a
configured library are intentionally not restored across launches.

### Test metadata editing

1. Use a writable test audio file in the selected music folder and keep a backup.
2. Right-click the track and choose **Edit metadata...**
3. Change a text field such as Title, then click **Save**.
4. Reopen the editor or inspect the file in another tag reader to confirm the
   change was written to the selected file.
5. In the tag editor's completed-update screen, choose **Revert update**, then
   confirm the previous value is back. Only the fields that save wrote are
   restored; the audio stream is never touched, as every write lands as an atomic
   rename over a staged copy.

### Test playlists and queue

1. With a non-empty library, click **Create playlist** in the Files panel and
   save the `.m3u8` file inside the selected music folder.
2. Right-click a track and choose **Add to playlist**, or drag a track into the
   open playlist.
3. Reorder or remove rows. Pudding writes each change to the ordinary `.m3u8`
   file automatically.
4. To test the unsaved queue, right-click a track and choose **Create queue**,
   then use **File > Save Queue as Playlist**.

### Test internet radio

1. Open the **Streams** tab. A writable stream list is created locally on first
   launch, seeded with a short default set of stations that are included with
   their operators' permission. The list is an ordinary `.m3u8` file holding
   URLs; no audio is bundled with it.
2. Double-click a station. Pudding connects directly to that provider; live
   streams replace the seek bar with a **Live Broadcast** indicator and show ICY
   now-playing metadata when the station supplies it.
3. To test adding a station, click **Add stream**, enter a direct HTTP or HTTPS
   Icecast/SHOUTcast audio stream URL that the reviewer is authorized to use,
   and save.
4. Pause to disconnect and resume to reconnect to the live edge.

### Privacy and support

Pudding collects no data and contains no telemetry or automatic crash reporting.
Local library metadata, playlists, settings, and station lists remain on the Mac.
Network requests occur only for radio streams, remote station lists/artwork, and
external web links chosen by the user.

- **Help > Privacy Policy:** https://puddingisgood.com/privacy/
- **Help > Support:** https://puddingisgood.com/support/
- Support email: pudding@incompl.com

No special review account, hardware, or credentials are required.
