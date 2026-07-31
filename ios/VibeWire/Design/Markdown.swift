import SwiftUI

/// Claude answers in Markdown, so the panel renders Markdown.
///
/// Not a full CommonMark implementation and not trying to be. SwiftUI's own
/// `AttributedString(markdown:)` handles inline spans well — bold, italic,
/// inline code, links — but flattens block structure: a fenced code block comes
/// out as one run-on paragraph with the backticks still in it, which is the
/// worst possible rendering for the thing you most want to read on a phone.
///
/// So: blocks are split here, inline spans are handed to the system parser, and
/// code gets the one treatment it actually needs — monospace, its own ground,
/// and horizontal scrolling instead of wrapping. Wrapped code is unreadable and
/// truncated code is a lie.
struct MarkdownText: View {
    let text: String
    var textColor: Color = NS.Color.text
    var size: CGFloat = 15

    /// An inline run has to be a `Text` — that is what lets a paragraph be one
    /// wrapping block rather than a stack of fragments — so these two cannot
    /// take the font as a modifier and read the reader's size themselves.
    @Environment(\.dynamicTypeSize) private var type

    init(_ text: String, color: Color = NS.Color.text, size: CGFloat = 15) {
        self.text = text
        self.textColor = color
        self.size = size
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(MarkdownBlock.parse(text).enumerated()), id: \.offset) { _, block in
                view(for: block)
            }
        }
    }

    @ViewBuilder
    private func view(for block: MarkdownBlock) -> some View {
        switch block {
        case .paragraph(let content):
            inline(content)
                .fixedSize(horizontal: false, vertical: true)
                .textSelection(.enabled)

        case .heading(let level, let content):
            inline(content, size: headingSize(level), weight: .semibold)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)

        case .code(let language, let body):
            CodeBlock(language: language, code: body)

        case .bullet(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("•")
                            .nsMono(size - 2)
                            .foregroundStyle(NS.Color.accent.opacity(0.8))
                        inline(item)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

        case .numbered(let items):
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    HStack(alignment: .top, spacing: 8) {
                        Text("\(index + 1).")
                            .nsMono(size - 3)
                            .foregroundStyle(NS.Color.accent.opacity(0.8))
                        inline(item)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

        case .quote(let content):
            HStack(alignment: .top, spacing: 10) {
                Rectangle()
                    .fill(NS.Color.accent.opacity(0.35))
                    .frame(width: 2)
                inline(content, color: NS.Color.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

        case .rule:
            Rectangle()
                .fill(NS.Color.hairlineDim)
                .frame(height: 1)
                .padding(.vertical, 2)
        }
    }

    private func inline(
        _ content: String,
        size overrideSize: CGFloat? = nil,
        weight: Font.Weight = .regular,
        color: Color? = nil
    ) -> Text {
        Text(Self.attributed(content, at: type))
            .font(NS.Font.sans(overrideSize ?? size, weight: weight, at: type))
            .foregroundStyle(color ?? textColor)
    }

    /// Inline spans only. `.inlineOnlyPreservingWhitespace` keeps the parser
    /// from swallowing the line structure this view has already resolved.
    static func attributed(_ content: String, at type: DynamicTypeSize) -> AttributedString {
        guard var attributed = try? AttributedString(
            markdown: content,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)
        ) else {
            return AttributedString(content)
        }

        // Inline code needs to look like code; the system parser marks the run
        // but leaves it styled as prose.
        for run in attributed.runs where run.inlinePresentationIntent == .code {
            attributed[run.range].font = NS.Font.mono(13, at: type)
            attributed[run.range].foregroundColor = NS.Color.accent
        }
        for run in attributed.runs where run.link != nil {
            attributed[run.range].underlineStyle = .single
            attributed[run.range].foregroundColor = NS.Color.accent
        }
        return attributed
    }

    private func headingSize(_ level: Int) -> CGFloat {
        switch level {
        case 1: return size + 6
        case 2: return size + 3
        default: return size + 1
        }
    }
}

/// Monospace, own ground, scrolls sideways. Copy button, because the reason to
/// look at a command on a phone is usually to run it somewhere else.
private struct CodeBlock: View {
    let language: String?
    let code: String

    /// What the last tap did, which is an event and not a condition.
    ///
    /// This used to be set true and never cleared, so the chip read COPIED for
    /// the rest of the session — reporting the last tap anyone made rather than
    /// what this control would do now, which is the one thing a label on a
    /// button is for. It goes back to offering the copy on its own.
    @State private var copied = false
    @State private var clearing: Task<Void, Never>?

    /// How long the chip states its answer before returning to COPY. Long
    /// enough to be read after the thumb has moved, short enough that it is
    /// plainly about the tap that just happened — the same 2.4s the browser's
    /// chip holds, so the two clients answer at one speed.
    private static let answerSeconds: Double = 2.4

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack {
                MonoCaps(
                    (language?.isEmpty == false ? language! : "CODE").uppercased(),
                    size: 9,
                    color: NS.Color.textTertiary,
                    tracking: 1.4
                )
                Spacer()
                Button {
                    // `UIPasteboard.general` is not optional and its setter
                    // returns nothing: a write to the general pasteboard from a
                    // foregrounded app has no failure for this view to report.
                    //
                    // The browser's chip carries a third REFUSED state, and it
                    // is earned there — the Mac serves that page over plain
                    // HTTP, a page that is not a secure context has no
                    // `navigator.clipboard` at all, and a control that does
                    // nothing and says nothing is the defect. Nothing on this
                    // side can refuse, so there is no state for one. Drawing it
                    // would be the panel holding space for a condition it can
                    // never measure.
                    UIPasteboard.general.string = code
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                    answerCopied()
                } label: {
                    MonoCaps(
                        copied ? "COPIED" : "COPY",
                        size: 9,
                        color: copied ? NS.Color.green : NS.Color.textSecondary,
                        tracking: 1.4
                    )
                    // 28pt was below the floor for a target, and the ink is
                    // four small letters. The chip looks the same; the area
                    // that answers a thumb is a full one.
                    .frame(minHeight: NS.Metric.minimumTarget)
                    .padding(.horizontal, 12)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(copied ? "Code copied" : "Copy code")
            }
            .padding(.horizontal, 10)
            .padding(.top, 4)

            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .nsMono(12)
                    .foregroundStyle(NS.Color.codeInk)
                    .lineSpacing(2)
                    .textSelection(.enabled)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                    .padding(.top, 2)
            }
        }
        // A code box takes the inner corner and its own ground, and nothing is
        // drawn round it: Deep against the panel's Raised is already two greys
        // apart, and a hairline on top of a fill is the one separation this
        // system does not use.
        .background(
            RoundedRectangle(cornerRadius: NS.Metric.radiusInner).fill(NS.Color.deepGround)
        )
        // A transcript scrolls answered chips out of the hierarchy while their
        // timers are still running, and a timer that outlives its view sets a
        // value nobody will draw.
        .onDisappear { clearing?.cancel() }
    }

    private func answerCopied() {
        clearing?.cancel()
        withAnimation(NS.Motion.stateChange) { copied = true }
        // The chip's accessibility label follows the word on it, so a reader
        // driving this by voice asks for the label that is actually there. That
        // is not where the confirmation lives, though: a name that changes under
        // a control nobody is focused on is never spoken again, which is why the
        // change is announced rather than only rewritten.
        AccessibilityNotification.Announcement("Code copied").post()
        clearing = Task { @MainActor in
            try? await Task.sleep(for: .seconds(Self.answerSeconds))
            guard !Task.isCancelled else { return }
            withAnimation(NS.Motion.stateChange) { copied = false }
        }
    }
}

// MARK: - Block splitting

enum MarkdownBlock {
    case paragraph(String)
    case heading(level: Int, text: String)
    case code(language: String?, body: String)
    case bullet([String])
    case numbered([String])
    case quote(String)
    case rule

    /// One pass, line by line. Fences win over everything: while a fence is
    /// open nothing inside it is interpreted, which is what makes it safe to
    /// show a code sample that itself contains Markdown.
    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [String] = []
        var numbers: [String] = []
        var quote: [String] = []

        var fenceLanguage: String?
        var fenceBody: [String] = []
        var inFence = false

        func flushParagraph() {
            guard !paragraph.isEmpty else { return }
            blocks.append(.paragraph(paragraph.joined(separator: "\n")))
            paragraph.removeAll()
        }
        func flushLists() {
            if !bullets.isEmpty { blocks.append(.bullet(bullets)); bullets.removeAll() }
            if !numbers.isEmpty { blocks.append(.numbered(numbers)); numbers.removeAll() }
        }
        func flushQuote() {
            guard !quote.isEmpty else { return }
            blocks.append(.quote(quote.joined(separator: "\n")))
            quote.removeAll()
        }
        func flushAll() {
            flushParagraph()
            flushLists()
            flushQuote()
        }

        for rawLine in text.components(separatedBy: .newlines) {
            let line = rawLine
            let trimmed = line.trimmingCharacters(in: .whitespaces)

            if trimmed.hasPrefix("```") || trimmed.hasPrefix("~~~") {
                if inFence {
                    blocks.append(.code(
                        language: fenceLanguage,
                        body: fenceBody.joined(separator: "\n")
                    ))
                    fenceBody.removeAll()
                    fenceLanguage = nil
                    inFence = false
                } else {
                    flushAll()
                    let tag = String(trimmed.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                    fenceLanguage = tag.isEmpty ? nil : tag
                    inFence = true
                }
                continue
            }

            if inFence {
                fenceBody.append(line)
                continue
            }

            if trimmed.isEmpty {
                flushAll()
                continue
            }

            if trimmed == "---" || trimmed == "***" || trimmed == "___" {
                flushAll()
                blocks.append(.rule)
                continue
            }

            if trimmed.hasPrefix("#") {
                flushAll()
                let hashes = trimmed.prefix { $0 == "#" }.count
                let content = trimmed.dropFirst(hashes).trimmingCharacters(in: .whitespaces)
                blocks.append(.heading(level: min(hashes, 3), text: content))
                continue
            }

            if trimmed.hasPrefix("> ") || trimmed == ">" {
                flushParagraph()
                flushLists()
                quote.append(String(trimmed.dropFirst(trimmed.count > 1 ? 2 : 1)))
                continue
            }

            if let item = bulletItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !numbers.isEmpty { blocks.append(.numbered(numbers)); numbers.removeAll() }
                bullets.append(item)
                continue
            }

            if let item = numberedItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !bullets.isEmpty { blocks.append(.bullet(bullets)); bullets.removeAll() }
                numbers.append(item)
                continue
            }

            flushLists()
            flushQuote()
            paragraph.append(line)
        }

        if inFence, !fenceBody.isEmpty {
            // Streaming: the closing fence has not arrived yet. Show what there
            // is rather than nothing — this is the common case mid-answer.
            blocks.append(.code(language: fenceLanguage, body: fenceBody.joined(separator: "\n")))
        }
        flushAll()
        return blocks
    }

    private static func bulletItem(_ line: String) -> String? {
        for marker in ["- ", "* ", "+ "] where line.hasPrefix(marker) {
            return String(line.dropFirst(marker.count))
        }
        return nil
    }

    private static func numberedItem(_ line: String) -> String? {
        let digits = line.prefix { $0.isNumber }
        guard !digits.isEmpty else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return String(rest.dropFirst(2))
    }
}
