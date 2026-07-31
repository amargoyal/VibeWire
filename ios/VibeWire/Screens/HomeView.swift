import SwiftUI

/// 03 · HOME — THE CONSOLE and 04 · HOME — UNREACHABLE.
///
/// Home shows the Mac instead of describing it.
///
/// The screen used to answer three questions in prose and numbers — is it awake,
/// is the link good enough, which displays exist — and then offer a way in at the
/// bottom. Every one of those answers is still here and still measured, but the
/// last frame the Mac sent is now the largest thing on the screen and is itself
/// the way in, so the numbers shrink to one strip and the displays to one row of
/// chips.
///
/// The three unhappy states are designed with the same care as the happy one,
/// because those are the ones that waste the two minutes.
///
/// Past `NS.Metric.wide` the same content becomes two columns rather than a phone
/// column stranded in the middle of an iPad: the picture and the way in on the
/// left, the readings on a rail to the right. Nothing is rendered twice — the
/// pieces are the same views in a different container.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var retryCountdown = 22

    private enum Posture {
        case awake
        case weak
        case asleep
        case connecting  // opening the socket — not a claim about the Mac
        case unreachable
    }

    private var posture: Posture {
        switch model.connection {
        case .failed, .idle, .unauthorized:
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

    private var condition: Condition {
        switch posture {
        case .awake: return .reachable
        case .weak: return .degraded
        case .unreachable: return .lost
        case .asleep, .connecting: return .idle
        }
    }

    var body: some View {
        GeometryReader { proxy in
            let wide = proxy.size.width >= NS.Metric.wide

            ScreenBody(scrolls: !wide, wide: wide) {
                VStack(alignment: .leading, spacing: 0) {
                    topBar(wide: wide)

                    if wide {
                        HStack(alignment: .top, spacing: 22) {
                            VStack(alignment: .leading, spacing: 16) {
                                hero
                                HStack(spacing: 10) { footer }
                            }
                            .frame(maxWidth: .infinity)

                            VStack(alignment: .leading, spacing: 14) { rail }
                                .frame(width: NS.Metric.rail)
                        }
                        .padding(.top, 4)
                        .padding(.bottom, 20)
                    } else {
                        machineTitle.padding(.top, 10)
                        hero.padding(.top, 14)
                        VStack(alignment: .leading, spacing: 14) { rail }
                            .padding(.top, 14)
                        Spacer(minLength: 14)
                        VStack(spacing: 9) { footer }
                            .padding(.bottom, 20)
                    }
                }
            }
        }
        .task { await countdownLoop() }
    }

    // MARK: The bar and the title

    /// On a phone the machine name is a 36pt heading under this bar. Where there
    /// is room it moves up into the bar beside the wordmark, with the link
    /// condition as a pill on the right — a 36pt name above a two-column layout
    /// is a title for a page rather than a label for the left-hand picture.
    private func topBar(wide: Bool) -> some View {
        HStack(spacing: 18) {
            MonoCaps(
                "VibeWire",
                size: 11,
                color: NS.Color.textSecondary,
                tracking: 3.5,
                weight: .medium
            )

            if wide {
                Rectangle()
                    .fill(NS.Color.hairline)
                    .frame(width: 1, height: 20)
                HStack(spacing: 10) {
                    ConditionDot(condition: condition, size: 8)
                    Text(model.hostName)
                        .font(NS.Font.sans(19, weight: .semibold))
                        .tracking(-0.4)
                        .foregroundStyle(NS.Color.text)
                    MonoCaps(machineLine.text, size: 10, color: machineLine.tone, tracking: 1)
                        .lineLimit(1)
                }
            }

            Spacer(minLength: 0)

            if wide {
                MonoCaps(pillLabel, size: 10, color: condition.color, tracking: 1.4)
                    .padding(.horizontal, 14)
                    .frame(minHeight: 36)
                    .background(Capsule().fill(condition.color.opacity(0.12)))
            }

            OverflowButton { model.presented = .settings }
        }
        .frame(minHeight: 40)
        .padding(.vertical, 10)
    }

    private var pillLabel: String {
        switch posture {
        case .awake, .weak:
            let rtt = model.link.rttMillis.map { "\(Int($0))MS" } ?? "—"
            return "\(transportLabel) · \(rtt)"
        case .asleep: return "ASLEEP"
        case .connecting: return "CONNECTING"
        case .unreachable: return "UNREACHABLE"
        }
    }

    private var machineTitle: some View {
        VStack(alignment: .leading, spacing: 7) {
            HStack(spacing: 10) {
                ConditionDot(condition: condition)
                DisplayTitle(
                    model.hostName,
                    size: 36,
                    color: posture == .asleep ? NS.Color.textSecondary : NS.Color.text
                )
            }
            MonoCaps(machineLine.text, size: 10, color: machineLine.tone, tracking: 1)
                .padding(.leading, 19)
        }
        .padding(.vertical, 4)
    }

    /// The caption under the machine name: what it is, and how this client
    /// reaches it.
    private var machineLine: (text: String, tone: Color) {
        switch posture {
        case .awake:
            let parts = [model.hostModel, "MACOS \(model.hostOS)", transportLabel]
                .filter { !$0.isEmpty }
            return (parts.joined(separator: " · "), NS.Color.textTertiary)
        case .weak:
            return ("LINK IS THIN OVER \(transportLabel)", NS.Color.amber)
        case .asleep:
            return ("\(model.link.onPower ? "ON POWER" : "ON BATTERY") · DISPLAY OFF", NS.Color.textTertiary)
        case .connecting:
            return (
                "\(model.link.onPower ? "ON POWER" : "ON BATTERY") · AWAITING HEARTBEAT",
                NS.Color.textTertiary
            )
        case .unreachable:
            let tailscale = model.transport.tailscaleRunning ? "TAILSCALE UP" : "TAILSCALE DOWN"
            return ("NO PATH TO THE MAC · \(tailscale)", NS.Color.red)
        }
    }

    /// Names the phone's radio alongside the path. "You are on GUEST-5G" is
    /// usually the actual bug, so it is stated rather than implied.
    private var transportLabel: String {
        let radio = model.linkMonitor.description
        switch model.transport.path {
        case .direct: return "\(radio) · DIRECT"
        case .relay:
            return model.transport.relayName.map { "\(radio) · RELAY \($0)" } ?? "\(radio) · RELAY"
        case .none: return "\(radio) · NO PATH"
        }
    }

    // MARK: The hero

    /// The Mac's screen, at whatever age it is, and the way in.
    ///
    /// The whole rectangle is the button. A picture of the thing being reached
    /// for is a better target than a word for it, and it is the one control on
    /// this screen that does not have to be read to be understood. When there is
    /// nothing to show it stays a hatched frame with its corner ticks — an empty
    /// frame, never a black one, because a black rectangle is a claim about what
    /// the Mac is displaying.
    private var hero: some View {
        let lost = posture == .unreachable
        let selected = model.displays.first(where: \.selected)
        let renderer = model.renderer(forDisplay: selected?.id ?? 0)
        // A renderer having painted is not enough to show its picture here.
        //
        // Until the host answers a `selectDisplay`, an unstreamed display resolves
        // to stream 0 — which is the decoder the *previous* display filled, still
        // holding its last frame. Selecting the second monitor on this screen would
        // otherwise put the first one's picture under the second one's caption: the
        // one lie this screen is built to not tell. So the hero shows a picture only
        // when a `videoConfig` actually maps the selected display to a stream.
        let carried = selected.map { display in
            model.videoConfigs.values.contains { $0.displayId == display.id }
        } ?? false
        let painted = carried && renderer.framesRendered > 0
        let openable = posture == .awake || posture == .weak

        return Button {
            if openable { model.startStream() } else { model.requestLastFrame() }
        } label: {
            ZStack {
                Hatch()

                if painted {
                    VideoSurface(renderer: renderer)
                } else {
                    MonoCaps(
                        lost ? "LAST FRAME" : "MAC SCREEN",
                        size: 10,
                        color: NS.Color.textDisabled,
                        tracking: NS.Metric.capsTrackingWide
                    )
                }

                CornerTicks(color: lost ? NS.Color.red.opacity(0.7) : NS.Color.accent.opacity(0.7))

                VStack {
                    VideoCaption(ageChip.text, color: ageChip.tone)
                        .padding(.top, 14)
                    Spacer(minLength: 0)
                    if let display = model.displays.first(where: \.selected) {
                        VideoCaption("\(display.name.uppercased()) · \(display.width) × \(display.height)")
                            .padding(.bottom, 14)
                    }
                }
            }
            // The lost screen keeps a smaller picture: the causes underneath it
            // are what the user came to read, and a full-height frame of
            // three-hour-old pixels pushes them off the screen.
            .frame(minHeight: lost ? 128 : 226, maxHeight: lost ? 128 : .infinity)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: NS.Metric.radiusCardLarge))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(openable ? "View the Mac’s screen" : "Ask the Mac for its last frame")
    }

    private var ageChip: (text: String, tone: Color) {
        guard let age = model.lastFrameAgeSeconds else {
            return ("NO FRAME YET", NS.Color.textSecondary)
        }
        if age < 60 { return ("LAST FRAME · \(age)S AGO", NS.Color.green) }
        if age < 3600 { return ("LAST FRAME · \(age / 60)M AGO", NS.Color.textSecondary) }
        return ("\(age / 3600)H OLD · TAP TO OPEN", NS.Color.amber)
    }

    // MARK: The rail

    @ViewBuilder
    private var rail: some View {
        conditionStrip

        if posture == .unreachable {
            causes
        } else {
            displays
        }
    }

    @ViewBuilder
    private var conditionStrip: some View {
        switch posture {
        case .awake, .weak: liveStrip
        case .connecting: pendingStrip(label: "CONNECTING", detail: "WAITING FOR THE FIRST HEARTBEAT")
        case .asleep: asleepStrip
        case .unreachable: unreachableStrip
        }
    }

    /// One card, one strip of readings.
    ///
    /// RTT is set larger than loss and downstream beside it, because three
    /// numbers at the same size is a table and the eye has to read all of it.
    /// RTT is the one that decides whether this session is going to be worth
    /// having.
    private var liveStrip: some View {
        let condition = model.link.condition
        let degraded = condition == .degraded
        let valueColor = degraded ? NS.Color.amber : NS.Color.text

        return Card {
            VStack(alignment: .leading, spacing: 15) {
                HStack(spacing: 9) {
                    MonoCaps(
                        degraded ? "THIN LINK" : "REACHABLE",
                        size: 10,
                        color: condition.color,
                        tracking: 1.8,
                        weight: .medium
                    )
                    Spacer(minLength: 8)
                    Sparkline(values: model.link.rttHistory, color: condition.color)
                        .frame(maxWidth: 150)
                    MonoCaps("60S", size: 8, tracking: 1.2)
                }

                HStack(alignment: .bottom, spacing: 20) {
                    Readout(
                        label: "RTT",
                        value: model.link.rttMillis.map { String(Int($0)) },
                        unit: "MS",
                        valueColor: valueColor,
                        lead: true
                    )
                    Readout(
                        label: "LOSS",
                        value: String(format: "%.1f", model.link.lossPercent),
                        unit: "%",
                        valueColor: degraded ? NS.Color.amber : NS.Color.textSecondary
                    )
                    Readout(
                        label: "DOWN",
                        value: String(format: "%.1f", model.link.downMbps),
                        unit: "MB/S",
                        valueColor: degraded ? NS.Color.amber : NS.Color.textSecondary
                    )
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
    }

    /// The Mac answered and told us it is asleep, so this states that rather
    /// than pretending the socket is still being opened. A dashed rule replaces
    /// live values; the layout does not move when it wakes — it just fills in.
    private var asleepStrip: some View {
        Card(tint: NS.Color.amber) {
            VStack(alignment: .leading, spacing: 13) {
                HStack(spacing: 9) {
                    ConditionDot(condition: .idle, size: 7)
                    MonoCaps("ASLEEP", size: 10, color: NS.Color.amber, tracking: 1.8, weight: .medium)
                }
                Text("The Mac is reachable but its display is off. Waking it takes a few seconds.")
                    .font(NS.Font.sans(15))
                    .foregroundStyle(NS.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                DashedRule()
                MonoCaps(
                    model.link.onPower ? "ON POWER · WILL ANSWER" : "ON BATTERY · MAY NOT ANSWER",
                    size: 9,
                    tracking: 1.2
                )
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 17)
        }
    }

    private func pendingStrip(label: String, detail: String) -> some View {
        Card {
            VStack(alignment: .leading, spacing: 15) {
                HStack(spacing: 9) {
                    ConditionDot(condition: .idle, size: 7)
                    MonoCaps(label, size: 10, color: NS.Color.textSecondary, tracking: 1.8, weight: .medium)
                }
                HStack(alignment: .bottom, spacing: 20) {
                    Readout(label: "RTT", value: nil, unit: "MS", lead: true)
                    Readout(label: "LOSS", value: nil, unit: "%")
                    Readout(label: "DOWN", value: nil, unit: "MB/S")
                    Spacer(minLength: 0)
                }
                DashedRule()
                MonoCaps(detail, size: 9, tracking: 1.2)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 16)
        }
    }

    /// Both transports listed with their own verdict. A failure with an address,
    /// not one vague "offline".
    private var unreachableStrip: some View {
        Card {
            VStack(alignment: .leading, spacing: 13) {
                Text(reconnectSentence)
                    .font(NS.Font.sans(15, weight: .medium))
                    .foregroundStyle(NS.Color.text)
                    .fixedSize(horizontal: false, vertical: true)

                VStack(spacing: 9) {
                    transportRow(
                        "DIRECT · \(model.transport.tailscaleAddress ?? model.pairedHost?.host ?? "—")",
                        verdict: model.transport.path == .direct ? "OK" : "TIMEOUT",
                        ok: model.transport.path == .direct
                    )
                    transportRow(
                        "RELAY · \(model.transport.relayName ?? model.transport.cloudflareHostname ?? "NOT CONFIGURED")",
                        verdict: model.transport.path == .relay
                            ? "OK"
                            : (model.transport.cloudflareRunning ? "NO HOST" : "OFF"),
                        ok: model.transport.path == .relay
                    )
                    transportRow("LAST CONTACT", verdict: lastContactLabel, ok: nil)
                }
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 17)
        }
    }

    private func transportRow(_ label: String, verdict: String, ok: Bool?) -> some View {
        HStack(spacing: 8) {
            MonoCaps(label, size: 9, tracking: 1)
                .lineLimit(1)
            Spacer(minLength: 8)
            MonoCaps(
                verdict,
                size: 9,
                color: ok == true ? NS.Color.green : (ok == nil ? NS.Color.textSecondary : NS.Color.red),
                tracking: 1.2
            )
        }
    }

    private var reconnectSentence: String {
        if case .reconnecting(let attempt, _) = model.connection {
            return "Tried \(attempt) time\(attempt == 1 ? "" : "s"). Nothing answered on either path."
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

    // MARK: Displays

    /// A connected, awake Mac reporting no displays is not an empty list — it is
    /// almost always Screen Recording permission missing, because that is what
    /// ScreenCaptureKit returns nothing without.
    private var noDisplays: some View {
        Card(tint: NS.Color.amber) {
            VStack(alignment: .leading, spacing: 10) {
                Text("The Mac answered, but reports no displays.")
                    .font(NS.Font.sans(15))
                    .foregroundStyle(NS.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                Text("Screen Recording permission is the usual cause. On the Mac: System Settings → Privacy & Security → Screen Recording → VibeWire.")
                    .font(NS.Font.sans(13))
                    .foregroundStyle(NS.Color.onAmberWash)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// Which screen, as a row of chips.
    ///
    /// A display is a shape and one word, and both fit in a 64pt chip laid
    /// across one row under the readings. The full name and resolution are on
    /// the hero's own caption and in the accessibility label, so nothing is
    /// lost by not spelling them out twice.
    private var displays: some View {
        VStack(alignment: .leading, spacing: 10) {
            SectionLabel("DISPLAYS")

            if model.displays.isEmpty {
                // "The Mac answered, but reports no displays" is a claim about a
                // machine that has answered. While the socket is still opening,
                // or while the Mac is asleep, nothing has answered — and printing
                // a permission diagnosis over a connection that has not completed
                // sends the reader to System Settings to fix a problem they do not
                // have. Before the first heartbeat the heading stands over a
                // dashed rule and the condition strip carries the state.
                if posture == .awake || posture == .weak {
                    noDisplays
                } else {
                    DashedRule().padding(.vertical, 14)
                }
            } else {
                HStack(spacing: 8) {
                    ForEach(model.displays) { display in
                        DisplayChip(
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
                            VStack(spacing: 6) {
                                HStack(spacing: 2) {
                                    ForEach(0..<2, id: \.self) { _ in
                                        RoundedRectangle(cornerRadius: NS.Metric.radiusScreen)
                                            .stroke(NS.Color.textTertiary, lineWidth: 1)
                                            .frame(width: 11, height: 15)
                                    }
                                }
                                MonoCaps("BOTH", size: 8, tracking: 1.2)
                            }
                            .frame(maxWidth: .infinity)
                            .frame(height: 64)
                            .overlay(
                                RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                    .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                                    .foregroundStyle(model.sideBySide ? NS.Color.accent : NS.Color.stroke)
                            )
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .disabled(posture == .weak)
                        .opacity(posture == .weak ? 0.55 : 1)
                        .accessibilityLabel(
                            posture == .weak
                                ? "Side by side, needs 3 megabits"
                                : "Both displays side by side"
                        )
                    }
                }
            }
        }
    }

    /// Causes ranked by likelihood rather than alphabetised.
    private var causes: some View {
        let rows: [(String, String, Color)] = [
            ("01", "The Mac is asleep, or VibeWire is not running on it.", NS.Color.red),
            (
                "02",
                model.transport.tailscaleRunning
                    ? "You are off the tailnet, or the Mac dropped off it."
                    : "Tailscale is not running on the Mac.",
                NS.Color.amber
            ),
            ("03", "A VPN on the Mac is eating the route.", NS.Color.textTertiary),
        ]

        return VStack(alignment: .leading, spacing: 9) {
            SectionLabel("MOST LIKELY, IN ORDER")
            VStack(spacing: NS.Metric.groupGap) {
                ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                    HStack(alignment: .top, spacing: 12) {
                        MonoCaps(row.0, size: 10, color: row.2, tracking: 0)
                        Text(row.1)
                            .font(NS.Font.sans(13))
                            .foregroundStyle(
                                row.2 == NS.Color.textTertiary ? NS.Color.textSecondary : NS.Color.text
                            )
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                    }
                    .padding(.horizontal, 16)
                    .padding(.vertical, 13)
                    .frame(minHeight: 50)
                    .groupedRow(GroupPosition.at(index, of: rows.count))
                }
            }
        }
    }

    // MARK: The way forward

    @ViewBuilder
    private var footer: some View {
        switch posture {
        case .awake:
            PrimaryAction(
                title: "View screen",
                detail: preflightLabel,
                glyph: "→",
                tint: NS.Color.green,
                ink: NS.Color.onGreen,
                // Nothing to open, and the strip above now says why.
                enabled: !model.displays.isEmpty
            ) {
                model.startStream()
            }
            claudeHandle

        case .weak:
            Text("Text will be soft until the link recovers. Pointer input stays instant — only video is throttled.")
                .font(NS.Font.sans(13))
                .foregroundStyle(NS.Color.onAmberWash)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.vertical, 13)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .fill(NS.Color.amber.opacity(0.08))
                )

            PrimaryAction(
                title: "View screen anyway",
                detail: "540P · SOFT TEXT UNTIL IT RECOVERS",
                glyph: "→",
                tint: NS.Color.amber,
                ink: NS.Color.onAmber
            ) {
                model.startStream()
            }
            claudeHandle

        case .connecting:
            Text("Waiting on the Mac to answer. Nothing is being retried in a loop — the battery is not the price of an unanswered question.")
                .font(NS.Font.sans(13))
                .foregroundStyle(NS.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

        case .asleep:
            Text("Its display is off. Waking it is a nudge, not a restart — anything you had open stays open.")
                .font(NS.Font.sans(13))
                .foregroundStyle(NS.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            PrimaryAction(
                title: "Wake it",
                detail: model.link.canWake
                    ? "NUDGES THE DISPLAY · USUALLY 4S"
                    : "MAC IS ON BATTERY — MAY NOT ANSWER",
                glyph: "↑",
                tint: NS.Color.accent,
                ink: NS.Color.onAccent
            ) {
                model.wake()
            }

        case .unreachable:
            PrimaryAction(
                title: "Try again",
                detail: "AUTO-RETRY IN \(retryCountdown)S · TAP TO GO NOW",
                glyph: "↻",
                tint: NS.Color.accent,
                ink: NS.Color.onAccent
            ) {
                retryCountdown = 22
                model.retry()
            }
            MovedAddress()
        }
    }

    private var preflightLabel: String {
        let display = model.displays.first(where: \.selected)
        let name = display.map { $0.name.uppercased() } ?? "NO DISPLAY"
        let ladder = model.settings.quality == "auto" ? "FIT" : model.settings.quality.uppercased()
        let estimate = model.link.rttMillis.map { Int($0 * 6 + 120) } ?? 800
        return "\(name) · \(ladder) · ~\(estimate)MS TO FIRST FRAME"
    }

    /// Claude, as a row rather than a caption with a link in it. It is a second
    /// destination from this screen, not a footnote about one.
    private var claudeHandle: some View {
        let detail: String = {
            if !model.claudeCwd.isEmpty {
                let short = model.claudeCwd
                    .replacingOccurrences(
                        of: "^/Users/[^/]+",
                        with: "~",
                        options: .regularExpression
                    )
                    .uppercased()
                return model.sessionCount > 0
                    ? "\(model.sessionCount) SESSION\(model.sessionCount == 1 ? "" : "S") · \(short) OPEN"
                    : short
            }
            return model.sessionCount > 0
                ? "\(model.sessionCount) SESSION\(model.sessionCount == 1 ? "" : "S") THIS LAUNCH"
                : "NO SESSION YET"
        }()

        return Button {
            model.presented = .claude
            model.listClaudeSessions()
        } label: {
            HStack(spacing: 13) {
                Circle().fill(NS.Color.accent).frame(width: 8, height: 8)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Claude Code")
                        .font(NS.Font.sans(15, weight: .medium))
                        .tracking(-0.2)
                        .foregroundStyle(NS.Color.text)
                    MonoCaps(detail, size: 9, tracking: 1)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("↗")
                    .font(NS.Font.mono(15))
                    .foregroundStyle(NS.Color.accent)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 10)
            .frame(minHeight: 62)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusControl).fill(NS.Color.raised)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Claude Code")
        .accessibilityValue(detail)
    }

    /// The countdown only exists on the unreachable screen, but this used to
    /// re-assign it every second on every other one — rebuilding the condition
    /// strip, the display row and the footer once a second to write the number
    /// 22 over the number 22.
    private func countdownLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            guard posture == .unreachable else {
                if retryCountdown != 22 { retryCountdown = 22 }
                continue
            }
            retryCountdown -= 1
            if retryCountdown <= 0 {
                retryCountdown = 22
                model.retry()
            }
        }
    }
}

/// The Mac moved.
///
/// Sits under "Try again" because it is the second question to ask, not the
/// first: a Mac that is asleep and a Mac that changed address look identical
/// from this screen, and retrying is cheaper than typing. But when the address
/// really has changed — and a Cloudflare quick tunnel takes a new hostname on
/// every host restart — no amount of retrying the old one will work, and the
/// only other way out of that used to be revoking the pairing.
///
/// Deliberately not a primary action, and deliberately not automatic: the app
/// does not go looking for a Mac at an address nobody gave it.
struct MovedAddress: View {
    @Environment(AppModel.self) private var model
    @State private var open = false
    @State private var address = ""
    @State private var port = "8787"
    @State private var failure: String?
    @State private var checking = false

    var body: some View {
        if open { card } else { handle }
    }

    private var handle: some View {
        Button {
            // Prefilled with the address that stopped answering, because the part
            // that changed is usually the tail of it.
            address = model.pairedHost?.host ?? ""
            port = model.pairedHost.map { String($0.port) } ?? "8787"
            failure = nil
            withAnimation(NS.Motion.stateChange) { open = true }
        } label: {
            HStack(spacing: 8) {
                MonoCaps("THE MAC MOVED ·", size: 9, tracking: 1.2)
                MonoCaps("CHANGE THE ADDRESS", size: 9, color: NS.Color.accent, tracking: 1.2)
                Spacer(minLength: 0)
            }
            .frame(minHeight: NS.Metric.minimumTarget)
            // Caption text is ink with gaps in it, so without this only the
            // glyphs themselves answered a tap.
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("The Mac moved")
        .accessibilityHint("Changes the address this phone dials, keeping the pairing.")
    }

    private var card: some View {
        Card {
            VStack(alignment: .leading, spacing: 10) {
                MonoCaps("NEW ADDRESS FOR THIS MAC", size: 9, tracking: 1.6)

                Text("The key stays. This is the same Mac at a different address, so there is nothing to pair again — no code, no trip to the menu bar.")
                    .font(NS.Font.sans(13))
                    .foregroundStyle(NS.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)

                // The same two fields the pairing card takes, because this client
                // stores an address and a port rather than one origin, and a host
                // that moved may well have moved to a different port too.
                HStack(spacing: 8) {
                    TextField("192.168.1.24 or mac.tailnet.ts.net", text: $address)
                        .font(NS.Font.mono(13))
                        .foregroundStyle(NS.Color.text)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)
                        .padding(.horizontal, 12)
                        .frame(minHeight: NS.Metric.minimumTarget)
                        .background(
                            RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                                .fill(NS.Color.raised2)
                        )
                        .accessibilityLabel("The Mac’s new address")

                    TextField("8787", text: $port)
                        .font(NS.Font.mono(13))
                        .foregroundStyle(NS.Color.text)
                        .keyboardType(.numberPad)
                        .multilineTextAlignment(.center)
                        .frame(width: 72)
                        .frame(minHeight: NS.Metric.minimumTarget)
                        .background(
                            RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                                .fill(NS.Color.raised2)
                        )
                        .accessibilityLabel("Port")
                }

                // The refusal names the address it tried, because the usual cause
                // is a character of it, and the line above stays true: the stored
                // address has not been touched.
                if let failure {
                    Text(failure)
                        .font(NS.Font.sans(13))
                        .foregroundStyle(NS.Color.red)
                        .fixedSize(horizontal: false, vertical: true)
                }

                HStack(spacing: 9) {
                    OutlinedAction(title: "CANCEL", height: 46) {
                        withAnimation(NS.Motion.stateChange) { open = false }
                    }
                    OutlinedAction(
                        title: checking ? "CHECKING…" : "USE IT",
                        tint: NS.Color.accent,
                        edge: NS.Color.accent.opacity(0.5),
                        height: 46
                    ) {
                        Task { await submit() }
                    }
                }
            }
            .padding(16)
        }
    }

    private func submit() async {
        // A second tap while the probe is in flight would run two of them and
        // report whichever finished last.
        guard !checking else { return }
        let trimmed = address.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty, let portValue = Int(port) else {
            failure = "Enter the Mac's new address and port."
            return
        }

        checking = true
        failure = nil
        let problem = await model.repoint(host: trimmed, port: portValue)
        checking = false
        if let problem {
            failure = problem
        } else {
            withAnimation(NS.Motion.stateChange) { open = false }
        }
    }
}

/// The phone form of a display choice: a shape and one word.
struct DisplayChip: View {
    let display: DisplayEntry
    var degraded: Bool
    var dimmed: Bool
    let action: () -> Void

    /// "Built-in Liquid Retina XDR" in a 64pt chip is one long ellipsis, so the
    /// chip takes the word that distinguishes it from the other one on the desk.
    private var shortName: String {
        let name = display.name.uppercased()
        if name.contains("BUILT-IN") { return "BUILT-IN" }
        return name.split(separator: " ").first.map(String.init) ?? name
    }

    var body: some View {
        Button(action: action) {
            VStack(spacing: 6) {
                RoundedRectangle(cornerRadius: NS.Metric.radiusScreen)
                    .fill(display.selected ? NS.Color.accent.opacity(0.20) : .clear)
                    .frame(width: 26, height: 17)
                    .overlay(
                        // The same 4-4 as every other provisional stroke in the
                        // app. An offline display's outline is dashed for the
                        // reason a pending step is, so the two have to be drawn
                        // in the same broken line to read as the same statement.
                        RoundedRectangle(cornerRadius: NS.Metric.radiusScreen)
                            .strokeBorder(
                                style: StrokeStyle(lineWidth: 1, dash: dimmed ? [4, 4] : [])
                            )
                            .foregroundStyle(display.selected ? NS.Color.accent : NS.Color.textTertiary)
                    )

                MonoCaps(
                    degraded && display.selected
                        ? "540P"
                        : (dimmed ? "\(display.width)×\(display.height)" : shortName),
                    size: 8,
                    color: degraded && display.selected
                        ? NS.Color.amber
                        : (display.selected ? NS.Color.accent : NS.Color.textSecondary),
                    tracking: 1.2
                )
                .lineLimit(1)
                .minimumScaleFactor(0.8)
                .padding(.horizontal, 6)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 64)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                    .fill(display.selected ? NS.Color.accent.opacity(0.12) : NS.Color.raised)
            )
            .overlay {
                if display.selected {
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .stroke(NS.Color.accent.opacity(0.5), lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(display.name)
        .accessibilityValue(
            dimmed
                ? "Last known \(display.width) by \(display.height)"
                : "\(display.width) by \(display.height)"
        )
        .accessibilityAddTraits(display.selected ? [.isButton, .isSelected] : .isButton)
    }
}
