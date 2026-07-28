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
            case .claude:
                ClaudePanelView()
                    .transition(LG.Motion.rise(reduced: reduceMotion))
            case .settings:
                SettingsView()
                    .transition(LG.Motion.push(reduced: reduceMotion))
            }

            if let banner = model.banner {
                BannerView(text: banner) {
                    model.banner = nil
                }
            }
        }
        .animation(LG.Motion.stateChange, value: model.route)
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
                    .foregroundStyle(Color(hex: 0xC9A468))
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
