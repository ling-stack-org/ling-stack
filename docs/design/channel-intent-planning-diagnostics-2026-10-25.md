# Channel planning: bounded repair and durable safe diagnostics

## Evidence and scope

R6's packaged single-command request stopped before proposal/Run admission. Its
stored decision has only `execution.operations`; the candidate and actual model
request count cannot be recovered. This change does not claim to recover them or
identify the historical malformed field. Static admission currently collapses
all candidate schema errors into the same field and then asks the user to relist
operations. That error handling is reproducible offline.

## Contract

- The existing strict candidate validator also produces the first schema issue.
  Paths contain only Host schema names (`operations[]`, not model keys/values or
  operation IDs); codes distinguish absent/type/value/array/extra-field errors.
  No second, weaker admission schema is introduced.
- Each selection uses a fresh Host selection ID. Existing `control_plane_events`
  in the runners domain record source/channel/selection IDs, request ordinal,
  purpose, request outcome and schema/binding outcome. Record no raw prompts,
  candidates, commands, exception text, file paths, unknown keys or model reasons.
  Reopening SQLite must retain these observations; started without finished means
  unknown, not success. Diagnostics confer no execution authority.
- A diagnostic persistence failure remains a Host error, not a model failure.
  It must neither dispatch work nor become an ordinary reply/clarification.
- Initial selection, compaction retry, format repair and binding repair share the
  existing maximum of two actual requests. Preserve source/owner/cwd/capability
  checks; do not guess a graph, normalize a command or fall back to old planners.
- Explicit model `clarify` remains available for genuinely missing user decisions.
  An execute/proposal candidate still rejected by the Host becomes a durable
  `channel_operation_plan_invalid` blocker: no teammate/tool/task was started.
  Do not ask the user to invent file inputs for a no-file command.
- Include a complete, illustrative no-file single-command candidate in selector
  instructions. Omit optional inputs/target/content/cwd at workspace root. Example
  strings are not a source registry and must never be copied as authority.

## Verification

Offline fake-adapter/temporary-SQLite cases: exact single Engineer command with
zero file grants; missing execution, empty operations, wrong version, empty inputs,
extra keys; repaired success; invalid/escape/transport repair; shared compaction
budget; ordinary reply and explicit clarification; durable replay; no private
diagnostic values; diagnostic write failures preserve Host error identity.

These checks do not replace a later frozen packaged channel approval case. Do not
rewrite the old R6 source/decision or rerun already accepted unrelated cases.

## Implementation checkpoint

Implemented with the existing control-plane store; no new SQLite table or real
history mutation. Daemon build passes. Final relevant regression coverage is
403 distinct cases across 16 files: operation/intent matrix 144, workspace 232,
remaining direct selector consumers 27. Workspace was split into exact disjoint
78/77/77 sets without increasing the 60-second capture bound; unchanged first-set
bodies/helpers were byte-proven reusable after a separate second-set test edit.
The 19 new diagnostics tests are included in 144, not additional tests.

Independent read-only review of five production and six test files has no open
actionable finding. Historical capture150 remains incomplete; RED/setup failures
are preserved. This is not packaged acceptance. The new shared modules must enter
the explicit reviewed Office source closure and successor QA packet before the
new App is built. The currently running R6 App contains neither this repair nor
the preceding TerminalReport command-evidence repair.
