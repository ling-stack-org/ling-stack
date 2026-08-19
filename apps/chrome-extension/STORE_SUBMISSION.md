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

> Ling for Chrome connects the user's existing Chrome profile to the local Ling Desktop daemon so
> Ling can list tabs, read a bounded visible-page snapshot, navigate, click, type and capture the
> visible viewport after the user enables the built-in plugin and approves the MCP tool call.

## Permission Justifications

| Permission | Justification |
| --- | --- |
| `scripting` | Inject the packaged Ling content script into the selected HTTP(S) tab only after an approved snapshot, click or type request. The manifest has no always-on content script. |
| `storage` | Store the local Ling workspace binding and revocable pairing credential on this Chrome profile. |
| `<all_urls>` | Chrome requires this host permission (or temporary `activeTab`) for `captureVisibleTab`; Ling needs durable, approved screenshot access after navigation. Runtime code rejects browser-internal, file, data and JavaScript URLs. |

The extension does not request `cookies`, `history`, `bookmarks`, `downloads`, `debugger`,
`tabs`, `activeTab`, `webRequest` or `nativeMessaging`.

Remote code declaration: `No`. All executable extension code is packaged in the submitted ZIP.

## Data Disclosure Draft

These disclosures are reflected in the public [Ling for Chrome Privacy Policy](PRIVACY.md):

- Page titles, HTTP(S) URLs, visible page text, interactive-element labels and visible screenshots
  are processed only when an approved Ling browser tool requests them.
- Text explicitly supplied to `chrome_type` is sent to the selected non-password page field.
- The extension exchanges data only with the loopback Ling daemon selected by the fixed protocol;
  it has no analytics, advertising or remote telemetry endpoint.
- When an approved browser result is used in an AI task, Ling may include bounded relevant content
  in a request to the model provider configured and selected by the user.
- The raw pairing credential remains in `chrome.storage.local`. Ling persists only its SHA-256 hash.
- Ling run records may retain approved tool inputs and bounded results according to Ling's local run
  history policy.
- Password and file inputs, cookies, saved passwords, history and bookmarks are not read.

The unpaired popup presents this disclosure before connection and keeps Connect disabled until the
user checks the explicit-consent control. Review the dashboard categories for at least `Website
content` and `Web history`; separately confirm whether the local Ling pairing credential should be
declared as `Authentication information`.

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
  - Connect Chrome drawer with the pairing flow; do not include a live pairing credential.
  - Extension popup in Connected and Unpaired states.

Use `STORE_LISTING.md` as the Dashboard field copy and `PRIVACY.md` as the stable public policy.

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

Do not use enterprise force-install policy, native messaging or command-line side loading as a
substitute for normal user installation.

## Official Policy References

- [Supplying Images](https://developer.chrome.com/docs/webstore/images)
- [Fill out the privacy fields](https://developer.chrome.com/docs/webstore/cws-dashboard-privacy)
- [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq)
- [chrome.tabs permissions and captureVisibleTab](https://developer.chrome.com/docs/extensions/reference/api/tabs)
