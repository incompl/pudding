import AVFoundation
import UniformTypeIdentifiers

/// One station's stream, fetched over our own connection and fed to AVPlayer
/// through an AVAssetResourceLoader, so the song titles come from the same
/// download as the audio.
///
/// An Icecast or SHOUTcast server only puts titles in the stream when the
/// request asks for them with `Icy-MetaData: 1`, and AVPlayer never gets them
/// from its own connection: on iOS 26.5 neither AVPlayerItemMetadataOutput nor
/// timedMetadata saw a single title, even with the header forced on through the
/// asset's options. So AVPlayer is handed a `pudding-stream:` URL it can't open
/// itself, and every byte it reads comes through this delegate. The connection
/// asks for titles, the parser takes them out, and AVPlayer gets plain audio.
///
/// AVPlayer treats the stream as a file. It's told the file is huge and allows
/// byte ranges, then reads it front to back as the audio arrives. A small
/// window of recent audio is kept in case it rereads a little behind itself.
///
/// HLS isn't played through here: AVPlayer fetches the playlist and segments
/// itself (see `handles`).
final class StreamLoader: NSObject, AVAssetResourceLoaderDelegate, URLSessionDataDelegate,
    @unchecked Sendable
{
    private static let scheme = "pudding-stream"
    /// What AVPlayer is told the stream's length is: about two years at 128
    /// kbps. It never gets near the end.
    private static let length: Int64 = 1 << 40
    /// Recent audio kept for rereads: about four minutes at 128 kbps.
    private static let window = 4 << 20
    /// Before playing, AVPlayer reads far ahead looking for a tag at the end of
    /// the "file" (it tried 4 GB in), and waits on that read for about 9
    /// seconds if it isn't answered. A read this far past the live edge gets
    /// one block of zeros straight away: there's nothing there.
    private static let probe: Int64 = 64 << 20
    private static let probeReply = 64 << 10
    /// After a dropped connection, the station is fetched again this many times
    /// in a row before playback gives up.
    private static let retries = 3
    private static let retryDelay: Duration = .seconds(1)

    private let url: URL
    /// Every field below is touched only on this queue: AVPlayer's loader calls
    /// and the connection's delegate calls both run on it.
    private let queue = DispatchQueue(label: "pudding.stream")
    private var session: URLSession?
    private var contentType: String?
    private var parser: IcyParser?
    /// Audio from offset `start` up to `start + audio.count`.
    private var audio = Data()
    private var start: Int64 = 0
    private var requests: [AVAssetResourceLoadingRequest] = []
    private var failures = 0
    private var error: Error?
    private var cancelled = false
    private var last: String?
    private var onTitle: (@MainActor @Sendable (String) -> Void)?

    init(url: URL) {
        self.url = url
    }

    /// True for a stream AVPlayer should be fed through a StreamLoader; false
    /// for HLS, which it fetches itself.
    static func handles(_ url: URL) -> Bool {
        url.pathExtension.lowercased() != "m3u8"
    }

    /// The asset to play. AVFoundation holds the delegate weakly, so the caller
    /// keeps this loader for as long as the asset plays.
    func asset() -> AVURLAsset {
        var parts = URLComponents(url: url, resolvingAgainstBaseURL: false)
        parts?.scheme = Self.scheme
        let asset = AVURLAsset(url: parts?.url ?? url)
        asset.resourceLoader.setDelegate(self, queue: queue)
        return asset
    }

    /// Connects, and calls `onTitle` with each new song title.
    func start(onTitle: @escaping @MainActor @Sendable (String) -> Void) {
        queue.async {
            self.onTitle = onTitle
            self.connect()
        }
    }

    func cancel() {
        queue.async {
            self.cancelled = true
            self.onTitle = nil
            // The session holds its delegate strongly until invalidated.
            self.session?.invalidateAndCancel()
            self.session = nil
            for request in self.requests where !request.isFinished && !request.isCancelled {
                request.finishLoading(with: CancellationError())
            }
            self.requests = []
            self.audio = Data()
        }
    }

    private func connect() {
        guard !cancelled else { return }
        parser = nil
        var request = URLRequest(url: url)
        request.setValue("1", forHTTPHeaderField: "Icy-MetaData")
        let delegateQueue = OperationQueue()
        delegateQueue.underlyingQueue = queue
        let session = URLSession(
            configuration: .ephemeral, delegate: self, delegateQueue: delegateQueue)
        self.session = session
        session.dataTask(with: request).resume()
    }

    // MARK: AVAssetResourceLoaderDelegate (on `queue`)

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        shouldWaitForLoadingOfRequestedResource loadingRequest: AVAssetResourceLoadingRequest
    ) -> Bool {
        guard !cancelled else { return false }
        requests.append(loadingRequest)
        serve()
        return true
    }

    func resourceLoader(
        _ resourceLoader: AVAssetResourceLoader,
        didCancel loadingRequest: AVAssetResourceLoadingRequest
    ) {
        requests.removeAll { $0 === loadingRequest }
    }

    /// Answers every waiting request as far as the audio so far allows.
    private func serve() {
        requests.removeAll { request in
            if request.isCancelled || request.isFinished { return true }
            if let info = request.contentInformationRequest {
                guard let contentType else { return failIfDone(request) }
                info.contentType = contentType
                info.contentLength = Self.length
                info.isByteRangeAccessSupported = true
            }
            guard let data = request.dataRequest else {
                request.finishLoading()
                return true
            }
            let end = data.requestsAllDataToEndOfResource
                ? Self.length
                : data.requestedOffset + Int64(data.requestedLength)
            let offset = data.currentOffset
            let available = start + Int64(audio.count)
            if offset > available + Self.probe {
                data.respond(with: Data(count: Int(min(end - offset, Int64(Self.probeReply)))))
                request.finishLoading()
                return true
            }
            if offset < start {
                request.finishLoading(with: PlayError("The stream moved on"))
                return true
            }
            if offset < available {
                let from = audio.startIndex + Int(offset - start)
                let to = audio.startIndex + Int(min(end, available) - start)
                data.respond(with: audio.subdata(in: from..<to))
            }
            if data.currentOffset >= end {
                request.finishLoading()
                return true
            }
            return failIfDone(request)
        }
    }

    /// Fails a request that can't be answered because playback gave up.
    private func failIfDone(_ request: AVAssetResourceLoadingRequest) -> Bool {
        guard let error else { return false }
        request.finishLoading(with: error)
        return true
    }

    // MARK: URLSessionDataDelegate (on `queue`)

    func urlSession(
        _ session: URLSession, dataTask: URLSessionDataTask,
        didReceive response: URLResponse,
        completionHandler: @escaping (URLSession.ResponseDisposition) -> Void
    ) {
        let http = response as? HTTPURLResponse
        if let status = http?.statusCode, !(200..<300).contains(status) {
            error = PlayError("The station answered \(status)")
            completionHandler(.cancel)
            serve()
            return
        }
        if let value = http?.value(forHTTPHeaderField: "icy-metaint"),
           let metaint = Int(value.trimmingCharacters(in: .whitespaces)), metaint > 0 {
            parser = IcyParser(metaint: metaint)
        }
        // Kept from the first connection: AVPlayer has already been told.
        if contentType == nil {
            contentType = Self.contentType(response.mimeType)
        }
        completionHandler(.allow)
        serve()
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard !cancelled else { return }
        failures = 0
        if var parser {
            let (sound, titles) = parser.feed(data)
            self.parser = parser
            append(sound)
            for title in titles where title != last {
                last = title
                if let onTitle {
                    Task { @MainActor in onTitle(title) }
                }
            }
        } else {
            append(data)
        }
        serve()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        session.finishTasksAndInvalidate()
        guard session === self.session, !cancelled, self.error == nil else { return }
        self.session = nil
        // A live stream never ends on its own: the connection dropped. Fetch it
        // again and carry on where the audio left off; MP3 and AAC decoders
        // find the next frame on their own.
        failures += 1
        guard failures <= Self.retries else {
            self.error = error ?? PlayError("The station stopped sending")
            serve()
            return
        }
        Task {
            try? await Task.sleep(for: Self.retryDelay)
            queue.async { self.connect() }
        }
    }

    private func append(_ data: Data) {
        audio.append(data)
        // Trim in large steps so the copy is rare.
        if audio.count > 2 * Self.window {
            let drop = audio.count - Self.window
            audio = audio.subdata(in: (audio.startIndex + drop)..<audio.endIndex)
            start += Int64(drop)
        }
    }

    /// The type AVPlayer is told it's reading, from the server's Content-Type.
    /// Stations label AAC as audio/aacp, which has no type of its own.
    private static func contentType(_ mime: String?) -> String {
        switch mime?.lowercased() {
        case "audio/aac", "audio/aacp", "audio/x-aac": "public.aac-audio"
        case let mime?: UTType(mimeType: mime)?.identifier ?? UTType.mp3.identifier
        case nil: UTType.mp3.identifier
        }
    }
}

/// Pulls titles out of an ICY stream. Every `metaint` audio bytes the server
/// puts one length byte L, then L×16 bytes of `StreamTitle='…';` padded with
/// NULs. Ported from desktop's icy.rs (IcyReader and parse_stream_title).
struct IcyParser {
    private enum Phase {
        case audio(Int)   // audio bytes left before the next length byte
        case length
        case meta(Int)    // metadata bytes left in this block
    }

    let metaint: Int
    private var phase: Phase
    private var block = Data()

    init(metaint: Int) {
        self.metaint = metaint
        phase = .audio(metaint)
    }

    /// Feeds the next chunk of the response body; returns its audio with the
    /// metadata taken out, and the titles that finished in it, oldest first.
    mutating func feed(_ data: Data) -> (audio: Data, titles: [String]) {
        var audio = Data(capacity: data.count)
        var titles: [String] = []
        var i = data.startIndex
        while i < data.endIndex {
            switch phase {
            case .audio(let left):
                let n = min(left, data.endIndex - i)
                audio.append(data[i..<(i + n)])
                i += n
                phase = left == n ? .length : .audio(left - n)
            case .length:
                let length = Int(data[i]) * 16
                i += 1
                block.removeAll(keepingCapacity: true)
                phase = length == 0 ? .audio(metaint) : .meta(length)
            case .meta(let left):
                let n = min(left, data.endIndex - i)
                block.append(data[i..<(i + n)])
                i += n
                if left == n {
                    if let title = Self.streamTitle(in: block) { titles.append(title) }
                    phase = .audio(metaint)
                } else {
                    phase = .meta(left - n)
                }
            }
        }
        return (audio, titles)
    }

    /// The value of `StreamTitle='…';`, or nil when it's missing or empty (some
    /// stations send an empty one between songs). Most encoders leave
    /// apostrophes in titles bare, so the title ends at the first `';`, not
    /// the first `'`. Some (liquidsoap) backslash-escape them, so an escaped
    /// quote doesn't end it and the escapes are undone.
    static func streamTitle(in block: Data) -> String? {
        // Nominally Latin-1, but many stations send UTF-8. Try UTF-8 first.
        guard let decoded = String(data: block, encoding: .utf8)
            ?? String(data: block, encoding: .isoLatin1)
        else { return nil }
        let text = String(decoded.reversed().drop { $0 == "\0" }.reversed())
        guard let open = text.range(of: "StreamTitle='") else { return nil }
        let rest = Array(text[open.upperBound...].utf8)

        var end: Int?
        var i = 0
        while i < rest.count {
            if rest[i] == UInt8(ascii: "\\") {
                i += 2
            } else if rest[i] == UInt8(ascii: "'"), i + 1 < rest.count,
                      rest[i + 1] == UInt8(ascii: ";") {
                end = i
                break
            } else {
                i += 1
            }
        }
        // A truncated block that lost its terminator: up to the last quote.
        guard let end = end ?? rest.lastIndex(of: UInt8(ascii: "'")) else { return nil }

        let raw = String(decoding: rest[..<end], as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let title = unescape(raw)
        return title.isEmpty ? nil : title
    }

    /// Undoes backslash-escaped quotes and backslashes; any other backslash is
    /// literal, since most encoders don't escape at all.
    private static func unescape(_ s: String) -> String {
        var out = ""
        var chars = s.makeIterator()
        while let c = chars.next() {
            guard c == "\\" else {
                out.append(c)
                continue
            }
            switch chars.next() {
            case let n? where n == "'" || n == "\"" || n == "\\": out.append(n)
            case let n?: out.append(c); out.append(n)
            case nil: out.append(c)
            }
        }
        return out
    }
}
