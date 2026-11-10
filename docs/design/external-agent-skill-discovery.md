# External Agent Skill Discovery And Adoption

Status: Active design (Design A); implementation in progress. Root discovery, boundary guards, daemon
`/skills/sync/shared/*` endpoints, API-client methods, and server tests exist on the
delivery working tree; the Skill Library surface is in progress. Adoption is never
automatic and never changes runtime behavior by itself.
Date: 2026-10-27
Owner: Skill source sync and Skill Library maintainers
Last verified: 2026-10-27 against Main `77a2a859` plus the uncommitted shared-source
slice (`packages/core/src/skill-source-sync.ts`, `packages/core/src/skill-types.ts`,
`packages/daemon/src/features/skills/*`, `packages/contracts/src/skills.ts`,
`packages/api-client/src/endpoints/skills.ts`)
Document type: canonical product and safety contract for local shared skill sources
Code and test anchors: `packages/core/src/skill-source-sync.ts`,
`packages/daemon/src/features/skills/routes.ts`,
`packages/daemon/src/features/skills/schemas.ts`,
`packages/core/test/skill-source-shared-roots.test.mjs`,
`packages/daemon/test/shared-skill-source-scan-api.test.mjs`,
`packages/contracts/src/skills.ts`
Implementation plan:
[External Agent Skill Discovery Implementation Plan](external-agent-skill-discovery-implementation-plan.md)

## Related Docs

- [Managed Official Skill Source P16](managed-official-skill-source-p16.md) — canonical
  contract for the Ling-managed official source; this document does not change it.
- [GStack Skill Source Sync](gstack-skill-source-sync.md) — scanner, classifier,
  snapshot, warning, and lazy-loading model reused by this contract.
- [GStack Source Upgrade Lifecycle](gstack-source-upgrade-lifecycle.md) — explicit-publish
  and no-silent-upgrade principles inherited here.
- [Skill Import Productization](skill-import-productization.md) — the existing one-file
  manual import path; this contract is the directory-based counterpart.
- [Skill Library Ownership Separation](skill-library-ownership-separation.md) — ownership
  views and the new **Local skill folders** section.
- [Skill Capability Model And Library Simplification](skill-capability-model-and-library-simplification.md)
- [Skill Editing And Revision](skill-editing-and-revision.md)
- [Skill Source Sync Simplification P15](skill-source-sync-simplification-p15.md) —
  historical source-sync productization; superseded for normal official acquisition by
  P16 and not the product path for local folders.

## Summary

Users already keep reusable agent skills in `.agents/skills` folders on their machine.
Those folders are written by Claude Code, Codex, third-party skill installers, or the
user directly. Ling labels them **shared** skill sources: Ling does not own them, but
they are a cross-agent convention worth adopting.

Design A turns the existing latent capability into a **local adoption** flow:

```text
<cwd>/.agents/skills/  +  ~/.agents/skills/
  -> explicit, read-only scan (auto-detected roots; no path input)
  -> Skill Library "Local skill folders" review surface
  -> user selects records and confirms publish
  -> Ling creates/reuses a user-owned skill entry + source snapshot
  -> runtime capacity is unchanged until the user binds or selects that skill
```

"Automatic discovery" means the user never types or configures a path: Ling knows the
two `.agents/skills` locations. It is never automatic where safety matters: **nothing is
published, bound, enabled, or injected without an explicit user action on specific
records.** There is no background scan-and-apply loop, no `auto-safe` path, no
filesystem watcher, and no network access in this flow.

This document owns behavior, safety rules, and the P16 boundary. Delivery state, phase
order, and remaining gates live in the
[implementation plan](external-agent-skill-discovery-implementation-plan.md).

This is a separate contract from the official source. P16 remains authoritative for
official updates; this document is authoritative for shared `.agents/skills` discovery
and adoption. The two share scanner/snapshot/publication machinery but never share
policy state, identifiers, or user intent.

## Terminology

- **Shared skill source** — a local `.agents/skills` directory not owned by Ling. Code
  and API names use `shared`.
- **Local skill folder** — the user-facing Skill Library section (product name).
- **Adoption / publish** — the explicit user action that creates a Ling-owned registry
  entry and source snapshot from a shared source.
- **Official source** — the Ling-managed cache defined by P16. Never called shared.

## Problem

Three gaps exist today.

1. **No supported path for directory-shaped local skills.**
   The manual import dialog accepts one text file and drops directory structure,
   `agents/openai.yaml`, and referenced-file provenance
   ([Skill Import Productization, "Input Contract"](skill-import-productization.md#input-contract)).
   Directory skills with references or agent metadata cannot be adopted faithfully.

2. **No decision model for external content.**
   `.agents/skills` folders are not Ling-managed. They can be stale, contain raw
   secret-like text, assume host-specific tools, or duplicate Ling built-ins. A
   one-click or automatic sync would let untrusted local content change what a teammate
   can do without review.

3. **No ongoing drift awareness.**
   An adopted skill's source folder can change later. Ling must surface "an update is
   available" without silently changing runtime behavior, and without confusing that
   signal with official-source updates.

The legacy `includeDetectedRoots` preview path already discovers workspace and home skill
roots (`packages/core/src/skill-source-sync.ts:127-141`), and the daemon exposes
preview/publish/refresh endpoints (`packages/daemon/src/features/skills/routes.ts:204-309`),
but those are compatibility internals: they accept arbitrary local paths, mix gstack and
Codex roots, publish with `gstack` provenance that would misclassify user content as
built-in, and have no user-decision model. Design A replaces that for the shared
convention with fixed roots and an explicit surface.

## Design Principles

1. **Auto-detected roots, read-only discovery.** Only two fixed locations are read; no
   client-supplied path is accepted. Discovery never executes, fetches, or writes to the
   source folder.
2. **Explicit adoption only.** Publish requires a user scan and per-record selection;
   creating new skills additionally requires the explicit new-skill confirmation. No
   policy mode may bypass this for shared sources.
3. **Provenance over guessing.** Adopted entries record which root and relative path they
   came from and preserve the raw source snapshot, warnings, and referenced-file
   inventory.
4. **Shared content is data, not authority.** Source text cannot grant tools, providers,
   MCP servers, credentials, approvals, external-send authority, or implicit invocation.
   All existing Effective Skill, approval, runtime, and sandbox gates stay in force.
5. **Protect managed namespaces.** P16 official entries and Ling built-ins are never
   adoption targets: shared adoption must not attach snapshots to, shadow, or overwrite
   them. Enforced by the `allowManagedSkillIdMatching` guard; see "Boundary".
6. **One contract per source class.** Official source (P16) and shared sources (this
   document) have separate endpoints, surfaces, provenance, and policy behavior.
7. **Bounded scope.** Fixed roots, one directory level, bounded sizes, no arbitrary
   paths, no home-directory enumeration beyond the two declared folders.

## Product Decision (Design A)

### Roots And Priority

Discovery considers exactly two roots, in this priority order:

| Priority | Root id | Path | Source kind | Meaning |
|---|---|---|---|---|
| 1 | `shared-agents-workspace` | `<workspace cwd>/.agents/skills/` | `workspace-skill-directory` | Skills shared with the project/repository |
| 2 | `shared-agents-user` | `~/.agents/skills/` (`os.homedir()`) | `workspace-skill-directory` | User-level skills shared across workspaces |

The root ids and resolver are implemented in
`packages/core/src/skill-source-sync.ts:54-58,155-185`. Both roots use the existing
`workspace-skill-directory` source kind because they are plain shared directories, not
Ling-owned or gstack-owned caches.

Rules:

- Roots are auto-detected; only existing directories are included. The project root
  requires a known workspace cwd; the user root always uses the home directory.
- The same physical directory is deduplicated with the project root first
  (`packages/core/test/skill-source-shared-roots.test.mjs`).
- Scans are explicit user actions (open section or **Refresh**). There is no timer,
  watcher, startup scan, or daemon-side background sweep.
- Exactly one directory level under each root is scanned; each skill is a directory
  containing `SKILL.md`, or the root itself is a single skill directory. Hidden
  directories are skipped (`packages/core/src/skill-source-sync.ts:382-410`).
- If both roots contain the same natural skill name, the higher-priority root owns it;
  the lower-priority record is reported as `blocked` (duplicate source) and is not
  publishable.
- `~/.codex/skills`, `~/.claude/skills`, gstack checkouts, mounted volumes, configured
  roots, and arbitrary user paths are **not** scanned in v1.

Clients may narrow a scan with `includeProjectRoot` / `includeUserRoot` /
`includeSkillIds` / `excludeSkillIds` / `maxSourceBytes`
(`packages/contracts/src/skills.ts:1318-1330`,
`packages/daemon/src/features/skills/schemas.ts:836-870`), but they may never widen it to
another path.

### Discovery Timing And Side Effects

- The Skill Library surface calls the explicit preview endpoint when the user opens
  **Local skill folders** or presses **Refresh**:
  `POST /skills/sync/shared/preview`
  (`packages/daemon/src/features/skills/routes.ts:302-313`).
- The preview is read-only with respect to skill state: no registry entries, snapshots,
  or artifacts are written, and no ignore/decision state is persisted server-side. The
  response is a pure projection of the current filesystem scan.
- No scan makes network requests, runs git, or executes anything from the source
  directories.
- There is no server-side "latest scan status" endpoint in v1. A navigation badge, if
  shown, must be derived from a scan already performed in this client session; the
  product must not introduce a background scanner merely to keep a badge fresh.
- Requests and responses may not serve as a delivery mechanism for arbitrary paths: the
  scan always uses the two auto-detected roots.

### User Interface

The Skill Library gains a fourth section, **Local skill folders**, placed after
**My skills** and before **AI evolution**. Entering or reloading the Skill Library still
opens **My skills**; the selected section is not persisted in localStorage.

The section contains:

- A short explanation that these folders belong to other agent tools, that Ling only
  reads them, and that nothing is available to teammates until it is published.
- One group per discovered root, labeled by scope (**Workspace** / **Home**). Absolute
  filesystem paths are never displayed.
- A record table with `Skill`, `State`, `Source`, `Updated`, `Actions`, plus selection
  checkboxes for publishable records. The `Source` cell reads **Local skill folder**;
  provenance detail shows the root label and the workspace-relative provenance such as
  `.agents/skills/<dir>/SKILL.md`.
- State chips: **New**, **Update available**, **Up to date**, **Blocked**, **Source
  missing**, **Ignored** (last only under "Show ignored").
- A detail inspector showing state and reason, a bounded source preview, display metadata
  from front matter and `agents/openai.yaml`, the warning list, the drift diff, and the
  referenced-file inventory (path/kind/size, no artifact contents).
- Toolbar actions: **Refresh**, **Publish selected**, **Ignore**, **Restore**, **Show
  ignored**. **Publish selected** stays disabled unless at least one publishable record
  is selected and opens a confirmation dialog listing the exact records to create/update.

The surface must never imply that adoption grants capability. Copy states that tool
access, approvals, and teammate binding stay explicit and separate.

### Record States

The shared scan reuses the existing source-sync classifier
(`packages/core/src/skill-source-sync.ts:612-628`) and supports:
`attachable`, `unchanged`, `drifted`, `new`, `missing`, `blocked`, `orphaned`
(`packages/core/src/skill-types.ts:65-72`). The surface maps them as follows, plus one
client-only suppression:

| State | Meaning | Allowed actions | Publishable |
|---|---|---|---|
| `new` | Discovered skill whose resolved id is not in the registry. | Select, inspect, ignore | Yes, with `allowNewSkills` confirmation |
| `drifted` | A previously source-backed skill whose checksum or warning fingerprint changed. | Select, inspect diff, ignore | Yes, explicit update |
| `unchanged` | Source-backed skill whose checksum and warning fingerprint match the active snapshot. | Inspect | No-op |
| `attachable` | The resolved id belongs to an entry already adopted by this flow (pack `shared-skill-source-sync`) but has no active source snapshot. | Inspect | Yes, for that shared-adopted entry only |
| `blocked` | Not publishable: error-severity warning (for example raw secret-like content), duplicate source, unreadable/oversized/truncated source, or a managed-id target. | Inspect, ignore | No |
| `missing` | A source-backed skill whose source folder or `SKILL.md` disappeared. Keep the entry and last snapshot; do not disable or delete. | Inspect, manage in My skills | No |
| `orphaned` | A snapshot whose skill entry is unknown or archived (cleanup case). | None in v1 (diagnostics only) | No |
| `ignored` (client) | User dismissed the record. Hidden by default, excluded from counts, restorable. | Restore | No |

`attachable` is the only state that can target an existing registry entry. Because the
classifier resolves natural names against all registry entries, a shared skill named like
a built-in (for example `review`) can resolve to a managed id. The shared preview passes
`allowManagedSkillIdMatching: false`, so any non-shared owner becomes `blocked` and gains
an error-severity `skill_id_conflict` warning instead of a definition preview
(`packages/core/src/skill-source-sync.ts:252-296`;
`packages/daemon/src/features/skills/routes.ts:1479-1480`). A publish request selecting
such a record is rejected by the normal `blocked` gate. The contracts warning-code union
must also carry `skill_id_conflict` so API consumers see the same vocabulary; that parity
check is tracked in the implementation plan.

### Identity, Provenance, And Collisions

The shared flow reuses the existing identity derivation
(`resolveSkillIdForSource`, `packages/core/src/skill-source-sync.ts:1008-1028`) instead of
introducing a second id scheme:

- The resolved id prefers an existing registry id matching the front-matter name or
  directory name; otherwise it normalizes the natural name
  (`normalizeGstackSkillId`, `packages/core/src/skill-source-sync.ts:358-363`).
- A matching **shared-adopted** entry (pack `shared-skill-source-sync`) is
  `attachable`/`drifted`: the user may attach or refresh its source snapshot. Any other
  owner, including other user-owned imports, is blocked rather than attached.
- A matching **managed** skill (`builtin`, `gstack`, or `workspace` provenance) becomes
  `blocked` with `skill_id_conflict`, is never published, and keeps P16 and Ling built-ins
  untouched.
- An id already owned by another shared/first-party entry is not renamed in v1; a true
  collision surfaces as `blocked` or a publish conflict. (A distinct local id namespace is
  a deferred decision, listed below.)
- Two roots offering the same natural name resolve by root priority; the lower priority
  duplicate is blocked.

**Provenance for adopted skills**

- Registry entry: `source: "skill-directory"`, `packId: "shared-skill-source-sync"`,
  pack name **Shared .agents skills**, and `sourcePath` provenance for display. Pack
  configuration lives in `packages/daemon/src/features/skills/routes.ts:331-341`.
- Source snapshot: existing snapshot model with `sourceKind:
  "workspace-skill-directory"`, `upstreamName`/`upstreamSkillPath` taken from the shared
  root, bounded raw `SKILL.md`, warnings, semantic profile, and referenced-file
  inventory.
- Artifacts: the existing publication path stores referenced files under workspace
  artifacts; only `references/` and `agents/openai.yaml` are eligible for runtime
  context, and scripts/assets are never executed
  (`packages/daemon/src/features/skills/source-publication.ts:43-100`).
- Definition ownership: publishing seeds the `SkillDefinition` for new records. Updates
  refresh only the source snapshot/provenance; they do not overwrite a definition the
  user edited in Ling, consistent with
  [Skill Editing And Revision](skill-editing-and-revision.md).

### Publish Semantics

Publish is the only operation that writes skill state, and it is always user-initiated.

Endpoint: `POST /skills/sync/shared/publish`
(`packages/daemon/src/features/skills/routes.ts:315-345`). Request:
`selectedSkillIds` (required, non-empty), `allowNewSkills` (default `false`),
`publishArtifacts` (default `true`), plus the scan-narrowing fields
(`packages/daemon/src/features/skills/schemas.ts:856-870`).

Rules:

1. The user must have scanned first; the UI only offers records from the current preview.
2. Selection is explicit per record. The UI sets `allowNewSkills` only from a
   confirmation dialog that lists the new skills; a batch containing `new` records
   without it is rejected with
   `skill_source_sync_new_skills_require_confirmation`
   (`packages/daemon/src/features/skills/routes.ts:1528-1531`).
3. `blocked`, `missing`, `orphaned`, and `unchanged` records are rejected; a semantic
   error in the selected diff also rejects the batch.
4. The batch is atomic. New entries are created through the existing import-draft
   publication path; existing snapshots are archived and a new snapshot becomes active
   (`packages/core/src/storage/sqlite/skill-source-publication.ts:18-88`).
5. Shared publish explicitly bypasses the `auto-safe` automation whitelist
   (`enforceAutoSafePolicy: false`, `packages/daemon/src/features/skills/routes.ts:332`).
   That mode belongs to official automation; shared adoption has no automated path, so a
   human-triggered publish must not be rejected merely because the workspace policy is
   `auto-safe`. It must still be an explicit, selected publish.
6. Publish never binds a skill to a teammate, never edits teammates/channels/councils/
   automations, never changes approval policy or tool grants, and never enables implicit
   invocation. Adopted entries appear in **My skills** as user-owned content and can be
   bound or archived through existing explicit flows.
7. Publish never touches official-source state: no cache refresh, no network, no
   subscription row, no `gstack` registry entry.

### Ignore And Restore

Ignore is a **client-side presentation decision**, not a server-side governance record.

- Stored workspace-scoped in the browser (localStorage, keyed by the workspace path), so
  ignored records are hidden per workspace and survive reloads.
- Ignored records are excluded from counts/badges, hidden unless **Show ignored** is on,
  and cannot be selected for publish until restored.
- Ignore survives source content changes: a changed ignored source does not silently
  re-surface.
- Ignore is not a security control. Clearing site data restores the records; the daemon
  never trusts an "ignored" flag and always re-evaluates the preview.
- Ignore applies only to non-adopted records. To remove an already adopted skill, use
  **My skills** archive/hard-delete; ignoring it would only hide the source signal.
- Ignoring a `blocked` record is allowed and is the recommended way to dismiss unsafe or
  unwanted external content.

A server-side persisted ignore decision remains a deferred decision: if multiple clients
must share suppression state, it needs its own API and privacy review.

### Drift And Missing Sources

- Drift means the active published snapshot for a source-backed skill no longer matches
  the current source: checksum differs, warning fingerprint differs, or a semantic
  comparison reports high-severity items. The inspector shows checksum, front-matter,
  warning, and referenced-file diffs.
- Drift is informational until the user confirms **Update**. No update happens on scan,
  settings open, daemon start, or through any workspace policy.
- A missing source leaves the skill and its last snapshot intact. Ling does not disable,
  archive, delete, or rewrite the definition. The skill keeps working under existing
  runtime rules.
- **Snapshot scoping (implemented boundary guard).** The shared preview passes
  `snapshotSourceRoots: roots`, so only snapshots whose `sourceKind` matches a shared root
  and whose `sourcePath` is inside that root participate in `unchanged`/`drifted`/
  `missing` classification (`packages/core/src/skill-source-sync.ts:238-242,1003-1007`;
  `packages/daemon/src/features/skills/routes.ts:1479`). Official gstack snapshots and
  snapshots from unrelated directories are therefore invisible to the shared surface.

## Security And Authority Invariants

These are product invariants, not implementation suggestions.

1. Scan and preview are read-only with respect to skill state; they write nothing
   server-side and perform no network or git operations.
2. The daemon reads only the two fixed roots, only within each skill directory. Path
   traversal, symlink escape, and non-regular files must be rejected; referenced files
   must resolve inside the skill directory.
3. Publication re-reads and re-verifies every selected source within the bounded size and
   rejects truncated, changed, or unverifiable content
   (`packages/daemon/src/features/skills/source-publication.ts:36-100`).
4. Absolute filesystem paths stay inside daemon/workspace state. The current preview
   contract still returns absolute `roots[].rootPath` and record `sourcePath`
   (`packages/contracts/src/skills.ts`, existing `SkillSourceSyncPreviewReport`); the UI
   must never render them, and a daemon-side public projection is a follow-up item.
5. Source text never grants tools, MCP servers, credentials, provider access, approval
   bypass, external-send authority, browser access, deploy authority, or channel/council
   membership. Warning/blocked classification is advisory evidence; the hard effect is
   refusing to publish error-severity content until the user changes the source.
6. Scripts and assets are never executed, and only reference/agent-metadata artifacts are
   eligible for runtime context under the existing source-runtime gates.
7. No automatic mode, timer, watcher, CLI default, or workspace setting may publish or
   update shared skills without a human confirmation in the requesting surface.
8. Lazy source loading still requires an Effective Skill selection at run time; adopting
   a skill adds nothing to prompts by itself.

## Boundary With The P16 Official Source

P16 and Design A are separate contracts with different trust roots.

| Dimension | P16 official source | Design A shared local source |
|---|---|---|
| Source | Ling-managed cache of `github.com/garrytan/gstack` | `<cwd>/.agents/skills` and `~/.agents/skills` |
| Trust decision | Application-owned origin/ref, verified on every refresh | User-owned files; never trusted automatically |
| Trigger | Explicit **Sync updates**; P16 owns the official lifecycle | Explicit scan + per-record selection and confirmation in **Local skill folders** |
| Automatic apply | Never silent; refresh is explicit | Never, under any mode |
| Endpoints | `/skills/sync/gstack/*` | `/skills/sync/shared/*` |
| Policy state | `skill_source_upgrade_policies` (mode, approved roots, new-skill policy) belongs to the official flow | No policy rows; `auto-safe` bypassed for explicit shared publish; ignore is client-local |
| Identity | Built-in/official namespace (`gstack` provenance, built-in ids) | Shares the natural-id resolver; managed ids are blocked with `skill_id_conflict`, never attached |
| Provenance | `gstack-skill-directory` snapshot + `official_skill_source_subscriptions` | `workspace-skill-directory` snapshot + pack `shared-skill-source-sync` |
| Network | `git fetch` of the official origin only | None |
| UI | Official updates surface, outside Skill Library ownership navigation | **Local skill folders** section inside the Skill Library |
| Runtime | Published source loads lazily after selection | Same, and only after the user binds/selects the adopted skill |

Rules that keep the boundary intact:

1. P16's statement that routine source sync does not scan `~/.codex/skills`,
   `~/.agents/skills`, or workspace `.agents/skills`
   ([P16, "Product Decision"](managed-official-skill-source-p16.md#product-decision))
   remains true. The official flow never scans them; the shared flow scans them only for
   local adoption and never feeds the official flow.
2. Official refresh/apply never reads shared ignore state, never publishes shared pack
   entries, and never mutates user-owned adopted entries.
3. Shared publish never reads or writes the managed official cache, never refreshes or
   updates the official subscription, never writes `gstack` registry entries, and never
   calls git or the network.
4. Managed-id guard: the shared preview runs with `allowManagedSkillIdMatching: false`,
   so a record resolving to a `builtin`, `gstack`, or `workspace` entry is `blocked` with
   `skill_id_conflict` and cannot be selected; no snapshot is attached to a managed skill
   and official runtime context is unchanged.
5. Snapshot-scope guard: shared drift/missing computation is restricted to snapshots
   inside the two shared roots via `snapshotSourceRoots`, so official snapshots never
   appear as shared `missing`/`drifted`.
6. Users see two distinct actions with distinct language: **Official skill updates**
   (Ling-provided) versus **Local skill folders** (your files). A single unified sync
   button is a non-goal unless a later contract explicitly unifies the trust boundaries.
7. Shared low-level machinery (scanner, warning classifier, snapshot publication,
   artifact staging) is reused, but the two flows must not share policy rows, user
   decisions, or response shapes. Provenance is parameterized rather than hard-coded
   `gstack` (`packages/daemon/src/features/skills/routes.ts:1490-1570`).

## Non-Goals

- Scanning `~/.codex/skills`, `~/.claude/skills`, gstack checkouts, mounted volumes, or
  arbitrary/configured roots.
- Accepting client-supplied source paths in scan/publish.
- Automatic publish, automatic update, startup imports, background sweeps, or filesystem
  watchers.
- Two-way sync: Ling never writes to, renames, deletes, or repairs the external folders.
- Executing scripts, installing dependencies, or running host commands from a skill
  directory.
- Editing source files in place, or treating shared files as Ling-owned drafts.
- Automatic teammate binding, implicit invocation, or prompt injection on adoption.
- Marketplace/remote install or trust-on-first-use of arbitrary directories.
- Persisting ignore decisions server-side in v1.
- Official-source behavior changes. P16 is out of scope for this change.

## Acceptance Criteria

Backend criteria 2, 4-9, 11, and 13 are covered today by
`packages/core/test/skill-source-shared-roots.test.mjs` and
`packages/daemon/test/shared-skill-source-scan-api.test.mjs`; the UI-facing criteria
(1, 3 in the surface, 10, 12) and contract-parity checks remain open in the
[implementation plan](external-agent-skill-discovery-implementation-plan.md).

1. Opening **Local skill folders** performs an explicit shared scan of the workspace and
   home `.agents/skills` roots and shows records with states and provenance; it writes no
   registry, snapshot, or artifact state.
2. The roots are auto-detected; no request field can widen them, and a missing root is
   simply absent from the result.
3. Duplicate names across roots resolve by project-first priority; the losing record is
   blocked/not publishable.
4. A source containing error-severity warning content (for example a raw secret-like
   value) is `blocked` and cannot be published; the reason is visible.
5. Publishing requires an explicit scan and selection; a batch with `new` records requires
   the explicit new-skill confirmation. No policy mode, timer, watcher, CLI default, or
   setting publishes without it.
6. A shared record that resolves to a built-in/official/workspace-owned skill is blocked
   and rejected server-side; no snapshot is attached to it and official runtime context
   is unchanged.
7. Adopted records are user-owned (`source: "skill-directory"`, pack
   `shared-skill-source-sync`), appear in **My skills**, and remain unbound and
   runtime-inert until the user explicitly binds/selects them.
8. Updating a drifted record archives the previous published snapshot, activates the new
   one, and leaves the user-edited `SkillDefinition` unchanged.
9. Shared drift/missing computation ignores official-source snapshots; official sync and
   shared adoption remain independent.
10. Ignore/restore persists per workspace in the client, removes/adds records from counts,
    and never deletes skills or snapshots.
11. A missing source leaves the adopted skill, definition, and last snapshot intact and
    surfaces as **Source missing**.
12. The UI never renders absolute filesystem paths; the API contract for this surface is
    reviewed for path exposure.
13. Negative tests cover path injection/escape, auto-publish absence, managed-id targets,
    snapshot cross-contamination, and new-skill confirmation.

## Rollback

The capability is additive:

- Remove the Skill Library section and the `/skills/sync/shared/*` routes to hide the
  feature; adopted entries remain ordinary user-owned `skill-directory` skills and can be
  archived/deleted with existing flows.
- No new server-side tables are required in v1 (ignore is client-local), so storage
  rollback is limited to removing scan-related code.
- Published snapshots remain available for audit and existing source-history rollback.
- No official-source code, policy, cache, or subscription is affected by rollback.

## Deferred Decisions

- A reserved local id namespace (`local-*`) if natural-id collisions with managed skills
  become common or need a non-breaking migration.
- Server-side persistable ignore decisions shared across clients.
- A daemon-side public projection that strips absolute paths from scan responses.
- Extending discovery to `~/.codex/skills` or user-selected extra roots under a separate
  trust contract.
- Cross-workspace/team sharing of adopted skills.
- A unified review inbox across official, shared, and AI-evolution sources.
- CLI parity for scan/publish/ignore.
