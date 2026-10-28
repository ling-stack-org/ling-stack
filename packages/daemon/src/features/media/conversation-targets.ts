import {
  mediaGenerationTargetRefKey,
  normalizeProviderPresetForMediaRuntime,
  resolveMediaProviderRuntimeState,
  type MediaGenerationKind,
  type MediaGenerationTargetRef,
  type MediaGenerationTargetSummary,
  type WorkspaceMediaGenerationDefaults,
  type MediaWorkflowInputField,
  type MediaWorkflowVersion,
  type RunStore,
  type SecretResolver,
} from "@ling-stack/core";
import { toPublicProviderPreset } from "../providers/secrets.js";
import { effectiveMediaWorkflowProtocol } from "./workflows/media-protocol-contract.js";

const providerOperations = [
  { generationKind: "image", operation: "image_generate" },
  { generationKind: "video", operation: "video_generate" },
] as const;

export function listConversationMediaGenerationTargets(
  store: RunStore,
  secretResolver: SecretResolver,
): MediaGenerationTargetSummary[] {
  return includeDefaultRepairTargets(store, [
    ...listProviderTargets(store, secretResolver),
    ...listWorkflowTargets(store, secretResolver),
  ]);
}

export function assertMediaGenerationDefaultUpdate(input: {
  readonly current: WorkspaceMediaGenerationDefaults | undefined;
  readonly next: WorkspaceMediaGenerationDefaults | null | undefined;
  readonly targets: readonly MediaGenerationTargetSummary[];
}): void {
  if (input.next === undefined || input.next === null) return;
  for (const generationKind of ["image", "video"] as const) {
    const nextRef = input.next[generationKind];
    if (!nextRef || sameTargetRef(nextRef, input.current?.[generationKind])) continue;
    const targetKey = mediaGenerationTargetRefKey(nextRef);
    const matchingRefTargets = input.targets.filter(
      (target) => mediaGenerationTargetRefKey(target.ref) === targetKey,
    );
    const target = matchingRefTargets.find((candidate) => candidate.generationKind === generationKind);
    if (!target) {
      const label = generationKind === "image" ? "image" : "video";
      if (matchingRefTargets.length > 0) {
        throw new Error(`The selected generation target does not support ${label} generation.`);
      }
      throw new Error(`The selected ${label} generation target does not exist.`);
    }
    if (!target.runnable) {
      throw new Error(target.unavailableReason ?? `The selected ${generationKind} generation target is not runnable.`);
    }
  }
}

function sameTargetRef(
  left: MediaGenerationTargetRef,
  right: MediaGenerationTargetRef | undefined,
): boolean {
  return Boolean(right && mediaGenerationTargetRefKey(left) === mediaGenerationTargetRefKey(right));
}

function listProviderTargets(store: RunStore, secretResolver: SecretResolver): MediaGenerationTargetSummary[] {
  const targets: MediaGenerationTargetSummary[] = [];
  for (const storedProvider of store.listProviderPresets()) {
    const provider = toPublicProviderPreset(
      store,
      normalizeProviderPresetForMediaRuntime(storedProvider),
      secretResolver,
    );
    for (const candidate of providerOperations) {
      if (!provider.capabilities.includes(candidate.operation)) {
        continue;
      }
      const runtime = resolveMediaProviderRuntimeState(provider, candidate.operation);
      const checkReady = provider.lastCheck?.ok === true;
      const supportsAspectRatio = candidate.generationKind === "image"
        ? Boolean(runtime.imageGeneration?.aspectRatios?.length)
        : Boolean(runtime.videoGeneration?.aspectRatios?.length);
      targets.push({
        id: `provider:${provider.id}`,
        ref: { kind: "provider", providerPresetId: provider.id },
        generationKind: candidate.generationKind,
        displayName: providerTargetDisplayName(provider),
        aliases: uniqueLabels([provider.model, provider.providerId, `${provider.providerId}/${provider.model}`]),
        runnable: runtime.canRun && checkReady,
        unavailableReason: !runtime.canRun
          ? providerUnavailableReason(runtime.reason)
          : checkReady
            ? undefined
            : "The generation model has not passed its latest check.",
        aspectRatios: candidate.generationKind === "image"
          ? runtime.imageGeneration?.aspectRatios
          : runtime.videoGeneration?.aspectRatios,
        sizeByAspectRatio: candidate.generationKind === "image"
          ? runtime.imageGeneration?.sizeByAspectRatio
          : undefined,
        durationsSeconds: runtime.videoGeneration?.durationsSeconds,
        supportsAspectRatio,
        supportsDurationSeconds: Boolean(runtime.videoGeneration?.durationsSeconds),
        supportsCount: candidate.generationKind === "image" && (runtime.imageGeneration?.maxCount ?? 1) > 1,
      });
    }
  }
  return targets;
}

function providerTargetDisplayName(
  provider: Pick<ReturnType<typeof toPublicProviderPreset>, "displayName" | "model" | "providerId">,
): string {
  return provider.providerId === "custom-openai-compatible"
    ? provider.model.trim() || provider.displayName.trim()
    : provider.displayName.trim() || provider.model.trim();
}

function listWorkflowTargets(store: RunStore, secretResolver: SecretResolver): MediaGenerationTargetSummary[] {
  const targets: MediaGenerationTargetSummary[] = [];
  for (const definition of store.listMediaWorkflowDefinitions()) {
    const activeVersion = definition.currentVersionId
      ? store.getMediaWorkflowVersion(definition.currentVersionId)
      : undefined;
    const version = activeVersion ?? store.listMediaWorkflowVersions(definition.id)[0];
    if (!version) {
      continue;
    }
    const connection = store.getMediaWorkflowConnection(definition.connectionId);
    const secretConfigured = connection?.authMode === "none" || Boolean(
      connection?.secretRef && secretResolver.status(connection.secretRef, "workflow_api_key").configured,
    );
    const baseReadiness = workflowBaseReadiness(
      definition.status,
      Boolean(activeVersion),
      version,
      connection?.status,
      secretConfigured,
    ) ?? workflowProtocolReadiness(connection);
    const supportedKinds = new Set(version.outputRules.map((rule) => rule.artifactType));
    for (const generationKind of ["image", "video"] as const) {
      if (!supportedKinds.has(generationKind)) {
        continue;
      }
      const inputReadiness = workflowInputReadiness(version.inputFields);
      const unavailableReason = baseReadiness ?? inputReadiness;
      const ratioField = version.inputFields.find((field) => field.semantic === "ratio");
      const durationField = version.inputFields.find((field) => field.semantic === "duration");
      targets.push({
        id: `workflow:${definition.id}`,
        ref: { kind: "workflow", workflowDefinitionId: definition.id },
        generationKind,
        displayName: definition.name,
        aliases: uniqueLabels([definition.id, definition.description ?? ""]),
        runnable: unavailableReason === undefined,
        unavailableReason,
        aspectRatios: readWorkflowStringOptions(version.inputFields, "ratio"),
        durationsSeconds: readWorkflowNumberOptions(version.inputFields, "duration"),
        supportsAspectRatio: Boolean(ratioField),
        supportsDurationSeconds: Boolean(durationField),
        supportsCount: false,
      });
    }
  }
  return targets;
}

function workflowProtocolReadiness(
  connection: ReturnType<RunStore["getMediaWorkflowConnection"]>,
): string | undefined {
  if (!connection) return undefined;
  const protocol = effectiveMediaWorkflowProtocol(connection);
  if (protocol === "prompt_legacy") {
    return "The ComfyUI Prompt/History protocol is read-only for historical jobs; switch the connection to Jobs API before creating new media tasks.";
  }
  return protocol === "jobs_v1" ? undefined : "The ComfyUI connection has not completed a Jobs API check.";
}

function workflowBaseReadiness(
  definitionStatus: string,
  hasActiveVersion: boolean,
  version: MediaWorkflowVersion,
  connectionStatus: string | undefined,
  secretConfigured: boolean,
): string | undefined {
  if (!hasActiveVersion) {
    return "The ComfyUI workflow has no active version.";
  }
  if (definitionStatus !== "ready" || !version.validation.ok) {
    return "The ComfyUI workflow is not active and ready.";
  }
  if (connectionStatus !== "ready") {
    return "The ComfyUI connection is not ready.";
  }
  if (!secretConfigured) {
    return "The ComfyUI connection credential is not configured.";
  }
  return undefined;
}

function workflowInputReadiness(fields: readonly MediaWorkflowInputField[]): string | undefined {
  const unsupported = fields.find((field) =>
    field.required &&
    field.defaultValue === undefined &&
    field.semantic !== "prompt" &&
    field.semantic !== "ratio" &&
    field.semantic !== "duration"
  );
  return unsupported
    ? `The ComfyUI workflow requires unsupported conversation input: ${unsupported.label}.`
    : undefined;
}

function readWorkflowStringOptions(
  fields: readonly MediaWorkflowInputField[],
  semantic: MediaWorkflowInputField["semantic"],
): readonly string[] | undefined {
  const options = fields.find((field) => field.semantic === semantic)?.options?.filter((value) => value.trim());
  return options && options.length > 0 ? options : undefined;
}

function readWorkflowNumberOptions(
  fields: readonly MediaWorkflowInputField[],
  semantic: MediaWorkflowInputField["semantic"],
): readonly number[] | undefined {
  const options = readWorkflowStringOptions(fields, semantic)
    ?.map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  return options && options.length > 0 ? options : undefined;
}

function providerUnavailableReason(reason: string | undefined): string {
  return reason ? `The generation model is unavailable: ${reason}.` : "The generation model is unavailable.";
}

function uniqueLabels(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function includeDefaultRepairTargets(
  store: RunStore,
  targets: readonly MediaGenerationTargetSummary[],
): MediaGenerationTargetSummary[] {
  const next = [...targets];
  const defaults = store.getWorkspaceSettings().mediaGenerationDefaults;
  for (const generationKind of ["image", "video"] as const) {
    const ref = defaults?.[generationKind];
    if (!ref) continue;
    const refKey = mediaGenerationTargetRefKey(ref);
    if (next.some((target) => target.generationKind === generationKind && mediaGenerationTargetRefKey(target.ref) === refKey)) {
      continue;
    }
    const repairTarget = defaultRepairTarget(store, generationKind, ref);
    if (repairTarget) next.push(repairTarget);
  }
  return next;
}

function defaultRepairTarget(
  store: RunStore,
  generationKind: MediaGenerationKind,
  ref: MediaGenerationTargetRef,
): MediaGenerationTargetSummary | undefined {
  if (ref.kind === "provider") {
    const provider = store.getProviderPreset(ref.providerPresetId);
    if (!provider) return undefined;
    return {
      id: `provider:${provider.id}`,
      ref,
      generationKind,
      displayName: provider.displayName,
      aliases: uniqueLabels([provider.model, provider.providerId, `${provider.providerId}/${provider.model}`]),
      runnable: false,
      unavailableReason: `The default generation model no longer supports ${generationKind} generation.`,
    };
  }
  const definition = store.getMediaWorkflowDefinition(ref.workflowDefinitionId);
  if (!definition) return undefined;
  return {
    id: `workflow:${definition.id}`,
    ref,
    generationKind,
    displayName: definition.name,
    aliases: uniqueLabels([definition.id, definition.description ?? ""]),
    runnable: false,
    unavailableReason: `The default ComfyUI workflow no longer supports ${generationKind} generation.`,
  };
}
