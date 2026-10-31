# MCP connection lifetime research (C01)

This experiment is disabled by default and is not imported by the Daemon. It
compares ten real SDK calls against local synthetic stdio/HTTP MCP servers.
It does not change `withMcpClient`, production Host admission, credentials,
tool authorization, execution evidence, or result publication.

From `packages/daemon`:

```sh
node --test experiments/mcp-reuse/generation-pool.test.mjs
node experiments/mcp-reuse/measure.mjs --run-isolated-probe
```

The pool keys connections by workspace/server/configuration/credential generation
and activation epoch. It has single-flight connection creation, bounded capacity,
idle eviction, generation retirement, per-request cancellation, stale-result
rejection and explicit shutdown drainage reporting. Each call requires its own
admission and currentness checks. Tests use synthetic guards; the measurement
uses a local SDK server. Neither proves production Host execution authority.

Production integration requires an independently reviewed connection owner that
preserves actual Host transport/send fencing and per-call operation evidence,
real authentication rotation, bounded notifications/output and verified process
drainage. Local handshake savings alone do not authorize enabling a global pool.
Fixed-order exploratory samples and noisy heap deltas are not product performance
or memory claims.
