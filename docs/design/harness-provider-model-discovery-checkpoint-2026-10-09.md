# Provider model discovery ownership checkpoint, 2026-10-09

## Scope and unchanged boundaries

Continue T13A from `a6967993` in the sole E6 implementation tree,
`codex/e6-safe-continuation`. Pi1.1 and supported Expo57 are already saved and
verified; do not repeat those migrations. This slice covers model discovery
and Web discovery request ownership, not runtime observations or all external
credential stores. The original E6 packaged macOS12 cases remain required.

The independent delegation-writer design WIP is excluded. No root-checkout
edit, real database repair, credential/Keychain change, push, cloud-CI enablement,
advisory dismissal, native approval/signing or release is authorized here.

## Confirmed failures and implementation

Saved discovery used a pre-await preset read, then returned chat/media results
or builtin fallback without rechecking ownership. Real HTTP gates reproduced
nine stale200 responses: same-time update, configuration A/B/A, deletion,
same-ID recreation, local-secret rotation/deletion, and media success plus
HTTP/network fallbacks. They must return409 `provider_model_connection_changed`
without models, catalog, fetchedAt or old source.

Core adds `getProviderConfigurationSnapshot`: one readonly SQLite SELECT joins
the preset and durable configuration revision. A separate preset read followed
by an authority read could pair old configuration A with revision B, so it is
not used. Missing/unsafe authority is rejected, never revision0. A deleted
preset cannot be reconstructed from its authority tombstone. This read neither
opens/commits a caller's transaction nor admits/consumes a health check; it adds
no table or migration. Public presets never acquire the private revision field.

Discovery captures that snapshot and builds the probe from the captured preset.
It rechecks after materialization, before each paginated request, and before
publishing success or failure. The outer boundary fences every media fallback;
stale409 cannot be swallowed into a builtin success. Saved IDs remain fenced
when an explicit request API key is supplied. Unsaved drafts have no saved
authority and keep the existing explicit-credential behavior. Shared manual,
startup and import check request revisions are not consumed by discovery.

Independent HTTP review reproduced three credential-materialization privacy
failures: ordinary resolver exception text, typed status.message, and arbitrary
status.errorCode were returned to the caller. Discovery now uses fixed public
exception text and only the four Core SecretStatusErrorCode values; unknown
codes map to `secret_materialization_failed`. It does not redact only a known
secret and assume every remaining raw exception field is safe. A concurrent
configuration mutation still takes precedence as409. Tests use fake resolvers,
not the user's Keychain or provider API.

Web request identity matches the effective listProviderModels payload plus cwd
and editing preset ID. It includes kind/provider/API/transport/endpoint,
trimmed inline credential, credential ref, parsed secret-header refs and auth
mode. Display name, selected model and token limits do not alter this request.
Render-time scope gating hides prior results before passive effects. Success,
catch and finally require the current opaque receipt; old finalizers cannot
clear a newer loading state. Close/unmount invalidate pending work. Selecting
a discovered model may preserve source context for one exact derived target,
not an unrelated edit. Private comparison material stays ephemeral, outside
result receipts/DOM/logs; no secret digest is an external authority.

Fresh browser review also proved two additional failures. An old-render fetch
callback could admit its old payload into the new scope and supersede its new
request. Admission now requires the callback's captured scope before any
state/API call. Separately, passive reset could invalidate a fresh request
admitted by a layout consumer; scope cleanup now clears only obsolete results
and pending work. Explicit close/open reset and unmount retain full invalidation.
Neither fix relies only on adding effect dependencies.

The new Daemon runtime leaf is explicitly included in Desktop's required
review-input inventory. Real esbuild/source-admission tests do not constitute
real native approval, signing or packaged GUI acceptance.

## Evidence and current gate state

Raw evidence lives in `output/e6-20260928`.

- `t13a-discovery-http-red-20261009.log`:2 controls passed,9 stale cases failed
  with expected409/actual200, not fixture setup errors.
- `t13a-discovery-core-red-20261009.tap`:6 new interface tests failed before
  implementation. The fresh Core joint gate passes41/41.
- `t13a-discovery-review-http-red-20261009.log`:7 boundary controls passed,
  three privacy cases failed. The narrowed privacy RED log retains the actual
  disclosed synthetic markers, never real credentials.
- Final Daemon focused52/52 includes the21 HTTP ownership/privacy cases,
  existing Provider API, metadata and actual paginated loopback requests.
- Initial focused33/42 failed when old API fixtures reached an unisolated
  default-store migration gate. No database was modified to bypass that gate;
  an explicitly isolated rerun passed42/42 before the final52-case gate.
- Initial full Daemon3716/3747 has31 `runtime_already_running` failures because
  concurrent workers shared one temporary default cwd. Those failures are not
  discarded as green. The existing per-process isolation prelude is used for
  the final rerun; production locking is not disabled or repaired around it.
- After final full gates, public safety detected two synthetic Bearer literals
  lacking a clearly-test marker. Only the fake explicit key literal/fixture
  binding was corrected, with unchanged assertions; final actual HTTP21/21
  was rerun. No scanner exemption was added and no production source changed.
- Actual Hook/ReactDOM uses existing Chrome, deferred synthetic API and the real
  payload adapter. Final20/20 is not packaged GUI acceptance. A readonly esbuild
  alias of old HEAD passed8/19 and failed11/19; it did not overwrite WIP. Two
  additional isolated REDs prove old-callback admission and layout-reset loss.
  An earlier added-test run had a fixture escaping error, corrected without
  weakening the production assertions; its log is retained, not called GREEN.

| Gate | Actual state | Receipt |
| --- | --- | --- |
| Core Node22 full | 2605/2605, exit0 | t13a-discovery-core-full-final-20261009.tap |
| Daemon Node22 focused | 52/52, exit0 | t13a-discovery-daemon-focused-finalv3-20261009.tap |
| Daemon full, per-process isolated | 3747/3747, exit0 | t13a-discovery-daemon-full-process-final-20261009.tap |
| Desktop Node22 unit full | 1930 pass,3 Windows-only skips, exit0 | t13a-discovery-desktop-full-final-20261009.tap |
| Node24 Core/Daemon joint | 93/93, exit0 | t13a-discovery-node24-joint-final-20261009.tap |
| Final fixture HTTP | 21/21, exit0 | t13a-discovery-http-final-20261010.tap |
| Web browser-free unit full, final source | 455/455, exit0 | t13a-discovery-web-full-final-20261010.tap |
| Web actual Hook/browser | 20/20, exit0; not packaged | t13a-web-discovery-final-v3-20261009.tap |
| Workspace typecheck, final source | exit0 | t13a-discovery-workspace-typecheck-final-20261010.log |
| Web production build, final source | exit0; existing large-chunk/dynamic-import warnings | t13a-discovery-web-build-final-20261010.log |

All handles above are terminal; do not poll or repeat them. Final source hashes
are retained in `t13a-discovery-final-source-20261010.sha256`. The final Web
full/types/build ran after both browser-discovered fixes. Core/Daemon/Desktop
source was unchanged during those Web-only fixes. Source/tests/checkpoint are
saved with explicit paths, never the independent writer-design WIP.

## Remaining decisions and original goal

External env/Keychain mutation authority is not solved by configured=true,
secret ref, timestamps, ordinary hashes or this SQLite snapshot. A private
keyed snapshot can establish effective-value equality, not unobserved external
A/B/A or cross-system atomicity. Shared mutation/invalidation requires a
separate trusted boundary. Runtime failures must use the actually bound
Attempt request, not a current preset reread or an old Run.providerSnapshot;
approval/recovery can bind a newer provider without rewriting original history.

Those T13A chains remain incomplete. H10 writer-budget D1 remains unanswered;
do not default or dispatch writers. H09 trusted producer, Office formal native
review/isolated Keychain, Mobile native compile/device and all fresh macOS12
packaged acceptance cases remain open. This checkpoint is progress, not the
completion of D0/E1–E6, U/T, Harness or release.

This slice has no unresolved implementation choice. Preserved sourceForm
selection behavior can restore non-model fields edited after fetching; changing
that existing behavior is not claimed here. Concurrent abandoned-render and
fresh packaged GUI acceptance are not proven by the browser fixture. Existing
large orchestrator/facade files receive no new discovery algorithm: authority
and request identity live in focused modules, and RunStore is a thin delegate.
