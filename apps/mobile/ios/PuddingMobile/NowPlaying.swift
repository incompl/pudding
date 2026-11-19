import SwiftUI

/// The now-playing screen, after desktop's radio hero: station art, the
/// station name, and the stream's song hung beneath it, with play/pause below.
/// Pushed over the station list by hand rather than through a NavigationStack
/// (Liquid Glass; see StationList), so the back button and edge swipe are ours.
struct NowPlaying: View {
    let player: Player.State
    let onPlayPause: () -> Void
    let onBack: () -> Void

    var body: some View {
        GeometryReader { geo in
            let side = min(geo.size.width - 64, geo.size.height * 0.5)
            VStack(spacing: 0) {
                header
                Spacer(minLength: 0)
                StationArt(url: player.station?.image)
                    .frame(width: side, height: side)
                Text(player.station?.name ?? "")
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(Palette.fg)
                    .multilineTextAlignment(.center)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity)
                    .padding(.top, 24)
                    // Hangs below the name without taking part in the layout,
                    // so a title can arrive, change or wrap without moving the
                    // art or the name. Same as desktop's #now-playing-stream-meta.
                    .overlay(alignment: .bottom) {
                        StreamMeta(meta: meta)
                            .alignmentGuide(.bottom) { $0[.top] - 8 }
                    }
                    .padding(.horizontal, 32)
                Spacer(minLength: 0)
                // Room for the hanging metadata above the button.
                Spacer().frame(height: 72)
                playPause
                    .padding(.bottom, 32)
            }
        }
        .background(Palette.bg)
        .tint(Palette.accent)
        // Edge swipe back, like a pushed screen.
        .gesture(
            DragGesture(minimumDistance: 20)
                .onEnded { drag in
                    if drag.startLocation.x < 32 && drag.translation.width > 80 { onBack() }
                }
        )
    }

    private var header: some View {
        HStack {
            Button(action: onBack) {
                Image(systemName: "chevron.left")
                    .font(.system(size: 20, weight: .semibold))
                    .frame(width: 44, height: 44, alignment: .leading)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel("Back")
            Spacer()
        }
        .foregroundStyle(Palette.accent)
        .padding(.horizontal, 16)
    }

    /// Live radio has no real pause: "pause" stops, and play rejoins live.
    private var isOn: Bool { player.status == .playing || player.status == .loading }

    private var playPause: some View {
        Button(action: onPlayPause) {
            Image(systemName: isOn ? "pause.circle.fill" : "play.circle.fill")
                .font(.system(size: 72))
                .foregroundStyle(Palette.accent)
                .contentTransition(.symbolEffect(.replace))
        }
        .accessibilityLabel(isOn ? "Pause" : "Play")
    }

    private var meta: StreamMeta.Content? {
        switch player.status {
        case .loading:
            .init(song: "Connecting…", artist: nil, isError: false)
        case .error:
            .init(song: player.error ?? "Couldn't play this station", artist: nil, isError: true)
        case .playing:
            player.song.map { .init(song: $0, artist: player.artist, isError: false) }
        case .stopped:
            nil
        }
    }
}

private struct StationArt: View {
    let url: String?

    var body: some View {
        // Fit, not fill: station logos come in every shape. The frame is fixed
        // by the caller so a logo loading in doesn't move the name.
        StationImage(url: url) { image in
            if let image {
                Image(uiImage: image).resizable().scaledToFit()
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                RoundedRectangle(cornerRadius: 10)
                    .fill(Palette.muted.opacity(0.2))
                    .overlay {
                        Image(systemName: "radio")
                            .font(.system(size: 48))
                            .foregroundStyle(Palette.muted)
                    }
            }
        }
    }
}

/// The song and artist under the station name. Fades in when the first title
/// arrives; a change fades out, swaps while invisible, then fades in, with the
/// same timings as desktop (250ms out, 600ms in). Going away (pause, stop)
/// fades out the way it came in, over 600ms, keeping the text until it's gone.
private struct StreamMeta: View {
    struct Content: Equatable {
        var song: String
        var artist: String?
        var isError: Bool
    }

    let meta: Content?
    @State private var shown: Content?
    @State private var visible: Bool
    @State private var swap: Task<Void, Never>?

    /// Starts already showing whatever is current, so on the push it's part of
    /// the screen's first frame and slides in with it. Filling it in from
    /// onAppear instead lands it in a later update, drawn in place while the
    /// screen slides under it.
    init(meta: Content?) {
        self.meta = meta
        _shown = State(initialValue: meta)
        _visible = State(initialValue: meta != nil)
    }

    var body: some View {
        VStack(spacing: 6) {
            if let shown {
                Text(shown.song)
                    .font(.system(size: 17))
                    .foregroundStyle(shown.isError ? Palette.accent : Palette.fg)
                    .lineLimit(2)
                if let artist = shown.artist {
                    Text(artist)
                        .font(.system(size: 15).italic())
                        .foregroundStyle(Palette.muted)
                        .lineLimit(1)
                }
            }
        }
        .multilineTextAlignment(.center)
        .fixedSize(horizontal: false, vertical: true)
        .opacity(visible ? 1 : 0)
        .onChange(of: meta) { _, next in show(next) }
    }

    private func show(_ next: Content?) {
        swap?.cancel()
        guard let next else {
            guard shown != nil else { return }
            withAnimation(.easeInOut(duration: 0.6)) { visible = false }
            swap = Task {
                try? await Task.sleep(for: .milliseconds(600))
                guard !Task.isCancelled else { return }
                shown = nil
            }
            return
        }
        if shown == nil {
            shown = next
            withAnimation(.easeInOut(duration: 0.6)) { visible = true }
            return
        }
        withAnimation(.easeInOut(duration: 0.25)) { visible = false }
        swap = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            shown = next
            withAnimation(.easeInOut(duration: 0.6)) { visible = true }
        }
    }
}
