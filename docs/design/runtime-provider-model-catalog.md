# Runtime Provider Model Catalog

Status: implemented
Owner: Provider platform
Related: [Provider Model Catalog And Discovery](provider-model-catalog-and-discovery-p15.md)

## Outcome

Model availability comes from the configured provider. The daemon independently obtains
public metadata from `https://models.dev/api.json`, normalizes it to the existing Ling
catalog contract and stores the last validated snapshot in the user's local state. This
data is not synchronized into Git or submitted as recurring pull requests. A bundled
snapshot remains an offline bootstrap, not a periodically synchronized source file.

## Boundaries and precedence

- Provider discovery continues to use only the selected provider's endpoint and its
  authorized credentials. Catalog requests carry no provider credentials or headers.
- Only the existing trusted provider IDs and descriptive fields are accepted. Remote
  data cannot select endpoints, execute code, grant permissions, enable adapters or
  create a provider model that its discovery response did not contain.
- User overrides and explicit provider metadata retain priority over reviewed protocol
  rules, exact catalog matches, family rules and conservative fallback, in that order.
- Discovery associates each model with its catalog version. Import uses that snapshot;
  the daemon retains the four most recent versions in memory. If a version is no longer
  available, import returns a conflict and the model list must be refreshed. Older
  clients without a version use the current snapshot. Import still applies server-side
  enrichment and validation.
- Saved providers and selections are not modified by refreshes or failures.

## Refresh and recovery

At daemon startup load and validate a local cache before scheduling a background refresh.
Use the bundled snapshot when no valid cache exists. Automatically refresh when the
snapshot reaches 24 hours; an explicit provider model refresh also requests a refresh.
The model-list request waits at most two seconds for this public metadata, then continues
with the current snapshot while a slower refresh completes in the background. A single
in-flight refresh is shared; requests are bounded by timeout and response size. An
invalid, empty, duplicate, missing-provider, sharply reduced or failed response must not replace the last good
snapshot or extend its freshness. Valid data is written atomically to a user-state cache
and installed in memory only after validation. Cache errors never prevent provider
discovery; retain the last usable in-memory snapshot and expose its provenance and age.
The update time used for freshness is the successful fetch time, not the newest model's
upstream update date. Network requests have no credentials, reject redirects, and use a
fixed HTTPS origin.

## Delivery and acceptance

1. Extract catalog normalization into a runtime-compatible module and retain existing
   capability and alias rules; remove the scheduled catalog PR workflow and its exclusive
   automation code, preserving unrelated translation automation.
2. Introduce an injectable daemon-owned catalog service with validated local cache,
   bounded fetch, atomic write, startup refresh and single-flight concurrency.
3. Feed one snapshot into discovery and import; keep the existing public provenance
   response and user-facing stale indication accurate.
4. Test online updates, offline restart, invalid/partial data, request limits, concurrent
   refresh, provider precedence, account separation, saved selections and import parity.
5. Run package typechecks, relevant tests and CI contracts; start locally with isolated
   test state, exercise provider discovery and import through the actual client, and
   capture runtime evidence. Clean up only this task's test state and processes.

The existing P15 verification record describes the earlier bundled implementation and
is historical. The implementation plan must track actual checks and remaining work.
