# T13-K-C Web Release Evidence

- Status: `captured`
- Capture state: `captured-12-of-12`
- Verification state: `verifier-passed`
- Visual review state: `reviewed-12-of-12`
- Served artifact: Vite source through the Playwright web server
- Source identity: `0a0b80502715+worktree-ea5788616335`

This directory is the release-level evidence ledger for 12 representative Web surfaces. The manifest, PNG files, and JSON sidecars were written by one gated single-worker capture and share the same pre-capture source identity. The read-only verifier passed after capture, and all 12 original-size screenshots were manually reviewed for intended-surface visibility, overlap, horizontal overflow, and obvious fixture noise.

This closes only the representative Web release gate. It does not promote Function IDs outside the recorded scenarios, does not make UI 2.0 globally complete, and is not packaged Desktop evidence. Signed/package macOS and Windows verification remains pending.

Capture command:

```bash
LING_CAPTURE_UI2_EVIDENCE=1 LING_PLAYWRIGHT_PORT=4260 corepack pnpm --filter @ling-stack/web exec playwright test e2e/ui2-web-release-gate.spec.ts --workers=1
```

Read-only verification command:

```bash
node apps/web/scripts/verify-ui2-release-evidence.mjs
```

The verifier rejects missing fields, duplicate or empty identifiers, invalid viewport/theme/locale values, browser errors, overflow findings, orphan PNG/JSON files, sidecar drift, PNG hash or dimension mismatches, and metadata that disagrees with the manifest state. A future recapture must update the manifest, sidecars, screenshots, source identity, and this metadata as one evidence transaction.
