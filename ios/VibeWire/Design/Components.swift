import SwiftUI

// MARK: - Type helpers

/// All-caps monospace label with the spec's tracking. Used for every readout
/// heading, status line and unit.
struct MonoCaps: View {
    let text: String
    var size: CGFloat = 10
    var color: Color = LG.Color.textTertiary
    var tracking: CGFloat = LG.Metric.capsTracking
    var weight: Font.Weight = .regular

    init(
        _ text: String,
        size: CGFloat = 10,
        color: Color = LG.Color.textTertiary,
        tracking: CGFloat = LG.Metric.capsTracking,
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
            .font(LG.Font.mono(size, weight: weight))
            .tracking(tracking)
            .foregroundStyle(color)
    }
}

/// A measured value with its unit set smaller and dimmer, e.g. `18ms`.
struct Readout: View {
    let label: String
    let value: String?
    let unit: String
    var valueColor: Color = LG.Color.text

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            MonoCaps(label, size: 9)
            if let value {
                HStack(alignment: .firstTextBaseline, spacing: 1) {
                    Text(value)
                        .font(LG.Font.mono(19))
                        .foregroundStyle(valueColor)
                    Text(unit)
                        .font(LG.Font.mono(11))
                        .foregroundStyle(LG.Color.textTertiary)
                }
            } else {
                // A dash, never a zero. An unmeasured value is not the same
                // thing as a measured zero.
                //
                // Which makes the dash a reading, so it is legible like one.
                // It used to be `textDisabled` — 1.9:1, invisible at arm's
                // length — which quietly demoted the one mark that says the
                // host has not answered. Dimmer than a real value, never
                // fainter than the label above it.
                Text("—")
                    .font(LG.Font.mono(19))
                    .foregroundStyle(LG.Color.textTertiary)
            }
        }
    }
}

/// A caption laid over the Mac's picture.
///
/// Alpha cannot be verified against content nobody controls: the captions here
/// were white at 34%, which measures 2.9:1 over a black desktop, 1.5:1 over a
/// grey one, and 1.0:1 — invisible — over a white document, which is what a
/// text editor actually looks like. The text is solid now and carries its own
/// ground at 92%, the way the trackpad boundary labels already did. Worst case
/// over pure white is 6.0:1, and the picture still shows through the chip
/// enough that it reads as part of the video rather than pasted on top.
struct VideoCaption: View {
    let text: String
    var size: CGFloat = 9
    var color: Color = LG.Color.textSecondary
    var tracking: CGFloat = 1.4

    init(
        _ text: String,
        size: CGFloat = 9,
        color: Color = LG.Color.textSecondary,
        tracking: CGFloat = 1.4
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
        padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(LG.Color.deepGround.opacity(0.92))
    }
}

// MARK: - Structure

struct Hairline: View {
    var color: Color = LG.Color.hairlineDim
    var body: some View {
        Rectangle()
            .fill(color)
            .frame(height: LG.Metric.hairline)
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
                    .foregroundStyle(LG.Color.stroke)
            )
    }
}

/// The bordered box used for status cards and grouped rows.
struct Panel<Content: View>: View {
    var tint: Color?
    var border: Color = LG.Color.hairline
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .background(
                RoundedRectangle(cornerRadius: LG.Metric.radiusMedium)
                    .fill(tint?.opacity(0.05) ?? LG.Color.raised)
            )
            .overlay(
                RoundedRectangle(cornerRadius: LG.Metric.radiusMedium)
                    .stroke(tint?.opacity(0.30) ?? border, lineWidth: LG.Metric.hairline)
            )
    }
}

// MARK: - Indicators

/// The pulsing condition dot. Pulse rate carries meaning: a thin link blinks
/// faster than a healthy one.
struct ConditionDot: View {
    let condition: Condition
    var size: CGFloat = 8
    /// Suppressed while video is on screen — nothing decorative moves next to
    /// a live feed.
    var animated: Bool = true

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var pulsing = false

    /// The pulse is emphasis, not information: the colour already reports the
    /// condition and the label beside it spells it out. So it is safe to still
    /// — at full opacity, never mid-fade, which would read as a dimmed dot.
    private var shouldPulse: Bool {
        animated && !reduceMotion && condition != .idle
    }

    var body: some View {
        Circle()
            .fill(condition == .idle ? .clear : condition.color)
            .frame(width: size, height: size)
            .overlay {
                if condition == .idle {
                    Circle().stroke(LG.Color.textTertiary, lineWidth: 1)
                }
            }
            .opacity(pulsing ? 1 : 0.35)
            .onAppear { applyPulse() }
            .onChange(of: animated) { _, _ in applyPulse() }
            .onChange(of: reduceMotion) { _, _ in applyPulse() }
    }

    private func applyPulse() {
        guard shouldPulse else {
            // `nil` sets the value outright, cancelling a loop already running.
            withAnimation(nil) { pulsing = true }
            return
        }
        // Rate carries meaning: a thin link blinks faster than a healthy one.
        let period: Double = condition == .degraded ? 1.4 : 2.6
        withAnimation(LG.Motion.loop(period, autoreverses: true, reduced: false)) {
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
        HStack(alignment: .bottom, spacing: 3) {
            ForEach(0..<4, id: \.self) { index in
                Rectangle()
                    .fill(index < filled ? color : LG.Color.stroke)
                    .frame(width: 4, height: 6 + CGFloat(index) * 3.4)
            }
        }
        .frame(height: 16, alignment: .bottom)
    }
}

/// The 60-second RTT trace on the home screen. Spiky means jittery, and the
/// most recent five samples are drawn brighter so "now" is legible.
struct Sparkline: View {
    let values: [Double]
    let color: Color
    var height: CGFloat = 22

    var body: some View {
        HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(values.suffix(20).enumerated()), id: \.offset) { index, value in
                let peak = max(values.max() ?? 1, 1)
                let scaled = max(6, CGFloat(value / peak) * height)
                Rectangle()
                    .fill(index >= max(0, min(20, values.count) - 5)
                          ? color
                          : color.opacity(0.42))
                    .frame(width: 4, height: scaled)
            }
        }
        .frame(height: height, alignment: .bottom)
    }
}

// MARK: - Controls

/// The 76pt primary action. Carries its own preflight in the sub-label, because
/// the button should say what it is about to do and how long it will take.
struct PrimaryAction: View {
    let title: String
    let detail: String
    let glyph: String
    var tint: Color = LG.Color.green
    var ink: Color = LG.Color.onGreen
    var enabled: Bool = true
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(LG.Font.sans(19, weight: .medium))
                        .foregroundStyle(ink)
                    // The preflight line — what this action costs before it is
                    // tapped. 0.66 put it at 4.50:1 on the cyan fill, which is
                    // the threshold to three decimal places; 0.72 gives it
                    // actual margin on all four tints.
                    MonoCaps(detail, size: 10, color: ink.opacity(0.72))
                        .lineLimit(1)
                        .minimumScaleFactor(0.75)
                }
                Spacer(minLength: 0)
                Text(glyph)
                    .font(LG.Font.mono(22))
                    .foregroundStyle(ink)
            }
            .padding(.horizontal, 22)
            // Minimum, not fixed. The title and its preflight line are stacked,
            // so at a large text size a fixed 76pt clips the very sentence that
            // says what the action costs. Identical at the default size.
            .frame(minHeight: LG.Metric.primaryAction)
            .frame(maxWidth: .infinity)
            .background(
                RoundedRectangle(cornerRadius: LG.Metric.radiusMedium).fill(tint)
            )
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .opacity(enabled ? 1 : 0.45)
    }
}

/// Bordered secondary action, 44pt minimum.
struct SecondaryAction: View {
    let title: String
    var tint: Color = LG.Color.textSecondary
    var border: Color = LG.Color.hairline
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            MonoCaps(title, size: 10, color: tint)
                .frame(maxWidth: .infinity)
                .frame(minHeight: LG.Metric.minimumTarget)
                .overlay(
                    RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
                        .stroke(border, lineWidth: LG.Metric.hairline)
                )
                // An outline is not a fill: without this only the caption's
                // own glyphs answered a tap.
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// The segmented control used for MON 1 / MON 2 / BOTH and CHAT / CODE.
struct Segmented<Value: Hashable>: View {
    let options: [(value: Value, label: String, badge: Color?)]
    @Binding var selection: Value

    var body: some View {
        HStack(spacing: 1) {
            ForEach(options, id: \.value) { option in
                Button {
                    withAnimation(LG.Motion.stateChange) { selection = option.value }
                } label: {
                    HStack(spacing: 8) {
                        MonoCaps(
                            option.label,
                            size: 11,
                            color: selection == option.value ? LG.Color.cyan : LG.Color.textSecondary
                        )
                        if let badge = option.badge {
                            Circle().fill(badge).frame(width: 5, height: 5)
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: LG.Metric.minimumTarget)
                    .background(
                        selection == option.value
                            ? LG.Color.cyan.opacity(0.14)
                            : LG.Color.raised
                    )
                }
                .buttonStyle(.plain)
            }
        }
        .background(LG.Color.hairlineDim)
        .clipShape(RoundedRectangle(cornerRadius: LG.Metric.radiusSmall))
        .overlay(
            RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
                .stroke(LG.Color.hairlineDim, lineWidth: LG.Metric.hairline)
        )
    }
}

/// Toggle drawn in the system's shape but the app's colours.
struct LGToggle: View {
    @Binding var isOn: Bool

    var body: some View {
        Button {
            withAnimation(LG.Motion.stateChange) { isOn.toggle() }
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? LG.Color.cyan.opacity(0.3) : LG.Color.chrome)
                    .overlay(
                        Capsule().stroke(isOn ? LG.Color.cyan : LG.Color.stroke, lineWidth: 1)
                    )
                Circle()
                    .fill(isOn ? LG.Color.cyan : LG.Color.textTertiary)
                    .frame(width: 24, height: 24)
                    .padding(3)
            }
            .frame(width: 52, height: 30)
        }
        .buttonStyle(.plain)
    }
}

/// A key cap. Cyan and dotted when held — the app's one signal for "this is
/// still down", used identically on the hub, the modifier bar and the key row.
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
            VStack(spacing: 2) {
                Text(glyph)
                    .font(LG.Font.mono(fontSize))
                    .foregroundStyle(isHeld ? LG.Color.cyan : LG.Color.text)
                if let caption {
                    MonoCaps(caption, size: 9, color: isHeld ? LG.Color.cyan : LG.Color.textTertiary)
                }
            }
            // The cap's width is a keyboard geometry and stays fixed; its
            // height gives way so a glyph stacked over a caption still fits.
            .frame(width: width)
            .frame(minHeight: height)
            .frame(maxWidth: width == nil ? .infinity : nil)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(isHeld ? LG.Color.cyan.opacity(0.18) : LG.Color.chrome)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(isHeld ? LG.Color.cyan : LG.Color.stroke, lineWidth: 1)
            )
            .overlay(alignment: .topTrailing) {
                if isHeld {
                    Circle()
                        .fill(LG.Color.cyan)
                        .frame(width: 5, height: 5)
                        .padding(5)
                }
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Screen chrome

/// The LONGARM wordmark and overflow control that sits at the top of the
/// non-video screens.
struct ScreenHeader: View {
    var trailing: (() -> Void)?

    var body: some View {
        HStack {
            MonoCaps("VibeWire", size: 12, color: LG.Color.textTertiary, tracking: 4.1, weight: .medium)
            Spacer()
            if let trailing {
                Button(action: trailing) {
                    HStack(spacing: 3) {
                        ForEach(0..<3, id: \.self) { _ in
                            Circle().fill(LG.Color.textSecondary).frame(width: 3, height: 3)
                        }
                    }
                    .frame(width: LG.Metric.minimumTarget, height: LG.Metric.minimumTarget)
                    // Hit testing follows the drawn shapes, not the frame around
                    // them. Without this the target is three 3pt dots with gaps
                    // between them — visually a button, practically unhittable,
                    // and it is the only way into Settings and unpairing.
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("menu")
                .accessibilityLabel("Settings")
            }
        }
        .frame(minHeight: LG.Metric.minimumTarget)
    }
}

/// Wraps a screen in the app's ground colour and edge insets.
struct ScreenBody<Content: View>: View {
    var background: Color = LG.Color.screenGround
    @ViewBuilder var content: () -> Content

    var body: some View {
        ZStack {
            background.ignoresSafeArea()
            content()
                .padding(.horizontal, LG.Metric.gutter)
        }
        .preferredColorScheme(.dark)
    }
}
