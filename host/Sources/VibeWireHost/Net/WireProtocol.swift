import Foundation

// MARK: - Envelope

/// Every control message is a JSON object with a `t` discriminator. Requests
/// that expect a reply carry `id`; the reply echoes it.
struct WireEnvelope: Decodable {
    let t: String
    let id: String?
}

// MARK: - Phone → host

enum InboundMessage {
    case selectDisplay(displayIds: [UInt32], sideBySide: Bool)
    case startStream(displayIds: [UInt32], maxHeight: Int?, targetFps: Int?)
    case stopStream
    case setQuality(ladder: HostSettings.QualityLadder, cellularCapMbps: Double?)
    case pointer(PointerEvent)
    case click(button: MouseButton, count: Int, display: UInt32?)
    case drag(phase: GesturePhase, dx: Double, dy: Double, count: Int)
    case scroll(dx: Double, dy: Double, momentum: Bool)
    case zoom(scale: Double, anchorX: Double, anchorY: Double, locked: Bool)
    case modifiers(held: Set<ModifierKey>, latched: Bool)
    case key(code: String, chars: String?, down: Bool)
    case combo(keys: [String])
    case text(String)
    case hubAction(HubAction)
    case clipboardPush(String)
    case wake
    case retry
    case lastFrame
    case claude(ClaudeInbound)
    case revoke(deviceId: String?, all: Bool)
    case setting(key: String, value: SettingValue)
    case ping(tMicros: UInt64, sequence: UInt64, rttMillis: Double?)
    /// The phone reporting its own radio, so the cellular cap can apply
    /// only when it is actually on cellular.
    case link(expensive: Bool, constrained: Bool)
}

enum MouseButton: String, Codable { case left, right, middle }
enum GesturePhase: String, Codable { case begin, move, end }

enum ModifierKey: String, Codable, Sendable, CaseIterable {
    case cmd, shift, option, control, fn, capsLock
}

enum HubAction: String, Codable {
    case keys, shot, copy, paste, lock, mods
}

enum SettingValue {
    case bool(Bool)
    case int(Int)
    case double(Double)
    case string(String)
}

struct PointerEvent {
    let phase: GesturePhase
    let dx: Double
    let dy: Double
    let display: UInt32?
    /// 1…8 from the 07A tick slider; the host converts to a gain curve.
    let sensitivity: Int?
}

enum ClaudeInbound {
    case listSessions(cwd: String?)
    case open(sessionId: String?, cwd: String?, mode: ClaudeMode)
    case send(text: String)
    case interrupt
    case permission(requestId: String, allow: Bool, scope: PermissionScope, message: String?)
    case diff(path: String?)
    case close
}

enum ClaudeMode: String, Codable { case chat, code }
enum PermissionScope: String, Codable { case once, always }

// MARK: - Inbound decoding

enum InboundDecodeError: Error {
    case unknownType(String)
    case malformed(String)
}

extension InboundMessage {
    // swiftlint:disable:next cyclomatic_complexity function_body_length
    static func decode(_ data: Data) throws -> (id: String?, message: InboundMessage) {
        guard let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = root["t"] as? String
        else { throw InboundDecodeError.malformed("missing discriminator") }

        let id = root["id"] as? String

        func requireString(_ key: String) throws -> String {
            guard let value = root[key] as? String else {
                throw InboundDecodeError.malformed("\(type): missing string \(key)")
            }
            return value
        }
        func double(_ key: String, _ fallback: Double = 0) -> Double {
            (root[key] as? NSNumber)?.doubleValue ?? fallback
        }
        func int(_ key: String) -> Int? { (root[key] as? NSNumber)?.intValue }
        func bool(_ key: String, _ fallback: Bool = false) -> Bool {
            (root[key] as? NSNumber)?.boolValue ?? fallback
        }
        func displayIds() -> [UInt32] {
            ((root["displayIds"] as? [NSNumber]) ?? []).map { $0.uint32Value }
        }
        func phase() -> GesturePhase {
            GesturePhase(rawValue: (root["phase"] as? String) ?? "move") ?? .move
        }

        let message: InboundMessage
        switch type {
        case "selectDisplay":
            message = .selectDisplay(
                displayIds: displayIds(),
                sideBySide: (root["mode"] as? String) == "sideBySide"
            )

        case "startStream":
            message = .startStream(
                displayIds: displayIds(),
                maxHeight: int("maxHeight"),
                targetFps: int("targetFps")
            )

        case "stopStream":
            message = .stopStream

        case "setQuality":
            let ladder = HostSettings.QualityLadder(
                rawValue: (root["ladder"] as? String) ?? "auto"
            ) ?? .auto
            message = .setQuality(
                ladder: ladder,
                cellularCapMbps: (root["cellularCapMbps"] as? NSNumber)?.doubleValue
            )

        case "pointer":
            message = .pointer(PointerEvent(
                phase: phase(),
                dx: double("dx"),
                dy: double("dy"),
                display: (root["display"] as? NSNumber)?.uint32Value,
                sensitivity: int("sensitivity")
            ))

        case "click":
            message = .click(
                button: MouseButton(rawValue: (root["button"] as? String) ?? "left") ?? .left,
                count: int("count") ?? 1,
                display: (root["display"] as? NSNumber)?.uint32Value
            )

        case "drag":
            // `count` is additive and optional: a client that never sends it drags
            // on a single click, which is what every version-1 client did.
            message = .drag(
                phase: phase(),
                dx: double("dx"),
                dy: double("dy"),
                count: int("count") ?? 1
            )

        case "scroll":
            message = .scroll(
                dx: double("dx"),
                dy: double("dy"),
                momentum: bool("momentum")
            )

        case "zoom":
            message = .zoom(
                scale: double("scale", 1),
                anchorX: double("anchorX", 0.5),
                anchorY: double("anchorY", 0.5),
                locked: bool("locked")
            )

        case "modifiers":
            let raw = (root["held"] as? [String]) ?? []
            let held = Set(raw.compactMap(ModifierKey.init(rawValue:)))
            message = .modifiers(held: held, latched: bool("latched", true))

        case "key":
            message = .key(
                code: try requireString("code"),
                chars: root["chars"] as? String,
                down: bool("down", true)
            )

        case "combo":
            guard let keys = root["keys"] as? [String] else {
                throw InboundDecodeError.malformed("combo: missing keys")
            }
            message = .combo(keys: keys)

        case "text":
            message = .text(try requireString("value"))

        case "hubAction":
            guard let raw = root["action"] as? String,
                  let action = HubAction(rawValue: raw)
            else { throw InboundDecodeError.malformed("hubAction: bad action") }
            message = .hubAction(action)

        case "clipboardPush":
            message = .clipboardPush(try requireString("text"))

        case "wake": message = .wake
        case "retry": message = .retry
        case "lastFrame": message = .lastFrame

        case "claude":
            message = .claude(try ClaudeInbound.decode(root))

        case "revoke":
            message = .revoke(
                deviceId: root["deviceId"] as? String,
                all: bool("all")
            )

        case "setting":
            let key = try requireString("key")
            let value: SettingValue
            if let b = root["value"] as? NSNumber, CFGetTypeID(b) == CFBooleanGetTypeID() {
                value = .bool(b.boolValue)
            } else if let n = root["value"] as? NSNumber {
                // Ints and doubles arrive indistinguishably from JSON; keep both.
                value = n.doubleValue == n.doubleValue.rounded()
                    ? .int(n.intValue)
                    : .double(n.doubleValue)
            } else if let s = root["value"] as? String {
                value = .string(s)
            } else {
                throw InboundDecodeError.malformed("setting: unsupported value")
            }
            message = .setting(key: key, value: value)

        case "ping":
            message = .ping(
                tMicros: (root["tMicros"] as? NSNumber)?.uint64Value ?? 0,
                sequence: (root["seq"] as? NSNumber)?.uint64Value ?? 0,
                // The phone reports the round trip it measured on its own
                // clock for the previous ping; the Mac cannot compute it.
                rttMillis: (root["rttMillis"] as? NSNumber)?.doubleValue
            )

        case "link":
            message = .link(
                expensive: bool("expensive"),
                constrained: bool("constrained")
            )

        default:
            throw InboundDecodeError.unknownType(type)
        }

        return (id, message)
    }
}

extension ClaudeInbound {
    static func decode(_ root: [String: Any]) throws -> ClaudeInbound {
        guard let sub = root["sub"] as? String else {
            throw InboundDecodeError.malformed("claude: missing sub")
        }
        switch sub {
        case "listSessions":
            return .listSessions(cwd: root["cwd"] as? String)
        case "open":
            let mode = ClaudeMode(rawValue: (root["mode"] as? String) ?? "code") ?? .code
            return .open(
                sessionId: root["sessionId"] as? String,
                cwd: root["cwd"] as? String,
                mode: mode
            )
        case "send":
            guard let text = root["text"] as? String else {
                throw InboundDecodeError.malformed("claude.send: missing text")
            }
            return .send(text: text)
        case "interrupt":
            return .interrupt
        case "permission":
            guard let requestId = root["requestId"] as? String,
                  let behavior = root["behavior"] as? String
            else { throw InboundDecodeError.malformed("claude.permission: missing fields") }
            let scope = PermissionScope(rawValue: (root["scope"] as? String) ?? "once") ?? .once
            return .permission(
                requestId: requestId,
                allow: behavior == "allow",
                scope: scope,
                message: root["message"] as? String
            )
        case "diff":
            // A nil path closes the live diff rather than opening one.
            return .diff(path: root["path"] as? String)
        case "close":
            return .close
        default:
            throw InboundDecodeError.unknownType("claude.\(sub)")
        }
    }
}

// MARK: - Host → phone

/// Outbound messages are built as loose dictionaries rather than a giant
/// Codable enum. The shapes are documented in PROTOCOL.md and every construction
/// site goes through one of these factories, so the wire stays consistent.
enum Outbound {
    static func hello(
        hostId: String,
        hostName: String,
        model: String,
        osVersion: String,
        capabilities: [String: Bool]
    ) -> [String: Any] {
        [
            "t": "hello",
            "hostId": hostId,
            "hostName": hostName,
            "model": model,
            "os": osVersion,
            "version": Config.hostVersion,
            "protocol": Config.protocolVersion,
            "capabilities": capabilities,
            // Additive, still protocol 1. A client that never reads it assumes
            // a Mac, which is what every host was until the Windows one.
            "platform": "macos",
        ]
    }

    static func error(_ code: String, _ message: String, retriable: Bool = false, id: String? = nil) -> [String: Any] {
        var payload: [String: Any] = [
            "t": "error",
            "code": code,
            "message": message,
            "retriable": retriable,
        ]
        if let id { payload["id"] = id }
        return payload
    }

    static func ack(_ id: String) -> [String: Any] {
        ["t": "ack", "id": id]
    }

    static func pong(tMicros: UInt64) -> [String: Any] {
        ["t": "pong", "tMicros": tMicros, "hostMicros": Timestamps.monotonicMicros()]
    }
}

// MARK: - Binary video framing

enum VideoFrameFlags {
    static let keyframe: UInt8 = 1 << 0
    static let parameterSets: UInt8 = 1 << 1
    static let resolutionChanged: UInt8 = 1 << 2
}

enum VideoFraming {
    static let magic: UInt8 = 0xB1
    static let headerSize = 20

    /// Header layout matches PROTOCOL.md §2.1. Big-endian throughout so the
    /// Swift and future non-Swift clients agree without guessing.
    static func frame(
        streamId: UInt16,
        sequence: UInt32,
        ptsMicros: UInt64,
        flags: UInt8,
        payload: Data
    ) -> Data {
        var out = Data(capacity: headerSize + payload.count)
        out.append(magic)
        out.append(flags)
        out.appendBigEndian(streamId)
        out.appendBigEndian(sequence)
        out.appendBigEndian(ptsMicros)
        // 4 bytes reserved keeps the payload 4-byte aligned for the decoder.
        out.appendBigEndian(UInt32(0))
        out.append(payload)
        return out
    }
}

extension Data {
    // Qualified with `Swift.` because Data has its own `withUnsafeBytes`
    // instance method that would otherwise shadow the global function.
    mutating func appendBigEndian(_ value: UInt16) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }
    mutating func appendBigEndian(_ value: UInt32) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }
    mutating func appendBigEndian(_ value: UInt64) {
        Swift.withUnsafeBytes(of: value.bigEndian) { append(contentsOf: $0) }
    }
}
