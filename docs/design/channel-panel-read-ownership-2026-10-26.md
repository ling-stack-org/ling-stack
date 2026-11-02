# Channel panel read ownership

## Contract

The selected channel's dock and activity panels are owned by the exact trimmed
workspace path and channel ID. They are channel-wide: selecting another topic
or branch in the same channel does not invalidate them. Transcript ownership
continues to include its thread ID and is independently enforced.

A keyed request revision alone is insufficient. A response for channel A can
remain the latest A request after the user selects B. Comparing only the path
and ID also admits A-to-B-to-A responses from the earlier visit.

Each channel-panel read therefore captures an owner identity and its keyed
request revision. Admission rejects a request for a nonselected owner. Success,
failure and loading updates require both identities still to be current. Each
React state updater repeats the check when applied, not only when scheduled.
Reset invalidates the owner identity without reusing its previous lifetime.

Already populated panel values are cleared before React commits a different
channel owner, rather than remaining visible until the next HTTP response.
Task navigation may inject a target task and explicitly select it in that same
React batch. On channel changes within one workspace, task rows are filtered by
the new channel ID rather than all discarded. Explicit task-selection revisions
preserve that batch's navigation intent even before its task HTTP row arrives;
background read updates never count as explicit navigation. Without a new
explicit selection the old selection is cleared. Workspace changes discard all
previous task rows even if the channel ID happens to match.
Protocol loading has a second asynchronous workflow-step stage; that stage
cannot publish after navigation either. Source history, submission acceptance,
Host effects and retry identities are not changed by these read protections.

## Consumers

The same local read guard covers execution proposals, attachments/link previews,
message-route decisions, intent decisions, full protocol/workflow reads, tasks,
the channel council, governance notifications, run artifacts, execution actions
and activity transitions. Workspace-wide provider/memory/council-list reads and
mutating operations have separate ownership and are not certified by this slice.

## Verification

`workspace-panel-scope.regression-1.browser.mjs` runs the actual workspace Hook,
React state and existing request guard with synthetic deferred HTTP responses.
It covers old-owner requests at entry and completion, workspace changes,
A-to-B-to-A, failure/loading state, latest-request precedence, populated panels,
branch-only continuity, queued state updaters and nonempty workflow-step reads.
It also covers task injection before/after channel selection in a single batch,
settings-return selection before task hydration, and cross-workspace task reset.
Only the application time of setters is held in the queued-updater scenario;
the resulting updates are applied by real React. No production seam is added.

These regressions and the ordinary Web suite do not establish packaged GUI,
real SSE reconnect, Daemon restart or Provider evaluation acceptance. A frozen
successor QA package and actual client observations remain required.
