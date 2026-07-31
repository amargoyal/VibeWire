import SwiftUI
import UIKit

/// Nightshift — the design system the whole app obeys.
///
/// It replaces Longarm, and the change is structural rather than cosmetic.
/// Longarm drew an instrument out of hairlines on a near-black ground: every
/// panel was a 1pt border, every grouped list a stack of rules, and the accent
/// was cyan. Nightshift keeps what that was for and changes what carries the
/// structure:
///
///  - **Filled surfaces, not hairlines.** A card is a lighter ground with a
///    large corner, not a box drawn around nothing. Two greys apart is easier
///    to read at arm's length than a 1pt line, and it survives a phone at
///    minimum brightness outdoors, which the hairlines did not.
///  - **Violet is the user's colour**, where Longarm used cyan. Held keys,
///    focus, Claude, the current selection. Machine conditions keep green /
///    amber / red, so "the Mac is doing something" and "I left something
///    switched on" still cannot be confused.
///  - **Grouped rows are one shape.** A list is a run of rows two points apart
///    whose outer corners round and whose inner corners do not, so the group
///    reads as one object and each row is still its own target.
///
/// Unchanged, because the reasons have not changed:
///  - Dark only. There is no light mode and no `.colorScheme` branching.
///  - Colour reports a condition, never decorates.
///  - Monospace for anything measured; the system sans for names, prose and
///    answers. Both scale with the reader's text size; nothing renders under
///    9pt.
///  - Reduce Motion takes the travel and the scale, never the fact that
///    something happened, and never the spinner.
///
/// The literals below are the sRGB conversions of the palette's OKLCH
/// definitions, which is where the web client states them. Keeping both sides in
/// the same space is what stops the two clients drifting a step apart.
enum NS {

    // MARK: Colour

    enum Color {
        /// reachable — oklch(0.83 0.14 165)
        static let green = SwiftUI.Color(hex: 0x5CE4B1)
        /// degraded — oklch(0.84 0.13 80)
        static let amber = SwiftUI.Color(hex: 0xF7C15F)
        /// lost / destructive — oklch(0.705 0.16 22)
        static let red = SwiftUI.Color(hex: 0xF37272)
        /// The user's own state: held keys, focus, the current selection,
        /// Claude. Violet rather than cyan so it cannot be mistaken for a green
        /// readout at a glance on a dim screen, which is where the two used to
        /// collide. oklch(0.765 0.13 272)
        static let accent = SwiftUI.Color(hex: 0x96ADFF)

        /// Four grounds, and every surface in the app is one of them.
        /// `screen` is the app; `deep` is what video and code sit on; `raised`
        /// is a card; `raised2` is a control inside a card.
        static let deepGround = SwiftUI.Color(hex: 0x06070A)
        static let screenGround = SwiftUI.Color(hex: 0x0F1114)
        static let raised = SwiftUI.Color(hex: 0x181A1F)
        static let raised2 = SwiftUI.Color(hex: 0x22252B)
        /// `raised` measured against `deep` rather than against `screen` — the
        /// same apparent step, on the darker ground the remote view uses.
        static let chrome = SwiftUI.Color(hex: 0x14161A)
        static let chrome2 = SwiftUI.Color(hex: 0x191B1E)

        /// Four steps of ink, each measured against the ground it lands on.
        ///   text 15.9:1 · textSecondary 7.4:1 · textTertiary 4.6:1 on `screen`
        ///
        /// `textFaint` is 3.1:1, deliberately below the body threshold: it is
        /// for the all-caps footnotes that repeat something already stated
        /// above, never for a sentence that carries information on its own.
        /// `textDisabled` is not for text at all — dormant indicator fills and
        /// disabled control ink only.
        static let text = SwiftUI.Color(hex: 0xF2F3F6)
        static let textSecondary = SwiftUI.Color(hex: 0xA5A9B1)
        static let textTertiary = SwiftUI.Color(hex: 0x777C84)
        static let textFaint = SwiftUI.Color(hex: 0x5F636B)
        static let textDisabled = SwiftUI.Color(hex: 0x3F4349)

        /// Prose the user wrote, set a step below Claude's answers so a
        /// transcript reads as a conversation without either side being a
        /// bubble.
        static let you = SwiftUI.Color(hex: 0xC1C4CB)
        static let codeInk = SwiftUI.Color(hex: 0xDCDEE2)
        static let context = SwiftUI.Color(hex: 0xB4B7BD)
        /// Body copy inside an amber card, where plain secondary ink would sit
        /// at 3.9:1 against the wash.
        static let onAmberWash = SwiftUI.Color(hex: 0xDCB87A)

        /// Nightshift draws far fewer lines than Longarm did: one now separates
        /// things a gap cannot, and nothing else.
        static let hairline = SwiftUI.Color(hex: 0x26292F)
        static let hairlineDim = SwiftUI.Color(hex: 0x1D1F24)
        static let stroke = SwiftUI.Color(hex: 0x2F3339)

        /// The edge of a control that has no fill, which is a different job
        /// from a line between two things.
        ///
        /// On an outlined action and on a toggle in its off state the edge *is*
        /// the control — there is nothing else on the glass to find — so it is
        /// held to the 3:1 that non-text contrast asks for rather than to the
        /// eye of a hairline. `stroke` measures 1.5:1 against the screen ground
        /// and fails that by more than half. Measured against the three grounds
        /// one of these actually sits on:
        ///   3.65:1 on `deep` · 3.44:1 on `screen` · 3.16:1 on `raised`
        ///
        /// Everything else keeps `stroke`. Holding every hairline to this number
        /// would make the system loud in the places it is deliberately quiet,
        /// which is the whole reason there are two.
        /// oklch(0.52 0.012 262)
        static let edge = SwiftUI.Color(hex: 0x656970)

        /// Ink on a filled action. Each is its own tint taken down to a
        /// near-black of the same hue, so a filled button reads as one object
        /// rather than as black text on colour.
        static let onGreen = SwiftUI.Color(hex: 0x002D1D)
        static let onAmber = SwiftUI.Color(hex: 0x2E1B00)
        static let onAccent = SwiftUI.Color(hex: 0x0E142C)
        static let onRed = SwiftUI.Color(hex: 0x230707)

        /// The scrim behind a destructive confirmation, laid on at 72% — which
        /// is where the browser puts it too. oklch(0.10 0.006 262)
        static let scrim = SwiftUI.Color(hex: 0x030305)

        /// The two greys of the hatch that stands in for a picture that has not
        /// arrived. An empty frame, never a black one — a black rectangle is a
        /// claim about what the Mac is displaying.
        static let hatchLight = SwiftUI.Color(hex: 0x15171C)
        static let hatchDark = SwiftUI.Color(hex: 0x0D0F13)
    }

    // MARK: Type

    enum Font {
        /// Every size in this app is a designed value — 9pt units, a 26pt
        /// readout, a 36pt machine name — so none of them can be handed to a
        /// system text style wholesale without losing the scale the instrument
        /// is drawn on. They still have to answer the reader's text size.
        ///
        /// So each call is scaled *relative to* the standard style nearest its
        /// own size, using that style's own growth curve: a 9pt unit label
        /// tracks `caption2`, a 36pt machine name tracks `largeTitle`, and the
        /// two grow at the different rates Apple already tuned.
        ///
        /// **The reader's size is an argument, never something read here**, and
        /// that is the whole of the fix for a clamp that did not clamp.
        ///
        /// `UIFontMetrics.scaledValue(for:)` resolves against the *application's*
        /// content size category and against nothing else — not
        /// `UITraitCollection.current`, and not SwiftUI's `dynamicTypeSize`
        /// environment. Measured, with the app at the largest accessibility
        /// step: `scaledValue(for: 9)` returns 33.33 both inside and outside a
        /// `.dynamicTypeSize(...accessibility1)` subtree, while a standard
        /// `caption2` line under that same modifier drops from 66.33pt to
        /// 33.67. So the remote screen's ceiling bound the text styles and left
        /// every `mono` and `sans` in the app free to grow past it — a screen
        /// documenting a limit it did not have. `performAsCurrent` does not
        /// reach it either, which rules out every trait-collection override.
        ///
        /// `scaledValue(for:compatibleWith:)` does honour a stated category, so
        /// the size comes in from the environment instead: already clamped
        /// where a ceiling is in force, and the reader's own everywhere else.
        /// Measured against the old spelling with no ceiling anywhere, the two
        /// agree to the point: 9.00 / 17.33 / 33.33 for a 9pt label at large /
        /// accessibility1 / accessibility5.
        private static func metrics(for size: CGFloat) -> UIFontMetrics {
            UIFontMetrics(forTextStyle: textStyle(for: size))
        }

        static func textStyle(for size: CGFloat) -> UIFont.TextStyle {
            switch size {
            case ..<12: return .caption2      // 11pt base — labels, units, captions
            case ..<13: return .caption1      // 12pt
            case ..<14.5: return .footnote    // 13pt — supporting prose
            case ..<16: return .subheadline   // 15pt — body prose, row titles
            case ..<16.5: return .callout     // 16pt
            case ..<20: return .body          // 17pt — readouts, action titles
            case ..<21: return .title3        // 20pt
            case ..<28: return .title2        // 22pt — screen titles, headlines
            case ..<34: return .title1        // 28pt — section titles
            default: return .largeTitle       // 34pt — the machine name, the zoom badge
            }
        }

        /// UIKit and SwiftUI each ship their own `TextStyle`, and they do not
        /// convert. The metrics side needs UIKit's; `Font.custom(relativeTo:)`
        /// needs SwiftUI's. Same roles, mapped once.
        private static func swiftUIStyle(for size: CGFloat) -> SwiftUI.Font.TextStyle {
            switch textStyle(for: size) {
            case .caption2: return .caption2
            case .caption1: return .caption
            case .footnote: return .footnote
            case .subheadline: return .subheadline
            case .callout: return .callout
            case .title3: return .title3
            case .title2: return .title2
            case .title1: return .title
            case .largeTitle: return .largeTitle
            default: return .body
            }
        }

        /// Nothing renders smaller than this, whatever the reader's setting.
        /// The instrument is dense on purpose, but a 6pt caption is not density
        /// — it is a value nobody can read.
        static let floor: CGFloat = 9

        /// The point size a call will actually render at, after the reader's
        /// text setting and the floor. Exposed because a monospaced layout can
        /// compute its own width from it — see `DiffView`.
        static func scaledSize(_ size: CGFloat, at type: DynamicTypeSize) -> CGFloat {
            max(
                floor,
                metrics(for: size).scaledValue(
                    for: size,
                    compatibleWith: UITraitCollection(preferredContentSizeCategory: .init(type))
                )
            )
        }

        /// SF Mono and IBM Plex Mono both advance 0.6em per character, which is
        /// what makes a monospaced column measurable without laying it out.
        static func monoAdvance(_ size: CGFloat, at type: DynamicTypeSize) -> CGFloat {
            scaledSize(size, at: type) * 0.6
        }

        /// IBM Plex Mono if bundled, otherwise the system monospace. Every
        /// readout, label and key uses this.
        ///
        /// Nightshift was drawn in Plex, and nothing bundles it today — there is
        /// no `UIAppFonts` key and no font file in the target — so every one of
        /// these is SF Mono in practice. The branch is kept because it is the
        /// one place that would need to change if the face is ever added, and
        /// because `custom` scales natively against the same style the fallback
        /// computes — natively meaning *from the environment*, which is the one
        /// thing the fallback did not do and the reason a ceiling on this app
        /// used to bind one branch of this function and not the other.
        static func mono(
            _ size: CGFloat,
            weight: SwiftUI.Font.Weight = .regular,
            at type: DynamicTypeSize
        ) -> SwiftUI.Font {
            if UIFont(name: "IBMPlexMono", size: size) != nil {
                let name: String
                switch weight {
                case .medium, .semibold: name = "IBMPlexMono-Medium"
                case .bold: name = "IBMPlexMono-SemiBold"
                default: name = "IBMPlexMono"
                }
                return .custom(
                    name,
                    size: max(floor, size),
                    relativeTo: swiftUIStyle(for: size)
                )
            }
            return .system(size: scaledSize(size, at: type), weight: weight, design: .monospaced)
        }

        /// Names, prose, answers. Instrument Sans where it is installed, the
        /// system face otherwise — the design's grammar is the weights and the
        /// tracking, not the specific face, and an instrument that waits on a
        /// font to say whether the link is up has its priorities wrong.
        static func sans(
            _ size: CGFloat,
            weight: SwiftUI.Font.Weight = .regular,
            at type: DynamicTypeSize
        ) -> SwiftUI.Font {
            if UIFont(name: "InstrumentSans-Regular", size: size) != nil {
                let name: String
                switch weight {
                case .medium: name = "InstrumentSans-Medium"
                case .semibold, .bold: name = "InstrumentSans-SemiBold"
                default: name = "InstrumentSans-Regular"
                }
                return .custom(name, size: max(floor, size), relativeTo: swiftUIStyle(for: size))
            }
            return .system(size: scaledSize(size, at: type), weight: weight)
        }

        /// The app's one heading style. Tight tracking and a semibold weight is
        /// what makes a machine name read as a title rather than as large body
        /// copy — Longarm set these regular and they never quite did.
        static func display(_ size: CGFloat, at type: DynamicTypeSize) -> SwiftUI.Font {
            sans(size, weight: .semibold, at: type)
        }
    }

    // MARK: Metrics

    enum Metric {
        /// Nothing tappable is ever smaller than this.
        static let minimumTarget: CGFloat = 44
        /// The primary action shrank from Longarm's 76pt box to a 68pt card
        /// because it no longer carries a border and the sub-label sits tighter
        /// under the title.
        static let primaryAction: CGFloat = 68
        static let secondaryAction: CGFloat = 56
        static let row: CGFloat = 58
        /// A control in the remote view's rail.
        static let railButton: CGFloat = 52

        /// Corners. A card is 20; the control inside it is 16; the control
        /// inside *that* is 12. The three steps are what make a nested control
        /// read as nested without a single line being drawn.
        static let radiusCard: CGFloat = 20
        static let radiusCardLarge: CGFloat = 22
        static let radiusControl: CGFloat = 16
        static let radiusInner: CGFloat = 12
        static let radiusSmall: CGFloat = 8
        /// A drawer's top corners, larger than a card's so it reads as arriving
        /// from off-screen rather than as a card that grew.
        static let radiusDrawer: CGFloat = 28
        /// The outline of a screen, wherever one is drawn small: the display
        /// chips, the side-by-side pair, the last-frame thumbnail. Tighter on
        /// purpose — a 22pt rectangle with a 16pt corner reads as a pill, not as
        /// a monitor.
        static let radiusScreen: CGFloat = 3
        /// The tip of a 3pt bar — the signal strength, the RTT trace. Barely a
        /// corner on purpose: a row of twenty square-ended bars is a picket
        /// fence, and rounding them any further turns the trace into a row of
        /// lozenges that reads as decoration rather than as samples.
        static let radiusBar: CGFloat = 1

        /// Grouped rows: the outer corner of the run, and the inner one. A row
        /// in the middle keeps the small corner so the 2pt gap reads as a seam
        /// rather than as space between separate cards.
        static let radiusGroupOuter: CGFloat = 16
        static let radiusGroupInner: CGFloat = 4
        static let groupGap: CGFloat = 2

        static let hairline: CGFloat = 1
        static let gutter: CGFloat = 20

        /// The widest a column of readings is allowed to get.
        ///
        /// Every screen but the remote view is a single column of rows, and a
        /// row is a label on the left and a value on the right. Run that to the
        /// glass on an iPad and the two ends stop being readable as one line —
        /// the eye loses which value belongs to which label. Bounded and
        /// centred, the same column reads as a deliberate panel at any width.
        static let measure: CGFloat = 560
        /// Past this the screen stops being a tall column and becomes two:
        /// picture on the left, readings on a rail to the right. Taken from the
        /// content — a 320pt rail plus a 16:10 picture wide enough to be worth
        /// looking at — not from a device class.
        static let wide: CGFloat = 900
        static let rail: CGFloat = 320

        /// Tracking on all-caps mono.
        static let capsTracking: CGFloat = 1.4
        static let capsTrackingWide: CGFloat = 2.4
        /// Tracking on the display sizes, as a fraction of the point size. The
        /// single most legible difference between this and the screens it
        /// replaces.
        static let displayTracking: CGFloat = -0.035
        static let titleTracking: CGFloat = -0.03
    }

    // MARK: Motion

    enum Motion {
        /// 120–180 ms, only for state changes and to hint at touch.
        static let stateChange = Animation.easeOut(duration: 0.15)

        /// A panel arriving from the bottom edge, and the same arrival for a
        /// reader who asked the system for less motion.
        ///
        /// Reduce Motion is about the vestibular system, not about stillness:
        /// what has to go is travel, scale and parallax, not the fact that
        /// something appeared. So the sheet still arrives — it just fades in
        /// place instead of sliding a screen height.
        static func rise(reduced: Bool) -> AnyTransition {
            reduced
                ? .opacity
                : .move(edge: .bottom).combined(with: .opacity)
        }

        /// A perpetual loop, or `nil` when the system has asked for less
        /// motion. `nil` is deliberate rather than a still animation: it is
        /// what `withAnimation` takes to mean "set this value now", so a caller
        /// lands on the resting state in one step.
        ///
        /// The exception is an activity spinner. A small rotating arc is not a
        /// vestibular trigger — iOS keeps its own `ProgressView` turning under
        /// Reduce Motion — and freezing one would say the host had stopped
        /// answering, which is a claim this app is not allowed to make without
        /// having measured it.
        static func loop(
            _ duration: Double,
            autoreverses: Bool,
            reduced: Bool
        ) -> Animation? {
            guard !reduced else { return nil }
            return .easeInOut(duration: duration).repeatForever(autoreverses: autoreverses)
        }

        static func linearLoop(_ duration: Double, reduced: Bool) -> Animation? {
            guard !reduced else { return nil }
            return .linear(duration: duration).repeatForever(autoreverses: false)
        }
    }
}

// MARK: - Type, applied where the reader's size can be read

/// The app's faces, applied as a modifier rather than fetched as a value.
///
/// `NS.Font` cannot read the reader's text size for itself: a static function
/// has no view, therefore no environment, and `UIFontMetrics` answers a static
/// call with the *application's* setting no matter what ceiling the view tree
/// above it declared. A modifier does have an environment. So this is where the
/// two meet, and it is the only place in the app that resolves a font.
///
/// The cost is that a font is no longer a value a call site can hold: every
/// `.nsMono(9)` is `.nsMono(9)` instead, and the three places that
/// need the resolved *number* rather than the face — the display title's
/// tracking, the diff's column width, the markdown parser's inline code —
/// declare `@Environment(\.dynamicTypeSize)` and say `at:` themselves. In
/// exchange, `.dynamicTypeSize(...)` means on this app's own type exactly what
/// it means on the system's, which is what it already claimed.
struct NSFontModifier: ViewModifier {
    enum Face { case mono, sans, display }

    let face: Face
    let size: CGFloat
    var weight: SwiftUI.Font.Weight = .regular

    @Environment(\.dynamicTypeSize) private var type

    func body(content: Content) -> some View {
        content.font(resolved)
    }

    private var resolved: SwiftUI.Font {
        switch face {
        case .mono: return NS.Font.mono(size, weight: weight, at: type)
        case .sans: return NS.Font.sans(size, weight: weight, at: type)
        case .display: return NS.Font.display(size, at: type)
        }
    }
}

extension View {
    /// Anything the machine measured or named.
    func nsMono(_ size: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(NSFontModifier(face: .mono, size: size, weight: weight))
    }

    /// Anything a person wrote.
    func nsSans(_ size: CGFloat, weight: Font.Weight = .regular) -> some View {
        modifier(NSFontModifier(face: .sans, size: size, weight: weight))
    }

    /// The one heading.
    func nsDisplay(_ size: CGFloat) -> some View {
        modifier(NSFontModifier(face: .display, size: size))
    }
}

/// SwiftUI and UIKit each name the twelve steps of Dynamic Type, and only the
/// SwiftUI → UIKit direction is missing from the frameworks. `UIFontMetrics`
/// speaks the UIKit one; the environment speaks the SwiftUI one; this is the
/// single place they are translated, so a step cannot be mismapped twice.
extension UIContentSizeCategory {
    init(_ type: DynamicTypeSize) {
        switch type {
        case .xSmall: self = .extraSmall
        case .small: self = .small
        case .medium: self = .medium
        case .large: self = .large
        case .xLarge: self = .extraLarge
        case .xxLarge: self = .extraExtraLarge
        case .xxxLarge: self = .extraExtraExtraLarge
        case .accessibility1: self = .accessibilityMedium
        case .accessibility2: self = .accessibilityLarge
        case .accessibility3: self = .accessibilityExtraLarge
        case .accessibility4: self = .accessibilityExtraExtraLarge
        case .accessibility5: self = .accessibilityExtraExtraExtraLarge
        @unknown default: self = .large
        }
    }
}

extension Color {
    init(hex: UInt32) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

// MARK: - Condition

/// One colour per condition, chosen once here so no screen invents its own
/// mapping.
enum Condition {
    case reachable
    case degraded
    case lost
    case idle

    var color: Color {
        switch self {
        case .reachable: return NS.Color.green
        case .degraded: return NS.Color.amber
        case .lost: return NS.Color.red
        case .idle: return NS.Color.textSecondary
        }
    }

    var ink: Color {
        switch self {
        case .reachable: return NS.Color.onGreen
        case .degraded: return NS.Color.onAmber
        case .lost: return NS.Color.onRed
        case .idle: return NS.Color.text
        }
    }

    /// Derived from measured values, never from a hand-set flag, so the label
    /// and the numbers beside it can never disagree.
    static func from(rttMillis: Double?, lossPercent: Double, awake: Bool) -> Condition {
        guard awake else { return .idle }
        guard let rtt = rttMillis else { return .lost }
        if rtt > 250 || lossPercent > 3 { return .degraded }
        return .reachable
    }
}
