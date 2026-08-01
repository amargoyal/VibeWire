import AppKit

/// Everything inside the status panel, drawn.
///
/// Laid out top-down in a flipped view, because the panel is a stack of blocks
/// read from the top and AppKit's bottom-left origin would put the arithmetic in
/// the way of that. `cursor` is the y the next block starts at.
@MainActor
final class PanelContent: FlippedView {
    /// One column: the panel is a fixed width and everything inside it is
    /// measured from these two, so there is no second place to change a margin.
    private static let width: CGFloat = 300
    private static let margin: CGFloat = 16
    private static var column: CGFloat { width - margin * 2 }

    private let readings: StatusPanel.Readings
    private let send: (StatusPanel.Action) -> Void

    init(readings: StatusPanel.Readings, send: @escaping (StatusPanel.Action) -> Void) {
        self.readings = readings
        self.send = send
        super.init(frame: NSRect(x: 0, y: 0, width: Self.width, height: 10))

        var cursor: CGFloat = 14
        cursor = addHeader(at: cursor)
        cursor = addDivider(at: cursor + 12)
        cursor = addTiles(at: cursor + 12)
        cursor = addLink(at: cursor + 14)

        if readings.degraded {
            cursor = addDivider(at: cursor + 14)
            cursor = addPermissions(at: cursor + 8)
            cursor += 8
        } else {
            cursor += 14
        }

        cursor = addDivider(at: cursor)
        cursor = addActions(at: cursor + 6)
        cursor = addDivider(at: cursor + 6)
        cursor = addQuit(at: cursor + 6)

        setFrameSize(NSSize(width: Self.width, height: cursor + 8))
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    /// The three shortcuts the rows advertise.
    ///
    /// A panel is not a menu and gets none of this for free, so it is written
    /// out here — and it has to be, because a row that prints ⌘D beside itself
    /// and does nothing when ⌘D is pressed is the interface telling a lie it
    /// could have simply not told.
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        guard event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
              let key = event.charactersIgnoringModifiers?.lowercased()
        else { return false }

        switch key {
        case "d": send(.openDashboard)
        case "p": send(.pair)
        case "q": send(.quit)
        default: return false
        }
        return true
    }

    // MARK: Header

    /// The machine, its condition, and how long it has held it.
    private func addHeader(at top: CGFloat) -> CGFloat {
        let (word, colour) = state()
        let chip = Self.chip(word: word, colour: colour)
        chip.setFrameOrigin(NSPoint(x: Self.width - Self.margin - chip.frame.width, y: top))
        addSubview(chip)

        let name = Self.label(
            readings.machine,
            font: .systemFont(ofSize: 15, weight: .semibold),
            colour: Palette.text
        )
        name.lineBreakMode = .byTruncatingTail
        name.frame = NSRect(
            x: Self.margin,
            y: top + 2,
            width: Self.column - chip.frame.width - 10,
            height: 19
        )
        addSubview(name)

        // The version and the uptime, in the size this system reserves for a
        // footnote repeating what is already stated above — neither is news, and
        // both are what someone reaches for when the answer above surprises them.
        let sub = Self.label(
            "VIBEWIRE \(Config.hostVersion) · UP \(Self.duration(readings.uptime))",
            font: .monospacedSystemFont(ofSize: 9, weight: .regular),
            colour: Palette.textTertiary
        )
        sub.frame = NSRect(x: Self.margin, y: top + 25, width: Self.column, height: 12)
        addSubview(sub)

        return top + 39
    }

    /// Three states, not two. A host that is serving with no Screen Recording
    /// grant sends a black picture, and one with no Accessibility grant ignores
    /// every tap. Both are running, and neither is SERVING — saying so here is
    /// what lets the grant rows below exist only when there is something to fix.
    private func state() -> (String, NSColor) {
        if readings.degraded { return ("DEGRADED", Palette.amber) }
        if readings.serving { return ("SERVING", Palette.green) }
        return ("STARTING", Palette.textTertiary)
    }

    // MARK: The three readings

    /// The machine, whether anything is attached, and which path it is on — the
    /// three values that come before any action, because the reason to open this
    /// is almost always to check whether the Mac is still serving.
    private func addTiles(at top: CGFloat) -> CGFloat {
        // An unmeasured value and a measured zero are different facts, and the
        // interface is not allowed to blur them.
        let values: [(String, String)] = [
            ("CLIENT", readings.serving ? (readings.clientAttached ? "1" : "0") : "—"),
            ("SCREENS", readings.serving ? "\(readings.streams)" : "—"),
            ("PATH", readings.path),
        ]

        let gap: CGFloat = 6
        let tileWidth = ((Self.column - gap * CGFloat(values.count - 1)) / CGFloat(values.count))
            .rounded(.down)

        for (index, value) in values.enumerated() {
            // Flipped like its parent. A plain `NSView` placed inside a flipped
            // one is positioned from the top but still lays *its own* children
            // out from the bottom, which put every tile's caption under its
            // reading instead of over it.
            let tile = FlippedView(frame: NSRect(
                x: Self.margin + CGFloat(index) * (tileWidth + gap),
                y: top,
                width: tileWidth,
                height: 46
            ))
            tile.fill(Palette.raised, radius: Palette.Radius.inner)

            let label = Self.label(
                value.0,
                font: .monospacedSystemFont(ofSize: 9, weight: .regular),
                colour: Palette.textTertiary
            )
            label.frame = NSRect(x: 10, y: 8, width: tileWidth - 16, height: 12)
            tile.addSubview(label)

            let reading = Self.label(
                value.1,
                font: .monospacedSystemFont(ofSize: value.1.count > 3 ? 11 : 14, weight: .regular),
                colour: value.1 == "—" ? Palette.textTertiary : Palette.text
            )
            reading.frame = NSRect(x: 10, y: 22, width: tileWidth - 16, height: 18)
            tile.addSubview(reading)

            addSubview(tile)
        }

        return top + 46
    }

    // MARK: Link

    /// What the phone on the other end measured, or dashes.
    ///
    /// Round trip is the phone's report of a round trip it took, so with nothing
    /// attached there is no number here at all — not a healthy zero, which is the
    /// one reading a link pane must never invent.
    private func addLink(at top: CGFloat) -> CGFloat {
        let heading = Self.label(
            readings.clientAttached ? "LINK · \(readings.attachedName ?? "ATTACHED")".uppercased() : "LINK",
            font: .monospacedSystemFont(ofSize: 9, weight: .regular),
            colour: Palette.textTertiary
        )
        heading.lineBreakMode = .byTruncatingTail
        heading.frame = NSRect(x: Self.margin, y: top, width: Self.column, height: 12)
        addSubview(heading)

        let rtt = readings.rttMillis.map { "\(Int($0.rounded())) MS" } ?? "— MS"
        let value = Self.label(
            rtt,
            font: .monospacedSystemFont(ofSize: 20, weight: .regular),
            colour: readings.rttMillis == nil ? Palette.textTertiary : Palette.text
        )
        value.frame = NSRect(x: Self.margin, y: top + 16, width: 120, height: 24)
        addSubview(value)

        // The shape of the last minute beside the number for right now. One
        // sample is a dot and no line, which is honest: a sparkline drawn from a
        // single reading would draw a trend nobody measured.
        let spark = Sparkline(history: readings.rttHistory)
        spark.frame = NSRect(x: Self.width - Self.margin - 96, y: top + 18, width: 96, height: 20)
        addSubview(spark)

        // Throughput gets a bar only when there is a real denominator to draw it
        // against. Off the cap there is no ceiling this host agreed to, and a bar
        // against a number nobody set would be a picture of nothing.
        let out = String(format: "%.1f", readings.outMbps)
        let caption: String
        if let ceiling = readings.ceilingMbps {
            caption = "\(out) OF \(String(format: "%.1f", ceiling)) MB/S"
            let meter = Meter(fraction: ceiling > 0 ? readings.outMbps / ceiling : 0)
            meter.frame = NSRect(x: Self.margin, y: top + 46, width: Self.column, height: 4)
            addSubview(meter)
        } else {
            caption = "\(out) MB/S OUT · NO CAP"
        }

        let sub = Self.label(
            readings.clientAttached ? caption : "NOTHING ATTACHED",
            font: .monospacedSystemFont(ofSize: 9, weight: .regular),
            colour: Palette.textTertiary
        )
        sub.frame = NSRect(
            x: Self.margin,
            y: top + (readings.ceilingMbps == nil ? 44 : 56),
            width: Self.column,
            height: 12
        )
        addSubview(sub)

        return top + (readings.ceilingMbps == nil ? 56 : 68)
    }

    // MARK: Permissions

    /// Only what is missing. Two permanent "granted" rows that no click could
    /// ever change were most of what the old menu showed, and they pushed the one
    /// row that ever needs acting on down among them.
    private func addPermissions(at top: CGFloat) -> CGFloat {
        var cursor = top
        if !readings.screenRecording {
            cursor = addRow(
                at: cursor,
                symbol: "exclamationmark.triangle.fill",
                title: "Grant Screen Recording",
                tint: Palette.amber,
                action: .grantScreenRecording
            )
        }
        if !readings.accessibility {
            cursor = addRow(
                at: cursor,
                symbol: "exclamationmark.triangle.fill",
                title: "Grant Accessibility",
                tint: Palette.amber,
                action: .grantAccessibility
            )
        }
        return cursor
    }

    // MARK: Actions

    private func addActions(at top: CGFloat) -> CGFloat {
        var cursor = addRow(
            at: top,
            symbol: "macwindow",
            title: "Open VibeWire",
            shortcut: "⌘D",
            action: .openDashboard
        )
        cursor = addRow(
            at: cursor,
            symbol: "qrcode",
            title: "Pair a device",
            shortcut: "⌘P",
            action: .pair
        )
        cursor = addRow(
            at: cursor,
            symbol: "iphone",
            title: "Paired devices",
            // A count the keychain has not answered for yet is a dash, the same
            // as every other unread value on this panel.
            shortcut: readings.pairedCount.map(String.init) ?? "—",
            action: .openPane("devices")
        )
        return cursor
    }

    private func addQuit(at top: CGFloat) -> CGFloat {
        addRow(at: top, symbol: "power", title: "Quit VibeWire", shortcut: "⌘Q", tint: Palette.red, action: .quit)
    }

    @discardableResult
    private func addRow(
        at top: CGFloat,
        symbol: String,
        title: String,
        shortcut: String? = nil,
        tint: NSColor? = nil,
        action: StatusPanel.Action
    ) -> CGFloat {
        let row = PanelRow(
            frame: NSRect(x: 6, y: top, width: Self.width - 12, height: 32),
            symbol: symbol,
            title: title,
            shortcut: shortcut,
            tint: tint
        ) { [send] in send(action) }
        addSubview(row)
        return top + 32
    }

    // MARK: Parts

    @discardableResult
    private func addDivider(at top: CGFloat) -> CGFloat {
        let line = NSView(frame: NSRect(x: Self.margin, y: top, width: Self.column, height: 1))
        line.wantsLayer = true
        line.layer?.backgroundColor = Palette.hairline.cgColor
        addSubview(line)
        return top + 1
    }

    private static func chip(word: String, colour: NSColor) -> NSView {
        let font = NSFont.monospacedSystemFont(ofSize: 9, weight: .medium)
        // Sized to the longest of the three words, so the chip holds still when
        // the state changes rather than resizing under a reader's eye.
        let wordWidth = ("STARTING" as NSString).size(withAttributes: [.font: font]).width.rounded(.up)
        let height: CGFloat = 22
        let chip = NSView(frame: NSRect(x: 0, y: 0, width: 10 + 6 + 6 + wordWidth + 10, height: height))
        // CALayer clamps `cornerRadius` to half the shorter side, so a 22pt chip
        // asking for the control corner would come back a capsule — and a capsule
        // in this system marks something transient, which a standing condition is
        // not. `small` is under the clamp.
        chip.fill(colour.withAlphaComponent(0.14), radius: Palette.Radius.small)

        let dot = NSView(frame: NSRect(x: 10, y: (height - 6) / 2, width: 6, height: 6))
        dot.fill(colour, radius: 3)
        chip.addSubview(dot)

        let text = label(word, font: font, colour: colour)
        text.frame = NSRect(x: 22, y: (height - 12) / 2 - 1, width: wordWidth + 2, height: 13)
        chip.addSubview(text)
        return chip
    }

    private static func label(_ string: String, font: NSFont, colour: NSColor) -> NSTextField {
        let field = NSTextField(labelWithString: string)
        field.font = font
        field.textColor = colour
        return field
    }

    /// `6D 04H`, `2H 14M`, `58M`. Two units at most: the third is never the one
    /// anybody was asking about.
    static func duration(_ interval: TimeInterval) -> String {
        let total = Int(max(0, interval))
        let days = total / 86_400
        let hours = (total % 86_400) / 3600
        let minutes = (total % 3600) / 60
        if days > 0 { return "\(days)D \(String(format: "%02d", hours))H" }
        if hours > 0 { return "\(hours)H \(String(format: "%02d", minutes))M" }
        return "\(minutes)M"
    }
}

/// A flipped container, so a stack read from the top is laid out from the top.
@MainActor
class FlippedView: NSView {
    override var isFlipped: Bool { true }
}

/// One clickable line: glyph, title, and whatever sits on the right.
///
/// A row rather than an `NSMenuItem`, so the whole of it can take a tint — the
/// quit row is clay ink on a clay wash and not black text on the system's blue,
/// and a missing permission is amber all the way across.
@MainActor
final class PanelRow: FlippedView {
    private let perform: () -> Void
    private let tint: NSColor
    private let highlight = NSView()

    init(
        frame: NSRect,
        symbol: String,
        title: String,
        shortcut: String?,
        tint: NSColor?,
        perform: @escaping () -> Void
    ) {
        self.perform = perform
        self.tint = tint ?? Palette.text
        super.init(frame: frame)

        highlight.frame = bounds
        highlight.autoresizingMask = [.width, .height]
        highlight.fill(self.tint.withAlphaComponent(0.12), radius: Palette.Radius.small)
        highlight.isHidden = true
        addSubview(highlight)

        let configuration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
        let glyph = NSImageView(frame: NSRect(x: 10, y: (frame.height - 16) / 2, width: 16, height: 16))
        glyph.image = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?
            .withSymbolConfiguration(configuration)
        glyph.contentTintColor = self.tint
        addSubview(glyph)

        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13, weight: .regular)
        label.textColor = self.tint
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: 36, y: (frame.height - 17) / 2, width: frame.width - 36 - 46, height: 17)
        addSubview(label)

        if let shortcut {
            let hint = NSTextField(labelWithString: shortcut)
            hint.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
            hint.textColor = Palette.textTertiary
            hint.alignment = .right
            hint.frame = NSRect(x: frame.width - 46, y: (frame.height - 14) / 2, width: 36, height: 14)
            addSubview(hint)
        }

        // `.activeAlways` rather than `.activeInKeyWindow`: this app is an
        // accessory and the panel is non-activating, so the row has to light up
        // for a pointer that arrived without anyone clicking first.
        addTrackingArea(NSTrackingArea(
            rect: .zero,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self
        ))
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func mouseEntered(with event: NSEvent) { highlight.isHidden = false }
    override func mouseExited(with event: NSEvent) { highlight.isHidden = true }

    override func mouseUp(with event: NSEvent) {
        // Only a release that landed on the row it started on, which is what
        // lets a press that changed its mind be taken back by sliding off.
        guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
        perform()
    }
}

/// The last readings as a line, drawn against their own range.
///
/// Normalised to the window's own minimum and maximum rather than to a fixed
/// scale: the question this answers is "is it getting worse", and a 12–18 ms link
/// pinned flat against a 500 ms axis answers nothing.
@MainActor
final class Sparkline: NSView {
    private let history: [Double]

    init(history: [Double]) {
        self.history = history
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func draw(_ dirtyRect: NSRect) {
        let inset = bounds.insetBy(dx: 1, dy: 2)

        // Under two samples there is no shape to draw. A flat rule says so —
        // drawing a line through one reading would invent a trend.
        guard history.count >= 2 else {
            Palette.textDisabled.setStroke()
            let rule = NSBezierPath()
            rule.move(to: NSPoint(x: inset.minX, y: inset.midY))
            rule.line(to: NSPoint(x: inset.maxX, y: inset.midY))
            rule.lineWidth = 1
            rule.stroke()
            return
        }

        let low = history.min() ?? 0
        let high = history.max() ?? 1
        // A perfectly steady link has no range to divide by, and belongs on the
        // middle of the axis rather than at the bottom of it.
        let span = high - low
        let step = inset.width / CGFloat(history.count - 1)

        let path = NSBezierPath()
        for (index, value) in history.enumerated() {
            let fraction = span > 0 ? (value - low) / span : 0.5
            let point = NSPoint(
                x: inset.minX + CGFloat(index) * step,
                // Lower is better for a round trip, so the line rises as the
                // link improves and a reader's "up is good" instinct holds.
                y: inset.minY + CGFloat(1 - fraction) * inset.height
            )
            index == 0 ? path.move(to: point) : path.line(to: point)
        }
        path.lineWidth = 1.5
        path.lineJoinStyle = .round
        path.lineCapStyle = .round
        Palette.green.withAlphaComponent(0.85).setStroke()
        path.stroke()
    }
}

/// A filled bar against a stated ceiling. Amber past three quarters, clay at the
/// ceiling — the colours this system already uses for approaching and reaching a
/// limit, so the bar does not need a second label to be read.
@MainActor
final class Meter: NSView {
    private let fraction: Double

    init(fraction: Double) {
        self.fraction = min(1, max(0, fraction))
        super.init(frame: .zero)
    }

    required init?(coder: NSCoder) { fatalError("not from a nib") }

    override func draw(_ dirtyRect: NSRect) {
        let radius = bounds.height / 2
        NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).setClip()
        Palette.raised2.setFill()
        bounds.fill()

        guard fraction > 0 else { return }
        let colour: NSColor = fraction >= 0.99 ? Palette.red : fraction > 0.75 ? Palette.amber : Palette.green
        colour.setFill()
        NSRect(x: 0, y: 0, width: bounds.width * fraction, height: bounds.height).fill()
    }
}
