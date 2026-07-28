import Foundation
import CoreGraphics
import Carbon.HIToolbox

/// Maps the phone's key names to macOS virtual key codes.
///
/// The phone sends stable names ("escape", "tab", "arrowLeft", "a") rather than
/// raw codes, so the two sides stay decoupled from Apple's numbering and from
/// each other's keyboard layout assumptions.
enum KeyMap {
    private static let named: [String: Int] = [
        // Row one of screen 05: hardware the phone doesn't have.
        "escape": kVK_Escape,
        "esc": kVK_Escape,
        "tab": kVK_Tab,
        "return": kVK_Return,
        "enter": kVK_Return,
        "delete": kVK_Delete,
        "backspace": kVK_Delete,
        "forwardDelete": kVK_ForwardDelete,
        "space": kVK_Space,

        "arrowLeft": kVK_LeftArrow,
        "arrowRight": kVK_RightArrow,
        "arrowUp": kVK_UpArrow,
        "arrowDown": kVK_DownArrow,
        "left": kVK_LeftArrow,
        "right": kVK_RightArrow,
        "up": kVK_UpArrow,
        "down": kVK_DownArrow,

        "home": kVK_Home,
        "end": kVK_End,
        "pageUp": kVK_PageUp,
        "pageDown": kVK_PageDown,

        "f1": kVK_F1, "f2": kVK_F2, "f3": kVK_F3, "f4": kVK_F4,
        "f5": kVK_F5, "f6": kVK_F6, "f7": kVK_F7, "f8": kVK_F8,
        "f9": kVK_F9, "f10": kVK_F10, "f11": kVK_F11, "f12": kVK_F12,

        // Letters
        "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D,
        "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G, "h": kVK_ANSI_H,
        "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L,
        "m": kVK_ANSI_M, "n": kVK_ANSI_N, "o": kVK_ANSI_O, "p": kVK_ANSI_P,
        "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T,
        "u": kVK_ANSI_U, "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X,
        "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,

        // Digits
        "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3,
        "4": kVK_ANSI_4, "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7,
        "8": kVK_ANSI_8, "9": kVK_ANSI_9,

        // Punctuation that shows up in shortcuts
        "minus": kVK_ANSI_Minus,
        "equal": kVK_ANSI_Equal,
        "leftBracket": kVK_ANSI_LeftBracket,
        "rightBracket": kVK_ANSI_RightBracket,
        "backslash": kVK_ANSI_Backslash,
        "semicolon": kVK_ANSI_Semicolon,
        "quote": kVK_ANSI_Quote,
        "comma": kVK_ANSI_Comma,
        "period": kVK_ANSI_Period,
        "slash": kVK_ANSI_Slash,
        "grave": kVK_ANSI_Grave,
    ]

    static func virtualKey(for name: String) -> CGKeyCode? {
        if let code = named[name] { return CGKeyCode(code) }
        // Tolerate case differences from the phone.
        if let code = named[name.lowercased()] { return CGKeyCode(code) }
        // Single characters that are not in the table: let the caller fall back
        // to unicode injection instead of guessing a layout.
        return nil
    }

    /// The phone may send "⌘", "cmd", or "command"; normalise before matching.
    static func normalizeModifier(_ raw: String) -> String {
        switch raw.lowercased() {
        case "⌘", "cmd", "command", "meta": return "cmd"
        case "⇧", "shift": return "shift"
        case "⌥", "opt", "option", "alt": return "option"
        case "⌃", "ctrl", "control": return "control"
        case "fn", "function": return "fn"
        case "caps", "capslock": return "capsLock"
        default: return raw
        }
    }
}
