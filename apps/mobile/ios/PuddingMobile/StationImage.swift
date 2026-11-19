import CryptoKit
import SwiftUI
import UIKit

/// A station's image from its URL, through ImageCache. Used instead of
/// AsyncImage, which always starts on its placeholder and swaps the image in
/// later: when that swap lands during Now Playing's slide-in, the art appears
/// in place instead of riding in with the screen. The row has already loaded
/// the same URL by the time Now Playing opens, so here it's on the first frame.
struct StationImage<Content: View>: View {
    let url: String?
    @ViewBuilder let content: (UIImage?) -> Content
    @State private var image: UIImage?

    init(url: String?, @ViewBuilder content: @escaping (UIImage?) -> Content) {
        self.url = url
        self.content = content
        _image = State(initialValue: url.flatMap(ImageCache.cached))
    }

    var body: some View {
        content(image)
            .task(id: url) {
                image = url.flatMap(ImageCache.cached)
                if image == nil, let url { image = await ImageCache.load(url) }
            }
    }
}

/// Station images by URL. Kept in memory for the session and on disk for
/// `maxAge`, so launching the app doesn't refetch every station's art. Once an
/// image is older than that it's fetched again; if that fetch fails, the old
/// copy is still used. A new image URL is a new entry, so editing a station's
/// image shows the new one right away.
@MainActor
enum ImageCache {
    nonisolated static let maxAge: TimeInterval = 30 * 24 * 60 * 60

    private static let images = NSCache<NSString, UIImage>()
    /// Loads already under way, so the row, Now Playing and the lock screen
    /// asking for the same URL at once share one fetch.
    private static var loading: [String: Task<UIImage?, Never>] = [:]

    static func cached(_ url: String) -> UIImage? {
        images.object(forKey: url as NSString)
    }

    static func load(_ url: String) async -> UIImage? {
        if let image = cached(url) { return image }
        if let task = loading[url] { return await task.value }
        let task = Task { await fetch(url) }
        loading[url] = task
        let image = await task.value
        loading[url] = nil
        if let image { images.setObject(image, forKey: url as NSString) }
        return image
    }

    private static func fetch(_ url: String) async -> UIImage? {
        guard let source = URL(string: url) else { return nil }
        let file = Disk.file(for: url)
        let saved = await Task.detached { Disk.read(file) }.value
        if let saved, saved.fresh, let image = UIImage(data: saved.data) { return image }

        if let (data, _) = try? await URLSession.shared.data(from: source),
           let image = UIImage(data: data) {
            Task.detached { Disk.write(data, to: file) }
            return image
        }
        return saved.flatMap { UIImage(data: $0.data) }
    }
}

/// The on-disk half of ImageCache: one file per image URL in Caches, which iOS
/// may clear when space runs low (the images are just fetched again).
private enum Disk {
    static let directory = FileManager.default
        .urls(for: .cachesDirectory, in: .userDomainMask)[0]
        .appendingPathComponent("StationImages", isDirectory: true)

    static func file(for url: String) -> URL {
        let name = SHA256.hash(data: Data(url.utf8)).map { String(format: "%02x", $0) }.joined()
        return directory.appendingPathComponent(name)
    }

    static func read(_ file: URL) -> (data: Data, fresh: Bool)? {
        guard let data = try? Data(contentsOf: file) else { return nil }
        let saved = (try? file.resourceValues(forKeys: [.contentModificationDateKey]))?
            .contentModificationDate ?? .distantPast
        return (data, Date().timeIntervalSince(saved) < ImageCache.maxAge)
    }

    static func write(_ data: Data, to file: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        try? data.write(to: file, options: .atomic)
    }
}
