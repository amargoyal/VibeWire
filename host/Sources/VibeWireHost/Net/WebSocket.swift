import Foundation
import CryptoKit

/// Minimal RFC 6455 framing. Hand-rolled rather than pulled from a package so
/// the host builds with no network fetch and stays a single binary.
///
/// Scope is deliberately narrow: server side only, no extensions, no
/// compression. Client frames must be masked (we enforce it); server frames
/// are never masked (per spec).
enum WebSocketOpcode: UInt8 {
    case continuation = 0x0
    case text = 0x1
    case binary = 0x2
    case close = 0x8
    case ping = 0x9
    case pong = 0xA
}

struct WebSocketFrame {
    let opcode: WebSocketOpcode
    let payload: Data
    let isFinal: Bool
}

enum WebSocketError: Error {
    case unmaskedClientFrame
    case reservedBitsSet
    case unknownOpcode(UInt8)
    case controlFrameTooLarge
    case fragmentedControlFrame
    case payloadTooLarge
}

enum WebSocketCodec {
    /// The magic GUID from RFC 6455 §1.3.
    private static let handshakeGUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

    /// Nothing the phone sends comes close to this. It exists so a hostile
    /// length field cannot make the host allocate itself to death.
    static let maxPayloadBytes = 32 * 1024 * 1024

    static func acceptKey(for clientKey: String) -> String {
        let digest = Insecure.SHA1.hash(data: Data((clientKey + handshakeGUID).utf8))
        return Data(digest).base64EncodedString()
    }

    /// Server → client. Never masked.
    static func encode(_ frame: WebSocketFrame) -> Data {
        var out = Data(capacity: frame.payload.count + 10)
        out.append((frame.isFinal ? 0x80 : 0x00) | frame.opcode.rawValue)

        let length = frame.payload.count
        if length < 126 {
            out.append(UInt8(length))
        } else if length <= 0xFFFF {
            out.append(126)
            out.appendBigEndian(UInt16(length))
        } else {
            out.append(127)
            out.appendBigEndian(UInt64(length))
        }
        out.append(frame.payload)
        return out
    }

    /// Pulls one frame off the front of `buffer`, removing the bytes it used.
    /// Returns nil when the buffer holds only a partial frame; the caller
    /// should read more and try again.
    static func next(from buffer: inout Data) throws -> WebSocketFrame? {
        guard let parsed = try parse(buffer) else { return nil }
        buffer.removeFirst(parsed.consumed)
        return parsed.frame
    }

    private struct Parsed {
        let frame: WebSocketFrame
        let consumed: Int
    }

    /// Pure function over a snapshot of the buffer. Keeping it free of
    /// mutation is what makes concurrent connections safe.
    private static func parse(_ buffer: Data) throws -> Parsed? {
        guard buffer.count >= 2 else { return nil }

        // Data slices can carry a non-zero start index; normalise so integer
        // offsets below are always relative to the first byte.
        let base = buffer.startIndex
        func byte(_ offset: Int) -> UInt8 { buffer[base + offset] }

        let b0 = byte(0)
        let b1 = byte(1)

        guard b0 & 0x70 == 0 else { throw WebSocketError.reservedBitsSet }

        let isFinal = (b0 & 0x80) != 0
        let rawOpcode = b0 & 0x0F
        let masked = (b1 & 0x80) != 0
        var length = Int(b1 & 0x7F)
        var cursor = 2

        guard masked else { throw WebSocketError.unmaskedClientFrame }

        if length == 126 {
            guard buffer.count >= cursor + 2 else { return nil }
            length = Int(byte(cursor)) << 8 | Int(byte(cursor + 1))
            cursor += 2
        } else if length == 127 {
            guard buffer.count >= cursor + 8 else { return nil }
            var value: UInt64 = 0
            for i in 0..<8 { value = value << 8 | UInt64(byte(cursor + i)) }
            guard value <= UInt64(maxPayloadBytes) else { throw WebSocketError.payloadTooLarge }
            length = Int(value)
            cursor += 8
        }

        guard buffer.count >= cursor + 4 else { return nil }
        let mask = (byte(cursor), byte(cursor + 1), byte(cursor + 2), byte(cursor + 3))
        cursor += 4

        guard buffer.count >= cursor + length else { return nil }

        guard let opcode = WebSocketOpcode(rawValue: rawOpcode) else {
            throw WebSocketError.unknownOpcode(rawOpcode)
        }

        if opcode == .close || opcode == .ping || opcode == .pong {
            guard length <= 125 else { throw WebSocketError.controlFrameTooLarge }
            guard isFinal else { throw WebSocketError.fragmentedControlFrame }
        }

        var payload = Data(count: length)
        if length > 0 {
            let maskBytes = [mask.0, mask.1, mask.2, mask.3]
            payload.withUnsafeMutableBytes { dest in
                let out = dest.bindMemory(to: UInt8.self)
                for i in 0..<length {
                    out[i] = byte(cursor + i) ^ maskBytes[i & 3]
                }
            }
        }

        return Parsed(
            frame: WebSocketFrame(opcode: opcode, payload: payload, isFinal: isFinal),
            consumed: cursor + length
        )
    }
}
