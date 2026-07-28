import SwiftUI

@main
struct VibeWireApp: App {
    @State private var model = AppModel()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(model)
                .preferredColorScheme(.dark)
                // Deliberately absent: light mode, a tab bar, an onboarding
                // tour. Fourteen screens is the whole application.
                .persistentSystemOverlays(.hidden)
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Which height the Claude panel opens at.
    ///
    /// Not a remembered preference — a fact about what is underneath it. Opened
    /// from the remote screen there is a live picture worth keeping in view, so
    /// it comes up half height; opened from Home there is nothing below to see,
    /// so it takes the screen. Dragging still overrides it for that session.
    @State private var claudeDetent: PresentationDetent = .large

    var body: some View {
        ZStack {
            LG.Color.screenGround.ignoresSafeArea()

            switch model.route {
            case .pairing:
                PairingView()
                    .transition(.opacity)
            case .home:
                HomeView()
                    .transition(.opacity)
            case .remote:
                RemoteView()
                    .transition(.opacity)
            }

            if let banner = model.banner {
                BannerView(text: banner) {
                    model.banner = nil
                }
            }
        }
        .animation(LG.Motion.stateChange, value: model.route)
        // Exactly one sheet modifier, driven by one value. Two modifiers here
        // would present only the first and drop the other without a word.
        .sheet(item: Binding(
            get: { model.presented },
            set: { model.presented = $0 }
        )) { presentation in
            switch presentation {
            case .settings:
                SettingsView()
                    .presentationDetents([.large])
                    // The app has one appearance and no system materials, so
                    // the sheet supplies its own ground rather than letting the
                    // default material show through.
                    .presentationBackground(LG.Color.screenGround)
            case .claude:
                ClaudePanelView()
                    .presentationDetents([.medium, .large], selection: $claudeDetent)
                    .presentationDragIndicator(.visible)
                    .presentationBackground(LG.Color.screenGround)
            }
        }
        .onChange(of: model.presented) { _, presented in
            guard presented == .claude else { return }
            claudeDetent = model.route == .remote ? .medium : .large
        }
        .task {
            await model.connectIfPaired()
        }
        // The QR on the Mac encodes exactly this URL, so the system camera can
        // open it straight into the app — no in-app scanner needed.
        .onOpenURL { url in
            Task { await model.handlePairingURL(url) }
        }
        .onChange(of: scenePhase) { _, phase in
            Task {
                switch phase {
                case .active:
                    await model.connectIfPaired()
                case .background:
                    // Nothing is left running on the Mac when the phone goes
                    // away — the socket close is what releases the streams.
                    await model.disconnect()
                default:
                    break
                }
            }
        }
    }
}

/// Errors are stated, not swallowed. Amber because a banner is always a
/// degraded condition, never a lost one — a lost condition gets a whole screen.
struct BannerView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let text: String
    let dismiss: () -> Void

    var body: some View {
        VStack {
            Spacer()
            HStack(alignment: .top, spacing: 12) {
                Rectangle()
                    .fill(LG.Color.amber)
                    .frame(width: 2)
                Text(text)
                    .font(LG.Font.sans(13))
                    .foregroundStyle(LG.Color.onAmberWash)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                Button(action: dismiss) {
                    Text("✕")
                        .font(LG.Font.mono(13))
                        .foregroundStyle(LG.Color.textSecondary)
                        .frame(width: 44, height: 44)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Dismiss message")
            }
            .padding(.leading, 14)
            .background(LG.Color.amber.opacity(0.07))
            .padding(.horizontal, LG.Metric.gutter)
            .padding(.bottom, 20)
        }
        .transition(LG.Motion.rise(reduced: reduceMotion))
    }
}
