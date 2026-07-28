import SwiftUI

/// 06A · CLAUDE · CHAT, 06B · CLAUDE CODE · RUNNING, 06C · DIFF + PERMISSION.
///
/// A sheet over the picture, because it acts on the Mac being looked at. No
/// bubbles: prose is prose, machine output is monospace in a gutter, and
/// everything the agent touched is a row that can be opened.
struct ClaudePanelView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var draft = ""
    @State private var filesExpanded = false
    @State private var showSessionPicker = false
    @State private var permissionAge = 0
    @FocusState private var composerFocused: Bool

    var body: some View {
        ScreenBody(background: LG.Color.screenGround) {
            VStack(spacing: 0) {
                grabber
                modeSegment.padding(.top, 4)

                if model.claudeMode == .code { sessionHeader.padding(.top, 12) }

                transcript

                if !suggestions.isEmpty && model.claudeMode == .chat {
                    suggestionChips.padding(.top, 12)
                }

                composer.padding(.top, 12)
            }
            .padding(.bottom, 8)
        }
        .overlay(alignment: .bottom) {
            if let permission = model.permission {
                PermissionSheet(request: permission, waited: permissionAge)
            }
        }
        // The sheet is a bottom overlay, so with the keyboard up it arrives
        // underneath it: a tool sits waiting on an answer the user cannot see
        // or reach. Typing gives way to the question.
        .onChange(of: model.permission == nil) { _, noPermission in
            if !noPermission {
                composerFocused = false
                // The sheet arrives at the bottom of a scrolling transcript, so
                // sighted users get it in their peripheral vision and VoiceOver
                // users got nothing at all — while a tool sat waiting on them.
                if let request = model.permission {
                    AccessibilityNotification
                        .Announcement("Claude is asking to run \(request.command)")
                        .post()
                }
            }
        }
        .sheet(isPresented: $showSessionPicker) {
            SessionPicker()
        }
        .task {
            model.listClaudeSessions()
            await ageTicker()
        }
    }

    // MARK: Chrome

    /// The panel is a real sheet now, so the capsule and the drag-past-60pt
    /// gesture that used to live here are the system's — including the pull
    /// between half height and full, which the hand-rolled version could not
    /// offer at all. What is left is the one thing the system does not know:
    /// which Mac this is talking to, and how far away it is.
    private var grabber: some View {
        HStack {
            MonoCaps(
                "● \(model.displays.first(where: \.selected)?.name.uppercased() ?? "MAC") · \(model.link.rttMillis.map { "\(Int($0))MS" } ?? "—")",
                size: 9,
                color: LG.Color.green,
                tracking: 1.4
            )
            // One line: this is a status caption, and wrapping it pushed
            // the round trip figure onto a second row.
            .lineLimit(1)
            .truncationMode(.tail)

            Spacer(minLength: 8)

            Button {
                dismiss()
            } label: {
                MonoCaps("DONE", size: 9, color: LG.Color.cyan, tracking: 1.4)
                    .padding(.horizontal, 10)
                    .frame(minHeight: LG.Metric.minimumTarget)
                    // Hit testing follows the drawn glyphs, so without this
                    // only the strokes of 9pt letters were tappable and the
                    // gaps between them were not — the same trap the three
                    // dots menu fell into.
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("closePanel")
            .accessibilityLabel("Close Claude panel")
        }
        .padding(.top, 6)
    }

    private var modeSegment: some View {
        Segmented(
            options: [
                (value: AppModel.ClaudeMode.chat, label: "CHAT", badge: nil),
                (
                    value: AppModel.ClaudeMode.code,
                    label: "CODE",
                    badge: model.claudeSessionId != nil ? LG.Color.green : nil
                ),
            ],
            selection: Binding(
                get: { model.claudeMode },
                // The segmented control writes its binding on every tap, not
                // only on a change. Re-opening tears down the running CLI and
                // starts another, which is what put two `claude` processes
                // 400ms apart in the host log and left the session unusable.
                set: { mode in
                    guard mode != model.claudeMode else { return }
                    // The terminal owns the mode of a live session, and
                    // re-opening here would quietly detach from it and start a
                    // private conversation instead — messages would stop
                    // reaching the terminal with nothing to say they had.
                    guard !model.claudeIsLive else { return }
                    model.openClaude(mode: mode)
                }
            )
        )
    }

    /// The session's real working directory and branch, straight from the CLI.
    private var sessionHeader: some View {
        Button {
            showSessionPicker = true
        } label: {
            VStack(alignment: .leading, spacing: 7) {
                HStack {
                    Text(shortPath(model.claudeCwd))
                        .font(LG.Font.mono(10))
                        .foregroundStyle(LG.Color.text)
                        .lineLimit(1)
                        .truncationMode(.head)
                    Spacer(minLength: 8)
                    if let branch = model.claudeBranch {
                        MonoCaps(branch, size: 10, color: LG.Color.green, tracking: 0.8)
                    }
                }
                HStack {
                    MonoCaps(subheaderLeft, size: 9, tracking: 1.2)
                    Spacer(minLength: 8)
                    MonoCaps(subheaderRight, size: 9, tracking: 1.2)
                }
            }
            .padding(.horizontal, 13)
            .padding(.vertical, 11)
            .background(RoundedRectangle(cornerRadius: 8).fill(LG.Color.raised))
            .overlay(
                RoundedRectangle(cornerRadius: 8).stroke(LG.Color.hairlineDim, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var subheaderLeft: String {
        // Which conversation this is, is the one thing worth stating plainly:
        // a private session and the terminal's session look identical here
        // otherwise, and only one of them shows up on the Mac.
        if model.claudeIsLive { return "LIVE · SHARED WITH YOUR TERMINAL" }
        if model.claudeOpening { return "STARTING · SEND A MESSAGE TO BEGIN" }
        guard model.claudeSessionId != nil else { return "NO SESSION · TAP TO PICK" }
        // The subscription flag is the load-bearing fact: it is what proves
        // this is not quietly billing per token.
        return model.claudeUsingSubscription == true ? "SUBSCRIPTION · NO API KEY" : "SESSION OPEN"
    }

    private var subheaderRight: String {
        let running = model.toolCalls.filter { $0.state == .running }.count
        if running > 0 { return "\(model.changedFiles.count) FILES · \(running) TOOLS RUNNING" }
        if let opened = model.claudeOpenedAt {
            let elapsed = Int(Date().timeIntervalSince(opened))
            return "\(elapsed / 60)M \(elapsed % 60)S"
        }
        return ""
    }

    private func shortPath(_ path: String) -> String {
        path.replacingOccurrences(of: NSHomeDirectory(), with: "~")
    }

    // MARK: Transcript

    private var transcript: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 20) {
                    if isEmptyTranscript && showsModePitch { emptyState }

                    ForEach(model.claudeTurns) { turn in
                        turnView(turn)
                    }

                    // Tool calls collapse to one 44pt line each — verb, target,
                    // duration — so twenty stay skimmable at arm's length.
                    if !model.toolCalls.isEmpty { toolLedger }

                    if !model.changedFiles.isEmpty { fileList }

                    if model.claudeStreaming { streamingIndicator }

                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.top, 22)
            }
            .onChange(of: model.claudeTurns.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: model.toolCalls.count) { _, _ in
                withAnimation { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private var isEmptyTranscript: Bool {
        model.claudeTurns.isEmpty && model.toolCalls.isEmpty && !model.claudeStreaming
    }

    /// Once a session is open or opening, the pitch for the mode has done its
    /// job — showing "pick a session" over a session that is already starting
    /// contradicts the header directly above it.
    private var showsModePitch: Bool {
        !hasSomewhereToSend
    }

    /// The panel opened to a full screen of nothing, with the only explanation
    /// a nine-point caption at the very top. This says what the two modes are
    /// for and gives the one tap that starts either.
    private var emptyState: some View {
        VStack(spacing: 14) {
            MonoCaps(
                model.claudeMode == .chat ? "CHAT" : "CODE",
                size: 10,
                color: LG.Color.cyan,
                tracking: 1.8
            )

            Text(model.claudeMode == .chat
                 ? "Ask about this Mac. Nothing is edited."
                 : "Run Claude Code in a folder on the Mac.")
                .font(LG.Font.sans(19))
                .foregroundStyle(LG.Color.textSecondary)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if model.claudeSessionId == nil {
                Button {
                    showSessionPicker = true
                } label: {
                    MonoCaps("PICK A SESSION", size: 11, color: LG.Color.cyan, tracking: 1.4)
                        .padding(.horizontal, 20)
                        .frame(height: 46)
                        .overlay(
                            RoundedRectangle(cornerRadius: 10)
                                .stroke(LG.Color.cyan.opacity(0.45), lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 32)
        .padding(.top, 60)
    }

    private func turnView(_ turn: ClaudeTurn) -> some View {
        VStack(alignment: .leading, spacing: turn.role == .user ? 7 : 9) {
            if turn.role == .user {
                MonoCaps("YOU · \(timeLabel(turn.at))", size: 9, tracking: 2)
                MarkdownText(turn.text, color: Color(hex: 0xC3C8D0))
            } else {
                HStack(spacing: 8) {
                    MonoCaps("CLAUDE", size: 9, color: LG.Color.cyan, tracking: 2)
                    Rectangle().fill(LG.Color.cyan.opacity(0.2)).frame(height: 1)
                }
                // Full measure width — no bubble tax on a 402pt screen.
                MarkdownText(turn.text)
            }
        }
    }

    private var toolLedger: some View {
        VStack(spacing: 1) {
            ForEach(model.toolCalls) { call in
                ToolRow(call: call)
            }
        }
        .background(LG.Color.chrome)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(
            RoundedRectangle(cornerRadius: 8).stroke(LG.Color.chrome, lineWidth: 1)
        )
    }

    /// Collapsed by default.
    ///
    /// This list lives inside the transcript, after the turns, and a branch
    /// with a dozen changed files is taller than the panel. The transcript
    /// scrolls to its bottom on every new turn, so the bottom was always this
    /// list — the conversation was pushed out of sight and sending a message
    /// appeared to do nothing. It is reference material, so it now sits behind
    /// one line until asked for.
    private var fileList: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(LG.Motion.stateChange) { filesExpanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    MonoCaps(
                        "\(model.changedFiles.count) CHANGED FILE\(model.changedFiles.count == 1 ? "" : "S")",
                        size: 9,
                        tracking: 1.6
                    )
                    MonoCaps(
                        filesExpanded ? "HIDE" : "SHOW · TAP FOR THE DIFF",
                        size: 9,
                        color: LG.Color.cyan,
                        tracking: 1.6
                    )
                    Spacer()
                }
                .frame(minHeight: 34)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("changedFiles")
            .accessibilityLabel("\(model.changedFiles.count) changed files")
            .accessibilityValue(filesExpanded ? "Expanded" : "Collapsed")

            if filesExpanded {
                VStack(spacing: 1) {
                    ForEach(model.changedFiles) { file in
                        Button {
                            model.openDiff(path: file.path)
                        } label: {
                            ChangedFileRow(file: file)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .background(LG.Color.chrome)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        // Attached here rather than beside the session picker: one view gets
        // one sheet, and a second `.sheet` on the same view is silently ignored.
        .sheet(isPresented: Binding(
            get: { model.diffPath != nil },
            set: { if !$0 { model.closeDiff() } }
        )) {
            DiffView()
        }
    }

    private var streamingIndicator: some View {
        HStack(spacing: 8) {
            Caret().frame(width: 2, height: 16)
            MonoCaps(
                model.claudeTokensPerSecond > 0
                    ? "STREAMING · \(model.claudeTokensPerSecond) TOK/S"
                    : "WORKING",
                size: 9,
                tracking: 1.6
            )
        }
    }

    /// Built once. `DateFormatter` init is one of the more expensive things in
    /// Foundation, and this was allocating a fresh one per turn per render of
    /// the transcript.
    private static let clock: DateFormatter = {
        let formatter = DateFormatter()
        formatter.dateFormat = "HH:mm"
        return formatter
    }()

    private func timeLabel(_ date: Date) -> String {
        Self.clock.string(from: date)
    }

    // MARK: Suggestions and composer

    /// Follow-ups as two thumb chips rather than another typing session.
    private var suggestions: [String] {
        guard model.claudeMode == .chat, !model.claudeStreaming,
              model.claudeTurns.last?.role == .assistant
        else { return [] }
        return ["What's eating my battery", "Show me the top processes"]
    }

    private var suggestionChips: some View {
        HStack(spacing: 8) {
            ForEach(suggestions, id: \.self) { suggestion in
                Button {
                    model.sendToClaude(suggestion)
                } label: {
                    MonoCaps(suggestion, size: 10, color: LG.Color.textSecondary, tracking: 1)
                        .padding(.horizontal, 14)
                        .frame(height: 44)
                        .overlay(Capsule().stroke(LG.Color.hairline, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            Spacer(minLength: 0)
        }
    }

    private var composer: some View {
        HStack(spacing: 10) {
            TextField(
                composerPrompt,
                text: $draft,
                axis: .vertical
            )
            .font(LG.Font.sans(15))
            .foregroundStyle(LG.Color.text)
            .focused($composerFocused)
            .lineLimit(1...4)
            .padding(.horizontal, 16)
            .padding(.vertical, 16)
            .background(RoundedRectangle(cornerRadius: LG.Metric.radiusLarge).fill(LG.Color.panel))
            .overlay(
                RoundedRectangle(cornerRadius: LG.Metric.radiusLarge)
                    .stroke(LG.Color.hairline, lineWidth: 1)
            )

            // Stop is a permanent red target while running: runaway agents are
            // the reason the phone came out.
            if model.claudeStreaming {
                Button {
                    model.interruptClaude()
                    UINotificationFeedbackGenerator().notificationOccurred(.warning)
                } label: {
                    VStack(spacing: 2) {
                        Rectangle().fill(LG.Color.red).frame(width: 12, height: 12)
                        MonoCaps("STOP", size: 9, color: LG.Color.red, tracking: 1)
                    }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Stop Claude")
                .accessibilityHint("Interrupts the run in progress.")
            } else {
                Button {
                    model.sendToClaude(draft)
                    draft = ""
                } label: {
                    Text("↑")
                        .font(LG.Font.mono(19))
                        .foregroundStyle(LG.Color.onCyan)
                        .frame(width: 56, height: 56)
                        .background(
                            RoundedRectangle(cornerRadius: LG.Metric.radiusLarge).fill(LG.Color.cyan)
                        )
                }
                .buttonStyle(.plain)
                .disabled(!canSend)
                .opacity(canSend ? 1 : 0.4)
                .accessibilityIdentifier("send")
                .accessibilityLabel("Send")
            }
        }
    }

    /// Sending with nothing open reached the host and came back as
    /// "no active session", which reads like a fault rather than a step not
    /// taken. The composer now says which step is missing and refuses to send.
    ///
    /// A brand new session counts as ready even though it has no id yet: the
    /// CLI stays silent until the first prompt, so the header asks for one, and
    /// gating on the id alone would block the very thing it asks for.
    private var hasSomewhereToSend: Bool {
        model.claudeSessionId != nil || model.claudeOpening
    }

    private var composerPrompt: String {
        guard hasSomewhereToSend else { return "Pick a session first…" }
        return model.claudeMode == .chat ? "Ask about this Mac…" : "Steer the session…"
    }

    private var canSend: Bool {
        guard hasSomewhereToSend else { return false }
        return !draft.trimmingCharacters(in: .whitespaces).isEmpty
    }

    /// A permission request is the only thing that shows this, and one is
    /// pending for a few seconds of a long session. Assigning it regardless
    /// rebuilt the transcript — the tallest view in the app — every second for
    /// the whole time the panel was open.
    private func ageTicker() async {
        while !Task.isCancelled {
            try? await Task.sleep(for: .seconds(1))
            let age = model.permission?.waitedSeconds ?? 0
            if age != permissionAge { permissionAge = age }
        }
    }
}

// MARK: - Rows

struct ToolRow: View {
    let call: ToolCall

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 10) {
                marker
                HStack(spacing: 4) {
                    Text(call.name)
                        .font(LG.Font.mono(11))
                        .foregroundStyle(call.state == .running ? LG.Color.text : LG.Color.textSecondary)
                    Text(call.target)
                        .font(LG.Font.mono(11))
                        .foregroundStyle(call.state == .running ? LG.Color.textSecondary : LG.Color.text)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
                Spacer(minLength: 8)
                MonoCaps(
                    call.milliseconds.map { formatDuration($0) } ?? "",
                    size: 9,
                    color: call.state == .running ? LG.Color.cyan : LG.Color.textTertiary,
                    tracking: 0
                )
            }
            .padding(.horizontal, 12)
            .frame(minHeight: 44)

            // Only the running one shows output.
            if call.state == .running, let preview = call.preview, !preview.isEmpty {
                Text(preview)
                    .font(LG.Font.mono(10))
                    .foregroundStyle(LG.Color.textTertiary)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 11)
            }
        }
        .background(call.state == .running ? LG.Color.screenGround : LG.Color.raised)
    }

    @ViewBuilder
    private var marker: some View {
        switch call.state {
        case .ok:
            Text("✓").font(LG.Font.mono(11)).foregroundStyle(LG.Color.green)
        case .error:
            Text("✕").font(LG.Font.mono(11)).foregroundStyle(LG.Color.red)
        case .running:
            Spinner(color: LG.Color.cyan).frame(width: 12, height: 12)
        }
    }

    private func formatDuration(_ milliseconds: Int) -> String {
        milliseconds < 1000
            ? "\(milliseconds)MS"
            : String(format: "%.1fS", Double(milliseconds) / 1000)
    }
}

/// File changes get counts and a four-bar ratio.
struct ChangedFileRow: View {
    let file: ChangedFile

    var body: some View {
        HStack(spacing: 10) {
            Text(file.status)
                .font(LG.Font.mono(10))
                .foregroundStyle(file.status == "A" ? LG.Color.green : LG.Color.amber)
            Text(file.path)
                .font(LG.Font.mono(11))
                .foregroundStyle(LG.Color.text)
                .lineLimit(1)
                .truncationMode(.head)
            Spacer(minLength: 8)
            if file.added > 0 {
                Text("+\(file.added)").font(LG.Font.mono(10)).foregroundStyle(LG.Color.green)
            }
            if file.removed > 0 {
                Text("−\(file.removed)").font(LG.Font.mono(10)).foregroundStyle(LG.Color.red)
            }
            ratioBars
        }
        .padding(12)
        .background(LG.Color.raised)
    }

    private var ratioBars: some View {
        let total = max(1, file.added + file.removed)
        let greenBars = Int((Double(file.added) / Double(total) * 4).rounded())
        return HStack(spacing: 2) {
            ForEach(0..<4, id: \.self) { index in
                Rectangle()
                    .fill(index < greenBars ? LG.Color.green : LG.Color.red)
                    .frame(width: 3, height: 12)
            }
        }
    }
}

// MARK: - 06C permission

/// The one thing only the user can do. States the command verbatim, what it
/// will destroy in plain units, and how long it has been waiting.
struct PermissionSheet: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let request: PermissionRequest
    let waited: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: 9) {
                Rectangle()
                    .fill(LG.Color.amber)
                    .frame(width: 7, height: 7)
                MonoCaps("WANTS TO RUN · PAUSED \(waited)S", size: 10, color: LG.Color.amber, tracking: 1.6)
            }
            .padding(.top, 14)
            .padding(.horizontal, 16)

            Text(request.command)
                .font(LG.Font.mono(12))
                .foregroundStyle(LG.Color.text)
                .lineSpacing(3)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(13)
                .background(RoundedRectangle(cornerRadius: 6).fill(LG.Color.deepGround))
                .overlay(
                    RoundedRectangle(cornerRadius: 6).stroke(LG.Color.hairlineDim, lineWidth: 1)
                )
                .padding(.horizontal, 16)
                .padding(.top, 12)

            Text(request.explanation)
                .font(LG.Font.sans(13))
                .foregroundStyle(LG.Color.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 16)
                .padding(.top, 12)

            VStack(spacing: 8) {
                Button {
                    model.answerPermission(allow: true, scope: "once")
                } label: {
                    Text("Allow once")
                        .font(LG.Font.sans(16, weight: .medium))
                        .foregroundStyle(LG.Color.onCyan)
                        .frame(maxWidth: .infinity)
                        .frame(minHeight: 56)
                        .background(RoundedRectangle(cornerRadius: 10).fill(LG.Color.cyan))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Runs this command once. You will be asked again next time.")

                // Deny gets its own full width row, and the standing grant is
                // moved away from it. These two used to sit side by side, the
                // same size, differing only in colour — so the tap that stops
                // a tool was one thumb's width from the tap that permanently
                // allows it, and only one of those can be taken back.
                SecondaryAction(
                    title: "DENY",
                    tint: LG.Color.red,
                    border: LG.Color.red.opacity(0.5)
                ) {
                    model.answerPermission(
                        allow: false,
                        scope: "once",
                        message: "Denied from the phone."
                    )
                }

                Button {
                    model.answerPermission(allow: true, scope: "always")
                } label: {
                    MonoCaps(
                        "ALWAYS ALLOW THIS HERE",
                        size: 9,
                        color: LG.Color.textTertiary,
                        tracking: 1.2
                    )
                    .frame(maxWidth: .infinity)
                    .frame(minHeight: LG.Metric.minimumTarget)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                // Visually demoted on purpose, and this is the one that cannot
                // be taken back — so the hint has to carry what the size does.
                .accessibilityLabel("Always allow this here")
                .accessibilityHint("Grants this command in this folder permanently. Cannot be undone from the phone.")
                .padding(.top, 2)
            }
            .padding(16)
        }
        .background(
            RoundedRectangle(cornerRadius: LG.Metric.radiusLarge).fill(LG.Color.raised)
        )
        .overlay(
            RoundedRectangle(cornerRadius: LG.Metric.radiusLarge)
                .stroke(LG.Color.amber.opacity(0.4), lineWidth: 1)
        )
        .padding(.horizontal, 18)
        .padding(.bottom, 20)
        .transition(LG.Motion.rise(reduced: reduceMotion))
        // A modal in fact if not in presentation: the agent is stopped until
        // this is answered, so the transcript behind it is not what to explore.
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
    }
}

// MARK: - Session picker

/// Real sessions from ~/.claude/projects, resumable by id.
struct SessionPicker: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        ScreenBody {
            VStack(alignment: .leading, spacing: 0) {
                HStack {
                    MonoCaps("RESUME A SESSION", size: 10, tracking: 2)
                    Spacer()
                    Button("Close") { dismiss() }
                        .font(LG.Font.mono(11))
                        .foregroundStyle(LG.Color.textSecondary)
                        .frame(height: 44)
                }
                .padding(.top, 24)

                // The picker could only resume, so a Mac with no sessions on it
                // was a dead end: the empty state said so and offered nothing.
                // The host already accepts an open without a session id.
                Button {
                    model.openClaude(mode: model.claudeMode)
                    dismiss()
                } label: {
                    HStack(spacing: 10) {
                        Text("+")
                            .font(LG.Font.mono(15))
                            .foregroundStyle(LG.Color.cyan)
                        MonoCaps("START A NEW SESSION", size: 11, color: LG.Color.cyan, tracking: 1.4)
                        Spacer()
                    }
                    .padding(.horizontal, 16)
                    .frame(height: 52)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(LG.Color.cyan.opacity(0.4), lineWidth: 1)
                    )
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("newSession")
                .padding(.top, 18)

                if model.claudeSessions.isEmpty {
                    MonoCaps("NO SESSIONS FOUND ON THE MAC", size: 11, tracking: 1.2)
                        .padding(.top, 24)
                }

                ScrollView {
                    LazyVStack(spacing: 8) {
                        ForEach(model.claudeSessions) { session in
                            Button {
                                model.openClaude(
                                    mode: .code,
                                    sessionId: session.id,
                                    cwd: session.cwd
                                )
                                dismiss()
                            } label: {
                                VStack(alignment: .leading, spacing: 6) {
                                    Text(session.summary)
                                        .font(LG.Font.sans(14))
                                        .foregroundStyle(LG.Color.text)
                                        .lineLimit(2)
                                        .multilineTextAlignment(.leading)
                                    HStack(spacing: 8) {
                                        MonoCaps(
                                            session.cwd
                                                .replacingOccurrences(of: NSHomeDirectory(), with: "~"),
                                            size: 9,
                                            tracking: 0.8
                                        )
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                        Spacer(minLength: 4)
                                        if let branch = session.gitBranch {
                                            MonoCaps(branch, size: 9, color: LG.Color.green, tracking: 0.8)
                                        }
                                        MonoCaps("\(session.messageCount) MSG", size: 9, tracking: 0.8)
                                    }
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(14)
                                .background(RoundedRectangle(cornerRadius: 8).fill(LG.Color.raised))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8)
                                        .stroke(LG.Color.hairlineDim, lineWidth: 1)
                                )
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    .padding(.top, 16)
                }

                PrimaryAction(
                    title: "New session",
                    detail: "STARTS IN THE LAST PROJECT",
                    glyph: "＋",
                    tint: LG.Color.cyan,
                    ink: LG.Color.onCyan
                ) {
                    model.openClaude(mode: .code)
                    dismiss()
                }
                .padding(.bottom, 24)
            }
        }
        .task { model.listClaudeSessions() }
    }
}
