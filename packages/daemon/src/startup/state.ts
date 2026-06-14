import { randomUUID } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import type {
  EffectiveConfigStartupSnapshot,
  StartupDiagnostic,
  StartupPhase,
  StartupPhaseStatus,
  StartupWorkspaceState,
  WorkspaceStartupStatus,
} from "@ling-stack/contracts";

export const startupPhaseOrder = [
  "process_config",
  "user_config",
  "workspace_store",
  "effective_config",
  "runtime_policy",
  "secret_resolver",
  "provider_warmup",
  "automation_scheduler",
  "external_work_scheduler",
  "plugin_warmup",
] as const satisfies readonly StartupPhase[];

export const requiredStartupPhases = [
  "process_config",
  "user_config",
  "workspace_store",
  "effective_config",
  "runtime_policy",
  "secret_resolver",
] as const satisfies readonly StartupPhase[];

export const optionalStartupPhases = [
  "provider_warmup",
  "automation_scheduler",
  "external_work_scheduler",
  "plugin_warmup",
] as const satisfies readonly StartupPhase[];

export interface StartupStateRegistryOptions {
  readonly now?: () => Date;
  readonly startupAttemptId?: string;
  readonly maxDiagnosticsPerWorkspace?: number;
}

interface WorkspaceStartupRecord {
  startupAttemptId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  phases: Map<StartupPhase, StartupPhaseStatus>;
  diagnostics: StartupDiagnostic[];
  effectiveConfigSnapshot?: EffectiveConfigStartupSnapshot;
}

const defaultMaxDiagnosticsPerWorkspace = 50;

export class StartupStateRegistry {
  private readonly recordsByCwd = new Map<string, WorkspaceStartupRecord>();
  private readonly now: () => Date;
  private readonly startupAttemptId: string;
  private readonly maxDiagnosticsPerWorkspace: number;

  constructor(options: StartupStateRegistryOptions = {}) {
    this.now = options.now ?? (() => new Date());
    this.startupAttemptId = options.startupAttemptId ?? createStartupAttemptId();
    this.maxDiagnosticsPerWorkspace = options.maxDiagnosticsPerWorkspace ?? defaultMaxDiagnosticsPerWorkspace;
  }

  getStartupAttemptId(): string {
    return this.startupAttemptId;
  }

  ensureWorkspace(cwd: string): WorkspaceStartupStatus {
    return this.snapshotForRecord(this.getOrCreateRecord(cwd));
  }

  resetWorkspace(cwd: string): WorkspaceStartupStatus {
    const normalizedCwd = normalizeCwd(cwd);
    this.recordsByCwd.delete(normalizedCwd);
    return this.snapshotForRecord(this.getOrCreateRecord(normalizedCwd));
  }

  setPhase(cwd: string, phase: StartupPhase, status: StartupPhaseStatus): WorkspaceStartupStatus {
    const record = this.getOrCreateRecord(cwd);
    record.phases.set(phase, status);
    record.updatedAt = this.timestamp();
    return this.snapshotForRecord(record);
  }

  addDiagnostic(cwd: string, diagnostic: StartupDiagnostic): WorkspaceStartupStatus {
    const record = this.getOrCreateRecord(cwd);
    const existingIndex = record.diagnostics.findIndex((item) =>
      item.phase === diagnostic.phase &&
      item.code === diagnostic.code &&
      item.path === diagnostic.path);
    if (existingIndex >= 0) {
      const existing = record.diagnostics[existingIndex];
      record.diagnostics[existingIndex] = {
        ...existing,
        level: highestDiagnosticLevel(existing.level, diagnostic.level),
        message: diagnostic.message,
        nextAction: diagnostic.nextAction ?? existing.nextAction,
        count: (existing.count ?? 1) + 1,
      };
    } else {
      record.diagnostics.push(diagnostic);
      if (record.diagnostics.length > this.maxDiagnosticsPerWorkspace) {
        record.diagnostics.splice(0, record.diagnostics.length - this.maxDiagnosticsPerWorkspace);
      }
    }
    record.updatedAt = this.timestamp();
    return this.snapshotForRecord(record);
  }

  recordEffectiveConfigSnapshot(cwd: string, snapshot: EffectiveConfigStartupSnapshot): WorkspaceStartupStatus {
    const record = this.getOrCreateRecord(cwd);
    record.effectiveConfigSnapshot = snapshot;
    record.updatedAt = this.timestamp();
    return this.snapshotForRecord(record);
  }

  getEffectiveConfigSnapshot(cwd: string): EffectiveConfigStartupSnapshot | undefined {
    return this.recordsByCwd.get(normalizeCwd(cwd))?.effectiveConfigSnapshot;
  }

  snapshot(cwd: string): WorkspaceStartupStatus | undefined {
    const record = this.recordsByCwd.get(normalizeCwd(cwd));
    return record ? this.snapshotForRecord(record) : undefined;
  }

  private getOrCreateRecord(cwd: string): WorkspaceStartupRecord {
    const normalizedCwd = normalizeCwd(cwd);
    const existing = this.recordsByCwd.get(normalizedCwd);
    if (existing) {
      return existing;
    }
    const now = this.timestamp();
    const phases = new Map<StartupPhase, StartupPhaseStatus>();
    for (const phase of startupPhaseOrder) {
      phases.set(phase, "not_started");
    }
    const record: WorkspaceStartupRecord = {
      startupAttemptId: this.startupAttemptId,
      cwd: normalizedCwd,
      startedAt: now,
      updatedAt: now,
      phases,
      diagnostics: [],
    };
    this.recordsByCwd.set(normalizedCwd, record);
    return record;
  }

  private snapshotForRecord(record: WorkspaceStartupRecord): WorkspaceStartupStatus {
    const phases = Object.fromEntries(startupPhaseOrder.map((phase) => [phase, record.phases.get(phase) ?? "not_started"])) as Record<StartupPhase, StartupPhaseStatus>;
    return {
      startupAttemptId: record.startupAttemptId,
      cwd: record.cwd,
      state: deriveStartupState(phases),
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      phases,
      diagnostics: record.diagnostics.map((diagnostic) => ({ ...diagnostic })),
      effectiveConfigLoadedAt: record.effectiveConfigSnapshot?.loadedAt,
    };
  }

  private timestamp(): string {
    return this.now().toISOString();
  }
}

export function deriveStartupState(phases: Readonly<Record<StartupPhase, StartupPhaseStatus>>): StartupWorkspaceState {
  if (requiredStartupPhases.some((phase) => phases[phase] === "failed")) {
    return "failed";
  }
  if (requiredStartupPhases.some((phase) => !isTerminalRequiredPhaseStatus(phases[phase]))) {
    return "starting";
  }
  if (requiredStartupPhases.some((phase) => phases[phase] === "degraded")) {
    return "degraded";
  }
  if (optionalStartupPhases.some((phase) => phases[phase] === "degraded" || phases[phase] === "failed")) {
    return "degraded";
  }
  return "ready";
}

function isTerminalRequiredPhaseStatus(status: StartupPhaseStatus): boolean {
  return status === "ready" || status === "degraded" || status === "failed";
}

function highestDiagnosticLevel(left: StartupDiagnostic["level"], right: StartupDiagnostic["level"]): StartupDiagnostic["level"] {
  const rank: Record<StartupDiagnostic["level"], number> = {
    info: 0,
    warning: 1,
    error: 2,
  };
  return rank[right] > rank[left] ? right : left;
}

function createStartupAttemptId(): string {
  return `startup_${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}_${randomUUID().slice(0, 8)}`;
}

function normalizeCwd(cwd: string): string {
  return resolvePath(cwd);
}
