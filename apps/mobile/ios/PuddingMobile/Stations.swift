import Foundation
import WebKit

/// A radio station. Field names match desktop's `Stream` (src/types.ts) so the
/// web layers can share code.
struct Station: Codable {
    var name: String
    var url: String
    var image: String?
}

/// The station list, kept as an app setting (UserDefaults). The first read on a
/// fresh install seeds it from packages/lib/default-streams.m3u8, which the
/// "Bundle web build" phase copies into the app.
enum Stations {
    private static let key = "stations"

    static func load() -> [Station] {
        if let data = UserDefaults.standard.data(forKey: key),
           let stations = try? JSONDecoder().decode([Station].self, from: data) {
            return stations
        }
        let seeded = defaults()
        save(seeded)
        return seeded
    }

    static func save(_ stations: [Station]) {
        if let data = try? JSONEncoder().encode(stations) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    private static func defaults() -> [Station] {
        guard let url = Bundle.main.url(forResource: "default-streams", withExtension: "m3u8"),
              let text = try? String(contentsOf: url, encoding: .utf8)
        else { return [] }
        return parseM3U(text)
    }

    /// Extended M3U: each non-comment line is a stream URL, optionally preceded
    /// by `#EXTINF:-1 tvg-logo="…",Name`.
    static func parseM3U(_ text: String) -> [Station] {
        var stations: [Station] = []
        var name: String?
        var image: String?
        for raw in text.split(whereSeparator: \.isNewline) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.hasPrefix("#EXTINF:") {
                (name, image) = parseExtinf(String(line.dropFirst("#EXTINF:".count)))
            } else if !line.isEmpty && !line.hasPrefix("#") {
                stations.append(Station(name: name ?? line, url: line, image: image))
                name = nil
                image = nil
            }
        }
        return stations
    }

    /// `-1 tvg-logo="…",Name` → (Name, logo). The name follows the first comma
    /// outside quotes, so a comma inside an attribute value doesn't split it.
    private static func parseExtinf(_ s: String) -> (String?, String?) {
        var inQuotes = false
        var split = s.endIndex
        for i in s.indices {
            if s[i] == "\"" { inQuotes.toggle() }
            if s[i] == "," && !inQuotes { split = i; break }
        }
        let attrs = s[..<split]
        let name = split < s.endIndex
            ? s[s.index(after: split)...].trimmingCharacters(in: .whitespaces)
            : ""
        var image: String?
        if let r = attrs.range(of: #"tvg-logo="([^"]*)""#, options: .regularExpression) {
            image = String(attrs[r].dropFirst("tvg-logo=\"".count).dropLast())
        }
        return (name.isEmpty ? nil : name, image?.isEmpty == true ? nil : image)
    }
}

/// JS ↔ Swift bridge for the station list. From the web layer:
///
///     window.webkit.messageHandlers.stations.postMessage({ op: "list" })
///     window.webkit.messageHandlers.stations.postMessage({ op: "save", stations })
///
/// Each returns a promise; "list" resolves to the station array.
final class StationsBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "stations"

    /// Returns (result, nil) to resolve the JS promise, or (nil, message) to reject it.
    func userContentController(
        _ controller: WKUserContentController,
        didReceive message: WKScriptMessage
    ) async -> (Any?, String?) {
        guard let body = message.body as? [String: Any], let op = body["op"] as? String else {
            return (nil, "expected { op }")
        }
        do {
            switch op {
            case "list":
                let data = try JSONEncoder().encode(Stations.load())
                return (try JSONSerialization.jsonObject(with: data), nil)
            case "save":
                // Checked first: JSONSerialization raises an ObjC exception (a
                // crash, not a throw) on input it can't encode.
                guard let list = body["stations"] as? [Any],
                      JSONSerialization.isValidJSONObject(list)
                else { return (nil, "save: expected { stations: [...] }") }
                let raw = try JSONSerialization.data(withJSONObject: list)
                Stations.save(try JSONDecoder().decode([Station].self, from: raw))
                return (nil, nil)
            default:
                return (nil, "unknown op: \(op)")
            }
        } catch {
            return (nil, "\(op): \(error)")
        }
    }
}
