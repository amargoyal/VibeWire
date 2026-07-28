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
    @State private var showTeachingOverlay = true
    @State private var pinchStart: CGFloat = 1
    @State private var showZoomBadge = false
    @State private var stallSeconds = 0

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
                LG.Color.deepGround.ignoresSafeArea()

                if isLandscape {
                    landscapeLayout
                } else {
                    portraitLayout(in: geometry)
                }

                // 03D — the stall overlay sits above the frozen picture.
                if case .stalled = model.streamState { reconnectingOverlay }
                if case .reconnecting = model.streamState { reconnectingOverlay }

                if model.showHub { ControlHubView() }
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
        .task { await stallTicker() }
        .onAppear {
            // The teaching overlay retires after three sessions; the corner
            // ticks and cursor halo stay forever.
            showTeachingOverlay = model.sessionCount <= 3
        }
    }

    // MARK: Portrait

    private func portraitLayout(in geometry: GeometryProxy) -> some View {
        VStack(spacing: 0) {
            statusStrip
                .padding(.horizontal, 18)
                .frame(height: 40)

            if model.displays.count > 1 {
                displayTabs.padding(.horizontal, 18).padding(.top, 6)
            }

            Spacer(minLength: 0)

            if model.sideBySide {
                sideBySidePanes
            } else {
                picture
            }

            padModeControl
                .padding(.horizontal, 18)
                .padding(.top, 12)

            Spacer(minLength: 0)

            // The hub's own arc and its "swipe the thumb" hint land on exactly
            // this strip, so with both up the two captions overlapped and
            // neither could be read.
            if showTeachingOverlay && model.streamState == .live && !model.sideBySide && !model.showHub {
                teachingLegend.padding(.bottom, 24)
            }

            bottomBar.frame(height: 96)
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
        .overlay(alignment: .trailing) {
            zoomRail.padding(.trailing, 20)
        }
        .overlay {
            if showZoomBadge { zoomBadge }
        }
        .overlay(alignment: .top) {
            if showTeachingOverlay && !model.sideBySide { trackpadBoundary }
        }
    }

    private var statusStrip: some View {
        HStack {
            HStack(spacing: 7) {
                ConditionDot(
                    condition: model.link.condition,
                    size: 6,
                    // Nothing decorative moves next to a live video feed.
                    animated: model.streamState != .live
                )
                MonoCaps(liveLabel, size: 10, color: model.link.condition.color, tracking: 1.4)
            }
            Spacer()
            MonoCaps(codecLabel, size: 10, tracking: 1.4)
        }
    }

    private var liveLabel: String {
        switch model.streamState {
        case .live:
            return "LIVE \(model.link.rttMillis.map { String(Int($0)) } ?? "—")MS"
        case .starting: return "OPENING"
        case .stalled: return "STALLED \(stallSeconds).0S"
        case .reconnecting(let attempt, _): return "RECONNECTING · TRY \(attempt)"
        case .stopped: return "STOPPED"
        case .failed: return "LOST"
        }
    }

    private var codecLabel: String {
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
            CornerTicks(color: stallTint ?? LG.Color.cyan.opacity(0.75))

            if model.streamState == .starting {
                Spinner(color: LG.Color.cyan).frame(width: 24, height: 24)
            }
        }
        .overlay(alignment: .bottomLeading) {
            VideoCaption(pictureCaption, color: stallTint ?? LG.Color.textSecondary)
                .padding(.leading, 10)
                .padding(.bottom, 26)
                // The hub's hint text sits on this exact line, and two 8pt
                // captions on top of each other read as neither.
                .opacity(model.showHub ? 0 : 1)
        }
    }

    private var pictureAspect: CGFloat {
        guard let config = model.videoConfigs.values.first, config.height > 0 else {
            return 16.0 / 10.0
        }
        return CGFloat(config.width) / CGFloat(config.height)
    }

    private var pictureCaption: String {
        if case .stalled = model.streamState {
            return "LAST GOOD FRAME"
        }
        guard let display = model.displays.first(where: \.selected) else { return "" }
        return "\(display.name.uppercased()) · \(display.width) × \(display.height) · LIVE"
    }

    /// Amber ticks and caption while stalled: the frozen frame keeps its
    /// geometry but stops claiming to be live.
    private var stallTint: Color? {
        if case .stalled = model.streamState { return LG.Color.amber.opacity(0.7) }
        if case .reconnecting = model.streamState { return LG.Color.amber.opacity(0.7) }
        return nil
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
                        CornerTicks(color: LG.Color.cyan.opacity(0.8))
                    }
                }
                .overlay(alignment: .bottomLeading) {
                    HStack(spacing: 8) {
                        if model.inputPane == index {
                            // Cyan at 16% over video was the same unverifiable
                            // bet the captions were making, and this badge is
                            // the one that says where input lands.
                            MonoCaps("INPUT HERE", size: 9, color: LG.Color.cyan, tracking: 1.4)
                                .videoChip()
                                .overlay(Rectangle().stroke(LG.Color.cyan.opacity(0.5), lineWidth: 1))
                        }
                        VideoCaption(
                            model.inputPane == index
                                ? "\(display.name.uppercased()) · \(display.width) × \(display.height)"
                                : "\(display.name.uppercased()) · TAP TO TAKE INPUT",
                            // The unfocused pane is dimmed by its own opacity
                            // already; taking the text down as well stacked two
                            // reductions on one caption.
                            color: LG.Color.textSecondary
                        )
                    }
                    .padding(.leading, 10)
                    .padding(.bottom, 20)
                }
                .onTapGesture {
                    withAnimation(LG.Motion.stateChange) {
                        model.inputPane = index
                        model.selectDisplay(display.id)
                    }
                }
            }
        }
    }

    // MARK: Overlays

    /// Reaches past the video into the bands, so the pad is visibly bigger than
    /// the picture.
    private var trackpadBoundary: some View {
        RoundedRectangle(cornerRadius: 14)
            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [5, 5]))
            .foregroundStyle(LG.Color.cyan.opacity(0.28))
            .padding(.horizontal, 10)
            .padding(.top, 150)
            .padding(.bottom, 96)
            .overlay(alignment: .topLeading) {
                MonoCaps("TRACKPAD", size: 9, color: LG.Color.cyan.opacity(0.7), tracking: 1.8)
                    .padding(.horizontal, 8)
                    .background(LG.Color.deepGround)
                    .offset(x: 30, y: 142)
            }
            .overlay(alignment: .bottomTrailing) {
                MonoCaps("TAP = CLICK", size: 9, color: LG.Color.cyan.opacity(0.5), tracking: 1.8)
                    .padding(.horizontal, 8)
                    .background(LG.Color.deepGround)
                    .offset(x: -30, y: -88)
            }
            .allowsHitTesting(false)
    }

    private var teachingLegend: some View {
        VStack(spacing: 12) {
            BreathingRing()
            MonoCaps(
                "MOVE ANYWHERE ON THE GLASS\nTWO FINGERS SCROLL · PINCH ZOOMS",
                size: 10,
                tracking: 1.6
            )
            .multilineTextAlignment(.center)
            .lineSpacing(6)
        }
        .allowsHitTesting(false)
    }

    private var zoomRail: some View {
        HStack(spacing: 8) {
            MonoCaps(
                model.zoomScale > 1.02
                    ? String(format: "%.1f×", model.zoomScale)
                    : "1.0× FIT",
                size: 10,
                color: model.zoomScale > 1.02 ? LG.Color.cyan : LG.Color.textSecondary,
                tracking: 1
            )
            ZStack(alignment: .bottom) {
                Capsule().fill(Color(hex: 0x1E242C)).frame(width: 3, height: 128)
                Capsule()
                    .fill(LG.Color.cyan.opacity(0.5))
                    .frame(width: 3, height: max(2, (model.zoomScale - 1) / 5 * 128))
                Rectangle()
                    .fill(LG.Color.cyan)
                    .frame(width: 11, height: 2)
                    .offset(y: -max(0, (model.zoomScale - 1) / 5 * 128))
            }
            .frame(width: 11, height: 128)
        }
        .allowsHitTesting(false)
    }

    /// The scale reads out big in the middle, where the eye already is.
    private var zoomBadge: some View {
        VStack(spacing: 6) {
            Text(String(format: "%.1f×", model.zoomScale))
                .font(LG.Font.mono(46, weight: .medium))
                .foregroundStyle(LG.Color.text)
            MonoCaps("HOLD TO LOCK · DOUBLE-TAP FITS", size: 10, color: LG.Color.cyan, tracking: 2)
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
                    .fill(LG.Color.deepGround.opacity(0.8))
                    .frame(width: 78, height: 49)
                    .overlay(Rectangle().stroke(LG.Color.stroke, lineWidth: 1))
                Rectangle()
                    .fill(LG.Color.cyan.opacity(0.16))
                    .frame(width: 78 / model.zoomScale, height: 49 / model.zoomScale)
                    .overlay(Rectangle().stroke(LG.Color.cyan, lineWidth: 1))
            }
            MonoCaps(
                model.displays.first(where: \.selected).map { "\($0.name.uppercased()) REGION" } ?? "REGION",
                size: 9,
                tracking: 1.2
            )
        }
        .allowsHitTesting(false)
    }

    /// A stall looks like a stall: it says how old the picture is, that input is
    /// queued rather than lost, and when it will stop trying.
    private var reconnectingOverlay: some View {
        VStack {
            Spacer()
            Panel(tint: LG.Color.amber) {
                VStack(alignment: .leading, spacing: 0) {
                    HStack(spacing: 10) {
                        Spinner(color: LG.Color.amber).frame(width: 16, height: 16)
                        MonoCaps("RECONNECTING", size: 12, color: LG.Color.amber, weight: .medium)
                    }

                    Text("The picture above is \(stallSeconds).0 seconds old. Keys and taps are being held, not dropped.")
                        .font(LG.Font.sans(15))
                        .foregroundStyle(LG.Color.text)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.top, 12)

                    VStack(spacing: 8) {
                        overlayRow("QUEUED INPUT", "\(queuedCount) EVENTS", LG.Color.text)
                        overlayRow("DROPPING TO", "540P ON RESUME", LG.Color.amber)
                        overlayRow("GIVING UP AT", "30S", LG.Color.text)
                    }
                    .padding(.top, 14)
                }
                .padding(18)
            }
            .padding(.horizontal, 18)
            .padding(.bottom, 108)
        }
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

    private var bottomBar: some View {
        HStack {
            Button {
                model.stopStream()
            } label: {
                Group {
                    if case .stalled = model.streamState {
                        HStack(spacing: 10) {
                            Text("✕").font(LG.Font.mono(15))
                            MonoCaps("STOP TRYING", size: 11, color: LG.Color.textSecondary, tracking: 1.2)
                        }
                        .padding(.horizontal, 20)
                        .frame(height: LG.Metric.hubButton)
                    } else {
                        Text("✕")
                            .font(LG.Font.mono(17))
                            .frame(width: LG.Metric.hubButton, height: LG.Metric.hubButton)
                    }
                }
                .foregroundStyle(LG.Color.textSecondary)
                .background(Capsule().fill(LG.Color.chrome.opacity(0.86)))
                .overlay(Capsule().stroke(LG.Color.hairline, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("stopStream")
            .accessibilityLabel(isStalled ? "Stop trying to reconnect" : "Stop streaming")

            Spacer()

            Button {
                withAnimation(LG.Motion.stateChange) { model.showHub.toggle() }
            } label: {
                HubGlyph(active: model.showHub)
                    .frame(width: LG.Metric.hubButton, height: LG.Metric.hubButton)
                    .background(Circle().fill(LG.Color.chrome.opacity(0.92)))
                    .overlay(Circle().stroke(LG.Color.stroke, lineWidth: 1))
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("hub")
            .accessibilityLabel("Control hub")
        }
        .padding(.horizontal, 20)
        .padding(.top, 0)
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
                CornerTicks(color: LG.Color.cyan.opacity(0.75))
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
                        Circle().fill(LG.Color.green).frame(width: 5, height: 5)
                        MonoCaps(liveLabel, size: 9, color: LG.Color.green, tracking: 1.4)
                    }
                    .videoChip()

                    VideoCaption(pictureCaption, size: 9)
                }
                .padding(.leading, 24)
                .padding(.bottom, 22)
            }

                padModeControl
                    .padding(.horizontal, 24)
                    .padding(.bottom, 12)
            }

            landscapeDock
                .frame(width: 231)
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
                    color: model.scrollLock ? LG.Color.cyan : LG.Color.textTertiary,
                    tracking: 1.4
                )
            }

            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                dockButton("⌨ KEYS") { model.showKeyboard = true }
                dockButton("⛶ SHOT") { model.hub("shot") }
                dockButton("COPY ←") { model.hub("copy") }
                dockButton("PASTE →") { model.hub("paste") }
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
                Hairline(color: LG.Color.chrome)
                HStack(spacing: 8) {
                    Button {
                        model.route = .claude
                        model.listClaudeSessions()
                    } label: {
                        MonoCaps("CLAUDE", size: 10, color: LG.Color.cyan, tracking: 1.2)
                            .frame(maxWidth: .infinity)
                            .frame(height: 50)
                            .background(
                                RoundedRectangle(cornerRadius: 8).fill(LG.Color.cyan.opacity(0.10))
                            )
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(LG.Color.cyan.opacity(0.4), lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)

                    Button {
                        model.stopStream()
                    } label: {
                        Text("✕")
                            .font(LG.Font.mono(15))
                            .foregroundStyle(LG.Color.textSecondary)
                            .frame(width: 50, height: 50)
                            .background(RoundedRectangle(cornerRadius: 8).fill(LG.Color.chrome))
                            .overlay(
                                RoundedRectangle(cornerRadius: 8)
                                    .stroke(LG.Color.hairline, lineWidth: 1)
                            )
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.horizontal, 22)
        .padding(.vertical, 22)
        .overlay(alignment: .leading) {
            Rectangle().fill(LG.Color.chrome).frame(width: 1)
        }
    }

    private func dockButton(_ title: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            MonoCaps(title, size: 10, color: LG.Color.text, tracking: 0.8)
                .frame(maxWidth: .infinity)
                .frame(height: 50)
                .background(RoundedRectangle(cornerRadius: 8).fill(LG.Color.chrome))
                .overlay(
                    RoundedRectangle(cornerRadius: 8).stroke(LG.Color.hairline, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private func dockReadout(_ label: String, _ value: String) -> some View {
        HStack {
            MonoCaps(label, size: 9, tracking: 1.2)
            Spacer()
            MonoCaps(value, size: 9, color: LG.Color.text, tracking: 1.2)
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
                    return
                }
                if pointerOrigin == nil {
                    pointerOrigin = value.startLocation
                }
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
                if travel < 6 && !isDragging && !isTwoFingerPanning && padMode == .pointer {
                    model.click()
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                }
                if isDragging {
                    model.drag("end")
                    isDragging = false
                }
                pointerOrigin = nil
            }
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
                withAnimation(LG.Motion.stateChange) { showZoomBadge = false }
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
        HStack(spacing: 8) {
            padModeButton(
                .pointer,
                symbol: "cursorarrow",
                label: "POINTER",
                hint: "ONE FINGER MOVES THE MAC'S POINTER"
            )
            padModeButton(
                .pan,
                symbol: "arrow.up.and.down.and.arrow.left.and.right",
                label: "MOVE VIEW",
                hint: "ONE FINGER MOVES THE PICTURE"
            )
        }
    }

    private func padModeButton(
        _ mode: PadMode,
        symbol: String,
        label: String,
        hint: String
    ) -> some View {
        let selected = padMode == mode
        return Button {
            withAnimation(LG.Motion.stateChange) { padMode = mode }
            UIImpactFeedbackGenerator(style: .light).impactOccurred()
        } label: {
            HStack(spacing: 7) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .medium))
                MonoCaps(
                    label,
                    size: 9,
                    color: selected ? LG.Color.cyan : LG.Color.textSecondary,
                    tracking: 1.2
                )
            }
            .foregroundStyle(selected ? LG.Color.cyan : LG.Color.textSecondary)
            .frame(maxWidth: .infinity)
            .frame(height: 40)
            .background(
                RoundedRectangle(cornerRadius: 8)
                    .fill(selected ? LG.Color.cyan.opacity(0.12) : Color.clear)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(
                        selected ? LG.Color.cyan.opacity(0.5) : LG.Color.hairline,
                        lineWidth: 1
                    )
            )
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("padMode-\(mode.rawValue)")
        .accessibilityLabel(label)
        .accessibilityHint(hint)
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
        withAnimation(LG.Motion.stateChange) {
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

    private func stallTicker() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            switch model.streamState {
            case .stalled(let millis):
                stallSeconds = millis / 1000
            case .reconnecting:
                stallSeconds += 1
            default:
                stallSeconds = 0
            }
            queuedCount = await model.queuedInputCount
        }
    }
}

// MARK: - Pieces

/// The corner ticks that mark the true edge of the captured pixels.
struct CornerTicks: View {
    var color: Color

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                tick(.topLeading, in: geometry)
                tick(.topTrailing, in: geometry)
                tick(.bottomLeading, in: geometry)
                tick(.bottomTrailing, in: geometry)
            }
        }
        .allowsHitTesting(false)
    }

    private func tick(_ corner: Alignment, in geometry: GeometryProxy) -> some View {
        let size: CGFloat = 11
        return Path { path in
            switch corner {
            case .topLeading:
                path.move(to: CGPoint(x: 0, y: size))
                path.addLine(to: .zero)
                path.addLine(to: CGPoint(x: size, y: 0))
            case .topTrailing:
                path.move(to: CGPoint(x: 0, y: 0))
                path.addLine(to: CGPoint(x: size, y: 0))
                path.addLine(to: CGPoint(x: size, y: size))
            case .bottomLeading:
                path.move(to: CGPoint(x: 0, y: 0))
                path.addLine(to: CGPoint(x: 0, y: size))
                path.addLine(to: CGPoint(x: size, y: size))
            default:
                path.move(to: CGPoint(x: size, y: 0))
                path.addLine(to: CGPoint(x: size, y: size))
                path.addLine(to: CGPoint(x: 0, y: size))
            }
        }
        .stroke(color, lineWidth: 1)
        .frame(width: size, height: size)
        .position(
            x: corner == .topLeading || corner == .bottomLeading ? 12 + size / 2
                : geometry.size.width - 12 - size / 2,
            y: corner == .topLeading || corner == .topTrailing ? 12 + size / 2
                : geometry.size.height - 12 - size / 2
        )
    }
}

/// The touch hint that retires after three sessions.
///
/// Scaling out from a point is the textbook Reduce Motion trigger, so with the
/// setting on the ring holds its outer position instead: two concentric circles
/// that still read as "a touch happens here", with the legend beside them
/// carrying the actual instruction.
struct BreathingRing: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false

    var body: some View {
        ZStack {
            Circle()
                .stroke(.white.opacity(0.22), lineWidth: 1)
                .frame(width: 30, height: 30)
            Circle()
                .stroke(.white.opacity(0.10), lineWidth: 1)
                .frame(width: 30, height: 30)
                .scaleEffect(reduceMotion ? 1.45 : (expanded ? 1.7 : 1))
                .opacity(reduceMotion ? 0.28 : (expanded ? 0 : 0.55))
        }
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeOut(duration: 2.8).repeatForever(autoreverses: false)) {
                expanded = true
            }
        }
    }
}

struct HubGlyph: View {
    var active: Bool

    var body: some View {
        VStack(spacing: 4) {
            ForEach(0..<3, id: \.self) { row in
                HStack(spacing: 4) {
                    ForEach(0..<3, id: \.self) { _ in
                        Circle()
                            .fill(row == 2 || active ? LG.Color.cyan : LG.Color.text)
                            .frame(width: 3, height: 3)
                    }
                }
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
