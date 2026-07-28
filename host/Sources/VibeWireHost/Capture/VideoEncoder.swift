import Foundation
import VideoToolbox
import CoreMedia
import CoreVideo

/// Hardware H.264 encoder tuned for interactive latency rather than file size.
///
/// The settings that matter:
/// - `RealTime = true` and no B-frames, so a frame never waits on a future
///   frame to be emitted. B-frames would add a frame of latency for a
///   compression win nobody watching their own desktop cares about.
/// - `MaxKeyFrameInterval` is short and we also force IDRs on demand, because a
///   phone that reconnects must be able to start decoding immediately.
/// - Parameter sets (SPS/PPS) are prepended to every keyframe. Sending them
///   once at the start would strand any client that joined late or dropped a
///   frame, which is exactly the reconnect case screen 03D is about.
final class VideoEncoder: @unchecked Sendable {
    struct Configuration: Equatable {
        var width: Int
        var height: Int
        var fps: Int
        var bitrate: Int
    }

    /// (annexBData, isKeyframe, ptsMicros)
    typealias Output = (Data, Bool, UInt64) -> Void

    private var session: VTCompressionSession?
    private var configuration: Configuration
    private let onEncoded: Output
    private let lock = NSLock()
    private var forceKeyframeNext = false

    init(configuration: Configuration, onEncoded: @escaping Output) throws {
        self.configuration = configuration
        self.onEncoded = onEncoded
        try createSession()
    }

    deinit {
        if let session {
            VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
            VTCompressionSessionInvalidate(session)
        }
    }

    var currentConfiguration: Configuration {
        lock.lock(); defer { lock.unlock() }
        return configuration
    }

    private func createSession() throws {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(configuration.width),
            height: Int32(configuration.height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session
        )
        guard status == noErr, let session else {
            throw EncoderError.sessionCreateFailed(status)
        }

        // Baseline-ish but with CABAC: broadly decodable and cheap to decode on
        // the phone, which is the side with a battery to protect.
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_High_AutoLevel)
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_H264EntropyMode, value: kVTH264EntropyMode_CABAC)

        setInt(session, kVTCompressionPropertyKey_MaxKeyFrameInterval, configuration.fps * 2)
        setInt(session, kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, 2)
        setInt(session, kVTCompressionPropertyKey_AverageBitRate, configuration.bitrate)
        setInt(session, kVTCompressionPropertyKey_ExpectedFrameRate, configuration.fps)

        // A hard ceiling over a 1s window keeps a sudden full-screen redraw
        // from blowing the link budget and stalling everything behind it.
        let cap = [configuration.bitrate / 8 * 2, 1] as CFArray
        VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: cap)

        // Best effort: low-latency rate control exists on Apple silicon and is
        // a no-op elsewhere, so a failure here is not fatal.
        VTSessionSetProperty(
            session,
            key: kVTVideoEncoderSpecification_EnableLowLatencyRateControl,
            value: kCFBooleanTrue
        )

        VTCompressionSessionPrepareToEncodeFrames(session)
        self.session = session

        Log.info(.capture, "encoder ready \(configuration.width)x\(configuration.height) @\(configuration.fps) \(configuration.bitrate / 1000)kbps")
    }

    private func setInt(_ session: VTCompressionSession, _ key: CFString, _ value: Int) {
        VTSessionSetProperty(session, key: key, value: NSNumber(value: value))
    }

    /// Bitrate can be retuned without tearing down the session; dimensions
    /// cannot, so a resolution change rebuilds it.
    func reconfigure(to new: Configuration) throws {
        lock.lock()
        let needsRebuild = new.width != configuration.width || new.height != configuration.height
        configuration = new
        lock.unlock()

        if needsRebuild {
            if let session {
                VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid)
                VTCompressionSessionInvalidate(session)
            }
            session = nil
            try createSession()
        } else if let session {
            setInt(session, kVTCompressionPropertyKey_AverageBitRate, new.bitrate)
            setInt(session, kVTCompressionPropertyKey_ExpectedFrameRate, new.fps)
            let cap = [new.bitrate / 8 * 2, 1] as CFArray
            VTSessionSetProperty(session, key: kVTCompressionPropertyKey_DataRateLimits, value: cap)
        }
        forceKeyframe()
    }

    func forceKeyframe() {
        lock.lock(); forceKeyframeNext = true; lock.unlock()
    }

    func encode(_ pixelBuffer: CVPixelBuffer, pts: CMTime) {
        guard let session else { return }

        lock.lock()
        let forceKey = forceKeyframeNext
        forceKeyframeNext = false
        lock.unlock()

        var properties: CFDictionary?
        if forceKey {
            properties = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue] as CFDictionary
        }

        VTCompressionSessionEncodeFrame(
            session,
            imageBuffer: pixelBuffer,
            presentationTimeStamp: pts,
            duration: .invalid,
            frameProperties: properties,
            infoFlagsOut: nil
        ) { [weak self] status, _, sampleBuffer in
            guard let self, status == noErr, let sampleBuffer else { return }
            handleEncoded(sampleBuffer)
        }
    }

    private func handleEncoded(_ sampleBuffer: CMSampleBuffer) {
        guard CMSampleBufferDataIsReady(sampleBuffer) else { return }

        let isKeyframe = Self.isKeyframe(sampleBuffer)
        var out = Data()

        // VideoToolbox hands back AVCC (length-prefixed). The phone's decoder
        // wants Annex-B, and Annex-B is also what survives packet loss more
        // gracefully, so convert here.
        if isKeyframe, let format = CMSampleBufferGetFormatDescription(sampleBuffer) {
            out.append(Self.parameterSets(from: format))
        }

        guard let block = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }
        var totalLength = 0
        var pointer: UnsafeMutablePointer<Int8>?
        guard CMBlockBufferGetDataPointer(
            block, atOffset: 0, lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength, dataPointerOut: &pointer
        ) == noErr, let pointer else { return }

        let startCode = Data([0x00, 0x00, 0x00, 0x01])
        var offset = 0
        let bytes = UnsafeRawPointer(pointer)
        while offset + 4 <= totalLength {
            var naluLength: UInt32 = 0
            memcpy(&naluLength, bytes.advanced(by: offset), 4)
            naluLength = CFSwapInt32BigToHost(naluLength)
            offset += 4
            guard naluLength > 0, offset + Int(naluLength) <= totalLength else { break }
            out.append(startCode)
            out.append(Data(bytes: bytes.advanced(by: offset), count: Int(naluLength)))
            offset += Int(naluLength)
        }

        let pts = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let ptsMicros = UInt64(max(0, CMTimeGetSeconds(pts) * 1_000_000))
        onEncoded(out, isKeyframe, ptsMicros)
    }

    private static func isKeyframe(_ sampleBuffer: CMSampleBuffer) -> Bool {
        guard let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: false
        ) as? [[CFString: Any]], let first = attachments.first else {
            return true
        }
        // Absence of the "not sync" marker means this is a sync sample.
        return !(first[kCMSampleAttachmentKey_NotSync] as? Bool ?? false)
    }

    private static func parameterSets(from format: CMFormatDescription) -> Data {
        var out = Data()
        let startCode = Data([0x00, 0x00, 0x00, 0x01])
        var count = 0
        guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            format, parameterSetIndex: 0, parameterSetPointerOut: nil,
            parameterSetSizeOut: nil, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil
        ) == noErr else { return out }

        for index in 0..<count {
            var pointer: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
                format, parameterSetIndex: index, parameterSetPointerOut: &pointer,
                parameterSetSizeOut: &size, parameterSetCountOut: nil, nalUnitHeaderLengthOut: nil
            ) == noErr, let pointer else { continue }
            out.append(startCode)
            out.append(Data(bytes: pointer, count: size))
        }
        return out
    }
}

enum EncoderError: Error, CustomStringConvertible {
    case sessionCreateFailed(OSStatus)

    var description: String {
        switch self {
        case .sessionCreateFailed(let status):
            return "VTCompressionSessionCreate failed: \(status)"
        }
    }
}
