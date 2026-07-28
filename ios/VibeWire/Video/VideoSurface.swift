import SwiftUI
import AVFoundation
import VideoToolbox
import CoreMedia

/// Renders the Mac's screen.
///
/// H.264 Annex-B arrives over the socket, gets rewrapped as AVCC in a
/// `CMSampleBuffer`, and goes to an `AVSampleBufferDisplayLayer`. That layer is
/// the shortest path from encoded bytes to glass on iOS: no decoder to manage,
/// no pixel copies, and it stays on the GPU.
final class VideoRenderer: @unchecked Sendable {
    private let layer = AVSampleBufferDisplayLayer()
    private var formatDescription: CMFormatDescription?
    private var didReportFailure = false
    /// Set when new SPS/PPS arrive, so the layer can be flushed before it is
    /// handed buffers in the new format.
    private var parameterSetsChanged = false
    private var spsData: Data?
    private var ppsData: Data?
    private let lock = NSLock()

    /// Set when a frame arrives before any parameter set, which happens if the
    /// phone joins mid-stream. The host re-sends SPS/PPS on every keyframe, so
    /// this resolves within a second rather than staying broken.
    private(set) var isWaitingForKeyframe = true

    private(set) var lastFrameAt: Date?
    private(set) var framesRendered = 0
    private(set) var framesDropped = 0

    var displayLayer: AVSampleBufferDisplayLayer { layer }

    init() {
        layer.videoGravity = .resizeAspect
        layer.backgroundColor = UIColor(red: 0.055, green: 0.063, blue: 0.075, alpha: 1).cgColor
        if #available(iOS 17.0, *) {
            layer.sampleBufferRenderer.requestMediaDataWhenReady(on: .main) {}
        }
    }

    func reset() {
        lock.lock()
        formatDescription = nil
        spsData = nil
        ppsData = nil
        isWaitingForKeyframe = true
        // Both of these describe the spell that just ended, not the next one.
        // Leaving `didReportFailure` set meant a renderer logged its first
        // failure and then went quiet for the rest of the process, which is the
        // opposite of what a once-per-spell guard is for.
        parameterSetsChanged = false
        didReportFailure = false
        lock.unlock()
        layer.flush()
    }

    func enqueue(_ frame: VideoFrame) {
        let units = AnnexB.nalUnits(in: frame.payload)
        guard !units.isEmpty else { return }

        var pictureUnits: [Data] = []

        for unit in units {
            switch AnnexB.type(of: unit) {
            case AnnexB.sps:
                lock.lock()
                if spsData != unit {
                    spsData = unit
                    formatDescription = nil
                    parameterSetsChanged = true
                }
                lock.unlock()
            case AnnexB.pps:
                lock.lock()
                if ppsData != unit {
                    ppsData = unit
                    formatDescription = nil
                    parameterSetsChanged = true
                }
                lock.unlock()
            default:
                pictureUnits.append(unit)
            }
        }

        guard !pictureUnits.isEmpty else { return }

        // Switching display restarts the stream at a different size, so new
        // parameter sets arrive and the format description is rebuilt. Handing
        // the layer buffers in a new format without flushing it first makes it
        // quietly stop drawing — no `.failed` status, no error, just a black
        // picture that only a fresh screen recovered from. Flush, and wait for
        // the next keyframe before feeding it again.
        lock.lock()
        let mustReset = parameterSetsChanged
        if mustReset {
            parameterSetsChanged = false
            isWaitingForKeyframe = true
        }
        lock.unlock()
        if mustReset { layer.flush() }

        guard let format = ensureFormatDescription() else {
            framesDropped += 1
            return
        }

        // Until a keyframe arrives there is nothing a decoder can do with the
        // bytes; drop them rather than feeding the layer garbage.
        if isWaitingForKeyframe {
            guard frame.isKeyframe else {
                framesDropped += 1
                return
            }
            isWaitingForKeyframe = false
        }

        guard let sampleBuffer = makeSampleBuffer(
            from: pictureUnits,
            format: format,
            ptsMicros: frame.ptsMicros
        ) else {
            framesDropped += 1
            return
        }

        // Display immediately rather than scheduling against a timebase. This
        // is a remote control, not a video player: the newest frame is always
        // the right frame, and buffering to smooth playback would be latency
        // the user feels in the cursor.
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(
            sampleBuffer, createIfNecessary: true
        ) as? [NSMutableDictionary], let first = attachments.first {
            first[kCMSampleAttachmentKey_DisplayImmediately] = true
        }

        enqueueOnLayer(sampleBuffer)
        framesRendered += 1
        lastFrameAt = Date()
    }

    private func enqueueOnLayer(_ sampleBuffer: CMSampleBuffer) {
        if #available(iOS 17.0, *) {
            let renderer = layer.sampleBufferRenderer
            if renderer.status == .failed {
                reportFailure(renderer.error)
                layer.flush()
            }
            renderer.enqueue(sampleBuffer)
        } else {
            if layer.status == .failed {
                reportFailure(layer.error)
                layer.flush()
            }
            layer.enqueue(sampleBuffer)
        }
    }

    /// A decode failure used to be indistinguishable from "the Mac's screen is
    /// simply dark": the layer went to `.failed`, got flushed, and said
    /// nothing, so a black pane had no explanation. Reported once per spell of
    /// failure rather than per frame, which at 60fps would be a torrent.
    private func reportFailure(_ error: Error?) {
        lock.lock()
        let alreadyReported = didReportFailure
        didReportFailure = true
        lock.unlock()
        guard !alreadyReported else { return }
        print("[VibeWire] video layer failed: \(error.map { "\($0)" } ?? "no error given")")
    }

    private func ensureFormatDescription() -> CMFormatDescription? {
        lock.lock()
        defer { lock.unlock() }

        if let formatDescription { return formatDescription }
        guard let sps = spsData, let pps = ppsData else { return nil }

        var description: CMFormatDescription?
        let status = sps.withUnsafeBytes { spsBytes -> OSStatus in
            pps.withUnsafeBytes { ppsBytes -> OSStatus in
                guard let spsBase = spsBytes.bindMemory(to: UInt8.self).baseAddress,
                      let ppsBase = ppsBytes.bindMemory(to: UInt8.self).baseAddress
                else { return -1 }

                let pointers: [UnsafePointer<UInt8>] = [spsBase, ppsBase]
                let sizes: [Int] = [sps.count, pps.count]

                return pointers.withUnsafeBufferPointer { pointerBuffer in
                    sizes.withUnsafeBufferPointer { sizeBuffer in
                        CMVideoFormatDescriptionCreateFromH264ParameterSets(
                            allocator: kCFAllocatorDefault,
                            parameterSetCount: 2,
                            parameterSetPointers: pointerBuffer.baseAddress!,
                            parameterSetSizes: sizeBuffer.baseAddress!,
                            nalUnitHeaderLength: 4,
                            formatDescriptionOut: &description
                        )
                    }
                }
            }
        }

        guard status == noErr else { return nil }
        formatDescription = description
        return description
    }

    /// Annex-B start codes become 4-byte big-endian lengths (AVCC), which is
    /// what CMBlockBuffer expects.
    private func makeSampleBuffer(
        from units: [Data],
        format: CMFormatDescription,
        ptsMicros: UInt64
    ) -> CMSampleBuffer? {
        var avcc = Data(capacity: units.reduce(0) { $0 + $1.count + 4 })
        for unit in units {
            var length = UInt32(unit.count).bigEndian
            withUnsafeBytes(of: &length) { avcc.append(contentsOf: $0) }
            avcc.append(unit)
        }

        var blockBuffer: CMBlockBuffer?
        let bytes = UnsafeMutableRawPointer.allocate(
            byteCount: avcc.count,
            alignment: MemoryLayout<UInt8>.alignment
        )
        avcc.copyBytes(
            to: UnsafeMutableRawBufferPointer(start: bytes, count: avcc.count)
        )

        // kCFAllocatorDefault as the block allocator hands ownership of `bytes`
        // to CoreMedia, which frees it when the buffer dies.
        let blockStatus = CMBlockBufferCreateWithMemoryBlock(
            allocator: kCFAllocatorDefault,
            memoryBlock: bytes,
            blockLength: avcc.count,
            blockAllocator: kCFAllocatorDefault,
            customBlockSource: nil,
            offsetToData: 0,
            dataLength: avcc.count,
            flags: 0,
            blockBufferOut: &blockBuffer
        )
        guard blockStatus == kCMBlockBufferNoErr, let blockBuffer else {
            bytes.deallocate()
            return nil
        }

        var sampleBuffer: CMSampleBuffer?
        var sampleSize = avcc.count
        var timing = CMSampleTimingInfo(
            duration: .invalid,
            presentationTimeStamp: CMTime(value: CMTimeValue(ptsMicros), timescale: 1_000_000),
            decodeTimeStamp: .invalid
        )

        let sampleStatus = CMSampleBufferCreateReady(
            allocator: kCFAllocatorDefault,
            dataBuffer: blockBuffer,
            formatDescription: format,
            sampleCount: 1,
            sampleTimingEntryCount: 1,
            sampleTimingArray: &timing,
            sampleSizeEntryCount: 1,
            sampleSizeArray: &sampleSize,
            sampleBufferOut: &sampleBuffer
        )
        guard sampleStatus == noErr else { return nil }
        return sampleBuffer
    }
}

/// One renderer per stream, vended by stream id.
///
/// A single renderer cannot serve two displays: the host sends an independent
/// H.264 elementary stream per display, each with its own SPS/PPS and its own
/// reference frames. Feeding both into one decoder makes it decode monitor 2's
/// slices against monitor 1's references — which is the green confetti and the
/// grey mush, not a network problem. Keyed by stream id so the demux is exactly
/// the one the wire header already carries.
final class RendererPool: @unchecked Sendable {
    private var byStream: [Int: VideoRenderer] = [:]
    private let lock = NSLock()

    func renderer(forStream streamId: Int) -> VideoRenderer {
        lock.lock()
        defer { lock.unlock() }
        if let existing = byStream[streamId] { return existing }
        let created = VideoRenderer()
        byStream[streamId] = created
        return created
    }

    func resetAll() {
        lock.lock()
        let all = Array(byStream.values)
        lock.unlock()
        for renderer in all { renderer.reset() }
    }

    /// Drops every renderer. The host renumbers streams on each start — a
    /// stream id is a position in the selection, not a stable identity — so
    /// after a restart the surviving objects belong to the previous numbering
    /// and vending one hands a view a decoder that will never be fed again.
    func removeAll() {
        lock.lock()
        let all = Array(byStream.values)
        byStream.removeAll()
        lock.unlock()
        for renderer in all { renderer.reset() }
    }

    /// Drops renderers for streams the host is no longer sending, so a stale
    /// picture cannot be mistaken for a live one after a display change.
    func keepOnly(streamIds: Set<Int>) {
        lock.lock()
        let doomed = byStream.filter { !streamIds.contains($0.key) }
        for key in doomed.keys { byStream.removeValue(forKey: key) }
        lock.unlock()
        for renderer in doomed.values { renderer.reset() }
    }
}

/// SwiftUI wrapper around the display layer.
struct VideoSurface: UIViewRepresentable {
    let renderer: VideoRenderer

    func makeUIView(context: Context) -> VideoSurfaceView {
        let view = VideoSurfaceView()
        view.attach(renderer.displayLayer)
        return view
    }

    /// Re-attaching matters for side by side: the pane's stream can arrive
    /// after the pane does, and a layer belongs to exactly one superlayer — two
    /// surfaces sharing one renderer leaves whichever attached first blank.
    func updateUIView(_ uiView: VideoSurfaceView, context: Context) {
        uiView.attach(renderer.displayLayer)
    }
}

/// A two-finger pan, reported in deltas.
///
/// SwiftUI's `DragGesture` cannot tell one finger from two, and the remote view
/// needs to: one finger is the trackpad, two fingers move the picture (or
/// scroll the Mac). The recognizer is installed on the host view's superview so
/// it sees touches without taking them — `cancelsTouchesInView` stays false and
/// the delegate allows simultaneous recognition, so the SwiftUI gestures
/// underneath keep working.
struct TwoFingerPan: UIViewRepresentable {
    let onChange: (CGSize) -> Void
    let onEnded: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onChange: onChange, onEnded: onEnded)
    }

    func makeUIView(context: Context) -> UIView {
        let view = UIView(frame: .zero)
        view.isUserInteractionEnabled = false
        view.backgroundColor = .clear

        // The recognizer has to live on an ancestor that actually receives the
        // touches. `superview` is the background modifier's own container: it
        // sits *behind* the content, is not an ancestor of the view the finger
        // lands on, and therefore never saw a single touch — which is why two
        // finger pan did nothing at all. The window is the one view guaranteed
        // to be in the delivery path, so the recognizer goes there and the
        // coordinator filters by location instead.
        installWhenReady(on: view, coordinator: context.coordinator)
        return view
    }

    private func installWhenReady(on view: UIView, coordinator: Coordinator) {
        DispatchQueue.main.async {
            guard coordinator.recognizer == nil else { return }
            guard let target = view.window else {
                // The view is not in a window yet on the first pass.
                installWhenReady(on: view, coordinator: coordinator)
                return
            }
            let recognizer = UIPanGestureRecognizer(
                target: coordinator,
                action: #selector(Coordinator.handle(_:))
            )
            recognizer.minimumNumberOfTouches = 2
            recognizer.maximumNumberOfTouches = 2
            // Never swallow the touch: the SwiftUI trackpad gesture in front
            // must keep working for one finger.
            recognizer.cancelsTouchesInView = false
            recognizer.delaysTouchesBegan = false
            recognizer.delaysTouchesEnded = false
            recognizer.delegate = coordinator
            target.addGestureRecognizer(recognizer)
            coordinator.recognizer = recognizer
            coordinator.host = view
        }
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        context.coordinator.onChange = onChange
        context.coordinator.onEnded = onEnded
        context.coordinator.host = uiView
    }

    /// The recognizer outlives the representable's view because it is installed
    /// on the window, so it has to be taken off by hand.
    static func dismantleUIView(_ uiView: UIView, coordinator: Coordinator) {
        if let recognizer = coordinator.recognizer {
            recognizer.view?.removeGestureRecognizer(recognizer)
        }
        coordinator.recognizer = nil
        coordinator.host = nil
    }

    final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onChange: (CGSize) -> Void
        var onEnded: () -> Void
        weak var recognizer: UIPanGestureRecognizer?
        /// The representable's own view, used only to test whether a pan
        /// started over the pad.
        weak var host: UIView?

        init(onChange: @escaping (CGSize) -> Void, onEnded: @escaping () -> Void) {
            self.onChange = onChange
            self.onEnded = onEnded
        }

        /// True while two fingers are actually driving the picture, so the
        /// single finger trackpad can stand down instead of also steering the
        /// Mac's pointer with the same touches.
        private(set) var isPanning = false

        @objc func handle(_ recognizer: UIPanGestureRecognizer) {
            switch recognizer.state {
            case .began:
                isPanning = withinHost(recognizer)
            case .changed:
                guard isPanning else { return }
                let translation = recognizer.translation(in: recognizer.view)
                onChange(CGSize(width: translation.x, height: translation.y))
            case .ended, .cancelled, .failed:
                guard isPanning else { return }
                isPanning = false
                onEnded()
            default:
                break
            }
        }

        /// The recognizer is on the window, so it fires for two finger pans
        /// anywhere on screen. Only the ones that start over the pad count.
        private func withinHost(_ recognizer: UIPanGestureRecognizer) -> Bool {
            guard let host, let window = recognizer.view else { return false }
            let frame = host.convert(host.bounds, to: window)
            return frame.contains(recognizer.location(in: window))
        }

        func gestureRecognizer(
            _ gestureRecognizer: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}

final class VideoSurfaceView: UIView {
    private var attached: AVSampleBufferDisplayLayer?

    /// Deliberately compares the cached reference and nothing else.
    ///
    /// Re-adopting the layer whenever `displayLayer.superlayer !== layer` looks
    /// like the more correct test — it repairs a pane whose layer was stolen —
    /// but two surfaces sharing one renderer then take it back from each other
    /// on every render pass, and the layer blanks under the churn. The sharing
    /// is the actual fault and is fixed in `AppModel.renderer(forDisplay:)`; a
    /// surface here owns its layer for as long as it is alive.
    /// Returns true when this surface actually took the layer on, so the
    /// renderer can be re-armed for it.
    @discardableResult
    func attach(_ displayLayer: AVSampleBufferDisplayLayer) -> Bool {
        guard attached !== displayLayer else { return false }
        attached?.removeFromSuperlayer()
        layer.addSublayer(displayLayer)
        attached = displayLayer
        setNeedsLayout()
        return true
    }

    override func layoutSubviews() {
        super.layoutSubviews()
        // No implicit animation: a resize should snap, not slide.
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        attached?.frame = bounds
        CATransaction.commit()
    }
}
