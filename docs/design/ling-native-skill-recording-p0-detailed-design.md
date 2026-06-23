# Ling-Native Skill Recording P0 Detailed Design

Status: detailed design for the first Web implementation of user-initiated skill
recording. Run Inspector and artifact evidence entry points are implemented in the first
slice; message overflow and Settings entry points remain follow-ups.

This design fills the gap between the existing `POST /skill-recordings` daemon entry and
a user-visible product surface. P0 is intentionally Ling-native: it records from existing
run, message, artifact, and workflow evidence instead of global macOS events.

## Goals

- Add a terminal-run `Save as Skill` entry in Run Inspector.
- Convert bounded run metadata into a reviewable `SkillRecordingObservationRequest`.
- Keep eligibility and duplicate suppression token-free.
- Reuse the existing `/skill-recordings` API, candidate routing, duplicate checks, and
  review workflow.
- Make duplicate outcomes visible before submission so users do not create parallel
  candidates for the same procedure.

## Non-Goals

- No global desktop event recording.
- No raw transcript or full artifact-body upload.
- No automatic model extraction on run list render.
- No automatic publication, teammate binding, runtime invocation, permission expansion, or
  `requestedSkillId` mutation.
- No new daemon-owned automatic post-run hook in P0.

## Entry Points

| Entry | P0 behavior |
| --- | --- |
| Run Inspector / terminal run | Primary entry. Opens a recording review sheet. Implemented. |
| Message overflow | Optional follow-up. Prefills a draft from selected message text and source refs. |
| Artifact / evidence panel | Secondary entry. Opens the same review sheet with selected artifact ids as source refs; artifact bodies are not submitted. Implemented. |
| Settings > Skill Library | Optional manual creation path for governance users. |

The review sheet is reusable across entry points. Message overflow should only be added
through an existing safe action slot, not by hardwiring recording into every message row.

## Run Inspector Eligibility

The `Save as Skill` button is visible when:

```text
run exists
  + run.status in ["succeeded", "failed", "cancelled"]
  + workspace skill recording is not known to be disabled
  + at least one bounded evidence source exists:
      task title, task prompt, tool events, validation/result events, selected skill id,
      summary path, event log path, or terminal status
```

The button may appear for failed or cancelled runs because the user may want to preserve a
troubleshooting procedure. Automatic recommendation must be stricter.

The non-blocking recommendation banner appears only when:

```text
run.status == "succeeded"
  + at least two unique tool labels or one selected skill id plus validation evidence
  + no obvious permission expansion phrase is present in task title/prompt
  + cheap duplicate precheck does not return append_evidence/update_existing/conflict_review
```

P0 can start with button visibility and omit the automatic banner if the cheap precheck
data is unavailable. The submit path still relies on the daemon duplicate gate.

## Draft Data Model

The Web sheet keeps a local draft:

```ts
interface RunSkillRecordingDraft {
  readonly runId: string;
  readonly workspaceCwd: string;
  readonly terminalStatus: "succeeded" | "failed" | "cancelled";
  readonly destinationHint: "skill" | "channel_protocol" | "playbook" | "automation" | "memory";
  readonly title: string;
  readonly summary: string;
  readonly normalizedGoal: string;
  readonly positiveTriggersText: string;
  readonly negativeTriggersText: string;
  readonly procedureStepsText: string;
  readonly validationStepsText: string;
  readonly toolLabels: readonly string[];
  readonly validationLabels: readonly string[];
  readonly artifactRefs: readonly string[];
}
```

The API request is derived only at submit time:

```ts
interface SkillRecordingObservationRequest {
  runId?: string;
  channelId?: string;
  teammateId?: string;
  taskId?: string;
  selectedSkillId?: string;
  terminalStatus?: "succeeded" | "failed" | "cancelled";
  toolLabels?: readonly string[];
  validationLabels?: readonly string[];
  artifactRefs?: readonly string[];
  destinationHint?: "skill" | "channel_protocol" | "playbook" | "automation" | "memory";
  title: string;
  summary: string;
  normalizedGoal: string;
  positiveTriggers?: readonly string[];
  negativeTriggers?: readonly string[];
  procedureSteps?: readonly ProcedureObservationStep[];
  validationSteps?: readonly ProcedureObservationValidationStep[];
  confidence?: "low" | "medium" | "high";
  reusableScore?: number;
}
```

## Field Mapping

| Request field | P0 source |
| --- | --- |
| `runId` | `RunSession.id` |
| `channelId` | `RunSession.channelId` |
| `teammateId` | `RunSession.teammateId` |
| `taskId` | `RunSession.taskId` |
| `selectedSkillId` | `RunSession.selectedSkillId` |
| `terminalStatus` | `RunSession.status` when terminal |
| `title` | `taskSnapshot.title`, fallback `Recorded run {shortRunId}` |
| `summary` | bounded summary from run status, provider, tool count, selected skill |
| `normalizedGoal` | normalized task title or prompt first line |
| `positiveTriggers` | title plus selected skill name when present |
| `negativeTriggers` | default `["one-off chat", "sensitive access changes"]` until user edits |
| `toolLabels` | unique `toolName` values from `tool_*` events |
| `validationLabels` | terminal/result event labels and explicit validation event summaries |
| `procedureSteps` | one step per unique tool label, editable |
| `validationSteps` | one terminal validation step, plus result/error evidence when present |
| `artifactRefs` | artifact ids when supplied by the caller; omitted in Run Inspector P0 if not loaded |

The draft sheet must make title, summary, triggers, steps, and validation editable before
submit.

## Cheap Duplicate Precheck

P0 should avoid model calls for duplicate suppression. The first implementation can use
a local heuristic:

```text
fingerprint =
  normalizedGoal
  + selectedSkillId
  + sorted toolLabels
  + sorted validationLabels
  + channelId
  + teammateId
```

If `selectedSkillId` is present, show an informational duplicate hint:

```text
This run already used skill {selectedSkillId}. New recordings should usually append
evidence or improve that skill instead of creating a separate candidate.
```

The authoritative duplicate gate remains daemon-side. If `/skill-recordings` returns
`evidence_recorded`, `blocked`, or a duplicate decision, the UI must show that result and
not claim a new candidate was created.

P1 adds a daemon read-only eligibility endpoint:

```http
GET /skill-recordings/eligibility?cwd=...&runId=...
```

That endpoint reads the run and bounded events from the daemon store, builds the same
recording observation shape used by `POST /skill-recordings`, runs route and duplicate
analysis, and returns `visible`, `recommended`, `reasonCode`, `actionHint`, `route`, and
`duplicateAnalysis` without creating observations, candidates, embeddings, or model calls.

## Review Sheet State Machine

```text
closed
  -> opened_prefilled
  -> editing
  -> submitting
  -> submitted_candidate_created
  -> submitted_evidence_recorded
  -> submitted_blocked
  -> error
```

State behavior:

- `opened_prefilled`: build draft from run and events.
- `editing`: user can modify destination, title, summary, triggers, steps, and validation.
- `submitting`: call `recordSkillRecording(workspaceCwd, request)`.
- `submitted_candidate_created`: show candidate id and route to Skill Library review.
- `submitted_evidence_recorded`: show duplicate or policy reason.
- `submitted_blocked`: show route blockers or daemon error.
- `error`: keep the sheet open and preserve edits.

## UX Copy

Use direct, bounded copy:

- `Save as Skill`
- `Review recording`
- `No model call is used for this precheck.`
- `Recording creates a candidate, not an active skill.`
- `Duplicate match`
- `Append evidence to existing`
- `Create candidate`

The sheet should not describe implementation details such as `ProcedureObservationJob`
unless the user opens debug details.

## Token Boundary

No token usage:

- Button visibility.
- Run metadata prefill.
- Duplicate hint from selected skill id.
- Draft editing.
- `/skill-recordings` submission.
- Displaying daemon duplicate or policy result.

Potential future token usage:

- Optional extraction from a selected transcript snippet.
- Optional summarization of long run evidence after the user opens the sheet.

P0 ships without model extraction.

## Error Handling

- If recording mode is disabled, show the daemon `skill_recording_disabled` message and
  link the user to Skill Governance settings.
- If the daemon returns `evidence_recorded`, show the duplicate/policy reason and source
  refs, not a success message saying a new skill exists.
- If validation steps are empty, allow submit only with an explicit low-confidence draft
  warning or require the user to add a validation line. P0 should default to requiring at
  least one validation line.
- If the run is not terminal, disable the button with `Run must finish before recording`.

## Test Matrix

| Scenario | Expected result |
| --- | --- |
| Successful terminal run with tool events and validation | Sheet opens, request submits, candidate created response shown. |
| Successful terminal run with `selectedSkillId` | Sheet shows duplicate hint; daemon duplicate response is respected. |
| Failed run | Button visible, no automatic recommendation, draft defaults to troubleshooting wording. |
| Running run | Button disabled or hidden. |
| Recording disabled | Submit returns disabled message, no candidate claim. |
| Missing validation | Sheet requires a validation line before submit. |
| Daemon duplicate response | UI reports evidence recorded/update path, not a new candidate. |

## Implementation Notes

- Keep the draft builder in a small Web helper so it can be unit-tested later without
  rendering the full inspector.
- Keep styling inside existing inspector/card patterns; no nested cards.
- Keep all text responsive. Long IDs should wrap in code blocks or small meta rows.
- Do not add backend storage in P0.
