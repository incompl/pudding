import AVFoundation
import MediaPlayer
import UIKit

/// Radio playback through AVPlayer: background audio, lock-screen and Control
/// Center controls, and the stream's song title (see StreamLoader).
///
/// Live radio has no pause. "Pause" from the lock screen stops, and play starts
/// the station again, so it picks up live rather than replaying a stale buffer.
@MainActor
final class Player: NSObject {
    static let shared = Player()

    enum Status {
        case stopped, loading, playing, error
    }

    struct State {
        var status: Status = .stopped
        var station: Station?
        var song: String?
        var artist: String?
        var error: String?
    }

    /// Called on every state change.
    var onChange: ((State) -> Void)?

    private(set) var state = State() {
        didSet {
            onChange?(state)
            updateNowPlaying()
        }
    }

    private let player = AVPlayer()
    private var start: Task<Void, Never>?
    private var itemStatus: NSKeyValueObservation?
    private var timeControl: NSKeyValueObservation?
    /// Feeds the current station to AVPlayer; nil for HLS or when stopped.
    private var stream: StreamLoader?
    private var artwork: (url: String, art: MPMediaItemArtwork?)?
    /// Set when a call or Siri interrupts playback, so it resumes afterwards.
    private var resumeAfterInterruption = false

    private override init() {
        super.init()
        // Reads the status when handled, not when observed: a stale "paused"
        // from the previous station mustn't stop the next one.
        timeControl = player.observe(\.timeControlStatus) { @Sendable [weak self] _, _ in
            Task { @MainActor in self?.timeControlChanged() }
        }
        setUpRemoteCommands()
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            let info = note.userInfo ?? [:]
            guard let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
                  let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }
            let options = AVAudioSession.InterruptionOptions(
                rawValue: info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0)
            MainActor.assumeIsolated { self?.interrupted(type, options) }
        }
    }

    // MARK: Controls

    func play(_ station: Station) {
        stop()
        state = State(status: .loading, station: station)
        start = Task {
            do {
                let url = try await StreamURL.resolve(station.url)
                try Task.checkCancellation()
                try AVAudioSession.sharedInstance().setCategory(.playback)
                try AVAudioSession.sharedInstance().setActive(true)
                begin(item(for: url))
            } catch is CancellationError {
            } catch {
                fail(error.localizedDescription)
            }
        }
    }

    func stop() {
        start?.cancel()
        start = nil
        itemStatus = nil
        stopStream()
        resumeAfterInterruption = false
        player.replaceCurrentItem(with: nil)
        if state.status != .stopped {
            state = State(status: .stopped, station: state.station)
        }
    }

    /// Swaps in an edited copy of the current station without touching
    /// playback: the stream is the same, or nothing is playing it.
    func relabel(_ station: Station) {
        state.station = station
    }

    /// Play the last station again (lock screen play, end of an interruption).
    private func resume() {
        if let station = state.station { play(station) }
    }

    // MARK: AVPlayer

    private func begin(_ item: AVPlayerItem) {
        itemStatus = item.observe(\.status) { @Sendable [weak self] item, _ in
            guard item.status == .failed else { return }
            let message = item.error?.localizedDescription ?? "Couldn't play this station"
            Task { @MainActor in self?.fail(message) }
        }
        player.replaceCurrentItem(with: item)
        player.play()
    }

    private func timeControlChanged() {
        guard player.currentItem != nil, state.status != .error else { return }
        switch player.timeControlStatus {
        case .playing: state.status = .playing
        case .waitingToPlayAtSpecifiedRate: state.status = .loading
        // Paused by the system (route change, e.g. headphones unplugged):
        // treat as stopped so the next play rejoins live.
        case .paused: stop()
        @unknown default: break
        }
    }

    private func fail(_ message: String) {
        start?.cancel()
        itemStatus = nil
        stopStream()
        player.replaceCurrentItem(with: nil)
        state = State(status: .error, station: state.station, error: message)
    }

    private func interrupted(
        _ type: AVAudioSession.InterruptionType,
        _ options: AVAudioSession.InterruptionOptions
    ) {
        switch type {
        case .began:
            let wasPlaying = state.status == .playing || state.status == .loading
            stop()
            resumeAfterInterruption = wasPlaying
        case .ended:
            if resumeAfterInterruption && options.contains(.shouldResume) { resume() }
            resumeAfterInterruption = false
        @unknown default:
            break
        }
    }

    // MARK: Lock screen and Control Center

    private func setUpRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()
        center.playCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated { self?.resume() }
            return .success
        }
        for command in [center.pauseCommand, center.stopCommand] {
            command.addTarget { [weak self] _ in
                MainActor.assumeIsolated { self?.stop() }
                return .success
            }
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                if self.state.status == .stopped || self.state.status == .error {
                    self.resume()
                } else {
                    self.stop()
                }
            }
            return .success
        }
    }

    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard let station = state.station else {
            center.nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [
            MPNowPlayingInfoPropertyIsLiveStream: true,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
            MPMediaItemPropertyTitle: state.song ?? station.name,
            MPMediaItemPropertyArtist: state.artist ?? (state.song == nil ? "" : station.name),
            MPMediaItemPropertyAlbumTitle: station.name,
        ]
        if let image = station.image, artwork?.url == image, let art = artwork?.art {
            info[MPMediaItemPropertyArtwork] = art
        } else if let image = station.image, artwork?.url != image {
            loadArtwork(image)
        }
        center.nowPlayingInfo = info
        center.playbackState = state.status == .playing || state.status == .loading
            ? .playing : .stopped
    }

    private func loadArtwork(_ image: String) {
        artwork = (image, nil)
        Task {
            guard let picture = await ImageCache.load(image),
                  artwork?.url == image
            else { return }
            artwork = (image, Self.artwork(picture))
            updateNowPlaying()
        }
    }

    /// Built outside the main actor on purpose: MediaPlayer calls the closure
    /// on its own queue, and a closure formed inside Player inherits main-actor
    /// isolation, which Swift 6 checks at runtime and traps on.
    private nonisolated static func artwork(_ picture: UIImage) -> MPMediaItemArtwork {
        MPMediaItemArtwork(boundsSize: picture.size) { @Sendable _ in picture }
    }
}

// MARK: Stream and song titles

extension Player {
    /// The item for a station: fed through a StreamLoader so the song titles
    /// come from the one download, or played by AVPlayer directly for HLS.
    private func item(for url: URL) -> AVPlayerItem {
        guard StreamLoader.handles(url) else { return AVPlayerItem(url: url) }
        let source = StreamLoader(url: url)
        source.start { [weak self, weak source] title in
            // A title from the station before this one arriving late.
            guard let self, let source, self.stream === source else { return }
            self.streamTitle(title)
        }
        stream = source
        return AVPlayerItem(asset: source.asset())
    }

    private func stopStream() {
        stream?.cancel()
        stream = nil
    }

    /// "Artist - Song" by convention; split on the first separator, keeping the
    /// whole string as the song when there's none. Same rule as desktop.
    private func streamTitle(_ raw: String) {
        guard state.status == .playing || state.status == .loading else { return }
        let title = StreamText.clean(raw)
        if let sep = title.range(of: " - "), sep.lowerBound > title.startIndex {
            let artist = title[..<sep.lowerBound].trimmingCharacters(in: .whitespaces)
            let song = title[sep.upperBound...].trimmingCharacters(in: .whitespaces)
            state.artist = artist
            state.song = song.isEmpty ? title : song
        } else {
            state.artist = nil
            state.song = title.isEmpty ? nil : title
        }
    }
}

/// Some stations relay scraped playlists and send titles that were never
/// cleaned up for ICY: HTML entities still encoded ("&#23665;" for 山) and the
/// whole string wrapped in the source's quotes ("'Artist - Song'"). Ported from
/// desktop's cleanStreamText. Unknown entities are left as they are.
enum StreamText {
    private static let named: [String: String] = [
        "amp": "&", "lt": "<", "gt": ">", "quot": "\"", "apos": "'", "nbsp": " ",
    ]

    static func clean(_ raw: String) -> String {
        var s = raw.replacing(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z]+);/) { match in
            let body = match.1
            guard body.hasPrefix("#") else {
                return named[body.lowercased()] ?? String(match.0)
            }
            let hex = body.dropFirst().first.map { $0 == "x" || $0 == "X" } ?? false
            let digits = body.dropFirst(hex ? 2 : 1)
            guard let cp = UInt32(digits, radix: hex ? 16 : 10), cp > 0,
                  let scalar = Unicode.Scalar(cp)
            else { return String(match.0) }
            return String(Character(scalar))
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.count >= 2 && s.hasPrefix("'") && s.hasSuffix("'") {
            s = String(s.dropFirst().dropLast()).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return s
    }
}

// MARK: Playlist links

/// AVPlayer can't open a .pls or plain .m3u, so those are fetched and the
/// stream URL inside is played instead. Ported from desktop's icy.rs.
///
/// Known gap: desktop also spots a playlist by its Content-Type when the URL
/// has no telling extension. That needs a request before every play, so it's
/// left out until a real station needs it.
enum StreamURL {
    private static let maxHops = 5

    static func resolve(_ string: String) async throws -> URL {
        guard var url = URL(string: string) else { throw PlayError("Not a valid URL") }
        for _ in 0..<maxHops {
            let ext = url.pathExtension.lowercased()
            guard ["pls", "m3u", "m3u8"].contains(ext) else { return url }
            let (data, _) = try await URLSession.shared.data(from: url)
            let body = String(decoding: data.prefix(64 * 1024), as: UTF8.self)
            // Real HLS: AVPlayer plays it directly.
            if body.contains("#EXT-X-") { return url }
            guard let next = firstStream(in: body) else {
                throw PlayError("The playlist has no stream in it")
            }
            url = next
        }
        throw PlayError("Too many playlist redirects")
    }

    /// First stream URL in a PLS (`File1=…`) or M3U (bare line) body, https
    /// first: App Transport Security blocks plain http.
    static func firstStream(in body: String) -> URL? {
        var found: [String] = []
        for raw in body.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") || line.hasPrefix("[") { continue }
            let candidate: String
            if let eq = line.firstIndex(of: "=") {
                let key = line[..<eq].trimmingCharacters(in: .whitespaces).lowercased()
                guard key.hasPrefix("file") else { continue }  // TitleN=, LengthN=, …
                candidate = line[line.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            } else {
                candidate = line
            }
            if candidate.hasPrefix("http://") || candidate.hasPrefix("https://") {
                found.append(candidate)
            }
        }
        let pick = found.first { $0.hasPrefix("https://") } ?? found.first
        return pick.flatMap(URL.init(string:))
    }
}

struct PlayError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
