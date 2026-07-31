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
    /// `raised` measured against `deep` rather than against `screen` — the same
    /// apparent step, on the darker ground the remote view uses. The Mac draws
    /// no remote view and so spends neither of these today; they are stated
    /// because a palette that is a subset of the other two clients' is a palette
    /// that drifts the next time this window grows a surface.
    static let chrome = NSColor(srgbRed: 0x14 / 255, green: 0x16 / 255, blue: 0x1A / 255, alpha: 1)
    static let chrome2 = NSColor(srgbRed: 0x19 / 255, green: 0x1B / 255, blue: 0x1E / 255, alpha: 1)

    /// Four steps of ink, each measured against the ground it lands on:
    /// `text` 15.9:1, `textSecondary` 7.4:1, `textTertiary` 4.6:1 on `screen`.
    /// `textFaint` is 3.1:1 and deliberately below the body threshold — it is
    /// for an all-caps footnote repeating something already stated above, never
    /// for a sentence carrying information on its own.
    static let text = NSColor(srgbRed: 0xF2 / 255, green: 0xF3 / 255, blue: 0xF6 / 255, alpha: 1)
    static let textSecondary = NSColor(srgbRed: 0xA5 / 255, green: 0xA9 / 255, blue: 0xB1 / 255, alpha: 1)
    static let textTertiary = NSColor(srgbRed: 0x77 / 255, green: 0x7C / 255, blue: 0x84 / 255, alpha: 1)
    static let textFaint = NSColor(srgbRed: 0x5F / 255, green: 0x63 / 255, blue: 0x6B / 255, alpha: 1)
    /// Not for text at all: a dormant indicator fill, or the ink of a control
    /// that cannot be used. Nothing a reader is meant to read lands on this.
    static let textDisabled = NSColor(srgbRed: 0x3F / 255, green: 0x43 / 255, blue: 0x49 / 255, alpha: 1)

    static let hairline = NSColor(srgbRed: 0x26 / 255, green: 0x29 / 255, blue: 0x2F / 255, alpha: 1)
    static let stroke = NSColor(srgbRed: 0x2F / 255, green: 0x33 / 255, blue: 0x39 / 255, alpha: 1)
    /// A line *between* two things and the edge of a control are different jobs
    /// and take different inks. `stroke` is the hairline — a divider, a dashed
    /// rule. `edge` is the boundary of a control that has no fill, where the
    /// edge *is* the control and there is nothing else to find, which is the
    /// case the 3:1 non-text threshold exists for. `stroke` measures 1.5:1
    /// against the screen ground and fails that by more than half; this measures
    /// 3.16:1 on `raised` and 3.04:1 on the sodium-tinted card the pairing
    /// window's grant buttons sit in.
    static let edge = NSColor(srgbRed: 0x65 / 255, green: 0x69 / 255, blue: 0x70 / 255, alpha: 1)

    /// Ink on a filled action. Each is its own tint taken down to a near-black
    /// of the same hue, so a filled button reads as one object rather than as
    /// black text sitting on colour. Named here rather than left to the call
    /// site, because "near-black of the same hue" is exactly the kind of value a
    /// call site invents differently every time it needs one.
    static let onGreen = NSColor(srgbRed: 0x00 / 255, green: 0x2D / 255, blue: 0x1D / 255, alpha: 1)
    static let onAmber = NSColor(srgbRed: 0x2E / 255, green: 0x1B / 255, blue: 0x00 / 255, alpha: 1)
    static let onAccent = NSColor(srgbRed: 0x0E / 255, green: 0x14 / 255, blue: 0x2C / 255, alpha: 1)
    static let onRed = NSColor(srgbRed: 0x23 / 255, green: 0x07 / 255, blue: 0x07 / 255, alpha: 1)

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
    ///
    /// `edge` is the one exception the system allows: a tinted card carries the
    /// hue as a 7 % wash *and* an outline, because the wash alone is 1.13:1
    /// against the ground it sits on and an edge nobody can find is not an edge.
    /// Nothing that already reads as a filled surface passes one.
    @discardableResult
    func fill(_ color: NSColor, radius: CGFloat, edge: NSColor? = nil) -> Self {
        wantsLayer = true
        layer?.cornerRadius = radius
        layer?.backgroundColor = color.cgColor
        // CALayer draws its border inside the bounds, which is what a one-point
        // edge has to do for a row of outlined controls to line up with a filled
        // sibling of the same declared height.
        layer?.borderWidth = edge == nil ? 0 : 1
        layer?.borderColor = edge?.cgColor
        return self
    }

    /// A control with no fill at all — an outlined action, where the boundary is
    /// the whole of it. Separate from `fill` rather than `fill(.clear, …)`,
    /// because "transparent" is the absence of a ground and not a colour this
    /// palette has any business naming.
    @discardableResult
    func outline(_ color: NSColor, radius: CGFloat) -> Self {
        wantsLayer = true
        layer?.cornerRadius = radius
        layer?.borderWidth = 1
        layer?.borderColor = color.cgColor
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
