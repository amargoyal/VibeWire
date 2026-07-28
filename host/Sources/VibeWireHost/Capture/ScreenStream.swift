import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo

/// Captures one display and emits encoded H.264 frames.
///
/// Two streams can run at once for the side-by-side mode on 03C; each gets its
/// own `streamId` so the phone can route frames to the right pane.
final class ScreenStream: NSObject, @unchecked Sendable {
    struct Quality {
        var maxHeight: Int
        var fps: Int
        var bitrate: Int

        /// The ladder behind the AUTO / 1080 / 720 / 540 control on 07A, and
        /// behind "WILL OPEN AT 540P" on the weak-link home screen.
        static func forLink(maxHeight: Int?, rttMillis: Double, lossPercent: Double, capMbps: Double?) -> Quality {
            let height: Int
            if let maxHeight {
                height = maxHeight
            } else if rttMillis > 250 || lossPercent > 3 {
                height = 540
            } else if rttMillis > 120 || lossPercent > 1 {
                height = 720
            } else {
                height = 1080
            }

            let fps = height <= 540 ? 30 : 60

            // Rough but honest: enough for text to stay readable at each step.
            var bitrate: Int
            switch height {
            case ...540: bitrate = 1_500_000
            case ...720: bitrate = 3_000_000
            default: bitrate = 6_000_000
            }
            if let capMbps {
                bitrate = min(bitrate, Int(capMbps * 1_000_000))
            }
            return Quality(maxHeight: height, fps: fps, bitrate: bitrate)
        }
    }

    let streamId: UInt16
    let displayId: CGDirectDisplayID

    private var stream: SCStream?
    private var encoder: VideoEncoder?
    private let outputQueue: DispatchQueue
    private var sequence: UInt32 = 0
    private var quality: Quality
    private var sourceSize: CGSize = .zero
    private var encodedSize: (width: Int, height: Int) = (0, 0)
    private var pendingResolutionFlag = false
    private let startedAt = Timestamps.monotonicMicros()

    /// Called with a fully framed binary message ready for the socket.
    private let onFrame: (Data) -> Void
    /// Called with the last successfully encoded keyframe so 02D can offer
    /// "SHOW LAST FRAME · 6H OLD".
    private let onKeyframeSnapshot: (Data, Date) -> Void

    private var bytesThisSecond = 0
    private var lastRateSample = Date()
    private(set) var measuredMbps: Double = 0
    private(set) var framesEncoded: Int = 0

    init(
        streamId: UInt16,
        displayId: CGDirectDisplayID,
        quality: Quality,
        onFrame: @escaping (Data) -> Void,
        onKeyframeSnapshot: @escaping (Data, Date) -> Void
    ) {
        self.streamId = streamId
        self.displayId = displayId
        self.quality = quality
        self.onFrame = onFrame
        self.onKeyframeSnapshot = onKeyframeSnapshot
        self.outputQueue = DispatchQueue(
            label: "com.vibewire.host.capture.\(streamId)",
            qos: .userInteractive
        )
        super.init()
    }

    func start() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(
            false, onScreenWindowsOnly: true
        )
        guard let display = content.displays.first(where: { $0.displayID == displayId }) else {
            throw CaptureError.displayGone(displayId)
        }

        sourceSize = CGSize(width: display.width, height: display.height)
        let target = Self.fit(source: sourceSize, maxHeight: quality.maxHeight)
        encodedSize = target

        let filter = SCContentFilter(display: display, excludingWindows: [])

        let configuration = SCStreamConfiguration()
        configuration.width = target.width
        configuration.height = target.height
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(quality.fps))
        configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
        configuration.colorSpaceName = CGColorSpace.sRGB
        configuration.showsCursor = true
        // One frame of slack. Deeper queues only add latency here.
        configuration.queueDepth = 3
        configuration.scalesToFit = true

        let encoder = try VideoEncoder(
            configuration: .init(
                width: target.width,
                height: target.height,
                fps: quality.fps,
                bitrate: quality.bitrate
            ),
            onEncoded: { [weak self] data, isKeyframe, pts in
                self?.emit(data, isKeyframe: isKeyframe, ptsMicros: pts)
            }
        )
        self.encoder = encoder

        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: outputQueue)
        try await stream.startCapture()
        self.stream = stream

        Log.info(.capture, "stream \(streamId) started on display \(displayId) at \(target.width)x\(target.height)@\(quality.fps)")
    }

    func stop() async {
        if let stream {
            try? await stream.stopCapture()
        }
        stream = nil
        encoder = nil
        Log.info(.capture, "stream \(streamId) stopped")
    }

    /// Applied live when the link changes. A resolution change rebuilds the
    /// SCStream config and the encoder, and forces a keyframe so the phone can
    /// re-latch immediately.
    func apply(quality newQuality: Quality) async {
        let target = Self.fit(source: sourceSize, maxHeight: newQuality.maxHeight)
        let sizeChanged = target != encodedSize

        quality = newQuality
        encodedSize = target

        if sizeChanged, let stream {
            let configuration = SCStreamConfiguration()
            configuration.width = target.width
            configuration.height = target.height
            configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(newQuality.fps))
            configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
            configuration.showsCursor = true
            configuration.queueDepth = 3
            configuration.scalesToFit = true
            try? await stream.updateConfiguration(configuration)
            pendingResolutionFlag = true
        }

        try? encoder?.reconfigure(to: .init(
            width: target.width,
            height: target.height,
            fps: newQuality.fps,
            bitrate: newQuality.bitrate
        ))
        Log.info(.capture, "stream \(streamId) retuned to \(target.height)p @\(newQuality.fps) \(newQuality.bitrate / 1000)kbps")
    }

    func requestKeyframe() {
        encoder?.forceKeyframe()
    }

    var currentQuality: Quality { quality }
    var currentSize: (width: Int, height: Int) { encodedSize }

    private static func fit(source: CGSize, maxHeight: Int) -> (width: Int, height: Int) {
        guard source.height > 0 else { return (1280, 720) }
        let scale = min(1.0, Double(maxHeight) / Double(source.height))
        // H.264 wants even dimensions; rounding to 2 avoids chroma artifacts.
        let width = max(2, Int((Double(source.width) * scale / 2).rounded()) * 2)
        let height = max(2, Int((Double(source.height) * scale / 2).rounded()) * 2)
        return (width, height)
    }

    private func emit(_ payload: Data, isKeyframe: Bool, ptsMicros: UInt64) {
        sequence &+= 1
        framesEncoded += 1

        var flags: UInt8 = 0
        if isKeyframe {
            flags |= VideoFrameFlags.keyframe
            flags |= VideoFrameFlags.parameterSets
        }
        if pendingResolutionFlag {
            flags |= VideoFrameFlags.resolutionChanged
            pendingResolutionFlag = false
        }

        let framed = VideoFraming.frame(
            streamId: streamId,
            sequence: sequence,
            ptsMicros: ptsMicros,
            flags: flags,
            payload: payload
        )
        onFrame(framed)

        if isKeyframe {
            onKeyframeSnapshot(framed, Date())
        }

        bytesThisSecond += framed.count
        let elapsed = Date().timeIntervalSince(lastRateSample)
        if elapsed >= 1 {
            measuredMbps = Double(bytesThisSecond) * 8 / elapsed / 1_000_000
            bytesThisSecond = 0
            lastRateSample = Date()
        }
    }
}

extension ScreenStream: SCStreamOutput {
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen,
              CMSampleBufferGetNumSamples(sampleBuffer) > 0,
              CMSampleBufferDataIsReady(sampleBuffer)
        else { return }

        // ScreenCaptureKit emits frames with a status attachment; skip the ones
        // that carry no new pixels (idle screen) so we do not burn bitrate
        // re-encoding an unchanged desktop.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
           let raw = attachments.first?[.status] as? Int,
           let status = SCFrameStatus(rawValue: raw),
           status != .complete {
            return
        }

        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let elapsedMicros = Timestamps.monotonicMicros() &- startedAt
        let pts = CMTime(value: CMTimeValue(elapsedMicros), timescale: 1_000_000)
        encoder?.encode(pixelBuffer, pts: pts)
    }
}

extension ScreenStream: SCStreamDelegate {
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        Log.error(.capture, "stream \(streamId) stopped with error: \(error)")
    }
}

enum CaptureError: Error, CustomStringConvertible {
    case displayGone(CGDirectDisplayID)
    case noPermission

    var description: String {
        switch self {
        case .displayGone(let id): return "display \(id) is no longer available"
        case .noPermission: return "screen recording permission not granted"
        }
    }
}
