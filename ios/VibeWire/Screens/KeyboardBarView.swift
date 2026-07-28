import SwiftUI

/// 05 · KEYBOARD MODE.
///
/// The system keyboard stays stock — building a custom one would cost the
/// muscle memory and autocorrect the user already has. This adds only what
/// macOS needs and iOS does not have: two rows above the keyboard, and a banner
/// naming what is being typed into, because typing blind into the wrong window
/// is the expensive mistake here.
struct KeyboardBarView: View {
    @Environment(AppModel.self) private var model
    @State private var buffer = ""
    @State private var combos: [[String]] = [
        ["cmd", "s"], ["cmd", "z"], ["cmd", "shift", "z"], ["cmd", "k"], ["control", "c"],
    ]
    @State private var showComboEditor = false
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            typingIntoBanner
                .padding(.horizontal, 18)
                .padding(.bottom, 12)

            VStack(spacing: 6) {
                hardwareRow
                comboRow
            }
            .padding(.horizontal, 8)
            .padding(.bottom, 8)
            .background(LG.Color.deepGround.opacity(0.96))

            // Invisible field that owns the system keyboard. Everything typed
            // is forwarded as unicode so autocorrect and emoji work.
            TextField("", text: $buffer)
                .focused($focused)
                .opacity(0.001)
                .frame(height: 1)
                .autocorrectionDisabled(false)
                .textInputAutocapitalization(.sentences)
                .onChange(of: buffer) { previous, current in
                    forward(previous: previous, current: current)
                }
                .onSubmit {
                    model.key("return")
                }
        }
        .onAppear { focused = true }
        .transition(.move(edge: .bottom))
    }

    /// What is being typed into, named.
    private var typingIntoBanner: some View {
        HStack(spacing: 10) {
            Caret().frame(width: 2, height: 18)
            MonoCaps("TYPING INTO", size: 11, color: LG.Color.cyan, tracking: 0.6)
            Text(model.link.frontmostApp.isEmpty ? "Unknown window" : model.link.frontmostApp)
                .font(LG.Font.sans(14))
                .foregroundStyle(LG.Color.text)
                .lineLimit(1)
            Spacer(minLength: 0)
            MonoCaps(
                model.displays.first(where: \.selected).map { $0.name.uppercased() } ?? "",
                size: 9,
                tracking: 1.2
            )
            Button {
                model.showKeyboard = false
                focused = false
            } label: {
                Text("✕")
                    .font(LG.Font.mono(13))
                    .foregroundStyle(LG.Color.textSecondary)
                    .frame(width: 44, height: 44)
            }
            .buttonStyle(.plain)
        }
        .padding(.leading, 14)
        .frame(height: 46)
        .background(
            RoundedRectangle(cornerRadius: 8).fill(LG.Color.cyan.opacity(0.06))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 8).stroke(LG.Color.cyan.opacity(0.28), lineWidth: 1)
        )
    }

    /// Row one: hardware the phone lacks. Arrows stay a single grouped cap so
    /// the shape is findable by feel — a flat row of four identical keys never
    /// is.
    private var hardwareRow: some View {
        HStack(spacing: 5) {
            textKey("esc", code: "escape")
            textKey("tab", code: "tab")

            ForEach(ModifierSpec.all, id: \.name) { spec in
                KeyCap(
                    glyph: spec.glyph,
                    width: 46,
                    height: 46,
                    isHeld: model.heldModifiers.contains(spec.name),
                    fontSize: 14
                ) {
                    model.toggleModifier(spec.name)
                }
            }

            arrowCluster
        }
    }

    private func textKey(_ label: String, code: String) -> some View {
        Button {
            model.key(code)
        } label: {
            Text(label)
                .font(LG.Font.mono(11))
                .tracking(0.6)
                .foregroundStyle(LG.Color.text)
                .padding(.horizontal, 12)
                .frame(height: 46)
                .background(RoundedRectangle(cornerRadius: 7).fill(LG.Color.chrome))
                .overlay(
                    RoundedRectangle(cornerRadius: 7).stroke(LG.Color.stroke, lineWidth: 1)
                )
        }
        .buttonStyle(.plain)
    }

    private var arrowCluster: some View {
        HStack(spacing: 0) {
            arrowKey("←", code: "arrowLeft")
            Rectangle().fill(LG.Color.hairlineDim).frame(width: 1, height: 34)
            VStack(spacing: 0) {
                arrowKey("↑", code: "arrowUp", height: 23, size: 10)
                arrowKey("↓", code: "arrowDown", height: 23, size: 10)
            }
            .frame(width: 26)
            Rectangle().fill(LG.Color.hairlineDim).frame(width: 1, height: 34)
            arrowKey("→", code: "arrowRight")
        }
        .frame(maxWidth: .infinity)
        .frame(height: 46)
        .background(RoundedRectangle(cornerRadius: 7).fill(LG.Color.raised))
        .overlay(
            RoundedRectangle(cornerRadius: 7).stroke(LG.Color.hairlineDim, lineWidth: 1)
        )
    }

    private func arrowKey(_ glyph: String, code: String, height: CGFloat = 34, size: CGFloat = 12) -> some View {
        Button {
            model.key(code)
        } label: {
            Text(glyph)
                .font(LG.Font.mono(size))
                .foregroundStyle(LG.Color.textSecondary)
                .frame(width: 26, height: height)
                // An arrow glyph is mostly empty space, and these keys have no
                // fill behind them, so only the strokes were hittable.
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(arrowName(code))
    }

    private func arrowName(_ code: String) -> String {
        switch code {
        case "arrowLeft": return "Left arrow"
        case "arrowRight": return "Right arrow"
        case "arrowUp": return "Up arrow"
        case "arrowDown": return "Down arrow"
        default: return code
        }
    }

    /// Row two: the combos actually sent, editable. Nothing scrolls
    /// horizontally — hidden keys are keys that will not be used.
    private var comboRow: some View {
        HStack(spacing: 5) {
            ForEach(Array(combos.enumerated()), id: \.offset) { _, combo in
                Button {
                    model.combo(combo)
                    UIImpactFeedbackGenerator(style: .light).impactOccurred()
                } label: {
                    Text(label(for: combo))
                        .font(LG.Font.mono(12))
                        .foregroundStyle(LG.Color.text)
                        .padding(.horizontal, 13)
                        .frame(height: 44)
                        .background(RoundedRectangle(cornerRadius: 7).fill(LG.Color.panel))
                        .overlay(
                            RoundedRectangle(cornerRadius: 7).stroke(LG.Color.hairline, lineWidth: 1)
                        )
                }
                .buttonStyle(.plain)
            }

            Button {
                showComboEditor = true
            } label: {
                Text("+")
                    .font(LG.Font.mono(11))
                    .foregroundStyle(LG.Color.textTertiary)
                    .frame(maxWidth: .infinity)
                    .frame(height: 44)
                    .overlay(
                        RoundedRectangle(cornerRadius: 7)
                            .strokeBorder(style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
                            .foregroundStyle(LG.Color.hairline)
                    )
                    // The dashed box is an outline, not a fill, so only the
                    // plus sign itself answered a tap.
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Add a key combination")
        }
        .sheet(isPresented: $showComboEditor) {
            ComboEditor(combos: $combos)
        }
    }

    private func label(for combo: [String]) -> String {
        combo.map { part in
            ModifierSpec.all.first { $0.name == part }?.glyph ?? part.uppercased()
        }.joined()
    }

    /// Diffs the text field rather than intercepting keystrokes, so autocorrect
    /// replacements and multi-character insertions all forward correctly.
    private func forward(previous: String, current: String) {
        if current.count > previous.count, current.hasPrefix(previous) {
            let added = String(current.dropFirst(previous.count))
            model.type(added)
        } else if current.count < previous.count, previous.hasPrefix(current) {
            for _ in 0..<(previous.count - current.count) {
                model.key("delete")
            }
        } else if current != previous {
            // An autocorrect replacement: erase what was there and retype.
            for _ in 0..<previous.count { model.key("delete") }
            model.type(current)
        }

        // Keep the buffer short so the diff stays cheap over a long session.
        if buffer.count > 200 { buffer = String(buffer.suffix(40)) }
    }
}

struct ComboEditor: View {
    @Binding var combos: [[String]]
    @Environment(\.dismiss) private var dismiss
    @State private var selectedModifiers: Set<String> = ["cmd"]
    @State private var letter = ""

    var body: some View {
        ScreenBody {
            VStack(alignment: .leading, spacing: 20) {
                MonoCaps("NEW COMBO", size: 10, tracking: 2).padding(.top, 24)

                HStack(spacing: 8) {
                    ForEach(ModifierSpec.all, id: \.name) { spec in
                        KeyCap(
                            glyph: spec.glyph,
                            caption: spec.caption,
                            width: 62,
                            height: 52,
                            isHeld: selectedModifiers.contains(spec.name)
                        ) {
                            if selectedModifiers.contains(spec.name) {
                                selectedModifiers.remove(spec.name)
                            } else {
                                selectedModifiers.insert(spec.name)
                            }
                        }
                    }
                }

                TextField("key", text: $letter)
                    .font(LG.Font.mono(15))
                    .foregroundStyle(LG.Color.text)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 14)
                    .frame(height: 52)
                    .background(RoundedRectangle(cornerRadius: 8).fill(LG.Color.panel))
                    .overlay(
                        RoundedRectangle(cornerRadius: 8).stroke(LG.Color.hairline, lineWidth: 1)
                    )

                Spacer()

                PrimaryAction(
                    title: "Add combo",
                    detail: "APPEARS IN ROW TWO",
                    glyph: "＋",
                    tint: LG.Color.cyan,
                    ink: LG.Color.onCyan,
                    enabled: !letter.isEmpty && !selectedModifiers.isEmpty
                ) {
                    combos.append(Array(selectedModifiers.sorted()) + [letter.lowercased()])
                    dismiss()
                }
                .padding(.bottom, 24)
            }
        }
    }
}
