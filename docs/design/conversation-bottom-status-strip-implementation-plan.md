# Conversation Bottom Status Strip Implementation Plan

Status: implementation plan
Date: 2026-10-28
Contract: [Conversation Bottom Status Strip](conversation-bottom-status-strip.md)

## Vertical slices

1. Read durable run event contracts and the three conversation ownership/read paths. Define one scoped metric projection with explicit coverage and optional values. Verify real Pi provider usage and unknown ACP/Codex values independently.
2. Build a daemon read-model that pages linked run events, deduplicates by event identity, aggregates runtime rounds/tool starts/usage, and resolves context evidence without treating capacity or projection estimates as measurements. Attach it to the current channel, normal detail, and teammate direct reads using existing scope/visibility checks. Test all three scopes, pagination, incomplete data, and zero-versus-unknown.
3. Replace model/surface/activity display in the existing shared bottom strip with the reference layout, two accessible detail cards, compact units, and a context ring. Keep its transparent sibling placement and approved gap unchanged.
4. Wire the three Web surfaces to their scoped metric projections and live refresh. Update package and Playwright coverage, inspect three screenshots, run focused package/daemon tests and Web typecheck. Distinguish test fixtures from real runtime evidence.

## Acceptance

All three composers display the same centered three-group strip below their border. No model/surface label appears there. Metrics are based on scoped runtime records, unknown metrics show `—`, and context estimates are labeled. Detail cards reveal actual token/cache/context breakdown. Existing composer controls remain intact. No unrelated file changes, commit, or push.
