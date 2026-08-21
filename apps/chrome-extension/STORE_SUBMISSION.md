# Chrome Web Store Submission

This checklist packages the built-in Ling Chrome integration for human review and Chrome Web Store
submission. It does not authorize publication or replace legal review.

## Listing

- Name: `Ling for Chrome`
- Category: `Productivity`
- Default language: English
- English summary: `Let Ling complete user-approved tasks in the Chrome tabs you connect.`
- Chinese summary: `让 Ling 在你连接的 Chrome 标签页中完成经你批准的任务。`

Single purpose:

> Ling for Chrome automatically connects the user's existing Chrome profile to the local Ling
> Desktop app through Chrome Native Messaging so
> Ling can list tabs, read a bounded visible-page snapshot, navigate, click, type and capture the
> visible viewport after the user enables the built-in plugin and approves the MCP tool call.

## Permission Justifications

| Permission | Justification |
| --- | --- |
| `scripting` | Inject the packaged Ling content script into the selected HTTP(S) tab only after an approved snapshot, click or type request. The manifest has no always-on content script. |
| `storage` | Store only the paused state and temporarily read/delete version 0.1.0 local pairing values during one-time migration. New connections never store a workspace, daemon URL, or credential. |
| `nativeMessaging` | Connect to the installed `com.lingstack.browser` Host, which forwards approved commands only to the private loopback broker of the Ling app running on the same computer. |
| `<all_urls>` | Chrome requires this host permission (or temporary `activeTab`) for `captureVisibleTab`; Ling needs durable, approved screenshot access after navigation. Runtime code rejects browser-internal, file, data and JavaScript URLs. |

The extension does not request `cookies`, `history`, `bookmarks`, `downloads`, `debugger`,
`tabs`, `activeTab` or `webRequest`.

Remote code declaration: `No`. All executable extension code is packaged in the submitted ZIP.

## Data Disclosure Draft

These disclosures are reflected in the public [Ling for Chrome Privacy Policy](PRIVACY.md):

- Page titles, HTTP(S) URLs, visible page text, interactive-element labels and visible screenshots
  are processed only when an approved Ling browser tool requests them.
- Text explicitly supplied to `chrome_type` is sent to the selected non-password page field.
- The extension exchanges data only with the installed Ling Browser Host and the private loopback
  broker selected by the fixed protocol; it has no analytics, advertising or remote telemetry endpoint.
- When an approved browser result is used in an AI task, Ling may include bounded relevant content
  in a request to the model provider configured and selected by the user.
- Version `0.1.1` may read a raw `0.1.0` pairing credential once for migration. Native success
  revokes its SHA-256 hash in Ling and deletes the credential, workspace, and daemon URL from Chrome.
- Ling run records may retain approved tool inputs and bounded results according to Ling's local run
  history policy.
- Password and file inputs, cookies, saved passwords, history and bookmarks are not read.

The popup presents a concise local-data disclosure and automatic connection status. Installing the
extension and enabling Chrome in Ling are the one-time authorization; actual browser tools still
require Ling approval. Review the dashboard categories for at least `Website content` and `Web
history`. Keep `Authentication information` declared for the one-time `0.1.0` credential migration.

The publisher contact email must be verified in the Dashboard before submission. Final submission
and publication remain human actions.

## Submission Assets

- First dashboard upload: `apps/chrome-extension/ling-for-chrome-store-bootstrap.zip`
- Final reviewed package: `apps/chrome-extension/ling-for-chrome.zip`
- Build metadata: `apps/chrome-extension/dist/build-metadata.json`
- Extension icons: `apps/chrome-extension/assets/icon-{16,32,48,128}.png`, derived from the current
  Ling project icon. Use `icon-128.png` for the Store listing.
- Small promotional image candidate: `apps/chrome-extension/store-assets/promo-440x280.png`, full
  bleed and text-free. Human visual approval is still required before submission.
- Screenshot size: 1280x800 or 640x400
- Prepared screenshot candidates live in `apps/chrome-extension/store-assets/screenshots/`.
- Suggested screenshots:
  - Plugin Manager showing Chrome as a Built-in plugin.
  - Chrome connection drawer showing automatic Host/extension detection.
  - Extension popup in Connected, Ling unavailable, and Paused states.

Use `STORE_LISTING.md` as the Dashboard field copy and `PRIVACY.md` as the policy source. The
Dashboard points to the public GitHub Gist recorded in `STORE_LISTING.md`; keep that Gist
byte-for-byte aligned with `PRIVACY.md` whenever the policy changes.

Generate the 1280x800 Plugin Manager screenshots without adding them to Git:

```sh
LING_CAPTURE_CHROME_PLUGIN_EVIDENCE=1 corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-plugin-manager-chrome.spec.ts
```

The output is `/tmp/ling-plugin-manager-chrome-light.png` and
`/tmp/ling-plugin-manager-chrome-dark.png`.

## Release Gate

1. Run `corepack pnpm --filter @ling-stack/chrome-extension test`.
2. Confirm the committed manifest key derives Dashboard Item ID
   `mbmlnnfhebclljonhedpjghbhibfapei`.
3. Run `corepack pnpm --filter @ling-stack/chrome-extension build` twice, confirm the ZIP hash is
   stable, and verify the built ID equals the Dashboard Item ID.
4. Complete privacy, permission, listing, contact, and reviewer-instruction fields.
5. Upload the final ZIP to the existing Dashboard item without changing the store-issued key.
6. Submit for review as a human publisher action.
7. Record the published Web Store URL in the release configuration.
8. Install from the Web Store in official Chrome and rerun the six-tool, revoke, prompt-injection
   boundary and cancellation acceptance flow.

Do not use enterprise force-install policy or command-line side loading as a substitute for normal
user installation. Native Messaging automates local app discovery after the user installs the
extension; it does not install the extension.

## Official Policy References

- [Supplying Images](https://developer.chrome.com/docs/webstore/images)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [chrome.tabs permissions and captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs)
