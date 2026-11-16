# macOS development packaging source review, 2026-11-09

This scoped review covers the Ling multi-agent safe-concurrency delivery and
its fixed Office packaging source closure. It updates the existing Darwin
arm64, `unsigned_dev`, ad-hoc,
`provider=false` source prerequisite. It does not accept a final App, ZIP, DMG,
public signature, notarization, GUI behavior, real Provider, Windows signer or
cross-platform release.

## Independent closure decision

Independent Codex context `01a1bca4-cd9d-7e21-8dd2-200a2e87528f` reviewed the
candidate fixed input closure and returned `APPROVE_SCOPED_DEVELOPMENT_PACKAGING`
before the persistent review record was adopted. This is a scoped source review
on the same model host, not human or cross-model approval.

The actual authored workspace projection used the real esbuild/metafile path from
`packages/daemon/src/cli.ts` and observed 5,050 total inputs, including 1,684
authored runtime inputs across the nine packaged workspace packages. The fixed
manifest now contains 1,820 unique inputs, with no missing or extra entry against
the candidate record. It adds 114 runtime inputs required by isolated execution,
capacity admission, integration, merge, recovery, template and Host boundary
paths. The non-runtime `api-client` and `conversation-ui-core` sources remain
outside the daemon packaging closure.

The candidate record matched every current fixed input byte: 1,820/1,820 with no
mismatch. Relative to the previous record it adds 114 keys and changes 164
existing digests. The 15 Office native source digests remain unchanged. The
adopted review record SHA-256 is
`bb0285d8225ea5ef7bfc677f24ad79ec3241ada880ecab84d6094f68f3730315`.

## Scope evidence

- The fixed authored closure is explicit in
  `apps/desktop/scripts/packaged-office-native-review-inputs.mjs`.
- The actual builder continues to consume reviewed authored bytes and verifies
  the real esbuild metafile in
  `apps/desktop/scripts/packaged-office-daemon-source-inputs.mjs`.
- Existing tests cover workflow safety and isolation, repository fencing, Host
  readonly and isolated tools, plugin-import secret policy and native process
  boundaries.
- The focused source-input suite passed 1,407/1,407 tests with no skips after
  the closure additions.

## Limits

This review does not certify the complete repository or hosted CI. Final native
artifact bytes, signing, notarization, clean-machine behavior, GUI acceptance,
real-model execution, real Provider behavior, Windows acceptance and public
distribution remain separate gates.
