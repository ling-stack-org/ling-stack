# Managed Official Skill Source P16

## Related Docs

- [Skill Source Sync Simplification P15](skill-source-sync-simplification-p15.md)
- [GStack Skill Source Sync](gstack-skill-source-sync.md)
- [GStack Source Upgrade Lifecycle](gstack-source-upgrade-lifecycle.md)
- [Settings Shell](./ui2.0升级/modules/settings/README.md)

## Status

Implemented active contract. The managed official cache, subscription state, refresh,
preview and trusted explicit publish path supersede P15's persisted local-checkout
connection as the normal source-sync mechanism.

Owner: Skill source sync
Last verified: 2026-08-03

## Summary

Official skill updates are a Ling-managed maintenance operation. A user should not
install, locate, update, or connect a local gstack checkout before receiving official
skills.

```text
User clicks Sync updates
  -> Ling refreshes its own managed official-source cache
  -> Ling verifies the expected official repository and resolved revision
  -> Ling scans the cache at that immutable revision
  -> Ling imports all parseable new and changed skills into the workspace
  -> Ling records the source revision and reports the result
```

The normal UI calls this feature `Official skill updates` (Chinese: `官方技能更新`).
`gstack` remains an implementation and provenance identifier, not primary product copy.

## Problem

The P15 local-connection flow requires a user to have and maintain a gstack checkout:

```text
User updates gstack locally
  -> Ling rediscovers or reconnects that checkout
  -> User clicks Sync updates
```

That creates an unnecessary two-step maintenance burden, makes results depend on a
machine-specific path, and invites confusion between the official upstream and unrelated
local skill folders. It is appropriate only for developer support and offline workflows,
not the standard product path.

## Product Decision

Ling owns one managed cache of the official `github.com/garrytan/gstack` source under its
user data root. The cache is not a workspace file, is not user-configurable in the Skill
Library, and is never exposed as a local path.

Ling does not scan any of the following for routine source sync:

- `~/.codex/skills` or `~/.agents/skills`;
- workspace `.agents/skills` directories;
- arbitrary directories named `gstack`;
- a user-selected checkout.

Manual custom skills remain explicit: users create a skill or import Markdown through the
existing My Skills workflow. A future enterprise/offline source integration can be a
separate, explicitly configured source type; it must not weaken this official-source
contract.

## Managed Source Contract

### Identity

The only default source descriptor is immutable application code:

```ts
const officialGstackSource = {
  id: "official-gstack",
  originUrl: "https://github.com/garrytan/gstack.git",
  ref: "main",
};
```

The daemon derives its cache location from `LING_STACK_HOME` / Ling's user data root,
for example `~/.ling-stack/sources/official-gstack`. The derived path is internal and is
not persisted in workspace settings or returned by Web APIs.

### Refresh And Verification

On every explicit `Sync updates` request, the daemon:

1. Creates the managed cache if it does not yet exist, otherwise fetches the configured
   ref from the configured official origin.
2. Verifies the cache is a Git worktree whose normalized `origin` is exactly
   `github.com/garrytan/gstack`.
3. Resolves the requested ref to an immutable commit and checks out that detached
   revision in the managed cache.
4. Verifies `.agents/skills` exists and derives the upstream package version when
   available.
5. Scans only that checked-out skills directory.

If Git is unavailable, the official origin cannot be reached, the repository identity is
wrong, or the skills directory is unreadable, the operation fails before writing any
workspace skill state. The persistent error is outcome-oriented and never leaks a local
filesystem path.

Ling does not run `git pull` in a user-owned checkout, does not update a user's Codex
installation, and does not install gstack's host runtime. It only refreshes its private
source cache.

### Workspace Publishing

The managed source cache is user-global; published skills and source snapshots remain
workspace-scoped. A successful apply:

- imports all parseable new and changed official skills directly;
- counts unchanged skills without rewriting them;
- archives replaced source snapshots using the existing history behavior;
- copies source artifacts from the checked-out immutable revision;
- records upstream origin, version, commit, and completion time with the workspace
  source subscription.

There is no review queue, selected-record list, or local-path approval step. Existing
run-time policy, approval, tool, and permission gates still govern what an imported skill
can do when it is invoked.

The registry mutation is all-or-nothing for the scanned revision: a missing, unreadable,
or unparseable required source prevents a partial update. A later retry reuses the managed
cache only after the daemon has again verified the origin and revision.

## Data Ownership

```text
User data root
  sources/official-gstack/       private managed Git cache

Workspace SQLite state
  official_skill_source_subscriptions
    source id, origin, ref, last synced commit, version, timestamps
  skill source snapshots
    skill-level checksums, immutable provenance, artifacts, history
```

The previous `gstack_source_connections` data model represents a user-owned local path.
It is retired by a forward migration. It contains only a connection pointer, so removing
it does not remove existing skill registry entries, snapshots, bindings, or histories.

## UI Contract

The Source Sync tab retains a deliberately compact shape:

- title: `Official skill updates` / `官方技能更新`;
- status: latest official version or a concise unavailable state, plus last successful
  workspace sync time when known;
- one action: `Sync updates` / `同步更新`;
- after success: `Synced N` and `Unchanged N`.

There is no `Connect gstack`, local-source count, source path, local checkout version,
preview, refresh, check, publish, advanced source settings, or health-diagnostic wall.

`Sync updates` is both the check and apply action. A normal unchanged result says the
workspace is already current. A real fetch or validation failure stays visible in the
result area until the next successful request; success feedback is a toast.

## API Contract

`POST /skills/sync/gstack/apply?cwd=...` becomes the only normal mutation endpoint. It
accepts no source path, root, repository, or policy input. Its response includes:

- `completedAt`;
- `summary.synced` and `summary.unchanged`;
- sanitized official source metadata: origin, revision, optional version;
- only skill and snapshot records written by this operation.

`GET /skills/sync/gstack/status?cwd=...` returns the latest sanitized subscription state.
It never fetches or scans and never exposes cache paths.

The old connection endpoints are retired from Web and are not used to discover local
repositories. Legacy preview/publish endpoints may remain as internal compatibility
capabilities until their callers are removed, but they are not part of this user flow.

## Security And Reliability Invariants

- The origin URL and ref are application-owned constants, never Web input.
- The daemon validates the normalized origin after every cache refresh.
- Workspace state stores commit provenance, not a private source path.
- The cache is under Ling user data and may be safely recreated.
- A failed refresh never changes user-owned gstack or Codex installations.
- Source instructions never grant tools, credentials, approval bypasses, browser access,
  deployment authority, or external-send authority.
- All displayed errors are localized product messages; raw Git stderr remains in daemon
  logs only.

## Non-Goals

- No background auto-update or silent network fetch in this slice. Refresh occurs only
  after the explicit user action.
- No registry marketplace or arbitrary remote URL field.
- No pull, update, or installation of a user's existing gstack/Codex checkout.
- No support for local custom skill auto-discovery in the official-source flow.
- No changes to skill execution, teammate bindings, snapshot history, or deletion rules.

## Acceptance

- A fresh user can click `Sync updates` without installing or locating gstack.
- Ling fetches only the official repository into a Ling-owned cache and validates it.
- The UI exposes no local filesystem path or gstack connection action.
- A source refresh imports all parseable new and changed skills atomically.
- A second request with the same revision reports unchanged records.
- Git/network/identity failure makes no workspace skill writes and produces a persistent,
  path-free error.
- Existing user-local source-connection records no longer participate in normal sync.
