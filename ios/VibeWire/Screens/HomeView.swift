import SwiftUI

/// 02A–02D · HOME · the condition report.
///
/// Answers three questions before the thumb moves — is it awake, is the link
/// good enough, which displays exist — then offers one 76pt way in. The three
/// unhappy states are designed with the same care as the happy one, because
/// those are the ones that waste the two minutes.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var retryCountdown = 22

    private enum Posture {
        case awake       // 02A
        case weak        // 02B
        case asleep      // 02C
        case connecting  // opening the socket — not a claim about the Mac
        case unreachable // 02D
    }

    private var posture: Posture {
        switch model.connection {
        case .failed, .idle, .unauthorized:
            // Both arms of the ternary that used to be here returned the same
            // thing, so the pairing check never meant anything.
            return .unreachable
        case .reconnecting:
            return .unreachable
        case .connecting:
            // Connecting used to report `asleep`, which showed a "Wake it"
            // button for a Mac that was fine and merely being dialled — and,
            // the other way round, a genuinely asleep Mac got a card reading
            // "CONNECTING · WAITING FOR THE FIRST HEARTBEAT".
            return .connecting
        case .connected:
            if !model.link.awake { return .asleep }
            return model.link.condition == .degraded ? .weak : .awake
        }
    }

    var body: some View {
        ScreenBody(scrolls: true) {
            VStack(alignment: .leading, spacing: 0) {
                ScreenHeader { model.route = .settings }

                machineTitle.padding(.top, 22)

                conditionCard.padding(.top, 24)

                if posture != .unreachable {
                    MonoCaps("DISPLAYS", size: 10, tracking: 2)
                        .padding(.top, 26)
                    displayList.padding(.top, 12)
                } else {
                    MonoCaps("MOST LIKELY, IN ORDER", size: 10, tracking: 2)
                        .padding(.top, 26)
                    causeList.padding(.top, 12)
                }

                Spacer(minLength: 12)

                footer
            }
            .padding(.bottom, 20)
        }
        .task { await countdownLoop() }
    }

    // MARK: Title

    private var machineTitle: some View {
        VStack(alignment: .leading, spacing: 7) {
            Text(model.hostName)
                .font(LG.Font.sans(30, weight: .medium))
                .foregroundStyle(posture == .asleep ? LG.Color.textSecondary : LG.Color.text)
            subtitle
        }
    }

    @ViewBuilder
    private var subtitle: some View {
        switch posture {
        case .awake:
            MonoCaps(
                [model.hostModel, "MACOS \(model.hostOS)", transportLabel]
                    .filter { !$0.isEmpty }
                    .joined(separator: " · "),
                size: 11,
                tracking: 1
            )
        case .weak:
            HStack(spacing: 4) {
                MonoCaps("LINK IS THIN OVER", size: 11, tracking: 1)
                MonoCaps(transportLabel, size: 11, color: LG.Color.amber, tracking: 1)
            }
        case .asleep:
            MonoCaps(
                "\(model.link.onPower ? "ON POWER" : "ON BATTERY") · DISPLAY OFF",
                size: 11,
                tracking: 1
            )
        case .connecting:
            MonoCaps(
                "\(model.link.onPower ? "ON POWER" : "ON BATTERY") · AWAITING HEARTBEAT",
                size: 11,
                tracking: 1
            )
        case .unreachable:
            HStack(spacing: 4) {
                MonoCaps("NO PATH TO THE MAC ·", size: 11, tracking: 1)
                MonoCaps(
                    model.transport.tailscaleRunning ? "TAILSCALE UP" : "TAILSCALE DOWN",
                    size: 11,
                    color: LG.Color.red,
                    tracking: 1
                )
            }
        }
    }

    /// Names the phone's radio alongside the path. "You are on GUEST-5G"
    /// is usually the actual bug, so it is stated rather than implied.
    private var transportLabel: String {
        let radio = model.linkMonitor.description
        switch model.transport.path {
        case .direct: return "\(radio) · DIRECT"
        case .relay:
            return model.transport.relayName.map { "\(radio) · RELAY \($0)" } ?? "\(radio) · RELAY"
        case .none: return "\(radio) · NO PATH"
        }
    }

    // MARK: Condition card

    @ViewBuilder
    private var conditionCard: some View {
        switch posture {
        case .awake, .weak:
            liveCard
        case .connecting:
            connectingCard
        case .asleep:
            asleepCard
        case .unreachable:
            unreachableCard
        }
    }

    private var liveCard: some View {
        let condition = model.link.condition
        return Panel(tint: condition.color) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    ConditionDot(condition: condition)
                    MonoCaps(
                        condition == .degraded ? "AWAKE · THIN LINK" : "AWAKE · REACHABLE",
                        size: 13,
                        color: condition.color,
                        weight: .medium
                    )
                    Spacer(minLength: 0)
                    SignalBars(filled: model.link.signalBars, color: condition.color)
                }

                HStack(spacing: 26) {
                    Readout(
                        label: "RTT",
                        value: model.link.rttMillis.map { String(Int($0)) },
                        unit: "MS",
                        valueColor: condition == .degraded ? LG.Color.amber : LG.Color.text
                    )
                    Readout(
                        label: "LOSS",
                        value: String(format: "%.1f", model.link.lossPercent),
                        unit: "%",
                        valueColor: condition == .degraded ? LG.Color.amber : LG.Color.text
                    )
                    Readout(
                        label: "DOWN",
                        value: String(format: "%.1f", model.link.downMbps),
                        unit: "MB",
                        valueColor: condition == .degraded ? LG.Color.amber : LG.Color.text
                    )
                }
                .padding(.top, 18)

                HStack(spacing: 10) {
                    Sparkline(values: model.link.rttHistory, color: condition.color)
                    MonoCaps(
                        condition == .degraded
                            ? "JITTER \(model.link.jitterMillis.map { String(Int($0)) } ?? "—")MS"
                            : "60S RTT",
                        size: 9,
                        tracking: 1.2
                    )
                }
                .padding(.top, 16)
            }
            .padding(18)
        }
    }

    /// Dashed rules replace live values. The layout does not move when it
    /// wakes — it just fills in.
    /// 02C. The Mac answered and told us it is asleep, so this states that
    /// rather than pretending the socket is still being opened. The "Wake it"
    /// action underneath belongs to this card, not to the connecting one.
    private var asleepCard: some View {
        Panel(tint: LG.Color.amber) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    ConditionDot(condition: .idle)
                    MonoCaps("ASLEEP", size: 13, color: LG.Color.amber, weight: .medium)
                    Spacer(minLength: 0)
                    SignalBars(filled: 0, color: LG.Color.stroke)
                }

                Text("The Mac is reachable but its display is off. Waking it takes a few seconds.")
                    .font(LG.Font.sans(15))
                    .foregroundStyle(LG.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 14)

                DashedRule().padding(.top, 16)

                MonoCaps(
                    model.link.onPower ? "ON POWER · WILL ANSWER" : "ON BATTERY · MAY NOT ANSWER",
                    size: 9,
                    tracking: 1.2
                )
                .padding(.top, 12)
            }
            .padding(18)
        }
    }

    private var connectingCard: some View {
        Panel {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    ConditionDot(condition: .idle)
                    MonoCaps("CONNECTING", size: 13, color: LG.Color.textSecondary, weight: .medium)
                    Spacer(minLength: 0)
                    SignalBars(filled: 0, color: LG.Color.stroke)
                }

                HStack(spacing: 26) {
                    Readout(label: "RTT", value: nil, unit: "MS")
                    Readout(label: "LOSS", value: nil, unit: "%")
                    Readout(label: "AGENT", value: "IDLE", unit: "", valueColor: LG.Color.textSecondary)
                }
                .padding(.top, 18)

                DashedRule().padding(.top, 16)

                MonoCaps("WAITING FOR THE FIRST HEARTBEAT", size: 9, tracking: 1.2)
                    .padding(.top, 12)
            }
            .padding(18)
        }
    }

    /// Both transports listed with their own verdict. A failure with an
    /// address, not one vague "offline".
    private var unreachableCard: some View {
        Panel(tint: LG.Color.red) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 10) {
                    Rectangle().fill(LG.Color.red).frame(width: 8, height: 8)
                    MonoCaps("UNREACHABLE", size: 13, color: LG.Color.red, weight: .medium)
                }

                Text(reconnectSentence)
                    .font(LG.Font.sans(15))
                    .foregroundStyle(LG.Color.text)
                    .padding(.top, 14)

                VStack(spacing: 9) {
                    transportRow(
                        "DIRECT · \(model.transport.tailscaleAddress ?? model.pairedHost?.host ?? "—")",
                        verdict: model.transport.path == .direct ? "OK" : "TIMEOUT",
                        ok: model.transport.path == .direct
                    )
                    transportRow(
                        "RELAY · \(model.transport.relayName ?? model.transport.cloudflareHostname ?? "NOT CONFIGURED")",
                        verdict: model.transport.path == .relay ? "OK"
                            : (model.transport.cloudflareRunning ? "NO HOST" : "OFF"),
                        ok: model.transport.path == .relay
                    )
                    transportRow(
                        "LAST CONTACT",
                        verdict: lastContactLabel,
                        ok: nil
                    )
                }
                .padding(.top, 16)
            }
            .padding(18)
        }
    }

    private func transportRow(_ label: String, verdict: String, ok: Bool?) -> some View {
        HStack {
            MonoCaps(label, size: 10, tracking: 1)
            Spacer(minLength: 8)
            MonoCaps(
                verdict,
                size: 10,
                color: ok == true ? LG.Color.green : (ok == nil ? LG.Color.textSecondary : LG.Color.red),
                tracking: 1
            )
        }
    }

    private var reconnectSentence: String {
        if case .reconnecting(let attempt, _) = model.connection {
            return "Tried \(attempt) time\(attempt == 1 ? "" : "s"). Nothing answered."
        }
        return "Nothing answered on either path."
    }

    private var lastContactLabel: String {
        guard let paired = model.pairedHost else { return "NEVER" }
        let elapsed = Date().timeIntervalSince(paired.pairedAt)
        if elapsed < 60 { return "JUST NOW" }
        if elapsed < 3600 { return "\(Int(elapsed / 60))M AGO" }
        return "\(Int(elapsed / 3600))H AGO"
    }

    // MARK: Lists

    private var displayList: some View {
        VStack(spacing: 8) {
            ForEach(model.displays) { display in
                DisplayRow(
                    display: display,
                    degraded: posture == .weak,
                    dimmed: posture == .asleep
                ) {
                    model.selectDisplay(display.id)
                }
            }

            if model.displays.count > 1 {
                Button {
                    model.selectBothDisplays()
                } label: {
                    HStack(spacing: 12) {
                        HStack(spacing: 3) {
                            ForEach(0..<2, id: \.self) { _ in
                                RoundedRectangle(cornerRadius: 2)
                                    .stroke(LG.Color.textTertiary, lineWidth: 1)
                                    .frame(width: 15, height: 20)
                            }
                        }
                        MonoCaps(
                            posture == .weak ? "SIDE BY SIDE · NEEDS 3 MB" : "SIDE BY SIDE · BOTH",
                            size: 11,
                            color: posture == .weak ? LG.Color.textTertiary : LG.Color.textSecondary,
                            tracking: 1.2
                        )
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 50)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                            .foregroundStyle(model.sideBySide ? LG.Color.cyan : LG.Color.hairline)
                    )
                }
                .buttonStyle(.plain)
                .disabled(posture == .weak)
            }
        }
    }

    /// Causes ranked by likelihood rather than alphabetised.
    private var causeList: some View {
        VStack(spacing: 1) {
            causeRow("01", "The Mac is asleep, or VibeWire is not running on it.", LG.Color.red)
            causeRow(
                "02",
                model.transport.tailscaleRunning
                    ? "You are off the tailnet, or the Mac dropped off it."
                    : "Tailscale is not running on the Mac.",
                LG.Color.amber
            )
            causeRow("03", "A VPN on the Mac is eating the route.", LG.Color.textTertiary)
        }
        .background(LG.Color.hairlineDim)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8).stroke(LG.Color.hairlineDim, lineWidth: 1)
        )
    }

    private func causeRow(_ number: String, _ text: String, _ color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            MonoCaps(number, size: 10, color: color, tracking: 0)
            Text(text)
                .font(LG.Font.sans(14))
                .foregroundStyle(color == LG.Color.textTertiary ? LG.Color.textSecondary : LG.Color.text)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 15)
        .background(LG.Color.raised)
    }

    // MARK: Footer

    @ViewBuilder
    private var footer: some View {
        switch posture {
        case .awake:
            VStack(spacing: 14) {
                PrimaryAction(
                    title: "View screen",
                    detail: preflightLabel,
                    glyph: "→",
                    tint: LG.Color.green,
                    ink: LG.Color.onGreen
                ) {
                    model.startStream()
                }
                claudeHandle
            }

        case .weak:
            VStack(spacing: 14) {
                HStack(spacing: 11) {
                    Rectangle().fill(LG.Color.amber).frame(width: 2)
                    Text("Text will be soft until the link recovers. Pointer input stays instant — only video is throttled.")
                        .font(LG.Font.sans(13))
                        .foregroundStyle(Color(hex: 0xC9A468))
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.leading, 12)
                .padding(.vertical, 13)
                .background(LG.Color.amber.opacity(0.07))

                PrimaryAction(
                    title: "View screen anyway",
                    detail: "540P · SOFT TEXT UNTIL IT RECOVERS",
                    glyph: "→",
                    tint: LG.Color.amber,
                    ink: LG.Color.onAmber
                ) {
                    model.startStream()
                }
                claudeHandle
            }

        case .connecting:
            VStack(alignment: .leading, spacing: 14) {
                Text("Waiting on the Mac to answer. Nothing is being retried in a loop — the battery is not the price of an unanswered question.")
                    .font(LG.Font.sans(13))
                    .foregroundStyle(LG.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

        case .asleep:
            VStack(alignment: .leading, spacing: 14) {
                Text("Its display is off. Waking it is a nudge, not a restart — anything you had open stays open.")
                    .font(LG.Font.sans(13))
                    .foregroundStyle(LG.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                PrimaryAction(
                    title: "Wake it",
                    detail: model.link.canWake
                        ? "NUDGES THE DISPLAY · USUALLY 4S"
                        : "MAC IS ON BATTERY — MAY NOT ANSWER",
                    glyph: "↑",
                    tint: LG.Color.cyan,
                    ink: LG.Color.onCyan
                ) {
                    model.wake()
                }
            }

        case .unreachable:
            VStack(spacing: 12) {
                Button {
                    model.requestLastFrame()
                } label: {
                    HStack(spacing: 12) {
                        RoundedRectangle(cornerRadius: 2)
                            .stroke(LG.Color.textTertiary, lineWidth: 1)
                            .frame(width: 30, height: 20)
                        MonoCaps("SHOW LAST FRAME", size: 11, color: LG.Color.textSecondary, tracking: 1)
                        Spacer(minLength: 0)
                        MonoCaps(
                            model.lastFrameAgeSeconds.map { "\($0 / 3600)H OLD" } ?? "IF ANY",
                            size: 10,
                            tracking: 0
                        )
                    }
                    .padding(.horizontal, 18)
                    .frame(height: 56)
                    .background(
                        RoundedRectangle(cornerRadius: LG.Metric.radiusMedium).fill(LG.Color.panel)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: LG.Metric.radiusMedium)
                            .stroke(LG.Color.hairline, lineWidth: 1)
                    )
                }
                .buttonStyle(.plain)

                PrimaryAction(
                    title: "Try again",
                    detail: "AUTO-RETRY IN \(retryCountdown)S · TAP TO GO NOW",
                    glyph: "↻",
                    tint: LG.Color.cyan,
                    ink: LG.Color.onCyan
                ) {
                    retryCountdown = 22
                    model.retry()
                }
            }
        }
    }

    private var preflightLabel: String {
        let display = model.displays.first(where: \.selected)
        let name = display.map { $0.name.uppercased() } ?? "NO DISPLAY"
        let ladder = model.settings.quality == "auto" ? "FIT" : model.settings.quality.uppercased()
        let estimate = model.link.rttMillis.map { Int($0 * 6 + 120) } ?? 800
        return "\(name) · \(ladder) · ~\(estimate)MS TO FIRST FRAME"
    }

    private var claudeHandle: some View {
        HStack {
            MonoCaps(
                model.sessionCount > 0 ? "SESSION \(model.sessionCount) THIS LAUNCH" : "NO SESSION YET",
                size: 10,
                tracking: 1.2
            )
            Spacer()
            Button {
                model.route = .claude
                model.listClaudeSessions()
            } label: {
                MonoCaps("CLAUDE ⌃", size: 10, color: LG.Color.cyan, tracking: 1.2)
                    .padding(.horizontal, 12)
                    .frame(height: LG.Metric.minimumTarget)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
        }
    }

    private func countdownLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            if posture == .unreachable {
                retryCountdown -= 1
                if retryCountdown <= 0 {
                    retryCountdown = 22
                    model.retry()
                }
            } else {
                retryCountdown = 22
            }
        }
    }
}

struct DisplayRow: View {
    let display: DisplayEntry
    var degraded: Bool
    var dimmed: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(display.selected ? LG.Color.cyan.opacity(0.14) : .clear)
                    .frame(width: 34, height: 22)
                    .overlay(
                        RoundedRectangle(cornerRadius: 2)
                            .strokeBorder(
                                style: StrokeStyle(lineWidth: 1, dash: dimmed ? [3, 3] : [])
                            )
                            .foregroundStyle(display.selected ? LG.Color.cyan : LG.Color.textTertiary)
                    )

                VStack(alignment: .leading, spacing: 3) {
                    Text(display.name)
                        .font(LG.Font.sans(15))
                        .foregroundStyle(dimmed ? LG.Color.textTertiary : LG.Color.text)
                    MonoCaps(
                        degraded && display.selected
                            ? "WILL OPEN AT 540P"
                            : (dimmed ? "LAST KNOWN \(display.width) × \(display.height)" : display.resolutionLabel),
                        size: 10,
                        color: degraded && display.selected ? LG.Color.amber : LG.Color.textTertiary,
                        tracking: 1
                    )
                }

                Spacer(minLength: 0)

                if display.selected {
                    MonoCaps("SELECTED", size: 10, color: LG.Color.cyan, tracking: 1.4)
                }
            }
            .padding(.horizontal, 16)
            .frame(height: 62)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(display.selected ? LG.Color.cyan.opacity(0.08) : LG.Color.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(display.selected ? LG.Color.cyan : LG.Color.hairline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }
}
