import SwiftUI

/// 06 · REMOTE — COMMANDS.
///
/// This replaces the thumb arc, and the reasons are worth keeping.
///
/// The arc put six 56pt circles on a sweep struck from the bottom-right corner,
/// so nothing was more than one thumb-rotation away. It was the most authored
/// thing in the app and it had three faults that never went away: it only fitted
/// a right thumb, the captions were two-word fragments that had to be learnt
/// rather than read, and — because the sweep reached most of the way up the
/// glass — it sat squarely over the Mac's picture, which is the one surface this
/// app exists to show.
///
/// A drawer fixes all three. It rises from the bottom edge and stops short of
/// the letterbox band, so the picture is never covered. Every action is a
/// labelled tile in a four-column grid, reachable by either hand. And the
/// modifiers, which used to be a tray that only appeared once something was
/// already held, are a permanent section of it — the one state you could not
/// previously reach without the tray.
///
/// What is unchanged: modifiers latch until released, so a two-hand chord is two
/// one-hand taps, and every trace of held state is violet, because machine
/// conditions never use it.
struct CommandDrawerView: View {
    @Environment(AppModel.self) private var model

    private struct Command {
        let action: String
        let glyph: String
        let caption: String
        let spoken: String
        var glyphSize: CGFloat = 16
    }

    /// Six commands, in the order they are reached for. KEYS and SHOT lead
    /// because they are the two that get used in the first minute; LOCK is last
    /// because it ends the session.
    private let commands: [Command] = [
        Command(action: "keys", glyph: "⌨", caption: "KEYS", spoken: "Keyboard"),
        Command(action: "shot", glyph: "⛶", caption: "SHOT", spoken: "Screenshot the Mac"),
        Command(
            action: "copy",
            glyph: "←",
            caption: "COPY",
            spoken: "Copy from the Mac",
            glyphSize: 13
        ),
        Command(
            action: "paste",
            glyph: "→",
            caption: "PASTE",
            spoken: "Paste to the Mac",
            glyphSize: 13
        ),
        Command(action: "enter", glyph: "⏎", caption: "ENTER", spoken: "Press Return on the Mac"),
        Command(action: "lock", glyph: "⏻", caption: "LOCK", spoken: "Lock the Mac’s screen"),
    ]

    private var held: [String] { model.heldModifiers.sorted() }

    private var sent: String {
        held.compactMap { name in
            ModifierSpec.all.first { $0.name == name }?.glyph
        }
        .joined()
    }

    var body: some View {
        ZStack(alignment: .bottom) {
            // Tapping out closes. The scrim is here to catch a tap, not to dim
            // the Mac's screen.
            Color.black.opacity(0.001)
                .ignoresSafeArea()
                .onTapGesture {
                    withAnimation(NS.Motion.stateChange) { model.showHub = false }
                }
                .accessibilityLabel("Close the commands")

            drawer
        }
    }

    private var drawer: some View {
        VStack(spacing: 14) {
            Grabber()

            HStack {
                MonoCaps("COMMANDS", size: 9, tracking: NS.Metric.capsTrackingWide)
                Spacer()
                Button {
                    withAnimation(NS.Motion.stateChange) { model.showHub = false }
                } label: {
                    MonoCaps("HIDE", size: 9, color: NS.Color.accent, tracking: 1.4)
                        .padding(.horizontal, 10)
                        .frame(minHeight: NS.Metric.minimumTarget)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(.vertical, -12)
            }

            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 6), count: 4),
                spacing: 6
            ) {
                ForEach(commands, id: \.action) { command in
                    Tile(
                        glyph: command.glyph,
                        caption: command.caption,
                        glyphSize: command.glyphSize,
                        spoken: command.spoken
                    ) {
                        run(command.action)
                    }
                }

                // The modifier group is not an action; it is a label for the
                // section below, and it states how many are down. It spans two
                // columns because that caption does not fit in one.
                VStack(spacing: 7) {
                    Text("⌘")
                        .font(NS.Font.mono(16))
                        .foregroundStyle(NS.Color.accent)
                    MonoCaps(
                        held.isEmpty ? "MODIFIERS" : "MODIFIERS · \(held.count) HELD",
                        size: 8,
                        color: NS.Color.accent,
                        tracking: 1
                    )
                }
                .frame(maxWidth: .infinity)
                .frame(height: 70)
                .background(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .fill(NS.Color.accent.opacity(0.14))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .stroke(NS.Color.accent.opacity(0.45), lineWidth: 1)
                )
                .gridCellColumns(2)
                .accessibilityHidden(true)
            }

            modifierSection
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity)
        .background(
            UnevenRoundedRectangle(
                topLeadingRadius: NS.Metric.radiusDrawer,
                topTrailingRadius: NS.Metric.radiusDrawer
            )
            .fill(NS.Color.raised)
        )
        .padding(.horizontal, 8)
        .accessibilityAddTraits(.isModal)
        .accessibilityLabel("Commands")
    }

    private var modifierSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                MonoCaps(
                    held.isEmpty ? "TAP TO LATCH" : "HELD UNTIL RELEASED",
                    size: 9,
                    color: held.isEmpty ? NS.Color.textTertiary : NS.Color.accent,
                    tracking: 1.6
                )
                Spacer()
                MonoCaps("SENT: \(sent.isEmpty ? "—" : sent)", size: 9, tracking: 1.2)
            }

            // Four caps that share the row and take whatever the device gives
            // them, and a fifth control that undoes the latch. Releasing
            // everything is a different kind of act from pressing a key, so it
            // is a wider target with a word on it rather than a fifth identical
            // cap.
            HStack(spacing: 6) {
                ForEach(ModifierSpec.all, id: \.name) { spec in
                    KeyCap(
                        glyph: spec.glyph,
                        caption: spec.caption,
                        height: 52,
                        isHeld: model.heldModifiers.contains(spec.name)
                    ) {
                        model.toggleModifier(spec.name)
                    }
                }

                Button {
                    model.releaseModifiers()
                } label: {
                    MonoCaps("RELEASE", size: 8, color: NS.Color.textSecondary, tracking: 1)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 52)
                        .overlay(
                            RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                .stroke(NS.Color.stroke, lineWidth: 1)
                        )
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(held.isEmpty)
                .opacity(held.isEmpty ? 0.45 : 1)
                .accessibilityLabel("Release all modifiers")
            }

            if !held.isEmpty {
                Text("Latched keys survive taps, drags and the keyboard. The next touch is a \(sent) touch.")
                    .font(NS.Font.sans(13))
                    .foregroundStyle(NS.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.top, 2)
    }

    private func run(_ action: String) {
        switch action {
        case "keys":
            model.showKeyboard = true
            withAnimation(NS.Motion.stateChange) { model.showHub = false }
        case "enter":
            // The one key worth reaching without opening a keyboard: it is what
            // finishes a command in a terminal, and summoning the whole system
            // keyboard to press it once is the long way round.
            model.key("return")
            withAnimation(NS.Motion.stateChange) { model.showHub = false }
        default:
            model.hub(action)
        }
    }
}
