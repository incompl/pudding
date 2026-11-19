import SwiftUI

@main
struct PuddingMobileApp: App {
    var body: some Scene {
        WindowGroup {
            StationList()
                // The window exists by now; push the saved mode onto it.
                .onAppear { Theme.shared.apply() }
        }
    }
}
