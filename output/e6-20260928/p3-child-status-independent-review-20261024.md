# P3-C01-002 — participant state is not its display color

## Real symptom and cause

Original stage-A GUI and public Host evidence are retained in
`p3-live-20261024/c01-checkpoint-{blocked.png,blocked-full-ax.txt,host-lineage.json}`.
Engineer Run failed, step blocked, approvals empty, but child header read waiting
for approval. This is not a Host approval fact and cannot authorize a new decision.

Workflow adapter produced tone=waiting for blocked, and the WorkCell fallback
projector inferred lifecycle=waiting from that color. Renderer translated generic
Waiting as approval. Canonical participant projection already preserved typed
lifecycle correctly; that path is unchanged.

The adapter now supplies explicit lifecycle, Core projects both lifecycle/status,
and UI uses the supplied display stateLabel only as text. Color and localized
text never decide state. Workflow and collaboration adapters retain cancellation,
queued and terminal states. User-input wait remains distinct from approval wait.

## Independent findings and closure

Read-only reviewer `/root/p3_child_status_review` confirmed the original error
with independent Node probes. Final-delta review found two additional multi-step
failures: an earlier queued row masked a later input-wait focus; mixed done plus
cancelled groups fell through to waiting. Both serial and parallel mirrors were
repaired. Six aggregate regressions first failed (saved RED log), then passed;
they now require a source-bound child narrative fixture, not a conditional assert.

Final independent selected scope: zero remaining confirmed findings. Reviewer
ran Core/Web selected tests 48/48, no skip, actual exit0; Web tsc and range
diff-check exit0. It did not edit files, rebuild dist, operate a DB or validate GUI.

Primary verification: Core full UI projection suite 197/197 and affected Web
matrix 120/120, zero skip, actual exit0; Web tsc exit0. Logs
`p3-child-status-core-green-20261024.log`, `p3-child-status-web-final-20261024.log`.
Original RED logs and failed aggregate probes remain. Not a whole-app GUI pass.

## Final reviewed SHA256

| Input | SHA256 |
| --- | --- |
| packages/conversation-ui-core/src/work-cell-view-model.ts | a909621e43ebe55e5960cc09ae76bca836b8f44a0620054e2b656c7664512180 |
| packages/conversation-ui-core/src/transcript-item.ts | b67cfebeb1da930f091b2ca3f94e784bfe8f0b6f3970e6ae4ebe795c2b01dffe |
| packages/conversation-ui-core/test/work-cell-view-model.test.mjs | 4788f4da01e2bae5d7aa27ad236311698f7da27595dad33dbe1efdeb9249f669 |
| apps/web/src/lib/workflow-progress.ts | fb0f353901d21ea162acda000557ba14290f6272711223ab1c4cfbd3fefdefc0 |
| apps/web/src/lib/collaboration-task-card.ts | b426a58d03a5f680530ff474c33c2ff230a054a248c9061016ed12872309da58 |
| apps/web/src/lib/collaboration-task-work-cell.ts | ab2add341167b13bf5286af843c8c07c00bd41cd2892167e9bf32d8ca05180a9 |
| apps/web/src/shared/conversation/timeline/ConversationTimeline.tsx | 8f192825622bcca055dc3e2f0bbfafdba81d6bb63b1125fa94d2116484cb0986 |
| apps/web/test/workflow-progress-identity.test.mjs | a3f8bc80fb7e44b5570296488a62309dcc8cd4a86dbc2a77567cd3d53f87e040 |

The original real failure remains unchanged. A reviewed new package must show
Blocked on that history and correct states for a new real collaboration before
claiming packaged acceptance. No publication or total E6 completion is implied.
