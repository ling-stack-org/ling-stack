import { readFileSync, realpathSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  parseExternalWorkflowMarkdown,
  type Channel,
  type ExternalWorkBackgroundScheduler,
  type ExternalWorkStoreFacet,
  type ExternalWorkflowDefinition,
  type ExternalWorkStatusResponse,
  type SecretResolver,
  type WorkspaceStoreFacet,
} from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { isPathInsideRoot } from "../../shared/path.js";
import { writeJson } from "../../shared/response.js";

export interface ExternalWorkBackgroundSchedulerList {
  list(cwd: string): readonly ExternalWorkBackgroundScheduler[];
}

type ExternalWorkStatusStore =
  ExternalWorkStoreFacet &
  WorkspaceStoreFacet;

export async function handleExternalWorkStatus(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  secretResolver: SecretResolver,
  backgroundSchedulers: ExternalWorkBackgroundSchedulerList | undefined,
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

export function readExternalWorkflowStatusFile(
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

export function parseExternalWorkflowStatus(markdown: string | undefined): {
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

export function buildExternalWorkStatusWorkflowSummary(
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

export function buildExternalWorkStatusSecret(
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

function buildExternalWorkStatusCounts(store: ExternalWorkStatusStore, channelId: string): ExternalWorkStatusResponse["records"] {
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

function statFileIfPresent(path: string): ReturnType<typeof statSync> | undefined {
  try {
    return statSync(path);
  } catch {
    return undefined;
  }
}
