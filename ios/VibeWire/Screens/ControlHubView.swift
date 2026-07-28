import SwiftUI

/// 04A · HUB OPEN and 04B · MODIFIERS LATCHED.
///
/// Six things actually reached for, on an arc swept by the right thumb from a
/// single hub. Nothing is more than one thumb-rotation away, nothing sits above
/// the video, and modifiers latch until dismissed so a two-hand chord becomes
/// two one-hand taps.
struct ControlHubView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false
    @State private var showModifiers = false

    /// The arc traces the path of a thumb pivoting at the base of the palm:
    /// a 210px sweep, 56pt targets on a 66pt pitch, ending at the two easiest
    /// positions. Offsets are from the bottom-right corner.
    private struct Spoke {
        let action: String
        let glyph: String
        let caption: String
        let x: CGFloat
        let y: CGFloat
        let tint: Color
    }

    private var spokes: [Spoke] {
        [
            Spoke(action: "keys", glyph: "⌨", caption: "KEYS", x: 20, y: 244, tint: LG.Color.text),
            Spoke(action: "shot", glyph: "⛶", caption: "SHOT", x: 85, y: 234, tint: LG.Color.text),
            Spoke(action: "copy", glyph: "COPY", caption: "← MAC", x: 143, y: 204, tint: LG.Color.text),
            Spoke(action: "paste", glyph: "PASTE", caption: "→ MAC", x: 190, y: 157, tint: LG.Color.text),
            Spoke(action: "lock", glyph: "⇅", caption: "LOCK", x: 220, y: 99, tint: LG.Color.text),
            Spoke(action: "mods", glyph: "⌘", caption: "MODS", x: 230, y: 34, tint: LG.Color.cyan),
        ]
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            // Tapping out closes, as the hint says.
            Color.black.opacity(0.001)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(LG.Motion.stateChange) { model.showHub = false }
                }

            ForEach(Array(spokes.enumerated()), id: \.element.action) { index, spoke in
                spokeButton(spoke, index: index)
            }

            closeButton

            if model.showKeyboard { KeyboardBarView() }
            if showModifiers || !model.heldModifiers.isEmpty { modifierTray }

            MonoCaps("SWEEP THE THUMB\nTAP OUT TO CLOSE", size: 10, tracking: 1.2)
                .lineSpacing(6)
                .padding(.leading, 20)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                .padding(.bottom, 120)
                .allowsHitTesting(false)
        }
        // The scrim is 660pt across and the ring 420pt — both wider than the
        // phone. As stack children they set the stack's size, the whole remote
        // view gets laid out at 660pt wide, and the picture and the arc both
        // end up past the edges where no thumb can reach them. A background is
        // sized by its content instead of the other way round, so the
        // decoration overflows without moving anything.
        //
        // `.frame(maxWidth: .infinity)` does not fix this: it can expand a view
        // to fill, never shrink one that asked for more than it was offered.
        .background(alignment: .bottomTrailing) { decoration }
        .onAppear {
            withAnimation(LG.Motion.stateChange) { appeared = true }
        }
    }

    /// The radial scrim keeps the arc legible over live video without covering
    /// the picture with a flat sheet, and the dashed ring traces the sweep.
    /// Both are larger than the phone on purpose — they read as a corner of
    /// something bigger.
    private var decoration: some View {
        ZStack(alignment: .bottomTrailing) {
            RadialGradient(
                colors: [LG.Color.deepGround.opacity(0.95), LG.Color.deepGround.opacity(0)],
                center: .bottomTrailing,
                startRadius: 40,
                endRadius: 330
            )
            .frame(width: 660, height: 660)
            .offset(x: 170, y: 170)

            Circle()
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                .foregroundStyle(LG.Color.cyan.opacity(0.16))
                .frame(width: 420, height: 420)
                .offset(x: 162, y: 148)
        }
        .allowsHitTesting(false)
    }

    private func spokeButton(_ spoke: Spoke, index: Int) -> some View {
        Button {
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
            switch spoke.action {
            case "keys":
                model.showKeyboard = true
                model.showHub = false
            case "mods":
                // Reveals the latch tray rather than firing an action. Without
                // this the spoke was dead: the tray only showed once something
                // was already held, which is the one state you cannot reach
                // without the tray.
                withAnimation(LG.Motion.stateChange) { showModifiers.toggle() }
            default:
                model.hub(spoke.action)
            }
        } label: {
            VStack(spacing: spoke.glyph.count > 2 ? 2 : 3) {
                Text(spoke.glyph)
                    .font(LG.Font.mono(spoke.glyph.count > 2 ? 10 : 15, weight: spoke.glyph.count > 2 ? .medium : .regular))
                    .foregroundStyle(spoke.tint)
                MonoCaps(
                    spoke.caption,
                    size: 8,
                    color: spoke.tint == LG.Color.cyan ? LG.Color.cyan : LG.Color.textSecondary,
                    tracking: 0.8
                )
            }
            .frame(width: LG.Metric.hubButton, height: LG.Metric.hubButton)
            .background(
                Circle().fill(
                    spoke.tint == LG.Color.cyan ? LG.Color.cyan.opacity(0.14) : LG.Color.chrome
                )
            )
            .overlay(
                Circle().stroke(
                    spoke.tint == LG.Color.cyan ? LG.Color.cyan : LG.Color.stroke,
                    lineWidth: 1
                )
            )
        }
        .buttonStyle(.plain)
        .offset(x: -spoke.x, y: -spoke.y)
        // The spokes land in sequence along the thumb arc, which is the one
        // authored moment in the app. Reduce Motion keeps the sequence — the
        // stagger is timing, not movement — and drops the spring and the
        // scale, which are the parts that travel.
        .scaleEffect(reduceMotion ? 1 : (appeared ? 1 : 0.6))
        .opacity(appeared ? 1 : 0)
        .animation(
            (reduceMotion
                ? Animation.easeOut(duration: 0.14)
                : Animation.spring(response: 0.28, dampingFraction: 0.78))
                .delay(Double(index) * 0.018),
            value: appeared
        )
    }

    private var closeButton: some View {
        Button {
            withAnimation(LG.Motion.stateChange) { model.showHub = false }
        } label: {
            Text("✕")
                .font(LG.Font.mono(19))
                .foregroundStyle(LG.Color.cyan)
                .frame(width: LG.Metric.hubButton, height: LG.Metric.hubButton)
                .background(Circle().fill(LG.Color.cyan.opacity(0.18)))
                .overlay(Circle().stroke(LG.Color.cyan, lineWidth: 1))
        }
        .buttonStyle(.plain)
        .offset(x: -20, y: -34)
    }

    /// 04B. Every trace of held state is cyan: the caps, the scroll-lock badge,
    /// the cursor halo. Machine conditions never use it, so a glance separates
    /// "the Mac is doing something" from "I left something switched on".
    private var modifierTray: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                MonoCaps("HELD UNTIL RELEASED", size: 10, color: LG.Color.cyan, tracking: 1.6)
                Spacer()
                MonoCaps(
                    "SENT: \(model.heldModifiers.sorted().map(glyph(for:)).joined())",
                    size: 10,
                    tracking: 1.2
                )
            }

            HStack(spacing: 8) {
                ForEach(ModifierSpec.all, id: \.name) { spec in
                    KeyCap(
                        glyph: spec.glyph,
                        caption: spec.caption,
                        width: 62,
                        height: 52,
                        isHeld: model.heldModifiers.contains(spec.name)
                    ) {
                        model.toggleModifier(spec.name)
                    }
                }

                Button {
                    model.releaseModifiers()
                } label: {
                    MonoCaps("RELEASE\nALL", size: 9, color: LG.Color.textSecondary, tracking: 1)
                        .multilineTextAlignment(.center)
                        .frame(maxWidth: .infinity)
                        .frame(height: 52)
                        .background(RoundedRectangle(cornerRadius: 8).fill(LG.Color.chrome))
                        .overlay(
                            RoundedRectangle(cornerRadius: 8).stroke(LG.Color.hairline, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
            .padding(.top, 12)

            Text("Latched keys survive taps, drags and the keyboard. Two lit caps means the next touch is a \(model.heldModifiers.sorted().map(glyph(for:)).joined()) touch.")
                .font(LG.Font.sans(13))
                .foregroundStyle(LG.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 12)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(
            RoundedRectangle(cornerRadius: LG.Metric.radiusLarge)
                .fill(Color(hex: 0x0D1014).opacity(0.92))
        )
        .overlay(
            RoundedRectangle(cornerRadius: LG.Metric.radiusLarge)
                .stroke(LG.Color.cyan.opacity(0.28), lineWidth: 1)
        )
        .padding(.horizontal, 18)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
        .padding(.bottom, 128)
        .transition(LG.Motion.rise(reduced: reduceMotion))
    }

    private func glyph(for modifier: String) -> String {
        ModifierSpec.all.first { $0.name == modifier }?.glyph ?? ""
    }
}
