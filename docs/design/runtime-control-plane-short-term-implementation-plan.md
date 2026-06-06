# Runtime Control Plane Short-Term Implementation Plan

## Purpose

This plan covers the highest-value short-term work from
[Runtime Control Plane Roadmap](runtime-control-plane-roadmap.md):

1. skill template backfill and overlay semantics;
2. skills registry refresh;
3. daemon restart and doctor hardening.

The goal is to fix real drift seen in the product today without introducing a new
Codex app-server protocol or changing Ling's HTTP/SSE daemon API.

## Motivation

The QA teammate exposed two separate problems:

- the running daemon served stale routes until it was restarted;
- existing built-in teammates kept old default skill bindings after the built-in
  template changed.

The first problem is daemon lifecycle and diagnostics. The second is template overlay.
Both are control-plane problems: clients should ask the daemon for the effective state,
and the daemon should make that state current and inspectable.

## Scope

In scope:

- backfill missing current template default skills for existing built-in teammates;
- preserve durable user overrides when backfilling;
- expose a lightweight skills registry refresh path;
- finish or verify daemon lifecycle commands and read-only doctor checks;
- update API client and Web refresh behavior only where needed for this slice;
- add targeted unit/API tests.

Out of scope:

- Codex app-server JSON-RPC;
- file-system skill watchers;
- distributed or remote daemon management;
- changing active run snapshots after a run has started;
- broad UI redesign.

## Slice 1: Skill Template Backfill And Overlay

### Current Behavior

Built-in templates live in `packages/core/src/builtin-skill-packs.ts`.

`SqliteRunStore.ensureDefaultAiTeammates()` creates missing built-in teammates and
seeds template skill bindings. For existing teammates, it only reseeds bindings when the
teammate has zero skill bindings.

That means an older built-in QA teammate with `qa` and `investigate` will not pick up
new template defaults such as `qa-only`, `design-review`, `devex-review`, and
`benchmark`.

### Target Behavior

Built-in teammates use this effective model:

```text
current built-in template defaults
+ durable user-added skill bindings
+ durable enabled/disabled state
- tombstoned teammate records
= effective teammate skill bindings
```

Backfill should add missing current template defaults for existing built-in teammates.
It must not reset user-owned state.

### Implementation

Primary files:

- `packages/core/src/storage/sqlite-run-store.ts`
- `packages/core/src/builtin-skill-packs.ts`
- `packages/core/test/ai-teammate-workspace.test.mjs`
- `packages/core/test/skill-packs.test.mjs`

Add a small store helper instead of using `replaceTeammateSkillBindings()` for backfill:

```ts
private backfillTemplateSkillBindings(
  teammateId: string,
  template: AiTeammateTemplate,
  now: string,
): boolean
```

Rules:

- no-op if the teammate does not exist;
- no-op if the teammate is tombstoned;
- insert missing `template.defaultSkillIds` with `source = "template"` and
  `enabled = true`;
- preserve existing rows exactly, including `enabled`, `source`, `created_at`, and
  `updated_at`;
- preserve user-added non-template rows;
- do not delete rows for skills that are no longer in the template in this slice.

Change `ensureDefaultAiTeammates()`:

- for new built-in teammates, keep current seeding behavior;
- for existing built-in teammates, call `backfillTemplateSkillBindings(...)` every time
  the store initializes;
- keep current channel/task id repair behavior.

Do not call `replaceTeammateSkillBindings()` for this automatic backfill. That method is
still useful for explicit user saves, but it deletes and reinserts rows, which is too
destructive for startup migration.

### Tests

Add targeted tests:

- old QA teammate with only `qa` and `investigate` becomes the current template default
  superset after store initialization;
- disabled existing template binding stays disabled;
- user-added custom binding remains present;
- tombstoned built-in teammate is not recreated or backfilled;
- running `ensureDefaultAiTeammates()` twice is idempotent.

Acceptance checks:

```bash
corepack pnpm --filter @ling-stack/core test
corepack pnpm --filter @ling-stack/daemon test
```

## Slice 2: Skills Registry Refresh

### Current Behavior

`packages/daemon/src/features/skills/registry.ts` builds the effective registry from:

- built-in skills from `listDefaultSkills(GSTACK_DEFAULT_SKILL_PACK_ID)`;
- durable custom skill registry entries from the store.

`GET /skills?cwd=...` returns the effective registry. Built-ins are code-loaded, so a
daemon restart is still required after code changes. Durable custom skill changes are
available through store reads, but there is no explicit refresh operation or registry
metadata for clients to reason about.

### Target Behavior

Add an explicit refresh operation that is cheap today and becomes the future hook for
file/plugin scanning.

Proposed endpoint:

```text
POST /skills/refresh?cwd=/path/to/project
```

Response:

```ts
interface SkillsRefreshResponse {
  cwd: string;
  refreshedAt: string;
  registryGeneration: number;
  skills: SkillRegistryEntry[];
}
```

For the first slice:

- refresh recomputes the effective registry;
- built-in entries still come from code;
- custom entries still come from SQLite;
- `registryGeneration` can be process-local if no durable generation exists yet;
- no file watchers are added.

### Implementation

Primary files:

- `packages/daemon/src/features/skills/registry.ts`
- `packages/daemon/src/features/skills/routes.ts`
- `packages/daemon/src/server/routes.ts`
- `packages/api-client/src/client.ts`
- `packages/api-client/test/client.test.mjs`
- `packages/daemon/test/plugin-manager-api.test.mjs` or a new focused skills API test

Add route parsing for `/skills/refresh`. Keep it a `POST` because refresh is an
operation even when it is read-only in this first implementation.

Add API client method:

```ts
refreshSkills(cwd: string): Promise<SkillsRefreshResponse>
```

Web use:

- call refresh after skill import publish/archive when the UI needs immediate registry
  consistency;
- do not make normal settings refresh depend on this endpoint;
- keep current `GET /skills` as the normal read path.

### Tests

Add daemon/API client tests:

- `POST /skills/refresh` returns built-in and custom skills;
- duplicate skill ids are de-duplicated with built-ins taking precedence;
- archived custom skills stay hidden unless an existing include option explicitly asks
  for them;
- response is stable when called twice.

Acceptance checks:

```bash
corepack pnpm --filter @ling-stack/daemon test
corepack pnpm --filter @ling-stack/api-client test
```

## Slice 3: Daemon Restart And Doctor Hardening

Detailed daemon lifecycle design already lives in
[Daemon Lifecycle and Doctor P0](daemon-lifecycle-p0.md). This slice is the short-term
execution checklist that connects it to the skill/registry issue.

### Target Behavior

Users should not need to find stale screen sessions or stale pid files manually.

Required commands:

```text
ling-stack daemon start --cwd /path/to/project
ling-stack daemon status --cwd /path/to/project
ling-stack daemon stop --cwd /path/to/project
ling-stack daemon restart --cwd /path/to/project
ling-stack daemon logs --cwd /path/to/project
ling-stack doctor --cwd /path/to/project
```

Doctor remains read-only. Restart is explicit and separate from doctor.

### Implementation Checks

Primary files:

- `packages/cli/src/daemon/state.ts`
- `packages/cli/src/daemon/process.ts`
- `packages/cli/src/daemon/logs.ts`
- `packages/cli/src/doctor/checks.ts`
- `packages/cli/src/main.ts`
- `packages/cli/test/daemon-lifecycle.test.mjs`
- `packages/cli/test/doctor.test.mjs`
- `docs/daemon-api.md`

Doctor should include check rows for:

- daemon lifecycle metadata exists and is parseable;
- recorded pid is alive or stale;
- configured port listener matches the expected daemon;
- `/health` is reachable when a listener exists;
- `/memory/review-policy` route is reachable and returns policy shape;
- `/skills` route is reachable and returns effective registry shape;
- provider preflight and keychain checks remain redacted;
- active run and stuck work diagnostics are bounded.

Do not make doctor call `POST /skills/refresh` or any repair endpoint.

### Tests

Add or verify tests:

- restart stops the recorded daemon and starts a new one;
- restart detects stale pid metadata and recovers without force when no live process
  exists;
- restart requires explicit force or refusal when active work is detected;
- doctor JSON is redacted and still works when the daemon is down;
- doctor reports stale listener or route mismatch as warning/fail without mutating state.

Acceptance checks:

```bash
corepack pnpm --filter @ling-stack/cli test
corepack pnpm --filter @ling-stack/daemon test
```

Manual smoke:

```bash
corepack pnpm --filter @ling-stack/daemon build
corepack pnpm --filter @ling-stack/cli build
node packages/cli/dist/index.js --cwd /tmp/ling-smoke daemon restart
node packages/cli/dist/index.js --cwd /tmp/ling-smoke doctor --json
curl -sS "http://127.0.0.1:17891/memory/review-policy?cwd=/tmp/ling-smoke"
curl -sS "http://127.0.0.1:17891/skills?cwd=/tmp/ling-smoke"
```

## Rollout Order

1. Implement skill template backfill first. It fixes existing workspace drift without UI
   or API changes.
2. Add skills registry refresh endpoint and API client method.
3. Finish daemon restart/doctor checks or verify the existing implementation against
   this checklist.
4. Update Web settings refresh behavior only after the daemon/API behavior is stable.

## Done Criteria

- Existing built-in QA teammate backfills to the current default skill set.
- Existing disabled skill state and custom skill bindings survive backfill.
- `/skills` and `/skills/refresh` agree on effective registry content.
- `ling-stack daemon restart` replaces stale daemons without manual screen/process work.
- `ling-stack doctor --json` can identify stale daemon, stale routes, skill registry
  readiness, and memory policy readiness without repairing state.
- Tests listed above pass.
