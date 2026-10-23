import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { registerHooks, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS } from "../../../packages/daemon/src/runtime/sandbox/packaged-office-native-published-review.ts";
import { PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS } from "../scripts/packaged-office-native-review-inputs.mjs";
import { bundleInventory, digest, readExecutableBundle } from "../../../scripts/gstack/executable-bundle.mjs";

const repositoryRoot = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
const workspaceNames = ["browser-host", "contracts", "core", "daemon", "localization", "plugin-sdk", "providers", "remote-protocol", "runner-pi"];
const reviewedLeaf = "packages/core/src/original-office-host-bridge.ts";
const compiledLeaf = "packages/core/dist/original-office-host-bridge.js";
test("Office fixed closure pins the shared read-only P3 compaction projection", () => {
  assert.ok(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(
    "packages/daemon/src/features/conversations/context-compaction-projection.ts"));
});
test("Office fixed closure pins the cold-start protocol and Desktop stage controller", () => {
  for (const path of ["apps/desktop/main/daemon-lifecycle.ts", "packages/core/src/daemon-resource-bootstrap.ts",
    "packages/core/src/execution-engine-host-authority.ts", "packages/core/src/bundled-skill-source.ts",
    "packages/core/package.json", "packages/daemon/src/cli.ts"]) {
    assert.ok(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(path), `missing reviewed bootstrap input: ${path}`);
  }
});
const requiredQuestionAndApprovalClosureInputs = [
  "packages/core/src/storage/sqlite/user-input-admission-policy.ts",
  "packages/core/src/storage/sqlite/user-input-answer-authority.ts",
  "packages/core/src/storage/sqlite/user-input-prestart-recovery-store.ts",
  "packages/core/src/storage/sqlite/user-input-run-created-replay.ts",
  "packages/core/src/storage/sqlite/user-input-startup-failure.ts",
  "packages/core/src/storage/sqlite/user-input-workflow-admission.ts",
  "packages/daemon/src/features/conversations/user-input-answer-route.ts",
  "packages/daemon/src/features/runs/approval-decision-projection.ts",
  "packages/daemon/src/features/runs/approval-postcommit-evidence.ts",
  "packages/daemon/src/features/runs/user-input-answer-dispatch.ts",
  "packages/daemon/src/features/runs/user-input-answer-routes.ts",
  "packages/daemon/src/features/runs/user-input-continuation-context.ts",
  "packages/daemon/src/features/runs/user-input-continuation-receiver.ts",
  "packages/daemon/src/features/runs/user-input-delivery-worker.ts",
  "packages/daemon/src/features/runs/user-input-execution-preparation.ts",
  "packages/daemon/src/features/runs/user-input-prepared-request.ts",
  "packages/daemon/src/features/runs/user-input-source-execution.ts",
  "packages/daemon/src/features/runs/user-input-source-policy.ts",
  "packages/daemon/src/features/runs/user-input-workflow-terminal.ts",
  "packages/daemon/src/features/runs/workflow-step-input-turn.ts",
];
const requiredNativeExecutionAndDelegationClosureInputs = [
  "packages/contracts/src/execution-engines.ts",
  "packages/contracts/src/runner-acceptance.ts",
  "packages/core/src/approval-decisions.ts",
  "packages/core/src/delegation-completion-barrier.ts",
  "packages/core/src/delegation-completion-evidence.ts",
  "packages/core/src/delegation-host-store-bridge.ts",
  "packages/core/src/execution-engine-host-authority.ts",
  "packages/core/src/execution-engine-profiles.ts",
  "packages/core/src/harness/delegation-lifecycle-types.ts",
  "packages/core/src/harness/delegation-write-types.ts",
  "packages/core/src/harness/delegation-write-validation.ts",
  "packages/core/src/harness/reliability.ts",
  "packages/core/src/native-artifacts.ts",
  "packages/core/src/native-execution-types.ts",
  "packages/core/src/native-openclaw-session.ts",
  "packages/core/src/run-terminal-intent-types.ts",
  "packages/core/src/storage/execution-engine-profile-store.ts",
  "packages/core/src/storage/sqlite/delegation-budget-migration.ts",
  "packages/core/src/storage/sqlite/delegation-budget-rows.ts",
  "packages/core/src/storage/sqlite/delegation-completion-evidence.ts",
  "packages/core/src/storage/sqlite/delegation-instruction-migration.ts",
  "packages/core/src/storage/sqlite/delegation-lifecycle-store.ts",
  "packages/core/src/storage/sqlite/delegation-stopped-handoff.ts",
  "packages/core/src/storage/sqlite/delegation-write-store.ts",
  "packages/core/src/storage/sqlite/harness-artifact-retention-store.ts",
  "packages/core/src/storage/sqlite/harness-artifact-recovery-pins.ts",
  "packages/core/src/storage/sqlite/harness-projection-checkpoint-store.ts",
  "packages/core/src/storage/sqlite/harness-reliability-migration.ts",
  "packages/core/src/storage/sqlite/harness-retention-index-migration.ts",
  "packages/core/src/storage/sqlite/harness-recovery-index-migration.ts",
  "packages/core/src/storage/sqlite/harness-reliability-schema.ts",
  "packages/core/src/storage/sqlite/host-attempt-native-coverage.ts",
  "packages/core/src/storage/sqlite/host-attempt-read-scope.ts",
  "packages/core/src/storage/sqlite/native-execution-migration.ts",
  "packages/core/src/storage/sqlite/native-execution-store.ts",
  "packages/core/src/storage/sqlite/native-approval-wait.ts",
  "packages/core/src/storage/sqlite/native-run-artifacts.ts",
  "packages/core/src/storage/sqlite/native-run-output.ts",
  "packages/core/src/storage/sqlite/run-terminal-intent-migration.ts",
  "packages/core/src/storage/sqlite/run-terminal-intent-store.ts",
  "packages/core/src/storage/sqlite/run-ancestry.ts",
  "packages/daemon/src/features/channels/terminal-report-delegation-evidence.ts",
  "packages/daemon/src/features/conversations/conversation-execution-selection.ts",
  "packages/daemon/src/features/conversations/conversation-run-request.ts",
  "packages/daemon/src/features/conversations/native-response-preferences.ts",
  "packages/daemon/src/features/execution-engines/engine-secret-store.ts",
  "packages/daemon/src/features/execution-engines/feature.ts",
  "packages/daemon/src/features/execution-engines/authority.ts",
  "packages/daemon/src/features/execution-engines/connection-probe.ts",
  "packages/daemon/src/features/execution-engines/controller.ts",
  "packages/daemon/src/features/execution-engines/installation-probe.ts",
  "packages/daemon/src/features/execution-engines/login-manager.ts",
  "packages/daemon/src/features/execution-engines/run-target-dispatcher.ts",
  "packages/daemon/src/features/execution-engines/acp-connection.ts",
  "packages/daemon/src/features/execution-engines/acp-probe-transport.ts",
  "packages/daemon/src/features/execution-engines/claude-connection.ts",
  "packages/daemon/src/features/execution-engines/claude-environment.ts",
  "packages/daemon/src/features/execution-engines/claude-probe-process.ts",
  "packages/daemon/src/features/execution-engines/codex-auth-state.ts",
  "packages/daemon/src/features/execution-engines/codex-connection.ts",
  "packages/daemon/src/features/execution-engines/codex-login.ts",
  "packages/daemon/src/features/execution-engines/kimi-auth-state.ts",
  "packages/daemon/src/features/execution-engines/kimi-connection.ts",
  "packages/daemon/src/features/execution-engines/kimi-native-executable.ts",
  "packages/daemon/src/features/execution-engines/kimi-probe-isolation.ts",
  "packages/daemon/src/features/execution-engines/kimi-terminal-login.ts",
  "packages/daemon/src/features/execution-engines/native-admission.ts",
  "packages/daemon/src/features/execution-engines/native-auth-home.ts",
  "packages/daemon/src/features/execution-engines/native-auth-file.ts",
  "packages/daemon/src/features/execution-engines/native-login.ts",
  "packages/daemon/src/features/execution-engines/native-secrets.ts",
  "packages/daemon/src/features/execution-engines/openclaw-environment.ts",
  "packages/daemon/src/features/execution-engines/owned-native-process.ts",
  "packages/daemon/src/features/execution-engines/secret-profile.ts",
  "packages/daemon/src/features/execution-engines/windows-supervisor.ts",
  "packages/daemon/src/features/harness/delegations/completion-wait.ts",
  "packages/daemon/src/features/harness/delegations/delegated-run-dispatch.ts",
  "packages/daemon/src/features/harness/delegations/delegated-run-recovery.ts",
  "packages/daemon/src/features/harness/delegations/provider-budget-host.ts",
  "packages/daemon/src/features/harness/delegations/runner-tools.ts",
  "packages/daemon/src/features/harness/delegations/runtime-registry.ts",
  "packages/daemon/src/features/harness/delegations/store-composition.ts",
  "packages/daemon/src/features/harness/delegations/host-authority.ts",
  "packages/daemon/src/features/harness/delegations/price-registry.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-pilot-runner.ts",
  "packages/daemon/src/features/harness/reliability/artifact-retention-service.ts",
  "packages/daemon/src/features/harness/reliability/lifecycle-coordinator.ts",
  "packages/daemon/src/features/harness/reliability/projection-reconciler.ts",
  "packages/daemon/src/features/runs/approval-action-policy.ts",
  "packages/daemon/src/features/runs/existing-idempotent-run.ts",
  "packages/daemon/src/features/runs/native-approval-events.ts",
  "packages/daemon/src/features/runs/native-run-dispatcher.ts",
  "packages/daemon/src/features/runs/native-conversation-selection.ts",
  "packages/daemon/src/features/runs/preparation-thread-failure.ts",
  "packages/daemon/src/features/runs/run-ready.ts",
  "packages/daemon/src/runtime/adapters/native-artifact-files.ts",
  "packages/daemon/src/runtime/conversation-execution-route.ts",
  "packages/daemon/src/runtime/native-runners.ts",
  "packages/daemon/src/runtime/run-execution-supervision.ts",
  "packages/daemon/src/runtime/runner-acceptance-store.ts",
  "packages/daemon/src/runtime/acp/journaled-lifecycle.ts",
  "packages/daemon/src/runtime/acp/approval-journal.ts",
  "packages/daemon/src/runtime/acp/content.ts",
  "packages/daemon/src/runtime/acp/event-normalizer.ts",
  "packages/daemon/src/runtime/acp/host-files.ts",
  "packages/daemon/src/runtime/acp/host-requests.ts",
  "packages/daemon/src/runtime/acp/host-terminal-process.ts",
  "packages/daemon/src/runtime/acp/host-terminals.ts",
  "packages/daemon/src/runtime/acp/host-text-read.ts",
  "packages/daemon/src/runtime/acp/host-text-write.ts",
  "packages/daemon/src/runtime/acp/kimi-bash-actions.ts",
  "packages/daemon/src/runtime/acp/kimi-action-preparation.ts",
  "packages/daemon/src/runtime/acp/kimi-execution-home.ts",
  "packages/daemon/src/runtime/acp/kimi-file-actions.ts",
  "packages/daemon/src/runtime/acp/kimi-host-files.ts",
  "packages/daemon/src/runtime/acp/kimi-host-terminals.ts",
  "packages/daemon/src/runtime/acp/kimi-model-configuration.ts",
  "packages/daemon/src/runtime/acp/kimi-model-transport.ts",
  "packages/daemon/src/runtime/acp/kimi-oauth-credentials.ts",
  "packages/daemon/src/runtime/acp/live-client.ts",
  "packages/daemon/src/runtime/acp/live-errors.ts",
  "packages/daemon/src/runtime/acp/live-stream.ts",
  "packages/daemon/src/runtime/acp/openclaw-action-preparation.ts",
  "packages/daemon/src/runtime/acp/session-metadata.ts",
  "packages/daemon/src/runtime/acp/session-settings.ts",
  "packages/daemon/src/runtime/acp/tool-observation.ts",
  "packages/daemon/src/runtime/acp/kimi-owned-execution.ts",
  "packages/daemon/src/runtime/acp/openclaw-owned-execution.ts",
  "packages/daemon/src/runtime/adapters/codex/journaled-lifecycle.ts",
  "packages/daemon/src/runtime/adapters/codex/action-preparation.ts",
  "packages/daemon/src/runtime/adapters/codex/approval-journal.ts",
  "packages/daemon/src/runtime/adapters/codex/approval-wait.ts",
  "packages/daemon/src/runtime/adapters/codex/duplex.ts",
  "packages/daemon/src/runtime/adapters/codex/event-normalizer.ts",
  "packages/daemon/src/runtime/adapters/codex/file-change-context.ts",
  "packages/daemon/src/runtime/adapters/codex/live-client.ts",
  "packages/daemon/src/runtime/adapters/codex/local-environment.ts",
  "packages/daemon/src/runtime/adapters/codex/observed-tools.ts",
  "packages/daemon/src/runtime/adapters/codex/owned-execution.ts",
  "packages/daemon/src/runtime/adapters/codex/permission-preparation.ts",
  "packages/daemon/src/runtime/adapters/codex/tool-content.ts",
  "packages/daemon/src/runtime/adapters/codex/tool-output.ts",
  "packages/daemon/src/runtime/adapters/native-artifact-import.ts",
  "packages/daemon/src/runtime/adapters/native-command-policy.ts",
  "packages/daemon/src/runtime/adapters/native-image-sanitizer.ts",
  "packages/daemon/src/runtime/adapters/native-model-relay.ts",
  "packages/daemon/src/runtime/adapters/native-tool-content.ts",
  "packages/daemon/src/runtime/adapters/native-stream-redaction.ts",
  "packages/daemon/src/runtime/runner-acceptance.ts",
  "packages/daemon/src/runtime/sandbox/native-process-launch.ts",
  "packages/runner-pi/src/delegation-instruction.ts",
  "packages/runner-pi/src/extensions/delegation.ts",
  "packages/runner-pi/src/provider-budget.ts",
  "packages/runner-pi/src/runtime-suspension.ts",
];
const gracefulTreeTypeOnlyInputs = [
  "packages/core/src/run-final-settlement-types.ts",
];
// These contracts also export Error classes consumed by the SQLite writers.
const gracefulTreeRuntimeInputs = [
  "packages/core/src/run-suspension-activation-types.ts",
  "packages/core/src/run-suspension-delegated-types.ts",
  "packages/core/src/run-suspension-start-types.ts",
  "packages/core/src/run-suspension-stop-types.ts",
  "packages/core/src/run-suspension-types.ts",
  "packages/core/src/storage/sqlite/delegation-resume-lineage.ts",
  "packages/core/src/storage/sqlite/run-compaction-suspension-effects.ts",
  "packages/core/src/storage/sqlite/run-compaction-suspension-lineage.ts",
  "packages/core/src/storage/sqlite/run-compaction-suspension-witness.ts",
  "packages/core/src/storage/sqlite/run-final-settlement-handoff.ts",
  "packages/core/src/storage/sqlite/run-final-settlement-migration.ts",
  "packages/core/src/storage/sqlite/run-final-settlement-records.ts",
  "packages/core/src/storage/sqlite/run-final-settlement-store.ts",
  "packages/core/src/storage/sqlite/run-suspension-activation-migration.ts",
  "packages/core/src/storage/sqlite/run-suspension-activation-records.ts",
  "packages/core/src/storage/sqlite/run-suspension-activation-store.ts",
  "packages/core/src/storage/sqlite/run-suspension-delegated-migration.ts",
  "packages/core/src/storage/sqlite/run-suspension-delegated-records.ts",
  "packages/core/src/storage/sqlite/run-suspension-delegated-store.ts",
  "packages/core/src/storage/sqlite/run-suspension-dependencies.ts",
  "packages/core/src/storage/sqlite/run-suspension-migration.ts",
  "packages/core/src/storage/sqlite/run-suspension-queued-proof.ts",
  "packages/core/src/storage/sqlite/run-suspension-start-migration.ts",
  "packages/core/src/storage/sqlite/run-suspension-start-records.ts",
  "packages/core/src/storage/sqlite/run-suspension-start-store.ts",
  "packages/core/src/storage/sqlite/run-suspension-stop-migration.ts",
  "packages/core/src/storage/sqlite/run-suspension-stop-records.ts",
  "packages/core/src/storage/sqlite/run-suspension-stop-store.ts",
  "packages/core/src/storage/sqlite/run-suspension-stopped-handoff.ts",
  "packages/core/src/storage/sqlite/run-suspension-store.ts",
  "packages/core/src/storage/sqlite/run-suspension-witness.ts",
  "packages/daemon/src/features/harness/continuations/final-settlement-observation.ts",
  "packages/daemon/src/features/harness/continuations/root-suspension-dispatch.ts",
  "packages/daemon/src/features/harness/continuations/run-compaction-suspension.ts",
  "packages/daemon/src/features/harness/continuations/run-graceful-suspension.ts",
  "packages/daemon/src/runtime/delegated-terminal-handoff.ts",
  "packages/daemon/src/runtime/run-shutdown-coordinator.ts",
  "packages/daemon/src/runtime/run-suspension-order.ts",
];
const newAuthoredRuntimeLeaves = [
  ...gracefulTreeRuntimeInputs,
  "packages/daemon/src/runtime/packaged-qa-harness-bootstrap.ts",
  "packages/daemon/src/runtime/workspace-runtime-owner.ts",
  "packages/daemon/src/features/runs/approval-event-state.ts",
  "packages/daemon/src/features/runs/approval-resume-preparation.ts",
  "packages/core/src/storage/sqlite/teammate-direct-approval-continuation-proof.ts",
  "packages/core/src/storage/sqlite/teammate-direct-message-runtime-proof.ts",
  "packages/core/src/storage/sqlite/teammate-direct-message-runtime-store.ts",
  "packages/core/src/teammate-direct-message-runtime-types.ts",
  "packages/core/src/teammate-direct-message-runtime-validation.ts",
  "packages/daemon/src/features/teammates/direct-message-lifecycle.ts",
  "packages/core/src/proposed-plan-mutation.ts",
  "packages/core/src/storage/sqlite/proposed-plan-action-store.ts",
  "packages/core/src/storage/sqlite/proposed-plan-revision-migration.ts",
  "packages/daemon/src/features/runs/execution-loop-semantic-evidence.ts",
  "packages/core/src/automation-context-budget.ts",
  "packages/core/src/storage/sqlite/media-workflow-check-migration.ts",
  "packages/daemon/src/features/media/workflows/workflow-connection-check.ts",
  "packages/daemon/src/features/external-work/workflow-path-admission.ts",
  "packages/daemon/src/features/media/scene-cancellation.ts",
  "packages/core/src/bundled-skill-source.ts",
  "packages/core/src/bundled-skill-browser.ts",
  "packages/daemon/src/features/skills/bundled-startup.ts",
  "packages/daemon/src/features/skills/packaged-identity.ts",
  "packages/daemon/src/features/skills/packaged-startup.ts",
  "packages/daemon/src/features/skills/packaged-runtime.ts",
  "packages/daemon/src/features/skills/packaged-history.ts",
  "packages/daemon/src/features/skills/bundled-source-mode.ts",
  "packages/core/src/effective-skill-registry.ts",
  "packages/core/src/skill-source-definition.ts",
  "packages/core/src/skill-source-selection.ts",
  "packages/core/src/storage/sqlite/skill-source-publication.ts",
  "packages/core/src/storage/sqlite/skill-source-rollback.ts",
  "packages/daemon/src/features/runs/skill-source-context.ts",
  "packages/daemon/src/features/runs/gstack-host-context.ts",
  "packages/daemon/src/features/skills/source-publication.ts",
  "packages/daemon/src/server/rpc-outbound.ts",
  "packages/daemon/src/shared/sse-stream-writer.ts",
  "packages/core/src/storage/sqlite/ling-turn-cursor-indexes.ts",
  "packages/daemon/src/features/conversations/normal-conversation-context-budget.ts",
  "packages/daemon/src/features/conversations/normal-conversation-context-turn-candidates.ts",
  "packages/core/src/workflow-step-start-owner.ts",
  "packages/core/src/storage/sqlite/channel-workflow-start-store.ts",
  "packages/daemon/src/features/runs/workflow-step-start-admission.ts",
  "packages/daemon/src/features/channels/file-request-content.ts",
  "packages/browser-host/src/descriptor-coordination.ts",
  "packages/daemon/src/features/browser-extension/native-broker-shutdown.ts",
  "packages/core/src/automation-recurrence.ts",
  "packages/daemon/src/features/automations/recurrence.ts",
  "packages/core/src/run-progress-checkpoint-types.ts",
  "packages/core/src/run-progress-checkpoint-lineage.ts",
  "packages/core/src/storage/sqlite/run-progress-checkpoint-effects.ts",
  "packages/core/src/storage/sqlite/run-progress-checkpoint-migration.ts",
  "packages/core/src/storage/sqlite/run-progress-checkpoint-store.ts",
  "packages/daemon/src/features/harness/continuations/run-ordinary-progress.ts",
  "packages/daemon/src/shared/public-http-transport.ts",
  "packages/runner-pi/src/ordinary-progress-recovery.ts",
  "packages/runner-pi/src/provider-request-auth.ts",
  "packages/runner-pi/src/session-continuation.ts",
  "packages/runner-pi/src/session-transcript.ts",
  "packages/core/src/storage/sqlite/delegation-migration.ts",
  "packages/core/src/storage/sqlite/delegation-mappers.ts",
  "packages/core/src/storage/sqlite/delegation-store.ts",
  "packages/core/src/harness/delegation-authority.ts",
  "packages/core/src/storage/sqlite/harness-diagnostics-mappers.ts",
  "packages/core/src/storage/sqlite/harness-diagnostics-store.ts",
  "packages/core/src/storage/sqlite/harness-diagnostics-validation.ts",
  "packages/daemon/src/runtime/harness-diagnostics.ts",
  "packages/core/src/storage/sqlite/mcp-metadata-migration.ts",
  "packages/core/src/storage/sqlite/mcp-metadata-publication-store.ts",
  "packages/daemon/src/features/mcp/metadata-publication.ts",
  "packages/core/src/storage/sqlite/provider-check-migration.ts",
  "packages/core/src/storage/sqlite/provider-check-publication-store.ts",
  "packages/daemon/src/features/providers/check-publication.ts",
  "packages/daemon/src/features/providers/model-discovery-authority.ts",
  "packages/core/src/provider-runtime-availability-types.ts",
  "packages/core/src/storage/sqlite/availability-incident-provenance-migration.ts",
  "packages/core/src/storage/sqlite/availability-incident-provenance-store.ts",
  "packages/core/src/storage/sqlite/availability-incident-source.ts",
  "packages/daemon/src/features/providers/runtime-failure-observations.ts",
  "packages/daemon/src/features/providers/runtime-invocations.ts",
  "packages/daemon/src/features/providers/runtime-observation-scope.ts",
  "packages/daemon/src/features/runs/provider-persistence.ts",
  "packages/daemon/src/features/runs/tool-context-budget.ts",
  "packages/runner-pi/src/provider-invocation.ts",
  "packages/core/src/harness/evaluation-tasks.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-validation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-mappers.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-migration.ts",
  "packages/core/src/storage/sqlite/run-evaluation-task-store.ts",
  "packages/daemon/src/features/harness/evaluations/task-worker-input.ts",
  "packages/daemon/src/features/harness/evaluations/task-worker-prepared.ts",
  "packages/daemon/src/features/harness/evaluations/task-worker.ts",
  "packages/daemon/src/features/harness/evaluations/task-worker-composition.ts",
  "packages/core/src/harness/evaluation-qa.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-validation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-mappers.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-migration.ts",
  "packages/core/src/storage/sqlite/run-evaluation-qa-store.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-json.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-preparation.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-owned-batch.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-transport.ts",
  "packages/daemon/src/features/harness/evaluations/qa-model-coordinator.ts",
  "packages/core/src/harness/human-evaluation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-mappers.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-migration.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-store.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-validation.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-read-store.ts",
  "packages/core/src/storage/sqlite/run-evaluation-human-read-validation.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-authority.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-protocol.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-routes.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-service.ts",
  "packages/daemon/src/features/harness/evaluations/human-evaluation-report.ts",
  ...requiredQuestionAndApprovalClosureInputs,
  ...requiredNativeExecutionAndDelegationClosureInputs.filter(name => name !== "packages/core/src/run-terminal-intent-types.ts"),
];
// This contract is exported with `export type *`; esbuild correctly erases it.
// It remains an explicit reviewed source and gets every fail-closed check below.
const newAuthoredTypeOnlyInputs = ["packages/contracts/src/harness-evaluation-qa.ts", "packages/contracts/src/harness-human-evaluation.ts",
  "packages/contracts/src/harness-human-evaluation-read.ts", "packages/core/src/harness/human-evaluation-read.ts",
  "packages/core/src/run-terminal-intent-types.ts", ...gracefulTreeTypeOnlyInputs];
const reviewedNativeInputs = ["apps/desktop/scripts/build-human-evaluation-helper.mjs", "apps/desktop/scripts/native/human-evaluation-darwin.swift"];
const newAuthoredRequiredInputs = [...newAuthoredRuntimeLeaves, ...newAuthoredTypeOnlyInputs, ...reviewedNativeInputs];
const staleSentinel = "__LING_EXPLICIT_STALE_DIST_RED__";
const authoredSentinel = "__LING_EXPLICIT_REVIEWED_AUTHORED_SOURCE_GREEN__";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
function newFile(path, bytes) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, bytes, { mode: 0o600 });
}

test("Office packaging review requires every new browser lifecycle, Pi, progress, transport, delegation, diagnostics, Provider and evaluation task/QA authored source", () => {
  for (const name of newAuthoredRequiredInputs) {
    assert.equal(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(name), true,
      `Runtime leaf must be an explicit required review input: ${name}`);
  }
});

test("Office fixed review closure explicitly pins required-question and approval authored sources", () => {
  assert.equal(requiredQuestionAndApprovalClosureInputs.length, 20);
  for (const name of requiredQuestionAndApprovalClosureInputs) {
    assert.equal(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(name), true,
      `Required-question or approval source must be an explicit fixed review input: ${name}`);
  }
});

test("Office fixed review closure explicitly pins native execution and dynamic delegation authored sources", () => {
  assert.equal(requiredNativeExecutionAndDelegationClosureInputs.length, 154);
  for (const name of requiredNativeExecutionAndDelegationClosureInputs) {
    assert.equal(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(name), true,
      `Native execution or delegation source must be an explicit fixed review input: ${name}`);
  }
});

test("Office review closure pins the Broker command result trust boundary", () => {
  assert.equal(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(
    "packages/daemon/src/features/harness/tool-execution/broker-command-result.ts"), true);
});

// Regression: P3-MAIN-CLOSURE — imported main leaves must be reviewed authored inputs.
// Found by /qa independent AST audit on 2026-10-24
// Report: output/e6-20260928/p3-main-office-closure-audit-20261024.md
test("Office review closure pins main work-summary and text-boundary runtime leaves", () => {
  for (const path of [
    "packages/core/src/storage/sqlite/work-summary-migration.ts",
    "packages/core/src/storage/sqlite/work-summary-store.ts",
    "packages/core/src/string-boundaries.ts",
    "packages/daemon/src/features/work-summary/cache.ts",
    "packages/daemon/src/features/work-summary/git-summary.ts",
    "packages/daemon/src/features/work-summary/pull-requests.ts",
    "packages/daemon/src/features/work-summary/routes.ts",
    "packages/daemon/src/features/work-summary/service.ts",
    "packages/daemon/src/shared/html-text.ts",
  ]) assert.equal(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.includes(path), true, path);
});

test("Office fixed fresh daemon must not consume a stale compiled bridge with unchanged reviewed TS (real esbuild, synthetic native only)", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async t => {
  const f = await approvedSyntheticFixture(t);
  const baseline = await f.bundle();
  assert.equal(baseline.bytes.includes(staleSentinel), false);
  assert.equal(baseline.pins.evidenceKind, "original_emitted_cli_byte_pins_only");
  const authoredBefore = readFileSync(join(f.root, reviewedLeaf));
  const reviewBefore = readFileSync(f.reviewPath);
  const originalCompiled = readFileSync(join(f.root, compiledLeaf));
  assert.equal(originalCompiled.length > 0, true);
  // Only this disposable generated leaf changes. Preserve every original JS
  // export/import and the fixed reviewed TS/approval row, including their hash.
  writeFileSync(join(f.root, compiledLeaf), Buffer.concat([
    Buffer.from(`globalThis.${staleSentinel} = true;\n`), originalCompiled,
  ]));
  assert.deepEqual(readFileSync(join(f.root, reviewedLeaf)), authoredBefore);
  assert.deepEqual(readFileSync(f.reviewPath), reviewBefore);
  assert.equal(f.reviewApi.readReviewedPackagedOfficeSource().sourceReviewSha256, hash(reviewBefore));
  const changed = await f.bundle();
  assert.deepEqual(readFileSync(join(f.root, reviewedLeaf)), authoredBefore);
  assert.deepEqual(readFileSync(f.reviewPath), reviewBefore);
  assert.equal(changed.pins.sha256, hash(changed.bytes));
  assert.equal(changed.pins.sizeBytes, changed.bytes.length);
  t.diagnostic(JSON.stringify({
    simulation: "native compiler/codesign only; esbuild and fixed fresh daemon/publication APIs are real",
    fixtureOnly: true, artifactExecuted: false,
    authoredSha256: hash(authoredBefore), unchangedReviewSha256: hash(reviewBefore),
    originalCompiledSha256: hash(originalCompiled), mutatedCompiledSha256: hash(readFileSync(join(f.root, compiledLeaf))),
    baselineBundleSha256: baseline.pins.sha256, changedBundleSha256: changed.pins.sha256,
    changedBundleSizeBytes: changed.bytes.length, staleSentinelInOriginalEmittedCli: changed.bytes.includes(staleSentinel),
    nativeCompilerCalls: f.counts.nativeCompilerCalls, signCalls: f.counts.signCalls,
    nativeVerifyCalls: f.counts.nativeVerifyCalls, helperNormalizeCalls: f.counts.helperNormalizeCalls,
  }));
  // The saved original RED reached real esbuild and granted original pins yet
  // carried this side effect. The same semantic assertion must now be GREEN.
  assert.equal(changed.bytes.includes(staleSentinel), false,
    "Unchanged reviewed authored TS must not authorize an added workspace dist runtime side effect");
  const baselineSource = assertOriginalSourceOnlyBuild(f, baseline, 0);
  const changedSource = assertOriginalSourceOnlyBuild(f, changed, 1);
  assert.equal(changedSource.reviewedBridgeSha256, baselineSource.reviewedBridgeSha256);
  t.diagnostic(JSON.stringify({ realEsbuildSourceAudit: { baseline: baselineSource, changed: changedSource } }));
});

test("Office fixed fresh daemon consumes an explicitly reviewed authored bridge change, not unchanged dist (real esbuild, synthetic native only)", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async t => {
  const f = await approvedSyntheticFixture(t);
  const compiledBefore = readFileSync(join(f.root, compiledLeaf));
  const authored = Buffer.concat([Buffer.from(`globalThis.${authoredSentinel} = true;\n`), readFileSync(join(f.root, reviewedLeaf))]);
  writeFileSync(join(f.root, reviewedLeaf), authored);
  // This is a new, explicit disposable fixture review of these authored bytes,
  // never a production approval refresh. The stale-dist test above does not do it.
  const explicitFixtureReview = JSON.parse(readFileSync(f.reviewPath, "utf8"));
  explicitFixtureReview.packagingSha256[reviewedLeaf] = hash(authored);
  writeFileSync(f.reviewPath, JSON.stringify(explicitFixtureReview));
  const bundle = await f.bundle();
  assert.deepEqual(readFileSync(join(f.root, compiledLeaf)), compiledBefore);
  assert.equal(compiledBefore.includes(authoredSentinel), false);
  assert.equal(bundle.bytes.includes(authoredSentinel), true,
    "A real original bundle must consume the explicitly reviewed authored side effect");
  const sourceAudit = assertOriginalSourceOnlyBuild(f, bundle, 0);
  assert.equal(sourceAudit.reviewedBridgeSha256, hash(authored));
  t.diagnostic(JSON.stringify({ fixtureOnly: true, artifactExecuted: false, reviewedAuthoredSentinelInOriginalEmittedCli: true,
    unchangedCompiledSha256: hash(compiledBefore), originalBundleSha256: bundle.pins.sha256,
    explicitFixtureReviewSha256: hash(readFileSync(f.reviewPath)), realEsbuildSourceAudit: sourceAudit }));
});

test("Office fixed fresh daemon rejects missing review digests, changed authored bytes and missing new runtime sources before any build (synthetic native only)", {
  skip: process.platform !== "darwin" || process.arch !== "arm64",
}, async t => {
  const f = await approvedSyntheticFixture(t);
  const originalReview = readFileSync(f.reviewPath);
  assert.equal(f.reviewApi.readReviewedPackagedOfficeSource().sourceReviewSha256, hash(originalReview));
  for (const name of newAuthoredRequiredInputs) {
    await t.test(name, async t => {
      const sourcePath = join(f.root, name), authoredBefore = readFileSync(sourcePath);
      // Native/compiler-script inputs are reviewed source, not a daemon dist leaf.
      const distPath = reviewedNativeInputs.includes(name) ? undefined
        : join(f.root, name.replace("/src/", "/dist/").replace(/\.ts$/u, ".js"));
      const compiledBefore = distPath ? readFileSync(distPath) : undefined;
      if (compiledBefore) assert.ok(compiledBefore.length > 0, "the stale generated leaf must exist throughout the rejection checks");
      await t.test("missing required review digest", async () => {
        const review = JSON.parse(originalReview.toString("utf8"));
        delete review.packagingSha256[name];
        const incompleteReview = Buffer.from(JSON.stringify(review));
        writeFileSync(f.reviewPath, incompleteReview);
        try {
          await assert.rejects(f.bundle(), /packaged_office_native_source_review_invalid/u);
          assert.deepEqual(readFileSync(f.reviewPath), incompleteReview);
          assert.deepEqual(readFileSync(sourcePath), authoredBefore);
          assertNoBuild(f);
        } finally { writeFileSync(f.reviewPath, originalReview); }
      });
      await t.test("authored mutation with unchanged review", async () => {
        const changed = Buffer.concat([Buffer.from("// EXPLICIT TEST-ONLY UNREVIEWED RUNTIME LEAF\n"), authoredBefore]);
        writeFileSync(sourcePath, changed);
        try {
          await assert.rejects(f.bundle(), /packaged_office_native_source_review_invalid/u);
          assert.deepEqual(readFileSync(f.reviewPath), originalReview);
          assert.deepEqual(readFileSync(sourcePath), changed);
          assertNoBuild(f);
        } finally { writeFileSync(sourcePath, authoredBefore); }
      });
      await t.test("missing authored source cannot fall back to existing dist", async () => {
        rmSync(sourcePath); // This exact path is inside the disposable mkdtemp fixture.
        try {
          await assert.rejects(f.bundle(), error => error.code === "ENOENT" && error.path === sourcePath);
          assert.equal(existsSync(sourcePath), false);
          assert.deepEqual(readFileSync(f.reviewPath), originalReview);
          assertNoBuild(f);
        } finally { writeFileSync(sourcePath, authoredBefore, { mode: 0o600 }); }
      });
      if (distPath) assert.deepEqual(readFileSync(distPath), compiledBefore);
    });
  }
  t.diagnostic(JSON.stringify({ fixtureOnly: true, artifactExecuted: false, newAuthoredRuntimeLeaves, newAuthoredTypeOnlyInputs,
    nativeCompilerCalls: f.counts.nativeCompilerCalls, signCalls: f.counts.signCalls,
    nativeVerifyCalls: f.counts.nativeVerifyCalls, helperNormalizeCalls: f.counts.helperNormalizeCalls,
    realEsbuildCalls: f.builds.length }));
});

/** A rejected review must not reach native compilation, codesign or actual esbuild. */
function assertNoBuild(f) {
  assert.deepEqual(f.counts, { nativeCompilerCalls: 0, signCalls: 0, nativeVerifyCalls: 0, helperNormalizeCalls: 0 });
  assert.equal(f.builds.length, 0);
}

/** Independent checks of captured real esbuild metadata and original API output pins. */
function assertOriginalSourceOnlyBuild(f, bundle, index) {
  const observed = f.builds[index];
  assert.ok(observed, "the actual fixed builder must call the capture-only real esbuild observer");
  assert.deepEqual(observed.options.entryPoints, [join(f.root, "packages/daemon/src/cli.ts")]);
  assert.equal(observed.options.write, false);
  assert.equal(observed.options.metafile, true);
  assert.equal(observed.options.target, "es2022");
  assert.deepEqual(observed.options.tsconfigRaw, { compilerOptions: { target: "ES2022", useDefineForClassFields: true } });
  assert.ok(observed.metafile?.inputs, "the real esbuild result must include its actual runtime inputs");
  const paths = Object.keys(observed.metafile.inputs).map(name => resolve(f.root, "apps/desktop", name));
  const workspaceInputs = paths.filter(path => workspaceNames.some(name => path.startsWith(join(f.root, "packages", name) + sep)));
  assert.ok(workspaceInputs.length > 0);
  const anyWorkspaceDist = paths.filter(path => workspaceNames.some(name => path.includes(`${sep}packages${sep}${name}${sep}dist${sep}`)));
  assert.deepEqual(anyWorkspaceDist, [], "no generated dist from any of the nine workspace packages may be a runtime input");
  assert.equal(workspaceInputs.every(path => workspaceNames.some(name => path.startsWith(join(f.root, "packages", name, "src") + sep))), true);
  const bridgePath = join(f.root, reviewedLeaf);
  assert.equal(paths.includes(bridgePath), true, "actual metafile must contain the reviewed authored bridge");
  const review = JSON.parse(readFileSync(f.reviewPath, "utf8"));
  const authored = readFileSync(bridgePath);
  assert.equal(hash(authored), review.packagingSha256[reviewedLeaf]);
  const bridgeInputName = Object.keys(observed.metafile.inputs).find(name => resolve(f.root, "apps/desktop", name) === bridgePath);
  assert.equal(observed.metafile.inputs[bridgeInputName].bytes, authored.length);
  assert.equal(workspaceInputs.every(path => Object.hasOwn(review.packagingSha256, path.slice(f.root.length + 1).split(sep).join("/"))), true);
  const reviewedAuthoredRuntimeSha256 = Object.fromEntries(newAuthoredRuntimeLeaves.map(name => {
    const path = join(f.root, name), bytes = readFileSync(path);
    assert.equal(paths.includes(path), true, `actual esbuild metafile must contain the reviewed runtime leaf: ${name}`);
    assert.equal(hash(bytes), review.packagingSha256[name]);
    const inputName = Object.keys(observed.metafile.inputs).find(input => resolve(f.root, "apps/desktop", input) === path);
    const loaded = name === "packages/daemon/src/features/skills/packaged-identity.ts"
      ? bytes.toString().replace('const embeddedBundledGstackJson: string = "NO_PACKAGED_GSTACK_IDENTITY";',
        `const embeddedBundledGstackJson: string = ${JSON.stringify(JSON.stringify(f.gsIdentity))};`)
      : bytes;
    assert.equal(observed.metafile.inputs[inputName].bytes, Buffer.byteLength(loaded));
    return [name, hash(bytes)];
  }));
  const reviewedAuthoredTypeOnlySha256 = Object.fromEntries(newAuthoredTypeOnlyInputs.map(name => {
    const path = join(f.root, name), bytes = readFileSync(path);
    assert.equal(hash(bytes), review.packagingSha256[name]);
    assert.equal(paths.includes(path), false, `type-only contract must not become an executable runtime input: ${name}`);
    return [name, hash(bytes)];
  }));
  assert.deepEqual(observed.outputFiles, [{ path: bundle.pins.path, sha256: bundle.pins.sha256, sizeBytes: bundle.pins.sizeBytes }],
    "original emitted API pins must match the untouched true esbuild output, not a synthesized result");
  return { entryPoint: "packages/daemon/src/cli.ts", runtimeInputs: paths.length, authoredWorkspaceRuntimeInputs: workspaceInputs.length,
    nineWorkspaceDistRuntimeInputs: anyWorkspaceDist.length, reviewedBridgeSha256: hash(authored),
    reviewedAuthoredRuntimeSha256, reviewedAuthoredTypeOnlySha256,
    originalEsbuildOutputSha256: observed.outputFiles[0].sha256 };
}

/**
 * Disposable test-only approved rows, faithful nine-package workspace inputs,
 * real existing esbuild, original native publication and original CLI APIs.
 * Only native compiler bodies and codesign transforms are explicitly replaced.
 * There is no fake esbuild result, generated-output execution or product approval.
 */
async function approvedSyntheticFixture(t) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-daemon-source-inputs-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const scripts = join(root, "apps/desktop/scripts"), nativeOffice = join(root, "native/office-local");
  for (const name of PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS) {
    assert.equal(existsSync(join(repositoryRoot, name)), true, `review input must exist: ${name}`);
    newFile(join(root, name), readFileSync(join(repositoryRoot, name)));
  }
  for (const name of OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS) {
    newFile(join(nativeOffice, name), readFileSync(join(repositoryRoot, "native/office-local", name)));
  }
  for (const name of workspaceNames) {
    const packageRoot = join(root, "packages", name), originalRoot = join(repositoryRoot, "packages", name);
    newFile(join(packageRoot, "package.json"), readFileSync(join(originalRoot, "package.json")));
    newFile(join(packageRoot, "tsconfig.json"), readFileSync(join(originalRoot, "tsconfig.json")));
    cpSync(join(originalRoot, "src"), join(packageRoot, "src"), { recursive: true });
    cpSync(join(originalRoot, "dist"), join(packageRoot, "dist"), { recursive: true });
    linkExistingDependencies(join(originalRoot, "node_modules"), join(packageRoot, "node_modules"), root);
  }
  linkExistingDependencies(join(repositoryRoot, "node_modules"), join(root, "node_modules"), root);
  linkExistingDependencies(join(repositoryRoot, "apps/desktop/node_modules"), join(root, "apps/desktop/node_modules"), root);
  // Disposable data only: the original builder/verifiers stay unchanged and
  // no synthetic browser executable or generated daemon is run.
  const selected = join(root, ".ling-stack/build/synthetic-gstack"), gs = join(selected, "gstack"), browser = join(selected, "gstack-browser");
  const lock = JSON.parse(readFileSync(join(root, "scripts/gstack/upstream-lock.json"), "utf8"));
  const skills = lock.skillIds.map(id => ({ id, entryPath: `skills/${id}/SKILL.md`, resourcePaths: [] }));
  for (const skill of skills) newFile(join(gs, skill.entryPath), `# ${skill.id}\nSynthetic source fixture.\n`);
  newFile(join(gs, "LICENSE"), "MIT fixture\n");
  const entryPath = "Chromium.app/Contents/MacOS/Chromium", framework = "Chromium.app/Contents/Frameworks/Chromium Framework.framework";
  newFile(join(browser, entryPath), "SYNTHETIC BROWSER DATA NEVER EXECUTED");
  mkdirSync(join(browser, framework, "Versions/A"), { recursive: true });
  const browserFiles = await bundleInventory(browser), links = [];
  for (let i = 0; i < 5; i++) {
    const path = `${framework}/alias-${i}`;
    symlinkSync("Versions/A", join(browser, path));
    links.push({ path, linkTarget: "Versions/A", resolvedTarget: `${framework}/Versions/A` });
  }
  const browserBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, target: { platform: process.platform, arch: process.arch },
    entryPath, files: browserFiles, links }));
  newFile(join(browser, "browser-component.json"), browserBytes);
  newFile(join(gs, "executable-build.json"), JSON.stringify({ scope: "isolated-local-client", releaseEligible: false,
    upstreamRevision: lock.revision, browser: { activation: "package-relative-only", componentChecksum: digest(browserBytes) } }));
  newFile(join(gs, "manifest.json"), JSON.stringify({ schemaVersion: 1, packId: "gstack-default", deliveryStage: "executable",
    upstream: { repository: "https://github.com/garrytan/gstack", revision: lock.revision, version: lock.version }, adaptationRevision: "ling-synthetic",
    target: { platform: process.platform, arch: process.arch }, licensePath: "LICENSE", skills, files: await bundleInventory(gs) }));
  const gsIdentity = (await readExecutableBundle(gs)).identity;
  newFile(join(root, ".ling-stack/build/gstack-desktop-selection.json"), JSON.stringify({ root: gs, identity: gsIdentity }));
  const temporary = join(root, "temporary"); mkdirSync(temporary);
  // Standard publication fixture seams only. The fixed daemon builder remains
  // byte-for-byte the authored implementation and still calls actual esbuild.
  for (const name of ["build-packaged-office-native.mjs", "build-restricted-command-helper.mjs"]) {
    const path = join(scripts, name);
    let source = readFileSync(path, "utf8").replace('import { tmpdir } from "node:os";',
      `const tmpdir = () => ${JSON.stringify(temporary)};`);
    if (name === "build-packaged-office-native.mjs") {
      source = source.replace('import { resolveSigningProfile } from "./cua-driver-signing/signing-contract.mjs";',
        'const resolveSigningProfile = () => ({ signingTier: "unsigned_dev" });');
    }
    writeFileSync(path, source);
  }
  const compilerPath = join(root, "toolchain/clang++"), sdkRoot = join(root, "sdk"), headersRoot = join(root, "headers");
  newFile(compilerPath, "EXPLICIT SYNTHETIC COMPILER IDENTITY");
  newFile(join(sdkRoot, "SDKSettings.json"), "EXPLICIT SYNTHETIC SDK");
  const headerNames = ["node_api.h", "js_native_api.h", "js_native_api_types.h", "node_api_types.h"];
  for (const name of headerNames) newFile(join(headersRoot, name), "EXPLICIT SYNTHETIC HEADER:" + name);
  const review = {
    schemaVersion: 1, reviewId: "packaged_office_native_v1", approval: "approved_source_and_packaging_review",
    protocolVersion: 2, napiVersion: 8, deploymentTarget: "13.0",
    sourceSha256: Object.fromEntries(OFFICE_LOCAL_NATIVE_REVIEW_SOURCE_INPUTS.map(name => [name, hash(readFileSync(join(nativeOffice, name)))])),
    packagingSha256: Object.fromEntries(PACKAGED_OFFICE_NATIVE_PACKAGING_SOURCE_INPUTS.map(name => [name, hash(readFileSync(join(root, name)))])),
    compiler: { path: compilerPath, version: "explicit synthetic compiler", sha256: hash(readFileSync(compilerPath)) },
    sdk: { root: sdkRoot, settingsSha256: hash(readFileSync(join(sdkRoot, "SDKSettings.json"))) },
    headers: { root: headersRoot, sha256: Object.fromEntries(headerNames.map(name => [name, hash(readFileSync(join(headersRoot, name)))])) },
    runtime: { platform: "darwin", architecture: "arm64", electron: "44.5.1", node: "24.14.0", uv: "1.51.0" },
    signing: { profile: "unsigned_dev", mode: "adhoc", identifier: "com.ling-stack.office-local.native" },
    trust: "original_office_source_and_packaging_v1",
  };
  const reviewPath = join(nativeOffice, "reviewed-packaged-source-v1.json");
  newFile(reviewPath, JSON.stringify(review));
  const helperReview = JSON.parse(readFileSync(join(root, "native/sandbox/reviewed-codesign-source-v1.json"), "utf8"));
  // Its unchanged reviewed source files were already copied by the fixed
  // packaging inventory; this is a disposable copy, not a product row update.
  for (const name of Object.keys(helperReview.sourceSha256)) {
    assert.equal(hash(readFileSync(join(root, "native/sandbox", name))), helperReview.sourceSha256[name]);
  }
  const counts = { nativeCompilerCalls: 0, signCalls: 0, nativeVerifyCalls: 0, helperNormalizeCalls: 0 };
  const builds = [];
  const counterKey = `__LING_EXPLICIT_NATIVE_FIXTURE_${root.split("/").at(-1).replaceAll("-", "_")}__`;
  globalThis[counterKey] = counts;
  t.after(() => { delete globalThis[counterKey]; });
  const realEsbuild = await import("esbuild");
  const observerKey = `${counterKey}_REAL_ESBUILD_OBSERVER`;
  // Delegate unchanged options to the installed real esbuild and return its
  // untouched result. This seam records evidence only; it does not fake output,
  // metafile, compiler transforms, publication APIs or the daemon builder bytes.
  globalThis[observerKey] = async options => {
    const result = await realEsbuild.build(options);
    builds.push({ options: { entryPoints: [...options.entryPoints], write: options.write, metafile: options.metafile,
      target: options.target, tsconfigRaw: structuredClone(options.tsconfigRaw) },
      metafile: structuredClone(result.metafile), outputFiles: result.outputFiles?.map(output => ({ path: output.path,
        sha256: hash(output.contents), sizeBytes: output.contents.byteLength })) });
    return result;
  };
  t.after(() => { delete globalThis[observerKey]; });
  const daemonBuildUrl = pathToFileURL(join(scripts, "build-packaged-daemon.mjs")).href;
  const esbuildObserverUrl = pathToFileURL(join(root, "explicit-capture-only-real-esbuild-observer.mjs")).href;
  const officeBuildUrl = pathToFileURL(join(nativeOffice, "scripts/build.mjs")).href;
  const helperBuildUrl = pathToFileURL(join(root, "native/sandbox/scripts/build.mjs")).href;
  const loader = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "esbuild" && context.parentURL === daemonBuildUrl) return { url: esbuildObserverUrl, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
    if (url === esbuildObserverUrl) return { format: "module", shortCircuit: true,
      source: `export async function build(options) { return await globalThis[${JSON.stringify(observerKey)}](options); }` };
    if (url === officeBuildUrl) return { format: "module", shortCircuit: true, source: `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createHash } from "node:crypto";
      const review = ${JSON.stringify(review)};
      export function buildNativeEvidence({output}) {
        globalThis[${JSON.stringify(counterKey)}].nativeCompilerCalls++;
        mkdirSync(output); const bytes = Buffer.from("EXPLICIT SYNTHETIC UNSIGNED OFFICE ADDON");
        writeFileSync(join(output, "office-local.node"), bytes);
        return {schemaVersion:2,addon:"office-local",protocolVersion:2,napiVersion:8,deploymentTarget:"13.0",
          platform:"darwin",architecture:"arm64",compiler:review.compiler,sdk:review.sdk,headers:review.headers,
          sourceSha256:review.sourceSha256,binary:{sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length},
          verification:{compilation:"passed"},scopeBinding:"unbound",coreSafe:false,packaged:false};
      }
    ` };
    if (url === helperBuildUrl) return { format: "module", shortCircuit: true, source: `
      import { mkdirSync, writeFileSync } from "node:fs";
      import { join } from "node:path";
      import { createHash } from "node:crypto";
      export function buildNativeEvidence({target,output}) {
        globalThis[${JSON.stringify(counterKey)}].nativeCompilerCalls++;
        mkdirSync(output); mkdirSync(join(output,"licenses"));
        const bytes=Buffer.from("EXPLICIT SYNTHETIC HELPER:LINKER-SIGNATURE");
        writeFileSync(join(output,"ling-sandbox-runner"),bytes);
        writeFileSync(join(output,"licenses/notice.txt"),"EXPLICIT SYNTHETIC NOTICE");
        return {schemaVersion:1,helperName:"ling-sandbox-runner",helperVersion:"source-input-simulation-v1",
          target,host:target,toolchain:"1.97.1",sourceSha256:${JSON.stringify(helperReview.sourceSha256)},
          verification:{format:"passed",releaseBuild:"passed",inputCapture:"passed"},
          fixedCodesignLeaf:{parserProtocol:"passed"},binary:{filename:"ling-sandbox-runner",
            sha256:createHash("sha256").update(bytes).digest("hex"),sizeBytes:bytes.length}};
      }
    ` };
    return nextLoad(url, context);
  } });
  t.after(() => loader.deregister());
  const mock = t.mock.method(childProcess, "spawnSync", (command, args) => {
    assert.equal(command, "/usr/bin/codesign");
    if (args[0] === "--force") {
      counts.signCalls++;
      const path = args.at(-1); writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from(":EXPLICIT SYNTHETIC SIGN TRANSFORM")]));
    } else if (args[0] === "--verify") counts.nativeVerifyCalls++;
    else {
      assert.equal(args[0], "--remove-signature"); counts.helperNormalizeCalls++;
      const bytes = readFileSync(args[1]), suffix = Buffer.from(":LINKER-SIGNATURE");
      assert.equal(bytes.subarray(-suffix.length).equals(suffix), true);
      writeFileSync(args[1], bytes.subarray(0, bytes.length - suffix.length));
    }
    return { status: 0, signal: null, stdout: "", stderr: "" };
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const daemonApi = await import(pathToFileURL(join(scripts, "build-packaged-daemon.mjs")).href);
  const officeApi = await import(pathToFileURL(join(scripts, "build-packaged-office-native.mjs")).href);
  const reviewApi = await import(pathToFileURL(join(scripts, "packaged-office-native-review.mjs")).href);
  return {
    root, counts, builds, reviewApi, reviewPath, gsIdentity,
    async bundle() {
      const token = await daemonApi.buildFreshPackagedDaemonForMacOffice();
      return officeApi.withOriginalPackagedOfficeNativePublication(token, async () => {
        const pins = daemonApi.readActiveOriginalPackagedOfficeDaemonBundle();
        const bytes = readFileSync(pins.path);
        assert.equal(hash(bytes), pins.sha256);
        return { pins, bytes };
      });
    },
  };
}

/** Keep workspace imports inside this fixture; only external dependencies reuse installed bytes. */
function linkExistingDependencies(original, destination, fixtureRoot) {
  if (!existsSync(original)) return;
  mkdirSync(destination, { recursive: true });
  const linkOne = (name, source) => {
    if (name === ".pnpm" || name === ".bin" || name.startsWith(".")) return;
    const target = name.startsWith("@ling-stack/")
      ? join(fixtureRoot, "packages", name.slice("@ling-stack/".length)) : realpathSync(source);
    if (!existsSync(target)) return; // Unused non-reviewed workspace packages are not silently adopted.
    const output = join(destination, name); mkdirSync(dirname(output), { recursive: true });
    if (!existsSync(output)) symlinkSync(target, output, "dir");
  };
  for (const name of readdirSync(original)) {
    const source = join(original, name);
    if (name.startsWith("@") && lstatSync(source).isDirectory()) {
      for (const child of readdirSync(source)) linkOne(`${name}/${child}`, join(source, child));
    } else linkOne(name, source);
  }
}
