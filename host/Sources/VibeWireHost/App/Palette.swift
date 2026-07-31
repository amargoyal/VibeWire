import AppKit

/// The Nightshift palette, for the two pieces of the Mac that draw themselves:
/// the menu bar's readout header and the pairing window.
///
/// The host follows macOS rather than iOS almost everywhere — it is a menu bar
/// item and one window, and both should behave like the platform's own. The
/// exception is the pairing window, which is the only screen a user compares
/// side by side with the phone in their other hand. That one is drawn in the
/// app's colours so the six digits on the Mac and the six boxes on the phone
/// look like the same instrument.
///
/// These are the sRGB conversions of the same OKLCH definitions the web client
/// and the iOS app state. Keeping all three in the same space is what stops
/// them drifting a step apart.
enum Palette {
    static let green = NSColor(srgbRed: 0x5C / 255, green: 0xE4 / 255, blue: 0xB1 / 255, alpha: 1)
    static let amber = NSColor(srgbRed: 0xF7 / 255, green: 0xC1 / 255, blue: 0x5F / 255, alpha: 1)
    static let red = NSColor(srgbRed: 0xF3 / 255, green: 0x72 / 255, blue: 0x72 / 255, alpha: 1)
    /// The user's own state. Violet, not cyan.
    static let accent = NSColor(srgbRed: 0x96 / 255, green: 0xAD / 255, blue: 0xFF / 255, alpha: 1)

    static let deep = NSColor(srgbRed: 0x06 / 255, green: 0x07 / 255, blue: 0x0A / 255, alpha: 1)
    static let screen = NSColor(srgbRed: 0x0F / 255, green: 0x11 / 255, blue: 0x14 / 255, alpha: 1)
    static let raised = NSColor(srgbRed: 0x18 / 255, green: 0x1A / 255, blue: 0x1F / 255, alpha: 1)
    static let raised2 = NSColor(srgbRed: 0x22 / 255, green: 0x25 / 255, blue: 0x2B / 255, alpha: 1)

    static let text = NSColor(srgbRed: 0xF2 / 255, green: 0xF3 / 255, blue: 0xF6 / 255, alpha: 1)
    static let textSecondary = NSColor(srgbRed: 0xA5 / 255, green: 0xA9 / 255, blue: 0xB1 / 255, alpha: 1)
    static let textTertiary = NSColor(srgbRed: 0x77 / 255, green: 0x7C / 255, blue: 0x84 / 255, alpha: 1)
    static let textFaint = NSColor(srgbRed: 0x5F / 255, green: 0x63 / 255, blue: 0x6B / 255, alpha: 1)

    static let hairline = NSColor(srgbRed: 0x26 / 255, green: 0x29 / 255, blue: 0x2F / 255, alpha: 1)
    static let stroke = NSColor(srgbRed: 0x2F / 255, green: 0x33 / 255, blue: 0x39 / 255, alpha: 1)

    /// Corners, in the same three steps every client uses: a card is 20, the
    /// control inside it is 16, the control inside *that* is 12.
    enum Radius {
        static let card: CGFloat = 20
        static let control: CGFloat = 16
        static let inner: CGFloat = 12
        static let small: CGFloat = 8
    }
}

extension NSView {
    /// A filled surface with a corner. Nightshift draws a card as a lighter
    /// ground rather than as a box around nothing, so this is the only
    /// background helper the host needs.
    @discardableResult
    func fill(_ color: NSColor, radius: CGFloat) -> Self {
        wantsLayer = true
        layer?.cornerRadius = radius
        layer?.backgroundColor = color.cgColor
        return self
    }
}

/// The rotation dial on the pairing window.
///
/// A sweep rather than a number that ticks: the number is beside it, and this
/// says at a glance whether there is time to walk to the phone and finish
/// typing. Drawn rather than animated — it is redrawn once a second by the same
/// timer that refreshes the code, so there is no animation to freeze under
/// Reduce Motion and nothing perpetual running behind a window nobody is
/// looking at.
final class RotationDial: NSView {
    /// 0…1 of the rotation window still remaining.
    var fraction: Double = 1 {
        didSet { needsDisplay = true }
    }

    override func draw(_ dirtyRect: NSRect) {
        let box = bounds.insetBy(dx: 0.5, dy: 0.5)
        let centre = NSPoint(x: box.midX, y: box.midY)
        let radius = min(box.width, box.height) / 2

        Palette.raised2.setFill()
        NSBezierPath(ovalIn: box).fill()

        let sweep = NSBezierPath()
        sweep.move(to: centre)
        sweep.appendArc(
            withCenter: centre,
            radius: radius,
            startAngle: 90,
            endAngle: 90 - 360 * CGFloat(max(0, min(1, fraction))),
            clockwise: true
        )
        sweep.close()
        Palette.amber.setFill()
        sweep.fill()

        Palette.screen.setFill()
        NSBezierPath(ovalIn: box.insetBy(dx: radius * 0.42, dy: radius * 0.42)).fill()
    }
}
