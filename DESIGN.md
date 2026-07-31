---
name: VibeWire
description: A dark instrument panel for holding a Mac in one hand — every mark on screen reports a measured value.
colors:
  reachable-jade: "#5CE4B1"
  degraded-sodium: "#F7C15F"
  lost-clay: "#F37272"
  held-violet: "#96ADFF"
  deep-ground: "#06070A"
  screen-ground: "#0F1114"
  raised: "#181A1F"
  raised-2: "#22252B"
  chrome: "#14161A"
  text: "#F2F3F6"
  text-secondary: "#A5A9B1"
  text-tertiary: "#777C84"
  text-faint: "#5F636B"
  text-disabled: "#3F4349"
  hairline: "#26292F"
  stroke: "#2F3339"
  on-jade: "#002D1D"
  on-sodium: "#2E1B00"
  on-clay: "#230707"
  on-violet: "#0E142C"
typography:
  display:
    fontFamily: "Instrument Sans, system sans"
    fontSize: "38pt"
    fontWeight: 600
    letterSpacing: "-0.035em"
  title:
    fontFamily: "Instrument Sans, system sans"
    fontSize: "26pt"
    fontWeight: 600
    letterSpacing: "-0.03em"
  action:
    fontFamily: "Instrument Sans, system sans"
    fontSize: "19pt"
    fontWeight: 600
    letterSpacing: "-0.02em"
  body:
    fontFamily: "Instrument Sans, system sans"
    fontSize: "15pt"
    fontWeight: 400
    letterSpacing: "normal"
  row-title:
    fontFamily: "Instrument Sans, system sans"
    fontSize: "15pt"
    fontWeight: 500
    letterSpacing: "-0.01em"
  label:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "9pt"
    fontWeight: 400
    letterSpacing: "1.4pt"
  label-wide:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "9pt"
    fontWeight: 400
    letterSpacing: "2.4pt"
  readout:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "19pt"
    fontWeight: 400
    letterSpacing: "-0.02em"
  readout-lead:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "26pt"
    fontWeight: 400
    letterSpacing: "-0.03em"
  code:
    fontFamily: "IBM Plex Mono, system monospaced"
    fontSize: "12pt"
    fontWeight: 400
    letterSpacing: "normal"
rounded:
  bar: "1pt"
  screen: "3pt"
  sm: "8pt"
  inner: "12pt"
  group-inner: "4pt"
  group-outer: "16pt"
  control: "16pt"
  card: "20pt"
  card-lg: "22pt"
  drawer: "28pt"
spacing:
  xs: "6pt"
  sm: "8pt"
  md: "12pt"
  lg: "16pt"
  card: "18pt"
  gutter: "20pt"
  section: "22pt"
components:
  action-primary:
    backgroundColor: "{colors.reachable-jade}"
    textColor: "{colors.on-jade}"
    typography: "{typography.action}"
    rounded: "{rounded.card}"
    padding: "12pt 22pt"
    height: "68pt"
  action-primary-violet:
    backgroundColor: "{colors.held-violet}"
    textColor: "{colors.on-violet}"
    rounded: "{rounded.card}"
    height: "68pt"
  action-filled:
    backgroundColor: "{colors.held-violet}"
    textColor: "{colors.on-violet}"
    rounded: "{rounded.control}"
    height: "56pt"
  action-destructive:
    backgroundColor: "{colors.lost-clay}"
    textColor: "{colors.on-clay}"
    rounded: "{rounded.control}"
    height: "60pt"
  action-outlined:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    height: "44pt"
  card:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.card}"
    padding: "18pt"
  card-tinted:
    backgroundColor: "rgba(247,193,95,0.07)"
    rounded: "{rounded.card}"
    padding: "18pt"
  group-row:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    typography: "{typography.row-title}"
    rounded: "{rounded.group-inner}"
    padding: "0 16pt"
    height: "58pt"
  group-row-selected:
    backgroundColor: "rgba(150,173,255,0.12)"
    textColor: "{colors.text}"
    rounded: "{rounded.group-inner}"
    height: "58pt"
  timeline-row:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    typography: "{typography.code}"
    height: "40pt"
  timeline-row-running:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.inner}"
    padding: "10pt 12pt"
  tile:
    backgroundColor: "{colors.raised-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.control}"
    height: "70pt"
  keycap:
    backgroundColor: "{colors.raised-2}"
    textColor: "{colors.text}"
    rounded: "{rounded.inner}"
    height: "46pt"
  keycap-held:
    backgroundColor: "rgba(150,173,255,0.20)"
    textColor: "{colors.held-violet}"
    rounded: "{rounded.inner}"
    height: "46pt"
  segment-track:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.inner}"
    padding: "3pt"
  segment-item-selected:
    backgroundColor: "rgba(150,173,255,0.16)"
    textColor: "{colors.held-violet}"
    typography: "{typography.label}"
    height: "38pt"
  field:
    backgroundColor: "{colors.raised-2}"
    textColor: "{colors.text}"
    typography: "{typography.code}"
    rounded: "{rounded.inner}"
    padding: "0 12pt"
    height: "44pt"
  code-block:
    backgroundColor: "{colors.deep-ground}"
    textColor: "{colors.text}"
    typography: "{typography.code}"
    rounded: "{rounded.inner}"
    padding: "13pt 14pt"
  drawer:
    backgroundColor: "{colors.raised}"
    rounded: "{rounded.drawer}"
    padding: "12pt 16pt"
---

# Design System: VibeWire — Nightshift

## Overview

**Creative North Star: "The Instrument Panel"**

VibeWire is a gauge cluster for one machine. Every mark on the glass reports something that was actually measured — round-trip time, packet loss, megabits, the age of the last good frame, how long a tool has been waiting on an answer. Nothing on screen is decoration wearing the costume of information. When a value has not been measured, the panel prints an em dash and holds the space, because an unmeasured value and a measured zero are different facts and the interface is not allowed to blur them.

Nightshift is the second turn of that system. It replaces **Longarm**, which drew the instrument out of hairlines on a near-black ground: every panel was a one-point border, every grouped list a stack of rules, and the accent was cyan. What it kept is the thesis. What changed is what carries the structure:

- **Filled surfaces, not hairlines.** A card is a lighter ground with a large corner, not a box drawn around nothing. Two greys apart survive a phone at minimum brightness outdoors, which a one-point line did not.
- **Violet is the user's colour.** Held keys, focus, Claude, the current selection. Cyan sat close enough to jade on a dim screen that a glance could confuse "the link is healthy" with "I left Command switched on"; violet cannot.
- **Grouped rows are one shape.** A list is a run of rows two points apart whose outer corners round and whose seams do not, so the group reads as one object and each row is still its own target.

And four screens were re-laid-out rather than repainted. **Home shows the Mac instead of describing it** — the last frame is the hero and the way in, so the numbers shrink to one strip. **The thumb-arc hub is gone**; its actions live in a labelled rail in the letterbox band and a drawer that never covers the picture. **Claude's tool calls became a timeline** and its permission prompt moved inline, so answering one no longer hides the sentence explaining it. **Pairing is one hero and one target card** instead of a graphic, two fields, a button and a status line.

The room is dark and stays dark. There is no light mode, no `colorScheme` branching, and no shadow anywhere in the app. Type does the second half of the work: monospace with wide tracking for anything counted or named by the machine, sans for prose the user reads at their own pace. The two never trade jobs.

**Key Characteristics:**
- Dark-only, six tonal grounds, zero shadows
- Monospace for measured, sans for prose — never interchangeable
- Four signal colours: three for the machine, one reserved for the user
- Filled cards and grouped rows instead of borders
- Every primary action states its own cost before it is tapped
- Motion is 120–180 ms state change; nothing decorative moves beside live video

## Colors

Defined in OKLCH — that is the source of truth in `web/src/design/nightshift.css` — and converted to sRGB literals for Swift, so the three clients cannot drift a step apart.

### Primary

- **Reachable Jade** (`#5CE4B1`, `oklch(0.83 0.14 165)`): the Mac is awake and the link is healthy. The condition dot, signal bars, RTT sparkline, the "View screen" action, added diff lines, git branch names, the `✓` on a completed tool call. Never used for anything the user switched on.
- **Held Violet** (`#96ADFF`, `oklch(0.765 0.13 272)`): the user's own state, and nothing else. Held and latched modifiers, the active code box and caret, the selected display, the selected pad mode, focus rings, Claude's turn marker and the whole Claude surface, zoom readouts. If violet is on screen, the user put it there.

### Secondary

- **Degraded Sodium** (`#F7C15F`, `oklch(0.84 0.13 80)`): a measured degradation, not a failure. A thin link, a stalled picture, a Mac that is asleep, a pending permission request, a modified file. Always attached to the number that justifies it (`JITTER 240MS`, `PAUSED 12S`).

### Tertiary

- **Lost Clay** (`#F37272`, `oklch(0.705 0.16 22)`): the path is gone, or the action destroys something. The unreachable strip, a failed exchange step, removed diff lines, revoke, and the Stop control on a running agent.

### Neutral

Six grounds, and every surface in the app is one of them:

- **Deep** (`#06070A`) — video and code. The darkest surface, reserved for places where the picture or the listing is the content.
- **Screen** (`#0F1114`) — the app.
- **Raised** (`#181A1F`) — a card, a row in a group, the composer.
- **Raised 2** (`#22252B`) — a control inside a card: a key cap, a tile, a field, a filled digit box.
- **Chrome** (`#14161A`) / **Chrome 2** (`#191B1E`) — the same apparent step as Raised, measured against Deep rather than Screen. Used only in the remote view, where the ground is darker.

Four steps of ink, each measured against the ground it lands on: **Text** 15.9:1, **Text Secondary** 7.4:1, **Text Tertiary** 4.6:1. **Text Faint** (`#5F636B`, 3.1:1) is deliberately below the body threshold — it is for the all-caps footnotes that repeat something already stated above, never for a sentence carrying information on its own. **Text Disabled** (`#3F4349`) is not for text at all: dormant indicator fills and disabled control ink only.

### Named Rules

**The Split-Voice Rule.** Jade, sodium and clay report what the **Mac** is doing. Violet reports what the **user** is doing. No colour crosses that line, which is what lets a glance in a dark room tell a degrading link from a latched modifier.

**The Redundant-Channel Rule.** A lost condition is drawn as a **square**, every other condition as a circle. Colour alone cannot carry "this is the bad one" for a reader who cannot separate red from green, and the shape costs nothing.

## Typography

Two families, drawn in **Instrument Sans** and **IBM Plex Mono**, falling back to the platform's own faces. The fallback is not a compromise to fix later: this page is usually served by the Mac on a local network with no route to a font CDN, and an instrument that waits on a webfont to say whether the link is up has its priorities wrong. The grammar — the weights, the tracking, the caps — is what carries the design.

- **Display** (38 / 36 / 30 / 26 pt, weight 600, tracking −0.035em): the machine name, the pairing headline, a screen title. Tight tracking and a semibold weight are what make a machine name read as a title rather than as large body copy.
- **Body** (15 pt, 1.5 line height): prose. Row titles take weight 500 and −0.01em.
- **Mono caps** (8–11 pt, tracking 1.4pt, 2.4pt for section headings): every readout heading, status line, unit, path, key and command.
- **Readout** (19 pt mono, or 26 pt for the one reading that is the reason to look at the card): measured values, with the unit set at 10 pt in Text Tertiary.

Every size is a designed value scaled against the standard text style nearest it, so raising the OS or browser text size scales the whole instrument the way Dynamic Type does. Nothing renders below 9 pt, whatever the setting: the instrument is dense on purpose, but a 6 pt caption is not density — it is a value nobody can read.

### Named Rules

**The Two-Families Rule.** Monospace for anything the machine measured or named. Sans for anything a person wrote. They never trade jobs, so the eye learns in one screen which parts of the panel are readings and which are sentences.

**The Lead-Reading Rule.** Where three numbers sit in a strip, one of them is why the card exists — RTT, on Home. It is set larger than the other two, because three numbers at the same size is a table and the eye has to read all of it.

## Layout

A single column bounded at 560 pt and centred, with a 20 pt gutter, on every screen but the remote view. Past **900 pt** the column stops being a column: Home becomes a picture and its actions on the left with a 320 pt rail of readings on the right, and the remote view's letterbox rail becomes a 276 pt dock down the right-hand side. The split is taken from the width of the window, never from a device class, so a tablet in Split View gets whichever layout its actual width earns.

On the web that switch is a **container query** on the screen itself, and the DOM order is the phone's order — grid areas do the rearranging, so nothing is rendered twice and there is no `isDesktop` anywhere in the client. On iOS it is a `GeometryReader` reading the same threshold.

The remote view is the exception: it runs edge to edge, and the chrome lives in the letterbox bands a 16:10 desktop leaves inside a phone's glass. The trackpad reaches past the video into those bands, so the first accidental swipe in the dark area still moves the cursor — which is what teaches it.

## Elevation & Depth

**No shadows anywhere in the app.** Depth is six tonal grounds and a corner radius. A control that sits inside a card is one step lighter than the card; a control inside *that* is one step lighter again, and one corner step tighter. Those three steps are what make a nested control read as nested without a single line being drawn.

Lines survive only where a gap cannot do the job: the divider in the wide header, the top edge of a destructive drawer, the rail on the Claude timeline. Nightshift draws roughly a fifth as many of them as Longarm did.

## Shapes

A corner ladder taken from the containment depth rather than from a t-shirt scale: **card 20**, **control 16**, **inner 12**, **small 8**, **screen 3**, **bar 1**. The last two are not containers: `screen` is the outline of a monitor drawn small, and `bar` is the tip of a 3 pt bar in the signal strength and the RTT trace — square-ended, a row of twenty of them is a picket fence. A drawer takes **28** on its top corners only, larger than a card's so it reads as arriving from off-screen rather than as a card that grew. The screen radius is deliberately tight — a 22 pt rectangle with a 16 pt corner reads as a pill, not as a monitor.

**Grouped rows use two radii.** The outer corners of the run take 16; the seams between rows take 4. That is what makes a run of rows read as one object while each row keeps its own 2 pt gap and its own tap target. The rule lives in CSS `:first-child` / `:last-child` and in a `GroupPosition` enum on iOS, so a row never has to be told where in the list it sits.

Circles are reserved for status geometry: condition dots, timeline markers, the spinner's 0.75-trimmed arc, the rotation dial. Capsules mark transient things: the connection pill on the wide header, suggestion chips, the drawer grabber, the toggle track.

**Dashed strokes mean provisional.** A 4-4 dash marks anything not yet real, not yet measured, or not yet chosen: the placeholder rule standing in for a value, a pending exchange step, the side-by-side option before it is picked, the add-combo slot, an offline display's outline. A solid stroke means the thing exists.

Two custom silhouettes carry the instrument metaphor: **corner ticks** — four 11 pt L-shaped strokes inset 12 pt from the picture's edges, marking where the real pixels end so a zoomed frame never reads as a cropped one — and the **hatch**, a 135° two-grey stripe standing in for a picture that has not arrived. An empty frame, never a black one, because a black rectangle is a claim about what the Mac is displaying.

### Named Rules

**The Dashed-Is-Provisional Rule.** Dashed means unmeasured, pending, or unselected. It resolves to a solid stroke the moment the thing becomes real. Dashes are never used decoratively.

**The Containment-Radius Rule.** Card 20 → control 16 → inner 12. A control never takes a corner equal to or larger than the thing containing it.

## Components

### Buttons

- **Primary:** a 68 pt filled card in a signal colour with matching ink — jade to proceed, violet for a user-initiated action (wake, retry, new session), sodium when the user is proceeding into a degraded state. A 19 pt semibold title over a 9 pt mono-caps sub-label; the glyph (`→`, `↑`, `↻`, `＋`) sits right.
- **Sub-label is mandatory.** It states what the action will do and what it costs before the thumb commits: `BUILT-IN · FIT · ~228MS TO FIRST FRAME`, `NUDGES THE DISPLAY · USUALLY 4S`, `AUTO-RETRY IN 14S · TAP TO GO NOW`.
- **Filled:** 56 pt, no sub-label, `radius.control` — "Allow once", "Copy image", a destructive confirm at 60 pt.
- **Outlined:** 44 pt minimum, mono-caps label, a one-point outline drawn *inside* the box so a row of these lines up with a filled sibling of the same declared height. Takes a clay tint and a 50 %-clay edge when destructive.
- **Quiet:** label only, no fill and no edge — the third option on a destructive sheet, the standing grant on a permission prompt. Deliberately weightless.
- **Disabled:** 45 % opacity on the whole control. No separate grey palette.
- **Pressed:** no visual pressed style; touch feedback is haptic.

### Cards and groups

- **`Card`** is the filled container: `radius.card`, Raised fill, no border, 16–18 pt interior padding. Passing a tint swaps the fill for that hue at 7 % and adds a 34 % outline — the wash carries the colour, and the outline keeps the edge findable where the wash is too faint.
- **`Group`** is a run of rows at 2 pt spacing with the two-radius corner treatment. It replaced Longarm's "stack on a chrome background and clip", which drew its dividers by letting the backing show through.
- **No card shadows, no card gradients.**

### Inputs

- **Text fields:** Raised 2 fill, `radius.inner`, 44 pt tall, mono at 13 pt, no border. Address and key fields disable autocapitalisation and autocorrect.
- **Code boxes** (pairing): six flexible-width 84 pt boxes over one hidden field that owns the keyboard, so paste, delete and one-time-code autofill behave exactly as the platform's users expect. The focused box takes a 12 %-violet fill, a 1.5 pt violet outline and a blinking 2 pt violet caret; a filled box takes Raised 2 and 30 pt mono; an empty one takes Raised.
- **Composer:** `radius.card`, Raised fill, 1–4 lines, 15 pt sans, paired with a 52 pt send button in solid violet that becomes a 52 pt clay Stop while the agent is streaming.
- **Focus:** a 2 pt violet outline at 2 pt offset. No glow.

### Navigation

**Three routes and two sheets — no navigation stack, and that is deliberate.** The route holds only the places the app can *be*: pairing → home → remote. Settings and the Claude panel are sheets over whichever of those is showing. Settings is not deeper than Home, it is beside it, and a stack would buy one chevron at the cost of a navigation model nothing else needs.

**The Claude sheet opens at the height its context calls for:** half from the remote screen, where there is a live picture worth keeping in view, and full from Home, where there is nothing below to see. Derived at presentation, never remembered — a stored detent would be exactly the hand-set flag the Measured Condition Rule exists to forbid.

**Every glyph-only or outline-only target carries a full-box hit shape.** Hit testing follows drawn ink, so three 3 pt dots, an arrow glyph, a dashed box and 9 pt caption text are all visually buttons and practically untappable without it.

### Segmented control

A padded track with a filled thumb, not a row of bordered cells: 3 pt of padding on a Raised track at `radius.inner`, with the selected item taking a 16 % violet wash and a violet label at `radius.inner − 3`. An optional 5 pt dot badges a segment whose underlying thing is live.

### Signature components

**`Readout`** — a mono-caps label over a mono value with its unit at 10 pt in Text Tertiary. Three sit in a row inside the condition strip, the first at 26 pt and the others at 19. This is the atom the whole system is built from.

**`ConditionDot`** — a 9 pt circle whose pulse rate carries meaning: 2.6 s healthy, 1.4 s degraded, a hollow ring when idle, and a **square** when lost. Pulse is suppressed entirely when video is live.

**The hero** — the last frame the Mac sent, at whatever age it is, as the largest thing on Home and as the button that starts the stream. A picture of the thing being reached for is a better target than a word for it. It carries two chips: the frame's age, and which display it is. When nothing has been decoded it is a hatched frame with its corner ticks.

**The rail** — the control layer in the remote view's lower band. Four things left to right: what one finger does (the only mode, so the only segmented control), the keyboard, Command, and everything else. `⌘` latches directly rather than opening the drawer to it — it is the modifier a Mac actually needs, and one tap instead of two is the difference between using it and not.

**The command drawer** — what replaced the thumb arc. Six labelled tiles in a four-column grid plus a permanent modifier section, rising from the bottom edge and stopping short of the picture. The arc only fitted a right thumb, its two-word captions had to be learnt rather than read, and it sat over the one surface this app exists to show.

**`KeyCap`** — 46 pt (52 in the drawer), Raised 2 fill, `radius.inner`, glyph over an optional 8 pt caption. When held: 20 % violet fill, violet outline, violet glyph, and a 5 pt violet dot in the top-trailing corner. One held-state treatment, used identically in the drawer, the modifier row and the key row.

**The timeline** — Claude's tool calls. A rail down the left says these happened in sequence; a finished call is one 40 pt line (verb, target, elapsed), and the running one becomes a card with its output in it, because that is the only one whose output is still news. A boxed list of equal rows said nothing about order and made twenty calls look like a table.

**The permission card** — sodium-tinted, at the end of the transcript rather than pinned over it. The verbatim command in a Deep-ground code block, an explanation in 13 pt sans, and how long it has been waiting. Allow-once is a filled violet bar; Deny is a full-width outlined clay row beneath it; "Always allow this here" is demoted to a quiet 9 pt text button, deliberately far from the two taps that are reversible. Everything else on screen dims to 50 % and the composer says `Answer the question first…`, so there is exactly one thing to do.

**Exchange steps** — four named rows in a group, with real detail values (`ED25519`, `STORED`) and per-step markers, instead of one indeterminate spinner. A failure lands on a specific step. The running step takes a 10 % violet wash.

**Diff** — mono 11 pt on Deep, jade on 10 % jade for additions, clay on 10 % clay for removals, violet for hunk headers. Scrolls in both axes; the leading `+`/`−` is preserved so a copied diff is still a diff.

**`VideoCaption`** — the ground any mark needs when it sits on the picture: 8 × 4 pt padding, `radius.sm`, Deep at 92 %, solid text on top. Alpha cannot be verified against content nobody controls — a caption at 34 % white measures 2.9:1 over a black desktop and 1.0:1 over a white document, which is what a text editor actually looks like.

**Markdown** — no bubbles. Claude's turns run the full measure under a violet `CLAUDE` label and a hairline; inline code takes mono in violet; fenced code gets its own Deep ground, horizontal scrolling and a copy button.

### The Mac host

The host follows macOS rather than iOS: a menu bar item and one window. The menu opens with **three measured values before any menu item** — the machine, whether a client is attached and how many screens are going out, and which path it is on — because the reason to open that menu is almost always to check whether the Mac is still serving. Drawn as a view rather than as greyed-out menu entries, since these are readings, not disabled commands.

The pairing window is the one exception to "follow the platform", and it earns it: it is the only screen a user compares side by side with the phone in their other hand. It is drawn in the app's own colours — six digit boxes, a rotation dial, one card per way in — so the digits on the Mac and the boxes on the phone look like the same instrument.

### Named Rules

**The Preflight Rule.** A primary action always states, in its own sub-label, what it is about to do and what it will cost in time, resolution or bytes.

**The Hit Shape Rule.** Any target whose ink does not fill its frame — glyphs, outlines, dashed boxes, caption text — must declare a full-box hit shape. This has caused four separate untappable controls in this codebase.

**The Consequence Rule.** A destructive confirmation lists three plain sentences: what is destroyed, what it takes to undo it, and what is *not* affected. The last line is what makes the tap safe to judge one-handed.

**The Never-Cover-The-Picture Rule.** Nothing that can be answered, dismissed or ignored is allowed to sit over the Mac's screen. The drawer stops short of the band, the stall card sits above the rail, and the permission prompt is in the transcript. This is the rule the thumb arc broke.

**The Reduce Motion Rule.** Reduce Motion is about the vestibular system, not about stillness. What goes is travel, scale and spring — sheets fade in place instead of rising. What stays is anything that would otherwise state something false: the spinner keeps turning, because a frozen one says the Mac stopped answering and nothing measured that.

## Do's and Don'ts

### Do:

- **Do** derive every displayed condition from a measured value, through `conditionFrom(...)` / `Condition.from(...)`, so the label and the numbers cannot disagree.
- **Do** print `—` in Text Tertiary for any value the host has not reported, at the size the real value will occupy.
- **Do** reserve Held Violet for state the user created — held modifiers, active selection, focused field, Claude — and jade / sodium / clay for what the Mac is doing.
- **Do** set every measured value, unit, path, key and command in mono, and every sentence in sans.
- **Do** give each primary action a mono-caps sub-label stating its cost.
- **Do** name the failure with its address and verdict — list both transports, their results, and the time of last contact rather than one word for "offline".
- **Do** let a group's corners come from position in the run, never from a prop passed at the call site.
- **Do** state the OKLCH definition in the web token file and derive the Swift literal from it, so the three clients cannot drift.

### Don't:

- **Don't** add a shadow, a gradient, or a light mode.
- **Don't** draw a border around something that already has a fill. Two greys apart is the separation.
- **Don't** spend violet on anything the machine did, or jade on anything the user switched on.
- **Don't** put a control over the Mac's picture that could have gone in the band beside it.
- **Don't** show a spinner where four named steps with real values would say the same thing and survive a failure.
- **Don't** let a value render below 9 pt, whatever the reader's text size.
- **Don't** use a dashed stroke decoratively — it means provisional, everywhere, or it means nothing.
