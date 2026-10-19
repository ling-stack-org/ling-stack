# Ling Mobile

This directory contains the iPhone-first Ling Mobile V1 conversation client. Unpaired
devices enter the secure QR flow; paired devices synchronize the PC conversation index,
channel/normal/teammate-direct transcripts, profile, and device-local appearance. Android
keeps compiling from the same Expo source but remains outside the current release gate.

The current source targets Expo SDK 58, React Native 0.88, and React 19.3. Expo modules,
including Secure Store 58, follow the SDK's published native dependency requirements.
The device evidence recorded below belongs to an older SDK 57 build; it must be rerun
on a new native build before accepting this SDK upgrade for a physical-device release.

Mobile uses TypeScript 7 for type checking. Expo Doctor currently recommends TypeScript
`~6.0.3` for SDK 58 and reports this version difference; the warning is not excluded.
Validate both `typecheck` and iOS/Android `expo export` when changing this compiler.

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

### Recorded Slice 1 device evidence

| Platform | Status | Device and build | Evidence |
| --- | --- | --- | --- |
| iOS | PASS — Slice 1 Secure Enclave physical-device gate closed; signed Release/TestFlight artifact gate pending | iPhone 13 Pro Max, iOS 26.5.2 (23F84), physical device, Debug Expo development client, app 0.0.1 (1) | Secure Enclave/non-exportability, shared fixtures, pin mutation, key lifecycle, and native-to-Node verification passed. |
| Android | PENDING | No physical Android device connected | S1 remains release-incomplete until the Android Keystore hardware gate is recorded. |

The iOS result was captured at `2026-07-19T15:05:36Z` from source revision
`037533a816af4ed6252079d17038096c1e53a430` with Xcode 26.6 (17F113),
Expo 57.0.7, and Node 24.15.0. The recorded, non-sensitive result summary is:

```json
{
  "backend": "ios_secure_enclave",
  "securityLevel": "secure_enclave",
  "hardwareBacked": true,
  "privateKeyExportable": false,
  "canonicalFixtureMatched": true,
  "allSigningFixturesVerified": true,
  "fixedGatewaySignatureVerified": true,
  "fixedDeviceSignatureVerified": true,
  "pairingHmacVerified": true,
  "gatewayFingerprintVerified": true,
  "changedGatewayFingerprintRejected": true,
  "signatureVerified": true,
  "mutatedMessageRejected": true,
  "reloadPublicKeyStable": true,
  "deleteInvalidatedKey": true,
  "regenerationRotatedPublicKey": true,
  "nodeCrossVerify": "PASS native-sign -> Node-verify"
}
```

The raw per-run public JWK, message, and signature are deliberately not retained or
committed. Reproduce them with the real-device fixture and immediately pass them to the
Node verifier above. This gate proves fixture-level Gateway identity pinning; the real
Tailscale Serve HTTPS/WSS path remains a later integration gate.

`react-types-mobile` is an npm alias for React 19 types. It intentionally keeps React 19
out of pnpm's hidden global `@types/react` hoist so the existing Web/UI 2.0 React 18
packages continue to typecheck; Mobile itself resolves the aliased 19.x declarations in
its `tsconfig.json`.
