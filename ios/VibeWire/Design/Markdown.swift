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
            MarkdownList(
                nodes: MarkdownListNode.nest(items),
                ordered: false,
                size: size,
                color: textColor
            )

        case .numbered(let items):
            MarkdownList(
                nodes: MarkdownListNode.nest(items),
                ordered: true,
                size: size,
                color: textColor
            )

        case .table(let header, let rows):
            MarkdownTable(header: header, rows: rows)

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

// MARK: - Lists

/// A run of list items, nested by depth, drawn as real nested lists.
///
/// Padding a flat run would draw the hierarchy for someone looking at it and
/// still say "list of six" to VoiceOver — which is the one claim the
/// indentation was not making. Each level is its own list, so a numbered run
/// counts from one inside each level the way it reads on the page.
///
/// The view recurses on itself. That is safe here because the recursion is over
/// data: `nest` bounds the depth at three, and a leaf has no children to
/// descend into.
private struct MarkdownList: View {
    let nodes: [MarkdownListNode]
    /// Numbered rather than bulleted. The marker is the only difference; the
    /// nesting, the task state and the spoken form are identical.
    let ordered: Bool
    let size: CGFloat
    let color: Color

    /// An inline run has to be a `Text`, so this cannot take the font as a
    /// modifier and read the reader's size for itself.
    @Environment(\.dynamicTypeSize) private var type

    /// One step of indent per level. Enough that the eye reads a level, small
    /// enough that a three-deep list still has a measure left on a phone.
    private static let step: CGFloat = 18

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(nodes.enumerated()), id: \.offset) { index, node in
                VStack(alignment: .leading, spacing: 6) {
                    row(node.item, number: index + 1)

                    if !node.children.isEmpty {
                        MarkdownList(
                            nodes: node.children,
                            ordered: ordered,
                            size: size,
                            color: color
                        )
                        .padding(.leading, Self.step)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func row(_ item: MarkdownListItem, number: Int) -> some View {
        let line = HStack(alignment: .top, spacing: 8) {
            marker(item, number: number)
            Text(MarkdownText.attributed(item.text, at: type))
                .font(NS.Font.sans(size, at: type))
                .foregroundStyle(color)
                .fixedSize(horizontal: false, vertical: true)
        }

        if let done = item.done {
            // The mark is decoration — a reader who is not looking at it gets
            // the sentence and nothing that says whether it is done — so the
            // state is spoken rather than only drawn.
            line
                .accessibilityElement(children: .combine)
                .accessibilityValue(done ? "Done" : "Not done")
        } else {
            line
        }
    }

    /// A number, or the task vocabulary this system already has: a tick for
    /// done, an outline for not yet, a bullet for an item that is neither.
    ///
    /// The browser spells the empty box `☐`, which the system monospace does
    /// not carry — it would be drawn by whatever face iOS substituted, at
    /// whatever width that face advances, in a column whose whole job is to
    /// line up. `□` is in the face, so it holds the column.
    private func marker(_ item: MarkdownListItem, number: Int) -> some View {
        Group {
            if ordered {
                Text("\(number).")
                    .nsMono(size - 3)
                    .foregroundStyle(NS.Color.accent.opacity(0.8))
            } else {
                Text(item.done == nil ? "•" : (item.done == true ? "✓" : "□"))
                    .nsMono(size - 2)
                    // Green is the done state everywhere else in this panel —
                    // the tick on a finished tool call is the same mark in the
                    // same ink.
                    .foregroundStyle(
                        (item.done == true ? NS.Color.green : NS.Color.accent).opacity(0.8)
                    )
            }
        }
        .accessibilityHidden(true)
    }
}

// MARK: - Table

/// A pipe table.
///
/// Mono throughout, because a table in an answer is a table of values and this
/// system sets anything measured in mono. It scrolls sideways rather than
/// wrapping cells: a four-column table does not fit a phone at any font size,
/// and a wrapped cell stops lining up with its heading, which is the only thing
/// a table is for.
private struct MarkdownTable: View {
    let header: [String]
    let rows: [[String]]

    @Environment(\.dynamicTypeSize) private var type

    /// A ragged row is ordinary in hand-written Markdown, so the grid is as
    /// wide as the widest line rather than as wide as the heading.
    private var columns: Int {
        max(header.count, rows.map(\.count).max() ?? 0)
    }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leadingFirstTextBaseline, horizontalSpacing: 18, verticalSpacing: 7) {
                GridRow {
                    ForEach(0..<columns, id: \.self) { column in
                        MonoCaps(cell(header, column), size: 9, tracking: 1.4)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.bottom, 7)
                            // Drawn under each heading rather than as one rule
                            // across the grid, which is also how the browser
                            // draws it: a cell that spans every column takes its
                            // width from a grid that is being asked how wide it
                            // wants to be, and the two questions have no answer
                            // between them.
                            .overlay(alignment: .bottom) {
                                Rectangle()
                                    .fill(NS.Color.hairline)
                                    .frame(height: NS.Metric.hairline)
                            }
                    }
                }

                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<columns, id: \.self) { column in
                            Text(MarkdownText.attributed(cell(row, column), at: type))
                                .font(NS.Font.mono(12, at: type))
                                // The first column is what the row is about; the
                                // rest are its values, a step back.
                                .foregroundStyle(column == 0 ? NS.Color.text : NS.Color.context)
                                .lineLimit(1)
                                .fixedSize()
                                // A cell read on its own is a value with nothing
                                // to measure it against. The heading is what a
                                // table is for, so it is said with every cell.
                                .accessibilityLabel(spoken(row, column))
                        }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
        }
        .background(
            RoundedRectangle(cornerRadius: NS.Metric.radiusInner).fill(NS.Color.deepGround)
        )
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Table")
    }

    private func cell(_ line: [String], _ column: Int) -> String {
        line.indices.contains(column) ? line[column] : ""
    }

    private func spoken(_ row: [String], _ column: Int) -> String {
        let value = cell(row, column)
        let heading = cell(header, column)
        return heading.isEmpty ? value : "\(heading): \(value)"
    }
}

// MARK: - Code

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

/// One line of a list, with the two things a flat `String` threw away.
///
/// `depth` is how far it was indented, because Claude nests lists constantly
/// and a nested list drawn flat says every point is a sibling of every other —
/// which is the one claim the indentation was making. `done` is the state of a
/// task box, where there was one; `nil` means this item is not a task.
struct MarkdownListItem {
    let text: String
    let depth: Int
    let done: Bool?
}

/// One item and whatever was indented under it.
struct MarkdownListNode {
    let item: MarkdownListItem
    var children: [MarkdownListNode]

    /// The flat run, grouped into the levels its indents describe.
    static func nest(_ items: [MarkdownListItem], depth: Int = 0) -> [MarkdownListNode] {
        var nodes: [MarkdownListNode] = []
        var index = items.startIndex

        while index < items.endIndex {
            let item = items[index]
            // An item deeper than its predecessors with no parent above it is a
            // stray indent, not a level; it joins the run rather than
            // disappearing into a child list of nothing.
            if item.depth > depth, !nodes.isEmpty {
                let start = index
                while index < items.endIndex, items[index].depth > depth { index += 1 }
                nodes[nodes.count - 1].children = nest(
                    Array(items[start..<index]),
                    depth: depth + 1
                )
                continue
            }
            nodes.append(MarkdownListNode(item: item, children: []))
            index += 1
        }
        return nodes
    }
}

enum MarkdownBlock {
    case paragraph(String)
    case heading(level: Int, text: String)
    case code(language: String?, body: String)
    case bullet([MarkdownListItem])
    case numbered([MarkdownListItem])
    case quote(String)
    case table(header: [String], rows: [[String]])
    case rule

    /// One pass, line by line. Fences win over everything: while a fence is
    /// open nothing inside it is interpreted, which is what makes it safe to
    /// show a code sample that itself contains Markdown.
    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var bullets: [MarkdownListItem] = []
        var numbers: [MarkdownListItem] = []
        var quote: [String] = []
        var table: [String] = []

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
        /// A run of pipe rows is a table only if the second one is the separator
        /// that says so. Anything else — one pipe in a sentence, a fragment cut
        /// off by the end of a streaming delta — goes back to being a paragraph,
        /// which is what it was before this existed.
        func flushTable() {
            guard !table.isEmpty else { return }
            blocks.append(parseTable(table) ?? .paragraph(table.joined(separator: "\n")))
            table.removeAll()
        }
        func flushAll() {
            flushParagraph()
            flushLists()
            flushQuote()
            flushTable()
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

            // A row of a pipe table. Claude writes these constantly and they
            // used to fall through to a paragraph, which renders the pipes and
            // the dashes verbatim — a table drawn as the ASCII it was typed as,
            // wrapped at the phone's measure into something with no columns in
            // it.
            if trimmed.hasPrefix("|") {
                flushParagraph()
                flushLists()
                flushQuote()
                table.append(trimmed)
                continue
            }
            flushTable()

            if let item = bulletItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !numbers.isEmpty { blocks.append(.numbered(numbers)); numbers.removeAll() }
                bullets.append(listItem(item, raw: line))
                continue
            }

            if let item = numberedItem(trimmed) {
                flushParagraph()
                flushQuote()
                if !bullets.isEmpty { blocks.append(.bullet(bullets)); bullets.removeAll() }
                numbers.append(listItem(item, raw: line))
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

    /// An item's text, its indent, and whether it is a task box.
    ///
    /// The indent has to come off the raw line, since the branch above matched
    /// a trimmed one — which is how every nested list in this app has been
    /// drawn flat. Two spaces is one step, which is what Claude writes; a tab
    /// counts as one step for the same reason. Three levels is the floor of
    /// what fits a phone's measure, so deeper indents fold into the third.
    private static func listItem(_ text: String, raw: String) -> MarkdownListItem {
        let indent = raw.prefix { $0 == " " || $0 == "\t" }
        let columns = indent.reduce(0) { $0 + ($1 == "\t" ? 2 : 1) }
        let depth = min(3, columns / 2)

        guard let box = taskBox(text) else {
            return MarkdownListItem(text: text, depth: depth, done: nil)
        }
        return MarkdownListItem(text: box.text, depth: depth, done: box.done)
    }

    /// `[ ] thing` and `[x] thing`, with the bullet marker already taken off.
    /// Until now the brackets were rendered as the literal characters they are.
    private static func taskBox(_ text: String) -> (done: Bool, text: String)? {
        var body = Substring(text)
        guard body.first == "[" else { return nil }
        body = body.dropFirst()
        guard let mark = body.first, mark == " " || mark == "x" || mark == "X" else { return nil }
        body = body.dropFirst()
        guard body.first == "]" else { return nil }
        body = body.dropFirst()
        // A box with nothing after it is not a task, it is a pair of brackets:
        // the space is what separates the mark from the thing being marked.
        guard body.first == " " else { return nil }
        return (mark != " ", String(body.drop { $0 == " " }))
    }

    /// A GitHub-style pipe table, or `nil` if this run is not one.
    ///
    /// The separator row is the whole test: `| --- | :--: |`. Without it a line
    /// starting with a pipe is just a line starting with a pipe — and a table
    /// still arriving in a stream of deltas has a header and no separator yet.
    /// Both have to come back as prose rather than as a half-built grid.
    private static func parseTable(_ lines: [String]) -> MarkdownBlock? {
        guard lines.count >= 2 else { return nil }
        let separator = cells(lines[1])
        guard !separator.isEmpty, separator.allSatisfy(isSeparatorCell) else { return nil }
        return .table(header: cells(lines[0]), rows: lines.dropFirst(2).map(cells))
    }

    /// The cells of one row. The outer pipes are the fence, not a cell each
    /// side, so a leading and a trailing one are dropped before the split.
    private static func cells(_ line: String) -> [String] {
        var body = Substring(line)
        if body.hasPrefix("|") { body = body.dropFirst() }
        if body.hasSuffix("|") { body = body.dropLast() }
        return body
            .split(separator: "|", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespaces) }
    }

    /// `---`, `:--`, `--:`, `:-:` — a run of dashes with an optional alignment
    /// colon at either end, and nothing else.
    private static func isSeparatorCell(_ cell: String) -> Bool {
        var body = Substring(cell)
        if body.hasPrefix(":") { body = body.dropFirst() }
        if body.hasSuffix(":") { body = body.dropLast() }
        return !body.isEmpty && body.allSatisfy { $0 == "-" }
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
