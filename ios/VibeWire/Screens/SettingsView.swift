import SwiftUI

/// 07A · SETTINGS and 07B · REVOKE · CONFIRM.
///
/// Four groups, no search field, no icons in coloured squares. Every value that
/// affects the picture shows its cost in bytes or milliseconds, because that is
/// the only reason to come here.
struct SettingsView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScreenBody {
            ZStack {
                ScrollView {
                    VStack(alignment: .leading, spacing: 0) {
                        header

                        group("PAIRED") { pairedDevices }
                        group("VIDEO") { videoSection }
                        group("TRACKPAD") { trackpadSection }
                        group("ACCESS") { accessSection }

                        revokeEverything.padding(.top, 12)

                        MonoCaps(
                            "VIBEWIRE \(model.settings.appVersion) · HOST \(model.settings.hostVersion) · NO ACCOUNT, NO CLOUD",
                            size: 9,
                            color: LG.Color.textTertiary,
                            tracking: 1.2
                        )
                        .padding(.top, 10)
                        .padding(.bottom, 40)
                    }
                }
                .opacity(model.showRevokeConfirm == nil ? 1 : 0.22)
                .allowsHitTesting(model.showRevokeConfirm == nil)

                if let target = model.showRevokeConfirm {
                    Color(hex: 0x060709).opacity(0.72).ignoresSafeArea()
                    RevokeConfirmSheet(target: target)
                }
            }
        }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button {
                model.route = .home
            } label: {
                Text("←")
                    .font(LG.Font.mono(17))
                    .foregroundStyle(LG.Color.textSecondary)
                    .frame(width: 44, height: 44)
                    // Only the arrow's own strokes were tappable, and this is
                    // the sole way back out of settings.
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("back")
            .accessibilityLabel("Back")

            Text("Settings")
                .font(LG.Font.sans(22, weight: .medium))
                .foregroundStyle(LG.Color.text)
            Spacer()
        }
        .padding(.top, 8)
    }

    private func group<Content: View>(
        _ title: String,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            MonoCaps(title, size: 10, tracking: 2)
            content()
        }
        .padding(.top, 20)
    }

    // MARK: Paired

    private var pairedDevices: some View {
        VStack(spacing: 0) {
            ForEach(model.devices) { device in
                HStack(spacing: 12) {
                    RoundedRectangle(cornerRadius: device.kind == "tablet" ? 2 : 3)
                        .stroke(device.isThisDevice ? LG.Color.cyan : LG.Color.textTertiary, lineWidth: 1)
                        .frame(
                            width: device.kind == "tablet" ? 28 : 20,
                            height: device.kind == "tablet" ? 22 : 30
                        )

                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.name)
                            .font(LG.Font.sans(15))
                            .foregroundStyle(LG.Color.text)
                        MonoCaps(
                            device.isThisDevice
                                ? "THIS DEVICE · PAIRED \(shortDate(device.pairedAt))"
                                : lastSeenLabel(device),
                            size: 9,
                            color: device.isThisDevice ? LG.Color.cyan : LG.Color.textTertiary,
                            tracking: 1.2
                        )
                    }

                    Spacer(minLength: 8)

                    if !device.isThisDevice {
                        Button {
                            model.showRevokeConfirm = .device(device)
                        } label: {
                            MonoCaps("REVOKE", size: 10, color: LG.Color.red, tracking: 1)
                                .padding(.horizontal, 14)
                                .frame(height: 44)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(LG.Color.red.opacity(0.4), lineWidth: 1)
                                )
                        }
                        .buttonStyle(.plain)
                    }
                }
                .frame(minHeight: 50)
                .overlay(alignment: .bottom) { Hairline(color: LG.Color.chrome) }
            }

            if model.devices.isEmpty {
                MonoCaps("NO DEVICES REPORTED BY THE HOST", size: 10, tracking: 1.2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .frame(height: 50)
            }
        }
    }

    private func lastSeenLabel(_ device: PairedDeviceEntry) -> String {
        guard let lastSeen = device.lastSeenAt else { return "NEVER CONNECTED" }
        let elapsed = Date().timeIntervalSince(lastSeen)
        // Under a minute this read "0 MIN AGO", and a host clock a few seconds
        // ahead of the phone's read "-1 MIN AGO".
        if elapsed < 60 { return "LAST SEEN JUST NOW" }
        if elapsed < 3600 { return "LAST SEEN \(count(elapsed / 60, "MIN")) AGO" }
        if elapsed < 86400 { return "LAST SEEN \(count(elapsed / 3600, "HOUR")) AGO" }
        return "LAST SEEN \(count(elapsed / 86400, "DAY")) AGO"
    }

    /// "1 DAY", not "1 DAYS".
    private func count(_ value: Double, _ noun: String) -> String {
        let whole = Int(value)
        return "\(whole) \(noun)\(whole == 1 ? "" : "S")"
    }

    private func shortDate(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "d MMM"
        return formatter.string(from: date).uppercased()
    }

    // MARK: Video

    private var videoSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Segmented(
                options: [
                    (value: "auto", label: "AUTO", badge: nil),
                    (value: "1080", label: "1080", badge: nil),
                    (value: "720", label: "720", badge: nil),
                    (value: "540", label: "540", badge: nil),
                ],
                selection: Binding(
                    get: { model.settings.quality },
                    set: { model.setQuality($0) }
                )
            )

            HStack {
                MonoCaps(nowLabel, size: 9, tracking: 1.2)
                Spacer()
                MonoCaps("DROPS ON ITS OWN", size: 9, color: LG.Color.textSecondary, tracking: 1.2)
            }

            SettingRow(
                title: "Cap on cellular",
                subtitle: "CEILING \(Int(model.settings.cellularCeilingMbps)) MB/S",
                isOn: Binding(
                    get: { model.settings.capOnCellular },
                    set: { model.setSetting("capOnCellular", $0) }
                )
            )
        }
    }

    private var nowLabel: String {
        guard let config = model.videoConfigs.values.first else { return "NOT STREAMING" }
        let rtt = model.link.rttMillis.map { "\(Int($0))MS" } ?? "—"
        return "NOW: \(config.height)P · \(String(format: "%.1f", config.bitrateMbps)) MB/S · \(rtt)"
    }

    // MARK: Trackpad

    private var trackpadSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Sensitivity")
                    .font(LG.Font.sans(15))
                    .foregroundStyle(LG.Color.text)
                Spacer()
                MonoCaps("\(model.settings.sensitivity) / 8", size: 11, color: LG.Color.cyan, tracking: 0)
            }

            // Eight ticks rather than a continuous slider, because a thumb can
            // hit a tick. The readout says what a swipe is worth in pixels.
            HStack(spacing: 6) {
                ForEach(1...8, id: \.self) { tick in
                    Button {
                        model.setSetting("sensitivity", tick)
                    } label: {
                        Rectangle()
                            .fill(tick <= model.settings.sensitivity ? LG.Color.cyan : LG.Color.stroke)
                            .frame(width: 4, height: 10 + CGFloat(tick - 1) * 4)
                            .frame(width: 22, height: 44)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
                Spacer(minLength: 0)
                MonoCaps("\(model.settings.sensitivity * 216)PX / SWIPE", size: 9, tracking: 1)
            }

            SettingRow(
                title: "Natural scrolling",
                subtitle: nil,
                isOn: Binding(
                    get: { model.settings.naturalScrolling },
                    set: { model.setSetting("naturalScrolling", $0) }
                )
            )
        }
    }

    // MARK: Access

    private var accessSection: some View {
        VStack(spacing: 0) {
            SettingRow(
                title: "Face ID each session",
                subtitle: "ADDS ~0.4S TO OPEN",
                isOn: Binding(
                    get: { model.settings.requireBiometricEachSession },
                    set: { model.setSetting("requireBiometricEachSession", $0) }
                )
            )
            .overlay(alignment: .bottom) { Hairline(color: LG.Color.chrome) }

            SettingRow(
                title: "Relay over internet",
                subtitle: relaySubtitle,
                subtitleColor: model.settings.relayOverInternet ? LG.Color.amber : LG.Color.textTertiary,
                isOn: Binding(
                    get: { model.settings.relayOverInternet },
                    set: { model.setSetting("relayOverInternet", $0) }
                )
            )
        }
    }

    private var relaySubtitle: String {
        if model.settings.relayOverInternet {
            if let hostname = model.transport.cloudflareHostname {
                return "ON · \(hostname.replacingOccurrences(of: "https://", with: ""))"
            }
            return "ON · STARTING TUNNEL…"
        }
        return model.transport.tailscaleRunning
            ? "OFF · TAILSCALE COVERS REMOTE ACCESS"
            : "OFF · NO REMOTE PATH CONFIGURED"
    }

    private var revokeEverything: some View {
        Button {
            // Goes through the same sheet as a single revoke. Revoking one
            // device asked for confirmation; revoking all of them, including
            // this phone, went straight through on one tap.
            model.showRevokeConfirm = .everything(count: model.devices.count)
        } label: {
            HStack {
                Text("Revoke every device")
                    .font(LG.Font.sans(15))
                    .foregroundStyle(LG.Color.red)
                Spacer()
                // Solid, not 70%: the count is the scale of what the tap
                // destroys, and the faded version read at 3.4:1.
                MonoCaps("\(model.devices.count) KEYS", size: 9, color: LG.Color.red, tracking: 1.2)
            }
            .padding(.horizontal, 18)
            .frame(height: 54)
            .overlay(
                RoundedRectangle(cornerRadius: LG.Metric.radiusMedium)
                    .stroke(LG.Color.red.opacity(0.4), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}

struct SettingRow: View {
    let title: String
    var subtitle: String?
    var subtitleColor: Color = LG.Color.textTertiary
    @Binding var isOn: Bool

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(LG.Font.sans(15))
                    .foregroundStyle(LG.Color.text)
                if let subtitle {
                    MonoCaps(subtitle, size: 9, color: subtitleColor, tracking: 1.2)
                }
            }
            Spacer(minLength: 8)
            LGToggle(isOn: $isOn)
        }
        .frame(minHeight: 50)
    }
}

/// 07B. Three consequences in plain sentences, including the one that is *not*
/// affected — that last line is what makes a destructive tap safe to make
/// one-handed. The confirming verb is the same word as the button that opened
/// it.
struct RevokeConfirmSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let target: AppModel.RevokeTarget

    private var title: String {
        switch target {
        case .device(let device): return "REVOKE \(device.name)"
        case .everything(let count): return "REVOKE ALL \(count) DEVICES"
        }
    }

    private var headline: String {
        switch target {
        case .device: return "Its key is deleted on the Mac. There is no undo."
        case .everything: return "Every key is deleted on the Mac. There is no undo."
        }
    }

    /// The third line is the one that makes the tap safe to judge: for a single
    /// device it says what keeps working, and for all of them it says plainly
    /// that this phone is included, which is the part a one-tap button hid.
    private var consequences: [(String, Color)] {
        switch target {
        case .device:
            return [
                ("Any live session from that device ends inside 1s.", LG.Color.red),
                ("Pairing again needs physical access to the Mac.", LG.Color.red),
                ("This iPhone keeps working. Nothing else changes.", LG.Color.textTertiary),
            ]
        case .everything:
            return [
                ("Every live session ends inside 1s.", LG.Color.red),
                ("This iPhone is included. You will be signed out.", LG.Color.red),
                ("Pairing again needs physical access to the Mac.", LG.Color.red),
            ]
        }
    }

    private var confirmLabel: String {
        switch target {
        case .device: return "Revoke it"
        case .everything: return "Revoke everything"
        }
    }

    private var cancelLabel: String {
        switch target {
        case .device: return "KEEP IT PAIRED"
        case .everything: return "KEEP THEM PAIRED"
        }
    }

    private var auditSubject: String {
        switch target {
        case .device(let device): return device.name.uppercased()
        case .everything(let count): return "ALL \(count) DEVICES"
        }
    }

    private var auditNoun: String {
        switch target {
        case .device: return "KEY"
        case .everything(let count): return count == 1 ? "KEY" : "KEYS"
        }
    }

    var body: some View {
        VStack {
            Spacer()
            VStack(alignment: .leading, spacing: 18) {
                Capsule()
                    .fill(LG.Color.stroke)
                    .frame(width: 46, height: 4)
                    .frame(maxWidth: .infinity)

                VStack(alignment: .leading, spacing: 10) {
                    MonoCaps(title, size: 10, color: LG.Color.red, tracking: 1.8)
                    Text(headline)
                        .font(LG.Font.sans(24))
                        .foregroundStyle(LG.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                }

                VStack(spacing: 1) {
                    ForEach(Array(consequences.enumerated()), id: \.offset) { _, line in
                        consequence(line.0, line.1)
                    }
                }
                .background(LG.Color.chrome)
                .clipShape(RoundedRectangle(cornerRadius: 8))

                VStack(spacing: 9) {
                    Button {
                        switch target {
                        case .device(let device): model.revoke(device)
                        case .everything: model.revokeAll()
                        }
                    } label: {
                        Text(confirmLabel)
                            .font(LG.Font.sans(17, weight: .medium))
                            .foregroundStyle(LG.Color.onRed)
                            .frame(maxWidth: .infinity)
                            .frame(height: 60)
                            .background(RoundedRectangle(cornerRadius: 10).fill(LG.Color.red))
                    }
                    .buttonStyle(.plain)

                    Button {
                        model.showRevokeConfirm = nil
                    } label: {
                        MonoCaps(cancelLabel, size: 11, color: LG.Color.textSecondary, tracking: 1.2)
                            .frame(maxWidth: .infinity)
                            .frame(height: 52)
                            .overlay(
                                RoundedRectangle(cornerRadius: 10)
                                    .stroke(LG.Color.hairline, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                }

                MonoCaps(
                    "HOST WILL LOG: REVOKED · \(auditSubject) · \(auditNoun) DELETED",
                    size: 9,
                    color: LG.Color.textTertiary,
                    tracking: 1.2
                )
                .frame(maxWidth: .infinity)
            }
            .padding(.horizontal, 22)
            .padding(.top, 26)
            .padding(.bottom, 44)
            .background(
                UnevenRoundedRectangle(topLeadingRadius: 18, topTrailingRadius: 18)
                    .fill(LG.Color.raised)
            )
            .overlay(alignment: .top) {
                Rectangle().fill(LG.Color.red.opacity(0.34)).frame(height: 1)
            }
        }
        .ignoresSafeArea(edges: .bottom)
        .transition(LG.Motion.rise(reduced: reduceMotion))
    }

    private func consequence(_ text: String, _ arrowColor: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 11) {
            Text("→")
                .font(LG.Font.mono(10))
                .foregroundStyle(arrowColor)
            Text(text)
                .font(LG.Font.sans(14))
                .foregroundStyle(arrowColor == LG.Color.textTertiary ? LG.Color.textSecondary : LG.Color.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 13)
        .background(LG.Color.screenGround)
    }
}
