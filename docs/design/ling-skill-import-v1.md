# Ling Skill Import v1

Status: Implemented v1 slice; PATCH-style draft editing remains deferred
Date: 2026-06-04
Scope: Unified skill registry, custom skill packs, persona import drafts, Effective
Skills UI, and skill-aware task/run polish

## Summary

Ling needs one skill model, not separate "global skills" and "agent skills" that drift
apart.

The target shape is:

```text
Unified Skill Registry
  -> built-in skill packs
  -> workspace custom skill packs
  -> imported skill directories
  -> optional teammate-scoped skill sources
  -> teammate bindings
  -> Effective Skill read model
  -> skill-aware tasks and runs
```

Skills define workflow templates. Bindings assign which teammate can use a skill.
Effective Skills decide whether a skill can actually run in the current channel, provider,
tool, approval, and state-machine context.

Persona sources such as `AGENTS.md`, `AGENT.md`, and `persona.md` are a separate import
path. They can shape a teammate profile, but they cannot grant tools, approvals, secrets,
external-send permission, or side effects.

## Current Foundation

Already implemented foundation:

- built-in `gstack-default` skill pack in `packages/core`,
- durable teammate skill bindings in `teammate_skill_bindings`,
- `EffectiveTeammateSkill` contracts and daemon read model,
- blocked reason codes for disabled binding, missing tools, missing provider capability,
  channel policy, and approval mismatch,
- task `requestedSkillId`,
- run `selectedSkillId`,
- run-start validation that rejects missing, unbound, or non-executable requested skills,
- selected skill prompt fragments, required tools, and approval profile merged into the
  runtime request,
- `POST /teammates/:id/persona-draft` for markdown persona draft parsing.

This slice should not replace those pieces. It should make them user-visible and add the
missing import and registry workflow.

## Goals

- Provide one workspace skill registry that can list built-in and custom skill
  definitions.
- Support importing compatible skill packs and skill directories as reviewed drafts.
- Support importing `AGENTS.md`, `AGENT.md`, `persona.md`, or pasted markdown as teammate
  persona drafts.
- Upgrade the Private Workspace Skills tab from a binding editor into an executability
  surface.
- Let tasks and runs select `requestedSkillId` from the effective skill list.
- Show the selected skill on run history and blocked run start errors.
- Preserve strict permission boundaries: imported text never grants authority.

## Non-Goals

- No automatic execution of imported `SKILL.md` or `AGENTS.md` content.
- No remote marketplace, package manager, or dependency installer.
- No automatic tool, MCP, secret, provider, approval, or external-send grant.
- No agent-to-agent hidden delegation through private chat.
- No vector retrieval provider work in this slice.

## Core Boundary

The strongest failure mode is treating a skill file as an auth grant. Ling must keep
definition, assignment, and execution separate:

```text
Skill definition says:
  "This is how to do QA."

Teammate binding says:
  "This teammate may request QA."

Effective Skill says:
  "This teammate can or cannot run QA here, now, with these tools and this provider."
```

The same applies to persona:

```text
Persona source says:
  "This teammate should behave like a careful QA engineer."

Persona source cannot say:
  "Enable bash."
  "Bypass approvals."
  "Read all channels."
  "Send externally."
  "Use this secret."
```

## Unified Skill Registry

The registry stores skill definitions and their provenance.

Sources:

- `builtin`: bundled Ling skill packs such as `gstack-default`.
- `workspace`: user-created Ling-native skill packs stored in the workspace database.
- `skill-directory`: imported local folders that contain `SKILL.md` files.
- `agents-md`: imported markdown that can produce persona drafts and, later, reviewed
  skill draft hints.
- `custom`: manually created or edited skill definitions.

The registry should expose definitions independently from teammate bindings. A skill can
exist in the registry without being bound to any teammate.

```ts
interface SkillRegistryEntry {
  readonly id: string;
  readonly packId: string;
  readonly source: "builtin" | "workspace" | "skill-directory" | "agents-md" | "custom";
  readonly sourcePath?: string;
  readonly version?: string;
  readonly checksum?: string;
  readonly definition: SkillDefinition;
  readonly reviewStatus: "builtin" | "draft" | "published" | "disabled" | "archived";
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

Workspace custom skills are common by default. A teammate-specific skill source is allowed,
but it is represented as registry visibility plus a teammate binding, not as a second
permission system:

```ts
interface SkillVisibility {
  readonly workspaceVisible: boolean;
  readonly ownerTeammateId?: string;
  readonly promotableToWorkspace: boolean;
}
```

## Skill Import Draft Lifecycle

Importing a skill pack should be a review flow:

```text
select source
  -> parse
  -> normalize definitions
  -> produce draft
  -> show warnings
  -> preview required tools
  -> preview provider capabilities
  -> preview approval profile
  -> user publishes to registry
  -> user binds to teammate
  -> Effective Skill validates runtime executability
```

Supported v1 inputs:

- a Ling-native JSON skill pack,
- a local directory containing one or more `SKILL.md` files,
- a pasted `SKILL.md` body,
- future-compatible `AGENTS.md` hints, but only as draft metadata unless the parser can
  confidently produce a safe `SkillDefinition`.

Draft warnings should be explicit and actionable:

```ts
type SkillImportWarningCode =
  | "permission_like_instruction"
  | "secret_reference"
  | "external_send_claim"
  | "unknown_tool"
  | "unknown_provider_capability"
  | "unsupported_section"
  | "missing_metadata"
  | "duplicate_skill_id";

interface SkillImportWarning {
  readonly code: SkillImportWarningCode;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly location?: string;
}
```

An import with `error` warnings cannot be published until the user edits the draft or
removes the invalid definition.

## Persona Import Draft Lifecycle

Persona import is separate from skill import.

Inputs:

- `AGENTS.md`,
- `AGENT.md`,
- `persona.md`,
- pasted markdown.

Current contract foundation:

```ts
interface TeammatePersonaDraft {
  readonly teammateId: string;
  readonly sourceKind: "agents-md" | "persona-md" | "markdown";
  readonly sourcePath?: string;
  readonly displayName: string;
  readonly description: string;
  readonly systemPrompt: string;
  readonly appendSystemPrompt: readonly string[];
  readonly warnings: readonly string[];
}
```

Target UI flow:

```text
Private Workspace Settings
  -> Import persona
  -> choose file or paste markdown
  -> create persona draft
  -> compare current teammate profile with draft
  -> show warnings
  -> user confirms selected fields
  -> PATCH durable teammate
```

The draft preview should separate:

- display name changes,
- description changes,
- system prompt replacement,
- append-only prompt fragments,
- warnings and ignored permission-like content.

Persona warnings should flag:

- instructions that claim tool access,
- approval bypass language,
- external-send instructions,
- secret references,
- broad memory/channel access claims,
- prompt text that appears to override system or policy boundaries.

Confirmation should write only normal teammate profile fields. It must not update:

- allowed tools,
- MCP bindings,
- approval profile,
- provider preset,
- memory scopes,
- channel memberships,
- secrets.

## Private Workspace Skills Tab

The current tab should become the teammate's skill control and diagnostics surface.

Target controls:

- list built-in and custom registry skills,
- import skill pack or skill directory,
- add manual custom skill draft,
- bind a skill to the teammate,
- disable a binding without deleting the registry definition,
- delete only user-created bindings or archived custom definitions,
- show executable / blocked status from `EffectiveTeammateSkill`,
- show blocked reason details and direct remediation links.

Rows should present:

```text
Skill name
Workflow phase
Binding source: template | user | imported
Binding state: enabled | disabled
Executable state: executable | blocked
Required tools
Provider capabilities
Approval profile
Blocked reasons
```

Blocked reason examples:

- `disabled_binding`: "Skill is disabled for this teammate."
- `missing_tools`: "Engineer lacks write, but Implementation requires write."
- `missing_provider_capability`: "Selected provider lacks tool_call."
- `channel_policy`: "This channel does not allow bash."
- `approval_mismatch`: "Teammate approval profile is weaker than Ship's strict profile."

The tab should use language such as "Executable" and "Blocked" instead of only "Enabled".
Enabled is only one input to executability.

## Effective Skill Read Model

The read model is the single UI and run-start source of truth:

```ts
interface EffectiveTeammateSkill {
  readonly teammateId: string;
  readonly skillId: string;
  readonly skill: SkillDefinition;
  readonly binding: TeammateSkillBinding;
  readonly executable: boolean;
  readonly blockedReasons: readonly EffectiveSkillBlockedReason[];
  readonly promptFragments: readonly string[];
  readonly requiredTools: readonly ToolName[];
  readonly requiredProviderCapabilities: readonly ProviderCapability[];
}
```

The current implementation computes this for built-in skills. The next slice should extend
the source list so custom and imported registry definitions participate in the same
calculation.

The UI should never infer executability client-side from partial fields. The daemon owns
the calculation because it has access to teammate policy, channel allowed tools, provider
capabilities, approval profile, and future workflow state.

## Skill-Aware Task And Run

Task creation and task detail should allow selecting a skill:

```text
Assignee teammate selected
  -> skill selector shows that teammate's Effective Skills
  -> executable skills are selectable
  -> blocked skills are visible but disabled with reasons
  -> task saves requestedSkillId
```

Run start behavior:

```text
task requestedSkillId
  -> resolve teammate
  -> build Effective Skills
  -> reject if missing, unbound, or blocked
  -> merge selected skill prompt fragments
  -> merge required tools
  -> merge approval profile
  -> persist selectedSkillId on run
```

Run UI should show:

- requested skill on the task,
- selected skill on the run,
- any blocked reasons if run start fails,
- skill prompt/tool/approval contribution in an audit-friendly detail panel.

If a task has no `requestedSkillId`, the run can still start through the existing generic
path. Future inference can suggest a skill, but v1 should prefer explicit selection.

## API Sketch

Existing API foundation:

- `GET /teammates/:id/skills`,
- `PUT /teammates/:id/skills`,
- `POST /teammates/:id/persona-draft`,
- task create/update `requestedSkillId`,
- run records `selectedSkillId`.

Implemented APIs:

```text
GET /skills
POST /skills/import-draft
GET /skills/import-drafts/:id
POST /skills/import-drafts/:id/publish
DELETE /skills/:id
```

Rules:

- `GET /skills` returns built-in and workspace registry definitions.
- `POST /skills/import-draft` parses source content and returns draft definitions plus
  warnings.
- Publishing an import draft writes registry definitions but does not bind them.
- Binding still happens through teammate skills APIs.
- `DELETE /skills/:id` archives a custom/imported registry definition.
- PATCH-style draft editing and skill editing are deferred; users can create a new draft
  when they need to revise imported content.

## Storage Sketch

Existing storage:

- `teammate_skill_bindings`,
- task `requested_skill_id`,
- run `selected_skill_id`.

New storage:

```sql
CREATE TABLE skill_packs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT,
  source_path TEXT,
  checksum TEXT,
  review_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE skill_definitions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  pack_id TEXT NOT NULL,
  source TEXT NOT NULL,
  definition_json TEXT NOT NULL,
  visibility_json TEXT NOT NULL,
  review_status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE skill_import_drafts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  source TEXT NOT NULL,
  source_path TEXT,
  draft_json TEXT NOT NULL,
  warnings_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Built-in packs can stay code-backed and be projected into `GET /skills`; they do not need
to be duplicated into SQLite unless a later migration needs immutable snapshots.

## UI Surface Sketch

### Skills Tab

```text
Header: Skills
Actions: Import pack, Add custom skill

Filters:
  All | Executable | Blocked | Disabled | Custom

Rows:
  Implementation       executable
  QA                   blocked: channel policy
  Ship                 blocked: approval mismatch
  Custom Release Note  disabled
```

### Import Skill Pack Dialog

```text
Source: paste | file | directory
Preview:
  Skills parsed
  Required tools
  Provider capabilities
  Approval profile
  Warnings
Actions:
  Save draft | Publish to registry | Cancel
```

### Persona Import Dialog

```text
Source: AGENTS.md | AGENT.md | persona.md | paste markdown
Preview:
  Current profile
  Draft profile
  Warnings
Actions:
  Apply selected fields | Cancel
```

### Task/Run Skill Selector

```text
Assignee: Engineer
Skill:
  Implementation       selectable
  Investigate          selectable
  Ship                 disabled: approval mismatch
```

## Test Plan

Core:

- registry lists built-in and custom skills without duplicating ids,
- import draft parser produces warnings for permission-like instructions,
- publishing an import draft creates registry definitions but no teammate binding,
- archived custom skills no longer appear as executable options,
- Effective Skills includes custom/imported definitions and existing built-in definitions,
- blocked reasons remain deterministic.

Daemon:

- `GET /skills` returns built-in plus custom registry entries,
- `POST /skills/import-draft` handles valid pack, invalid pack, duplicate ids, and
  unknown tools,
- teammate skill binding rejects missing definitions unless explicitly preserving unknown
  legacy bindings,
- persona draft import never mutates tools, approval profile, secrets, provider, memory,
  or channel memberships,
- run start rejects blocked requested skills and returns reason codes.

Web:

- Skills tab shows executable and blocked states,
- importing a skill pack shows warnings before publishing,
- binding an imported skill updates the Effective Skill list,
- persona import shows draft comparison and applies only selected profile fields,
- task create/update can save `requestedSkillId`,
- run history shows `selectedSkillId`,
- blocked run start displays reason codes in user-facing text.

Verification:

- `corepack pnpm --filter @ling-stack/core test`,
- `corepack pnpm --filter @ling-stack/daemon test`,
- `corepack pnpm --filter @ling-stack/web typecheck`,
- targeted web e2e for Skills tab, persona import, and skill-aware run,
- `git diff --check`.

## Rollout Plan

1. Documentation baseline. Implemented.
2. Storage and contracts for custom skill registry and import drafts. Implemented.
3. Daemon registry APIs and parser safeguards. Implemented.
4. Private Workspace Skills tab upgrade. Implemented.
5. Persona import UI. Implemented.
6. Task/run skill selector and blocked reason display. Implemented for teammate workspace
   task creation, run history selected skill, and daemon blocked errors.
7. Focused tests and merge. Completed in PR #70.

## Open Questions

- Should teammate-scoped custom skills be private forever, or can users promote them into
  workspace skills with a review step?
- Should import drafts keep raw source content for diffing, or only keep normalized draft
  JSON and source checksum?
- Should `AGENTS.md` produce only persona drafts in v1, or can it also emit skill draft
  hints when sections are clearly parseable?
- Should unknown legacy skill bindings remain visible forever, or should they prompt a
  one-time migration into custom registry entries?
