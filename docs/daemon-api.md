# Daemon API

The daemon is the local process that connects the future CLI, web UI, and desktop shell to Ling Stack runners.

## Start

Current manual foreground start:

```bash
corepack pnpm --filter @ling-stack/daemon build
node packages/daemon/dist/cli.js
```

Environment variables:

```text
LING_STACK_HOST=127.0.0.1
LING_STACK_PORT=17891
```

Provider presets can reference secrets from the daemon process environment:

```text
LOCAL_RELAY_API_KEY=sk-local
```

Background daemon lifecycle commands are not part of the current HTTP API contract.
The P0 design for `ling-stack daemon start`, `status`, `stop`, `restart`, `logs`, and
read-only doctor checks lives in [Daemon Lifecycle and Doctor P0](design/daemon-lifecycle-p0.md).

## Health

```http
GET /health
```

Response:

```json
{
  "ok": true,
  "service": "ling-stack-daemon",
  "defaultWorkspaceCwd": "/path/to/workspace",
  "readiness": "ready"
}
```

This endpoint is the live process reachability check. The current implementation does
not expose full startup diagnostics. `readiness` is a lightweight aggregate for the
default workspace and may be `starting`, `ready`, `degraded`, or `failed`. Clients that
need phase diagnostics should call `/startup/status`.

The current implementation does not expose lifecycle metadata such as pid, version,
started time, host, port, state path, or log path. The P0 daemon lifecycle design may
extend `/health` with those fields after `.ling-stack/daemon/daemon.json` and
`.ling-stack/logs/daemon.log` exist. Until then, clients must treat those fields as
optional and unavailable.

## Startup Readiness

```http
GET /startup/status?cwd=/path/to/project
```

Returns memory-only startup status for the requested workspace. Missing `cwd` defaults
to the daemon default workspace. If no status exists yet, the daemon performs a
best-effort required-phase warmup for that workspace.

```json
{
  "startupAttemptId": "startup_20260614_000000_abc123",
  "cwd": "/path/to/project",
  "state": "degraded",
  "startedAt": "2026-06-14T00:00:00.000Z",
  "updatedAt": "2026-06-14T00:00:01.000Z",
  "phases": {
    "process_config": "ready",
    "user_config": "ready",
    "workspace_store": "ready",
    "effective_config": "ready",
    "runtime_policy": "ready",
    "secret_resolver": "degraded",
    "provider_warmup": "ready",
    "automation_scheduler": "ready",
    "external_work_scheduler": "ready",
    "plugin_warmup": "ready"
  },
  "diagnostics": [],
  "effectiveConfigLoadedAt": "2026-06-14T00:00:00.900Z"
}
```

```http
POST /startup/refresh?cwd=/path/to/project
```

Clears the in-memory workspace startup record, recomputes required phases, and returns
the same response shape. It does not create, repair, or rewrite user/workspace config
files and never returns secret values.

Runs started through the daemon check required startup phases before durable work-unit
claim. Invalid workspace runtime policy rejects with `runtime_policy_invalid`; startup
that is still loading rejects with `startup_not_ready`.

Optional warmup failures do not make `/health` fail. Failed provider startup checks or
plugin descriptor checks move the workspace status to `degraded` and add bounded
diagnostics; action-specific preflight still owns the final run/provider/plugin block.

## Workspace Directory Selection

```http
POST /workspace-directory/select?cwd=/path/to/workspace
```

Opens the local daemon host's native directory picker and returns a real absolute
path. The request `cwd` is used only as the default picker location; it does not
change the workspace settings.

```json
{ "cancelled": false, "path": "/path/to/project", "label": "project" }
```

If the user cancels the native picker, the daemon returns:

```json
{ "cancelled": true }
```

Unsupported platforms return `501 directory_picker_unsupported`.

## Effective Configuration

```http
GET /config/effective?cwd=/path/to/project
```

This endpoint is read-only. It reports the current user/workspace configuration paths
and the effective source for the settings the UI needs to explain. It does not create
`~/.ling-stack`, repair files, migrate localStorage, or change runtime settings.

Current resolution:

- `workspaceCwd`: workspace settings, then the request `cwd`;
- `theme`, `locale`, `responseLanguage`, `lingConversationTone`: workspace settings, then
  `~/.ling-stack/settings.json`, then built-in defaults;
- runtime runner settings: field-level workspace runtime settings, then user
  `~/.ling-stack/config.json.runtimeDefaults`, then built-in Pi defaults.

User-level runtime defaults in `~/.ling-stack/config.json` are returned under
`layers.userConfig` for visibility and apply to execution until the workspace writes
that runtime field. `PATCH /runtime/settings` writes a complete workspace runtime
settings file, so inherited runtime values become workspace-owned after save.

Response:

```json
{
  "cwd": "/path/to/project",
  "paths": {
    "user": {
      "rootDir": "/Users/me/.ling-stack",
      "configPath": "/Users/me/.ling-stack/config.json",
      "settingsPath": "/Users/me/.ling-stack/settings.json",
      "providerProfilesPath": "/Users/me/.ling-stack/providers/profiles.json",
      "pluginCacheDir": "/Users/me/.ling-stack/plugins/cache",
      "logsDir": "/Users/me/.ling-stack/logs"
    },
    "workspace": {
      "rootDir": "/path/to/project/.ling-stack",
      "configPath": "/path/to/project/.ling-stack/config.json",
      "databasePath": "/path/to/project/.ling-stack/ling-stack.sqlite",
      "runtimeSettingsPath": "/path/to/project/.ling-stack/runtime-settings.json",
      "sessionsDir": "/path/to/project/.ling-stack/sessions",
      "artifactsDir": "/path/to/project/.ling-stack/artifacts",
      "attachmentsDir": "/path/to/project/.ling-stack/attachments",
      "pluginCacheDir": "/path/to/project/.ling-stack/plugins/cache",
      "logsDir": "/path/to/project/.ling-stack/logs"
    }
  },
  "values": {
    "workspaceCwd": {
      "value": "/path/to/project",
      "source": "built_in",
      "key": "workspaceCwd"
    },
    "theme": {
      "value": "dark",
      "source": "user",
      "path": "/Users/me/.ling-stack/settings.json",
      "key": "theme"
    },
    "locale": {
      "value": "zh-CN",
      "source": "user",
      "path": "/Users/me/.ling-stack/settings.json",
      "key": "locale"
    },
    "responseLanguage": {
      "value": "follow_user",
      "source": "built_in",
      "key": "responseLanguage"
    },
    "lingConversationTone": {
      "value": "pragmatic",
      "source": "built_in",
      "key": "lingConversationTone"
    },
    "runtime": {
      "defaultRunnerId": {
        "value": "pi",
        "source": "user",
        "path": "/Users/me/.ling-stack/config.json",
        "key": "runtime.defaultRunnerId"
      },
      "explicitRunnerFallback": {
        "value": "disabled",
        "source": "built_in",
        "key": "runtime.explicitRunnerFallback"
      },
      "implicitRunnerFallback": {
        "value": "allow_to_default",
        "source": "built_in",
        "key": "runtime.implicitRunnerFallback"
      }
    }
  },
  "layers": {
    "userConfig": {
      "runtimeDefaults": {
        "defaultRunnerId": "pi"
      }
    },
    "userSettings": {
      "theme": "dark",
      "locale": "zh-CN",
      "lingConversationTone": "friendly"
    },
    "workspaceSettings": {
      "schemaVersion": 1,
      "updatedAt": "2026-06-13T00:00:00.000Z"
    }
  },
  "diagnostics": []
}
```

`diagnostics` contains non-fatal warnings for unreadable or invalid optional user-level
JSON files. The endpoint ignores unknown user config keys and returns only recognized,
sanitized user-layer fields.

## Workspace Settings

```http
GET /workspace-settings?cwd=/path/to/project
PATCH /workspace-settings?cwd=/path/to/project
Content-Type: application/json
```

Workspace settings are stored in the workspace SQLite state under `.ling-stack`.
Nullable PATCH fields clear the workspace override and fall back to user settings or
built-in defaults.

`lingConversationTone` accepts `friendly`, `pragmatic`, `none`, or `null`.
`pragmatic` is the built-in default. Invalid values are rejected on PATCH; invalid
persisted or user-level settings fall back through effective config diagnostics instead
of crashing the daemon.

```json
{
  "lingConversationTone": "friendly"
}
```

## Channels and Tasks

Channels bind a workspace workflow to optional defaults such as a local path, provider preset, teammate, and allowed tools. Tasks are persisted work items inside a channel.

All channel and task endpoints require `cwd` so the daemon can choose the local workspace database:

```text
.ling-stack/ling-stack.sqlite
```

### List Channels

```http
GET /channels?cwd=/path/to/project&limit=100
```

Response:

```json
{
  "cwd": "/path/to/project",
  "channels": [
    {
      "id": "channel_...",
      "workspaceId": "workspace_default",
      "name": "Engineering",
      "status": "active",
      "boundPath": "/path/to/project",
      "defaultProviderPresetId": "provider_...",
      "defaultTeammateId": null,
      "allowedTools": ["read", "grep", "find", "ls"],
      "runtimePolicy": {
        "maxConcurrentRuns": 1,
        "schedulingMode": "smart",
        "writeLockScope": "boundPath",
        "allowReadOnlyParallel": true,
        "queueOnConflict": true
      },
      "createdAt": "2026-05-21T00:00:00.000Z",
      "updatedAt": "2026-05-21T00:00:00.000Z"
    }
  ]
}
```

### Create Channel

```http
POST /channels?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "name": "Engineering",
  "status": "active",
  "boundPath": "/path/to/project",
  "defaultProviderPresetId": "provider_...",
  "defaultTeammateId": "teammate_...",
  "allowedTools": ["read", "grep", "find", "ls"],
  "runtimePolicy": {
    "maxConcurrentRuns": 1,
    "schedulingMode": "smart",
    "writeLockScope": "boundPath",
    "allowReadOnlyParallel": true,
    "queueOnConflict": true
  }
}
```

`allowedTools` may contain `read`, `grep`, `find`, `ls`, `bash`, `edit`, or `write`.
`status` may be `active`, `paused`, or `archived`. Paused channels can be edited but cannot start new runs. `runtimePolicy.schedulingMode` is always `smart`; the daemon computes the effective serial/parallel decision per workflow tick from dependency, tool, approval, lease, and `maxConcurrentRuns` evidence. `runtimePolicy.writeLockScope` controls whether side-effectful runs lock the channel, bound path, or whole workspace.

### Get, Update, Delete Channel

```http
GET /channels/:id?cwd=/path/to/project
PATCH /channels/:id?cwd=/path/to/project
DELETE /channels/:id?cwd=/path/to/project
```

`PATCH` accepts partial fields. Nullable fields can be cleared with `null`. `DELETE` returns `409 channel_has_tasks` when the channel still owns tasks.

### List Tasks

```http
GET /tasks?cwd=/path/to/project&channelId=channel_...&status=todo&limit=100
```

Supported statuses:

```text
todo, claimed, running, blocked, review, done, failed, cancelled
```

Response:

```json
{
  "cwd": "/path/to/project",
  "tasks": [
    {
      "id": "task_...",
      "workspaceId": "workspace_default",
      "channelId": "channel_...",
      "title": "Inspect daemon API",
      "prompt": "Read the daemon package and summarize the routes.",
      "status": "todo",
      "assigneeTeammateId": null,
      "currentRunId": null,
      "createdAt": "2026-05-21T00:00:00.000Z",
      "updatedAt": "2026-05-21T00:00:00.000Z"
    }
  ]
}
```

### Create Task

```http
POST /tasks?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "channelId": "channel_...",
  "title": "Inspect daemon API",
  "prompt": "Read the daemon package and summarize the routes.",
  "status": "todo",
  "assigneeTeammateId": "teammate_..."
}
```

The referenced channel must exist.

### Get, Update, Delete Task

```http
GET /tasks/:id?cwd=/path/to/project
PATCH /tasks/:id?cwd=/path/to/project
DELETE /tasks/:id?cwd=/path/to/project
```

`PATCH` accepts `channelId`, `title`, `prompt`, `status`, `assigneeTeammateId`, and `currentRunId`. Nullable fields can be cleared with `null`.

When a persisted task is run through `/runs`, the daemon updates the linked task status to `running`, then `done`, `failed`, or `cancelled`.

## AI Teammates

AI teammates are durable workspace members. The daemon seeds built-in `gstack-default`
teammates with deterministic ids such as `teammate_builtin_engineer`, migrates legacy
template references such as `engineer`, and stores custom teammates in the workspace
SQLite database.

All teammate endpoints require `cwd`.

### List And Create Teammates

```http
GET /teammates?cwd=/path/to/project&includeHidden=false&includeDisabled=false&limit=100
POST /teammates?cwd=/path/to/project
```

`GET` returns active, visible teammates by default. `includeHidden=true` and
`includeDisabled=true` widen the roster.

```json
{
  "cwd": "/path/to/project",
  "teammates": [
    {
      "id": "teammate_builtin_engineer",
      "workspaceId": "workspace_default",
      "templateId": "engineer",
      "roleKey": "engineer",
      "displayName": "Engineer",
      "description": "Owns scoped implementation.",
      "providerPresetId": "provider_...",
      "appendSystemPrompt": [],
      "allowedTools": ["read", "grep", "find", "ls"],
      "approvalProfile": { "mode": "ask" },
      "status": "active",
      "pinned": true,
      "hidden": false,
      "createdAt": "2026-05-29T00:00:00.000Z",
      "updatedAt": "2026-05-29T00:00:00.000Z"
    }
  ]
}
```

`POST` creates a durable teammate:

```json
{
  "templateId": "engineer",
  "roleKey": "engineer",
  "displayName": "Ling Engineer",
  "description": "Owns scoped implementation in the Engineering channel.",
  "providerPresetId": "provider_...",
  "systemPrompt": "You are the Engineering AI teammate.",
  "allowedTools": ["read", "grep", "find", "ls"],
  "approvalProfile": { "mode": "ask" },
  "status": "active",
  "pinned": true,
  "hidden": false
}
```

### Get, Update, Disable Teammate

```http
GET /teammates/:id?cwd=/path/to/project
PATCH /teammates/:id?cwd=/path/to/project
DELETE /teammates/:id?cwd=/path/to/project
POST /teammates/:id/hard-delete?cwd=/path/to/project
```

`PATCH` accepts partial identity, provider, prompt, allowed tool, approval profile,
status, pin, hidden, and avatar reference fields. Nullable fields can be cleared with
`null`. `avatarImageAttachmentId`, when set directly, must reference a
`teammate_profile_avatar` private attachment owned by the same teammate.

`DELETE` is a soft disable. It sets `status` to `disabled` and `hidden` to `true`;
private history and related records remain available for retention/audit.

`POST /hard-delete` is the destructive retention path. It accepts an optional reason and
returns a minimal tombstone. It deletes teammate private thread/messages, private
attachments and avatar bytes, teammate-scope memory, related used-memory events, and
teammate private bindings. It does not cascade-delete channel messages, tasks, or run
history; those records clear teammate references or render as a deleted teammate.

Request:

```json
{
  "reason": "owner request"
}
```

Response:

```json
{
  "tombstone": {
    "id": "tomb_...",
    "workspaceId": "workspace_default",
    "entityType": "ai-teammate",
    "entityId": "teammate_...",
    "reason": "owner request",
    "deletedCounts": {
      "aiTeammates": 1,
      "directThreads": 1,
      "directMessages": 8,
      "privateAttachments": 2,
      "memoryObjects": 1,
      "usedMemoryEvents": 3
    },
    "createdAt": "2026-06-04T00:00:00.000Z"
  }
}
```

The tombstone intentionally omits message text, prompt text, persona text, snippets,
file names, and attachment content.

## Skill Registry

The skill registry lists built-in and workspace custom skill definitions. Skill
definitions are workflow templates; teammate bindings and Effective Skill checks still
decide whether a skill can run.

```http
GET /skills?cwd=/path/to/project
GET /skills/health?cwd=/path/to/project
GET /skills/usage-events?cwd=/path/to/project
GET /skills/usage-stats?cwd=/path/to/project
POST /skills/:id/corrections?cwd=/path/to/project
GET /procedure-observations?cwd=/path/to/project
POST /procedure-observations?cwd=/path/to/project
POST /procedure-observations/jobs?cwd=/path/to/project
GET /procedure-observation-clusters?cwd=/path/to/project
GET /procedure-observation-clusters/:id?cwd=/path/to/project
GET /skill-candidates?cwd=/path/to/project
GET /skill-candidates/:id?cwd=/path/to/project
POST /skill-candidates?cwd=/path/to/project
POST /skill-candidates/observe?cwd=/path/to/project
POST /skill-candidates/:id/review?cwd=/path/to/project
POST /skill-candidates/:id/draft?cwd=/path/to/project
POST /skills/refresh?cwd=/path/to/project
POST /skills/import-draft?cwd=/path/to/project
GET /skills/import-drafts/:id?cwd=/path/to/project
POST /skills/import-drafts/:id/publish?cwd=/path/to/project
DELETE /skills/:id?cwd=/path/to/project
```

`GET /skills` returns built-in definitions projected from `gstack-default` plus published
workspace registry definitions. Built-in definitions are not duplicated into SQLite.

`GET /skills/health` returns a read-only governance report over the effective skill
registry, durable skill candidates, and local skill usage telemetry. It uses the same
registry projection as `GET /skills`, accepts an optional `limit` query parameter, and
does not create candidates, publish drafts, archive skills, or mutate review state.

```http
GET /skills/health?cwd=/path/to/project&limit=50
```

Health response:

```json
{
  "cwd": "/path/to/project",
  "report": {
    "workspaceId": "workspace_default",
    "generatedAt": "2026-06-20T00:00:00.000Z",
    "staleCandidateDays": 30,
    "summary": {
      "totalSkills": 18,
      "activeSkills": 18,
      "generatedSkills": 0,
      "pendingCandidates": 0,
      "duplicateClusters": 0,
      "conflictCount": 0,
      "staleCandidates": 0,
      "highFailureRateSkills": 0,
      "findings": { "critical": 0, "warning": 0, "info": 0 }
    },
    "findings": []
  }
}
```

`GET /skills/usage-events` returns local event records used to rebuild skill governance
statistics. Optional `skillId`, `candidateId`, `runId`, `kind`, and `limit` query
parameters are supported. `GET /skills/usage-stats` returns aggregated stats and
optionally accepts `skillId`.

```http
GET /skills/usage-events?cwd=/path/to/project&skillId=reusable-release-checklist&kind=failed&limit=50
GET /skills/usage-stats?cwd=/path/to/project&skillId=reusable-release-checklist
```

Usage events are product telemetry, not authority. They do not mutate active skill
definitions and do not disable, archive, supersede, bind, publish, or delete skills.
Dashboards may window stats by time, but source events remain the rebuildable record
until the workspace retention policy says otherwise.

`POST /skills/:id/corrections` records a structured `user_corrected` event for an
effective skill. This is the manual path for correction telemetry. It can include
optional `candidateId`, `runId`, `teammateId`, and `channelId` references, but it does
not create or update a `SkillCandidate`.

```json
{
  "reason": "The checklist skipped release evidence collection.",
  "candidateId": "skill_candidate_release_checklist",
  "runId": "run_..."
}
```

`GET /procedure-observations` lists bounded structured observations. Optional
`clusterId`, `channelId`, `routeKind`, and `limit` query parameters are supported. `POST
/procedure-observations` persists a structured observation, computes the conservative
candidate route, and returns the observation plus route. The route can be `memory`,
`channel_protocol`, `playbook`, `automation`, `skill`, `approval_policy_review`, or
`reject`.

Observation requests are intentionally structured and bounded. They do not accept raw
transcripts, full prompts, secret values, or artifact bodies.

```json
{
  "source": "explicit_user_request",
  "signals": ["save_as_skill"],
  "title": "Reusable UI verification flow",
  "summary": "Capture the repeated UI verification flow.",
  "normalizedGoal": "verify web ui change",
  "positiveTriggers": ["web ui verification"],
  "negativeTriggers": ["docs-only change"],
  "procedureSteps": [
    { "title": "Run Web typecheck", "instruction": "Run the Web typecheck.", "requiredTools": ["bash"] }
  ],
  "validationSteps": [
    { "title": "Run Playwright smoke", "commandOrCheck": "corepack pnpm --filter @ling-stack/web exec playwright test" }
  ],
  "sourceRefs": [{ "type": "manual", "id": "manual_ui_observation" }],
  "confidence": "high",
  "reusableScore": 85
}
```

`GET /procedure-observation-clusters` returns a read-only governance queue grouped from
existing `ProcedureObservation` rows. It accepts optional `channelId`, `routeKind`,
`status`, and `limit` query parameters. `GET /procedure-observation-clusters/:id` returns
the cluster plus its bounded observations.

Clusters are not destination records. A `ready_for_review` cluster recommends a human
action such as `create_skill_candidate`, `create_channel_protocol_candidate`, or
`create_playbook_candidate`; it does not create that candidate automatically.

```http
GET /procedure-observation-clusters?cwd=/path/to/project&channelId=channel_...&routeKind=playbook&status=ready_for_review&limit=50
GET /procedure-observation-clusters/procedure_cluster_...?cwd=/path/to/project
```

Cluster response:

```json
{
  "cwd": "/path/to/project",
  "clusters": [
    {
      "id": "procedure_cluster_...",
      "workspaceId": "workspace_default",
      "channelId": "channel_...",
      "routeKind": "playbook",
      "status": "ready_for_review",
      "recommendedAction": "create_playbook_candidate",
      "title": "Channel workflow release playbook",
      "summary": "A channel workflow produced a repeatable release playbook.",
      "normalizedGoal": "channel release playbook",
      "observationCount": 2,
      "confidence": "high",
      "reusableScore": 79,
      "positiveTriggers": ["channel release workflow"],
      "negativeTriggers": [],
      "routeBlockers": [],
      "sourceRefs": [{ "type": "run", "id": "run_..." }],
      "firstObservedAt": "2026-06-20T00:00:00.000Z",
      "lastObservedAt": "2026-06-20T00:10:00.000Z"
    }
  ]
}
```

`POST /procedure-observations/jobs` is the daemon-owned explicit observation job entry.
It accepts bounded metadata for a user-confirmed recording, explicit save action, or
structured evidence job. The daemon computes an idempotent `jobKey`, writes a
`ProcedureObservation` first, and only creates a pending skill candidate when the job is
explicitly confirmed, routes to `skill`, has no blockers, and duplicate analysis returns
`no_overlap`. Non-confirmed successful tool chains are evidence-only. The route does not
read raw transcripts or create active skills.

```json
{
  "source": "manual_recording",
  "signals": ["save_as_skill", "user_approved_recording"],
  "runId": "run_...",
  "userConfirmed": true,
  "destinationHint": "skill",
  "title": "Recorded release verification flow",
  "summary": "Capture a user-approved release verification flow.",
  "normalizedGoal": "verify release change",
  "positiveTriggers": ["release verification"],
  "negativeTriggers": ["docs-only release note"],
  "toolLabels": ["bash"],
  "validationLabels": ["release validation passed"]
}
```

`POST /skill-candidates/observe` is the skill-governance compatibility route. It persists
the same `ProcedureObservation`, then creates a pending `SkillCandidate` only when the
router chooses `skill`, no route blockers are present, and duplicate analysis returns
`no_overlap`. Duplicate or conflicting observations record evidence and return
`evidence_recorded`; permission-expanding or unsafe observations return `blocked`.
This route does not publish drafts, bind teammates, or mutate active skills.

`GET /skill-candidates` lists durable candidate records. Optional `status`, `origin`, and
`limit` query parameters are supported. `GET /skill-candidates/:id` returns the candidate
plus review records.

`POST /skill-candidates` creates an explicit manual candidate. The route does not accept
raw transcripts and does not infer candidates from runs. If `duplicateAnalysis` is absent,
the daemon computes duplicate overlap against effective skills before persisting the
candidate.

```json
{
  "title": "Reusable release checklist",
  "summary": "Capture the repeated release checklist as a reviewed candidate skill.",
  "definition": {
    "workflowPhase": "ship",
    "positiveTriggers": ["repeated release checklist"],
    "negativeTriggers": ["one-off release note"],
    "procedureSteps": [
      { "title": "Collect release evidence", "instruction": "Read linked run and approval evidence." }
    ],
    "validationSteps": [
      { "title": "Run skill health", "commandOrCheck": "GET /skills/health" }
    ],
    "requiredTools": ["read"],
    "requiredProviderCapabilities": ["chat"]
  },
  "sourceRefs": [{ "type": "manual", "id": "manual_release_note" }]
}
```

`POST /skill-candidates/:id/review` applies an auditable review action. Public HTTP review
routes force `actor: "user"` even if the request body contains another actor. Review does
not publish into the Skill Registry. `approve_for_draft` is blocked unless the candidate
has negative triggers, validation steps, and no critical safety finding.

```json
{
  "action": "approve_for_draft",
  "reason": "Validated manually."
}
```

`POST /skill-candidates/:id/draft` turns an `approved_for_draft` candidate into a normal
`SkillImportDraft`. It does not publish the draft, bind teammates, or mutate the active
registry. Duplicate decisions that require merge/update/conflict review
(`update_existing`, `conflict_review`, `reject_duplicate`) block draft creation until a
reviewer resolves the overlap. The optional body `{ "content": "..." }` reparses the
user-edited skill content while preserving `packId=ling-generated` and the canonical
`skill-candidates/:id` source path. Publishing that draft marks the candidate as
`published` and records the candidate-to-skill publication link.

Draft-from-candidate response:

```json
{
  "cwd": "/path/to/project",
  "candidate": { "id": "skill_candidate_...", "status": "approved_for_draft" },
  "draft": {
    "id": "skill_draft_...",
    "source": "custom",
    "sourcePath": "skill-candidates/skill_candidate_...",
    "definitions": []
  }
}
```

`POST /skills/refresh` recomputes the effective registry and returns a process-local
`registryGeneration` plus `refreshedAt`. In the current slice this is a lightweight
explicit refresh hook over built-ins and SQLite-backed custom skills; future local
file/plugin scanners should attach to the same endpoint instead of adding client-side
registry guesses.

Refresh response:

```json
{
  "cwd": "/path/to/project",
  "refreshedAt": "2026-06-06T00:00:00.000Z",
  "registryGeneration": 1,
  "skills": []
}
```

`POST /skills/import-draft` accepts Ling-native JSON or markdown/`SKILL.md` content and
returns a reviewed draft. Draft creation does not bind the skill to any teammate and does
not grant tools, approvals, provider capabilities, secrets, memory access, or
external-send permission.

```json
{
  "source": "skill-directory",
  "sourcePath": "SKILL.md",
  "content": "---\nname: Custom QA Review\ndescription: Run a focused QA pass.\n---\n\nReport failures first."
}
```

Draft response:

```json
{
  "cwd": "/path/to/project",
  "draft": {
    "id": "skill_draft_...",
    "source": "skill-directory",
    "definitions": [
      {
        "definition": {
          "id": "custom-qa-review",
          "name": "Custom QA Review",
          "workflowPhase": "operate",
          "requiredTools": ["read", "grep", "find", "ls"],
          "requiredProviderCapabilities": ["chat", "reasoning"],
          "approvalProfile": { "mode": "none" }
        },
        "warnings": []
      }
    ],
    "warnings": []
  },
  "contextFindings": [
    {
      "kind": "missing_or_weak_routing_description",
      "severity": "warning",
      "skillId": "custom-qa-review",
      "title": "Missing or weak routing description",
      "message": "custom-qa-review has a weak routing description.",
      "evidence": [{ "sourceRef": "SKILL.md", "message": "Routing descriptions should identify when the skill should be selected." }],
      "recommendation": "Add a concise trigger-oriented description before relying on automatic routing."
    }
  ]
}
```

Draft optimization preview uses the same draft payload plus optional `mode`. It returns a
preview only; it does not create a draft, publish a skill, create a source snapshot, or
change runtime behavior:

```http
POST /skills/import-draft/optimization-preview?cwd=/path/to/project
```

```json
{
  "source": "skill-directory",
  "sourcePath": "SKILL.md",
  "content": "---\nname: Custom QA Review\ndescription: Run a focused QA pass.\n---\n\nReport failures first.",
  "mode": "preview_on_demand"
}
```

Published source-backed skills can persist a compiled runtime view for later review. The
daemon rebuilds the view from the published source snapshot; callers do not submit
compiled prompt text. These APIs do not affect current run context selection.

```http
GET /skills/:id/compiled-views?cwd=/path/to/project
POST /skills/:id/compiled-views?cwd=/path/to/project
POST /skills/:id/compiled-views/:viewId/archive?cwd=/path/to/project
```

`POST /skills/:id/compiled-views` accepts optional `mode`. It returns `404
skill_source_snapshot_not_found` when the skill has no published source snapshot, which
keeps import-draft previews and source-sync preview rows from becoming persisted runtime
views.

Publishing a draft writes registry definitions and still does not bind them:

```http
POST /skills/import-drafts/skill_draft_.../publish?cwd=/path/to/project
```

New teammate bindings must reference a built-in or published registry skill. Existing
unknown durable bindings can be preserved for legacy visibility, but new unknown binding
ids are rejected.

`DELETE /skills/:id` archives a custom/imported registry skill. Built-in skills are
projected from code and cannot be deleted through this endpoint.

### Channel Memberships

```http
GET /teammates/:id/channels?cwd=/path/to/project
PUT /teammates/:id/channels?cwd=/path/to/project
```

`PUT` replaces the teammate's memberships. When a membership has `isDefault: true`, the
daemon also updates the matching channel's `defaultTeammateId`.

```json
{
  "memberships": [
    { "channelId": "channel_...", "isDefault": true }
  ]
}
```

## AI Councils

AI councils are durable management collections of multiple AI teammates. They are not
super-agents and do not grant tools, MCP access, provider credentials, deployment rights,
external-send rights, or approval bypass. Ling Agent remains the protected system
coordinator and is excluded from normal council membership.

Council governance is restrict-only. `governanceProfile.permissionBoundary` is
`restrict_only`, and approval, tool grant, and credential boundaries are all
`cannot_*`. Council APIs must not be treated as an authority mutation path.

The daemon seeds a built-in `Development Council` with id
`council_builtin_development`. It is available by default but is not attached to every
channel automatically.

```http
GET /ai-councils?cwd=/path/to/project&includeArchived=false&limit=100
POST /ai-councils?cwd=/path/to/project
GET /ai-councils/health?cwd=/path/to/project&limit=100
GET /ai-councils/:id?cwd=/path/to/project
PATCH /ai-councils/:id?cwd=/path/to/project
POST /ai-councils/:id/clone?cwd=/path/to/project
GET /ai-councils/:id/members?cwd=/path/to/project
PUT /ai-councils/:id/members?cwd=/path/to/project
```

`POST /ai-councils` creates a user-owned council. It accepts only metadata, optional
routing policy, optional member references, and `pinned`; it cannot grant authority:

```json
{
  "displayName": "Design Council",
  "description": "Design review and implementation advisors.",
  "routingPolicy": {
    "defaultMode": "advisory",
    "maxActiveMembers": 2
  },
  "members": [
    {
      "teammateId": "teammate_builtin_designer",
      "slotKey": "design",
      "label": "Design",
      "position": 0,
      "enabled": true
    }
  ],
  "pinned": false
}
```

`POST /ai-councils/:id/clone` clones a non-archived council into a user-owned council
and copies member references, not teammate profiles:

```json
{
  "displayName": "Frontend Review Council",
  "description": "A channel-specific clone of Development Council."
}
```

`PATCH /ai-councils/:id` currently accepts `displayName`, `description`, `status`, and
`pinned` for user-owned councils only. Built-in and template councils return
`400 bad_request`; clone them first. Setting `status` to `archived` detaches that
council id from channel council policies without deleting member teammates.

`PUT /members` replaces the council member projection. Members reference durable
teammate ids and may be disabled without deleting the teammate.

```json
{
  "members": [
    {
      "teammateId": "teammate_builtin_engineer",
      "slotKey": "engineer",
      "label": "Engineer",
      "position": 2,
      "enabled": true
    }
  ]
}
```

`GET /ai-councils/health` is read-only and returns a shared Web/Desktop health report:

```json
{
  "report": {
    "workspaceId": "workspace_default",
    "generatedAt": "2026-06-21T00:00:00.000Z",
    "summary": {
      "totalCouncils": 1,
      "activeCouncils": 1,
      "totalMembers": 8,
      "availableMembers": 7,
      "blockedMembers": 1,
      "findings": { "info": 1, "warning": 0, "critical": 0 }
    },
    "findings": [
      {
        "kind": "member_disabled",
        "severity": "info",
        "councilId": "council_builtin_development",
        "teammateId": "teammate_builtin_engineer",
        "title": "Council member is disabled"
      }
    ]
  }
}
```

First-slice finding kinds are deterministic membership/governance issues:
`council_not_active`, `council_empty`, `council_no_available_members`,
`member_disabled`, `teammate_missing`, `teammate_not_active`, `teammate_hidden`, and
`system_teammate_excluded`.

Channels attach councils by reference through a channel council policy. This does not
copy council members into `teammate_channel_memberships`.

```http
GET /channels/:id/council-policy?cwd=/path/to/project
PUT /channels/:id/council-policy?cwd=/path/to/project
GET /channels/:id/effective-council?cwd=/path/to/project
```

Default channel policy has no attached councils:

```json
{
  "attachedCouncilIds": [],
  "preferredCouncilId": null
}
```

Attach the built-in development council:

```json
{
  "attachedCouncilIds": ["council_builtin_development"],
  "preferredCouncilId": "council_builtin_development"
}
```

Council create/clone/update, channel council policy, and member replacement requests
accept only their documented fields. Unknown fields return `400 bad_request`, including
`allowedTools`, `approvalProfile`, `credentialRef`, `runtimePolicy`, provider ids, or
teammate permissions. These endpoints do not mutate the referenced teammate's own tools,
provider, runner, or approval profile.

`GET /channels/:id/effective-council` returns a stable projection for Web and desktop
clients: the channel policy, attached active councils, effective member health, and the
merged specialist roster from direct teammate memberships plus attached councils.

### Skill Bindings

```http
GET /teammates/:id/skills?cwd=/path/to/project
PUT /teammates/:id/skills?cwd=/path/to/project
```

Skill bindings are durable metadata. They do not grant execution authority by themselves;
runs still pass through provider capability checks, allowed tools, approval policy, and
state-machine gates. Disabled bindings are retained as user overrides, so a template skill
can be turned off without deleting the skill definition from the workspace library.
Template-default bindings are protected by storage: omitting them from a replacement
request does not delete them. Manually added `source: "user"` bindings can be deleted by
omitting them from the replacement set. The `GET` response includes `effectiveSkills`
when the daemon can compute current executability.

```json
{
  "bindings": [
    { "skillId": "implement", "source": "template", "enabled": true }
  ]
}
```

### Memory Scopes

```http
GET /teammates/:id/memory-scopes?cwd=/path/to/project
PUT /teammates/:id/memory-scopes?cwd=/path/to/project
```

Memory scopes are visible trust-boundary metadata and are always provisioned for every AI
teammate. Each teammate gets private `private-chat-summary` and `private-notes` scopes by
default; each channel membership adds that teammate's own `channel-brief` and
`channel-decisions` scopes for that channel. There is no supported off switch.
`enabled:false` is rejected, and Ling Agent scopes are protected system memory.

```json
{
  "scopes": [
    { "kind": "private-chat-summary", "enabled": true },
    { "kind": "private-notes", "enabled": true },
    { "kind": "channel-brief", "channelId": "channel_...", "enabled": true },
    { "kind": "channel-decisions", "channelId": "channel_...", "enabled": true }
  ]
}
```

Supported scope kinds:

```text
channel-brief, channel-decisions, private-chat-summary, private-notes
```

### Ling Memory

```http
GET /memory?cwd=/path/to/project
POST /memory?cwd=/path/to/project
PATCH /memory/:id?cwd=/path/to/project
GET /memory/consolidation-jobs?cwd=/path/to/project
POST /memory/consolidation-jobs?cwd=/path/to/project
POST /memory/recall?cwd=/path/to/project
GET /memory/used?cwd=/path/to/project
GET /memory/review-policy?cwd=/path/to/project
PATCH /memory/review-policy?cwd=/path/to/project
GET /memory/promotion-inbox?cwd=/path/to/project
POST /memory/:id/review?cwd=/path/to/project
```

Manual memory created through `POST /memory` may still default to active. Extracted
or reflected memory should create candidates and then use the review policy and
promotion inbox before active/shared/persona recall.

`POST /memory/consolidation-jobs` is an explicit trigger, not an automatic daemon
startup scheduler. It creates a durable job record, runs the memory review classifier,
creates a candidate memory, records the review decision, and returns the created
candidate. Even if the classifier would otherwise return `auto-active`, consolidation
jobs store the output as `auto-candidate` with `reasonCode:
"consolidation_candidate_only"`.

```json
{
  "kind": "task_run_lesson",
  "sourceScopeType": "channel",
  "confidence": "high",
  "candidate": {
    "scopeType": "channel",
    "ownerId": "channel_...",
    "title": "Consolidated run lesson",
    "body": "When Model Workbench width regresses, check the workspace frame before editing cards.",
    "tags": ["model-workbench"],
    "sourceRefs": [
      { "type": "run-event", "id": "run_event_...", "label": "Run succeeded" }
    ]
  }
}
```

Review policy modes are `conservative`, `balanced`, and `fast`; the default is
`balanced`. Candidate and disabled memories are not returned by default recall.
`POST /memory/:id/review` accepts actions:

```text
approve, edit_and_approve, keep_candidate, reject, archive, quarantine
```

For `edit_and_approve`, pass changed memory fields under `editedMemory`:

```json
{
  "action": "edit_and_approve",
  "editedMemory": {
    "title": "Provider routing order",
    "body": "Provider routing resolves teammate, explicit run, channel default, then workspace selected.",
    "scopeType": "workspace",
    "ownerId": "workspace_default",
    "sensitivity": "normal"
  },
  "reason": "Stable workspace rule confirmed by user."
}
```

### Governance Notifications

```http
GET /governance-notifications?cwd=/path/to/project
GET /governance-notifications/summary?cwd=/path/to/project
POST /governance-notifications/:id/seen?cwd=/path/to/project
POST /governance-notifications/:id/dismiss?cwd=/path/to/project
```

Governance notifications are durable projections over authoritative review queues.
They do not replace memory, skill, protocol, playbook, approval, or workflow source
records. Dismissal hides the reminder only; source review state stays in its own API.

Optional list filters:

```text
surface=channel|teammate_direct|ling_agent|workspace
channelId=channel_...
teammateId=teammate_...
threadId=thread_...
kind=memory_candidate|memory_health_finding|skill_candidate|procedure_cluster|channel_protocol_candidate|channel_playbook_candidate|workflow_fanin
status=unread|seen|dismissed|resolved
includeResolved=true|false
includeDismissed=true|false
limit=1..500
```

Surface semantics:

- `channel` is a channel-header notification projection. It never writes ordinary
  notification rows into `conversation_items`.
- `teammate_direct` is a single teammate private-thread projection. Delivery is quiet
  window gated and writes a short direct `system` message only after the thread is idle.
- `ling_agent` is for workspace or cross-owner review pressure with no safer local
  owner. Delivery writes one bounded Ling Agent private `system` digest per flush, not
  one chat row per source record.
- `workspace` is reserved for a future workspace notification center; first clients
  should read the daemon list/summary APIs rather than SQLite directly.

The first implementation slice creates memory candidate notifications when candidate
memory is created through `POST /memory`, `POST /memory/import`, or
`POST /memory/consolidation-jobs`, and marks those notifications resolved after terminal
memory review actions. Notification summaries deliberately omit memory bodies and raw
transcript text. Channel-scoped memory candidates use the channel surface, teammate
memory candidates use the teammate direct surface, and workspace-scoped memory candidates
use the Ling Agent digest surface.

### Private Thread And Messages

```http
GET /teammates/:id/direct-thread?cwd=/path/to/project
GET /teammates/:id/direct-messages?cwd=/path/to/project&limit=100
POST /teammates/:id/direct-messages?cwd=/path/to/project
POST /teammates/:id/direct-messages/stream?cwd=/path/to/project
```

`direct-thread` creates the one-to-one teammate thread if it does not exist. Private
messages are durable. `POST` persists the local-user message before provider resolution;
if the teammate is paused, disabled, missing a provider, or the provider cannot run, the
daemon stores a blocked AI reply instead of dropping the user message.

```json
{
  "body": "Can you help refine this task?",
  "attachmentIds": ["tpatt_..."],
  "requestAiReply": true,
  "providerPresetId": "provider_..."
}
```

Response:

```json
{
  "message": {
    "id": "tdmsg_...",
    "authorType": "local-user",
    "attachmentIds": ["tpatt_..."],
    "status": "ready"
  },
  "aiReply": {
    "id": "tdmsg_...",
    "authorType": "ai-teammate",
    "status": "blocked",
    "errorMessage": "No provider preset is selected for this teammate."
  }
}
```

Private chat uses no tools and does not include channel messages, files, memory objects, or
web content unless a future explicit prompt-inclusion model adds that behavior. The
teammate's default memory scopes still exist and remain inspectable.

`POST /direct-messages/stream` uses the same request body and returns
`text/event-stream`. The daemon first persists the local-user message, then creates a
pending AI reply and updates that same record as deltas arrive.

SSE events:

```text
ready
delta
done
blocked
error
```

Event payload shapes:

```json
{ "message": { "id": "tdmsg_user_..." }, "aiReply": { "id": "tdmsg_ai_...", "status": "pending" } }
```

```json
{ "messageId": "tdmsg_ai_...", "delta": "partial text", "body": "full text so far" }
```

```json
{ "message": { "id": "tdmsg_user_..." }, "aiReply": { "id": "tdmsg_ai_...", "status": "ready" } }
```

Provider preflight failures emit `blocked`; provider/runtime errors emit `error` and the
AI reply is stored as `failed` when one exists. Client aborts stop streaming and abort the
provider request; already persisted messages remain durable.

### Private Attachments And Avatar

Private attachments share the same file root and validation policy as channel
attachments, but are scoped to a teammate private thread or teammate profile avatar.

```http
GET /teammates/:id/direct-attachments?cwd=/path/to/project&limit=100
POST /teammates/:id/direct-attachments?cwd=/path/to/project
POST /teammates/:id/avatar?cwd=/path/to/project
DELETE /teammates/:id/avatar?cwd=/path/to/project
GET /attachments/:id/content?cwd=/path/to/project
DELETE /attachments/:id?cwd=/path/to/project
```

`POST /direct-attachments` accepts JSON with base64 content:

```json
{
  "fileName": "notes.md",
  "contentType": "text/markdown",
  "contentBase64": "IyBOb3Rlcw=="
}
```

Response:

```json
{
  "attachment": {
    "id": "tpatt_...",
    "teammateId": "teammate_...",
    "threadId": "tdthread_...",
    "scope": "teammate_direct_thread",
    "fileName": "notes.md",
    "contentType": "text/markdown",
    "sizeBytes": 7
  }
}
```

`GET /direct-attachments` lists only `teammate_direct_thread` attachments for that
teammate's private thread. A private direct message can reference at most 10
`attachmentIds`, and every id must belong to the same teammate private thread.

`POST /avatar` stores a `teammate_profile_avatar` attachment, sets
`avatarImageAttachmentId` on the teammate, and deletes the previous avatar file if it is
being replaced. `DELETE /avatar` clears the field and deletes the avatar attachment bytes.
Avatar upload uses the image subset of the same attachment validation policy.

`GET /attachments/:id/content` and `DELETE /attachments/:id` resolve both channel
attachments and teammate private attachments. Deleting a private avatar attachment also
clears the owning teammate's avatar reference.

Private attachments are user-provided context only. They do not automatically enter
memory and are not automatically provided to AI; future AI file inclusion must use an
explicit, auditable path.

### Teammate Read Models

```http
GET /teammates/:id/tasks?cwd=/path/to/project&status=todo&limit=100
GET /teammates/:id/activity?cwd=/path/to/project&limit=100
```

`tasks` returns tasks assigned through `assigneeTeammateId`. `activity` composes private
messages, assigned tasks, teammate runs, approvals attached to teammate runs, and channel
messages that mention the teammate.

## Channel Conversation Items, Turns, Attachments, and Links

Channel discussion is durable in the workspace SQLite database. Uploaded files are stored under:

```text
.ling-stack/attachments
```

### Conversation Items And Turns

```http
GET /channels/:id/items?cwd=/path/to/project&limit=100&beforeSequence=123
GET /channels/:id/items?cwd=/path/to/project&threadId=thread_...
GET /channels/:id/items?cwd=/path/to/project&anchorItemId=item_...
POST /channels/:id/turns?cwd=/path/to/project
POST /channels/:id/turns/stream?cwd=/path/to/project
```

`conversation_items` is the only Channel timeline authority. `GET /items` returns the
resolved `LingThread`, owning `LingTurn` records, ordered canonical items, and discardable
presentation decorations. Pagination uses the stable per-Thread `sequence` cursor.

The read surface is explicit:

- no selector selects Channel Root;
- `threadId` is a canonical `LingThread.id` for Root, Topic, or Branch reads;
- `anchorItemId` materializes or reuses a Topic from a committed item;
- both selectors together return `400 bad_request`.

`POST /turns` accepts one local user turn plus structured mentions, attachment ids, link
preview ids, file refs, optional reply supervision, and optional `requestAiReply`.
Referenced attachments and link previews must belong to the same channel. The user item
and owning `LingTurn` are committed atomically. If no provider is ready, the accepted user
item remains durable and any requested assistant item becomes blocked.

```json
{
  "surface": { "kind": "thread", "threadId": "thread_..." },
  "body": "请 @Engineer 完善需求",
  "mentions": [{ "id": "engineer", "label": "Engineer", "kind": "ai-teammate" }],
  "attachmentIds": ["att_..."],
  "linkPreviewIds": ["link_..."],
  "requestAiReply": true,
  "replyDisposition": { "mode": "queue_followup", "activeRunId": "run_..." },
  "providerPresetId": "provider_...",
  "teammateId": "engineer"
}
```

`surface` is one of `{ "kind": "channel_root" }`,
`{ "kind": "thread", "threadId": "..." }`, or
`{ "kind": "topic", "anchorItemId": "..." }`. Omission selects Channel Root. The Turn
request has no top-level `threadId` compatibility alias.

`POST /turns/stream` uses the same body and returns `text/event-stream`. It persists the
user Item and Turn, creates durable pending assistant Items, and streams visible text into
those same Items.
The Web normally sends mentions and `requestAiReply` without a duplicate `teammateId`;
the daemon resolves no mention to `ling_agent`, one mention to that teammate, and multiple
mentions back to `ling_agent`.

Channel reply supervision is scoped to a conversation line: Root, a Branch root, a message-keyed
Topic, or an explicit Thread. The Web sends `replyDisposition.mode = "queue_followup"` only when
the message is structurally related to an active reply. With `activeRunId`, the daemon accepts the
disposition only when that exact active `channel_ai_reply` Run belongs to the same channel and
conversation line. Without `activeRunId`, the request may follow only a process-local predecessor
whose reply Run has not linked yet; it never scans for an arbitrary active Run. A missing, stale,
terminal, cross-channel, or cross-line target falls back to normal intent routing.

When accepted, the response contains `replyDispatch.disposition = "followup_queued"`. The daemon,
not the public Run-intervention request body, writes the intervention's channel lineage fields
`sourceMessageId` and `targetTeammateId`. Continuations resolve the target's current channel model
binding when their FIFO item starts. `RunSession.threadId` remains the canonical LingThread id;
`ConversationActiveReplyTarget.sourceMessageId` identifies the source ConversationItem used for
Root, Branch, and Topic projection. `GET /channels/:id/items` excludes queued source Items until
their intervention has `startedAt`. It also excludes a source Item while dispatch classification
is in flight between message persistence and the authoritative `reply_pending` or
`followup_queued` state, preventing concurrent refresh from briefly exposing a queued message.

SSE events:

- `ready`: `{ "thread": LingThread, "turn": LingTurn, "userItem": ConversationItem, "assistantItems"?: ConversationItem[], "decorations": [] }`
- `reply_pending`: `{ "sourceItemId": string, "targetTeammateId": string, "startedAt": string }`
- `run_linked`: `{ "itemId": string, "linkedRunId": string, "activeReply"?: ConversationActiveReplyTarget }`
- `delta`: `{ "itemId": string, "delta": string, "body": string }`
- `done`: `ChannelConversationTurnResponse`
- `blocked`: `ChannelConversationTurnResponse & { "error"?: string }`
- `error`: partial Turn response plus `{ "error": string }`

Hidden `<ling_task_proposal>` blocks are not streamed as visible deltas. The daemon
continues to extract and persist proposals through the channel proposal pipeline.

### Attachments

```http
GET /channels/:id/attachments?cwd=/path/to/project&limit=100
POST /channels/:id/attachments?cwd=/path/to/project
GET /attachments/:id/content?cwd=/path/to/project
DELETE /attachments/:id?cwd=/path/to/project
```

The shared content and delete routes resolve both channel attachments and private
teammate attachments. Channel upload/list routes only manage channel-scoped
attachments.

`POST` uses JSON with base64 content:

```json
{
  "fileName": "brief.pdf",
  "contentType": "application/pdf",
  "contentBase64": "JVBERi0x..."
}
```

`contentType` is accepted as an upload hint, but the daemon serves downloads with a content type derived from the validated extension. MVP limits: 25MB per file, at most 10 attachment ids per message, allowed extensions are `png`, `jpg`, `jpeg`, `webp`, `gif`, `pdf`, `docx`, `xlsx`, `pptx`, `txt`, `md`, `csv`, `json`, and `log`. Attachments are metadata and downloadable inputs only; AI ingestion is not automatic.

### Link Previews

```http
GET /channels/:id/link-previews?cwd=/path/to/project&limit=100
POST /channels/:id/link-previews?cwd=/path/to/project
POST /link-previews/:id/refresh?cwd=/path/to/project
```

The daemon fetches public HTML metadata only: title, description, image URL, and site name. It does not send cookies, credentials, page bodies, or extracted content to AI. Preview fetches block localhost, private, link-local, and metadata-network addresses, enforce redirect/timeout/body-size limits, and store failed or blocked previews as visible records.

## Channel Collaboration Protocol

v1.1 adds durable protocol records for channel coordination. These endpoints only record
state; they do not start runs, call an AI provider, mutate task/run status, or bypass
approval/runtime locks.

```http
GET /channels/:id/brief?cwd=/path/to/project
PATCH /channels/:id/brief?cwd=/path/to/project

GET /channels/:id/decisions?cwd=/path/to/project&status=active&limit=100
POST /channels/:id/decisions?cwd=/path/to/project
PATCH /decisions/:id?cwd=/path/to/project

GET /channels/:id/handoffs?cwd=/path/to/project&status=proposed&limit=100
POST /channels/:id/handoffs?cwd=/path/to/project
PATCH /handoffs/:id?cwd=/path/to/project

GET /channels/:id/context-summaries?cwd=/path/to/project&targetType=task&targetId=task_...&limit=100
POST /channels/:id/context-summaries?cwd=/path/to/project
PATCH /context-summaries/:id?cwd=/path/to/project

GET /channels/:id/protocol?cwd=/path/to/project
GET /channels/:id/protocol/canvas?cwd=/path/to/project&limit=50
PATCH /channels/:id/protocol?cwd=/path/to/project
POST /channels/:id/protocol/revert?cwd=/path/to/project
GET /channels/:id/protocol/drafts?cwd=/path/to/project&status=draft&limit=50
POST /channels/:id/protocol/drafts?cwd=/path/to/project
POST /channels/:id/protocol/drafts/:draftId/apply?cwd=/path/to/project
GET /channels/:id/protocol-candidates?cwd=/path/to/project&status=draft&limit=50
POST /channels/:id/protocol-candidates?cwd=/path/to/project
POST /channels/:id/protocol-candidates/from-cluster/:clusterId?cwd=/path/to/project
POST /channels/:id/protocol-candidates/:candidateId/review?cwd=/path/to/project
GET /channels/:id/playbook-candidates?cwd=/path/to/project&status=draft&limit=50
POST /channels/:id/playbook-candidates/from-cluster/:clusterId?cwd=/path/to/project
POST /channels/:id/playbook-candidates/:candidateId/review?cwd=/path/to/project
```

Brief `GET` returns an empty Brief-shaped record when no Brief has been saved yet.
Brief `PATCH` is a full replacement for objective, scope, criteria, questions, risks,
and linked source ids.

Decision `POST` creates an `active` decision by default. If `supersedesDecisionId` is
provided, the daemon marks the old decision `superseded` and creates a new active
decision. Decision `PATCH` can update text fields or set `status` to `active`,
`superseded`, or `rejected`.

Handoff `POST` records a manual from/to participant transfer with reason, required input,
expected output, and status. Handoff `PATCH` only updates the handoff record; completing a
handoff does not mark a task done.

Context summaries target either `task` or `thread`. `task` targets must reference a task in
the same channel. `thread` targets must reference a channel message id or an existing
message thread id in the same channel.

All source ids are channel-scoped. Unknown or cross-channel source references return a
displayable `400` error. Missing channels return `404 channel_not_found`.

`GET /channels/:id/protocol` returns the effective channel collaboration protocol:
channel settings, workspace defaults, and protocol-only overrides resolved into one
read model. `PATCH /channels/:id/protocol` edits channel-backed fields only:
`responseLanguage`, `autoReplyMode`, and `defaultTeammateId`.

`GET /channels/:id/protocol/canvas` returns the effective protocol plus the channel
canvas governance view: draft protocol candidates, channel-scoped `channel_protocol` and
`playbook` observation clusters, and compact section summaries. It is read-only and does
not create drafts, apply protocols, publish skills, or grant authority.

Protocol-only fields use draft review before activation: `defaultWorkflowPreference`,
`visibleMultiReplyMaxParticipants`, `privacyRules`, and `reviewRules`.
`POST /channels/:id/protocol/drafts` creates a draft with `sourceRefs` and does not
change the active protocol. Applying a draft validates base version and channel-scoped
source refs, then writes the protocol override.

`/channels/:id/protocol-candidates` is a governance alias over protocol drafts for the
Skill Candidate and channel canvas module. Creating a candidate is equivalent to creating
a protocol draft. Reviewing with `{"action":"approve"}` applies the draft; reviewing with
`{"action":"reject"}` cancels it. Protocol candidates never grant tools, approvals,
provider access, secrets, external-send authority, or workflow execution.

`POST /channels/:id/protocol-candidates/from-cluster/:clusterId` manually converts a
`ready_for_review` `ProcedureObservationCluster` into a draft protocol candidate. The
cluster must belong to the channel, have `routeKind: "channel_protocol"`, and have no
route blockers. If `proposedPatch` is omitted, the daemon creates one review rule from
the cluster title, summary, and positive triggers. `playbook`, `skill`, `memory`,
`automation`, blocked, and cross-channel clusters return displayable `400` errors and do
not create protocol candidates. This route is manual and does not enable automatic
post-run or transcript-derived candidate creation.

`/channels/:id/playbook-candidates` is a channel-local governance queue for operating
procedures observed from channel workflow output. `POST
/channels/:id/playbook-candidates/from-cluster/:clusterId` manually converts a
same-channel `ready_for_review` cluster with `routeKind: "playbook"` into a playbook
candidate. The daemon reads procedure and validation steps from the underlying
observations in that cluster; the cluster itself remains a compact review summary.
If the channel already has a `draft` or `active` playbook candidate with the same
`normalizedGoal` or overlapping source refs, the daemon returns that candidate instead of
creating a duplicate.
Reviewing with `{"action":"approve"}` marks the candidate `active`; reviewing with
`{"action":"reject"}` marks it `cancelled`. This does not create a global Skill, does
not write Memory, does not grant tools or approvals, and does not enable automatic
runtime invocation. `channel_protocol`, `skill`, `memory`, blocked, and cross-channel
clusters return displayable `400` errors.

## Channel Handoff Workflows

v1.2 upgrades handoffs into explicit, user-started workflow records. Workflow mutations
record coordination state and never bypass task/run state machines, provider preflight,
approval policy, or runtime leases.

```http
GET /channels/:id/workflows?cwd=/path/to/project&status=running&limit=100
POST /channels/:id/workflows?cwd=/path/to/project
GET /workflows/:id?cwd=/path/to/project
PATCH /workflows/:id?cwd=/path/to/project
POST /handoffs/:id/workflow?cwd=/path/to/project

GET /workflows/:id/steps?cwd=/path/to/project&status=queued&limit=100
POST /workflows/:id/steps?cwd=/path/to/project
PATCH /workflow-steps/:id?cwd=/path/to/project
POST /workflow-steps/:id/start?cwd=/path/to/project
```

Workflow statuses are `draft`, `ready`, `running`, `waiting_for_approval`, `blocked`,
`succeeded`, `failed`, and `cancelled`. Step statuses are `queued`, `claimed`,
`running`, `waiting_for_approval`, `blocked`, `succeeded`, `failed`, `skipped`, and
`cancelled`.

`POST /handoffs/:id/workflow` creates a draft `ChannelWorkflow` and first queued
`ChannelWorkflowStep` from the handoff. It does not start execution.

`POST /channels/:id/workflows` accepts exactly one of `templateId`, `customTemplate`,
`customTemplateId`, or `workflowGraph`. Custom template steps and workflow graph nodes may
use `councilSlotKey` instead of `teammateId`/`teammateTemplateId`; the daemon resolves the
slot through the channel's effective AI council, stores the resolved teammate on the step,
and persists `metadata.councilSlotKey` plus `metadata.proposalStepSources` as source
evidence. Built-in templates use `councilSlotKey` first and fall back to their legacy
`teammateTemplateId` when the channel has no matching active council member.

`POST /workflow-steps/:id/start` accepts:

```json
{
  "mode": "create_task",
  "providerPresetId": "provider_...",
  "assigneeTeammateId": "engineer",
  "idempotencyKey": "client-generated-key"
}
```

`create_task` creates a channel task from the step context, links it to the step, marks
the step succeeded, and returns JSON with `workflow`, `workflowStep`, and `task`.

`create_and_run_task` creates the task and then delegates to the existing run
coordinator. When a run starts, the response is the same POST/SSE stream used by
`POST /runs`; the step is updated with the linked task/run after the coordinator
finishes. If provider readiness, channel status, or runtime state blocks execution before
a run starts, the route returns JSON with `workflow`, `workflowStep`, and `blocker`.

Starting a step acquires a `workflow_step` lease. Duplicate starts return
`409 resource_conflict` while the lease is active. Step `skip` and `cancel` only mutate
workflow-step state; they do not mark linked task/run records terminal.

## External Work

Phase 1 adds a read-only GitHub manual import path. Phase 2 adds manual read-only
GitHub polling and local scheduler reconciliation. Phase 3 adds approval-gated action
records for GitHub comments and labels. Phase 4 adds manual GitHub CI triage for
existing PR external-work items: it reads failing checks, workflow jobs, and bounded
redacted logs, then creates local evidence and fix tasks by default. Phase 4.1 adds a
separate explicit SSE endpoint to start the linked local fix task through the normal
task/run path; it still does not mutate GitHub. Phase 5 adds strict approval-gated PR
review actions. Propose, list, show, and cancel remain local only; the explicit execute
endpoint is the only path that can call allowed GitHub mutation APIs after approval and
stale-target revalidation. Phase 6 adds explicitly registered GitHub background
polling and reconciliation; background ticks reuse the read-only poll/reconcile paths
and still do not start runners or execute GitHub mutations. Phase 7 adds Linear as a
second read-only source adapter for manual import and poll. Linear operations create or
reuse local Ling records and evidence only; they do not start runners, propose hidden
actions, or call Linear mutation APIs.
Import parses a repository
`WORKFLOW.md`, normalizes a GitHub PR or issue payload, creates or reuses a
`ChannelWorkflow` and `ChannelWorkflowStep`, and writes local evidence artifacts. It
does not start a runner, receive webhooks, post comments, add labels, request reviews,
push commits, close issues, or merge. Polling only uses GitHub `GET` endpoints.

Setup/status surface: Web Settings and CLI use the local-only status endpoint to show
workflow file health, source target, status-only token readiness, local external-work
counts, CI triage counts, action counts, and background scheduler state without calling
GitHub, Linear, hooks, runners, or mutation APIs. The design is in
[External Work Status Surface](design/external-work-status-surface.md).
Web Settings also exposes explicit local workflow setup plus Keychain token setup and
removal. Workflow setup writes or repairs a minimal channel-bound `WORKFLOW.md` from a
user-entered GitHub repository or Linear project slug; token setup only writes/deletes
local Keychain entries and may update `WORKFLOW.md` to point at a `keychain:` ref. None
of these setup endpoints call GitHub or Linear.

### Show External Work Status

```http
GET /external-work/status?cwd=/path/to/project&channelId=channel_...&workflowPath=WORKFLOW.md
```

`channelId` is required. `workflowPath` is optional and defaults to `WORKFLOW.md` under
the channel bound path. If supplied, it must resolve inside the channel bound path.
Missing or invalid workflow files return `200` with `workflow.exists`, `workflow.valid`,
and `workflow.error` set so Settings can still render setup guidance. Missing channels
return `404`; missing `channelId` or out-of-bounds paths return `400`.

Response:

```json
{
  "cwd": "/path/to/project",
  "channel": {
    "id": "channel_...",
    "name": "Engineering",
    "boundPath": "/path/to/project"
  },
  "workflow": {
    "path": "/path/to/project/WORKFLOW.md",
    "exists": true,
    "valid": true,
    "sourceKind": "github",
    "repository": "owner/repo",
    "events": ["pull_request.opened"],
    "secretRef": "env:GITHUB_TOKEN"
  },
  "secret": {
    "ref": "env:GITHUB_TOKEN",
    "purpose": "github_token",
    "status": "configured"
  },
  "records": {
    "externalWork": { "total": 0, "ready": 0, "blocked": 0, "retryWait": 0, "terminal": 0 },
    "ciTriage": { "total": 0, "triaged": 0, "taskCreated": 0, "runRequested": 0, "blocked": 0, "stale": 0, "failed": 0 },
    "actions": { "total": 0, "waitingForApproval": 0, "approved": 0, "failed": 0, "succeeded": 0, "cancelled": 0, "staleTarget": 0 }
  },
  "background": {
    "supported": true,
    "running": false,
    "status": "not_configured"
  },
  "lastErrors": {}
}
```

SDK clients can use:

```ts
await client.getExternalWorkStatus("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
});
```

CLI:

```bash
ling-stack external-work status --channel channel_... --workflow-path WORKFLOW.md
```

### Configure External Work Workflow

```http
POST /external-work/workflow/configure?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "sourceKind": "github",
  "repository": "owner/repo"
}
```

For GitHub, `repository` accepts either `owner/repo` or a GitHub URL such as
`https://github.com/owner/repo`; the daemon stores the normalized `owner/repo` value in
`WORKFLOW.md`. For Linear, send `"sourceKind": "linear"` and `projectSlug` instead of
`repository`. `workflowPath` defaults to `WORKFLOW.md` under the channel bound path and
must stay inside that bound path. If the file is missing or invalid, the daemon writes a
minimal local workflow with safe default events and prompt text. If the existing
workflow is already valid, the endpoint is a no-op and returns the current workflow
summary.

This endpoint is local-only: it writes `WORKFLOW.md` but does not call GitHub, Linear,
hooks, runners, polling, reconciliation, or mutation APIs.

Response:

```json
{
  "cwd": "/path/to/project",
  "channelId": "channel_...",
  "sourceKind": "github",
  "workflow": {
    "path": "/path/to/project/WORKFLOW.md",
    "exists": true,
    "valid": true,
    "sourceKind": "github",
    "repository": "owner/repo",
    "events": ["pull_request.opened", "pull_request.synchronize", "issue.opened"]
  },
  "workflowCreated": true,
  "workflowUpdated": true
}
```

SDK:

```ts
await client.configureExternalWorkWorkflow("/path/to/project", {
  channelId: "channel_...",
  sourceKind: "github",
  repository: "owner/repo",
});
```

### Configure External Work Secret

```http
POST /external-work/secrets/configure?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "token": "<github-token>",
  "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  "updateWorkflow": true
}
```

`channelId` and `token` are required. `workflowPath` defaults to `WORKFLOW.md` under
the channel bound path and must stay inside that bound path. `secretRef` is optional; if
omitted, the daemon derives a stable `keychain:LING_STACK_GITHUB_<OWNER>_<REPO>_TOKEN`
or `keychain:LING_STACK_LINEAR_<PROJECT>_TOKEN` ref from the workflow source. Web setup
accepts only `keychain:` refs. `env:` remains supported for manual status/polling, but
cannot be written or removed from Web Settings.

When `updateWorkflow` is not `false`, the daemon updates only `source.secretRef` in the
workflow front matter. The token value is sent once to the daemon, saved in macOS
Keychain, and never returned in the response.

Response:

```json
{
  "cwd": "/path/to/project",
  "channelId": "channel_...",
  "sourceKind": "github",
  "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
  "secret": {
    "ref": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN",
    "purpose": "github_token",
    "status": "configured"
  },
  "workflow": {
    "path": "/path/to/project/WORKFLOW.md",
    "exists": true,
    "valid": true,
    "sourceKind": "github",
    "repository": "owner/repo",
    "events": ["pull_request.opened"],
    "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN"
  },
  "workflowUpdated": true
}
```

SDK:

```ts
await client.configureExternalWorkSecret("/path/to/project", {
  channelId: "channel_...",
  token: "<github-token>",
});
```

### Delete External Work Secret

```http
POST /external-work/secrets/delete?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "secretRef": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN"
}
```

`secretRef` is optional and defaults to the current workflow `source.secretRef`. Only
`keychain:` refs can be removed through this endpoint. The daemon deletes the local
Keychain item and leaves `WORKFLOW.md` unchanged so the UI can still show which ref is
missing.

SDK:

```ts
await client.deleteExternalWorkSecret("/path/to/project", {
  channelId: "channel_...",
});
```

```http
POST /external-work/github/import?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "eventType": "pull_request.opened",
  "payload": {
    "repository": { "full_name": "owner/repo" },
    "pull_request": { "number": 123, "title": "Fix bug" }
  },
  "workflowPath": "WORKFLOW.md"
}
```

`workflowMarkdown` may be supplied instead of `workflowPath` for tests and manual
imports. If neither is supplied, the daemon reads `WORKFLOW.md` from the channel
`boundPath`. `workflowPath` may be absolute or relative, but it must resolve inside the
channel `boundPath`.

Response:

```json
{
  "externalWorkItem": {
    "sourceKind": "github",
    "kind": "github_pull_request",
    "identifier": "owner/repo#123",
    "idempotencyKey": "github:pull_request:owner/repo:123:head-sha:updated-at"
  },
  "workflow": {},
  "workflowStep": {},
  "artifacts": [],
  "duplicate": false
}
```

The same source idempotency key returns the existing workflow and step with
`duplicate: true`. Evidence artifacts currently include the normalized external work
item JSON and rendered workflow prompt markdown, both served through the existing
artifact endpoints.

### Poll GitHub

```http
POST /external-work/github/poll?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false
}
```

The daemon reads the channel-bound `WORKFLOW.md`, resolves `source.secretRef` through
the existing secret resolver when present, calls GitHub read-only PR/issue list
endpoints, claims source and subject leases, creates or reuses local workflow records,
and writes scheduler state in the same SQLite workspace store. `executeHooks` defaults
to `false`; when true, only `afterCreate` and `beforeRun` run inside the isolated
external workspace with hook evidence artifacts.

For reproducible live polling, prefer `source.secretRef: env:GITHUB_TOKEN` and start
the daemon with `GITHUB_TOKEN` in its environment. Unauthenticated GitHub reads can hit
low API rate limits before the smoke path finishes.

Response:

```json
{
  "candidates": 1,
  "claimed": 1,
  "duplicates": 0,
  "blocked": 0,
  "retryScheduled": 0,
  "terminalIgnored": 0,
  "artifacts": [],
  "results": [],
  "schedulerStates": []
}
```

### Import Linear

```http
POST /external-work/linear/import?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "eventType": "issue.created",
  "payload": {
    "id": "linear-issue-123",
    "identifier": "LIN-123",
    "title": "Wire Linear external work",
    "state": { "name": "Todo" },
    "project": { "slug": "ling-stack" }
  },
  "workflowPath": "WORKFLOW.md"
}
```

The parsed `WORKFLOW.md` must use `source.kind: linear` and must include
`source.projectSlug`. `workflowMarkdown` may be supplied instead of `workflowPath` for
tests and fixtures. The endpoint normalizes a `linear_issue`, creates or reuses the same
local workflow and workflow-step records used by GitHub external work, and writes the
normalized item plus rendered prompt artifacts.

Response:

```json
{
  "externalWorkItem": {
    "sourceKind": "linear",
    "kind": "linear_issue",
    "identifier": "LIN-123",
    "idempotencyKey": "linear:issue:ling-stack:LIN-123:2026-06-01T00:00:00.000Z"
  },
  "workflow": {},
  "workflowStep": {},
  "artifacts": [],
  "duplicate": false
}
```

### Poll Linear

```http
POST /external-work/linear/poll?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false
}
```

The daemon reads the channel-bound Linear `WORKFLOW.md`, resolves `source.secretRef`
through the existing secret resolver with the `linear_token` purpose, and calls Linear's
read-only GraphQL API to list issues. Candidates are filtered by
`source.projectSlug`. Poll then reuses the existing scheduler-state, source/subject
lease, isolated workspace, hook evidence, and artifact pipeline.

Phase 7 Linear poll does not add a background scheduler and does not perform Linear
mutations. Local reconcile can still repair leases, missing workflow/step rows,
terminal local workflow state, and retry waits, but remote Linear terminal checks are
deferred.

Response:

```json
{
  "candidates": 1,
  "claimed": 1,
  "duplicates": 0,
  "blocked": 0,
  "retryScheduled": 0,
  "terminalIgnored": 0,
  "artifacts": [],
  "results": [],
  "schedulerStates": []
}
```

### Start GitHub Background Polling

```http
POST /external-work/github/background/start?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 50,
  "executeHooks": false,
  "runImmediately": true
}
```

This Phase 6 endpoint registers a process-local background scheduler for one explicit
`cwd`, channel, and channel-bound workflow path. It does not scan all workspaces and it
does not install a webhook receiver. Duplicate registration for the same resolved
`cwd + channelId + workflowPath` returns the existing scheduler with `duplicate: true`
instead of creating another timer.

`runImmediately` defaults to `true`. When the parsed workflow has
`scheduler.reconcileOnStartup: true`, registration runs reconcile once before the first
poll tick. The tick then reuses the same read-only GitHub poll and local reconcile
services as the manual endpoints. GitHub token resolution follows `source.secretRef`;
token values are never stored in scheduler state or artifacts.

Response:

```json
{
  "cwd": "/path/to/project",
  "scheduler": {
    "id": "external_work_background_...",
    "sourceKind": "github",
    "channelId": "channel_...",
    "workflowPath": "WORKFLOW.md",
    "repository": "owner/repo",
    "pollIntervalMs": 30000,
    "limit": 50,
    "executeHooks": false,
    "status": "running",
    "startedAt": "2026-06-01T00:00:00.000Z",
    "lastPollAt": "2026-06-01T00:00:00.000Z",
    "nextPollAt": "2026-06-01T00:00:30.000Z",
    "lastReconcileAt": "2026-06-01T00:00:00.000Z",
    "tickCount": 1,
    "lastPoll": {},
    "lastReconcile": {}
  },
  "duplicate": false,
  "startupReconcile": {}
}
```

If a poll tick fails, the scheduler remains inspectable and stores
`lastErrorCode: "background_tick_failed"` plus a readable `lastErrorMessage`; it should
schedule the next tick instead of crashing the daemon. Background ticks may read GitHub
and create or reuse local workflows, scheduler state, leases, workspaces, hooks, and
artifacts. They must not start local runners, propose hidden mutations, or execute
external actions.

### List External Work Background Schedulers

```http
GET /external-work/background?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "schedulers": [
    {
      "id": "external_work_background_...",
      "status": "running",
      "channelId": "channel_...",
      "repository": "owner/repo",
      "pollIntervalMs": 30000,
      "tickCount": 1,
      "nextPollAt": "2026-06-01T00:00:30.000Z"
    }
  ]
}
```

This endpoint reads only process-local scheduler registry state. It does not call
GitHub, reconcile state, run hooks, start runners, or mutate approvals/actions.

### Stop External Work Background Scheduler

```http
POST /external-work/background/:schedulerId/stop?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "scheduler": {
    "id": "external_work_background_...",
    "status": "stopped",
    "stoppedAt": "2026-06-01T00:01:00.000Z"
  }
}
```

Stop clears the process-local timer and removes the duplicate-registration key so the
same channel/workflow can be started again later. It does not delete durable external
work, scheduler-state rows, workflows, steps, artifacts, or approvals.

### Triage GitHub CI

```http
POST /external-work/github/ci/triage?cwd=/path/to/project
```

Request:

```json
{
  "externalWorkId": "external_work_...",
  "workflowPath": "WORKFLOW.md",
  "limit": 5,
  "createTask": true,
  "startRun": false
}
```

The target must be an existing `github_pull_request` external-work record. The daemon
loads the record's channel, reads the channel-bound `WORKFLOW.md`, resolves
`source.secretRef` as `github_token` when present, re-reads the current PR, and refuses
stale head SHAs before inspecting CI. It uses only GitHub `GET` endpoints for check
runs, workflow runs, workflow jobs, and job logs. Tokens are never stored in SQLite or
artifacts; logs are bounded and redacted before artifact write.

`createTask` defaults to `true`. Created tasks are local Ling tasks in the same channel
and include an explicit instruction not to push, comment, review, merge, or otherwise
mutate GitHub without a separate approval-gated external action. `startRun` remains
rejected on this JSON triage endpoint; Phase 4.1 starts local fix runs through the
separate explicit SSE endpoint below.

Response:

```json
{
  "cwd": "/path/to/project",
  "triaged": 1,
  "taskCreated": 1,
  "duplicates": 0,
  "blocked": 0,
  "stale": 0,
  "failed": 0,
  "records": [
    {
      "triage": {
        "id": "external_work_ci_triage_...",
        "status": "task_created",
        "checkName": "web e2e",
        "repository": "owner/repo",
        "subjectNumber": 123,
        "headSha": "head-sha"
      },
      "externalWork": {},
      "task": {},
      "artifacts": []
    }
  ]
}
```

Repeating the same failing check/job for the same PR head SHA returns existing triage
records as `duplicates` and does not create a second task. Stale PR heads create a
`stale` local triage record and do not read old CI.

### List GitHub CI Triage

```http
GET /external-work/github/ci/triage?cwd=/path/to/project&channelId=channel_...&status=task_created&limit=25
```

This Phase 4.2 endpoint is local-only. It reads persisted CI triage records and joins
the linked external work item, local fix task, optional run, and artifacts. It does not
read GitHub and does not start a runner.

Query parameters:

- `externalWorkId`: optional external-work id filter.
- `channelId`: optional channel filter.
- `status`: optional triage status filter: `triaged`, `task_created`, `run_requested`,
  `blocked`, `stale`, or `failed`.
- `limit`: optional positive integer, defaulting to the daemon limit.

Response:

```json
{
  "cwd": "/path/to/project",
  "records": [
    {
      "triage": {
        "id": "external_work_ci_triage_...",
        "status": "task_created",
        "repository": "owner/repo",
        "subjectNumber": 123,
        "checkName": "web e2e"
      },
      "externalWork": {},
      "task": {},
      "run": {},
      "artifacts": []
    }
  ]
}
```

### Show GitHub CI Triage

```http
GET /external-work/github/ci/triage/:triageId?cwd=/path/to/project
```

This endpoint returns one local CI triage view with the same shape as list. Missing
records return `404 ci_triage_not_found`. It is also local-only: no GitHub reads and no
runner startup.

### Start GitHub CI Fix Run

```http
POST /external-work/github/ci/triage/:triageId/run?cwd=/path/to/project
```

This Phase 4.1 endpoint starts a local fix run for one existing CI triage record. It
does not read or mutate GitHub. The record must already have a local task, and stale
triage records are rejected. The daemon uses the same run startup path as normal task
runs: provider resolution, provider preflight unless skipped, task status CAS,
resource leases, approval policy, and SSE runner streaming.

Request:

```json
{
  "providerPresetId": "provider_...",
  "skipProviderPreflight": false,
  "idempotencyKey": "optional-custom-key",
  "tools": ["read", "grep", "bash", "edit"],
  "thinkingLevel": "medium",
  "systemPrompt": "optional override",
  "appendSystemPrompt": ["optional extra instruction"],
  "agentDir": ".ling-stack/agents/default"
}
```

Response:

The response is `text/event-stream`, matching `POST /runs`. The first event is:

```text
event: ready
data: {"ok":true,"runId":"run_..."}
```

When the run is accepted or deduplicated, the triage record is updated to
`status: "run_requested"` with `runId`. Repeating the same request uses a deterministic
default idempotency key for the triage record, task, and head SHA, so it returns the
existing run instead of starting another runner. Use this endpoint only after triage has
created the local task; it does not push commits, comment, label, review, merge, or
release.

### List External Work

```http
GET /external-work?cwd=/path/to/project&channelId=channel_...&status=ready&limit=50
```

Query filters are optional:

- `channelId`
- `sourceKind`: `github` or `linear`
- `workItemKind`: `github_pull_request`, `github_issue`, or `linear_issue`
- `status` or `schedulerStatus`: `discovered`, `claimed`, `workspace_preparing`,
  `ready`, `blocked`, `retry_wait`, or `terminal`
- `limit`: 1-500

Response:

```json
{
  "cwd": "/path/to/project",
  "externalWork": [
    {
      "externalWork": {},
      "workflow": {},
      "workflowStep": {},
      "schedulerState": {},
      "artifacts": []
    }
  ]
}
```

The list endpoint is local-only. It reads existing SQLite records and artifacts; it
does not call GitHub, run hooks, start runners, or reconcile state.

### Show External Work

```http
GET /external-work/external_work_...?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "externalWork": {
    "externalWork": {},
    "workflow": {},
    "workflowStep": {},
    "schedulerState": {},
    "artifacts": []
  }
}
```

Missing workflow or workflow-step records are omitted rather than synthesized so local
repair tools can see stale mappings directly. Missing external work ids return
`404 external_work_not_found`.

### Propose External Work Action

```http
POST /external-work/actions/propose?cwd=/path/to/project
```

Request for a comment proposal:

```json
{
  "externalWorkId": "external_work_...",
  "actionKind": "github_comment",
  "approvalRequirement": "standard",
  "payload": {
    "type": "github_comment",
    "body": "Proposed comment body"
  }
}
```

Request for a label proposal:

```json
{
  "externalWorkId": "external_work_...",
  "actionKind": "github_label",
  "payload": {
    "type": "github_label",
    "labels": ["agent-ready", "needs-review"]
  }
}
```

Request for a PR review proposal:

```json
{
  "externalWorkId": "external_work_...",
  "actionKind": "github_pr_review",
  "approvalRequirement": "strict",
  "payload": {
    "type": "github_pr_review",
    "event": "REQUEST_CHANGES",
    "body": "Please fix the failing CI before merge."
  }
}
```

`github_pr_review` is allowed only for `github_pull_request` external work. It always
requires `strict` approval; `standard` is rejected. Supported events are `COMMENT`,
`APPROVE`, and `REQUEST_CHANGES`. The body must be non-empty.

Response:

```json
{
  "cwd": "/path/to/project",
  "action": {
    "id": "external_work_action_...",
    "status": "waiting_for_approval",
    "approvalId": "approval_..."
  },
  "approval": {},
  "artifacts": [],
  "duplicate": false
}
```

The daemon writes a target snapshot, proposed payload, and approval preview as local
artifacts owned by the external work item and linked from the action. The same action
idempotency key returns the existing action with `duplicate: true`. Propose never calls
GitHub mutation APIs.

### List External Work Actions

```http
GET /external-work/actions?cwd=/path/to/project&externalWorkId=external_work_...&status=waiting_for_approval
```

Query filters are optional:

- `externalWorkId`
- `channelId`
- `actionKind`: `github_comment`, `github_label`, or `github_pr_review`
- `status`: `proposed`, `waiting_for_approval`, `approved`, `executing`, `succeeded`,
  `failed`, `cancelled`, `denied`, `expired`, or `stale_target`
- `limit`: 1-500

Response:

```json
{
  "cwd": "/path/to/project",
  "actions": [
    {
      "action": {},
      "externalWork": {},
      "approval": {},
      "artifacts": []
    }
  ]
}
```

The list endpoint is local-only. It does not call GitHub, start runners, execute hooks,
or mutate approval decisions.

### Show External Work Action

```http
GET /external-work/actions/external_work_action_...?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "action": {
    "action": {},
    "externalWork": {},
    "approval": {},
    "artifacts": []
  }
}
```

Missing action ids return `404 external_work_action_not_found`.

### Cancel External Work Action

```http
POST /external-work/actions/external_work_action_.../cancel?cwd=/path/to/project
```

Request:

```json
{
  "reason": "No longer needed"
}
```

Only `proposed`, `waiting_for_approval`, and `approved` actions can be cancelled. A
pending approval is denied with the cancellation reason, the action is marked
`cancelled`, and a local cancellation artifact is linked. Cancel never calls GitHub.

### Execute External Work Action

```http
POST /external-work/actions/external_work_action_.../execute?cwd=/path/to/project
```

Request:

```json
{
  "workflowPath": "WORKFLOW.md"
}
```

`workflowPath` is optional and defaults to `WORKFLOW.md` inside the action channel's
bound path. The daemon parses the workflow to resolve `source.secretRef` through the
existing secret resolver. The resolved GitHub token is passed to the adapter only for
the current request; it is not stored in SQLite or written to artifacts.

Execute requires the linked approval to be `approved` and the action status to be
`approved`. Denied, expired, cancelled, stale, failed, executing, and already-succeeded
actions are rejected before any GitHub call. When eligible, the daemon acquires the
`external_subject` lease, re-reads the current GitHub PR or issue with a read-only
`GET`, and compares the durable target snapshot. A stale state or PR head SHA marks the
action `stale_target`, writes a stale-target evidence artifact, and skips mutation.

Allowed mutation endpoints are limited to:

- `POST /repos/{owner}/{repo}/issues/{number}/comments`
- `POST /repos/{owner}/{repo}/issues/{number}/labels`
- `POST /repos/{owner}/{repo}/pulls/{pull_number}/reviews`

Response:

```json
{
  "cwd": "/path/to/project",
  "action": {
    "id": "external_work_action_...",
    "status": "succeeded",
    "executionAttemptCount": 1,
    "executedAt": "2026-05-31T00:00:00.000Z"
  },
  "approval": {},
  "artifacts": []
}
```

Successful execution writes redacted request/response evidence, including GitHub result
URLs when present. GitHub permission, validation, rate-limit, unavailable, and network
failures mark the action `failed`, persist normalized error evidence, and do not expose
authorization headers or token values.

### Web External Action Approval Cards

The Web Inbox consumes the existing approval and external action endpoints; it does not
add a separate mutation path. For approvals with `externalWorkActionId`, Web loads
`GET /external-work/actions/:id`, shows the target snapshot, comment body or label set,
action status, last error, and linked artifacts, then uses the normal approval endpoints
for Approve/Deny.

Approval and execution stay separate. After a user approves an external action, Web
refreshes the action detail and only shows `Execute action` when the action status is
`approved`. Clicking that button calls `POST /external-work/actions/:id/execute`.
Cancelling from Web calls `POST /external-work/actions/:id/cancel`. Web does not support
edit-and-approve in this phase; users cancel and create a fresh proposal instead.

### Reconcile External Work

```http
POST /external-work/reconcile?cwd=/path/to/project
```

Request:

```json
{
  "channelId": "channel_...",
  "workflowPath": "WORKFLOW.md"
}
```

`channelId` and `workflowPath` are optional. Without `workflowPath`, reconcile only
repairs local state: expired leases, missing workflow/step records, terminal workflow
steps, and retry rows whose backoff has elapsed. With `workflowPath`, it may also use
GitHub read-only single-item `GET` requests to detect remote terminal state.

SDK clients can use the same endpoint through:

```ts
await client.importGitHubExternalWork("/path/to/project", {
  channelId: "channel_...",
  eventType: "pull_request.opened",
  payload,
  workflowPath: "WORKFLOW.md",
});

await client.importLinearExternalWork("/path/to/project", {
  channelId: "channel_...",
  eventType: "issue.created",
  payload,
  workflowPath: "WORKFLOW.md",
});

await client.pollGitHubExternalWork("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
  limit: 50,
});

await client.pollLinearExternalWork("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
  limit: 50,
});

await client.startGitHubExternalWorkBackground("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
  limit: 50,
  runImmediately: true,
});

await client.listExternalWorkBackgroundSchedulers("/path/to/project");

await client.stopExternalWorkBackgroundScheduler(
  "/path/to/project",
  "external_work_background_...",
);

await client.triageGitHubExternalWorkCi("/path/to/project", {
  externalWorkId: "external_work_...",
  workflowPath: "WORKFLOW.md",
  limit: 5,
  createTask: true,
});

await client.listGitHubExternalWorkCiTriage("/path/to/project", {
  channelId: "channel_...",
  status: "task_created",
  limit: 25,
});

await client.getGitHubExternalWorkCiTriage(
  "/path/to/project",
  "external_work_ci_triage_...",
);

const runStream = await client.startGitHubExternalWorkCiTriageRun(
  "/path/to/project",
  "external_work_ci_triage_...",
  {
    providerPresetId: "provider_...",
    tools: ["read", "grep", "bash", "edit"],
  },
);

await client.listExternalWork("/path/to/project", {
  channelId: "channel_...",
  schedulerStatus: "ready",
  limit: 50,
});

await client.getExternalWork("/path/to/project", "external_work_...");

await client.proposeExternalWorkAction("/path/to/project", {
  externalWorkId: "external_work_...",
  actionKind: "github_comment",
  payload: { type: "github_comment", body: "Proposed comment body" },
});

await client.proposeExternalWorkAction("/path/to/project", {
  externalWorkId: "external_work_...",
  actionKind: "github_pr_review",
  approvalRequirement: "strict",
  payload: {
    type: "github_pr_review",
    event: "REQUEST_CHANGES",
    body: "Please fix the failing CI before merge.",
  },
});

await client.listExternalWorkActions("/path/to/project", {
  externalWorkId: "external_work_...",
  status: "waiting_for_approval",
});

await client.getExternalWorkAction("/path/to/project", "external_work_action_...");

await client.cancelExternalWorkAction("/path/to/project", "external_work_action_...", {
  reason: "No longer needed",
});

await client.executeExternalWorkAction("/path/to/project", "external_work_action_...", {
  workflowPath: "WORKFLOW.md",
});

await client.reconcileExternalWork("/path/to/project", {
  channelId: "channel_...",
  workflowPath: "WORKFLOW.md",
});
```

The CLI exposes the same external-work surfaces:

```bash
ling-stack --cwd /path/to/project external-work github import \
  --channel channel_... \
  --event-type pull_request.opened \
  --payload-file examples/external-work/github/pull-request-opened.json \
  --workflow-path WORKFLOW.md

ling-stack --cwd /path/to/project external-work github poll \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50

ling-stack --cwd /path/to/project external-work github background start \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50

ling-stack --cwd /path/to/project external-work github background list

ling-stack --cwd /path/to/project external-work github background stop \
  external_work_background_...

ling-stack --cwd /path/to/project external-work linear import \
  --channel channel_... \
  --event-type issue.created \
  --payload-file issue.json \
  --workflow-path WORKFLOW.md

ling-stack --cwd /path/to/project external-work linear poll \
  --channel channel_... \
  --workflow-path WORKFLOW.md \
  --limit 50

ling-stack --cwd /path/to/project external-work github ci triage \
  --external-work external_work_... \
  --workflow-path WORKFLOW.md \
  --limit 5

ling-stack --cwd /path/to/project external-work github ci run \
  --triage external_work_ci_triage_... \
  --provider provider_...

ling-stack --cwd /path/to/project external-work list \
  --channel channel_... \
  --status ready

ling-stack --cwd /path/to/project external-work show external_work_...

ling-stack --cwd /path/to/project external-work actions propose-comment \
  --external-work external_work_... \
  --body-file comment.md \
  --approval standard

ling-stack --cwd /path/to/project external-work actions propose-labels \
  --external-work external_work_... \
  --label agent-ready \
  --label needs-review

ling-stack --cwd /path/to/project external-work actions propose-review \
  --external-work external_work_... \
  --event REQUEST_CHANGES \
  --body-file review.md

ling-stack --cwd /path/to/project external-work actions list \
  --external-work external_work_... \
  --status waiting_for_approval

ling-stack --cwd /path/to/project external-work actions show external_work_action_...

ling-stack --cwd /path/to/project external-work actions cancel external_work_action_... \
  --reason "No longer needed"

ling-stack --cwd /path/to/project external-work actions execute external_work_action_... \
  --workflow-path WORKFLOW.md

ling-stack --cwd /path/to/project external-work reconcile \
  --channel channel_... \
  --workflow-path WORKFLOW.md
```

`--workflow-markdown-file <path>` may be used instead of `--workflow-path` for inline
manual import tests. CI triage creates local fix tasks by default; use
`--no-create-task` to write only triage records and artifacts. `external-work github ci
run` is the explicit Phase 4.1 bridge from a triage record to the normal local runner.
The CLI and SDK only call local daemon endpoints. Action proposal creates local proposed
action and approval records only. Import, poll, background start/list/stop, CI triage,
list/show, action proposal/cancel, and reconcile do not start a runner. Only
`external-work github ci run` starts a local runner. Only `external-work actions execute`
can mutate GitHub, and only after approval and revalidation. PR review actions are
strict approval actions; the Web and CLI do not support edit-and-approve, so users
cancel and re-propose if the review event or body is wrong. Linear import and poll are
read-only Phase 7 surfaces and have no action execution path.

For a copy-pasteable temp workspace smoke, use
`examples/external-work/github/README.md`. That smoke copies the example `WORKFLOW.md`
into a temporary channel bound path, starts an isolated daemon on a non-default port,
creates a channel, imports the PR or issue fixture, reads evidence artifacts through
`/artifacts/:id/content`, runs an authenticated read-only poll/reconcile cycle, and
confirms the runner list stays empty.

For a real repository smoke, use `docs/external-work-live-smoke.md` or the helper:

```bash
corepack pnpm build
export GITHUB_TOKEN="$(gh auth token)"
node examples/external-work/github/live-readonly-smoke.mjs --repo owner/repo --limit 1
```

The helper uses live GitHub read endpoints, creates and cancels a local proposed action,
and verifies no runner starts. It never approves or executes the action, so it never
calls GitHub mutation APIs. The same doc contains the explicit optional mutation smoke
for disposable test PRs or issues.

### Run Persisted Task

```http
POST /tasks/:id/run?cwd=/path/to/project
Content-Type: application/json
Accept: text/event-stream
```

```json
{
  "providerPresetId": "provider_...",
  "teammateId": "engineer",
  "idempotencyKey": "client-generated-key",
  "tools": ["read", "grep", "find", "ls"]
}
```

The daemon loads the task and channel, rejects paused or archived channels, checks provider readiness, acquires resource leases, claims the task with compare-and-set, creates a run, streams events, and releases leases on terminal state. Repeating the same `idempotencyKey` returns the original run id and does not start another runner.

Conflicts return `409 resource_conflict` with the blocking resource in the message. v0.1 exposes conflict visibility; durable queued-attempt scheduling is a later slice.

## Run Task

```http
POST /runs
Content-Type: application/json
Accept: text/event-stream
```

`POST /runs` returns an SSE stream. Because native `EventSource` cannot send POST bodies, web clients should use `fetch()` and read the response body stream.

`cwd` is the execution directory passed to the runner. `workspaceCwd` is optional and selects where Ling Stack stores run/session records and resolves provider presets. If `workspaceCwd` is omitted, it defaults to `cwd`. Persisted channel/task flows should set `workspaceCwd` to the Ling Stack workspace path and `cwd` to the selected channel `boundPath`.

Request with inline provider config:

```json
{
  "cwd": "/path/to/project",
  "task": {
    "id": "task-1",
    "title": "Inspect the project",
    "prompt": "List the files and summarize the repo.",
    "channelId": "engineering"
  },
  "provider": {
    "provider": "openai",
    "model": "gpt-5.5",
    "apiKey": "env-or-runtime-key"
  },
  "tools": ["read", "grep", "find", "ls"],
  "skillOptimizationMode": "no_operation",
  "thinkingLevel": "medium"
}
```

## Runtime Diagnostics

These endpoints are read-only and intended for Web timelines, CLI doctor, and debugging stuck work.

```http
GET /state-transitions?cwd=/path/to/project&entityType=task&entityId=task_...
GET /runtime/leases?cwd=/path/to/project&status=active
GET /runtime/extensions?cwd=/path/to/project
```

`/state-transitions` returns persisted transition facts for `task`, `run`, `approval`, `media_job`, `workflow`, or `workflow_step`.

`/runtime/leases` returns active, released, or expired leases. Resource types are `channel`, `bound_path`, `workspace`, `provider`, `task`, and `workflow_step`.

`/runtime/extensions` returns safe internal extension metadata for diagnostics. It does
not report plugin lifecycle state, health checks, install actions, secrets, or dynamic
code paths. Product-managed plugin state remains under `/plugins`.

Response:

```json
{
  "cwd": "/path/to/project",
  "extensions": [
    {
      "id": "tool:write",
      "name": "Write",
      "version": "0.1.0",
      "kind": "tool",
      "trustLevel": "internal",
      "capabilities": ["filesystem:write"],
      "defaultApproval": "ask",
      "sideEffectLevel": "write"
    }
  ]
}
```

Inline provider config is useful for development, but normal product flows should use provider presets so raw API keys are not persisted in workspace records.

For OpenAI-compatible relays as inline config:

```json
{
  "cwd": "/path/to/project",
  "task": {
    "id": "task-2",
    "title": "Relay smoke test",
    "prompt": "Say hello."
  },
  "provider": {
    "provider": "local-relay",
    "displayName": "Local Relay",
    "model": "dpv4",
    "baseUrl": "http://127.0.0.1:3000/v1",
    "api": "openai-completions",
    "apiKey": "sk-local"
  },
  "tools": ["read"],
  "thinkingLevel": "off"
}
```

Request with a provider preset:

```json
{
  "workspaceCwd": "/path/to/workspace",
  "cwd": "/path/to/channel/project",
  "task": {
    "id": "task-3",
    "title": "Preset smoke test",
    "prompt": "Inspect the repo and summarize the main packages."
  },
  "providerPresetId": "provider_...",
  "skipProviderPreflight": false,
  "tools": ["read", "grep", "find", "ls"],
  "thinkingLevel": "medium"
}
```

Rules:

- Request must include either `providerPresetId` or `provider`.
- Supplying both returns `bad_request`.
- `media-job` presets cannot run Pi coding tasks.
- Disabled presets return `provider_disabled`.
- Presets without `chat` capability return `unsupported_capability`.
- `providerPresetId` product runs require a successful saved provider check. If `lastCheck` is missing or `lastCheck.ok !== true`, the daemon returns `provider_preflight_failed` before creating a run session.
- Required `apiKeyRef` values are re-resolved from the current daemon environment at run startup. Missing required secrets return `provider_preflight_failed`.
- `skipProviderPreflight: true` is a development/debug escape hatch for direct callers and CLI `--skip-preflight`. It bypasses secret-readiness and `lastCheck` gates only; it does not allow disabled, media-only, or no-chat presets to run.
- Inline `provider` requests are development-only and are not checked against persisted provider `lastCheck`.
- Product runs default to read-only tools: `read`, `grep`, `find`, `ls`.
- `skillOptimizationMode` defaults to `no_operation`. `auto_runtime_experimental` is
  an explicit experimental per-run override; it may select an active compiled runtime view
  for the selected skill when one exists. Import, publish, and ordinary task runs do not
  enable compiled views automatically.
- If `bash`, `edit`, or `write` are enabled for a run, Pi tool execution is paused before the side effect and an approval request is created.
- The run stays `waiting_for_approval` until `/approvals/:id/approve` or `/approvals/:id/deny` resolves the request.

Preflight failure response:

```http
HTTP/1.1 400 Bad Request
Content-Type: application/json
```

```json
{
  "error": "provider_preflight_failed",
  "message": "Local Relay: provider has not been checked. Run provider check before starting."
}
```

SSE events:

```text
event: ready
data: {"ok":true,"runId":"run_..."}

event: run_start
data: {"type":"run_start","taskId":"task-1",...}

event: assistant_text_delta
data: {"type":"assistant_text_delta","text":"..."}

event: tool_start
data: {"type":"tool_start","toolName":"read",...}

event: tool_end
data: {"type":"tool_end","toolName":"read","isError":false,...}

event: approval_requested
data: {"approvalId":"approval_...","actionType":"bash","risk":"medium",...}

event: approval_approved
data: {"approvalId":"approval_...","status":"approved",...}

event: approval_expired
data: {"approvalId":"approval_...","status":"expired",...}

event: run_end
data: {"type":"run_end","taskId":"task-1","messageCount":3}

event: result
data: {"taskId":"task-1","messageCount":3,"eventCount":12}
```

Errors are also sent as SSE once the stream has started:

```text
event: error
data: {"error":"run_failed","message":"..."}
```

## Run History

Runs and events are persisted in the workspace runtime directory:

```text
.ling-stack/ling-stack.sqlite
.ling-stack/sessions/<runId>.jsonl
.ling-stack/sessions/<runId>.summary.json
```

For runs created with `workspaceCwd`, query run history using `cwd=<workspaceCwd>`. The returned run object's `cwd` remains the execution directory.

### List Runs

```http
GET /runs?cwd=/path/to/project&limit=50
```

Response:

```json
{
  "cwd": "/path/to/project",
  "runs": [
    {
      "id": "run_...",
      "status": "succeeded",
      "cwd": "/path/to/project",
      "taskId": "task-1",
      "providerName": "local-relay",
      "providerModel": "gpt-5.5",
      "eventLogPath": "/path/to/project/.ling-stack/sessions/run_....jsonl",
      "createdAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:10.000Z"
    }
  ]
}
```

Optional query parameters:

- `limit`: integer from `1` to `200`, default `50`.
- `status`: one of `queued`, `running`, `waiting_for_approval`, `succeeded`, `failed`, `cancelled`.

### Get Run

```http
GET /runs/:id?cwd=/path/to/project
```

Passing `cwd` is recommended after daemon restart because the in-memory run-to-store index is rebuilt lazily.

When a run selects a source-backed skill, `requestSnapshot.skillSourceContext` records
the runtime view evidence used to build the runner prompt. In the default
`no_operation` mode, Ling still uses the original published source snapshot. A compiled
runtime view is not selected unless a future policy explicitly enables it.

```json
{
  "requestSnapshot": {
    "selectedSkillId": "implement",
    "skillSourceContext": {
      "runtimeViewKind": "original_source",
      "optimizationMode": "no_operation",
      "snapshotId": "skill_source_...",
      "skillId": "implement",
      "sourceChecksum": "sha256:...",
      "tokenEstimate": 128,
      "includedRefs": [
        {
          "id": "skill_source_...:skill-md",
          "title": "SKILL.md source",
          "kind": "reference",
          "sourceRef": "skill-source:skill_source_...:rawSkillMarkdown"
        }
      ],
      "deferredRefs": [
        {
          "id": "file:references/checklist.md",
          "title": "references/checklist.md",
          "kind": "reference",
          "sourceRef": "skill-source-file:references/checklist.md",
          "loadPolicy": "on_request"
        }
      ],
      "materializedRefs": []
    }
  }
}
```

`runtimeViewKind` may be `metadata_only`, `original_source`, `compiled_view`, or
`disabled_for_runner` in the current P2A slice. P2A exposes the lazy reference index as
evidence only; it does not perform hidden mid-run reference injection.

If an explicitly compiled run fails with a missing-reference signature, `run_error.data`
may include `skillContextFallback`. This is a retry-time fallback plan, not a hidden
continuation:

```json
{
  "type": "run_error",
  "data": {
    "message": "missing reference lazy_examples",
    "skillContextFallback": {
      "reasonCode": "compiled_missing_reference",
      "fromRuntimeViewKind": "compiled_view",
      "retryRuntimeViewKind": "original_source",
      "matchedRefIds": ["lazy_examples"],
      "message": "Compiled skill context failed with a missing deferred reference; retry with original source."
    }
  }
}
```

### Get Run Events

```http
GET /runs/:id/events?cwd=/path/to/project&afterSeq=0&limit=200
```

Response:

```json
{
  "runId": "run_...",
  "events": [
    {
      "id": "evt_...",
      "runId": "run_...",
      "seq": 1,
      "ts": "2026-05-20T00:00:00.000Z",
      "type": "run_created",
      "data": {
        "taskId": "task-1",
        "cwd": "/path/to/project",
        "providerName": "local-relay",
        "providerModel": "gpt-5.5"
      }
    }
  ],
  "nextSeq": 2
}
```

### List Run Artifacts

```http
GET /runs/:id/artifacts?cwd=/path/to/project
```

Passing `cwd` is recommended after daemon restart. Artifact paths are local paths under `.ling-stack/artifacts` and are served only through the artifact content endpoint.

During run execution the daemon records `artifact_created` events for extracted Pi tool evidence. v0.1 extraction covers text, log, Markdown, diff output, and generated file path metadata. Media job artifacts use the same artifact API; live media adapters can store returned image and video bytes as local artifacts. Current connected media paths include OpenAI Images and Seedream `image_generate`, Seedream URL/data-URL `image_edit`, and Seedance `video_generate` after final task polling and video download.

Response:

```json
{
  "runId": "run_...",
  "artifacts": [
    {
      "id": "artifact_...",
      "runId": "run_...",
      "type": "markdown",
      "path": "run_.../summary.md",
      "title": "Summary",
      "contentType": "text/markdown; charset=utf-8",
      "sizeBytes": 1024,
      "createdAt": "2026-05-22T00:00:00.000Z"
    }
  ]
}
```

### Get Artifact Metadata

```http
GET /artifacts/:id?cwd=/path/to/project
```

Response:

```json
{
  "artifact": {
    "id": "artifact_...",
    "runId": "run_...",
    "type": "markdown",
    "path": "run_.../summary.md",
    "title": "Summary",
    "createdAt": "2026-05-22T00:00:00.000Z"
  }
}
```

### Get Artifact Content

```http
GET /artifacts/:id/content?cwd=/path/to/project
```

The daemon resolves artifact content relative to `.ling-stack/artifacts` and rejects paths outside that directory with `403 artifact_outside_root`.

## Media Jobs

Media jobs are persisted metadata for direct provider or Media Production workflow execution. The Generation Runtime Resolver decides whether a provider can run the requested image or video operation. Standalone jobs run after an explicit run request. Media Production scene runs, ordered project runs, and workflow tests treat the user's generation action as the explicit authorization and dispatch immediately without creating a second `media_cost` approval.

Supported statuses:

```text
queued, running, waiting_for_approval, succeeded, failed, cancelled
```

Supported operations:

```text
image_generate, image_edit, video_generate
```

### Create Media Job

```http
POST /media-jobs?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "providerPresetId": "provider_...",
  "operation": "image_generate",
  "prompt": "Create a clean product screenshot style image.",
  "input": {
    "size": "2K"
  }
}
```

Rules:

- `providerPresetId` must reference an enabled provider preset with `api: "media-job"`.
- The provider preset must include the requested media operation in `capabilities`.
- Chat provider presets return `unsupported_capability`.
- Creation only records queued metadata. Live vendor calls happen only through explicit run execution after runtime readiness checks pass; billing and provider account charges are handled by the configured vendor account, not by a Ling approval gate.

Response:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "workspaceId": "workspace_default",
    "providerPresetId": "provider_...",
    "operation": "image_generate",
    "prompt": "Create a clean product screenshot style image.",
    "input": {
      "size": "2K"
    },
    "artifactIds": [],
    "status": "queued",
    "createdAt": "2026-05-23T00:00:00.000Z",
    "updatedAt": "2026-05-23T00:00:00.000Z"
  }
}
```

### List Media Jobs

```http
GET /media-jobs?cwd=/path/to/project&status=queued&providerPresetId=provider_...&limit=100
```

Response:

```json
{
  "cwd": "/path/to/project",
  "mediaJobs": []
}
```

### Get Media Job

```http
GET /media-jobs/:id?cwd=/path/to/project
```

Response:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "status": "queued"
  }
}
```

### Run Media Job

```http
POST /media-jobs/:id/run?cwd=/path/to/project
```

The current execution interface uses the media adapter contract, provider-kind registry, and Generation Runtime Resolver. A live-ready provider preset must have a supported operation, `compat.mediaVendorTransport.mode = "live"` after normalization, `baseUrl`, `apiKeyRef`, and a configured secret. Live transport currently supports OpenAI Images `image_generate`, Seedream `image_generate`, Seedream URL-based `image_edit`, and Seedance `video_generate` with final task polling plus video download. Image and video adapters record compact JSON metadata artifacts and download returned HTTP(S) media URLs into local artifacts under `.ling-stack/artifacts` without sending the provider authorization header to those media URLs. Jimeng, billing, local-file image edit materialization, and unsupported media operations remain out of scope.

Live-ready standalone jobs execute directly when `POST /media-jobs/:id/run` is called. This route does not create a `media_cost` approval. Media Production uses the same durable executor automatically after its scene, project, or workflow-test route creates the job.

Runnable statuses are `queued`, `waiting_for_approval`, `failed`, and `cancelled`. `running` and `succeeded` jobs return `409 media_job_not_runnable`. Tests can force the static failure path with `input.forceFailure: true`.

Response:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "status": "succeeded",
    "artifactIds": ["artifact_..."]
  },
  "artifacts": [
    {
      "id": "artifact_...",
      "mediaJobId": "media_job_...",
      "type": "markdown",
      "path": "media_jobs/media_job_.../static-result-2026-05-23T00-00-00-000Z.md",
      "title": "Image generate static result",
      "contentType": "text/markdown; charset=utf-8"
    }
  ]
}
```

Standalone media job runs do not return an `approval` field:

```json
{
  "mediaJob": {
    "id": "media_job_...",
    "status": "succeeded",
    "artifactIds": ["artifact_..."]
  },
  "artifacts": [{ "id": "artifact_...", "mediaJobId": "media_job_...", "type": "image" }]
}
```

### Media Production Dispatch

The Media Production entry points create durable jobs and immediately hand them to the daemon dispatcher:

```http
POST /media-scenes/:id/run?cwd=/path/to/project
POST /media-projects/:id/run?cwd=/path/to/project
POST /media-workflows/:id/test?cwd=/path/to/project
```

A scene or workflow test response contains the queued job. A project run contains one queued job and Scene Run per submitted scene:

```json
{
  "mediaJob": { "id": "media_job_...", "status": "queued" },
  "mediaSceneRun": { "id": "media_scene_run_...", "mediaJobId": "media_job_..." }
}
```

The response is written before the background dispatcher advances the job to `running`, so clients should refresh the shared Media Job record. Provider and Workflow jobs keep their distinct execution source and use the same polling, cancellation, artifact, runtime-work-unit, and restart-resume infrastructure. Historical `waiting_for_approval` jobs and approval records remain readable for compatibility, but new Media Production runs do not create them.

### List Media Job Artifacts

```http
GET /media-jobs/:id/artifacts?cwd=/path/to/project
```

Response:

```json
{
  "mediaJobId": "media_job_...",
  "artifacts": []
}
```

### Cancel Run

```http
POST /runs/:id/cancel?cwd=/path/to/project
```

Cancellation is best effort. For an active run, the daemon marks the run `cancelled`, appends a `run_cancelled` event, streams that event to the open SSE client when possible, and asks the Pi session to abort.

Response:

```json
{
  "cancelled": true,
  "active": true,
  "run": {
    "id": "run_...",
    "status": "cancelled"
  }
}
```

## Provider Presets

Provider presets store reusable non-secret provider configuration. API keys are represented as `apiKeyRef`, using `env:NAME` or `keychain:NAME`.

### List Provider Templates

```http
GET /provider-templates
```

Response:

```json
{
  "templates": [
    {
      "templateId": "local-openai-compatible-relay",
      "kind": "openai-compatible",
      "displayName": "Local OpenAI-Compatible Relay",
      "description": "Local relay, One API, New API, LiteLLM, OpenRouter-style gateways, or private compatible gateways.",
      "providerId": "local-relay",
      "model": "dpv4",
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
      "capabilities": ["chat", "tool_call", "reasoning"],
      "input": ["text"],
      "enabled": false
    }
  ]
}
```

Templates are reusable request bodies for `POST /providers`. They are disabled by default and use secret refs rather than raw keys.

### List Providers

```http
GET /providers?cwd=/path/to/project
```

Response:

```json
{
  "cwd": "/path/to/project",
  "providers": [
    {
      "id": "provider_...",
      "kind": "openai-compatible",
      "displayName": "Local Relay",
      "providerId": "local-relay",
      "model": "gpt-5.5",
      "api": "openai-completions",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
      "apiKeyConfigured": true,
      "apiKeyStatus": {
        "ref": "env:LOCAL_RELAY_API_KEY",
        "kind": "env",
        "configured": true
      },
      "headers": {},
      "secretHeaderRefs": {},
      "input": ["text"],
      "compat": {},
      "capabilities": ["chat", "tool_call", "reasoning"],
      "enabled": true,
      "createdAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

`apiKeyStatus` is status-only metadata. It never includes the resolved secret value.

### Create Provider

```http
POST /providers?cwd=/path/to/project
Content-Type: application/json
```

```json
{
  "kind": "openai-compatible",
  "displayName": "Local Relay",
  "providerId": "local-relay",
  "model": "gpt-5.5",
  "api": "openai-completions",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
  "capabilities": ["chat", "tool_call", "reasoning"],
  "input": ["text"],
  "enabled": true,
  "authHeader": true,
  "reasoning": true,
  "contextWindow": 128000,
  "maxTokens": 16384
}
```

Raw `apiKey` is not accepted for persistent provider presets. `apiKeyRef` accepts only supported secret refs such as `env:LOCAL_RELAY_API_KEY` or `keychain:provider_local`.

### Configure Provider Keychain Secret

```http
POST /providers/:id/secrets/configure?cwd=/path/to/project
Content-Type: application/json
```

This endpoint lets a trusted local daemon save a provider API key into the configured
Keychain store and update the provider preset to reference that key. It accepts only
`keychain:` refs. It never returns the raw secret value.

Request:

```json
{
  "secretRef": "keychain:provider_local_relay",
  "apiKey": "sk-...",
  "clearLocalSecret": true
}
```

Response:

```json
{
  "provider": {
    "id": "provider_...",
    "apiKeyRef": "keychain:provider_local_relay",
    "apiKeyConfigured": true
  },
  "secretRef": "keychain:provider_local_relay",
  "status": {
    "ref": "keychain:provider_local_relay",
    "kind": "keychain",
    "configured": true
  }
}
```

If the current runtime has no Keychain store, the daemon returns `501` with
`secret_store_unavailable` status metadata. Existing workspace-local provider secrets are
cleared by default after a successful Keychain save unless `clearLocalSecret` is `false`.

### Delete Provider Keychain Secret

```http
DELETE /providers/:id/secrets/keychain?cwd=/path/to/project
Content-Type: application/json
```

Request body is optional:

```json
{
  "secretRef": "keychain:provider_local_relay"
}
```

The daemon deletes the Keychain item and clears the provider `apiKeyRef` only when the
provider currently points at the same ref. It does not delete the provider preset.

Response shape matches the configure endpoint.

### List Provider Models

```http
POST /provider-models?cwd=/path/to/project
Content-Type: application/json
```

The model discovery endpoint asks the configured provider route for available models
and enriches the result with Ling capability metadata. It is used by Model Workbench
before creating provider presets.

Request:

```json
{
  "kind": "openai-compatible",
  "providerId": "local-relay",
  "api": "openai-completions",
  "providerTransport": "auto",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
  "headers": {},
  "secretHeaderRefs": {},
  "authHeader": true
}
```

Fields:

- `kind`, `providerId`, and `api` describe the provider route to inspect.
- `providerTransport` is optional and only applies to APIs that support a transport
  choice.
- `baseUrl` is required for OpenAI-compatible and media routes that need a remote
  endpoint.
- `apiKeyRef` is the preferred secret input. A transient `apiKey` may be accepted by
  setup flows for discovery only; the value is never returned.
- `headers` are static non-secret headers.
- `secretHeaderRefs` maps HTTP header names to `env:` or `keychain:` refs. The daemon
  resolves them only inside trusted runtime calls, rejects duplicate static/secret
  header names, and redacts resolved values from snapshots and artifacts.
- `authHeader` controls whether the daemon sends the resolved API key as the standard
  authorization header for compatible providers.

Response:

```json
{
  "source": "openai-compatible:/models",
  "models": [
    {
      "id": "gpt-5.5",
      "displayName": "gpt-5.5",
      "ownedBy": "openai",
      "api": "openai-responses",
      "input": ["text", "image"],
      "capabilities": ["chat", "tool_call", "reasoning", "vision"],
      "thinkingModes": ["off", "low", "medium", "high"],
      "thinkingSupport": {
        "levels": ["off", "low", "medium", "high"]
      },
      "contextWindow": 128000,
      "maxTokens": 16384,
      "supportedParameters": ["reasoning.effort"],
      "capabilitySource": "model_catalog",
      "capabilityConfidence": "known"
    }
  ]
}
```

Capability metadata follows a conservative rule:

1. Reliable upstream model metadata wins when present.
2. Ling's model catalog fills known model-family gaps.
3. Unknown models stay conservative and are not promoted to generation or reasoning
   models only because their id looks similar.

Common failures:

- `secret_missing`
- `auth_failed`
- `network_failed`
- `provider_error`
- `unsupported_capability`
- `bad_request`

Secret values are never returned in success or error bodies.

### Import Provider Models

```http
POST /providers/import-models?cwd=/path/to/project
Content-Type: application/json
```

The import endpoint creates or updates one provider preset per selected model from a
model discovery result. It deduplicates by provider id, protocol, normalized Base URL,
and model id.

Request:

```json
{
  "kind": "openai-compatible",
  "displayName": "Local Relay",
  "providerId": "local-relay",
  "api": "openai-completions",
  "providerTransport": "auto",
  "baseUrl": "http://127.0.0.1:8317/v1",
  "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
  "headers": {},
  "secretHeaderRefs": {},
  "authHeader": true,
  "capabilities": ["chat"],
  "input": ["text"],
  "enabled": true,
  "models": [
    {
      "id": "gpt-5.5",
      "displayName": "gpt-5.5",
      "api": "openai-responses",
      "input": ["text", "image"],
      "capabilities": ["chat", "tool_call", "reasoning", "vision"],
      "thinkingModes": ["off", "low", "medium", "high"],
      "contextWindow": 128000,
      "maxTokens": 16384
    }
  ]
}
```

Response:

```json
{
  "providers": [
    {
      "id": "provider_...",
      "kind": "openai-compatible",
      "displayName": "Local Relay · gpt-5.5",
      "providerId": "local-relay",
      "model": "gpt-5.5",
      "api": "openai-responses",
      "baseUrl": "http://127.0.0.1:8317/v1",
      "apiKeyRef": "env:LOCAL_RELAY_API_KEY",
      "apiKeyConfigured": true,
      "headers": {},
      "secretHeaderRefs": {},
      "input": ["text", "image"],
      "capabilities": ["chat", "tool_call", "reasoning", "vision"],
      "thinkingModes": ["off", "low", "medium", "high"],
      "reasoning": true,
      "compat": {
        "modelMetadata": {
          "capabilitySource": "model_catalog",
          "capabilityConfidence": "known"
        }
      },
      "enabled": true,
      "createdAt": "2026-05-20T00:00:00.000Z",
      "updatedAt": "2026-05-20T00:00:00.000Z"
    }
  ],
  "createdCount": 1,
  "updatedCount": 0,
  "warnings": []
}
```

Import behavior:

- Model-level `api`, `input`, `capabilities`, `thinkingModes`, `contextWindow`, and
  `maxTokens` override the shared request defaults for that imported preset.
- `reasoning` is derived from `thinkingModes`: any mode other than `off` adds the
  `reasoning` capability.
- Discovery metadata is persisted under provider compatibility metadata so later UI
  and runtime checks can explain where capability decisions came from.
- Media models are normalized through the generation runtime resolver during import.
- Imported non-media providers may run provider check after save; failures return
  warnings or provider `lastCheck` state rather than exposing secret values.
- A raw `apiKey` in the import request is a setup compatibility path that stores a
  local provider secret and returns only a ref/status. Prefer `apiKeyRef` for durable
  configuration.

### Get, Update, Delete

```http
GET /providers/:id?cwd=/path/to/project
PATCH /providers/:id?cwd=/path/to/project
DELETE /providers/:id?cwd=/path/to/project
```

`PATCH` accepts partial provider fields. The daemon validates the merged provider shape before writing.

Media provider presets can prepare the live transport gate without changing the media job API:

```json
{
  "baseUrl": "https://ark.cn-beijing.volces.com/api/v3",
  "model": "doubao-seedream-5-0-260128",
  "apiKeyRef": "env:SEEDREAM_API_KEY",
  "compat": {
    "mediaVendorTransport": {
      "mode": "live"
    }
  }
}
```

CLI equivalent:

```bash
ling-stack provider update provider_... --base-url https://ark.cn-beijing.volces.com/api/v3 --model doubao-seedream-5-0-260128 --api-key-ref env:SEEDREAM_API_KEY --compat-json '{"mediaVendorTransport":{"mode":"live"}}'
```

### Check Provider

```http
POST /providers/:id/check?cwd=/path/to/project
```

Response:

```json
{
  "ok": true,
  "code": "ready",
  "message": "Provider is reachable and accepted the configured model.",
  "checkedAt": "2026-05-20T00:00:00.000Z"
}
```

The check validates base URL format, required secret refs, enabled state, and supported capabilities. For `media-job` presets, the check uses generation runtime readiness; providers whose live check would create paid output may return static readiness without generating media. For `openai-completions`, `openai-responses`, and `anthropic-messages`, it also performs a small live model request with a 10 second timeout. Common failure codes include `secret_missing`, `network_failed`, `auth_failed`, `model_unsupported`, `rate_limited`, `provider_disabled`, and `provider_error`.

## MCP Servers And Tools

MCP server config stores transport metadata and secret refs. Runtime status is reported
through short-lived status snapshots, not by returning or mutating raw secret values.

### List MCP Servers

```http
GET /mcp/servers?cwd=/path/to/project
```

Response:

```json
{
  "servers": [
    {
      "id": "mcp_...",
      "workspaceId": "default",
      "displayName": "GitHub MCP",
      "enabled": true,
      "required": false,
      "transport": {
        "type": "streamable-http",
        "url": "http://127.0.0.1:3000/mcp",
        "headers": {
          "X-Client": "ling-stack"
        },
        "secretHeaderRefs": {
          "X-Api-Key": "keychain:MCP_REMOTE_API_KEY"
        }
      },
      "status": {
        "kind": "ready",
        "message": "MCP server is reachable.",
        "checkedAt": "2026-06-06T00:00:00.000Z"
      },
      "statusSnapshot": {
        "serverId": "mcp_...",
        "checkedAt": "2026-06-06T00:00:00.000Z",
        "expiresAt": "2026-06-06T00:05:00.000Z",
        "status": "ready",
        "toolCount": 3,
        "missingSecretRefs": [],
        "authStatus": {
          "kind": "configured",
          "refs": ["keychain:MCP_REMOTE_API_KEY"],
          "missingRefs": []
        }
      },
      "secretConfigured": {
        "X-Api-Key": true
      },
      "secretStatuses": [
        {
          "ref": "keychain:MCP_REMOTE_API_KEY",
          "kind": "keychain",
          "configured": true
        }
      ],
      "legacySecretMigrationRequired": false,
      "createdAt": "2026-06-06T00:00:00.000Z",
      "updatedAt": "2026-06-06T00:00:00.000Z"
    }
  ]
}
```

`secretStatuses` and `secretConfigured` are status-only metadata. They never include
resolved env, keychain, bearer-token, or header values.

### Create MCP Server

```http
POST /mcp/servers?cwd=/path/to/project
Content-Type: application/json
```

Stdio transport:

```json
{
  "displayName": "Local Filesystem MCP",
  "enabled": true,
  "required": false,
  "transport": {
    "type": "stdio",
    "command": "node",
    "args": ["server.js"],
    "env": {
      "NODE_ENV": "production"
    },
    "secretEnvRefs": {
      "GITHUB_TOKEN": "keychain:LING_STACK_GITHUB_OWNER_REPO_TOKEN"
    }
  }
}
```

Streamable HTTP transport:

```json
{
  "displayName": "Remote MCP",
  "enabled": true,
  "transport": {
    "type": "streamable-http",
    "url": "http://127.0.0.1:3000/mcp",
    "headers": {
      "X-Client": "ling-stack"
    },
    "secretHeaderRefs": {
      "X-Api-Key": "keychain:MCP_REMOTE_API_KEY"
    },
    "bearerTokenRef": "env:MCP_BEARER_TOKEN"
  }
}
```

Raw `secrets`, `clearSecretNames`, persisted `status`, and legacy transport secret
fields are rejected for new writes. Use `secretEnvRefs`, `secretHeaderRefs`, and
`bearerTokenRef`. Use either `secretHeaderRefs.Authorization` or `bearerTokenRef`
for bearer auth; `bearerTokenRef` is the shorthand that produces
`Authorization: Bearer <value>`.

### Get, Update, Delete MCP Server

```http
GET /mcp/servers/:id?cwd=/path/to/project
PATCH /mcp/servers/:id?cwd=/path/to/project
DELETE /mcp/servers/:id?cwd=/path/to/project
```

`PATCH` accepts the same redacted config fields as create. It does not accept raw
secret values and does not write runtime status.

### Check MCP Server

```http
POST /mcp/servers/:id/check?cwd=/path/to/project
```

Response:

```json
{
  "server": {
    "id": "mcp_...",
    "displayName": "Remote MCP",
    "status": {
      "kind": "ready",
      "message": "MCP server is reachable.",
      "checkedAt": "2026-06-06T00:00:00.000Z"
    },
    "secretStatuses": [],
    "legacySecretMigrationRequired": false
  },
  "statusSnapshot": {
    "serverId": "mcp_...",
    "checkedAt": "2026-06-06T00:00:00.000Z",
    "expiresAt": "2026-06-06T00:05:00.000Z",
    "status": "ready",
    "protocolVersion": "2025-03-26",
    "toolCount": 3,
    "missingSecretRefs": [],
    "authStatus": {
      "kind": "configured",
      "refs": [],
      "missingRefs": []
    },
    "latencyMs": 32
  }
}
```

If required refs are missing, the daemon fails closed and returns a structured failed
snapshot with `errorCode` such as `mcp_secret_missing`; it still does not expose values.

### Get MCP Status Snapshot

```http
GET /mcp/servers/:id/status?cwd=/path/to/project
```

This endpoint reads the cached snapshot only. It does not open a live MCP connection,
sync tools, or repair config.

Response:

```json
{
  "server": {
    "id": "mcp_...",
    "displayName": "Remote MCP",
    "legacySecretMigrationRequired": false
  },
  "statusSnapshot": null
}
```

`statusSnapshot` is `null` when no snapshot exists. Expired snapshots may be returned
with `status: "expired"` and a remediation message.

### Sync MCP Tools

```http
POST /mcp/servers/:id/sync-tools?cwd=/path/to/project
```

Response:

```json
{
  "server": {
    "id": "mcp_...",
    "displayName": "Remote MCP"
  },
  "statusSnapshot": {
    "serverId": "mcp_...",
    "checkedAt": "2026-06-06T00:00:00.000Z",
    "expiresAt": "2026-06-06T00:05:00.000Z",
    "status": "ready",
    "toolCount": 3,
    "missingSecretRefs": [],
    "authStatus": {
      "kind": "configured",
      "refs": [],
      "missingRefs": []
    }
  },
  "tools": [
    {
      "id": "mcp_tool_...",
      "serverId": "mcp_...",
      "rawName": "search",
      "displayName": "search",
      "callableNamespace": "mcp",
      "callableName": "search",
      "sideEffectLevel": "read",
      "defaultApproval": "allow",
      "enabled": true
    }
  ]
}
```

Tool sync persists the tool catalog after successful listing and persists a redacted
status snapshot for the attempted check/list operation.

### List MCP Tools

```http
GET /mcp/tools?cwd=/path/to/project&serverId=mcp_...
```

Response:

```json
{
  "tools": []
}
```

### Removed MCP Secret Read

```http
GET /mcp/servers/:id/secret?cwd=/path/to/project&name=Authorization
```

Response:

```json
{
  "error": "mcp_secret_endpoint_removed",
  "message": "MCP secret values are not readable. Use secret refs and /secrets/status."
}
```

The route returns HTTP `410 Gone`. Clients that need secret readiness should use
`GET /secrets/status`.

## Secrets

### Get Secret Status

```http
GET /secrets/status?ref=env%3AOPENAI_API_KEY&purpose=provider_api_key
```

`purpose` is optional. Supported values are `provider_api_key`, `github_token`, `linear_token`, `webhook_secret`, `custom_header`, and `automation_token`.

Response:

```json
{
  "status": {
    "ref": "env:OPENAI_API_KEY",
    "kind": "env",
    "configured": true
  }
}
```

For unavailable keychain storage:

```json
{
  "status": {
    "ref": "keychain:provider_local",
    "kind": "keychain",
    "configured": false,
    "errorCode": "secret_store_unavailable",
    "message": "Keychain secret store is unavailable in this runtime."
  }
}
```

This endpoint is read-only and never returns a raw secret value.

## Approval Policy and Requests

Approval requests are persisted in the workspace SQLite database and can be listed or resolved through the daemon. v0.1 stores approval decisions, defaults product runs to read-only tools, and pauses Pi tool execution before `bash`, `edit`, or `write` proceeds.

### Workspace Policy

Approval policy controls whether Ling Stack automatically allows, asks for approval, or denies tool execution. It is workspace-scoped in v0.1.

Default policy:

```json
{
  "toolDecisions": {
    "read": "allow",
    "grep": "allow",
    "find": "allow",
    "ls": "allow",
    "bash": "ask",
    "edit": "ask",
    "write": "ask"
  },
  "allowedWritePaths": ["."]
}
```

`allowedWritePaths` entries are resolved relative to the run execution `cwd` unless they are absolute paths. `edit` and `write` requests outside these scopes are denied before they reach the approval inbox.

### Get Approval Policy

```http
GET /approval-policy?cwd=/path/to/workspace
```

Response:

```json
{
  "cwd": "/path/to/workspace",
  "policy": {
    "workspaceId": "workspace_default",
    "toolDecisions": {
      "read": "allow",
      "grep": "allow",
      "find": "allow",
      "ls": "allow",
      "bash": "ask",
      "edit": "ask",
      "write": "ask"
    },
    "allowedWritePaths": ["."],
    "createdAt": "2026-05-20T00:00:00.000Z",
    "updatedAt": "2026-05-20T00:00:00.000Z"
  }
}
```

### Update Approval Policy

```http
PATCH /approval-policy?cwd=/path/to/workspace
Content-Type: application/json
```

```json
{
  "toolDecisions": {
    "bash": "ask",
    "edit": "ask",
    "write": "deny"
  },
  "allowedWritePaths": [".", "src", "docs"]
}
```

Tool decisions must be `allow`, `ask`, or `deny`.

### List Approvals

```http
GET /approvals?cwd=/path/to/project&status=pending
```

Optional query parameters:

- `status`: one of `pending`, `approved`, `denied`, `expired`, `cancelled`.
- `runId`: filter by run id.
- `mediaJobId`: filter by media job id.
- `limit`: integer from `1` to `500`, default `100`.

Response:

```json
{
  "cwd": "/path/to/project",
  "approvals": [
    {
      "id": "approval_...",
      "runId": "run_...",
      "taskId": "task-1",
      "channelId": "workspace",
      "actionType": "bash",
      "risk": "high",
      "title": "Run shell command",
      "description": "The agent wants to run a shell command.",
      "payload": {
        "type": "bash",
        "cwd": "/path/to/project",
        "command": "git status",
        "riskFlags": ["unknown_shell"]
      },
      "status": "pending",
      "createdAt": "2026-05-20T00:00:00.000Z"
    }
  ]
}
```

### Get Approval

```http
GET /approvals/:id?cwd=/path/to/project
```

### Approve or Deny

```http
POST /approvals/:id/approve?cwd=/path/to/project
POST /approvals/:id/deny?cwd=/path/to/project
Content-Type: application/json
```

Request body is optional:

```json
{
  "reason": "Reviewed locally."
}
```

Approval decisions append `approval_approved`, `approval_denied`, or `approval_expired` to the linked run event log when the run still exists. Listing or fetching approvals lazily normalizes pending requests whose `expiresAt` is already in the past.
Media cost approvals are owned by `mediaJobId`. Approving a Media Production request dispatches its direct-provider or workflow job; denying it fails the waiting job without contacting the external generation service. Historical approvals remain readable through the same endpoints.

## Current Limits

- HTTP client disconnect does not imply cancellation; callers must use `POST /runs/:id/cancel`.
- Cancellation is best effort and depends on Pi session abort behavior.
- Inline API keys are accepted in `/runs` for early development only; production desktop builds should use OS keychain or a local secret store.
- Media provider health checks are static config checks until media job execution exists.
- v0.1 does not expire provider `lastCheck` by time. Provider edits clear old check state; future versions can add TTL-based recheck prompts.
- Artifact content is local-only and must live under `.ling-stack/artifacts`.
