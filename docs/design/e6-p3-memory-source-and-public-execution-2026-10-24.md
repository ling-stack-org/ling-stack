# P3 Memory source binding and public execution views

Status: implementation/integration follow-up, not packaged acceptance or release approval.

## Cause

Accepted workflow execution input must retain exact task lineage. Previously the
rendered workflow Context Pack included private role Memory in that task text.
Freezing it made the leak visible in Task/Run/WorkUnit snapshots and canonical
system dispatch turns. Filtering only `preselectedMemoryUse` was insufficient:
the frozen SDK input and continuation system prompts carry the same private body.

Separately, recording Memory use updated `updatedAt`, so using an unchanged
source could invalidate the workflow context stamp that had just consumed it.

## Internal execution contract

1. The Context Pack still budgets and stamps retained role evidence. Its role
   body is excluded from the accepted task and is hydrated once as private system
   instructions. A dropped role section is not silently reintroduced.
2. Initial selection carries Host-only `sourceRevisions`: exact retained IDs and
   canonical SHA256 of each actual recalled `MemoryObject`, excluding only
   observational `lastUsedAt`. Scope, enabled/review state, semantic text and
   `updatedAt` remain significant. Current eligibility also rejects expired or
   superseded sources; independent usage counts are not semantic revisions.
3. Pi and native validate selection before hydration and after asynchronous
   preparation. Missing revision, changed source or lost eligibility fails
   closed before execution. Native also checks its later Host authority gates.
4. Frozen Pi recovery reuses exact accepted SDK input and its existing eligibility
   guards. It does not recall again, reinterpret a task or replay from a public
   snapshot. Native restart policy remains `stop_without_resume`.
5. Durable used-Memory evidence contains only IDs, recall query and policy
   version, never the one-time rendered prompt/revision object. Native use is
   recorded only after a journaled `nativeTurnId`, including accepted input
   followed by a failure. Availability checks alone are not model-use facts.
6. A use record updates `lastUsedAt`, not semantic `updatedAt`. Editing a source
   still changes the semantic revision and context freshness verdict.

## Public transport contract

- Run-owned public snapshots omit the known internal top-level fields
  `runnerExecutionInput`, `preselectedMemoryUse`, `systemPrompt`, and
  `appendSystemPrompt`. Stored objects and internal recovery remain untouched.
- Public workflow task snapshots omit internal `prompt`, including older
  rendered inputs. They retain identity/title/channel metadata. Do not sanitize
  by searching text or recursively deleting similarly named user/tool fields.
- Historical system dispatch turns/items require typed workflow ownership.
  Their public text must not expose old internal input or claim that an editable
  current objective is the original historical instruction. Ordinary user turns
  and answers retain their own text. Missing provenance cannot authorize a raw
  fallback. This boundary also applies to thread/fork/preview and channel item
  transport views, without modifying stored history or internal context building.
- Public workflow Thread objectives and Host dispatch text use a fixed private-input
  description, not today's editable step prompt. Search removes private source
  snippets and private-only matches. Local-user follow-ups, Q&A anchors and tool
  payloads keep their typed data. A missing Turn cannot restore a dispatch body.
- Historical generic resume Runs can lack `workflowStepId`. Public Run and
  Run-owned WorkUnit projections therefore also consult the owning Store's
  persisted Thread kind; every transport caller passes its resolved Store.
  Generic workflow resume is rejected before preparation/dispatch. Its preview
  retains public counts/IDs and the new user instruction, never rendered internal
  history. Workflow continuation must use Host workflow-step controls.
- Apply the same WorkUnit projection to nested private runtime/control responses
  and supervisor active/stuck/queued/stale collections. Do not change service
  objects used by cancellation or scheduling.
- Workflow retry/continuation remains Host-owned. A generic snapshot rerun must
  not manufacture a separate task from a public workflow view. Web controls and
  the request builder share the same capability check. Ordinary explicit task
  rerun does not replay cached private system hydration.

## Verification and limits

The tests must demonstrate actual owner-scoped private SDK input, unchanged
internal recovery, full-response public canaries, selection/await races, semantic
edits versus observational use, and no fabricated native use before acceptance.
Negative controls disable the exact new guard and must fail the regression.

Current implementation/test receipts are tracked in
`output/e6-20260928/p3-current-checkpoint-20261023.md`. A real new QA package and
remaining client/recovery/delegation/Office/H09 acceptance are separate gates.
Passing a synthetic HTTP fixture is not live GUI or model evidence.
