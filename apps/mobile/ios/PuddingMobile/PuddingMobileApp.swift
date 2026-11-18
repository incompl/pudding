import SwiftUI

@main
struct PuddingMobileApp: App {
    var body: some Scene {
        WindowGroup {
            // The web layer draws edge to edge and keeps clear of the notch and
            // home indicator itself, via CSS env(safe-area-inset-*).
            WebView().ignoresSafeArea()
        }
    }
}
