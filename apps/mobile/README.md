# Ling Mobile

This directory currently contains the Slice 1 secure-device-key development build. It is
not the final Mobile UI.

The app-local Expo module exposes only four operations: generate/load a key, sign bytes,
verify a signature, and delete the key. It has no private-key export API. Canonical JSON
and signing transcripts stay in `@ling-stack/remote-protocol`; native code receives only
bytes and returns the platform's X9.62 DER signature, which the adapter converts to the
fixed 64-byte V1 wire encoding.

## Local static validation

```bash
corepack pnpm --filter @ling-stack/mobile typecheck
corepack pnpm --filter @ling-stack/mobile test
corepack pnpm --filter @ling-stack/mobile run doctor
corepack pnpm --dir apps/mobile exec expo-modules-autolinking search --platform ios --json
corepack pnpm --dir apps/mobile exec expo-modules-autolinking search --platform android --json
```

`expo prebuild --clean --no-install` may be used to inspect generated native projects;
top-level `ios/` and `android/` are intentionally ignored and must not be committed.

## Real-device security gate

1. Build an Expo development client on a physical iPhone and Android device.
2. Run the in-app fixture. It must match and native-verify all five shared pairing/auth
   signing fixtures, match the pairing HMAC, sign, verify, and reject a one-byte mutation.
   It must also retain the same public key across reload, invalidate signing after delete,
   and rotate the public key after regeneration.
3. iOS must report `ios_secure_enclave`, `secure_enclave`, and
   `privateKeyExportable=false`. Simulator failure is expected and must not trigger a
   software fallback.
4. Android must report `android_keystore`, `privateKeyExportable=false`, and its actual
   `KeyInfo` security level. `strongbox`/`trusted_environment` are hardware-backed;
   `software` is explicit reduced assurance, not a JavaScript key fallback.
5. Replace the pinned Gateway public-key fingerprint in the fixture. Both platforms must
   reject the changed application identity after normal TLS validation succeeds.
6. Copy `nodeInteropEvidence` from the result into the Node fixture verifier. Node must
   verify the physical device's P1363 signature over the reported message bytes.

```bash
corepack pnpm --filter @ling-stack/mobile build:deps
corepack pnpm --filter @ling-stack/mobile verify:native-evidence < device-evidence.json
```

Hosted simulators can prove compilation and autolinking, but cannot close the hardware
gate. S1 remains release-incomplete until the physical-device evidence is recorded.

`react-types-mobile` is an npm alias for React 19 types. It intentionally keeps React 19
out of pnpm's hidden global `@types/react` hoist so the existing Web/UI 2.0 React 18
packages continue to typecheck; Mobile itself resolves the aliased 19.x declarations in
its `tsconfig.json`.
