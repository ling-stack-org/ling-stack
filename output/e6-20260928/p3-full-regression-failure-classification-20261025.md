# P3 full-regression failure classification — read-only, 2026-10-25

## Verdict and scope

The isolated-candidate run actually exited **1**, not green. Its 42 fail count
contains **38 failing leaf cases plus four failing ancestor tests**. This report
classifies that existing run; it does not rerun tests, change assertions or
production/test bytes, modify candidate/dist, or issue QA approval.

Primary evidence: `p3-memory-daemon-final-full-20261025.log` lines 20400–20408
(7546 total, 7492 pass, 42 fail, 12 skipped), detailed failures 20411–21038,
and final metadata at 21039 (`exitCode: 1`, `sourceAndCandidateUnchanged: true`).
The before/after 5230-input digest is
`72081158402f5544f0abfd66d662d91b86396deb7844f422aab54be2c9508444`.

| Failure class | Leaf failures | Ancestor failures | Node fail count |
| --- | ---: | ---: | ---: |
| ACP/Codex native-image lifecycle | 8 | 0 | 8 |
| Native-artifact image import | 7 | 0 | 7 |
| Packaged-codesign mechanism fixtures | 12 | 4 | 16 |
| Permission axes (another investigation owner) | 11 | 0 | 11 |
| Total | 38 | 4 | 42 |

## Images: 15 cases share a candidate resource boundary

The eight original lifecycle failures report `host_commit_failed`:

- `acp-journaled-lifecycle.test.mjs`: 739, 778, and the two cases at 888.
- `codex-journaled-lifecycle.test.mjs`: the two cases at 72 and the case at 188.
- `codex-owned-execution.test.mjs`: 355.

Existing separate evidence, `p3-candidate-images-revalidated-20261025.log`,
shows these exact eight pass with the same candidate after supplying the
product-owned codec path; exit 0, source/tests unchanged, codec unchanged.
Codec SHA256:
`e27d0fbed8c42fdd3807772282b747a6dec4a32ee6b0bbc584c6add95c092562`.
This is not a rerun of the seven import cases below.

`native-artifact-import.test.mjs` contributes seven more failures:

| Test line | Expected behavior / observed failure |
| --- | --- |
| 24 | Async image processing followed by text materialization; `invalid_artifact` |
| 40 | Metadata-stripped returned pixels and replay; `invalid_artifact` |
| 117 | Animation/damaged pixels; `invalid_artifact` instead of `unsupported_artifact` |
| 143 | Substituted artifact directory; `invalid_artifact` instead of `artifact_conflict` |
| 152 | JPEG/WebP decode; `invalid_artifact` |
| 162 | All eight EXIF orientations; `invalid_artifact` |
| 175 | JPEG/ICC golden pixels; `invalid_artifact` |

All seven stacks fail in candidate `native-image-sanitizer.js:35`, at the
`helperPath()` failure translation, before successful codec processing. The
helper defaults to a path relative to physical `import.meta.url` unless
`LING_IMAGE_SANITIZER_PATH` is explicit. Root established the candidate lacks
its native image-sanitizer resource; the full normal dist has that resource.
These seven have the same strongly supported missing-resource prerequisite,
but **remain un-revalidated in this report**. Their higher-level behaviors
must not be marked passed solely from the eight-case result.

## Packaged codesign: module identity, not just equal source bytes

The three failing files contribute 12 leaf failures and four ancestors:

| File | Leaf / ancestor count | Failed cases |
| --- | --- | --- |
| `packaged-codesign-host-invocation.test.mjs` | 1 / 1 | :27 exact original source singleton re-export |
| `packaged-codesign-host-source.test.mjs` | 2 / 1 | :125 original verification plus cleanup aggregate; :157 dummy resource observer/native call |
| `packaged-codesign-original-issuer.test.mjs` | 9 / 2 | :10 canonical binding; :31 later-registry refusal; :57 corrupt manifest; :65 helper drift; :79 transient cleanup; :92 `inner_failure` and `timeout`; :107 FD reuse; :118 custody limit |

Ancestor names (run log 6979–7093) are the three outer tests and the issuer's
inner group, “normal inner failure and helper timeout do not imply integrity
loss or retire custody.” They must not be counted as extra independent defects.

### Direct evidence

1. Invocation :31 explicitly fails strict identity: equal-shaped actor objects
   are not reference-equal (log 20617 onward).
2. Issuer binding stacks enter both
   `candidate/.../protected-host-staging.js` and the same path with
   `?codesign-mechanism=1` (log 20681 onward). The ordinary inventory instance
   calls ordinary staging enrollment checks on a query-isolated registry. The
   rejection is `protected_host_registry_invalid`; later issuer failures cascade
   from different ownership/fixture state. The FD-reuse case has no held FD and
   therefore reaches a fixture `.row` TypeError.
3. `test/support/packaged-codesign-host-simulation-fixture.mjs:10–12` derives
   physical module URLs from `LING_PROTECTED_HOST_SOURCE_TEST_DIST`, or ordinary
   `packages/daemon/dist`. Its hooks at :93–120 preserve isolation only for exact
   `context.parentURL` membership/equality against those URLs. It also reads
   compiled injection bytes directly from that dist (:80–82).
4. The full run installs `public-projection-test-loader.mjs` (log line 2).
   That loader :8–15 rewrites ordinary daemon dist URL references to the
   physically distinct candidate. `final-build-loader.mjs:19–23` also rewrites
   resolved workspace dist locations. The fixture's exact source URL/parent
   comparisons and the runtime's WeakMap/singleton ownership are consequently
   not equivalent merely because the JS text is equal.
5. Root reported a fresh comparison of all **1541** compiled contracts/core/
   daemon `.js` files: normal post-build dist and candidate match byte-for-byte,
   with zero mismatches. This comparison is Root-supplied evidence, not a test
   or hash comparison rerun by this read-only reviewer.

### Interpretation and limit

The observed identity split and resource location are concrete. Combined with
equal production JS bytes, the leading explanation is **the external candidate
test adapter does not preserve the fixture's physical URL/isolation contract**,
not a demonstrated production codesign logic regression. Standard complete-dist
execution without that adapter is an appropriate discriminating follow-up.
It must preserve production bytes, tests and acceptance assertions. **Until its
actual result is available, these 12 leaves are not passed or proven solely
environmental**, and virtual mechanism tests never certify a real package,
signature, OS sandbox or GUI.

## Permission axes: 11 leaf failures, separate owner

`run-request-permission-axes.test.mjs:49` reports child process exit 1 through
`ownedCase` :121 for:

`direct-collection-workspace`, `direct-collection-full-access`,
`direct-sse-workspace`, `direct-sse-full-access`,
`resume-conversation-read-only`, `resume-conversation-ask-workspace`,
`legacy-and-canonical`, `normal-prepared-retry-current-policy`,
`malformed-source-axis-rejected-before-input`,
`fork-conversation-read-only`, `fork-conversation-full-access-receipt-not-reused`.

This report does not diagnose those children's underlying error or infer
approval-policy correctness. Their separate owner must provide that result.

## Required follow-up, without broadening claims

- Root's standard complete-dist targeted run can discriminate the module and
  missing-resource explanations without modifying source/tests/thresholds.
- Revalidate the seven import leaves, not just the already green eight images.
- If targeted failures persist without the candidate adapter, investigate the
  remaining actual failures; do not suppress identity/security assertions.
- Full-suite success and packaged/macOS acceptance remain distinct later gates.
