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

    var body: some View {
        ScreenBody {
            VStack(alignment: .leading, spacing: 0) {
                header

                if model.diffPatch.isEmpty {
                    empty
                } else {
                    ScrollView {
                        // Sideways too: wrapped code lies about indentation,
                        // and a diff is mostly indentation.
                        ScrollView(.horizontal, showsIndicators: false) {
                            VStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                                    row(line)
                                }
                            }
                            .padding(.vertical, 10)
                        }
                    }
                    .background(
                        RoundedRectangle(cornerRadius: 8).fill(Color(hex: 0x0B0E12))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(LG.Color.hairlineDim, lineWidth: 1)
                    )
                    .padding(.top, 14)
                }

                footer
            }
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                MonoCaps("LIVE DIFF", size: 10, color: LG.Color.cyan, tracking: 2)
                Spacer()
                Button("Close") { dismiss() }
                    .font(LG.Font.mono(11))
                    .foregroundStyle(LG.Color.textSecondary)
                    .frame(height: 44)
            }
            Text(model.diffPath ?? "")
                .font(LG.Font.mono(12))
                .foregroundStyle(LG.Color.text)
                .lineLimit(2)
                .truncationMode(.head)
        }
        .padding(.top, 24)
    }

    private var empty: some View {
        VStack(spacing: 10) {
            Spacer()
            Spinner(color: LG.Color.cyan).frame(width: 20, height: 20)
            MonoCaps("READING THE WORKING TREE", size: 10, tracking: 1.4)
            Spacer()
        }
        .frame(maxWidth: .infinity)
    }

    private var footer: some View {
        HStack(spacing: 14) {
            MonoCaps("+\(addedCount)", size: 10, color: LG.Color.green, tracking: 1.2)
            MonoCaps("−\(removedCount)", size: 10, color: LG.Color.red, tracking: 1.2)
            Spacer()
            MonoCaps("UPDATES AS CLAUDE EDITS", size: 9, tracking: 1.4)
        }
        .padding(.vertical, 16)
    }

    private func row(_ line: String) -> some View {
        let kind = DiffLineKind(line)
        return Text(line.isEmpty ? " " : line)
            .font(LG.Font.mono(11))
            .foregroundStyle(kind.foreground)
            .padding(.horizontal, 10)
            .padding(.vertical, 1)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(kind.background)
    }

    private var lines: [String] {
        model.diffPatch.components(separatedBy: .newlines)
    }

    private var addedCount: Int {
        lines.filter { $0.hasPrefix("+") && !$0.hasPrefix("+++") }.count
    }

    private var removedCount: Int {
        lines.filter { $0.hasPrefix("-") && !$0.hasPrefix("---") }.count
    }
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
        case .added: return LG.Color.green
        case .removed: return LG.Color.red
        case .hunk: return LG.Color.cyan
        case .meta: return LG.Color.textTertiary
        case .context: return Color(hex: 0xA8AEB8)
        }
    }

    var background: Color {
        switch self {
        case .added: return LG.Color.green.opacity(0.08)
        case .removed: return LG.Color.red.opacity(0.08)
        default: return .clear
        }
    }
}
