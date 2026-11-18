import UniformTypeIdentifiers
import WebKit

/// Serves the app bundle's `web/` folder (the Vite build, copied in by the
/// "Bundle web build" phase) at pudding://app/…
///
/// Why not loadFileURL: WebKit treats file:// as an opaque origin, so the
/// `<script type="module">` Vite emits fails its CORS check. A custom scheme
/// gives the page a real origin.
final class BundleSchemeHandler: NSObject, WKURLSchemeHandler {
    static let scheme = "pudding"

    private let root = Bundle.main.resourceURL!
        .appendingPathComponent("web", isDirectory: true)
        .standardizedFileURL

    func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
        guard let url = task.request.url else { return }
        let path = url.path.isEmpty || url.path == "/" ? "index.html" : String(url.path.dropFirst())
        let file = root.appendingPathComponent(path).standardizedFileURL

        // Refuse anything that escapes web/ (e.g. "/../Info.plist").
        guard file.path.hasPrefix(root.path + "/"),
              let data = try? Data(contentsOf: file)
        else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let mime = UTType(filenameExtension: file.pathExtension)?.preferredMIMEType
            ?? "application/octet-stream"
        let response = HTTPURLResponse(
            url: url,
            statusCode: 200,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": mime, "Content-Length": String(data.count)]
        )!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {}
}
