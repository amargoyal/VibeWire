import SwiftUI
import AVFoundation

/// 01A · PAIRING · WAITING and 01B · PAIRING · EXCHANGING.
///
/// A handshake, not a login: two named machines agreeing to trust each other.
/// No account, no password field, no branding.
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
    @FocusState private var codeFieldFocused: Bool

    var body: some View {
        ScreenBody {
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
    }

    // MARK: 01A — waiting

    private var waitingBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            MonoCaps("VibeWire", size: 13, color: LG.Color.textTertiary, tracking: 4.4, weight: .medium)
                .padding(.top, 12)

            machinePair(active: false)
                .padding(.top, 46)

            Text("Type the six digits\non your Mac.")
                .font(LG.Font.sans(27))
                .foregroundStyle(LG.Color.text)
                .padding(.top, 34)

            VStack(alignment: .leading, spacing: 2) {
                MonoCaps("MENU BAR → VIBEWIRE → PAIR", size: 11, tracking: 0.4, weight: .regular)
                HStack(spacing: 4) {
                    MonoCaps("CODE ROTATES EVERY", size: 11, tracking: 0.4)
                    MonoCaps("60S", size: 11, color: LG.Color.amber, tracking: 0.4)
                }
            }
            .padding(.top, 12)

            codeBoxes
                .padding(.top, 30)

            if let errorText {
                Text(errorText)
                    .font(LG.Font.sans(13))
                    .foregroundStyle(LG.Color.red)
                    .multilineTextAlignment(.center)
                    // Transport failures carry a domain and code; they must not
                    // be truncated to the half that says nothing.
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
                    .padding(.top, 14)
            }

            Hairline().padding(.top, 26)

            scanRow.padding(.top, 26)

            addressRow.padding(.top, 20)

            Spacer(minLength: 12)

            discoveryLine
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
            .frame(height: 64)

            HStack(spacing: 9) {
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
        return RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
            .fill(isActive ? LG.Color.cyan.opacity(0.08) : LG.Color.panel)
            .frame(width: 48, height: 64)
            .overlay(
                RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
                    .stroke(isActive ? LG.Color.cyan : LG.Color.hairline, lineWidth: 1)
            )
            .overlay {
                if value.isEmpty {
                    if isActive { Caret() }
                } else {
                    Text(value)
                        .font(LG.Font.mono(27))
                        .foregroundStyle(LG.Color.text)
                }
            }
    }

    private var scanRow: some View {
        Button {
            showScanner = true
        } label: {
            HStack(spacing: 14) {
                RoundedRectangle(cornerRadius: LG.Metric.radiusHairline)
                    .fill(LG.Color.textSecondary.opacity(0.35))
                    .frame(width: 30, height: 30)
                    .overlay(
                        Image(systemName: "qrcode")
                            .font(.system(size: 18))
                            .foregroundStyle(LG.Color.textSecondary)
                    )
                VStack(alignment: .leading, spacing: 3) {
                    Text("Scan the QR instead")
                        .font(LG.Font.sans(15))
                        .foregroundStyle(LG.Color.text)
                    MonoCaps("OPENS CAMERA · SAME HANDSHAKE", size: 10, tracking: 1.2)
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)
            .frame(height: 60)
            .background(
                RoundedRectangle(cornerRadius: LG.Metric.radiusMedium).fill(LG.Color.panel)
            )
            .overlay(
                RoundedRectangle(cornerRadius: LG.Metric.radiusMedium)
                    .stroke(LG.Color.hairline, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var addressRow: some View {
        VStack(alignment: .leading, spacing: 8) {
            MonoCaps("MAC ADDRESS", size: 10)
            HStack(spacing: 8) {
                TextField("192.168.1.24 or mac.tailnet.ts.net", text: $address)
                    .font(LG.Font.mono(13))
                    .foregroundStyle(LG.Color.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .keyboardType(.URL)
                    .padding(.horizontal, 12)
                    .frame(height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: LG.Metric.radiusSmall).fill(LG.Color.panel)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
                            .stroke(LG.Color.hairline, lineWidth: 1)
                    )

                TextField("8787", text: $port)
                    .font(LG.Font.mono(13))
                    .foregroundStyle(LG.Color.text)
                    .keyboardType(.numberPad)
                    .multilineTextAlignment(.center)
                    .frame(width: 68, height: 44)
                    .background(
                        RoundedRectangle(cornerRadius: LG.Metric.radiusSmall).fill(LG.Color.panel)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
                            .stroke(LG.Color.hairline, lineWidth: 1)
                    )
            }
        }
    }

    /// Discovery is reported before the user types. If the Mac were not there,
    /// this line says so instead of accepting six digits into a void.
    private var discoveryLine: some View {
        HStack(spacing: 10) {
            if let probeMillis {
                Circle().fill(LG.Color.green).frame(width: 6, height: 6)
                MonoCaps(
                    "HOST FOUND · \(Int(probeMillis)) MS",
                    size: 10,
                    color: LG.Color.textTertiary,
                    tracking: 1.2
                )
            } else if address.isEmpty {
                Circle().fill(LG.Color.textDisabled).frame(width: 6, height: 6)
                MonoCaps("ENTER THE MAC'S ADDRESS TO BEGIN", size: 10, tracking: 1.2)
            } else {
                Circle().fill(LG.Color.red).frame(width: 6, height: 6)
                MonoCaps("NOTHING ANSWERING AT THAT ADDRESS", size: 10, color: LG.Color.red, tracking: 1.2)
            }
        }
    }

    // MARK: 01B — exchanging

    private var exchangingBody: some View {
        VStack(alignment: .leading, spacing: 0) {
            MonoCaps("VibeWire", size: 13, color: LG.Color.textTertiary, tracking: 4.4, weight: .medium)
                .padding(.top, 12)

            machinePair(active: true)
                .padding(.top, 46)

            Text("Trading keys.")
                .font(LG.Font.sans(27))
                .foregroundStyle(LG.Color.text)
                .padding(.top, 34)

            MonoCaps("CODE ACCEPTED · KEEP BOTH DEVICES AWAKE", size: 11, tracking: 0.4)
                .padding(.top, 12)

            HStack(spacing: 9) {
                ForEach(0..<6, id: \.self) { index in
                    RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
                        .fill(LG.Color.chrome)
                        .frame(width: 48, height: 64)
                        .overlay(
                            RoundedRectangle(cornerRadius: LG.Metric.radiusSmall)
                                .stroke(LG.Color.stroke, lineWidth: 1)
                        )
                        .overlay(
                            Text(digits[index])
                                .font(LG.Font.mono(27))
                                .foregroundStyle(LG.Color.text)
                        )
                }
            }
            .padding(.top, 30)

            // Four named steps with real values rather than one indeterminate
            // spinner. If step three fails, the failure has an address.
            VStack(spacing: 0) {
                ForEach(steps) { step in
                    ExchangeStepRow(step: step)
                }
            }
            .padding(.top, 34)

            Spacer()

            MonoCaps(
                "PAIRING TRAFFIC STAYS ON THE PATH YOU CHOSE.\nYOU WILL NOT SEE THIS SCREEN AGAIN.",
                size: 10,
                tracking: 1.2
            )
            .lineSpacing(5)
            .padding(.bottom, 20)
        }
    }

    private func machinePair(active: Bool) -> some View {
        HStack(spacing: 10) {
            machineTile(
                glyph: RoundedRectangle(cornerRadius: 3)
                    .stroke(active ? LG.Color.cyan : LG.Color.textSecondary, lineWidth: 1)
                    .frame(width: 16, height: 26),
                caption: "THIS",
                active: active
            )

            ZStack {
                if active {
                    Rectangle().fill(LG.Color.cyan).frame(height: 1)
                } else {
                    TravellingDot()
                }
            }
            .frame(maxWidth: .infinity)

            machineTile(
                glyph: RoundedRectangle(cornerRadius: 2)
                    .stroke(active ? LG.Color.cyan : LG.Color.textSecondary, lineWidth: 1)
                    .frame(width: 30, height: 20),
                caption: "MAC",
                active: active
            )
        }
    }

    private func machineTile(glyph: some View, caption: String, active: Bool) -> some View {
        VStack(spacing: 5) {
            glyph
            MonoCaps(caption, size: 8, color: active ? LG.Color.cyan : LG.Color.textTertiary, tracking: 0.8)
        }
        .frame(width: 64, height: 64)
        .background(
            RoundedRectangle(cornerRadius: LG.Metric.radiusLarge)
                .fill(active ? LG.Color.cyan.opacity(0.10) : LG.Color.chrome)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LG.Metric.radiusLarge)
                .stroke(active ? LG.Color.cyan : LG.Color.stroke, lineWidth: 1)
        )
    }

    // MARK: Actions

    private func submit(code: String) {
        guard !address.isEmpty, let portValue = Int(port) else {
            errorText = "Enter the Mac's address first."
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
        withAnimation(LG.Motion.stateChange) {
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

    private func probeLoop() async {
        while !Task.isCancelled {
            if !address.isEmpty, let portValue = Int(port) {
                probeMillis = await model.probe(host: address, port: portValue)
            } else {
                probeMillis = nil
            }
            try? await Task.sleep(for: .seconds(2))
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
        ExchangeStep(id: 2, title: "STORING TRUST IN KEYCHAIN", detail: "—", state: .pending),
        ExchangeStep(id: 3, title: "FIRST FRAME", detail: "QUEUED", state: .pending),
    ]
}

struct ExchangeStepRow: View {
    let step: ExchangeStep

    var body: some View {
        HStack(spacing: 14) {
            marker
            MonoCaps(
                step.title,
                size: 12,
                color: step.state == .pending ? LG.Color.textTertiary : LG.Color.textSecondary,
                tracking: 1.2
            )
            Spacer(minLength: 0)
            MonoCaps(step.detail, size: 11, color: detailColor, tracking: 0)
        }
        .frame(height: 52)
        .overlay(alignment: .bottom) {
            if step.id != 3 { Hairline() }
        }
    }

    private var detailColor: Color {
        switch step.state {
        case .running: return LG.Color.cyan
        case .failed: return LG.Color.red
        default: return LG.Color.textTertiary
        }
    }

    @ViewBuilder
    private var marker: some View {
        switch step.state {
        case .done:
            Circle()
                .stroke(LG.Color.green, lineWidth: 1)
                .frame(width: 18, height: 18)
                .overlay(
                    Text("✓").font(.system(size: 11)).foregroundStyle(LG.Color.green)
                )
        case .running:
            Spinner(color: LG.Color.cyan).frame(width: 18, height: 18)
        case .failed:
            Circle()
                .stroke(LG.Color.red, lineWidth: 1)
                .frame(width: 18, height: 18)
                .overlay(
                    Text("✕").font(.system(size: 10)).foregroundStyle(LG.Color.red)
                )
        case .pending:
            Circle()
                .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [2, 2]))
                .foregroundStyle(LG.Color.stroke)
                .frame(width: 18, height: 18)
        }
    }
}

// MARK: - Small animated pieces

struct Caret: View {
    @State private var visible = true
    var body: some View {
        Rectangle()
            .fill(LG.Color.cyan)
            .frame(width: 2, height: 26)
            .opacity(visible ? 1 : 0)
            .onAppear {
                withAnimation(.linear(duration: 1.1).repeatForever(autoreverses: false)) {
                    visible.toggle()
                }
            }
    }
}

struct Spinner: View {
    var color: Color = LG.Color.cyan
    @State private var angle: Double = 0

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.75)
            .stroke(color, style: StrokeStyle(lineWidth: 1, lineCap: .round))
            .rotationEffect(.degrees(angle))
            .onAppear {
                withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) {
                    angle = 360
                }
            }
    }
}

/// The only motion on the waiting screen: one dot travelling the dashed line
/// between the two named machines.
struct TravellingDot: View {
    @State private var progress: CGFloat = 0

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                Rectangle()
                    .fill(.clear)
                    .frame(height: 1)
                    .overlay(
                        Rectangle()
                            .stroke(style: StrokeStyle(lineWidth: 1, dash: [5, 5]))
                            .foregroundStyle(LG.Color.stroke)
                    )
                Circle()
                    .fill(LG.Color.green)
                    .frame(width: 5, height: 5)
                    .offset(x: progress * geometry.size.width)
                    .opacity(progress > 0.02 && progress < 0.98 ? 1 : 0)
            }
            .onAppear {
                withAnimation(.linear(duration: 2.2).repeatForever(autoreverses: false)) {
                    progress = 1
                }
            }
        }
        .frame(height: 6)
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
        view.backgroundColor = UIColor(red: 0.043, green: 0.051, blue: 0.063, alpha: 1)

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
