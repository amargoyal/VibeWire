import AppKit
import Foundation

/// Draws the picture behind the two icons in the disk image window.
///
/// A drag-to-Applications window is the first thing anyone sees of this
/// project, before the app has run once, and the default is a white rectangle
/// with two icons floating in it and no indication which way round they go.
///
/// Drawn rather than exported. The mark here is `WaveMark`'s path and the
/// colours are `Palette`'s, both compiled into this tool rather than copied
/// into it, so the artwork cannot drift from the app it introduces. A PNG
/// checked into the repository would have drifted the first time either
/// changed, and nobody would have noticed until a release went out.
///
/// Writes two files, at 1x and 2x; `package-dmg.sh` combines them into the
/// multi-resolution TIFF Finder wants, so the window is sharp on a Retina
/// display and correct on the projector it is being demonstrated on.
@main
enum DMGBackground {
    /// This window is drawn light, and the app is not.
    ///
    /// Finder draws the label under each icon itself, in the reader's system
    /// appearance, and nothing inside a disk image can change that colour. In
    /// Light Mode it is near black. The first version of this art was the
    /// app's own near-black ground, which made both labels invisible: the two
    /// words that say which icon is which.
    ///
    /// Dark would be right for the one reader in Dark Mode and wrong for
    /// everyone else, so the ground is light and the contrast comes from the
    /// app icon, which is a dark tile, and from the mark's own colours.
    enum Ink {
        static let groundTop = NSColor(srgbRed: 0xFF / 255, green: 0xFF / 255, blue: 0xFF / 255, alpha: 1)
        static let groundBottom = NSColor(srgbRed: 0xEB / 255, green: 0xEE / 255, blue: 0xF4 / 255, alpha: 1)
        static let card = NSColor(srgbRed: 0xFF / 255, green: 0xFF / 255, blue: 0xFF / 255, alpha: 1)
        static let cardEdge = NSColor(srgbRed: 0xD6 / 255, green: 0xDA / 255, blue: 0xE3 / 255, alpha: 1)
        /// The app's violet, darkened until it holds its own on white.
        static let accent = NSColor(srgbRed: 0x5B / 255, green: 0x6C / 255, blue: 0xE8 / 255, alpha: 1)
        static let text = NSColor(srgbRed: 0x0F / 255, green: 0x11 / 255, blue: 0x14 / 255, alpha: 1)
        static let textSecondary = NSColor(srgbRed: 0x4A / 255, green: 0x50 / 255, blue: 0x5C / 255, alpha: 1)
        static let textTertiary = NSColor(srgbRed: 0x75 / 255, green: 0x7C / 255, blue: 0x8A / 255, alpha: 1)
    }

    /// The window's content size, which `dmg-settings.py` states again for
    /// Finder. The two have to agree or the art sits off-centre.
    static let size = NSSize(width: 660, height: 520)

    /// Where Finder puts the two icons, in its own coordinates: origin at the
    /// top left, y downwards. Everything drawn below is positioned from these
    /// rather than from numbers repeated by hand.
    static let appIcon = NSPoint(x: 175, y: 206)
    /// The loose file, in the corner rather than under the pair. Centred, its
    /// Finder label landed on the footnote, and a text file's icon is a
    /// thumbnail of its own first paragraph: the loudest thing in the window,
    /// sitting in the middle of it.
    static let notesIcon = NSPoint(x: 586, y: 376)
    static let applicationsIcon = NSPoint(x: 485, y: 206)

    static func main() {
        let arguments = CommandLine.arguments
        // `--preview <out.png> <app bundle>` draws the background with the
        // icons and their labels on top: what the window will look like, for
        // looking at while the art is being worked on, without mounting
        // anything or fighting Finder for the front of the screen.
        if arguments.count == 4, arguments[1] == "--preview" {
            previewApp = URL(fileURLWithPath: arguments[3])
            write(scale: 2, to: URL(fileURLWithPath: arguments[2]))
            return
        }
        guard arguments.count == 3 else {
            FileHandle.standardError.write(
                Data("usage: DMGBackground <1x.png> <2x.png> | --preview <out.png> <app>\n".utf8)
            )
            exit(2)
        }
        write(scale: 1, to: URL(fileURLWithPath: arguments[1]))
        write(scale: 2, to: URL(fileURLWithPath: arguments[2]))
    }

    /// Set only in preview mode. The disk image itself never draws icons: they
    /// are Finder's to place, and drawing them into the background would put a
    /// second, fixed copy behind the real ones.
    static var previewApp: URL?

    private static func write(scale: CGFloat, to url: URL) {
        let pixels = NSSize(width: size.width * scale, height: size.height * scale)
        guard let representation = NSBitmapImageRep(
            bitmapDataPlanes: nil,
            pixelsWide: Int(pixels.width),
            pixelsHigh: Int(pixels.height),
            bitsPerSample: 8,
            samplesPerPixel: 4,
            hasAlpha: true,
            isPlanar: false,
            colorSpaceName: .calibratedRGB,
            bytesPerRow: 0,
            bitsPerPixel: 0
        ) else { exit(1) }
        representation.size = size

        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: representation)
        draw()
        NSGraphicsContext.current?.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()

        guard let data = representation.representation(using: .png, properties: [:]) else { exit(1) }
        do { try data.write(to: url) } catch { exit(1) }
    }
}

// MARK: - The picture

extension DMGBackground {
    /// Finder measures from the top left and AppKit draws from the bottom, so
    /// every position in this file is quoted the way Finder quotes it and
    /// converted once, here.
    static func flip(_ point: NSPoint) -> NSPoint {
        NSPoint(x: point.x, y: size.height - point.y)
    }

    static func draw() {
        let frame = NSRect(origin: .zero, size: size)

        // The ground: the app's own screen colour, lifted a little at the top
        // so the window has a direction and does not read as a flat swatch.
        NSGradient(colors: [Ink.groundTop, Ink.groundBottom])?.draw(in: frame, angle: -90)

        // A soft violet cast under the app icon, and nothing under
        // Applications. The eye starts where the light is, which is the icon
        // that has to be picked up.
        glow(at: flip(NSPoint(x: appIcon.x, y: appIcon.y + 12)), radius: 220, color: Ink.accent, alpha: 0.10)

        header()
        headline()
        wells()
        arrow()
        footnote()
        if previewApp != nil { previewIcons() }
    }

    /// The radial wash behind the app icon. Drawn as a gradient to clear
    /// rather than a blurred shape, because a shadow here would have an edge
    /// and an edge would read as a box nobody put there.
    static func glow(at centre: NSPoint, radius: CGFloat, color: NSColor, alpha: CGFloat) {
        let gradient = NSGradient(
            colors: [
                color.withAlphaComponent(alpha),
                color.withAlphaComponent(alpha * 0.35),
                color.withAlphaComponent(0),
            ],
            atLocations: [0, 0.45, 1],
            colorSpace: .sRGB
        )
        gradient?.draw(
            fromCenter: centre, radius: 0,
            toCenter: centre, radius: radius,
            options: []
        )
    }

    /// The mark and the word, top left, at the size a title bar would use.
    static func header() {
        let markHeight: CGFloat = 26
        let markWidth: CGFloat = markHeight * 1.7
        let origin = flip(NSPoint(x: 40, y: 46))
        let box = NSRect(x: origin.x, y: origin.y - markHeight, width: markWidth, height: markHeight)

        wave(in: box)

        draw(
            "VIBEWIRE",
            at: NSPoint(x: box.maxX + 14, y: box.minY + 4),
            font: .systemFont(ofSize: 13, weight: .semibold),
            color: Ink.text,
            kern: 3.4
        )
    }

    /// The mark, stroked with the gradient the app icon carries: cyan at the
    /// first crest running to green at the flat tail.
    ///
    /// Stroked by clipping to the outline of the path rather than by stroking
    /// in a flat colour, because a gradient along a stroke is not something
    /// `NSBezierPath` will do and the alternative was a flat mark that does
    /// not match the icon sitting two inches below it.
    static func wave(in box: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let lineWidth = max(2.4, box.height * 0.17)
        // A stroke is centred on its path, so the box gives up half a line
        // width on every side or the crests come out shaved flat.
        let inner = box.insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
        let outline = WaveMark.path(in: inner).cgPath.copy(
            strokingWithWidth: lineWidth,
            lineCap: .round,
            lineJoin: .round,
            miterLimit: 10
        )

        context.saveGState()
        context.addPath(outline)
        context.clip()
        NSGradient(
            colors: [
                // The icon's cyan and green, taken a step darker: the icon
                // carries them on a black tile and this carries them on white.
                NSColor(srgbRed: 0x2A / 255, green: 0x9A / 255, blue: 0xC4 / 255, alpha: 1),
                NSColor(srgbRed: 0x1F / 255, green: 0xA8 / 255, blue: 0x7C / 255, alpha: 1),
            ]
        )?.draw(in: box, angle: 0)
        context.restoreGState()
    }

    /// What to do, said once, in the one place a reader is already looking.
    static func headline() {
        let text = "Drag VibeWire onto Applications"
        let font = NSFont.systemFont(ofSize: 21, weight: .semibold)
        let width = measure(text, font: font, kern: 0).width
        draw(
            text,
            at: NSPoint(x: (size.width - width) / 2, y: flip(NSPoint(x: 0, y: 118)).y),
            font: font,
            color: Ink.text,
            kern: 0
        )
    }

    /// A seat under each icon, so the two slots read as a pair with a
    /// direction rather than as two loose files.
    static func wells() {
        for (point, lit) in [(appIcon, true), (applicationsIcon, false)] {
            // Shifted down and taller than it is wide: Finder draws the icon
            // at the point and its label underneath, and a square well cut the
            // label in half along its bottom edge.
            let centre = flip(NSPoint(x: point.x, y: point.y + 18))
            let width: CGFloat = 138
            let height: CGFloat = 172
            let rect = NSRect(
                x: centre.x - width / 2,
                y: centre.y - height / 2,
                width: width,
                height: height
            )
            let path = NSBezierPath(roundedRect: rect, xRadius: 28, yRadius: 28)

            // A card, so the label Finder draws under the icon lands on white
            // whatever the ground is doing, and so the two slots read as one
            // pair with a direction.
            NSGraphicsContext.saveGraphicsState()
            let shadow = NSShadow()
            shadow.shadowColor = NSColor.black.withAlphaComponent(lit ? 0.16 : 0.10)
            shadow.shadowBlurRadius = lit ? 22 : 16
            shadow.shadowOffset = NSSize(width: 0, height: -4)
            shadow.set()
            Ink.card.setFill()
            path.fill()
            NSGraphicsContext.restoreGraphicsState()

            (lit ? Ink.accent.withAlphaComponent(0.55) : Ink.cardEdge).setStroke()
            path.lineWidth = lit ? 1.5 : 1
            path.stroke()
        }
    }

    /// Three chevrons pointing the way, brightening towards the destination.
    ///
    /// Not one long arrow: a single stroke between two icons gets covered by
    /// the icon being dragged over it, and what is left looks like a stray
    /// line. Three marks survive having one of them obscured.
    static func arrow() {
        let from = flip(appIcon)
        let to = flip(applicationsIcon)
        let y = from.y
        let start = from.x + 86
        let end = to.x - 86
        let step = (end - start) / 3

        for index in 0..<3 {
            let x = start + step * CGFloat(index) + step / 2
            let path = NSBezierPath()
            path.move(to: NSPoint(x: x - 7, y: y + 11))
            path.line(to: NSPoint(x: x + 7, y: y))
            path.line(to: NSPoint(x: x - 7, y: y - 11))
            path.lineWidth = 3
            path.lineCapStyle = .round
            path.lineJoinStyle = .round
            Ink.accent.withAlphaComponent(0.35 + 0.21 * CGFloat(index)).setStroke()
            path.stroke()
        }
    }

    /// The two facts worth having before the app is opened, and the one thing
    /// that will otherwise look like a failure on first launch.
    static func footnote() {
        let lines = [
            "macOS 14 or later · Apple silicon and Intel",
            "Not notarized: first launch needs System Settings, Privacy & Security, Open Anyway",
        ]
        let font = NSFont.systemFont(ofSize: 11, weight: .regular)
        for (index, line) in lines.enumerated() {
            let width = measure(line, font: font, kern: 0.2).width
            draw(
                line,
                at: NSPoint(
                    // Centred on the window, and low enough to clear the label
                    // Finder draws under the file in the corner above.
                    x: (size.width - width) / 2,
                    y: flip(NSPoint(x: 0, y: 472 + CGFloat(index) * 17)).y
                ),
                font: font,
                color: index == 0 ? Ink.textSecondary : Ink.textTertiary,
                kern: 0.2
            )
        }
    }
}

// MARK: - Text

extension DMGBackground {
    static func attributes(font: NSFont, color: NSColor, kern: CGFloat) -> [NSAttributedString.Key: Any] {
        [.font: font, .foregroundColor: color, .kern: kern]
    }

    static func measure(_ text: String, font: NSFont, kern: CGFloat) -> NSSize {
        NSAttributedString(
            string: text,
            attributes: attributes(font: font, color: .white, kern: kern)
        ).size()
    }

    static func draw(
        _ text: String,
        at point: NSPoint,
        font: NSFont,
        color: NSColor,
        kern: CGFloat
    ) {
        NSAttributedString(
            string: text,
            attributes: attributes(font: font, color: color, kern: kern)
        ).draw(at: point)
    }
}

// MARK: - Preview

extension DMGBackground {
    /// Draws what Finder will draw on top of this picture: the three icons at
    /// the positions `dmg-settings.py` gives it, each with the label Finder
    /// writes underneath.
    ///
    /// An approximation on one point only, and it is the point that matters:
    /// the label colour is the reader's system appearance, and this draws the
    /// Light Mode one, because that is the case the artwork has to survive.
    static func previewIcons() {
        guard let app = previewApp else { return }
        let workspace = NSWorkspace.shared

        icon(workspace.icon(forFile: app.path), at: appIcon, label: "VibeWire")
        icon(workspace.icon(forFile: "/Applications"), at: applicationsIcon, label: "Applications")
        icon(
            workspace.icon(forFileType: "public.plain-text"),
            at: notesIcon,
            label: "Start here.txt"
        )
    }

    static func icon(_ image: NSImage, at point: NSPoint, label: String) {
        let side: CGFloat = 96
        let centre = flip(point)
        image.draw(in: NSRect(
            x: centre.x - side / 2,
            y: centre.y - side / 2,
            width: side,
            height: side
        ))

        // Finder's own icon-view label: centred under the icon, at the text
        // size the settings file asks for, in the appearance's label colour.
        let font = NSFont.systemFont(ofSize: 13)
        let width = measure(label, font: font, kern: 0).width
        draw(
            label,
            at: NSPoint(x: centre.x - width / 2, y: centre.y - side / 2 - 19),
            font: font,
            color: NSColor(srgbRed: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1),
            kern: 0
        )
    }
}
