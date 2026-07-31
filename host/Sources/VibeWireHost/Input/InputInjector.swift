import Foundation
import CoreGraphics
import AppKit
import Carbon.HIToolbox

/// Turns phone gestures into real macOS events.
///
/// The trackpad model matters: the phone sends *relative* deltas, not absolute
/// coordinates. That is what makes the whole glass usable as a pad — including
/// the letterbox bands outside the picture — which is the point of the dashed
/// TRACKPAD rectangle on 03A.
///
/// Requires Accessibility permission. Without it CGEvent posts are silently
/// swallowed, so the host checks and surfaces that state rather than looking
/// broken.
final class InputInjector: @unchecked Sendable {
    private let lock = NSLock()

    /// Absolute cursor position we maintain ourselves. Reading it back from the
    /// system every event would fight with any physical mouse movement and
    /// makes drags jittery.
    private var cursor: CGPoint = .zero
    private var activeDisplay: CGDirectDisplayID = CGMainDisplayID()
    private var latchedModifiers: Set<ModifierKey> = []
    private var isDragging = false
    /// The click count the current drag went down with — 1 for an ordinary drag,
    /// 2 when the phone double-tapped and then held. Every event of that drag has
    /// to carry the same number: AppKit reads the count off the event, so a
    /// `down(2)` followed by `dragged(1)` is a double-click that immediately stops
    /// being one, and the word it just selected is dropped on the first move.
    private var dragClickCount = 1
    private var sensitivity: Int = 5
    private var naturalScrolling = true
    private var scrollAccumulator: (x: Double, y: Double) = (0, 0)

    init() {
        cursor = Self.currentCursorPosition()
    }

    // MARK: Permission

    static func hasAccessibilityPermission() -> Bool {
        AXIsProcessTrusted()
    }

    static func requestAccessibilityPermission() {
        // The imported `kAXTrustedCheckOptionPrompt` is a mutable global and
        // therefore not concurrency-safe; the key string itself is stable API.
        let options = ["AXTrustedCheckOptionPrompt": true]
        _ = AXIsProcessTrustedWithOptions(options as CFDictionary)
    }

    // MARK: Settings

    func update(sensitivity: Int?, naturalScrolling: Bool?) {
        lock.lock(); defer { lock.unlock() }
        if let sensitivity { self.sensitivity = max(1, min(8, sensitivity)) }
        if let naturalScrolling { self.naturalScrolling = naturalScrolling }
    }

    /// 07A says "1080PX / SWIPE" at tick 5. The curve is linear in the tick so
    /// the readout stays honest and predictable.
    private func gain() -> Double {
        0.6 + Double(sensitivity - 1) * 0.35
    }

    // MARK: Pointer

    func movePointer(dx: Double, dy: Double, display: CGDirectDisplayID?) {
        lock.lock()
        if let display { activeDisplay = display }
        let scale = gain()
        var next = CGPoint(x: cursor.x + dx * scale, y: cursor.y + dy * scale)
        next = Self.clamp(next, to: activeDisplay)
        cursor = next
        let dragging = isDragging
        let count = dragClickCount
        let modifiers = latchedModifiers
        lock.unlock()

        let type: CGEventType = dragging ? .leftMouseDragged : .mouseMoved
        post(mouse: type, at: next, button: .left, clickCount: dragging ? count : 0, modifiers: modifiers)
    }

    func click(button: MouseButton, count: Int, display: CGDirectDisplayID?) {
        lock.lock()
        if let display { activeDisplay = display }
        let point = cursor
        let modifiers = latchedModifiers
        lock.unlock()

        let (down, up, cgButton): (CGEventType, CGEventType, CGMouseButton)
        switch button {
        case .left: (down, up, cgButton) = (.leftMouseDown, .leftMouseUp, .left)
        case .right: (down, up, cgButton) = (.rightMouseDown, .rightMouseUp, .right)
        case .middle: (down, up, cgButton) = (.otherMouseDown, .otherMouseUp, .center)
        }

        // Double-click has to arrive as two down/up pairs with an increasing
        // click count, otherwise AppKit reads it as two separate clicks.
        for index in 1...max(1, count) {
            post(mouse: down, at: point, button: cgButton, clickCount: index, modifiers: modifiers)
            post(mouse: up, at: point, button: cgButton, clickCount: index, modifiers: modifiers)
        }
    }

    /// `count` is the click the button goes down on: 1 is a press-and-drag, 2 is a
    /// double-click that never let go — the gesture that selects a word and then
    /// stretches the selection, or picks up the thing the second click chose.
    func drag(phase: GesturePhase, dx: Double, dy: Double, count: Int = 1) {
        switch phase {
        case .begin:
            lock.lock()
            isDragging = true
            dragClickCount = max(1, min(3, count))
            let clicks = dragClickCount
            let point = cursor
            let modifiers = latchedModifiers
            lock.unlock()
            post(mouse: .leftMouseDown, at: point, button: .left, clickCount: clicks, modifiers: modifiers)

        case .move:
            movePointer(dx: dx, dy: dy, display: nil)

        case .end:
            lock.lock()
            isDragging = false
            let clicks = dragClickCount
            dragClickCount = 1
            let point = cursor
            let modifiers = latchedModifiers
            lock.unlock()
            post(mouse: .leftMouseUp, at: point, button: .left, clickCount: clicks, modifiers: modifiers)
        }
    }

    // MARK: Scroll

    func scroll(dx: Double, dy: Double, momentum: Bool) {
        lock.lock()
        let natural = naturalScrolling
        // Accumulate sub-pixel deltas so slow two-finger drags still move.
        scrollAccumulator.x += dx
        scrollAccumulator.y += dy
        let stepX = Int32(scrollAccumulator.x)
        let stepY = Int32(scrollAccumulator.y)
        scrollAccumulator.x -= Double(stepX)
        scrollAccumulator.y -= Double(stepY)
        let modifiers = latchedModifiers
        lock.unlock()

        guard stepX != 0 || stepY != 0 else { return }

        let sign: Int32 = natural ? 1 : -1
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .pixel,
            wheelCount: 2,
            wheel1: stepY * sign,
            wheel2: stepX * sign,
            wheel3: 0
        ) else { return }

        event.flags = Self.flags(for: modifiers)
        if momentum {
            event.setIntegerValueField(.scrollWheelEventMomentumPhase, value: 1)
        }
        event.post(tap: .cghidEventTap)
    }

    /// Pinch on the phone maps to ⌘+scroll, which is what most Mac apps treat
    /// as zoom. A true magnification gesture event exists but is only honoured
    /// by a subset of apps, so this is the more reliable mapping.
    func zoom(scale: Double, locked: Bool) {
        let steps = Int32((scale - 1.0) * 10)
        guard steps != 0 else { return }
        guard let event = CGEvent(
            scrollWheelEvent2Source: nil,
            units: .line,
            wheelCount: 1,
            wheel1: steps,
            wheel2: 0,
            wheel3: 0
        ) else { return }
        event.flags = .maskCommand
        event.post(tap: .cghidEventTap)
    }

    // MARK: Modifiers

    /// Latched modifiers survive taps, drags and the keyboard — that is the
    /// whole point of 04B: a two-hand chord becomes two one-hand taps.
    func setModifiers(_ held: Set<ModifierKey>) {
        lock.lock()
        let previous = latchedModifiers
        latchedModifiers = held
        lock.unlock()

        // Emit real flagsChanged events so apps that watch modifier state
        // (rather than reading flags off each event) stay in sync.
        for modifier in ModifierKey.allCases {
            let wasHeld = previous.contains(modifier)
            let isHeld = held.contains(modifier)
            guard wasHeld != isHeld else { continue }
            guard let keyCode = Self.modifierKeyCode(modifier) else { continue }
            guard let event = CGEvent(
                keyboardEventSource: nil,
                virtualKey: keyCode,
                keyDown: isHeld
            ) else { continue }
            event.type = .flagsChanged
            event.flags = Self.flags(for: held)
            event.post(tap: .cghidEventTap)
        }
    }

    func releaseAllModifiers() {
        setModifiers([])
    }

    var heldModifiers: Set<ModifierKey> {
        lock.lock(); defer { lock.unlock() }
        return latchedModifiers
    }

    // MARK: Keys

    func key(code: String, chars: String?, down: Bool) {
        lock.lock()
        let modifiers = latchedModifiers
        lock.unlock()

        if let keyCode = KeyMap.virtualKey(for: code) {
            postKey(keyCode, down: down, modifiers: modifiers)
            return
        }

        // Anything without a virtual key (emoji, accented text from the system
        // keyboard) goes through as a unicode payload.
        if down, let chars, !chars.isEmpty {
            type(text: chars)
        }
    }

    /// A tap of ⌘ then S sends ⌘S and unlatches — the behaviour described on
    /// the 05 detail panel.
    func combo(keys: [String]) {
        let modifierNames = keys.compactMap { ModifierKey(rawValue: KeyMap.normalizeModifier($0)) }
        let plainKeys = keys.filter { ModifierKey(rawValue: KeyMap.normalizeModifier($0)) == nil }
        let modifiers = Set(modifierNames)

        guard let last = plainKeys.last, let keyCode = KeyMap.virtualKey(for: last) else {
            setModifiers(modifiers)
            return
        }

        let flags = Self.flags(for: modifiers)
        if let down = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: true) {
            down.flags = flags
            down.post(tap: .cghidEventTap)
        }
        if let up = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: false) {
            up.flags = flags
            up.post(tap: .cghidEventTap)
        }
    }

    /// Batched text from the system keyboard. Sent as unicode rather than
    /// synthesised key codes so autocorrect, emoji, and non-Latin input work.
    func type(text: String) {
        let scalars = Array(text.utf16)
        // CGEvent takes a bounded buffer; chunk long paste-like input.
        let chunkSize = 20
        var index = 0
        while index < scalars.count {
            let end = min(index + chunkSize, scalars.count)
            var chunk = Array(scalars[index..<end])
            guard let event = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true) else { return }
            event.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
            event.post(tap: .cghidEventTap)

            if let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false) {
                up.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
                up.post(tap: .cghidEventTap)
            }
            index = end
        }
    }

    // MARK: Cursor reporting

    func cursorPosition() -> (point: CGPoint, display: CGDirectDisplayID) {
        lock.lock(); defer { lock.unlock() }
        return (cursor, activeDisplay)
    }

    /// Called when the client selects a display, so the pointer arrives where the
    /// user is about to be looking.
    ///
    /// This used to recentre only when the cursor had ended up outside the new
    /// display's bounds, which made the landing spot depend on where the pointer
    /// happened to be: switch away and back, and it was wherever you left it.
    /// From a phone that is the wrong trade. There is no second cursor to glance
    /// at and no screen edge to feel for, so the first swipe after a switch has to
    /// start somewhere known — and the centre is the only point on a display that
    /// needs no explanation. Re-selecting the display already being driven leaves
    /// the cursor alone, because that is not a switch.
    func focus(display: CGDirectDisplayID) {
        lock.lock()
        let changed = activeDisplay != display
        activeDisplay = display
        let bounds = CGDisplayBounds(display)
        if changed || !bounds.contains(cursor) {
            cursor = CGPoint(x: bounds.midX, y: bounds.midY)
        }
        let point = cursor
        lock.unlock()
        post(mouse: .mouseMoved, at: point, button: .left, clickCount: 0, modifiers: [])
    }

    // MARK: Plumbing

    private func postKey(_ keyCode: CGKeyCode, down: Bool, modifiers: Set<ModifierKey>) {
        guard let event = CGEvent(keyboardEventSource: nil, virtualKey: keyCode, keyDown: down) else { return }
        event.flags = Self.flags(for: modifiers)
        event.post(tap: .cghidEventTap)
    }

    private func post(
        mouse type: CGEventType,
        at point: CGPoint,
        button: CGMouseButton,
        clickCount: Int,
        modifiers: Set<ModifierKey>
    ) {
        guard let event = CGEvent(
            mouseEventSource: nil,
            mouseType: type,
            mouseCursorPosition: point,
            mouseButton: button
        ) else { return }
        if clickCount > 0 {
            event.setIntegerValueField(.mouseEventClickState, value: Int64(clickCount))
        }
        event.flags = Self.flags(for: modifiers)
        event.post(tap: .cghidEventTap)
    }

    private static func flags(for modifiers: Set<ModifierKey>) -> CGEventFlags {
        var flags: CGEventFlags = []
        if modifiers.contains(.cmd) { flags.insert(.maskCommand) }
        if modifiers.contains(.shift) { flags.insert(.maskShift) }
        if modifiers.contains(.option) { flags.insert(.maskAlternate) }
        if modifiers.contains(.control) { flags.insert(.maskControl) }
        if modifiers.contains(.fn) { flags.insert(.maskSecondaryFn) }
        if modifiers.contains(.capsLock) { flags.insert(.maskAlphaShift) }
        return flags
    }

    private static func modifierKeyCode(_ modifier: ModifierKey) -> CGKeyCode? {
        switch modifier {
        case .cmd: return CGKeyCode(kVK_Command)
        case .shift: return CGKeyCode(kVK_Shift)
        case .option: return CGKeyCode(kVK_Option)
        case .control: return CGKeyCode(kVK_Control)
        case .capsLock: return CGKeyCode(kVK_CapsLock)
        case .fn: return CGKeyCode(kVK_Function)
        }
    }

    private static func currentCursorPosition() -> CGPoint {
        guard let event = CGEvent(source: nil) else {
            let bounds = CGDisplayBounds(CGMainDisplayID())
            return CGPoint(x: bounds.midX, y: bounds.midY)
        }
        return event.location
    }

    /// Keeps the pointer on the display the phone is driving. Without this a
    /// fast swipe walks off onto a second monitor the user cannot see.
    private static func clamp(_ point: CGPoint, to display: CGDirectDisplayID) -> CGPoint {
        let bounds = CGDisplayBounds(display)
        return CGPoint(
            x: min(max(point.x, bounds.minX), bounds.maxX - 1),
            y: min(max(point.y, bounds.minY), bounds.maxY - 1)
        )
    }
}
