import AppKit

/// VibeWire's mark: the damped wave that runs out into a flat line.
///
/// Stated as a path rather than shipped as a PNG for two reasons. It is drawn at
/// menu-bar size, where a bitmap of the app icon would be a grey smudge and a
/// hairline stroke would disappear entirely — a mark this small has to be redrawn
/// heavier, not resampled. And a path has no bundle to be missing from: the host
/// runs both as `VibeWire.app` and straight out of `swift build`, and a status
/// item that lost its icon in the second case would be a bug that only ever
/// appeared in development.
enum WaveMark {
    /// The wave, in a unit box with y running down from the first crest.
    ///
    /// Taken off the 1024 pt artwork and normalised, so the two marks are the
    /// same drawing at two sizes rather than two drawings of the same idea. Each
    /// segment runs crest to crest with horizontal control points, which is what
    /// gives a sine its shape; only the tail departs from that, easing out of the
    /// last crest into the flat line the wave settles to.
    private static func path(in rect: NSRect) -> NSBezierPath {
        func point(_ x: CGFloat, _ y: CGFloat) -> NSPoint {
            // y is quoted from the top, and AppKit draws from the bottom.
            NSPoint(x: rect.minX + x * rect.width, y: rect.maxY - y * rect.height)
        }

        let path = NSBezierPath()
        path.move(to: point(0.000, 0.507))
        path.curve(to: point(0.139, 0.000), controlPoint1: point(0.045, 0.360), controlPoint2: point(0.090, 0.000))
        path.curve(to: point(0.364, 1.000), controlPoint1: point(0.220, 0.000), controlPoint2: point(0.280, 1.000))
        path.curve(to: point(0.563, 0.137), controlPoint1: point(0.455, 1.000), controlPoint2: point(0.470, 0.137))
        path.curve(to: point(0.719, 0.726), controlPoint1: point(0.640, 0.137), controlPoint2: point(0.645, 0.726))
        path.curve(to: point(0.851, 0.329), controlPoint1: point(0.780, 0.329), controlPoint2: point(0.800, 0.329))
        path.curve(to: point(0.938, 0.493), controlPoint1: point(0.893, 0.329), controlPoint2: point(0.902, 0.493))
        path.line(to: point(1.000, 0.493))
        return path
    }

    /// A template image of the mark, for the status item.
    ///
    /// Template means AppKit throws the colour away and keeps the coverage, so
    /// the mark follows the menu bar — dark ink on a light bar, light on a dark
    /// one, white while the item is held open — which is the only way a status
    /// icon can be legible on a wallpaper the app does not control.
    ///
    /// The stroke is heavier in proportion than the app icon's. At 20 pt across,
    /// the icon's own 5.8 % would come out at a single point and read as a grey
    /// scribble; the mark has to survive the size it is actually drawn at.
    static func statusItemImage(width: CGFloat = 20, height: CGFloat = 12) -> NSImage {
        let lineWidth = max(1.6, width * 0.095)
        let image = NSImage(size: NSSize(width: width, height: height), flipped: false) { rect in
            // A stroke is centred on its path, so the box has to give up half a
            // line width on every side or the crests are shaved flat.
            let inner = rect.insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
            let path = path(in: inner)
            path.lineWidth = lineWidth
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            NSColor.black.setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = true
        image.accessibilityDescription = "VibeWire"
        return image
    }
}
