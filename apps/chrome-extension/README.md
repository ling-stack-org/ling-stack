# Ling for Chrome

Ling for Chrome is the auditable Manifest V3 extension used by the built-in Chrome plugin.

Production installation remains Chrome Web Store-owned. For local development only:

1. Run `corepack pnpm --filter @ling-stack/chrome-extension build`.
2. Open `chrome://extensions`, enable Developer mode, and choose `Load unpacked`.
3. Select `apps/chrome-extension/dist`.
4. Run `corepack pnpm ling browser-host install` once for this source checkout.
5. Enable Chrome in Ling Plugin Manager. The extension connects automatically while Ling is running.

The extension does not request access to cookies, passwords, history, bookmarks, downloads,
`chrome.debugger`, or `webRequest`. It uses `nativeMessaging` only to reach the signed local Ling
Browser Host; the Host forwards the existing reviewed browser protocol and does not read page data.
The `alarms` permission only wakes the Manifest V3 worker to restore that local connection after
Ling restarts or a temporary disconnect.

The production Chrome Web Store extension ID is `mbmlnnfhebclljonhedpjghbhibfapei`. The manifest
public key is committed so local builds and the Store package keep the same reviewed identity. The
legacy development ID remains daemon-allowlisted only for compatibility with earlier local builds.

Before publication, follow [Chrome Web Store Submission](STORE_SUBMISSION.md) and use the prepared
[Dashboard copy](STORE_LISTING.md), [privacy policy](PRIVACY.md), and
[store assets](store-assets/README.md). Publisher contact verification and final submission remain
human release gates.
