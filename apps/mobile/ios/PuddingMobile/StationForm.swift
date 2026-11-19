import SwiftUI

/// The Add Station and Edit Station sheet. Like Settings, it has no
/// NavigationStack or toolbar (Liquid Glass); the header is drawn here instead.
struct StationForm: View {
    /// The station being edited, or nil to add a new one.
    let original: Station?
    let onSave: (Station) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var name: String
    @State private var url: String
    @State private var image: String
    @FocusState private var focused: Field?

    private enum Field { case name, url, image }

    init(editing original: Station? = nil, onSave: @escaping (Station) -> Void) {
        self.original = original
        self.onSave = onSave
        _name = State(initialValue: original?.name ?? "")
        _url = State(initialValue: original?.url ?? "")
        _image = State(initialValue: original?.image ?? "")
    }

    /// Only the stream URL is required. A blank name falls back to the URL,
    /// the same as an M3U entry without #EXTINF.
    private var station: Station? {
        guard let stream = Self.webURL(url) else { return nil }
        let title = name.trimmingCharacters(in: .whitespaces)
        let art = image.trimmingCharacters(in: .whitespaces)
        return Station(
            name: title.isEmpty ? stream : title,
            url: stream,
            image: art.isEmpty ? nil : art)
    }

    /// Invalid, or an edit that changes nothing.
    private var canSave: Bool { station != nil && station != original }

    /// The trimmed text when it's an http(s) URL with a host, else nil.
    private static func webURL(_ text: String) -> String? {
        let s = text.trimmingCharacters(in: .whitespaces)
        guard let u = URL(string: s), let scheme = u.scheme?.lowercased(),
              scheme == "https" || scheme == "http", u.host() != nil
        else { return nil }
        return s
    }

    var body: some View {
        Form {
            Group {
                TextField("Name", text: $name)
                    .focused($focused, equals: .name)
                    .submitLabel(.next)
                    .onSubmit { focused = .url }
                TextField("Stream URL", text: $url)
                    .focused($focused, equals: .url)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.next)
                    .onSubmit { focused = .image }
                TextField("Image URL (optional)", text: $image)
                    .focused($focused, equals: .image)
                    .keyboardType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .onSubmit(save)
            }
            .foregroundStyle(Palette.fg)
            .listRowBackground(Palette.raised)
        }
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .background(Palette.panel)
        .tint(Palette.accent)
        .presentationDetents([.medium])
        .presentationBackground(Palette.panel)
        // A new station starts typing; an edit opens on what's there, the
        // way Contacts does, so the keyboard doesn't cover it.
        .onAppear { if original == nil { focused = .name } }
    }

    private var header: some View {
        ZStack {
            Text(original == nil ? "Add Station" : "Edit Station")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.fg)
            HStack {
                Button("Cancel") { dismiss() }
                    .font(.system(size: 17))
                    .foregroundStyle(Palette.accent)
                Spacer()
                // An explicit style overrides the dimming .disabled gives.
                Button(original == nil ? "Add" : "Save", action: save)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(canSave ? Palette.accent : Palette.muted)
                    .disabled(!canSave)
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 16)
        .padding(.bottom, 4)
    }

    private func save() {
        guard canSave, let station else { return }
        onSave(station)
        dismiss()
    }
}
