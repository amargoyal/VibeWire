import SwiftUI

/// The live diff for one file Claude is editing.
///
/// The host re-sends the patch after every tool result while this is open, so
/// the view is a window onto the working tree rather than a snapshot: an edit
/// lands here as Claude makes it. What is shown is `git diff HEAD` — the same
/// thing the user would see at the terminal, not a reconstruction from tool
/// arguments, which drifts the moment a `Bash` step writes a file.
struct DiffView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    /// The column's width is a character count times a rendered advance, so
    /// this one needs the resolved point size rather than the face.
    @Environment(\.dynamicTypeSize) private var type

    var body: some View {
        // Parsed once per body pass. As four separate computed properties this
        // split the whole patch four times per render — for the rows, the
        // width, and each of the two counts in the footer.
        let patch = Patch(model.diffPatch, at: type)

        return ScreenBody {
            VStack(alignment: .leading, spacing: 0) {
                header

                if model.diffPatch.isEmpty {
                    empty
                } else {
                    ScrollView {
                        // Sideways too: wrapped code lies about indentation,
                        // and a diff is mostly indentation.
                        //
                        // The width is computed rather than measured, and that
                        // is the whole optimisation. A horizontal scroll view
                        // sizes itself to its content, so with an unmeasured
                        // column it had to lay out every line of the patch to
                        // find the longest — which made the `LazyVStack` below
                        // eager no matter what, on a view the host re-sends
                        // after every tool result while Claude is editing.
                        // Monospaced text advances a known amount per
                        // character, so the longest line is arithmetic.
                        ScrollView(.horizontal, showsIndicators: false) {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(patch.lines.enumerated()), id: \.offset) { _, line in
                                    row(line)
                                }
                            }
                            .frame(width: patch.width, alignment: .leading)
                            .padding(.vertical, 10)
                        }
                    }
                    // Deep on the screen ground, and nothing drawn round it. Two
                    // greys apart is the separation the listing needs; a hairline
                    // on top of a fill is the border this system does not draw.
                    .background(
                        RoundedRectangle(cornerRadius: NS.Metric.radiusControl)
                            .fill(NS.Color.deepGround)
                    )
                    .padding(.top, 14)
                }

                footer(patch)
            }
        }
    }

    /// One pass over the patch: the rows, the width the column needs, and the
    /// two counts the footer states.
    private struct Patch {
        let lines: [String]
        let width: CGFloat
        let added: Int
        let removed: Int

        init(_ text: String, at type: DynamicTypeSize) {
            var lines: [String] = []
            var longest = 0
            var added = 0
            var removed = 0

            for line in text.split(separator: "\n", omittingEmptySubsequences: false) {
                longest = max(longest, line.count)
                if line.hasPrefix("+"), !line.hasPrefix("+++") {
                    added += 1
                } else if line.hasPrefix("-"), !line.hasPrefix("---") {
                    removed += 1
                }
                lines.append(String(line))
            }

            self.lines = lines
            self.added = added
            self.removed = removed
            // Wide enough for the longest line, so the added and removed tints
            // run the full width of the column instead of stopping raggedly at
            // each line's own last character.
            self.width = CGFloat(longest) * NS.Font.monoAdvance(DiffView.codeSize, at: type) + 20
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                MonoCaps("LIVE DIFF", size: 10, color: NS.Color.accent, tracking: 2)
                Spacer()
                SheetDismiss("CLOSE") { dismiss() }
            }
            Text(model.diffPath ?? "")
                .nsMono(12)
                .foregroundStyle(NS.Color.text)
                .lineLimit(2)
                .truncationMode(.head)
        }
        .padding(.top, 24)
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Spacer()
            Spinner(size: 20, color: NS.Color.accent)
            MonoCaps("READING THE WORKING TREE", size: 10, tracking: 1.4)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private func footer(_ patch: Patch) -> some View {
        HStack(spacing: 14) {
            MonoCaps("+\(patch.added)", size: 10, color: NS.Color.green, tracking: 1.2)
            MonoCaps("−\(patch.removed)", size: 10, color: NS.Color.red, tracking: 1.2)
            Spacer()
            MonoCaps("UPDATES AS CLAUDE EDITS", size: 9, tracking: 1.4)
        }
        .padding(.vertical, 16)
    }

    private func row(_ line: String) -> some View {
        let kind = DiffLineKind(line)
        return Text(line.isEmpty ? " " : line)
            .nsMono(Self.codeSize)
            .foregroundStyle(kind.foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(kind.background)
    }

    fileprivate static let codeSize: CGFloat = 11
}

/// Colour carries the meaning; the leading +/− stays so a copied diff is still
/// a diff.
private enum DiffLineKind {
    case added, removed, hunk, meta, context

    init(_ line: String) {
        if line.hasPrefix("+++") || line.hasPrefix("---") {
            self = .meta
        } else if line.hasPrefix("@@") {
            self = .hunk
        } else if line.hasPrefix("+") {
            self = .added
        } else if line.hasPrefix("-") {
            self = .removed
        } else if line.hasPrefix("diff ") || line.hasPrefix("index ")
                    || line.hasPrefix("new file") || line.hasPrefix("deleted file") {
            self = .meta
        } else {
            self = .context
        }
    }

    var foreground: Color {
        switch self {
        case .added: return NS.Color.green
        case .removed: return NS.Color.red
        case .hunk: return NS.Color.accent
        case .meta: return NS.Color.textTertiary
        case .context: return NS.Color.context
        }
    }

    /// The wash is 10%, the same figure the web token file states. Below that
    /// the tint stops surviving a phone at minimum brightness, which is where a
    /// diff is most often read.
    var background: Color {
        switch self {
        case .added: return NS.Color.green.opacity(0.10)
        case .removed: return NS.Color.red.opacity(0.10)
        default: return .clear
        }
    }
}
