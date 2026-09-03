import type {
  RunStore,
  SecretResolver,
  TerminalReportArtifact,
  TerminalReportChange,
  TerminalReportContent,
  TerminalReportCorrection,
  TerminalReportEvidenceSnapshot,
  TerminalReportParticipant,
  TerminalReportRisk,
  TerminalReportSourceRef,
  TerminalReportVerification,
} from "@ling-stack/core";
import { validateTerminalReportContent } from "@ling-stack/core";
import type { RunnerRegistry } from "../../runtime/runners.js";
import { extractAssistantText } from "../../shared/assistant-text.js";
import { resolveProviderForRun } from "../runs/providers.js";
import { LING_AGENT_EXECUTOR_ID } from "./ling-agent-executor.js";
import { parseStrictJsonObject } from "./model-json.js";
import {
  buildTerminalReportPrompt,
  TERMINAL_REPORT_PROMPT_VERSION,
  TERMINAL_REPORT_SYSTEM_PROMPT,
} from "./terminal-report-prompt.js";

export interface TerminalReportSynthesisInput {
  readonly store: RunStore;
  readonly snapshot: TerminalReportEvidenceSnapshot;
  readonly runnerRegistry?: RunnerRegistry;
  readonly secretResolver?: SecretResolver;
  readonly timeoutMs?: number;
}

export interface TerminalReportSynthesisResult {
  readonly mode: "model" | "deterministic_fallback";
  readonly content?: TerminalReportContent;
  readonly providerPresetId?: string;
  readonly providerModel?: string;
  readonly requestedRunnerId?: string;
  readonly effectiveRunnerId?: string;
  readonly attemptCount: number;
  readonly validationCodes: readonly string[];
  readonly fallbackReason?: string;
  readonly latencyMs: number;
}

export async function synthesizeTerminalReportContent(
  input: TerminalReportSynthesisInput,
): Promise<TerminalReportSynthesisResult> {
  const startedAt = Date.now();
  if (!input.runnerRegistry || !input.secretResolver) {
    return fallbackResult(startedAt, "terminal_report_model_runtime_unavailable");
  }
  const resolved = resolveSynthesisRuntime({
    store: input.store,
    snapshot: input.snapshot,
    runnerRegistry: input.runnerRegistry,
    secretResolver: input.secretResolver,
  });
  if (!resolved) {
    return fallbackResult(startedAt, "terminal_report_provider_unavailable");
  }

  let previousOutput = "";
  let validationCodes: string[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const prompt = buildTerminalReportPrompt(
      input.snapshot,
      attempt === 2 ? { validationCodes, previousOutput } : undefined,
    );
    let output: string;
    try {
      output = await requestTerminalReportModel({
        ...input,
        prompt: prompt.prompt,
        providerPresetId: resolved.providerPresetId,
        runnerResolution: resolved.runnerResolution,
      });
    } catch (error) {
      const code = error instanceof TerminalReportSynthesisTimeoutError
        ? "terminal_report_synthesis_timeout"
        : "terminal_report_synthesis_request_failed";
      return fallbackResult(startedAt, code, {
        providerPresetId: resolved.providerPresetId,
        providerModel: resolved.providerModel,
        requestedRunnerId: resolved.runnerResolution.requestedRunnerId,
        effectiveRunnerId: resolved.runnerResolution.effectiveRunnerId,
        attemptCount: attempt,
        validationCodes,
      });
    }
    previousOutput = output;
    try {
      const content = bindEvidenceFacts(
        parseTerminalReportContent(parseStrictJsonObject(output, "Terminal report model output")),
        input.snapshot,
      );
      const validation = validateTerminalReportContent(content, input.snapshot);
      if (validation.ok) {
        return {
          mode: "model",
          content,
          providerPresetId: resolved.providerPresetId,
          providerModel: resolved.providerModel,
          requestedRunnerId: resolved.runnerResolution.requestedRunnerId,
          effectiveRunnerId: resolved.runnerResolution.effectiveRunnerId,
          attemptCount: attempt,
          validationCodes,
          latencyMs: Date.now() - startedAt,
        };
      }
      validationCodes = [...new Set(validation.issues.map((issue) => issue.code))];
    } catch {
      validationCodes = ["terminal_report_schema_invalid"];
    }
  }

  return fallbackResult(startedAt, "terminal_report_synthesis_invalid_after_repair", {
    providerPresetId: resolved.providerPresetId,
    providerModel: resolved.providerModel,
    requestedRunnerId: resolved.runnerResolution.requestedRunnerId,
    effectiveRunnerId: resolved.runnerResolution.effectiveRunnerId,
    attemptCount: 2,
    validationCodes,
  });
}

function bindEvidenceFacts(
  content: TerminalReportContent,
  snapshot: TerminalReportEvidenceSnapshot,
): TerminalReportContent {
  const evidenceArtifacts = new Map(snapshot.artifacts.map((artifact) => [artifact.id, artifact]));
  const evidenceParticipants = new Map(snapshot.participants.map((participant) => [participant.agentId, participant]));
  return {
    ...content,
    // Participant rows are a semantic responsibility summary. Bind them to
    // Host-derived summaries so a model cannot copy a raw or materialized
    // command from the verification section into the participant narrative.
    participants: content.participants.map((participant) => {
      const evidence = evidenceParticipants.get(participant.agentId);
      const contribution = evidence?.contributionSummaries.filter(Boolean).join("; ").trim();
      return contribution ? { ...participant, contribution } : participant;
    }),
    artifacts: content.artifacts.map((artifact) => {
      const trustedFileRefs = evidenceArtifacts.get(artifact.id)?.sourceRefs.filter((ref) =>
        ref.kind === "file" && ref.visibility !== "developer_only" && ref.sensitivity !== "secret_adjacent"
      ) ?? [];
      if (trustedFileRefs.length === 0) {
        return artifact;
      }
      return {
        ...artifact,
        sourceRefs: uniqueTerminalReportSourceRefs([...artifact.sourceRefs, ...trustedFileRefs]),
      };
    }),
  };
}

function uniqueTerminalReportSourceRefs(
  refs: readonly TerminalReportSourceRef[],
): readonly TerminalReportSourceRef[] {
  return [...new Map(refs.map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
}

function resolveSynthesisRuntime(input: Required<Pick<TerminalReportSynthesisInput, "store" | "snapshot" | "runnerRegistry" | "secretResolver">>) {
  const ling = input.store.getAiTeammate(LING_AGENT_EXECUTOR_ID);
  const channel = input.snapshot.channelId ? input.store.getChannel(input.snapshot.channelId) : undefined;
  const sourceRunIds = input.snapshot.participants.flatMap((participant) => participant.runIds);
  const sourceRun = [...sourceRunIds].reverse().map((runId) => input.store.getRun(runId)).find(Boolean);
  const providerPresetIds = [...new Set([
    ling?.providerPresetId,
    channel?.defaultProviderPresetId,
    sourceRun?.providerPresetId,
  ].filter((id): id is string => Boolean(id)))];
  for (const providerPresetId of providerPresetIds) {
    try {
      const runnerResolution = input.runnerRegistry.resolve({
        requestedRunnerId: ling?.runnerId,
        requestSource: "product_default",
        tools: [],
        allowFallback: true,
      });
      const provider = resolveProviderForRun(input.store, {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task: {
          id: input.snapshot.id,
          title: "Ling terminal report synthesis",
          prompt: input.snapshot.objective,
          channelId: input.snapshot.channelId,
        },
        providerPresetId,
        tools: [],
        thinkingLevel: "low",
      }, input.secretResolver);
      return {
        providerPresetId,
        providerModel: provider.model,
        provider,
        runnerResolution,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function requestTerminalReportModel(input: TerminalReportSynthesisInput & {
  readonly prompt: string;
  readonly providerPresetId: string;
  readonly runnerResolution: ReturnType<RunnerRegistry["resolve"]>;
}): Promise<string> {
  if (!input.secretResolver) {
    throw new Error("Terminal report secret resolver is unavailable.");
  }
  const provider = resolveProviderForRun(input.store, {
    cwd: input.store.paths.cwd,
    workspaceCwd: input.store.paths.cwd,
    task: {
      id: input.snapshot.id,
      title: "Ling terminal report synthesis",
      prompt: input.prompt,
      channelId: input.snapshot.channelId,
    },
    providerPresetId: input.providerPresetId,
    tools: [],
    thinkingLevel: "low",
    systemPrompt: TERMINAL_REPORT_SYSTEM_PROMPT,
  }, input.secretResolver);
  const abortController = new AbortController();
  const timeoutMs = input.timeoutMs ?? 45_000;
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  const textDeltas: string[] = [];
  try {
    const result = await input.runnerResolution.runner.adapter.runTask({
      cwd: input.store.paths.cwd,
      task: {
        id: input.snapshot.id,
        title: `Terminal report ${TERMINAL_REPORT_PROMPT_VERSION}`,
        prompt: input.prompt,
        channelId: input.snapshot.channelId,
      },
      provider,
      tools: [],
      thinkingLevel: "low",
      systemPrompt: TERMINAL_REPORT_SYSTEM_PROMPT,
      signal: abortController.signal,
      onEvent: (event) => {
        if (event.type === "assistant_text_delta") {
          textDeltas.push(event.text);
        }
      },
    });
    if (abortController.signal.aborted) {
      throw new TerminalReportSynthesisTimeoutError();
    }
    return textDeltas.join("").trim() || extractAssistantText(result.messages) || "";
  } catch (error) {
    if (abortController.signal.aborted) {
      throw new TerminalReportSynthesisTimeoutError();
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function parseTerminalReportContent(record: Record<string, unknown>): TerminalReportContent {
  const outcomeRecord = requiredRecord(record.outcome, "outcome");
  const outcome = {
    status: requiredEnum(outcomeRecord.status, "outcome.status", ["succeeded", "partially_succeeded", "blocked", "failed", "cancelled"]),
    title: requiredString(outcomeRecord.title, "outcome.title"),
    summary: requiredString(outcomeRecord.summary, "outcome.summary"),
    corrections: optionalArray(outcomeRecord.corrections, "outcome.corrections").map(parseCorrection),
    sourceRefs: parseSourceRefs(outcomeRecord.sourceRefs, "outcome.sourceRefs"),
  } satisfies TerminalReportContent["outcome"];
  return {
    outcome,
    changes: optionalArray(record.changes, "changes").map(parseChange),
    verification: optionalArray(record.verification, "verification").map(parseVerification),
    participants: optionalArray(record.participants, "participants").map(parseParticipant),
    artifacts: optionalArray(record.artifacts, "artifacts").map(parseArtifact),
    risks: optionalArray(record.risks, "risks").map(parseRisk),
    references: parseSourceRefs(record.references ?? [], "references"),
  };
}

function parseCorrection(value: unknown, index: number): TerminalReportCorrection {
  const record = requiredRecord(value, `outcome.corrections.${index}`);
  return {
    id: requiredString(record.id, `outcome.corrections.${index}.id`),
    originalAssumption: requiredString(record.originalAssumption, `outcome.corrections.${index}.originalAssumption`),
    correctedFact: requiredString(record.correctedFact, `outcome.corrections.${index}.correctedFact`),
    confidence: requiredEnum(record.confidence, `outcome.corrections.${index}.confidence`, ["high", "medium"]),
    sourceRefs: parseSourceRefs(record.sourceRefs, `outcome.corrections.${index}.sourceRefs`),
  };
}

function parseChange(value: unknown, index: number): TerminalReportChange {
  const record = requiredRecord(value, `changes.${index}`);
  return {
    id: requiredString(record.id, `changes.${index}.id`),
    kind: requiredEnum(record.kind, `changes.${index}.kind`, ["behavior", "code", "configuration", "documentation", "data", "other"]),
    title: requiredString(record.title, `changes.${index}.title`),
    summary: requiredString(record.summary, `changes.${index}.summary`),
    paths: stringArray(record.paths, `changes.${index}.paths`),
    addedLines: optionalNumber(record.addedLines, `changes.${index}.addedLines`),
    deletedLines: optionalNumber(record.deletedLines, `changes.${index}.deletedLines`),
    sourceRefs: parseSourceRefs(record.sourceRefs, `changes.${index}.sourceRefs`),
  };
}

function parseVerification(value: unknown, index: number): TerminalReportVerification {
  const record = requiredRecord(value, `verification.${index}`);
  return {
    id: requiredString(record.id, `verification.${index}.id`),
    title: requiredString(record.title, `verification.${index}.title`),
    status: requiredEnum(record.status, `verification.${index}.status`, ["passed", "failed", "blocked", "cancelled", "skipped", "not_run", "unknown"]),
    summary: optionalString(record.summary, `verification.${index}.summary`),
    command: optionalString(record.command, `verification.${index}.command`),
    durationMs: optionalNumber(record.durationMs, `verification.${index}.durationMs`),
    sourceRefs: parseSourceRefs(record.sourceRefs, `verification.${index}.sourceRefs`),
  };
}

function parseParticipant(value: unknown, index: number): TerminalReportParticipant {
  const record = requiredRecord(value, `participants.${index}`);
  return {
    agentId: requiredString(record.agentId, `participants.${index}.agentId`),
    displayName: requiredString(record.displayName, `participants.${index}.displayName`),
    roleKey: optionalString(record.roleKey, `participants.${index}.roleKey`),
    status: requiredEnum(record.status, `participants.${index}.status`, ["completed", "failed", "blocked", "cancelled"]),
    contribution: requiredString(record.contribution, `participants.${index}.contribution`),
    sourceRefs: parseSourceRefs(record.sourceRefs, `participants.${index}.sourceRefs`),
  };
}

function parseArtifact(value: unknown, index: number): TerminalReportArtifact {
  const record = requiredRecord(value, `artifacts.${index}`);
  return {
    id: requiredString(record.id, `artifacts.${index}.id`),
    kind: requiredEnum(record.kind, `artifacts.${index}.kind`, ["file", "diff", "document", "image", "test_result", "commit", "pull_request", "deployment", "external", "other"]),
    title: requiredString(record.title, `artifacts.${index}.title`),
    path: optionalString(record.path, `artifacts.${index}.path`),
    href: optionalString(record.href, `artifacts.${index}.href`),
    summary: optionalString(record.summary, `artifacts.${index}.summary`),
    addedLines: optionalNumber(record.addedLines, `artifacts.${index}.addedLines`),
    deletedLines: optionalNumber(record.deletedLines, `artifacts.${index}.deletedLines`),
    sourceRefs: parseSourceRefs(record.sourceRefs, `artifacts.${index}.sourceRefs`),
  };
}

function parseRisk(value: unknown, index: number): TerminalReportRisk {
  const record = requiredRecord(value, `risks.${index}`);
  return {
    id: requiredString(record.id, `risks.${index}.id`),
    severity: requiredEnum(record.severity, `risks.${index}.severity`, ["info", "warning", "critical"]),
    status: requiredEnum(record.status, `risks.${index}.status`, ["unresolved", "mitigated", "accepted", "unverified"]),
    approvalDecision: record.approvalDecision === undefined
      ? undefined
      : requiredEnum(record.approvalDecision, `risks.${index}.approvalDecision`, ["pending", "approved", "denied", "expired", "cancelled"]),
    summary: requiredString(record.summary, `risks.${index}.summary`),
    nextAction: optionalString(record.nextAction, `risks.${index}.nextAction`),
    sourceRefs: parseSourceRefs(record.sourceRefs, `risks.${index}.sourceRefs`),
  };
}

function parseSourceRefs(value: unknown, path: string): TerminalReportSourceRef[] {
  return optionalArray(value, path).map((entry, index) => {
    const record = requiredRecord(entry, `${path}.${index}`);
    return {
      kind: requiredEnum(record.kind, `${path}.${index}.kind`, ["message", "turn", "task", "run", "workflow", "workflow_step", "operation", "execution_action", "approval", "artifact", "file", "check", "commit", "pull_request", "deployment", "memory", "context_source", "external"]),
      id: requiredString(record.id, `${path}.${index}.id`),
      label: optionalString(record.label, `${path}.${index}.label`),
      href: optionalString(record.href, `${path}.${index}.href`),
      visibility: requiredEnum(record.visibility, `${path}.${index}.visibility`, ["conversation", "folded_evidence", "developer_only"]),
      sensitivity: record.sensitivity === undefined ? undefined : requiredEnum(record.sensitivity, `${path}.${index}.sensitivity`, ["normal", "private", "secret_adjacent"]),
    };
  });
}

function requiredRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function optionalArray(value: unknown, path: string): unknown[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`${path} must be an array.`);
  }
  return value;
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a non-empty string.`);
  }
  return value.trim();
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${path} must be a string.`);
  }
  return value;
}

function optionalNumber(value: unknown, path: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${path} must be a finite number.`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  const values = optionalArray(value, path);
  if (values.some((entry) => typeof entry !== "string")) {
    throw new Error(`${path} must contain strings only.`);
  }
  return values as string[];
}

function requiredEnum<const T extends readonly string[]>(value: unknown, path: string, values: T): T[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error(`${path} is invalid.`);
  }
  return value as T[number];
}

function fallbackResult(
  startedAt: number,
  fallbackReason: string,
  metadata: Partial<Omit<TerminalReportSynthesisResult, "mode" | "fallbackReason" | "latencyMs">> = {},
): TerminalReportSynthesisResult {
  return {
    mode: "deterministic_fallback",
    attemptCount: metadata.attemptCount ?? 0,
    validationCodes: metadata.validationCodes ?? [],
    providerPresetId: metadata.providerPresetId,
    providerModel: metadata.providerModel,
    requestedRunnerId: metadata.requestedRunnerId,
    effectiveRunnerId: metadata.effectiveRunnerId,
    fallbackReason,
    latencyMs: Date.now() - startedAt,
  };
}

class TerminalReportSynthesisTimeoutError extends Error {
  constructor() {
    super("Terminal report synthesis timed out.");
  }
}
