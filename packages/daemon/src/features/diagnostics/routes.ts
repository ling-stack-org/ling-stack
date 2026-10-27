import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import type { DaemonContext } from "../../context.js";
import { writeJson } from "../../shared/response.js";
import { redactSecrets } from "@ling-stack/core";
import type {
  DiagnosticsCheck,
  DiagnosticsDoctorResponse,
  DiagnosticsLogTailResponse,
} from "@ling-stack/contracts";

const DOCTOR_VERSION = 1 as const;
const LOG_TAIL_VERSION = 1 as const;
const MAX_LOG_LINES = 500;

function overall(checks: readonly DiagnosticsCheck[]): DiagnosticsDoctorResponse["overallStatus"] {
  if (checks.some((check) => check.status === "fail")) return "fail";
  if (checks.some((check) => check.status === "warning")) return "warning";
  return "ok";
}

/**
 * Daemon-side doctor checks. Deliberately bounded: the CLI's doctor composes
 * many client-side probes, this route only reports what the daemon itself can
 * observe (workspace store, startup phases, log file readability, config
 * feature flags) so the web panel has a single authoritative source.
 */
export async function handleDiagnosticsDoctor(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Use GET for diagnostics doctor" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const cwd = url.searchParams.get("cwd") ?? context.config.defaultWorkspaceCwd;
  const checks: DiagnosticsCheck[] = [];
  const generatedAt = new Date().toISOString();

  try {
    const store = context.storeRegistry.getStore(cwd);
    checks.push({
      id: "workspace_store",
      category: "workspace",
      status: "ok",
      summary: "Workspace run store opened",
      details: `cwd: ${cwd}`,
    });
    void store;
  } catch (error) {
    checks.push({
      id: "workspace_store",
      category: "workspace",
      status: "fail",
      summary: "Workspace run store could not be opened",
      details: error instanceof Error ? error.message : String(error),
      remediation: "Run `ling workspace repair-registry` or check the workspace directory permissions.",
    });
  }

  const snapshot = context.startupState.snapshot(cwd);
  if (snapshot) {
    const failed = Object.entries(snapshot.phases ?? {})
      .filter(([, phase]) => phase === "failed" || phase === "degraded")
      .map(([phase]) => phase);
    const errors = snapshot.diagnostics.filter((diagnostic) => diagnostic.level === "error");
    checks.push({
      id: "startup_phases",
      category: "startup",
      status: failed.length > 0 || errors.length > 0 ? "warning" : "ok",
      summary: failed.length > 0
        ? `Startup phase(s) not ready: ${failed.join(", ")}`
        : `Startup state: ${snapshot.state}`,
      details: failed.length > 0
        ? errors.length > 0
          ? errors.map((diagnostic) => `${diagnostic.phase}: ${diagnostic.message}`).join("; ")
          : "See startup diagnostics for phase details."
        : undefined,
      remediation: failed.length > 0 ? "Open Run diagnostics or refresh startup from this panel." : undefined,
    });
  } else {
    checks.push({
      id: "startup_phases",
      category: "startup",
      status: "unchecked",
      summary: "No startup status recorded for this workspace yet",
    });
  }

  const logPath = process.env.LING_STACK_DAEMON_LOG_PATH;
  if (logPath) {
    try {
      await readFile(logPath, { encoding: "utf8", flag: "r" });
      checks.push({
        id: "log_file",
        category: "logs",
        status: "ok",
        summary: "Daemon log file readable",
        details: `path: ${logPath}`,
      });
    } catch (error) {
      checks.push({
        id: "log_file",
        category: "logs",
        status: "warning",
        summary: "Daemon log file is not readable",
        details: error instanceof Error ? error.message : String(error),
        remediation: "Check that the log file exists and the daemon user can read it.",
      });
    }
  } else {
    checks.push({
      id: "log_file",
      category: "logs",
      status: "unchecked",
      summary: "Daemon log path not provided (started without lifecycle env)",
      remediation: "Start the daemon via `ling daemon` so the log path is advertised.",
    });
  }

  checks.push({
    id: "feature_flags",
    category: "config",
    status: "ok",
    summary: "Feature configuration loaded",
    details: `harness: ${context.config.harness.continuations.mode}, snapshots: ${context.config.workspaceSnapshots.captureEnabled ? "capture on" : "capture off"}, channels.autoRoute: ${context.config.channels.autoRoute === true}`,
  });

  const body: DiagnosticsDoctorResponse = {
    doctorVersion: DOCTOR_VERSION,
    cwd,
    overallStatus: overall(checks),
    checks,
    generatedAt,
  };
  writeJson(response, 200, body);
}

/**
 * Bounded, secret-redacted daemon log tail. Reads the lifecycle log file the
 * CLI advertises via LING_STACK_DAEMON_LOG_PATH; without it the route reports
 * null rather than guessing paths.
 */
export async function handleDiagnosticsLogs(
  request: IncomingMessage,
  response: ServerResponse,
  context: DaemonContext,
): Promise<void> {
  if (request.method !== "GET") {
    writeJson(response, 405, { error: "method_not_allowed", message: "Use GET for diagnostics logs" });
    return;
  }
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${context.config.host}:${context.config.port}`}`);
  const requested = Number.parseInt(url.searchParams.get("lines") ?? "200", 10);
  const lines = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), MAX_LOG_LINES) : 200;
  const logPath = process.env.LING_STACK_DAEMON_LOG_PATH;

  if (!logPath) {
    const body: DiagnosticsLogTailResponse = { logVersion: LOG_TAIL_VERSION, logPath: null, truncated: false, lines: [] };
    writeJson(response, 200, body);
    return;
  }

  try {
    const raw = await readFile(logPath, { encoding: "utf8", flag: "r" });
    const allLines = raw.split(/\r?\n/u).filter((line) => line.length > 0);
    const tail = allLines.slice(-lines);
    const redacted = redactSecrets(tail);
    const body: DiagnosticsLogTailResponse = {
      logVersion: LOG_TAIL_VERSION,
      logPath,
      truncated: allLines.length > tail.length,
      lines: Array.isArray(redacted) ? redacted.map((line) => String(line)) : [],
    };
    writeJson(response, 200, body);
  } catch (error) {
    writeJson(response, 200, {
      logVersion: LOG_TAIL_VERSION,
      logPath,
      truncated: false,
      lines: [],
      error: error instanceof Error ? error.message : String(error),
    } satisfies DiagnosticsLogTailResponse & { error: string });
  }
}
