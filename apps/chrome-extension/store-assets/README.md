# Chrome Web Store Assets

These are prepared submission candidates for Ling for Chrome. The image files are source-controlled
so the reviewed Store listing can be tied to the exact extension revision.

## Files

- `promo-440x280.png`: text-free small promotional image using the current Ling project icon.
- `screenshots/plugin-manager-light-1280x800.png`: English pairing flow with a non-live fixture code.
- `screenshots/plugin-manager-dark-1280x800.png`: Chinese connected state.
- `source/promo-440x280.html`: deterministic source for the promotional image.
- `source/ling-icon-512.png`: direct 512px render of the shared precision vector master.

The screenshots are generated from the Plugin Manager acceptance fixture. Before final publication,
compare them with the signed release build and obtain human approval; never capture a live pairing
credential, account name, private URL, or user workspace data.

## Regenerate

From the repository root:

```sh
corepack pnpm --filter @ling-stack/desktop generate:icons

corepack pnpm --filter @ling-stack/web exec playwright screenshot \
  --viewport-size "440, 280" \
  "file://$(pwd)/apps/chrome-extension/store-assets/source/promo-440x280.html" \
  "$(pwd)/apps/chrome-extension/store-assets/promo-440x280.png"

LING_CAPTURE_CHROME_PLUGIN_EVIDENCE=1 \
  corepack pnpm --filter @ling-stack/web exec playwright test \
  e2e/ui2-plugin-manager-chrome.spec.ts

cp /tmp/ling-plugin-manager-chrome-light.png \
  apps/chrome-extension/store-assets/screenshots/plugin-manager-light-1280x800.png
cp /tmp/ling-plugin-manager-chrome-dark.png \
  apps/chrome-extension/store-assets/screenshots/plugin-manager-dark-1280x800.png
```

Run `sips -g pixelWidth -g pixelHeight <file>` on macOS, or an equivalent PNG inspector, before
uploading. Expected dimensions are encoded in each filename.
