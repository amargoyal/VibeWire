import SwiftUI
import AVFoundation

/// 01 · PAIRING and 02 · EXCHANGING KEYS.
///
/// A handshake, not a login: two named machines agreeing to trust each other.
/// No account, no password field, no branding.
///
/// Nightshift restructured this screen more than any other. It used to be a
/// machine-pair graphic, six boxes, a scan button, two address fields and a
/// discovery line — five things competing to be read first, four of which are
/// usually already correct. It is now one hero and one target card: the six
/// digits are the whole top of the screen, and everything about *where* they are
/// being sent collapses into a single card that states the answer and offers
/// EDIT. The fields still exist; they are just no longer the first thing between
/// the user and the code they are holding in their head.
struct PairingView: View {
    @Environment(AppModel.self) private var model

    @State private var digits: [String] = Array(repeating: "", count: 6)
    @State private var focusedIndex = 0
    @State private var address = ""
    @State private var port = "8787"
    @State private var probeMillis: Double?
    @State private var isExchanging = false
    @State private var steps: [ExchangeStep] = ExchangeStep.initial
    @State private var errorText: String?
    @State private var showScanner = false
    @State private var editingTarget = false
    /// Where the dial's arc is, and nothing else. It is a second hand for the
    /// cadence, not a countdown on this particular code — see the caption it
    /// sits beside.
    @State private var dialPhase = 60
    @FocusState private var codeFieldFocused: Bool

    /// The host rotates the pairing code on this cadence, and the dial reports
    /// it.
    private static let rotationSeconds = 60

    var body: some View {
        ScreenBody(scrolls: true) {
            if isExchanging {
                exchangingBody
            } else {
                waitingBody
            }
        }
        .sheet(isPresented: $showScanner) {
            QRScannerView { payload in
                showScanner = false
                apply(scanned: payload)
            }
        }
        .task { await probeLoop() }
        .task { await rotationLoop() }
    }

    // MARK: 01 — waiting

    private var waitingBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            MonoCaps(
                "VibeWire",
                size: 11,
                color: NS.Color.textSecondary,
                tracking: 3.5,
                weight: .medium
            )
            .frame(minHeight: 34, alignment: .leading)

            DisplayTitle("Six digits\nfrom the menu bar.")
                .padding(.top, 44)

            MonoCaps("MENU BAR → VIBEWIRE → PAIR", size: 10, tracking: 1.6)
                .padding(.top, 14)

            codeBoxes.padding(.top, 34)

            // Nothing on this phone knows when the Mac last turned the code
            // over — the rotation phase is not on the wire — so `ROTATES IN 43S`
            // was this screen's own age modulo sixty, drawn in amber next to six
            // digits it might have been forty seconds wrong about.
            //
            // An exact second count is a claim; the cadence is a fact, and it is
            // the one the reader needs, because what it answers is how long to
            // keep looking at the Mac. The dial stays and turns on the same tick:
            // it reports the same cadence without pretending to know where in it
            // this moment sits.
            HStack(spacing: 9) {
                RotatesIn(fraction: Double(dialPhase) / Double(Self.rotationSeconds))
                MonoCaps(
                    "THE MAC ROTATES THIS CODE EVERY \(Self.rotationSeconds)S",
                    size: 9,
                    tracking: 1.4
                )
            }
            .padding(.top, 16)

            if let errorText {
                Text(errorText)
                    .nsSans(13)
                    .foregroundStyle(NS.Color.red)
                    // Transport failures carry a domain and code; they must not
                    // be truncated to the half that says nothing.
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.top, 16)
            }

            targetCard.padding(.top, 30)

            SectionLabel("OTHER WAYS IN").padding(.top, 26)

            scanRow.padding(.top, 10)

            Spacer(minLength: 16)

            MonoCaps(
                "NO ACCOUNT. NO PASSWORD.\nTHE MAC KEEPS A PUBLIC KEY AND NOTHING REPLAYABLE.",
                size: 9,
                color: NS.Color.textFaint,
                tracking: 1.4
            )
            .lineSpacing(5)
            .padding(.bottom, 20)
        }
    }

    private var codeBoxes: some View {
        ZStack {
            // A single hidden field owns the keyboard; the six boxes are only a
            // rendering of its contents. That keeps paste and delete behaving
            // the way they do everywhere else on iOS.
            TextField("", text: Binding(
                get: { digits.joined() },
                set: { newValue in
                    let filtered = String(newValue.filter(\.isNumber).prefix(6))
                    digits = (0..<6).map { index in
                        index < filtered.count
                            ? String(Array(filtered)[index])
                            : ""
                    }
                    focusedIndex = min(filtered.count, 5)
                    if filtered.count == 6 { submit(code: filtered) }
                }
            ))
            .keyboardType(.numberPad)
            .textContentType(.oneTimeCode)
            .focused($codeFieldFocused)
            .opacity(0.01)
            .frame(minHeight: 84)

            HStack(spacing: 8) {
                ForEach(0..<6, id: \.self) { index in
                    codeBox(index: index)
                }
            }
            .allowsHitTesting(false)
        }
        .contentShape(Rectangle())
        .onTapGesture { codeFieldFocused = true }
        .onAppear { codeFieldFocused = true }
    }

    private func codeBox(index: Int) -> some View {
        let isActive = index == focusedIndex && codeFieldFocused
        let value = digits[index]
        // The boxes take an equal share of whatever width is there: six fixed
        // boxes and five gaps overflowed the app's very first screen on the
        // narrowest phone it targets.
        return RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
            .fill(
                isActive
                    ? NS.Color.accent.opacity(0.12)
                    : (value.isEmpty ? NS.Color.raised : NS.Color.raised2)
            )
            .frame(maxWidth: .infinity)
            .frame(height: 84)
            .overlay {
                if isActive {
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .stroke(NS.Color.accent, lineWidth: 1.5)
                }
            }
            .overlay {
                if value.isEmpty {
                    if isActive { Caret(height: 30) }
                } else {
                    Text(value)
                        .nsMono(30)
                        .foregroundStyle(NS.Color.text)
                }
            }
    }

    /// Where the six digits are about to go.
    ///
    /// One card doing what a status line and two labelled fields used to do
    /// between them. Discovery is reported in its own header — if the Mac were
    /// not there, this says so rather than accepting six digits into a void —
    /// and the address is a value to read, not a field to fill, until EDIT says
    /// otherwise.
    private var targetCard: some View {
        Card {
            VStack(alignment: .leading, spacing: 11) {
                HStack(spacing: 9) {
                    Group {
                        if discovery.square {
                            Rectangle().fill(discovery.tone)
                        } else {
                            Circle().fill(discovery.tone)
                        }
                    }
                    .frame(width: 7, height: 7)

                    MonoCaps(
                        discovery.text,
                        size: 9,
                        color: discovery.tone,
                        tracking: 1.6,
                        weight: .medium
                    )
                    Spacer(minLength: 8)
                    Button {
                        withAnimation(NS.Motion.stateChange) { editingTarget.toggle() }
                    } label: {
                        MonoCaps(
                            editingTarget ? "DONE" : "EDIT",
                            size: 9,
                            color: NS.Color.accent,
                            tracking: 1.4
                        )
                        .padding(.horizontal, 10)
                        .frame(minHeight: NS.Metric.minimumTarget)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.vertical, -12)
                    .accessibilityLabel("Edit the Mac’s address")
                }

                if editingTarget {
                    HStack(spacing: 8) {
                        TextField("192.168.1.24 or mac.tailnet.ts.net", text: $address)
                            .nsMono(13)
                            .foregroundStyle(NS.Color.text)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                            .padding(.horizontal, 12)
                            .frame(minHeight: NS.Metric.minimumTarget)
                            .background(
                                RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                                    .fill(NS.Color.raised2)
                            )

                        TextField("8787", text: $port)
                            .nsMono(13)
                            .foregroundStyle(NS.Color.text)
                            .keyboardType(.numberPad)
                            .multilineTextAlignment(.center)
                            .frame(width: 72)
                            .frame(minHeight: NS.Metric.minimumTarget)
                            .background(
                                RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                                    .fill(NS.Color.raised2)
                            )
                    }
                } else {
                    Text(address.isEmpty ? "No address" : "\(address):\(port)")
                        .nsMono(14)
                        .foregroundStyle(NS.Color.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }

                MonoCaps("THE CODE AND THE KEYS GO TO THIS ADDRESS ONLY", size: 9, tracking: 1)
                    .lineSpacing(3)
            }
            .padding(.horizontal, 18)
            .padding(.top, 16)
            .padding(.bottom, 18)
        }
    }

    private var discovery: (text: String, tone: Color, square: Bool) {
        if let probeMillis {
            return ("HOST FOUND · \(Int(probeMillis)) MS", NS.Color.green, false)
        }
        if address.isEmpty {
            return ("NO ADDRESS YET", NS.Color.textTertiary, false)
        }
        return ("NOTHING ANSWERING", NS.Color.red, true)
    }

    private var scanRow: some View {
        Button {
            showScanner = true
        } label: {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: NS.Metric.radiusInner)
                    .fill(NS.Color.raised2)
                    .frame(width: 34, height: 34)
                    .overlay(
                        Image(systemName: "qrcode")
                            .font(.system(size: 17))
                            .foregroundStyle(NS.Color.textSecondary)
                    )
                VStack(alignment: .leading, spacing: 4) {
                    Text("Scan the QR on the Mac")
                        .nsSans(15, weight: .medium)
                        .tracking(-0.2)
                        .foregroundStyle(NS.Color.text)
                    MonoCaps("OPENS CAMERA · SAME HANDSHAKE", size: 9, tracking: 1)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .padding(.vertical, 12)
            .frame(minHeight: NS.Metric.primaryAction)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: NS.Metric.radiusCard).fill(NS.Color.raised)
            )
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Scan the QR code")
        .accessibilityHint("Opens the camera. Same handshake as typing the code.")
    }

    // MARK: 02 — exchanging

    /// Four named steps with real values rather than one indeterminate spinner.
    /// If step three fails, the failure has an address.
    ///
    /// The digits stay on screen and go dim: the code has been accepted and is
    /// no longer something to act on, but removing it mid-handshake makes the
    /// screen look like it started over.
    private var exchangingBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            MonoCaps(
                "VibeWire",
                size: 11,
                color: NS.Color.textSecondary,
                tracking: 3.5,
                weight: .medium
            )
            .frame(minHeight: 34, alignment: .leading)

            DisplayTitle("Trading keys.")
                .padding(.top, 44)

            MonoCaps("CODE ACCEPTED · KEEP BOTH DEVICES AWAKE", size: 10, tracking: 1.6)
                .padding(.top, 14)

            HStack(spacing: 8) {
                ForEach(0..<6, id: \.self) { index in
                    RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                        .fill(NS.Color.raised)
                        .frame(maxWidth: .infinity)
                        .frame(height: 84)
                        .overlay(
                            Text(digits[index])
                                .nsMono(30)
                                .foregroundStyle(NS.Color.textTertiary)
                        )
                }
            }
            .padding(.top, 34)

            VStack(spacing: NS.Metric.groupGap) {
                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                    ExchangeStepRow(
                        step: step,
                        position: GroupPosition.at(index, of: steps.count)
                    )
                }
            }
            .padding(.top, 34)

            Spacer(minLength: 16)

            MonoCaps(
                "PAIRING TRAFFIC STAYS ON THE PATH YOU CHOSE.\nYOU WILL NOT SEE THIS SCREEN AGAIN.",
                size: 9,
                color: NS.Color.textFaint,
                tracking: 1.4
            )
            .lineSpacing(5)
            .padding(.bottom, 20)
        }
    }

    // MARK: Actions

    private func submit(code: String) {
        // The field submits the moment it holds six digits, and a paste can
        // deliver six digits more than once. Pairing twice burns the code —
        // the second attempt arrives after the first has consumed it, and the
        // host answers `code_expired` for a code that was in fact correct.
        guard !isExchanging else { return }
        guard !address.isEmpty, let portValue = Int(port) else {
            errorText = "Enter the Mac's address first."
            editingTarget = true
            return
        }
        errorText = nil
        isExchanging = true
        steps = ExchangeStep.initial

        Task {
            advance(0, .done, detail: "\(Int(probeMillis ?? 0)) MS")
            advance(1, .running)

            let failure = await model.completePairing(host: address, port: portValue, code: code)

            if let failure {
                advance(1, .failed, detail: "FAILED")
                errorText = failure
                isExchanging = false
                digits = Array(repeating: "", count: 6)
                return
            }

            advance(1, .done, detail: "ED25519")
            advance(2, .running)
            try? await Task.sleep(for: .milliseconds(280))
            advance(2, .done, detail: "STORED")
            advance(3, .running, detail: "…")
        }
    }

    private func advance(_ index: Int, _ state: ExchangeStep.State, detail: String? = nil) {
        guard steps.indices.contains(index) else { return }
        withAnimation(NS.Motion.stateChange) {
            steps[index].state = state
            if let detail { steps[index].detail = detail }
        }
    }

    private func apply(scanned payload: String) {
        // vibewire://pair?host=…&port=…&code=…
        guard let components = URLComponents(string: payload) else { return }
        let items = components.queryItems ?? []
        if let host = items.first(where: { $0.name == "host" })?.value { address = host }
        if let scannedPort = items.first(where: { $0.name == "port" })?.value { port = scannedPort }
        if let code = items.first(where: { $0.name == "code" })?.value, code.count == 6 {
            digits = code.map(String.init)
            submit(code: code)
        }
    }

    /// Discovery is worth a request every two seconds while someone is looking
    /// at the address field. It is not worth one during the handshake, where
    /// the same host is already answering on the same socket, and a probe
    /// landing mid-exchange only competes with it.
    private func probeLoop() async {
        while !Task.isCancelled {
            if isExchanging {
                try? await Task.sleep(for: .seconds(2))
                continue
            }
            if !address.isEmpty, let portValue = Int(port) {
                let millis = await model.probe(host: address, port: portValue)
                if millis != probeMillis { probeMillis = millis }
            } else if probeMillis != nil {
                probeMillis = nil
            }
            try? await Task.sleep(for: .seconds(2))
        }
    }

    /// Turns the dial at the cadence the host rotates on. Nothing is being
    /// counted down: the arc is a sixty-second sweep drawn beside a caption that
    /// states the cadence, and the phase it starts from is arbitrary because the
    /// real one is not on the wire.
    private func rotationLoop() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            guard !isExchanging else { continue }
            dialPhase = dialPhase <= 1 ? Self.rotationSeconds : dialPhase - 1
        }
    }
}

// MARK: - Exchange steps

struct ExchangeStep: Identifiable, Equatable {
    enum State { case pending, running, done, failed }

    let id: Int
    let title: String
    var detail: String
    var state: State

    static let initial: [ExchangeStep] = [
        ExchangeStep(id: 0, title: "HOST VERIFIED", detail: "—", state: .pending),
        ExchangeStep(id: 1, title: "KEYS EXCHANGED", detail: "—", state: .pending),
        ExchangeStep(id: 2, title: "STORING TRUST", detail: "KEYCHAIN", state: .pending),
        ExchangeStep(id: 3, title: "FIRST FRAME", detail: "QUEUED", state: .pending),
    ]

    var timelineState: TimelineState {
        switch state {
        case .pending: return .pending
        case .running: return .running
        case .done: return .done
        case .failed: return .failed
        }
    }
}

struct ExchangeStepRow: View {
    let step: ExchangeStep
    let position: GroupPosition

    var body: some View {
        HStack(spacing: 14) {
            TimelineMark(state: step.timelineState, size: 20, ground: .clear)
            MonoCaps(
                step.title,
                size: 11,
                color: titleColor,
                tracking: 1.2
            )
            Spacer(minLength: 8)
            MonoCaps(step.detail, size: 10, color: detailColor, tracking: 0)
        }
        .padding(.horizontal, 18)
        .frame(minHeight: 64)
        .groupedRow(
            position,
            background: step.state == .running
                ? NS.Color.accent.opacity(0.10)
                : NS.Color.raised
        )
    }

    private var titleColor: Color {
        switch step.state {
        case .pending: return NS.Color.textTertiary
        case .running: return NS.Color.text
        default: return NS.Color.textSecondary
        }
    }

    private var detailColor: Color {
        switch step.state {
        case .running: return NS.Color.accent
        case .failed: return NS.Color.red
        case .done: return NS.Color.textSecondary
        case .pending: return NS.Color.textFaint
        }
    }
}

// MARK: - QR scanner

struct QRScannerView: UIViewControllerRepresentable {
    let onScan: (String) -> Void

    func makeUIViewController(context: Context) -> QRScannerController {
        let controller = QRScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ uiViewController: QRScannerController, context: Context) {}
}

final class QRScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: ((String) -> Void)?
    private let session = AVCaptureSession()

    override func viewDidLoad() {
        super.viewDidLoad()
        // The Nightshift `deep`, so the camera sheet arrives on the same ground
        // as the rest of the app rather than on a black rectangle.
        view.backgroundColor = UIColor(red: 0.024, green: 0.027, blue: 0.039, alpha: 1)

        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input)
        else { return }

        session.addInput(input)

        let output = AVCaptureMetadataOutput()
        guard session.canAddOutput(output) else { return }
        session.addOutput(output)
        output.setMetadataObjectsDelegate(self, queue: .main)
        output.metadataObjectTypes = [.qr]

        let preview = AVCaptureVideoPreviewLayer(session: session)
        preview.frame = view.bounds
        preview.videoGravity = .resizeAspectFill
        view.layer.addSublayer(preview)

        Task.detached { [session] in session.startRunning() }
    }

    override func viewWillDisappear(_ animated: Bool) {
        super.viewWillDisappear(animated)
        session.stopRunning()
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard let object = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
              let value = object.stringValue
        else { return }
        session.stopRunning()
        onScan?(value)
    }
}
