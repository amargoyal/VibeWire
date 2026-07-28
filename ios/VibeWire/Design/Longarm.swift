import SwiftUI

/// The Longarm design system, lifted straight from the spec sheet.
///
/// Rules the whole app obeys:
///  - Dark only. There is no light mode and no `.colorScheme` branching.
///  - Colour reports a condition, never decorates. Green reachable, amber
///    degraded, red lost. Cyan is reserved for the user's own input — held
///    keys, Claude, active selection — so machine state and user state never
///    look alike.
///  - Monospace for anything measured. Helvetica for names, prose, answers.
///  - Hairlines instead of cards. No shadows inside the app.
enum LG {

    // MARK: Colour

    enum Color {
        /// reachable
        static let green = SwiftUI.Color(hex: 0x58D9A3)
        /// degraded
        static let amber = SwiftUI.Color(hex: 0xE8B45A)
        /// lost / destructive
        static let red = SwiftUI.Color(hex: 0xE4685A)
        /// Claude / active input — the user's own state
        static let cyan = SwiftUI.Color(hex: 0x6BC7E8)

        static let chrome = SwiftUI.Color(hex: 0x14171C)
        static let screenGround = SwiftUI.Color(hex: 0x0B0D10)
        static let deepGround = SwiftUI.Color(hex: 0x08090B)
        static let panel = SwiftUI.Color(hex: 0x101318)
        static let raised = SwiftUI.Color(hex: 0x0E1116)

        static let text = SwiftUI.Color(hex: 0xE9EBEE)
        static let textSecondary = SwiftUI.Color(hex: 0x949AA5)
        static let textTertiary = SwiftUI.Color(hex: 0x5C626D)
        static let textDisabled = SwiftUI.Color(hex: 0x3A404A)

        static let hairline = SwiftUI.Color(hex: 0x262B33)
        static let hairlineDim = SwiftUI.Color(hex: 0x1A1E24)
        static let stroke = SwiftUI.Color(hex: 0x2E343D)

        /// Ink used on top of a filled action button.
        static let onGreen = SwiftUI.Color(hex: 0x06130D)
        static let onAmber = SwiftUI.Color(hex: 0x170F02)
        static let onCyan = SwiftUI.Color(hex: 0x04141B)
        static let onRed = SwiftUI.Color(hex: 0x1B0805)
    }

    // MARK: Type

    enum Font {
        /// IBM Plex Mono if bundled, otherwise the system monospace. Every
        /// readout, label and key uses this.
        static func mono(_ size: CGFloat, weight: SwiftUI.Font.Weight = .regular) -> SwiftUI.Font {
            if UIFont(name: "IBMPlexMono", size: size) != nil {
                let name: String
                switch weight {
                case .medium, .semibold: name = "IBMPlexMono-Medium"
                case .bold: name = "IBMPlexMono-SemiBold"
                default: name = "IBMPlexMono"
                }
                return .custom(name, size: size)
            }
            return .system(size: size, weight: weight, design: .monospaced)
        }

        /// Names, prose, answers.
        static func sans(_ size: CGFloat, weight: SwiftUI.Font.Weight = .regular) -> SwiftUI.Font {
            .system(size: size, weight: weight)
        }
    }

    // MARK: Metrics

    enum Metric {
        /// Nothing tappable is ever smaller than this.
        static let minimumTarget: CGFloat = 44
        static let primaryAction: CGFloat = 76
        static let hubButton: CGFloat = 56

        static let radiusHairline: CGFloat = 3
        static let radiusSmall: CGFloat = 6
        static let radiusMedium: CGFloat = 10
        static let radiusLarge: CGFloat = 12

        static let hairline: CGFloat = 1
        static let gutter: CGFloat = 24

        /// Tracking on all-caps mono, per the spec sheet.
        static let capsTracking: CGFloat = 1.4
    }

    // MARK: Motion

    enum Motion {
        /// 120–180 ms, only for state changes and to hint at touch.
        static let stateChange = Animation.easeOut(duration: 0.15)
        static let touch = Animation.easeOut(duration: 0.12)

        /// Nothing decorative moves next to a live video feed, so the ambient
        /// animations are gated on there being no picture on screen.
        static let ambient = Animation.easeInOut(duration: 2.4).repeatForever(autoreverses: true)
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
        case .reachable: return LG.Color.green
        case .degraded: return LG.Color.amber
        case .lost: return LG.Color.red
        case .idle: return LG.Color.textSecondary
        }
    }

    var ink: Color {
        switch self {
        case .reachable: return LG.Color.onGreen
        case .degraded: return LG.Color.onAmber
        case .lost: return LG.Color.onRed
        case .idle: return LG.Color.text
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
