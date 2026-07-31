import SwiftUI

/// 03A–03D · REMOTE VIEW, with the control layer (04) and keyboard mode (05)
/// layered on top.
///
/// A 16:10 desktop inside a 19.5:9 phone leaves bands. They are used rather
/// than fought: the picture keeps every pixel it has, the chrome lives in the
/// dark, and the trackpad reaches past the video into the bands — so the first
/// accidental swipe in the dark area still moves the cursor, which is what
/// teaches it.
struct RemoteView: View {
    @Environment(AppModel.self) private var model

    @State private var pointerOrigin: CGPoint?
    @State private var isDragging = false
    /// The press that has not yet decided whether it is a tap, a slide or a drag.
    /// A finger that stays put for `holdToDragSeconds` picks the window up; one
    /// that travels first is steering, which is what a trackpad has always done.
    @State private var holdToDrag: Task<Void, Never>?
    @State private var travelSincePress: CGFloat = 0
    @State private var showTeachingOverlay = true
    @State private var pinchStart: CGFloat = 1
    @State private var showZoomBadge = false

    // Zoom that goes somewhere: the pinch keeps its focal point, and two
    // fingers move the view around once there is more picture than glass.
    @State private var pan: CGSize = .zero
    @State private var panStart: CGSize = .zero
    @State private var isPinching = false
    /// Two fingers are moving the picture, so the one finger trackpad must not
    /// also be steering the Mac's pointer with the same touches.
    @State private var isTwoFingerPanning = false
    /// The recognizer reports travel from the start of the gesture; scrolling
    /// needs the step since the previous event.
    @State private var lastScrollTravel: CGSize = .zero

    /// What one finger does on the glass.
    ///
    /// Moving the picture used to be a two finger drag, which fought the pinch
    /// for the same two fingers and was impossible to aim. It is now a stated
    /// mode: two fingers only ever zoom or scroll, and one finger does exactly
    /// the one thing this says it does.
    enum PadMode: String {
        case pointer
        case pan
    }

    @State private var padMode: PadMode = .pointer
    @State private var pictureSize: CGSize = .zero

    /// Orientation taken from the glass, not from `UIDevice`.
    ///
    /// Reading `UIDevice.current.orientation` inside `body` is not observable
    /// state: rotating the phone changes nothing SwiftUI is watching, so the
    /// layout only swapped when something *else* forced a redraw — the stall
    /// ticker a second later, or a touch. That is the "it rearranges itself
    /// about five seconds later, or the moment I touch it" behaviour. It also
    /// reports `.faceUp`/`.unknown` when the phone is flat, which landscape is
    /// not. The geometry proxy is recomputed on rotation by definition.
    @State private var isLandscape = false

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                NS.Color.deepGround.ignoresSafeArea()

                if isLandscape {
                    landscapeLayout
                } else {
                    portraitLayout(in: geometry)
                }

                // 03D — the stall overlay sits above the frozen picture.
                if case .stalled = model.streamState { reconnectingOverlay }
                if case .reconnecting = model.streamState { reconnectingOverlay }

                // 03E — the same frozen picture from the opposite cause. The
                // two can never both be up: `decodeFailure` is only read while
                // the host says frames are still coming.
                if cannotDecode { undecodableOverlay }

                // The drawer carries its own arrival — see the `rise` on the
                // drawer inside it, which travels its own height rather than
                // the whole screen's. The taps that open and hide it animate
                // the change, which is what runs it.
                if model.showHub { CommandDrawerView() }

                // 05 — the keyboard bar. Three places set `showKeyboard`; until
                // this line nothing read it, so KEYS in the rail, KEYS in the
                // landscape dock and KEYS in the drawer all did nothing at all.
                if model.showKeyboard { KeyboardBarView() }
            }
            // Nothing layered on the glass gets to resize the glass.
            .frame(width: geometry.size.width, height: geometry.size.height)
            .onAppear { applyOrientation(geometry.size) }
            .onChange(of: geometry.size) { _, size in applyOrientation(size) }
        }
        .statusBarHidden(isLandscape)
        // The one screen that cannot take the whole Dynamic Type range, and it
        // is worth being precise about why: almost nothing here is text. The
        // hub's six spokes sit at hard-coded offsets tracing a thumb's sweep —
        // that is hand geometry, not type — the picture holds a fixed aspect,
        // and the landscape dock is 231pt of controls. Past this step the
        // captions start colliding with the video they annotate.
        //
        // accessibility1 is already two steps beyond the largest standard size,
        // and every other screen in the app takes the full range.
        .dynamicTypeSize(...DynamicTypeSize.accessibility1)
        .task { await queueTicker() }
        .onAppear {
            // The teaching overlay retires after three sessions; the corner
            // ticks and cursor halo stay forever.
            showTeachingOverlay = model.sessionCount <= 3
        }
    }

    // MARK: Portrait

    private func portraitLayout(in geometry: GeometryProxy) -> some View {
        VStack(spacing: 0) {
            HStack(spacing: 10) {
                stopButton(size: 36)
                statusStrip
            }
            .padding(.horizontal, 14)
            .frame(height: 44)

            if model.displays.count > 1 {
                displayTabs.padding(.horizontal, 14).padding(.top, 6)
            }

            Spacer(minLength: 0)

            if model.sideBySide {
                sideBySidePanes
            } else {
                picture
            }

            pictureCaptionRow
                .padding(.horizontal, 14)
                .padding(.top, 12)

            Spacer(minLength: 0)

            VStack(spacing: 10) {
                // Teaching gestures over a picture that has stopped updating is
                // noise on top of a fault, and the card below wants the space.
                if showTeachingOverlay && model.streamState == .live
                    && !cannotDecode && !model.sideBySide && !model.showHub {
                    teachingLegend
                }
                rail
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 12)
        }
        // The pad is the whole glass, not just the picture.
        .contentShape(Rectangle())
        .gesture(trackpadGesture)
        .simultaneousGesture(pinchGesture)
        .background(
            TwoFingerPan(
                onChange: {
                    // The recognizer reports translation from where the pan
                    // began, so the baseline has to be taken there too.
                    if !isTwoFingerPanning {
                        isTwoFingerPanning = true
                        panStart = pan
                        lastScrollTravel = .zero
                    }
                    twoFingerDrag($0, ended: false)
                },
                onEnded: {
                    isTwoFingerPanning = false
                    twoFingerDrag(.zero, ended: true)
                }
            )
        )
        .onTapGesture(count: 2) { resetView() }
        .overlay(alignment: .topTrailing) {
            if model.zoomScale > 1.02 { minimap.padding(.top, 66).padding(.trailing, 20) }
        }
        .overlay {
            if showZoomBadge { zoomBadge }
        }
    }

    private var statusStrip: some View {
        HStack {
            HStack(spacing: 7) {
                ConditionDot(
                    condition: streamCondition,
                    size: 6,
                    // Nothing decorative moves next to a live video feed.
                    animated: !pictureIsLive
                )
                MonoCaps(liveLabel, size: 10, color: streamCondition.color, tracking: 1.4)
            }
            Spacer()
            MonoCaps(codecLabel, size: 10, tracking: 1.4)
        }
    }

    /// What the *picture* is doing, which is not what the socket is doing.
    ///
    /// `link.condition` answers "is the Mac answering"; this answers "are frames
    /// arriving", and the two disagree exactly where it matters — a socket that
    /// still replies while the stream has stopped. The dot and the label beside
    /// it both take this, so the colour and the word can never say two different
    /// things about the same picture.
    private var streamCondition: Condition {
        // Frames are arriving and none of them can be turned into a picture.
        // Whatever the socket is doing, this picture is not live and the strip
        // above it may not say it is. It takes `lost` rather than `degraded`
        // because nothing here is thinning gracefully — there is no picture at
        // all — and because a lost condition is drawn as a square, which is the
        // redundant channel this app owes the one state that is not recoverable
        // by waiting.
        if cannotDecode { return .lost }
        switch model.streamState {
        // A live picture is only as good as the link carrying it, so here the
        // measured round trip and loss are what decide between the two.
        case .live: return model.link.condition
        // Frames have stopped arriving. That is a measured degradation whatever
        // the socket claims, and it pulses at the faster rate this system gives
        // a thin link.
        case .stalled, .reconnecting: return .degraded
        case .failed: return .lost
        // Nothing has been measured about a stream that has not started or has
        // been stopped, so the dot is a hollow ring rather than a colour.
        case .starting, .stopped: return .idle
        }
    }

    /// Stalled or reconnecting: two states, one fact — frames are not arriving,
    /// so nothing on this screen may go on reading as though they were.
    private var picturePaused: Bool {
        switch model.streamState {
        case .stalled, .reconnecting: return true
        default: return false
        }
    }

    /// The decoder's reason for the picture on the glass being the last one that
    /// decoded rather than the newest one sent.
    ///
    /// Gated on the host still reporting a running stream. Once frames stop
    /// arriving, the fault on screen is the stall — a decode failure recorded
    /// while they were still coming is a fact about a stream that has since
    /// stopped, and two cards claiming one frozen frame is the collapse this
    /// state exists to avoid. The value is not cleared here; the renderer clears
    /// it on evidence and nothing else. It simply stops outranking the newer,
    /// truer state.
    private var decodeFailure: String? {
        switch model.streamState {
        case .live, .starting: return model.selectedDecodeFailure
        default: return nil
        }
    }

    private var cannotDecode: Bool { decodeFailure != nil }

    /// The picture is genuinely moving, which is the only thing that earns the
    /// suppression of the condition dot's pulse. That rule exists so nothing
    /// decorative moves beside live video — and a frame that cannot be decoded
    /// is not live video, whatever the host is reporting.
    private var pictureIsLive: Bool { model.streamState == .live && !cannotDecode }

    /// How old the picture is, and only where that has actually been measured.
    ///
    /// A stall is measured: the host is still on the socket and reported the age
    /// of the last frame it sent. A reconnect is not measured by anyone — the
    /// socket is gone — so it has no age to print, and says what it does know
    /// instead.
    private var stalledMillis: Int? {
        if case .stalled(let millis) = model.streamState { return millis }
        return nil
    }

    private func seconds(_ millis: Int) -> String {
        String(format: "%.1f", Double(millis) / 1000)
    }

    private var liveLabel: String {
        // Its own word, not a fourth spelling of STALLED. The two look the same
        // on the glass and have nothing else in common.
        if cannotDecode { return "CANNOT DECODE" }
        switch model.streamState {
        case .live:
            return "LIVE \(model.link.rttMillis.map { String(Int($0)) } ?? "—")MS"
        case .starting: return "OPENING"
        // The host's own figure, to the tenth it was reported in. This used to
        // round to whole seconds and print a `.0` after them, which is a digit
        // nobody measured sitting where a measured one goes.
        case .stalled(let millis): return "STALLED \(seconds(millis))S"
        case .reconnecting(let attempt, _): return "RECONNECTING · TRY \(attempt)"
        case .stopped: return "STOPPED"
        case .failed: return "LOST"
        }
    }

    private var codecLabel: String {
        // A bitrate measured before the stall is not a bitrate now, and a codec
        // line describing a stream that has stopped arriving is the strip
        // claiming health it has not observed. While the picture is paused this
        // prints the em dash the panel prints for anything unmeasured.
        //
        // A decode failure is deliberately *not* paused here, and it is the one
        // place these two states are told apart on the strip itself. The host is
        // still sending at this rate, in this codec; that is measured, still
        // true, and the evidence for the sentence on the card saying the link is
        // fine. Blanking it would hide the one reading that explains the state.
        guard !picturePaused else { return "—" }
        guard let config = model.videoConfigs.values.sorted(by: { $0.streamId < $1.streamId }).first
        else { return "—" }
        if model.videoConfigs.count > 1 {
            let total = model.videoConfigs.values.reduce(0.0) { $0 + $1.bitrateMbps }
            return "\(model.videoConfigs.count) STREAMS · \(String(format: "%.1f", total)) MB/S"
        }
        return "H.264 · \(String(format: "%.1f", config.bitrateMbps)) MB/S · \(config.fps)FPS"
    }

    private var displayTabs: some View {
        @Bindable var bindable = model
        return Segmented(
            options: tabOptions,
            selection: Binding(
                get: { model.sideBySide ? -1 : Int(model.displays.first(where: \.selected)?.id ?? 0) },
                set: { value in
                    if value == -1 {
                        model.selectBothDisplays()
                    } else {
                        model.selectDisplay(UInt32(value))
                    }
                    model.startStream()
                }
            )
        )
    }

    private var tabOptions: [(value: Int, label: String, badge: Color?)] {
        var options = model.displays.enumerated().map { index, display in
            (value: Int(display.id), label: "MON \(index + 1)", badge: nil as Color?)
        }
        if model.displays.count > 1 {
            options.append((value: -1, label: "BOTH", badge: nil))
        }
        return options
    }

    // MARK: Picture

    private var picture: some View {
        ZStack {
            // This used to stay black on the way back from side by side, and it
            // was never a decoding fault: a stream id is a *position in the
            // selection*, not an identity, so display 2 stopped being stream 1
            // the moment it became the only selected display. The phone kept
            // the old number, resolved this picture to renderer 1 in the window
            // before `videoConfig` landed, and then watched every frame of the
            // new stream arrive on renderer 0. Selection now renumbers locally
            // the way the host does — see `AppModel.selectDisplay`.
            VideoSurface(renderer: model.selectedRenderer)
                .aspectRatio(pictureAspect, contentMode: .fit)
                .scaleEffect(model.zoomScale, anchor: .center)
                .offset(pan)
                .clipped()
                .background(
                    GeometryReader { proxy in
                        Color.clear
                            .onAppear { pictureSize = proxy.size }
                            .onChange(of: proxy.size) { _, size in pictureSize = size }
                    }
                )

            // Corner ticks stay forever — they mark the edge of the real pixels
            // so a zoomed picture never looks like a cropped one.
            CornerTicks(color: frozenTint ?? NS.Color.accent.opacity(0.75))

            // A spinner says "wait, this is coming". Once the decoder has said
            // it cannot use what is arriving, that is a claim nothing measured.
            if model.streamState == .starting && !cannotDecode {
                Spinner(size: 24, color: NS.Color.accent)
            }
        }
        .overlay(alignment: .bottomLeading) {
            VideoCaption(pictureCaption, color: frozenTint ?? NS.Color.textSecondary)
                .padding(.leading, 10)
                .padding(.bottom, 26)
                // The hub's hint text sits on this exact line, and two 8pt
                // captions on top of each other read as neither.
                .opacity(model.showHub ? 0 : 1)
        }
        .overlay(alignment: .bottomTrailing) {
            // Something is being carried, and the only way to put it down is to
            // lift the finger. Violet, because holding is the user's own state.
            if isDragging {
                VideoCaption("DRAGGING · LIFT TO DROP", color: NS.Color.accent)
                    .padding(.trailing, 10)
                    .padding(.bottom, 26)
            }
        }
    }

    private var pictureAspect: CGFloat {
        guard let config = model.videoConfigs.values.first, config.height > 0 else {
            return 16.0 / 10.0
        }
        return CGFloat(config.width) / CGFloat(config.height)
    }

    private var pictureCaption: String {
        // Not the same sentence as a stall's, and the difference is the point:
        // in a stall the frame on the glass is the last one that *arrived*; here
        // frames keep arriving and are thrown away, so it is the last one that
        // *decoded*.
        if cannotDecode { return "LAST DECODED FRAME" }
        // A reconnect freezes the same frame a stall does, and this named only
        // the stall — so while the socket was being redialled the caption over
        // a frozen picture went on reading `… · LIVE`.
        if picturePaused { return "LAST GOOD FRAME" }
        guard let display = model.displays.first(where: \.selected) else { return "" }
        let geometry = "\(display.name.uppercased()) · \(display.width) × \(display.height)"
        // `LIVE` is a claim about arriving frames, so it is only appended where
        // frames are arriving. Stopped, opening and lost all kept it before.
        return model.streamState == .live ? "\(geometry) · LIVE" : geometry
    }

    /// The ticks and the caption take the colour of whatever froze the picture:
    /// the frozen frame keeps its geometry but stops claiming to be live.
    ///
    /// Two inks, not one, because these are two conditions. Amber is a measured
    /// degradation that waiting may fix — a stall usually does resolve. Clay is
    /// this: the bytes are all here and none of them are a picture, which
    /// waiting fixes only if the next keyframe happens to decode.
    private var frozenTint: Color? {
        if cannotDecode { return NS.Color.red.opacity(0.7) }
        return picturePaused ? NS.Color.amber.opacity(0.7) : nil
    }

    // MARK: 03C — side by side

    private var sideBySidePanes: some View {
        VStack(spacing: 10) {
            ForEach(Array(model.displays.enumerated()), id: \.element.id) { index, display in
                ZStack {
                    VideoSurface(renderer: model.renderer(forDisplay: display.id))
                        .aspectRatio(paneAspect(for: display), contentMode: .fit)
                        .opacity(model.inputPane == index ? 1 : 0.55)

                    if model.inputPane == index {
                        CornerTicks(color: NS.Color.accent.opacity(0.8))
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    HStack(spacing: 8) {
                        if model.inputPane == index {
                            // Cyan at 16% over video was the same unverifiable
                            // bet the captions were making, and this badge is
                            // the one that says where input lands.
                            MonoCaps("INPUT HERE", size: 9, color: NS.Color.accent, tracking: 1.4)
                                .videoChip()
                                .overlay(Rectangle().stroke(NS.Color.accent.opacity(0.5), lineWidth: 1))
                        }
                        VideoCaption(
                            paneCaption(for: display, index: index),
                            // The unfocused pane is dimmed by its own opacity
                            // already; taking the text down as well stacked two
                            // reductions on one caption.
                            color: model.decodeFailure(forDisplay: display.id) == nil
                                ? NS.Color.textSecondary
                                : NS.Color.red
                        )
                    }
                    .padding(.leading, 10)
                    .padding(.bottom, 20)
                }
                .onTapGesture {
                    withAnimation(NS.Motion.stateChange) {
                        model.inputPane = index
                        model.selectDisplay(display.id)
                    }
                }
            }
        }
    }

    /// Each pane owns a stream and therefore its own decoder, so one can be
    /// undecodable while the other is fine. Naming it here is what keeps the
    /// two-monitor case from reproducing exactly the fault this state was added
    /// for: a frozen pane with the geometry caption still under it.
    private func paneCaption(for display: DisplayEntry, index: Int) -> String {
        let name = display.name.uppercased()
        if model.decodeFailure(forDisplay: display.id) != nil {
            return "\(name) · CANNOT DECODE"
        }
        if model.inputPane == index {
            return "\(name) · \(display.width) × \(display.height)"
        }
        return "\(name) · TAP TO TAKE INPUT"
    }

    // MARK: Overlays

    private var teachingLegend: some View {
        MonoCaps(
            "MOVE ANYWHERE ON THE GLASS\nTWO FINGERS SCROLL · PINCH ZOOMS",
            size: 9,
            tracking: 1.6
        )
        .multilineTextAlignment(.center)
        .lineSpacing(6)
        .frame(maxWidth: .infinity)
        .allowsHitTesting(false)
    }

    /// The scale reads out big in the middle, where the eye already is.
    private var zoomBadge: some View {
        VStack(spacing: 6) {
            Text(String(format: "%.1f×", model.zoomScale))
                .font(NS.Font.mono(46, weight: .medium))
                .foregroundStyle(NS.Color.text)
            MonoCaps("DOUBLE-TAP FITS", size: 10, color: NS.Color.accent, tracking: 2)
        }
        .allowsHitTesting(false)
        .transition(.opacity)
    }

    /// Only appears above 1.0×. It answers "where am I", which is the only
    /// question zoom creates.
    private var minimap: some View {
        VStack(alignment: .trailing, spacing: 6) {
            ZStack(alignment: .center) {
                Rectangle()
                    .fill(NS.Color.deepGround.opacity(0.8))
                    .frame(width: 78, height: 49)
                    .overlay(Rectangle().stroke(NS.Color.stroke, lineWidth: 1))
                Rectangle()
                    .fill(NS.Color.accent.opacity(0.16))
                    .frame(width: 78 / model.zoomScale, height: 49 / model.zoomScale)
                    .overlay(Rectangle().stroke(NS.Color.accent, lineWidth: 1))
            }
            MonoCaps(
                model.displays.first(where: \.selected).map { "\($0.name.uppercased()) REGION" } ?? "REGION",
                size: 9,
                tracking: 1.2
            )
        }
        .allowsHitTesting(false)
    }

    /// A stall looks like a stall: it says how old the picture is — where that
    /// has been measured — that input is queued rather than lost, and when it
    /// will stop trying.
    private var reconnectingOverlay: some View {
        VStack {
            Spacer()
            Card(tint: NS.Color.amber) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 10) {
                        Spinner(size: 16, color: NS.Color.amber)
                        // The same word the strip at the top is using. Two names
                        // for one state on one screen reads as two states.
                        MonoCaps(
                            stalledMillis != nil ? "STALLED" : "RECONNECTING",
                            size: 11,
                            color: NS.Color.amber,
                            tracking: 1.6,
                            weight: .medium
                        )
                    }

                    Text(overlaySentence)
                        .font(NS.Font.sans(15))
                        .foregroundStyle(NS.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)

                    VStack(spacing: 8) {
                        // "1 EVENT", not "1 EVENTS" — the same rule the paired
                        // device list follows for its own counted nouns.
                        overlayRow(
                            "QUEUED INPUT",
                            "\(queuedCount) EVENT\(queuedCount == 1 ? "" : "S")",
                            NS.Color.text
                        )
                        overlayRow("DROPPING TO", "540P ON RESUME", NS.Color.amber)
                        overlayRow("GIVING UP AT", "30S", NS.Color.text)
                    }
                    .padding(.top, 14)
                }
                .padding(18)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 78)
        }
    }

    /// Two states that know two different things, so they get two different
    /// sentences rather than one that fits neither.
    ///
    /// This used to print "the picture above is N seconds old" in both, with N
    /// coming from a one-second ticker this view ran itself — a number nobody
    /// measured, presented as the age of the frame on screen. A stall has a real
    /// age because the host reports one. A reconnect does not, so it states the
    /// attempt and the next retry, which is what the state actually carries.
    private var overlaySentence: String {
        if let millis = stalledMillis {
            return "The picture above is \(seconds(millis)) seconds old. Keys and taps are being held, not dropped."
        }
        if case .reconnecting(let attempt, let nextRetryMs) = model.streamState {
            let next = max(1, Int((Double(nextRetryMs) / 1000).rounded()))
            return "Nothing is arriving. Try \(attempt), the next in \(next)s. Keys and taps are being held, not dropped."
        }
        return "Nothing is arriving. Keys and taps are being held, not dropped."
    }

    /// 03E — frames are arriving and none of them can be turned into a picture.
    ///
    /// Deliberately not the stall card wearing a different word. A stall has an
    /// age, a queue and a retry to count down, and none of the three exist here:
    /// the socket is up, the round trip is real, and every key and tap is
    /// landing on the Mac while this is on screen — which is the single most
    /// useful thing this card says, because the frozen picture implies the
    /// opposite. What it has instead of a clock is the decoder's own reason and
    /// the one thing that clears it.
    ///
    /// It sits where the stall card sits, above the rail rather than over the
    /// picture. The picture is the last thing this app should cover, and it is
    /// still the last true frame of the Mac.
    private var undecodableOverlay: some View {
        VStack {
            Spacer()
            Card(tint: NS.Color.red) {
                VStack(alignment: .leading, spacing: 0) {
                    MonoCaps(
                        "CANNOT DECODE",
                        size: 11,
                        color: NS.Color.red,
                        tracking: 1.6,
                        weight: .medium
                    )

                    Text(
                        """
                        The Mac is sending video this iPhone cannot decode. \
                        The link is fine and your keys and taps are still \
                        landing — only the picture has stopped. It clears \
                        itself on the next keyframe that decodes; if it does \
                        not, stop the stream and start it again.
                        """
                    )
                    .font(NS.Font.sans(15))
                    .foregroundStyle(NS.Color.text)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.top, 12)

                    if let reason = decodeFailure {
                        // The decoder's own words, in mono because the machine
                        // wrote them. Evidence, not the answer — the answer is
                        // the sentence above.
                        Text(reason)
                            .font(NS.Font.mono(11))
                            .foregroundStyle(NS.Color.textSecondary)
                            .lineLimit(2)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(.top, 10)
                    }

                    VStack(spacing: 8) {
                        // Both rows are the proof of the sentence: bytes are
                        // still coming down, and input is still going up. A
                        // stall can say neither.
                        overlayRow("STILL ARRIVING", arrivingRate, NS.Color.text)
                        overlayRow("INPUT", "STILL LANDING", NS.Color.text)
                    }
                    .padding(.top, 14)
                }
                .padding(18)
            }
            .padding(.horizontal, 14)
            .padding(.bottom, 78)
        }
    }

    /// What the host says it is still sending, which is the reading that makes
    /// "the link is fine" a measurement rather than a reassurance.
    private var arrivingRate: String {
        guard let config = model.videoConfigs.values.sorted(by: { $0.streamId < $1.streamId }).first
        else { return "—" }
        return String(format: "%.1f MB/S", config.bitrateMbps)
    }

    @State private var queuedCount = 0

    private func overlayRow(_ label: String, _ value: String, _ color: Color) -> some View {
        HStack {
            MonoCaps(label, size: 10, tracking: 1)
            Spacer()
            MonoCaps(value, size: 10, color: color, tracking: 1)
        }
    }

    // MARK: Bottom bar

    private var isStalled: Bool {
        if case .stalled = model.streamState { return true }
        return false
    }

    /// Ends the session. The one control that is in the same place in every
    /// layout.
    private func stopButton(size: CGFloat, label: String? = nil) -> some View {
        Button {
            model.stopStream()
        } label: {
            HStack(spacing: 9) {
                Text("✕").font(NS.Font.mono(14))
                if let label {
                    MonoCaps(label, size: 9, color: NS.Color.textSecondary, tracking: 1.4)
                }
            }
            .foregroundStyle(NS.Color.textSecondary)
            .frame(maxWidth: label == nil ? nil : .infinity)
            .frame(width: label == nil ? size : nil, height: size)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusInner).fill(NS.Color.chrome2)
            )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("stopStream")
        .accessibilityLabel(isStalled ? "Stop trying to reconnect" : "Stop streaming")
    }

    /// What is on screen and at what scale, stated in the band rather than over
    /// the picture. This is where the zoom rail's reading went: a slider nobody
    /// drags is not worth 128pt of the right-hand edge, but the number it
    /// carried is.
    private var pictureCaptionRow: some View {
        HStack {
            if !pictureCaption.isEmpty {
                VideoCaption(pictureCaption, color: frozenTint ?? NS.Color.textSecondary)
            }
            Spacer(minLength: 8)
            MonoCaps(
                model.zoomScale > 1.02
                    ? String(format: "%.1f×", model.zoomScale)
                    : "1.0× FIT",
                size: 9,
                color: model.zoomScale > 1.02 ? NS.Color.accent : NS.Color.textTertiary,
                tracking: 1
            )
        }
    }

    /// The control layer, in the lower letterbox band.
    ///
    /// Four things, left to right: what one finger does, the keyboard, the
    /// Command key, and everything else. The first is the only one that is a
    /// mode, so it is the only one drawn as a segmented control; the other three
    /// are 52pt squares in the order they are reached for.
    ///
    /// ⌘ latches Command directly rather than opening the drawer to it. It is
    /// the modifier a Mac actually needs — ⌘Tab, ⌘Space, ⌘W — and putting it one
    /// tap away instead of two is the difference between using it and not.
    @ViewBuilder
    private var rail: some View {
        if isStalled {
            HStack(spacing: 8) {
                stopButton(size: NS.Metric.railButton, label: "STOP TRYING")
                railButton(glyph: "⌨", label: "Keyboard", enabled: false) {}
                drawerButton
            }
        } else {
            HStack(spacing: 8) {
                padModeControl
                railButton(glyph: "⌨", label: "Keyboard") { model.showKeyboard = true }
                railButton(
                    glyph: "⌘",
                    label: "Command",
                    held: model.heldModifiers.contains("cmd")
                ) {
                    model.toggleModifier("cmd")
                }
                drawerButton
            }
        }
    }

    private var drawerButton: some View {
        Button {
            withAnimation(NS.Motion.stateChange) { model.showHub.toggle() }
        } label: {
            Text("⋯")
                .font(NS.Font.mono(15))
                .foregroundStyle(NS.Color.text)
                .frame(width: NS.Metric.railButton, height: NS.Metric.railButton)
                .background(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .fill(NS.Color.raised2)
                )
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("hub")
        .accessibilityLabel("Commands")
    }

    private func railButton(
        glyph: String,
        label: String,
        held: Bool = false,
        enabled: Bool = true,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Text(glyph)
                .font(NS.Font.mono(15))
                .foregroundStyle(
                    held ? NS.Color.accent : (enabled ? NS.Color.text : NS.Color.textDisabled)
                )
                .frame(width: NS.Metric.railButton, height: NS.Metric.railButton)
                .background(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .fill(held ? NS.Color.accent.opacity(0.20) : NS.Color.chrome)
                )
                .overlay {
                    if held {
                        RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                            .stroke(NS.Color.accent, lineWidth: 1)
                    }
                }
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(label)
        .accessibilityAddTraits(held ? [.isButton, .isSelected] : .isButton)
    }

    // MARK: Landscape — a different instrument, not a stretched portrait

    private var landscapeLayout: some View {
        HStack(spacing: 0) {
            VStack(spacing: 0) {
            ZStack {
                VideoSurface(renderer: model.selectedRenderer)
                    .aspectRatio(pictureAspect, contentMode: .fit)
                    .scaleEffect(model.zoomScale, anchor: .center)
                    .offset(pan)
                    .clipped()
                // Amber ticks while the picture is frozen, exactly as in
                // portrait. Landscape held the live accent through a stall, so
                // the same frozen frame was marked healthy in one orientation
                // and degraded in the other.
                CornerTicks(color: frozenTint ?? NS.Color.accent.opacity(0.75))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .contentShape(Rectangle())
            .gesture(trackpadGesture)
            .simultaneousGesture(pinchGesture)
            // Two fingers scroll the Mac here as they do in portrait; moving
            // the picture is the pad mode's job.
            .background(
                TwoFingerPan(
                    onChange: {
                        if !isTwoFingerPanning {
                            isTwoFingerPanning = true
                            panStart = pan
                            lastScrollTravel = .zero
                        }
                        twoFingerDrag($0, ended: false)
                    },
                    onEnded: {
                        isTwoFingerPanning = false
                        twoFingerDrag(.zero, ended: true)
                    }
                )
            )
            .overlay(alignment: .bottomLeading) {
                HStack(spacing: 10) {
                    HStack(spacing: 6) {
                        // Derived, like the portrait strip's. This was a
                        // hard-coded green circle beside a hard-coded green
                        // caption, so a stalled, reconnecting or lost picture
                        // kept a healthy dot sitting on the frozen frame it was
                        // describing — and the word beside it already said
                        // STALLED. `ConditionDot` also brings the square a lost
                        // condition is owed, which a bare `Circle` cannot draw.
                        ConditionDot(
                            condition: streamCondition,
                            size: 5,
                            animated: !pictureIsLive
                        )
                        MonoCaps(liveLabel, size: 9, color: streamCondition.color, tracking: 1.4)
                    }
                    .videoChip()

                    VideoCaption(pictureCaption, size: 9, color: frozenTint ?? NS.Color.textSecondary)
                }
                .padding(.leading, 24)
                .padding(.bottom, 22)
            }

                padModeControl
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }

            landscapeDock
                .frame(width: 276)
        }
    }

    private var landscapeDock: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                MonoCaps("CONTROLS", size: 9, tracking: 2)
                Spacer()
                MonoCaps(
                    model.scrollLock ? "LOCK" : "FREE",
                    size: 9,
                    color: model.scrollLock ? NS.Color.accent : NS.Color.textTertiary,
                    tracking: 1.4
                )
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                Tile(glyph: "⌨", caption: "KEYS", spoken: "Keyboard") {
                    model.showKeyboard = true
                }
                Tile(glyph: "⛶", caption: "SHOT", spoken: "Screenshot the Mac") {
                    model.hub("shot")
                }
                Tile(glyph: "←", caption: "COPY", glyphSize: 13, spoken: "Copy from the Mac") {
                    model.hub("copy")
                }
                Tile(glyph: "→", caption: "PASTE", glyphSize: 13, spoken: "Paste to the Mac") {
                    model.hub("paste")
                }
            }

            HStack(spacing: 6) {
                ForEach(ModifierSpec.all, id: \.name) { spec in
                    KeyCap(
                        glyph: spec.glyph,
                        height: 46,
                        isHeld: model.heldModifiers.contains(spec.name),
                        fontSize: 13
                    ) {
                        model.toggleModifier(spec.name)
                    }
                }
            }

            Spacer()

            VStack(spacing: 9) {
                dockReadout("RTT", model.link.rttMillis.map { "\(Int($0)) MS" } ?? "—")
                dockReadout("RATE", String(format: "%.1f MB/S", model.link.downMbps))
                dockReadout("FRONTMOST", model.link.frontmostApp.isEmpty ? "—" : model.link.frontmostApp)
                HStack(spacing: 8) {
                    Button {
                        model.presented = .claude
                        model.listClaudeSessions()
                    } label: {
                        MonoCaps("CLAUDE", size: 10, color: NS.Color.accent, tracking: 1.4)
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                            .background(
                                RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                    .fill(NS.Color.accent.opacity(0.12))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                    .stroke(NS.Color.accent.opacity(0.4), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)

                    Button {
                        model.stopStream()
                    } label: {
                        Text("✕")
                            .font(NS.Font.mono(14))
                            .foregroundStyle(NS.Color.textSecondary)
                            .frame(width: 50, height: 50)
                            .background(
                                RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                                    .fill(NS.Color.raised)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 24)
        .frame(maxHeight: .infinity, alignment: .top)
        .background(NS.Color.screenGround)
    }

    private func dockReadout(_ label: String, _ value: String) -> some View {
        HStack {
            MonoCaps(label, size: 9, tracking: 1.2)
            Spacer()
            MonoCaps(value, size: 9, color: NS.Color.text, tracking: 1.2)
        }
    }

    // MARK: Gestures

    private var trackpadGesture: some Gesture {
        DragGesture(minimumDistance: 0)
            .onChanged { value in
                // SwiftUI's DragGesture cannot count fingers, so it also fires
                // while two are pinching. Without this the picture moved and
                // the Mac's pointer ran off at the same time.
                guard !isTwoFingerPanning else {
                    pointerOrigin = nil
                    cancelHold()
                    return
                }
                if pointerOrigin == nil {
                    pointerOrigin = value.startLocation
                    travelSincePress = 0
                    startHoldToDrag()
                }
                travelSincePress = hypot(value.translation.width, value.translation.height)
                if travelSincePress >= Self.tapSlop { cancelHold() }
                let previous = pointerOrigin ?? value.startLocation
                let dx = value.location.x - previous.x
                let dy = value.location.y - previous.y
                pointerOrigin = value.location

                switch padMode {
                case .pointer:
                    if isDragging {
                        model.drag("move", dx: dx, dy: dy)
                    } else {
                        model.movePointer(dx: dx, dy: dy)
                    }
                case .pan:
                    // The finger carries the picture, so it tracks the finger
                    // rather than nudging it.
                    pan = clampedPan(CGSize(
                        width: pan.width + dx,
                        height: pan.height + dy
                    ))
                }
            }
            .onEnded { value in
                let travel = hypot(
                    value.translation.width,
                    value.translation.height
                )
                // A short press that did not travel is a click, not a move —
                // unless two fingers were pinching, where lifting them must not
                // land a click, or the pad is moving the view rather than the
                // Mac's pointer.
                if travel < Self.tapSlop && !isDragging && !isTwoFingerPanning && padMode == .pointer {
                    model.click()
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
                if isDragging {
                    model.drag("end")
                    isDragging = false
                }
                cancelHold()
                pointerOrigin = nil
            }
    }

    /// Below this a press is a tap, not a travel.
    private static let tapSlop: CGFloat = 6
    /// How long a finger has to stay put before a slide becomes a drag. The same
    /// 450ms the browser client uses, so the two clients feel like one hand.
    private static let holdToDragSeconds: Double = 0.45

    private func startHoldToDrag() {
        holdToDrag?.cancel()
        holdToDrag = Task { @MainActor in
            try? await Task.sleep(for: .seconds(Self.holdToDragSeconds))
            guard !Task.isCancelled else { return }
            guard !isDragging, !isTwoFingerPanning, padMode == .pointer else { return }
            guard travelSincePress < Self.tapSlop else { return }
            isDragging = true
            model.drag("begin")
            // Heavier than a click: picking something up is a different act from
            // pressing it, and the finger is not looking at the screen it moved.
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
        }
    }

    private func cancelHold() {
        holdToDrag?.cancel()
        holdToDrag = nil
    }

    private var pinchGesture: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                // `pinchStart` used to be captured in `onEnded`, so the first
                // pinch of a session scaled from a stale value.
                if !isPinching {
                    isPinching = true
                    pinchStart = model.zoomScale
                    panStart = pan
                }

                withAnimation(.none) {
                    model.zoom(to: pinchStart * value.magnification)
                    // Keep whatever is under the fingers under the fingers, by
                    // moving the picture rather than moving the scale origin.
                    //
                    // Anchoring `scaleEffect` at the pinch point instead looks
                    // right for one gesture and then traps you: the anchor is
                    // also the point the offset is measured from, so panning
                    // away from it fights the zoom and the picture springs
                    // back. That is why only the first spot could be reached.
                    let ratio = model.zoomScale / pinchStart
                    let focal = CGPoint(
                        x: (value.startAnchor.x - 0.5) * pictureSize.width,
                        y: (value.startAnchor.y - 0.5) * pictureSize.height
                    )
                    pan = clampedPan(CGSize(
                        width: focal.x - (focal.x - panStart.width) * ratio,
                        height: focal.y - (focal.y - panStart.height) * ratio
                    ))
                    showZoomBadge = true
                }
            }
            .onEnded { _ in
                isPinching = false
                pinchStart = model.zoomScale
                panStart = pan
                withAnimation(NS.Motion.stateChange) { showZoomBadge = false }
            }
    }

    /// Two fingers move the view; one finger stays the trackpad. Below 1.0× the
    /// same gesture is a scroll wheel, which is what the legend has always
    /// claimed and nothing implemented.
    /// Two fingers now only ever scroll the Mac; moving the picture belongs to
    /// the pad mode. `travel` is the recognizer's translation measured from
    /// where the gesture began — cumulative, not per event.
    private func twoFingerDrag(_ travel: CGSize, ended: Bool) {
        if ended {
            lastScrollTravel = .zero
            return
        }

        // Scrolling wants the movement since the last event. Passing the
        // cumulative travel sent a bigger number every frame — the Mac got a
        // flood of ever-growing scrolls that ran away on its own.
        let step = CGSize(
            width: travel.width - lastScrollTravel.width,
            height: travel.height - lastScrollTravel.height
        )
        lastScrollTravel = travel
        guard step != .zero else { return }
        model.scroll(dx: step.width, dy: step.height)
    }

    /// Pointer or pan, sitting under the picture in both orientations.
    private var padModeControl: some View {
        HStack(spacing: 3) {
            padModeButton(
                .pointer,
                symbol: "cursorarrow",
                label: "POINTER",
                hint: "ONE FINGER MOVES THE MAC'S POINTER"
            )
            padModeButton(
                .pan,
                symbol: "arrow.up.and.down.and.arrow.left.and.right",
                label: "VIEW",
                hint: "ONE FINGER MOVES THE PICTURE"
            )
        }
        .padding(3)
        .frame(height: NS.Metric.railButton)
        .background(
            RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                .fill(NS.Color.chrome.opacity(0.92))
        )
    }

    private func padModeButton(
        _ mode: PadMode,
        symbol: String,
        label: String,
        hint: String
    ) -> some View {
        let selected = padMode == mode
        return Button {
            withAnimation(NS.Motion.stateChange) { padMode = mode }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            HStack(spacing: 6) {
                Image(systemName: symbol)
                    .font(.system(size: 12, weight: .medium))
                MonoCaps(
                    label,
                    size: 9,
                    color: selected ? NS.Color.accent : NS.Color.textTertiary,
                    tracking: 1
                )
            }
            .foregroundStyle(selected ? NS.Color.accent : NS.Color.textTertiary)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                    .fill(selected ? NS.Color.accent.opacity(0.16) : Color.clear)
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("padMode-\(mode.rawValue)")
        .accessibilityLabel(label)
        .accessibilityHint(hint)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    /// Stops the picture being dragged off its own glass: the travel available
    /// is exactly the overhang the zoom created.
    private func clampedPan(_ proposed: CGSize) -> CGSize {
        let scale = model.zoomScale
        guard scale > 1, pictureSize != .zero else { return .zero }
        let slackX = pictureSize.width * (scale - 1) / 2
        let slackY = pictureSize.height * (scale - 1) / 2
        return CGSize(
            width: min(max(proposed.width, -slackX), slackX),
            height: min(max(proposed.height, -slackY), slackY)
        )
    }

    private func applyOrientation(_ size: CGSize) {
        let landscape = size.width > size.height
        guard landscape != isLandscape else { return }
        isLandscape = landscape
        // The picture is re-framed completely by the rotation, so a pan
        // measured against the old frame means nothing — recentre instead of
        // carrying a stale offset into a differently shaped glass.
        pan = .zero
        panStart = .zero
    }

    private func resetView() {
        withAnimation(NS.Motion.stateChange) {
            model.resetZoom()
            pinchStart = 1
            isPinching = false
            pan = .zero
            panStart = .zero
        }
    }

    private func paneAspect(for display: DisplayEntry) -> CGFloat {
        if let config = model.videoConfigs.values.first(where: { $0.displayId == display.id }),
           config.height > 0 {
            return CGFloat(config.width) / CGFloat(config.height)
        }
        guard display.height > 0 else { return 16.0 / 10.0 }
        return CGFloat(display.width) / CGFloat(display.height)
    }

    /// Every write here invalidates the whole remote screen, so every write has
    /// to be worth a rebuild.
    ///
    /// It used to assign both values unconditionally once a second, which meant
    /// that while a 60fps stream was running — the most timing-sensitive state
    /// this app has — SwiftUI rebuilt the picture, the overlays, the zoom rail
    /// and the bottom bar every second to set two numbers that had not changed.
    /// It also awaited the socket actor for a queue depth that is only ever
    /// shown inside the reconnecting overlay.
    ///
    /// The second number it carried was a stall clock, and for a reconnect that
    /// clock was this view's own invention: the socket is gone, so nothing on
    /// the phone is measuring the age of anything. The age of the last frame now
    /// comes from the host's `stalled` report and from nowhere else, which
    /// leaves the queue depth as the one thing here worth a timer.
    private func queueTicker() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))

            // Only ask, and only redraw, when there is somewhere to show it.
            if picturePaused {
                let queued = await model.queuedInputCount
                if queued != queuedCount { queuedCount = queued }
            } else if queuedCount != 0 {
                queuedCount = 0
            }
        }
    }
}

struct ModifierSpec {
    let name: String
    let glyph: String
    let caption: String

    static let all: [ModifierSpec] = [
        ModifierSpec(name: "control", glyph: "⌃", caption: "CTRL"),
        ModifierSpec(name: "option", glyph: "⌥", caption: "OPT"),
        ModifierSpec(name: "shift", glyph: "⇧", caption: "SHIFT"),
        ModifierSpec(name: "cmd", glyph: "⌘", caption: "CMD"),
    ]
}
