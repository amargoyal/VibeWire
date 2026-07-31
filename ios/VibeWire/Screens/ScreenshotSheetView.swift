import SwiftUI

/// 03G · REMOTE — THE SHOT.
///
/// What comes back when SHOT is tapped, which until now was rendered by nothing
/// at all. The PNG arrived, went onto `UIPasteboard`, and raised a one-line
/// banner saying so; `lastScreenshot` was written and never read. The entire
/// result of the tile was a sentence about a picture, and the picture itself was
/// somewhere the user had to go and find.
///
/// The browser client has the other half of this — `web/src/app/App.tsx`,
/// `ScreenshotSheet` — and its reasoning is the part worth porting: show the
/// shot, offer the things that can actually be done with it, and name which of
/// them is likely to fail *before* it is tried, because writing an image to a
/// browser clipboard is refused more often than it is granted, and refused
/// silently.
///
/// The phone's constraints are different, so the sheet is different:
///
///  - **`UIPasteboard` does not refuse.** The shot is already on the clipboard
///    by the time this panel exists, so that is a fact to state, not a button to
///    offer. A COPY IMAGE control here would be a second spelling of something
///    that has already happened.
///  - **iOS has two destinations a browser does not**: the photo library, which
///    is where a shot goes when it needs to outlive the next copy, and the share
///    sheet, which is where it goes when it is meant for someone else. Those are
///    two different intents, so they are two controls.
///  - **The failure that has to be named here belongs to Photos.** Add-only
///    access can be refused, the refusal lands seconds after the tap, and until
///    it lands nothing on screen may claim the shot was saved.
///
/// ### It covers the picture, and this is the one thing allowed to
///
/// The Never-Cover-The-Picture Rule exists so that nothing answerable,
/// dismissable or ignorable sits over the Mac's screen — the drawer stops short
/// of the band, the stall card sits above the rail, the permission prompt is in
/// the transcript. This panel is the exception the rule is shaped around rather
/// than a breach of it: its content *is* the Mac's screen, at the full
/// resolution the display actually runs at, which is strictly more of the thing
/// the rule protects than the 1080/720/540 stream underneath it. A drawer-height
/// version of this — the shape that would obey the rule literally — draws a
/// 3456 × 2234 desktop about 150pt tall, which is the thumbnail the live picture
/// already is.
struct ScreenshotSheetView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.displayScale) private var displayScale

    /// Zoom and pan on the still, and the panel's own travel under a swipe.
    ///
    /// Every one of these is local to this view, and that is load-bearing rather
    /// than incidental: **nothing in this file calls a method on `AppModel` that
    /// reaches the Mac.** The remote view's pinch is `model.zoom(...)`, which
    /// sends a `zoom` message and scales a live picture; its one-finger drag is
    /// `model.movePointer(...)`, which steers the cursor. The same two gestures
    /// here move a still on this phone and nothing else. That is the difference
    /// the panel has to make unmistakable, and the strongest guarantee available
    /// is that the code path to the socket does not exist here.
    @State private var scale: CGFloat = 1
    @State private var scaleAtPinchStart: CGFloat = 1
    @State private var pan: CGSize = .zero
    @State private var panAtDragStart: CGSize = .zero
    @State private var isPinching = false
    @State private var isPanning = false
    /// The size of the box the still is drawn in, and the size the still is
    /// actually drawn at inside it. Both are needed: the first anchors a pinch's
    /// focal point, the second is what says how far the picture may travel and
    /// how far it is worth magnifying.
    @State private var viewport: CGSize = .zero
    @State private var drawnSize: CGSize = .zero
    @State private var sheetTravel: CGFloat = 0

    @State private var save: SaveState = .untried
    @State private var saver = PhotoSaver()

    /// Where the write to Photos has got to.
    ///
    /// Four values rather than a `Bool`, because the interesting part of this
    /// action is the two seconds between the tap and the answer. A control that
    /// went straight from "Save to Photos" to "Saved" would be stating an
    /// outcome nobody had measured yet.
    private enum SaveState: Equatable {
        case untried
        case writing
        case saved
        /// The library's own words, and whether they are a permission being
        /// refused — which is the one cause a second tap cannot fix.
        case refused(reason: String, isPermission: Bool)
    }

    var body: some View {
        // No image means no panel at all, not an empty one. `showScreenshot` is
        // only ever raised alongside a decoded image, so this is a guard rather
        // than a state — but an invisible scrim over the remote screen with
        // nothing on it would be a modal trap, and that is worth not being able
        // to reach.
        if let image = model.lastScreenshot {
            ZStack(alignment: .bottom) {
                // Tapping out closes, exactly as it does on the command drawer.
                // Near-transparent rather than a scrim: `NS.Color.scrim` is
                // spent on destructive confirmations, and this panel already
                // takes almost the whole glass, so there is nothing left to dim.
                //
                // It is also what keeps this sheet from fighting the remote
                // view underneath. The trackpad, the pinch and the two-finger
                // pan are attached to the portrait layout, which is a *sibling*
                // in `RemoteView`'s ZStack, not an ancestor of this one — so a
                // hit-testable layer over it takes the touch and those gestures
                // never see it.
                Color.black.opacity(0.001)
                    .ignoresSafeArea()
                    .contentShape(Rectangle())
                    .onTapGesture { close() }
                    .accessibilityLabel("Close the screenshot")

                panel(image)
                    // Enough of the remote screen left showing that this reads
                    // as a panel over it rather than as a screen of its own,
                    // which is what the 28pt top corners are already saying.
                    .padding(.top, 28)
                    .offset(y: sheetTravel)
                    .transition(NS.Motion.rise(reduced: reduceMotion))
            }
        }
    }

    // MARK: The panel

    private func panel(_ image: UIImage) -> some View {
        VStack(spacing: 0) {
            header
            still(image).padding(.top, 12)
            actions(image).padding(.top, 14)
            outcome.padding(.top, 10)
        }
        .padding(.horizontal, 16)
        .padding(.top, 12)
        .padding(.bottom, 16)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
            UnevenRoundedRectangle(
                topLeadingRadius: NS.Metric.radiusDrawer,
                topTrailingRadius: NS.Metric.radiusDrawer
            )
            .fill(NS.Color.raised)
        )
        .padding(.horizontal, 8)
        .accessibilityAddTraits(.isModal)
        .accessibilityLabel("Screenshot of the Mac")
    }

    /// The grabber, the heading and the way out — and the region that owns the
    /// swipe.
    ///
    /// Every sheet in this app can be swiped down, and this one has a picture
    /// under the header that owns one-finger drags for panning. One finger
    /// cannot mean two things on the same pixels, so the swipe lives here, where
    /// the grabber already claims it. Below, the picture takes the same swipe
    /// only while it is at fit and has nothing to pan.
    private var header: some View {
        VStack(spacing: 12) {
            Grabber()

            HStack {
                SectionLabel("SCREENSHOT")
                Spacer()
                SheetDismiss { close() }
            }
        }
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .gesture(swipeToDismiss)
    }

    // MARK: The still

    /// The shot, on the deep ground pictures sit on everywhere else.
    ///
    /// **On the thumbnail problem.** A 3456 × 2234 display drawn to fit a phone
    /// is about a ninth of its native size, and menu bar text at a ninth is not
    /// text. Shrinking it to fit and stopping there would make this panel a
    /// larger copy of the live picture it is drawn over, which is not worth
    /// covering the live picture for — the reason to take a shot at all is that
    /// the stream, capped at 1080 and re-encoded, could not resolve something.
    /// So the still zooms, up to the point where its own pixels run out, and it
    /// pans while zoomed.
    ///
    /// **On the corner ticks.** The remote view marks the true edge of the
    /// captured pixels with four L-shaped strokes so a zoomed frame never reads
    /// as a cropped one. They are deliberately not here: the letterbox around an
    /// aspect-fit still already shows exactly where the picture ends, the chips
    /// sit in the two corners the ticks would occupy, and inset far enough to
    /// clear them they would cost a third of the picture's height in landscape.
    /// The zoom readout carries what they would have said.
    private func still(_ image: UIImage) -> some View {
        GeometryReader { proxy in
            Image(uiImage: image)
                .resizable()
                .interpolation(.high)
                .aspectRatio(contentMode: .fit)
                // Measured before the scale is applied, so this is the size the
                // picture occupies at 1.0× — which is what both the pan clamp
                // and the zoom ceiling are computed against.
                .background(
                    GeometryReader { inner in
                        Color.clear
                            .onAppear { drawnSize = inner.size }
                            .onChange(of: inner.size) { _, size in drawnSize = size }
                    }
                )
                .scaleEffect(scale, anchor: .center)
                .offset(pan)
                .frame(width: proxy.size.width, height: proxy.size.height)
                .clipped()
                .accessibilityLabel("The Mac's screen at the moment the shot was taken")
                .onAppear { viewport = proxy.size }
                .onChange(of: proxy.size) { _, size in viewport = size }
        }
        .background(
            RoundedRectangle(cornerRadius: NS.Metric.radiusCard).fill(NS.Color.deepGround)
        )
        .clipShape(RoundedRectangle(cornerRadius: NS.Metric.radiusCard))
        .contentShape(Rectangle())
        .gesture(dragOnStill)
        .simultaneousGesture(pinchOnStill)
        // The same double-tap that fits the picture on the remote screen, so the
        // one gesture this panel shares with it means the same thing in both.
        .onTapGesture(count: 2) { fit() }
        .overlay(alignment: .bottomLeading) { geometryChip(image).padding(10) }
        .overlay(alignment: .bottomTrailing) { zoomChip.padding(10) }
        .frame(maxHeight: .infinity)
    }

    /// What this file is, in the terms the machine reported it: which screen it
    /// came off, its real pixel count, and its format. The dimensions are read
    /// from the image rather than from the display entry, because the image is
    /// the thing on screen and the display list is a separate report that can be
    /// a frame behind it.
    private func geometryChip(_ image: UIImage) -> some View {
        VideoCaption(shotGeometry(image))
    }

    private func shotGeometry(_ image: UIImage) -> String {
        let pixels = "\(Int(image.size.width * image.scale)) × \(Int(image.size.height * image.scale))"
        guard let display = model.displays.first(where: \.selected) else {
            return "\(pixels) · PNG"
        }
        return "\(display.name.uppercased()) · \(pixels) · PNG"
    }

    /// The scale, in the spelling the remote view's caption row already uses —
    /// violet once the reader has zoomed, because a zoom is the user's own doing
    /// and nothing the Mac did. It carries the gesture that is available next,
    /// so the panel never needs a teaching line that is true only on first use.
    private var zoomChip: some View {
        VideoCaption(
            isZoomed
                ? String(format: "%.1f× · DOUBLE-TAP FITS", scale)
                : "1.0× · PINCH TO ZOOM",
            color: isZoomed ? NS.Color.accent : NS.Color.textSecondary
        )
    }

    private var isZoomed: Bool { scale > 1.02 }

    /// Where the zoom stops.
    ///
    /// Past the point at which one captured pixel covers one device pixel there
    /// is nothing further to reveal — only the same pixels drawn bigger — so
    /// that is the ceiling, computed from the file's own size and this screen's
    /// scale rather than from a number picked to feel generous. Floored at 2×,
    /// because a shot of a small display can already be at its limit while still
    /// being smaller than the reader would like it.
    private var maxScale: CGFloat {
        guard let image = model.lastScreenshot, drawnSize.width > 0 else { return 2 }
        let nativePixels = image.size.width * image.scale
        let oneToOne = nativePixels / max(drawnSize.width * displayScale, 1)
        return min(8, max(2, oneToOne))
    }

    // MARK: Gestures

    private var pinchOnStill: some Gesture {
        MagnifyGesture()
            .onChanged { value in
                if !isPinching {
                    isPinching = true
                    scaleAtPinchStart = scale
                    panAtDragStart = pan
                }
                withAnimation(.none) {
                    let proposed = min(max(scaleAtPinchStart * value.magnification, 1), maxScale)
                    let ratio = proposed / max(scaleAtPinchStart, 0.01)
                    scale = proposed
                    // Keep whatever is under the fingers under the fingers by
                    // moving the picture, not by moving the scale's anchor —
                    // the same correction the remote view carries, and for the
                    // same reason: an anchored `scaleEffect` is also where the
                    // offset is measured from, so panning away from it fights
                    // the zoom and only the first spot is ever reachable.
                    let focal = CGPoint(
                        x: (value.startAnchor.x - 0.5) * viewport.width,
                        y: (value.startAnchor.y - 0.5) * viewport.height
                    )
                    pan = clamped(CGSize(
                        width: focal.x - (focal.x - panAtDragStart.width) * ratio,
                        height: focal.y - (focal.y - panAtDragStart.height) * ratio
                    ))
                }
            }
            .onEnded { _ in
                isPinching = false
                scaleAtPinchStart = scale
                panAtDragStart = pan
            }
    }

    /// One finger on the still: it moves the picture while there is more picture
    /// than box, and puts the panel away when there is not.
    private var dragOnStill: some Gesture {
        DragGesture(minimumDistance: 4)
            .onChanged { value in
                // SwiftUI's `DragGesture` cannot count fingers, so it fires
                // while two are pinching as well.
                guard !isPinching else { return }
                if isZoomed {
                    if !isPanning {
                        isPanning = true
                        panAtDragStart = pan
                    }
                    pan = clamped(CGSize(
                        width: panAtDragStart.width + value.translation.width,
                        height: panAtDragStart.height + value.translation.height
                    ))
                } else {
                    sheetTravel = max(0, value.translation.height)
                }
            }
            .onEnded { value in
                isPanning = false
                if isZoomed {
                    panAtDragStart = pan
                } else {
                    settle(value)
                }
            }
    }

    private var swipeToDismiss: some Gesture {
        DragGesture(minimumDistance: 8)
            .onChanged { sheetTravel = max(0, $0.translation.height) }
            .onEnded { settle($0) }
    }

    /// A flick counts as well as a long pull, so the panel can be thrown away
    /// with the same short gesture the system's own sheets take.
    private func settle(_ value: DragGesture.Value) {
        if value.translation.height > 90 || value.predictedEndTranslation.height > 180 {
            close()
        } else {
            withAnimation(NS.Motion.stateChange) { sheetTravel = 0 }
        }
    }

    /// The travel available is exactly the overhang the zoom created, so the
    /// picture cannot be dragged off its own box.
    private func clamped(_ proposed: CGSize) -> CGSize {
        guard scale > 1, drawnSize != .zero else { return .zero }
        let slackX = max(0, (drawnSize.width * scale - viewport.width) / 2)
        let slackY = max(0, (drawnSize.height * scale - viewport.height) / 2)
        return CGSize(
            width: min(max(proposed.width, -slackX), slackX),
            height: min(max(proposed.height, -slackY), slackY)
        )
    }

    private func fit() {
        withAnimation(NS.Motion.stateChange) {
            scale = 1
            scaleAtPinchStart = 1
            pan = .zero
            panAtDragStart = .zero
        }
    }

    private func close() {
        withAnimation(NS.Motion.stateChange) {
            sheetTravel = 0
            model.showScreenshot = false
        }
    }

    // MARK: What can be done with it

    /// Two controls, for two intents: keep it, or send it.
    ///
    /// The third destination is not here, and its absence is the decision. The
    /// shot went onto `UIPasteboard` the moment it arrived — `UIPasteboard` has
    /// no permission to refuse and no failure to report — so a COPY IMAGE button
    /// beside these two would be a control whose whole effect is to redo
    /// something already done. It is stated underneath instead, which is what it
    /// is: a fact, not an offer.
    private func actions(_ image: UIImage) -> some View {
        HStack(spacing: 9) {
            saveControl(image)
            shareControl(image)
        }
    }

    @ViewBuilder
    private func saveControl(_ image: UIImage) -> some View {
        switch save {
        case .untried:
            // Violet: the reader is about to do something, and this app spends
            // violet on what the user does. 56pt, well clear of the floor.
            FilledAction(title: "Save to Photos", height: NS.Metric.secondaryAction) {
                beginSave(image)
            }

        case .writing:
            // Not a button and not a verdict. The first tap of a session raises
            // the system's own add-only prompt, which can sit here for as long
            // as it takes to read, and a control that had already flipped to
            // SAVED would be answering a question still on screen.
            verdict(
                glyph: nil,
                text: "SAVING",
                ink: NS.Color.textSecondary,
                wash: NS.Color.raised2,
                spoken: "Saving to Photos"
            )

        case .saved:
            // Jade, in the same job it does on a completed tool call: the
            // library took it. Whether the library took it is a fact about the
            // machine, which is the side of the split-voice rule jade is on.
            verdict(
                glyph: "✓",
                text: "SAVED TO PHOTOS",
                ink: NS.Color.green,
                wash: NS.Color.green.opacity(0.10),
                spoken: "Saved to Photos"
            )

        case .refused:
            // Stated, and left stated. A refusal is not a button: if it was the
            // permission, iOS asks once and a second tap cannot re-ask; if it
            // was anything else, the shot is still on the clipboard and Share is
            // still right beside this. The sentence below carries the answer.
            verdict(
                glyph: "✕",
                text: "PHOTOS REFUSED",
                ink: NS.Color.red,
                wash: NS.Color.red.opacity(0.10),
                spoken: "Photos refused the save"
            )
        }
    }

    private func verdict(
        glyph: String?,
        text: String,
        ink: Color,
        wash: Color,
        spoken: String
    ) -> some View {
        HStack(spacing: 8) {
            if let glyph {
                Text(glyph).nsMono(12).foregroundStyle(ink)
            } else {
                Spinner(size: 13, color: ink)
            }
            MonoCaps(text, size: 10, color: ink)
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: NS.Metric.secondaryAction)
        .background(
            RoundedRectangle(cornerRadius: NS.Metric.radiusControl).fill(wash)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    /// The system share sheet, which is the one destination that reaches things
    /// this app has never heard of — a message, a note, another Mac over AirDrop.
    ///
    /// `ShareLink` is not a `Button`, so it cannot be an `OutlinedAction`; it
    /// takes the same treatment from the same tokens instead, at the same 56pt
    /// as the control beside it.
    private func shareControl(_ image: UIImage) -> some View {
        ShareLink(
            item: Image(uiImage: image),
            preview: SharePreview("\(model.hostName) screenshot", image: Image(uiImage: image))
        ) {
            MonoCaps("SHARE", size: 10, color: NS.Color.textSecondary)
                .frame(maxWidth: .infinity)
                .frame(minHeight: NS.Metric.secondaryAction)
                .overlay(
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .stroke(NS.Color.edge, lineWidth: NS.Metric.hairline)
                )
                // An outline is not a fill: without this only the caption's own
                // glyphs would answer a tap.
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Share this screenshot")
    }

    /// The line under the actions: either the third destination, stated, or the
    /// refusal, named.
    @ViewBuilder
    private var outcome: some View {
        switch save {
        case .refused(let reason, let isPermission):
            VStack(alignment: .leading, spacing: 8) {
                Text(refusal(isPermission: isPermission))
                    .nsSans(13)
                    .foregroundStyle(NS.Color.text)
                    .fixedSize(horizontal: false, vertical: true)

                // The library's own words, in mono because the machine wrote
                // them. Evidence, not the answer — the answer is the sentence
                // above it.
                Text(reason)
                    .nsMono(11)
                    .foregroundStyle(NS.Color.textSecondary)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)

        default:
            // Text Secondary rather than Text Faint: a faint all-caps line is
            // for a footnote repeating something already stated above, and this
            // is the only place the clipboard is mentioned at all.
            MonoCaps(
                "ALREADY ON THIS PHONE'S CLIPBOARD · PASTE IT ANYWHERE",
                size: 9,
                color: NS.Color.textSecondary,
                tracking: 1.2
            )
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    /// A refused permission and a failed write are two different answers, and
    /// only one of them has a switch behind it. Telling a reader whose library
    /// was simply unavailable to go and change a permission they already granted
    /// would be a wrong answer stated confidently, which is the defect this app
    /// has already paid for once.
    private func refusal(isPermission: Bool) -> String {
        if isPermission {
            return """
            Nothing reached Photos: this app has not been allowed to add to the \
            library, and iOS asks for that once. The switch is in Settings › \
            VibeWire › Photos. The shot is still on this phone's clipboard, and \
            Share can still send it.
            """
        }
        return """
        Nothing reached Photos. The shot is still on this phone's clipboard, and \
        Share can still send it.
        """
    }

    private func beginSave(_ image: UIImage) {
        guard save == .untried else { return }
        save = .writing
        saver.write(image) { error in
            guard let error else {
                save = .saved
                return
            }
            save = .refused(
                reason: error.localizedDescription,
                isPermission: PhotoSaver.isAccessRefusal(error)
            )
        }
    }
}

/// The object the photo library answers.
///
/// `UIImageWriteToSavedPhotosAlbum` reports through an Objective-C selector, so
/// whatever receives the verdict has to be an `NSObject` — a SwiftUI view is a
/// struct and cannot be one. This class exists for that and nothing else.
///
/// It is also the reason the sheet has a `writing` state at all: the call
/// returns immediately, long before the system has asked the reader anything, so
/// every claim made between the tap and this callback is a guess.
private final class PhotoSaver: NSObject {
    private var report: ((NSError?) -> Void)?

    func write(_ image: UIImage, then report: @escaping (NSError?) -> Void) {
        self.report = report
        UIImageWriteToSavedPhotosAlbum(
            image,
            self,
            #selector(finished(_:didFinishSavingWithError:contextInfo:)),
            nil
        )
    }

    /// Called on the main thread by UIKit once the write has either landed or
    /// been refused.
    @objc private func finished(
        _ image: UIImage,
        didFinishSavingWithError error: NSError?,
        contextInfo: UnsafeRawPointer?
    ) {
        let answer = report
        report = nil
        answer?(error)
    }

    /// Whether the library said no because it was not allowed to say yes.
    ///
    /// `UIImageWriteToSavedPhotosAlbum` predates PhotoKit and still answers a
    /// denied add-only permission in the assets-library domain on some systems
    /// and in PhotoKit's on others. Both are compared as strings so this file
    /// does not have to import Photos for one constant. Anything else — a full
    /// disk, an image the library will not take — falls through as a plain
    /// failure, which is a different sentence.
    static func isAccessRefusal(_ error: NSError) -> Bool {
        error.domain == "ALAssetsLibraryErrorDomain" || error.domain == "PHPhotosErrorDomain"
    }
}
