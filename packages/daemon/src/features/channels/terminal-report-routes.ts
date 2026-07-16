import type { IncomingMessage, ServerResponse } from "node:http";
import type { TerminalReportDto, TerminalReportSourceRefDto } from "@ling-stack/contracts";
import type { TerminalReport, TerminalReportSourceRef } from "@ling-stack/core";
import type { ResolvedDaemonConfig } from "../../config.js";
import type { RunStoreRegistry } from "../../runtime/store-registry.js";
import { readOptionalIntegerQuery } from "../../shared/request.js";
import { writeJson } from "../../shared/response.js";

export async function handleTerminalReportItem(
  request: IncomingMessage,
  response: ServerResponse,
  config: ResolvedDaemonConfig,
  storeRegistry: RunStoreRegistry,
  reportId: string,
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${config.host}:${config.port}`}`);
  const cwd = url.searchParams.get("cwd");
  if (!cwd) {
    writeJson(response, 400, { error: "bad_request", message: "cwd query parameter is required" });
    return;
  }
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for terminal reports` });
    return;
  }

  try {
    const record = storeRegistry.getStore(cwd).getTerminalReport(reportId);
    if (!record?.report || (record.status !== "committed" && record.status !== "fallback")) {
      writeJson(response, 404, { error: "terminal_report_not_found", message: `Terminal report not found: ${reportId}` });
      return;
    }
    writeJson(response, 200, { report: projectTerminalReportDto(record.report) });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleTerminalReportsCollection(
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
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for terminal reports` });
    return;
  }
  try {
    const reports = storeRegistry.getStore(cwd).listTerminalReports({
      threadId: url.searchParams.get("threadId") ?? undefined,
      sourceKind: readSourceKind(url.searchParams.get("sourceKind")),
      sourceId: url.searchParams.get("sourceId") ?? undefined,
      limit: readOptionalIntegerQuery(url, "limit", 1),
    })
      .filter((record) => Boolean(record.report) && (record.status === "committed" || record.status === "fallback"))
      .map((record) => projectTerminalReportDto(record.report!));
    writeJson(response, 200, { reports });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function handleChannelTerminalReports(
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
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: `${request.method} is not supported for channel terminal reports` });
    return;
  }

  try {
    const store = storeRegistry.getStore(cwd);
    if (!store.getChannel(channelId)) {
      writeJson(response, 404, { error: "channel_not_found", message: `Channel not found: ${channelId}` });
      return;
    }
    const reports = store.listTerminalReports({
      channelId,
      threadId: url.searchParams.get("threadId") ?? undefined,
      sourceKind: readSourceKind(url.searchParams.get("sourceKind")),
      sourceId: url.searchParams.get("sourceId") ?? undefined,
      limit: readOptionalIntegerQuery(url, "limit", 1),
    })
      .filter((record) => Boolean(record.report) && (record.status === "committed" || record.status === "fallback"))
      .map((record) => projectTerminalReportDto(record.report!));
    writeJson(response, 200, { reports });
  } catch (error) {
    writeJson(response, 400, {
      error: "bad_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function projectTerminalReportDto(report: TerminalReport): TerminalReportDto {
  return {
    ...report,
    outcome: {
      ...report.outcome,
      sourceRefs: publicSourceRefs(report.outcome.sourceRefs),
      corrections: report.outcome.corrections.map((correction) => ({
        ...correction,
        sourceRefs: publicSourceRefs(correction.sourceRefs),
      })),
    },
    changes: report.changes.map((change) => ({ ...change, sourceRefs: publicSourceRefs(change.sourceRefs) })),
    verification: report.verification.map((check) => ({ ...check, sourceRefs: publicSourceRefs(check.sourceRefs) })),
    participants: report.participants.map((participant) => ({ ...participant, sourceRefs: publicSourceRefs(participant.sourceRefs) })),
    artifacts: report.artifacts.map((artifact) => ({ ...artifact, sourceRefs: publicSourceRefs(artifact.sourceRefs) })),
    risks: report.risks.map((risk) => ({ ...risk, sourceRefs: publicSourceRefs(risk.sourceRefs) })),
    references: publicSourceRefs(report.references),
    synthesis: {
      mode: report.synthesis.mode,
      promptVersion: report.synthesis.promptVersion,
      attemptCount: report.synthesis.attemptCount,
      validationCodes: report.synthesis.validationCodes,
    },
  };
}

function publicSourceRefs(refs: readonly TerminalReportSourceRef[]): TerminalReportSourceRefDto[] {
  return refs
    .filter((ref) => ref.visibility !== "developer_only" && ref.sensitivity !== "secret_adjacent")
    .map((ref) => ({ ...ref }));
}

function readSourceKind(value: string | null): "workflow" | "run" | "turn" | undefined {
  if (value === null || value === "") {
    return undefined;
  }
  if (value === "workflow" || value === "run" || value === "turn") {
    return value;
  }
  throw new Error(`Unsupported terminal report source kind: ${value}`);
}
