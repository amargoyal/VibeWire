import SwiftUI

/// 03F · REMOTE — THE LANDSCAPE DOCK.
///
/// The rail, unrolled. A landscape window has height to spare on the right and
/// no thumb reaching around the corner, so the tiles that live in a drawer on a
/// portrait phone are simply on screen, the modifiers are a permanent row, and
/// the three readings a portrait phone has no room for — RTT, rate, and which
/// window has focus — are stated at the bottom. FRONTMOST is the one that stops
/// a typed command going into the wrong window, and it is the reason this dock
/// is worth its 276pt.
///
/// **It is two blocks, and only one of them is allowed to scroll.**
///
/// Measured, at the default text size, the previous single stack wanted 427pt.
/// A phone in landscape with the status bar hidden has its portrait width less
/// the 21pt home indicator to give: 354pt on a 13 mini, 372 on a 15, 381 on a
/// 16 Pro, 419 on a 16 Pro Max. So the stack overflowed the glass on every
/// phone in that range, and what hung off the bottom edge was the last row —
/// the way to Claude and the way to stop the stream.
///
/// Re-measured now that `RemoteView`'s `.dynamicTypeSize(...accessibility1)`
/// binds this app's own faces and not only the system's, this split wants,
/// with one monitor: 344pt at the default size and 390 at accessibility1, which
/// is the top of this screen's range. With a second monitor's picker in the
/// scrolling half: 400 and 446. Unclamped — which is what the reader would get
/// if the ceiling above were removed — the same dock wants 630 at the system's
/// largest step and 776 with two monitors and a latched modifier.
///
/// No amount of shaving fixes that, because the text can always grow further
/// than the glass. So the dock states which half it would rather lose sight of:
///
///  - `DockControls` — the header, the six command tiles, the modifiers and the
///    display picker — sits in a scroll view. A tile that is one drag away is
///    still reachable.
///  - `DockInstrument` — the three readings, CLAUDE and ✕ — never scrolls. The
///    two controls that answer "reach the agent" and "stop this now" are pinned
///    to the bottom edge at every text size, and the readings sit directly
///    above them because a reading you have to hunt for is not an instrument.
///
/// At the default size on the shortest phone in the range nothing scrolls at
/// all — the scroll view is invisible until the reader's text size, or a second
/// monitor's picker, actually needs it, and `.scrollBounceBehavior(.basedOnSize)`
/// is what stops it rubber-banding while it has nothing to scroll.
///
/// The pinned half is what that promise is measured against, and it holds with
/// room to spare: 139pt at the default size and 169 at the top of the range,
/// against 354pt of glass on the shortest phone. That leaves the scrolling half
/// 173pt there, against the 209 it wants with one monitor and the 265 it wants
/// with two — so on that phone it scrolls, and on a 16 Pro Max, with 238pt for
/// it, the one-monitor case still does not.
struct LandscapeDock: View {
    /// 16 is `spacing.lg`; the 22/24 this used to carry were not on the scale
    /// at all.
    static let padH: CGFloat = 16
    static let padV: CGFloat = 16
    /// `spacing.md`, between the two blocks and between the rows inside them.
    static let gap: CGFloat = 12
    static let width: CGFloat = 276
    /// What is left for a control once the padding is taken off.
    static var contentWidth: CGFloat { width - 2 * padH }

    var body: some View {
        VStack(alignment: .leading, spacing: Self.gap) {
            ScrollView {
                DockControls()
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(maxHeight: .infinity)

            DockInstrument()
        }
        .padding(.horizontal, Self.padH)
        .padding(.vertical, Self.padV)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(NS.Color.screenGround)
    }
}

/// Everything in the dock that is a command. This is the half that gives way.
struct DockControls: View {
    @Environment(AppModel.self) private var model

    /// 52pt — the same height as a control in the portrait rail, and 8pt clear
    /// of the 44pt floor. Six of these in three columns is 112pt of dock; the
    /// four that used to sit here in two columns at 70 were 148pt and carried
    /// two fewer commands.
    private static let tileHeight: CGFloat = 52

    private var held: [String] { model.heldModifiers.sorted() }

    var body: some View {
        VStack(alignment: .leading, spacing: LandscapeDock.gap) {
            HStack {
                MonoCaps("CONTROLS", size: 9, tracking: NS.Metric.capsTrackingWide)
                Spacer()
                // LOCK / FREE used to sit here, read from `model.scrollLock` —
                // a flag nothing in this app and nothing in `PROTOCOL.md` ever
                // writes, so the slot could only ever print FREE. A readout
                // with one reachable value is not a reading, and the flag went
                // with it rather than being left for the next reader to try to
                // wire up.
                //
                // What took the slot is measured, and is the one piece of state
                // in this dock that outlives the tap that set it: a latched
                // modifier stays down through taps, drags and the keyboard, and
                // the 46pt caps below it are easy to miss at a glance. Violet,
                // because a latch is the user's own doing. Nothing is printed
                // when nothing is held — a zero here would be a reading of the
                // same kind FREE was.
                //
                // It is also the way back out, which the drawer and the browser
                // both have and this dock did not. The word will not fit in the
                // modifier row: five 44pt cells is all `contentWidth` divides
                // into, and RELEASE at the accessibility1 step measures 71pt,
                // so it would be drawn as `RELE…` exactly where the reader most
                // needs the word. Here it has the whole trailing half of a row.
                //
                // 44pt of target on an 11pt row is the drawer's HIDE idiom: a
                // full-height hit shape pulled back in by negative padding, so
                // the box that answers a thumb is 44 while the row it sits in
                // stays a caption. The 16pt pull leaves it reaching 4pt into
                // the tile below, which keeps that tile at 48 — and only while
                // something is latched, because with nothing held there is no
                // button on screen to reach anywhere.
                if !held.isEmpty {
                    Button {
                        model.releaseModifiers()
                    } label: {
                        MonoCaps(
                            "RELEASE \(held.count)",
                            size: 9,
                            color: NS.Color.accent,
                            tracking: 1.4
                        )
                        .padding(.horizontal, 8)
                        .frame(minHeight: NS.Metric.minimumTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, -16)
                    .accessibilityLabel("Release all \(held.count) held modifiers")
                }
            }

            // Three columns rather than two, which is what let ENTER and LOCK
            // join without costing a row: four tiles in three columns is
            // already two rows, so the fifth and sixth are free. They are the
            // two the drawer has always had and this dock did not, which made
            // the landscape window the one place a command could be missing
            // from — and ⏎ is the key that finishes a command in a terminal,
            // which is most of what this app is pointed at.
            //
            // Same six, in the same order the drawer reaches for them, so
            // rotating the phone does not reshuffle them.
            LazyVGrid(
                columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 3),
                spacing: 8
            ) {
                Tile(
                    glyph: "⌨",
                    caption: "KEYS",
                    height: Self.tileHeight,
                    spoken: "Keyboard"
                ) {
                    model.showKeyboard = true
                }
                Tile(
                    glyph: "⛶",
                    caption: "SHOT",
                    height: Self.tileHeight,
                    spoken: "Screenshot the Mac"
                ) {
                    model.hub("shot")
                }
                Tile(
                    glyph: "←",
                    caption: "COPY",
                    glyphSize: 13,
                    height: Self.tileHeight,
                    spoken: "Copy from the Mac"
                ) {
                    model.hub("copy")
                }
                Tile(
                    glyph: "→",
                    caption: "PASTE",
                    glyphSize: 13,
                    height: Self.tileHeight,
                    spoken: "Paste to the Mac"
                ) {
                    model.hub("paste")
                }
                Tile(
                    glyph: "⏎",
                    caption: "ENTER",
                    height: Self.tileHeight,
                    spoken: "Press Return on the Mac"
                ) {
                    model.key("return")
                }
                Tile(
                    glyph: "⏻",
                    caption: "LOCK",
                    height: Self.tileHeight,
                    spoken: "Lock the Mac’s screen"
                ) {
                    model.hub("lock")
                }
            }

            // Four caps sharing `contentWidth` at 6pt apart: (244 − 18) / 4 =
            // 56.5pt each, comfortably over the floor. The way back out of a
            // latch is in the header, where the word fits.
            HStack(spacing: 6) {
                ForEach(ModifierSpec.all, id: \.name) { spec in
                    KeyCap(
                        glyph: spec.glyph,
                        height: 46,
                        isHeld: model.heldModifiers.contains(spec.name),
                        fontSize: 13
                    ) {
                        model.toggleModifier(spec.name)
                    }
                }
            }

            // Which screen is being sent, which was reachable in portrait and
            // nowhere in landscape — so a laptop with a second monitor could
            // only ever see the one it opened with.
            //
            // It is the one thing in this block that costs a row nothing else
            // was paying for: 56pt with its gap, which at the default text size
            // fits without scrolling only on a 16 Pro Max. It is added anyway,
            // because one drag to reach a monitor beats no way to reach it, and
            // it goes *last* precisely so that it is the thing the drag is for.
            // Above it are the modifiers, which are wanted mid-sentence and
            // have nowhere else to be reached from in this orientation.
            if model.displays.count > 1 {
                DisplayTabs()
            }
        }
    }
}

/// The three readings, and the two ways out of this screen. This is the half
/// that is always on the glass.
struct DockInstrument: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 8) {
            DockReadout("RTT", model.link.rttMillis.map { "\(Int($0)) MS" } ?? "—")
            DockReadout("RATE", String(format: "%.1f MB/S", model.link.downMbps))
            DockReadout("FRONTMOST", model.link.frontmostApp.isEmpty ? "—" : model.link.frontmostApp)
            HStack(spacing: 8) {
                Button {
                    model.presented = .claude
                    model.listClaudeSessions()
                } label: {
                    MonoCaps("CLAUDE", size: 10, color: NS.Color.accent, tracking: 1.4)
                        .frame(maxWidth: .infinity)
                        .frame(height: 50)
                        .background(
                            RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                .fill(NS.Color.accent.opacity(0.12))
                        )
                        .overlay(
                            RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                .stroke(NS.Color.accent.opacity(0.4), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)

                Button {
                    model.stopStream()
                } label: {
                    Text("✕")
                        .nsMono(14)
                        .foregroundStyle(NS.Color.textSecondary)
                        .frame(width: 50, height: 50)
                        .background(
                            RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                .fill(NS.Color.raised)
                        )
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("stopStream")
                .accessibilityLabel("Stop streaming")
            }
        }
    }
}

struct DockReadout: View {
    let label: String
    let value: String

    init(_ label: String, _ value: String) {
        self.label = label
        self.value = value
    }

    var body: some View {
        HStack {
            MonoCaps(label, size: 9, tracking: 1.2)
            Spacer()
            MonoCaps(value, size: 9, color: NS.Color.text, tracking: 1.2)
        }
    }
}
