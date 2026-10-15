# A20: Media workflow connection check ownership

## Proven failure and scope

Root's first real run of `media-workflow-connection-check-ownership.test.mjs`
(`b25b1d42fc09af2b07288566be672526762be62f34c5a3f4d304afca62b33ed2`)
finished with exit 1: 23 tests, 7 passed, 16 failed, no cancellation, skip or todo.
Raw evidence: `output/e6-20260928/a19-20261015/a20-first-ownership-red.log`,
SHA-256 `718b57734fea2a5ad09999a7cb4ce4d445fa371d5aafa709c9bc5c9746e5e9e3`.
The real native ComfyUI HTTP inspection was held while public PATCH or a newer
check completed. The old success/error then replaced the current SQLite health.
No timeout or substituted sender was needed. Public deletion plus a new UUID
already kept the successor isolated; that remains a positive regression.

Only connection-check admission and publication are changed. ComfyUI transport
permissions, workflow import/execution, Provider D1, A19 media cancellation and
the current three conversation renderers are not changed. No paid Provider,
real Keychain, daily database or GUI is used by these regressions.

## Durable authority and module boundaries

Migration 162 adds a small Host-only
`media_workflow_connection_check_authorities` table. Each connection ID owns:

- `config_revision`, initially 1, incremented by every accepted configuration
  mutation, including a same-value PATCH or an empty PATCH that clears health;
- `request_revision`, incremented once for each admitted check;
- `published_revision`, recording the consumed check request.

These are positive/nonnegative safe integers with SQLite type/range checks.
Overflow rejects the whole statement/transaction; clocks and content hashes are
not versions. Tombstones survive deletion. Insert/delete/configuration triggers
advance configuration authority, so a later insertion cannot recreate an old
ticket's authority. Public POST still generates a new UUID; tests must not claim
that public same-ID recreation exists.

Configuration columns and health publication are separate write paths. Ordinary
configuration updates name the configuration columns, trigger revision advance
and clear health (retaining an explicit disabled status). A health-only Core
update does not name configuration columns. Explicit disabling also advances
configuration authority, preventing an older in-flight check from reenabling it.
An accepted public reset with
`status=unchecked, health=null` is explicitly treated as a configuration mutation
even when no field value changes. Check publication only writes status, health
and updated time, so it does not revoke itself or advance configuration revision.

The existing media workflow types expose Host-only state/ticket/result types.
`SqliteMediaWorkflowStore` owns synchronous authority reads, admission and atomic
publication; `SqliteRunStore` only delegates. A dedicated Daemon
`workflow-connection-check.ts` owns credential observation and native inspection.
`workflow-service.ts` re-exports this operation; the route translates its result.
No generic Provider framework or connection execution policy is copied.

## Admission, async inspection and publication

1. In `BEGIN IMMEDIATE`, atomically read the current connection plus authority
   and increment `request_revision`. Return that exact configuration and ticket.
2. Resolve only the selected connection's credential. Capture an ephemeral,
   keyed SHA-256 proof of its effective value. The random proof key, proof and
   resolved value remain in the current invocation only.
3. Execute the original `ComfyUiClient.inspect()` using the admitted configuration
   and resolved value. URL/network policy/authentication checks remain in the
   actual sender. Only credential/configuration/transport/protocol failures from
   this inspection become a candidate health result.
4. After the await, reread the current row and authority. Deleted, changed or
   superseded tickets are discarded without looking up a retired credential.
   Reread the effective credential only for a still-current configuration.
5. If credential observation is unavailable or its proof differs, discard the
   result. Otherwise publish synchronously through a `BEGIN IMMEDIATE` CAS that
   checks configuration revision, latest request revision and unconsumed ticket.
   Health, status and ticket consumption commit together.

An older check cannot publish after a newer check has merely been admitted,
regardless of success/error or completion order. Duplicate publication cannot
overwrite an already consumed request. Admission/result transaction exceptions
roll back and propagate as Host errors. Store read/write failures are outside
the inspection catch: they must never turn into a second error-health write.
No network, secret resolution, Promise or notification runs inside a transaction.

## Credential guarantee

This follows the already chosen D1 external-current-value boundary, not a new
secret-history policy. `authMode=none` reads no secret. For bearer mode, a normal
missing/unconfigured secret can yield current error health if the same effective
missing state is observed again; an exception while reading a secret cannot
establish identity and returns stale/unavailable without publishing health.
The selected reference and auth mode are also protected by configuration revision.

No raw credential or proof is persisted, returned, logged or attached to an
event. There is no hash of a secret without an invocation-local random key.
External value A -> B -> A entirely between observations cannot be detected.
There is no reuse of a proof or in-flight check across daemon restart, and no
claim to version arbitrary external Keychain/environment history.

### Inspection diagnostics are a secret boundary

Root's subsequent owned bearer malformed-JSON regression ran one selected case
and finished with exit 1: 0 passed, 1 failed, no cancellation, skip or todo.
Raw evidence:
`output/e6-20260928/a20-20261015/credential-parse-error-first.log`,
SHA-256 `5a65c75a086b2f8efe6a859eaaaca80b3adb1733eb53e6430f1b8a46adfbda24`.
The real HTTP sender carried a random, non-`sk-` fixture key, and the native
`Response.json()` error quoted that value. Before failing the no-secret POST
assertion, the test proved HTTP 200 error-health publication, both effective
credential observations, matching persisted health and consumed check authority.
Thus the generic Store redaction patterns alone did not enforce this boundary.

The Daemon inspection catch now projects native `SyntaxError` to a fixed,
body-free JSON-format diagnostic. A raw parser diagnostic must not be persisted
or returned, including when it contains only a truncated or escaped credential
fragment or the connection uses no authentication. Other diagnostic messages
retain useful HTTP status, timeout and network-policy details, but pass through
the existing Core redactor with the actual admitted credential as an explicit
extra secret. This removes every exact occurrence without depending on a key
prefix or a `Bearer` label. No secret is added to the Store API or durable state.

The original malformed-JSON regression and previous 48 assertions remain.
Additional owned native-byte cases cover repeated arbitrary keys, a long key
whose parser diagnostic can contain only an excerpt, and a no-authentication
parse failure with a useful body-free error. Product repair and these new cases
remain source-only until Root rebuilds and records actual post-fix results;
the earlier real RED is not rewritten as a passing run.

## Public response

Successful publication keeps the existing HTTP 200 `{ connection }` shape.
A discarded result returns HTTP 409:

```json
{
  "error": "media_workflow_check_result_stale",
  "reason": "config_changed",
  "message": "Connection check result was superseded. Check the current connection again.",
  "connection": { "id": "current-row-only" }
}
```

Reasons are `deleted`, `config_changed`, `superseded`, `already_published`,
`credential_changed` or `credential_unavailable`. `connection`, when present,
is a current read-only SQLite fact with existing public secret-status projection.
Deletion omits it. The original admitted connection is never a fallback, and
the old inspection is never implicitly retried. The existing client treats 409
as a failed mutation rather than replacing UI state with stale health, matching
the established Provider manual-check convention.

## Failure, restart and validation gates

Durable revisions survive reopen; a fresh process cannot reset request ordering
or an existing tombstone. There is no automatic resume or reissue of an HTTP
check on restart. Corrupt/missing authority, conflicting migration markers or
schema drift fail closed rather than recreating an assumed generation.
Migration is savepoint-atomic and idempotent, with exact owned schema checks.

Root alone runs builds, migration/runtime tests and frozen-input review. The
original 23 cases must remain: ordinary protocol variants and real HTTP errors,
real public-only sender rejection, every configuration axis with both late
outcomes, same-value mutation, reverse completion, deletion/recreation and
effective synthetic env credential rotation. Updated stale status assertions
are an explicit new contract, not removal of the full-row no-pollution checks.
Additional tests cover persistent revision/reopen, duplicate publication,
missing/corrupt authority and transaction rollback, credential read failure and
unchanged/missing-secret positives. Source-only implementation is not acceptance.

No unresolved product decision remains for this scope. Fresh verification and
independent review are outstanding until Root records their actual results.
