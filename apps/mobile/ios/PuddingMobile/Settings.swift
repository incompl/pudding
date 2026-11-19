import SwiftUI
import UIKit

/// The settings sheet. Like the station list, it has no NavigationStack or
/// toolbar (Liquid Glass); the header is drawn here instead.
struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.colorScheme) private var showing
    private var theme = Theme.shared

    var body: some View {
        Form {
            // A Group hands its modifiers to each row inside it.
            Group {
                Toggle("Match System", isOn: Binding(
                    get: { theme.mode == .system },
                    set: { theme.setMatchSystem($0, showing: showing) }
                ))
                themeRow("Dark Theme", .dark)
                themeRow("Light Theme", .light)
            }
            .listRowBackground(Palette.raised)
        }
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .background(Palette.panel)
        .tint(Palette.accent)
        .presentationDetents([.medium])
        .presentationBackground(Palette.panel)
    }

    private var header: some View {
        ZStack {
            Text("Settings")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.fg)
            HStack {
                Spacer()
                Button("Done") { dismiss() }
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Palette.accent)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 4)
    }

    /// A menu of one mode's themes. Toggles rather than a Picker so choosing
    /// the theme that's already checked still fires: when not matching the
    /// system, that's how you switch back to its mode, same as desktop.
    private func themeRow(_ title: String, _ scheme: ColorScheme) -> some View {
        let current = theme.accent(for: scheme)
        // Pinned to the other mode: this one's choice is saved but not in use,
        // like desktop leaving that group unselected.
        let inUse = theme.mode == .system || showing == scheme
        return LabeledContent(title) {
            Menu {
                ForEach(Theme.themes(for: scheme)) { t in
                    Toggle(isOn: Binding(
                        get: { t.id == current.id },
                        set: { _ in theme.select(scheme, id: t.id) }
                    )) {
                        Label {
                            Text(t.name)
                        } icon: {
                            Image(uiImage: Swatch.image(t))
                        }
                    }
                }
            } label: {
                HStack(spacing: 4) {
                    Text(current.name)
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 12, weight: .medium))
                }
                .foregroundStyle(inUse ? Palette.accent : Palette.muted)
            }
        }
        .foregroundStyle(Palette.fg)
    }
}

/// The accent as a single dot edged in its dim partner, so it holds up on
/// whichever menu surface it lands on. Rendered as an original-color image so
/// the menu doesn't tint it.
private enum Swatch {
    static func image(_ theme: AccentTheme) -> UIImage {
        let d: CGFloat = 14, line: CGFloat = 1
        let rect = CGRect(x: 0, y: 0, width: d, height: d)
        return UIGraphicsImageRenderer(size: rect.size).image { _ in
            let path = UIBezierPath(ovalIn: rect.insetBy(dx: line / 2, dy: line / 2))
            path.lineWidth = line
            Palette.rgb(theme.accent).setFill()
            path.fill()
            Palette.rgb(theme.accentDim).setStroke()
            path.stroke()
        }
        .withRenderingMode(.alwaysOriginal)
    }
}
