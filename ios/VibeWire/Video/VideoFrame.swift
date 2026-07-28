import Foundation

/// One binary frame off the socket, decoded from the header in PROTOCOL.md §2.1.
struct VideoFrame: Sendable {
    let streamId: UInt16
    let sequence: UInt32
    let ptsMicros: UInt64
    let isKeyframe: Bool
    let carriesParameterSets: Bool
    let resolutionChanged: Bool
    /// H.264 Annex-B.
    let payload: Data

    private static let magic: UInt8 = 0xB1
    private static let headerSize = 20

    init?(_ data: Data) {
        guard data.count > Self.headerSize else { return nil }
        let base = data.startIndex
        guard data[base] == Self.magic else { return nil }

        let flags = data[base + 1]
        func be16(_ offset: Int) -> UInt16 {
            UInt16(data[base + offset]) << 8 | UInt16(data[base + offset + 1])
        }
        func be32(_ offset: Int) -> UInt32 {
            (0..<4).reduce(UInt32(0)) { $0 << 8 | UInt32(data[base + offset + $1]) }
        }
        func be64(_ offset: Int) -> UInt64 {
            (0..<8).reduce(UInt64(0)) { $0 << 8 | UInt64(data[base + offset + $1]) }
        }

        streamId = be16(2)
        sequence = be32(4)
        ptsMicros = be64(8)
        isKeyframe = flags & 0x01 != 0
        carriesParameterSets = flags & 0x02 != 0
        resolutionChanged = flags & 0x04 != 0
        payload = Data(data[(base + Self.headerSize)...])
    }
}

/// Splits an Annex-B buffer into its NAL units.
///
/// Written as a scan for 3- and 4-byte start codes rather than a regex or a
/// naive split, because the byte pattern can legitimately appear inside a
/// payload only when preceded by the emulation-prevention byte the encoder
/// inserts — so scanning start codes in order is both correct and cheap.
enum AnnexB {
    static func nalUnits(in data: Data) -> [Data] {
        var units: [Data] = []
        var index = data.startIndex
        var unitStart: Int?

        func isStartCode(_ position: Int) -> Int? {
            if position + 3 < data.endIndex,
               data[position] == 0, data[position + 1] == 0,
               data[position + 2] == 0, data[position + 3] == 1 {
                return 4
            }
            if position + 2 < data.endIndex,
               data[position] == 0, data[position + 1] == 0, data[position + 2] == 1 {
                return 3
            }
            return nil
        }

        while index < data.endIndex {
            if let codeLength = isStartCode(index) {
                if let start = unitStart, start < index {
                    units.append(Data(data[start..<index]))
                }
                index += codeLength
                unitStart = index
            } else {
                index += 1
            }
        }

        if let start = unitStart, start < data.endIndex {
            units.append(Data(data[start..<data.endIndex]))
        }
        return units
    }

    /// NAL unit type lives in the low 5 bits of the first byte.
    static func type(of unit: Data) -> UInt8 {
        guard let first = unit.first else { return 0 }
        return first & 0x1F
    }

    static let sps: UInt8 = 7
    static let pps: UInt8 = 8
    static let idr: UInt8 = 5
}
