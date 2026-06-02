import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFileSync } from "node:child_process";
import { lookup } from "node:dns/promises";
import { mkdirSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { basename, extname, isAbsolute, join, relative, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import {
  approvalToolDecisions,
  approvalStatuses,
  createBuiltinAiTeammateId,
  createRunId,
  createSqliteRunStore,
  defaultApprovalToolDecisions,
  DEFAULT_WORKSPACE_ID,
  defaultProviderTemplates,
  getRunSummaryPath,
  buildExternalWorkActionView,
  cancelExternalWorkAction,
  executeExternalWorkAction,
  normalizeGitHubExternalWorkItem,
  normalizeLinearExternalWorkItem,
  pollGitHubExternalWork,
  pollLinearExternalWork,
  parseExternalWorkflowMarkdown,
  parseSecretRef,
  proposeExternalWorkAction,
  reconcileExternalWork,
  renderExternalWorkflowPrompt,
  syncExternalWorkActionForApproval,
  updateExternalWorkflowSecretRef,
  buildExternalWorkCiTriageView,
  triageGitHubExternalWorkCi,
  listBuiltinSkillPackExtensions,
  listBuiltinToolExtensions,
  isSupportedSecretRef,
  mediaJobStatuses,
  mediaOperations,
  providerApis,
  providerCapabilities,
  providerKinds,
  redactSecrets,
  readOnlyRunTools,
  riskyRunTools,
  createCompositeSecretResolver,
  secretPurposes,
  taskStatuses,
  writeRunSummary,
  type ApprovalPayload,
  type ApprovalPolicy,
  type ApprovalPolicyUpdateInput,
  type ApprovalRequest,
  type ApprovalRisk,
  type ApprovalStatus,
  type ApprovalToolDecision,
  type ArtifactType,
  type AiTeammate,
  type AiTeammateUpdateInput,
  type ChannelAttachment,
  type ChannelAttachmentKind,
  type ChannelBrief,
  channelContextSummaryAuthorTypes,
  channelContextSummaryTargetTypes,
  channelWorkflowStatuses,
  channelWorkflowStepStatuses,
  type ChannelContextSummaryAuthorType,
  type ChannelContextSummaryTargetType,
  channelDecisionStatuses,
  type ChannelDecisionStatus,
  type ChannelExecutionProposal,
  type ChannelExecutionProposalStep,
  type ChannelExecutionProposalStatus,
  channelHandoffStatuses,
  type ChannelHandoff,
  type ChannelHandoffStatus,
  type ChannelWorkflowStatus,
  type ChannelWorkflowStepStartMode,
  type ChannelWorkflowStepStatus,
  type ChannelLinkPreview,
  type ChannelMention,
  type ChannelMessage,
  type ChannelMessageAuthorType,
  type ChannelMessageIntent,
  type ChannelMessageKind,
  type CreateApprovalRequestInput,
  type CreateAiTeammateInput,
  type ChannelUpdateInput,
  type Channel,
  type CreateMediaJobInput,
  type CreateChannelInput,
  type CreateChannelExecutionProposalInput,
  type CreateTaskInput,
  type MediaJob,
  type MediaJobStatus,
  type MediaOperation,
  type ProviderApi,
  type ProviderCapability,
  type ProviderCheckResult,
  type ProviderKind,
  type ProviderModelListRequest,
  type ProviderModelListResponse,
  type ProviderModelOption,
  type ProviderPreset,
  type ProviderPresetInput,
  type ProviderPresetUpdateInput,
  type PublicProviderPreset,
  type RunArtifact,
  type ExternalWorkImportResponse,
  type ExternalWorkBackgroundListResponse,
  type ExternalWorkBackgroundMutationResponse,
  type ExternalWorkBackgroundScheduler,
  type ExternalWorkGitHubBackgroundStartRequest,
  type ExternalWorkActionDetailResponse,
  type ExternalWorkActionExecuteRequest,
  type ExternalWorkActionKind,
  type ExternalWorkActionListResponse,
  type ExternalWorkActionMutationResponse,
  type ExternalWorkActionStatus,
  type ExternalWorkCiTriageRequest,
  type ExternalWorkCiTriageDetailResponse,
  type ExternalWorkCiTriageListResponse,
  type ExternalWorkCiTriageRunRequest,
  type ExternalWorkCiTriageResponse,
  type ExternalWorkCiTriageStatus,
  type ExternalWorkItem,
  type ExternalWorkDetailResponse,
  type ExternalWorkListResponse,
  type ExternalWorkRecord,
  type ExternalWorkSchedulerStatus,
  type ExternalWorkView,
  type ExternalWorkPollRequest,
  type ExternalWorkPollResponse,
  type ExternalWorkReconcileRequest,
  type ExternalWorkReconcileResponse,
  type ExternalWorkSecretConfigureRequest,
  type ExternalWorkSecretDeleteRequest,
  type ExternalWorkSecretMutationResponse,
  type ExternalWorkStatusResponse,
  type ExternalWorkWorkflowConfigureRequest,
  type ExternalWorkWorkflowMutationResponse,
  type ExternalSourceKind,
  type ExternalWorkItemKind,
  type ExternalWorkflowDefinition,
  type RunEventEnvelope,
  type RunEventType,
  type RunTool,
  type RunSession,
  type RunStore,
  type RunSummary,
  type RunStatus,
  type ResourceLease,
  type ReplaceTeammateChannelMembershipInput,
  type ReplaceTeammateMemoryScopeInput,
  type ReplaceTeammateSkillBindingInput,
  type ResolvedSecret,
  type SecretPurpose,
  type SecretResolver,
  type SkillApprovalProfile,
  type SecretStatus,
  type Task,
  type TaskStatus,
  type TaskUpdateInput,
  type UpdateChannelExecutionProposalInput,
} from "@ling-stack/core";
import {
  createPiRunner,
  getPiRunnerExtension,
  type PiRunnerApprovalRequest,
  type PiRunnerEvent,
  type PiRunnerProviderConfig,
  type PiRunnerResult,
  type PiRunnerRunOptions,
} from "@ling-stack/runner-pi";
import {
  createDefaultMediaAdapterRegistry,
  createLiveMediaVendorTransport,
  executeMediaJob as executeMediaAdapterJob,
  listBuiltinProviderExtensions,
  resolveMediaAdapter,
  resolveMediaVendorTransportGateConfig,
  type MediaExecutionArtifact,
} from "@ling-stack/providers";
import {
  createLingExtensionRegistry,
  type ChannelSourceExtensionMetadata,
  type LingExtensionRegistry,
} from "@ling-stack/plugin-sdk";

export interface DaemonConfig {
  readonly host?: string;
  readonly port?: number;
  readonly maxBodyBytes?: number;
  readonly defaultWorkspaceCwd?: string;
}

export interface ResolvedDaemonConfig {
  readonly host: string;
  readonly port: number;
  readonly maxBodyBytes: number;
  readonly defaultWorkspaceCwd: string;
}

export interface RunnerAdapter {
  runTask(options: PiRunnerRunOptions): Promise<PiRunnerResult>;
}

export type RunStoreFactory = (cwd: string) => RunStore;

export interface DaemonDependencies {
  readonly runner?: RunnerAdapter;
  readonly storeFactory?: RunStoreFactory;
  readonly extensionRegistry?: LingExtensionRegistry;
  readonly secretResolver?: SecretResolver;
  readonly externalSecretStore?: ExternalSecretStore;
  readonly externalWorkFetch?: typeof globalThis.fetch;
}

export interface ExternalSecretStore extends SecretResolver {
  setSecret(ref: string, value: string, purpose?: SecretPurpose): SecretStatus;
  deleteSecret(ref: string, purpose?: SecretPurpose): SecretStatus;
}

export const defaultDaemonConfig: DaemonConfig = {
  host: "127.0.0.1",
  port: 17891,
  maxBodyBytes: 1024 * 1024,
};

const APPROVAL_TIMEOUT_MS = 30 * 60 * 1000;
const APPROVAL_POLL_INTERVAL_MS = 500;
const APPROVAL_PREVIEW_LIMIT = 1_200;
const PROVIDER_CHECK_TIMEOUT_MS = 10_000;
const MAX_EXTRACTED_ARTIFACT_BYTES = 256 * 1024;
const MAX_EXTRACTED_ARTIFACTS_PER_TOOL = 6;
const CHANNEL_ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
const externalSourceKinds = ["github", "linear"] as const satisfies readonly ExternalSourceKind[];
const externalWorkItemKinds = ["github_pull_request", "github_issue", "linear_issue"] as const satisfies readonly ExternalWorkItemKind[];
const externalWorkActionKinds = ["github_comment", "github_label", "github_pr_review"] as const satisfies readonly ExternalWorkActionKind[];
const externalWorkActionStatuses = [
  "proposed",
  "waiting_for_approval",
  "approved",
  "executing",
  "succeeded",
  "failed",
  "cancelled",
  "denied",
  "expired",
  "stale_target",
] as const satisfies readonly ExternalWorkActionStatus[];
const externalWorkSchedulerStatuses = [
  "discovered",
  "claimed",
  "workspace_preparing",
  "ready",
  "blocked",
  "retry_wait",
  "terminal",
] as const satisfies readonly ExternalWorkSchedulerStatus[];
const externalWorkCiTriageStatuses = [
  "triaged",
  "task_created",
  "run_requested",
  "blocked",
  "stale",
  "failed",
] as const satisfies readonly ExternalWorkCiTriageStatus[];
const CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES = 40 * 1024 * 1024;
const CHANNEL_LINK_PREVIEW_TIMEOUT_MS = 5_000;
const CHANNEL_LINK_PREVIEW_MAX_BYTES = 192 * 1024;
const CHANNEL_LINK_PREVIEW_MAX_REDIRECTS = 3;

export interface RunRequest extends Omit<PiRunnerRunOptions, "onApprovalRequired" | "onEvent" | "provider"> {
  readonly workspaceCwd?: string;
  readonly providerPresetId?: string;
  readonly provider?: PiRunnerProviderConfig;
  readonly approvalProfile?: SkillApprovalProfile;
  readonly skipProviderPreflight?: boolean;
  readonly idempotencyKey?: string;
}

interface ExecuteRunRequestOptions {
  readonly onRunReady?: (runId: string) => void;
}

interface ChannelMessageRequest {
  readonly threadId?: string;
  readonly kind?: ChannelMessageKind;
  readonly intent?: ChannelMessageIntent;
  readonly authorType: ChannelMessageAuthorType;
  readonly authorId?: string;
  readonly body: string;
  readonly mentions: readonly ChannelMention[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly linkedTaskId?: string;
  readonly linkedRunId?: string;
  readonly requestAiReply: boolean;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
}

interface ChannelExecutionProposalRequest {
  readonly sourceMessageId: string;
  readonly proposedByTeammateId: string;
  readonly title: string;
  readonly prompt: string;
  readonly assigneeTeammateId: string;
  readonly acceptanceCriteria: readonly string[];
  readonly collaborationSteps: readonly ChannelExecutionProposalStep[];
  readonly requiredTools: readonly RunTool[];
  readonly riskSummary?: string;
}

interface ChannelAttachmentRequest {
  readonly fileName: string;
  readonly contentType?: string;
  readonly contentBase64: string;
  readonly messageId?: string;
}

interface ChannelLinkPreviewRequest {
  readonly url: string;
  readonly messageId?: string;
}

interface ChannelBriefRequest {
  readonly objective: string;
  readonly scope: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly risks: readonly string[];
  readonly decisionIds: readonly string[];
  readonly attachmentIds: readonly string[];
  readonly linkPreviewIds: readonly string[];
  readonly updatedBy: string;
}

interface ChannelDecisionRequest {
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly title: string;
  readonly decision: string;
  readonly rationale?: string;
  readonly alternatives: readonly string[];
  readonly status?: ChannelDecisionStatus;
  readonly supersedesDecisionId?: string;
  readonly createdBy: string;
}

interface ChannelDecisionUpdateRequest {
  readonly title?: string;
  readonly decision?: string;
  readonly rationale?: string;
  readonly alternatives?: readonly string[];
  readonly status?: ChannelDecisionStatus;
}

interface ChannelHandoffRequest {
  readonly sourceMessageId?: string;
  readonly sourceTaskId?: string;
  readonly sourceRunId?: string;
  readonly fromParticipantId: string;
  readonly fromParticipantLabel: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly reason: string;
  readonly requiredInput: string;
  readonly expectedOutput: string;
  readonly status?: ChannelHandoffStatus;
  readonly createdBy: string;
}

interface ChannelHandoffUpdateRequest {
  readonly fromParticipantId?: string;
  readonly fromParticipantLabel?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly reason?: string;
  readonly requiredInput?: string;
  readonly expectedOutput?: string;
  readonly status?: ChannelHandoffStatus;
}

interface ChannelContextSummaryRequest {
  readonly targetType: ChannelContextSummaryTargetType;
  readonly targetId: string;
  readonly sourceMessageIds: readonly string[];
  readonly decisionIds: readonly string[];
  readonly summary: string;
  readonly acceptanceCriteria: readonly string[];
  readonly openQuestions: readonly string[];
  readonly authorType: ChannelContextSummaryAuthorType;
  readonly authorId?: string;
}

interface ChannelContextSummaryUpdateRequest {
  readonly targetType?: ChannelContextSummaryTargetType;
  readonly targetId?: string;
  readonly sourceMessageIds?: readonly string[];
  readonly decisionIds?: readonly string[];
  readonly summary?: string;
  readonly acceptanceCriteria?: readonly string[];
  readonly openQuestions?: readonly string[];
  readonly authorType?: ChannelContextSummaryAuthorType;
  readonly authorId?: string | null;
}

interface ChannelWorkflowRequest {
  readonly sourceHandoffId?: string;
  readonly title: string;
  readonly objective: string;
  readonly status?: ChannelWorkflowStatus;
  readonly createdBy: string;
}

interface ChannelWorkflowFromHandoffRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly contextSummaryId?: string;
  readonly createdBy: string;
}

interface ChannelWorkflowUpdateRequest {
  readonly title?: string;
  readonly objective?: string;
  readonly status?: ChannelWorkflowStatus;
}

interface ChannelWorkflowStepRequest {
  readonly sourceHandoffId?: string;
  readonly contextSummaryId?: string;
  readonly position?: number;
  readonly title: string;
  readonly prompt: string;
  readonly toParticipantId: string;
  readonly toParticipantLabel: string;
  readonly status?: ChannelWorkflowStepStatus;
}

interface ChannelWorkflowStepUpdateRequest {
  readonly sourceHandoffId?: string | null;
  readonly contextSummaryId?: string | null;
  readonly taskId?: string | null;
  readonly runId?: string | null;
  readonly position?: number;
  readonly title?: string;
  readonly prompt?: string;
  readonly toParticipantId?: string;
  readonly toParticipantLabel?: string;
  readonly status?: ChannelWorkflowStepStatus;
  readonly blocker?: string | null;
  readonly resultSummary?: string | null;
}

interface ChannelWorkflowStepStartRequest {
  readonly mode: ChannelWorkflowStepStartMode;
  readonly taskTitle?: string;
  readonly taskPrompt?: string;
  readonly providerPresetId?: string;
  readonly assigneeTeammateId?: string;
  readonly idempotencyKey?: string;
  readonly skipProviderPreflight?: boolean;
}

interface ExternalGitHubImportRequest {
  readonly channelId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowMarkdown?: string;
  readonly workflowPath?: string;
}

interface ExternalLinearImportRequest {
  readonly channelId: string;
  readonly eventType: string;
  readonly payload: unknown;
  readonly workflowMarkdown?: string;
  readonly workflowPath?: string;
}

interface PreparedRunConcurrency {
  readonly channel?: Channel;
  readonly taskExists: boolean;
  readonly leases: readonly ResourceLease[];
}

const RESOURCE_LEASE_TTL_MS = 6 * 60 * 60 * 1000;

export interface DaemonServer {
  readonly server: Server;
  readonly config: ResolvedDaemonConfig;
  readonly extensionRegistry: LingExtensionRegistry;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createDaemonServer(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): DaemonServer {
  const resolvedConfig = resolveConfig(config);
  const runner = dependencies.runner ?? createPiRunner();
  const extensionRegistry = dependencies.extensionRegistry ?? createDefaultLingExtensionRegistry();
  const externalSecretStore = dependencies.externalSecretStore ?? createSystemKeychainSecretStore();
  const secretResolver = dependencies.secretResolver ?? createCompositeSecretResolver({ keychainResolver: externalSecretStore });
  const externalWorkFetch = dependencies.externalWorkFetch;
  const storeRegistry = new RunStoreRegistry(dependencies.storeFactory ?? createSqliteRunStore);
  const backgroundSchedulers = new ExternalWorkBackgroundSchedulerRegistry(storeRegistry, secretResolver, externalWorkFetch);
  const activeRuns = new ActiveRunRegistry();
  const server = createServer(async (request, response) => {
    try {
      await routeRequest(request, response, resolvedConfig, runner, storeRegistry, activeRuns, secretResolver, externalSecretStore, externalWorkFetch, backgroundSchedulers);
    } catch (error) {
      if (!response.headersSent) {
        writeJson(response, 500, {
          error: "internal_error",
          message: error instanceof Error ? error.message : String(error),
        });
      } else {
        response.end();
      }
    }
  });

  return {
    server,
    config: resolvedConfig,
    extensionRegistry,
    start: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(resolvedConfig.port, resolvedConfig.host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    stop: () =>
      new Promise<void>((resolve, reject) => {
        activeRuns.cancelAll();
        backgroundSchedulers.stopAll();
        server.close((error) => {
          storeRegistry.closeAll();
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

export const LOCAL_CHANNEL_SOURCE_EXTENSION_ID = "channel-source:local";

export function createDefaultLingExtensionRegistry(): LingExtensionRegistry {
  const registry = createLingExtensionRegistry();
  registry.register(getLocalChannelSourceExtension());
  registry.register(getPiRunnerExtension());
  for (const extension of listBuiltinToolExtensions()) {
    registry.register(extension);
  }
  for (const extension of listBuiltinSkillPackExtensions()) {
    registry.register(extension);
  }
  for (const extension of listBuiltinProviderExtensions()) {
    registry.register(extension);
  }
  return registry;
}

export function getLocalChannelSourceExtension(): ChannelSourceExtensionMetadata {
  return {
    manifest: {
      id: LOCAL_CHANNEL_SOURCE_EXTENSION_ID,
      name: "Local Channel Source",
      version: "0.1.0",
      kind: "channel-source",
      trustLevel: "internal",
      capabilities: ["channel-source:local", "source:web", "source:cli"],
    },
    sourceKind: "local",
    eventTypes: ["web", "cli", "local"],
  };
}

function createSystemKeychainSecretStore(): ExternalSecretStore {
  const service = "ling-stack";
  const unavailable = (ref: string, message = "Keychain secret store is unavailable in this runtime."): SecretStatus => ({
    ref,
    kind: "keychain",
    configured: false,
    errorCode: "secret_store_unavailable",
    message,
  });

  return {
    status(ref: string): SecretStatus {
      let parsed: ReturnType<typeof parseSecretRef>;
      try {
        parsed = parseSecretRef(ref);
      } catch (error) {
        return {
          ref,
          kind: "keychain",
          configured: false,
          errorCode: "invalid_secret_ref",
          message: error instanceof Error ? error.message : String(error),
        };
      }
      if (parsed.kind !== "keychain") {
        return {
          ref,
          kind: parsed.kind,
          configured: false,
          errorCode: "invalid_secret_ref",
          message: "External work Web secret setup only supports keychain: refs.",
        };
      }
      if (process.platform !== "darwin") {
        return unavailable(ref);
      }
      try {
        execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", parsed.name], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        return { ref, kind: "keychain", configured: true };
      } catch (error) {
        const message = readProcessErrorMessage(error);
        if (message.includes("could not be found") || message.includes("The specified item could not be found")) {
          return {
            ref,
            kind: "keychain",
            configured: false,
            errorCode: "secret_missing",
            message: `Secret is not configured: ${ref}`,
          };
        }
        return unavailable(ref, message || "Keychain secret status could not be read.");
      }
    },
    resolve(ref: string): ResolvedSecret {
      const status = this.status(ref);
      if (!status.configured) {
        return { ref, configured: false, status };
      }
      const parsed = parseSecretRef(ref);
      try {
        const value = execFileSync("/usr/bin/security", ["find-generic-password", "-s", service, "-a", parsed.name, "-w"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }).trim();
        return { ref, configured: Boolean(value), value, status };
      } catch (error) {
        const message = readProcessErrorMessage(error);
        return {
          ref,
          configured: false,
          status: {
            ref,
            kind: "keychain",
            configured: false,
            errorCode: "secret_access_denied",
            message: message || "Keychain secret could not be read.",
          },
        };
      }
    },
    setSecret(ref: string, value: string): SecretStatus {
      const parsed = parseSecretRef(ref);
      if (parsed.kind !== "keychain") {
        return {
          ref,
          kind: parsed.kind,
          configured: false,
          errorCode: "invalid_secret_ref",
          message: "External work Web secret setup only supports keychain: refs.",
        };
      }
      if (process.platform !== "darwin") {
        return unavailable(ref);
      }
      try {
        execFileSync("/usr/bin/security", ["add-generic-password", "-U", "-s", service, "-a", parsed.name, "-w", value], {
          stdio: ["ignore", "ignore", "pipe"],
        });
        return { ref, kind: "keychain", configured: true };
      } catch (error) {
        return {
          ref,
          kind: "keychain",
          configured: false,
          errorCode: "secret_access_denied",
          message: readProcessErrorMessage(error) || "Keychain secret could not be saved.",
        };
      }
    },
    deleteSecret(ref: string): SecretStatus {
      const parsed = parseSecretRef(ref);
      if (parsed.kind !== "keychain") {
        return {
          ref,
          kind: parsed.kind,
          configured: false,
          errorCode: "invalid_secret_ref",
          message: "External work Web secret setup only supports keychain: refs.",
        };
      }
      if (process.platform !== "darwin") {
        return unavailable(ref);
      }
      try {
        execFileSync("/usr/bin/security", ["delete-generic-password", "-s", service, "-a", parsed.name], {
          stdio: ["ignore", "ignore", "pipe"],
        });
      } catch (error) {
        const message = readProcessErrorMessage(error);
        if (!message.includes("could not be found") && !message.includes("The specified item could not be found")) {
          return {
            ref,
            kind: "keychain",
            configured: false,
            errorCode: "secret_access_denied",
            message: message || "Keychain secret could not be deleted.",
          };
        }
      }
      return {
        ref,
        kind: "keychain",
        configured: false,
        errorCode: "secret_missing",
        message: `Secret is not configured: ${ref}`,
      };
    },
  };
}

function readProcessErrorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = "stderr" in error ? (error as { readonly stderr?: unknown }).stderr : undefined;
    if (Buffer.isBuffer(stderr)) {
      return stderr.toString("utf8").trim();
    }
    if (typeof stderr === "string") {
      return stderr.trim();
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export async function startDaemon(
  config: DaemonConfig = defaultDaemonConfig,
  dependencies: DaemonDependencies = {},
): Promise<DaemonServer> {
  const daemon = createDaemonServer(config, dependencies);
  await daemon.start();
  return daemon;
}

async function routeRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  secretResolver: SecretResolver,
  externalSecretStore: ExternalSecretStore,
  externalWorkFetch?: typeof globalThis.fetch,
  backgroundSchedulers?: ExternalWorkBackgroundSchedulerRegistry,
): Promise<void> {
  setCorsHeaders(response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, {
      ok: true,
      service: "ling-stack-daemon",
      defaultWorkspaceCwd: config.defaultWorkspaceCwd,
    });
    return;
  }

  if (url.pathname === "/channels") {
    await handleChannelsCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/teammates") {
    await handleTeammatesCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/tasks") {
    await handleTasksCollection(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/providers") {
    await handleProvidersCollection(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/provider-check") {
    await handleProviderDraftCheck(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/provider-models") {
    await handleProviderModelsProbe(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/media-jobs") {
    await handleMediaJobsCollection(request, response, config, storeRegistry, secretResolver);
    return;
  }

  if (url.pathname === "/external-work/github/import") {
    await handleExternalGitHubImport(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/linear/import") {
    await handleExternalLinearImport(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/status") {
    await handleExternalWorkStatus(request, response, config, storeRegistry, secretResolver, backgroundSchedulers);
    return;
  }

  if (url.pathname === "/external-work/workflow/configure") {
    await handleExternalWorkWorkflowConfigure(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/secrets/configure") {
    await handleExternalWorkSecretConfigure(request, response, config, storeRegistry, secretResolver, externalSecretStore);
    return;
  }

  if (url.pathname === "/external-work/secrets/delete") {
    await handleExternalWorkSecretDelete(request, response, config, storeRegistry, secretResolver, externalSecretStore);
    return;
  }

  if (url.pathname === "/external-work/github/poll") {
    await handleExternalGitHubPoll(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  if (url.pathname === "/external-work/linear/poll") {
    await handleExternalLinearPoll(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  if (url.pathname === "/external-work/github/background/start") {
    await handleExternalGitHubBackgroundStart(request, response, config, storeRegistry, backgroundSchedulers);
    return;
  }

  if (url.pathname === "/external-work/background") {
    await handleExternalWorkBackgroundCollection(request, response, config, backgroundSchedulers);
    return;
  }

  const externalWorkBackgroundStopRoute = parseExternalWorkBackgroundStopRoute(url.pathname);
  if (externalWorkBackgroundStopRoute) {
    await handleExternalWorkBackgroundStop(request, response, config, backgroundSchedulers, externalWorkBackgroundStopRoute.schedulerId);
    return;
  }

  if (url.pathname === "/external-work/github/ci/triage") {
    await handleExternalGitHubCiTriage(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  const externalWorkCiTriageItemRoute = parseExternalWorkCiTriageItemRoute(url.pathname);
  if (externalWorkCiTriageItemRoute) {
    await handleExternalWorkCiTriageItem(request, response, config, storeRegistry, externalWorkCiTriageItemRoute.triageId);
    return;
  }

  const externalWorkCiTriageRunRoute = parseExternalWorkCiTriageRunRoute(url.pathname);
  if (externalWorkCiTriageRunRoute) {
    await handleExternalWorkCiTriageRun(request, response, config, runner, storeRegistry, activeRuns, secretResolver, externalWorkCiTriageRunRoute.triageId);
    return;
  }

  if (url.pathname === "/external-work/reconcile") {
    await handleExternalWorkReconcile(request, response, config, storeRegistry, secretResolver, externalWorkFetch);
    return;
  }

  if (url.pathname === "/external-work/actions/propose") {
    await handleExternalWorkActionPropose(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/external-work/actions") {
    await handleExternalWorkActionsCollection(request, response, config, storeRegistry);
    return;
  }

  const externalWorkActionRoute = parseExternalWorkActionRoute(url.pathname);
  if (externalWorkActionRoute) {
    await handleExternalWorkActionItem(request, response, config, storeRegistry, secretResolver, externalWorkFetch, externalWorkActionRoute);
    return;
  }

  if (url.pathname === "/external-work") {
    await handleExternalWorkCollection(request, response, config, storeRegistry);
    return;
  }

  const externalWorkItemRoute = matchSingleSegmentRoute(url.pathname, "/external-work");
  if (externalWorkItemRoute) {
    await handleExternalWorkItem(request, response, config, storeRegistry, externalWorkItemRoute);
    return;
  }

  if (request.method === "GET" && url.pathname === "/provider-templates") {
    writeJson(response, 200, { templates: defaultProviderTemplates() });
    return;
  }

  if (url.pathname === "/approval-policy") {
    await handleApprovalPolicy(request, response, config, storeRegistry);
    return;
  }

  if (url.pathname === "/approvals") {
    handleApprovalsCollection(request, response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/state-transitions") {
    handleListStateTransitions(response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime/leases") {
    handleListResourceLeases(response, url, storeRegistry);
    return;
  }

  if (request.method === "GET" && url.pathname === "/secrets/status") {
    handleSecretStatus(response, url, secretResolver);
    return;
  }

  if (request.method === "POST" && url.pathname === "/runs") {
    await handleRun(request, response, config, runner, storeRegistry, activeRuns, secretResolver);
    return;
  }
  if (request.method === "GET" && url.pathname === "/runs") {
    handleListRuns(response, url, storeRegistry);
    return;
  }

  const runRoute = parseRunRoute(url.pathname);
  if (request.method === "POST" && runRoute?.kind === "cancel") {
    handleCancelRun(response, url, storeRegistry, activeRuns, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "run") {
    handleGetRun(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "events") {
    handleGetRunEvents(response, url, storeRegistry, runRoute.runId);
    return;
  }
  if (request.method === "GET" && runRoute?.kind === "artifacts") {
    handleListRunArtifacts(response, url, storeRegistry, runRoute.runId);
    return;
  }

  const artifactRoute = parseArtifactRoute(url.pathname);
  if (request.method === "GET" && artifactRoute?.kind === "artifact") {
    handleGetArtifact(response, url, storeRegistry, artifactRoute.artifactId);
    return;
  }
  if (request.method === "GET" && artifactRoute?.kind === "content") {
    handleGetArtifactContent(response, url, storeRegistry, artifactRoute.artifactId);
    return;
  }

  const attachmentRoute = parseChannelAttachmentRoute(url.pathname);
  if (attachmentRoute) {
    await handleChannelAttachmentItem(request, response, config, storeRegistry, attachmentRoute);
    return;
  }

  const linkPreviewRoute = parseChannelLinkPreviewRoute(url.pathname);
  if (linkPreviewRoute) {
    await handleChannelLinkPreviewItem(request, response, config, storeRegistry, linkPreviewRoute);
    return;
  }

  const decisionRoute = parseChannelDecisionRoute(url.pathname);
  if (decisionRoute) {
    await handleChannelDecisionItem(request, response, config, storeRegistry, decisionRoute.decisionId);
    return;
  }

  const handoffRoute = parseChannelHandoffRoute(url.pathname);
  if (handoffRoute) {
    if (handoffRoute.action === "workflow") {
      await handleChannelWorkflowFromHandoff(request, response, config, storeRegistry, handoffRoute.handoffId);
      return;
    }
    await handleChannelHandoffItem(request, response, config, storeRegistry, handoffRoute.handoffId);
    return;
  }

  const workflowRoute = parseChannelWorkflowRoute(url.pathname);
  if (workflowRoute) {
    if (workflowRoute.kind === "workflow") {
      await handleChannelWorkflowItem(request, response, config, storeRegistry, workflowRoute.workflowId);
      return;
    }
    if (workflowRoute.kind === "steps") {
      await handleChannelWorkflowStepsCollection(request, response, config, storeRegistry, workflowRoute.workflowId);
      return;
    }
    await handleChannelWorkflowStepItem(request, response, config, runner, storeRegistry, activeRuns, secretResolver, workflowRoute.workflowStepId, workflowRoute.action);
    return;
  }

  const contextSummaryRoute = parseChannelContextSummaryRoute(url.pathname);
  if (contextSummaryRoute) {
    await handleChannelContextSummaryItem(request, response, config, storeRegistry, contextSummaryRoute.contextSummaryId);
    return;
  }

  const channelRoute = parseChannelRoute(url.pathname);
  if (channelRoute) {
    if (channelRoute.action === "brief") {
      await handleChannelBrief(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "messages") {
      await handleChannelMessagesCollection(request, response, config, runner, storeRegistry, secretResolver, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "proposals") {
      await handleChannelExecutionProposalsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "attachments") {
      await handleChannelAttachmentsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "link-previews") {
      await handleChannelLinkPreviewsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "decisions") {
      await handleChannelDecisionsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "handoffs") {
      await handleChannelHandoffsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "context-summaries") {
      await handleChannelContextSummariesCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    if (channelRoute.action === "workflows") {
      await handleChannelWorkflowsCollection(request, response, config, storeRegistry, channelRoute.channelId);
      return;
    }
    await handleChannelItem(request, response, config, storeRegistry, channelRoute.channelId);
    return;
  }

  const channelProposalRoute = parseChannelExecutionProposalRoute(url.pathname);
  if (channelProposalRoute) {
    await handleChannelExecutionProposalItem(request, response, config, storeRegistry, channelProposalRoute.proposalId);
    return;
  }

  const teammateRoute = parseTeammateRoute(url.pathname);
  if (teammateRoute) {
    await handleTeammateRoute(request, response, config, runner, storeRegistry, secretResolver, teammateRoute);
    return;
  }

  const taskRoute = parseTaskRoute(url.pathname);
  if (taskRoute) {
    if (request.method === "POST" && taskRoute.action === "run") {
      await handleTaskRunRequest(request, response, config, runner, storeRegistry, activeRuns, secretResolver, taskRoute.taskId);
      return;
    }
    if (taskRoute.action) {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for task ${taskRoute.action}` });
      return;
    }
    await handleTaskItem(request, response, config, storeRegistry, taskRoute.taskId);
    return;
  }

  const providerRoute = parseProviderRoute(url.pathname);
  if (providerRoute) {
    await handleProviderItem(request, response, config, storeRegistry, secretResolver, providerRoute);
    return;
  }

  const mediaJobRoute = parseMediaJobRoute(url.pathname);
  if (mediaJobRoute) {
    if (request.method === "POST" && mediaJobRoute.action === "run") {
      await handleRunMediaJob(response, url, storeRegistry, secretResolver, mediaJobRoute.mediaJobId);
      return;
    }
    if (request.method === "GET" && mediaJobRoute.action === "artifacts") {
      handleListMediaJobArtifacts(response, url, storeRegistry, mediaJobRoute.mediaJobId);
      return;
    }
    if (mediaJobRoute.action) {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for media job ${mediaJobRoute.action}` });
      return;
    }
    handleMediaJobItem(request, response, config, storeRegistry, mediaJobRoute.mediaJobId);
    return;
  }

  const approvalRoute = parseApprovalRoute(url.pathname);
  if (approvalRoute) {
    await handleApprovalItem(request, response, config, storeRegistry, approvalRoute);
    return;
  }

  writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
}

function handleSecretStatus(response: ServerResponse, url: URL, secretResolver: SecretResolver): void {
  const ref = url.searchParams.get("ref");
  if (!ref) {
    writeJson(response, 400, { error: "bad_request", message: "ref query parameter is required" });
    return;
  }
  const purpose = readOptionalSecretPurposeQuery(url);
  if (purpose === null) {
    writeJson(response, 400, { error: "bad_request", message: "purpose is not supported" });
    return;
  }
  const status = secretResolver.status(ref, purpose);
  writeJson(response, 200, { status });
}

async function handleRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  let runRequest: RunRequest;
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    runRequest = parseRunRequest(body);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  await executeRunRequest(runRequest, response, runner, storeRegistry, activeRuns, secretResolver);
}

async function executeRunRequest(
  runRequest: RunRequest,
  response: ServerResponse,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  secretResolver: SecretResolver,
  options: ExecuteRunRequestOptions = {},
): Promise<string | undefined> {
  let store: RunStore | undefined;
  let run: RunSession | undefined;
  let runnerRequest: PiRunnerRunOptions;
  let preparedConcurrency: PreparedRunConcurrency = { taskExists: false, leases: [] };
  let resolvedSecretValues: readonly (string | undefined)[] = [];
  try {
    const workspaceCwd = runRequest.workspaceCwd ?? runRequest.cwd;
    store = storeRegistry.getStore(workspaceCwd);
    const resolvedProvider = resolveProviderForRun(store, runRequest, secretResolver);
    runnerRequest = {
      cwd: runRequest.cwd,
      task: runRequest.task,
      provider: resolvedProvider,
      tools: runRequest.tools,
      thinkingLevel: runRequest.thinkingLevel,
      systemPrompt: runRequest.systemPrompt,
      appendSystemPrompt: runRequest.appendSystemPrompt,
      agentDir: runRequest.agentDir,
    };
    resolvedSecretValues = [resolvedProvider.apiKey];
    const runId = createRunId();
    const createdAt = new Date().toISOString();
    preparedConcurrency = prepareRunConcurrency({
      store,
      runRequest,
      runId,
      now: createdAt,
    });
    run = store.createRun({
      id: runId,
      cwd: runRequest.cwd,
      taskId: runRequest.task.id,
      channelId: preparedConcurrency.channel?.id ?? runRequest.task.channelId,
      providerPresetId: runRequest.providerPresetId,
      providerName: resolvedProvider.provider,
      providerModel: resolvedProvider.model,
      taskSnapshot: runRequest.task,
      providerSnapshot: { providerPresetId: runRequest.providerPresetId, ...resolvedProvider },
      requestSnapshot: { ...runRequest, workspaceCwd, provider: resolvedProvider },
      createdAt,
    });
    storeRegistry.rememberRun(run.id, store);
    store.appendEvent(run.id, "run_created", {
      taskId: run.taskId,
      workspaceCwd,
      cwd: run.cwd,
      providerName: run.providerName,
      providerModel: run.providerModel,
      leases: preparedConcurrency.leases.map((lease) => ({
        id: lease.id,
        resourceType: lease.resourceType,
        resourceKey: lease.resourceKey,
      })),
    });
  } catch (error) {
    if (preparedConcurrency.leases.length > 0) {
      const now = new Date().toISOString();
      for (const lease of preparedConcurrency.leases) {
        store?.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, now);
      }
    }
    if (error instanceof DuplicateRunRequestError) {
      try {
        options.onRunReady?.(error.runId);
      } catch {
        // The run itself is already known; auxiliary link updates must not corrupt SSE.
      }
      writeSseHead(response);
      writeSse(response, "ready", { ok: true, runId: error.runId, duplicate: true });
      response.end();
      return error.runId;
    }
    const statusCode = error instanceof HttpError ? error.statusCode : 500;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "run_storage_unavailable",
      message: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }

  if (!store || !run) {
    writeJson(response, 500, { error: "run_storage_unavailable", message: "Run was not initialized." });
    return undefined;
  }

  writeSseHead(response);
  writeSse(response, "ready", { ok: true, runId: run.id });
  try {
    options.onRunReady?.(run.id);
  } catch {
    // The run itself is already known; auxiliary link updates must not corrupt SSE.
  }

  const abortController = new AbortController();
  let clientClosed = false;
  let runStartedAt: string | undefined;
  let persistedRunError = false;
  let persistenceError: unknown;
  let extractedArtifactCounter = 0;
  const toolStartArgsById = new Map<string, unknown>();
  response.on("close", () => {
    clientClosed = true;
  });

  const streamEnvelope = (envelope: RunEventEnvelope): void => {
    if (!clientClosed) {
      writeSse(response, envelope.type, envelope);
    }
  };

  activeRuns.add(run.id, {
    abortController,
    streamEnvelope,
  });

  const appendAndMaybeStream = (type: RunEventType, data: unknown): RunEventEnvelope | undefined => {
    if (persistenceError) {
      return undefined;
    }
    if (abortController.signal.aborted && type !== "run_cancelled") {
      return undefined;
    }
    if (store.getRun(run.id)?.status === "cancelled" && type !== "run_cancelled") {
      return undefined;
    }

    try {
      const envelope = store.appendEvent(run.id, type, redactSecrets(data, resolvedSecretValues));
      if (type === "run_error") {
        persistedRunError = true;
      }
      streamEnvelope(envelope);
      return envelope;
    } catch (error) {
      persistenceError = error;
      return undefined;
    }
  };

  try {
    runStartedAt = new Date().toISOString();
    const runStartTransition = store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "queued",
      event: "runner_started",
      actor: "runner",
      now: runStartedAt,
      startedAt: runStartedAt,
    });
    if (!runStartTransition.ok) {
      throw new Error(`Run transition failed: ${runStartTransition.code}`);
    }
    if (preparedConcurrency.taskExists) {
      const taskStartTransition = store.transitionTaskStatus({
        taskId: run.taskId,
        expectedStatus: "claimed",
        event: "start_run",
        actor: "runner",
        now: runStartedAt,
        currentRunId: run.id,
      });
      if (!taskStartTransition.ok) {
        throw new Error(`Task transition failed: ${taskStartTransition.code}`);
      }
    }
    const approvalPolicy = mergeApprovalPolicyWithProfile(store.getApprovalPolicy(), runRequest.approvalProfile);

    const result = await runner.runTask({
      ...runnerRequest,
      onApprovalRequired: createRunApprovalHandler({
        store,
        run,
        approvalPolicy,
        appendAndMaybeStream,
        streamEnvelope,
        signal: abortController.signal,
      }),
      onEvent: (event: PiRunnerEvent) => {
        if (event.type === "tool_start") {
          toolStartArgsById.set(event.toolCallId, event.args);
        }
        const eventEnvelope = appendAndMaybeStream(event.type, event);
        if (eventEnvelope && event.type === "tool_end") {
          const sourceArgs = toolStartArgsById.get(event.toolCallId);
          try {
            const artifacts = persistExtractedArtifacts({
              store,
              run,
              event,
              sourceArgs,
              nextIndex: () => {
                extractedArtifactCounter += 1;
                return extractedArtifactCounter;
              },
              extraSecrets: resolvedSecretValues,
            });
            for (const artifact of artifacts) {
              appendAndMaybeStream("artifact_created", {
                artifact,
                toolCallId: event.toolCallId,
                toolName: event.toolName,
              });
            }
          } catch {
            // Artifact extraction is best-effort evidence capture; runner output remains authoritative.
          }
        }
      },
      signal: abortController.signal,
    });

    if (persistenceError) {
      throw persistenceError;
    }
    if (store.getRun(run.id)?.status === "cancelled") {
      if (!clientClosed) {
        response.end();
      }
      return run.id;
    }

    const resultEnvelope = appendAndMaybeStream("result", {
      taskId: result.taskId,
      messageCount: result.messages.length,
      runnerEventCount: result.events.length,
    });
    if (!resultEnvelope && persistenceError) {
      throw persistenceError;
    }

    const endedAt = new Date().toISOString();
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "succeeded",
      taskId: run.taskId,
      eventCount: resultEnvelope?.seq ?? store.countEvents(run.id),
      messageCount: result.messages.length,
      startedAt: runStartedAt,
      endedAt,
      errorMessage: null,
    });
    store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "runner_succeeded",
      actor: "runner",
      now: endedAt,
      endedAt,
      summaryPath,
      errorMessage: null,
    });
    if (preparedConcurrency.taskExists) {
      store.transitionTaskStatus({
        taskId: run.taskId,
        expectedStatus: "running",
        event: "run_succeeded",
        actor: "runner",
        now: endedAt,
        currentRunId: run.id,
      });
    }

    if (!clientClosed) {
      response.end();
    }
  } catch (error) {
    if (isAbortError(error) || store.getRun(run.id)?.status === "cancelled") {
      ensureRunCancelled({
        store,
        runId: run.id,
        taskId: run.taskId,
        startedAt: runStartedAt,
        reason: "cancelled",
        active: false,
        streamEnvelope,
      });
      if (!clientClosed) {
        response.end();
      }
      return run.id;
    }
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), resolvedSecretValues);
    const endedAt = new Date().toISOString();
    const failureEvent = persistedRunError
      ? undefined
      : appendFailureEvent(store, run.id, message, clientClosed, response);
    const summaryPath = writeTerminalSummary(getRunSummaryPath(store.paths, run.id), {
      runId: run.id,
      status: "failed",
      taskId: run.taskId,
      eventCount: failureEvent?.seq ?? store.countEvents(run.id),
      startedAt: runStartedAt,
      endedAt,
      errorMessage: message,
    });
    store.transitionRunStatus({
      runId: run.id,
      expectedStatus: "running",
      event: "runner_failed",
      actor: "runner",
      reason: message,
      now: endedAt,
      endedAt,
      summaryPath,
      errorMessage: message,
    });
    if (preparedConcurrency.taskExists) {
      store.transitionTaskStatus({
        taskId: run.taskId,
        expectedStatus: "running",
        event: "run_failed",
        actor: "runner",
        reason: message,
        now: endedAt,
        currentRunId: run.id,
      });
    }

    if (!clientClosed) {
      response.end();
    }
  } finally {
    store.releaseResourceLeasesForOwner("run", run.id, new Date().toISOString());
    activeRuns.delete(run.id);
  }
  return run.id;
}

function prepareRunConcurrency(input: {
  readonly store: RunStore;
  readonly runRequest: RunRequest;
  readonly runId: string;
  readonly now: string;
}): PreparedRunConcurrency {
  input.store.expireResourceLeases(input.now);

  const taskId = input.runRequest.task.id;
  const task = input.store.getTask(taskId);
  const channelId = input.runRequest.task.channelId ?? task?.channelId;
  const channel = channelId ? input.store.getChannel(channelId) : undefined;
  if (channelId && !channel) {
    throw new HttpError(404, "channel_not_found", `Channel not found: ${channelId}`);
  }
  if (channel?.status === "paused") {
    throw new HttpError(409, "channel_paused", `Channel is paused: ${channel.id}`);
  }
  if (channel?.status === "archived") {
    throw new HttpError(409, "channel_archived", `Channel is archived: ${channel.id}`);
  }

  if (task && input.runRequest.idempotencyKey) {
    const duplicate = input.store.findStateTransitionByIdempotency("task", task.id, input.runRequest.idempotencyKey);
    if (duplicate) {
      const runId = duplicate.reason?.startsWith("run:") ? duplicate.reason.slice("run:".length) : undefined;
      if (runId) {
        throw new DuplicateRunRequestError(runId);
      }
      throw new HttpError(409, "duplicate_run_request", "Duplicate run request");
    }
  }

  const leases: ResourceLease[] = [];
  const leaseInputs = buildRunLeaseInputs({
    runId: input.runId,
    runRequest: input.runRequest,
    channel,
    taskId,
    now: input.now,
  });

  for (const leaseInput of leaseInputs) {
    const lease = input.store.acquireResourceLease(leaseInput);
    if (!lease) {
      const blockingLease = input.store.getBlockingResourceLease(leaseInput.resourceType, leaseInput.resourceKey);
      for (const acquiredLease of leases) {
        input.store.releaseResourceLeasesForOwner(acquiredLease.ownerType, acquiredLease.ownerId, input.now);
      }
      throw new HttpError(
        409,
        "resource_conflict",
        blockingLease
          ? `Resource is locked by ${blockingLease.ownerType}:${blockingLease.ownerId}: ${blockingLease.resourceType}:${blockingLease.resourceKey}`
          : `Resource is locked: ${leaseInput.resourceType}:${leaseInput.resourceKey}`,
      );
    }
    leases.push(lease);
  }

  if (task) {
    const claimEvent = task.status === "todo" ? "claim" : task.status === "failed" ? "retry" : undefined;
    if (claimEvent) {
      const result = input.store.transitionTaskStatus({
        taskId: task.id,
        expectedStatus: task.status,
        event: claimEvent,
        actor: "system",
        reason: `run:${input.runId}`,
        idempotencyKey: input.runRequest.idempotencyKey,
        now: input.now,
      });
      if (!result.ok) {
        for (const lease of leases) {
          input.store.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, input.now);
        }
        throw new HttpError(409, result.code, `Task transition failed: ${result.code}`);
      }
    } else if (task.status !== "claimed") {
      for (const lease of leases) {
        input.store.releaseResourceLeasesForOwner(lease.ownerType, lease.ownerId, input.now);
      }
      throw new HttpError(409, "task_not_runnable", `Task ${task.id} is ${task.status}`);
    }
  }

  return {
    channel,
    taskExists: Boolean(task),
    leases,
  };
}

function buildRunLeaseInputs(input: {
  readonly runId: string;
  readonly runRequest: RunRequest;
  readonly channel?: Channel;
  readonly taskId: string;
  readonly now: string;
}): Parameters<RunStore["acquireResourceLease"]>[0][] {
  const expiresAt = new Date(new Date(input.now).getTime() + RESOURCE_LEASE_TTL_MS).toISOString();
  const base = {
    workspaceId: DEFAULT_WORKSPACE_ID,
    ownerType: "run" as const,
    ownerId: input.runId,
    acquiredAt: input.now,
    expiresAt,
  };
  const leases: Parameters<RunStore["acquireResourceLease"]>[0][] = [
    {
      ...base,
      resourceType: "task",
      resourceKey: input.taskId,
    },
  ];

  if (input.channel?.runtimePolicy.executionMode === "serial") {
    leases.push({
      ...base,
      resourceType: "channel",
      resourceKey: input.channel.id,
    });
  }

  if (usesSideEffectTools(input.runRequest.tools ?? [])) {
    const scope = input.channel?.runtimePolicy.writeLockScope ?? "boundPath";
    if (scope === "workspace") {
      leases.push({ ...base, resourceType: "workspace", resourceKey: DEFAULT_WORKSPACE_ID });
    } else if (scope === "channel" || !input.channel?.boundPath) {
      leases.push({ ...base, resourceType: "channel", resourceKey: input.channel?.id ?? input.taskId });
    } else {
      leases.push({ ...base, resourceType: "bound_path", resourceKey: canonicalResourcePath(input.channel.boundPath) });
    }
  }

  return leases;
}

function usesSideEffectTools(tools: readonly RunTool[]): boolean {
  return tools.some((tool) => tool === "bash" || tool === "edit" || tool === "write");
}

function canonicalResourcePath(path: string): string {
  const resolved = resolvePath(path);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

async function handleChannelsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channels: store.listChannels({ limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const channel = store.createChannel(parseCreateChannelInput(body), new Date().toISOString());
      writeJson(response, 201, { channel });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { channel });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const updated = store.updateChannel(channelId, parseChannelUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { channel: updated });
      return;
    }

    if (request.method === "DELETE") {
      const tasks = store.listTasks({ channelId, limit: 1 });
      if (tasks.length > 0) {
        writeJson(response, 409, { error: "channel_has_tasks", message: `Channel has tasks and cannot be deleted: ${channelId}` });
        return;
      }
      store.deleteChannel(channelId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channels` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelMessagesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const page = store.listChannelMessagesPage({
        channelId,
        threadId: url.searchParams.get("threadId") ?? undefined,
        beforeMessageId: url.searchParams.get("beforeMessageId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      writeJson(response, 200, {
        cwd,
        channelId,
        messages: page.messages,
        hasMore: page.hasMore,
        nextBeforeMessageId: page.nextBeforeMessageId,
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelMessageRequest(body);
      const referenceError = validateChannelMessageReferences(store, channelId, input.attachmentIds, input.linkPreviewIds);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, {
          error: referenceError.code,
          message: referenceError.message,
        });
        return;
      }
      const now = new Date().toISOString();
      const message = store.createChannelMessage(
        {
          channelId,
          threadId: input.threadId,
          kind: input.kind ?? "message",
          intent: input.intent ?? "discuss",
          authorType: input.authorType,
          authorId: input.authorId,
          body: input.body,
          mentions: input.mentions,
          attachmentIds: input.attachmentIds,
          linkPreviewIds: input.linkPreviewIds,
          linkedTaskId: input.linkedTaskId,
          linkedRunId: input.linkedRunId,
        },
        now,
      );

      let aiReply: ChannelMessage | undefined;
      if (input.requestAiReply) {
        aiReply = await createAiChannelReply({
          runner,
          store,
          channel,
          sourceMessage: message,
          providerPresetId: input.providerPresetId,
          teammateId: input.teammateId,
          secretResolver,
        });
      }

      writeJson(response, 201, aiReply ? { message, aiReply } : { message });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel messages` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelExecutionProposalsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        proposals: store.listChannelExecutionProposals({
          channelId,
          sourceMessageId: url.searchParams.get("sourceMessageId") ?? undefined,
          status: readOptionalChannelExecutionProposalStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelExecutionProposalRequest(body);
      const messageError = validateChannelMessageOwner(store, channelId, input.sourceMessageId);
      if (messageError) {
        writeJson(response, messageError.statusCode === 404 ? 400 : messageError.statusCode, {
          error: messageError.code,
          message: messageError.message,
        });
        return;
      }
      const proposal = store.createChannelExecutionProposal({ channelId, ...input }, new Date().toISOString());
      writeJson(response, 201, { proposal });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel proposals` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelExecutionProposalItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  proposalId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const proposal = store.getChannelExecutionProposal(proposalId);
    if (!proposal) {
      writeJson(response, 404, { error: "proposal_not_found", message: `Channel proposal not found: ${proposalId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { proposal });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelExecutionProposalUpdateInput(body);
      const updated = store.updateChannelExecutionProposal(proposalId, input, new Date().toISOString());
      writeJson(response, 200, { proposal: updated ?? proposal });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel proposal` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTeammatesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammates: store.listAiTeammates({
          includeHidden: url.searchParams.get("includeHidden") === "true",
          includeDisabled: url.searchParams.get("includeDisabled") === "true",
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const teammate = store.createAiTeammate(parseCreateAiTeammateInput(body), new Date().toISOString());
      writeJson(response, 201, { teammate });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /teammates` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTeammateRoute(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  route: { readonly teammateId: string; readonly action?: "channels" | "skills" | "memory-scopes" | "direct-thread" | "direct-messages" | "tasks" | "activity" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const teammate = store.getAiTeammate(route.teammateId);
    if (!teammate) {
      writeJson(response, 404, { error: "teammate_not_found", message: `AI teammate not found: ${route.teammateId}` });
      return;
    }

    if (!route.action) {
      if (request.method === "GET") {
        writeJson(response, 200, { teammate });
        return;
      }
      if (request.method === "PATCH") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const updated = store.updateAiTeammate(route.teammateId, parseAiTeammateUpdateInput(body), new Date().toISOString());
        writeJson(response, 200, { teammate: updated });
        return;
      }
      if (request.method === "DELETE") {
        const disabled = store.disableAiTeammate(route.teammateId, new Date().toISOString());
        writeJson(response, 200, { teammate: disabled });
        return;
      }
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate` });
      return;
    }

    if (route.action === "channels") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          teammateId: route.teammateId,
          memberships: store.listTeammateChannelMemberships(route.teammateId),
        });
        return;
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const memberships = store.replaceTeammateChannelMemberships(
          route.teammateId,
          parseReplaceTeammateChannelMembershipsRequest(body),
          new Date().toISOString(),
        );
        writeJson(response, 200, { cwd, teammateId: route.teammateId, memberships });
        return;
      }
    }

    if (route.action === "skills") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          teammateId: route.teammateId,
          bindings: store.listTeammateSkillBindings(route.teammateId),
        });
        return;
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const bindings = store.replaceTeammateSkillBindings(
          route.teammateId,
          parseReplaceTeammateSkillBindingsRequest(body),
          new Date().toISOString(),
        );
        writeJson(response, 200, { cwd, teammateId: route.teammateId, bindings });
        return;
      }
    }

    if (route.action === "memory-scopes") {
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          teammateId: route.teammateId,
          scopes: store.listTeammateMemoryScopes(route.teammateId),
        });
        return;
      }
      if (request.method === "PUT") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const scopes = store.replaceTeammateMemoryScopes(
          route.teammateId,
          parseReplaceTeammateMemoryScopesRequest(body),
          new Date().toISOString(),
        );
        writeJson(response, 200, { cwd, teammateId: route.teammateId, scopes });
        return;
      }
    }

    if (route.action === "direct-thread") {
      if (request.method === "GET") {
        const thread = store.getOrCreateTeammateDirectThread(route.teammateId, new Date().toISOString());
        writeJson(response, 200, { cwd, teammateId: route.teammateId, thread });
        return;
      }
    }

    if (route.action === "direct-messages") {
      const thread = store.getOrCreateTeammateDirectThread(route.teammateId, new Date().toISOString());
      if (request.method === "GET") {
        writeJson(response, 200, {
          cwd,
          teammateId: route.teammateId,
          thread,
          messages: store.listTeammateDirectMessages({
            teammateId: route.teammateId,
            threadId: thread.id,
            limit: readOptionalIntegerQuery(url, "limit", 1),
          }),
        });
        return;
      }
      if (request.method === "POST") {
        const body = await readJsonBody(request, config.maxBodyBytes);
        const input = parseTeammateDirectMessageRequest(body);
        const now = new Date().toISOString();
        const message = store.createTeammateDirectMessage(
          {
            threadId: thread.id,
            teammateId: route.teammateId,
            authorType: "local-user",
            authorId: "local-user",
            body: input.body,
          },
          now,
        );
        const aiReply = input.requestAiReply
          ? await createAiTeammateDirectReply({
              runner,
              store,
              teammate,
              thread,
              sourceMessage: message,
              providerPresetId: input.providerPresetId,
              secretResolver,
            })
          : undefined;
        writeJson(response, 201, aiReply ? { message, aiReply } : { message });
        return;
      }
    }

    if (route.action === "tasks" && request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        tasks: store.listTasks({
          assigneeTeammateId: route.teammateId,
          status: readOptionalTaskStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (route.action === "activity" && request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        teammateId: route.teammateId,
        items: buildTeammateActivityItems(store, route.teammateId, readOptionalIntegerQuery(url, "limit", 1) ?? 100),
      });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for teammate ${route.action}` });
  } catch (error) {
    writeJson(response, error instanceof HttpError ? error.statusCode : 400, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelAttachmentsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        attachments: store.listChannelAttachments({ channelId, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, Math.max(config.maxBodyBytes, CHANNEL_ATTACHMENT_REQUEST_MAX_BYTES));
      const input = parseChannelAttachmentRequest(body);
      const messageError = input.messageId ? validateChannelMessageOwner(store, channelId, input.messageId) : undefined;
      if (messageError) {
        writeJson(response, messageError.statusCode, { error: messageError.code, message: messageError.message });
        return;
      }
      const attachment = persistChannelAttachment(store, channelId, input);
      writeJson(response, 201, { attachment });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel attachments` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelAttachmentItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly attachmentId: string; readonly action?: "content" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const attachment = store.getChannelAttachment(route.attachmentId);
    if (!attachment) {
      writeJson(response, 404, { error: "attachment_not_found", message: `Attachment not found: ${route.attachmentId}` });
      return;
    }

    if (request.method === "GET" && route.action === "content") {
      handleGetChannelAttachmentContent(response, store, attachment);
      return;
    }

    if (request.method === "GET" && !route.action) {
      writeJson(response, 200, { attachment });
      return;
    }

    if (request.method === "DELETE" && !route.action) {
      deleteChannelAttachmentContent(store, attachment);
      store.deleteChannelAttachment(route.attachmentId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel attachment` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelLinkPreviewsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        linkPreviews: store.listChannelLinkPreviews({ channelId, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelLinkPreviewRequest(body);
      const messageError = input.messageId ? validateChannelMessageOwner(store, channelId, input.messageId) : undefined;
      if (messageError) {
        writeJson(response, messageError.statusCode, { error: messageError.code, message: messageError.message });
        return;
      }
      const linkPreview = await createOrFetchChannelLinkPreview(store, channelId, input);
      writeJson(response, 201, { linkPreview });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel link previews` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelLinkPreviewItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly linkPreviewId: string; readonly action: "refresh" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelLinkPreview(route.linkPreviewId);
    if (!existing) {
      writeJson(response, 404, { error: "link_preview_not_found", message: `Link preview not found: ${route.linkPreviewId}` });
      return;
    }
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for link preview refresh` });
      return;
    }
    const metadata = await fetchLinkPreviewMetadata(existing.normalizedUrl);
    const updated = store.updateChannelLinkPreview(
      existing.id,
      metadata,
      new Date().toISOString(),
    );
    writeJson(response, 200, { linkPreview: updated ?? existing });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleChannelBrief(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        brief: store.getChannelBrief(channelId) ?? createEmptyChannelBrief(channel),
      });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelBriefRequest(body);
      const referenceError = validateChannelBriefReferences(store, channelId, input);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const brief = store.updateChannelBrief(channelId, input, new Date().toISOString());
      writeJson(response, 200, { brief });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel brief` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelDecisionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const status = readOptionalChannelDecisionStatusQuery(url, "status");
      writeJson(response, 200, {
        cwd,
        channelId,
        decisions: store.listChannelDecisions({ channelId, status, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelDecisionRequest(body);
      const referenceError = validateProtocolSourceReferences(store, channelId, input) ??
        (input.supersedesDecisionId ? validateChannelDecisionOwner(store, channelId, input.supersedesDecisionId) : undefined);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const decision = store.createChannelDecision({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { decision });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel decisions` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelDecisionItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  decisionId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelDecision(decisionId);
    if (!existing) {
      writeJson(response, 404, { error: "decision_not_found", message: `Channel decision not found: ${decisionId}` });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel decision` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelDecisionUpdateRequest(body);
    const decision = store.updateChannelDecision(decisionId, input, new Date().toISOString());
    writeJson(response, 200, { decision: decision ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelHandoffsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const status = readOptionalChannelHandoffStatusQuery(url, "status");
      writeJson(response, 200, {
        cwd,
        channelId,
        handoffs: store.listChannelHandoffs({ channelId, status, limit: readOptionalIntegerQuery(url, "limit", 1) }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelHandoffRequest(body);
      const referenceError = validateProtocolSourceReferences(store, channelId, input);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const handoff = store.createChannelHandoff({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { handoff });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel handoffs` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelHandoffItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  handoffId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelHandoff(handoffId);
    if (!existing) {
      writeJson(response, 404, { error: "handoff_not_found", message: `Channel handoff not found: ${handoffId}` });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel handoff` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelHandoffUpdateRequest(body);
    const handoff = store.updateChannelHandoff(handoffId, input, new Date().toISOString());
    writeJson(response, 200, { handoff: handoff ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelContextSummariesCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    if (request.method === "GET") {
      const targetType = readOptionalChannelContextSummaryTargetTypeQuery(url, "targetType");
      writeJson(response, 200, {
        cwd,
        channelId,
        contextSummaries: store.listChannelContextSummaries({
          channelId,
          targetType,
          targetId: url.searchParams.get("targetId") ?? undefined,
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelContextSummaryRequest(body);
      const referenceError = validateChannelContextSummaryReferences(store, channelId, input);
      if (referenceError) {
        writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
        return;
      }
      const contextSummary = store.createChannelContextSummary({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { contextSummary });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel context summaries` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelContextSummaryItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  contextSummaryId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelContextSummary(contextSummaryId);
    if (!existing) {
      writeJson(response, 404, { error: "context_summary_not_found", message: `Channel context summary not found: ${contextSummaryId}` });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel context summary` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelContextSummaryUpdateRequest(body);
    const referenceError = validateChannelContextSummaryReferences(store, existing.channelId, {
      targetType: input.targetType ?? existing.targetType,
      targetId: input.targetId ?? existing.targetId,
      sourceMessageIds: input.sourceMessageIds ?? existing.sourceMessageIds,
      decisionIds: input.decisionIds ?? existing.decisionIds,
    });
    if (referenceError) {
      writeJson(response, referenceError.statusCode, { error: referenceError.code, message: referenceError.message });
      return;
    }
    const contextSummary = store.updateChannelContextSummary(contextSummaryId, input, new Date().toISOString());
    writeJson(response, 200, { contextSummary: contextSummary ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelWorkflowsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  channelId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        channelId,
        workflows: store.listChannelWorkflows({
          channelId,
          status: readOptionalChannelWorkflowStatusQuery(url, "status"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelWorkflowRequest(body);
      const workflow = store.createChannelWorkflow({ ...input, channelId }, new Date().toISOString());
      writeJson(response, 201, { workflow });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflows` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelWorkflowFromHandoff(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  handoffId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for handoff workflow creation` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const handoff = store.getChannelHandoff(handoffId);
    if (!handoff) {
      writeJson(response, 404, { error: "handoff_not_found", message: `Channel handoff not found: ${handoffId}` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelWorkflowFromHandoffRequest(body);
    const workflow = store.createChannelWorkflow(
      {
        channelId: handoff.channelId,
        sourceHandoffId: handoff.id,
        title: input.title ?? `Handoff to ${handoff.toParticipantLabel}`,
        objective: input.objective ?? (handoff.expectedOutput || handoff.reason || "Complete handoff workflow."),
        createdBy: input.createdBy,
      },
      new Date().toISOString(),
    );
    const workflowStep = store.createChannelWorkflowStep(
      {
        workflowId: workflow.id,
        sourceHandoffId: handoff.id,
        contextSummaryId: input.contextSummaryId,
        title: `Complete handoff: ${handoff.expectedOutput || handoff.reason || handoff.toParticipantLabel}`,
        prompt: formatHandoffStepPrompt(handoff),
        toParticipantId: handoff.toParticipantId,
        toParticipantLabel: handoff.toParticipantLabel,
      },
      new Date().toISOString(),
    );
    writeJson(response, 201, { workflow, workflowStep });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelWorkflowItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workflowId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelWorkflow(workflowId);
    if (!existing) {
      writeJson(response, 404, { error: "workflow_not_found", message: `Channel workflow not found: ${workflowId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { workflow: existing });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflow` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelWorkflowUpdateRequest(body);
    if (input.status && input.status !== existing.status) {
      const transition = transitionWorkflowToStatus(store, existing.id, existing.status, input.status, new Date().toISOString());
      if (!transition.ok) {
        writeJson(response, 409, { error: transition.code, message: `Workflow transition failed: ${transition.code}` });
        return;
      }
    }
    const workflow = store.updateChannelWorkflow(workflowId, { title: input.title, objective: input.objective }, new Date().toISOString());
    writeJson(response, 200, { workflow: workflow ?? store.getChannelWorkflow(workflowId) ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelWorkflowStepsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  workflowId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannelWorkflow(workflowId)) {
      writeJson(response, 404, { error: "workflow_not_found", message: `Channel workflow not found: ${workflowId}` });
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        workflowId,
        workflowSteps: store.listChannelWorkflowSteps({
          workflowId,
          status: readOptionalChannelWorkflowStepStatusQuery(url, "status"),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }
    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseChannelWorkflowStepRequest(body);
      const workflowStep = store.createChannelWorkflowStep({ ...input, workflowId }, new Date().toISOString());
      writeJson(response, 201, { workflowStep });
      return;
    }
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflow steps` });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelWorkflowStepItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  secretResolver: SecretResolver,
  workflowStepId: string,
  action?: "start",
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const existing = store.getChannelWorkflowStep(workflowStepId);
    if (!existing) {
      writeJson(response, 404, { error: "workflow_step_not_found", message: `Channel workflow step not found: ${workflowStepId}` });
      return;
    }
    if (action === "start") {
      await handleChannelWorkflowStepStart(request, response, config, runner, storeRegistry, activeRuns, secretResolver, cwd, existing.id);
      return;
    }
    if (request.method === "GET") {
      writeJson(response, 200, { workflowStep: existing });
      return;
    }
    if (request.method !== "PATCH") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel workflow step` });
      return;
    }
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseChannelWorkflowStepUpdateRequest(body);
    if (input.status && input.status !== existing.status) {
      const transition = transitionWorkflowStepToStatus(store, existing.id, existing.status, input.status, new Date().toISOString(), {
        taskId: input.taskId,
        runId: input.runId,
        blocker: input.blocker,
        resultSummary: input.resultSummary,
      });
      if (!transition.ok) {
        writeJson(response, 409, { error: transition.code, message: `Workflow step transition failed: ${transition.code}` });
        return;
      }
    }
    const workflowStep = store.updateChannelWorkflowStep(
      workflowStepId,
      { ...input, status: undefined },
      new Date().toISOString(),
    );
    writeJson(response, 200, { workflowStep: workflowStep ?? store.getChannelWorkflowStep(workflowStepId) ?? existing });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleChannelWorkflowStepStart(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  secretResolver: SecretResolver,
  cwd: string,
  workflowStepId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for workflow step start` });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const body = await readJsonBody(request, config.maxBodyBytes);
  const input = parseChannelWorkflowStepStartRequest(body);
  const started = prepareWorkflowStepStart(store, workflowStepId, input, cwd, secretResolver);
  if (started.kind === "blocked") {
    writeJson(response, 200, {
      workflow: store.getChannelWorkflow(started.workflowId),
      workflowStep: store.getChannelWorkflowStep(workflowStepId),
      blocker: started.blocker,
    });
    return;
  }
  if (started.kind === "error") {
    writeJson(response, started.statusCode, { error: started.code, message: started.message });
    return;
  }

  if (input.mode === "create_task") {
    const finishedAt = new Date().toISOString();
    store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "running",
      event: "succeed",
      actor: "system",
      reason: `task:${started.task.id}`,
      now: finishedAt,
      taskId: started.task.id,
      resultSummary: "Task created from workflow step.",
    });
    completeWorkflowIfStepsFinished(store, started.workflowId, finishedAt);
    writeJson(response, 200, {
      workflow: store.getChannelWorkflow(started.workflowId),
      workflowStep: store.getChannelWorkflowStep(workflowStepId),
      task: started.task,
    });
    return;
  }

  const runId = await executeRunRequest(started.runRequest, response, runner, storeRegistry, activeRuns, secretResolver);
  const completedAt = new Date().toISOString();
  if (!runId) {
    store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "running",
      event: "blocked",
      actor: "system",
      reason: "Run did not start.",
      now: completedAt,
      taskId: started.task.id,
      blocker: "Run did not start.",
    });
    store.transitionChannelWorkflowStatus({
      workflowId: started.workflowId,
      event: "step_blocked",
      actor: "system",
      reason: "Run did not start.",
      now: completedAt,
    });
    return;
  }
  const run = store.getRun(runId);
  if (run?.status === "succeeded") {
    store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "running",
      event: "succeed",
      actor: "runner",
      reason: `run:${runId}`,
      now: completedAt,
      taskId: started.task.id,
      runId,
      resultSummary: "Run succeeded.",
    });
    completeWorkflowIfStepsFinished(store, started.workflowId, completedAt);
    return;
  }
  store.transitionChannelWorkflowStepStatus({
    workflowStepId,
    expectedStatus: "running",
    event: "fail",
    actor: "runner",
    reason: run?.errorMessage ?? `run:${runId}`,
    now: completedAt,
    taskId: started.task.id,
    runId,
    blocker: run?.errorMessage,
  });
  store.transitionChannelWorkflowStatus({
    workflowId: started.workflowId,
    event: "step_failed",
    actor: "runner",
    reason: run?.errorMessage ?? `run:${runId}`,
    now: completedAt,
  });
}

type PreparedWorkflowStepStart =
  | { readonly kind: "ready"; readonly workflowId: string; readonly task: Task; readonly runRequest: RunRequest }
  | { readonly kind: "blocked"; readonly workflowId: string; readonly blocker: string }
  | { readonly kind: "error"; readonly statusCode: number; readonly code: string; readonly message: string };

function prepareWorkflowStepStart(
  store: RunStore,
  workflowStepId: string,
  input: ChannelWorkflowStepStartRequest,
  cwd: string,
  secretResolver: SecretResolver,
): PreparedWorkflowStepStart {
  const step = store.getChannelWorkflowStep(workflowStepId);
  if (!step) {
    return { kind: "error", statusCode: 404, code: "workflow_step_not_found", message: `Channel workflow step not found: ${workflowStepId}` };
  }
  const workflow = store.getChannelWorkflow(step.workflowId);
  if (!workflow) {
    return { kind: "error", statusCode: 404, code: "workflow_not_found", message: `Channel workflow not found: ${step.workflowId}` };
  }
  const channel = store.getChannel(step.channelId);
  if (!channel) {
    return { kind: "error", statusCode: 404, code: "channel_not_found", message: `Channel not found: ${step.channelId}` };
  }

  const now = new Date().toISOString();
  store.expireResourceLeases(now);
  const lease = store.acquireResourceLease({
    workspaceId: DEFAULT_WORKSPACE_ID,
    resourceType: "workflow_step",
    resourceKey: step.id,
    ownerType: "workflow_step",
    ownerId: step.id,
    acquiredAt: now,
    expiresAt: new Date(new Date(now).getTime() + RESOURCE_LEASE_TTL_MS).toISOString(),
  });
  if (!lease) {
    const blockingLease = store.getBlockingResourceLease("workflow_step", step.id);
    return {
      kind: "error",
      statusCode: 409,
      code: "resource_conflict",
      message: blockingLease ? `Workflow step is locked by ${blockingLease.ownerType}:${blockingLease.ownerId}` : `Workflow step is locked: ${step.id}`,
    };
  }

  const fail = (statusCode: number, code: string, message: string): PreparedWorkflowStepStart => {
    store.releaseResourceLeasesForOwner("workflow_step", step.id, new Date().toISOString());
    return { kind: "error", statusCode, code, message };
  };
  const block = (message: string): PreparedWorkflowStepStart => {
    const blockedAt = new Date().toISOString();
    store.transitionChannelWorkflowStepStatus({
      workflowStepId: step.id,
      expectedStatus: "running",
      event: "blocked",
      actor: "system",
      reason: message,
      now: blockedAt,
      blocker: message,
    });
    store.transitionChannelWorkflowStatus({
      workflowId: workflow.id,
      event: "step_blocked",
      actor: "system",
      reason: message,
      now: blockedAt,
    });
    store.releaseResourceLeasesForOwner("workflow_step", step.id, blockedAt);
    return { kind: "blocked", workflowId: workflow.id, blocker: message };
  };

  const workflowTransition = ensureWorkflowRunning(store, workflow.id, workflow.status, now);
  if (!workflowTransition.ok) {
    return fail(409, workflowTransition.code, `Workflow transition failed: ${workflowTransition.code}`);
  }
  const latestStep = store.getChannelWorkflowStep(step.id) ?? step;
  const stepTransition = ensureWorkflowStepRunning(store, step.id, latestStep.status, now);
  if (!stepTransition.ok) {
    return fail(409, stepTransition.code, `Workflow step transition failed: ${stepTransition.code}`);
  }

  const providerPresetId = input.providerPresetId ?? channel.defaultProviderPresetId;
  const taskTitle = input.taskTitle ?? step.title;
  const taskPrompt = input.taskPrompt ?? formatWorkflowStepTaskPrompt(step.prompt, workflow.objective);
  const runRequestBase: RunRequest = {
    workspaceCwd: cwd,
    cwd: channel.boundPath ?? cwd,
    providerPresetId,
    skipProviderPreflight: input.skipProviderPreflight ?? false,
    idempotencyKey: input.idempotencyKey ?? `workflow-step:${step.id}`,
    task: {
      id: "pending",
      title: taskTitle,
      prompt: taskPrompt,
      channelId: channel.id,
    },
    tools: channel.allowedTools,
    thinkingLevel: "medium",
  };

  if (input.mode === "create_and_run_task") {
    if (!providerPresetId) {
      return block("No provider preset is selected for this workflow step.");
    }
    try {
      resolveProviderForRun(store, runRequestBase, secretResolver);
    } catch (error) {
      return block(error instanceof Error ? error.message : String(error));
    }
  }

  const task = store.createTask(
    {
      channelId: channel.id,
      title: taskTitle,
      prompt: taskPrompt,
      assigneeTeammateId: input.assigneeTeammateId ?? step.toParticipantId,
    },
    new Date().toISOString(),
  );
  store.updateChannelWorkflowStep(step.id, { taskId: task.id }, new Date().toISOString());

  return {
    kind: "ready",
    workflowId: workflow.id,
    task,
    runRequest: {
      ...runRequestBase,
      task: {
        id: task.id,
        title: task.title,
        prompt: task.prompt,
        channelId: task.channelId,
      },
    },
  };
}

function ensureWorkflowRunning(
  store: RunStore,
  workflowId: string,
  status: ChannelWorkflowStatus,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStatus"]> {
  if (status === "running") {
    return { ok: true, from: status, to: status };
  }
  if (status === "draft") {
    const prepared = store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: "draft",
      event: "prepare",
      actor: "system",
      now,
    });
    if (!prepared.ok) {
      return prepared;
    }
    return store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: "ready",
      event: "start",
      actor: "system",
      now,
    });
  }
  if (status === "ready" || status === "blocked") {
    return store.transitionChannelWorkflowStatus({
      workflowId,
      expectedStatus: status,
      event: "start",
      actor: "system",
      now,
    });
  }
  return { ok: false, code: "invalid_transition", currentStatus: status };
}

function ensureWorkflowStepRunning(
  store: RunStore,
  workflowStepId: string,
  status: ChannelWorkflowStepStatus,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStepStatus"]> {
  if (status === "running") {
    return { ok: true, from: status, to: status };
  }
  if (status === "queued") {
    const claimed = store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "queued",
      event: "claim",
      actor: "system",
      now,
    });
    if (!claimed.ok) {
      return claimed;
    }
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  if (status === "blocked") {
    const resumed = store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "blocked",
      event: "resume",
      actor: "system",
      now,
      blocker: null,
    });
    if (!resumed.ok) {
      return resumed;
    }
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  if (status === "claimed") {
    return store.transitionChannelWorkflowStepStatus({
      workflowStepId,
      expectedStatus: "claimed",
      event: "start",
      actor: "system",
      now,
      blocker: null,
    });
  }
  return { ok: false, code: "invalid_transition", currentStatus: status };
}

function transitionWorkflowToStatus(
  store: RunStore,
  workflowId: string,
  currentStatus: ChannelWorkflowStatus,
  nextStatus: ChannelWorkflowStatus,
  now: string,
): ReturnType<RunStore["transitionChannelWorkflowStatus"]> {
  if (currentStatus === nextStatus) {
    return { ok: true, from: currentStatus, to: nextStatus };
  }
  const event =
    currentStatus === "draft" && nextStatus === "ready" ? "prepare"
      : (currentStatus === "ready" || currentStatus === "blocked") && nextStatus === "running" ? "start"
        : currentStatus === "running" && nextStatus === "waiting_for_approval" ? "approval_requested"
          : currentStatus === "waiting_for_approval" && nextStatus === "running" ? "approval_approved"
            : currentStatus === "running" && nextStatus === "blocked" ? "step_blocked"
              : (currentStatus === "running" || currentStatus === "blocked") && nextStatus === "failed" ? "step_failed"
                : currentStatus === "running" && nextStatus === "succeeded" ? "all_steps_succeeded"
                  : nextStatus === "cancelled" ? "cancel"
                    : undefined;
  if (!event) {
    return { ok: false, code: "invalid_transition", currentStatus };
  }
  return store.transitionChannelWorkflowStatus({
    workflowId,
    expectedStatus: currentStatus,
    event,
    actor: "local-user",
    now,
  });
}

function transitionWorkflowStepToStatus(
  store: RunStore,
  workflowStepId: string,
  currentStatus: ChannelWorkflowStepStatus,
  nextStatus: ChannelWorkflowStepStatus,
  now: string,
  metadata: {
    readonly taskId?: string | null;
    readonly runId?: string | null;
    readonly blocker?: string | null;
    readonly resultSummary?: string | null;
  } = {},
): ReturnType<RunStore["transitionChannelWorkflowStepStatus"]> {
  if (currentStatus === nextStatus) {
    return { ok: true, from: currentStatus, to: nextStatus };
  }
  const event =
    currentStatus === "queued" && nextStatus === "claimed" ? "claim"
      : currentStatus === "queued" && nextStatus === "skipped" ? "skip"
        : currentStatus === "claimed" && nextStatus === "running" ? "start"
          : currentStatus === "running" && nextStatus === "waiting_for_approval" ? "approval_requested"
            : currentStatus === "waiting_for_approval" && nextStatus === "running" ? "approval_approved"
              : currentStatus === "running" && nextStatus === "blocked" ? "blocked"
                : currentStatus === "blocked" && nextStatus === "claimed" ? "resume"
                  : currentStatus === "running" && nextStatus === "succeeded" ? "succeed"
                    : (currentStatus === "running" || currentStatus === "waiting_for_approval" || currentStatus === "blocked") && nextStatus === "failed" ? "fail"
                      : nextStatus === "cancelled" ? "cancel"
                        : undefined;
  if (!event) {
    return { ok: false, code: "invalid_transition", currentStatus };
  }
  return store.transitionChannelWorkflowStepStatus({
    workflowStepId,
    expectedStatus: currentStatus,
    event,
    actor: "local-user",
    now,
    taskId: metadata.taskId,
    runId: metadata.runId,
    blocker: metadata.blocker,
    resultSummary: metadata.resultSummary,
  });
}

function completeWorkflowIfStepsFinished(store: RunStore, workflowId: string, now: string): void {
  const workflow = store.getChannelWorkflow(workflowId);
  if (!workflow || workflow.status !== "running") {
    return;
  }
  const steps = store.listChannelWorkflowSteps({ workflowId, limit: 500 });
  if (steps.length === 0 || steps.some((step) => step.status !== "succeeded" && step.status !== "skipped")) {
    return;
  }
  store.transitionChannelWorkflowStatus({
    workflowId,
    expectedStatus: "running",
    event: "all_steps_succeeded",
    actor: "system",
    now,
  });
}

function formatHandoffStepPrompt(handoff: ChannelHandoff): string {
  return [
    `Reason: ${handoff.reason || "No reason provided."}`,
    `Required input: ${handoff.requiredInput || "No required input provided."}`,
    `Expected output: ${handoff.expectedOutput || "No expected output provided."}`,
    "",
    "Use the visible channel Brief, active decisions, and linked context summary before starting work.",
  ].join("\n");
}

function formatWorkflowStepTaskPrompt(prompt: string, workflowObjective: string): string {
  return [`Workflow objective: ${workflowObjective || "No objective provided."}`, "", prompt].join("\n");
}

async function handleTasksCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        tasks: store.listTasks({
          channelId: url.searchParams.get("channelId") ?? undefined,
          assigneeTeammateId: url.searchParams.get("assigneeTeammateId") ?? undefined,
          status: readOptionalTaskStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateTaskInput(body);
      if (!store.getChannel(input.channelId)) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const task = store.createTask(input, new Date().toISOString());
      writeJson(response, 201, { task });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /tasks` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTaskItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  taskId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const task = store.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "task_not_found", message: `Task not found: ${taskId}` });
      return;
    }

    if (request.method === "GET") {
      writeJson(response, 200, { task });
      return;
    }

    if (request.method === "PATCH") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseTaskUpdateInput(body);
      if (input.channelId && !store.getChannel(input.channelId)) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const updated = store.updateTask(taskId, input, new Date().toISOString());
      writeJson(response, 200, { task: updated });
      return;
    }

    if (request.method === "DELETE") {
      store.deleteTask(taskId);
      writeJson(response, 200, { ok: true });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for tasks` });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleTaskRunRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  secretResolver: SecretResolver,
  taskId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const workspaceCwd = url.searchParams.get("cwd");
  if (!workspaceCwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    if (!isRecord(body)) {
      throw new Error("Task run request must be a JSON object");
    }
    const providerPresetId = readString(body, "providerPresetId");
    const store = storeRegistry.getStore(workspaceCwd);
    const task = store.getTask(taskId);
    if (!task) {
      writeJson(response, 404, { error: "task_not_found", message: `Task not found: ${taskId}` });
      return;
    }
    const channel = store.getChannel(task.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${task.channelId}` });
      return;
    }

    await executeRunRequest(
      {
        workspaceCwd,
        cwd: channel.boundPath ?? workspaceCwd,
        providerPresetId,
        skipProviderPreflight: readOptionalBoolean(body, "skipProviderPreflight") ?? false,
        idempotencyKey: readOptionalString(body, "idempotencyKey"),
        task: {
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          channelId: task.channelId,
        },
        tools: readOptionalRunTools(body, "tools") ?? channel.allowedTools,
        approvalProfile: readOptionalApprovalProfile(body, "approvalProfile"),
        thinkingLevel: readOptionalThinkingLevel(body, "thinkingLevel"),
        systemPrompt: readOptionalString(body, "systemPrompt"),
        appendSystemPrompt: readOptionalStringArray(body, "appendSystemPrompt"),
        agentDir: readOptionalString(body, "agentDir"),
      },
      response,
      runner,
      storeRegistry,
      activeRuns,
      secretResolver,
    );
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleProvidersCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    writeJson(response, 200, {
      cwd,
      providers: store.listProviderPresets().map((preset) => toPublicProviderPreset(store, preset, secretResolver)),
    });
    return;
  }

  if (request.method === "POST") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseProviderPresetCreateRequest(body);
      const now = new Date().toISOString();
      const preset = store.createProviderPreset(input.presetInput, now);
      const provider = input.apiKey ? saveLocalProviderSecret(store, preset, input.apiKey, now) : preset;
      writeJson(response, 201, { provider: toPublicProviderPreset(store, provider, secretResolver) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /providers` });
}

async function handleProviderDraftCheck(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /provider-check` });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseProviderPresetCreateRequest(body);
    const store = storeRegistry.getStore(cwd);
    const preset = providerDraftInputToPreset(input.presetInput, input.apiKey, new Date().toISOString());
    const resolver = input.apiKey ? createDraftProviderSecretResolver(secretResolver, input.apiKey) : secretResolver;
    const result = await checkProviderPreset(store, preset, resolver);
    writeJson(response, 200, result);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleProviderItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  route: { readonly providerId: string; readonly action?: "check" | "secret" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  const preset = store.getProviderPreset(route.providerId);
  if (!preset) {
    writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
    return;
  }

  if (request.method === "POST" && route.action === "check") {
    const checkResult = await checkProviderPreset(store, preset, secretResolver);
    store.recordProviderCheckResult(route.providerId, checkResult);
    writeJson(response, 200, checkResult);
    return;
  }

  if (request.method === "GET" && route.action === "secret") {
    writeJson(response, 200, toProviderSecretResponse(store, preset));
    return;
  }

  if (route.action) {
    writeJson(response, 404, { error: "not_found", message: `No route for ${request.method} ${url.pathname}` });
    return;
  }

  if (request.method === "GET") {
    writeJson(response, 200, { provider: toPublicProviderPreset(store, preset, secretResolver) });
    return;
  }

  if (request.method === "PATCH") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseProviderPresetUpdateRequest(body);
      const updateInput = providerUpdateWithSecretRef(route.providerId, input);
      validateProviderPresetUpdate(preset, updateInput);
      const now = new Date().toISOString();
      const updated = store.updateProviderPreset(route.providerId, updateInput, now);
      if (!updated) {
        writeJson(response, 404, { error: "provider_not_found", message: `Provider preset not found: ${route.providerId}` });
        return;
      }
      if (input.apiKey) {
        store.setProviderSecret(route.providerId, input.apiKey, now);
      }
      if (input.clearApiKey) {
        store.deleteProviderSecret(route.providerId);
      }
      writeJson(response, 200, { provider: toPublicProviderPreset(store, updated, secretResolver) });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (request.method === "DELETE") {
    store.deleteProviderSecret(route.providerId);
    store.deleteProviderPreset(route.providerId);
    writeJson(response, 200, { ok: true });
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for provider presets` });
}

async function handleProviderModelsProbe(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /provider-models` });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseProviderModelListRequest(body);
    const store = storeRegistry.getStore(cwd);
    const result = await listProviderModels(store, input, secretResolver);
    writeJson(response, 200, result);
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleMediaJobsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (request.method === "GET") {
      writeJson(response, 200, {
        cwd,
        mediaJobs: store.listMediaJobs({
          providerPresetId: url.searchParams.get("providerPresetId") ?? undefined,
          status: readOptionalMediaJobStatusQuery(url),
          limit: readOptionalIntegerQuery(url, "limit", 1),
        }),
      });
      return;
    }

    if (request.method === "POST") {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const input = parseCreateMediaJobInput(body);
      assertMediaJobProvider(store, input, secretResolver);
      const job = store.createMediaJob(input, new Date().toISOString());
      writeJson(response, 201, { mediaJob: job });
      return;
    }

    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /media-jobs` });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : 400;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleExternalGitHubImport(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub external work import` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubImportRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }

    const workflowMarkdown = readExternalWorkflowMarkdown(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowMarkdown);
    if (workflowDefinition.config.source.kind !== "github") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const externalWorkItem = normalizeGitHubExternalWorkItem({
      eventType: input.eventType,
      payload: input.payload,
      repositoryFullName: workflowDefinition.config.source.repository,
    });
    const renderedPrompt = renderExternalWorkflowPrompt(workflowDefinition.promptTemplate, { item: externalWorkItem });
    const now = new Date().toISOString();
    const imported = store.createOrReuseExternalWorkWorkflow(
      {
        channelId: channel.id,
        externalWorkItem,
        workflowDefinition,
        renderedPrompt,
      },
      now,
    );
    const artifacts = imported.duplicate
      ? store.listExternalWorkArtifacts(imported.externalWork.id)
      : createExternalWorkEvidenceArtifacts(store, imported.externalWork.id, externalWorkItem, renderedPrompt, now);
    if (!imported.duplicate) {
      store.updateExternalWorkArtifacts(imported.externalWork.id, artifacts.map((artifact) => artifact.id), new Date().toISOString());
    }
    const responseBody: ExternalWorkImportResponse = {
      externalWorkItem,
      workflow: imported.workflow,
      workflowStep: imported.workflowStep,
      artifacts,
      duplicate: imported.duplicate,
    };
    writeJson(response, imported.duplicate ? 200 : 201, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalLinearImport(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for Linear external work import` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalLinearImportRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }

    const workflowMarkdown = readExternalWorkflowMarkdown(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowMarkdown);
    if (workflowDefinition.config.source.kind !== "linear") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const externalWorkItem = normalizeLinearExternalWorkItem({
      eventType: input.eventType,
      payload: input.payload,
      projectSlug: workflowDefinition.config.source.projectSlug,
    });
    const renderedPrompt = renderExternalWorkflowPrompt(workflowDefinition.promptTemplate, { item: externalWorkItem });
    const now = new Date().toISOString();
    const imported = store.createOrReuseExternalWorkWorkflow(
      {
        channelId: channel.id,
        externalWorkItem,
        workflowDefinition,
        renderedPrompt,
      },
      now,
    );
    const artifacts = imported.duplicate
      ? store.listExternalWorkArtifacts(imported.externalWork.id)
      : createExternalWorkEvidenceArtifacts(store, imported.externalWork.id, externalWorkItem, renderedPrompt, now);
    if (!imported.duplicate) {
      store.updateExternalWorkArtifacts(imported.externalWork.id, artifacts.map((artifact) => artifact.id), new Date().toISOString());
    }
    const responseBody: ExternalWorkImportResponse = {
      externalWorkItem,
      workflow: imported.workflow,
      workflowStep: imported.workflowStep,
      artifacts,
      duplicate: imported.duplicate,
    };
    writeJson(response, imported.duplicate ? 200 : 201, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work list` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const records = store.listExternalWorkRecords({
      channelId: url.searchParams.get("channelId") ?? undefined,
      sourceKind: readOptionalExternalSourceKindQuery(url),
      workItemKind: readOptionalExternalWorkItemKindQuery(url),
      schedulerStatus: readOptionalExternalWorkSchedulerStatusQuery(url),
      limit: readOptionalIntegerQuery(url, "limit", 1),
    });
    const responseBody: ExternalWorkListResponse = {
      cwd,
      externalWork: records.map((record) => buildExternalWorkView(store, record)),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  externalWorkId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work detail` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const record = store.getExternalWorkRecord(externalWorkId);
    if (!record) {
      writeJson(response, 404, { error: "external_work_not_found", message: `External work item not found: ${externalWorkId}` });
      return;
    }
    const responseBody: ExternalWorkDetailResponse = {
      cwd,
      externalWork: buildExternalWorkView(store, record),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function buildExternalWorkView(store: RunStore, externalWork: ExternalWorkRecord): ExternalWorkView {
  const workflow = store.getChannelWorkflow(externalWork.workflowId);
  const workflowStep = store.getChannelWorkflowStep(externalWork.workflowStepId);
  const schedulerState = store.getExternalWorkSchedulerState(externalWork.id);
  return {
    externalWork,
    ...(workflow ? { workflow } : {}),
    ...(workflowStep ? { workflowStep } : {}),
    ...(schedulerState ? { schedulerState } : {}),
    artifacts: store.listExternalWorkArtifacts(externalWork.id),
  };
}

async function handleExternalWorkStatus(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerRegistry | undefined,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work status` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const channelId = url.searchParams.get("channelId");
  if (!channelId) {
    writeJson(response, 400, { error: "bad_request", message: "channelId query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }

    const workflowFile = readExternalWorkflowStatusFile(channel, cwd, url.searchParams.get("workflowPath") ?? undefined);
    const parsed = parseExternalWorkflowStatus(workflowFile.markdown);
    const workflowDefinition = parsed.workflowDefinition;
    const sourceKind = workflowDefinition?.config.source.kind ?? "unknown";
    const secretPurpose = sourceKind === "github" ? "github_token" : sourceKind === "linear" ? "linear_token" : undefined;
    const secretRef = workflowDefinition?.config.source.secretRef;
    const secret = buildExternalWorkStatusSecret(secretResolver, secretRef, secretPurpose);
    const backgroundScheduler = pickExternalWorkBackgroundScheduler(backgroundSchedulers?.list(cwd) ?? [], channel.id, workflowDefinition?.config.source.repository);
    const responseBody: ExternalWorkStatusResponse = {
      cwd,
      channel: {
        id: channel.id,
        name: channel.name,
        ...(channel.boundPath ? { boundPath: channel.boundPath } : {}),
      },
      workflow: buildExternalWorkStatusWorkflowSummary(workflowFile, parsed),
      secret,
      records: buildExternalWorkStatusCounts(store, channel.id),
      background: buildExternalWorkStatusBackground(backgroundScheduler, sourceKind),
      lastErrors: {
        ...(backgroundScheduler?.lastPoll?.results.some((item) => item.action === "blocked" && item.message)
          ? { poll: backgroundScheduler.lastPoll.results.find((item) => item.action === "blocked" && item.message)?.message }
          : {}),
        ...(backgroundScheduler?.lastReconcile?.schedulerStates.some((state) => state.lastErrorMessage)
          ? { reconcile: backgroundScheduler.lastReconcile.schedulerStates.find((state) => state.lastErrorMessage)?.lastErrorMessage }
          : {}),
        ...(backgroundScheduler?.lastErrorMessage ? { background: backgroundScheduler.lastErrorMessage } : {}),
      },
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkWorkflowConfigure(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work workflow setup` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const input = readExternalWorkWorkflowConfigureRequest(body);
    const store = storeRegistry.getStore(cwd);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }

    const targetPath = resolveExternalWorkflowWritablePath(channel, cwd, input.workflowPath);
    const existingFile = readExternalWorkflowStatusFile(channel, cwd, input.workflowPath);
    const existingParsed = parseExternalWorkflowStatus(existingFile.markdown);
    const workflowCreated = !existingFile.exists;
    let workflowUpdated = false;

    if (!existingFile.exists || !existingParsed.workflowDefinition) {
      writeFileSync(targetPath, buildMinimalExternalWorkflowMarkdown(input), "utf8");
      workflowUpdated = true;
    }

    const workflowFile = readExternalWorkflowStatusFile(channel, cwd, input.workflowPath);
    const parsed = parseExternalWorkflowStatus(workflowFile.markdown);
    if (!parsed.workflowDefinition) {
      throw new Error(parsed.error ?? "Generated WORKFLOW.md is invalid.");
    }
    const responseBody: ExternalWorkWorkflowMutationResponse = {
      cwd,
      channelId: channel.id,
      sourceKind: parsed.workflowDefinition.config.source.kind,
      workflow: buildExternalWorkStatusWorkflowSummary(workflowFile, parsed),
      workflowCreated,
      workflowUpdated,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkSecretConfigure(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalSecretStore: ExternalSecretStore,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work secret setup` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const input = readExternalWorkSecretConfigureRequest(body);
    const prepared = prepareExternalWorkSecretMutation(storeRegistry, cwd, input.channelId, input.workflowPath);
    const token = input.token.trim();
    if (!token) {
      throw new Error("token is required.");
    }
    const secretRef = normalizeExternalWorkSecretRef(input.secretRef ?? prepared.workflowDefinition.config.source.secretRef, prepared.workflowDefinition);
    const setStatus = externalSecretStore.setSecret(secretRef, token, externalWorkSecretPurpose(prepared.workflowDefinition.config.source.kind));
    if (!setStatus.configured) {
      throw new Error(setStatus.message ?? `Could not save secret: ${secretRef}`);
    }

    const workflowUpdated = updateExternalWorkWorkflowSecretRefIfNeeded(prepared.workflowFile.path, prepared.workflowFile.markdown, secretRef, input.updateWorkflow !== false);
    const workflowFile = readExternalWorkflowStatusFile(prepared.channel, cwd, input.workflowPath);
    const parsed = parseExternalWorkflowStatus(workflowFile.markdown);
    const workflowDefinition = parsed.workflowDefinition ?? prepared.workflowDefinition;
    const responseBody: ExternalWorkSecretMutationResponse = {
      cwd,
      channelId: prepared.channel.id,
      sourceKind: workflowDefinition.config.source.kind,
      secretRef,
      secret: buildExternalWorkStatusSecret(secretResolver, secretRef, externalWorkSecretPurpose(workflowDefinition.config.source.kind)),
      workflow: buildExternalWorkStatusWorkflowSummary(workflowFile, parsed, secretRef),
      workflowUpdated,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkSecretDelete(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalSecretStore: ExternalSecretStore,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work secret deletion` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const input = readExternalWorkSecretDeleteRequest(body);
    const prepared = prepareExternalWorkSecretMutation(storeRegistry, cwd, input.channelId, input.workflowPath);
    const sourceKind = prepared.workflowDefinition.config.source.kind;
    const secretRef = input.secretRef ?? prepared.workflowDefinition.config.source.secretRef;
    if (!secretRef) {
      throw new Error("WORKFLOW.md source.secretRef is required to remove a configured token.");
    }
    const parsedRef = parseSecretRef(secretRef);
    if (parsedRef.kind !== "keychain") {
      throw new Error("Only keychain: external work secrets can be removed from Web Settings.");
    }
    externalSecretStore.deleteSecret(secretRef, externalWorkSecretPurpose(sourceKind));
    const workflowFile = readExternalWorkflowStatusFile(prepared.channel, cwd, input.workflowPath);
    const parsed = parseExternalWorkflowStatus(workflowFile.markdown);
    const responseBody: ExternalWorkSecretMutationResponse = {
      cwd,
      channelId: prepared.channel.id,
      sourceKind,
      secretRef,
      secret: buildExternalWorkStatusSecret(secretResolver, secretRef, externalWorkSecretPurpose(sourceKind)),
      workflow: buildExternalWorkStatusWorkflowSummary(workflowFile, parsed, secretRef),
      workflowUpdated: false,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function prepareExternalWorkSecretMutation(
  storeRegistry: RunStoreRegistry,
  cwd: string,
  channelId: string,
  workflowPath: string | undefined,
): {
  readonly channel: Channel;
  readonly workflowFile: { readonly path: string; readonly exists: boolean; readonly markdown: string; readonly error?: string };
  readonly workflowDefinition: ExternalWorkflowDefinition;
} {
  const store = storeRegistry.getStore(cwd);
  const channel = store.getChannel(channelId);
  if (!channel) {
    throw new Error(`Channel not found: ${channelId}`);
  }
  const workflowFile = readExternalWorkflowStatusFile(channel, cwd, workflowPath);
  if (!workflowFile.exists || !workflowFile.markdown) {
    throw new Error(workflowFile.error ?? "WORKFLOW.md was not found");
  }
  const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
  return {
    channel,
    workflowFile: {
      path: workflowFile.path,
      exists: true,
      markdown: workflowFile.markdown,
      ...(workflowFile.error ? { error: workflowFile.error } : {}),
    },
    workflowDefinition,
  };
}

function readExternalWorkSecretConfigureRequest(body: unknown): ExternalWorkSecretConfigureRequest {
  if (!isRecord(body)) {
    throw new Error("external work secret setup request must be a JSON object");
  }
  const value = body;
  const channelId = readStringAllowEmpty(value, "channelId").trim();
  if (!channelId) {
    throw new Error("channelId is required.");
  }
  return {
    channelId,
    workflowPath: readOptionalString(value, "workflowPath"),
    token: readStringAllowEmpty(value, "token"),
    secretRef: readOptionalString(value, "secretRef"),
    updateWorkflow: readOptionalBoolean(value, "updateWorkflow"),
  };
}

function readExternalWorkSecretDeleteRequest(body: unknown): ExternalWorkSecretDeleteRequest {
  if (!isRecord(body)) {
    throw new Error("external work secret delete request must be a JSON object");
  }
  const value = body;
  const channelId = readStringAllowEmpty(value, "channelId").trim();
  if (!channelId) {
    throw new Error("channelId is required.");
  }
  return {
    channelId,
    workflowPath: readOptionalString(value, "workflowPath"),
    secretRef: readOptionalString(value, "secretRef"),
  };
}

function readExternalWorkWorkflowConfigureRequest(body: unknown): ExternalWorkWorkflowConfigureRequest {
  if (!isRecord(body)) {
    throw new Error("external work workflow setup request must be a JSON object");
  }
  const value = body;
  const channelId = readStringAllowEmpty(value, "channelId").trim();
  if (!channelId) {
    throw new Error("channelId is required.");
  }
  const sourceKind = readExternalSourceKind(value, "sourceKind");
  const rawRepository = readOptionalString(value, "repository");
  const repository = rawRepository !== undefined ? normalizeGitHubRepositoryInput(rawRepository) : undefined;
  const projectSlug = readOptionalString(value, "projectSlug")?.trim();
  if (sourceKind === "github") {
    if (!repository) {
      throw new Error("repository is required for GitHub external work and must use owner/repo or GitHub URL format.");
    }
  } else if (!projectSlug) {
    throw new Error("projectSlug is required for Linear external work.");
  } else if (!/^[A-Za-z0-9_.-]+$/.test(projectSlug)) {
    throw new Error("projectSlug may only contain letters, numbers, dots, underscores, and dashes.");
  }
  return {
    channelId,
    workflowPath: readOptionalString(value, "workflowPath"),
    sourceKind,
    ...(repository ? { repository } : {}),
    ...(projectSlug ? { projectSlug } : {}),
  };
}

function readExternalSourceKind(record: Record<string, unknown>, key: string): ExternalSourceKind {
  const value = readStringAllowEmpty(record, key).trim();
  if (!externalSourceKinds.includes(value as ExternalSourceKind)) {
    throw new Error(`${key} must be one of: ${externalSourceKinds.join(", ")}`);
  }
  return value as ExternalSourceKind;
}

function normalizeGitHubRepositoryInput(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }

  let candidate = trimmed;
  if (/^https?:\/\//i.test(candidate)) {
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      return undefined;
    }
    if (url.hostname !== "github.com") {
      return undefined;
    }
    const [owner, repo] = url.pathname.split("/").filter(Boolean);
    candidate = owner && repo ? `${owner}/${repo}` : "";
  } else if (candidate.startsWith("git@github.com:")) {
    candidate = candidate.slice("git@github.com:".length);
  } else if (candidate.startsWith("github.com/")) {
    candidate = candidate.slice("github.com/".length);
  }

  candidate = candidate.replace(/\.git$/i, "").replace(/\/+$/g, "");
  const [owner, repo, ...extra] = candidate.split("/");
  if (!owner || !repo || extra.length > 0) {
    return undefined;
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    return undefined;
  }
  return `${owner}/${repo}`;
}

function resolveExternalWorkflowWritablePath(channel: Channel, cwd: string, workflowPathInput: string | undefined): string {
  const root = channel.boundPath ?? cwd;
  const rootRealPath = realpathSync(root);
  const workflowPath = workflowPathInput
    ? isAbsolute(workflowPathInput)
      ? workflowPathInput
      : resolvePath(rootRealPath, workflowPathInput)
    : resolvePath(rootRealPath, "WORKFLOW.md");

  if (!isPathInsideRoot(rootRealPath, workflowPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  const existing = statFileIfPresent(workflowPath);
  if (existing) {
    if (!existing.isFile()) {
      throw new Error("Workflow path is not a file");
    }
    const workflowRealPath = realpathSync(workflowPath);
    if (!isPathInsideRoot(rootRealPath, workflowRealPath)) {
      throw new Error("workflowPath must resolve inside the channel bound path");
    }
    return workflowRealPath;
  }

  const parentPath = resolvePath(workflowPath, "..");
  mkdirSync(parentPath, { recursive: true });
  const parentRealPath = realpathSync(parentPath);
  if (!isPathInsideRoot(rootRealPath, parentRealPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  return workflowPath;
}

function buildMinimalExternalWorkflowMarkdown(input: ExternalWorkWorkflowConfigureRequest): string {
  const sourceBlock = input.sourceKind === "github"
    ? [
        "source:",
        "  kind: github",
        `  repository: ${input.repository}`,
        "  events:",
        "    - pull_request.opened",
        "    - pull_request.synchronize",
        "    - issue.opened",
      ]
    : [
        "source:",
        "  kind: linear",
        `  projectSlug: ${input.projectSlug}`,
        "  events:",
        "    - issue.created",
      ];
  return [
    "---",
    ...sourceBlock,
    "scheduler:",
    "  reconcileOnStartup: false",
    "agent:",
    "  teammateId: engineer",
    "---",
    "",
    "Review {{ item.kind }} {{ item.identifier }}.",
    "",
    "Title: {{ item.title }}",
    "State: {{ item.state }}",
    "",
    "Summarize the requested work, identify required code, test, and docs changes, and propose a safe implementation plan.",
    "Do not perform external mutations unless a separate approval-gated action is explicitly requested.",
    "",
  ].join("\n");
}

function normalizeExternalWorkSecretRef(secretRef: string | undefined, workflowDefinition: ExternalWorkflowDefinition): string {
  if (secretRef) {
    const parsed = parseSecretRef(secretRef);
    if (parsed.kind !== "keychain") {
      throw new Error("Web token setup requires a keychain: secretRef.");
    }
    return secretRef;
  }
  return `keychain:${defaultExternalWorkSecretName(workflowDefinition)}`;
}

function defaultExternalWorkSecretName(workflowDefinition: ExternalWorkflowDefinition): string {
  const source = workflowDefinition.config.source;
  const target = source.kind === "github" ? source.repository : source.projectSlug;
  const suffix = (target ?? "default")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase()
    .slice(0, 80) || "DEFAULT";
  return `LING_STACK_${source.kind.toUpperCase()}_${suffix}_TOKEN`;
}

function externalWorkSecretPurpose(sourceKind: ExternalSourceKind): "github_token" | "linear_token" {
  return sourceKind === "github" ? "github_token" : "linear_token";
}

function updateExternalWorkWorkflowSecretRefIfNeeded(path: string, markdown: string, secretRef: string, shouldUpdate: boolean): boolean {
  if (!shouldUpdate) {
    return false;
  }
  const current = parseExternalWorkflowMarkdown(markdown).config.source.secretRef;
  if (current === secretRef) {
    return false;
  }
  writeFileSync(path, updateExternalWorkflowSecretRef(markdown, secretRef), "utf8");
  return true;
}

function readExternalWorkflowStatusFile(
  channel: Channel,
  cwd: string,
  workflowPathInput: string | undefined,
): { readonly path: string; readonly exists: boolean; readonly markdown?: string; readonly error?: string } {
  const root = channel.boundPath ?? cwd;
  let rootRealPath: string;
  try {
    rootRealPath = realpathSync(root);
  } catch (error) {
    const workflowPath = workflowPathInput
      ? isAbsolute(workflowPathInput)
        ? workflowPathInput
        : resolvePath(root, workflowPathInput)
      : resolvePath(root, "WORKFLOW.md");
    return {
      path: resolvePath(workflowPath),
      exists: false,
      error: `Channel bound path cannot be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const workflowPath = workflowPathInput
    ? isAbsolute(workflowPathInput)
      ? workflowPathInput
      : resolvePath(rootRealPath, workflowPathInput)
    : resolvePath(rootRealPath, "WORKFLOW.md");

  if (!isPathInsideRoot(rootRealPath, workflowPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  const stat = statFileIfPresent(workflowPath);
  if (!stat) {
    return { path: resolvePath(workflowPath), exists: false, error: "WORKFLOW.md was not found" };
  }
  if (!stat.isFile()) {
    return { path: resolvePath(workflowPath), exists: true, error: "Workflow path is not a file" };
  }
  const workflowRealPath = realpathSync(workflowPath);
  if (!isPathInsideRoot(rootRealPath, workflowRealPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  return {
    path: workflowRealPath,
    exists: true,
    markdown: readFileSync(workflowRealPath, "utf8"),
  };
}

function parseExternalWorkflowStatus(markdown: string | undefined): {
  readonly workflowDefinition?: ExternalWorkflowDefinition;
  readonly error?: string;
} {
  if (!markdown) {
    return {};
  }
  try {
    return { workflowDefinition: parseExternalWorkflowMarkdown(markdown) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function buildExternalWorkStatusWorkflowSummary(
  workflowFile: { readonly path: string; readonly exists: boolean; readonly markdown?: string; readonly error?: string },
  parsed: { readonly workflowDefinition?: ExternalWorkflowDefinition; readonly error?: string },
  secretRefOverride?: string,
): ExternalWorkStatusResponse["workflow"] {
  const workflowDefinition = parsed.workflowDefinition;
  const source = workflowDefinition?.config.source;
  const secretRef = secretRefOverride ?? source?.secretRef;
  return {
    path: workflowFile.path,
    exists: workflowFile.exists,
    valid: Boolean(workflowFile.exists && workflowDefinition && !workflowFile.error),
    sourceKind: source?.kind ?? "unknown",
    events: source?.events ?? [],
    ...(workflowFile.error || parsed.error ? { error: workflowFile.error ?? parsed.error } : {}),
    ...(source?.repository ? { repository: source.repository } : {}),
    ...(source?.projectSlug ? { projectSlug: source.projectSlug } : {}),
    ...(secretRef ? { secretRef } : {}),
  };
}

function buildExternalWorkStatusSecret(
  secretResolver: SecretResolver,
  secretRef: string | undefined,
  purpose: "github_token" | "linear_token" | undefined,
): ExternalWorkStatusResponse["secret"] {
  if (!secretRef || !purpose) {
    return { status: "not_required" };
  }
  const status = secretResolver.status(secretRef, purpose);
  if (status.configured) {
    return { ref: status.ref, purpose, status: "configured" };
  }
  const mappedStatus = status.errorCode === "secret_missing"
    ? "missing"
    : status.errorCode === "invalid_secret_ref"
      ? "invalid"
      : "unavailable";
  return {
    ref: status.ref,
    purpose,
    status: mappedStatus,
    ...(status.message ? { message: status.message } : {}),
  };
}

function buildExternalWorkStatusCounts(store: RunStore, channelId: string): ExternalWorkStatusResponse["records"] {
  return {
    externalWork: {
      total: store.countExternalWorkRecords({ channelId }),
      ready: store.countExternalWorkRecords({ channelId, schedulerStatus: "ready" }),
      blocked: store.countExternalWorkRecords({ channelId, schedulerStatus: "blocked" }),
      retryWait: store.countExternalWorkRecords({ channelId, schedulerStatus: "retry_wait" }),
      terminal: store.countExternalWorkRecords({ channelId, schedulerStatus: "terminal" }),
    },
    ciTriage: {
      total: store.countExternalWorkCiTriage({ channelId }),
      triaged: store.countExternalWorkCiTriage({ channelId, status: "triaged" }),
      taskCreated: store.countExternalWorkCiTriage({ channelId, status: "task_created" }),
      runRequested: store.countExternalWorkCiTriage({ channelId, status: "run_requested" }),
      blocked: store.countExternalWorkCiTriage({ channelId, status: "blocked" }),
      stale: store.countExternalWorkCiTriage({ channelId, status: "stale" }),
      failed: store.countExternalWorkCiTriage({ channelId, status: "failed" }),
    },
    actions: {
      total: store.countExternalWorkActions({ channelId }),
      waitingForApproval: store.countExternalWorkActions({ channelId, status: "waiting_for_approval" }),
      approved: store.countExternalWorkActions({ channelId, status: "approved" }),
      failed: store.countExternalWorkActions({ channelId, status: "failed" }),
      succeeded: store.countExternalWorkActions({ channelId, status: "succeeded" }),
      cancelled: store.countExternalWorkActions({ channelId, status: "cancelled" }),
      staleTarget: store.countExternalWorkActions({ channelId, status: "stale_target" }),
    },
  };
}

function pickExternalWorkBackgroundScheduler(
  schedulers: readonly ExternalWorkBackgroundScheduler[],
  channelId: string,
  repository: string | undefined,
): ExternalWorkBackgroundScheduler | undefined {
  const candidates = schedulers.filter((scheduler) =>
    scheduler.channelId === channelId && (!repository || !scheduler.repository || scheduler.repository === repository)
  );
  return candidates.find((scheduler) => scheduler.status === "running") ?? candidates[0];
}

function buildExternalWorkStatusBackground(
  scheduler: ExternalWorkBackgroundScheduler | undefined,
  sourceKind: ExternalWorkStatusResponse["workflow"]["sourceKind"],
): ExternalWorkStatusResponse["background"] {
  if (sourceKind === "linear") {
    return { supported: false, running: false, status: "unsupported" };
  }
  if (sourceKind !== "github") {
    return { supported: false, running: false, status: "not_configured" };
  }
  if (!scheduler) {
    return { supported: true, running: false, status: "not_configured" };
  }
  return {
    supported: true,
    running: scheduler.status === "running",
    schedulerId: scheduler.id,
    status: scheduler.status,
    ...(scheduler.lastPollAt ? { lastTickAt: scheduler.lastPollAt } : {}),
    ...(scheduler.nextPollAt ? { nextPollAt: scheduler.nextPollAt } : {}),
    ...(scheduler.lastErrorMessage ? { lastError: scheduler.lastErrorMessage } : {}),
  };
}

async function handleExternalWorkActionPropose(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action propose` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const result = proposeExternalWorkAction({
      store: storeRegistry.getStore(cwd),
      request: readExternalWorkActionProposeRequest(body),
      now: new Date().toISOString(),
    });
    const responseBody: ExternalWorkActionMutationResponse = {
      cwd,
      action: result.action,
      ...(result.approval ? { approval: result.approval } : {}),
      artifacts: result.artifacts,
      duplicate: result.duplicate,
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkActionsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work actions list` });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const store = storeRegistry.getStore(cwd);
    const actions = store.listExternalWorkActions({
      externalWorkId: url.searchParams.get("externalWorkId") ?? undefined,
      channelId: url.searchParams.get("channelId") ?? undefined,
      status: readOptionalExternalWorkActionStatusQuery(url),
      actionKind: readOptionalExternalWorkActionKindQuery(url),
      limit: readOptionalIntegerQuery(url, "limit", 1),
    });
    const responseBody: ExternalWorkActionListResponse = {
      cwd,
      actions: actions.map((action) => buildExternalWorkActionView(store, action)),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkActionItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch: typeof globalThis.fetch | undefined,
  route: { readonly actionId: string; readonly action?: "cancel" | "execute" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const store = storeRegistry.getStore(cwd);
  if (!route.action && request.method === "GET") {
    const action = store.getExternalWorkAction(route.actionId);
    if (!action) {
      writeJson(response, 404, { error: "external_work_action_not_found", message: `External work action not found: ${route.actionId}` });
      return;
    }
    const responseBody: ExternalWorkActionDetailResponse = {
      cwd,
      action: buildExternalWorkActionView(store, action),
    };
    writeJson(response, 200, responseBody);
    return;
  }
  if (route.action === "cancel") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action cancel` });
      return;
    }
    try {
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const result = cancelExternalWorkAction({
        store,
        actionId: route.actionId,
        request: isRecord(body) ? { reason: readOptionalString(body, "reason") } : undefined,
        now: new Date().toISOString(),
      });
      const responseBody: ExternalWorkActionMutationResponse = {
        cwd,
        action: result.action,
        ...(result.approval ? { approval: result.approval } : {}),
        artifacts: result.artifacts,
      };
      writeJson(response, 200, responseBody);
    } catch (error) {
      writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  if (route.action === "execute") {
    if (request.method !== "POST") {
      writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action execute` });
      return;
    }
    try {
      const body = await readOptionalJsonBody(request, config.maxBodyBytes);
      const input = parseExternalWorkActionExecuteRequest(body);
      const action = store.getExternalWorkAction(route.actionId);
      if (!action) {
        writeJson(response, 404, { error: "external_work_action_not_found", message: `External work action not found: ${route.actionId}` });
        return;
      }
      const channel = store.getChannel(action.channelId);
      if (!channel) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${action.channelId}` });
        return;
      }
      const workflowFile = readExternalWorkflowFile(input, channel, cwd);
      const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
      if (workflowDefinition.config.source.kind !== "github") {
        writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
        return;
      }
      if (workflowDefinition.config.source.repository && workflowDefinition.config.source.repository !== action.target.repository) {
        writeJson(response, 400, { error: "repository_mismatch", message: `WORKFLOW.md source.repository does not match action target: ${workflowDefinition.config.source.repository} !== ${action.target.repository}` });
        return;
      }
      const githubToken = resolveExternalGitHubToken(workflowDefinition, secretResolver);
      const result = await executeExternalWorkAction({
        store,
        actionId: route.actionId,
        githubToken,
        fetch: externalWorkFetch,
      });
      const responseBody: ExternalWorkActionMutationResponse = {
        cwd,
        action: result.action,
        ...(result.approval ? { approval: result.approval } : {}),
        artifacts: result.artifacts,
      };
      writeJson(response, 200, responseBody);
    } catch (error) {
      writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }
  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work action detail` });
}

async function handleExternalGitHubPoll(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub external work poll` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubPollRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }
    const workflowFile = readExternalWorkflowFile(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "github") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const githubToken = resolveExternalGitHubToken(workflowDefinition, secretResolver);
    const pollResponse: ExternalWorkPollResponse = await pollGitHubExternalWork({
      store,
      cwd,
      channelId: input.channelId,
      workflowDefinition,
      workflowDirectory: workflowFile.directory,
      githubToken,
      fetch: externalWorkFetch,
      limit: input.limit,
      executeHooks: input.executeHooks === true,
    });
    writeJson(response, 200, pollResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalLinearPoll(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for Linear external work poll` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalLinearPollRequest(body);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
      return;
    }
    const workflowFile = readExternalWorkflowFile(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "linear") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const linearToken = resolveExternalSourceToken(workflowDefinition, secretResolver, "linear_token", "Linear");
    const pollResponse: ExternalWorkPollResponse = await pollLinearExternalWork({
      store,
      cwd,
      channelId: input.channelId,
      workflowDefinition,
      workflowDirectory: workflowFile.directory,
      linearToken,
      fetch: externalWorkFetch,
      limit: input.limit,
      executeHooks: input.executeHooks === true,
    });
    writeJson(response, 200, pollResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalGitHubBackgroundStart(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerRegistry | undefined,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub external work background start` });
    return;
  }
  if (!backgroundSchedulers) {
    writeJson(response, 500, { error: "background_scheduler_unavailable", message: "External work background scheduler is unavailable." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubBackgroundStartRequest(body);
    storeRegistry.getStore(cwd);
    const result = await backgroundSchedulers.start(cwd, input);
    const responseBody: ExternalWorkBackgroundMutationResponse = {
      cwd,
      scheduler: result.scheduler,
      duplicate: result.duplicate,
      ...(result.startupReconcile ? { startupReconcile: result.startupReconcile } : {}),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkBackgroundCollection(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerRegistry | undefined,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work background schedulers` });
    return;
  }
  if (!backgroundSchedulers) {
    writeJson(response, 500, { error: "background_scheduler_unavailable", message: "External work background scheduler is unavailable." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const responseBody: ExternalWorkBackgroundListResponse = {
    cwd,
    schedulers: backgroundSchedulers.list(cwd),
  };
  writeJson(response, 200, responseBody);
}

async function handleExternalWorkBackgroundStop(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerRegistry | undefined,
  schedulerId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work background stop` });
    return;
  }
  if (!backgroundSchedulers) {
    writeJson(response, 500, { error: "background_scheduler_unavailable", message: "External work background scheduler is unavailable." });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const scheduler = backgroundSchedulers.stop(cwd, schedulerId);
  if (!scheduler) {
    writeJson(response, 404, { error: "background_scheduler_not_found", message: `External work background scheduler not found: ${schedulerId}` });
    return;
  }
  const responseBody: ExternalWorkBackgroundMutationResponse = { cwd, scheduler };
  writeJson(response, 200, responseBody);
}

async function handleExternalGitHubCiTriage(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method === "GET") {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
    const cwd = url.searchParams.get("cwd");
    if (!cwd) {
      writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
      return;
    }

    try {
      const store = storeRegistry.getStore(cwd);
      const records = store.listExternalWorkCiTriage({
        externalWorkId: url.searchParams.get("externalWorkId") ?? undefined,
        channelId: url.searchParams.get("channelId") ?? undefined,
        status: readOptionalExternalWorkCiTriageStatusQuery(url),
        limit: readOptionalIntegerQuery(url, "limit", 1),
      });
      const responseBody: ExternalWorkCiTriageListResponse = {
        cwd,
        records: records.map((record) => buildExternalWorkCiTriageView(store, record)),
      };
      writeJson(response, 200, responseBody);
    } catch (error) {
      writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
    }
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for GitHub CI triage` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalGitHubCiTriageRequest(body);
    const externalWork = store.getExternalWorkRecord(input.externalWorkId);
    if (!externalWork) {
      writeJson(response, 404, { error: "external_work_not_found", message: `External work item not found: ${input.externalWorkId}` });
      return;
    }
    const channel = store.getChannel(externalWork.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${externalWork.channelId}` });
      return;
    }
    const workflowFile = readExternalWorkflowFile(input, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "github") {
      writeJson(response, 400, { error: "unsupported_source", message: `Unsupported external source kind: ${workflowDefinition.config.source.kind}` });
      return;
    }
    const githubToken = resolveExternalGitHubToken(workflowDefinition, secretResolver);
    const triageResponse: ExternalWorkCiTriageResponse = await triageGitHubExternalWorkCi({
      store,
      cwd,
      externalWorkId: input.externalWorkId,
      workflowDefinition,
      githubToken,
      fetch: externalWorkFetch,
      limit: input.limit,
      createTask: input.createTask,
      startRun: input.startRun,
    });
    writeJson(response, 200, triageResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkCiTriageItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  triageId: string,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for CI triage detail` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const record = store.getExternalWorkCiTriage(triageId);
    if (!record) {
      writeJson(response, 404, { error: "ci_triage_not_found", message: `External work CI triage record not found: ${triageId}` });
      return;
    }
    const responseBody: ExternalWorkCiTriageDetailResponse = {
      cwd,
      record: buildExternalWorkCiTriageView(store, record),
    };
    writeJson(response, 200, responseBody);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkCiTriageRun(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  runner: RunnerAdapter,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  secretResolver: SecretResolver,
  triageId: string,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for CI triage run` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalWorkCiTriageRunRequest(body);
    const store = storeRegistry.getStore(cwd);
    const triage = store.getExternalWorkCiTriage(triageId);
    if (!triage) {
      writeJson(response, 404, { error: "ci_triage_not_found", message: `External work CI triage record not found: ${triageId}` });
      return;
    }
    if (triage.status === "stale") {
      writeJson(response, 409, { error: "ci_triage_stale", message: `CI triage target is stale: ${triageId}` });
      return;
    }
    if (!triage.taskId) {
      writeJson(response, 409, { error: "ci_triage_task_missing", message: `CI triage record has no local fix task: ${triageId}` });
      return;
    }
    const task = store.getTask(triage.taskId);
    if (!task) {
      writeJson(response, 404, { error: "task_not_found", message: `Task not found: ${triage.taskId}` });
      return;
    }
    const channel = store.getChannel(task.channelId);
    if (!channel) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${task.channelId}` });
      return;
    }

    await executeRunRequest(
      {
        workspaceCwd: cwd,
        cwd: channel.boundPath ?? cwd,
        providerPresetId: input.providerPresetId,
        skipProviderPreflight: input.skipProviderPreflight ?? false,
        idempotencyKey: input.idempotencyKey ?? `external_work_ci_triage_run:${triage.id}:${triage.taskId}:${triage.headSha}`,
        task: {
          id: task.id,
          title: task.title,
          prompt: task.prompt,
          channelId: task.channelId,
        },
        tools: input.tools ?? channel.allowedTools,
        thinkingLevel: input.thinkingLevel,
        systemPrompt: input.systemPrompt,
        appendSystemPrompt: input.appendSystemPrompt,
        agentDir: input.agentDir,
      },
      response,
      runner,
      storeRegistry,
      activeRuns,
      secretResolver,
      {
        onRunReady: (runId) => {
          store.updateExternalWorkCiTriage(triage.id, { status: "run_requested", runId }, new Date().toISOString());
        },
      },
    );
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

async function handleExternalWorkReconcile(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  externalWorkFetch?: typeof globalThis.fetch,
): Promise<void> {
  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for external work reconcile` });
    return;
  }

  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const body = await readJsonBody(request, config.maxBodyBytes);
    const input = parseExternalWorkReconcileRequest(body);
    let workflowDefinition: ExternalWorkflowDefinition | undefined;
    let githubToken: string | undefined;
    if (input.workflowPath) {
      const channel = input.channelId ? store.getChannel(input.channelId) : undefined;
      if (input.channelId && !channel) {
        writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${input.channelId}` });
        return;
      }
      const workflowFile = readExternalWorkflowFile(input, channel, cwd);
      workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
      githubToken = workflowDefinition.config.source.kind === "github"
        ? resolveExternalGitHubToken(workflowDefinition, secretResolver)
        : undefined;
    }
    const reconcileResponse: ExternalWorkReconcileResponse = await reconcileExternalWork({
      store,
      channelId: input.channelId,
      workflowDefinition,
      githubToken,
      fetch: externalWorkFetch,
    });
    writeJson(response, 200, reconcileResponse);
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function parseExternalGitHubImportRequest(value: unknown): ExternalGitHubImportRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  if (value.payload === undefined) {
    throw new Error("payload is required");
  }
  return {
    channelId: readString(value, "channelId"),
    eventType: readString(value, "eventType"),
    payload: value.payload,
    workflowMarkdown: readOptionalString(value, "workflowMarkdown"),
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

function parseExternalLinearImportRequest(value: unknown): ExternalLinearImportRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  if (value.payload === undefined) {
    throw new Error("payload is required");
  }
  return {
    channelId: readString(value, "channelId"),
    eventType: readString(value, "eventType"),
    payload: value.payload,
    workflowMarkdown: readOptionalString(value, "workflowMarkdown"),
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

function parseExternalGitHubPollRequest(value: unknown): ExternalWorkPollRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const limit = readOptionalNumber(value, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return {
    channelId: readString(value, "channelId"),
    workflowPath: readOptionalString(value, "workflowPath"),
    limit,
    executeHooks: readOptionalBoolean(value, "executeHooks"),
  };
}

function parseExternalLinearPollRequest(value: unknown): ExternalWorkPollRequest {
  return parseExternalGitHubPollRequest(value);
}

function parseExternalGitHubBackgroundStartRequest(value: unknown): ExternalWorkGitHubBackgroundStartRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const limit = readOptionalNumber(value, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 100)) {
    throw new Error("limit must be an integer between 1 and 100");
  }
  return {
    channelId: readString(value, "channelId"),
    workflowPath: readOptionalString(value, "workflowPath"),
    limit,
    executeHooks: readOptionalBoolean(value, "executeHooks"),
    runImmediately: readOptionalBoolean(value, "runImmediately"),
  };
}

function parseExternalGitHubCiTriageRequest(value: unknown): ExternalWorkCiTriageRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  const limit = readOptionalNumber(value, "limit");
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 25)) {
    throw new Error("limit must be an integer between 1 and 25");
  }
  return {
    externalWorkId: readString(value, "externalWorkId"),
    workflowPath: readOptionalString(value, "workflowPath"),
    limit,
    createTask: readOptionalBoolean(value, "createTask"),
    startRun: readOptionalBoolean(value, "startRun"),
  };
}

function parseExternalWorkCiTriageRunRequest(value: unknown): ExternalWorkCiTriageRunRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  return {
    providerPresetId: readString(value, "providerPresetId"),
    skipProviderPreflight: readOptionalBoolean(value, "skipProviderPreflight"),
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
    tools: readOptionalRunTools(value, "tools"),
    thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
  };
}

function parseExternalWorkReconcileRequest(value: unknown): ExternalWorkReconcileRequest {
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  return {
    channelId: readOptionalString(value, "channelId"),
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

function parseExternalWorkActionExecuteRequest(value: unknown): ExternalWorkActionExecuteRequest {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Request body must be an object");
  }
  return {
    workflowPath: readOptionalString(value, "workflowPath"),
  };
}

function readExternalWorkflowMarkdown(input: { readonly workflowMarkdown?: string; readonly workflowPath?: string }, channel: Channel, cwd: string): string {
  return readExternalWorkflowFile(input, channel, cwd).markdown;
}

function readExternalWorkflowFile(
  input: { readonly workflowMarkdown?: string; readonly workflowPath?: string },
  channel: Channel | undefined,
  cwd: string,
): { readonly markdown: string; readonly path?: string; readonly directory: string } {
  if (input.workflowMarkdown !== undefined) {
    const root = channel?.boundPath ?? cwd;
    return { markdown: input.workflowMarkdown, directory: root };
  }
  const root = channel?.boundPath ?? cwd;
  const workflowPath = input.workflowPath
    ? isAbsolute(input.workflowPath)
      ? input.workflowPath
      : resolvePath(root, input.workflowPath)
    : resolvePath(root, "WORKFLOW.md");
  let rootRealPath: string;
  let workflowRealPath: string;
  try {
    rootRealPath = realpathSync(root);
    workflowRealPath = realpathSync(workflowPath);
  } catch (error) {
    throw new Error(`Workflow file cannot be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPathInsideRoot(rootRealPath, workflowRealPath)) {
    throw new Error("workflowPath must resolve inside the channel bound path");
  }
  return {
    markdown: readFileSync(workflowRealPath, "utf8"),
    path: workflowRealPath,
    directory: resolvePath(workflowRealPath, ".."),
  };
}

function resolveExternalGitHubToken(workflowDefinition: ExternalWorkflowDefinition, secretResolver: SecretResolver): string | undefined {
  return resolveExternalSourceToken(workflowDefinition, secretResolver, "github_token", "GitHub");
}

function resolveExternalSourceToken(
  workflowDefinition: ExternalWorkflowDefinition,
  secretResolver: SecretResolver,
  purpose: SecretPurpose,
  label: string,
): string | undefined {
  const secretRef = workflowDefinition.config.source.secretRef;
  if (!secretRef) {
    return undefined;
  }
  const secret = secretResolver.resolve(secretRef, purpose);
  if (!secret.configured || !secret.value) {
    throw new Error(secret.status?.message ?? `${label} token is not configured: ${secretRef}`);
  }
  return secret.value;
}

function createExternalWorkEvidenceArtifacts(
  store: RunStore,
  externalWorkId: string,
  externalWorkItem: ExternalWorkItem,
  renderedPrompt: string,
  createdAt: string,
): RunArtifact[] {
  const artifactDir = resolvePath(store.paths.artifactsDir, "external-work", externalWorkId);
  mkdirSync(artifactDir, { recursive: true });
  const itemJson = `${JSON.stringify(externalWorkItem, null, 2)}\n`;
  const itemPath = resolvePath(artifactDir, "normalized-item.json");
  writeFileSync(itemPath, itemJson, "utf8");
  const promptText = `${renderedPrompt.trim()}\n`;
  const promptPath = resolvePath(artifactDir, "rendered-prompt.md");
  writeFileSync(promptPath, promptText, "utf8");

  return [
    store.createArtifact({
      externalWorkId,
      type: "json",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, itemPath)),
      title: "Normalized external work item",
      contentType: "application/json; charset=utf-8",
      sizeBytes: Buffer.byteLength(itemJson, "utf8"),
      createdAt,
    }),
    store.createArtifact({
      externalWorkId,
      type: "markdown",
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, promptPath)),
      title: "Rendered workflow prompt",
      contentType: "text/markdown; charset=utf-8",
      sizeBytes: Buffer.byteLength(promptText, "utf8"),
      createdAt,
    }),
  ];
}

function handleMediaJobItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
): void {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for media jobs` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Media job not found: ${mediaJobId}` });
      return;
    }
    writeJson(response, 200, { mediaJob: job });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleRunMediaJob(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  mediaJobId: string,
): Promise<void> {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  let store: RunStore | undefined;
  let job: MediaJob | undefined;
  let startedExecution = false;
  try {
    store = storeRegistry.getStore(cwd);
    job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Media job not found: ${mediaJobId}` });
      return;
    }
    if (!isRunnableMediaJobStatus(job.status)) {
      writeJson(response, 409, {
        error: "media_job_not_runnable",
        message: `Media job cannot be run from status ${job.status}: ${mediaJobId}`,
      });
      return;
    }

    const provider = assertMediaJobProvider(store, {
      providerPresetId: job.providerPresetId,
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
    }, secretResolver);
    const mediaSecret = provider.apiKeyRef ? resolveProviderSecret(store, provider, secretResolver) : undefined;
    const mediaSecretValues = [mediaSecret?.value];

    const approvalGate = applyMediaCostApprovalGate(store, job, provider);
    if (approvalGate.kind === "waiting_for_approval") {
      writeJson(response, 200, { mediaJob: approvalGate.mediaJob, approval: approvalGate.approval, artifacts: [] });
      return;
    }
    if (approvalGate.kind === "blocked") {
      writeJson(response, 200, { mediaJob: approvalGate.mediaJob, approval: approvalGate.approval, artifacts: [] });
      return;
    }

    job = store.updateMediaJobStatus(job.id, { status: "running", errorMessage: null }, new Date().toISOString()) ?? job;
    startedExecution = true;

    const requestedAt = new Date().toISOString();
    const execution = await executeMediaAdapterJob(createMediaAdapterForProvider(store, provider, secretResolver), {
      jobId: job.id,
      provider: {
        id: provider.id,
        kind: provider.kind,
        displayName: provider.displayName,
        providerId: provider.providerId,
        model: provider.model,
        api: provider.api,
        baseUrl: provider.baseUrl,
        apiKeyRef: provider.apiKeyRef,
        capabilities: provider.capabilities,
      },
      operation: job.operation,
      prompt: job.prompt,
      input: job.input,
      requestedAt,
    });

    if (execution.status === "failed") {
      const failed = store.updateMediaJobStatus(
        job.id,
        {
          status: "failed",
          errorMessage: execution.errorMessage ?? "Media adapter execution failed.",
        },
        new Date().toISOString(),
      ) ?? job;
      writeJson(response, 200, { mediaJob: failed, artifacts: [] });
      return;
    }

    const completedAt = new Date().toISOString();
    const artifacts = createMediaJobArtifacts(store, job, execution.artifacts, completedAt, mediaSecretValues);
    const artifactIds = [...new Set([...job.artifactIds, ...artifacts.map((artifact) => artifact.id)])];
    const succeeded = store.updateMediaJobStatus(
      job.id,
      {
        status: "succeeded",
        artifactIds,
        errorMessage: null,
      },
      completedAt,
    ) ?? job;

    writeJson(response, 200, { mediaJob: succeeded, artifacts });
  } catch (error) {
    const statusCode = error instanceof HttpError ? error.statusCode : startedExecution ? 500 : 400;
    const provider = store && job ? store.getProviderPreset(job.providerPresetId) : undefined;
    const mediaSecret = store && provider?.apiKeyRef ? resolveProviderSecret(store, provider, secretResolver) : undefined;
    const message = redactTextWithSecrets(error instanceof Error ? error.message : String(error), [mediaSecret?.value]);
    const failed = store && job && startedExecution
      ? store.updateMediaJobStatus(job.id, { status: "failed", errorMessage: message }, new Date().toISOString())
      : undefined;
    writeJson(response, statusCode, {
      error: error instanceof HttpError ? error.code : startedExecution ? "media_job_execution_failed" : "bad_request",
      message,
      ...(failed ? { mediaJob: failed } : {}),
    });
  }
}

function handleListMediaJobArtifacts(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  mediaJobId: string,
): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    const job = store.getMediaJob(mediaJobId);
    if (!job) {
      writeJson(response, 404, { error: "media_job_not_found", message: `Media job not found: ${mediaJobId}` });
      return;
    }
    writeJson(response, 200, {
      mediaJobId,
      artifacts: store.listMediaJobArtifacts(mediaJobId),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApprovalPolicy(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  if (request.method === "GET") {
    writeJson(response, 200, { cwd, policy: store.getApprovalPolicy() });
    return;
  }

  if (request.method === "PATCH") {
    try {
      const body = await readJsonBody(request, config.maxBodyBytes);
      const policy = store.updateApprovalPolicy(parseApprovalPolicyUpdateInput(body), new Date().toISOString());
      writeJson(response, 200, { cwd, policy });
    } catch (error) {
      writeJson(response, 400, {
        error: "bad_request",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval policy` });
}

function handleApprovalsCollection(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
): void {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for /approvals` });
    return;
  }

  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    expireStalePendingApprovals(store, {
      runId: url.searchParams.get("runId") ?? undefined,
      mediaJobId: url.searchParams.get("mediaJobId") ?? undefined,
      externalWorkActionId: url.searchParams.get("externalWorkActionId") ?? undefined,
    });
    writeJson(response, 200, {
      cwd,
      approvals: store.listApprovalRequests({
        status: readOptionalApprovalStatusQuery(url),
        runId: url.searchParams.get("runId") ?? undefined,
        mediaJobId: url.searchParams.get("mediaJobId") ?? undefined,
        externalWorkActionId: url.searchParams.get("externalWorkActionId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function handleApprovalItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  route: { readonly approvalId: string; readonly action?: "approve" | "deny" },
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }

  const store = storeRegistry.getStore(cwd);
  expireStaleApproval(store, route.approvalId);
  const approval = store.getApprovalRequest(route.approvalId);
  if (!approval) {
    writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
    return;
  }

  if (!route.action && request.method === "GET") {
    writeJson(response, 200, { approval });
    return;
  }

  if (!route.action) {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval requests` });
    return;
  }

  if (request.method !== "POST") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for approval decisions` });
    return;
  }

  try {
    const body = await readOptionalJsonBody(request, config.maxBodyBytes);
    const decision = { reason: isRecord(body) ? readOptionalString(body, "reason") : undefined, resolvedBy: "local-user" as const };
    const now = new Date().toISOString();
    const updated =
      route.action === "approve"
        ? store.approveApprovalRequest(route.approvalId, decision, now)
        : store.denyApprovalRequest(route.approvalId, decision, now);
    if (!updated) {
      writeJson(response, 404, { error: "approval_not_found", message: `Approval request not found: ${route.approvalId}` });
      return;
    }
    appendApprovalDecisionEvent(store, updated);
    syncExternalWorkActionForApproval(store, updated, now);
    writeJson(response, 200, { approval: updated });
  } catch (error) {
    writeJson(response, 400, {
      error: error instanceof Error && error.message.includes("not pending") ? "approval_not_pending" : "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function writeTerminalSummary(summaryPath: string, summary: RunSummary): string | undefined {
  try {
    writeRunSummary(summaryPath, summary);
    return summaryPath;
  } catch {
    return undefined;
  }
}

function handleListRuns(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, {
      error: "bad_request",
      message: "cwd query parameter is required",
    });
    return;
  }

  try {
    const limit = readOptionalIntegerQuery(url, "limit", 1);
    const status = readOptionalRunStatusQuery(url);
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      runs: store.listRuns({ limit, status }),
    });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function handleListStateTransitions(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const entityType = url.searchParams.get("entityType") ?? undefined;
  if (entityType !== undefined && !["task", "run", "approval", "media_job", "workflow", "workflow_step"].includes(entityType)) {
    writeJson(response, 400, { error: "bad_request", message: "entityType is invalid" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      transitions: store.listStateTransitionEvents({
        entityType: entityType as NonNullable<Parameters<RunStore["listStateTransitionEvents"]>[0]>["entityType"] | undefined,
        entityId: url.searchParams.get("entityId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function handleListResourceLeases(response: ServerResponse, url: URL, storeRegistry: RunStoreRegistry): void {
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  const status = url.searchParams.get("status") ?? undefined;
  if (status !== undefined && !["active", "released", "expired"].includes(status)) {
    writeJson(response, 400, { error: "bad_request", message: "status is invalid" });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    writeJson(response, 200, {
      cwd,
      leases: store.listResourceLeases({
        status: status as NonNullable<Parameters<RunStore["listResourceLeases"]>[0]>["status"] | undefined,
        ownerId: url.searchParams.get("ownerId") ?? undefined,
        limit: readOptionalIntegerQuery(url, "limit", 1),
      }),
    });
  } catch (error) {
    writeJson(response, 400, { error: "bad_request", message: error instanceof Error ? error.message : String(error) });
  }
}

function handleGetRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, run);
}

function handleGetRunEvents(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  let afterSeq: number | undefined;
  let limit: number | undefined;
  try {
    afterSeq = readOptionalIntegerQuery(url, "afterSeq", 0);
    limit = readOptionalIntegerQuery(url, "limit", 1);
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  const events = store.listEvents(runId, { afterSeq, limit });
  const lastEvent = events.at(-1);
  writeJson(response, 200, {
    runId,
    events,
    nextSeq: lastEvent ? lastEvent.seq + 1 : (afterSeq ?? 0) + 1,
  });
}

function handleListRunArtifacts(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  if (!store?.getRun(runId)) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, {
    runId,
    artifacts: store.listArtifacts(runId),
  });
}

function handleGetArtifact(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const lookup = storeRegistry.findStoreForArtifact(artifactId, url.searchParams.get("cwd") ?? undefined);
  if (!lookup) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  writeJson(response, 200, {
    artifact: lookup.artifact,
  });
}

function handleGetArtifactContent(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  artifactId: string,
): void {
  const lookup = storeRegistry.findStoreForArtifact(artifactId, url.searchParams.get("cwd") ?? undefined);
  if (!lookup) {
    writeJson(response, 404, {
      error: "artifact_not_found",
      message: "Artifact was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  let artifactPath: string;
  try {
    artifactPath = resolveArtifactContentPath(lookup.store, lookup.artifact);
  } catch (error) {
    writeJson(response, 403, {
      error: "artifact_outside_root",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const stats = statSync(artifactPath);
    if (!stats.isFile()) {
      writeJson(response, 404, {
        error: "artifact_content_not_found",
        message: `Artifact content is not a file: ${lookup.artifact.id}`,
      });
      return;
    }

    const content = readFileSync(artifactPath);
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": lookup.artifact.contentType ?? inferArtifactContentType(lookup.artifact),
      "Content-Length": String(content.byteLength),
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    writeJson(response, 404, {
      error: "artifact_content_not_found",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function createAiChannelReply(input: {
  readonly runner: RunnerAdapter;
  readonly store: RunStore;
  readonly channel: Channel;
  readonly sourceMessage: ChannelMessage;
  readonly providerPresetId?: string;
  readonly teammateId?: string;
  readonly secretResolver: SecretResolver;
}): Promise<ChannelMessage> {
  const teammateId =
    input.teammateId ??
    input.sourceMessage.mentions.find((mention) => mention.kind === "ai-teammate")?.id ??
    input.channel.defaultTeammateId ??
    "ai-teammate";
  const teammate = resolveAiTeammateReference(input.store, teammateId);
  const canonicalTeammateId = teammate?.id ?? teammateId;
  const providerPresetId = input.providerPresetId ?? teammate?.providerPresetId ?? input.channel.defaultProviderPresetId;
  const now = new Date().toISOString();

  if (teammate && teammate.status !== "active") {
    return input.store.createChannelMessage(
      {
        channelId: input.channel.id,
        threadId: input.sourceMessage.threadId ?? input.sourceMessage.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: canonicalTeammateId,
        body: `AI teammate is ${teammate.status}.`,
        status: "blocked",
        errorMessage: `Teammate status is ${teammate.status}.`,
      },
      now,
    );
  }

  if (!providerPresetId) {
    return input.store.createChannelMessage(
      {
        channelId: input.channel.id,
        threadId: input.sourceMessage.threadId ?? input.sourceMessage.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: canonicalTeammateId,
        body: "AI teammate is not configured for this channel.",
        status: "blocked",
        errorMessage: "No provider preset is selected for this channel discussion.",
      },
      now,
    );
  }

  const textDeltas: string[] = [];
  try {
    const provider = resolveProviderForRun(
      input.store,
      {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task: {
          id: input.sourceMessage.id,
          title: `Channel discussion in ${input.channel.name}`,
          prompt: formatChannelDiscussionPrompt(input.channel, input.sourceMessage),
          channelId: input.channel.id,
        },
        providerPresetId,
        tools: [],
        thinkingLevel: "medium",
        systemPrompt: [
          "You are an AI teammate inside a Ling Stack channel.",
          "Reply concisely and only to the current channel discussion.",
          "This MVP does not give you attachment contents or web page bodies. Do not claim to inspect them.",
          "Do not perform tool use or side effects.",
          "When the work is clear enough to start, include one hidden proposal block after your visible reply:",
          `Use exact teammate ids in proposal JSON. Default assigneeTeammateId and collaboration teammateId to "${canonicalTeammateId}" unless the user explicitly selected another teammate id.`,
          `<ling_task_proposal>{"title":"...","prompt":"...","assigneeTeammateId":"${canonicalTeammateId}","acceptanceCriteria":["..."],"collaborationSteps":[{"teammateId":"${canonicalTeammateId}","action":"coordinated","summary":"..."}],"requiredTools":["read"],"riskSummary":"..."}</ling_task_proposal>`,
          "Do not include a proposal block for ordinary notes, unclear work, or pure discussion.",
        ].join("\n"),
      },
      input.secretResolver,
    );

    const result = await input.runner.runTask({
      cwd: input.store.paths.cwd,
      task: {
        id: input.sourceMessage.id,
        title: `Channel discussion in ${input.channel.name}`,
        prompt: formatChannelDiscussionPrompt(input.channel, input.sourceMessage),
        channelId: input.channel.id,
      },
      provider,
      tools: [],
      thinkingLevel: "medium",
      systemPrompt: [
        "You are an AI teammate inside a Ling Stack channel.",
        "Reply concisely and only to the current channel discussion.",
        "This MVP does not give you attachment contents or web page bodies. Do not claim to inspect them.",
        "Do not perform tool use or side effects.",
        "When the work is clear enough to start, include one hidden proposal block after your visible reply:",
        `Use exact teammate ids in proposal JSON. Default assigneeTeammateId and collaboration teammateId to "${canonicalTeammateId}" unless the user explicitly selected another teammate id.`,
        `<ling_task_proposal>{"title":"...","prompt":"...","assigneeTeammateId":"${canonicalTeammateId}","acceptanceCriteria":["..."],"collaborationSteps":[{"teammateId":"${canonicalTeammateId}","action":"coordinated","summary":"..."}],"requiredTools":["read"],"riskSummary":"..."}</ling_task_proposal>`,
        "Do not include a proposal block for ordinary notes, unclear work, or pure discussion.",
      ].join("\n"),
      onEvent: (event) => {
        if (event.type === "assistant_text_delta") {
          textDeltas.push(event.text);
        }
      },
    });
    const rawReplyText = textDeltas.join("").trim() || extractAssistantText(result.messages) || "AI reply completed without text.";
    const extractedProposal = extractChannelExecutionProposal(rawReplyText, canonicalTeammateId);
    const replyText = extractedProposal?.visibleBody || rawReplyText;
    const reply = input.store.createChannelMessage(
      {
        channelId: input.channel.id,
        threadId: input.sourceMessage.threadId ?? input.sourceMessage.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: canonicalTeammateId,
        body: replyText,
      },
      new Date().toISOString(),
    );
    if (extractedProposal) {
      input.store.createChannelExecutionProposal(
        {
          channelId: input.channel.id,
          sourceMessageId: reply.id,
          proposedByTeammateId: canonicalTeammateId,
          title: extractedProposal.title,
          prompt: extractedProposal.prompt,
          assigneeTeammateId: extractedProposal.assigneeTeammateId,
          acceptanceCriteria: extractedProposal.acceptanceCriteria,
          collaborationSteps: extractedProposal.collaborationSteps,
          requiredTools: extractedProposal.requiredTools,
          riskSummary: extractedProposal.riskSummary,
        },
        new Date().toISOString(),
      );
    }
    return reply;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return input.store.createChannelMessage(
      {
        channelId: input.channel.id,
        threadId: input.sourceMessage.threadId ?? input.sourceMessage.id,
        kind: "ai_reply",
        intent: "discuss",
        authorType: "ai-teammate",
        authorId: canonicalTeammateId,
        body: `AI teammate is blocked: ${message}`,
        status: "blocked",
        errorMessage: message,
      },
      new Date().toISOString(),
    );
  }
}

function resolveAiTeammateReference(store: RunStore, teammateId: string): AiTeammate | undefined {
  return store.getAiTeammate(teammateId) ?? store.getAiTeammate(createBuiltinAiTeammateId(teammateId));
}

function extractChannelExecutionProposal(
  body: string,
  fallbackTeammateId: string,
): (Pick<CreateChannelExecutionProposalInput, "title" | "prompt" | "assigneeTeammateId" | "acceptanceCriteria" | "collaborationSteps" | "requiredTools" | "riskSummary"> & { readonly visibleBody: string }) | undefined {
  const match = /<ling_task_proposal>([\s\S]*?)<\/ling_task_proposal>/i.exec(body);
  if (!match) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(match[1] ?? "");
    if (!isRecord(parsed)) {
      return undefined;
    }
    const title = typeof parsed.title === "string" ? parsed.title.trim() : "";
    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
    if (!title || !prompt) {
      return undefined;
    }
    const assigneeTeammateId = typeof parsed.assigneeTeammateId === "string" && parsed.assigneeTeammateId.trim()
      ? parsed.assigneeTeammateId.trim()
      : fallbackTeammateId;
    const acceptanceCriteria = Array.isArray(parsed.acceptanceCriteria)
      ? parsed.acceptanceCriteria.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim())
      : [];
    const requiredTools = Array.isArray(parsed.requiredTools) ? parsed.requiredTools.filter(isRunTool) : [];
    const collaborationSteps = parseProposalCollaborationSteps(parsed.collaborationSteps, fallbackTeammateId);
    const visibleBody = body.replace(match[0], "").trim() || "我整理了一个可执行提案，确认后可以交给队友开始处理。";
    return {
      visibleBody,
      title,
      prompt,
      assigneeTeammateId,
      acceptanceCriteria,
      collaborationSteps,
      requiredTools,
      riskSummary: typeof parsed.riskSummary === "string" && parsed.riskSummary.trim() ? parsed.riskSummary.trim() : undefined,
    };
  } catch {
    return undefined;
  }
}

function parseProposalCollaborationSteps(value: unknown, fallbackTeammateId: string): ChannelExecutionProposalStep[] {
  if (!Array.isArray(value)) {
    return [{ teammateId: fallbackTeammateId, action: "coordinated", summary: "Drafted an execution proposal from the channel discussion." }];
  }
  const steps = value.flatMap((item): ChannelExecutionProposalStep[] => {
    if (!isRecord(item)) {
      return [];
    }
    const teammateId = typeof item.teammateId === "string" && item.teammateId.trim() ? item.teammateId.trim() : fallbackTeammateId;
    const action = typeof item.action === "string" && isChannelExecutionProposalStepAction(item.action) ? item.action : "consulted";
    const summary = typeof item.summary === "string" && item.summary.trim() ? item.summary.trim() : "Contributed to the execution proposal.";
    return [{ teammateId, action, summary }];
  });
  return steps.length > 0 ? steps : [{ teammateId: fallbackTeammateId, action: "coordinated", summary: "Drafted an execution proposal from the channel discussion." }];
}

function isChannelExecutionProposalStepAction(value: string): value is ChannelExecutionProposalStep["action"] {
  return value === "coordinated" || value === "consulted" || value === "reviewed" || value === "flagged_risk";
}

function isRunTool(value: unknown): value is RunTool {
  return value === "read" || value === "grep" || value === "find" || value === "ls" || value === "bash" || value === "edit" || value === "write";
}

async function createAiTeammateDirectReply(input: {
  readonly runner: RunnerAdapter;
  readonly store: RunStore;
  readonly teammate: AiTeammate;
  readonly thread: { readonly id: string };
  readonly sourceMessage: { readonly id: string; readonly body: string };
  readonly providerPresetId?: string;
  readonly secretResolver: SecretResolver;
}): Promise<ReturnType<RunStore["createTeammateDirectMessage"]>> {
  const providerPresetId = input.providerPresetId ?? input.teammate.providerPresetId;
  const now = new Date().toISOString();
  if (input.teammate.status !== "active") {
    return input.store.createTeammateDirectMessage(
      {
        threadId: input.thread.id,
        teammateId: input.teammate.id,
        authorType: "ai-teammate",
        authorId: input.teammate.id,
        body: `AI teammate is ${input.teammate.status}.`,
        status: "blocked",
        errorMessage: `Teammate status is ${input.teammate.status}.`,
      },
      now,
    );
  }

  if (!providerPresetId) {
    return input.store.createTeammateDirectMessage(
      {
        threadId: input.thread.id,
        teammateId: input.teammate.id,
        authorType: "ai-teammate",
        authorId: input.teammate.id,
        body: "AI teammate is blocked: no provider preset is selected.",
        status: "blocked",
        errorMessage: "No provider preset is selected for this teammate.",
      },
      now,
    );
  }

  const recentMessages = input.store.listTeammateDirectMessages({
    teammateId: input.teammate.id,
    threadId: input.thread.id,
    limit: 20,
  });
  const textDeltas: string[] = [];
  try {
    const task = {
      id: input.sourceMessage.id,
      title: `Private chat with ${input.teammate.displayName}`,
      prompt: formatTeammateDirectPrompt(input.teammate, recentMessages),
      channelId: "private",
    };
    const systemPrompt = [
      input.teammate.systemPrompt ?? `You are ${input.teammate.displayName}, an AI teammate inside Ling Stack.`,
      ...input.teammate.appendSystemPrompt,
      "Reply concisely to the private conversation.",
      "This private chat has no tool access and cannot mutate files, send external messages, or inspect channel files.",
      "Do not claim to see channel history, attachments, private memory, or web pages unless the user explicitly pasted that content in this chat.",
    ].join("\n");
    const provider = resolveProviderForRun(
      input.store,
      {
        cwd: input.store.paths.cwd,
        workspaceCwd: input.store.paths.cwd,
        task,
        providerPresetId,
        tools: [],
        thinkingLevel: "medium",
        systemPrompt,
      },
      input.secretResolver,
    );

    const result = await input.runner.runTask({
      cwd: input.store.paths.cwd,
      task,
      provider,
      tools: [],
      thinkingLevel: "medium",
      systemPrompt,
      onEvent: (event) => {
        if (event.type === "assistant_text_delta") {
          textDeltas.push(event.text);
        }
      },
    });
    const replyText = textDeltas.join("").trim() || extractAssistantText(result.messages) || "AI reply completed without text.";
    return input.store.createTeammateDirectMessage(
      {
        threadId: input.thread.id,
        teammateId: input.teammate.id,
        authorType: "ai-teammate",
        authorId: input.teammate.id,
        body: replyText,
      },
      new Date().toISOString(),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return input.store.createTeammateDirectMessage(
      {
        threadId: input.thread.id,
        teammateId: input.teammate.id,
        authorType: "ai-teammate",
        authorId: input.teammate.id,
        body: `AI teammate is blocked: ${message}`,
        status: "blocked",
        errorMessage: message,
      },
      new Date().toISOString(),
    );
  }
}

function formatChannelDiscussionPrompt(channel: Channel, message: ChannelMessage): string {
  const mentions = message.mentions.length > 0
    ? message.mentions.map((mention) => `@${mention.label}`).join(", ")
    : "none";
  return [
    `Channel: ${channel.name}`,
    `Mentions: ${mentions}`,
    `User message:`,
    message.body,
    "",
    "Reply as the channel AI teammate. Keep the response actionable and brief.",
  ].join("\n");
}

function formatTeammateDirectPrompt(
  teammate: AiTeammate,
  messages: readonly { readonly authorType: string; readonly body: string; readonly status: string }[],
): string {
  const history = messages
    .filter((message) => message.status === "ready")
    .slice(-20)
    .map((message) => `${message.authorType === "ai-teammate" ? teammate.displayName : "User"}: ${message.body}`)
    .join("\n");
  return [
    `Teammate: ${teammate.displayName}`,
    `Role: ${teammate.roleKey}`,
    `Description: ${teammate.description}`,
    "",
    "Private conversation:",
    history || "No prior messages.",
    "",
    "Reply to the latest user message.",
  ].join("\n");
}

function buildTeammateActivityItems(
  store: RunStore,
  teammateId: string,
  limit: number,
): Array<{
  readonly id: string;
  readonly kind: "direct-message" | "task" | "run" | "approval" | "channel-message";
  readonly title: string;
  readonly subtitle?: string;
  readonly status?: string;
  readonly createdAt: string;
  readonly sourceId: string;
}> {
  const items: Array<{
    readonly id: string;
    readonly kind: "direct-message" | "task" | "run" | "approval" | "channel-message";
    readonly title: string;
    readonly subtitle?: string;
    readonly status?: string;
    readonly createdAt: string;
    readonly sourceId: string;
  }> = [];

  const thread = store.getOrCreateTeammateDirectThread(teammateId, new Date().toISOString());
  for (const message of store.listTeammateDirectMessages({ teammateId, threadId: thread.id, limit })) {
    items.push({
      id: `direct-message:${message.id}`,
      kind: "direct-message",
      title: message.authorType === "ai-teammate" ? "AI teammate replied" : "Private message",
      subtitle: previewText(message.body),
      status: message.status,
      createdAt: message.createdAt,
      sourceId: message.id,
    });
  }

  for (const task of store.listTasks({ assigneeTeammateId: teammateId, limit })) {
    items.push({
      id: `task:${task.id}`,
      kind: "task",
      title: task.title,
      subtitle: previewText(task.prompt),
      status: task.status,
      createdAt: task.createdAt,
      sourceId: task.id,
    });
  }

  for (const run of store.listRuns({ teammateId, limit })) {
    items.push({
      id: `run:${run.id}`,
      kind: "run",
      title: run.taskSnapshot && isRecord(run.taskSnapshot) && typeof run.taskSnapshot.title === "string"
        ? run.taskSnapshot.title
        : run.taskId,
      subtitle: run.providerModel,
      status: run.status,
      createdAt: run.createdAt,
      sourceId: run.id,
    });
  }

  const teammateRunIds = new Set(store.listRuns({ teammateId, limit: 200 }).map((run) => run.id));
  for (const approval of store.listApprovalRequests({ status: "pending", limit: 200 })) {
    if (approval.runId && teammateRunIds.has(approval.runId)) {
      items.push({
        id: `approval:${approval.id}`,
        kind: "approval",
        title: approval.title,
        subtitle: approval.description,
        status: approval.status,
        createdAt: approval.createdAt,
        sourceId: approval.id,
      });
    }
  }

  for (const channel of store.listChannels({ limit: 200 })) {
    for (const message of store.listChannelMessages({ channelId: channel.id, limit: 200 })) {
      if (message.mentions.some((mention) => mention.kind === "ai-teammate" && mention.id === teammateId)) {
        items.push({
          id: `channel-message:${message.id}`,
          kind: "channel-message",
          title: `Mentioned in #${channel.name}`,
          subtitle: previewText(message.body),
          status: message.status,
          createdAt: message.createdAt,
          sourceId: message.id,
        });
      }
    }
  }

  return items
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
    .slice(0, Math.min(Math.max(limit, 1), 200));
}

function previewText(value: string, maxLength = 140): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 1)}...`;
}

function extractAssistantText(messages: readonly unknown[]): string | undefined {
  for (const message of [...messages].reverse()) {
    const text = extractTextFromUnknown(message);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function extractTextFromUnknown(value: unknown): string | undefined {
  if (typeof value === "string") {
    return value.trim() || undefined;
  }
  if (Array.isArray(value)) {
    return value.map(extractTextFromUnknown).filter(Boolean).join("").trim() || undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  for (const key of ["text", "content", "message"]) {
    const text = extractTextFromUnknown(value[key]);
    if (text) {
      return text;
    }
  }
  return undefined;
}

function validateChannelMessageReferences(
  store: RunStore,
  channelId: string,
  attachmentIds: readonly string[],
  linkPreviewIds: readonly string[],
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  for (const attachmentId of attachmentIds) {
    const attachment = store.getChannelAttachment(attachmentId);
    if (!attachment) {
      return {
        statusCode: 404,
        code: "attachment_not_found",
        message: `Channel attachment not found: ${attachmentId}`,
      };
    }
    if (attachment.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "attachment_channel_mismatch",
        message: `Attachment does not belong to channel: ${attachmentId}`,
      };
    }
  }

  for (const linkPreviewId of linkPreviewIds) {
    const linkPreview = store.getChannelLinkPreview(linkPreviewId);
    if (!linkPreview) {
      return {
        statusCode: 404,
        code: "link_preview_not_found",
        message: `Channel link preview not found: ${linkPreviewId}`,
      };
    }
    if (linkPreview.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "link_preview_channel_mismatch",
        message: `Link preview does not belong to channel: ${linkPreviewId}`,
      };
    }
  }

  return undefined;
}

function validateChannelMessageOwner(
  store: RunStore,
  channelId: string,
  messageId: string,
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  const message = store.getChannelMessage(messageId);
  if (!message) {
    return {
      statusCode: 404,
      code: "message_not_found",
      message: `Channel message not found: ${messageId}`,
    };
  }
  if (message.channelId !== channelId) {
    return {
      statusCode: 400,
      code: "message_channel_mismatch",
      message: `Message does not belong to channel: ${messageId}`,
    };
  }
  return undefined;
}

function validateChannelBriefReferences(
  store: RunStore,
  channelId: string,
  input: Pick<ChannelBriefRequest, "decisionIds" | "attachmentIds" | "linkPreviewIds">,
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  for (const decisionId of input.decisionIds) {
    const error = validateChannelDecisionOwner(store, channelId, decisionId);
    if (error) {
      return error;
    }
  }
  const assetError = validateChannelMessageReferences(store, channelId, input.attachmentIds, input.linkPreviewIds);
  return assetError?.statusCode === 404 ? { ...assetError, statusCode: 400 } : assetError;
}

function validateProtocolSourceReferences(
  store: RunStore,
  channelId: string,
  input: { readonly sourceMessageId?: string; readonly sourceTaskId?: string; readonly sourceRunId?: string },
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  if (input.sourceMessageId) {
    const messageError = validateChannelMessageOwner(store, channelId, input.sourceMessageId);
    if (messageError) {
      return messageError.statusCode === 404 ? { ...messageError, statusCode: 400 } : messageError;
    }
  }
  if (input.sourceTaskId) {
    const task = store.getTask(input.sourceTaskId);
    if (!task) {
      return { statusCode: 400, code: "task_not_found", message: `Task not found: ${input.sourceTaskId}` };
    }
    if (task.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "task_channel_mismatch",
        message: `Task does not belong to channel: ${input.sourceTaskId}`,
      };
    }
  }
  if (input.sourceRunId) {
    const run = store.getRun(input.sourceRunId);
    if (!run) {
      return { statusCode: 400, code: "run_not_found", message: `Run session not found: ${input.sourceRunId}` };
    }
    if (run.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "run_channel_mismatch",
        message: `Run does not belong to channel: ${input.sourceRunId}`,
      };
    }
  }
  return undefined;
}

function validateChannelDecisionOwner(
  store: RunStore,
  channelId: string,
  decisionId: string,
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  const decision = store.getChannelDecision(decisionId);
  if (!decision) {
    return { statusCode: 400, code: "decision_not_found", message: `Channel decision not found: ${decisionId}` };
  }
  if (decision.channelId !== channelId) {
    return {
      statusCode: 400,
      code: "decision_channel_mismatch",
      message: `Decision does not belong to channel: ${decisionId}`,
    };
  }
  return undefined;
}

function validateChannelContextSummaryReferences(
  store: RunStore,
  channelId: string,
  input: Pick<ChannelContextSummaryRequest, "targetType" | "targetId" | "sourceMessageIds" | "decisionIds">,
): { readonly statusCode: number; readonly code: string; readonly message: string } | undefined {
  if (input.targetType === "task") {
    const target = store.getTask(input.targetId);
    if (!target) {
      return { statusCode: 400, code: "summary_target_not_found", message: `Task not found: ${input.targetId}` };
    }
    if (target.channelId !== channelId) {
      return {
        statusCode: 400,
        code: "summary_target_channel_mismatch",
        message: `Summary target does not belong to channel: ${input.targetId}`,
      };
    }
  } else if (!isThreadTargetInChannel(store, channelId, input.targetId)) {
    return { statusCode: 400, code: "summary_target_not_found", message: `Channel thread not found: ${input.targetId}` };
  }

  for (const messageId of input.sourceMessageIds) {
    const messageError = validateChannelMessageOwner(store, channelId, messageId);
    if (messageError) {
      return messageError.statusCode === 404 ? { ...messageError, statusCode: 400 } : messageError;
    }
  }
  for (const decisionId of input.decisionIds) {
    const decisionError = validateChannelDecisionOwner(store, channelId, decisionId);
    if (decisionError) {
      return decisionError;
    }
  }
  return undefined;
}

function isThreadTargetInChannel(store: RunStore, channelId: string, targetId: string): boolean {
  const directMessage = store.getChannelMessage(targetId);
  if (directMessage) {
    return directMessage.channelId === channelId;
  }
  return store.listChannelMessages({ channelId, threadId: targetId, limit: 1 }).length > 0;
}

function createEmptyChannelBrief(channel: Channel): ChannelBrief {
  return {
    id: `brief_${channel.id}`,
    workspaceId: channel.workspaceId,
    channelId: channel.id,
    objective: "",
    scope: "",
    acceptanceCriteria: [],
    openQuestions: [],
    risks: [],
    decisionIds: [],
    attachmentIds: [],
    linkPreviewIds: [],
    updatedBy: "system",
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  };
}

function persistChannelAttachment(store: RunStore, channelId: string, input: ChannelAttachmentRequest): ChannelAttachment {
  const safeFileName = sanitizeAttachmentFileName(input.fileName);
  const inferred = inferChannelAttachmentKind(safeFileName, input.contentType);
  const content = Buffer.from(input.contentBase64, "base64");
  if (content.byteLength === 0) {
    throw new Error("Attachment content is empty");
  }
  if (content.byteLength > CHANNEL_ATTACHMENT_MAX_BYTES) {
    throw new Error(`Attachment exceeds ${CHANNEL_ATTACHMENT_MAX_BYTES} bytes`);
  }

  const now = new Date().toISOString();
  const storageName = `${formatTimestampSlug(now)}-${safeFileName}`;
  const relativePath = normalizeArtifactPath(join(channelId, storageName));
  const absoluteDir = resolvePath(store.paths.attachmentsDir, channelId);
  const absolutePath = resolvePath(store.paths.attachmentsDir, relativePath);
  if (!isPathInsideRoot(store.paths.attachmentsDir, absolutePath)) {
    throw new Error("Attachment content path is outside .ling-stack/attachments");
  }
  mkdirSync(absoluteDir, { recursive: true });
  writeFileSync(absolutePath, content);

  return store.createChannelAttachment({
    channelId,
    messageId: input.messageId,
    kind: inferred.kind,
    fileName: safeFileName,
    contentType: inferred.contentType,
    sizeBytes: content.byteLength,
    path: relativePath,
    createdAt: now,
  });
}

function sanitizeAttachmentFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (trimmed !== basename(trimmed) || trimmed.includes("\\") || trimmed.includes("/")) {
    throw new Error("fileName must not contain path separators");
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._ -]+/g, "_").replace(/^\.+/, "").trim();
  if (!safe) {
    throw new Error("fileName must contain a safe filename");
  }
  inferChannelAttachmentKind(safe);
  return safe.slice(0, 160);
}

function inferChannelAttachmentKind(fileName: string, _contentType?: string): { readonly kind: ChannelAttachmentKind; readonly contentType: string } {
  const extension = extname(fileName).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
    return { kind: "image", contentType: imageContentTypeForExtension(extension) };
  }
  if (extension === ".pdf") {
    return { kind: "pdf", contentType: "application/pdf" };
  }
  if ([".docx", ".xlsx", ".pptx"].includes(extension)) {
    return { kind: "office", contentType: officeContentTypeForExtension(extension) };
  }
  if ([".txt", ".md", ".csv", ".json", ".log"].includes(extension)) {
    return { kind: "text", contentType: textContentTypeForExtension(extension) };
  }
  throw new Error("Unsupported attachment type. Allowed: png, jpg, jpeg, webp, gif, pdf, docx, xlsx, pptx, txt, md, csv, json, log");
}

function imageContentTypeForExtension(extension: string): string {
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  return "image/png";
}

function officeContentTypeForExtension(extension: string): string {
  if (extension === ".docx") {
    return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  }
  if (extension === ".xlsx") {
    return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  }
  return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
}

function textContentTypeForExtension(extension: string): string {
  if (extension === ".md") {
    return "text/markdown; charset=utf-8";
  }
  if (extension === ".csv") {
    return "text/csv; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

function handleGetChannelAttachmentContent(response: ServerResponse, store: RunStore, attachment: ChannelAttachment): void {
  let contentPath: string;
  try {
    contentPath = resolveChannelAttachmentContentPath(store, attachment);
  } catch (error) {
    writeJson(response, 403, {
      error: "attachment_outside_root",
      message: error instanceof Error ? error.message : String(error),
    });
    return;
  }

  try {
    const stats = statSync(contentPath);
    if (!stats.isFile()) {
      writeJson(response, 404, {
        error: "attachment_content_not_found",
        message: `Attachment content is not a file: ${attachment.id}`,
      });
      return;
    }
    const content = readFileSync(contentPath);
    setCorsHeaders(response);
    response.writeHead(200, {
      "Content-Type": attachment.contentType,
      "Content-Length": String(content.byteLength),
      "Content-Disposition": `inline; filename="${attachment.fileName.replace(/"/g, "")}"`,
      "X-Content-Type-Options": "nosniff",
    });
    response.end(content);
  } catch (error) {
    writeJson(response, 404, {
      error: "attachment_content_not_found",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function deleteChannelAttachmentContent(store: RunStore, attachment: ChannelAttachment): void {
  try {
    unlinkSync(resolveChannelAttachmentContentPath(store, attachment));
  } catch {
    // Missing files should not block metadata cleanup.
  }
}

function resolveChannelAttachmentContentPath(store: RunStore, attachment: ChannelAttachment): string {
  const absolutePath = isAbsolute(attachment.path)
    ? attachment.path
    : resolvePath(store.paths.attachmentsDir, attachment.path);
  if (!isPathInsideRoot(store.paths.attachmentsDir, absolutePath)) {
    throw new Error(`Attachment content path is outside .ling-stack/attachments: ${attachment.path}`);
  }
  return absolutePath;
}

async function createOrFetchChannelLinkPreview(
  store: RunStore,
  channelId: string,
  input: ChannelLinkPreviewRequest,
): Promise<ChannelLinkPreview> {
  const normalizedUrl = normalizePreviewUrl(input.url);
  const existing = store
    .listChannelLinkPreviews({ channelId, limit: 500 })
    .find((preview) => preview.normalizedUrl === normalizedUrl);
  if (existing) {
    return existing;
  }

  const metadata = await fetchLinkPreviewMetadata(normalizedUrl);
  return store.createChannelLinkPreview(
    {
      channelId,
      messageId: input.messageId,
      url: input.url,
      normalizedUrl,
      title: metadata.title ?? undefined,
      description: metadata.description ?? undefined,
      imageUrl: metadata.imageUrl ?? undefined,
      siteName: metadata.siteName ?? undefined,
      status: metadata.status,
      errorMessage: metadata.errorMessage ?? undefined,
    },
    new Date().toISOString(),
  );
}

async function fetchLinkPreviewMetadata(url: string): Promise<{
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly siteName?: string | null;
  readonly status: ChannelLinkPreview["status"];
  readonly errorMessage?: string | null;
}> {
  try {
    const final = await fetchPreviewHtml(url);
    return {
      ...parseLinkPreviewHtml(final.url, final.html),
      status: "ready",
      errorMessage: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: isBlockedPreviewError(error) ? "blocked" : "failed",
      errorMessage: message,
      title: null,
      description: null,
      imageUrl: null,
      siteName: null,
    };
  }
}

async function fetchPreviewHtml(initialUrl: string): Promise<{ readonly url: string; readonly html: string }> {
  let currentUrl = normalizePreviewUrl(initialUrl);
  for (let redirectCount = 0; redirectCount <= CHANNEL_LINK_PREVIEW_MAX_REDIRECTS; redirectCount += 1) {
    await assertPreviewUrlAllowed(currentUrl);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CHANNEL_LINK_PREVIEW_TIMEOUT_MS);
    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Accept: "text/html,application/xhtml+xml",
          "User-Agent": "LingStackLinkPreview/0.1",
        },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location) {
          throw new Error("Redirect response is missing Location");
        }
        currentUrl = normalizePreviewUrl(new URL(location, currentUrl).toString());
        continue;
      }
      if (!response.ok) {
        throw new Error(`Preview fetch failed with HTTP ${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (contentType && !contentType.toLowerCase().includes("text/html")) {
        throw new Error(`Preview content type is not HTML: ${contentType}`);
      }
      const reader = response.body?.getReader();
      if (!reader) {
        return { url: currentUrl, html: await response.text() };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      while (true) {
        const result = await reader.read();
        if (result.done) {
          break;
        }
        total += result.value.byteLength;
        if (total > CHANNEL_LINK_PREVIEW_MAX_BYTES) {
          throw new Error(`Preview HTML exceeds ${CHANNEL_LINK_PREVIEW_MAX_BYTES} bytes`);
        }
        chunks.push(result.value);
      }
      return { url: currentUrl, html: Buffer.concat(chunks).toString("utf8") };
    } finally {
      clearTimeout(timeout);
    }
  }
  throw new Error("Preview exceeded redirect limit");
}

function parseLinkPreviewHtml(url: string, html: string): {
  readonly title?: string | null;
  readonly description?: string | null;
  readonly imageUrl?: string | null;
  readonly siteName?: string | null;
} {
  const title = readMeta(html, "og:title") ?? readTitle(html);
  const description = readMeta(html, "og:description") ?? readMeta(html, "description");
  const image = readMeta(html, "og:image");
  const siteName = readMeta(html, "og:site_name") ?? new URL(url).hostname;
  return {
    title,
    description,
    imageUrl: image ? new URL(image, url).toString() : null,
    siteName,
  };
}

function readMeta(html: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta\\s+[^>]*(?:property|name)=["']${escaped}["'][^>]*content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta\\s+[^>]*content=["']([^"']+)["'][^>]*(?:property|name)=["']${escaped}["'][^>]*>`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]).slice(0, 300);
    }
  }
  return undefined;
}

function readTitle(html: string): string | undefined {
  const match = /<title[^>]*>([^<]+)<\/title>/i.exec(html);
  return match?.[1] ? decodeHtmlEntities(match[1]).slice(0, 300) : undefined;
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .trim();
}

function normalizePreviewUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl.trim());
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only http and https links can be previewed");
  }
  parsed.username = "";
  parsed.password = "";
  parsed.hash = "";
  return parsed.toString();
}

async function assertPreviewUrlAllowed(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost")) {
    throw new PreviewBlockedError("Link preview blocks localhost hosts");
  }
  const addresses = await lookup(parsed.hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new Error(`Unable to resolve host: ${parsed.hostname}`);
  }
  for (const address of addresses) {
    if (isBlockedPreviewAddress(address.address)) {
      throw new PreviewBlockedError(`Link preview blocks private or local address: ${address.address}`);
    }
  }
}

function isBlockedPreviewAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = address.split(".").map(Number);
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }
  if (family === 6) {
    const lower = address.toLowerCase();
    return lower === "::1" || lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:");
  }
  return true;
}

function isBlockedPreviewError(error: unknown): boolean {
  return error instanceof PreviewBlockedError;
}

class PreviewBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PreviewBlockedError";
  }
}

function handleCancelRun(
  response: ServerResponse,
  url: URL,
  storeRegistry: RunStoreRegistry,
  activeRuns: ActiveRunRegistry,
  runId: string,
): void {
  const store = storeRegistry.findStoreForRun(runId, url.searchParams.get("cwd") ?? undefined);
  const run = store?.getRun(runId);
  if (!store || !run) {
    writeJson(response, 404, {
      error: "run_not_found",
      message: "Run was not found in the active daemon stores. Pass ?cwd=/path/to/project after a daemon restart.",
    });
    return;
  }

  if (run.status === "cancelled") {
    writeJson(response, 200, { cancelled: true, active: false, run });
    return;
  }

  if (isTerminalRunStatus(run.status)) {
    writeJson(response, 409, {
      error: "run_not_cancellable",
      message: `Run ${runId} is already ${run.status}.`,
      run,
    });
    return;
  }

  const activeRun = activeRuns.get(runId);
  const cancelled = ensureRunCancelled({
    store,
    runId,
    taskId: run.taskId,
    startedAt: run.startedAt,
    reason: "user_requested",
    active: Boolean(activeRun),
    streamEnvelope: activeRun?.streamEnvelope,
  });
  activeRun?.abortController.abort();

  writeJson(response, 200, {
    cancelled: true,
    active: Boolean(activeRun),
    run: store.getRun(runId),
    event: cancelled.event,
  });
}

function ensureRunCancelled(input: {
  readonly store: RunStore;
  readonly runId: string;
  readonly taskId: string;
  readonly startedAt?: string;
  readonly reason: string;
  readonly active: boolean;
  readonly streamEnvelope?: (envelope: RunEventEnvelope) => void;
}): { readonly event?: RunEventEnvelope } {
  const current = input.store.getRun(input.runId);
  if (!current || current.status === "cancelled") {
    return {};
  }
  if (isTerminalRunStatus(current.status)) {
    return {};
  }

  const endedAt = new Date().toISOString();
  const event = input.store.appendEvent(input.runId, "run_cancelled", {
    reason: input.reason,
    active: input.active,
  });
  input.streamEnvelope?.(event);
  const summaryPath = writeTerminalSummary(getRunSummaryPath(input.store.paths, input.runId), {
    runId: input.runId,
    status: "cancelled",
    taskId: input.taskId,
    eventCount: event.seq,
    startedAt: input.startedAt,
    endedAt,
    errorMessage: null,
  });
  input.store.transitionRunStatus({
    runId: input.runId,
    expectedStatus: current.status,
    event: "cancel",
    actor: "local-user",
    reason: input.reason,
    now: endedAt,
    endedAt,
    summaryPath,
    errorMessage: null,
  });
  const task = input.store.getTask(input.taskId);
  if (task && task.status !== "done" && task.status !== "cancelled") {
    input.store.transitionTaskStatus({
      taskId: input.taskId,
      expectedStatus: task.status,
      event: "cancel",
      actor: "local-user",
      reason: input.reason,
      now: endedAt,
      currentRunId: input.runId,
    });
  }
  input.store.releaseResourceLeasesForOwner("run", input.runId, endedAt);
  return { event };
}

function isTerminalRunStatus(status: RunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function updateLinkedTaskForRun(store: RunStore, taskId: string, input: TaskUpdateInput): void {
  if (!store.getTask(taskId)) {
    return;
  }
  store.updateTask(taskId, input, new Date().toISOString());
}

function appendFailureEvent(
  store: RunStore,
  runId: string,
  message: string,
  clientClosed: boolean,
  response: ServerResponse,
): RunEventEnvelope | undefined {
  try {
    const envelope = store.appendEvent(runId, "run_error", { message });
    if (!clientClosed) {
      writeSse(response, envelope.type, envelope);
    }
    return envelope;
  } catch {
    return undefined;
  }
}

function resolveProviderForRun(store: RunStore, runRequest: RunRequest, secretResolver: SecretResolver): PiRunnerProviderConfig {
  if (runRequest.providerPresetId && runRequest.provider) {
    throw new HttpError(400, "bad_request", "providerPresetId and inline provider cannot both be supplied");
  }

  if (runRequest.providerPresetId) {
    const preset = store.getProviderPreset(runRequest.providerPresetId);
    if (!preset) {
      throw new HttpError(404, "provider_not_found", `Provider preset not found: ${runRequest.providerPresetId}`);
    }
    if (!preset.enabled) {
      throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
    }
    if (preset.api === "media-job") {
      throw new HttpError(400, "unsupported_capability", "Media provider presets cannot run pi coding tasks");
    }
    if (!preset.capabilities.includes("chat")) {
      throw new HttpError(400, "unsupported_capability", "Provider preset must include chat capability for coding runs");
    }
    assertProviderRunPreflight(store, preset, runRequest.skipProviderPreflight === true, secretResolver);
    const secret: ResolvedSecret = preset.apiKeyRef ? resolveProviderSecret(store, preset, secretResolver) : { configured: false };
    return removeUndefined({
      provider: preset.providerId,
      model: preset.model,
      displayName: preset.displayName,
      apiKey: secret.value,
      baseUrl: preset.baseUrl,
      api: preset.api as PiRunnerProviderConfig["api"],
      headers: preset.headers,
      authHeader: preset.authHeader,
      reasoning: preset.reasoning,
      input: preset.input,
      contextWindow: preset.contextWindow,
      maxTokens: preset.maxTokens,
      compat: preset.compat,
    }) as PiRunnerProviderConfig;
  }

  if (!runRequest.provider) {
    throw new HttpError(400, "bad_request", "Either providerPresetId or provider is required");
  }

  return runRequest.provider;
}

function assertProviderRunPreflight(store: RunStore, preset: ProviderPreset, skipProviderPreflight: boolean, secretResolver: SecretResolver): void {
  if (skipProviderPreflight) {
    return;
  }

  const secretBlocker = providerSecretPreflightBlocker(store, preset, secretResolver);
  if (secretBlocker) {
    throw new HttpError(400, "provider_preflight_failed", `${preset.displayName}: ${secretBlocker}`);
  }

  if (!preset.lastCheck) {
    throw new HttpError(400, "provider_preflight_failed", `${preset.displayName}: provider has not been checked. Run provider check before starting.`);
  }
  if (!preset.lastCheck.ok) {
    throw new HttpError(
      400,
      "provider_preflight_failed",
      `${preset.displayName}: provider check failed (${preset.lastCheck.code ?? "failed"}). ${preset.lastCheck.message}`.trim(),
    );
  }
}

function providerSecretPreflightBlocker(store: RunStore, preset: ProviderPreset, secretResolver: SecretResolver): string | undefined {
  const needsSecret = preset.api !== "media-job" && (preset.api === "anthropic-messages" || preset.authHeader !== false);
  if (needsSecret && !preset.apiKeyRef) {
    return "API key missing.";
  }
  if (preset.apiKeyRef) {
    const status = providerSecretStatus(store, preset, secretResolver);
    if (!status.configured) {
      return `${status.message ?? "API key missing."}`;
    }
  }
  return undefined;
}

function appendApprovalDecisionEvent(store: RunStore, approval: ApprovalRequest): void {
  if (!approval.runId) {
    return;
  }
  const run = store.getRun(approval.runId);
  if (!run) {
    return;
  }
  store.appendEvent(approval.runId, approvalDecisionEventType(approval), {
    approvalId: approval.id,
    status: approval.status,
    resolvedBy: approval.resolvedBy,
    decisionReason: approval.decisionReason,
  });
}

function approvalDecisionEventType(approval: ApprovalRequest): Extract<RunEventType, "approval_approved" | "approval_denied" | "approval_expired"> {
  if (approval.status === "approved") {
    return "approval_approved";
  }
  if (approval.status === "expired") {
    return "approval_expired";
  }
  return "approval_denied";
}

function expireStalePendingApprovals(
  store: RunStore,
  options: { readonly runId?: string; readonly mediaJobId?: string; readonly externalWorkActionId?: string } = {},
): void {
  const now = new Date().toISOString();
  let safety = 0;
  for (;;) {
    const pending = store.listApprovalRequests({
      status: "pending",
      runId: options.runId,
      mediaJobId: options.mediaJobId,
      externalWorkActionId: options.externalWorkActionId,
      limit: 500,
    });
    const expired = pending.filter((approval) => approval.expiresAt && approval.expiresAt <= now);
    if (expired.length === 0) {
      return;
    }
    for (const approval of expired) {
      expireApproval(store, approval, now);
    }
    safety += 1;
    if (pending.length < 500 || safety > 20) {
      return;
    }
  }
}

function expireStaleApproval(store: RunStore, approvalId: string): void {
  const approval = store.getApprovalRequest(approvalId);
  const now = new Date().toISOString();
  if (!approval || approval.status !== "pending" || !approval.expiresAt || approval.expiresAt > now) {
    return;
  }
  expireApproval(store, approval, now);
}

function expireApproval(store: RunStore, approval: ApprovalRequest, now: string): ApprovalRequest | undefined {
  const expired = store.expireApprovalRequest(
    approval.id,
    { reason: "Approval request expired before a decision was received." },
    now,
  );
  if (expired) {
    appendApprovalDecisionEvent(store, expired);
    syncExternalWorkActionForApproval(store, expired, now);
  }
  return expired;
}

function createRunApprovalHandler(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly approvalPolicy: ApprovalPolicy;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
  readonly signal?: AbortSignal;
}): PiRunnerRunOptions["onApprovalRequired"] {
  return async (request: PiRunnerApprovalRequest) => {
    const approvalInput = toCreateApprovalRequestInput(options.run, request);
    const policyDecision = evaluateApprovalPolicy(options.approvalPolicy, request, approvalInput.payload);
    if (policyDecision.decision === "allow") {
      return {
        approved: true,
        reason: policyDecision.reason,
      };
    }

    if (policyDecision.decision === "deny") {
      const denied = options.store.createApprovalRequest(approvalInput, new Date().toISOString());
      const resolved = options.store.denyApprovalRequest(
        denied.id,
        { reason: policyDecision.reason },
        new Date().toISOString(),
      );
      if (!resolved) {
        throw new Error(`Approval request not found after policy denial: ${denied.id}`);
      }
      const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(resolved));
      streamOrAppendApprovalDecisionEvent({
        store: options.store,
        approval: resolved,
        afterSeq: requestEvent?.seq ?? 0,
        appendAndMaybeStream: options.appendAndMaybeStream,
        streamEnvelope: options.streamEnvelope,
      });
      return {
        approved: false,
        approvalId: resolved.id,
        reason: resolved.decisionReason,
      };
    }

    const approval = options.store.createApprovalRequest(approvalInput, new Date().toISOString());
    const waitingAt = new Date().toISOString();
    options.store.transitionRunStatus({
      runId: options.run.id,
      expectedStatus: "running",
      event: "approval_requested",
      actor: "system",
      now: waitingAt,
    });
    const requestEvent = options.appendAndMaybeStream("approval_requested", approvalRequestEventPayload(approval));

    const resolvedApproval = await waitForApprovalDecision(options.store, approval.id, options.signal);
    const resolvedAt = new Date().toISOString();
    if (resolvedApproval.status === "approved") {
      options.store.transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_approved",
        actor: "local-user",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
      });
    } else if (resolvedApproval.status === "expired") {
      options.store.transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_expired",
        actor: "system",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
        endedAt: resolvedAt,
        errorMessage: resolvedApproval.decisionReason ?? "Approval expired.",
      });
    } else {
      options.store.transitionRunStatus({
        runId: options.run.id,
        expectedStatus: "waiting_for_approval",
        event: "approval_denied",
        actor: "local-user",
        reason: resolvedApproval.decisionReason,
        now: resolvedAt,
        endedAt: resolvedAt,
        errorMessage: resolvedApproval.decisionReason ?? "Approval denied.",
      });
    }
    streamOrAppendApprovalDecisionEvent({
      store: options.store,
      approval: resolvedApproval,
      afterSeq: requestEvent?.seq ?? 0,
      appendAndMaybeStream: options.appendAndMaybeStream,
      streamEnvelope: options.streamEnvelope,
    });

    if (resolvedApproval.status === "approved") {
      return {
        approved: true,
        approvalId: resolvedApproval.id,
        reason: resolvedApproval.decisionReason,
      };
    }

    return {
      approved: false,
      approvalId: resolvedApproval.id,
      reason:
        resolvedApproval.decisionReason ??
        `Ling Stack approval ${resolvedApproval.status} for ${resolvedApproval.actionType}.`,
    };
  };
}

function approvalRequestEventPayload(approval: ApprovalRequest): Record<string, unknown> {
  return {
    approvalId: approval.id,
    toolCallId: approval.toolCallId,
    actionType: approval.actionType,
    risk: approval.risk,
    title: approval.title,
    description: approval.description,
    payload: approval.payload,
    expiresAt: approval.expiresAt,
  };
}

function evaluateApprovalPolicy(
  policy: ApprovalPolicy,
  request: PiRunnerApprovalRequest,
  payload: ApprovalPayload,
): { readonly decision: ApprovalToolDecision; readonly reason: string } {
  const toolDecision = policy.toolDecisions[request.toolName] ?? defaultApprovalToolDecisions[request.toolName];
  if (toolDecision === "deny") {
    return {
      decision: "deny",
      reason: `Ling Stack policy denied ${request.toolName}.`,
    };
  }

  if ((payload.type === "file_write" || payload.type === "file_edit") && !isPathWithinAllowedWritePaths(payload.path, request.cwd, policy.allowedWritePaths)) {
    return {
      decision: "deny",
      reason: `Ling Stack policy denied ${request.toolName}: ${payload.path} is outside allowed write paths.`,
    };
  }

  if (toolDecision === "allow") {
    return {
      decision: "allow",
      reason: `Ling Stack policy allowed ${request.toolName}.`,
    };
  }

  return {
    decision: "ask",
    reason: `Ling Stack policy requires approval for ${request.toolName}.`,
  };
}

function mergeApprovalPolicyWithProfile(policy: ApprovalPolicy, profile: SkillApprovalProfile | undefined): ApprovalPolicy {
  if (!profile || profile.mode === "none") {
    return policy;
  }

  const requiredTools = new Set<RunTool>();
  for (const tool of profile.requiredForTools ?? []) {
    requiredTools.add(tool);
  }
  for (const action of profile.requiredForActions ?? []) {
    if (isRunTool(action)) {
      requiredTools.add(action);
    }
  }
  if (profile.mode === "strict") {
    for (const tool of riskyRunTools) {
      requiredTools.add(tool);
    }
  }
  if (requiredTools.size === 0) {
    return policy;
  }

  const toolDecisions = { ...policy.toolDecisions };
  for (const tool of requiredTools) {
    if (toolDecisions[tool] !== "deny") {
      toolDecisions[tool] = "ask";
    }
  }
  return { ...policy, toolDecisions };
}

function toCreateApprovalRequestInput(run: RunSession, request: PiRunnerApprovalRequest): CreateApprovalRequestInput {
  const payload = toApprovalPayload(request);
  const risk = classifyApprovalRisk(request, payload);
  return {
    runId: run.id,
    taskId: run.taskId,
    channelId: run.channelId,
    toolCallId: request.toolCallId,
    actionType: request.toolName,
    risk,
    title: approvalTitle(request.toolName, risk),
    description: approvalDescription(request.toolName, payload),
    payload,
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function toApprovalPayload(request: PiRunnerApprovalRequest): ApprovalPayload {
  if (request.toolName === "bash") {
    const command = readInputString(request.input, "command", "");
    return {
      type: "bash",
      cwd: request.cwd,
      command,
      riskFlags: classifyBashRiskFlags(command),
    };
  }

  if (request.toolName === "write") {
    const path = readInputString(request.input, "path", "<unknown>");
    const content = readInputString(request.input, "content", "");
    return {
      type: "file_write",
      path,
      bytes: Buffer.byteLength(content, "utf8"),
      preview: truncatePreview(content),
    };
  }

  if (request.toolName !== "edit") {
    return {
      type: "tool_call",
      toolName: request.toolName,
      cwd: request.cwd,
      input: request.input,
    };
  }

  const path = readInputString(request.input, "path", "<unknown>");
  return {
    type: "file_edit",
    path,
    diffPreview: truncatePreview(formatEditPreview(readInputArray(request.input, "edits"))),
  };
}

function classifyApprovalRisk(request: PiRunnerApprovalRequest, payload: ApprovalPayload): ApprovalRisk {
  if (payload.type === "bash") {
    return payload.riskFlags.length > 0 ? "high" : "medium";
  }

  if (payload.type === "file_write" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  if (payload.type === "file_edit" && isOutsideWorkspace(payload.path, request.cwd)) {
    return "high";
  }

  if (payload.type === "tool_call") {
    return "low";
  }

  return "medium";
}

function approvalTitle(toolName: PiRunnerApprovalRequest["toolName"], risk: ApprovalRisk): string {
  if (toolName === "bash") {
    return risk === "high" ? "Approve high-risk shell command" : "Approve shell command";
  }
  if (toolName === "write") {
    return "Approve file write";
  }
  if (toolName === "edit") {
    return "Approve file edit";
  }
  return `Approve ${toolName}`;
}

function approvalDescription(toolName: PiRunnerApprovalRequest["toolName"], payload: ApprovalPayload): string {
  if (payload.type === "bash") {
    return payload.command || "The agent requested a shell command.";
  }
  if (payload.type === "file_write") {
    return `The agent requested writing ${payload.bytes} bytes to ${payload.path}.`;
  }
  if (payload.type === "file_edit") {
    return `The agent requested editing ${payload.path}.`;
  }
  if (payload.type === "tool_call") {
    return `The agent requested ${payload.toolName}.`;
  }
  return `The agent requested ${toolName}.`;
}

async function waitForApprovalDecision(store: RunStore, approvalId: string, signal?: AbortSignal): Promise<ApprovalRequest> {
  const deadline = Date.now() + APPROVAL_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    throwIfAborted(signal);
    const approval = store.getApprovalRequest(approvalId);
    if (!approval) {
      throw new Error(`Approval request not found: ${approvalId}`);
    }
    if (approval.status !== "pending") {
      return approval;
    }
    await delay(APPROVAL_POLL_INTERVAL_MS);
  }

  const expired = store.expireApprovalRequest(
    approvalId,
    { reason: "Approval request timed out before a decision was received." },
    new Date().toISOString(),
  );
  if (!expired) {
    throw new Error(`Approval request not found after timeout: ${approvalId}`);
  }
  appendApprovalDecisionEvent(store, expired);
  return expired;
}

function streamOrAppendApprovalDecisionEvent(options: {
  readonly store: RunStore;
  readonly approval: ApprovalRequest;
  readonly afterSeq: number;
  readonly appendAndMaybeStream: (type: RunEventType, data: unknown) => RunEventEnvelope | undefined;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}): void {
  const existingEvent = findApprovalDecisionEvent(options.store, options.approval, options.afterSeq);
  if (existingEvent) {
    options.streamEnvelope(existingEvent);
    return;
  }

  options.appendAndMaybeStream(approvalDecisionEventType(options.approval), {
    approvalId: options.approval.id,
    status: options.approval.status,
    resolvedBy: options.approval.resolvedBy,
    decisionReason: options.approval.decisionReason,
  });
}

function findApprovalDecisionEvent(
  store: RunStore,
  approval: ApprovalRequest,
  afterSeq: number,
): RunEventEnvelope | undefined {
  if (!approval.runId) {
    return undefined;
  }
  return store
    .listEvents(approval.runId, { afterSeq, limit: 1000 })
    .find(
      (event) =>
        (event.type === "approval_approved" || event.type === "approval_denied" || event.type === "approval_expired") &&
        isRecord(event.data) &&
        event.data.approvalId === approval.id,
    );
}

function classifyBashRiskFlags(command: string): string[] {
  const checks: Array<[RegExp, string]> = [
    [/\brm\s+-(?:[^\n]*r[^\n]*f|[^\n]*f[^\n]*r)\b/i, "destructive_remove"],
    [/\bgit\s+reset\s+--hard\b/i, "git_reset_hard"],
    [/\bgit\s+push\b[^\n]*--force\b/i, "git_force_push"],
    [/\bsudo\b/i, "sudo"],
    [/\b(?:chmod|chown)\s+-R\b/i, "recursive_permission_change"],
    [/\b(?:dd|mkfs|diskutil)\b/i, "disk_mutation"],
    [/\b(?:kubectl|helm|flyctl|vercel|netlify|aws|gcloud|az)\b[^\n]*\b(?:apply|delete|deploy|destroy|terminate)\b/i, "external_mutation"],
    [/\b(?:curl|wget)\b[^\n|;]*\|\s*(?:sh|bash)\b/i, "remote_script_execution"],
  ];
  return checks.filter(([pattern]) => pattern.test(command)).map(([, flag]) => flag);
}

function isOutsideWorkspace(inputPath: string, cwd: string): boolean {
  if (inputPath === "<unknown>") {
    return true;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  const relativePath = relative(cwd, absolutePath);
  return relativePath.startsWith("..") || isAbsolute(relativePath);
}

function isPathWithinAllowedWritePaths(inputPath: string, cwd: string, allowedWritePaths: readonly string[]): boolean {
  if (inputPath === "<unknown>") {
    return false;
  }
  const absolutePath = isAbsolute(inputPath) ? inputPath : resolvePath(cwd, inputPath);
  return allowedWritePaths.some((allowedPath) => {
    const scopePath = isAbsolute(allowedPath) ? allowedPath : resolvePath(cwd, allowedPath);
    const relativePath = relative(scopePath, absolutePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
  });
}

interface ExtractedArtifactCandidate {
  readonly type: ArtifactType;
  readonly title: string;
  readonly contentType?: string;
  readonly content?: string;
  readonly existingPath?: string;
}

function persistExtractedArtifacts(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>;
  readonly sourceArgs: unknown;
  readonly nextIndex: () => number;
  readonly extraSecrets?: readonly (string | undefined)[];
}): RunArtifact[] {
  const candidates = extractArtifactCandidates(options);
  const artifacts: RunArtifact[] = [];
  for (const candidate of candidates.slice(0, MAX_EXTRACTED_ARTIFACTS_PER_TOOL)) {
    const artifact = materializeExtractedArtifact(options.store, options.run.id, candidate, options.nextIndex(), options.extraSecrets ?? []);
    if (artifact) {
      artifacts.push(artifact);
    }
  }
  return artifacts;
}

function extractArtifactCandidates(options: {
  readonly store: RunStore;
  readonly run: RunSession;
  readonly event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>;
  readonly sourceArgs: unknown;
}): ExtractedArtifactCandidate[] {
  const candidates: ExtractedArtifactCandidate[] = [];
  const addTextCandidate = (title: string, content: string, type?: ArtifactType): void => {
    if (!content.trim()) {
      return;
    }
    const artifactType = type ?? inferArtifactTypeFromText(content);
    candidates.push({
      type: artifactType,
      title,
      content,
      contentType: contentTypeForArtifactType(artifactType),
    });
  };

  collectToolResultTextCandidates(options.event).forEach((candidate) => addTextCandidate(candidate.title, candidate.content, candidate.type));

  const generatedPath = readInputString(options.sourceArgs, "path", "");
  if (options.event.toolName === "write") {
    const generatedContent = readInputString(options.sourceArgs, "content", "");
    if (generatedContent) {
      addTextCandidate(
        `Generated file content: ${generatedPath || options.event.toolCallId}`,
        generatedContent,
        inferArtifactTypeFromPath(generatedPath, generatedContent),
      );
    }
  }

  if (options.event.toolName === "edit") {
    const edits = readInputArray(options.sourceArgs, "edits");
    const hasDiffOutput = candidates.some((candidate) => candidate.type === "diff");
    if (edits.length > 0 && !hasDiffOutput) {
      addTextCandidate(`Generated edit diff: ${generatedPath || options.event.toolCallId}`, formatEditPreview(edits), "diff");
    }
  }

  for (const rawPath of collectGeneratedArtifactPaths(options.event, options.sourceArgs)) {
    const existingPath = resolveExistingArtifactPath(options.store.paths.artifactsDir, options.run.cwd, rawPath);
    if (existingPath) {
      const artifactType = inferArtifactTypeFromPath(existingPath);
      candidates.push({
        type: artifactType,
        title: `Generated file: ${basename(rawPath) || rawPath}`,
        existingPath,
        contentType: contentTypeForArtifactType(artifactType),
      });
    } else {
      candidates.push({
        type: "file",
        title: `Generated file metadata: ${rawPath}`,
        content: formatGeneratedFileMetadata(options.event, rawPath),
        contentType: contentTypeForArtifactType("file"),
      });
    }
  }

  return dedupeArtifactCandidates(candidates);
}

function collectToolResultTextCandidates(
  event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>,
): Array<{ readonly title: string; readonly content: string; readonly type?: ArtifactType }> {
  if (typeof event.result === "string") {
    return [{ title: `${event.toolName} output`, content: event.result, type: inferArtifactTypeFromText(event.result) }];
  }
  const result = event.result;
  if (!isRecord(result)) {
    return [];
  }

  const candidates: Array<{ readonly title: string; readonly content: string; readonly type?: ArtifactType }> = [];
  const addField = (key: string, title: string, type?: ArtifactType): void => {
    const value = result[key];
    if (typeof value === "string" && value.trim()) {
      candidates.push({ title, content: value, type: type ?? inferArtifactTypeFromText(value) });
      return;
    }
    const textContent = readToolResultTextContent(value);
    if (textContent.trim()) {
      candidates.push({ title, content: textContent, type: type ?? inferArtifactTypeFromText(textContent) });
    }
  };

  addField("diff", `${event.toolName} diff`, "diff");
  addField("patch", `${event.toolName} patch`, "diff");
  addField("unifiedDiff", `${event.toolName} diff`, "diff");
  addField("markdown", `${event.toolName} markdown`, "markdown");
  addField("stdout", `${event.toolName} stdout`, "log");
  addField("stderr", `${event.toolName} stderr`, "log");
  addField("log", `${event.toolName} log`, "log");
  addField("output", `${event.toolName} output`);
  addField("text", `${event.toolName} text`);
  addField("content", `${event.toolName} content`);
  return candidates;
}

function readToolResultTextContent(value: unknown): string {
  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((item) => {
      if (!isRecord(item)) {
        return "";
      }
      const type = item.type;
      const text = item.text;
      if ((type === undefined || type === "text") && typeof text === "string") {
        return text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function collectGeneratedArtifactPaths(event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>, sourceArgs: unknown): string[] {
  const paths = new Set<string>();
  for (const path of collectPathLikeFields(event.result)) {
    paths.add(path);
  }

  if (event.toolName === "write" || event.toolName === "edit") {
    const path = readInputString(sourceArgs, "path", "");
    if (looksLikeFilePathString(path)) {
      paths.add(path);
    }
  }

  return [...paths];
}

function collectPathLikeFields(value: unknown, keyHint = ""): string[] {
  if (typeof value === "string") {
    return keyLooksLikePath(keyHint) && looksLikeFilePathString(value) ? [value] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap((item) => collectPathLikeFields(item, keyHint));
  }
  if (!isRecord(value)) {
    return [];
  }
  return Object.entries(value).flatMap(([key, item]) => collectPathLikeFields(item, key));
}

function keyLooksLikePath(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, "");
  return (
    normalized === "path" ||
    normalized === "filepath" ||
    normalized === "filename" ||
    normalized === "files" ||
    normalized === "paths" ||
    normalized.endsWith("path") ||
    normalized.endsWith("file") ||
    normalized.endsWith("files") ||
    normalized.includes("outputpath") ||
    normalized.includes("outputfile") ||
    normalized.includes("artifactpath") ||
    normalized.includes("targetpath")
  );
}

function looksLikeFilePathString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 512 || trimmed.includes("\n") || /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return false;
  }
  return trimmed.includes("/") || trimmed.includes("\\") || extname(trimmed) !== "";
}

function resolveExistingArtifactPath(artifactRoot: string, cwd: string, rawPath: string): string | undefined {
  const candidates = isAbsolute(rawPath)
    ? [rawPath]
    : [resolvePath(artifactRoot, rawPath), resolvePath(cwd, rawPath)];

  for (const candidate of candidates) {
    const absolutePath = resolvePath(candidate);
    if (!isPathInsideRoot(artifactRoot, absolutePath)) {
      continue;
    }
    const stats = statFileIfPresent(absolutePath);
    if (stats?.isFile()) {
      return absolutePath;
    }
  }
  return undefined;
}

function materializeExtractedArtifact(
  store: RunStore,
  runId: string,
  candidate: ExtractedArtifactCandidate,
  index: number,
  extraSecrets: readonly (string | undefined)[] = [],
): RunArtifact | undefined {
  const createdAt = new Date().toISOString();

  if (candidate.existingPath) {
    if (!isPathInsideRoot(store.paths.artifactsDir, candidate.existingPath)) {
      return undefined;
    }
    const stats = statFileIfPresent(candidate.existingPath);
    if (!stats?.isFile()) {
      return undefined;
    }
    return store.createArtifact({
      runId,
      type: candidate.type,
      path: normalizeArtifactPath(relative(store.paths.artifactsDir, candidate.existingPath)),
      title: candidate.title,
      contentType: candidate.contentType,
      sizeBytes: Number(stats.size),
      createdAt,
    });
  }

  if (candidate.content === undefined) {
    return undefined;
  }

  const runArtifactDir = resolvePath(store.paths.artifactsDir, runId);
  mkdirSync(runArtifactDir, { recursive: true });
  const relativePath = `${runId}/${formatArtifactFilename(index, candidate)}`;
  const absolutePath = resolvePath(store.paths.artifactsDir, relativePath);
  const content = truncateExtractedArtifactContent(redactArtifactContent(candidate.content, extraSecrets));
  writeFileSync(absolutePath, content, "utf8");
  const stats = statSync(absolutePath);

  return store.createArtifact({
    runId,
    type: candidate.type,
    path: relativePath,
    title: candidate.title,
    contentType: candidate.contentType,
    sizeBytes: Number(stats.size),
    createdAt,
  });
}

function createMediaAdapterForProvider(store: RunStore, provider: ProviderPreset, secretResolver: SecretResolver) {
  const gate = resolveMediaVendorTransportGateConfig(provider.compat);
  if (!gate.ok) {
    throw new HttpError(400, gate.errorCode ?? "invalid_request", gate.errorMessage ?? "Invalid media vendor transport configuration.");
  }
  const secret: ResolvedSecret = provider.apiKeyRef ? resolveProviderSecret(store, provider, secretResolver) : { configured: false };
  const registry = createDefaultMediaAdapterRegistry({
    mediaVendorTransport: gate.config?.mode === "live"
      ? createLiveMediaVendorTransport({
        baseUrl: provider.baseUrl,
        apiKeyRef: provider.apiKeyRef,
        apiKeyConfigured: secret.configured,
        apiKey: secret.value,
      })
      : undefined,
  });
  const resolution = resolveMediaAdapter(registry, {
    id: provider.id,
    kind: provider.kind,
    displayName: provider.displayName,
    providerId: provider.providerId,
    model: provider.model,
    api: provider.api,
    baseUrl: provider.baseUrl,
    apiKeyRef: provider.apiKeyRef,
    capabilities: provider.capabilities,
  });
  if (!resolution.ok || !resolution.adapter) {
    throw new HttpError(400, resolution.errorCode ?? "unsupported_capability", resolution.errorMessage ?? "Media adapter is not available.");
  }
  return resolution.adapter;
}

type MediaCostApprovalGateResult =
  | { readonly kind: "not_required" }
  | { readonly kind: "approved"; readonly approval: ApprovalRequest }
  | { readonly kind: "waiting_for_approval"; readonly mediaJob: MediaJob; readonly approval: ApprovalRequest }
  | { readonly kind: "blocked"; readonly mediaJob: MediaJob; readonly approval: ApprovalRequest };

function applyMediaCostApprovalGate(store: RunStore, job: MediaJob, provider: ProviderPreset): MediaCostApprovalGateResult {
  const gate = resolveMediaVendorTransportGateConfig(provider.compat);
  if (!gate.ok || gate.config?.mode !== "live") {
    return { kind: "not_required" };
  }

  expireStalePendingApprovals(store, { mediaJobId: job.id });
  const approvals = store
    .listApprovalRequests({ mediaJobId: job.id, limit: 500 })
    .filter((approval) => approval.actionType === "media_cost");

  for (const approval of approvals) {
    if (approval.status === "pending") {
      return {
        kind: "waiting_for_approval",
        mediaJob: markMediaJobWaitingForApproval(store, job),
        approval,
      };
    }
    if (approval.status === "approved") {
      return { kind: "approved", approval };
    }
    if (approval.status === "denied" || approval.status === "expired") {
      return {
        kind: "blocked",
        mediaJob: failMediaJobForApprovalDecision(store, job, approval),
        approval,
      };
    }
  }

  const approval = store.createApprovalRequest(createMediaCostApprovalInput(job, provider), new Date().toISOString());
  return {
    kind: "waiting_for_approval",
    mediaJob: markMediaJobWaitingForApproval(store, job),
    approval,
  };
}

function createMediaCostApprovalInput(job: MediaJob, provider: ProviderPreset): CreateApprovalRequestInput {
  return {
    mediaJobId: job.id,
    actionType: "media_cost",
    risk: "high",
    title: "Approve media job cost",
    description: `${provider.displayName} ${job.operation} requires approval before live media execution.`,
    payload: {
      type: "media_cost",
      providerPresetId: provider.id,
      model: provider.model,
      operation: job.operation,
      promptPreview: truncatePreview(job.prompt),
    },
    expiresAt: new Date(Date.now() + APPROVAL_TIMEOUT_MS).toISOString(),
  };
}

function markMediaJobWaitingForApproval(store: RunStore, job: MediaJob): MediaJob {
  if (job.status === "waiting_for_approval" && !job.errorMessage) {
    return job;
  }
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "waiting_for_approval",
      errorMessage: null,
    },
    new Date().toISOString(),
  ) ?? job;
}

function failMediaJobForApprovalDecision(store: RunStore, job: MediaJob, approval: ApprovalRequest): MediaJob {
  return store.updateMediaJobStatus(
    job.id,
    {
      status: "failed",
      errorMessage: `Media cost approval ${approval.status} before live media execution.`,
    },
    new Date().toISOString(),
  ) ?? job;
}

function createMediaJobArtifacts(
  store: RunStore,
  job: MediaJob,
  candidates: readonly MediaExecutionArtifact[],
  createdAt: string,
  extraSecrets: readonly (string | undefined)[] = [],
): RunArtifact[] {
  return candidates
    .map((candidate, index) => createMediaJobArtifact(store, job, candidate, index, createdAt, extraSecrets))
    .filter((artifact): artifact is RunArtifact => Boolean(artifact));
}

function createMediaJobArtifact(
  store: RunStore,
  job: MediaJob,
  candidate: MediaExecutionArtifact,
  index: number,
  createdAt: string,
  extraSecrets: readonly (string | undefined)[] = [],
): RunArtifact | undefined {
  if (candidate.content === undefined && candidate.contentBytes === undefined) {
    return undefined;
  }
  const artifactDir = resolvePath(store.paths.artifactsDir, "media_jobs", job.id);
  mkdirSync(artifactDir, { recursive: true });
  const relativePath = normalizeArtifactPath(`media_jobs/${job.id}/${formatMediaArtifactFilename(index, candidate, createdAt)}`);
  const absolutePath = resolvePath(store.paths.artifactsDir, relativePath);
  if (candidate.contentBytes !== undefined) {
    writeFileSync(absolutePath, Buffer.from(candidate.contentBytes));
  } else {
    const content = redactArtifactContent(candidate.content ?? "", extraSecrets);
    writeFileSync(absolutePath, content, "utf8");
  }
  const stats = statSync(absolutePath);

  return store.createArtifact({
    mediaJobId: job.id,
    type: candidate.type,
    path: relativePath,
    title: candidate.title,
    contentType: candidate.contentType ?? contentTypeForArtifactType(candidate.type),
    sizeBytes: Number(stats.size),
    createdAt,
  });
}

function formatMediaArtifactFilename(index: number, candidate: MediaExecutionArtifact, createdAt: string): string {
  const hintedName = candidate.pathHint ? basename(candidate.pathHint) : "";
  const titleSlug = (hintedName || candidate.title)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || `artifact-${formatTimestampSlug(createdAt)}`;
  const extension = extname(titleSlug) ? "" : `.${artifactExtensionForType(candidate.type)}`;
  return `${String(index + 1).padStart(3, "0")}-${titleSlug}${extension}`;
}

function formatTimestampSlug(value: string): string {
  return value.replace(/[^0-9A-Za-z]+/g, "-").replace(/^-+|-+$/g, "") || "now";
}

function dedupeArtifactCandidates(candidates: readonly ExtractedArtifactCandidate[]): ExtractedArtifactCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.type}\0${candidate.title}\0${candidate.existingPath ?? candidate.content ?? ""}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

function formatArtifactFilename(index: number, candidate: ExtractedArtifactCandidate): string {
  const titleSlug = candidate.title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "artifact";
  return `${String(index).padStart(3, "0")}-${titleSlug}.${artifactExtensionForType(candidate.type)}`;
}

function artifactExtensionForType(type: ArtifactType): string {
  if (type === "markdown") {
    return "md";
  }
  if (type === "diff") {
    return "diff";
  }
  if (type === "json") {
    return "json";
  }
  if (type === "log") {
    return "log";
  }
  if (type === "image") {
    return "png";
  }
  if (type === "video") {
    return "mp4";
  }
  return "txt";
}

function inferArtifactTypeFromPath(path: string, content = ""): ArtifactType {
  const extension = extname(path).toLowerCase();
  if (extension === ".md" || extension === ".markdown") {
    return "markdown";
  }
  if (extension === ".diff" || extension === ".patch") {
    return "diff";
  }
  if (extension === ".json") {
    return "json";
  }
  if (extension === ".log" || extension === ".txt" || extension === ".out" || extension === ".err") {
    return "log";
  }
  if (content) {
    return inferArtifactTypeFromText(content);
  }
  return "file";
}

function inferArtifactTypeFromText(content: string): ArtifactType {
  if (isDiffLikeContent(content)) {
    return "diff";
  }
  if (isMarkdownLikeContent(content)) {
    return "markdown";
  }
  return "log";
}

function isDiffLikeContent(content: string): boolean {
  return /^diff --git /m.test(content) || /^--- .+\n\+\+\+ /m.test(content) || /^@@ /m.test(content);
}

function isMarkdownLikeContent(content: string): boolean {
  return /^#{1,6}\s+\S/m.test(content) || /```/.test(content) || /^\s*[-*]\s+\S/m.test(content);
}

function formatGeneratedFileMetadata(event: Extract<PiRunnerEvent, { readonly type: "tool_end" }>, rawPath: string): string {
  return [
    `Generated file path: ${rawPath}`,
    `Source tool: ${event.toolName}`,
    `Tool call: ${event.toolCallId}`,
    "",
    "Content was not copied because artifact content is served only from .ling-stack/artifacts.",
  ].join("\n");
}

function redactArtifactContent(content: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const redacted = redactSecrets(content, extraSecrets);
  return typeof redacted === "string" ? redacted : content;
}

function redactTextWithSecrets(content: string, extraSecrets: readonly (string | undefined)[] = []): string {
  const redacted = redactSecrets(content, extraSecrets);
  return typeof redacted === "string" ? redacted : content;
}

function truncateExtractedArtifactContent(content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes <= MAX_EXTRACTED_ARTIFACT_BYTES) {
    return content;
  }
  const truncated = Buffer.from(content, "utf8").subarray(0, MAX_EXTRACTED_ARTIFACT_BYTES).toString("utf8");
  return `${truncated}\n\n[truncated from ${bytes} bytes]`;
}

function statFileIfPresent(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}

function isPathInsideRoot(root: string, path: string): boolean {
  const relativePath = relative(resolvePath(root), resolvePath(path));
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function normalizeArtifactPath(path: string): string {
  return path.replace(/\\/g, "/");
}

function contentTypeForArtifactType(type: ArtifactType): string {
  if (type === "json") {
    return "application/json; charset=utf-8";
  }
  if (type === "markdown") {
    return "text/markdown; charset=utf-8";
  }
  if (type === "diff") {
    return "text/x-diff; charset=utf-8";
  }
  if (type === "log" || type === "file") {
    return "text/plain; charset=utf-8";
  }
  if (type === "image") {
    return "image/png";
  }
  if (type === "video") {
    return "video/mp4";
  }
  return "application/octet-stream";
}

function resolveArtifactContentPath(store: RunStore, artifact: RunArtifact): string {
  const artifactRoot = store.paths.artifactsDir;
  const absolutePath = isAbsolute(artifact.path) ? artifact.path : resolvePath(artifactRoot, artifact.path);
  const relativePath = relative(artifactRoot, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Artifact content path is outside .ling-stack/artifacts: ${artifact.path}`);
  }
  return absolutePath;
}

function inferArtifactContentType(artifact: RunArtifact): string {
  return contentTypeForArtifactType(artifact.type);
}

function formatEditPreview(edits: readonly unknown[]): string {
  if (edits.length === 0) {
    return "No edit preview was provided.";
  }
  return edits
    .map((edit, index) => {
      if (!isRecord(edit)) {
        return `#${index + 1}\n<invalid edit entry>`;
      }
      const oldText = readInputString(edit, "oldText", "");
      const newText = readInputString(edit, "newText", "");
      return `#${index + 1}\n- ${truncatePreview(oldText, 320)}\n+ ${truncatePreview(newText, 320)}`;
    })
    .join("\n\n");
}

function readInputString(input: unknown, key: string, fallback: string): string {
  if (!isRecord(input)) {
    return fallback;
  }
  const value = input[key];
  return typeof value === "string" ? value : fallback;
}

function readInputArray(input: unknown, key: string): unknown[] {
  if (!isRecord(input)) {
    return [];
  }
  const value = input[key];
  return Array.isArray(value) ? value : [];
}

function truncatePreview(value: string, limit = APPROVAL_PREVIEW_LIMIT): string {
  return value.length > limit ? `${value.slice(0, limit)}...` : value;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw createAbortError();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(): Error {
  const error = new Error("Run cancelled.");
  error.name = "AbortError";
  return error;
}

async function readJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("Request body is required");
  }

  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

async function readOptionalJsonBody(request: IncomingMessage, maxBytes: number): Promise<unknown | undefined> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > maxBytes) {
      throw new Error(`Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

function parseRunRequest(value: unknown): RunRequest {
  if (!isRecord(value)) {
    throw new Error("Run request must be a JSON object");
  }

  const cwd = readString(value, "cwd");
  const workspaceCwd = readOptionalString(value, "workspaceCwd");
  const task = value.task;
  const provider = value.provider;
  const providerPresetId = readOptionalString(value, "providerPresetId");
  const skipProviderPreflight = readOptionalBoolean(value, "skipProviderPreflight") ?? false;
  const idempotencyKey = readOptionalString(value, "idempotencyKey");

  if (!isRecord(task)) {
    throw new Error("task must be an object");
  }
  if (provider !== undefined && !isRecord(provider)) {
    throw new Error("provider must be an object");
  }
  if (providerPresetId && provider !== undefined) {
    throw new Error("providerPresetId and provider cannot both be supplied");
  }
  if (!providerPresetId && provider === undefined) {
    throw new Error("Either providerPresetId or provider is required");
  }

  const runRequest: RunRequest = {
    cwd,
    workspaceCwd,
    providerPresetId,
    skipProviderPreflight,
    idempotencyKey,
    task: {
      id: readString(task, "id"),
      title: readString(task, "title"),
      prompt: readString(task, "prompt"),
      channelId: readOptionalString(task, "channelId"),
    },
    provider: provider ? parseInlineProvider(provider) : undefined,
      tools: readOptionalStringArray(value, "tools", ["read", "bash", "edit", "write", "grep", "find", "ls"]) ?? [...readOnlyRunTools],
      approvalProfile: readOptionalApprovalProfile(value, "approvalProfile"),
      thinkingLevel: readOptionalThinkingLevel(value, "thinkingLevel"),
      systemPrompt: readOptionalString(value, "systemPrompt"),
      appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    agentDir: readOptionalString(value, "agentDir"),
  };

  return runRequest;
}

function parseInlineProvider(provider: Record<string, unknown>): PiRunnerProviderConfig {
  return {
    provider: readString(provider, "provider"),
    model: readString(provider, "model"),
    displayName: readOptionalString(provider, "displayName"),
    apiKey: readOptionalString(provider, "apiKey"),
    baseUrl: readOptionalString(provider, "baseUrl"),
    api: readOptionalProviderApi(provider, "api"),
    headers: readOptionalStringRecord(provider, "headers"),
    authHeader: readOptionalBoolean(provider, "authHeader"),
    reasoning: readOptionalBoolean(provider, "reasoning"),
    input: readOptionalStringArray(provider, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(provider, "contextWindow"),
    maxTokens: readOptionalNumber(provider, "maxTokens"),
    compat: isRecord(provider.compat) ? provider.compat : undefined,
  };
}

function parseRunRoute(
  pathname: string,
): { kind: "run"; runId: string } | { kind: "events"; runId: string } | { kind: "artifacts"; runId: string } | { kind: "cancel"; runId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "runs") {
    return { kind: "run", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "events") {
    return { kind: "events", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "artifacts") {
    return { kind: "artifacts", runId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "runs" && segments[2] === "cancel") {
    return { kind: "cancel", runId: segments[1] };
  }
  return undefined;
}

function parseArtifactRoute(pathname: string): { kind: "artifact"; artifactId: string } | { kind: "content"; artifactId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "artifacts") {
    return { kind: "artifact", artifactId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "artifacts" && segments[2] === "content") {
    return { kind: "content", artifactId: segments[1] };
  }
  return undefined;
}

function parseChannelRoute(
  pathname: string,
): {
  readonly channelId: string;
  readonly action?: "brief" | "messages" | "proposals" | "attachments" | "link-previews" | "decisions" | "handoffs" | "context-summaries" | "workflows";
} | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channels") {
    return { channelId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "channels" &&
    (
      segments[2] === "brief" ||
      segments[2] === "messages" ||
      segments[2] === "proposals" ||
      segments[2] === "attachments" ||
      segments[2] === "link-previews" ||
      segments[2] === "decisions" ||
      segments[2] === "handoffs" ||
      segments[2] === "context-summaries" ||
      segments[2] === "workflows"
    )
  ) {
    return { channelId: segments[1], action: segments[2] };
  }
  return undefined;
}

function parseChannelExecutionProposalRoute(pathname: string): { readonly proposalId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "channel-proposals") {
    return { proposalId: segments[1] };
  }
  return undefined;
}

function parseTeammateRoute(
  pathname: string,
): {
  readonly teammateId: string;
  readonly action?: "channels" | "skills" | "memory-scopes" | "direct-thread" | "direct-messages" | "tasks" | "activity";
} | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "teammates") {
    return { teammateId: segments[1] };
  }
  if (
    segments.length === 3 &&
    segments[0] === "teammates" &&
    (
      segments[2] === "channels" ||
      segments[2] === "skills" ||
      segments[2] === "memory-scopes" ||
      segments[2] === "direct-thread" ||
      segments[2] === "direct-messages" ||
      segments[2] === "tasks" ||
      segments[2] === "activity"
    )
  ) {
    return { teammateId: segments[1], action: segments[2] };
  }
  return undefined;
}

function parseChannelAttachmentRoute(
  pathname: string,
): { readonly attachmentId: string; readonly action?: "content" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "attachments") {
    return { attachmentId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "attachments" && segments[2] === "content") {
    return { attachmentId: segments[1], action: "content" };
  }
  return undefined;
}

function parseChannelLinkPreviewRoute(
  pathname: string,
): { readonly linkPreviewId: string; readonly action: "refresh" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "link-previews" && segments[2] === "refresh") {
    return { linkPreviewId: segments[1], action: "refresh" };
  }
  return undefined;
}

function parseChannelDecisionRoute(pathname: string): { readonly decisionId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "decisions") {
    return { decisionId: segments[1] };
  }
  return undefined;
}

function parseChannelHandoffRoute(pathname: string): { readonly handoffId: string; readonly action?: "workflow" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "handoffs") {
    return { handoffId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "handoffs" && segments[2] === "workflow") {
    return { handoffId: segments[1], action: "workflow" };
  }
  return undefined;
}

function parseChannelWorkflowRoute(
  pathname: string,
):
  | { readonly kind: "workflow"; readonly workflowId: string }
  | { readonly kind: "steps"; readonly workflowId: string }
  | { readonly kind: "workflow-step"; readonly workflowStepId: string; readonly action?: "start" }
  | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "workflows") {
    return { kind: "workflow", workflowId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "workflows" && segments[2] === "steps") {
    return { kind: "steps", workflowId: segments[1] };
  }
  if (segments.length === 2 && segments[0] === "workflow-steps") {
    return { kind: "workflow-step", workflowStepId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "workflow-steps" && segments[2] === "start") {
    return { kind: "workflow-step", workflowStepId: segments[1], action: "start" };
  }
  return undefined;
}

function parseChannelContextSummaryRoute(pathname: string): { readonly contextSummaryId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "context-summaries") {
    return { contextSummaryId: segments[1] };
  }
  return undefined;
}

function parseTaskRoute(pathname: string): { readonly taskId: string; readonly action?: "run" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "tasks") {
    return { taskId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "tasks" && segments[2] === "run") {
    return { taskId: segments[1], action: "run" };
  }
  return undefined;
}

function parseProviderRoute(pathname: string): { readonly providerId: string; readonly action?: "check" | "secret" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "providers") {
    return { providerId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "providers" && segments[2] === "check") {
    return { providerId: segments[1], action: "check" };
  }
  if (segments.length === 3 && segments[0] === "providers" && segments[2] === "secret") {
    return { providerId: segments[1], action: "secret" };
  }
  return undefined;
}

function parseMediaJobRoute(pathname: string): { readonly mediaJobId: string; readonly action?: "run" | "artifacts" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "media-jobs") {
    return { mediaJobId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "media-jobs" && (segments[2] === "run" || segments[2] === "artifacts")) {
    return { mediaJobId: segments[1], action: segments[2] };
  }
  return undefined;
}

function parseApprovalRoute(pathname: string): { readonly approvalId: string; readonly action?: "approve" | "deny" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 2 && segments[0] === "approvals") {
    return { approvalId: segments[1] };
  }
  if (segments.length === 3 && segments[0] === "approvals" && (segments[2] === "approve" || segments[2] === "deny")) {
    return { approvalId: segments[1], action: segments[2] };
  }
  return undefined;
}

function parseExternalWorkActionRoute(pathname: string): { readonly actionId: string; readonly action?: "cancel" | "execute" } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (segments.length === 3 && segments[0] === "external-work" && segments[1] === "actions") {
    return { actionId: segments[2] };
  }
  if (
    segments.length === 4 &&
    segments[0] === "external-work" &&
    segments[1] === "actions" &&
    (segments[3] === "cancel" || segments[3] === "execute")
  ) {
    return { actionId: segments[2], action: segments[3] };
  }
  return undefined;
}

function parseExternalWorkCiTriageItemRoute(pathname: string): { readonly triageId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (
    segments.length === 5 &&
    segments[0] === "external-work" &&
    segments[1] === "github" &&
    segments[2] === "ci" &&
    segments[3] === "triage"
  ) {
    return { triageId: segments[4] };
  }
  return undefined;
}

function parseExternalWorkBackgroundStopRoute(pathname: string): { readonly schedulerId: string } | undefined {
  const prefix = "/external-work/background/";
  if (!pathname.startsWith(prefix) || !pathname.endsWith("/stop")) {
    return undefined;
  }
  const schedulerId = decodeURIComponent(pathname.slice(prefix.length, -"/stop".length));
  return schedulerId ? { schedulerId } : undefined;
}

function parseExternalWorkCiTriageRunRoute(pathname: string): { readonly triageId: string } | undefined {
  const segments = pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (
    segments.length === 6 &&
    segments[0] === "external-work" &&
    segments[1] === "github" &&
    segments[2] === "ci" &&
    segments[3] === "triage" &&
    segments[5] === "run"
  ) {
    return { triageId: segments[4] };
  }
  return undefined;
}

function parseApprovalPolicyUpdateInput(value: unknown): ApprovalPolicyUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Approval policy update must be a JSON object");
  }
  const input: ApprovalPolicyUpdateInput = {
    toolDecisions: readOptionalApprovalToolDecisions(value, "toolDecisions"),
    allowedWritePaths: readOptionalStringArray(value, "allowedWritePaths")?.map((path) => path.trim()),
  };
  validateApprovalPolicyUpdateInput(input);
  return input;
}

function validateApprovalPolicyUpdateInput(input: ApprovalPolicyUpdateInput): void {
  if (input.allowedWritePaths?.some((path) => path.trim().length === 0)) {
    throw new Error("allowedWritePaths must not contain empty paths");
  }
}

function parseCreateChannelInput(value: unknown): CreateChannelInput {
  if (!isRecord(value)) {
    throw new Error("Channel request must be a JSON object");
  }
  const input: CreateChannelInput = {
    name: readString(value, "name"),
    status: readOptionalChannelStatus(value, "status"),
    boundPath: readOptionalString(value, "boundPath"),
    defaultProviderPresetId: readOptionalString(value, "defaultProviderPresetId"),
    defaultTeammateId: readOptionalString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    runtimePolicy: readOptionalChannelRuntimePolicy(value, "runtimePolicy"),
  };
  validateChannelInput(input);
  return input;
}

function parseChannelUpdateInput(value: unknown): ChannelUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Channel update must be a JSON object");
  }
  const input: ChannelUpdateInput = {
    name: readOptionalString(value, "name"),
    status: readOptionalChannelStatus(value, "status"),
    boundPath: readNullableString(value, "boundPath"),
    defaultProviderPresetId: readNullableString(value, "defaultProviderPresetId"),
    defaultTeammateId: readNullableString(value, "defaultTeammateId"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    runtimePolicy: readOptionalChannelRuntimePolicy(value, "runtimePolicy"),
  };
  validateChannelInput(input);
  return input;
}

function validateChannelInput(input: ChannelUpdateInput): void {
  if (input.name !== undefined && input.name.trim().length === 0) {
    throw new Error("name must be a non-empty string");
  }
  if (input.allowedTools !== undefined && input.allowedTools.length === 0) {
    throw new Error("allowedTools must contain at least one tool");
  }
}

function parseCreateTaskInput(value: unknown): CreateTaskInput {
  if (!isRecord(value)) {
    throw new Error("Task request must be a JSON object");
  }
  const input: CreateTaskInput = {
    channelId: readString(value, "channelId"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
  };
  validateTaskInput(input);
  return input;
}

function parseTaskUpdateInput(value: unknown): TaskUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Task update must be a JSON object");
  }
  const input: TaskUpdateInput = {
    channelId: readOptionalString(value, "channelId"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    status: readOptionalTaskStatus(value, "status"),
    assigneeTeammateId: readNullableString(value, "assigneeTeammateId"),
    currentRunId: readNullableString(value, "currentRunId"),
  };
  validateTaskInput(input);
  return input;
}

function validateTaskInput(input: TaskUpdateInput): void {
  if (input.channelId !== undefined && input.channelId.trim().length === 0) {
    throw new Error("channelId must be a non-empty string");
  }
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
}

function parseCreateAiTeammateInput(value: unknown): CreateAiTeammateInput {
  if (!isRecord(value)) {
    throw new Error("AI teammate request must be a JSON object");
  }
  const input: CreateAiTeammateInput = {
    templateId: readOptionalString(value, "templateId"),
    roleKey: readAiTeammateRoleKey(value, "roleKey"),
    displayName: readString(value, "displayName"),
    description: readStringAllowEmpty(value, "description"),
    avatarTone: readOptionalString(value, "avatarTone"),
    avatarImageAttachmentId: readOptionalString(value, "avatarImageAttachmentId"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    systemPrompt: readOptionalString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    approvalProfile: readApprovalProfile(value, "approvalProfile"),
    status: readOptionalAiTeammateStatus(value, "status"),
    pinned: readOptionalBoolean(value, "pinned"),
    hidden: readOptionalBoolean(value, "hidden"),
  };
  validateAiTeammateInput(input);
  return input;
}

function parseAiTeammateUpdateInput(value: unknown): AiTeammateUpdateInput {
  if (!isRecord(value)) {
    throw new Error("AI teammate update must be a JSON object");
  }
  const input: AiTeammateUpdateInput = {
    templateId: readNullableString(value, "templateId"),
    roleKey: readOptionalAiTeammateRoleKey(value, "roleKey"),
    displayName: readOptionalString(value, "displayName"),
    description: readOptionalString(value, "description"),
    avatarTone: readNullableString(value, "avatarTone"),
    avatarImageAttachmentId: readNullableString(value, "avatarImageAttachmentId"),
    providerPresetId: readNullableString(value, "providerPresetId"),
    systemPrompt: readNullableString(value, "systemPrompt"),
    appendSystemPrompt: readOptionalStringArray(value, "appendSystemPrompt"),
    allowedTools: readOptionalRunTools(value, "allowedTools"),
    approvalProfile: readOptionalApprovalProfile(value, "approvalProfile"),
    status: readOptionalAiTeammateStatus(value, "status"),
    pinned: readOptionalBoolean(value, "pinned"),
    hidden: readOptionalBoolean(value, "hidden"),
  };
  validateAiTeammateInput(input);
  return input;
}

function validateAiTeammateInput(input: AiTeammateUpdateInput): void {
  if (input.displayName !== undefined && input.displayName.trim().length === 0) {
    throw new Error("displayName must be a non-empty string");
  }
  if (input.allowedTools !== undefined && input.allowedTools.length === 0) {
    throw new Error("allowedTools must contain at least one tool");
  }
}

function parseReplaceTeammateChannelMembershipsRequest(value: unknown): readonly ReplaceTeammateChannelMembershipInput[] {
  if (!isRecord(value) || !Array.isArray(value.memberships)) {
    throw new Error("memberships must be an array");
  }
  return value.memberships.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`memberships[${index}] must be an object`);
    }
    return {
      channelId: readString(item, "channelId"),
      isDefault: readOptionalBoolean(item, "isDefault"),
    };
  });
}

function parseReplaceTeammateSkillBindingsRequest(value: unknown): readonly ReplaceTeammateSkillBindingInput[] {
  if (!isRecord(value) || !Array.isArray(value.bindings)) {
    throw new Error("bindings must be an array");
  }
  return value.bindings.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`bindings[${index}] must be an object`);
    }
    const source = readOptionalString(item, "source");
    if (source !== undefined && source !== "template" && source !== "user") {
      throw new Error(`bindings[${index}].source must be template or user`);
    }
    return {
      skillId: readString(item, "skillId"),
      source,
      enabled: readOptionalBoolean(item, "enabled"),
    };
  });
}

function parseReplaceTeammateMemoryScopesRequest(value: unknown): readonly ReplaceTeammateMemoryScopeInput[] {
  if (!isRecord(value) || !Array.isArray(value.scopes)) {
    throw new Error("scopes must be an array");
  }
  return value.scopes.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`scopes[${index}] must be an object`);
    }
    return {
      id: readOptionalString(item, "id"),
      kind: readTeammateMemoryScopeKind(item, "kind"),
      channelId: readOptionalString(item, "channelId"),
      enabled: readOptionalBoolean(item, "enabled"),
    };
  });
}

function parseTeammateDirectMessageRequest(value: unknown): { readonly body: string; readonly requestAiReply: boolean; readonly providerPresetId?: string } {
  if (!isRecord(value)) {
    throw new Error("Direct message request must be a JSON object");
  }
  const body = readString(value, "body");
  return {
    body,
    requestAiReply: readOptionalBoolean(value, "requestAiReply") ?? false,
    providerPresetId: readOptionalString(value, "providerPresetId"),
  };
}

function parseChannelMessageRequest(value: unknown): ChannelMessageRequest {
  if (!isRecord(value)) {
    throw new Error("Channel message request must be a JSON object");
  }
  const input: ChannelMessageRequest = {
    threadId: readOptionalString(value, "threadId"),
    kind: readOptionalChannelMessageKind(value, "kind"),
    intent: readOptionalChannelMessageIntent(value, "intent") ?? "discuss",
    authorType: readOptionalChannelMessageAuthorType(value, "authorType") ?? "local-user",
    authorId: readOptionalString(value, "authorId"),
    body: readString(value, "body"),
    mentions: readOptionalChannelMentions(value, "mentions") ?? [],
    attachmentIds: readOptionalStringArray(value, "attachmentIds") ?? [],
    linkPreviewIds: readOptionalStringArray(value, "linkPreviewIds") ?? [],
    linkedTaskId: readOptionalString(value, "linkedTaskId"),
    linkedRunId: readOptionalString(value, "linkedRunId"),
    requestAiReply: readOptionalBoolean(value, "requestAiReply") ?? false,
    providerPresetId: readOptionalString(value, "providerPresetId"),
    teammateId: readOptionalString(value, "teammateId"),
  };
  if (!input.body.trim() && input.attachmentIds.length === 0 && input.linkPreviewIds.length === 0) {
    throw new Error("body, attachmentIds, or linkPreviewIds is required");
  }
  if (input.attachmentIds.length > 10) {
    throw new Error("A channel message can reference at most 10 attachments");
  }
  return input;
}

function parseChannelExecutionProposalRequest(value: unknown): ChannelExecutionProposalRequest {
  if (!isRecord(value)) {
    throw new Error("Channel proposal request must be a JSON object");
  }
  const input: ChannelExecutionProposalRequest = {
    sourceMessageId: readString(value, "sourceMessageId"),
    proposedByTeammateId: readString(value, "proposedByTeammateId"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    assigneeTeammateId: readString(value, "assigneeTeammateId"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria") ?? [],
    collaborationSteps: readOptionalChannelExecutionProposalSteps(value, "collaborationSteps") ?? [],
    requiredTools: readOptionalRunTools(value, "requiredTools") ?? [],
    riskSummary: readOptionalString(value, "riskSummary"),
  };
  validateChannelExecutionProposalInput(input);
  return input;
}

function parseChannelExecutionProposalUpdateInput(value: unknown): UpdateChannelExecutionProposalInput {
  if (!isRecord(value)) {
    throw new Error("Channel proposal update must be a JSON object");
  }
  const input: UpdateChannelExecutionProposalInput = {
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria"),
    collaborationSteps: readOptionalChannelExecutionProposalSteps(value, "collaborationSteps"),
    requiredTools: readOptionalRunTools(value, "requiredTools"),
    riskSummary: readNullableString(value, "riskSummary"),
    status: readOptionalChannelExecutionProposalStatus(value, "status"),
    linkedTaskId: readNullableString(value, "linkedTaskId"),
    linkedRunId: readNullableString(value, "linkedRunId"),
    errorMessage: readNullableString(value, "errorMessage"),
  };
  validateChannelExecutionProposalInput(input);
  return input;
}

function validateChannelExecutionProposalInput(
  input: Partial<Pick<CreateChannelExecutionProposalInput, "title" | "prompt" | "assigneeTeammateId" | "acceptanceCriteria" | "collaborationSteps">>,
): void {
  if (input.title !== undefined && input.title.trim().length === 0) {
    throw new Error("title must be a non-empty string");
  }
  if (input.prompt !== undefined && input.prompt.trim().length === 0) {
    throw new Error("prompt must be a non-empty string");
  }
  if (input.assigneeTeammateId !== undefined && input.assigneeTeammateId.trim().length === 0) {
    throw new Error("assigneeTeammateId must be a non-empty string");
  }
  if (input.acceptanceCriteria?.some((item) => !item.trim())) {
    throw new Error("acceptanceCriteria entries must be non-empty strings");
  }
  if (input.collaborationSteps?.some((step) => !step.teammateId.trim() || !step.summary.trim())) {
    throw new Error("collaborationSteps entries must contain teammateId and summary");
  }
}

function parseChannelAttachmentRequest(value: unknown): ChannelAttachmentRequest {
  if (!isRecord(value)) {
    throw new Error("Channel attachment request must be a JSON object");
  }
  const input: ChannelAttachmentRequest = {
    fileName: readString(value, "fileName"),
    contentType: readOptionalString(value, "contentType"),
    contentBase64: readString(value, "contentBase64"),
    messageId: readOptionalString(value, "messageId"),
  };
  if (!input.fileName.trim()) {
    throw new Error("fileName must be a non-empty string");
  }
  if (!input.contentBase64.trim()) {
    throw new Error("contentBase64 must be a non-empty string");
  }
  return input;
}

function parseChannelLinkPreviewRequest(value: unknown): ChannelLinkPreviewRequest {
  if (!isRecord(value)) {
    throw new Error("Channel link preview request must be a JSON object");
  }
  return {
    url: readString(value, "url"),
    messageId: readOptionalString(value, "messageId"),
  };
}

function parseChannelBriefRequest(value: unknown): ChannelBriefRequest {
  if (!isRecord(value)) {
    throw new Error("Channel brief request must be a JSON object");
  }
  return {
    objective: readStringAllowEmpty(value, "objective"),
    scope: readStringAllowEmpty(value, "scope"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria") ?? [],
    openQuestions: readOptionalStringArray(value, "openQuestions") ?? [],
    risks: readOptionalStringArray(value, "risks") ?? [],
    decisionIds: readOptionalStringArray(value, "decisionIds") ?? [],
    attachmentIds: readOptionalStringArray(value, "attachmentIds") ?? [],
    linkPreviewIds: readOptionalStringArray(value, "linkPreviewIds") ?? [],
    updatedBy: readString(value, "updatedBy"),
  };
}

function parseChannelDecisionRequest(value: unknown): ChannelDecisionRequest {
  if (!isRecord(value)) {
    throw new Error("Channel decision request must be a JSON object");
  }
  return {
    sourceMessageId: readOptionalString(value, "sourceMessageId"),
    sourceTaskId: readOptionalString(value, "sourceTaskId"),
    sourceRunId: readOptionalString(value, "sourceRunId"),
    title: readString(value, "title"),
    decision: readString(value, "decision"),
    rationale: readOptionalString(value, "rationale"),
    alternatives: readOptionalStringArray(value, "alternatives") ?? [],
    status: readOptionalChannelDecisionStatus(value, "status"),
    supersedesDecisionId: readOptionalString(value, "supersedesDecisionId"),
    createdBy: readString(value, "createdBy"),
  };
}

function parseChannelDecisionUpdateRequest(value: unknown): ChannelDecisionUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel decision update must be a JSON object");
  }
  return {
    title: readOptionalString(value, "title"),
    decision: readOptionalString(value, "decision"),
    rationale: readOptionalString(value, "rationale"),
    alternatives: readOptionalStringArray(value, "alternatives"),
    status: readOptionalChannelDecisionStatus(value, "status"),
  };
}

function parseChannelHandoffRequest(value: unknown): ChannelHandoffRequest {
  if (!isRecord(value)) {
    throw new Error("Channel handoff request must be a JSON object");
  }
  return {
    sourceMessageId: readOptionalString(value, "sourceMessageId"),
    sourceTaskId: readOptionalString(value, "sourceTaskId"),
    sourceRunId: readOptionalString(value, "sourceRunId"),
    fromParticipantId: readString(value, "fromParticipantId"),
    fromParticipantLabel: readString(value, "fromParticipantLabel"),
    toParticipantId: readString(value, "toParticipantId"),
    toParticipantLabel: readString(value, "toParticipantLabel"),
    reason: readStringAllowEmpty(value, "reason"),
    requiredInput: readStringAllowEmpty(value, "requiredInput"),
    expectedOutput: readStringAllowEmpty(value, "expectedOutput"),
    status: readOptionalChannelHandoffStatus(value, "status"),
    createdBy: readString(value, "createdBy"),
  };
}

function parseChannelHandoffUpdateRequest(value: unknown): ChannelHandoffUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel handoff update must be a JSON object");
  }
  return {
    fromParticipantId: readOptionalString(value, "fromParticipantId"),
    fromParticipantLabel: readOptionalString(value, "fromParticipantLabel"),
    toParticipantId: readOptionalString(value, "toParticipantId"),
    toParticipantLabel: readOptionalString(value, "toParticipantLabel"),
    reason: readOptionalString(value, "reason"),
    requiredInput: readOptionalString(value, "requiredInput"),
    expectedOutput: readOptionalString(value, "expectedOutput"),
    status: readOptionalChannelHandoffStatus(value, "status"),
  };
}

function parseChannelContextSummaryRequest(value: unknown): ChannelContextSummaryRequest {
  if (!isRecord(value)) {
    throw new Error("Channel context summary request must be a JSON object");
  }
  return {
    targetType: readChannelContextSummaryTargetType(value, "targetType"),
    targetId: readString(value, "targetId"),
    sourceMessageIds: readOptionalStringArray(value, "sourceMessageIds") ?? [],
    decisionIds: readOptionalStringArray(value, "decisionIds") ?? [],
    summary: readString(value, "summary"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria") ?? [],
    openQuestions: readOptionalStringArray(value, "openQuestions") ?? [],
    authorType: readChannelContextSummaryAuthorType(value, "authorType"),
    authorId: readOptionalString(value, "authorId"),
  };
}

function parseChannelContextSummaryUpdateRequest(value: unknown): ChannelContextSummaryUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel context summary update must be a JSON object");
  }
  return {
    targetType: readOptionalChannelContextSummaryTargetType(value, "targetType"),
    targetId: readOptionalString(value, "targetId"),
    sourceMessageIds: readOptionalStringArray(value, "sourceMessageIds"),
    decisionIds: readOptionalStringArray(value, "decisionIds"),
    summary: readOptionalString(value, "summary"),
    acceptanceCriteria: readOptionalStringArray(value, "acceptanceCriteria"),
    openQuestions: readOptionalStringArray(value, "openQuestions"),
    authorType: readOptionalChannelContextSummaryAuthorType(value, "authorType"),
    authorId: readNullableString(value, "authorId"),
  };
}

function parseChannelWorkflowRequest(value: unknown): ChannelWorkflowRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow request must be a JSON object");
  }
  return {
    sourceHandoffId: readOptionalString(value, "sourceHandoffId"),
    title: readString(value, "title"),
    objective: readStringAllowEmpty(value, "objective"),
    status: readOptionalChannelWorkflowStatus(value, "status"),
    createdBy: readString(value, "createdBy"),
  };
}

function parseChannelWorkflowFromHandoffRequest(value: unknown): ChannelWorkflowFromHandoffRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow from handoff request must be a JSON object");
  }
  return {
    title: readOptionalString(value, "title"),
    objective: readOptionalString(value, "objective"),
    contextSummaryId: readOptionalString(value, "contextSummaryId"),
    createdBy: readString(value, "createdBy"),
  };
}

function parseChannelWorkflowUpdateRequest(value: unknown): ChannelWorkflowUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow update must be a JSON object");
  }
  return {
    title: readOptionalString(value, "title"),
    objective: readOptionalString(value, "objective"),
    status: readOptionalChannelWorkflowStatus(value, "status"),
  };
}

function parseChannelWorkflowStepRequest(value: unknown): ChannelWorkflowStepRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow step request must be a JSON object");
  }
  return {
    sourceHandoffId: readOptionalString(value, "sourceHandoffId"),
    contextSummaryId: readOptionalString(value, "contextSummaryId"),
    position: readOptionalNumber(value, "position"),
    title: readString(value, "title"),
    prompt: readString(value, "prompt"),
    toParticipantId: readString(value, "toParticipantId"),
    toParticipantLabel: readString(value, "toParticipantLabel"),
    status: readOptionalChannelWorkflowStepStatus(value, "status"),
  };
}

function parseChannelWorkflowStepUpdateRequest(value: unknown): ChannelWorkflowStepUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow step update must be a JSON object");
  }
  return {
    sourceHandoffId: readNullableString(value, "sourceHandoffId"),
    contextSummaryId: readNullableString(value, "contextSummaryId"),
    taskId: readNullableString(value, "taskId"),
    runId: readNullableString(value, "runId"),
    position: readOptionalNumber(value, "position"),
    title: readOptionalString(value, "title"),
    prompt: readOptionalString(value, "prompt"),
    toParticipantId: readOptionalString(value, "toParticipantId"),
    toParticipantLabel: readOptionalString(value, "toParticipantLabel"),
    status: readOptionalChannelWorkflowStepStatus(value, "status"),
    blocker: readNullableString(value, "blocker"),
    resultSummary: readNullableString(value, "resultSummary"),
  };
}

function parseChannelWorkflowStepStartRequest(value: unknown): ChannelWorkflowStepStartRequest {
  if (!isRecord(value)) {
    throw new Error("Channel workflow step start request must be a JSON object");
  }
  return {
    mode: readChannelWorkflowStepStartMode(value, "mode"),
    taskTitle: readOptionalString(value, "taskTitle"),
    taskPrompt: readOptionalString(value, "taskPrompt"),
    providerPresetId: readOptionalString(value, "providerPresetId"),
    assigneeTeammateId: readOptionalString(value, "assigneeTeammateId"),
    idempotencyKey: readOptionalString(value, "idempotencyKey"),
    skipProviderPreflight: readOptionalBoolean(value, "skipProviderPreflight"),
  };
}

function parseCreateMediaJobInput(value: unknown): CreateMediaJobInput {
  if (!isRecord(value)) {
    throw new Error("Media job request must be a JSON object");
  }
  const input: CreateMediaJobInput = {
    providerPresetId: readString(value, "providerPresetId"),
    operation: readMediaOperation(value, "operation"),
    prompt: readString(value, "prompt"),
    input: readOptionalObject(value, "input"),
  };
  validateMediaJobInput(input);
  return input;
}

function validateMediaJobInput(input: CreateMediaJobInput): void {
  if (!input.providerPresetId.trim()) {
    throw new Error("providerPresetId must be a non-empty string");
  }
  if (!input.prompt.trim()) {
    throw new Error("prompt must be a non-empty string");
  }
}

function assertMediaJobProvider(store: RunStore, input: CreateMediaJobInput, secretResolver?: SecretResolver): ProviderPreset {
  void secretResolver;
  const preset = store.getProviderPreset(input.providerPresetId);
  if (!preset) {
    throw new HttpError(404, "provider_not_found", `Provider preset not found: ${input.providerPresetId}`);
  }
  if (!preset.enabled) {
    throw new HttpError(400, "provider_disabled", `Provider preset is disabled: ${preset.id}`);
  }
  if (preset.api !== "media-job") {
    throw new HttpError(400, "unsupported_capability", "Media jobs require a media-job provider preset");
  }
  if (!preset.capabilities.includes(input.operation)) {
    throw new HttpError(400, "unsupported_capability", `${preset.displayName} does not support ${input.operation}`);
  }
  return preset;
}

function isRunnableMediaJobStatus(status: MediaJobStatus): boolean {
  return status === "queued" || status === "waiting_for_approval" || status === "failed" || status === "cancelled";
}

function shouldForceStaticMediaFailure(input: Record<string, unknown>): boolean {
  return input.forceFailure === true;
}

function parseProviderPresetInput(value: unknown): ProviderPresetInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset request must be a JSON object");
  }
  return validateProviderPresetInput({
    kind: readProviderKind(value, "kind"),
    displayName: readString(value, "displayName"),
    providerId: readString(value, "providerId"),
    model: readString(value, "model"),
    api: readProviderApi(value, "api"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readOptionalBoolean(value, "authHeader"),
    reasoning: readOptionalBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readOptionalNumber(value, "contextWindow"),
    maxTokens: readOptionalNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  });
}

interface ProviderPresetCreateRequest {
  readonly presetInput: ProviderPresetInput;
  readonly apiKey?: string;
}

interface ProviderPresetUpdateRequest {
  readonly updateInput: ProviderPresetUpdateInput;
  readonly apiKey?: string;
  readonly clearApiKey: boolean;
}

function parseProviderPresetCreateRequest(value: unknown): ProviderPresetCreateRequest {
  if (!isRecord(value)) {
    throw new Error("Provider preset request must be a JSON object");
  }
  return {
    presetInput: parseProviderPresetInput(value),
    apiKey: readOptionalApiKey(value),
  };
}

function parseProviderPresetUpdateInput(value: unknown): ProviderPresetUpdateInput {
  if (!isRecord(value)) {
    throw new Error("Provider preset update must be a JSON object");
  }

  const input: ProviderPresetUpdateInput = {
    kind: value.kind === undefined ? undefined : readProviderKind(value, "kind"),
    displayName: readOptionalString(value, "displayName"),
    providerId: readOptionalString(value, "providerId"),
    model: readOptionalString(value, "model"),
    api: value.api === undefined ? undefined : readProviderApi(value, "api"),
    baseUrl: readNullableString(value, "baseUrl"),
    apiKeyRef: readNullableApiKeyRef(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readNullableBoolean(value, "authHeader"),
    reasoning: readNullableBoolean(value, "reasoning"),
    input: readOptionalStringArray(value, "input", ["text", "image"]),
    contextWindow: readNullableNumber(value, "contextWindow"),
    maxTokens: readNullableNumber(value, "maxTokens"),
    compat: isRecord(value.compat) ? value.compat : undefined,
    capabilities: value.capabilities === undefined ? undefined : readProviderCapabilities(value, "capabilities"),
    enabled: readOptionalBoolean(value, "enabled"),
  };

  return input;
}

function parseProviderPresetUpdateRequest(value: unknown): ProviderPresetUpdateRequest {
  if (!isRecord(value)) {
    throw new Error("Provider preset update must be a JSON object");
  }
  const apiKey = readOptionalApiKey(value);
  const clearApiKey = readOptionalBoolean(value, "clearApiKey") ?? false;
  if (apiKey && clearApiKey) {
    throw new Error("apiKey and clearApiKey cannot both be provided");
  }
  return {
    updateInput: parseProviderPresetUpdateInput(value),
    apiKey,
    clearApiKey,
  };
}

function parseProviderModelListRequest(value: unknown): ProviderModelListRequest {
  if (!isRecord(value)) {
    throw new Error("Provider model list request must be a JSON object");
  }
  return {
    kind: readProviderKind(value, "kind"),
    providerId: readString(value, "providerId"),
    api: readProviderApi(value, "api"),
    baseUrl: readOptionalString(value, "baseUrl"),
    apiKeyRef: readOptionalApiKeyRef(value),
    apiKey: readOptionalApiKey(value),
    headers: readOptionalStringRecord(value, "headers"),
    authHeader: readOptionalBoolean(value, "authHeader"),
  };
}

function providerUpdateWithSecretRef(providerId: string, input: ProviderPresetUpdateRequest): ProviderPresetUpdateInput {
  if (input.apiKey) {
    return { ...input.updateInput, apiKeyRef: localProviderSecretRef(providerId) };
  }
  if (input.clearApiKey) {
    return { ...input.updateInput, apiKeyRef: null };
  }
  return input.updateInput;
}

function saveLocalProviderSecret(store: RunStore, preset: ProviderPreset, apiKey: string, now: string): ProviderPreset {
  store.setProviderSecret(preset.id, apiKey, now);
  return store.updateProviderPreset(preset.id, { apiKeyRef: localProviderSecretRef(preset.id) }, now) ?? preset;
}

const draftProviderSecretRef = "keychain:LING_STACK_DRAFT_PROVIDER_API_KEY";

function providerDraftInputToPreset(input: ProviderPresetInput, apiKey: string | undefined, now: string): ProviderPreset {
  return {
    id: "provider_draft_check",
    kind: input.kind,
    displayName: input.displayName,
    providerId: input.providerId,
    model: input.model,
    api: input.api,
    baseUrl: input.baseUrl,
    apiKeyRef: apiKey ? draftProviderSecretRef : input.apiKeyRef,
    headers: input.headers ?? {},
    authHeader: input.authHeader,
    reasoning: input.reasoning,
    input: input.input ?? ["text"],
    contextWindow: input.contextWindow,
    maxTokens: input.maxTokens,
    compat: input.compat ?? {},
    capabilities: input.capabilities,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
}

function createDraftProviderSecretResolver(delegate: SecretResolver, apiKey: string): SecretResolver {
  return {
    status(ref: string, purpose?: SecretPurpose): SecretStatus {
      if (ref === draftProviderSecretRef) {
        return {
          ref,
          kind: "keychain",
          configured: true,
        };
      }
      return delegate.status(ref, purpose);
    },
    resolve(ref: string, purpose?: SecretPurpose): ResolvedSecret {
      const status = this.status(ref, purpose);
      if (ref === draftProviderSecretRef) {
        return {
          ref,
          configured: true,
          value: apiKey,
          status,
        };
      }
      return delegate.resolve(ref, purpose);
    },
  };
}

function localProviderSecretRef(providerId: string): string {
  return `local:${providerId}`;
}

function providerSecretStatus(store: RunStore, preset: Pick<ProviderPreset, "id" | "apiKeyRef">, secretResolver: SecretResolver): SecretStatus {
  if (!preset.apiKeyRef) {
    return {
      ref: "",
      kind: "local",
      configured: false,
      errorCode: "secret_missing",
      message: "API key missing.",
    };
  }
  if (isLocalProviderSecretRef(preset.apiKeyRef)) {
    const providerId = readLocalProviderSecretProviderId(preset.apiKeyRef);
    const validLocalRef = providerId === preset.id;
    const configured = validLocalRef && store.hasProviderSecret(providerId);
    return {
      ref: preset.apiKeyRef,
      kind: "local",
      configured,
      errorCode: configured ? undefined : validLocalRef ? "secret_missing" : "invalid_secret_ref",
      message: configured ? undefined : validLocalRef ? "API key missing. Add an API key before checking this preset." : "Local API key ref does not match this provider.",
    };
  }
  return secretResolver.status(preset.apiKeyRef, "provider_api_key");
}

function resolveProviderSecret(store: RunStore, preset: Pick<ProviderPreset, "id" | "apiKeyRef">, secretResolver: SecretResolver): ResolvedSecret {
  if (!preset.apiKeyRef) {
    return { configured: false };
  }
  if (isLocalProviderSecretRef(preset.apiKeyRef)) {
    const status = providerSecretStatus(store, preset, secretResolver);
    if (!status.configured) {
      return { ref: preset.apiKeyRef, configured: false, status };
    }
    return {
      ref: preset.apiKeyRef,
      configured: true,
      value: store.getProviderSecret(readLocalProviderSecretProviderId(preset.apiKeyRef)),
      status,
    };
  }
  return secretResolver.resolve(preset.apiKeyRef, "provider_api_key");
}

function isLocalProviderSecretRef(ref: string): boolean {
  return ref.startsWith("local:");
}

function readLocalProviderSecretProviderId(ref: string): string {
  return ref.slice("local:".length);
}

function validateProviderPresetInput(input: ProviderPresetInput): ProviderPresetInput {
  validateProviderPresetShape(input);
  return input;
}

function validateProviderPresetUpdate(existing: ProviderPreset, input: ProviderPresetUpdateInput): void {
  validateProviderPresetShape({
    kind: input.kind ?? existing.kind,
    displayName: input.displayName ?? existing.displayName,
    providerId: input.providerId ?? existing.providerId,
    model: input.model ?? existing.model,
    api: input.api ?? existing.api,
    baseUrl: input.baseUrl === null ? undefined : input.baseUrl ?? existing.baseUrl,
    apiKeyRef: input.apiKeyRef === null ? undefined : input.apiKeyRef ?? existing.apiKeyRef,
    capabilities: input.capabilities ?? existing.capabilities,
  });
}

function validateProviderPresetShape(input: {
  readonly kind?: ProviderKind;
  readonly displayName?: string;
  readonly providerId?: string;
  readonly model?: string;
  readonly api?: ProviderApi;
  readonly baseUrl?: string | null;
  readonly apiKeyRef?: string | null;
  readonly capabilities?: readonly ProviderCapability[];
}): void {
  if (!input.displayName?.trim()) {
    throw new Error("displayName must be a non-empty string");
  }
  if (!input.providerId?.trim()) {
    throw new Error("providerId must be a non-empty string");
  }
  if (input.providerId && !/^[A-Za-z0-9._-]+$/.test(input.providerId)) {
    throw new Error("providerId may only contain letters, numbers, dot, underscore, and dash");
  }
  if (!input.model?.trim()) {
    throw new Error("model must be a non-empty string");
  }
  if (input.kind === "openai-compatible" && !input.baseUrl) {
    throw new Error("baseUrl is required for openai-compatible providers");
  }
  if (input.baseUrl) {
    validateUrl(input.baseUrl, "baseUrl");
  }
  if (input.apiKeyRef && !isSupportedProviderApiKeyRef(input.apiKeyRef)) {
    throw new Error("apiKeyRef must use env:NAME or keychain:NAME");
  }
  if (!input.capabilities || input.capabilities.length === 0) {
    throw new Error("capabilities must contain at least one capability");
  }
  if (input.api === "media-job") {
    const hasMediaCapability = input.capabilities.some((capability) =>
      ["image_generate", "image_edit", "video_generate"].includes(capability),
    );
    if (!hasMediaCapability) {
      throw new Error("media-job providers must include a media capability");
    }
    return;
  }
  if (!input.capabilities.includes("chat")) {
    throw new Error("coding provider presets must include chat capability");
  }
}

function toPublicProviderPreset(store: RunStore, preset: ProviderPreset, secretResolver: SecretResolver): PublicProviderPreset {
  const apiKeyStatus = preset.apiKeyRef ? providerSecretStatus(store, preset, secretResolver) : undefined;
  return {
    ...preset,
    apiKeyConfigured: apiKeyStatus?.configured ?? false,
    apiKeyStatus,
  };
}

function toProviderSecretResponse(store: RunStore, preset: ProviderPreset): { readonly providerId: string; readonly apiKey: string; readonly apiKeyRef?: string; readonly configured: boolean } {
  if (!preset.apiKeyRef || !isLocalProviderSecretRef(preset.apiKeyRef)) {
    return {
      providerId: preset.id,
      apiKey: "",
      apiKeyRef: preset.apiKeyRef,
      configured: false,
    };
  }
  const providerId = readLocalProviderSecretProviderId(preset.apiKeyRef);
  const validLocalRef = providerId === preset.id;
  const apiKey = validLocalRef ? store.getProviderSecret(providerId) ?? "" : "";
  return {
    providerId: preset.id,
    apiKey,
    apiKeyRef: preset.apiKeyRef,
    configured: apiKey.length > 0,
  };
}

async function checkProviderPreset(store: RunStore, preset: ProviderPreset, secretResolver: SecretResolver): Promise<ProviderCheckResult> {
  const checkedAt = new Date().toISOString();
  if (preset.baseUrl) {
    try {
      validateUrl(preset.baseUrl, "baseUrl");
    } catch (error) {
      return { ok: false, code: "bad_request", message: error instanceof Error ? error.message : String(error), checkedAt };
    }
  }
  const needsSecret = preset.api === "anthropic-messages" || preset.authHeader !== false;
  if (needsSecret && !preset.apiKeyRef) {
    return { ok: false, code: "secret_missing", message: "API key missing. Add an API key before running a live check.", checkedAt };
  }
  if (preset.apiKeyRef) {
    const secretStatus = providerSecretStatus(store, preset, secretResolver);
    if (!secretStatus.configured) {
      return {
        ok: false,
        code: secretStatus.errorCode ?? "secret_missing",
        message: secretStatus.message ?? `API key missing: ${preset.apiKeyRef} is not configured.`,
        checkedAt,
      };
    }
  }
  if (preset.api !== "media-job" && !preset.capabilities.includes("chat")) {
    return { ok: false, code: "unsupported_capability", message: "Provider preset cannot run chat tasks.", checkedAt };
  }
  if (!preset.enabled) {
    return { ok: false, code: "provider_disabled", message: "Provider preset is disabled.", checkedAt };
  }

  if (preset.api === "media-job") {
    const gate = resolveMediaVendorTransportGateConfig(preset.compat);
    if (!gate.ok) {
      return {
        ok: false,
        code: gate.errorCode ?? "invalid_request",
        message: gate.errorMessage ?? "Invalid media vendor transport configuration.",
        checkedAt,
      };
    }
    if (gate.config?.mode === "live") {
      if (!preset.baseUrl) {
        return { ok: false, code: "bad_request", message: "baseUrl is required for live media vendor transport.", checkedAt };
      }
      if (!preset.apiKeyRef) {
        return { ok: false, code: "secret_missing", message: "API key missing. Add an API key before enabling live media vendor transport.", checkedAt };
      }
      const secretStatus = providerSecretStatus(store, preset, secretResolver);
      if (!secretStatus.configured) {
        return {
          ok: false,
          code: secretStatus.errorCode ?? "secret_missing",
          message: secretStatus.message ?? `API key missing: ${preset.apiKeyRef} is not configured.`,
          checkedAt,
        };
      }
      if (preset.kind !== "seedream" || !preset.capabilities.includes("image_generate")) {
        return {
          ok: false,
          code: "unsupported_capability",
          message: "Live media vendor transport currently supports Seedream image_generate only.",
          checkedAt,
        };
      }
      return {
        ok: true,
        code: "static_check",
        message: "Seedream image_generate live transport configuration is complete. Provider check does not create media or make generation requests.",
        checkedAt,
      };
    }
    return {
      ok: true,
      code: "static_check",
      message: "Media provider configuration is valid. Media vendor transport is disabled by default and no live vendor HTTP request will be made.",
      checkedAt,
    };
  }

  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(preset.api)) {
    return {
      ok: true,
      code: "static_check",
      message: `Provider configuration is valid. Live checks for ${preset.api} are not implemented yet.`,
      checkedAt,
    };
  }

  return await probeChatProvider(store, preset, checkedAt, secretResolver);
}

async function listProviderModels(
  store: RunStore,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): Promise<ProviderModelListResponse> {
  const preset = providerModelListInputToPreset(input);
  if (preset.baseUrl) {
    validateUrl(preset.baseUrl, "baseUrl");
  }
  if (preset.api === "media-job") {
    throw new HttpError(400, "unsupported_capability", "Model discovery is available for chat providers only.");
  }
  if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(preset.api)) {
    throw new HttpError(400, "unsupported_capability", `Model discovery is not implemented for ${preset.api}.`);
  }
  const secret = resolveProviderModelListSecret(store, preset, input, secretResolver);
  if ((preset.api === "anthropic-messages" || preset.authHeader !== false) && !secret.configured) {
    throw new HttpError(400, "secret_missing", "API key missing. Add an API key before fetching models.");
  }

  const source = buildProviderModelsUrl(preset);
  try {
    const response = await fetch(source, {
      method: "GET",
      headers: buildProviderModelsHeaders(preset, secret),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new HttpError(
        response.status === 401 || response.status === 403 ? 401 : 400,
        response.status === 401 || response.status === 403 ? "auth_failed" : "provider_error",
        await providerModelListFailureMessage(response, secret.value),
      );
    }
    const body = await response.json() as unknown;
    return {
      source,
      models: parseProviderModelsResponse(body),
    };
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }
    throw new HttpError(
      400,
      "network_failed",
      `Provider model discovery failed: ${redactTextWithSecrets(error instanceof Error ? error.message : String(error), [secret.value])}`,
    );
  }
}

function providerModelListInputToPreset(input: ProviderModelListRequest): ProviderPreset {
  return {
    id: "provider_model_probe",
    kind: input.kind,
    displayName: "Provider model probe",
    providerId: input.providerId,
    model: "model-probe",
    api: input.api,
    baseUrl: input.baseUrl,
    apiKeyRef: input.apiKey ? "__request_api_key__" : input.apiKeyRef,
    headers: input.headers ?? {},
    authHeader: input.authHeader ?? true,
    reasoning: false,
    input: ["text"],
    compat: {},
    capabilities: ["chat"],
    enabled: true,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
}

function resolveProviderModelListSecret(
  store: RunStore,
  preset: ProviderPreset,
  input: ProviderModelListRequest,
  secretResolver: SecretResolver,
): ResolvedSecret {
  if (input.apiKey) {
    return {
      ref: "__request_api_key__",
      configured: true,
      value: input.apiKey,
      status: {
        ref: "__request_api_key__",
        kind: "local",
        configured: true,
      },
    };
  }
  return preset.apiKeyRef ? resolveProviderSecret(store, preset, secretResolver) : { configured: false };
}

function buildProviderModelsUrl(preset: ProviderPreset): string {
  return `${normalizeProviderBaseUrl(preset)}/models`;
}

function buildProviderModelsHeaders(preset: ProviderPreset, secret: ResolvedSecret): Record<string, string> {
  const headers: Record<string, string> = { ...preset.headers };
  if (preset.api === "anthropic-messages") {
    if (secret.value) {
      headers["x-api-key"] = secret.value;
    }
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    return headers;
  }
  if (preset.authHeader !== false && secret.value) {
    headers.Authorization = `Bearer ${secret.value}`;
  }
  return headers;
}

async function providerModelListFailureMessage(response: Response, secret?: string): Promise<string> {
  const bodyText = redactTextWithSecrets(await readLimitedResponseText(response, 800), [secret]);
  return `Provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`;
}

function parseProviderModelsResponse(body: unknown): readonly ProviderModelOption[] {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : [];
  const models: ProviderModelOption[] = [];
  const seen = new Set<string>();
  for (const item of data) {
    const model = parseProviderModelOption(item);
    if (!model || seen.has(model.id)) {
      continue;
    }
    seen.add(model.id);
    models.push(model);
    if (models.length >= 200) {
      break;
    }
  }
  return models;
}

function parseProviderModelOption(value: unknown): ProviderModelOption | undefined {
  if (typeof value === "string") {
    const id = value.trim();
    return id ? { id } : undefined;
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const id = typeof value.id === "string"
    ? value.id.trim()
    : typeof value.name === "string"
      ? value.name.trim()
      : "";
  if (!id) {
    return undefined;
  }
  return removeUndefined({
    id,
    displayName: typeof value.display_name === "string" ? value.display_name : typeof value.displayName === "string" ? value.displayName : undefined,
    ownedBy: typeof value.owned_by === "string" ? value.owned_by : typeof value.ownedBy === "string" ? value.ownedBy : undefined,
    createdAt: typeof value.created_at === "string" ? value.created_at : undefined,
  });
}

async function probeChatProvider(store: RunStore, preset: ProviderPreset, checkedAt: string, secretResolver: SecretResolver): Promise<ProviderCheckResult> {
  try {
    const response = await fetch(buildProviderCheckUrl(preset), {
      method: "POST",
      headers: buildProviderCheckHeaders(store, preset, secretResolver),
      body: JSON.stringify(buildProviderCheckBody(preset)),
      signal: AbortSignal.timeout(PROVIDER_CHECK_TIMEOUT_MS),
    });

    if (response.ok) {
      return {
        ok: true,
        code: "ready",
        message: "Provider is reachable and accepted the configured model.",
        checkedAt,
      };
    }

    return await providerCheckHttpFailure(response, checkedAt);
  } catch (error) {
    return {
      ok: false,
      code: "network_failed",
      message: `Provider network check failed: ${error instanceof Error ? error.message : String(error)}`,
      checkedAt,
    };
  }
}

function buildProviderCheckUrl(preset: ProviderPreset): string {
  const baseUrl = normalizeProviderBaseUrl(preset);
  if (preset.api === "anthropic-messages") {
    return `${baseUrl}/messages`;
  }
  if (preset.api === "openai-responses") {
    return `${baseUrl}/responses`;
  }
  return `${baseUrl}/chat/completions`;
}

function normalizeProviderBaseUrl(preset: ProviderPreset): string {
  if (preset.baseUrl) {
    return preset.baseUrl.replace(/\/+$/, "");
  }
  if (preset.api === "anthropic-messages" || preset.kind === "anthropic") {
    return "https://api.anthropic.com/v1";
  }
  return "https://api.openai.com/v1";
}

function buildProviderCheckHeaders(store: RunStore, preset: ProviderPreset, secretResolver: SecretResolver): Record<string, string> {
  const secret: ResolvedSecret = preset.apiKeyRef ? resolveProviderSecret(store, preset, secretResolver) : { configured: false };
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...preset.headers,
  };

  if (preset.api === "anthropic-messages") {
    if (secret.value) {
      headers["x-api-key"] = secret.value;
    }
    headers["anthropic-version"] = headers["anthropic-version"] ?? "2023-06-01";
    return headers;
  }

  if (preset.authHeader !== false && secret.value) {
    headers.Authorization = `Bearer ${secret.value}`;
  }
  return headers;
}

function buildProviderCheckBody(preset: ProviderPreset): Record<string, unknown> {
  if (preset.api === "anthropic-messages") {
    return {
      model: preset.model,
      max_tokens: 8,
      messages: [{ role: "user", content: "Reply with OK." }],
    };
  }
  if (preset.api === "openai-responses") {
    return {
      model: preset.model,
      input: "Reply with OK.",
      max_output_tokens: 8,
      stream: false,
    };
  }
  return {
    model: preset.model,
    messages: [{ role: "user", content: "Reply with OK." }],
    max_tokens: 8,
    stream: false,
  };
}

async function providerCheckHttpFailure(response: Response, checkedAt: string): Promise<ProviderCheckResult> {
  const bodyText = await readLimitedResponseText(response, 800);
  const lowerBody = bodyText.toLowerCase();
  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: "auth_failed",
      message: `Provider authentication failed with HTTP ${response.status}. Check the API key and account access.`,
      checkedAt,
    };
  }
  if (response.status === 404 || lowerBody.includes("model") && (lowerBody.includes("not found") || lowerBody.includes("does not exist"))) {
    return {
      ok: false,
      code: "model_unsupported",
      message: `Provider rejected the endpoint or model with HTTP ${response.status}. Check baseUrl and model.`,
      checkedAt,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      code: "rate_limited",
      message: "Provider is reachable but rate limited the health check.",
      checkedAt,
    };
  }
  return {
    ok: false,
    code: "provider_error",
    message: `Provider returned HTTP ${response.status}${bodyText ? `: ${bodyText}` : "."}`,
    checkedAt,
  };
}

async function readLimitedResponseText(response: Response, limit: number): Promise<string> {
  try {
    const text = await response.text();
    return text.length > limit ? `${text.slice(0, limit)}...` : text;
  } catch {
    return "";
  }
}

function resolveConfig(config: DaemonConfig): ResolvedDaemonConfig {
  return {
    host: config.host ?? "127.0.0.1",
    port: config.port ?? 17891,
    maxBodyBytes: config.maxBodyBytes ?? 1024 * 1024,
    defaultWorkspaceCwd: resolvePath(config.defaultWorkspaceCwd ?? process.env.LING_STACK_DEFAULT_WORKSPACE_CWD ?? process.cwd()),
  };
}

function writeJson(response: ServerResponse, statusCode: number, body: unknown): void {
  setCorsHeaders(response);
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body)}\n`);
}

function writeSseHead(response: ServerResponse): void {
  setCorsHeaders(response);
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  response.write(": ling-stack run stream\n\n");
}

function writeSse(response: ServerResponse, event: string, data: unknown): void {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function setCorsHeaders(response: ServerResponse): void {
  response.setHeader("Access-Control-Allow-Origin", "*");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
}

function matchSingleSegmentRoute(pathname: string, prefix: string): string | undefined {
  const routePrefix = `${prefix}/`;
  if (!pathname.startsWith(routePrefix)) {
    return undefined;
  }
  const segment = pathname.slice(routePrefix.length);
  if (!segment || segment.includes("/")) {
    return undefined;
  }
  return decodeURIComponent(segment);
}

function readString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${key} must be a non-empty string`);
  }
  return value;
}

function readStringAllowEmpty(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readOptionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  return value;
}

function readNullableString(record: Record<string, unknown>, key: string): string | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string or null`);
  }
  return value;
}

function readOptionalBoolean(record: Record<string, unknown>, key: string): boolean | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean`);
  }
  return value;
}

function readNullableBoolean(record: Record<string, unknown>, key: string): boolean | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${key} must be a boolean or null`);
  }
  return value;
}

function readOptionalNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number`);
  }
  return value;
}

function readNullableNumber(record: Record<string, unknown>, key: string): number | null | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${key} must be a finite number or null`);
  }
  return value;
}

function readOptionalStringRecord(record: Record<string, unknown>, key: string): Record<string, string> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const result: Record<string, string> = {};
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (typeof entryValue !== "string") {
      throw new Error(`${key}.${entryKey} must be a string`);
    }
    result[entryKey] = entryValue;
  }
  return result;
}

function readOptionalObject(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return value;
}

function readOptionalApiKey(record: Record<string, unknown>): string | undefined {
  const value = record.apiKey;
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error("apiKey must be a string");
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readOptionalApiKeyRef(record: Record<string, unknown>): string | undefined {
  const value = readOptionalString(record, "apiKeyRef");
  if (value && !isSupportedProviderApiKeyRef(value)) {
    throw new Error("apiKeyRef must use env:NAME or keychain:NAME");
  }
  return value;
}

function readNullableApiKeyRef(record: Record<string, unknown>): string | null | undefined {
  const value = readNullableString(record, "apiKeyRef");
  if (typeof value === "string" && !isSupportedProviderApiKeyRef(value)) {
    throw new Error("apiKeyRef must use env:NAME or keychain:NAME");
  }
  return value;
}

function isSupportedProviderApiKeyRef(value: string): boolean {
  return isSupportedSecretRef(value) || isValidLocalProviderSecretRef(value);
}

function isValidLocalProviderSecretRef(value: string): boolean {
  if (!isLocalProviderSecretRef(value)) {
    return false;
  }
  const providerId = readLocalProviderSecretProviderId(value);
  return providerId.trim() === providerId && providerId.length > 0 && !/\s/.test(providerId);
}

function readOptionalStringArray<T extends string = string>(
  record: Record<string, unknown>,
  key: string,
  allowed?: readonly T[],
): T[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (typeof item !== "string") {
      throw new Error(`${key}[${index}] must be a string`);
    }
    if (allowed && !allowed.includes(item as T)) {
      throw new Error(`${key}[${index}] must be one of: ${allowed.join(", ")}`);
    }
    return item as T;
  });
}

function readOptionalRunTools(record: Record<string, unknown>, key: string): RunTool[] | undefined {
  return readOptionalStringArray(record, key, [...readOnlyRunTools, "bash", "edit", "write"] as const);
}

function readOptionalChannelExecutionProposalSteps(
  record: Record<string, unknown>,
  key: string,
): ChannelExecutionProposalStep[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const action = readString(item, "action");
    if (action !== "coordinated" && action !== "consulted" && action !== "reviewed" && action !== "flagged_risk") {
      throw new Error(`${key}[${index}].action must be one of: coordinated, consulted, reviewed, flagged_risk`);
    }
    return {
      teammateId: readString(item, "teammateId"),
      action,
      summary: readString(item, "summary"),
    };
  });
}

function readOptionalChannelExecutionProposalStatus(
  record: Record<string, unknown>,
  key: string,
): ChannelExecutionProposalStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "draft" && value !== "accepted" && value !== "cancelled" && value !== "superseded" && value !== "blocked" && value !== "run_failed") {
    throw new Error(`${key} must be one of: draft, accepted, cancelled, superseded, blocked, run_failed`);
  }
  return value;
}

function readAiTeammateRoleKey(record: Record<string, unknown>, key: string): CreateAiTeammateInput["roleKey"] {
  const value = readString(record, key);
  if (!["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"].includes(value)) {
    throw new Error(`${key} must be a supported AI teammate role`);
  }
  return value as CreateAiTeammateInput["roleKey"];
}

function readOptionalAiTeammateRoleKey(record: Record<string, unknown>, key: string): AiTeammateUpdateInput["roleKey"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!["product", "architect", "engineer", "designer", "qa", "security", "release", "docs", "custom"].includes(value)) {
    throw new Error(`${key} must be a supported AI teammate role`);
  }
  return value as AiTeammateUpdateInput["roleKey"];
}

function readOptionalAiTeammateStatus(record: Record<string, unknown>, key: string): CreateAiTeammateInput["status"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "active" && value !== "paused" && value !== "disabled") {
    throw new Error(`${key} must be one of: active, paused, disabled`);
  }
  return value;
}

function readApprovalProfile(record: Record<string, unknown>, key: string): SkillApprovalProfile {
  const value = record[key];
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return parseApprovalProfileObject(value, key);
}

function readOptionalApprovalProfile(record: Record<string, unknown>, key: string): SkillApprovalProfile | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  return parseApprovalProfileObject(value, key);
}

function parseApprovalProfileObject(value: Record<string, unknown>, key: string): SkillApprovalProfile {
  if (value.mode !== "none" && value.mode !== "standard" && value.mode !== "strict") {
    throw new Error(`${key}.mode must be one of: none, standard, strict`);
  }
  const requiredForTools = readOptionalStringArray(value, "requiredForTools", [...readOnlyRunTools, "bash", "edit", "write"] as const);
  const requiredForActions = readOptionalStringArray(value, "requiredForActions", [
    "write",
    "edit",
    "bash",
    "git_commit",
    "git_push",
    "external_send",
    "deploy",
    "media_cost",
    "credential_change",
    "provider_change",
  ] as const);
  const risk = readOptionalString(value, "risk");
  if (risk !== undefined && risk !== "low" && risk !== "medium" && risk !== "high" && risk !== "critical") {
    throw new Error(`${key}.risk must be one of: low, medium, high, critical`);
  }
  return {
    mode: value.mode,
    ...(risk ? { risk: risk as SkillApprovalProfile["risk"] } : {}),
    ...(requiredForTools ? { requiredForTools } : {}),
    ...(requiredForActions ? { requiredForActions } : {}),
  };
}

function readTeammateMemoryScopeKind(record: Record<string, unknown>, key: string): ReplaceTeammateMemoryScopeInput["kind"] {
  const value = readString(record, key);
  if (value !== "channel-brief" && value !== "channel-decisions" && value !== "private-chat-summary" && value !== "private-notes") {
    throw new Error(`${key} must be a supported memory scope kind`);
  }
  return value;
}

function readOptionalApprovalToolDecisions(
  record: Record<string, unknown>,
  key: string,
): Partial<Record<RunTool, ApprovalToolDecision>> | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }

  const result: Partial<Record<RunTool, ApprovalToolDecision>> = {};
  const validTools = Object.keys(defaultApprovalToolDecisions) as RunTool[];
  for (const [tool, decision] of Object.entries(value)) {
    if (!validTools.includes(tool as RunTool)) {
      throw new Error(`${key}.${tool} is not a supported tool`);
    }
    if (typeof decision !== "string" || !approvalToolDecisions.includes(decision as ApprovalToolDecision)) {
      throw new Error(`${key}.${tool} must be one of: ${approvalToolDecisions.join(", ")}`);
    }
    result[tool as RunTool] = decision as ApprovalToolDecision;
  }
  return result;
}

function readOptionalTaskStatus(record: Record<string, unknown>, key: string): TaskStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`${key} must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function readOptionalChannelMessageKind(record: Record<string, unknown>, key: string): ChannelMessageKind | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "message" && value !== "ai_reply" && value !== "system" && value !== "task_link") {
    throw new Error(`${key} must be one of: message, ai_reply, system, task_link`);
  }
  return value;
}

function readOptionalChannelMessageIntent(record: Record<string, unknown>, key: string): ChannelMessageIntent | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "discuss" && value !== "task") {
    throw new Error(`${key} must be one of: discuss, task`);
  }
  return value;
}

function readOptionalChannelMessageAuthorType(record: Record<string, unknown>, key: string): ChannelMessageAuthorType | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "local-user" && value !== "ai-teammate" && value !== "system") {
    throw new Error(`${key} must be one of: local-user, ai-teammate, system`);
  }
  return value;
}

function readOptionalChannelDecisionStatus(record: Record<string, unknown>, key: string): ChannelDecisionStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelDecisionStatuses.includes(value as ChannelDecisionStatus)) {
    throw new Error(`${key} must be one of: ${channelDecisionStatuses.join(", ")}`);
  }
  return value as ChannelDecisionStatus;
}

function readOptionalChannelHandoffStatus(record: Record<string, unknown>, key: string): ChannelHandoffStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelHandoffStatuses.includes(value as ChannelHandoffStatus)) {
    throw new Error(`${key} must be one of: ${channelHandoffStatuses.join(", ")}`);
  }
  return value as ChannelHandoffStatus;
}

function readOptionalChannelWorkflowStatus(record: Record<string, unknown>, key: string): ChannelWorkflowStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelWorkflowStatuses.includes(value as ChannelWorkflowStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStatus;
}

function readOptionalChannelWorkflowStepStatus(record: Record<string, unknown>, key: string): ChannelWorkflowStepStatus | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelWorkflowStepStatuses.includes(value as ChannelWorkflowStepStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStepStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStepStatus;
}

function readChannelWorkflowStepStartMode(record: Record<string, unknown>, key: string): ChannelWorkflowStepStartMode {
  const value = readString(record, key);
  if (value !== "create_task" && value !== "create_and_run_task") {
    throw new Error(`${key} must be one of: create_task, create_and_run_task`);
  }
  return value;
}

function readChannelContextSummaryTargetType(record: Record<string, unknown>, key: string): ChannelContextSummaryTargetType {
  const value = readString(record, key);
  if (!channelContextSummaryTargetTypes.includes(value as ChannelContextSummaryTargetType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryTargetTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryTargetType;
}

function readOptionalChannelContextSummaryTargetType(
  record: Record<string, unknown>,
  key: string,
): ChannelContextSummaryTargetType | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelContextSummaryTargetTypes.includes(value as ChannelContextSummaryTargetType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryTargetTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryTargetType;
}

function readChannelContextSummaryAuthorType(record: Record<string, unknown>, key: string): ChannelContextSummaryAuthorType {
  const value = readString(record, key);
  if (!channelContextSummaryAuthorTypes.includes(value as ChannelContextSummaryAuthorType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryAuthorTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryAuthorType;
}

function readOptionalChannelContextSummaryAuthorType(
  record: Record<string, unknown>,
  key: string,
): ChannelContextSummaryAuthorType | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (!channelContextSummaryAuthorTypes.includes(value as ChannelContextSummaryAuthorType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryAuthorTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryAuthorType;
}

function readOptionalChannelMentions(record: Record<string, unknown>, key: string): ChannelMention[] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error(`${key} must be an array`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new Error(`${key}[${index}] must be an object`);
    }
    const id = readString(item, "id");
    const label = readString(item, "label");
    const kind = readString(item, "kind");
    if (kind !== "ai-teammate" && kind !== "local-user" && kind !== "channel") {
      throw new Error(`${key}[${index}].kind must be one of: ai-teammate, local-user, channel`);
    }
    return { id, label, kind };
  });
}

function readOptionalChannelStatus(record: Record<string, unknown>, key: string): Channel["status"] | undefined {
  const value = readOptionalString(record, key);
  if (value === undefined) {
    return undefined;
  }
  if (value !== "active" && value !== "paused" && value !== "archived") {
    throw new Error(`${key} must be one of: active, paused, archived`);
  }
  return value;
}

function readOptionalChannelRuntimePolicy(
  record: Record<string, unknown>,
  key: string,
): CreateChannelInput["runtimePolicy"] | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value)) {
    throw new Error(`${key} must be an object`);
  }
  const policy: {
    maxConcurrentRuns?: number;
    executionMode?: "serial" | "parallel";
    writeLockScope?: "channel" | "boundPath" | "workspace";
    allowReadOnlyParallel?: boolean;
    queueOnConflict?: boolean;
  } = {};
  const maxConcurrentRuns = value.maxConcurrentRuns;
  if (maxConcurrentRuns !== undefined) {
    if (typeof maxConcurrentRuns !== "number" || !Number.isInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > 20) {
      throw new Error(`${key}.maxConcurrentRuns must be an integer between 1 and 20`);
    }
    policy.maxConcurrentRuns = maxConcurrentRuns;
  }
  if (value.executionMode !== undefined) {
    if (value.executionMode !== "serial" && value.executionMode !== "parallel") {
      throw new Error(`${key}.executionMode must be serial or parallel`);
    }
    policy.executionMode = value.executionMode;
  }
  if (value.writeLockScope !== undefined) {
    if (value.writeLockScope !== "channel" && value.writeLockScope !== "boundPath" && value.writeLockScope !== "workspace") {
      throw new Error(`${key}.writeLockScope must be channel, boundPath, or workspace`);
    }
    policy.writeLockScope = value.writeLockScope;
  }
  if (value.allowReadOnlyParallel !== undefined) {
    if (typeof value.allowReadOnlyParallel !== "boolean") {
      throw new Error(`${key}.allowReadOnlyParallel must be a boolean`);
    }
    policy.allowReadOnlyParallel = value.allowReadOnlyParallel;
  }
  if (value.queueOnConflict !== undefined) {
    if (typeof value.queueOnConflict !== "boolean") {
      throw new Error(`${key}.queueOnConflict must be a boolean`);
    }
    policy.queueOnConflict = value.queueOnConflict;
  }
  return policy;
}

function readProviderKind(record: Record<string, unknown>, key: string): ProviderKind {
  const value = readString(record, key);
  if (!providerKinds.includes(value as ProviderKind)) {
    throw new Error(`${key} must be one of: ${providerKinds.join(", ")}`);
  }
  return value as ProviderKind;
}

function readProviderApi(record: Record<string, unknown>, key: string): ProviderApi {
  const value = readString(record, key);
  if (!providerApis.includes(value as ProviderApi)) {
    throw new Error(`${key} must be one of: ${providerApis.join(", ")}`);
  }
  return value as ProviderApi;
}

function readProviderCapabilities(record: Record<string, unknown>, key: string): ProviderCapability[] {
  return readOptionalStringArray(record, key, providerCapabilities)?.map((capability) => capability as ProviderCapability) ?? [];
}

function readMediaOperation(record: Record<string, unknown>, key: string): MediaOperation {
  const value = readString(record, key);
  if (!mediaOperations.includes(value as MediaOperation)) {
    throw new Error(`${key} must be one of: ${mediaOperations.join(", ")}`);
  }
  return value as MediaOperation;
}

function readOptionalThinkingLevel(record: Record<string, unknown>, key: string): RunRequest["thinkingLevel"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "off",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
  ])?.[0];
}

function readOptionalProviderApi(record: Record<string, unknown>, key: string): PiRunnerProviderConfig["api"] {
  return readOptionalStringArray({ [key]: record[key] === undefined ? undefined : [record[key]] }, key, [
    "openai-completions",
    "openai-responses",
    "anthropic-messages",
    "google-generative-ai",
    "mistral-conversations",
  ])?.[0];
}

function readOptionalIntegerQuery(url: URL, key: string, minValue: number): number | undefined {
  const rawValue = url.searchParams.get(key);
  if (rawValue === null) {
    return undefined;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < minValue || String(value) !== rawValue) {
    throw new Error(`${key} must be an integer greater than or equal to ${minValue}`);
  }
  return value;
}

function readOptionalRunStatusQuery(url: URL): RunStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!["queued", "running", "waiting_for_approval", "succeeded", "failed", "cancelled"].includes(value)) {
    throw new Error("status must be one of: queued, running, waiting_for_approval, succeeded, failed, cancelled");
  }
  return value as RunStatus;
}

function readOptionalTaskStatusQuery(url: URL): TaskStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!taskStatuses.includes(value as TaskStatus)) {
    throw new Error(`status must be one of: ${taskStatuses.join(", ")}`);
  }
  return value as TaskStatus;
}

function readOptionalChannelExecutionProposalStatusQuery(url: URL): ChannelExecutionProposalStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (value !== "draft" && value !== "accepted" && value !== "cancelled" && value !== "superseded" && value !== "blocked" && value !== "run_failed") {
    throw new Error("status must be one of: draft, accepted, cancelled, superseded, blocked, run_failed");
  }
  return value;
}

function readOptionalApprovalStatusQuery(url: URL): ApprovalStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!approvalStatuses.includes(value as ApprovalStatus)) {
    throw new Error(`status must be one of: ${approvalStatuses.join(", ")}`);
  }
  return value as ApprovalStatus;
}

function readOptionalChannelDecisionStatusQuery(url: URL, key: string): ChannelDecisionStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelDecisionStatuses.includes(value as ChannelDecisionStatus)) {
    throw new Error(`${key} must be one of: ${channelDecisionStatuses.join(", ")}`);
  }
  return value as ChannelDecisionStatus;
}

function readOptionalChannelHandoffStatusQuery(url: URL, key: string): ChannelHandoffStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelHandoffStatuses.includes(value as ChannelHandoffStatus)) {
    throw new Error(`${key} must be one of: ${channelHandoffStatuses.join(", ")}`);
  }
  return value as ChannelHandoffStatus;
}

function readOptionalChannelWorkflowStatusQuery(url: URL, key: string): ChannelWorkflowStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelWorkflowStatuses.includes(value as ChannelWorkflowStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStatus;
}

function readOptionalChannelWorkflowStepStatusQuery(url: URL, key: string): ChannelWorkflowStepStatus | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelWorkflowStepStatuses.includes(value as ChannelWorkflowStepStatus)) {
    throw new Error(`${key} must be one of: ${channelWorkflowStepStatuses.join(", ")}`);
  }
  return value as ChannelWorkflowStepStatus;
}

function readOptionalChannelContextSummaryTargetTypeQuery(
  url: URL,
  key: string,
): ChannelContextSummaryTargetType | undefined {
  const value = url.searchParams.get(key);
  if (value === null) {
    return undefined;
  }
  if (!channelContextSummaryTargetTypes.includes(value as ChannelContextSummaryTargetType)) {
    throw new Error(`${key} must be one of: ${channelContextSummaryTargetTypes.join(", ")}`);
  }
  return value as ChannelContextSummaryTargetType;
}

function readOptionalMediaJobStatusQuery(url: URL): MediaJobStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!mediaJobStatuses.includes(value as MediaJobStatus)) {
    throw new Error(`status must be one of: ${mediaJobStatuses.join(", ")}`);
  }
  return value as MediaJobStatus;
}

function readOptionalExternalSourceKindQuery(url: URL): ExternalSourceKind | undefined {
  const value = url.searchParams.get("sourceKind");
  if (value === null) {
    return undefined;
  }
  if (!externalSourceKinds.includes(value as ExternalSourceKind)) {
    throw new Error(`sourceKind must be one of: ${externalSourceKinds.join(", ")}`);
  }
  return value as ExternalSourceKind;
}

function readOptionalExternalWorkItemKindQuery(url: URL): ExternalWorkItemKind | undefined {
  const value = url.searchParams.get("workItemKind");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkItemKinds.includes(value as ExternalWorkItemKind)) {
    throw new Error(`workItemKind must be one of: ${externalWorkItemKinds.join(", ")}`);
  }
  return value as ExternalWorkItemKind;
}

function readOptionalExternalWorkActionKindQuery(url: URL): ExternalWorkActionKind | undefined {
  const value = url.searchParams.get("actionKind");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkActionKinds.includes(value as ExternalWorkActionKind)) {
    throw new Error(`actionKind must be one of: ${externalWorkActionKinds.join(", ")}`);
  }
  return value as ExternalWorkActionKind;
}

function readOptionalExternalWorkActionStatusQuery(url: URL): ExternalWorkActionStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkActionStatuses.includes(value as ExternalWorkActionStatus)) {
    throw new Error(`status must be one of: ${externalWorkActionStatuses.join(", ")}`);
  }
  return value as ExternalWorkActionStatus;
}

function readOptionalExternalWorkSchedulerStatusQuery(url: URL): ExternalWorkSchedulerStatus | undefined {
  const value = url.searchParams.get("schedulerStatus") ?? url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkSchedulerStatuses.includes(value as ExternalWorkSchedulerStatus)) {
    throw new Error(`schedulerStatus must be one of: ${externalWorkSchedulerStatuses.join(", ")}`);
  }
  return value as ExternalWorkSchedulerStatus;
}

function readOptionalExternalWorkCiTriageStatusQuery(url: URL): ExternalWorkCiTriageStatus | undefined {
  const value = url.searchParams.get("status");
  if (value === null) {
    return undefined;
  }
  if (!externalWorkCiTriageStatuses.includes(value as ExternalWorkCiTriageStatus)) {
    throw new Error(`status must be one of: ${externalWorkCiTriageStatuses.join(", ")}`);
  }
  return value as ExternalWorkCiTriageStatus;
}

function readExternalWorkActionProposeRequest(value: unknown): {
  readonly externalWorkId: string;
  readonly actionKind: ExternalWorkActionKind;
  readonly payload:
    | { readonly type: "github_comment"; readonly body: string }
    | { readonly type: "github_label"; readonly labels: readonly string[] }
    | { readonly type: "github_pr_review"; readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; readonly body: string };
  readonly approvalRequirement?: "standard" | "strict";
  readonly expiresAt?: string;
} {
  if (!isRecord(value)) {
    throw new Error("external work action proposal must be a JSON object");
  }
  const externalWorkId = readString(value, "externalWorkId");
  const actionKind = readString(value, "actionKind") as ExternalWorkActionKind;
  if (!externalWorkActionKinds.includes(actionKind)) {
    throw new Error(`actionKind must be one of: ${externalWorkActionKinds.join(", ")}`);
  }
  const payload = readOptionalObject(value, "payload");
  if (!payload) {
    throw new Error("payload must be an object");
  }
  const payloadType = readString(payload, "type");
  const approvalRequirement = readOptionalString(value, "approvalRequirement");
  if (approvalRequirement !== undefined && approvalRequirement !== "standard" && approvalRequirement !== "strict") {
    throw new Error("approvalRequirement must be standard or strict");
  }
  const parsedPayload = payloadType === "github_comment"
    ? { type: "github_comment" as const, body: readString(payload, "body") }
    : payloadType === "github_label"
      ? { type: "github_label" as const, labels: readOptionalStringArray(payload, "labels") ?? [] }
      : payloadType === "github_pr_review"
        ? readGitHubPrReviewPayload(payload)
        : undefined;
  if (!parsedPayload) {
    throw new Error("payload.type must be github_comment, github_label, or github_pr_review");
  }
  return {
    externalWorkId,
    actionKind,
    payload: parsedPayload,
    approvalRequirement,
    expiresAt: readOptionalString(value, "expiresAt"),
  };
}

function readGitHubPrReviewPayload(payload: Record<string, unknown>): {
  readonly type: "github_pr_review";
  readonly event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
  readonly body: string;
} {
  const event = readString(payload, "event");
  if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") {
    throw new Error("payload.event must be COMMENT, APPROVE, or REQUEST_CHANGES");
  }
  return {
    type: "github_pr_review",
    event,
    body: readString(payload, "body"),
  };
}

function readOptionalSecretPurposeQuery(url: URL): SecretPurpose | null | undefined {
  const value = url.searchParams.get("purpose");
  if (value === null) {
    return undefined;
  }
  if (!secretPurposes.includes(value as SecretPurpose)) {
    return null;
  }
  return value as SecretPurpose;
}

function validateUrl(value: string, fieldName: string): void {
  try {
    new URL(value);
  } catch {
    throw new Error(`${fieldName} must be a valid URL`);
  }
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

class DuplicateRunRequestError extends Error {
  constructor(readonly runId: string) {
    super(`Duplicate run request for ${runId}`);
  }
}

interface ActiveRun {
  readonly abortController: AbortController;
  readonly streamEnvelope: (envelope: RunEventEnvelope) => void;
}

class ActiveRunRegistry {
  private readonly activeRuns = new Map<string, ActiveRun>();

  add(runId: string, run: ActiveRun): void {
    this.activeRuns.set(runId, run);
  }

  get(runId: string): ActiveRun | undefined {
    return this.activeRuns.get(runId);
  }

  delete(runId: string): void {
    this.activeRuns.delete(runId);
  }

  cancelAll(): void {
    for (const run of this.activeRuns.values()) {
      run.abortController.abort();
    }
    this.activeRuns.clear();
  }
}

interface ExternalWorkBackgroundSchedulerEntry {
  scheduler: ExternalWorkBackgroundScheduler;
  key: string;
  timer?: ReturnType<typeof setTimeout>;
  running: boolean;
}

class ExternalWorkBackgroundSchedulerRegistry {
  private readonly entriesById = new Map<string, ExternalWorkBackgroundSchedulerEntry>();
  private readonly idsByKey = new Map<string, string>();

  constructor(
    private readonly storeRegistry: RunStoreRegistry,
    private readonly secretResolver: SecretResolver,
    private readonly externalWorkFetch?: typeof globalThis.fetch,
  ) {}

  async start(cwd: string, input: ExternalWorkGitHubBackgroundStartRequest): Promise<{
    readonly scheduler: ExternalWorkBackgroundScheduler;
    readonly duplicate: boolean;
    readonly startupReconcile?: ExternalWorkReconcileResponse;
  }> {
    const prepared = this.prepare(cwd, input);
    const key = this.key(cwd, input.channelId, prepared.workflowFile.path);
    const existingId = this.idsByKey.get(key);
    if (existingId) {
      const existing = this.entriesById.get(existingId);
      if (existing && existing.scheduler.status === "running") {
        return { scheduler: existing.scheduler, duplicate: true };
      }
    }

    const now = new Date().toISOString();
    const scheduler: ExternalWorkBackgroundScheduler = {
      id: `external_work_background_${randomUUID()}`,
      cwd,
      sourceKind: "github",
      channelId: input.channelId,
      ...(input.workflowPath ? { workflowPath: input.workflowPath } : {}),
      repository: prepared.workflowDefinition.config.source.repository,
      pollIntervalMs: prepared.workflowDefinition.config.scheduler.pollIntervalMs,
      ...(input.limit ? { limit: input.limit } : {}),
      executeHooks: input.executeHooks === true,
      status: "running",
      startedAt: now,
      tickCount: 0,
    };
    const entry: ExternalWorkBackgroundSchedulerEntry = { scheduler, key, running: false };
    this.entriesById.set(scheduler.id, entry);
    this.idsByKey.set(key, scheduler.id);

    let startupReconcile: ExternalWorkReconcileResponse | undefined;
    if (prepared.workflowDefinition.config.scheduler.reconcileOnStartup) {
      startupReconcile = await reconcileExternalWork({
        store: prepared.store,
        channelId: input.channelId,
        workflowDefinition: prepared.workflowDefinition,
        githubToken: prepared.githubToken,
        fetch: this.externalWorkFetch,
      });
      entry.scheduler = {
        ...entry.scheduler,
        lastReconcileAt: new Date().toISOString(),
        lastReconcile: startupReconcile,
      };
    }

    if (input.runImmediately !== false) {
      await this.runTick(entry);
    }
    this.schedule(entry);
    return { scheduler: entry.scheduler, duplicate: false, ...(startupReconcile ? { startupReconcile } : {}) };
  }

  list(cwd: string): ExternalWorkBackgroundScheduler[] {
    return Array.from(this.entriesById.values())
      .filter((entry) => entry.scheduler.cwd === cwd)
      .map((entry) => entry.scheduler);
  }

  stop(cwd: string, schedulerId: string): ExternalWorkBackgroundScheduler | undefined {
    const entry = this.entriesById.get(schedulerId);
    if (!entry || entry.scheduler.cwd !== cwd) {
      return undefined;
    }
    if (entry.timer) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
    entry.scheduler = {
      ...entry.scheduler,
      status: "stopped",
      stoppedAt: new Date().toISOString(),
      nextPollAt: undefined,
    };
    this.idsByKey.delete(entry.key);
    return entry.scheduler;
  }

  stopAll(): void {
    for (const entry of this.entriesById.values()) {
      if (entry.timer) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
      }
      entry.scheduler = {
        ...entry.scheduler,
        status: "stopped",
        stoppedAt: new Date().toISOString(),
        nextPollAt: undefined,
      };
    }
    this.idsByKey.clear();
  }

  private schedule(entry: ExternalWorkBackgroundSchedulerEntry): void {
    if (entry.scheduler.status !== "running") {
      return;
    }
    const nextPollAt = new Date(Date.now() + entry.scheduler.pollIntervalMs).toISOString();
    entry.scheduler = { ...entry.scheduler, nextPollAt };
    entry.timer = setTimeout(() => {
      void this.runTick(entry).finally(() => this.schedule(entry));
    }, entry.scheduler.pollIntervalMs);
    entry.timer.unref?.();
  }

  private async runTick(entry: ExternalWorkBackgroundSchedulerEntry): Promise<void> {
    if (entry.running || entry.scheduler.status !== "running") {
      return;
    }
    entry.running = true;
    const now = new Date().toISOString();
    try {
      const prepared = this.prepare(entry.scheduler.cwd, {
        channelId: entry.scheduler.channelId,
        workflowPath: entry.scheduler.workflowPath,
        limit: entry.scheduler.limit,
        executeHooks: entry.scheduler.executeHooks,
      });
      const poll = await pollGitHubExternalWork({
        store: prepared.store,
        cwd: entry.scheduler.cwd,
        channelId: entry.scheduler.channelId,
        workflowDefinition: prepared.workflowDefinition,
        workflowDirectory: prepared.workflowFile.directory,
        githubToken: prepared.githubToken,
        fetch: this.externalWorkFetch,
        limit: entry.scheduler.limit,
        executeHooks: entry.scheduler.executeHooks,
        now,
      });
      const reconcile = await reconcileExternalWork({
        store: prepared.store,
        channelId: entry.scheduler.channelId,
        workflowDefinition: prepared.workflowDefinition,
        githubToken: prepared.githubToken,
        fetch: this.externalWorkFetch,
        now: new Date().toISOString(),
      });
      entry.scheduler = {
        ...entry.scheduler,
        repository: prepared.workflowDefinition.config.source.repository,
        pollIntervalMs: prepared.workflowDefinition.config.scheduler.pollIntervalMs,
        status: "running",
        tickCount: entry.scheduler.tickCount + 1,
        lastPollAt: now,
        lastReconcileAt: new Date().toISOString(),
        lastErrorCode: undefined,
        lastErrorMessage: undefined,
        lastPoll: poll,
        lastReconcile: reconcile,
      };
    } catch (error) {
      entry.scheduler = {
        ...entry.scheduler,
        status: "running",
        tickCount: entry.scheduler.tickCount + 1,
        lastPollAt: now,
        lastErrorCode: "background_tick_failed",
        lastErrorMessage: error instanceof Error ? error.message : String(error),
      };
    } finally {
      entry.running = false;
    }
  }

  private prepare(cwd: string, input: Pick<ExternalWorkGitHubBackgroundStartRequest, "channelId" | "workflowPath" | "limit" | "executeHooks">): {
    readonly store: RunStore;
    readonly channel: Channel;
    readonly workflowFile: ReturnType<typeof readExternalWorkflowFile>;
    readonly workflowDefinition: ExternalWorkflowDefinition;
    readonly githubToken: string | undefined;
  } {
    const store = this.storeRegistry.getStore(cwd);
    const channel = store.getChannel(input.channelId);
    if (!channel) {
      throw new Error(`Channel not found: ${input.channelId}`);
    }
    const workflowFile = readExternalWorkflowFile({ workflowPath: input.workflowPath }, channel, cwd);
    const workflowDefinition = parseExternalWorkflowMarkdown(workflowFile.markdown);
    if (workflowDefinition.config.source.kind !== "github") {
      throw new Error(`Unsupported external source kind: ${workflowDefinition.config.source.kind}`);
    }
    return {
      store,
      channel,
      workflowFile,
      workflowDefinition,
      githubToken: resolveExternalGitHubToken(workflowDefinition, this.secretResolver),
    };
  }

  private key(cwd: string, channelId: string, workflowPath: string | undefined): string {
    return [cwd, channelId, workflowPath ?? "WORKFLOW.md"].join("\0");
  }
}

class RunStoreRegistry {
  private readonly storesByCwd = new Map<string, RunStore>();
  private readonly storesByRunId = new Map<string, RunStore>();

  constructor(private readonly storeFactory: RunStoreFactory) {}

  getStore(cwd: string): RunStore {
    const existing = this.storesByCwd.get(cwd);
    if (existing) {
      return existing;
    }

    const store = this.storeFactory(cwd);
    store.recoverStaleRuns(new Date().toISOString());
    this.storesByCwd.set(cwd, store);
    return store;
  }

  rememberRun(runId: string, store: RunStore): void {
    this.storesByRunId.set(runId, store);
  }

  findStoreForRun(runId: string, cwd?: string): RunStore | undefined {
    if (cwd) {
      return this.getStore(cwd);
    }

    const knownStore = this.storesByRunId.get(runId);
    if (knownStore?.getRun(runId)) {
      return knownStore;
    }

    for (const store of this.storesByCwd.values()) {
      if (store.getRun(runId)) {
        this.rememberRun(runId, store);
        return store;
      }
    }

    return undefined;
  }

  findStoreForArtifact(artifactId: string, cwd?: string): { readonly store: RunStore; readonly artifact: RunArtifact } | undefined {
    if (cwd) {
      const store = this.getStore(cwd);
      const artifact = store.getArtifact(artifactId);
      return artifact ? { store, artifact } : undefined;
    }

    for (const store of this.storesByCwd.values()) {
      const artifact = store.getArtifact(artifactId);
      if (artifact) {
        if (artifact.runId) {
          this.rememberRun(artifact.runId, store);
        }
        return { store, artifact };
      }
    }

    return undefined;
  }

  closeAll(): void {
    for (const store of this.storesByCwd.values()) {
      store.close();
    }
    this.storesByCwd.clear();
    this.storesByRunId.clear();
  }
}
