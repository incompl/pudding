import SwiftUI
import WebKit

/// The whole UI: one WKWebView running the Vite-built web app.
struct WebView: UIViewRepresentable {
    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(BundleSchemeHandler(), forURLScheme: BundleSchemeHandler.scheme)

        let web = WKWebView(frame: .zero, configuration: config)
        // Insets are CSS's job (env(safe-area-inset-*)); don't let UIKit add its own.
        web.scrollView.contentInsetAdjustmentBehavior = .never
        // No white flash before the page paints its own background.
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        #if DEBUG
        web.isInspectable = true  // Safari ▸ Develop ▸ Simulator
        #endif
        web.load(URLRequest(url: Self.startURL))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {}

    /// The bundled build, unless a debug launch names a dev server
    /// (`pnpm sim:dev` passes PUDDING_DEV_URL through simctl).
    private static var startURL: URL {
        #if DEBUG
        if let dev = ProcessInfo.processInfo.environment["PUDDING_DEV_URL"],
           let url = URL(string: dev) {
            return url
        }
        #endif
        return URL(string: "\(BundleSchemeHandler.scheme)://app/index.html")!
    }
}
