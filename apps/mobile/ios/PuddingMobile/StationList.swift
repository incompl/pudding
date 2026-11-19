import SwiftUI

/// The station list: tap to play and open Now Playing, swipe to delete, Edit
/// to reorder, add, and tap a row to change it (the Alarms pattern).
/// Deliberately no NavigationStack, toolbar or .searchable, which are where
/// iOS 26 puts Liquid Glass; the header and search bar are drawn here instead.
struct StationList: View {
    @State private var store = StationStore()
    @State private var editMode = EditMode.inactive
    @State private var showSettings = false
    @State private var showAdd = false
    /// The row whose Edit Station sheet is open.
    @State private var editing: StationStore.Row?
    @State private var showNowPlaying = false
    @State private var query = ""
    /// The player state the list keeps showing while Now Playing slides in,
    /// so the tapped row's accent, the bar and the cleared search land behind
    /// it rather than during the slide.
    @State private var heldPlayer: Player.State?
    @FocusState private var searching: Bool
    /// Follows the on-screen keyboard rather than the search field's focus:
    /// with a hardware keyboard the field can be focused with no keyboard up,
    /// and then there's no reason to hide the now-playing bar.
    @State private var keyboardUp = false

    /// Filters live as you type; there's no search button to commit.
    private var visibleRows: [StationStore.Row] {
        let q = query.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty else { return store.rows }
        return store.rows.filter { $0.station.name.localizedStandardContains(q) }
    }

    /// Now Playing slides in and out over the list.
    private let slideDuration = 0.3
    private var slide: Animation { .easeInOut(duration: slideDuration) }

    private var isFiltering: Bool { !query.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        ZStack {
            list
            if showNowPlaying {
                NowPlaying(
                    player: store.player,
                    onPlayPause: { store.playPause() },
                    onBack: { withAnimation(slide) { showNowPlaying = false } }
                )
                .transition(.move(edge: .trailing))
                .zIndex(1)
            }
        }
    }

    private var list: some View {
        ScrollViewReader { proxy in
            List {
                ForEach(visibleRows) { row in
                    StationRow(
                        station: row.station,
                        player: heldPlayer ?? store.player,
                        editing: editMode.isEditing)
                        .contentShape(Rectangle())
                        .onTapGesture {
                            // In Edit mode a tap changes the station instead
                            // of playing it.
                            if editMode.isEditing {
                                editing = row
                                return
                            }
                            // A pick ends the search: back on the full list
                            // when Now Playing closes. The keyboard goes now so
                            // it isn't left over Now Playing; the list itself
                            // changes once it's covered.
                            searching = false
                            heldPlayer = store.player
                            store.open(row.station)
                            withAnimation(slide) { showNowPlaying = true }
                            // A timer, not withAnimation's completion, which let
                            // these show during the slide.
                            Task {
                                try? await Task.sleep(for: .seconds(slideDuration))
                                query = ""
                                heldPlayer = nil
                            }
                        }
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                        .listRowBackground(Palette.bg)
                        .listRowSeparator(.hidden)
                        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
                            Button(role: .destructive) {
                                store.delete(row.id)
                            } label: {
                                Label("Delete", systemImage: "trash")
                            }
                        }
                }
                // Offsets in a filtered list aren't offsets in the full one, so
                // reordering waits until the search is cleared.
                .onMove(perform: isFiltering ? nil : { store.move(from: $0, to: $1) })
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Palette.bg)
            .scrollDismissesKeyboard(.immediately)
            // A tap anywhere in the list ends the search, for when there's too
            // little to scroll. Simultaneous, so rows still get their taps.
            .simultaneousGesture(TapGesture().onEnded { searching = false })
            .overlay {
                if isFiltering && visibleRows.isEmpty {
                    Text("No stations match")
                        .font(.system(size: 17))
                        .foregroundStyle(Palette.muted)
                }
            }
            .environment(\.editMode, $editMode)
            .safeAreaInset(edge: .top, spacing: 0) { header }
            // The keyboard is part of the bottom safe area, so the bar rides
            // up with it.
            // Edit swaps search for Add: reordering doesn't work while
            // filtered anyway, and Add is the louder of the two.
            // The now-playing bar sits above it, so pausing never means
            // scrolling to the station. It fades out while the keyboard is up,
            // which has already taken most of the screen, and back once it's
            // down.
            .safeAreaInset(edge: .bottom, spacing: 0) {
                VStack(spacing: 0) {
                    if !keyboardUp, let station = (heldPlayer ?? store.player).station {
                        nowPlayingBar(station, player: heldPlayer ?? store.player)
                            .transition(.opacity)
                    }
                    if editMode.isEditing { addBar } else { searchBar }
                }
                .animation(.easeInOut(duration: 0.25), value: keyboardUp)
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                keyboardUp = true
            }
            .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
                keyboardUp = false
            }
            .tint(Palette.accent)
            .sheet(isPresented: $showSettings) { SettingsView() }
            .sheet(isPresented: $showAdd) {
                StationForm { station in
                    let id = store.add(station)
                    withAnimation { proxy.scrollTo(id, anchor: .bottom) }
                }
            }
            .sheet(item: $editing) { row in
                StationForm(editing: row.station) { store.update(row.id, to: $0) }
            }
        }
    }

    private var header: some View {
        // The title sits in its own layer so it stays centered however wide
        // the buttons on either side are.
        ZStack {
            Text("Pudding")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.fg)
            HStack {
                Button("Settings") { showSettings = true }
                Spacer()
                Button(editMode.isEditing ? "Done" : "Edit") {
                    // Editing works on the whole list, so it ends any search.
                    searching = false
                    query = ""
                    withAnimation { editMode = editMode.isEditing ? .inactive : .active }
                }
            }
            .font(.system(size: 17))
            .foregroundStyle(Palette.accent)
        }
        // UIKit's standard inline navigation bar: 44pt with the contents
        // centered in it, which also sets the gap above the first row.
        .padding(.horizontal, 16)
        .frame(height: 44)
        .background(Palette.bg)
    }

    /// What's on, with play/pause on the right; tap the rest to open Now
    /// Playing. Stays after a pause (the player keeps its station), so play
    /// rejoins the station, like Now Playing's button.
    private func nowPlayingBar(_ station: Station, player: Player.State) -> some View {
        let isOn = player.status == .playing || player.status == .loading
        let detail: String? = switch player.status {
        case .loading: "Connecting…"
        case .error: player.error ?? "Couldn't play this station"
        case .playing: [player.artist, player.song].compactMap { $0 }.joined(separator: " — ")
        case .stopped: nil
        }
        return HStack(spacing: 0) {
            Button {
                searching = false
                withAnimation(slide) { showNowPlaying = true }
            } label: {
                HStack(spacing: 10) {
                    Artwork(url: station.image, size: 40)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(station.name)
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(Palette.fg)
                        if let detail, !detail.isEmpty {
                            Text(detail)
                                .font(.system(size: 13))
                                .foregroundStyle(player.status == .error ? Palette.accent : Palette.muted)
                                .transition(.opacity)
                        }
                    }
                    .lineLimit(1)
                    // The detail line fades in and out and the name slides to
                    // make room, rather than both snapping when a song title
                    // arrives or goes. A new title crossfades over the old.
                    .animation(.easeInOut(duration: 0.3), value: detail)
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens Now Playing")
            Button { store.playPause() } label: {
                Image(systemName: isOn ? "pause.circle.fill" : "play.circle.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(Palette.accent)
                    .contentTransition(.symbolEffect(.replace))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(isOn ? "Pause" : "Play")
        }
        .padding(.leading, 8)
        .padding(.trailing, 4)
        .padding(.vertical, 6)
        .background(Palette.panel, in: RoundedRectangle(cornerRadius: 12))
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .background(Palette.bg)
    }

    /// Same frame as the search bar it replaces, filled with the accent so
    /// it reads as the thing to tap.
    private var addBar: some View {
        Button { showAdd = true } label: {
            Label("Add Station", systemImage: "plus")
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.accent)
                .frame(maxWidth: .infinity)
                .frame(height: 36)
                .background(Palette.accent.opacity(0.15), in: RoundedRectangle(cornerRadius: 10))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Palette.bg)
    }

    private var searchBar: some View {
        HStack(spacing: 6) {
            Image(systemName: "magnifyingglass")
                .foregroundStyle(Palette.muted)
            TextField("Search", text: $query)
                .focused($searching)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.done)
                .foregroundStyle(Palette.fg)
            if !query.isEmpty {
                Button { query = "" } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(Palette.muted)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("Clear search")
            }
        }
        .font(.system(size: 17))
        .padding(.horizontal, 10)
        .frame(height: 36)
        .background(Palette.muted.opacity(0.12), in: RoundedRectangle(cornerRadius: 10))
        .contentShape(Rectangle())
        .onTapGesture { searching = true }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .background(Palette.bg)
    }
}

private struct StationRow: View {
    let station: Station
    let player: Player.State
    let editing: Bool

    var body: some View {
        HStack(spacing: 12) {
            Artwork(url: station.image)
                .overlay {
                    // Says what a tap does in Edit mode. The whole row is the
                    // target; the art darkens so the white pencil reads on any
                    // image (and on the empty placeholder). Always present and
                    // faded by opacity with its own animation: List rows don't
                    // reliably pick up the Edit toggle's withAnimation.
                    ZStack {
                        Color.black.opacity(0.6)
                        Image(systemName: "pencil")
                            .font(.system(size: 26, weight: .semibold))
                            .foregroundStyle(.white)
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .opacity(editing ? 1 : 0)
                    .animation(.easeInOut(duration: 0.25), value: editing)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
                }
            // The accent marks the now-playing bar's station; the bar carries its
            // song and the pause button.
            Text(station.name)
                // Semibold when accented: thin accent text loses contrast on
                // some themes.
                .font(.system(size: 17, weight: isActive ? .semibold : .regular))
                .foregroundStyle(isActive ? Palette.accent : Palette.fg)
            Spacer(minLength: 0)
        }
    }

    /// Whether this row's station is the now-playing bar's, playing or not:
    /// the highlight follows the bar, not the sound.
    private var isActive: Bool {
        guard let current = player.station else { return false }
        return current.url == station.url && current.name == station.name
    }
}

private struct Artwork: View {
    let url: String?
    var size: CGFloat = 48

    var body: some View {
        StationImage(url: url) { image in
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Palette.muted.opacity(0.2)
            }
        }
        .frame(width: size, height: size)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: Model

@MainActor
@Observable
final class StationStore {
    /// Stations carry no id of their own (two can share a URL), so each row
    /// gets one for the list's identity.
    struct Row: Identifiable {
        let id = UUID()
        var station: Station
    }

    private(set) var rows: [Row]
    private(set) var player = Player.shared.state

    init() {
        rows = Stations.load().map { Row(station: $0) }
        Player.shared.onChange = { [weak self] state in self?.player = state }
    }

    private var isOn: Bool { player.status == .playing || player.status == .loading }

    /// Opening the station that's on leaves it playing; any other starts.
    func open(_ station: Station) {
        let current = player.station?.url == station.url && player.station?.name == station.name
        if !(isOn && current) { Player.shared.play(station) }
    }

    /// Now Playing's button: stop what's on, or play the last station again.
    func playPause() {
        if isOn {
            Player.shared.stop()
        } else if let station = player.station {
            Player.shared.play(station)
        }
    }

    /// Adds to the end of the list and returns the new row's id.
    @discardableResult
    func add(_ station: Station) -> Row.ID {
        let row = Row(station: station)
        rows.append(row)
        save()
        return row.id
    }

    /// The player knows its station by name and URL, so an edit to the one
    /// that's current is handed on: a new stream restarts it if it's on, and
    /// a new name or image just relabels it.
    func update(_ id: Row.ID, to station: Station) {
        guard let i = rows.firstIndex(where: { $0.id == id }) else { return }
        let old = rows[i].station
        rows[i].station = station
        save()
        if let current = player.station, current.url == old.url, current.name == old.name {
            if isOn && station.url != old.url {
                Player.shared.play(station)
            } else {
                Player.shared.relabel(station)
            }
        }
    }

    func delete(_ id: Row.ID) {
        rows.removeAll { $0.id == id }
        save()
    }

    func move(from source: IndexSet, to destination: Int) {
        rows.move(fromOffsets: source, toOffset: destination)
        save()
    }

    private func save() {
        Stations.save(rows.map(\.station))
    }
}

// MARK: Colors

/// bg is desktop's MODE_BG; fg and muted are desktop's --text and
/// --text-muted. accent is the theme chosen in Settings for each mode
/// (Theme.swift).
enum Palette {
    static let bg = dynamic(light: 0xffffff, dark: 0x000000)
    static let fg = dynamic(light: 0x1c1c1e, dark: 0xf1f1f1)
    static let muted = dynamic(light: 0x55555b, dark: 0xaaaaaa)
    /// Desktop's --panel: the ground of a card that sits on bg.
    static let panel = dynamic(light: 0xf7f7f7, dark: 0x0f0f0f)
    /// Desktop's --surface-raised: an element lifted off a panel.
    static let raised = dynamic(light: 0xffffff, dark: 0x1a1a1a)

    /// Reads both accents here rather than inside the UIColor closure, so a
    /// view using it redraws when either changes.
    @MainActor static var accent: Color {
        let theme = Theme.shared
        return dynamic(light: theme.accent(for: .light).accent, dark: theme.accent(for: .dark).accent)
    }

    private static func dynamic(light: UInt32, dark: UInt32) -> Color {
        Color(UIColor { $0.userInterfaceStyle == .dark ? rgb(dark) : rgb(light) })
    }

    static func rgb(_ hex: UInt32) -> UIColor {
        UIColor(
            red: CGFloat((hex >> 16) & 0xff) / 255,
            green: CGFloat((hex >> 8) & 0xff) / 255,
            blue: CGFloat(hex & 0xff) / 255,
            alpha: 1)
    }
}
