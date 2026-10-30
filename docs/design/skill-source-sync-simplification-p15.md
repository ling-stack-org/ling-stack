# Skill Source Sync Simplification P15

## Related Docs

- [Managed Official Skill Source P16](managed-official-skill-source-p16.md)
- [Settings Shell](./ui2.0升级/modules/settings/README.md)
- [Skill Capability Model And Library Simplification](skill-capability-model-and-library-simplification.md)
- [GStack Skill Source Sync](gstack-skill-source-sync.md)
- [External Agent Skill Discovery And Adoption](external-agent-skill-discovery.md) —
  separate contract for local shared `.agents/skills`; not part of the P15/P16 official
  source workflow.

## Summary

> Superseded for normal source acquisition by
> [Managed Official Skill Source P16](managed-official-skill-source-p16.md). P15 remains
> the historical record for collapsing the diagnostic UI into one sync action.
>
> Local shared `.agents/skills` discovery is also outside this document: it uses fixed
> roots, an explicit per-record confirmation, and its own endpoints. See
> [External Agent Skill Discovery And Adoption](external-agent-skill-discovery.md).

Source sync is a maintenance task, not a diagnostic console. The default flow is one
action: `Sync updates`. It imports a previously connected official gstack checkout into
Ling's skill registry. New and changed parseable gstack skills are both applied directly.

The normal page does not expose preview, refresh, check, publish, row selection, or
health diagnostics. Those APIs remain available for compatibility and support, but
they are no longer the ordinary user workflow.

## Default Flow

```text
First connection
  -> daemon looks for a bounded set of local folders named gstack
  -> each candidate must be a Git repository with .agents/skills and the official
     github.com/garrytan/gstack origin
  -> one candidate is saved automatically; no or multiple candidates show Connect gstack
  -> Connect gstack opens the native folder picker once and validates the chosen repo root

Sync updates
  -> daemon reads the saved gstack connection only
  -> new and changed parseable skills are published atomically
  -> unchanged items are counted without writes
  -> missing or unreadable source fails the sync before any writes
  -> page shows a compact synced / unchanged summary
```

`Sync updates` does not download, install, or upgrade gstack. It never guesses a fixed
home, workspace, or mounted-volume path, and it never falls back to Codex, Agents, or
project skill directories. Ling remembers the validated repository root and skills root
per workspace after the first connection. The UI never exposes that local path.

Automatic discovery is deliberately bounded: it only considers directories named
`gstack` under the current user's home folder and immediate mounted volumes, skips common
large/system directories, and has a traversal budget. A renamed checkout or any ambiguous
result uses the native picker instead of a broad disk scan. The gstack checkout is trusted:
source warnings, semantic differences, and referenced scripts or assets do not create a
confirmation queue. They remain preserved source metadata and runtime policy still
governs any risky action when the skill is used.

## Page Hierarchy

Default layer:

- connection status, current gstack source count, and last successful sync time;
- one `Sync updates` action when connected, or one `Connect gstack` action when a
  connection is needed;
- the latest compact summary: synced and unchanged. The browser
  restores this result after a page reload only when its completion time still
  matches the daemon-owned `lastCheckedAt`; otherwise it is discarded as stale.

There is no default attention, approval, source-root, or upgrade-policy layer. A
missing checkout, unreadable source, or parse failure is a persistent sync error with
one concise reason; the operation makes no partial registry writes. The old standalone
source-health diagnostic panel is not rendered by default.

## API Contract

`GET /skills/sync/gstack/connection?cwd=...` reads a saved connection or performs
bounded official-repository discovery. A unique candidate is saved automatically.
`POST /skills/sync/gstack/connect?cwd=...` invokes the native folder picker, validates
the selected repository root, and saves the connection. Both responses expose only
connection state, origin, version, and timestamps - never local filesystem paths.

`POST /skills/sync/gstack/apply?cwd=...` accepts the existing
`SkillSourceSyncRequest` and returns:

- `completedAt` and the refreshed source policy;
- an exclusive `synced / unchanged` summary;
- only the skills and snapshots that were written in this operation.

The daemon owns official-repository validation, persisted connection resolution, and
atomic writes. The Web app cannot submit paths or decide which records may be written.
Existing preview, refresh,
check-updates, and publish APIs stay intact as compatibility internals, but ordinary
source sync does not invoke them.

## Non-Goals

- Do not modify skill execution, teammate bindings, source snapshot history, or
  permanent-delete behavior.
- Do not make Ling install, pull, or update gstack itself.
- Do not scan Codex, Agents, workspace, configured, or manually entered skill roots
  from this page. A folder chooser is used only to make the initial official-repository
  connection when discovery is not unique.
- Do not replace the shared diagnostic APIs; only remove their default page placement.

## Acceptance

- Source Sync has one default mutation action, `Sync updates`.
- Sync reads only the persisted official gstack connection; a missing, moved, or invalid
  connection requires reconnecting before any source writes begin.
- A unique official local checkout is connected automatically. Zero or multiple matches
  require one native folder selection, after which the path is stored privately.
- Normal syncs show no all-record list, approval queue, advanced source controls, or
  standalone health section.
- The restored result belongs to the daemon's latest sync; successful completion
  feedback is transient.
- New, warning-bearing, and script-referencing local gstack skills are published with
  their source snapshots; unavailable sources fail before a partial write.
