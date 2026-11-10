import { createHash } from "node:crypto";
import {
  DEFAULT_WORKSPACE_ID,
  resolveMediaGenerationTarget,
  type ConversationMediaOperation,
  type MediaGenerationTargetSummary,
  type MediaWorkflowInputField,
  type MediaWorkflowVersion,
  type RunSession,
  type RunStore,
  type SecretResolver,
  type WorkUnitKind,
} from "@ling-stack/core";
import type {
  PiRunnerMediaGenerationToolCallRequest,
  PiRunnerMediaGenerationToolCallResult,
  PiRunnerMediaGenerationToolDefinition,
} from "@ling-stack/runner-pi";
import type { ControlPlaneEventHub } from "../control-plane/events.js";
import { appendControlPlaneEvent } from "../control-plane/events.js";
import {
  retryRuntimeWorkUnit,
  startRuntimeWorkUnit,
  transitionWorkUnitCancelled,
  transitionWorkUnitTerminal,
} from "../../runtime/work-units.js";
import type { RuntimeSupervisor } from "../../runtime/supervisor.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import type { AttemptLocalWriterGroup } from "../../runtime/attempt-local-writers.js";
import type { AttemptHostOperationTracker } from "../../runtime/attempt-host-operation-tracker.js";
import { MediaLocalExecutionAdmissionError, type MediaLocalExecutionHandle, type MediaLocalExecutionReservation } from "../../runtime/media-local-executions.js";
import { bindHostMediaOperation, reserveHostMediaOperation, type HostMediaOperation } from "./host-operation.js";
import { dispatchMediaJobExecution, type RunMediaJobHooks } from "./executor.js";
import { listConversationMediaGenerationTargets } from "./conversation-targets.js";
import { publishConversationMediaProjectionChange } from "./conversation-events.js";

const trackedMediaHandlers = new WeakSet<Function>();

/** Only the production handler can enroll its real background execution chain. */
export function isTrackedConversationMediaGenerationToolHandler(handler: Function): boolean {
  return trackedMediaHandlers.has(handler);
}

export function createConversationMediaGenerationToolDefinitions(
  targets: readonly MediaGenerationTargetSummary[],
): PiRunnerMediaGenerationToolDefinition[] {
  return ([
    { name: "image_generate", generationKind: "image" },
    { name: "video_generate", generationKind: "video" },
  ] as const).flatMap(({ name, generationKind }) => {
    const runnable = targets.filter((target) => target.generationKind === generationKind && target.runnable);
    return runnable.length > 0 ? [{
      name,
      targets: runnable.map((target) => ({
        id: target.id,
        displayName: target.displayName,
        aspectRatios: target.aspectRatios,
        durationsSeconds: target.durationsSeconds,
        supportsAspectRatio: target.supportsAspectRatio,
        supportsDurationSeconds: target.supportsDurationSeconds,
        supportsCount: target.supportsCount,
      })),
    }] : [];
  });
}

export function isConversationMediaGenerationEligible(input: {
  readonly createdByActor?: string;
  readonly workUnitKind: WorkUnitKind;
}): boolean {
  return input.createdByActor === "local-user" && (
    input.workUnitKind === "conversation_run" ||
    input.workUnitKind === "channel_ai_reply" ||
    input.workUnitKind === "teammate_direct_reply"
  );
}

export function createConversationMediaGenerationToolHandler(input: {
  readonly store: RunStore;
  readonly storeRegistry: RunStoreRegistry;
  readonly secretResolver: SecretResolver;
  readonly runtimeSupervisor: RuntimeSupervisor;
  readonly run: RunSession;
  readonly linkedMessageId?: string;
  readonly controlPlaneEvents?: ControlPlaneEventHub;
  readonly launchMediaJob?: (mediaJobId: string) => void;
  /** Resolved once at actual callback entry, never during Run preparation. */
  readonly getExecutionContext?: () => {
    readonly localWriters: AttemptLocalWriterGroup;
    readonly hostOperationTracker: AttemptHostOperationTracker;
  } | undefined;
}): (request: PiRunnerMediaGenerationToolCallRequest) => PiRunnerMediaGenerationToolCallResult {
  const nextCreatedAt = createMonotonicTimestamp();
  const capturedOperations = new Map<string, { readonly digest: string; readonly host: HostMediaOperation }>();
  const retiredToolCalls = new Set<string>();
  const handler = (request: PiRunnerMediaGenerationToolCallRequest): PiRunnerMediaGenerationToolCallResult => {
    const captured = input.getExecutionContext?.();
    if (input.getExecutionContext && !captured) {
      return toolFailure("media_host_context_unavailable", "The captured Media execution context is not available; no job was created.");
    }
    request.signal?.throwIfAborted();
    if (request.runId !== input.run.id) {
      return toolFailure("invalid_media_tool_run", "The generation tool call does not belong to the active run.");
    }
    const operation: ConversationMediaOperation = request.toolName;
    const generationKind = operation === "image_generate" ? "image" : "video";
    const targets = listConversationMediaGenerationTargets(input.store, input.secretResolver);
    const resolution = resolveMediaGenerationTarget({
      generationKind,
      requestedTarget: request.target,
      defaultTarget: input.store.getWorkspaceSettings().mediaGenerationDefaults?.[generationKind],
      targets,
    });
    if (!resolution.ok) {
      return toolFailure(
        resolution.code,
        formatResolutionFailure(resolution.message, resolution.candidates),
        resolution.candidates,
      );
    }
    let reservation: MediaLocalExecutionReservation | undefined;
    let localExecution: MediaLocalExecutionHandle | undefined;
    let newlyReservedHost: HostMediaOperation | undefined;
    let capturedOperation: { readonly digest: string; readonly host: HostMediaOperation } | undefined;
    try {
      const mediaJobInput = buildMediaJobInput(input.store, resolution.target, request, operation);
      if (captured) {
        if (retiredToolCalls.has(request.toolCallId)) throw new Error("media_tool_identity_retired: use a new tool call identity for an explicit retry.");
        if (input.launchMediaJob) throw new Error("media_host_launch_unsupported: a void launcher cannot prove its background lifetime.");
        const digest = createHash("sha256").update(JSON.stringify({
          source: captured.hostOperationTracker.source,
          cwd: input.store.paths.cwd,
          toolCallId: request.toolCallId,
          target: resolution.target.ref,
          mediaJobInput,
        })).digest("hex");
        const previous = capturedOperations.get(request.toolCallId);
        if (previous && previous.digest !== digest) throw new Error("media_reuse_identity_conflict");
        const host = previous?.host ?? (newlyReservedHost = reserveHostMediaOperation(captured.hostOperationTracker, request.toolCallId));
        const source = captured.hostOperationTracker.source;
        const assertParentLineage = (): void => {
          const run = input.store.getRun(source.runId);
          const unit = input.store.getWorkUnit(source.workUnitId);
          const attempt = input.store.getWorkUnitAttempt(source.attemptId);
          if (run?.workUnitId !== source.workUnitId || unit?.linkedRunId !== source.runId
            || unit.activeAttemptId !== source.attemptId || attempt?.workUnitId !== source.workUnitId
            || attempt.runtimeInstanceId !== source.runtimeInstanceId || attempt.fencingToken !== source.fencingToken) {
            throw new MediaLocalExecutionAdmissionError("parent_source_obsolete", "Media parent execution identity was replaced.");
          }
        };
        reservation = input.storeRegistry.mediaLocalExecutions.reserve({
          source: captured.hostOperationTracker.source,
          requestDigest: digest,
          toolCallId: request.toolCallId,
          localWriters: captured.localWriters,
          effectGate: mode => {
            assertParentLineage();
            if (mode === "forward") {
              if (previous) captured.hostOperationTracker.executorGroup.assertAdmissionOpen();
              else host.assertMayPrepare();
            }
          },
          launchEffect: (mode, effect) => {
            try { host.launchEffect(mode, effect); }
            catch (error) {
              if (error instanceof MediaLocalExecutionAdmissionError) throw error;
              throw new MediaLocalExecutionAdmissionError("host_effect_unconfirmed", error instanceof Error ? error.message : String(error));
            }
          },
          completionGate: assertParentLineage,
          ...(previous ? {} : { onLocalCompleted: () => host.finish() }),
        });
        capturedOperation = { digest, host };
      }
      const created = input.store.createOrReuseConversationMediaJob({
        runId: input.run.id,
        linkedMessageId: input.linkedMessageId,
        channelId: input.run.channelId,
        teammateId: input.run.teammateId,
        idempotencyKey: `media_tool:${input.run.id}:${request.toolCallId}`,
        toolCallId: request.toolCallId,
        ...(captured && capturedOperation ? { executionAdmission: {
          schemaVersion: 1 as const,
          source: captured.hostOperationTracker.source,
          requestDigest: capturedOperation.digest,
        } } : {}),
        target: {
          id: resolution.target.id,
          ref: resolution.target.ref,
          generationKind,
          displayName: resolution.target.displayName,
        },
        mediaJob: mediaJobInput,
      }, nextCreatedAt());
      if (reservation) {
        const binding = { cwd: input.store.paths.cwd, mediaJobId: created.mediaJob.id, workUnitId: created.workUnit.id };
        localExecution = created.reused
          ? input.storeRegistry.mediaLocalExecutions.attachReused(reservation, binding)
          : input.storeRegistry.mediaLocalExecutions.bindNew(reservation, binding);
        if (capturedOperation) {
          bindHostMediaOperation(capturedOperation.host, localExecution);
          capturedOperations.set(request.toolCallId, capturedOperation);
        }
      }
      if (!created.reused) {
        input.store.appendRuntimeEvent({
          workUnitId: created.workUnit.id,
          type: "work_unit_created",
          actor: "system",
          ts: created.workUnit.createdAt,
          data: {
            kind: created.workUnit.kind,
            source: "conversation_media_tool",
            runId: input.run.id,
            mediaJobId: created.mediaJob.id,
          },
        });
        appendConversationMediaControlPlaneEvent(input, created.workUnit.id, created.mediaJob.id, "media_job.created");
        if (input.launchMediaJob) {
          input.launchMediaJob(created.mediaJob.id);
        } else {
          dispatchMediaJobExecution({
            cwd: input.store.paths.cwd,
            storeRegistry: input.storeRegistry,
            secretResolver: input.secretResolver,
            mediaJobId: created.mediaJob.id,
            localExecution,
            hooks: createMediaJobHooks(
              input.runtimeSupervisor,
              input.storeRegistry,
              input.controlPlaneEvents,
            ),
          });
        }
      }
      return {
        content: [{
          type: "text",
          text: created.reused
            ? `${generationKind === "image" ? "Image" : "Video"} generation task already exists and remains ${created.mediaJob.status}.`
            : `${generationKind === "image" ? "Image" : "Video"} generation started with ${resolution.target.displayName}.`,
        }],
        details: {
          mediaJobId: created.mediaJob.id,
          status: created.mediaJob.status,
          targetId: resolution.target.id,
          targetDisplayName: resolution.target.displayName,
          reused: created.reused,
        },
      };
    } catch (error) {
      if (newlyReservedHost && !localExecution) retiredToolCalls.add(request.toolCallId);
      if (localExecution) {
        // Binding already happened. Finish this exact error tail through the
        // same capability, never abandon a bound background writer.
        try { void input.storeRegistry.mediaLocalExecutions.track(localExecution, () => { throw error; }).catch(() => {}); }
        catch { /* A stopped/prepared generation is already completing under its registry owner. */ }
      } else if (reservation) input.storeRegistry.mediaLocalExecutions.abandon(reservation);
      else if (newlyReservedHost) {
        try { newlyReservedHost.finish(); } catch { /* The tracker retains the unconfirmed durable blocker. */ }
      }
      return toolFailure(
        "generation_input_invalid",
        error instanceof Error ? error.message : String(error),
      );
    }
  };
  if (input.getExecutionContext) trackedMediaHandlers.add(handler);
  return handler;
}

function createMonotonicTimestamp(): () => string {
  let previous = 0;
  return () => {
    previous = Math.max(Date.now(), previous + 1);
    return new Date(previous).toISOString();
  };
}

function buildMediaJobInput(
  store: RunStore,
  target: MediaGenerationTargetSummary,
  request: PiRunnerMediaGenerationToolCallRequest,
  operation: ConversationMediaOperation,
): {
  readonly providerPresetId?: string;
  readonly workflowVersionId?: string;
  readonly operation: ConversationMediaOperation;
  readonly prompt: string;
  readonly input?: Record<string, unknown>;
} {
  assertRequestedOptionsSupported(target, request);
  if (target.ref.kind === "provider") {
    const mediaInput: Record<string, unknown> = {};
    if (operation === "image_generate") {
      if (request.aspectRatio) mediaInput.size = imageSizeForRatio(target, request.aspectRatio);
      if (request.count !== undefined) mediaInput.n = request.count;
    } else {
      if (request.aspectRatio) mediaInput.ratio = request.aspectRatio;
      if (request.durationSeconds !== undefined) mediaInput.duration = request.durationSeconds;
    }
    return {
      providerPresetId: target.ref.providerPresetId,
      operation,
      prompt: request.prompt,
      input: Object.keys(mediaInput).length > 0 ? mediaInput : undefined,
    };
  }
  const definition = store.getMediaWorkflowDefinition(target.ref.workflowDefinitionId);
  const version = definition?.currentVersionId
    ? store.getMediaWorkflowVersion(definition.currentVersionId)
    : undefined;
  if (!definition || definition.status !== "ready" || !version || !version.validation.ok) {
    throw new Error(`The ComfyUI workflow is no longer ready: ${target.displayName}.`);
  }
  return {
    workflowVersionId: version.id,
    operation,
    prompt: request.prompt,
    input: { workflowInputValues: buildWorkflowInputValues(version, request) },
  };
}

function buildWorkflowInputValues(
  version: MediaWorkflowVersion,
  request: PiRunnerMediaGenerationToolCallRequest,
): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const field of version.inputFields) {
    const value = workflowFieldValue(field, request);
    if (value !== undefined) values[field.id] = value;
    if (field.required && value === undefined && field.semantic !== "prompt") {
      throw new Error(`The ComfyUI workflow requires input: ${field.label}.`);
    }
  }
  return values;
}

function workflowFieldValue(
  field: MediaWorkflowInputField,
  request: PiRunnerMediaGenerationToolCallRequest,
): unknown {
  if (field.semantic === "prompt") return request.prompt;
  if (field.semantic === "ratio" && request.aspectRatio !== undefined) return request.aspectRatio;
  if (field.semantic === "duration" && request.durationSeconds !== undefined) return request.durationSeconds;
  return field.defaultValue;
}

function assertRequestedOptionsSupported(
  target: MediaGenerationTargetSummary,
  request: PiRunnerMediaGenerationToolCallRequest,
): void {
  if (request.aspectRatio && !target.supportsAspectRatio) {
    throw new Error(`${target.displayName} does not support an aspect ratio input.`);
  }
  if (request.aspectRatio && target.aspectRatios && !target.aspectRatios.includes(request.aspectRatio)) {
    throw new Error(`${target.displayName} does not support aspect ratio ${request.aspectRatio}.`);
  }
  if (
    request.durationSeconds !== undefined &&
    !target.supportsDurationSeconds
  ) {
    throw new Error(`${target.displayName} does not support a duration input.`);
  }
  if (
    request.durationSeconds !== undefined &&
    target.durationsSeconds &&
    !target.durationsSeconds.includes(request.durationSeconds)
  ) {
      throw new Error(`${target.displayName} does not support duration ${request.durationSeconds} seconds.`);
  }
  if (request.count !== undefined && !target.supportsCount) {
    throw new Error(`${target.displayName} does not support an image count input.`);
  }
}

function imageSizeForRatio(target: MediaGenerationTargetSummary, ratio: string): string {
  const size = target.sizeByAspectRatio?.[ratio];
  if (size) return size;
  throw new Error(`${target.displayName} does not have a verified size for aspect ratio ${ratio}.`);
}

function formatResolutionFailure(message: string, candidates: readonly MediaGenerationTargetSummary[]): string {
  if (candidates.length === 0) return message;
  return `${message} Available targets: ${candidates.map((target) => target.displayName).join(", ")}.`;
}

function toolFailure(
  code: string,
  message: string,
  candidates: readonly MediaGenerationTargetSummary[] = [],
): PiRunnerMediaGenerationToolCallResult {
  return {
    content: [{ type: "text", text: message }],
    details: {
      code,
      candidates: candidates.map((target) => ({ id: target.id, displayName: target.displayName })),
    },
    isError: true,
  };
}

function createMediaJobHooks(
  runtimeSupervisor: RuntimeSupervisor,
  storeRegistry: RunStoreRegistry,
  controlPlaneEvents?: ControlPlaneEventHub,
): RunMediaJobHooks {
  return {
    startRuntimeWorkUnit: (request) => startRuntimeWorkUnit({ ...request, runtimeSupervisor }),
    recoverRuntimeWorkUnit: (request) => retryRuntimeWorkUnit({ ...request, runtimeSupervisor }),
    transitionRuntimeWorkUnitTerminal: (request) => {
      transitionWorkUnitTerminal(request.store, {
        workUnitId: request.workUnitId,
        attemptId: request.attemptId,
        event: request.event,
        attemptStatus: request.attemptStatus,
        runtimeEventType: request.runtimeEventType,
        actor: request.actor,
        now: request.now,
        errorCode: request.errorCode,
        errorMessage: request.errorMessage,
      });
    },
    transitionRuntimeWorkUnitCancelled: (request) => {
      transitionWorkUnitCancelled(
        request.store,
        request.workUnitId,
        request.attemptId,
        request.reason,
      );
    },
    ...(controlPlaneEvents ? {
      onMediaJobProjectionChanged: (request) => {
        publishConversationMediaProjectionChange({
          store: storeRegistry.getStore(request.cwd),
          controlPlaneEvents,
          mediaJobId: request.mediaJobId,
          createdArtifactIds: request.createdArtifactIds,
        });
      },
    } : {}),
  };
}

function appendConversationMediaControlPlaneEvent(
  input: {
    readonly store: RunStore;
    readonly controlPlaneEvents?: ControlPlaneEventHub;
    readonly run: RunSession;
  },
  workUnitId: string,
  mediaJobId: string,
  action: string,
): void {
  if (!input.controlPlaneEvents) return;
  appendControlPlaneEvent(input.store, input.controlPlaneEvents, {
    workspaceId: DEFAULT_WORKSPACE_ID,
    cwd: input.store.paths.cwd,
    domain: "work_units",
    entityType: "work_unit",
    entityId: workUnitId,
    action,
    data: { runId: input.run.id, mediaJobId },
  }, new Date().toISOString());
}
