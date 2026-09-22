# Accounts

Mac setup requires a verified account as its final step. The host remembers completion, so normal launches remain available offline. Remote browser account enforcement is a separate setting. The email-code flow below serves both sign-in and account creation.

For the phone client, the activation target is unchanged: see the computer's desktop on the phone, move its pointer, click. An account is not on the path to that and never blocks it. What an account adds is memory that outlives a browser's site data, and one optional answer to a question pairing cannot answer — *who* is holding the phone.

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

1. **Set up custom SMTP.** Authentication → Emails → SMTP Settings. Supabase refuses to let the templates be edited until a project has its own SMTP, and its shared sender is capped at two emails an hour, so this is not optional for either reason. The project currently uses Gmail SMTP; see the sender notes below.
2. **Put the code in the email.** Authentication → Emails. The default Magic Link and Confirm Signup templates contain only `{{ .ConfirmationURL }}`. Add `{{ .Token }}` to both — and to the subject line, where a phone shows it in the notification and `autocomplete="one-time-code"` can lift it. Without it the six digits the sign-in screen asks for are in no email anyone receives. Confirm Signup matters as much as Magic Link: it is the template a first-ever address gets, which is most sign-ins at this stage.
3. **Allow the origins that can use a link.** Authentication → URL Configuration → Redirect URLs. Add the published client (`https://amargoyal.github.io/VibeWire/**`) and any fixed host address. A Cloudflare quick-tunnel hostname changes every restart and cannot be listed; the code path covers it.

### Gmail sender

The project now uses a Gmail SMTP sender in place of Resend's restricted test sender. The SMTP host is `smtp.gmail.com`, port `465`, with the sender address as the username and a Google app password stored only in Supabase. Never commit SMTP credentials.

Gmail is a personal mail service with sending limits and deliverability constraints. Move to a verified domain and transactional provider when usage grows. Verify both signup and returning-user emails after changing the sender.

Google is optional. Until it is enabled, its button is not drawn, in the browser client and in Mac setup alike. Apple is not offered: it needs a paid Apple Developer account.

### Provider redirect URLs

Both providers return to Supabase at `https://iqtuikhyqkythaffxuca.supabase.co/auth/v1/callback`, and Supabase then returns to the page that asked. Mac setup asks from the host itself, so add `http://127.0.0.1:*/**` to Redirect URLs beside the published client. Without it, a Mac setup sign-in lands on the Site URL and is refused there.

### Google

1. In Google Cloud Console, configure the OAuth consent screen: External, app name `VibeWire`, authorized domains `amargoyal.github.io` and `iqtuikhyqkythaffxuca.supabase.co`, home page `https://amargoyal.github.io/VibeWire/`, privacy policy `https://amargoyal.github.io/VibeWire/privacy.html`, terms `https://amargoyal.github.io/VibeWire/terms.html`.
2. Create an OAuth client ID of type Web application. Origin `https://amargoyal.github.io`, redirect URI the Supabase callback above.
3. In Supabase, Authentication → Sign In / Providers → Google: enable it and paste the client ID and secret.
4. Publish the consent screen. In Testing mode only listed test users can sign in. A logo sends the app through brand verification first.

### Apple

Needs a paid Apple Developer account.

1. An App ID with Sign in with Apple enabled.
2. A Services ID, for example `com.amargoyal.vibewire.web`, with Sign in with Apple configured: domain `iqtuikhyqkythaffxuca.supabase.co`, return URL the Supabase callback above. The Services ID is the client ID.
3. A key with Sign in with Apple enabled. Download the `.p8` once and keep it out of the repository. Note its Key ID and the Team ID.
4. Sign a client secret JWT with that key (ES256, `iss` the Team ID, `sub` the Services ID, `aud` `https://appleid.apple.com`).
5. In Supabase, Authentication → Sign In / Providers → Apple: enable it, add the Services ID to Client IDs, and paste the JWT as the secret.

Apple caps the client secret at six months. When it expires, Apple sign-in fails until a new JWT is signed from the same `.p8` and pasted into Supabase.

`VITE_SUPABASE_URL` / `VITE_SUPABASE_KEY` build the client against another project. `VIBEWIRE_ACCOUNT_URL` / `VIBEWIRE_ACCOUNT_KEY` do the same for either host. Clearing them leaves a build with no account screens and a requirement that cannot be switched on.

## Validation

- Web client and dashboard: TypeScript checks and production builds.
- Mac host: `swift build`.
- Windows host: `npx tsc --noEmit`.
- Live email round trip, against the real project: `POST /auth/v1/otp` returned 200, Resend reported the message delivered with the six digits in its subject, `POST /auth/v1/verify` with `type: "email"` returned a session, and the trigger had already written the `profiles` row. This historical check used the former Resend test sender. The Gmail migration requires a fresh delivery check.
- Not yet exercised: a live Google or Apple sign-in, in the browser client or through Mac setup, and a phone refused by a host with the requirement on.
