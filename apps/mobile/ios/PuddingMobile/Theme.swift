import SwiftUI
import UIKit

/// Theming, ported from desktop's apps/desktop/src/theme.ts; keep the two in
/// sync by hand. The mode (dark / light / system) picks the neutral palette;
/// a theme only swaps the accent. Each mode keeps its own accent, so under
/// "system" an OS dark/light flip resolves to whichever was saved for that
/// side and neither choice clobbers the other. Same UserDefaults key names as
/// desktop's store.
struct AccentTheme: Identifiable {
    let id: String
    let name: String
    let accent: UInt32
    let accentDim: UInt32
}

enum ThemeMode: String {
    case dark, light, system
}

@MainActor
@Observable
final class Theme {
    static let shared = Theme()

    static let darkThemes = [
        AccentTheme(id: "pistachio", name: "Pistachio", accent: 0xb5d17a, accentDim: 0x7e9152),
        AccentTheme(id: "dreamcicle", name: "Dreamcicle", accent: 0xf5a966, accentDim: 0xbe7637),
        AccentTheme(id: "blackberry", name: "Blackberry", accent: 0xdb6bf4, accentDim: 0xa94fc0),
        AccentTheme(id: "blueberry", name: "Blueberry", accent: 0x3ea9ff, accentDim: 0x217fcb),
        AccentTheme(id: "banana", name: "Banana", accent: 0xf0d375, accentDim: 0xb19843),
        AccentTheme(id: "strawberry", name: "Strawberry", accent: 0xef6c7e, accentDim: 0xc14858),
    ]

    static let lightThemes = [
        AccentTheme(id: "apple", name: "Apple", accent: 0x00a86b, accentDim: 0x007a4e),
        AccentTheme(id: "apricot", name: "Apricot", accent: 0xff740a, accentDim: 0xc55a08),
        AccentTheme(id: "grape", name: "Grape", accent: 0xa32bff, accentDim: 0x701ab3),
        AccentTheme(id: "raspberry", name: "Raspberry", accent: 0x0a3dff, accentDim: 0x1334ae),
        AccentTheme(id: "coffee", name: "Coffee", accent: 0x966428, accentDim: 0x673018),
        AccentTheme(id: "fruitpunch", name: "Fruit Punch", accent: 0xf61d52, accentDim: 0xc31641),
    ]

    static func themes(for scheme: ColorScheme) -> [AccentTheme] {
        scheme == .dark ? darkThemes : lightThemes
    }

    private static let modeKey = "themeMode"
    private static let darkKey = "darkAccent"
    private static let lightKey = "lightAccent"

    private(set) var mode: ThemeMode {
        didSet {
            UserDefaults.standard.set(mode.rawValue, forKey: Self.modeKey)
            apply()
        }
    }
    private(set) var darkAccent: String {
        didSet { UserDefaults.standard.set(darkAccent, forKey: Self.darkKey) }
    }
    private(set) var lightAccent: String {
        didSet { UserDefaults.standard.set(lightAccent, forKey: Self.lightKey) }
    }

    private init() {
        let defaults = UserDefaults.standard
        mode = defaults.string(forKey: Self.modeKey).flatMap(ThemeMode.init) ?? .dark
        darkAccent = defaults.string(forKey: Self.darkKey) ?? "pistachio"
        lightAccent = defaults.string(forKey: Self.lightKey) ?? "apple"
    }

    /// The saved accent for a mode, falling back to the first theme when the
    /// saved id is unknown (desktop's resolveTheme).
    func accent(for scheme: ColorScheme) -> AccentTheme {
        let id = scheme == .dark ? darkAccent : lightAccent
        let themes = Self.themes(for: scheme)
        return themes.first { $0.id == id } ?? themes[0]
    }

    /// On: follow the OS. Off: pin to whichever mode is showing now.
    func setMatchSystem(_ on: Bool, showing: ColorScheme) {
        mode = on ? .system : (showing == .dark ? .dark : .light)
    }

    /// Choosing a theme sets that mode's accent and, unless matching the
    /// system, switches to that mode (desktop's selectTheme).
    func select(_ scheme: ColorScheme, id: String) {
        if scheme == .dark { darkAccent = id } else { lightAccent = id }
        if mode != .system { mode = scheme == .dark ? .dark : .light }
    }

    /// Pushes the mode onto every window. Done through UIKit rather than
    /// .preferredColorScheme, which doesn't reliably return to the system
    /// appearance after being given nil.
    func apply() {
        let style: UIUserInterfaceStyle = switch mode {
        case .dark: .dark
        case .light: .light
        case .system: .unspecified
        }
        for scene in UIApplication.shared.connectedScenes {
            for window in (scene as? UIWindowScene)?.windows ?? [] {
                window.overrideUserInterfaceStyle = style
            }
        }
    }
}
