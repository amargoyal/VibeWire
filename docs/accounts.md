# Accounts

The activation target is unchanged: see the computer's desktop on the phone, move its pointer, click. An account is not on the path to that and never blocks it. What an account adds is memory that outlives a browser's site data, and one optional answer to a question pairing cannot answer — *who* is holding the phone.

## Research and decisions

- [Nielsen Norman Group: Onboarding — skip it when possible](https://www.nngroup.com/videos/onboarding-skip-it-when-possible/) and [Mobile-app onboarding](https://www.nngroup.com/articles/mobile-app-onboarding/): anything a person must get through before using the product reduces usability. So the account is the last step, after the wire is proven, and SKIP is a real answer that is remembered — asked once, not once per pairing.
- [Nielsen Norman Group: A checklist for registration and login forms on mobile](https://www.nngroup.com/articles/checklist-registration-login/): think twice before requiring registration at all; where it exists, make it painless. There is no password field, no confirm-password field, and no separate sign-up path — a first-time address makes an account and a returning one signs in.
- [Nielsen Norman Group: "Get Started" stops users](https://www.nngroup.com/articles/get-started/): an ambiguous call to action that drops someone into a funnel costs trust. The screen says what the account is for in one sentence and what is lost by skipping, and the button says SEND ME A CODE rather than "Get started".
- One-time codes over magic links as the first offer: a link opens in whichever browser the mail client hands it to, which on a phone is frequently the mail app's own in-app browser — signing in a browser that is not the one holding the pairing. Codes also autofill from the notification through `autocomplete="one-time-code"`. The link still works and is in the same email; it is the second offer, not the first.
- Codes also sidestep a problem specific to this product. The same bundle is served from `http://192.168.1.24:8787`, from a Cloudflare hostname that changes on every host restart, and from GitHub Pages. A redirect allowlist cannot be written for the middle one, and OAuth and magic links both need one. A code needs no redirect at all.
- Providers are asked for, not assumed: `GET /auth/v1/settings` reports which are enabled, and buttons are drawn only for those. The rule everywhere else in this client is that a control which cannot work is not drawn.

## What the account stores

| Table | Holds | Why it is not a credential |
|---|---|---|
| `profiles` | Email, display name | Mirrors `auth.users`, which a publishable key cannot read |
| `hosts` | Host id, name, platform, addresses, timestamps | A directory. Reaching a host still needs the signing key in the browser and a trust record in the host's keychain |
| `client_prefs` | One jsonb document: the keyboard bar's combos, whether the connect guide was read | Preferences |
| `client_devices` | Browsers signed into the account | A list of where you are signed in |

Not stored, by design: private keys, host public keys, pairing codes, frames, clipboard contents, Claude transcripts. Restoring from this directory still ends at the pairing screen with six digits to type, because that is the only thing that can make a host trust a browser.

Every table has row-level security and every policy is `auth.uid()` against the row's owner. `user_id` defaults to `auth.uid()`, so the client never states its own identity. The two `security definer` trigger functions have `execute` revoked from `anon` and `authenticated`, because a function in the `public` schema is otherwise callable over PostgREST.

## Requiring a sign-in

A host setting, off by default: **Require a signed-in browser**. It appears in the pairing sheet, in Settings, and as the last step of the host's setup guide.

- Off is the honest default. Pairing is already a key exchange this computer agreed to, and the device holding the key got it because someone read six digits off this screen.
- On, the host answers browsers signed into the account that owns it and nothing else. The first signed-in browser to connect while the setting is on claims the computer; that claim is written to `config.json`. Turning the setting off releases it.
- The iPhone app is unaffected. It authenticates with a key in the Secure Enclave and has no account to present.
- The token travels as the first message on the socket, never as a URL parameter — a browser cannot set a header on a WebSocket, and a token in a URL is a token in a log.
- The host verifies by asking the issuer (`GET /auth/v1/user`), not by reading the token. A host that checked the signature itself would keep answering a session that was revoked ten minutes ago. Answers are cached for a minute, keyed by a hash of the token.
- An account server the host cannot reach is a refusal, not a pass — and the client is told which of the two happened, so a dropped uplink does not read as a rejected sign-in.

## Configuring the Supabase project

Three things cannot be set from code and have to be done once in the dashboard, in this order.

1. **Set up custom SMTP.** Authentication → Emails → SMTP Settings. Supabase refuses to let the templates be edited until a project has its own SMTP, and its shared sender is capped at two emails an hour, so this is not optional for either reason. The project currently sends through Resend: host `smtp.resend.com`, port `465`, username `resend`, password a Resend API key, sender `onboarding@resend.dev`.
2. **Put the code in the email.** Authentication → Emails. The default Magic Link and Confirm Signup templates contain only `{{ .ConfirmationURL }}`. Add `{{ .Token }}` to both — and to the subject line, where a phone shows it in the notification and `autocomplete="one-time-code"` can lift it. Without it the six digits the sign-in screen asks for are in no email anyone receives. Confirm Signup matters as much as Magic Link: it is the template a first-ever address gets, which is most sign-ins at this stage.
3. **Allow the origins that can use a link.** Authentication → URL Configuration → Redirect URLs. Add the published client (`https://amargoyal.github.io/VibeWire/**`) and any fixed host address. A Cloudflare quick-tunnel hostname changes every restart and cannot be listed; the code path covers it.

### The sender is a placeholder, and its limit is real

`onboarding@resend.dev` is Resend's shared test sender. **It delivers only to the address on the Resend account that owns the key.** Anyone else who types their email into the sign-in screen gets a 403 at Resend and then waits for a code that was never sent — the client cannot tell that apart from a slow inbox, because the `POST /otp` that triggered it succeeded.

That is acceptable while the only person signing in is the person who owns the project, and it is the reason there is no VibeWire domain in this document. Before a second person signs in, buy a domain, verify it in Resend, and change the sender to something at that domain. `vibewire.app`, `vibewire.com` and `vibewire.dev` were taken as of 2026-09-21; `vibewire.io` and `vibewire.sh` were not.

Google and Apple are optional and need credentials from Google and Apple plus those same redirect URLs. Until a provider is enabled, its button is not drawn.

`VITE_SUPABASE_URL` / `VITE_SUPABASE_KEY` build the client against another project. `VIBEWIRE_ACCOUNT_URL` / `VIBEWIRE_ACCOUNT_KEY` do the same for either host. Clearing them leaves a build with no account screens and a requirement that cannot be switched on.

## Validation

- Web client and dashboard: TypeScript checks and production builds.
- Mac host: `swift build`.
- Windows host: `npx tsc --noEmit`.
- Live email round trip, against the real project: `POST /auth/v1/otp` returned 200, Resend reported the message delivered with the six digits in its subject, `POST /auth/v1/verify` with `type: "email"` returned a session, and the trigger had already written the `profiles` row. Only the account server's own address can receive one until the sender changes — see above.
- Not yet exercised: a provider sign-in, and a phone refused by a host with the requirement on.
