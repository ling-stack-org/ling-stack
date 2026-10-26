# Skill/Plugin Marketplace and Sharing

## Status

Status: design approved for implementation
Owner: Skills / Plugins / Web
Last verified: 2026-10-26

## Background and competitive reference

ZCode ships a skills/plugin ecosystem users can install by name; MiniMax has
`@`-selectable official plugins. Ling's Skill Library (editor, import, review
queue, governance, evolution) and Plugin Manager are strong *internally*, but
there is no distribution surface: sharing a skill means sending a file around
and importing it manually.

## Goal

1. One-click share: export a skill (or plugin) as a signed pack file or URL.
2. Community index: a static, git-hosted JSON index (no server) that the
   client can browse and install from, with the same review/governance gates
   as manual import.
3. No auto-install, no auto-update of skills — Ling's governance model is a
   differentiator, keep it.

## Design

### 1. Pack format already exists

`packages/plugin-sdk/src/skill-pack.ts` defines the pack. Marketplace work
wraps it, doesn't replace it:

- `SkillPackManifest` gains optional `source: { kind: "marketplace", indexUrl, packId, version, integrity: "sha256-..." }`
  (additive).
- Export: `ling skills export <id>` → `.lingpack` file (zip of pack + manifest
  with integrity hash). The Skill Library inspector gains "Export".
- Import via URL: `SkillImportDialog` accepts a URL to a `.lingpack`; the
  daemon fetches it through the audited-destination egress path, verifies
  integrity, then enters the **existing review queue** — identical to file
  import downstream of verification.

### 2. Index format (static, forkable, no infrastructure)

```json
{ "indexVersion": 1, "generatedAt": "...", "skills": [ { "id", "name", "description", "versions": [{ "version", "url", "integrity", "compat" }] } ] }
```

- Client settings "Skill library → Browse index" renders a table from any
  user-configured index URL (default: the project's own hosted index).
- `compat` pins engine/version constraints the daemon already checks for
  plugin capability gates.
- The index is content-addressed by integrity hash; a hostile index can at
  worst point at packs the user then reviews — the review queue is the trust
  boundary, not the index.

### 3. Compatibility analysis

| Existing surface | Impact | Handling |
|---|---|---|
| Skill review queue / governance | reused verbatim | Marketplace installs are just imports with provenance; no bypass path exists or will be added. |
| Skill evolution / recording | unchanged | Evolution operates on installed skills regardless of origin. |
| Plugin capability checks | reused | `compat` field feeds the existing checks. |
| External-work egress pinning | reused | Index and pack fetches go through audited destinations. |

### 4. Incompatible-case upgrade path

`indexVersion` gates the index schema; unknown versions render "update Ling to
browse this index" instead of misparsing. Pack manifest unknown fields are
ignored (existing tolerant manifest parsing), so new pack features don't break
older daemons — they fail *at the capability gate* if actually used.

## Implementation plan

1. Contracts/plugin-sdk: manifest `source` + integrity, index schema + parser.
2. CLI: `skills export`; daemon: URL-import route with integrity check +
   egress pinning.
3. Web: export button, import-from-URL field, "Browse index" table with
   provenance column.
4. Tests: parser unit tests (v1, unknown version, bad integrity), daemon route
   tests (verification failure → rejection, egress pinning), Playwright spec:
   browse mocked index → import → lands in review queue, screenshots.

## Acceptance

- Round trip: export → serve file → import by URL → review queue entry with
  provenance (unit + Playwright).
- Tampered pack (integrity mismatch) rejected (unit test).
- Existing skill library suites stay green.
