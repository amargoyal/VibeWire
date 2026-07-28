---
name: VibeWire
description: A dark instrument panel for holding a Mac in one hand — every mark on screen reports a measured value.
colors:
  reachable-jade: "#58D9A3"
  degraded-sodium: "#E8B45A"
  lost-clay: "#E4685A"
  held-cyan: "#6BC7E8"
  deep-ground: "#08090B"
  screen-ground: "#0B0D10"
  raised: "#0E1116"
  panel: "#101318"
  chrome: "#14171C"
  text: "#E9EBEE"
  text-secondary: "#949AA5"
  text-tertiary: "#7C8493"
  text-disabled: "#3A404A"
  hairline-dim: "#1A1E24"
  hairline: "#262B33"
  stroke: "#2E343D"
  on-jade: "#06130D"
  on-sodium: "#170F02"
  on-clay: "#1B0805"
  on-cyan: "#04141B"
typography:
  display:
    fontFamily: "SF Pro (system sans)"
    fontSize: "30pt"
    fontWeight: 500
    letterSpacing: "normal"
  headline:
    fontFamily: "SF Pro (system sans)"
    fontSize: "27pt"
    fontWeight: 400
    letterSpacing: "normal"
  title:
    fontFamily: "SF Pro (system sans)"
    fontSize: "19pt"
    fontWeight: 500
    letterSpacing: "normal"
  body:
    fontFamily: "SF Pro (system sans)"
    fontSize: "15pt"
    fontWeight: 400
    letterSpacing: "normal"
  label:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "10pt"
    fontWeight: 400
    letterSpacing: "1.4pt"
  readout:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "19pt"
    fontWeight: 400
    letterSpacing: "normal"
  code:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "11pt"
    fontWeight: 400
    letterSpacing: "normal"
rounded:
  hairline: "3pt"
  sm: "6pt"
  row: "8pt"
  md: "10pt"
  lg: "12pt"
  sheet: "18pt"
spacing:
  xs: "6pt"
  sm: "8pt"
  md: "12pt"
  lg: "16pt"
  panel: "18pt"
  gutter: "24pt"
  section: "26pt"
components:
  action-primary:
    backgroundColor: "{colors.reachable-jade}"
    textColor: "{colors.on-jade}"
    typography: "{typography.title}"
    rounded: "{rounded.md}"
    padding: "0 22pt"
    height: "76pt"
  action-primary-cyan:
    backgroundColor: "{colors.held-cyan}"
    textColor: "{colors.on-cyan}"
    rounded: "{rounded.md}"
    height: "76pt"
  action-destructive:
    backgroundColor: "{colors.lost-clay}"
    textColor: "{colors.on-clay}"
    rounded: "{rounded.md}"
    height: "60pt"
  action-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.sm}"
    height: "44pt"
  panel:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.md}"
    padding: "18pt"
  panel-tinted:
    backgroundColor: "rgba(88,217,163,0.05)"
    rounded: "{rounded.md}"
    padding: "18pt"
  list-row:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.body}"
    rounded: "{rounded.row}"
    padding: "0 16pt"
    height: "62pt"
  list-row-selected:
    backgroundColor: "rgba(107,199,232,0.08)"
    textColor: "{colors.text}"
    rounded: "{rounded.row}"
    height: "62pt"
  ledger-row:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    typography: "{typography.code}"
    padding: "0 12pt"
    height: "44pt"
  keycap:
    backgroundColor: "{colors.chrome}"
    textColor: "{colors.text}"
    rounded: "{rounded.row}"
    height: "46pt"
  keycap-held:
    backgroundColor: "rgba(107,199,232,0.18)"
    textColor: "{colors.held-cyan}"
    rounded: "{rounded.row}"
    height: "46pt"
  segment-item:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    height: "44pt"
  segment-item-selected:
    backgroundColor: "rgba(107,199,232,0.14)"
    textColor: "{colors.held-cyan}"
    typography: "{typography.label}"
    height: "44pt"
  field:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.text}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: "0 12pt"
    height: "44pt"
  code-block:
    backgroundColor: "{colors.deep-ground}"
    textColor: "{colors.text}"
    typography: "{typography.code}"
    rounded: "{rounded.sm}"
    padding: "13pt"
---

# Design System: VibeWire

## Overview

**Creative North Star: "The Instrument Panel"**

VibeWire is a gauge cluster for one machine. Every mark on the glass reports something that was actually measured — round-trip time, packet loss, megabits, the age of the last good frame, how long a tool has been waiting on an answer. Nothing on screen is decoration wearing the costume of information. When a value has not been measured, the panel prints an em dash and holds the space, because an unmeasured value and a measured zero are different facts and the interface is not allowed to blur them.

The room is dark and stays dark. There is no light mode, no `colorScheme` branching, and no shadow anywhere in the app. Depth is built from five tonal grounds and a one-point hairline, the way a bezel separates one dial from the next. Type does the second half of the work: monospace with wide tracking for anything counted or named by the machine, system sans for prose the user reads at their own pace. The two never trade jobs, so the eye learns in one screen which parts of the panel are readings and which are sentences.

Color is a signalling system with exactly four voices, and the most important thing about it is the split: jade, sodium and clay report what the **Mac** is doing, and cyan reports what the **user** is doing — a held modifier, an active selection, a Claude session, the caret. That separation is what lets a glance in a dark room distinguish "the link is degrading" from "I left Command switched on." It is rejected outright as a generic remote-desktop client with a gray toolbar and one undifferentiated "Connected", as a consumer chat app with bubbles and avatars, and as a neon hacker dashboard where color is atmosphere. The unhappy states — asleep, thin link, unreachable — are drawn with the same care as the happy one, because those are the states that cost the user two minutes.

**Key Characteristics:**
- Dark-only, five tonal grounds, zero shadows
- Monospace for measured, sans for prose — never interchangeable
- Four signal colors: three for the machine, one reserved for the user
- Hairlines and tint-washes instead of cards
- Every primary action states its own cost before it is tapped
- Motion is 120–180 ms state change; nothing decorative moves beside live video

## Colors

A near-black instrument ground carrying four saturated-but-soft signal hues, each desaturated just enough to sit on black without haloing.

### Primary

- **Reachable Jade** (`#58D9A3`): the Mac is awake and the link is healthy. Used on the condition dot, signal bars, RTT sparkline, the "View screen" action, added diff lines, git branch names, and the `✓` on a completed tool call. Never used for anything the user switched on.
- **Held Cyan** (`#6BC7E8`): the user's own state, and nothing else. Held and latched modifiers, the active code box and caret, the selected display, the selected pad mode, Claude's turn marker and the whole Claude surface, the trackpad boundary, zoom readouts, and the hub's MODS spoke. If cyan is on screen, the user put it there.

### Secondary

- **Degraded Sodium** (`#E8B45A`): a measured degradation, not a failure. A thin link, a stalled picture, a Mac that is asleep, a pending permission request, a modified file. Always attached to the number that justifies it (`JITTER 240MS`, `PAUSED 12S`).

### Tertiary

- **Lost Clay** (`#E4685A`): the path is gone, or the action destroys something. Unreachable card, failed exchange step, removed diff lines, revoke, and the Stop control on a running agent.

### Neutral

- **Deep Ground** (`#08090B`): the video screen and the ground behind fenced code — the darkest surface, reserved for places where the picture or the code is the content.
- **Screen Ground** (`#0B0D10`): the standard screen background for every non-video screen.
- **Raised** (`#0E1116`): panels, sheets, and list rows lifted one step off the ground.
- **Panel** (`#101318`): input fields, display rows, and the pressable surfaces above them.
- **Chrome** (`#14171C`): key caps, dock buttons, ledger backing, and the divider fill between stacked rows.
- **Text** (`#E9EBEE`): prose and any value currently true.
- **Text Secondary** (`#949AA5`): supporting prose, inactive labels, idle condition. 6.9:1.
- **Text Tertiary** (`#7C8493`): mono caps headings, units, and captions — the default color of a label, and so the most-read text in the product. 4.8:1 at worst, on chrome. It carries 70 of the app's 123 label call sites; every one of them is 8–10 pt, which is why it is set to clear AA on the lightest ground rather than the darkest.
- **Text Disabled** (`#3A404A`): 1.7:1, deliberately under the text threshold — which makes it **not a text color**. Ink for a disabled control and fills for dormant indicators only.
- **Hairline Dim** (`#1A1E24`) / **Hairline** (`#262B33`) / **Stroke** (`#2E343D`): the three rule weights, dim for divisions inside a group, hairline for a container edge, stroke for an interactive edge.
- **Ink colors** (`#06130D`, `#170F02`, `#1B0805`, `#04141B`): near-black text laid on a filled signal button. Each is the signal hue driven to ~7% lightness so the pairing stays in family rather than punching a hole with pure black.

### Named Rules

**The Two Voices Rule.** Jade, sodium and clay describe the machine. Cyan describes the user. A control may never take a machine color to mean "on", and a condition may never take cyan to mean "bad". Any new color must declare which side of that line it lives on, or it does not get added.

**The Dash Rule.** A value that has not been measured renders as `—` in Text Disabled at the same size the real value will take. Never `0`, never blank, never a spinner in place of a number.

**The Measured Condition Rule.** Condition is derived from measured inputs (`Condition.from(rttMillis:lossPercent:awake:)`), never set by hand at a call site. The label and the numbers beside it cannot disagree, because they come from the same expression.

**The Measured Contrast Rule.** A text color is chosen by computing it against the ground it actually lands on — and against the *lightest* such ground, not the average. Dark is a product decision here, so there is no light appearance to fall back on and the palette has to carry legibility by itself. Body and label text clears 4.5:1; anything that cannot is not a text color.

**The No Alpha Over Video Rule.** Nothing readable sits on the Mac's picture as translucent ink. Alpha over content nobody controls has no contrast ratio — white at 34% measures 2.9:1 over a black desktop and 1.0:1 over a white document. Marks over video are solid and carry their own ground (`.videoChip()`).

## Typography

**Display / Body Font:** SF Pro — the system sans, no custom brand face
**Label / Readout / Code Font:** SF Mono. `LG.Font.mono` names IBM Plex Mono first, but nothing bundles it — there is no `UIAppFonts` key and no font file in the target — so every mono glyph in the app is the system monospace today. The branch is kept as the single place that would change if the face is ever added.

**Scaling:** every size answers Dynamic Type. Each call is scaled relative to the standard text style nearest its own value — a 9 pt unit label tracks `caption2`, a 19 pt readout tracks `body`, a 30 pt machine name tracks `title1` — so the roles grow at the different rates Apple already tuned rather than all inflating together. The style is derived from the size inside `LG.Font`, which is what let every existing call site gain scaling without changing. Nothing renders below **9 pt** (`LG.Font.floor`).

**Character:** A technical pairing with a strict division of labor. Mono is the machine's voice: uppercased, tracked wide (0.8–4.4 pt), and small enough that it reads as an annotation on a dial rather than a sentence. Sans is the human voice: mixed case, unmodified, used for anything written to be read as language. The contrast is the hierarchy — there is no bold-heavy type scale doing that job.

### Hierarchy

- **Display** (medium, 30 pt): the Mac's own name on Home, and only there. It is the largest thing in the app because the machine is the subject.
- **Headline** (regular, 24–27 pt): the one sentence a full-screen moment turns on — "Type the six digits on your Mac.", "Trading keys.", "Its key is deleted on the Mac. There is no undo."
- **Title** (medium, 17–22 pt): screen titles and the label on a filled primary action.
- **Body** (regular, 13–15 pt): all prose. 15 pt for the primary sentence in a card, 13 pt for the supporting one. Always `.fixedSize(horizontal: false, vertical: true)` so a sentence is never truncated into a half-truth.
- **Label** (regular mono, 8–13 pt, uppercased, tracking 0.8–4.4): every heading, unit, status line, and caption. 10 pt at tracking 1.4 is the default; 9 pt for the quietest captions; 2.0–4.4 tracking for section headings and the wordmark.
- **Readout** (regular mono, 19 pt, unit at 11 pt in Text Tertiary): a measured value and its unit set as one baseline-aligned pair. 46 pt for the zoom badge, which is the one readout meant to be read mid-gesture.
- **Code** (regular mono, 10–12 pt): tool names and targets, diff lines, the verbatim command in a permission request, fenced code in Claude's answers.

### Named Rules

**The Two Registers Rule.** Monospace is for anything the machine measured or named: values, units, paths, keys, commands, statuses. Sans is for anything written to be read as language. A label never becomes sans to look friendlier, and prose never becomes mono to look technical.

**The Verbatim Rule.** A command, a path, or an error the user may need to act on is rendered mono, selectable (`.textSelection(.enabled)`), and never truncated mid-token. Truncation, when unavoidable, takes the head of a path and the middle of a target — never the tail that carries the filename.

**The 9 Point Floor Rule.** Nothing renders below 9 pt at any text size. This is a deliberate departure from the platform's 11 pt floor, taken because the instrument's density is the design and a uniform 11 pt would rewrite it — but 6 pt and 7 pt captions were not density, they were unreadable. The floor is enforced inside `LG.Font`, so a call site cannot opt out by passing a smaller number.

**The Growing Control Rule.** A control that stacks text sets `minHeight`, never a fixed `height`. Identical at the default size; at large sizes the control grows instead of clipping the words inside it. The 76 pt primary action is the case that proves it — a fixed height clips the preflight line, which is the sentence saying what the action costs.

## Layout

One column, 24 pt gutters, set by `ScreenBody` — which also owns the ground color, extends it under the safe area, and forces `.preferredColorScheme(.dark)`. Content stays inside the safe area; only the ground and bottom sheets cross it.

Vertical rhythm runs on a coarse scale rather than a strict grid: 12 pt between a heading and its content, 18 pt inside a panel, 22–26 pt between sections. Cards and rows carry their own interior padding (18 pt for a condition card, 16 pt horizontal for a list row, 12–14 pt for a ledger row) so the gutter never has to do two jobs.

Fixed control sizes are load-bearing, not incidental: 44 pt is the floor for anything tappable, 76 pt for the single primary action on a screen, 56 pt for a hub spoke and for the composer's send and stop, 46 pt for a key cap, 50–62 pt for list rows. The control hub is laid out on measured thumb geometry — a 210 pt arc of six 56 pt targets on a 66 pt pitch, positioned by explicit offsets from the bottom-trailing corner, ending at the two easiest positions for a right thumb.

**Every screen but the remote view is one column, bounded at 560 pt (`LG.Metric.measure`) and centred in whatever is left.** A row here is a label on the left and a value on the right; run that to the glass on an iPad and the two ends stop reading as one line. Bounded, the same column reads as a deliberate panel at any width. On a phone the cap never binds — 402 pt of glass minus two gutters is 354 pt — so this is invisible until the window gets wide. It also covers landscape, iPad Split View, and a phone-width window on a tablet without a single device check.

**Screens that are one column ending in a primary action set `ScreenBody(scrolls: true)`** — Home, Pairing, the combo editor. They fill the viewport when there is room, so their spacers still push the footer to the bottom edge, and scroll only once the content genuinely does not fit. Without it, landscape and the larger text sizes both push the only way forward off the screen.

**Portrait** is the instrument: status strip, optional display tabs, picture, pad-mode control, then a 96 pt bottom bar holding stop and hub. **Landscape** is a different instrument rather than a stretched one — the picture takes the left, and a 231 pt right-hand dock carries controls, a modifier row, and live RTT/rate readouts, separated by a single 1 pt chrome rule.

On the remote screen, the letterbox bands left by a 16:10 desktop inside a 19.5:9 phone are treated as usable surface: the trackpad is the entire glass, not just the picture, so the first accidental swipe into the dark area still moves the cursor. The picture keeps every pixel it has; the chrome lives in the bands.

### Named Rules

**The Held Space Rule.** A layout does not move when a value arrives. Pending values are drawn as a dashed rule or an em dash occupying the final geometry, so filling in is a substitution rather than a reflow.

**The Whole Glass Rule.** On the remote screen the input surface is the full frame, including the bands. Anything drawn over the picture is `.allowsHitTesting(false)` unless it is itself a control.

**The Bounded Column Rule.** Layout is driven by available width, never by device model. A column caps at `measure` and centres; a row of equal controls shares the width it is given rather than claiming a fixed one. The six pairing boxes are the case that proves it — at a fixed 48 pt they needed 333 pt inside 327 pt of iPhone SE, and overflowed the app's first screen.

## Elevation & Depth

There are no shadows in this app — not one `.shadow()` call exists, and none should be added. Depth is entirely tonal plus a hairline, which is what keeps the interface legible beside a live video feed where a soft shadow would read as a compression artifact.

Five grounds form the stack, each roughly two to six points of lightness apart: Deep Ground (`#08090B`) for video and code, Screen Ground (`#0B0D10`) for the page, Raised (`#0E1116`) for panels and sheets, Panel (`#101318`) for fields and pressable rows, Chrome (`#14171C`) for key caps and the fill showing between stacked rows. Because the steps are small, a 1 pt hairline is what actually separates two surfaces; the tone only says which is on top.

A panel that carries a condition takes a **tint wash** instead of a new ground: the signal color at 5% opacity as fill, and the same hue at 30% as its border. That is the system's only "lift", and it is semantic — a tinted panel always means the panel is reporting that condition.

The single deliberate exception is the control hub, which lays a radial gradient of Deep Ground (95% → 0%) behind its arc so six controls stay legible over moving video without dropping an opaque sheet on the picture. It is drawn as a `.background(alignment:)`, never as a stack child, because at 660 pt it is wider than the phone and would otherwise size the entire screen.

### Named Rules

**The No Shadow Rule.** Depth comes from tone and a hairline. If two surfaces are not separable, the fix is a hairline or a ground step — never a shadow, never a blur.

**The Tint Means Condition Rule.** A colored panel wash (5% fill, 30% border) is reserved for a panel that is reporting that condition. It is never used to make an ordinary container look interesting.

## Shapes

A four-step radius ladder — 3 pt hairline, 6 pt small, 10 pt medium, 12 pt large — with an 8 pt de facto "row" radius used for list rows, key caps, ledgers, and inline groups, and 7 pt inside the keyboard bar. Bottom sheets use an `UnevenRoundedRectangle` with 18 pt top corners only, so the sheet reads as arriving from the edge rather than floating.

Circles are reserved for radial and status geometry: hub spokes and their close button, condition dots, the pairing step markers, the spinner's 0.75-trimmed arc. Capsules mark transient or dismissible things: the stop pill on the remote screen, suggestion chips, the sheet grabber, the toggle track.

**Dashed strokes mean provisional.** A 4-4 or 5-5 dash marks anything not yet real, not yet measured, or not yet chosen: the placeholder rule standing in for a value, a pending exchange step, the side-by-side option before it is picked, the add-combo slot, the trackpad boundary hint, the hub's sweep ring, and an offline display's outline. A solid stroke means the thing exists.

Two custom silhouettes carry the instrument metaphor: **corner ticks** — four 11 pt L-shaped strokes inset 12 pt from the picture's edges, marking where the real pixels end so a zoomed frame never reads as a cropped one — and the **machine tiles** on the pairing screen, a 16×26 phone outline and a 30×20 display outline drawn at 1 pt, connected by the line that gives the product its name.

### Named Rules

**The Dashed-Is-Provisional Rule.** Dashed means unmeasured, pending, or unselected. It resolves to a solid stroke the moment the thing becomes real. Dashes are never used decoratively.

## Components

### Buttons

- **Shape:** gently rounded (10 pt) for filled actions, small-rounded (6 pt) for outlined ones, 8 pt for grid and dock buttons.
- **Primary:** a 76 pt filled bar in a signal color with matching ink — jade to proceed, cyan for a user-initiated action (wake, retry, new session), sodium when the user is proceeding into a degraded state. Left column carries a 19 pt medium sans title over a 10 pt mono-caps sub-label; the glyph (`→`, `↑`, `↻`, `＋`) sits right.
- **Sub-label is mandatory.** It states what the action will do and what it costs before the thumb commits: `MAIN · FIT · ~228MS TO FIRST FRAME`, `NUDGES THE DISPLAY · USUALLY 4S`, `AUTO-RETRY IN 14S · TAP TO GO NOW`.
- **Secondary:** outlined, 44 pt, mono-caps label in Text Secondary over a hairline border, no fill. Takes a red tint and a 50%-opacity red border when destructive.
- **Destructive confirm:** 60 pt filled clay with `#1B0805` ink, always paired with an outlined 52 pt keep-it action beneath, never beside.
- **Disabled:** 45% opacity on the whole control, plus `.disabled(true)`. No separate gray palette.
- **Pressed:** no dedicated pressed style; `.buttonStyle(.plain)` throughout, with `UIImpactFeedbackGenerator(style: .light)` on hub spokes, pad-mode switches, combos, and trackpad clicks. Touch feedback is haptic, not visual.

### Chips

- **Style:** capsule outline in hairline, 44 pt tall, 14 pt horizontal padding, 10 pt mono-caps in Text Secondary.
- **Use:** Claude follow-up suggestions only. They are shortcuts, so they never take a fill or a signal color.

### Cards / Containers

- **`Panel`** is the only container: 10 pt corners, Raised fill, hairline border, 18 pt interior padding. Passing a tint swaps the fill for that hue at 5% and the border for 30%.
- **Row groups** stack their rows on a Chrome background with 1 pt spacing, then clip the whole group to 8 pt — so the divider is the backing showing through, not a drawn line.
- **No card shadows, no card gradients.**

### Inputs / Fields

- **Text fields:** Panel fill, 6 pt corners, hairline border, 44 pt tall, mono at 13 pt. Address and key fields disable autocapitalization and autocorrect.
- **Code boxes** (pairing): six 48×64 pt boxes over one hidden `TextField` that owns the keyboard, so paste, delete, and one-time-code autofill behave exactly as iOS users expect. The focused box takes an 8%-cyan fill, a cyan border, and a blinking 2 pt cyan caret; filled boxes show 27 pt mono.
- **Composer:** 12 pt corners, Panel fill, 1–4 lines, 15 pt sans, paired with a 56 pt send button in solid cyan that becomes a 56 pt clay Stop while the agent is streaming.
- **Focus:** border shifts hairline → cyan and the fill picks up an 8% cyan wash. No glow, no ring.

### Navigation

Route-driven, not a tab bar: pairing → home → remote → claude → settings, held in `AppModel.route`. Screens carry their own chrome — a `ScreenHeader` with the `VibeWire` wordmark in 12 pt mono-caps at 4.1 tracking and a three-dot overflow, or a 44 pt back arrow with a 22 pt sans title. The Claude panel presents as a draggable sheet with a grabber and a drag-down-to-dismiss gesture; the diff, session picker, and combo editor are true sheets.

**Every glyph-only or outline-only target carries `.contentShape(Rectangle())`.** Hit testing follows drawn ink, so three 3 pt dots, an arrow glyph, a dashed box, and 9 pt caption text are all visually buttons and practically untappable without it.

### Segmented control

Custom, not `Picker`: equal-width 44 pt items separated by 1 pt of Hairline Dim showing through, clipped to 6 pt. Selected takes a 14% cyan wash with a cyan label; unselected sits on Raised with a Text Secondary label. An optional 5 pt dot badges a segment whose underlying thing is live. It writes its binding on every tap, so consumers must guard against re-selecting the current value.

### Toggle

Drawn in the system's shape but the app's colors: 52×30 capsule, cyan-30% fill with a cyan border and cyan knob when on, Chrome fill with a stroke border and a Text Tertiary knob when off. 24 pt knob, 3 pt inset.

### Signature components

**`Readout`** — a 9 pt mono-caps label over a 19 pt mono value with its unit at 11 pt in Text Tertiary, baseline-aligned with 1 pt of space. Three or four sit in a row inside a condition card. This is the atom the whole system is built from.

**`ConditionDot`** — an 8 pt filled circle whose pulse rate carries meaning: 2.6 s healthy, 1.4 s degraded, a hollow ring when idle. Pulse is suppressed entirely when video is live.

**`SignalBars`** / **`Sparkline`** — four ascending 4 pt bars for strength; twenty 4 pt bars for the 60-second RTT trace, with the most recent five drawn at full opacity and the rest at 42%, so "now" is legible inside the history.

**`KeyCap`** — 46 pt (52 pt in the latch tray), Chrome fill, 8 pt corners, glyph in mono over an optional 7 pt caption. When held: 18% cyan fill, cyan border, cyan glyph, and a 5 pt cyan dot in the top-trailing corner. One held-state treatment, used identically on the hub, the modifier bar, and the key row.

**`ToolRow`** — one 44 pt line per tool call: state marker (`✓` jade / `✕` clay / cyan spinner), mono name, mono target truncated at the middle, elapsed time right-aligned. Only a running call expands to show a 10 pt preview, and only a running call takes Screen Ground instead of Raised.

**`PermissionSheet`** — sodium-bordered bottom sheet stating the verbatim command in a Deep Ground code box, an explanation in 13 pt sans, and how long it has been waiting. Allow-once is a 56 pt filled cyan bar; Deny is a full-width outlined clay row beneath it; "Always allow this here" is demoted to a 9 pt mono-caps text button, deliberately far from the two taps that are reversible.

**Exchange steps** — four named rows with real detail values (`ED25519`, `STORED`) and per-step markers, instead of one indeterminate spinner. A failure lands on a specific step.

**Diff** — mono 11 pt on `#0B0E12`, jade on 8% jade for additions, clay on 8% clay for removals, cyan for hunk headers, Text Tertiary for metadata. Scrolls in both axes; the leading `+`/`−` is preserved so a copied diff is still a diff. The column's width is computed from the longest line rather than measured (`LG.Font.monoAdvance` — monospaced text advances 0.6 em per character), so the added and removed tints run the full width of the column instead of stopping raggedly at each line's own last character.

**`VideoCaption` / `.videoChip()`** — the ground any mark needs when it sits on the picture: 6 pt horizontal, 3 pt vertical, Deep Ground at 92%. Solid text on top. Defined once so a caption, the INPUT HERE badge, and the landscape live readout cannot drift apart, and so the contrast holds over a white document as well as a black one.

**Markdown** — blocks split locally, inline spans through `AttributedString`. Inline code takes mono 13 pt in cyan; bullets and numbers take cyan markers at 80%; block quotes take a 2 pt cyan-35% rule; fenced code gets its own ground, horizontal scrolling, and a copy button. No bubbles — Claude's turns run the full measure under a cyan `CLAUDE` label and a hairline.

### Named Rules

**The Preflight Rule.** A primary action always states, in its own sub-label, what it is about to do and what it will cost in time, resolution, or bytes.

**The Hit Shape Rule.** Any target whose ink does not fill its frame — glyphs, outlines, dashed boxes, caption text — must declare `.contentShape(Rectangle())`. This has caused four separate untappable controls in this codebase.

**The Consequence Rule.** A destructive confirmation lists three plain sentences: what is destroyed, what it takes to undo it, and what is *not* affected. The last line is what makes the tap safe to judge one-handed.

**The Reduce Motion Rule.** Reduce Motion is about the vestibular system, not about stillness. What goes is travel, scale, and spring — sheets fade in place instead of rising, the settings screen crossfades instead of pushing, the hub's spokes keep their staggered sequence but lose the scale-up, and the pairing dot rests at the midpoint of its wire instead of crossing it. What stays is anything that would otherwise state something false: the spinner keeps turning, because a frozen one says the Mac stopped answering and nothing measured that. Every loop routes through `LG.Motion.loop` / `linearLoop`, which return `nil` under the setting so `withAnimation` lands on the resting state in one step.

## Do's and Don'ts

### Do:

- **Do** derive every displayed condition from a measured value, through `Condition.from(...)`, so the label and the numbers cannot disagree.
- **Do** print `—` in Text Disabled for any value the host has not reported, at the size the real value will occupy.
- **Do** reserve Held Cyan (`#6BC7E8`) for state the user created — held modifiers, active selection, focused field, Claude — and Reachable Jade / Degraded Sodium / Lost Clay for what the Mac is doing.
- **Do** set every measured value, unit, path, key, and command in mono, and every sentence in sans.
- **Do** give each primary action a mono-caps sub-label stating its cost (`540P · SOFT TEXT UNTIL IT RECOVERS`).
- **Do** name the failure with its address and verdict — list both transports, their results, and the time of last contact rather than one word for "offline".
- **Do** add `.contentShape(Rectangle())` to any glyph-only, outline-only, or caption-sized target.
- **Do** separate surfaces with a 1 pt hairline (`#1A1E24` inside a group, `#262B33` at a container edge, `#2E343D` on an interactive edge) and a tonal step.
- **Do** compute a text color against the lightest ground it lands on, and clear 4.5:1 there. `chrome` (`#14171C`) is that ground, and a 7 pt key-cap caption is the case to check.
- **Do** give any mark over the Mac's picture its own ground with `.videoChip()`.
- **Do** hold layout with a dashed rule or em dash so nothing reflows when a value arrives.
- **Do** keep every tappable control at 44 pt or larger, and place destructive taps a full row away from irreversible ones.
- **Do** suppress ambient animation while video is live — pass `animated: false` the way `ConditionDot` does on the remote screen.
- **Do** route every perpetual loop through `LG.Motion.loop` / `linearLoop`, and every edge transition through `LG.Motion.rise` / `push`, so Reduce Motion is handled once rather than per view.
- **Do** land on a resting state that still reads correctly when a loop is suppressed — full opacity for the condition dot, midpoint for the pairing dot, outer radius for the teaching ring. A frozen mid-fade looks like a bug.
- **Do** keep motion at 120–180 ms for state changes; the only longer motions are the hub's 0.28 s spring with an 18 ms per-spoke stagger and the deliberately slow ambient loops on screens with no picture.

### Don't:

- **Don't** add a shadow, blur, or glassmorphic material. Depth is tone plus hairline, and the app has zero `.shadow()` calls today.
- **Don't** introduce a light mode or branch on `colorScheme`. `ScreenBody` pins `.preferredColorScheme(.dark)` and the palette assumes it.
- **Don't** use a signal color decoratively, or use cyan for a machine condition. A new color must declare which of the two voices it belongs to.
- **Don't** set text in `textDisabled` (`#3A404A`, 1.7:1). It is ink for a disabled control and fill for a dormant dot. If a mark is meant to be read — including the em dash that says "not measured" — it takes `textTertiary`.
- **Don't** lower a color's opacity to make it recede. Every alpha step is an unverified contrast ratio: `ink.opacity(0.66)` on the preflight line measured 4.50:1, and a 70% red count measured 3.4:1. Pick the dimmer color, or accept the solid one.
- **Don't** render a chat bubble, avatar, or typing-dot animation in the Claude panel. Prose runs the full measure under a label.
- **Don't** show a bare spinner in place of a value or a named step. Four named steps with real detail beat one indeterminate arc.
- **Don't** collapse distinct failures into one message. A timeout, a refused connection, a missing permission, and a sleeping Mac are four states with four answers.
- **Don't** wrap code or a diff. Scroll it horizontally; wrapped code lies about indentation and truncated code lies outright.
- **Don't** pass a text size below 9, or set a fixed `height` on a control that stacks text. The floor is enforced in `LG.Font` and the growth in `minHeight`; both exist because the app has to answer the reader's text size.
- **Don't** hard-code a new hex literal at a call site. Seven already exist outside the token file (`#C9A468`, `#C3C8D0`, `#A8AEB8`, `#0B0E12`, `#0D1014`, `#1E242C`, `#060709`); they are drift, not precedent — add the token instead.
- **Don't** put an oversized decorative layer in a `ZStack` as a sibling. Anything wider than the phone goes in `.background(alignment:)`, or it resizes the whole screen.
- **Don't** use dashes decoratively. A dashed stroke means unmeasured, pending, or unselected, and it resolves to solid when the thing becomes real.
- **Don't** attach two `.sheet` modifiers to one view — SwiftUI honors only the first. Move the second onto a child.
