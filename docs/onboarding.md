# Mac onboarding update

The Mac window now opens as a dedicated four-stage setup flow: Welcome, Permissions, Connect your phone, Your account. The dashboard is unavailable until setup completes. Sidebar links, menu pane requests, keyboard shortcuts and URL fragments cannot dismiss the flow.

Both macOS permissions must be granted. Phone pairing can be done now or later. The final step requires email verification through Supabase, creating an account for a new address or signing in an existing one. The Mac independently verifies the returned access token before saving `vibewire.setup.completed.v2` in UserDefaults. Closing or restarting before completion does not mark setup done. Existing installations complete this new flow once.

Completed setup works offline on subsequent launches. Browser account requirements for remote connections remain a separate host setting.

## Regression checks

Run `npm run build:all --prefix web`, `swift build --package-path host`, `npm test --prefix host-electron`, and `node --test web/dashboard/test/account.test.mjs` from the repository root.

For visual checks, run `npm run dev:dashboard --prefix web`. The development-only `/test/index.html#settings` fixture must still show onboarding. `?permissions#settings` permits progression to the account screen. `?complete&permissions#settings` displays settings with long values and all update actions. Check 1040 × 680 and 1360 × 900 for horizontal overflow.

---

## Previous onboarding notes

# Device setup

The activation target is a real first connection: see the computer’s desktop on the phone, move its pointer, and click. A completed explanation is not a completed connection.

## Research and decisions

- [Apple: Onboarding](https://developer.apple.com/design/human-interface-guidelines/onboarding): keep onboarding brief, optional, and connected to actual use. VibeWire uses a working host checklist and a dismissible client guide rather than an overlay tour.
- [Apple: User privacy and data use](https://developer.apple.com/app-store/user-privacy-and-data-use/): explain access and respect permission choices. The Mac introduces Screen Recording and Accessibility separately before a user requests either. iPhone camera access is requested only after Scan; manual pairing remains available after denial.
- [Nielsen Norman Group: Onboarding tutorials versus contextual help](https://www.nngroup.com/articles/onboarding-tutorials/): help is easier to use at the point of need. Permission recovery sits beside its request; browser restrictions and away-from-home setup are expandable details.
- [Nielsen Norman Group: Progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/): defer advanced choices. Same Wi-Fi is the initial path; Tailscale and relay guidance are available without making remote networking a prerequisite.

## Surface direction

Operate mode, extending the incumbent Nightshift system. Large plain-language headings, existing violet action color, numbered steps only where order matters, hairline-separated sections, no overlays over the remote picture. Secondary information stays behind native disclosures. All new controls have at least 44-pixel/point hit areas; no new animation.

- **Host:** Setup guide is a permanent sidebar destination. A dashboard with no paired devices opens there unless a specific destination was requested. The Mac opens it on first launch and whenever permissions are missing, replacing unexplained startup permission prompts. Users may skip; a later launch can resume unfinished setup. Live host facts determine permissions, pairing, and video-sending status; no claim that the viewer decoded a frame or that a click succeeded.
- **Browser:** Introduces this device as the viewer, offers QR/manual pairing instructions, and explains origin-specific storage, local HTTP camera/clipboard restrictions, local-network prompts, and HTTPS/HTTP restrictions. A successful QR link can proceed directly to pairing. Dismissal is stored per origin and survives refresh; blocked storage does not break the guide. Replay from pairing or Settings.
- **iPhone:** Introduces the Mac/phone roles, explains Local Network before entering an address, and explains optional Camera access at Scan. Camera denial offers Settings or code entry. Dismissal uses AppStorage; replay from pairing or Settings. No automatic keyboard opening while reading.
- **Windows:** The shared host guide omits macOS permission buttons and explains keeping the computer unlocked.

No protocol changes, telemetry, new accounts, relay auto-enablement, or changes to trust semantics.

## Validation

- Web client and dashboard: TypeScript checks and production builds.
- Mac host: `swift build`.
- iPhone: unsigned generic-device Xcode build. Simulator execution is blocked on this machine by mismatched CoreSimulator versions (1171.2 installed, 1171.7 required).
- Browser visual inspection: 390×844 client and 1000×850 host fixture; checked visible skip, disclosure controls, readable wrapping, and persistence after skip/reload. The host fixture uses invented state and never grants actual system permissions.
- Remaining physical-device checks: deny/regrant macOS permissions and relaunch; deny/regrant iOS camera/local-network permissions; pair a real phone; confirm first picture and input; Dynamic Type/VoiceOver; Windows runtime.

## Integration with PR #9

PR #9 adds iPhone address discovery and failover. This work does not modify its networking files. Both touch SettingsView.swift in separate places (setup help after the header versus the new address section). Keep the address section when combining them. The onboarding remains grounded in main’s current features and does not promise automatic recovery from every network change.
