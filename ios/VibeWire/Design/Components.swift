import SwiftUI

// MARK: - Type helpers

/// All-caps monospace label with the spec's tracking. Used for every readout
/// heading, status line and unit.
struct MonoCaps: View {
    let text: String
    var size: CGFloat = 10
    var color: Color = NS.Color.textTertiary
    var tracking: CGFloat = NS.Metric.capsTracking
    var weight: Font.Weight = .regular

    init(
        _ text: String,
        size: CGFloat = 10,
        color: Color = NS.Color.textTertiary,
        tracking: CGFloat = NS.Metric.capsTracking,
        weight: Font.Weight = .regular
    ) {
        self.text = text
        self.size = size
        self.color = color
        self.tracking = tracking
        self.weight = weight
    }

    var body: some View {
        Text(text.uppercased())
            .font(NS.Font.mono(size, weight: weight))
            .tracking(tracking)
            .foregroundStyle(color)
    }
}

/// The app's one heading, at four sizes.
///
/// Tight tracking and a semibold weight is what makes a machine name read as a
/// title rather than as large body copy. There is no separate typeface, weight
/// or colour decision to make at a call site.
struct DisplayTitle: View {
    let text: String
    var size: CGFloat = 38
    var color: Color = NS.Color.text

    init(_ text: String, size: CGFloat = 38, color: Color = NS.Color.text) {
        self.text = text
        self.size = size
        self.color = color
    }

    var body: some View {
        Text(text)
            .font(NS.Font.display(size))
            .tracking(NS.Font.scaledSize(size) * NS.Metric.displayTracking)
            .lineSpacing(-2)
            .foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }
}

/// A measured value with its unit set smaller and dimmer, e.g. `18ms`.
///
/// `lead` is the one reading on a card that is the reason to look at it — the
/// RTT on the condition strip. It is set larger than the two beside it, because
/// three numbers at the same size is a table and the eye has to read all of it.
struct Readout: View {
    let label: String
    let value: String?
    let unit: String
    var valueColor: Color = NS.Color.text
    var lead: Bool = false

    /// Spoken as one reading rather than three fragments. Left to itself
    /// VoiceOver announces "RTT", "18", "MS" as separate elements, which is
    /// three swipes to learn one number.
    private var spokenValue: String {
        guard let value else { return "not measured" }
        return unit.isEmpty ? value : "\(value) \(spokenUnit)"
    }

    private var spokenUnit: String {
        switch unit.uppercased() {
        case "MS": return "milliseconds"
        case "%": return "percent"
        case "MB/S": return "megabits per second"
        default: return unit
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            MonoCaps(label, size: 8, tracking: 1.8)
            if let value {
                HStack(alignment: .firstTextBaseline, spacing: 2) {
                    Text(value)
                        .font(NS.Font.mono(lead ? 26 : 19))
                        .tracking(lead ? -0.8 : -0.4)
                        .foregroundStyle(valueColor)
                    Text(unit)
                        .font(NS.Font.mono(10))
                        .foregroundStyle(NS.Color.textTertiary)
                }
            } else {
                // A dash, never a zero. An unmeasured value is not the same
                // thing as a measured zero — which makes the dash a reading, so
                // it is legible like one. Dimmer than a real value, never
                // fainter than the label above it.
                Text("—")
                    .font(NS.Font.mono(lead ? 26 : 19))
                    .foregroundStyle(NS.Color.textTertiary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(spokenValue)
    }
}

/// A caption laid over the Mac's picture.
///
/// Alpha cannot be verified against content nobody controls: the captions here
/// were white at 34%, which measures 2.9:1 over a black desktop, 1.5:1 over a
/// grey one, and 1.0:1 — invisible — over a white document, which is what a
/// text editor actually looks like. The text is solid and carries its own ground
/// at 92%.
struct VideoCaption: View {
    let text: String
    var size: CGFloat = 9
    var color: Color = NS.Color.textSecondary
    var tracking: CGFloat = 1.0

    init(
        _ text: String,
        size: CGFloat = 9,
        color: Color = NS.Color.textSecondary,
        tracking: CGFloat = 1.0
    ) {
        self.text = text
        self.size = size
        self.color = color
        self.tracking = tracking
    }

    var body: some View {
        MonoCaps(text, size: size, color: color, tracking: tracking)
            .videoChip()
    }
}

extension View {
    /// The ground any mark needs when it sits on the Mac's picture. Defined
    /// once so a caption, a badge and a readout cannot drift apart.
    func videoChip() -> some View {
        padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusSmall)
                    .fill(NS.Color.deepGround.opacity(0.92))
            )
    }
}

// MARK: - Structure

struct Hairline: View {
    var color: Color = NS.Color.hairline
    var body: some View {
        Rectangle()
            .fill(color)
            .frame(height: NS.Metric.hairline)
    }
}

/// A dashed rule that stands in for a live value the host has not reported yet.
/// The layout does not move when the real value arrives — it just fills in.
struct DashedRule: View {
    var body: some View {
        Rectangle()
            .fill(.clear)
            .frame(height: 1)
            .overlay(
                Rectangle()
                    .stroke(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                    .foregroundStyle(NS.Color.stroke)
            )
    }
}

/// A card: a lighter ground with a large corner and no border.
///
/// The tinted variant is for a card that reports a condition — the wash carries
/// the colour and a hairline of the same tint keeps it legible where the wash is
/// too faint to find an edge.
struct Card<Content: View>: View {
    var tint: Color?
    var radius: CGFloat = NS.Metric.radiusCard
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .background(
                RoundedRectangle(cornerRadius: radius)
                    .fill(tint?.opacity(0.07) ?? NS.Color.raised)
            )
            .overlay {
                if let tint {
                    RoundedRectangle(cornerRadius: radius)
                        .stroke(tint.opacity(0.34), lineWidth: NS.Metric.hairline)
                }
            }
    }
}

/// Where a row sits in a group, which is the only thing that decides its
/// corners.
enum GroupPosition {
    case first
    case middle
    case last
    case only

    /// A run of `count` rows, so a call site can map an index without repeating
    /// the four-way test.
    static func at(_ index: Int, of count: Int) -> GroupPosition {
        if count <= 1 { return .only }
        if index == 0 { return .first }
        if index == count - 1 { return .last }
        return .middle
    }

    var top: CGFloat {
        switch self {
        case .first, .only: return NS.Metric.radiusGroupOuter
        case .middle, .last: return NS.Metric.radiusGroupInner
        }
    }

    var bottom: CGFloat {
        switch self {
        case .last, .only: return NS.Metric.radiusGroupOuter
        case .first, .middle: return NS.Metric.radiusGroupInner
        }
    }
}

extension View {
    /// A row in a group: the outer corners of the run round, the seams between
    /// rows do not, so the group reads as one object and each row is still its
    /// own target.
    func groupedRow(_ position: GroupPosition, background: Color = NS.Color.raised) -> some View {
        clipShape(
            UnevenRoundedRectangle(
                topLeadingRadius: position.top,
                bottomLeadingRadius: position.bottom,
                bottomTrailingRadius: position.bottom,
                topTrailingRadius: position.top
            )
        )
        .background(
            UnevenRoundedRectangle(
                topLeadingRadius: position.top,
                bottomLeadingRadius: position.bottom,
                bottomTrailingRadius: position.bottom,
                topTrailingRadius: position.top
            )
            .fill(background)
        )
    }
}

/// A section heading over a group or a card.
struct SectionLabel: View {
    let text: String
    init(_ text: String) { self.text = text }

    var body: some View {
        MonoCaps(text, size: 9, tracking: NS.Metric.capsTrackingWide)
    }
}

/// The hatch that stands in for a picture that has not arrived. An empty frame,
/// never a black one — a black rectangle is a claim about what the Mac is
/// displaying.
struct Hatch: View {
    var body: some View {
        Canvas { context, size in
            context.fill(Path(CGRect(origin: .zero, size: size)), with: .color(NS.Color.hatchDark))
            let step: CGFloat = 16
            var offset = -size.height
            while offset < size.width + size.height {
                var stripe = Path()
                stripe.move(to: CGPoint(x: offset, y: 0))
                stripe.addLine(to: CGPoint(x: offset + size.height, y: size.height))
                context.stroke(
                    stripe,
                    with: .color(NS.Color.hatchLight),
                    style: StrokeStyle(lineWidth: step / 2)
                )
                offset += step
            }
        }
        .accessibilityHidden(true)
    }
}

/// The corner ticks that mark the true edge of the captured pixels, so a zoomed
/// picture never looks like a cropped one.
struct CornerTicks: View {
    var color: Color
    var inset: CGFloat = 12
    var length: CGFloat = 11

    var body: some View {
        GeometryReader { proxy in
            Path { path in
                let w = proxy.size.width
                let h = proxy.size.height
                // top leading
                path.move(to: CGPoint(x: inset, y: inset + length))
                path.addLine(to: CGPoint(x: inset, y: inset))
                path.addLine(to: CGPoint(x: inset + length, y: inset))
                // top trailing
                path.move(to: CGPoint(x: w - inset - length, y: inset))
                path.addLine(to: CGPoint(x: w - inset, y: inset))
                path.addLine(to: CGPoint(x: w - inset, y: inset + length))
                // bottom leading
                path.move(to: CGPoint(x: inset, y: h - inset - length))
                path.addLine(to: CGPoint(x: inset, y: h - inset))
                path.addLine(to: CGPoint(x: inset + length, y: h - inset))
                // bottom trailing
                path.move(to: CGPoint(x: w - inset - length, y: h - inset))
                path.addLine(to: CGPoint(x: w - inset, y: h - inset))
                path.addLine(to: CGPoint(x: w - inset, y: h - inset - length))
            }
            .stroke(color, lineWidth: 1)
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

// MARK: - Indicators

/// The condition dot.
///
/// A lost condition is drawn square rather than round: colour alone cannot carry
/// "this is the bad one" for a reader who cannot separate red from green, and
/// the shape is the redundant channel that costs nothing.
///
/// Pulse rate carries meaning: a thin link blinks faster than a healthy one.
struct ConditionDot: View {
    let condition: Condition
    var size: CGFloat = 9
    /// Suppressed while video is on screen — nothing decorative moves next to
    /// a live feed.
    var animated: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    /// The pulse is emphasis, not information: the colour already reports the
    /// condition and the label beside it spells it out. So it is safe to hold
    /// still — at full opacity, never mid-fade, which would read as a dimmed
    /// dot. A lost condition never pulses: the square is already saying it.
    private var shouldPulse: Bool {
        animated && !reduceMotion && condition != .idle && condition != .lost
    }

    var body: some View {
        Group {
            if condition == .lost {
                Rectangle().fill(condition.color)
            } else {
                Circle()
                    .fill(condition == .idle ? .clear : condition.color)
                    .overlay {
                        if condition == .idle {
                            Circle().stroke(NS.Color.textTertiary, lineWidth: 1)
                        }
                    }
            }
        }
        .frame(width: size, height: size)
        .opacity(pulsing ? 1 : 0.45)
        .onAppear { applyPulse() }
        .onChange(of: animated) { _, _ in applyPulse() }
        .onChange(of: reduceMotion) { _, _ in applyPulse() }
        // The condition is always spelled out in the label beside this dot —
        // "REACHABLE" — so announcing the dot as well is one more swipe to reach
        // the same fact.
        .accessibilityHidden(true)
    }

    private func applyPulse() {
        guard shouldPulse else {
            // `nil` sets the value outright, cancelling a loop already running.
            withAnimation(nil) { pulsing = true }
            return
        }
        let period: Double = condition == .degraded ? 1.4 : 2.6
        withAnimation(NS.Motion.loop(period, autoreverses: true, reduced: false)) {
            pulsing = true
        }
    }
}

/// Four ascending bars. Signal strength, drawn the same way everywhere.
struct SignalBars: View {
    /// 0…4
    let filled: Int
    let color: Color

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(0..<4, id: \.self) { index in
                RoundedRectangle(cornerRadius: NS.Metric.radiusBar)
                    .fill(index < filled ? color : NS.Color.stroke)
                    .frame(width: 3, height: 5 + CGFloat(index) * 3)
            }
        }
        .frame(height: 14, alignment: .bottom)
        // Strength is a picture of the condition the card already states, and
        // the RTT and loss readouts carry the numbers behind it.
        .accessibilityHidden(true)
    }
}

/// The 60-second RTT trace. Spiky means jittery, and the most recent five
/// samples are drawn at full strength so "now" is legible.
struct Sparkline: View {
    let values: [Double]
    let color: Color
    var height: CGFloat = 18

    var body: some View {
        // Both of these were inside the loop, so a 60-sample history scanned
        // itself twenty times to draw twenty bars — on the home screen, once a
        // second, for as long as it is open.
        let recent = Array(values.suffix(20))
        let peak = max(values.max() ?? 1, 1)
        let brightFrom = max(0, recent.count - 5)

        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(recent.enumerated()), id: \.offset) { index, value in
                let scaled = max(5, CGFloat(value / peak) * height)
                RoundedRectangle(cornerRadius: NS.Metric.radiusBar)
                    .fill(index >= brightFrom ? color : color.opacity(0.35))
                    .frame(height: scaled)
            }
        }
        .frame(height: height, alignment: .bottom)
        // Sixty bars is not something to hear one at a time. The trace shows
        // jitter; the RTT readout beside it is the number that matters.
        .accessibilityHidden(true)
    }
}

/// The one loop that keeps running under Reduce Motion.
///
/// A small rotating arc is not a vestibular trigger — iOS keeps its own
/// `ProgressView` turning under the setting for the same reason — and freezing
/// one would say the host had stopped answering, which is a claim this app is
/// not allowed to make without having measured it.
struct Spinner: View {
    var size: CGFloat = 16
    var color: Color = NS.Color.accent

    @State private var turning = false

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.75)
            .stroke(color, style: StrokeStyle(lineWidth: 1.5, lineCap: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(turning ? 360 : 0))
            .onAppear {
                withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                    turning = true
                }
            }
            .accessibilityLabel("Working")
    }
}

/// The blinking insertion point. The user's own state, so it is the accent.
struct Caret: View {
    var height: CGFloat = 26

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = true

    var body: some View {
        Rectangle()
            .fill(NS.Color.accent)
            .frame(width: 2, height: height)
            .opacity(on ? 1 : 0)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                    on = false
                }
            }
            .accessibilityHidden(true)
    }
}

/// The countdown to the next pairing code, drawn as a sweep rather than as a
/// number that ticks. The number is beside it — this says at a glance whether
/// there is time to finish typing.
struct RotatesIn: View {
    /// 0…1
    let fraction: Double
    var size: CGFloat = 14

    var body: some View {
        // A stroked arc, not a filled one. `Circle().trim().fill()` closes the
        // arc across its own ends, so it fills a chord rather than a pie slice —
        // which reads as a nearly-full disc at 85% and as a lens at 50%, saying
        // the wrong thing at every value except 0 and 1. Stroking the same trim
        // is the dial the design asks for and is honest the whole way round.
        let ring = size * 0.21
        return ZStack {
            Circle()
                .stroke(NS.Color.raised2, lineWidth: ring)
            Circle()
                .trim(from: 0, to: max(0, min(1, fraction)))
                .stroke(NS.Color.amber, style: StrokeStyle(lineWidth: ring, lineCap: .butt))
                .rotationEffect(.degrees(-90))
        }
        .padding(ring / 2)
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

// MARK: - Controls

/// The primary action. Carries its own preflight in the sub-label, because the
/// button should say what it is about to do and how long it will take.
struct PrimaryAction: View {
    let title: String
    let detail: String
    let glyph: String
    var tint: Color = NS.Color.green
    var ink: Color = NS.Color.onGreen
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(NS.Font.sans(19, weight: .semibold))
                        .tracking(-0.4)
                        .foregroundStyle(ink)
                    // The preflight line — what this action costs before it is
                    // tapped. 0.66 put it at 4.50:1 on the accent fill, which is
                    // the threshold to three decimal places; 0.72 gives it
                    // actual margin on all four tints.
                    MonoCaps(detail, size: 9, color: ink.opacity(0.72), tracking: 1.0)
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                Spacer(minLength: 0)
                Text(glyph)
                    .font(NS.Font.mono(22))
                    .foregroundStyle(ink)
            }
            .padding(.horizontal, 22)
            .padding(.vertical, 12)
            // Minimum, not fixed. The title and its preflight line are stacked,
            // so at a large text size a fixed height clips the very sentence
            // that says what the action costs.
            .frame(minHeight: NS.Metric.primaryAction)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusCard).fill(tint)
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
        // The preflight is the cost of the tap, so it is spoken as the value of
        // the control rather than as a second element after it.
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(title)
        .accessibilityValue(detail)
        .accessibilityAddTraits(.isButton)
    }
}

/// A filled action with no sub-label: the confirming verb on a destructive
/// sheet, "Allow once".
struct FilledAction: View {
    let title: String
    var tint: Color = NS.Color.accent
    var ink: Color = NS.Color.onAccent
    var height: CGFloat = NS.Metric.secondaryAction
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title)
                .font(NS.Font.sans(16, weight: .semibold))
                .tracking(-0.2)
                .foregroundStyle(ink)
                .frame(maxWidth: .infinity)
                .frame(minHeight: height)
                .background(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl).fill(tint)
                )
        }
        .buttonStyle(.plain)
    }
}

/// An outlined action, labelled in caps. 44pt minimum.
struct OutlinedAction: View {
    let title: String
    var tint: Color = NS.Color.textSecondary
    var edge: Color = NS.Color.stroke
    var height: CGFloat = NS.Metric.minimumTarget
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            MonoCaps(title, size: 10, color: tint)
                .frame(maxWidth: .infinity)
                .frame(minHeight: height)
                .overlay(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .stroke(edge, lineWidth: NS.Metric.hairline)
                )
                // An outline is not a fill: without this only the caption's own
                // glyphs answered a tap.
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The segmented control: a padded track with a filled thumb, rather than
/// Longarm's row of bordered cells. MON 1 / MON 2 / BOTH, CHAT / CODE, the
/// quality ladder, POINTER / VIEW.
struct Segmented<Value: Hashable>: View {
    let options: [(value: Value, label: String, badge: Color?)]
    @Binding var selection: Value
    var track: Color = NS.Color.raised
    var height: CGFloat = 38

    var body: some View {
        HStack(spacing: 3) {
            ForEach(options, id: \.value) { option in
                Button {
                    withAnimation(NS.Motion.stateChange) { selection = option.value }
                } label: {
                    HStack(spacing: 6) {
                        MonoCaps(
                            option.label,
                            size: 9,
                            color: selection == option.value
                                ? NS.Color.accent
                                : NS.Color.textTertiary
                        )
                        if let badge = option.badge {
                            Circle().fill(badge).frame(width: 5, height: 5)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: height)
                    .background(
                        RoundedRectangle(cornerRadius: NS.Metric.radiusInner - 3)
                            .fill(
                                selection == option.value
                                    ? NS.Color.accent.opacity(0.16)
                                    : .clear
                            )
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(option.label)
                // Without this the selected segment sounds exactly like the ones
                // beside it, and the control's whole job is to say which one is
                // current.
                .accessibilityAddTraits(
                    selection == option.value ? [.isButton, .isSelected] : .isButton
                )
            }
        }
        .padding(3)
        .background(
            RoundedRectangle(cornerRadius: NS.Metric.radiusInner).fill(track)
        )
    }
}

/// Toggle drawn in the system's shape but the app's colours.
struct NSToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(NS.Motion.stateChange) { isOn.toggle() }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? NS.Color.accent.opacity(0.3) : NS.Color.raised2)
                    .overlay(
                        Capsule().stroke(isOn ? NS.Color.accent : NS.Color.stroke, lineWidth: 1)
                    )
                Circle()
                    .fill(isOn ? NS.Color.accent : NS.Color.textTertiary)
                    .frame(width: 24, height: 24)
                    .padding(3)
            }
            .frame(width: 52, height: 32)
        }
        .buttonStyle(.plain)
        // Drawn in the system's shape but built from a Button, so none of the
        // switch semantics came for free: without this it announced as an
        // unlabelled button with no on or off about it.
        .accessibilityAddTraits(.isToggle)
        .accessibilityValue(isOn ? "On" : "Off")
    }
}

/// A key cap. Violet and dotted when held — the app's one signal for "this is
/// still down", used identically in the command drawer, the modifier row and
/// the keyboard bar.
struct KeyCap: View {
    let glyph: String
    var caption: String?
    var width: CGFloat?
    var height: CGFloat = 46
    var isHeld: Bool = false
    var fontSize: CGFloat = 15
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 3) {
                Text(glyph)
                    .font(NS.Font.mono(fontSize))
                    .foregroundStyle(isHeld ? NS.Color.accent : NS.Color.text)
                if let caption {
                    MonoCaps(
                        caption,
                        size: 8,
                        color: isHeld ? NS.Color.accent : NS.Color.textTertiary,
                        tracking: 0.8
                    )
                }
            }
            // The cap's width is a keyboard geometry and stays fixed; its height
            // gives way so a glyph stacked over a caption still fits.
            .frame(width: width)
            .frame(minHeight: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                    .fill(isHeld ? NS.Color.accent.opacity(0.20) : NS.Color.raised2)
            )
            .overlay {
                if isHeld {
                    RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                        .stroke(NS.Color.accent, lineWidth: 1)
                }
            }
            .overlay(alignment: .topTrailing) {
                if isHeld {
                    Circle()
                        .fill(NS.Color.accent)
                        .frame(width: 5, height: 5)
                        .padding(6)
                }
            }
        }
        .buttonStyle(.plain)
        // A modifier symbol read aloud is a coin toss — "⌘" is announced as
        // "place of interest sign". The caption is the word for it.
        .accessibilityLabel(caption ?? Self.spoken(glyph))
        .accessibilityAddTraits(isHeld ? [.isButton, .isSelected] : .isButton)
        .accessibilityHint(isHeld ? "Held. Activates to release." : "")
    }

    /// Caps without captions still have to be nameable.
    static func spoken(_ glyph: String) -> String {
        switch glyph {
        case "⌘": return "Command"
        case "⇧": return "Shift"
        case "⌥": return "Option"
        case "⌃": return "Control"
        case "←": return "Left arrow"
        case "→": return "Right arrow"
        case "↑": return "Up arrow"
        case "↓": return "Down arrow"
        default: return glyph
        }
    }
}

/// A tile in the command drawer — a glyph over a caption.
///
/// This is what replaced the thumb arc. The arc put seven unlabelled circles on
/// a sweep only a right thumb could reach; a tile says what it does in a word
/// and is the same distance from either hand.
struct Tile: View {
    let glyph: String
    let caption: String
    var accent: Bool = false
    var glyphSize: CGFloat = 16
    let spoken: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 7) {
                Text(glyph)
                    .font(NS.Font.mono(glyphSize))
                    .foregroundStyle(accent ? NS.Color.accent : NS.Color.text)
                MonoCaps(
                    caption,
                    size: 8,
                    color: accent ? NS.Color.accent : NS.Color.textSecondary,
                    tracking: 1.0
                )
            }
            .frame(maxWidth: .infinity)
            .frame(height: 70)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                    .fill(accent ? NS.Color.accent.opacity(0.14) : NS.Color.raised2)
            )
            .overlay {
                if accent {
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .stroke(NS.Color.accent.opacity(0.45), lineWidth: 1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(spoken)
    }
}

/// The grabber at the top of a drawer. Not a control — it names the edge this
/// arrived from.
struct Grabber: View {
    var body: some View {
        Capsule()
            .fill(NS.Color.stroke)
            .frame(width: 40, height: 4)
            .accessibilityHidden(true)
    }
}

/// The way out of a sheet.
///
/// Text Secondary rather than the accent, deliberately: every one of these
/// sheets can also be dismissed by swiping down, so this is the second way out,
/// never the primary action on the screen. The accent is not spent on it.
struct SheetDismiss: View {
    let title: String
    let action: () -> Void

    init(_ title: String = "DONE", action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            MonoCaps(title, size: 10, color: NS.Color.textSecondary)
                .padding(.horizontal, 12)
                .frame(minHeight: NS.Metric.minimumTarget)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title.capitalized)
    }
}

// MARK: - Timeline

enum TimelineState {
    case done
    case running
    case failed
    case pending
}

/// The marker on the timeline rail.
///
/// Four states and four shapes: a green tick, a turning arc, a red cross, a
/// dashed ring. The colour repeats what the shape already said, which is what
/// lets this work in a photograph of a phone held at arm's length.
struct TimelineMark: View {
    let state: TimelineState
    var size: CGFloat = 15
    /// The rail runs behind the mark, so the mark carries the ground it sits on
    /// and punches a hole in the line rather than sitting on top of it.
    var ground: Color = NS.Color.screenGround

    var body: some View {
        Group {
            switch state {
            case .running:
                Spinner(size: size)
            case .done:
                ring(NS.Color.green, glyph: "✓", dashed: false)
            case .failed:
                ring(NS.Color.red, glyph: "✕", dashed: false)
            case .pending:
                ring(NS.Color.textDisabled, glyph: "", dashed: true)
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }

    private func ring(_ color: Color, glyph: String, dashed: Bool) -> some View {
        Circle()
            .fill(ground)
            .overlay(
                // 4-4, the one dash in the system. Dashed means provisional
                // everywhere it appears, so a pending marker has to be drawn in
                // the same broken line as a placeholder rule and an unpicked
                // option, or the pattern stops carrying the meaning.
                Circle().stroke(
                    color,
                    style: StrokeStyle(lineWidth: 1, dash: dashed ? [4, 4] : [])
                )
            )
            .overlay(
                Text(glyph)
                    .font(NS.Font.mono(9))
                    .foregroundStyle(color)
            )
    }
}

/// One row on the timeline: the rail segment, the mark, and whatever the row
/// carries. The rail is drawn per row rather than once behind the stack, so a
/// row can be any height and the line still meets its neighbours.
struct TimelineRow<Content: View>: View {
    let state: TimelineState
    var isFirst: Bool = false
    var isLast: Bool = false
    var ground: Color = NS.Color.screenGround
    @ViewBuilder var content: () -> Content

    var body: some View {
        HStack(alignment: .top, spacing: 9) {
            ZStack {
                Rectangle()
                    .fill(NS.Color.accent.opacity(0.28))
                    .frame(width: 1)
                    .padding(.top, isFirst ? 12 : 0)
                    .padding(.bottom, isLast ? 12 : 0)
                VStack {
                    TimelineMark(state: state, ground: ground)
                    Spacer(minLength: 0)
                }
                .padding(.top, 12)
            }
            .frame(width: 15)

            content()
        }
    }
}

// MARK: - Screen chrome

/// The three dots that open Settings.
///
/// Hit testing follows the drawn shapes, not the frame around them. Without a
/// full-size target this is three 3pt dots with gaps between them — visually a
/// button, practically unhittable, and it is the only way into Settings and
/// unpairing.
struct OverflowButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 3) {
                ForEach(0..<3, id: \.self) { _ in
                    Circle().fill(NS.Color.textSecondary).frame(width: 3, height: 3)
                }
            }
            .frame(width: 40, height: 40)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusInner).fill(NS.Color.raised)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("menu")
        .accessibilityLabel("Settings")
    }
}

/// The wordmark and overflow control that sits at the top of the non-video
/// screens.
struct ScreenHeader: View {
    var trailing: (() -> Void)?

    var body: some View {
        HStack {
            MonoCaps(
                "VibeWire",
                size: 11,
                color: NS.Color.textSecondary,
                tracking: 3.5,
                weight: .medium
            )
            Spacer()
            if let trailing {
                OverflowButton(action: trailing)
            }
        }
        .frame(minHeight: NS.Metric.minimumTarget)
    }
}

/// Wraps a screen in the app's ground colour and edge insets.
struct ScreenBody<Content: View>: View {
    var background: Color = NS.Color.screenGround
    /// Set on screens that are one fixed column ending in a primary action.
    ///
    /// Those screens were laid out for a portrait phone and nothing else, so in
    /// landscape — or at a large text size — the footer holding the only way
    /// forward simply left the screen. `false` is right for a screen that owns
    /// a scroll view of its own; two nested ones fight.
    var scrolls: Bool = false
    /// A screen that lays itself out in two columns past `NS.Metric.wide` takes
    /// the width instead of staying a bounded column in the middle of it.
    var wide: Bool = false
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack {
            background.ignoresSafeArea()

            if scrolls {
                GeometryReader { proxy in
                    ScrollView {
                        // Fill the viewport when there is room, so the spacers
                        // inside still push the footer to the bottom edge, and
                        // scroll only once the content genuinely does not fit.
                        // Without the minimum, every one of these screens
                        // collapses to its natural height and floats.
                        column.frame(minHeight: proxy.size.height, alignment: .top)
                    }
                    .scrollBounceBehavior(.basedOnSize)
                }
            } else {
                column
            }
        }
        .preferredColorScheme(.dark)
    }

    private var column: some View {
        content()
            .padding(.horizontal, NS.Metric.gutter)
            // Bounded, then centred in whatever is left. This is the whole of
            // the iPad story for a single-column screen: the layout does not
            // stretch, it stays a column and moves to the middle — which also
            // covers landscape, Split View, and a phone-width window on a
            // tablet, without once asking what device it is running on.
            .frame(maxWidth: wide ? .infinity : NS.Metric.measure)
            .frame(maxWidth: .infinity)
    }
}
