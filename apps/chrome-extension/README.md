# Ling for Chrome

Ling for Chrome is the auditable Manifest V3 extension used by the built-in Chrome plugin.

Production installation remains Chrome Web Store-owned. For local development only:

1. Run `corepack pnpm --filter @ling-stack/chrome-extension build`.
2. Open `chrome://extensions`, enable Developer mode, and choose `Load unpacked`.
3. Select `apps/chrome-extension/dist`.
4. Enable Chrome in Ling Plugin Manager and enter the generated pairing code in the extension popup.

The extension does not request access to cookies, passwords, history, bookmarks, downloads,
`chrome.debugger`, `webRequest`, or native messaging.

The stable development extension ID is `ggmhibjboaedlnidbemkefonahjgcapc`. It is not the production
Chrome Web Store Item ID. The Store bootstrap flow obtains the production public key before release.

Before publication, follow [Chrome Web Store Submission](STORE_SUBMISSION.md) and use the prepared
[Dashboard copy](STORE_LISTING.md) plus [store assets](store-assets/README.md). A reviewed public
privacy-policy URL and publisher account remain human release gates.
