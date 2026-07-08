import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import {
  approvalToolDecisions,
  buildMemoryMarkdownExport,
  createSqliteRunStore,
  defaultAllowedWritePaths,
  defaultApprovalToolDecisions,
  defaultProviderTemplates,
  parseMemoryMarkdownImport,
  registerResolvedWorkspace,
  resolveConfigPaths,
  resolveStoragePaths,
  type ApprovalToolDecision,
  type LingStackRuntimePaths,
  type MemoryReviewState,
  type MemoryScopeType,
  type MemorySensitivity,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderPresetInput,
  type RunTool,
  type WorkspaceStateLocation,
} from "@ling-stack/core";
import { readDaemonLogLines } from "./daemon/logs.js";
import { startBackgroundDaemon, stopDaemonProcess } from "./daemon/process.js";
import { readDaemonStateSnapshot } from "./daemon/state.js";
import {
  checkStatusExitCode,
  overallDoctorStatus,
  type DoctorCheck,
  type DoctorReport,
  type DoctorStatus,
} from "./doctor/checks.js";
import { CliError, errorMessage } from "./errors.js";
import { generateCompletionScript, supportedCompletionShells, type CompletionShell } from "./completion/scripts.js";
import { parseRunStreamRecord, type RunEventEnvelope, type RunStreamRecord } from "./run/events.js";
import { readRunPromptInput } from "./run/input.js";
import {
  createLastMessageCollector,
  validateLastMessageTarget,
  writeLastMessageAtomic,
} from "./run/last-message.js";
import { createRunOutput, type RunOutput } from "./run/output.js";
import {
  DEFAULT_LOCAL_WEB_URL,
  readLocalServiceLogs,
  readLocalStackStatus,
  restartLocalStack,
  type LocalStartupStatus,
  type LocalServiceLog,
  type LocalServiceName,
  type LocalServiceStatus,
  type LocalStackStatus,
} from "./local/services.js";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "17891";
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const VALID_TOOLS: ReadonlySet<string> = new Set(Object.keys(defaultApprovalToolDecisions) as RunTool[]);
const VALID_POLICY_DECISIONS: ReadonlySet<string> = new Set(approvalToolDecisions);
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_PROVIDER_KINDS = new Set(["openai", "anthropic", "google", "openai-compatible", "doubao", "deepseek", "minimax", "glm", "jimeng", "seedream", "seedance"]);
const VALID_PROVIDER_APIS = new Set(["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations", "media-job"]);
const VALID_PROVIDER_TRANSPORTS = new Set(["auto", "websocket", "websocket-cached", "sse"]);
const VALID_PROVIDER_CAPABILITIES = new Set(["chat", "tool_call", "reasoning", "vision", "embedding", "image_generate", "image_edit", "video_generate", "tts", "asr"]);
const VALID_PROVIDER_INPUTS = new Set(["text", "image"]);
const VALID_MEMORY_SCOPE_TYPES = new Set(["workspace", "channel", "teammate", "task", "run"]);
const VALID_MEMORY_REVIEW_STATES = new Set(["candidate", "active", "disabled", "archived", "rejected"]);
const VALID_MEMORY_SENSITIVITIES = new Set(["normal", "private", "secret-adjacent"]);

type QueryValue = string | number | boolean | undefined;

interface GlobalOptions {
  readonly daemonUrl: string;
  readonly cwd: string;
  readonly json: boolean;
  readonly verbose: boolean;
  readonly color: boolean;
  readonly help: boolean;
}

interface ParsedGlobalArgs {
  readonly args: readonly string[];
  readonly options: GlobalOptions;
}

interface ParsedCommandArgs {
  readonly positionals: readonly string[];
  readonly flags: ReadonlyMap<string, readonly string[]>;
  readonly booleans: ReadonlySet<string>;
}

interface CommandParserSpec {
  readonly stringFlags?: ReadonlySet<string>;
  readonly repeatableFlags?: ReadonlySet<string>;
  readonly booleanFlags?: ReadonlySet<string>;
}

interface RunApprovalSummary {
  readonly id: string;
  readonly status: string;
  readonly actionType: string;
  readonly risk: string;
  readonly reason: string;
}

interface ProviderCheckSummary {
  readonly providerId: string;
  readonly displayName: string;
  readonly ok: boolean;
  readonly code?: string;
  readonly message: string;
  readonly checkedAt: string;
}

interface DoctorDependencyError {
  readonly code: string;
  readonly message: string;
  readonly status?: number;
}

interface DoctorDependencyResult {
  readonly ok: boolean;
  readonly body?: unknown;
  readonly error?: DoctorDependencyError;
}

interface InitResult {
  readonly cwd: string;
  readonly rootDir: string;
  readonly databasePath: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
  readonly logsDir: string;
  readonly piDir: string;
  readonly configPath: string;
  readonly workspaceId: string;
  readonly stateLocation: string;
  readonly createdProviders: readonly ProviderPreset[];
  readonly skippedProviders: readonly ProviderPreset[];
}

interface WorkspaceStateMigrationResult {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly source: WorkspaceStateMigrationSide;
  readonly target: WorkspaceStateMigrationSide;
  readonly manifestPath: string;
  readonly backupRoot: string;
  readonly copiedPaths: readonly string[];
}

interface WorkspaceStateMigrationPreflightResult {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly canMigrate: boolean;
  readonly source: WorkspaceStateMigrationSide;
  readonly target: WorkspaceStateMigrationSide;
  readonly plan: WorkspaceStateMigrationPreflightPlan;
  readonly checks: readonly WorkspaceStateMigrationPreflightCheck[];
}

interface WorkspaceStateMigrationPreflightPlan {
  readonly previewMigrationRoot: string;
  readonly previewManifestPath: string;
  readonly previewBackupRoot: string;
  readonly previewStagingRoot: string;
  readonly sourceWillRemain: boolean;
  readonly targetWillBeBackedUp: boolean;
  readonly repoPointerWillBeWritten: boolean;
  readonly registryWillBeUpdated: boolean;
}

interface WorkspaceStateMigrationPreflightCheck {
  readonly id: string;
  readonly status: DoctorStatus;
  readonly summary: string;
  readonly details?: Readonly<Record<string, unknown>>;
  readonly remediation?: string;
}

interface WorkspaceRegistryRepairResult {
  readonly cwd: string;
  readonly workspaceId: string;
  readonly dryRun: boolean;
  readonly canRepair: boolean;
  readonly changed: boolean;
  readonly globalDatabasePath: string;
  readonly resolved: WorkspaceRegistryRepairEntry;
  readonly registry?: WorkspaceRegistryDiagnosticEntry;
  readonly mismatches: readonly string[];
  readonly checks: readonly WorkspaceStateMigrationPreflightCheck[];
}

interface WorkspaceRegistryRepairEntry {
  readonly workspaceId: string;
  readonly canonicalCwd: string;
  readonly displayName: string;
  readonly stateLocation: WorkspaceStateLocation;
  readonly stateRoot: string;
}

interface WorkspaceStateMigrationSide {
  readonly stateLocation: WorkspaceStateLocation;
  readonly rootDir: string;
  readonly databasePath: string;
}

interface WorkspaceRegistryDiagnosticEntry {
  readonly workspaceId: string;
  readonly canonicalCwd: string;
  readonly displayName: string;
  readonly stateLocation: WorkspaceStateLocation;
  readonly stateRoot: string;
  readonly lastOpenedAt: string;
}

interface DaemonListenOptions {
  readonly host: string;
  readonly port: number;
  readonly defaultWorkspaceCwd: string;
}

interface DaemonCommandOptions extends DaemonListenOptions {
  readonly daemonUrl: string;
  readonly timeoutMs: number;
}

interface UiOptions {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly open: boolean;
  readonly foreground: boolean;
}

export async function main(): Promise<void> {
  let parsed: ParsedGlobalArgs | undefined;
  try {
    parsed = parseGlobalArgs(process.argv.slice(2));
    process.exitCode = await dispatch(parsed);
  } catch (error) {
    const options = parsed?.options ?? defaultGlobalOptions(false);
    printCliError(error, options);
    process.exitCode = error instanceof CliError ? error.exitCode : 1;
  }
}

async function dispatch(parsed: ParsedGlobalArgs): Promise<number> {
  const [command, ...rest] = parsed.args;

  if (!command || command === "help") {
    printHelp();
    return 0;
  }

  if (parsed.options.help) {
    printCommandHelp(command, rest[0]);
    return 0;
  }

  switch (command) {
    case "init":
      return await handleInit(rest, parsed.options);
    case "doctor":
      return await handleDoctor(rest, parsed.options);
    case "workspace":
      return await handleWorkspace(rest, parsed.options);
    case "memory":
      return await handleMemory(rest, parsed.options);
    case "daemon":
      return await handleDaemon(rest, parsed.options);
    case "restart":
      return await handleLocalRestart(rest, parsed.options);
    case "status":
      return await handleLocalStatus(rest, parsed.options);
    case "logs":
      return await handleLocalLogs(rest, parsed.options);
    case "run":
      return await handleRun(rest, parsed.options);
    case "provider":
      return await handleProvider(rest, parsed.options);
    case "channel":
      return await handleChannel(rest, parsed.options);
    case "task":
      return await handleTask(rest, parsed.options);
    case "policy":
      return await handlePolicy(rest, parsed.options);
    case "approvals":
      return await handleApprovals(rest, parsed.options);
    case "runs":
      return await handleRuns(rest, parsed.options);
    case "automations":
      return await handleAutomations(rest, parsed.options);
    case "external-work":
      return await handleExternalWork(rest, parsed.options);
    case "ui":
      return await handleUi(rest, parsed.options);
    case "completion":
      return handleCompletion(rest, parsed.options);
    default:
      throw new CliError(2, "unknown_command", `Unknown command: ${command}`);
  }
}

async function handleInit(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["workspace-state-location"]),
    booleanFlags: new Set(["with-provider-templates", "no-provider-templates"]),
  });
  assertNoPositionals(parsed.positionals, "init");
  const withProviderTemplates = readProviderTemplatesFlag(parsed);
  const workspaceStateLocation = readWorkspaceStateLocationFlag(getFlag(parsed, "workspace-state-location"));
  const result = await initWorkspace(options.cwd, withProviderTemplates, workspaceStateLocation);

  if (options.json) {
    printJson({
      ok: true,
      cwd: result.cwd,
      rootDir: result.rootDir,
      databasePath: result.databasePath,
      sessionsDir: result.sessionsDir,
      artifactsDir: result.artifactsDir,
      logsDir: result.logsDir,
      piDir: result.piDir,
      configPath: result.configPath,
      workspaceId: result.workspaceId,
      stateLocation: result.stateLocation,
      createdProviderIds: result.createdProviders.map((provider) => provider.id),
      skippedProviderIds: result.skippedProviders.map((provider) => provider.id),
    });
    return 0;
  }

  console.log(`Initialized Ling Stack at ${result.rootDir}`);
  console.log(`Database: ${result.databasePath}`);
  console.log(`Config: ${result.configPath}`);
  console.log(`Workspace state: ${result.stateLocation} (${result.workspaceId})`);
  if (withProviderTemplates) {
    console.log(`Provider templates: ${result.createdProviders.length} created, ${result.skippedProviders.length} skipped`);
  } else {
    console.log("Provider templates: skipped");
  }
  console.log("Next:");
  console.log("  export LOCAL_RELAY_API_KEY=...");
  console.log("  ling-stack provider list");
  console.log("  ling-stack provider update <provider_id> --api-key-ref env:LOCAL_RELAY_API_KEY --enabled true");
  console.log("  ling-stack run --provider <provider_id> \"Inspect this repo.\"");
  return 0;
}

async function handleDoctor(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    booleanFlags: new Set(["summary", "all", "ascii"]),
  });
  const mode = parsed.positionals[0];
  if (mode && mode !== "config") {
    throw new CliError(2, "unknown_doctor_mode", `Unknown doctor mode: ${mode}`);
  }
  if (parsed.positionals.length > (mode ? 1 : 0)) {
    throw new CliError(2, "too_many_args", "doctor accepts at most one mode.");
  }
  const report = mode === "config" ? await buildDoctorConfigReport(options) : await buildDoctorReport(options);

  if (options.json) {
    printJson(report);
    return checkStatusExitCode(report.overallStatus);
  }

  printDoctorReport(report, {
    summary: parsed.booleans.has("summary"),
    ascii: parsed.booleans.has("ascii"),
  });
  return checkStatusExitCode(report.overallStatus);
}

async function handleWorkspace(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "status", ...rest] = args;
  switch (subcommand) {
    case "migrate-state":
    case "migrate":
      return await handleWorkspaceMigrateState(rest, options);
    case "repair-registry":
      return await handleWorkspaceRepairRegistry(rest, options);
    case "registry":
      return await handleWorkspaceRegistry(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown workspace command: ${subcommand}`);
  }
}

async function handleWorkspaceRegistry(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "repair", ...rest] = args;
  switch (subcommand) {
    case "repair":
      return await handleWorkspaceRepairRegistry(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown workspace registry command: ${subcommand}`);
  }
}

async function handleMemory(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "export", ...rest] = args;
  switch (subcommand) {
    case "export":
      return await handleMemoryExport(rest, options);
    case "import":
      return await handleMemoryImport(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown memory command: ${subcommand}`);
  }
}

async function handleMemoryExport(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["scope-type", "owner-id", "review-state", "sensitivity", "tag", "limit", "output"]),
    booleanFlags: new Set(["include-secret-adjacent", "stdout"]),
  });
  assertNoPositionals(parsed.positionals, "memory export");
  const paths = resolveStoragePaths(options.cwd).workspace;
  const store = createSqliteRunStore(options.cwd, paths);
  try {
    const limit = readOptionalIntegerFlag(parsed, "limit");
    const memories = store.listMemoryObjects({
      scopeType: readMemoryScopeTypeFlag(getFlag(parsed, "scope-type")),
      ownerId: getFlag(parsed, "owner-id"),
      reviewState: readMemoryReviewStateFlag(getFlag(parsed, "review-state")),
      sensitivity: readMemorySensitivityFlag(getFlag(parsed, "sensitivity")),
      tag: getFlag(parsed, "tag"),
      limit,
    });
    const markdownExport = buildMemoryMarkdownExport({
      memories,
      latestDecisionsByMemoryId: new Map(memories.map((memory) => [memory.id, store.getLatestMemoryReviewDecision(memory.id)])),
      metadataByMemoryId: new Map(
        store
          .listMemorySelfImprovingMetadata({ limit: 1000 })
          .filter((metadata) => memories.some((memory) => memory.id === metadata.memoryId))
          .map((metadata) => [metadata.memoryId, metadata]),
      ),
      options: {
        workspaceId: "workspace_default",
        includeSecretAdjacent: parsed.booleans.has("include-secret-adjacent"),
      },
    });
    const stdout = parsed.booleans.has("stdout");
    const outputPath = stdout ? undefined : resolve(getFlag(parsed, "output") ?? join(paths.memoryExportsDir, markdownExport.suggestedFileName));
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, markdownExport.markdown, "utf8");
    }

    if (options.json) {
      printJson({
        ok: true,
        cwd: options.cwd,
        outputPath,
        export: stdout ? markdownExport : omitMarkdown(markdownExport),
      });
      return 0;
    }
    if (stdout) {
      process.stdout.write(markdownExport.markdown);
      return 0;
    }
    console.log(`Memory export written: ${outputPath}`);
    console.log(`Exported memories: ${markdownExport.memoryCount}`);
    console.log(`Skipped secret-adjacent memories: ${markdownExport.skippedSecretAdjacentCount}`);
    console.log(`Redaction applied: ${markdownExport.redactionApplied ? "yes" : "no"}`);
    return 0;
  } finally {
    store.close();
  }
}

async function handleMemoryImport(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["file", "source-id", "source-label", "limit"]),
    booleanFlags: new Set(["dry-run"]),
  });
  assertNoPositionals(parsed.positionals, "memory import");
  const filePath = getFlag(parsed, "file");
  if (!filePath) {
    throw new CliError(2, "missing_option", "memory import requires --file <memory.md>.");
  }
  const inputPath = resolve(filePath);
  const markdown = await readFile(inputPath, "utf8");
  const plan = parseMemoryMarkdownImport(markdown, {
    sourceId: getFlag(parsed, "source-id") ?? basename(inputPath),
    sourceLabel: getFlag(parsed, "source-label") ?? basename(inputPath),
    limit: readOptionalIntegerFlag(parsed, "limit"),
  });
  const dryRun = parsed.booleans.has("dry-run");
  const paths = resolveStoragePaths(options.cwd).workspace;
  const store = createSqliteRunStore(options.cwd, paths);
  try {
    const now = new Date().toISOString();
    const memories = dryRun ? [] : plan.candidates.map((candidate) => store.createMemoryObject(candidate.createInput, now));
    if (options.json) {
      printJson({
        ok: true,
        cwd: options.cwd,
        inputPath,
        dryRun,
        importedCount: memories.length,
        plan,
        memories,
      });
      return 0;
    }
    console.log(`Memory import ${dryRun ? "previewed" : "completed"}: ${inputPath}`);
    console.log(`Candidates: ${plan.candidateCount}`);
    console.log(`Skipped sections: ${plan.skippedCount}`);
    console.log(`Imported memories: ${memories.length}`);
    if (plan.candidates.some((candidate) => candidate.warnings.length > 0)) {
      console.log("Warnings:");
      for (const candidate of plan.candidates) {
        for (const warning of candidate.warnings) {
          console.log(`- ${candidate.title}: ${warning}`);
        }
      }
    }
    return 0;
  } finally {
    store.close();
  }
}

async function handleWorkspaceRepairRegistry(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    booleanFlags: new Set(["dry-run"]),
  });
  assertNoPositionals(parsed.positionals, "workspace repair-registry");
  const dryRun = parsed.booleans.has("dry-run");
  const result = await repairWorkspaceRegistry(options.cwd, dryRun);
  if (options.json) {
    printJson({
      ok: result.canRepair,
      dryRun: result.dryRun,
      cwd: result.cwd,
      workspaceId: result.workspaceId,
      canRepair: result.canRepair,
      changed: result.changed,
      globalDatabasePath: result.globalDatabasePath,
      resolved: result.resolved,
      registry: result.registry,
      mismatches: result.mismatches,
      checks: result.checks,
    });
    return result.canRepair ? 0 : 4;
  }
  printWorkspaceRegistryRepair(result);
  return result.canRepair ? 0 : 4;
}

async function handleWorkspaceMigrateState(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["to"]),
    booleanFlags: new Set(["dry-run"]),
  });
  assertNoPositionals(parsed.positionals, "workspace migrate-state");
  const targetStateLocation = readWorkspaceStateLocationFlag(getFlag(parsed, "to"));
  if (!targetStateLocation) {
    throw new CliError(2, "missing_option", "workspace migrate-state requires --to repo-local or --to user-data-dir.");
  }
  if (parsed.booleans.has("dry-run")) {
    const preflight = await preflightWorkspaceStateMigration(options.cwd, targetStateLocation);
    if (options.json) {
      printJson({
        ok: preflight.canMigrate,
        dryRun: true,
        cwd: preflight.cwd,
        workspaceId: preflight.workspaceId,
        canMigrate: preflight.canMigrate,
        source: preflight.source,
        target: preflight.target,
        plan: preflight.plan,
        checks: preflight.checks,
      });
    } else {
      printWorkspaceStateMigrationPreflight(preflight);
    }
    return preflight.canMigrate ? 0 : 4;
  }
  const result = await migrateWorkspaceState(options.cwd, targetStateLocation);

  if (options.json) {
    printJson({
      ok: true,
      cwd: result.cwd,
      workspaceId: result.workspaceId,
      source: result.source,
      target: result.target,
      manifestPath: result.manifestPath,
      backupRoot: result.backupRoot,
      copiedPaths: result.copiedPaths,
    });
    return 0;
  }

  console.log(`Workspace state migrated: ${result.source.stateLocation} -> ${result.target.stateLocation}`);
  console.log(`Workspace: ${result.workspaceId}`);
  console.log(`Source: ${result.source.rootDir}`);
  console.log(`Target: ${result.target.rootDir}`);
  console.log(`Manifest: ${result.manifestPath}`);
  console.log(`Backup: ${result.backupRoot}`);
  return 0;
}

function printWorkspaceStateMigrationPreflight(preflight: WorkspaceStateMigrationPreflightResult): void {
  console.log(`Workspace state migration dry run: ${preflight.source.stateLocation} -> ${preflight.target.stateLocation}`);
  console.log(`Status: ${preflight.canMigrate ? "ok" : "blocked"}`);
  console.log(`Workspace: ${preflight.workspaceId}`);
  console.log(`Source: ${preflight.source.rootDir}`);
  console.log(`Target: ${preflight.target.rootDir}`);
  console.log(`Preview manifest: ${preflight.plan.previewManifestPath}`);
  console.log(`Preview backup: ${preflight.plan.previewBackupRoot}`);
  console.log("Checks:");
  for (const check of preflight.checks) {
    console.log(`  ${check.status.padEnd(7)} ${check.id}  ${check.summary}`);
    if (check.remediation) {
      console.log(`          Next: ${check.remediation}`);
    }
  }
}

function printWorkspaceRegistryRepair(result: WorkspaceRegistryRepairResult): void {
  console.log(`Workspace registry repair${result.dryRun ? " dry run" : ""}`);
  console.log(`Status: ${result.canRepair ? "ok" : "blocked"}`);
  console.log(`Workspace: ${result.workspaceId}`);
  console.log(`Global SQLite: ${result.globalDatabasePath}`);
  console.log(`Resolved state: ${result.resolved.stateLocation} ${result.resolved.stateRoot}`);
  console.log(`Changed: ${result.changed}`);
  if (result.mismatches.length > 0) {
    console.log(`Mismatches: ${result.mismatches.join(", ")}`);
  }
  console.log("Checks:");
  for (const check of result.checks) {
    console.log(`  ${check.status.padEnd(7)} ${check.id}  ${check.summary}`);
    if (check.remediation) {
      console.log(`          Next: ${check.remediation}`);
    }
  }
}

async function handleDaemonStatus(options: GlobalOptions): Promise<number> {
  const [snapshot, daemon] = await Promise.all([
    readDaemonStateSnapshot(options.cwd),
    probeDaemonHealth(options),
  ]);
  const stateStatus = daemonLifecycleStatus(snapshot, daemon.ok);

  if (options.json) {
    printJson({
      ok: stateStatus !== "stale" && stateStatus !== "conflict" && daemon.ok,
      status: stateStatus,
      daemonUrl: options.daemonUrl,
      pid: snapshot.pid,
      pidAlive: snapshot.pidAlive,
      state: snapshot.state,
      stateError: snapshot.stateError,
      pidError: snapshot.pidError,
      health: daemon.ok ? daemon.health : undefined,
      healthError: daemon.ok ? undefined : daemon.error,
      elapsedMs: daemon.elapsedMs,
    });
    return stateStatus === "stale" || stateStatus === "conflict" ? 4 : daemon.ok ? 0 : 3;
  }

  console.log(`Daemon: ${daemon.ok ? "ok" : "not running"}`);
  console.log(`URL: ${options.daemonUrl}`);
  if (snapshot.pid !== undefined) {
    console.log(`PID: ${snapshot.pid} (${snapshot.pidAlive ? "alive" : "stale"})`);
  }
  if (snapshot.state?.logPath) {
    console.log(`Log: ${snapshot.state.logPath}`);
  }
  if (snapshot.pidError) {
    console.log(`PID state: warning ${snapshot.pidError}`);
  }
  if (snapshot.stateError) {
    console.log(`State: warning ${snapshot.stateError}`);
  }
  if (!daemon.ok) {
    console.log(`Health: ${daemon.error}`);
  } else {
    console.log(`Service: ${daemon.service}`);
    console.log(`Readiness: ${readString(daemon.health, "readiness") ?? "unknown"}`);
  }
  console.log(`Latency: ${daemon.elapsedMs}ms`);
  return stateStatus === "stale" || stateStatus === "conflict" ? 4 : daemon.ok ? 0 : 3;
}

async function handleLocalRestart(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["timeout", "web-url"]),
    booleanFlags: new Set(["force", "skip-build"]),
  });
  assertNoPositionals(parsed.positionals, "restart");
  const timeoutMs = readTimeoutMs(parsed, 10000);
  const webUrl = normalizeDaemonUrl(getFlag(parsed, "web-url") ?? DEFAULT_LOCAL_WEB_URL);
  if (!parsed.booleans.has("force")) {
    await assertNoActiveWorkForLifecycle("restarting", options);
  }
  const result = await restartLocalStack({
    cwd: options.cwd,
    daemonUrl: options.daemonUrl,
    webUrl,
    timeoutMs,
    buildPackages: !parsed.booleans.has("skip-build"),
  });

  if (options.json) {
    printJson(result);
    return result.ok ? 0 : 4;
  }

  console.log("Local stack restarted");
  console.log(`Local package build: ${result.build.ran ? "ok" : `skipped (${result.build.skippedReason ?? "not requested"})`}`);
  printLocalServiceStatus(result.status.daemon);
  printStartupStatusSummary(result.status.startup);
  printLocalServiceStatus(result.status.web);
  return result.ok ? 0 : 4;
}

async function handleLocalStatus(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["web-url", "timeout"]),
  });
  assertNoPositionals(parsed.positionals, "status");
  const timeoutMs = readTimeoutMs(parsed, 1500);
  const status = await readLocalStackStatus({
    cwd: options.cwd,
    daemonUrl: options.daemonUrl,
    webUrl: normalizeDaemonUrl(getFlag(parsed, "web-url") ?? DEFAULT_LOCAL_WEB_URL),
    timeoutMs,
  });

  if (options.json) {
    printJson(status);
    return status.ok ? 0 : 3;
  }

  printLocalStackStatus(status);
  return status.ok ? 0 : 3;
}

async function handleLocalLogs(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["service", "lines"]),
    booleanFlags: new Set(["follow"]),
  });
  assertNoPositionals(parsed.positionals, "logs");
  if (parsed.booleans.has("follow")) {
    throw new CliError(2, "not_implemented", "logs --follow is not implemented yet.");
  }
  const service = readLocalLogService(getFlag(parsed, "service") ?? "all");
  const lineCount = readOptionalIntegerFlag(parsed, "lines") ?? 200;
  if (lineCount < 1) {
    throw new CliError(2, "bad_lines", "--lines must be a positive integer.");
  }
  const logs = await readLocalServiceLogs({
    cwd: options.cwd,
    service,
    lines: lineCount,
  });

  if (options.json) {
    printJson({ logs });
    return logs.some((log) => log.error) ? 4 : 0;
  }

  printLocalServiceLogs(logs);
  return logs.some((log) => log.error) ? 4 : 0;
}

function readLocalLogService(value: string): LocalServiceName | "all" {
  if (value === "daemon" || value === "web" || value === "all") {
    return value;
  }
  throw new CliError(2, "bad_service", "--service must be one of: daemon, web, all.");
}

function printLocalStackStatus(status: LocalStackStatus): void {
  console.log(`Local stack: ${status.ok ? "ready" : "not ready"}`);
  printLocalServiceStatus(status.daemon);
  printStartupStatusSummary(status.startup);
  printLocalServiceStatus(status.web);
}

function printLocalServiceStatus(service: LocalServiceStatus): void {
  const manager = service.launchd.installed ? service.launchd.manager : "unmanaged";
  const pid = service.launchd.pid ? ` pid=${service.launchd.pid}` : "";
  const state = service.launchd.state ? ` state=${service.launchd.state}` : "";
  console.log(`${titleCase(service.name)}: ${service.endpoint.ok ? "ready" : "not ready"} (${service.endpoint.url})`);
  console.log(`  Manager: ${manager} ${service.launchd.label}${state}${pid}`.trimEnd());
  if (service.launchd.error && !service.launchd.installed) {
    console.log(`  Manager error: ${service.launchd.error}`);
  }
  if (service.endpoint.service) {
    console.log(`  Service: ${service.endpoint.service}`);
  }
  if (service.endpoint.readiness) {
    console.log(`  Readiness: ${service.endpoint.readiness}`);
  }
  if (!service.endpoint.ok && service.endpoint.error) {
    console.log(`  Health: ${service.endpoint.error}`);
  }
  if (service.launchd.stdoutPath) {
    console.log(`  Log: ${service.launchd.stdoutPath}`);
  }
}

const REQUIRED_STARTUP_PHASES = [
  "process_config",
  "user_config",
  "workspace_store",
  "effective_config",
  "runtime_policy",
  "secret_resolver",
] as const;

const OPTIONAL_STARTUP_PHASES = [
  "provider_warmup",
  "automation_scheduler",
  "external_work_scheduler",
  "plugin_warmup",
] as const;

function printStartupStatusSummary(status: LocalStartupStatus | undefined): void {
  if (!status) {
    console.log("Startup: unavailable");
    return;
  }
  const state = status.ok ? status.state ?? "unknown" : "unavailable";
  const cwd = status.cwd ? ` ${status.cwd}` : "";
  console.log(`Startup: ${state}${cwd}`);
  if (!status.ok) {
    console.log(`  Status: ${status.error ?? "unavailable"}`);
    return;
  }
  console.log(`  Required: ${formatStartupPhaseSummary(status, REQUIRED_STARTUP_PHASES)}`);
  console.log(`  Warmup: ${formatStartupPhaseSummary(status, OPTIONAL_STARTUP_PHASES)}`);
  if (status.failedRequiredPhase) {
    console.log(`  Failed phase: ${status.failedRequiredPhase}`);
  }
  for (const diagnostic of status.diagnostics.slice(0, 3)) {
    const count = diagnostic.count && diagnostic.count > 1 ? ` x${diagnostic.count}` : "";
    console.log(`  ${diagnostic.level}: ${diagnostic.phase}/${diagnostic.code}${count} - ${diagnostic.message}`);
    if (diagnostic.nextAction) {
      console.log(`    Next: ${diagnostic.nextAction}`);
    }
  }
}

function formatStartupPhaseSummary(
  status: LocalStartupStatus,
  phases: readonly string[],
): string {
  return phases
    .map((phase) => `${phase}=${status.phases[phase] ?? "not_started"}`)
    .join(", ");
}

function printLocalServiceLogs(logs: readonly LocalServiceLog[]): void {
  for (const [index, log] of logs.entries()) {
    if (index > 0) {
      console.log("");
    }
    console.log(`==> ${log.service} (${log.path}) <==`);
    if (log.error) {
      console.log(`Error: ${log.error}`);
      continue;
    }
    for (const line of log.lines) {
      console.log(line);
    }
  }
}

async function readDaemonHealth(options: GlobalOptions): Promise<{
  readonly health: unknown;
  readonly elapsedMs: number;
  readonly service: string;
}> {
  const startedAt = Date.now();
  const health = await requestJson(options, "GET", "/health");
  const elapsedMs = Date.now() - startedAt;
  return {
    health,
    elapsedMs,
    service: readString(health, "service") ?? "unknown",
  };
}

async function probeDaemonHealth(options: GlobalOptions): Promise<{
  readonly ok: boolean;
  readonly health?: unknown;
  readonly elapsedMs: number;
  readonly service: string;
  readonly error?: string;
}> {
  try {
    const health = await readDaemonHealth(options);
    return { ok: true, ...health };
  } catch (error) {
    const elapsedMs = 0;
    return {
      ok: false,
      elapsedMs,
      service: "unknown",
      error: error instanceof CliError ? `${error.code}: ${error.message}` : errorMessage(error),
    };
  }
}

async function requestDoctorJson(
  options: GlobalOptions,
  method: "GET",
  path: string,
  query?: Record<string, QueryValue>,
): Promise<DoctorDependencyResult> {
  try {
    return { ok: true, body: await requestJson(options, method, path, query) };
  } catch (error) {
    if (error instanceof CliError) {
      return {
        ok: false,
        error: {
          code: error.code,
          message: error.message,
          status: error.status,
        },
      };
    }
    return {
      ok: false,
      error: {
        code: "unknown_error",
        message: errorMessage(error),
      },
    };
  }
}

async function preferredDoctorResult(
  preferred: DoctorDependencyResult | undefined,
  fallback: () => Promise<DoctorDependencyResult>,
): Promise<DoctorDependencyResult> {
  if (preferred?.ok) {
    return preferred;
  }
  return await fallback();
}

function controlPlaneDomainResult(
  snapshotResult: DoctorDependencyResult,
  domain: string,
  mapData: (data: Record<string, unknown>) => unknown,
): DoctorDependencyResult | undefined {
  if (!snapshotResult.ok) {
    return undefined;
  }
  const domains = readField(snapshotResult.body, "domains");
  if (!isRecord(domains)) {
    return undefined;
  }
  const domainSnapshot = readField(domains, domain);
  if (!isRecord(domainSnapshot)) {
    return {
      ok: false,
      error: {
        code: "control_plane_domain_missing",
        message: `Control-plane snapshot did not include ${domain}.`,
      },
    };
  }
  if (readBoolean(domainSnapshot, "ok") !== true) {
    const error = readField(domainSnapshot, "error");
    return {
      ok: false,
      error: {
        code: isRecord(error) ? readString(error, "code") ?? "control_plane_domain_failed" : "control_plane_domain_failed",
        message: isRecord(error) ? readString(error, "message") ?? `${domain} snapshot failed.` : `${domain} snapshot failed.`,
      },
    };
  }
  const data = readField(domainSnapshot, "data");
  return {
    ok: true,
    body: mapData(isRecord(data) ? data : {}),
  };
}

async function buildDoctorReport(options: GlobalOptions): Promise<DoctorReport> {
  const snapshot = await readDaemonStateSnapshot(options.cwd);
  const daemon = await probeDaemonHealth(options);
  const storagePaths = resolveStoragePaths(options.cwd);
  const dependencyUnavailable = !daemon.ok;
  const skippedDependency = skippedDoctorDependency("daemon_unreachable", "Daemon is not reachable.");
  const controlPlaneSnapshotResult = dependencyUnavailable
    ? skippedDependency
    : await requestDoctorJson(options, "GET", "/control-plane/snapshot", {
      cwd: options.cwd,
      domains: "providers,skills,approvals,memory,mcp,work_units,runners",
    });
  const snapshotProvidersResult = controlPlaneDomainResult(controlPlaneSnapshotResult, "providers", (data) => ({
    cwd: options.cwd,
    providers: readArray(data, "providers"),
  }));
  const snapshotSkillsResult = controlPlaneDomainResult(controlPlaneSnapshotResult, "skills", (data) => ({
    cwd: options.cwd,
    skills: readArray(data, "skills"),
  }));
  const snapshotApprovalPolicyResult = controlPlaneDomainResult(controlPlaneSnapshotResult, "approvals", (data) => ({
    cwd: options.cwd,
    policy: readField(data, "policy"),
  }));
  const snapshotMemoryReviewPolicyResult = controlPlaneDomainResult(controlPlaneSnapshotResult, "memory", (data) => ({
    cwd: options.cwd,
    policy: readField(data, "reviewPolicy"),
  }));
  const snapshotMcpServersResult = controlPlaneDomainResult(controlPlaneSnapshotResult, "mcp", (data) => ({
    cwd: options.cwd,
    servers: readArray(data, "servers"),
  }));
  const snapshotStaleWorkResult = controlPlaneDomainResult(controlPlaneSnapshotResult, "work_units", (data) => ({
    cwd: options.cwd,
    workUnits: readArray(data, "stale"),
  }));
  const snapshotRunnersResult = controlPlaneDomainResult(controlPlaneSnapshotResult, "runners", (data) => ({
    cwd: options.cwd,
    runners: readArray(data, "runners"),
  }));

  const channelsResult = dependencyUnavailable
    ? skippedDependency
    : await requestDoctorJson(options, "GET", "/channels", { cwd: options.cwd });
  const tasksResult = dependencyUnavailable
    ? skippedDependency
    : await requestDoctorJson(options, "GET", "/tasks", { cwd: options.cwd });
  const providersResult = dependencyUnavailable
    ? skippedDependency
    : await preferredDoctorResult(snapshotProvidersResult, () => requestDoctorJson(options, "GET", "/providers", { cwd: options.cwd }));
  const approvalPolicyResult = dependencyUnavailable
    ? skippedDependency
    : await preferredDoctorResult(snapshotApprovalPolicyResult, () => requestDoctorJson(options, "GET", "/approval-policy", { cwd: options.cwd }));
  const activeLeasesResult = dependencyUnavailable
    ? skippedDependency
    : await requestDoctorJson(options, "GET", "/runtime/leases", { cwd: options.cwd, status: "active" });
  const staleWorkResult = dependencyUnavailable
    ? skippedDependency
    : await preferredDoctorResult(snapshotStaleWorkResult, () => requestDoctorJson(options, "GET", "/runtime/stuck", { cwd: options.cwd }));
  const mcpServersResult = dependencyUnavailable
    ? skippedDependency
    : await preferredDoctorResult(snapshotMcpServersResult, () => requestDoctorJson(options, "GET", "/mcp/servers", { cwd: options.cwd }));
  const skillsResult = dependencyUnavailable
    ? skippedDependency
    : await preferredDoctorResult(snapshotSkillsResult, () => requestDoctorJson(options, "GET", "/skills", { cwd: options.cwd }));
  const memoryReviewPolicyResult = dependencyUnavailable
    ? skippedDependency
    : await preferredDoctorResult(snapshotMemoryReviewPolicyResult, () => requestDoctorJson(options, "GET", "/memory/review-policy", { cwd: options.cwd }));
  const runnersResult = dependencyUnavailable
    ? skippedDependency
    : await preferredDoctorResult(snapshotRunnersResult, () => requestDoctorJson(options, "GET", "/runners", { cwd: options.cwd }));
  const recentRunsResult = dependencyUnavailable
    ? skippedDependency
    : await requestDoctorJson(options, "GET", "/runs", { cwd: options.cwd, limit: 10 });

  const providers = providersResult.ok ? readArray(providersResult.body, "providers") : [];
  const runnableProviders = providers.filter((provider) => providerRunCompatibilityBlocker(provider) === undefined);
  const preflightReadyProviders = runnableProviders.filter((provider) => providerLastCheckReady(provider));
  const uncheckedProviders = runnableProviders.filter((provider) => !isRecord(readField(provider, "lastCheck")));
  const failedProviders = runnableProviders.filter((provider) => {
    const lastCheck = readField(provider, "lastCheck");
    return isRecord(lastCheck) && readBoolean(lastCheck, "ok") !== true;
  });

  const channels = channelsResult.ok ? readArray(channelsResult.body, "channels") : [];
  const channelsWithDefaultProvider = channels.filter((channel) => Boolean(readString(channel, "defaultProviderPresetId")));
  const tasks = tasksResult.ok ? readArray(tasksResult.body, "tasks") : [];
  const activeLeases = activeLeasesResult.ok ? readArray(activeLeasesResult.body, "leases") : [];
  const staleWorkUnits = staleWorkResult.ok ? readArray(staleWorkResult.body, "workUnits") : [];
  const mcpServers = mcpServersResult.ok ? readArray(mcpServersResult.body, "servers") : [];
  const skills = skillsResult.ok ? readArray(skillsResult.body, "skills") : [];
  const builtinSkills = skills.filter((skill) => readString(skill, "reviewStatus") === "builtin");
  const publishedSkills = skills.filter((skill) => readString(skill, "reviewStatus") === "published");
  const approvalPolicyOk = approvalPolicyResult.ok && isRecord(readField(approvalPolicyResult.body, "policy"));
  const memoryReviewPolicy = memoryReviewPolicyResult.ok ? readField(memoryReviewPolicyResult.body, "policy") : undefined;
  const memoryReviewPolicyOk = isRecord(memoryReviewPolicy) &&
    typeof readString(memoryReviewPolicy, "workspaceId") === "string" &&
    typeof readString(memoryReviewPolicy, "mode") === "string";
  const next = buildDoctorNextSteps({
    providers,
    runnableProviders,
    preflightReadyProviders,
    channels,
    approvalPolicyOk,
    providersResult,
    channelsResult,
    tasksResult,
    approvalPolicyResult,
  });
  const checks: DoctorCheck[] = [
    await checkSystemNode(),
    await checkWorkspacePaths(options.cwd),
    await checkWorkspaceSqlite(storagePaths.workspace.databasePath),
    checkDaemonProcessState(snapshot),
    checkDaemonHealth(options, daemon),
    await checkDaemonLogs(snapshot),
    await checkWebHealth(),
    checkProviderDependency("providers.configured", "providers", providersResult, () => {
      if (runnableProviders.length > 0) {
        return okCheck("providers.configured", "providers", `${runnableProviders.length} runnable provider(s) configured`, {
          total: providers.length,
          runnable: runnableProviders.length,
        });
      }
      return failCheck("providers.configured", "providers", "no enabled chat-capable provider is configured", {
        total: providers.length,
        runnable: runnableProviders.length,
      }, "Configure and enable a chat-capable provider.");
    }),
    checkProviderDependency("providers.secrets", "providers", providersResult, () => {
      const missingSecrets = runnableProviders.filter((provider) =>
        readString(provider, "secretStatus") === "missing" ||
        readString(provider, "secretStatus") === "unavailable" ||
        (readString(provider, "apiKeyRef") && readBoolean(provider, "apiKeyConfigured") !== true));
      if (missingSecrets.length === 0) {
        return okCheck("providers.secrets", "providers", "provider secret refs are configured", {
          checked: runnableProviders.length,
        });
      }
      return failCheck("providers.secrets", "providers", `${missingSecrets.length} provider secret ref(s) are missing`, {
        missing: missingSecrets.map((provider) => readString(provider, "id") ?? "unknown"),
      }, "Configure the missing env or keychain secret refs.");
    }),
    checkProviderDependency("providers.preflight", "providers", providersResult, () => {
      if (preflightReadyProviders.length > 0) {
        return okCheck("providers.preflight", "providers", `${preflightReadyProviders.length} provider(s) passed preflight`, {
          runnable: runnableProviders.length,
          preflightReady: preflightReadyProviders.length,
          unchecked: uncheckedProviders.length,
          failed: failedProviders.length,
        });
      }
      return failCheck("providers.preflight", "providers", "no runnable provider has a successful preflight check", {
        runnable: runnableProviders.length,
        preflightReady: preflightReadyProviders.length,
        unchecked: uncheckedProviders.length,
        failed: failedProviders.length,
      }, "Run ling-stack provider check-all.");
    }),
    dependencyCheck("channels.configured", "channels", channelsResult, () => {
      if (channels.length > 0) {
        return okCheck("channels.configured", "channels", `${channels.length} channel(s) configured`, { total: channels.length });
      }
      return failCheck("channels.configured", "channels", "no channel is configured", { total: channels.length }, "Create a channel with ling-stack channel create.");
    }),
    dependencyCheck("channels.default_provider", "channels", channelsResult, () => {
      if (channels.length === 0 || channelsWithDefaultProvider.length === channels.length) {
        return okCheck("channels.default_provider", "channels", "channels have default providers", {
          total: channels.length,
          withDefaultProvider: channelsWithDefaultProvider.length,
        });
      }
      return warningCheck("channels.default_provider", "channels", "some channels lack default providers", {
        total: channels.length,
        withDefaultProvider: channelsWithDefaultProvider.length,
      }, "Set default providers or pass --provider explicitly.");
    }),
    dependencyCheck("approval_policy.load", "policy", approvalPolicyResult, () =>
      approvalPolicyOk
        ? okCheck("approval_policy.load", "policy", "approval policy loads", {})
        : failCheck("approval_policy.load", "policy", "approval policy cannot be loaded", {}, "Run ling-stack policy show.")),
    dependencyCheck("skills.registry", "skills", skillsResult, () =>
      skills.length > 0
        ? okCheck("skills.registry", "skills", "effective skill registry loads", {
          total: skills.length,
          builtin: builtinSkills.length,
          published: publishedSkills.length,
        })
        : warningCheck("skills.registry", "skills", "effective skill registry is empty", {
          total: skills.length,
          builtin: builtinSkills.length,
          published: publishedSkills.length,
        }, "Restart the daemon or refresh skills from the settings UI.")),
    dependencyCheck("memory.review_policy", "memory", memoryReviewPolicyResult, () =>
      memoryReviewPolicyOk
        ? okCheck("memory.review_policy", "memory", "memory review policy loads", {
          workspaceId: readString(memoryReviewPolicy, "workspaceId"),
          mode: readString(memoryReviewPolicy, "mode"),
        })
        : failCheck("memory.review_policy", "memory", "memory review policy cannot be loaded", {}, "Inspect the daemon memory review-policy route.")),
    dependencyCheck("runtime.leases", "runtime", activeLeasesResult, () =>
      activeLeases.length === 0
        ? okCheck("runtime.leases", "runtime", "no active leases", { activeLeases: 0 })
        : warningCheck("runtime.leases", "runtime", `${activeLeases.length} active lease(s)`, { activeLeases: activeLeases.length })),
    dependencyCheck("runtime.stale_work", "runtime", staleWorkResult, () =>
      staleWorkUnits.length === 0
        ? okCheck("runtime.stale_work", "runtime", "no stale work units reported", { staleWorkUnits: 0 })
        : warningCheck("runtime.stale_work", "runtime", `${staleWorkUnits.length} stale work unit(s) reported`, { staleWorkUnits: staleWorkUnits.length })),
    await checkShellSnapshotDiagnostics(options, runnersResult, recentRunsResult),
    dependencyCheck("mcp.servers", "mcp", mcpServersResult, () =>
      okCheck("mcp.servers", "mcp", `${mcpServers.length} MCP server(s) configured`, { total: mcpServers.length })),
    dependencyCheck("mcp.secrets", "mcp", mcpServersResult, () => {
      const missing = mcpServers.filter((server) =>
        readBoolean(server, "enabled") === true &&
        ((readNumber(server, "missingSecretCount") ?? 0) > 0 ||
          readArray(server, "secretStatuses").some((status) => isRecord(status) && readBoolean(status, "configured") !== true)));
      return missing.length === 0
        ? okCheck("mcp.secrets", "mcp", "MCP secret status has no blockers", { missing: 0 })
        : warningCheck("mcp.secrets", "mcp", `${missing.length} MCP server(s) have missing secrets`, { missing: missing.length });
    }),
    dependencyCheck("mcp.legacy_secrets", "mcp", mcpServersResult, () => {
      const legacy = mcpServers.filter((server) => readBoolean(server, "legacySecretMigrationRequired") === true);
      return legacy.length === 0
        ? okCheck("mcp.legacy_secrets", "mcp", "no legacy MCP raw secrets detected", { legacy: 0 })
        : warningCheck("mcp.legacy_secrets", "mcp", `${legacy.length} MCP server(s) require secret ref migration`, { legacy: legacy.length }, "Edit MCP servers to use env: or keychain: secret refs.");
    }),
    dependencyCheck("mcp.status_snapshots", "mcp", mcpServersResult, () => {
      const enabled = mcpServers.filter((server) => readBoolean(server, "enabled") === true);
      const failed = enabled.filter((server) => {
        const snapshot = readField(server, "statusSnapshot");
        return readString(server, "status") === "failed" || (isRecord(snapshot) && readString(snapshot, "status") === "failed");
      });
      const missing = enabled.filter((server) => !readString(server, "status") && !isRecord(readField(server, "statusSnapshot")));
      if (failed.length > 0) {
        return warningCheck("mcp.status_snapshots", "mcp", `${failed.length} MCP server status snapshot(s) failed`, {
          failed: failed.length,
          missing: missing.length,
        }, "Run an MCP check after fixing server config or secret refs.");
      }
      return missing.length === 0
        ? okCheck("mcp.status_snapshots", "mcp", "MCP status snapshots are available", { missing: 0 })
        : warningCheck("mcp.status_snapshots", "mcp", `${missing.length} MCP server(s) have no recent status snapshot`, { missing: missing.length }, "Run an MCP check or sync tools when you need live status.");
    }),
    await checkExternalWorkflow(options.cwd),
  ];
  if (next.length > 0) {
    checks.push({
      id: "doctor.next_steps",
      category: "doctor",
      status: "warning",
      summary: "recommended next steps are available",
      details: { commands: next },
      issues: [],
      durationMs: 0,
    });
  }
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overallStatus: overallDoctorStatus(checks),
    cwd: options.cwd,
    daemonUrl: redactSecretLikeString(options.daemonUrl),
    checks,
  };
}

async function buildDoctorConfigReport(options: GlobalOptions): Promise<DoctorReport> {
  const snapshot = await readDaemonStateSnapshot(options.cwd);
  const paths = resolveConfigPaths(options.cwd);
  const daemon = await probeDaemonHealth(options);
  const startupResult = daemon.ok
    ? await requestDoctorJson(options, "GET", "/startup/status", { cwd: options.cwd })
    : undefined;
  const checks: DoctorCheck[] = [
    await checkWorkspacePaths(options.cwd),
    await checkUserConfigRoot(paths.user.rootDir),
    await checkOptionalUserConfigFile("config.user_config", "user config is optional", paths.user.configPath),
    await checkOptionalUserConfigFile("config.user_settings", "user settings are optional", paths.user.settingsPath),
    await checkOptionalUserConfigFile("config.user_provider_profiles", "user provider profiles are optional", paths.user.providerProfilesPath),
    await checkOptionalUserConfigFile("config.global_sqlite", "global registry is optional", paths.user.globalDatabasePath),
    checkWorkspaceIdentity(paths.workspace),
    await checkWorkspaceRegistry(options.cwd, paths.user.globalDatabasePath, paths.workspace),
    await checkWorkspaceCwdWritable(options.cwd, paths.workspace),
    await checkRepoLocalStateConflict(options.cwd, paths.workspace),
    await checkConfigFile(paths.workspace.configPath),
    await checkWorkspaceSqlite(paths.workspace.databasePath),
    await checkRuntimeSettingsFile(paths.workspace.runtimeSettingsPath),
    await checkPathExists("config.sessions", "config", "sessions directory is under resolved workspace state root", paths.workspace.sessionsDir, "directory", "Run ling-stack init."),
    await checkPathExists("config.artifacts", "config", "artifacts directory is under resolved workspace state root", paths.workspace.artifactsDir, "directory", "Run ling-stack init."),
    await checkPathExists("config.attachments", "config", "attachments directory is under resolved workspace state root", paths.workspace.attachmentsDir, "directory", "Run ling-stack init."),
    await checkPathExists("config.pi", "config", "Pi agent directory is under resolved workspace state root", paths.workspace.piDir, "directory", "Run ling-stack init."),
    await checkPathExists("config.plugins_cache", "config", "plugin cache is under resolved workspace state root", paths.workspace.pluginCacheDir, "directory", "Run ling-stack init."),
    await checkPathExists("config.logs", "config", "logs directory is under resolved workspace state root", snapshot.paths.logsDir, "directory", "Run ling-stack daemon start."),
    checkDaemonProcessState(snapshot),
    ...(startupResult ? buildStartupConfigChecks(startupResult) : []),
    await checkRootLogsLeak(options.cwd),
  ];
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    overallStatus: overallDoctorStatus(checks),
    cwd: options.cwd,
    daemonUrl: redactSecretLikeString(options.daemonUrl),
    checks,
  };
}

async function checkConfigFile(configPath: string): Promise<DoctorCheck> {
  return checkPathExists("config.workspace_config", "config", "workspace config exists", configPath, "file", "Run ling-stack init.");
}

function buildStartupConfigChecks(result: DoctorDependencyResult): readonly DoctorCheck[] {
  if (!result.ok) {
    return [
      warningCheck("startup.status", "startup", "startup status could not be read", {
        error: result.error,
      }, result.error?.code === "daemon_unreachable" ? "Run ling-stack daemon start." : "Inspect /startup/status."),
    ];
  }
  const phases = readField(result.body, "phases");
  const diagnostics = readArray(result.body, "diagnostics");
  const body = result.body;
  const checks = [
    startupPhaseCheck("startup.user_config", "user_config", phases, diagnostics),
    startupPhaseCheck("startup.workspace_store", "workspace_store", phases, diagnostics),
    startupPhaseCheck("startup.effective_config", "effective_config", phases, diagnostics),
    startupPhaseCheck("startup.runtime_policy", "runtime_policy", phases, diagnostics),
    startupPhaseCheck("startup.secret_resolver", "secret_resolver", phases, diagnostics),
  ];
  for (const phase of OPTIONAL_STARTUP_PHASES) {
    const status = readString(phases, phase) ?? "not_started";
    if (status !== "ready") {
      checks.push(startupPhaseCheck(`startup.${phase}`, phase, phases, diagnostics));
    }
  }
  checks.unshift(okCheck("startup.snapshot", "startup", `startup snapshot is ${readString(body, "state") ?? "unknown"}`, {
    cwd: readString(body, "cwd"),
    state: readString(body, "state"),
    startupAttemptId: readString(body, "startupAttemptId"),
    effectiveConfigLoadedAt: readString(body, "effectiveConfigLoadedAt"),
  }));
  return checks;
}

function startupPhaseCheck(
  id: string,
  phase: string,
  phases: unknown,
  diagnostics: readonly unknown[],
): DoctorCheck {
  const status = readString(phases, phase) ?? "not_started";
  const phaseDiagnostics = diagnostics
    .filter((diagnostic) => isRecord(diagnostic) && readString(diagnostic, "phase") === phase)
    .map((diagnostic) => ({
      level: readString(diagnostic, "level"),
      code: readString(diagnostic, "code"),
      message: readString(diagnostic, "message"),
      nextAction: readString(diagnostic, "nextAction"),
    }));
  const details = { phase, status, diagnostics: phaseDiagnostics };
  if (status === "ready") {
    return okCheck(id, "startup", `${phase} is ready`, details);
  }
  const remediation = phaseDiagnostics.find((diagnostic) => diagnostic.nextAction)?.nextAction ??
    (status === "failed" ? "Inspect /startup/status diagnostics." : "Refresh startup status after the daemon settles.");
  if (status === "failed") {
    return failCheck(id, "startup", `${phase} failed`, details, remediation);
  }
  return warningCheck(id, "startup", `${phase} is ${status}`, details, remediation);
}

async function checkRuntimeSettingsFile(path: string): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const item = await stat(path);
    if (!item.isFile()) {
      return warningCheck("config.runtime_settings", "config", "runtime-settings path exists but is not a file", { path }, "Repair .ling-stack/runtime-settings.json.", Date.now() - startedAt);
    }
    return okCheck("config.runtime_settings", "config", "runtime settings are under resolved workspace state root", { path }, Date.now() - startedAt);
  } catch {
    return okCheck("config.runtime_settings", "config", "runtime settings use defaults", { path, exists: false }, Date.now() - startedAt);
  }
}

function checkWorkspaceIdentity(paths: LingStackRuntimePaths): DoctorCheck {
  return okCheck("workspace.identity", "workspace", "workspace storage identity resolved", {
    workspaceId: paths.identity.workspaceId,
    canonicalCwd: paths.identity.canonicalCwd,
    displayName: paths.identity.displayName,
    stateLocation: paths.stateLocation,
    stateRoot: paths.rootDir,
  });
}

async function checkWorkspaceRegistry(
  cwd: string,
  globalDatabasePath: string,
  paths: LingStackRuntimePaths,
): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const databaseFile = await stat(globalDatabasePath);
    if (!databaseFile.isFile()) {
      return warningCheck("workspace.registry", "workspace", "global registry path exists but is not a file", {
        globalDatabasePath,
      }, "Repair ~/.ling-stack/global.sqlite or set LING_STACK_HOME to a valid user root.", Date.now() - startedAt);
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return okCheck("workspace.registry", "workspace", "global workspace registry is not initialized", {
        globalDatabasePath,
        exists: false,
      }, Date.now() - startedAt);
    }
    return warningCheck("workspace.registry", "workspace", "global workspace registry could not be inspected", {
      globalDatabasePath,
      error: errorMessage(error),
    }, "Inspect ~/.ling-stack/global.sqlite permissions.", Date.now() - startedAt);
  }

  let registryEntry: WorkspaceRegistryDiagnosticEntry | undefined;
  try {
    registryEntry = readWorkspaceRegistryEntryReadOnly(globalDatabasePath, resolve(cwd));
  } catch (error) {
    return warningCheck("workspace.registry", "workspace", "global workspace registry could not be read", {
      globalDatabasePath,
      error: errorMessage(error),
    }, "Run ling-stack init or a future registry repair command after backing up workspace state.", Date.now() - startedAt);
  }

  if (!registryEntry) {
    return warningCheck("workspace.registry", "workspace", "global workspace registry has no row for this cwd", {
      globalDatabasePath,
      canonicalCwd: paths.identity.canonicalCwd,
      workspaceId: paths.identity.workspaceId,
    }, "Run ling-stack init to register this workspace after confirming the active state root.", Date.now() - startedAt);
  }

  const mismatches = [];
  if (registryEntry.workspaceId !== paths.identity.workspaceId) {
    mismatches.push("workspace_id");
  }
  if (registryEntry.stateLocation !== paths.stateLocation) {
    mismatches.push("state_location");
  }
  if (resolve(registryEntry.stateRoot) !== resolve(paths.rootDir)) {
    mismatches.push("state_root");
  }
  if (registryEntry.canonicalCwd !== paths.identity.canonicalCwd) {
    mismatches.push("canonical_cwd");
  }
  const details = {
    globalDatabasePath,
    resolved: {
      workspaceId: paths.identity.workspaceId,
      canonicalCwd: paths.identity.canonicalCwd,
      stateLocation: paths.stateLocation,
      stateRoot: paths.rootDir,
    },
    registry: registryEntry,
    mismatches,
  };
  if (mismatches.length > 0) {
    return warningCheck("workspace.registry", "workspace", "global workspace registry row is stale", details, "Run ling-stack init or a future registry repair command after confirming the active state root.", Date.now() - startedAt);
  }
  return okCheck("workspace.registry", "workspace", "global workspace registry matches resolved state", details, Date.now() - startedAt);
}

async function checkWorkspaceCwdWritable(cwd: string, paths: LingStackRuntimePaths): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    await access(resolve(cwd), fsConstants.W_OK);
    return okCheck("workspace.cwd_writable", "workspace", "workspace cwd is writable", {
      cwd: resolve(cwd),
      stateLocation: paths.stateLocation,
    }, Date.now() - startedAt);
  } catch (error) {
    const details = {
      cwd: resolve(cwd),
      stateLocation: paths.stateLocation,
      stateRoot: paths.rootDir,
      writable: false,
      error: errorMessage(error),
    };
    if (paths.stateLocation === "user-data-dir") {
      return okCheck("workspace.cwd_writable", "workspace", "workspace cwd is read-only; user-data-dir state is selected", details, Date.now() - startedAt);
    }
    return warningCheck("workspace.cwd_writable", "workspace", "workspace cwd is not writable while repo-local state is selected", details, "Use user-data-dir for read-only repos: ling-stack workspace migrate-state --to user-data-dir.", Date.now() - startedAt);
  }
}

function readWorkspaceRegistryEntryReadOnly(
  globalDatabasePath: string,
  canonicalCwd: string,
): WorkspaceRegistryDiagnosticEntry | undefined {
  const database = new DatabaseSync(globalDatabasePath, { readOnly: true });
  try {
    const row = database
      .prepare(`
        SELECT workspace_id, canonical_cwd, display_name, state_location, state_root, last_opened_at
        FROM workspaces_registry
        WHERE canonical_cwd = ? AND archived_at IS NULL
        ORDER BY last_opened_at DESC
        LIMIT 1
      `)
      .get(canonicalCwd) as Record<string, SQLOutputValue> | undefined;
    if (!row) {
      return undefined;
    }
    return {
      workspaceId: readSqlString(row, "workspace_id"),
      canonicalCwd: readSqlString(row, "canonical_cwd"),
      displayName: readSqlString(row, "display_name"),
      stateLocation: readSqlWorkspaceStateLocation(row, "state_location"),
      stateRoot: readSqlString(row, "state_root"),
      lastOpenedAt: readSqlString(row, "last_opened_at"),
    };
  } finally {
    database.close();
  }
}

function readSqlWorkspaceStateLocation(row: Record<string, SQLOutputValue>, key: string): WorkspaceStateLocation {
  const value = readSqlString(row, key);
  if (value === "repo-local" || value === "user-data-dir") {
    return value;
  }
  throw new Error(`Unsupported workspace registry state location: ${value}`);
}

function readSqlString(row: Record<string, SQLOutputValue>, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new Error(`Expected workspace registry ${key} to be a string`);
  }
  return value;
}

async function checkRepoLocalStateConflict(cwd: string, paths: LingStackRuntimePaths): Promise<DoctorCheck> {
  const repoLocalDatabasePath = join(resolve(cwd), ".ling-stack", "ling-stack.sqlite");
  if (paths.stateLocation !== "user-data-dir") {
    return okCheck("workspace.repo_local_state", "workspace", "repo-local state is authoritative", {
      stateLocation: paths.stateLocation,
      databasePath: paths.databasePath,
    });
  }
  try {
    const database = await stat(repoLocalDatabasePath);
    if (database.isFile()) {
      return warningCheck("workspace.repo_local_state", "workspace", "repo-local database exists but user-data-dir is selected", {
        stateLocation: paths.stateLocation,
        authoritativeDatabasePath: paths.databasePath,
        unusedDatabasePath: repoLocalDatabasePath,
      }, "Run an explicit migration or archive the unused repo-local state before relying on backups.");
    }
  } catch (error) {
    if (!isMissingPathError(error)) {
      return warningCheck("workspace.repo_local_state", "workspace", "repo-local state could not be inspected", {
        stateLocation: paths.stateLocation,
        authoritativeDatabasePath: paths.databasePath,
        repoLocalDatabasePath,
        error: errorMessage(error),
      }, "Inspect repo-local .ling-stack permissions.");
    }
  }
  return okCheck("workspace.repo_local_state", "workspace", "user-data-dir state is authoritative", {
    stateLocation: paths.stateLocation,
    authoritativeDatabasePath: paths.databasePath,
    repoLocalDatabasePath,
  });
}

async function checkUserConfigRoot(path: string): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const item = await stat(path);
    if (!item.isDirectory()) {
      return warningCheck("config.user_root", "config", "user .ling-stack path exists but is not a directory", { path }, "Repair ~/.ling-stack or set LING_STACK_HOME to a directory.", Date.now() - startedAt);
    }
    return okCheck("config.user_root", "config", "user .ling-stack directory exists", { path, exists: true }, Date.now() - startedAt);
  } catch (error) {
    if (!isMissingPathError(error)) {
      return warningCheck("config.user_root", "config", "user .ling-stack directory could not be inspected", { path, error: errorMessage(error) }, "Repair ~/.ling-stack or set LING_STACK_HOME to a readable directory.", Date.now() - startedAt);
    }
    return okCheck("config.user_root", "config", "user .ling-stack defaults are not initialized", { path, exists: false }, Date.now() - startedAt);
  }
}

async function checkOptionalUserConfigFile(id: string, summary: string, path: string): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const item = await stat(path);
    if (!item.isFile()) {
      return warningCheck(id, "config", `${summary} but path is not a file`, { path }, "Repair the user-level Ling Stack config path.", Date.now() - startedAt);
    }
    return okCheck(id, "config", summary, { path, exists: true }, Date.now() - startedAt);
  } catch (error) {
    if (!isMissingPathError(error)) {
      return warningCheck(id, "config", `${summary} but path could not be inspected`, { path, error: errorMessage(error) }, "Repair the user-level Ling Stack config path.", Date.now() - startedAt);
    }
    return okCheck(id, "config", `${summary}; using workspace or built-in defaults`, { path, exists: false }, Date.now() - startedAt);
  }
}

function isMissingPathError(error: unknown): boolean {
  return isNodeError(error) && error.code === "ENOENT";
}

async function checkRootLogsLeak(cwd: string): Promise<DoctorCheck> {
  const startedAt = Date.now();
  const path = join(cwd, ".logs");
  try {
    const item = await stat(path);
    if (item.isDirectory()) {
      return warningCheck("config.root_logs", "config", "root .logs directory exists outside .ling-stack", { path }, "Move Ling-generated logs under .ling-stack/logs or document .logs as external development cache.", Date.now() - startedAt);
    }
    return warningCheck("config.root_logs", "config", "root .logs path exists outside .ling-stack", { path }, "Remove or document this external cache.", Date.now() - startedAt);
  } catch {
    return okCheck("config.root_logs", "config", "no root .logs Ling state detected", { path }, Date.now() - startedAt);
  }
}

async function checkPathExists(
  id: string,
  category: string,
  summary: string,
  path: string,
  kind: "file" | "directory",
  remediation: string,
): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const item = await stat(path);
    const ok = kind === "file" ? item.isFile() : item.isDirectory();
    if (!ok) {
      return warningCheck(id, category, `${summary} but has the wrong filesystem type`, { path, kind }, remediation, Date.now() - startedAt);
    }
    return okCheck(id, category, summary, { path, kind }, Date.now() - startedAt);
  } catch (error) {
    return warningCheck(id, category, `${summary} is missing`, { path, error: errorMessage(error) }, remediation, Date.now() - startedAt);
  }
}

function buildDoctorNextSteps({
  providers,
  runnableProviders,
  preflightReadyProviders,
  channels,
  approvalPolicyOk,
  providersResult,
  channelsResult,
  tasksResult,
  approvalPolicyResult,
}: {
  readonly providers: readonly unknown[];
  readonly runnableProviders: readonly unknown[];
  readonly preflightReadyProviders: readonly unknown[];
  readonly channels: readonly unknown[];
  readonly approvalPolicyOk: boolean;
  readonly providersResult: DoctorDependencyResult;
  readonly channelsResult: DoctorDependencyResult;
  readonly tasksResult: DoctorDependencyResult;
  readonly approvalPolicyResult: DoctorDependencyResult;
}): readonly string[] {
  const next = new Set<string>();
  if (!providersResult.ok) {
    next.add("ling-stack provider list");
  } else if (providers.length === 0) {
    next.add("ling-stack init --with-provider-templates");
  } else if (runnableProviders.length === 0) {
    const providerId = readString(providers[0], "id") ?? "<provider_id>";
    next.add(`ling-stack provider update ${providerId} --enabled true --api-key-ref env:LOCAL_RELAY_API_KEY`);
  } else if (preflightReadyProviders.length === 0) {
    next.add("ling-stack provider check-all");
  }

  if (!channelsResult.ok) {
    next.add("ling-stack channel list");
  } else if (channels.length === 0) {
    const providerId = readString(preflightReadyProviders[0], "id") ?? readString(runnableProviders[0], "id") ?? "<provider_id>";
    next.add(`ling-stack channel create --name Engineering --path . --provider ${providerId}`);
  }

  if (!tasksResult.ok) {
    next.add("ling-stack task list");
  }
  if (!approvalPolicyOk || !approvalPolicyResult.ok) {
    next.add("ling-stack policy show");
  }
  return [...next];
}

function skippedDoctorDependency(code: string, message: string): DoctorDependencyResult {
  return {
    ok: false,
    error: { code, message },
  };
}

async function checkSystemNode(): Promise<DoctorCheck> {
  const startedAt = Date.now();
  return okCheck("system.node", "system", "Node runtime is available", {
    nodePath: process.execPath,
    nodeVersion: process.version,
  }, Date.now() - startedAt);
}

async function checkWorkspacePaths(cwd: string): Promise<DoctorCheck> {
  const startedAt = Date.now();
  const snapshot = await readDaemonStateSnapshot(cwd);
  try {
    const root = await stat(snapshot.paths.rootDir);
    if (!root.isDirectory()) {
      return failCheck("workspace.paths", "workspace", "workspace state root exists but is not a directory", {
        rootDir: snapshot.paths.rootDir,
      }, "Remove the file and run ling-stack init.", Date.now() - startedAt);
    }
    await access(snapshot.paths.rootDir, fsConstants.W_OK);
    return okCheck("workspace.paths", "workspace", "runtime paths exist", {
      rootDir: snapshot.paths.rootDir,
      daemonDir: snapshot.paths.daemonDir,
      logsDir: snapshot.paths.logsDir,
    }, Date.now() - startedAt);
  } catch (error) {
    return failCheck("workspace.paths", "workspace", "workspace state root is missing or not writable", {
      rootDir: snapshot.paths.rootDir,
      error: errorMessage(error),
    }, "Run ling-stack init.", Date.now() - startedAt);
  }
}

async function checkWorkspaceSqlite(databasePath: string): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const database = await stat(databasePath);
    if (!database.isFile()) {
      return failCheck("workspace.sqlite", "workspace", "SQLite path exists but is not a file", {
        databasePath,
      }, "Repair the workspace database path.", Date.now() - startedAt);
    }
    return okCheck("workspace.sqlite", "workspace", "database file exists", { databasePath }, Date.now() - startedAt);
  } catch (error) {
    return failCheck("workspace.sqlite", "workspace", "workspace database is missing", {
      databasePath,
      error: errorMessage(error),
    }, "Run ling-stack init.", Date.now() - startedAt);
  }
}

function checkDaemonProcessState(snapshot: Awaited<ReturnType<typeof readDaemonStateSnapshot>>): DoctorCheck {
  const details = {
    pid: snapshot.pid,
    pidAlive: snapshot.pidAlive,
    pidPath: snapshot.paths.pidPath,
    statePath: snapshot.paths.statePath,
    pidError: snapshot.pidError,
    stateError: snapshot.stateError,
  };
  if (snapshot.pidError || snapshot.stateError) {
    return warningCheck("daemon.process_state", "daemon", "daemon lifecycle metadata is malformed", details, "Inspect or remove stale daemon files under the resolved workspace state root.");
  }
  if (snapshot.pid === undefined) {
    return okCheck("daemon.process_state", "daemon", "no daemon state file found", details);
  }
  if (snapshot.pidAlive === false) {
    return warningCheck("daemon.process_state", "daemon", "daemon pid is stale", details, "Run ling-stack daemon status or ling-stack daemon start.");
  }
  return okCheck("daemon.process_state", "daemon", "daemon pid is alive", details);
}

function checkDaemonHealth(
  options: GlobalOptions,
  daemon: Awaited<ReturnType<typeof probeDaemonHealth>>,
): DoctorCheck {
  if (!daemon.ok) {
    return failCheck("daemon.health", "daemon", "daemon is not reachable", {
      url: options.daemonUrl,
      error: daemon.error,
    }, "Run ling-stack daemon start.");
  }
  const service = readString(daemon.health, "service");
  if (service !== "ling-stack-daemon") {
    return failCheck("daemon.health", "daemon", "daemon health endpoint is not Ling Stack", {
      url: options.daemonUrl,
      service,
      elapsedMs: daemon.elapsedMs,
    }, "Check --daemon-url or restart the daemon.");
  }
  return okCheck("daemon.health", "daemon", "daemon is reachable", {
    url: options.daemonUrl,
    service,
    elapsedMs: daemon.elapsedMs,
  }, daemon.elapsedMs);
}

async function checkDaemonLogs(snapshot: Awaited<ReturnType<typeof readDaemonStateSnapshot>>): Promise<DoctorCheck> {
  const startedAt = Date.now();
  try {
    const logPath = snapshot.state?.logPath ?? snapshot.paths.logPath;
    const log = await stat(logPath);
    if (!log.isFile()) {
      return warningCheck("daemon.logs", "daemon", "daemon log path is not a file", { logPath }, "Inspect .ling-stack/logs.", Date.now() - startedAt);
    }
    return okCheck("daemon.logs", "daemon", "daemon log file exists", {
      logPath,
      size: log.size,
      modifiedAt: log.mtime.toISOString(),
    }, Date.now() - startedAt);
  } catch (error) {
    if (snapshot.pid === undefined && snapshot.state === undefined) {
      return okCheck("daemon.logs", "daemon", "no daemon log file found", { logPath: snapshot.paths.logPath }, Date.now() - startedAt);
    }
    return warningCheck("daemon.logs", "daemon", "daemon log file is missing or unreadable", {
      logPath: snapshot.state?.logPath ?? snapshot.paths.logPath,
      error: errorMessage(error),
    }, "Run ling-stack daemon start or inspect .ling-stack/logs.", Date.now() - startedAt);
  }
}

async function checkWebHealth(): Promise<DoctorCheck> {
  const startedAt = Date.now();
  const url = "http://127.0.0.1:5173";
  const reachable = await isWebUiReachable(url);
  if (reachable) {
    return okCheck("web.health", "web", "Web UI is reachable", { url }, Date.now() - startedAt);
  }
  return warningCheck("web.health", "web", "Web UI is not reachable", { url }, "Run ling-stack ui --foreground.", Date.now() - startedAt);
}

async function checkExternalWorkflow(cwd: string): Promise<DoctorCheck> {
  const startedAt = Date.now();
  const workflowPath = join(cwd, "WORKFLOW.md");
  try {
    const workflow = await stat(workflowPath);
    if (!workflow.isFile()) {
      return warningCheck("external_work.workflow", "external-work", "WORKFLOW.md exists but is not a file", { workflowPath }, "Repair or remove WORKFLOW.md.", Date.now() - startedAt);
    }
    return okCheck("external_work.workflow", "external-work", "WORKFLOW.md exists", { workflowPath }, Date.now() - startedAt);
  } catch {
    return okCheck("external_work.workflow", "external-work", "no bound WORKFLOW.md found", { workflowPath }, Date.now() - startedAt);
  }
}

async function checkShellSnapshotDiagnostics(
  options: GlobalOptions,
  runnersResult: DoctorDependencyResult,
  recentRunsResult: DoctorDependencyResult,
): Promise<DoctorCheck> {
  const startedAt = Date.now();
  const runners = runnersResult.ok ? readArray(runnersResult.body, "runners") : [];
  const runnersWithCapability = runners
    .filter((runner) => readArray(runner, "capabilities").includes("runtime:shell-snapshot"))
    .map((runner) => readString(runner, "id") ?? "unknown");
  const capabilityAdvertised = runnersWithCapability.length > 0;

  if (!runnersResult.ok) {
    return warningCheck("runtime.shell_snapshots", "runtime", "shell snapshot capability could not be checked", {
      error: runnersResult.error,
    }, "Inspect runner runtime settings.", Date.now() - startedAt);
  }

  if (!recentRunsResult.ok) {
    return warningCheck("runtime.shell_snapshots", "runtime", "recent runs could not be checked for shell snapshots", {
      capabilityAdvertised,
      runnersWithCapability,
      error: recentRunsResult.error,
    }, "Run ling-stack runs list.", Date.now() - startedAt);
  }

  const recentRuns = readArray(recentRunsResult.body, "runs").slice(0, 10);
  let checkedRuns = 0;
  let snapshots = 0;
  let shellSnapshotJsonArtifacts = 0;
  let shellSnapshotTextArtifacts = 0;
  let unreadableJsonArtifacts = 0;
  let missingTextArtifacts = 0;
  const routeFailures: string[] = [];
  const artifactFailures: string[] = [];

  for (const run of recentRuns) {
    const runId = readString(run, "id");
    if (!runId) {
      continue;
    }
    checkedRuns += 1;
    const [snapshotResult, artifactResult] = await Promise.all([
      requestDoctorJson(options, "GET", `/runs/${encodeURIComponent(runId)}/shell-snapshots`, { cwd: options.cwd }),
      requestDoctorJson(options, "GET", `/runs/${encodeURIComponent(runId)}/artifacts`, { cwd: options.cwd }),
    ]);

    let listedSnapshots = 0;
    let listedMissingText = 0;
    if (snapshotResult.ok) {
      const items = readArray(snapshotResult.body, "snapshots");
      listedSnapshots = items.length;
      listedMissingText = items.filter((snapshot) => !readString(snapshot, "textArtifactId")).length;
      snapshots += listedSnapshots;
    } else {
      routeFailures.push(`${runId}: ${snapshotResult.error?.code ?? "unknown_error"}`);
    }

    if (artifactResult.ok) {
      const artifacts = readArray(artifactResult.body, "artifacts");
      const jsonArtifacts = artifacts.filter(isShellSnapshotJsonArtifact);
      const textArtifacts = artifacts.filter(isShellSnapshotTextArtifact);
      shellSnapshotJsonArtifacts += jsonArtifacts.length;
      shellSnapshotTextArtifacts += textArtifacts.length;
      if (snapshotResult.ok) {
        unreadableJsonArtifacts += Math.max(0, jsonArtifacts.length - listedSnapshots);
        missingTextArtifacts += Math.max(listedMissingText, Math.max(0, jsonArtifacts.length - textArtifacts.length));
      }
    } else {
      artifactFailures.push(`${runId}: ${artifactResult.error?.code ?? "unknown_error"}`);
    }
  }

  const details = {
    capabilityAdvertised,
    runnersWithCapability,
    checkedRuns,
    snapshots,
    shellSnapshotJsonArtifacts,
    shellSnapshotTextArtifacts,
    unreadableJsonArtifacts,
    missingTextArtifacts,
    routeFailures,
    artifactFailures,
  };

  if (routeFailures.length > 0) {
    return warningCheck("runtime.shell_snapshots", "runtime", `${routeFailures.length} shell snapshot route check(s) failed`, details, "Inspect the shell snapshot daemon routes.", Date.now() - startedAt);
  }
  if (artifactFailures.length > 0 || unreadableJsonArtifacts > 0 || missingTextArtifacts > 0) {
    return warningCheck("runtime.shell_snapshots", "runtime", "shell snapshot artifacts need inspection", details, "Inspect run artifacts or rerun the command after fixing artifact storage.", Date.now() - startedAt);
  }
  if (!capabilityAdvertised) {
    return warningCheck("runtime.shell_snapshots", "runtime", "shell snapshot runtime capability is not advertised", details, "Enable runtimeTools.shellSnapshot in daemon config when shell diagnostics are needed.", Date.now() - startedAt);
  }
  if (checkedRuns === 0) {
    return okCheck("runtime.shell_snapshots", "runtime", "shell snapshot capability is advertised; no recent runs to inspect", details, Date.now() - startedAt);
  }
  return okCheck("runtime.shell_snapshots", "runtime", "shell snapshot diagnostics are healthy", details, Date.now() - startedAt);
}

function isShellSnapshotJsonArtifact(artifact: unknown): boolean {
  const path = readString(artifact, "path") ?? "";
  return path.includes("/shell-snapshots/") && path.endsWith(".json");
}

function isShellSnapshotTextArtifact(artifact: unknown): boolean {
  const path = readString(artifact, "path") ?? "";
  return path.includes("/shell-snapshots/") && path.endsWith(".txt");
}

function checkProviderDependency(
  id: string,
  category: string,
  result: DoctorDependencyResult,
  build: () => DoctorCheck,
): DoctorCheck {
  return dependencyCheck(id, category, result, build);
}

function dependencyCheck(
  id: string,
  category: string,
  result: DoctorDependencyResult,
  build: () => DoctorCheck,
): DoctorCheck {
  if (result.ok) {
    return build();
  }
  return failCheck(id, category, `${id} could not be checked`, {
    error: result.error,
  }, result.error?.code === "daemon_unreachable" ? "Run ling-stack daemon start." : undefined);
}

function okCheck(
  id: string,
  category: string,
  summary: string,
  details: Readonly<Record<string, unknown>>,
  durationMs = 0,
): DoctorCheck {
  return {
    id,
    category,
    status: "ok",
    summary,
    details: redactDoctorDetails(removeUndefinedDeep(details)) as Readonly<Record<string, unknown>>,
    issues: [],
    durationMs,
  };
}

function warningCheck(
  id: string,
  category: string,
  summary: string,
  details: Readonly<Record<string, unknown>>,
  remediation?: string,
  durationMs = 0,
): DoctorCheck {
  return statusCheck("warning", id, category, summary, details, remediation, durationMs);
}

function failCheck(
  id: string,
  category: string,
  summary: string,
  details: Readonly<Record<string, unknown>>,
  remediation?: string,
  durationMs = 0,
): DoctorCheck {
  return statusCheck("fail", id, category, summary, details, remediation, durationMs);
}

function statusCheck(
  status: Exclude<DoctorStatus, "ok">,
  id: string,
  category: string,
  summary: string,
  details: Readonly<Record<string, unknown>>,
  remediation: string | undefined,
  durationMs: number,
): DoctorCheck {
  return {
    id,
    category,
    status,
    summary,
    details: redactDoctorDetails(removeUndefinedDeep(details)) as Readonly<Record<string, unknown>>,
    issues: [
      {
        severity: status,
        cause: summary,
        ...(remediation ? { remedy: remediation } : {}),
      },
    ],
    remediation,
    durationMs,
  };
}

function redactDoctorDetails(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretLikeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDoctorDetails(item));
  }
  if (!isRecord(value)) {
    return value;
  }
  const redacted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (/token|secret|authorization|cookie|api[-_]?key|password/i.test(key)) {
      redacted[key] = "<redacted>";
      continue;
    }
    redacted[key] = redactDoctorDetails(nestedValue);
  }
  return redacted;
}

function redactSecretLikeString(value: string): string {
  let output = value.replace(/https?:\/\/[^\s"')]+/g, (candidate) => redactUrlString(candidate));
  output = output.replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>");
  output = output.replace(/\b(sk-[A-Za-z0-9._-]+)/g, "<redacted>");
  return output;
}

function redactUrlString(value: string): string {
  try {
    const url = new URL(value);
    if (url.username) {
      url.username = "<redacted>";
    }
    if (url.password) {
      url.password = "<redacted>";
    }
    for (const key of [...url.searchParams.keys()]) {
      if (/token|secret|key|password|code/i.test(key)) {
        url.searchParams.set(key, "<redacted>");
      }
    }
    return normalizeDaemonUrl(url.toString().replace(/%3Credacted%3E/g, "<redacted>"));
  } catch {
    return value;
  }
}

function providerRunCompatibilityBlocker(provider: unknown): string | undefined {
  const displayName = readString(provider, "displayName") ?? readString(provider, "id") ?? "Provider";
  if (readBoolean(provider, "enabled") !== true) {
    return `${displayName}: provider is disabled.`;
  }
  if (readString(provider, "api") === "media-job") {
    return `${displayName}: provider is media only.`;
  }
  if (!readArray(provider, "capabilities").includes("chat")) {
    return `${displayName}: provider does not support chat.`;
  }
  if (readString(provider, "apiKeyRef") && readBoolean(provider, "apiKeyConfigured") !== true) {
    return `${displayName}: ${providerSecretStatus(provider)}.`;
  }
  return undefined;
}

function providerLastCheckReady(provider: unknown): boolean {
  const lastCheck = readField(provider, "lastCheck");
  return isRecord(lastCheck) && readBoolean(lastCheck, "ok") === true;
}

function printDoctorReport(report: DoctorReport, options: { readonly summary: boolean; readonly ascii: boolean }): void {
  if (options.summary) {
    printDoctorSummary(report);
    return;
  }
  console.log("Ling Stack doctor");
  console.log(`Status: ${report.overallStatus}`);
  console.log(`Workspace: ${report.cwd}`);
  console.log(`Daemon URL: ${report.daemonUrl}`);
  const categories = [...new Set(report.checks.map((check) => check.category))];
  for (const category of categories) {
    console.log("");
    console.log(titleCase(category));
    for (const check of report.checks.filter((item) => item.category === category)) {
      const status = options.ascii ? `[${check.status}]` : check.status.padEnd(7, " ");
      console.log(`  ${status} ${check.id.padEnd(28, " ")} ${check.summary}`);
    }
  }
  const next = doctorNextCommands(report);
  if (next.length > 0) {
    console.log("");
    console.log("Next:");
    for (const command of next) {
      console.log(`  ${command}`);
    }
  }
}

function printDoctorSummary(report: DoctorReport): void {
  console.log(`Ling Stack doctor: ${report.overallStatus}`);
  const byCategory = new Map<string, { ok: number; warning: number; fail: number }>();
  for (const check of report.checks) {
    const counts = byCategory.get(check.category) ?? { ok: 0, warning: 0, fail: 0 };
    counts[check.status] += 1;
    byCategory.set(check.category, counts);
  }
  for (const [category, counts] of byCategory) {
    const parts = [
      counts.fail ? `${counts.fail} fail` : undefined,
      counts.warning ? `${counts.warning} warning` : undefined,
      counts.ok ? `${counts.ok} ok` : undefined,
    ].filter((part): part is string => Boolean(part));
    console.log(`${titleCase(category)}: ${parts.join(", ")}`);
  }
  const next = doctorNextCommands(report);
  if (next.length > 0) {
    console.log(`Next: ${next[0]}`);
  }
}

function doctorNextCommands(report: DoctorReport): readonly string[] {
  const commands = new Set<string>();
  for (const check of report.checks) {
    if (check.remediation?.startsWith("Run ling-stack ")) {
      commands.add(check.remediation.slice("Run ".length).replace(/\.$/, ""));
    }
    const detailCommands = readArray(check.details, "commands");
    for (const command of detailCommands) {
      if (typeof command === "string") {
        commands.add(command);
      }
    }
  }
  return [...commands];
}

function titleCase(value: string): string {
  return value
    .split(/[-_]/g)
    .map((part) => part ? `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}` : part)
    .join(" ");
}

async function handleDaemon(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "status", ...rest] = args;
  if (subcommand === "status") {
    assertNoPositionals(rest, "daemon status");
    return await handleDaemonStatus(options);
  }
  if (subcommand === "start") {
    return await handleDaemonStart(rest, options);
  }
  if (subcommand === "stop") {
    return await handleDaemonStop(rest, options);
  }
  if (subcommand === "restart") {
    return await handleDaemonRestart(rest, options);
  }
  if (subcommand === "logs") {
    return await handleDaemonLogs(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown daemon command: ${subcommand}`);
}

async function handleDaemonStart(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["host", "port", "timeout"]),
    booleanFlags: new Set(["foreground"]),
  });
  assertNoPositionals(parsed.positionals, "daemon start");
  const commandOptions = readDaemonCommandOptions(parsed, options);
  if (parsed.booleans.has("foreground")) {
    if (options.json) {
      throw new CliError(2, "unsupported_json", "daemon start --foreground is a long-running process and does not support --json yet.");
    }
    return await runDaemonForeground(commandOptions);
  }
  const health = await probeDaemonHealth(options);
  const snapshot = await readDaemonStateSnapshot(options.cwd);
  if (snapshot.pidAlive && !health.ok) {
    throw new CliError(4, "daemon_state_conflict", "A Ling-managed daemon pid is alive, but its health endpoint is not reachable.");
  }
  if (health.ok && !snapshot.pidAlive) {
    throw new CliError(4, "daemon_state_conflict", "A daemon is already reachable, but no live Ling-managed daemon pid was found for this workspace.");
  }
  const state = await startBackgroundDaemon({
    cwd: options.cwd,
    host: commandOptions.host,
    port: commandOptions.port,
    daemonUrl: commandOptions.daemonUrl,
    daemonCliPath: resolveDaemonCliPath(),
    timeoutMs: commandOptions.timeoutMs,
  }).catch((error: unknown) => {
    const message = errorMessage(error);
    if (message.startsWith("daemon_start_timeout:")) {
      throw new CliError(7, "daemon_start_timeout", message.replace(/^daemon_start_timeout:\s*/, ""));
    }
    throw new CliError(4, "daemon_start_failed", message.replace(/^daemon_start_failed:\s*/, ""));
  });

  if (options.json) {
    printJson({ ok: true, daemon: state });
    return 0;
  }
  console.log("Daemon started");
  console.log(`URL: ${state.url}`);
  console.log(`PID: ${state.pid}`);
  console.log(`Log: ${state.logPath}`);
  return 0;
}

async function handleDaemonStop(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["timeout"]),
    booleanFlags: new Set(["force"]),
  });
  assertNoPositionals(parsed.positionals, "daemon stop");
  const timeoutMs = readTimeoutMs(parsed, 5000);
  if (!parsed.booleans.has("force")) {
    await assertNoActiveWorkForLifecycle("stopping", options);
  }
  const result = await stopDaemonProcess({ cwd: options.cwd, timeoutMs }).catch((error: unknown) => {
    const message = errorMessage(error);
    if (message.startsWith("daemon_not_running:")) {
      throw new CliError(3, "daemon_not_running", message.replace(/^daemon_not_running:\s*/, ""));
    }
    if (message.startsWith("daemon_stop_timeout:")) {
      throw new CliError(7, "daemon_stop_timeout", message.replace(/^daemon_stop_timeout:\s*/, ""));
    }
    throw new CliError(4, "daemon_stop_failed", message);
  });

  if (options.json) {
    printJson({ ok: true, pid: result.pid, stale: result.stale });
    return 0;
  }
  console.log(result.stale ? `Removed stale daemon state for PID ${result.pid}` : `Daemon stopped: ${result.pid}`);
  return 0;
}

async function assertNoActiveWorkForLifecycle(action: "stopping" | "restarting", options: GlobalOptions): Promise<void> {
  const [snapshot, health] = await Promise.all([
    readDaemonStateSnapshot(options.cwd),
    probeDaemonHealth(options),
  ]);
  if (!health.ok) {
    if (snapshot.pidAlive) {
      throw new CliError(4, "daemon_state_conflict", `Cannot verify active work before ${action} the daemon. Use --force to ${action === "stopping" ? "stop" : "restart"} anyway.`);
    }
    return;
  }
  const activeWork = await readActiveWorkCount(options);
  if (activeWork === undefined) {
    throw new CliError(4, "daemon_state_conflict", `Cannot verify active work before ${action} the daemon. Use --force to ${action === "stopping" ? "stop" : "restart"} anyway.`);
  }
  if (activeWork > 0) {
    throw new CliError(4, "daemon_has_active_work", `Daemon has ${activeWork} active work unit(s). Use --force to ${action === "stopping" ? "stop" : "restart"} anyway.`);
  }
}

async function handleDaemonRestart(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["host", "port", "timeout"]),
    booleanFlags: new Set(["force"]),
  });
  assertNoPositionals(parsed.positionals, "daemon restart");
  const commandOptions = readDaemonCommandOptions(parsed, options);
  if (!parsed.booleans.has("force")) {
    await assertNoActiveWorkForLifecycle("restarting", options);
  }
  try {
    await stopDaemonProcess({ cwd: options.cwd, timeoutMs: commandOptions.timeoutMs });
  } catch (error) {
    const message = errorMessage(error);
    if (!message.startsWith("daemon_not_running:")) {
      if (message.startsWith("daemon_stop_timeout:")) {
        throw new CliError(7, "daemon_stop_timeout", message.replace(/^daemon_stop_timeout:\s*/, ""));
      }
      throw new CliError(4, "daemon_stop_failed", message);
    }
  }
  const state = await startBackgroundDaemon({
    cwd: options.cwd,
    host: commandOptions.host,
    port: commandOptions.port,
    daemonUrl: commandOptions.daemonUrl,
    daemonCliPath: resolveDaemonCliPath(),
    timeoutMs: commandOptions.timeoutMs,
  }).catch((error: unknown) => {
    const message = errorMessage(error);
    if (message.startsWith("daemon_start_timeout:")) {
      throw new CliError(7, "daemon_start_timeout", message.replace(/^daemon_start_timeout:\s*/, ""));
    }
    throw new CliError(4, "daemon_start_failed", message.replace(/^daemon_start_failed:\s*/, ""));
  });
  if (options.json) {
    printJson({ ok: true, daemon: state });
    return 0;
  }
  console.log("Daemon restarted");
  console.log(`URL: ${state.url}`);
  console.log(`PID: ${state.pid}`);
  console.log(`Log: ${state.logPath}`);
  return 0;
}

async function handleDaemonLogs(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["lines"]),
    booleanFlags: new Set(["follow"]),
  });
  assertNoPositionals(parsed.positionals, "daemon logs");
  if (parsed.booleans.has("follow")) {
    throw new CliError(2, "not_implemented", "daemon logs --follow is not implemented in P0.");
  }
  const lineCount = readOptionalIntegerFlag(parsed, "lines") ?? 200;
  if (lineCount < 1) {
    throw new CliError(2, "bad_lines", "--lines must be a positive integer.");
  }
  const snapshot = await readDaemonStateSnapshot(options.cwd);
  const result = await readDaemonLogLines(snapshot.paths, snapshot.state, lineCount).catch((error: unknown) => {
    const message = errorMessage(error);
    if (message.startsWith("daemon_log_missing:")) {
      throw new CliError(4, "daemon_log_missing", message.replace(/^daemon_log_missing:\s*/, ""));
    }
    throw new CliError(4, "daemon_log_error", message);
  });
  if (options.json) {
    printJson(result);
    return 0;
  }
  for (const line of result.lines) {
    console.log(line);
  }
  return 0;
}

function readDaemonCommandOptions(parsed: ParsedCommandArgs, options: GlobalOptions): DaemonCommandOptions {
  const listenOptions = readDaemonListenOptions(parsed, options);
  return {
    ...listenOptions,
    daemonUrl: `http://${listenOptions.host}:${listenOptions.port}`,
    timeoutMs: readTimeoutMs(parsed, 5000),
  };
}

function readTimeoutMs(parsed: ParsedCommandArgs, fallback: number): number {
  const raw = getFlag(parsed, "timeout");
  if (raw === undefined) {
    return fallback;
  }
  const value = Number.parseInt(raw, 10);
  if (!Number.isInteger(value) || value < 1 || String(value) !== raw) {
    throw new CliError(2, "bad_timeout", "--timeout must be a positive integer number of milliseconds.");
  }
  return value;
}

function daemonLifecycleStatus(
  snapshot: Awaited<ReturnType<typeof readDaemonStateSnapshot>>,
  healthOk: boolean,
): "running" | "not_running" | "stale" | "conflict" {
  if (snapshot.pidError || snapshot.stateError) {
    return "stale";
  }
  if (snapshot.pidAlive && healthOk) {
    return "running";
  }
  if (snapshot.pidAlive && !healthOk) {
    return "conflict";
  }
  if (snapshot.pid !== undefined && snapshot.pidAlive === false) {
    return "stale";
  }
  if (snapshot.pid === undefined && healthOk) {
    return "running";
  }
  return "not_running";
}

async function readActiveWorkCount(options: GlobalOptions): Promise<number | undefined> {
  try {
    const active = await requestJson(options, "GET", "/runtime/active", { cwd: options.cwd });
    return readArray(active, "workUnits").length;
  } catch {
    return undefined;
  }
}

async function handleDaemonStartForeground(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["host", "port"]),
    booleanFlags: new Set(["foreground"]),
  });
  assertNoPositionals(parsed.positionals, "daemon start");
  if (options.json) {
    throw new CliError(2, "unsupported_json", "daemon start --foreground is a long-running process and does not support --json yet.");
  }

  const listenOptions = readDaemonListenOptions(parsed, options);
  return await runDaemonForeground(listenOptions);
}

async function handleUi(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["host", "port"]),
    booleanFlags: new Set(["open", "foreground"]),
  });
  assertNoPositionals(parsed.positionals, "ui");
  const uiOptions = readUiOptions(parsed);

  if (uiOptions.foreground && options.json) {
    throw new CliError(2, "unsupported_json", "ui --foreground is a long-running process and does not support --json.");
  }

  const [webRunning, daemonRunning] = await Promise.all([
    isWebUiReachable(uiOptions.url),
    isDaemonReachable(options.daemonUrl),
  ]);

  if (uiOptions.foreground) {
    if (webRunning) {
      if (uiOptions.open) {
        openExternalUrl(uiOptions.url);
      }
      console.log(`Ling Stack Web UI already running at ${uiOptions.url}`);
      return 0;
    }
    if (!daemonRunning) {
      console.log(`Daemon is not reachable at ${options.daemonUrl}`);
      console.log("Start it in another terminal:");
      console.log("  ling-stack daemon start --foreground");
    }
    return await runWebForeground(uiOptions, options.daemonUrl, options.cwd);
  }

  const status = {
    url: uiOptions.url,
    daemonUrl: options.daemonUrl,
    webRunning,
    daemonRunning,
    openRequested: uiOptions.open,
    webStartCommand: `ling-stack ui --foreground --port ${uiOptions.port}`,
    daemonStartCommand: "ling-stack daemon start --foreground",
  };

  if (options.json) {
    printJson(status);
    return 0;
  }

  console.log(`Web UI: ${uiOptions.url}`);
  console.log(`Web server: ${webRunning ? "running" : "not running"}`);
  console.log(`Daemon: ${daemonRunning ? "running" : "not running"} (${options.daemonUrl})`);
  if (webRunning && uiOptions.open) {
    openExternalUrl(uiOptions.url);
    console.log("Opened browser.");
  }
  if (!webRunning) {
    console.log("Start Web UI:");
    console.log(`  ${status.webStartCommand}`);
  }
  if (!daemonRunning) {
    console.log("Start daemon:");
    console.log(`  ${status.daemonStartCommand}`);
  }
  return 0;
}

function handleCompletion(args: readonly string[], options: GlobalOptions): number {
  if (options.json) {
    throw new CliError(2, "unsupported_json", "completion outputs shell script and does not support --json.");
  }
  const parsed = parseCommandArgs(args);
  const shell = singlePositional(parsed.positionals, "completion <bash|zsh|fish>");
  if (!isCompletionShell(shell)) {
    throw new CliError(2, "bad_completion_shell", `completion shell must be one of: ${supportedCompletionShells.join(", ")}`);
  }
  process.stdout.write(generateCompletionScript(shell));
  return 0;
}

function isCompletionShell(value: string): value is CompletionShell {
  return (supportedCompletionShells as readonly string[]).includes(value);
}

async function handleRun(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["provider", "title", "task", "thinking", "system-prompt", "agent-dir", "prompt", "prompt-file", "output-last-message"]),
    repeatableFlags: new Set(["tool", "append-system-prompt"]),
    booleanFlags: new Set(["skip-preflight"]),
  });

  const providerPresetId = getFlag(parsed, "provider");
  if (!providerPresetId) {
    throw new CliError(2, "missing_provider", "ling-stack run requires --provider <providerPresetId> for CLI v0.1.");
  }

  const outputLastMessagePath = getFlag(parsed, "output-last-message");
  if (outputLastMessagePath) {
    await validateLastMessageTarget(outputLastMessagePath);
  }
  const promptInput = await readRunPromptInput({
    prompt: getFlag(parsed, "prompt"),
    promptFile: getFlag(parsed, "prompt-file"),
    positionals: parsed.positionals,
    stdin: process.stdin,
    fileBaseCwd: process.cwd(),
  });
  const prompt = promptInput.prompt;

  const thinkingLevel = getFlag(parsed, "thinking") ?? "medium";
  if (!VALID_THINKING_LEVELS.has(thinkingLevel)) {
    throw new CliError(2, "bad_thinking_level", `--thinking must be one of: ${[...VALID_THINKING_LEVELS].join(", ")}`);
  }

  const tools = readTools(parsed);
  const taskId = getFlag(parsed, "task") ?? `task_cli_${randomUUID()}`;
  const title = getFlag(parsed, "title") ?? titleFromPrompt(prompt);
  const appendSystemPrompt = getFlagValues(parsed, "append-system-prompt");
  const skipProviderPreflight = parsed.booleans.has("skip-preflight");
  if (!skipProviderPreflight) {
    await assertProviderRunPreflight(options, providerPresetId);
  }

  const body = removeUndefined({
    cwd: options.cwd,
    providerPresetId,
    skipProviderPreflight: skipProviderPreflight ? true : undefined,
    task: {
      id: taskId,
      title,
      prompt,
    },
    tools,
    thinkingLevel,
    systemPrompt: getFlag(parsed, "system-prompt"),
    appendSystemPrompt: appendSystemPrompt.length > 0 ? appendSystemPrompt : undefined,
    agentDir: getFlag(parsed, "agent-dir"),
  });

  const output = createCliRunOutput(options);
  const lastMessage = outputLastMessagePath ? createLastMessageCollector() : undefined;
  try {
    await streamRun(options, body, (record) => {
      if (record.kind === "ready") {
        output.handleReady(record.runId);
        return;
      }
      lastMessage?.handleEvent(record.envelope);
      output.handleEvent(record.envelope);
    });
  } finally {
    output.finish();
  }
  const exitCode = output.exitCode();
  if (exitCode !== 0) {
    return exitCode;
  }
  if (outputLastMessagePath) {
    const message = lastMessage?.lastCompletedMessage();
    if (message === undefined) {
      throw new CliError(4, "no_final_message", "Run completed without a final assistant message.");
    }
    await writeLastMessageAtomic(outputLastMessagePath, message);
  }
  return 0;
}

async function handleProvider(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  switch (subcommand) {
    case "list":
      return await handleProviderList(rest, options);
    case "add":
      return await handleProviderAdd(rest, options);
    case "show":
      return await handleProviderShow(rest, options);
    case "check-all":
      return await handleProviderCheckAll(rest, options);
    case "check":
      return await handleProviderCheck(rest, options);
    case "update":
      return await handleProviderUpdate(rest, options);
    case "remove":
    case "delete":
      return await handleProviderRemove(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown provider command: ${subcommand}`);
  }
}

async function handleProviderList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "provider list");
  const response = await requestJson(options, "GET", "/providers", { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printProvidersList(response);
  return 0;
}

async function handleProviderAdd(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, providerCommandParserSpec());
  if (parsed.positionals.length !== 1) {
    throw new CliError(2, "bad_usage", "Usage: ling-stack provider add <kind> --name <name> --provider-id <id> --model <model> [options]");
  }
  const kind = parsed.positionals[0];
  assertAllowed("kind", kind, VALID_PROVIDER_KINDS);
  const body = buildProviderAddBody(parsed, kind);
  const response = await requestJson(options, "POST", "/providers", { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  const provider = readField(response, "provider");
  console.log(`Provider created: ${readString(provider, "id") ?? ""}`);
  console.log(`Name: ${readString(provider, "displayName") ?? ""}`);
  console.log(`Model: ${readString(provider, "model") ?? ""}`);
  console.log(`Enabled: ${readBoolean(provider, "enabled") ?? false}`);
  return 0;
}

async function handleProviderShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const providerId = singlePositional(parsed.positionals, "provider show <id>");
  const response = await requestJson(options, "GET", `/providers/${encodeURIComponent(providerId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printProviderDetail(response);
  return 0;
}

async function handleProviderCheck(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const providerId = singlePositional(parsed.positionals, "provider check <id>");
  const response = await requestJson(options, "POST", `/providers/${encodeURIComponent(providerId)}/check`, { cwd: options.cwd });
  const ok = readBoolean(response, "ok") ?? false;
  if (options.json) {
    printJson(response);
    return ok ? 0 : 4;
  }
  console.log(`Provider: ${providerId}`);
  console.log(`Status: ${ok ? "ok" : "failed"}`);
  const code = readString(response, "code");
  if (code) {
    console.log(`Code: ${code}`);
  }
  console.log(`Message: ${readString(response, "message") ?? ""}`);
  console.log(`Checked: ${readString(response, "checkedAt") ?? ""}`);
  return ok ? 0 : 4;
}

async function handleProviderCheckAll(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "provider check-all");
  const listResponse = await requestJson(options, "GET", "/providers", { cwd: options.cwd });
  const providers = readArray(listResponse, "providers");
  const candidates = providers.filter(canBatchCheckProviderResponse);
  const results: ProviderCheckSummary[] = [];

  for (const provider of candidates) {
    const providerId = readString(provider, "id");
    if (!providerId) {
      continue;
    }
    const result = (await requestJson(options, "POST", `/providers/${encodeURIComponent(providerId)}/check`, { cwd: options.cwd })) as ProviderCheckResult;
    results.push({
      providerId,
      displayName: readString(provider, "displayName") ?? providerId,
      ok: result.ok,
      code: result.code,
      message: result.message,
      checkedAt: result.checkedAt,
    });
  }

  const readyCount = results.filter((result) => result.ok).length;
  const failedCount = results.length - readyCount;
  if (options.json) {
    printJson({
      cwd: readString(listResponse, "cwd") ?? options.cwd,
      checked: results,
      skipped: providers.length - candidates.length,
      ready: readyCount,
      failed: failedCount,
    });
    return failedCount === 0 ? 0 : 4;
  }

  if (results.length === 0) {
    console.log("No enabled chat providers to check.");
    return 0;
  }

  printTable(
    ["ID", "Name", "Status", "Code", "Checked"],
    results.map((result) => [
      truncate(result.providerId, 32),
      truncate(result.displayName, 24),
      result.ok ? "ok" : "failed",
      truncate(result.code ?? "", 20),
      truncate(result.checkedAt, 24),
    ]),
  );
  console.log(`Checked ${results.length} chat providers: ${readyCount} ready, ${failedCount} failed.`);
  return failedCount === 0 ? 0 : 4;
}

async function handleProviderUpdate(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, providerCommandParserSpec({ includeClearFlags: true }));
  if (parsed.positionals.length !== 1) {
    throw new CliError(2, "bad_usage", "Usage: ling-stack provider update <id> [options]");
  }
  const providerId = parsed.positionals[0];
  const body = buildProviderUpdateBody(parsed);
  if (Object.keys(body).length === 0) {
    throw new CliError(2, "empty_update", "provider update requires at least one field to update.");
  }
  const response = await requestJson(options, "PATCH", `/providers/${encodeURIComponent(providerId)}`, { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  const provider = readField(response, "provider");
  console.log(`Provider updated: ${readString(provider, "id") ?? providerId}`);
  console.log(`Name: ${readString(provider, "displayName") ?? ""}`);
  console.log(`Model: ${readString(provider, "model") ?? ""}`);
  console.log(`Enabled: ${readBoolean(provider, "enabled") ?? false}`);
  return 0;
}

async function handleProviderRemove(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const providerId = singlePositional(parsed.positionals, "provider remove <id>");
  const response = await requestJson(options, "DELETE", `/providers/${encodeURIComponent(providerId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  console.log(`Provider removed: ${providerId}`);
  return 0;
}

async function handleChannel(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  switch (subcommand) {
    case "list":
      return await handleChannelList(rest, options);
    case "create":
      return await handleChannelCreate(rest, options);
    case "show":
      return await handleChannelShow(rest, options);
    case "update":
      return await handleChannelUpdate(rest, options);
    case "remove":
    case "delete":
      return await handleChannelRemove(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown channel command: ${subcommand}`);
  }
}

async function handleChannelList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["limit"]),
  });
  assertNoPositionals(parsed.positionals, "channel list");
  const response = await requestJson(options, "GET", "/channels", {
    cwd: options.cwd,
    limit: getFlag(parsed, "limit"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printChannelsList(response);
  return 0;
}

async function handleChannelCreate(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, channelCommandParserSpec());
  assertNoPositionals(parsed.positionals, "channel create");
  const name = getFlag(parsed, "name");
  if (!name) {
    throw new CliError(2, "missing_option", "channel create requires --name <name>.");
  }
  const body = removeUndefined({
    name,
    status: readChannelStatusFlag(parsed),
    boundPath: getFlag(parsed, "path") ?? options.cwd,
    defaultProviderPresetId: getFlag(parsed, "provider"),
    defaultTeammateId: getFlag(parsed, "teammate"),
    allowedTools: readChannelTools(parsed),
    runtimePolicy: readChannelRuntimePolicyFlags(parsed),
  });
  const response = await requestJson(options, "POST", "/channels", { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  const channel = readField(response, "channel");
  console.log(`Channel created: ${readString(channel, "id") ?? ""}`);
  console.log(`Name: ${readString(channel, "name") ?? ""}`);
  console.log(`Status: ${readString(channel, "status") ?? "active"}`);
  console.log(`Path: ${readString(channel, "boundPath") ?? ""}`);
  console.log(`Runtime policy: ${formatChannelPolicy(channel)}`);
  return 0;
}

async function handleChannelShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const channelId = singlePositional(parsed.positionals, "channel show <id>");
  const response = await requestJson(options, "GET", `/channels/${encodeURIComponent(channelId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printChannelDetail(response);
  return 0;
}

async function handleChannelUpdate(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, channelCommandParserSpec({ includeClearFlags: true }));
  const channelId = singlePositional(parsed.positionals, "channel update <id>");
  const body = removeUndefined({
    name: getFlag(parsed, "name"),
    status: readChannelStatusFlag(parsed),
    boundPath: readNullableFlag(parsed, "path", parsed.booleans.has("clear-path")),
    defaultProviderPresetId: readNullableFlag(parsed, "provider", parsed.booleans.has("clear-provider")),
    defaultTeammateId: readNullableFlag(parsed, "teammate", parsed.booleans.has("clear-teammate")),
    allowedTools: readChannelTools(parsed),
    runtimePolicy: readChannelRuntimePolicyFlags(parsed),
  });
  if (Object.keys(body).length === 0) {
    throw new CliError(2, "empty_update", "channel update requires at least one field to update.");
  }
  const response = await requestJson(options, "PATCH", `/channels/${encodeURIComponent(channelId)}`, { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  const channel = readField(response, "channel");
  console.log(`Channel updated: ${readString(channel, "id") ?? channelId}`);
  console.log(`Name: ${readString(channel, "name") ?? ""}`);
  console.log(`Status: ${readString(channel, "status") ?? "active"}`);
  console.log(`Runtime policy: ${formatChannelPolicy(channel)}`);
  return 0;
}

async function handleChannelRemove(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const channelId = singlePositional(parsed.positionals, "channel remove <id>");
  await requestJson(options, "DELETE", `/channels/${encodeURIComponent(channelId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson({ ok: true, channelId });
    return 0;
  }
  console.log(`Channel removed: ${channelId}`);
  return 0;
}

async function handleTask(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  switch (subcommand) {
    case "list":
      return await handleTaskList(rest, options);
    case "create":
      return await handleTaskCreate(rest, options);
    case "show":
      return await handleTaskShow(rest, options);
    case "update":
      return await handleTaskUpdate(rest, options);
    case "run":
      return await handleTaskRun(rest, options);
    case "remove":
    case "delete":
      return await handleTaskRemove(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown task command: ${subcommand}`);
  }
}

async function handleTaskList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "status", "limit"]),
  });
  assertNoPositionals(parsed.positionals, "task list");
  const response = await requestJson(options, "GET", "/tasks", {
    cwd: options.cwd,
    channelId: getFlag(parsed, "channel"),
    status: getFlag(parsed, "status"),
    limit: getFlag(parsed, "limit"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printTasksList(response);
  return 0;
}

async function handleTaskCreate(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, taskCommandParserSpec());
  const channelId = getFlag(parsed, "channel");
  if (!channelId) {
    throw new CliError(2, "missing_option", "task create requires --channel <channelId>.");
  }
  const prompt = await readPrompt(parsed);
  if (!prompt) {
    throw new CliError(2, "missing_prompt", "task create requires --prompt <text>, --prompt-file <path>, or prompt text.");
  }
  const title = getFlag(parsed, "title") ?? titleFromPrompt(prompt);
  const body = removeUndefined({
    channelId,
    title,
    prompt,
    status: getFlag(parsed, "status"),
    assigneeTeammateId: getFlag(parsed, "assignee"),
  });
  const response = await requestJson(options, "POST", "/tasks", { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  const task = readField(response, "task");
  console.log(`Task created: ${readString(task, "id") ?? ""}`);
  console.log(`Title: ${readString(task, "title") ?? ""}`);
  console.log(`Status: ${readString(task, "status") ?? ""}`);
  return 0;
}

async function handleTaskShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const taskId = singlePositional(parsed.positionals, "task show <id>");
  const response = await requestJson(options, "GET", `/tasks/${encodeURIComponent(taskId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printTaskDetail(response);
  return 0;
}

async function handleTaskUpdate(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, taskCommandParserSpec({ includeClearFlags: true }));
  const taskId = singlePositional(parsed.positionals, "task update <id>");
  const prompt = await readPrompt(parsed, { includePositionals: false });
  const body = removeUndefined({
    channelId: getFlag(parsed, "channel"),
    title: getFlag(parsed, "title"),
    prompt: prompt || undefined,
    status: getFlag(parsed, "status"),
    assigneeTeammateId: readNullableFlag(parsed, "assignee", parsed.booleans.has("clear-assignee")),
    currentRunId: readNullableFlag(parsed, "current-run", parsed.booleans.has("clear-current-run")),
  });
  if (Object.keys(body).length === 0) {
    throw new CliError(2, "empty_update", "task update requires at least one field to update.");
  }
  const response = await requestJson(options, "PATCH", `/tasks/${encodeURIComponent(taskId)}`, { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  const task = readField(response, "task");
  console.log(`Task updated: ${readString(task, "id") ?? taskId}`);
  console.log(`Status: ${readString(task, "status") ?? ""}`);
  return 0;
}

async function handleTaskRun(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["provider", "thinking", "system-prompt", "agent-dir"]),
    repeatableFlags: new Set(["tool", "append-system-prompt"]),
    booleanFlags: new Set(["skip-preflight"]),
  });
  const taskId = singlePositional(parsed.positionals, "task run <id>");
  const providerPresetId = getFlag(parsed, "provider");
  if (!providerPresetId) {
    throw new CliError(2, "missing_provider", "task run requires --provider <providerPresetId>.");
  }
  const taskResponse = await requestJson(options, "GET", `/tasks/${encodeURIComponent(taskId)}`, { cwd: options.cwd });
  const task = readRequiredRecord(taskResponse, "task");
  const channelId = readString(task, "channelId");
  if (!channelId) {
    throw new CliError(4, "bad_response", "Task response did not include channelId.");
  }
  const channelResponse = await requestJson(options, "GET", `/channels/${encodeURIComponent(channelId)}`, { cwd: options.cwd });
  const channel = readRequiredRecord(channelResponse, "channel");
  const thinkingLevel = getFlag(parsed, "thinking") ?? "medium";
  if (!VALID_THINKING_LEVELS.has(thinkingLevel)) {
    throw new CliError(2, "bad_thinking_level", `--thinking must be one of: ${[...VALID_THINKING_LEVELS].join(", ")}`);
  }
  const skipProviderPreflight = parsed.booleans.has("skip-preflight");
  if (!skipProviderPreflight) {
    await assertProviderRunPreflight(options, providerPresetId);
  }
  const explicitTools = readTools(parsed);
  const channelTools = readArray(channel, "allowedTools").filter((tool): tool is string => typeof tool === "string");
  const body = removeUndefined({
    workspaceCwd: options.cwd,
    cwd: readString(channel, "boundPath") ?? options.cwd,
    providerPresetId,
    skipProviderPreflight: skipProviderPreflight ? true : undefined,
    task: {
      id: taskId,
      title: readString(task, "title") ?? taskId,
      prompt: readString(task, "prompt") ?? "",
      channelId,
    },
    tools: getFlagValues(parsed, "tool").length > 0 ? explicitTools : channelTools,
    thinkingLevel,
    systemPrompt: getFlag(parsed, "system-prompt"),
    appendSystemPrompt: getFlagValues(parsed, "append-system-prompt"),
    agentDir: getFlag(parsed, "agent-dir"),
  });
  const output = createCliRunOutput(options);
  try {
    await streamRun(options, body, (record) => {
      if (record.kind === "ready") {
        output.handleReady(record.runId);
        return;
      }
      output.handleEvent(record.envelope);
    });
  } finally {
    output.finish();
  }
  return output.exitCode();
}

async function handleTaskRemove(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const taskId = singlePositional(parsed.positionals, "task remove <id>");
  await requestJson(options, "DELETE", `/tasks/${encodeURIComponent(taskId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson({ ok: true, taskId });
    return 0;
  }
  console.log(`Task removed: ${taskId}`);
  return 0;
}

async function handlePolicy(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "show", ...rest] = args;
  switch (subcommand) {
    case "show":
      return await handlePolicyShow(rest, options);
    case "set":
      return await handlePolicySet(rest, options);
    case "reset":
      return await handlePolicyReset(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown policy command: ${subcommand}`);
  }
}

async function handlePolicyShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "policy show");
  const response = await requestJson(options, "GET", "/approval-policy", { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printApprovalPolicy(response);
  return 0;
}

async function handlePolicySet(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, policyCommandParserSpec());
  assertNoPositionals(parsed.positionals, "policy set");
  const body = buildPolicySetBody(parsed);
  if (Object.keys(body).length === 0) {
    throw new CliError(2, "empty_update", "policy set requires at least one --tool or --write-path option.");
  }
  const response = await requestJson(options, "PATCH", "/approval-policy", { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  printApprovalPolicy(response);
  return 0;
}

async function handlePolicyReset(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "policy reset");
  const response = await requestJson(options, "PATCH", "/approval-policy", { cwd: options.cwd }, {
    toolDecisions: defaultApprovalToolDecisions,
    allowedWritePaths: defaultAllowedWritePaths,
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printApprovalPolicy(response);
  return 0;
}

async function handleApprovals(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  switch (subcommand) {
    case "list":
      return await handleApprovalsList(rest, options);
    case "show":
      return await handleApprovalsShow(rest, options);
    case "approve":
      return await handleApprovalDecision(rest, options, "approve");
    case "deny":
      return await handleApprovalDecision(rest, options, "deny");
    default:
      throw new CliError(2, "unknown_command", `Unknown approvals command: ${subcommand}`);
  }
}

async function handleApprovalsList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["status", "run-id", "media-job-id", "limit"]),
  });
  assertNoPositionals(parsed.positionals, "approvals list");
  const response = await requestJson(options, "GET", "/approvals", {
    cwd: options.cwd,
    status: getFlag(parsed, "status"),
    runId: getFlag(parsed, "run-id"),
    mediaJobId: getFlag(parsed, "media-job-id"),
    limit: getFlag(parsed, "limit"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printApprovalsList(response);
  return 0;
}

async function handleApprovalsShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const approvalId = singlePositional(parsed.positionals, "approvals show <id>");
  const response = await requestJson(options, "GET", `/approvals/${encodeURIComponent(approvalId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printApprovalDetail(response);
  return 0;
}

async function handleApprovalDecision(
  args: readonly string[],
  options: GlobalOptions,
  decision: "approve" | "deny",
): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["reason"]),
  });
  const approvalId = singlePositional(parsed.positionals, `approvals ${decision} <id>`);
  const response = await requestJson(options, "POST", `/approvals/${encodeURIComponent(approvalId)}/${decision}`, { cwd: options.cwd }, {
    reason: getFlag(parsed, "reason"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  const approval = readField(response, "approval");
  console.log(`Approval ${decision === "approve" ? "approved" : "denied"}: ${readString(approval, "id") ?? approvalId}`);
  console.log(`Status: ${readString(approval, "status") ?? "unknown"}`);
  return 0;
}

async function handleRuns(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  switch (subcommand) {
    case "list":
      return await handleRunsList(rest, options);
    case "show":
      return await handleRunsShow(rest, options);
    case "events":
      return await handleRunsEvents(rest, options);
    case "shell-snapshots":
      return await handleRunsShellSnapshots(rest, options);
    case "shell-snapshot":
      return await handleRunsShellSnapshot(rest, options);
    case "cancel":
      return await handleRunsCancel(rest, options);
    default:
      throw new CliError(2, "unknown_command", `Unknown runs command: ${subcommand}`);
  }
}

async function handleRunsList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["status", "limit"]),
  });
  assertNoPositionals(parsed.positionals, "runs list");
  const response = await requestJson(options, "GET", "/runs", {
    cwd: options.cwd,
    status: getFlag(parsed, "status"),
    limit: getFlag(parsed, "limit"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printRunsList(response);
  return 0;
}

async function handleRunsShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const runId = singlePositional(parsed.positionals, "runs show <id>");
  const response = await requestJson(options, "GET", `/runs/${encodeURIComponent(runId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  const eventsResponse = await requestJson(options, "GET", `/runs/${encodeURIComponent(runId)}/events`, { cwd: options.cwd, limit: 500 });
  printRunDetail(response, eventsResponse);
  return 0;
}

async function handleRunsEvents(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["after-seq", "limit"]),
  });
  const runId = singlePositional(parsed.positionals, "runs events <id>");
  const response = await requestJson(options, "GET", `/runs/${encodeURIComponent(runId)}/events`, {
    cwd: options.cwd,
    afterSeq: getFlag(parsed, "after-seq"),
    limit: getFlag(parsed, "limit"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printRunEvents(response);
  return 0;
}

async function handleRunsShellSnapshots(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["tool-call"]),
  });
  const runId = singlePositional(parsed.positionals, "runs shell-snapshots <run-id>");
  const response = await requestJson(options, "GET", `/runs/${encodeURIComponent(runId)}/shell-snapshots`, {
    cwd: options.cwd,
    toolCallId: getFlag(parsed, "tool-call"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printRunShellSnapshots(response);
  return 0;
}

async function handleRunsShellSnapshot(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  if (parsed.positionals.length !== 2) {
    throw new CliError(2, "usage", "Usage: runs shell-snapshot <run-id> <snapshot-id>");
  }
  const [runId, snapshotId] = parsed.positionals;
  const response = await requestJson(
    options,
    "GET",
    `/runs/${encodeURIComponent(runId)}/shell-snapshots/${encodeURIComponent(snapshotId)}`,
    { cwd: options.cwd },
  );
  if (options.json) {
    printJson(response);
    return 0;
  }
  printRunShellSnapshot(response);
  return 0;
}

async function handleRunsCancel(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const runId = singlePositional(parsed.positionals, "runs cancel <id>");
  const response = await requestJson(options, "POST", `/runs/${encodeURIComponent(runId)}/cancel`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  const run = readField(response, "run");
  console.log(`Run cancelled: ${runId}`);
  console.log(`Active runner: ${readBoolean(response, "active") ?? false ? "yes" : "no"}`);
  console.log(`Status: ${readString(run, "status") ?? "cancelled"}`);
  return 0;
}

async function handleAutomations(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "scheduler", ...rest] = args;
  if (subcommand === "scheduler") {
    return await handleAutomationScheduler(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown automations command: ${subcommand}`);
}

async function handleAutomationScheduler(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "status", ...rest] = args;
  if (subcommand === "start") {
    return await handleAutomationSchedulerStart(rest, options);
  }
  if (subcommand === "status" || subcommand === "list") {
    return await handleAutomationSchedulerStatus(rest, options);
  }
  if (subcommand === "stop") {
    return await handleAutomationSchedulerStop(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown automations scheduler command: ${subcommand}`);
}

async function handleAutomationSchedulerStart(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "automations scheduler start");
  const response = await requestJson(options, "POST", "/automations/scheduler/start", { cwd: options.cwd }, {});
  if (options.json) {
    printJson(response);
    return 0;
  }
  printAutomationSchedulerMutation(response, "Automation scheduler started");
  return 0;
}

async function handleAutomationSchedulerStatus(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "automations scheduler status");
  const response = await requestJson(options, "GET", "/automations/scheduler", { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printAutomationSchedulerList(response);
  return 0;
}

async function handleAutomationSchedulerStop(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "automations scheduler stop");
  const response = await requestJson(options, "POST", "/automations/scheduler/stop", { cwd: options.cwd }, {});
  if (options.json) {
    printJson(response);
    return 0;
  }
  printAutomationSchedulerMutation(response, "Automation scheduler stopped");
  return 0;
}

async function handleExternalWork(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [source = "github", ...rest] = args;
  if (source === "status") {
    return await handleExternalWorkStatus(rest, options);
  }
  if (source === "list") {
    return await handleExternalWorkList(rest, options);
  }
  if (source === "show") {
    return await handleExternalWorkShow(rest, options);
  }
  if (source === "actions") {
    return await handleExternalWorkActions(rest, options);
  }
  if (source === "reconcile") {
    return await handleExternalWorkReconcile(rest, options);
  }
  if (source === "github") {
    return await handleExternalWorkGitHub(rest, options);
  }
  if (source === "linear") {
    return await handleExternalWorkLinear(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown external-work source: ${source}`);
}

async function handleExternalWorkStatus(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "workflow-path"]),
  });
  assertNoPositionals(parsed.positionals, "external-work status");
  const channelId = getFlag(parsed, "channel");
  if (!channelId) {
    throw new CliError(2, "missing_option", "external-work status requires --channel <channelId>.");
  }
  const response = await requestJson(options, "GET", "/external-work/status", {
    cwd: options.cwd,
    channelId,
    workflowPath: getFlag(parsed, "workflow-path"),
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkStatus(response);
  return 0;
}

async function handleExternalWorkList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "status", "source-kind", "work-item-kind", "limit"]),
  });
  assertNoPositionals(parsed.positionals, "external-work list");
  const limit = readOptionalIntegerFlag(parsed, "limit");
  if (limit !== undefined && limit > 500) {
    throw new CliError(2, "bad_number", "--limit must be at most 500.");
  }
  const response = await requestJson(options, "GET", "/external-work", {
    cwd: options.cwd,
    channelId: getFlag(parsed, "channel"),
    status: getFlag(parsed, "status"),
    sourceKind: getFlag(parsed, "source-kind"),
    workItemKind: getFlag(parsed, "work-item-kind"),
    limit,
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkList(response);
  return 0;
}

async function handleExternalWorkShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const externalWorkId = singlePositional(parsed.positionals, "external-work show <externalWorkId>");
  const response = await requestJson(options, "GET", `/external-work/${encodeURIComponent(externalWorkId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkShow(response);
  return 0;
}

async function handleExternalWorkGitHub(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "import", ...rest] = args;
  if (subcommand === "import") {
    return await handleExternalWorkGitHubImport(rest, options);
  }
  if (subcommand === "poll") {
    return await handleExternalWorkGitHubPoll(rest, options);
  }
  if (subcommand === "background") {
    return await handleExternalWorkGitHubBackground(rest, options);
  }
  if (subcommand === "ci") {
    return await handleExternalWorkGitHubCi(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown external-work github command: ${subcommand}`);
}

async function handleExternalWorkGitHubBackground(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "start") {
    return await handleExternalWorkGitHubBackgroundStart(rest, options);
  }
  if (subcommand === "list") {
    return await handleExternalWorkGitHubBackgroundList(rest, options);
  }
  if (subcommand === "stop") {
    return await handleExternalWorkGitHubBackgroundStop(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown external-work github background command: ${subcommand}`);
}

async function handleExternalWorkGitHubCi(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "triage", ...rest] = args;
  if (subcommand === "triage") {
    return await handleExternalWorkGitHubCiTriage(rest, options);
  }
  if (subcommand === "run") {
    return await handleExternalWorkGitHubCiRun(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown external-work github ci command: ${subcommand}`);
}

async function handleExternalWorkLinear(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "import", ...rest] = args;
  if (subcommand === "import") {
    return await handleExternalWorkLinearImport(rest, options);
  }
  if (subcommand === "poll") {
    return await handleExternalWorkLinearPoll(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown external-work linear command: ${subcommand}`);
}

async function handleExternalWorkActions(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "list", ...rest] = args;
  if (subcommand === "propose-comment") {
    return await handleExternalWorkActionProposeComment(rest, options);
  }
  if (subcommand === "propose-labels") {
    return await handleExternalWorkActionProposeLabels(rest, options);
  }
  if (subcommand === "propose-review") {
    return await handleExternalWorkActionProposeReview(rest, options);
  }
  if (subcommand === "list") {
    return await handleExternalWorkActionsList(rest, options);
  }
  if (subcommand === "show") {
    return await handleExternalWorkActionShow(rest, options);
  }
  if (subcommand === "cancel") {
    return await handleExternalWorkActionCancel(rest, options);
  }
  if (subcommand === "execute") {
    return await handleExternalWorkActionExecute(rest, options);
  }
  throw new CliError(2, "unknown_command", `Unknown external-work actions command: ${subcommand}`);
}

async function handleExternalWorkActionProposeComment(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["external-work", "body-file", "approval"]),
  });
  assertNoPositionals(parsed.positionals, "external-work actions propose-comment");
  const externalWorkId = getFlag(parsed, "external-work");
  if (!externalWorkId) {
    throw new CliError(2, "missing_option", "external-work actions propose-comment requires --external-work <id>.");
  }
  const bodyFile = getFlag(parsed, "body-file");
  if (!bodyFile) {
    throw new CliError(2, "missing_option", "external-work actions propose-comment requires --body-file <comment.md>.");
  }
  const response = await requestJson(options, "POST", "/external-work/actions/propose", { cwd: options.cwd }, removeUndefined({
    externalWorkId,
    actionKind: "github_comment",
    approvalRequirement: readApprovalRequirementFlag(parsed),
    payload: {
      type: "github_comment",
      body: await readUtf8File(bodyFile, "comment body file"),
    },
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkActionMutation(response, "External work action proposed");
  return 0;
}

async function handleExternalWorkActionProposeLabels(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["external-work", "approval"]),
    repeatableFlags: new Set(["label"]),
  });
  assertNoPositionals(parsed.positionals, "external-work actions propose-labels");
  const externalWorkId = getFlag(parsed, "external-work");
  if (!externalWorkId) {
    throw new CliError(2, "missing_option", "external-work actions propose-labels requires --external-work <id>.");
  }
  const labels = getFlagValues(parsed, "label").map((label) => label.trim()).filter(Boolean);
  if (labels.length === 0) {
    throw new CliError(2, "missing_option", "external-work actions propose-labels requires at least one --label <name>.");
  }
  const response = await requestJson(options, "POST", "/external-work/actions/propose", { cwd: options.cwd }, removeUndefined({
    externalWorkId,
    actionKind: "github_label",
    approvalRequirement: readApprovalRequirementFlag(parsed),
    payload: {
      type: "github_label",
      labels,
    },
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkActionMutation(response, "External work action proposed");
  return 0;
}

async function handleExternalWorkActionProposeReview(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["external-work", "event", "body-file", "approval"]),
  });
  assertNoPositionals(parsed.positionals, "external-work actions propose-review");
  const externalWorkId = getFlag(parsed, "external-work");
  if (!externalWorkId) {
    throw new CliError(2, "missing_option", "external-work actions propose-review requires --external-work <id>.");
  }
  const event = getFlag(parsed, "event");
  if (event !== "COMMENT" && event !== "APPROVE" && event !== "REQUEST_CHANGES") {
    throw new CliError(2, "bad_option", "external-work actions propose-review requires --event COMMENT|APPROVE|REQUEST_CHANGES.");
  }
  const bodyFile = getFlag(parsed, "body-file");
  if (!bodyFile) {
    throw new CliError(2, "missing_option", "external-work actions propose-review requires --body-file <review.md>.");
  }
  const approvalRequirement = readApprovalRequirementFlag(parsed) ?? "strict";
  if (approvalRequirement !== "strict") {
    throw new CliError(2, "bad_option", "github_pr_review actions require --approval strict.");
  }
  const response = await requestJson(options, "POST", "/external-work/actions/propose", { cwd: options.cwd }, {
    externalWorkId,
    actionKind: "github_pr_review",
    approvalRequirement,
    payload: {
      type: "github_pr_review",
      event,
      body: await readUtf8File(bodyFile, "review body file"),
    },
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkActionMutation(response, "External work action proposed");
  return 0;
}

async function handleExternalWorkActionsList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["external-work", "channel", "status", "action-kind", "limit"]),
  });
  assertNoPositionals(parsed.positionals, "external-work actions list");
  const limit = readOptionalIntegerFlag(parsed, "limit");
  if (limit !== undefined && limit > 500) {
    throw new CliError(2, "bad_number", "--limit must be at most 500.");
  }
  const response = await requestJson(options, "GET", "/external-work/actions", {
    cwd: options.cwd,
    externalWorkId: getFlag(parsed, "external-work"),
    channelId: getFlag(parsed, "channel"),
    status: getFlag(parsed, "status"),
    actionKind: getFlag(parsed, "action-kind"),
    limit,
  });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkActionsList(response);
  return 0;
}

async function handleExternalWorkActionShow(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const actionId = singlePositional(parsed.positionals, "external-work actions show <actionId>");
  const response = await requestJson(options, "GET", `/external-work/actions/${encodeURIComponent(actionId)}`, { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkActionShow(response);
  return 0;
}

async function handleExternalWorkActionCancel(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["reason"]),
  });
  const actionId = singlePositional(parsed.positionals, "external-work actions cancel <actionId>");
  const response = await requestJson(options, "POST", `/external-work/actions/${encodeURIComponent(actionId)}/cancel`, { cwd: options.cwd }, removeUndefined({
    reason: getFlag(parsed, "reason"),
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkActionMutation(response, "External work action cancelled");
  return 0;
}

async function handleExternalWorkActionExecute(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["workflow-path"]),
  });
  const actionId = singlePositional(parsed.positionals, "external-work actions execute <actionId>");
  const response = await requestJson(options, "POST", `/external-work/actions/${encodeURIComponent(actionId)}/execute`, { cwd: options.cwd }, removeUndefined({
    workflowPath: getFlag(parsed, "workflow-path"),
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkActionMutation(response, "External work action executed");
  return 0;
}

async function handleExternalWorkGitHubImport(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "event-type", "payload-file", "workflow-path", "workflow-markdown-file"]),
  });
  assertNoPositionals(parsed.positionals, "external-work github import");
  const channelId = getFlag(parsed, "channel");
  if (!channelId) {
    throw new CliError(2, "missing_option", "external-work github import requires --channel <channelId>.");
  }
  const eventType = getFlag(parsed, "event-type");
  if (!eventType) {
    throw new CliError(2, "missing_option", "external-work github import requires --event-type <eventType>.");
  }
  const payloadFile = getFlag(parsed, "payload-file");
  if (!payloadFile) {
    throw new CliError(2, "missing_option", "external-work github import requires --payload-file <payload.json>.");
  }
  const workflowPath = getFlag(parsed, "workflow-path");
  const workflowMarkdownFile = getFlag(parsed, "workflow-markdown-file");
  if (workflowPath && workflowMarkdownFile) {
    throw new CliError(2, "bad_usage", "--workflow-path and --workflow-markdown-file are mutually exclusive.");
  }

  const payload = await readJsonFile(payloadFile, "payload file");
  const workflowMarkdown = workflowMarkdownFile ? await readUtf8File(workflowMarkdownFile, "workflow markdown file") : undefined;
  const response = await requestJson(options, "POST", "/external-work/github/import", { cwd: options.cwd }, removeUndefined({
    channelId,
    eventType,
    payload,
    workflowPath,
    workflowMarkdown,
  }));

  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkImport(response);
  return 0;
}

async function handleExternalWorkGitHubPoll(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "workflow-path", "limit"]),
    booleanFlags: new Set(["execute-hooks"]),
  });
  assertNoPositionals(parsed.positionals, "external-work github poll");
  const channelId = getFlag(parsed, "channel");
  if (!channelId) {
    throw new CliError(2, "missing_option", "external-work github poll requires --channel <channelId>.");
  }
  const limit = readOptionalIntegerFlag(parsed, "limit");
  if (limit !== undefined && limit > 100) {
    throw new CliError(2, "bad_number", "--limit must be at most 100.");
  }
  const response = await requestJson(options, "POST", "/external-work/github/poll", { cwd: options.cwd }, removeUndefined({
    channelId,
    workflowPath: getFlag(parsed, "workflow-path"),
    limit,
    executeHooks: parsed.booleans.has("execute-hooks") ? true : undefined,
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkPoll(response);
  return 0;
}

async function handleExternalWorkLinearImport(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "event-type", "payload-file", "workflow-path", "workflow-markdown-file"]),
  });
  assertNoPositionals(parsed.positionals, "external-work linear import");
  const channelId = getFlag(parsed, "channel");
  if (!channelId) {
    throw new CliError(2, "missing_option", "external-work linear import requires --channel <channelId>.");
  }
  const eventType = getFlag(parsed, "event-type");
  if (!eventType) {
    throw new CliError(2, "missing_option", "external-work linear import requires --event-type <eventType>.");
  }
  const payloadFile = getFlag(parsed, "payload-file");
  if (!payloadFile) {
    throw new CliError(2, "missing_option", "external-work linear import requires --payload-file <payload.json>.");
  }
  const workflowPath = getFlag(parsed, "workflow-path");
  const workflowMarkdownFile = getFlag(parsed, "workflow-markdown-file");
  if (workflowPath && workflowMarkdownFile) {
    throw new CliError(2, "bad_usage", "--workflow-path and --workflow-markdown-file are mutually exclusive.");
  }

  const payload = await readJsonFile(payloadFile, "payload file");
  const workflowMarkdown = workflowMarkdownFile ? await readUtf8File(workflowMarkdownFile, "workflow markdown file") : undefined;
  const response = await requestJson(options, "POST", "/external-work/linear/import", { cwd: options.cwd }, removeUndefined({
    channelId,
    eventType,
    payload,
    workflowPath,
    workflowMarkdown,
  }));

  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkImport(response);
  return 0;
}

async function handleExternalWorkLinearPoll(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "workflow-path", "limit"]),
    booleanFlags: new Set(["execute-hooks"]),
  });
  assertNoPositionals(parsed.positionals, "external-work linear poll");
  const channelId = getFlag(parsed, "channel");
  if (!channelId) {
    throw new CliError(2, "missing_option", "external-work linear poll requires --channel <channelId>.");
  }
  const limit = readOptionalIntegerFlag(parsed, "limit");
  if (limit !== undefined && limit > 100) {
    throw new CliError(2, "bad_number", "--limit must be at most 100.");
  }
  const response = await requestJson(options, "POST", "/external-work/linear/poll", { cwd: options.cwd }, removeUndefined({
    channelId,
    workflowPath: getFlag(parsed, "workflow-path"),
    limit,
    executeHooks: parsed.booleans.has("execute-hooks") ? true : undefined,
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkPoll(response);
  return 0;
}

async function handleExternalWorkGitHubBackgroundStart(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "workflow-path", "limit"]),
    booleanFlags: new Set(["execute-hooks", "no-run-immediately"]),
  });
  assertNoPositionals(parsed.positionals, "external-work github background start");
  const channelId = getFlag(parsed, "channel");
  if (!channelId) {
    throw new CliError(2, "missing_option", "external-work github background start requires --channel <channelId>.");
  }
  const limit = readOptionalIntegerFlag(parsed, "limit");
  if (limit !== undefined && limit > 100) {
    throw new CliError(2, "bad_number", "--limit must be at most 100.");
  }
  const response = await requestJson(options, "POST", "/external-work/github/background/start", { cwd: options.cwd }, removeUndefined({
    channelId,
    workflowPath: getFlag(parsed, "workflow-path"),
    limit,
    executeHooks: parsed.booleans.has("execute-hooks") ? true : undefined,
    runImmediately: parsed.booleans.has("no-run-immediately") ? false : undefined,
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkBackgroundMutation(response, "External work background scheduler started");
  return 0;
}

async function handleExternalWorkGitHubBackgroundList(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  assertNoPositionals(parsed.positionals, "external-work github background list");
  const response = await requestJson(options, "GET", "/external-work/background", { cwd: options.cwd });
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkBackgroundList(response);
  return 0;
}

async function handleExternalWorkGitHubBackgroundStop(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args);
  const schedulerId = singlePositional(parsed.positionals, "external-work github background stop <schedulerId>");
  const response = await requestJson(options, "POST", `/external-work/background/${encodeURIComponent(schedulerId)}/stop`, { cwd: options.cwd }, {});
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkBackgroundMutation(response, "External work background scheduler stopped");
  return 0;
}

async function handleExternalWorkGitHubCiTriage(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["external-work", "workflow-path", "limit"]),
    booleanFlags: new Set(["no-create-task"]),
  });
  assertNoPositionals(parsed.positionals, "external-work github ci triage");
  const externalWorkId = getFlag(parsed, "external-work");
  if (!externalWorkId) {
    throw new CliError(2, "missing_option", "external-work github ci triage requires --external-work <id>.");
  }
  const limit = readOptionalIntegerFlag(parsed, "limit");
  if (limit !== undefined && limit > 25) {
    throw new CliError(2, "bad_number", "--limit must be at most 25.");
  }
  const response = await requestJson(options, "POST", "/external-work/github/ci/triage", { cwd: options.cwd }, removeUndefined({
    externalWorkId,
    workflowPath: getFlag(parsed, "workflow-path"),
    limit,
    createTask: parsed.booleans.has("no-create-task") ? false : undefined,
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkCiTriage(response);
  return 0;
}

async function handleExternalWorkGitHubCiRun(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["triage", "provider", "thinking", "system-prompt", "agent-dir", "idempotency-key"]),
    repeatableFlags: new Set(["tool", "append-system-prompt"]),
    booleanFlags: new Set(["skip-preflight"]),
  });
  assertNoPositionals(parsed.positionals, "external-work github ci run");
  const triageId = getFlag(parsed, "triage");
  if (!triageId) {
    throw new CliError(2, "missing_option", "external-work github ci run requires --triage <externalWorkCiTriageId>.");
  }
  const providerPresetId = getFlag(parsed, "provider");
  if (!providerPresetId) {
    throw new CliError(2, "missing_provider", "external-work github ci run requires --provider <providerPresetId>.");
  }
  const thinkingLevel = getFlag(parsed, "thinking") ?? "medium";
  if (!VALID_THINKING_LEVELS.has(thinkingLevel)) {
    throw new CliError(2, "bad_thinking_level", `--thinking must be one of: ${[...VALID_THINKING_LEVELS].join(", ")}`);
  }
  const skipProviderPreflight = parsed.booleans.has("skip-preflight");
  if (!skipProviderPreflight) {
    await assertProviderRunPreflight(options, providerPresetId);
  }
  const body = removeUndefined({
    providerPresetId,
    skipProviderPreflight: skipProviderPreflight ? true : undefined,
    idempotencyKey: getFlag(parsed, "idempotency-key"),
    tools: getFlagValues(parsed, "tool").length > 0 ? readTools(parsed) : undefined,
    thinkingLevel,
    systemPrompt: getFlag(parsed, "system-prompt"),
    appendSystemPrompt: getFlagValues(parsed, "append-system-prompt"),
    agentDir: getFlag(parsed, "agent-dir"),
  });
  const output = createCliRunOutput(options);
  try {
    await streamRun(
      options,
      body,
      (record) => {
        if (record.kind === "ready") {
          output.handleReady(record.runId);
          return;
        }
        output.handleEvent(record.envelope);
      },
      `/external-work/github/ci/triage/${encodeURIComponent(triageId)}/run`,
      { cwd: options.cwd },
    );
  } finally {
    output.finish();
  }
  return output.exitCode();
}

async function handleExternalWorkReconcile(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["channel", "workflow-path"]),
  });
  assertNoPositionals(parsed.positionals, "external-work reconcile");
  const response = await requestJson(options, "POST", "/external-work/reconcile", { cwd: options.cwd }, removeUndefined({
    channelId: getFlag(parsed, "channel"),
    workflowPath: getFlag(parsed, "workflow-path"),
  }));
  if (options.json) {
    printJson(response);
    return 0;
  }
  printExternalWorkReconcile(response);
  return 0;
}

async function preflightWorkspaceStateMigration(
  cwd: string,
  targetStateLocation: WorkspaceStateLocation,
): Promise<WorkspaceStateMigrationPreflightResult> {
  const current = resolveStoragePaths(cwd);
  const sourcePaths = current.workspace;
  const target = resolveStoragePaths(cwd, {
    workspaceStateLocation: targetStateLocation,
  });
  const targetPaths = target.workspace;
  const startedAt = new Date().toISOString();
  const migrationId = createWorkspaceMigrationId(sourcePaths, targetPaths, startedAt, "dry-run");
  const migrationRoot = join(current.user.stateDir, "migrations", migrationId);
  const backupRoot = join(migrationRoot, "backup");
  const stagingRoot = workspaceMigrationStagingRoot(targetPaths, migrationId);
  const targetRootStat = await statOptional(targetPaths.rootDir);
  const checks = [
    checkWorkspaceMigrationDirection(sourcePaths, targetPaths),
    await checkWorkspaceMigrationDaemon(cwd),
    await checkWorkspaceMigrationSourceRoot(sourcePaths),
    await checkWorkspaceMigrationSourceDatabase(sourcePaths),
    await checkWorkspaceMigrationTargetRoot(targetPaths, targetRootStat),
    await checkWorkspaceMigrationTargetWritable(targetPaths),
    await checkWorkspaceMigrationMetadataWritable(current.user.stateDir),
    await checkWorkspaceMigrationRepoPointer(sourcePaths, targetPaths),
    await checkWorkspaceMigrationRegistry(current.user.globalDatabasePath, sourcePaths, targetPaths),
  ];
  return {
    cwd: sourcePaths.cwd,
    workspaceId: sourcePaths.identity.workspaceId,
    canMigrate: checks.every((check) => check.status !== "fail"),
    source: workspaceMigrationSide(sourcePaths),
    target: workspaceMigrationSide(targetPaths),
    plan: {
      previewMigrationRoot: migrationRoot,
      previewManifestPath: join(migrationRoot, "manifest.json"),
      previewBackupRoot: backupRoot,
      previewStagingRoot: stagingRoot,
      sourceWillRemain: true,
      targetWillBeBackedUp: Boolean(targetRootStat?.isDirectory()),
      repoPointerWillBeWritten: targetPaths.stateLocation === "user-data-dir",
      registryWillBeUpdated: true,
    },
    checks,
  };
}

function checkWorkspaceMigrationDirection(
  sourcePaths: LingStackRuntimePaths,
  targetPaths: LingStackRuntimePaths,
): WorkspaceStateMigrationPreflightCheck {
  if (sourcePaths.stateLocation === targetPaths.stateLocation) {
    return migrationPreflightCheck("direction", "fail", `workspace state is already ${targetPaths.stateLocation}`, {
      stateLocation: sourcePaths.stateLocation,
    }, "Choose the other state location.");
  }
  if (resolve(sourcePaths.rootDir) === resolve(targetPaths.rootDir)) {
    return migrationPreflightCheck("direction", "fail", "source and target state roots resolve to the same path", {
      sourceRoot: sourcePaths.rootDir,
      targetRoot: targetPaths.rootDir,
    }, "Repair workspace path resolution before migrating.");
  }
  return migrationPreflightCheck("direction", "ok", `${sourcePaths.stateLocation} can migrate to ${targetPaths.stateLocation}`, {
    sourceLocation: sourcePaths.stateLocation,
    targetLocation: targetPaths.stateLocation,
  });
}

async function checkWorkspaceMigrationDaemon(cwd: string): Promise<WorkspaceStateMigrationPreflightCheck> {
  const snapshot = await readDaemonStateSnapshot(cwd);
  const details = {
    pid: snapshot.pid,
    pidAlive: snapshot.pidAlive,
    pidPath: snapshot.paths.pidPath,
    statePath: snapshot.paths.statePath,
    pidError: snapshot.pidError,
    stateError: snapshot.stateError,
  };
  if (snapshot.pidAlive) {
    return migrationPreflightCheck("daemon_stopped", "fail", "daemon is running", details, "Stop the daemon before migrating: ling-stack daemon stop.");
  }
  if (snapshot.pidError || snapshot.stateError) {
    return migrationPreflightCheck("daemon_stopped", "warning", "daemon lifecycle metadata is malformed but no live pid was detected", details, "Inspect stale daemon metadata if migration fails.");
  }
  return migrationPreflightCheck("daemon_stopped", "ok", "daemon is not running", details);
}

async function checkWorkspaceMigrationSourceRoot(paths: LingStackRuntimePaths): Promise<WorkspaceStateMigrationPreflightCheck> {
  try {
    const root = await stat(paths.rootDir);
    if (!root.isDirectory()) {
      return migrationPreflightCheck("source_root", "fail", "source state root is not a directory", {
        sourceRoot: paths.rootDir,
      }, "Repair the source state root before migrating.");
    }
    return migrationPreflightCheck("source_root", "ok", "source state root exists", {
      sourceRoot: paths.rootDir,
    });
  } catch (error) {
    return migrationPreflightCheck("source_root", "fail", "source state root is missing or unreadable", {
      sourceRoot: paths.rootDir,
      error: errorMessage(error),
    }, "Run ling-stack init or restore the source state root before migrating.");
  }
}

async function checkWorkspaceMigrationSourceDatabase(paths: LingStackRuntimePaths): Promise<WorkspaceStateMigrationPreflightCheck> {
  try {
    const database = await stat(paths.databasePath);
    if (!database.isFile()) {
      return migrationPreflightCheck("source_database", "fail", "source SQLite path is not a file", {
        databasePath: paths.databasePath,
      }, "Repair the source database path before migrating.");
    }
    return migrationPreflightCheck("source_database", "ok", "source SQLite database exists", {
      databasePath: paths.databasePath,
    });
  } catch (error) {
    return migrationPreflightCheck("source_database", "fail", "source SQLite database is missing or unreadable", {
      databasePath: paths.databasePath,
      error: errorMessage(error),
    }, "Run ling-stack init or restore the source database before migrating.");
  }
}

async function checkWorkspaceMigrationTargetRoot(
  paths: LingStackRuntimePaths,
  targetRootStat: Awaited<ReturnType<typeof stat>> | undefined,
): Promise<WorkspaceStateMigrationPreflightCheck> {
  if (!targetRootStat) {
    return migrationPreflightCheck("target_root", "ok", "target state root does not exist yet", {
      targetRoot: paths.rootDir,
    });
  }
  if (!targetRootStat.isDirectory()) {
    return migrationPreflightCheck("target_root", "fail", "target state root exists but is not a directory", {
      targetRoot: paths.rootDir,
    }, "Move or remove the target path before migrating.");
  }
  return migrationPreflightCheck("target_root", "warning", "target state root exists and will be backed up before replacement", {
    targetRoot: paths.rootDir,
  });
}

async function checkWorkspaceMigrationTargetWritable(paths: LingStackRuntimePaths): Promise<WorkspaceStateMigrationPreflightCheck> {
  const targetParent = dirname(paths.rootDir);
  const ancestor = await findExistingAncestor(targetParent);
  try {
    await access(ancestor, fsConstants.W_OK);
    return migrationPreflightCheck("target_writable", "ok", "target parent path is writable", {
      targetRoot: paths.rootDir,
      checkedPath: ancestor,
    });
  } catch (error) {
    return migrationPreflightCheck("target_writable", "fail", "target parent path is not writable", {
      targetRoot: paths.rootDir,
      checkedPath: ancestor,
      error: errorMessage(error),
    }, "Choose a writable user root or repair directory permissions before migrating.");
  }
}

async function checkWorkspaceMigrationMetadataWritable(userStateDir: string): Promise<WorkspaceStateMigrationPreflightCheck> {
  const ancestor = await findExistingAncestor(userStateDir);
  try {
    await access(ancestor, fsConstants.W_OK);
    return migrationPreflightCheck("metadata_writable", "ok", "migration metadata path is writable", {
      stateDir: userStateDir,
      checkedPath: ancestor,
    });
  } catch (error) {
    return migrationPreflightCheck("metadata_writable", "fail", "migration metadata path is not writable", {
      stateDir: userStateDir,
      checkedPath: ancestor,
      error: errorMessage(error),
    }, "Repair ~/.ling-stack permissions before migrating.");
  }
}

async function checkWorkspaceMigrationRepoPointer(
  sourcePaths: LingStackRuntimePaths,
  targetPaths: LingStackRuntimePaths,
): Promise<WorkspaceStateMigrationPreflightCheck> {
  if (targetPaths.stateLocation !== "user-data-dir") {
    return migrationPreflightCheck("repo_pointer", "ok", "repo-local target does not need a relocated-state pointer", {
      targetLocation: targetPaths.stateLocation,
    });
  }
  try {
    await access(sourcePaths.rootDir, fsConstants.W_OK);
    return migrationPreflightCheck("repo_pointer", "ok", "repo-local config pointer can be written", {
      pointerPath: join(sourcePaths.rootDir, "config.json"),
    });
  } catch (error) {
    return migrationPreflightCheck("repo_pointer", "fail", "repo-local config pointer cannot be written", {
      pointerPath: join(sourcePaths.rootDir, "config.json"),
      error: errorMessage(error),
    }, "Make repo .ling-stack writable before migrating to user-data-dir.");
  }
}

async function checkWorkspaceMigrationRegistry(
  globalDatabasePath: string,
  sourcePaths: LingStackRuntimePaths,
  targetPaths: LingStackRuntimePaths,
): Promise<WorkspaceStateMigrationPreflightCheck> {
  try {
    const registryStat = await stat(globalDatabasePath);
    if (!registryStat.isFile()) {
      return migrationPreflightCheck("registry_update", "fail", "global registry path exists but is not a file", {
        globalDatabasePath,
      }, "Repair ~/.ling-stack/global.sqlite before migrating.");
    }
  } catch (error) {
    if (isMissingPathError(error)) {
      return migrationPreflightCheck("registry_update", "ok", "global registry will be created or updated", {
        globalDatabasePath,
        exists: false,
      });
    }
    return migrationPreflightCheck("registry_update", "fail", "global registry path could not be inspected", {
      globalDatabasePath,
      error: errorMessage(error),
    }, "Repair ~/.ling-stack permissions before migrating.");
  }

  let registryEntry: WorkspaceRegistryDiagnosticEntry | undefined;
  try {
    registryEntry = readWorkspaceRegistryEntryReadOnly(globalDatabasePath, sourcePaths.identity.canonicalCwd);
  } catch (error) {
    const message = errorMessage(error);
    if (/no such table/i.test(message)) {
      return migrationPreflightCheck("registry_update", "warning", "global registry table is missing and will be initialized", {
        globalDatabasePath,
      });
    }
    return migrationPreflightCheck("registry_update", "fail", "global registry could not be read", {
      globalDatabasePath,
      error: message,
    }, "Repair or back up ~/.ling-stack/global.sqlite before migrating.");
  }

  if (!registryEntry) {
    return migrationPreflightCheck("registry_update", "warning", "global registry has no row for this workspace and will be updated", {
      globalDatabasePath,
      workspaceId: sourcePaths.identity.workspaceId,
      targetStateLocation: targetPaths.stateLocation,
    });
  }
  const mismatches = [];
  if (registryEntry.workspaceId !== sourcePaths.identity.workspaceId) {
    mismatches.push("workspace_id");
  }
  if (registryEntry.stateLocation !== sourcePaths.stateLocation) {
    mismatches.push("state_location");
  }
  if (resolve(registryEntry.stateRoot) !== resolve(sourcePaths.rootDir)) {
    mismatches.push("state_root");
  }
  if (mismatches.length > 0) {
    return migrationPreflightCheck("registry_update", "warning", "global registry row differs from the current source and will be overwritten on success", {
      globalDatabasePath,
      mismatches,
      registry: registryEntry,
      source: workspaceMigrationSide(sourcePaths),
      target: workspaceMigrationSide(targetPaths),
    });
  }
  return migrationPreflightCheck("registry_update", "ok", "global registry can be updated", {
    globalDatabasePath,
    registry: registryEntry,
    targetStateLocation: targetPaths.stateLocation,
  });
}

async function findExistingAncestor(path: string): Promise<string> {
  let current = resolve(path);
  for (;;) {
    if (await statOptional(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
}

function migrationPreflightCheck(
  id: string,
  status: DoctorStatus,
  summary: string,
  details: Readonly<Record<string, unknown>> = {},
  remediation?: string,
): WorkspaceStateMigrationPreflightCheck {
  return removeUndefined({
    id,
    status,
    summary,
    details,
    remediation,
  }) as unknown as WorkspaceStateMigrationPreflightCheck;
}

async function repairWorkspaceRegistry(cwd: string, dryRun: boolean): Promise<WorkspaceRegistryRepairResult> {
  const paths = resolveStoragePaths(cwd);
  const resolved = workspaceRegistryRepairEntry(paths.workspace);
  const globalDatabasePath = paths.user.globalDatabasePath;
  const { registry, checks } = await preflightWorkspaceRegistryRepair(globalDatabasePath, resolved);
  const mismatches = registry ? workspaceRegistryMismatches(registry, resolved) : ["missing_row"];
  const canRepair = checks.every((check) => check.status !== "fail");
  const changed = canRepair && mismatches.length > 0;
  if (changed && !dryRun) {
    registerResolvedWorkspace(cwd, { workspaceStateLocation: paths.workspace.stateLocation });
  }
  return {
    cwd: paths.cwd,
    workspaceId: paths.workspace.identity.workspaceId,
    dryRun,
    canRepair,
    changed,
    globalDatabasePath,
    resolved,
    registry,
    mismatches,
    checks: changed && !dryRun
      ? [
        ...checks,
        migrationPreflightCheck("registry_written", "ok", "global registry row was written", {
          globalDatabasePath,
          workspaceId: resolved.workspaceId,
          stateLocation: resolved.stateLocation,
          stateRoot: resolved.stateRoot,
        }),
      ]
      : checks,
  };
}

async function preflightWorkspaceRegistryRepair(
  globalDatabasePath: string,
  resolved: WorkspaceRegistryRepairEntry,
): Promise<{
  readonly registry?: WorkspaceRegistryDiagnosticEntry;
  readonly checks: readonly WorkspaceStateMigrationPreflightCheck[];
}> {
  const checks: WorkspaceStateMigrationPreflightCheck[] = [];
  try {
    const registryPath = await stat(globalDatabasePath);
    if (!registryPath.isFile()) {
      return {
        checks: [
          migrationPreflightCheck("registry_path", "fail", "global registry path exists but is not a file", {
            globalDatabasePath,
          }, "Move or remove the non-file global.sqlite path before repairing the registry."),
        ],
      };
    }
    checks.push(migrationPreflightCheck("registry_path", "ok", "global registry file exists", {
      globalDatabasePath,
    }));
  } catch (error) {
    if (isMissingPathError(error)) {
      checks.push(migrationPreflightCheck("registry_path", "ok", "global registry will be created", {
        globalDatabasePath,
        exists: false,
      }));
      return {
        checks: [
          ...checks,
          migrationPreflightCheck("registry_row", "warning", "global registry has no row for this workspace and will be written", {
            workspaceId: resolved.workspaceId,
            stateLocation: resolved.stateLocation,
            stateRoot: resolved.stateRoot,
          }),
        ],
      };
    }
    return {
      checks: [
        migrationPreflightCheck("registry_path", "fail", "global registry path could not be inspected", {
          globalDatabasePath,
          error: errorMessage(error),
        }, "Repair ~/.ling-stack permissions before repairing the registry."),
      ],
    };
  }

  let registry: WorkspaceRegistryDiagnosticEntry | undefined;
  try {
    registry = readWorkspaceRegistryEntryReadOnly(globalDatabasePath, resolved.canonicalCwd);
  } catch (error) {
    const message = errorMessage(error);
    if (!/no such table/i.test(message)) {
      return {
        checks: [
          ...checks,
          migrationPreflightCheck("registry_read", "fail", "global registry could not be read", {
            globalDatabasePath,
            error: message,
          }, "Back up or repair ~/.ling-stack/global.sqlite before repairing the row."),
        ],
      };
    }
    checks.push(migrationPreflightCheck("registry_read", "warning", "global registry table is missing and will be initialized", {
      globalDatabasePath,
    }));
  }

  if (!registry) {
    return {
      registry,
      checks: [
        ...checks,
        migrationPreflightCheck("registry_row", "warning", "global registry has no row for this workspace and will be written", {
          workspaceId: resolved.workspaceId,
          stateLocation: resolved.stateLocation,
          stateRoot: resolved.stateRoot,
        }),
      ],
    };
  }

  const mismatches = workspaceRegistryMismatches(registry, resolved);
  if (mismatches.length === 0) {
    return {
      registry,
      checks: [
        ...checks,
        migrationPreflightCheck("registry_row", "ok", "global registry row already matches resolved workspace state", {
          registry,
        }),
      ],
    };
  }
  return {
    registry,
    checks: [
      ...checks,
      migrationPreflightCheck("registry_row", "warning", "global registry row will be updated to match resolved workspace state", {
        mismatches,
        registry,
        resolved,
      }),
    ],
  };
}

function workspaceRegistryRepairEntry(paths: LingStackRuntimePaths): WorkspaceRegistryRepairEntry {
  return {
    workspaceId: paths.identity.workspaceId,
    canonicalCwd: paths.identity.canonicalCwd,
    displayName: paths.identity.displayName,
    stateLocation: paths.stateLocation,
    stateRoot: paths.rootDir,
  };
}

function workspaceRegistryMismatches(
  registry: WorkspaceRegistryDiagnosticEntry,
  resolved: WorkspaceRegistryRepairEntry,
): readonly string[] {
  const mismatches = [];
  if (registry.workspaceId !== resolved.workspaceId) {
    mismatches.push("workspace_id");
  }
  if (registry.canonicalCwd !== resolved.canonicalCwd) {
    mismatches.push("canonical_cwd");
  }
  if (registry.displayName !== resolved.displayName) {
    mismatches.push("display_name");
  }
  if (registry.stateLocation !== resolved.stateLocation) {
    mismatches.push("state_location");
  }
  if (resolve(registry.stateRoot) !== resolve(resolved.stateRoot)) {
    mismatches.push("state_root");
  }
  return mismatches;
}

async function migrateWorkspaceState(
  cwd: string,
  targetStateLocation: WorkspaceStateLocation,
): Promise<WorkspaceStateMigrationResult> {
  const current = resolveStoragePaths(cwd);
  const sourcePaths = current.workspace;
  if (sourcePaths.stateLocation === targetStateLocation) {
    throw new CliError(2, "already_selected", `Workspace state is already ${targetStateLocation}.`);
  }

  await assertDaemonStoppedForWorkspaceMigration(cwd);
  await assertWorkspaceStateSource(sourcePaths);

  const target = resolveStoragePaths(cwd, {
    workspaceStateLocation: targetStateLocation,
  });
  const targetPaths = target.workspace;
  if (resolve(sourcePaths.rootDir) === resolve(targetPaths.rootDir)) {
    throw new CliError(2, "same_state_root", "Source and target workspace state roots resolve to the same path.");
  }

  const startedAt = new Date().toISOString();
  const migrationId = createWorkspaceMigrationId(sourcePaths, targetPaths, startedAt);
  const migrationRoot = join(current.user.stateDir, "migrations", migrationId);
  const backupRoot = join(migrationRoot, "backup");
  const manifestPath = join(migrationRoot, "manifest.json");
  const stagingRoot = workspaceMigrationStagingRoot(targetPaths, migrationId);
  const source = workspaceMigrationSide(sourcePaths);
  const targetSide = workspaceMigrationSide(targetPaths);
  const baseManifest = {
    schemaVersion: 1,
    migrationId,
    status: "started",
    startedAt,
    cwd: sourcePaths.cwd,
    workspaceId: sourcePaths.identity.workspaceId,
    source,
    target: targetSide,
    stagingRoot,
    backupRoot,
  };

  await mkdir(backupRoot, { recursive: true });
  await writeJsonDocument(manifestPath, baseManifest);

  let targetBackupRoot: string | undefined;
  let sourceConfigBackupPath: string | undefined;
  let sourceConfigReplaced = false;
  let targetExistingRemoved = false;
  let targetInstalled = false;
  let registryUpdated = false;

  try {
    await assertWorkspaceStateTarget(targetPaths.rootDir);
    await mkdir(dirname(stagingRoot), { recursive: true });
    await cp(sourcePaths.rootDir, stagingRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await writeWorkspaceConfig(join(stagingRoot, "config.json"), targetPaths, "ling-stack workspace migrate-state", {
      exclusive: false,
    });
    const copiedPaths = await listTopLevelPaths(stagingRoot);

    targetBackupRoot = await backupExistingStateRoot(targetPaths.rootDir, backupRoot);
    if (targetBackupRoot) {
      await rm(targetPaths.rootDir, { recursive: true, force: true });
      targetExistingRemoved = true;
    }
    await mkdir(dirname(targetPaths.rootDir), { recursive: true });
    await moveStagingStateRoot(stagingRoot, targetPaths.rootDir);
    targetInstalled = true;

    if (targetPaths.stateLocation === "user-data-dir") {
      sourceConfigBackupPath = await backupFileIfPresent(sourcePaths.configPath, backupRoot, "repo-local-config-before.json");
      await writeRepoLocalWorkspacePointer(cwd, targetPaths, {
        createdBy: "ling-stack workspace migrate-state pointer",
        replaceExisting: true,
      });
      sourceConfigReplaced = true;
    }

    registerResolvedWorkspace(cwd, { workspaceStateLocation: targetPaths.stateLocation });
    registryUpdated = true;

    const completedAt = new Date().toISOString();
    await writeJsonDocument(manifestPath, {
      ...baseManifest,
      status: "succeeded",
      completedAt,
      copiedPaths,
      backups: {
        targetExistingRoot: targetBackupRoot,
        repoLocalConfigBefore: sourceConfigBackupPath,
      },
    });

    return {
      cwd: sourcePaths.cwd,
      workspaceId: sourcePaths.identity.workspaceId,
      source,
      target: targetSide,
      manifestPath,
      backupRoot,
      copiedPaths,
    };
  } catch (error) {
    await rm(stagingRoot, { recursive: true, force: true }).catch(() => undefined);
    if (sourceConfigReplaced) {
      await restoreFileBackup(sourceConfigBackupPath, sourcePaths.configPath).catch(() => undefined);
    }
    if (targetInstalled || targetExistingRemoved) {
      await restoreStateRootBackup(targetBackupRoot, targetPaths.rootDir).catch(() => undefined);
    }
    if (registryUpdated) {
      try {
        registerResolvedWorkspace(cwd, { workspaceStateLocation: sourcePaths.stateLocation });
      } catch {
        // The manifest below records the original failure; registry repair is best effort.
      }
    }
    await writeJsonDocument(manifestPath, {
      ...baseManifest,
      status: "failed",
      failedAt: new Date().toISOString(),
      error: errorMessage(error),
      backups: {
        targetExistingRoot: targetBackupRoot,
        repoLocalConfigBefore: sourceConfigBackupPath,
      },
    }).catch(() => undefined);
    throw error;
  }
}

async function assertDaemonStoppedForWorkspaceMigration(cwd: string): Promise<void> {
  const snapshot = await readDaemonStateSnapshot(cwd);
  if (snapshot.pidAlive) {
    throw new CliError(
      2,
      "daemon_running",
      `Stop the Ling Stack daemon before migrating workspace state. Active daemon pid: ${snapshot.pid}.`,
    );
  }
}

async function assertWorkspaceStateSource(paths: LingStackRuntimePaths): Promise<void> {
  const root = await statRequired(paths.rootDir, "source_state_missing", "Source workspace state root is missing.");
  if (!root.isDirectory()) {
    throw new CliError(2, "source_state_invalid", `Source workspace state root is not a directory: ${paths.rootDir}`);
  }
  const database = await statRequired(paths.databasePath, "source_database_missing", "Source workspace database is missing.");
  if (!database.isFile()) {
    throw new CliError(2, "source_database_invalid", `Source workspace database is not a file: ${paths.databasePath}`);
  }
}

async function assertWorkspaceStateTarget(targetRoot: string): Promise<void> {
  const target = await statOptional(targetRoot);
  if (target && !target.isDirectory()) {
    throw new CliError(2, "target_state_invalid", `Target workspace state root exists but is not a directory: ${targetRoot}`);
  }
}

async function statRequired(path: string, code: string, message: string): Promise<Awaited<ReturnType<typeof stat>>> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new CliError(2, code, message);
    }
    throw error;
  }
}

async function statOptional(path: string): Promise<Awaited<ReturnType<typeof stat>> | undefined> {
  try {
    return await stat(path);
  } catch (error) {
    if (isMissingPathError(error)) {
      return undefined;
    }
    throw error;
  }
}

function createWorkspaceMigrationId(
  sourcePaths: LingStackRuntimePaths,
  targetPaths: LingStackRuntimePaths,
  startedAt: string,
  suffixOverride?: string,
): string {
  const timestamp = startedAt.replace(/[:.]/g, "-");
  const suffix = suffixOverride ?? randomUUID().replace(/-/g, "").slice(0, 8);
  return `migration_${timestamp}_${sourcePaths.identity.workspaceId}_${sourcePaths.stateLocation}_to_${targetPaths.stateLocation}_${suffix}`;
}

function workspaceMigrationStagingRoot(targetPaths: LingStackRuntimePaths, migrationId: string): string {
  const targetName = basename(targetPaths.rootDir).replace(/^\.+/, "") || "workspace-state";
  return join(dirname(targetPaths.rootDir), `.${targetName}.${migrationId}.staging`);
}

function workspaceMigrationSide(paths: LingStackRuntimePaths): WorkspaceStateMigrationSide {
  return {
    stateLocation: paths.stateLocation,
    rootDir: paths.rootDir,
    databasePath: paths.databasePath,
  };
}

async function backupExistingStateRoot(targetRoot: string, backupRoot: string): Promise<string | undefined> {
  const target = await statOptional(targetRoot);
  if (!target) {
    return undefined;
  }
  if (!target.isDirectory()) {
    throw new CliError(2, "target_state_invalid", `Target workspace state root exists but is not a directory: ${targetRoot}`);
  }
  const backupPath = join(backupRoot, "target-existing");
  await cp(targetRoot, backupPath, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  return backupPath;
}

async function backupFileIfPresent(filePath: string, backupRoot: string, backupName: string): Promise<string | undefined> {
  const item = await statOptional(filePath);
  if (!item) {
    return undefined;
  }
  if (!item.isFile()) {
    return undefined;
  }
  const backupPath = join(backupRoot, backupName);
  await cp(filePath, backupPath, {
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
  return backupPath;
}

async function restoreFileBackup(backupPath: string | undefined, targetPath: string): Promise<void> {
  if (!backupPath) {
    await rm(targetPath, { force: true });
    return;
  }
  await mkdir(dirname(targetPath), { recursive: true });
  await cp(backupPath, targetPath, {
    force: true,
    preserveTimestamps: true,
  });
}

async function restoreStateRootBackup(backupRoot: string | undefined, targetRoot: string): Promise<void> {
  await rm(targetRoot, { recursive: true, force: true });
  if (!backupRoot) {
    return;
  }
  await cp(backupRoot, targetRoot, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
  });
}

async function moveStagingStateRoot(stagingRoot: string, targetRoot: string): Promise<void> {
  try {
    await rename(stagingRoot, targetRoot);
  } catch (error) {
    if (!isNodeError(error) || error.code !== "EXDEV") {
      throw error;
    }
    await cp(stagingRoot, targetRoot, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

async function listTopLevelPaths(rootDir: string): Promise<readonly string[]> {
  const entries = await readdir(rootDir);
  return entries.sort();
}

async function writeJsonDocument(filePath: string, value: unknown): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function initWorkspace(
  cwd: string,
  withProviderTemplates: boolean,
  workspaceStateLocation?: WorkspaceStateLocation,
): Promise<InitResult> {
  const storagePaths = resolveStoragePaths(cwd, workspaceStateLocation ? { workspaceStateLocation } : {});
  const paths = storagePaths.workspace;
  if (paths.stateLocation === "user-data-dir") {
    await assertUserDataDirInitHasNoRepoLocalDatabase(cwd);
  }
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
  await mkdir(paths.attachmentsDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.piDir, { recursive: true });
  await mkdir(paths.pluginsDir, { recursive: true });
  await mkdir(paths.pluginCacheDir, { recursive: true });
  await mkdir(paths.worktreesDir, { recursive: true });
  await mkdir(paths.memoryExportsDir, { recursive: true });
  await writeDefaultConfig(paths.configPath, paths);
  if (paths.stateLocation === "user-data-dir") {
    await writeRepoLocalWorkspacePointer(cwd, paths);
  }

  const store = createSqliteRunStore(cwd, paths);
  const createdProviders: ProviderPreset[] = [];
  const skippedProviders: ProviderPreset[] = [];
  try {
    if (withProviderTemplates) {
      const existingProviders = store.listProviderPresets();
      const now = new Date().toISOString();
      for (const template of defaultProviderTemplates()) {
        const existing = findEquivalentProvider(existingProviders, template);
        if (existing) {
          skippedProviders.push(existing);
          continue;
        }
        const created = store.createProviderPreset(template, now);
        existingProviders.push(created);
        createdProviders.push(created);
      }
    }
  } finally {
    store.close();
  }
  registerResolvedWorkspace(cwd, { workspaceStateLocation: paths.stateLocation });

  return {
    cwd,
    rootDir: paths.rootDir,
    databasePath: paths.databasePath,
    sessionsDir: paths.sessionsDir,
    artifactsDir: paths.artifactsDir,
    logsDir: paths.logsDir,
    piDir: paths.piDir,
    configPath: paths.configPath,
    workspaceId: paths.identity.workspaceId,
    stateLocation: paths.stateLocation,
    createdProviders,
    skippedProviders,
  };
}

async function writeDefaultConfig(configPath: string, paths: LingStackRuntimePaths): Promise<void> {
  await writeWorkspaceConfig(configPath, paths, "ling-stack init", { exclusive: true }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
  });
}

async function writeWorkspaceConfig(
  configPath: string,
  paths: LingStackRuntimePaths,
  createdBy: string,
  options: { readonly exclusive?: boolean } = {},
): Promise<void> {
  const config = {
    schemaVersion: 1,
    product: "ling-stack",
    workspaceId: paths.identity.workspaceId,
    workspaceStateLocation: paths.stateLocation,
    providerTemplates: "sqlite",
    secrets: "env/keychain refs",
    createdBy,
  };
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, {
    flag: options.exclusive ? "wx" : "w",
  });
}

async function assertUserDataDirInitHasNoRepoLocalDatabase(cwd: string): Promise<void> {
  const repoLocalDatabasePath = join(resolve(cwd), ".ling-stack", "ling-stack.sqlite");
  try {
    const database = await stat(repoLocalDatabasePath);
    if (database.isFile()) {
      throw new CliError(
        2,
        "migration_required",
        "A repo-local Ling Stack database already exists. user-data-dir init would require an explicit migration command.",
      );
    }
  } catch (error) {
    if (error instanceof CliError) {
      throw error;
    }
    if (!isMissingPathError(error)) {
      throw new CliError(1, "workspace_state_inspect_failed", `Could not inspect repo-local workspace database: ${errorMessage(error)}`);
    }
  }
}

async function writeRepoLocalWorkspacePointer(
  cwd: string,
  paths: LingStackRuntimePaths,
  options: { readonly createdBy?: string; readonly replaceExisting?: boolean } = {},
): Promise<void> {
  const pointerDir = join(resolve(cwd), ".ling-stack");
  const pointerPath = join(pointerDir, "config.json");
  await mkdir(pointerDir, { recursive: true });
  const pointer = {
    schemaVersion: 1,
    product: "ling-stack",
    workspaceId: paths.identity.workspaceId,
    workspaceStateLocation: "user-data-dir",
    stateRoot: paths.rootDir,
    configPath: paths.configPath,
    createdBy: options.createdBy ?? "ling-stack init pointer",
  };
  await writeFile(pointerPath, `${JSON.stringify(pointer, null, 2)}\n`, {
    flag: options.replaceExisting ? "w" : "wx",
  }).catch(async (error: unknown) => {
    if (options.replaceExisting) {
      throw error;
    }
    if (!isNodeError(error) || error.code !== "EEXIST") {
      throw error;
    }
    const existing = await readJsonFile(pointerPath, "workspace pointer").catch(() => undefined);
    if (isRecord(existing) && existing.workspaceStateLocation === "user-data-dir") {
      return;
    }
    throw new CliError(
      2,
      "migration_required",
      "A repo-local Ling Stack config already exists. user-data-dir init would require an explicit migration command.",
    );
  });
}

function findEquivalentProvider(
  providers: readonly ProviderPreset[],
  template: ProviderPresetInput,
): ProviderPreset | undefined {
  return providers.find(
    (provider) =>
      provider.kind === template.kind &&
      provider.providerId === template.providerId &&
      provider.model === template.model &&
      provider.api === template.api,
  );
}

function readProviderTemplatesFlag(parsed: ParsedCommandArgs): boolean {
  const withTemplates = parsed.booleans.has("with-provider-templates");
  const withoutTemplates = parsed.booleans.has("no-provider-templates");
  if (withTemplates && withoutTemplates) {
    throw new CliError(2, "bad_option", "Use either --with-provider-templates or --no-provider-templates, not both.");
  }
  return !withoutTemplates;
}

function readWorkspaceStateLocationFlag(value: string | undefined): WorkspaceStateLocation | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "repo-local" || value === "user-data-dir") {
    return value;
  }
  throw new CliError(2, "bad_option", "--workspace-state-location must be repo-local or user-data-dir.");
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function readDaemonListenOptions(parsed: ParsedCommandArgs, options: GlobalOptions): DaemonListenOptions {
  let daemonUrl: URL;
  try {
    daemonUrl = new URL(options.daemonUrl);
  } catch {
    throw new CliError(2, "bad_daemon_url", "--daemon-url must be a valid URL.");
  }
  const host = getFlag(parsed, "host") ?? daemonUrl.hostname;
  const port = getFlag(parsed, "port") ? readRequiredPort(getFlag(parsed, "port") as string, "--port") : readPortFromDaemonUrl(daemonUrl);
  return { host, port, defaultWorkspaceCwd: options.cwd };
}

function readPortFromDaemonUrl(url: URL): number {
  if (url.port) {
    return readRequiredPort(url.port, "--daemon-url");
  }
  if (url.protocol === "http:") {
    return 80;
  }
  if (url.protocol === "https:") {
    return 443;
  }
  throw new CliError(2, "bad_daemon_url", "--daemon-url must include an http or https URL.");
}

function readRequiredPort(value: string, source: string): number {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value) {
    throw new CliError(2, "bad_port", `${source} must specify a TCP port between 1 and 65535.`);
  }
  return port;
}

async function runDaemonForeground(options: DaemonListenOptions): Promise<number> {
  const daemonCliPath = resolveDaemonCliPath();
  const child = spawn(process.execPath, [daemonCliPath], {
    env: {
      ...process.env,
      LING_STACK_HOST: options.host,
      LING_STACK_PORT: String(options.port),
      LING_STACK_DEFAULT_WORKSPACE_CWD: options.defaultWorkspaceCwd,
    },
    stdio: "inherit",
  });

  return await new Promise<number>((resolve, reject) => {
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", (error) => {
      cleanup();
      reject(new CliError(1, "daemon_start_failed", error.message));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code !== null) {
        resolve(code);
        return;
      }
      resolve(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
    });
  });
}

function resolveDaemonCliPath(): string {
  try {
    return createRequire(import.meta.url).resolve("@ling-stack/daemon/dist/cli.js");
  } catch (error) {
    throw new CliError(1, "daemon_cli_not_found", `Cannot resolve @ling-stack/daemon CLI: ${errorMessage(error)}`);
  }
}

function readUiOptions(parsed: ParsedCommandArgs): UiOptions {
  const host = getFlag(parsed, "host") ?? "127.0.0.1";
  const port = getFlag(parsed, "port") ? readRequiredPort(getFlag(parsed, "port") as string, "--port") : 5173;
  return {
    host,
    port,
    url: `http://${host}:${port}`,
    open: parsed.booleans.has("open"),
    foreground: parsed.booleans.has("foreground"),
  };
}

async function isDaemonReachable(daemonUrl: string): Promise<boolean> {
  try {
    const response = await fetch(buildUrl(daemonUrl, "/health"), { signal: AbortSignal.timeout(1000) });
    if (!response.ok) {
      return false;
    }
    const body = (await response.json()) as { ok?: unknown };
    return body.ok === true;
  } catch {
    return false;
  }
}

async function isHttpReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function isWebUiReachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) {
      return false;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/html")) {
      return false;
    }
    const body = await response.text();
    return body.includes("<title>Ling Stack</title>");
  } catch {
    return false;
  }
}

async function runWebForeground(options: UiOptions, daemonUrl: string, defaultWorkspaceCwd: string): Promise<number> {
  const webDir = resolveWebPackageDir();
  const viteCliPath = resolveViteCliPath(webDir);
  const child = spawn(process.execPath, [viteCliPath, "--host", options.host, "--port", String(options.port), "--strictPort"], {
    cwd: webDir,
    env: {
      ...process.env,
      VITE_LING_STACK_DAEMON_URL: daemonUrl,
      VITE_LING_STACK_DEFAULT_WORKSPACE_CWD: defaultWorkspaceCwd,
    },
    stdio: "inherit",
  });

  if (options.open) {
    void waitForHttpReachable(options.url, 10_000).then((reachable) => {
      if (reachable) {
        openExternalUrl(options.url);
      }
    });
  }

  return await waitForChildExit(child, "web_ui_start_failed");
}

async function waitForHttpReachable(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isHttpReachable(url)) {
      return true;
    }
    await delay(250);
  }
  return false;
}

function resolveWebPackageDir(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve("@ling-stack/web/package.json"));
  } catch (error) {
    throw new CliError(1, "web_package_not_found", `Cannot resolve @ling-stack/web package: ${errorMessage(error)}`);
  }
}

function resolveViteCliPath(webDir: string): string {
  try {
    const requireFromWeb = createRequire(join(webDir, "package.json"));
    return join(dirname(requireFromWeb.resolve("vite/package.json")), "bin", "vite.js");
  } catch (error) {
    throw new CliError(1, "vite_cli_not_found", `Cannot resolve Vite from @ling-stack/web: ${errorMessage(error)}`);
  }
}

function openExternalUrl(url: string): void {
  const opener =
    process.platform === "darwin"
      ? { command: "open", args: [url] }
      : process.platform === "win32"
        ? { command: "cmd", args: ["/c", "start", "", url] }
        : { command: "xdg-open", args: [url] };
  const child = spawn(opener.command, opener.args, { detached: true, stdio: "ignore" });
  child.unref();
}

async function waitForChildExit(child: ReturnType<typeof spawn>, errorCode: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const forwardSignal = (signal: NodeJS.Signals): void => {
      if (!child.killed) {
        child.kill(signal);
      }
    };
    const onSigint = (): void => forwardSignal("SIGINT");
    const onSigterm = (): void => forwardSignal("SIGTERM");
    const cleanup = (): void => {
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };

    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    child.once("error", (error) => {
      cleanup();
      reject(new CliError(1, errorCode, error.message));
    });
    child.once("exit", (code, signal) => {
      cleanup();
      if (code !== null) {
        resolve(code);
        return;
      }
      resolve(signal === "SIGINT" || signal === "SIGTERM" ? 0 : 1);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, ms);
  });
}

async function requestJson(
  options: GlobalOptions,
  method: "DELETE" | "GET" | "PATCH" | "POST",
  path: string,
  query?: Record<string, QueryValue>,
  body?: unknown,
): Promise<unknown> {
  const url = buildUrl(options.daemonUrl, path, query);
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: removeUndefined({
        Accept: "application/json",
        "Content-Type": body === undefined ? undefined : "application/json",
      }) as Record<string, string>,
      body: body === undefined ? undefined : JSON.stringify(removeUndefinedDeep(body)),
    });
  } catch (error) {
    throw new CliError(3, "daemon_unreachable", `Cannot reach Ling Stack daemon at ${options.daemonUrl}: ${errorMessage(error)}`);
  }

  if (!response.ok) {
    throw await daemonHttpError(response);
  }

  return await parseJsonResponse(response);
}

async function streamRun(
  options: GlobalOptions,
  body: unknown,
  handleRecord: (record: RunStreamRecord) => void,
  path = "/runs",
  query: Record<string, QueryValue> = {},
): Promise<void> {
  try {
    await streamRunRpc(options, body, handleRecord, path);
    return;
  } catch (error) {
    if (!(error instanceof RpcFallbackError)) {
      throw error;
    }
  }

  const url = buildUrl(options.daemonUrl, path, query);
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(removeUndefinedDeep(body)),
    });
  } catch (error) {
    throw new CliError(3, "daemon_unreachable", `Cannot reach Ling Stack daemon at ${options.daemonUrl}: ${errorMessage(error)}`);
  }

  if (!response.ok || !response.body) {
    throw await daemonHttpError(response);
  }

  const decoder = new TextDecoder();
  const reader = response.body.getReader();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split(/\r?\n\r?\n/);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) {
      handleRunStreamBlock(block, handleRecord);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    handleRunStreamBlock(buffer, handleRecord);
  }
}

class RpcFallbackError extends Error {}

type WebSocketLike = {
  readonly CONNECTING: number;
  readonly OPEN: number;
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(event: "open" | "message" | "error" | "close", listener: (event: { readonly data?: unknown }) => void): void;
};

type WebSocketConstructorLike = {
  readonly CONNECTING: number;
  readonly OPEN: number;
  new(url: string): WebSocketLike;
};

async function streamRunRpc(
  options: GlobalOptions,
  body: unknown,
  handleRecord: (record: RunStreamRecord) => void,
  path: string,
): Promise<void> {
  if (path !== "/runs") {
    throw new RpcFallbackError("WebSocket RPC only supports the primary run endpoint.");
  }
  const cwd = readRunRequestCwd(body);
  const WebSocketCtor = (globalThis as unknown as { readonly WebSocket?: WebSocketConstructorLike }).WebSocket;
  if (!cwd || !WebSocketCtor) {
    throw new RpcFallbackError("WebSocket RPC is not available.");
  }
  const ws = new WebSocketCtor(buildRpcStreamUrl(options.daemonUrl, cwd));
  let accepted = false;
  let startResponseSeen = false;
  let settled = false;

  return await new Promise<void>((resolve, reject) => {
    const close = (): void => {
      if (ws.readyState === WebSocketCtor.CONNECTING || ws.readyState === WebSocketCtor.OPEN) {
        ws.close();
      }
    };
    const settleResolve = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      close();
      resolve();
    };
    const settleReject = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      close();
      reject(error);
    };
    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { cwd } }));
      ws.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "runs.start", params: body }));
    });
    ws.addEventListener("message", (message) => {
      const envelope = parseRpcEnvelope(message.data);
      if (!envelope) {
        return;
      }
      if (envelope.id === 2) {
        startResponseSeen = true;
        if (envelope.error) {
          const code = readRpcErrorCode(envelope.error);
          settleReject(code === "method_not_found" || code === "not_initialized"
            ? new RpcFallbackError(envelope.error.message)
            : new CliError(4, code ?? "rpc_error", envelope.error.message));
          return;
        }
        accepted = true;
        return;
      }
      if (envelope.method !== "$/run_event") {
        return;
      }
      const params = envelope.params;
      if (!isRecord(params)) {
        return;
      }
      if (params.kind === "ready") {
        const data = params.data;
        if (isRecord(data) && typeof data.runId === "string") {
          handleRecord({ kind: "ready", runId: data.runId });
        }
        return;
      }
      if (params.kind === "event") {
        if (!isRunEventEnvelope(params.data)) {
          settleReject(new CliError(4, "bad_rpc_event", "RPC run_event did not contain a run event envelope."));
          return;
        }
        handleRecord({ kind: "event", envelope: params.data });
        return;
      }
      if (params.kind === "error") {
        const bodyRecord = params.body;
        const message = isRecord(bodyRecord) && typeof bodyRecord.message === "string"
          ? bodyRecord.message
          : "Run failed before the stream started.";
        settleReject(accepted ? new CliError(4, "run_failed", message) : new RpcFallbackError(message));
        return;
      }
      if (params.kind === "end") {
        settleResolve();
      }
    });
    ws.addEventListener("error", () => {
      settleReject(accepted ? new CliError(4, "rpc_stream_failed", "WebSocket RPC stream failed.") : new RpcFallbackError("WebSocket RPC is unavailable."));
    });
    ws.addEventListener("close", () => {
      if (settled) {
        return;
      }
      settleReject(accepted || startResponseSeen
        ? new CliError(4, "rpc_stream_closed", "WebSocket RPC stream closed.")
        : new RpcFallbackError("WebSocket RPC closed before run start."));
    });
  });
}

function handleRunStreamBlock(block: string, handleRecord: (record: RunStreamRecord) => void): void {
  const record = parseRunStreamRecord(block);
  if (record) {
    handleRecord(record);
  }
}

function buildRpcStreamUrl(baseUrl: string, cwd: string): string {
  const url = new URL("/rpc/stream", `${baseUrl}/`);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("cwd", cwd);
  return url.toString();
}

function readRunRequestCwd(body: unknown): string | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  return typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : undefined;
}

function parseRpcEnvelope(data: unknown): {
  readonly id?: number | string | null;
  readonly method?: string;
  readonly params?: unknown;
  readonly error?: { readonly message: string; readonly data?: unknown };
} | undefined {
  const text = typeof data === "string"
    ? data
    : data instanceof ArrayBuffer
      ? Buffer.from(data).toString("utf8")
      : undefined;
  if (text === undefined) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    return isRecord(parsed) ? parsed as ReturnType<typeof parseRpcEnvelope> : undefined;
  } catch {
    return undefined;
  }
}

function readRpcErrorCode(error: { readonly data?: unknown }): string | undefined {
  return isRecord(error.data) && typeof error.data.code === "string" ? error.data.code : undefined;
}

function createCliRunOutput(options: GlobalOptions): RunOutput {
  return createRunOutput({
    json: options.json,
    verbose: options.verbose,
    daemonUrl: options.daemonUrl,
    cwd: options.cwd,
    writers: {
      stdout: process.stdout,
      stderr: process.stderr,
    },
  });
}

async function readPrompt(parsed: ParsedCommandArgs, options: { readonly includePositionals?: boolean } = {}): Promise<string> {
  const promptParts: string[] = [];
  const promptFile = getFlag(parsed, "prompt-file");
  if (promptFile) {
    promptParts.push(await readFile(resolve(promptFile), "utf8"));
  }
  const promptFlag = getFlag(parsed, "prompt");
  if (promptFlag) {
    promptParts.push(promptFlag);
  }
  if (options.includePositionals !== false && parsed.positionals.length > 0) {
    promptParts.push(parsed.positionals.join(" "));
  }
  return promptParts.join("\n\n").trim();
}

async function readJsonFile(filePath: string, label: string): Promise<unknown> {
  const text = await readUtf8File(filePath, label);
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new CliError(2, "invalid_json", `Invalid JSON in ${label} ${filePath}: ${errorMessage(error)}`);
  }
}

async function readUtf8File(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(resolve(filePath), "utf8");
  } catch (error) {
    throw new CliError(2, "file_read_error", `Cannot read ${label} ${filePath}: ${errorMessage(error)}`);
  }
}

function readTools(parsed: ParsedCommandArgs): readonly string[] {
  const values = getFlagValues(parsed, "tool").flatMap((value) => value.split(","));
  const tools = values.map((value) => value.trim()).filter(Boolean);
  const effectiveTools = tools.length > 0 ? tools : [...DEFAULT_TOOLS];
  const invalidTools = effectiveTools.filter((tool) => !VALID_TOOLS.has(tool));
  if (invalidTools.length > 0) {
    throw new CliError(2, "bad_tool", `Unsupported tool(s): ${invalidTools.join(", ")}. Valid tools: ${[...VALID_TOOLS].join(", ")}`);
  }
  return effectiveTools;
}

function providerCommandParserSpec(options: { readonly includeClearFlags?: boolean } = {}): CommandParserSpec {
  return {
    stringFlags: new Set([
      "name",
      "display-name",
      "kind",
      "provider-id",
      "model",
      "api",
      "provider-transport",
      "base-url",
      "api-key-ref",
      "context-window",
      "max-tokens",
      "enabled",
      "headers-json",
      "compat-json",
    ]),
    repeatableFlags: new Set(["capability", "input", "header"]),
    booleanFlags: new Set([
      "auth-header",
      "no-auth-header",
      "reasoning",
      "no-reasoning",
      "disabled",
      ...(options.includeClearFlags
        ? ["clear-provider-transport", "clear-base-url", "clear-api-key-ref", "clear-auth-header", "clear-reasoning", "clear-context-window", "clear-max-tokens"]
        : []),
    ]),
  };
}

function channelCommandParserSpec(options: { readonly includeClearFlags?: boolean } = {}): CommandParserSpec {
  return {
    stringFlags: new Set(["name", "path", "provider", "teammate", "status", "write-lock-scope", "max-concurrent-runs"]),
    repeatableFlags: new Set(["tool"]),
    booleanFlags: new Set([
      "read-only-parallel",
      "no-read-only-parallel",
      "queue-on-conflict",
      "no-queue-on-conflict",
      ...(options.includeClearFlags ? ["clear-path", "clear-provider", "clear-teammate"] : []),
    ]),
  };
}

function readChannelStatusFlag(parsed: ParsedCommandArgs): string | undefined {
  const status = getFlag(parsed, "status");
  if (status === undefined) {
    return undefined;
  }
  if (status !== "active" && status !== "paused" && status !== "archived") {
    throw new CliError(2, "bad_channel_status", "--status must be one of: active, paused, archived");
  }
  return status;
}

function readChannelRuntimePolicyFlags(parsed: ParsedCommandArgs): Record<string, unknown> | undefined {
  const runtimePolicy = removeUndefined({
    maxConcurrentRuns: readOptionalIntegerFlag(parsed, "max-concurrent-runs"),
    schedulingMode: "smart",
    writeLockScope: readChannelWriteLockScopeFlag(parsed),
    allowReadOnlyParallel: readBooleanPair(parsed, "read-only-parallel", "no-read-only-parallel"),
    queueOnConflict: readBooleanPair(parsed, "queue-on-conflict", "no-queue-on-conflict"),
  });
  const hasPolicyFlag = Object.keys(runtimePolicy).some((key) => key !== "schedulingMode");
  return hasPolicyFlag ? runtimePolicy : undefined;
}

function readChannelWriteLockScopeFlag(parsed: ParsedCommandArgs): string | undefined {
  const value = getFlag(parsed, "write-lock-scope");
  if (value === undefined) {
    return undefined;
  }
  if (value !== "channel" && value !== "boundPath" && value !== "workspace") {
    throw new CliError(2, "bad_write_lock_scope", "--write-lock-scope must be channel, boundPath, or workspace");
  }
  return value;
}

function readBooleanPair(parsed: ParsedCommandArgs, positiveKey: string, negativeKey: string): boolean | undefined {
  const positive = parsed.booleans.has(positiveKey);
  const negative = parsed.booleans.has(negativeKey);
  if (positive && negative) {
    throw new CliError(2, "conflicting_flags", `--${positiveKey} and --${negativeKey} cannot be used together.`);
  }
  if (positive) {
    return true;
  }
  if (negative) {
    return false;
  }
  return undefined;
}

function taskCommandParserSpec(options: { readonly includeClearFlags?: boolean } = {}): CommandParserSpec {
  return {
    stringFlags: new Set(["channel", "title", "prompt", "prompt-file", "status", "assignee", "current-run"]),
    booleanFlags: new Set([
      ...(options.includeClearFlags ? ["clear-assignee", "clear-current-run"] : []),
    ]),
  };
}

function policyCommandParserSpec(): CommandParserSpec {
  return {
    repeatableFlags: new Set(["tool", "write-path"]),
  };
}

function readChannelTools(parsed: ParsedCommandArgs): readonly string[] | undefined {
  const values = getFlagValues(parsed, "tool").flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    return undefined;
  }
  const invalidTools = values.filter((tool) => !VALID_TOOLS.has(tool));
  if (invalidTools.length > 0) {
    throw new CliError(2, "bad_tool", `Unsupported tool(s): ${invalidTools.join(", ")}. Valid tools: ${[...VALID_TOOLS].join(", ")}`);
  }
  return [...new Set(values)];
}

function buildPolicySetBody(parsed: ParsedCommandArgs): Record<string, unknown> {
  return removeUndefined({
    toolDecisions: readPolicyToolDecisions(parsed),
    allowedWritePaths: readPolicyWritePaths(parsed),
  });
}

function readPolicyToolDecisions(parsed: ParsedCommandArgs): Partial<Record<RunTool, ApprovalToolDecision>> | undefined {
  const assignments = getFlagValues(parsed, "tool")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (assignments.length === 0) {
    return undefined;
  }

  const toolDecisions: Partial<Record<RunTool, ApprovalToolDecision>> = {};
  for (const assignment of assignments) {
    const separatorIndex = assignment.indexOf("=");
    if (separatorIndex <= 0 || separatorIndex === assignment.length - 1) {
      throw new CliError(2, "bad_tool_policy", "--tool must use TOOL=allow|ask|deny.");
    }
    const tool = assignment.slice(0, separatorIndex).trim();
    const decision = assignment.slice(separatorIndex + 1).trim();
    assertAllowed("tool", tool, VALID_TOOLS);
    assertAllowed("decision", decision, VALID_POLICY_DECISIONS);
    toolDecisions[tool as RunTool] = decision as ApprovalToolDecision;
  }
  return toolDecisions;
}

function readPolicyWritePaths(parsed: ParsedCommandArgs): readonly string[] | undefined {
  const paths = getFlagValues(parsed, "write-path")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  if (paths.length === 0) {
    return undefined;
  }
  return [...new Set(paths)];
}

function readNullableFlag(parsed: ParsedCommandArgs, key: string, clear: boolean): string | null | undefined {
  const value = getFlag(parsed, key);
  if (value !== undefined && clear) {
    throw new CliError(2, "bad_option", `Use either --${key} or --clear-${key}, not both.`);
  }
  return clear ? null : value;
}

function buildProviderAddBody(parsed: ParsedCommandArgs, kind: string): Record<string, unknown> {
  const displayName = getFlag(parsed, "name") ?? getFlag(parsed, "display-name");
  const providerId = getFlag(parsed, "provider-id");
  const model = getFlag(parsed, "model");
  const api = getFlag(parsed, "api") ?? defaultProviderApi(kind);
  const capabilities = readStringSetFlag(parsed, "capability", VALID_PROVIDER_CAPABILITIES, defaultProviderCapabilities(kind, api));
  const input = readStringSetFlag(parsed, "input", VALID_PROVIDER_INPUTS, ["text"]);
  assertAllowed("api", api, VALID_PROVIDER_APIS);

  if (!displayName) {
    throw new CliError(2, "missing_option", "provider add requires --name <displayName>.");
  }
  if (!providerId) {
    throw new CliError(2, "missing_option", "provider add requires --provider-id <id>.");
  }
  if (!model) {
    throw new CliError(2, "missing_option", "provider add requires --model <model>.");
  }

  return removeUndefined({
    kind,
    displayName,
    providerId,
    model,
    api,
    providerTransport: readAllowedOptionalFlag(parsed, "provider-transport", VALID_PROVIDER_TRANSPORTS),
    baseUrl: getFlag(parsed, "base-url"),
    apiKeyRef: getFlag(parsed, "api-key-ref"),
    headers: readHeaders(parsed),
    authHeader: readTriStateBoolean(parsed, "auth-header", "no-auth-header"),
    reasoning: readTriStateBoolean(parsed, "reasoning", "no-reasoning"),
    input,
    contextWindow: readOptionalIntegerFlag(parsed, "context-window"),
    maxTokens: readOptionalIntegerFlag(parsed, "max-tokens"),
    compat: readJsonObjectFlag(parsed, "compat-json"),
    capabilities,
    enabled: readEnabledFlag(parsed, true),
  });
}

function buildProviderUpdateBody(parsed: ParsedCommandArgs): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  setIfDefined(body, "kind", readAllowedOptionalFlag(parsed, "kind", VALID_PROVIDER_KINDS));
  setIfDefined(body, "displayName", getFlag(parsed, "name") ?? getFlag(parsed, "display-name"));
  setIfDefined(body, "providerId", getFlag(parsed, "provider-id"));
  setIfDefined(body, "model", getFlag(parsed, "model"));
  setIfDefined(body, "api", readAllowedOptionalFlag(parsed, "api", VALID_PROVIDER_APIS));
  setIfDefinedOrCleared(body, "providerTransport", readAllowedOptionalFlag(parsed, "provider-transport", VALID_PROVIDER_TRANSPORTS), parsed.booleans.has("clear-provider-transport"));
  setIfDefinedOrCleared(body, "baseUrl", getFlag(parsed, "base-url"), parsed.booleans.has("clear-base-url"));
  setIfDefinedOrCleared(body, "apiKeyRef", getFlag(parsed, "api-key-ref"), parsed.booleans.has("clear-api-key-ref"));
  setIfDefined(body, "headers", readHeaders(parsed));
  setIfDefinedOrCleared(body, "authHeader", readTriStateBoolean(parsed, "auth-header", "no-auth-header"), parsed.booleans.has("clear-auth-header"));
  setIfDefinedOrCleared(body, "reasoning", readTriStateBoolean(parsed, "reasoning", "no-reasoning"), parsed.booleans.has("clear-reasoning"));
  setIfDefined(body, "input", readStringSetFlag(parsed, "input", VALID_PROVIDER_INPUTS));
  setIfDefinedOrCleared(body, "contextWindow", readOptionalIntegerFlag(parsed, "context-window"), parsed.booleans.has("clear-context-window"));
  setIfDefinedOrCleared(body, "maxTokens", readOptionalIntegerFlag(parsed, "max-tokens"), parsed.booleans.has("clear-max-tokens"));
  setIfDefined(body, "compat", readJsonObjectFlag(parsed, "compat-json"));
  setIfDefined(body, "capabilities", readStringSetFlag(parsed, "capability", VALID_PROVIDER_CAPABILITIES));
  setIfDefined(body, "enabled", readEnabledFlag(parsed));
  return body;
}

function defaultProviderApi(kind: string): string {
  if (kind === "anthropic") {
    return "anthropic-messages";
  }
  if (kind === "google") {
    return "google-generative-ai";
  }
  return "openai-completions";
}

function defaultProviderCapabilities(kind: string, api: string): readonly string[] {
  if (api !== "media-job") {
    return ["chat", "tool_call", "reasoning"];
  }
  if (kind === "seedance") {
    return ["video_generate"];
  }
  return ["image_generate"];
}

function readStringSetFlag(
  parsed: ParsedCommandArgs,
  key: string,
  allowed: ReadonlySet<string>,
  fallback?: readonly string[],
): readonly string[] | undefined {
  const values = getFlagValues(parsed, key).flatMap((value) => value.split(",")).map((value) => value.trim()).filter(Boolean);
  if (values.length === 0) {
    return fallback;
  }
  for (const value of values) {
    assertAllowed(key, value, allowed);
  }
  return [...new Set(values)];
}

function readAllowedOptionalFlag(parsed: ParsedCommandArgs, key: string, allowed: ReadonlySet<string>): string | undefined {
  const value = getFlag(parsed, key);
  if (value !== undefined) {
    assertAllowed(key, value, allowed);
  }
  return value;
}

function readMemoryScopeTypeFlag(value: string | undefined): MemoryScopeType | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertAllowed("scope-type", value, VALID_MEMORY_SCOPE_TYPES);
  return value as MemoryScopeType;
}

function readMemoryReviewStateFlag(value: string | undefined): MemoryReviewState | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertAllowed("review-state", value, VALID_MEMORY_REVIEW_STATES);
  return value as MemoryReviewState;
}

function readMemorySensitivityFlag(value: string | undefined): MemorySensitivity | undefined {
  if (value === undefined) {
    return undefined;
  }
  assertAllowed("sensitivity", value, VALID_MEMORY_SENSITIVITIES);
  return value as MemorySensitivity;
}

function readHeaders(parsed: ParsedCommandArgs): Record<string, string> | undefined {
  const headerEntries = getFlagValues(parsed, "header");
  const headersFromJson = readJsonObjectFlag(parsed, "headers-json");
  const headers: Record<string, string> = {};
  if (headersFromJson) {
    for (const [key, value] of Object.entries(headersFromJson)) {
      if (typeof value !== "string") {
        throw new CliError(2, "bad_header", "--headers-json must be an object with string values.");
      }
      headers[key] = value;
    }
  }
  for (const entry of headerEntries) {
    const separatorIndex = entry.indexOf("=");
    if (separatorIndex <= 0) {
      throw new CliError(2, "bad_header", "--header must use KEY=VALUE.");
    }
    headers[entry.slice(0, separatorIndex)] = entry.slice(separatorIndex + 1);
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

function readJsonObjectFlag(parsed: ParsedCommandArgs, key: string): Record<string, unknown> | undefined {
  const value = getFlag(parsed, key);
  if (value === undefined) {
    return undefined;
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value) as unknown;
  } catch {
    throw new CliError(2, "bad_json", `--${key} must be valid JSON.`);
  }
  if (!isRecord(parsedJson)) {
    throw new CliError(2, "bad_json", `--${key} must be a JSON object.`);
  }
  return parsedJson;
}

function readOptionalIntegerFlag(parsed: ParsedCommandArgs, key: string): number | undefined {
  const rawValue = getFlag(parsed, key);
  if (rawValue === undefined) {
    return undefined;
  }
  const value = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(value) || value < 1 || String(value) !== rawValue) {
    throw new CliError(2, "bad_number", `--${key} must be a positive integer.`);
  }
  return value;
}

function readApprovalRequirementFlag(parsed: ParsedCommandArgs): "standard" | "strict" | undefined {
  const value = getFlag(parsed, "approval");
  if (value === undefined) {
    return undefined;
  }
  if (value !== "standard" && value !== "strict") {
    throw new CliError(2, "bad_option", "--approval must be standard or strict.");
  }
  return value;
}

function readEnabledFlag(parsed: ParsedCommandArgs, fallback?: boolean): boolean | undefined {
  const enabled = getFlag(parsed, "enabled");
  const disabled = parsed.booleans.has("disabled");
  if (enabled !== undefined && disabled) {
    throw new CliError(2, "bad_option", "Use either --enabled <true|false> or --disabled, not both.");
  }
  if (disabled) {
    return false;
  }
  if (enabled !== undefined) {
    return parseBooleanValue(enabled, "--enabled");
  }
  return fallback;
}

function readTriStateBoolean(parsed: ParsedCommandArgs, positiveKey: string, negativeKey: string): boolean | undefined {
  const positive = parsed.booleans.has(positiveKey);
  const negative = parsed.booleans.has(negativeKey);
  if (positive && negative) {
    throw new CliError(2, "bad_option", `Use either --${positiveKey} or --${negativeKey}, not both.`);
  }
  if (positive) {
    return true;
  }
  if (negative) {
    return false;
  }
  return undefined;
}

function parseBooleanValue(value: string, flag: string): boolean {
  if (value === "true" || value === "1" || value === "yes") {
    return true;
  }
  if (value === "false" || value === "0" || value === "no") {
    return false;
  }
  throw new CliError(2, "bad_boolean", `${flag} must be true or false.`);
}

function setIfDefined(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

function setIfDefinedOrCleared(target: Record<string, unknown>, key: string, value: unknown, cleared: boolean): void {
  if (cleared) {
    target[key] = null;
    return;
  }
  setIfDefined(target, key, value);
}

function assertAllowed(key: string, value: string, allowed: ReadonlySet<string>): void {
  if (!allowed.has(value)) {
    throw new CliError(2, `bad_${key.replace(/-/g, "_")}`, `${key} must be one of: ${[...allowed].join(", ")}`);
  }
}

function parseGlobalArgs(rawArgs: readonly string[]): ParsedGlobalArgs {
  const defaultOptions = defaultGlobalOptions(false);
  let daemonUrl = defaultOptions.daemonUrl;
  let cwd = defaultOptions.cwd;
  let json = false;
  let verbose = false;
  let color = true;
  let help = false;
  const args: string[] = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--") {
      args.push(...rawArgs.slice(index));
      break;
    }
    if (arg === "--daemon-url") {
      daemonUrl = requireNext(rawArgs, index, "--daemon-url");
      index += 1;
      continue;
    }
    if (arg.startsWith("--daemon-url=")) {
      daemonUrl = arg.slice("--daemon-url=".length);
      continue;
    }
    if (arg === "--cwd") {
      cwd = resolve(requireNext(rawArgs, index, "--cwd"));
      index += 1;
      continue;
    }
    if (arg.startsWith("--cwd=")) {
      cwd = resolve(arg.slice("--cwd=".length));
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--verbose") {
      verbose = true;
      continue;
    }
    if (arg === "--no-color") {
      color = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    args.push(arg);
  }

  return {
    args,
    options: {
      daemonUrl: normalizeDaemonUrl(daemonUrl),
      cwd,
      json,
      verbose,
      color,
      help,
    },
  };
}

function parseCommandArgs(args: readonly string[], spec: CommandParserSpec = {}): ParsedCommandArgs {
  const stringFlags = spec.stringFlags ?? new Set<string>();
  const repeatableFlags = spec.repeatableFlags ?? new Set<string>();
  const booleanFlags = spec.booleanFlags ?? new Set<string>();
  const flags = new Map<string, string[]>();
  const booleans = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--") || arg === "--") {
      positionals.push(arg);
      continue;
    }

    const [rawKey, rawValue] = splitFlag(arg);
    if (!stringFlags.has(rawKey) && !repeatableFlags.has(rawKey) && !booleanFlags.has(rawKey)) {
      throw new CliError(2, "unknown_option", `Unknown option: --${rawKey}`);
    }
    if (booleanFlags.has(rawKey)) {
      if (rawValue !== undefined) {
        throw new CliError(2, "bad_option", `--${rawKey} does not accept a value`);
      }
      booleans.add(rawKey);
      continue;
    }

    const value = rawValue ?? requireNext(args, index, `--${rawKey}`);
    if (rawValue === undefined) {
      index += 1;
    }
    if (repeatableFlags.has(rawKey)) {
      flags.set(rawKey, [...(flags.get(rawKey) ?? []), value]);
    } else {
      flags.set(rawKey, [value]);
    }
  }

  return { positionals, flags, booleans };
}

function splitFlag(arg: string): readonly [string, string | undefined] {
  const withoutPrefix = arg.slice(2);
  const equalsIndex = withoutPrefix.indexOf("=");
  if (equalsIndex === -1) {
    return [withoutPrefix, undefined];
  }
  return [withoutPrefix.slice(0, equalsIndex), withoutPrefix.slice(equalsIndex + 1)];
}

function requireNext(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined) {
    throw new CliError(2, "missing_option_value", `${flag} requires a value`);
  }
  return value;
}

function getFlag(parsed: ParsedCommandArgs, key: string): string | undefined {
  const values = parsed.flags.get(key);
  return values?.at(-1);
}

function getFlagValues(parsed: ParsedCommandArgs, key: string): readonly string[] {
  return parsed.flags.get(key) ?? [];
}

function singlePositional(positionals: readonly string[], usage: string): string {
  if (positionals.length !== 1) {
    throw new CliError(2, "bad_usage", `Usage: ling-stack ${usage}`);
  }
  return positionals[0];
}

function assertNoPositionals(positionals: readonly string[], command: string): void {
  if (positionals.length > 0) {
    throw new CliError(2, "bad_usage", `Unexpected argument(s) for ${command}: ${positionals.join(" ")}`);
  }
}

function defaultGlobalOptions(help: boolean): GlobalOptions {
  return {
    daemonUrl: normalizeDaemonUrl(defaultDaemonUrl()),
    cwd: process.cwd(),
    json: false,
    verbose: false,
    color: true,
    help,
  };
}

function defaultDaemonUrl(): string {
  if (process.env.LING_STACK_DAEMON_URL) {
    return process.env.LING_STACK_DAEMON_URL;
  }
  return `http://${process.env.LING_STACK_HOST ?? DEFAULT_HOST}:${process.env.LING_STACK_PORT ?? DEFAULT_PORT}`;
}

function normalizeDaemonUrl(value: string): string {
  return value.replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, path: string, query: Record<string, QueryValue> = {}): string {
  const url = new URL(path, `${baseUrl}/`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

async function daemonHttpError(response: Response): Promise<CliError> {
  let body: unknown;
  try {
    body = await parseJsonResponse(response);
  } catch {
    body = undefined;
  }
  const code = readString(body, "error") ?? `http_${response.status}`;
  const message = readString(body, "message") ?? `${response.status} ${response.statusText}`;
  return new CliError(4, code, message, response.status);
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }
  return parseJson(text, "Response body was not valid JSON");
}

function parseJson(text: string, message: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CliError(4, "invalid_json", message);
  }
}

function printProvidersList(response: unknown): void {
  const providers = readArray(response, "providers");
  if (providers.length === 0) {
    console.log("No providers found.");
    return;
  }
  printTable(
    ["ID", "Kind", "Name", "Provider", "Model", "API", "Transport", "Enabled", "Secret", "Check"],
    providers.map((provider) => [
      truncate(readString(provider, "id") ?? "", 32),
      truncate(readString(provider, "kind") ?? "", 18),
      truncate(readString(provider, "displayName") ?? "", 24),
      truncate(readString(provider, "providerId") ?? "", 18),
      truncate(readString(provider, "model") ?? "", 20),
      truncate(readString(provider, "api") ?? "", 20),
      truncate(readString(provider, "providerTransport") ?? "default", 18),
      String(readBoolean(provider, "enabled") ?? false),
      providerSecretStatus(provider),
      truncate(providerCheckStatus(provider), 18),
    ]),
  );
}

function printProviderDetail(response: unknown): void {
  const provider = readField(response, "provider");
  if (!isRecord(provider)) {
    printJson(response);
    return;
  }
  console.log(`ID: ${readString(provider, "id") ?? ""}`);
  console.log(`Kind: ${readString(provider, "kind") ?? ""}`);
  console.log(`Name: ${readString(provider, "displayName") ?? ""}`);
  console.log(`Provider ID: ${readString(provider, "providerId") ?? ""}`);
  console.log(`Model: ${readString(provider, "model") ?? ""}`);
  console.log(`API: ${readString(provider, "api") ?? ""}`);
  console.log(`Transport: ${readString(provider, "providerTransport") ?? "default"}`);
  const baseUrl = readString(provider, "baseUrl");
  if (baseUrl) {
    console.log(`Base URL: ${baseUrl}`);
  }
  const apiKeyRef = readString(provider, "apiKeyRef");
  if (apiKeyRef) {
    console.log(`API key ref: ${apiKeyRef}`);
  }
  console.log(`Secret: ${providerSecretStatus(provider)}`);
  console.log(`Enabled: ${readBoolean(provider, "enabled") ?? false}`);
  console.log(`Auth header: ${formatOptionalBoolean(readBoolean(provider, "authHeader"))}`);
  console.log(`Reasoning: ${formatOptionalBoolean(readBoolean(provider, "reasoning"))}`);
  console.log(`Input: ${readArray(provider, "input").join(", ")}`);
  console.log(`Capabilities: ${readArray(provider, "capabilities").join(", ")}`);
  const contextWindow = readNumber(provider, "contextWindow");
  if (contextWindow !== undefined) {
    console.log(`Context window: ${contextWindow}`);
  }
  const maxTokens = readNumber(provider, "maxTokens");
  if (maxTokens !== undefined) {
    console.log(`Max tokens: ${maxTokens}`);
  }
  const headers = readField(provider, "headers");
  if (isRecord(headers) && Object.keys(headers).length > 0) {
    console.log(`Headers: ${Object.keys(headers).join(", ")}`);
  }
  const compat = readField(provider, "compat");
  if (isRecord(compat) && Object.keys(compat).length > 0) {
    console.log("Compat:");
    console.log(JSON.stringify(compat, null, 2));
  }
  printProviderLastCheck(provider);
  console.log(`Created: ${readString(provider, "createdAt") ?? ""}`);
  console.log(`Updated: ${readString(provider, "updatedAt") ?? ""}`);
}

function providerSecretStatus(provider: unknown): string {
  if (!readString(provider, "apiKeyRef")) {
    return "none";
  }
  const apiKeyStatus = readField(provider, "apiKeyStatus");
  if (isRecord(apiKeyStatus) && readBoolean(apiKeyStatus, "configured") !== true) {
    return readString(apiKeyStatus, "errorCode") ?? "missing";
  }
  return readBoolean(provider, "apiKeyConfigured") ? "configured" : "missing";
}

async function assertProviderRunPreflight(options: GlobalOptions, providerPresetId: string): Promise<void> {
  const response = await requestJson(options, "GET", `/providers/${encodeURIComponent(providerPresetId)}`, { cwd: options.cwd });
  const provider = readRequiredRecord(response, "provider");
  const blocker = providerRunPreflightBlocker(provider);
  if (blocker) {
    throw new CliError(
      4,
      "provider_preflight_failed",
      `${blocker} Run 'ling-stack provider check ${providerPresetId}' or pass --skip-preflight for debugging.`,
    );
  }
}

function providerRunPreflightBlocker(provider: unknown): string | undefined {
  const displayName = readString(provider, "displayName") ?? readString(provider, "id") ?? "Provider";
  if (readBoolean(provider, "enabled") !== true) {
    return `${displayName}: provider is disabled.`;
  }
  if (readString(provider, "api") === "media-job") {
    return `${displayName}: provider is media only.`;
  }
  if (!readArray(provider, "capabilities").includes("chat")) {
    return `${displayName}: provider does not support chat.`;
  }
  if (readString(provider, "apiKeyRef") && readBoolean(provider, "apiKeyConfigured") !== true) {
    return `${displayName}: ${providerSecretStatus(provider)}.`;
  }

  const lastCheck = readField(provider, "lastCheck");
  if (!isRecord(lastCheck)) {
    return `${displayName}: provider has not been checked.`;
  }
  if (readBoolean(lastCheck, "ok") !== true) {
    return `${displayName}: provider check failed (${readString(lastCheck, "code") ?? "failed"}). ${readString(lastCheck, "message") ?? ""}`.trim();
  }
  return undefined;
}

function providerCheckStatus(provider: unknown): string {
  const lastCheck = readField(provider, "lastCheck");
  if (!isRecord(lastCheck)) {
    return "unchecked";
  }
  if (readBoolean(lastCheck, "ok")) {
    return "ready";
  }
  return readString(lastCheck, "code") ?? "failed";
}

function canBatchCheckProviderResponse(provider: unknown): boolean {
  return (
    readBoolean(provider, "enabled") === true &&
    readString(provider, "api") !== "media-job" &&
    readArray(provider, "capabilities").includes("chat")
  );
}

function envNameFromRef(ref: string): string {
  if (ref.startsWith("env:")) {
    return ref.slice("env:".length);
  }
  if (ref.startsWith("keychain:")) {
    return ref.slice("keychain:".length);
  }
  return ref;
}

function printProviderLastCheck(provider: unknown): void {
  const lastCheck = readField(provider, "lastCheck");
  if (!isRecord(lastCheck)) {
    console.log("Last check: unchecked");
    return;
  }
  console.log(`Last check: ${providerCheckStatus(provider)}`);
  console.log(`Checked: ${readString(lastCheck, "checkedAt") ?? ""}`);
  const message = readString(lastCheck, "message");
  if (message) {
    console.log(`Check message: ${message}`);
  }
}

function formatOptionalBoolean(value: boolean | undefined): string {
  return value === undefined ? "default" : String(value);
}

function printChannelsList(response: unknown): void {
  const channels = readArray(response, "channels");
  if (channels.length === 0) {
    console.log("No channels found.");
    return;
  }
  printTable(
    ["ID", "Name", "Status", "Policy", "Path", "Provider", "Tools", "Updated"],
    channels.map((channel) => [
      truncate(readString(channel, "id") ?? "", 32),
      truncate(readString(channel, "name") ?? "", 24),
      truncate(readString(channel, "status") ?? "active", 10),
      truncate(formatChannelPolicy(channel), 18),
      truncate(readString(channel, "boundPath") ?? "", 28),
      truncate(readString(channel, "defaultProviderPresetId") ?? "", 22),
      truncate(readArray(channel, "allowedTools").join(","), 24),
      truncate(readString(channel, "updatedAt") ?? "", 24),
    ]),
  );
}

function printChannelDetail(response: unknown): void {
  const channel = readField(response, "channel");
  if (!isRecord(channel)) {
    printJson(response);
    return;
  }
  console.log(`ID: ${readString(channel, "id") ?? ""}`);
  console.log(`Name: ${readString(channel, "name") ?? ""}`);
  console.log(`Status: ${readString(channel, "status") ?? "active"}`);
  console.log(`Path: ${readString(channel, "boundPath") ?? ""}`);
  const provider = readString(channel, "defaultProviderPresetId");
  if (provider) {
    console.log(`Default provider: ${provider}`);
  }
  const teammate = readString(channel, "defaultTeammateId");
  if (teammate) {
    console.log(`Default teammate: ${teammate}`);
  }
  console.log(`Allowed tools: ${readArray(channel, "allowedTools").join(", ")}`);
  console.log(`Runtime policy: ${formatChannelPolicy(channel)}`);
  console.log(`Created: ${readString(channel, "createdAt") ?? ""}`);
  console.log(`Updated: ${readString(channel, "updatedAt") ?? ""}`);
}

function formatChannelPolicy(channel: unknown): string {
  const policy = readField(channel, "runtimePolicy");
  if (!isRecord(policy)) {
    return "smart/boundPath";
  }
  return [
    readString(policy, "schedulingMode") ?? "smart",
    readString(policy, "writeLockScope") ?? "boundPath",
    `max=${readNumber(policy, "maxConcurrentRuns") ?? 1}`,
  ].join("/");
}

function printTasksList(response: unknown): void {
  const tasks = readArray(response, "tasks");
  if (tasks.length === 0) {
    console.log("No tasks found.");
    return;
  }
  printTable(
    ["ID", "Status", "Channel", "Title", "Run", "Updated"],
    tasks.map((task) => [
      truncate(readString(task, "id") ?? "", 32),
      readString(task, "status") ?? "",
      truncate(readString(task, "channelId") ?? "", 22),
      truncate(readString(task, "title") ?? "", 32),
      truncate(readString(task, "currentRunId") ?? "", 18),
      truncate(readString(task, "updatedAt") ?? "", 24),
    ]),
  );
}

function printTaskDetail(response: unknown): void {
  const task = readField(response, "task");
  if (!isRecord(task)) {
    printJson(response);
    return;
  }
  console.log(`ID: ${readString(task, "id") ?? ""}`);
  console.log(`Title: ${readString(task, "title") ?? ""}`);
  console.log(`Status: ${readString(task, "status") ?? ""}`);
  console.log(`Channel: ${readString(task, "channelId") ?? ""}`);
  const assignee = readString(task, "assigneeTeammateId");
  if (assignee) {
    console.log(`Assignee: ${assignee}`);
  }
  const currentRun = readString(task, "currentRunId");
  if (currentRun) {
    console.log(`Current run: ${currentRun}`);
  }
  console.log("Prompt:");
  console.log(readString(task, "prompt") ?? "");
  console.log(`Created: ${readString(task, "createdAt") ?? ""}`);
  console.log(`Updated: ${readString(task, "updatedAt") ?? ""}`);
}

function printApprovalPolicy(response: unknown): void {
  const policy = readField(response, "policy");
  if (!isRecord(policy)) {
    printJson(response);
    return;
  }

  console.log(`CWD: ${readString(response, "cwd") ?? ""}`);
  console.log(`Workspace: ${readString(policy, "workspaceId") ?? ""}`);
  console.log(`Updated: ${readString(policy, "updatedAt") ?? ""}`);
  console.log("");
  console.log("Tool decisions:");
  const toolDecisions = readField(policy, "toolDecisions");
  printTable(
    ["Tool", "Decision"],
    (Object.keys(defaultApprovalToolDecisions) as RunTool[]).map((tool) => [
      tool,
      readString(toolDecisions, tool) ?? defaultApprovalToolDecisions[tool],
    ]),
  );
  const allowedWritePaths = readArray(policy, "allowedWritePaths").filter((path): path is string => typeof path === "string");
  console.log("");
  console.log(`Allowed write paths: ${allowedWritePaths.length > 0 ? allowedWritePaths.join(", ") : "<none>"}`);
}

function printApprovalsList(response: unknown): void {
  const approvals = readArray(response, "approvals");
  if (approvals.length === 0) {
    console.log("No approvals found.");
    return;
  }
  printTable(
    ["ID", "Status", "Risk", "Action", "Owner", "Title", "Created"],
    approvals.map((approval) => [
      truncate(readString(approval, "id") ?? "", 32),
      readString(approval, "status") ?? "",
      readString(approval, "risk") ?? "",
      readString(approval, "actionType") ?? "",
      truncate(approvalOwnerLabel(approval), 24),
      truncate(readString(approval, "title") ?? "", 36),
      truncate(readString(approval, "createdAt") ?? "", 24),
    ]),
  );
}

function printApprovalDetail(response: unknown): void {
  const approval = readField(response, "approval");
  if (!isRecord(approval)) {
    printJson(response);
    return;
  }
  console.log(`ID: ${readString(approval, "id") ?? ""}`);
  console.log(`Status: ${readString(approval, "status") ?? ""}`);
  console.log(`Risk: ${readString(approval, "risk") ?? ""}`);
  console.log(`Action: ${readString(approval, "actionType") ?? ""}`);
  console.log(`Run: ${readString(approval, "runId") ?? ""}`);
  console.log(`Task: ${readString(approval, "taskId") ?? ""}`);
  const mediaJobId = readString(approval, "mediaJobId");
  if (mediaJobId) {
    console.log(`Media job: ${mediaJobId}`);
  }
  console.log(`Title: ${readString(approval, "title") ?? ""}`);
  console.log(`Description: ${readString(approval, "description") ?? ""}`);
  console.log(`Created: ${readString(approval, "createdAt") ?? ""}`);
  const expiresAt = readString(approval, "expiresAt");
  if (expiresAt) {
    console.log(`Expires: ${expiresAt}`);
  }
  const resolvedAt = readString(approval, "resolvedAt");
  if (resolvedAt) {
    console.log(`Resolved: ${resolvedAt}`);
  }
  const reason = readString(approval, "decisionReason");
  if (reason) {
    console.log(`Reason: ${reason}`);
  }
  console.log("Payload:");
  console.log(JSON.stringify(readField(approval, "payload") ?? null, null, 2));
}

function printRunsList(response: unknown): void {
  const runs = readArray(response, "runs");
  if (runs.length === 0) {
    console.log("No runs found.");
    return;
  }
  printTable(
    ["ID", "Status", "Provider", "Model", "Task", "Updated"],
    runs.map((run) => [
      truncate(readString(run, "id") ?? "", 32),
      readString(run, "status") ?? "",
      truncate(readString(run, "providerName") ?? "", 18),
      truncate(readString(run, "providerModel") ?? "", 18),
      truncate(readString(run, "taskId") ?? "", 20),
      truncate(readString(run, "updatedAt") ?? "", 24),
    ]),
  );
}

function printRunShellSnapshots(response: unknown): void {
  const snapshots = readArray(response, "snapshots");
  console.log(`Run: ${readString(response, "runId") ?? ""}`);
  if (snapshots.length === 0) {
    console.log("No shell snapshots found.");
    return;
  }
  printTable(
    ["Seq", "Status", "Source", "Tool Call", "Exit", "Duration", "Snapshot", "Command"],
    snapshots.map((snapshot) => [
      String(readNumber(snapshot, "sequence") ?? ""),
      readString(snapshot, "status") ?? "",
      readString(snapshot, "source") ?? "",
      truncate(readString(snapshot, "toolCallId") ?? "", 24),
      readNumber(snapshot, "exitCode") === undefined ? "" : String(readNumber(snapshot, "exitCode")),
      readNumber(snapshot, "durationMs") === undefined ? "" : `${readNumber(snapshot, "durationMs")}ms`,
      truncate(readString(snapshot, "id") ?? "", 42),
      truncate(readString(snapshot, "commandPreview") ?? "", 64),
    ]),
  );
}

function printRunShellSnapshot(response: unknown): void {
  const snapshot = readRequiredRecord(response, "snapshot");
  const command = readOptionalRecord(snapshot, "command");
  const process = readOptionalRecord(snapshot, "process");
  const output = readOptionalRecord(snapshot, "output");
  const redaction = readOptionalRecord(snapshot, "redaction");
  console.log(`ID: ${readString(snapshot, "id") ?? ""}`);
  console.log(`Run: ${readString(snapshot, "runId") ?? ""}`);
  console.log(`Tool call: ${readString(snapshot, "toolCallId") ?? ""}`);
  console.log(`Sequence: ${readNumber(snapshot, "sequence") ?? ""}`);
  console.log(`Status: ${readString(snapshot, "status") ?? ""}`);
  console.log(`Source: ${readString(snapshot, "source") ?? ""}`);
  console.log(`Created: ${readString(snapshot, "createdAt") ?? ""}`);
  const approvalId = readString(snapshot, "approvalId");
  if (approvalId) {
    console.log(`Approval: ${approvalId}`);
  }
  console.log(`CWD: ${readString(command, "cwd") ?? ""}`);
  console.log(`Command: ${readString(command, "commandPreview") ?? ""}`);
  const startedAt = readString(process, "startedAt");
  const endedAt = readString(process, "endedAt");
  if (startedAt) {
    console.log(`Started: ${startedAt}`);
  }
  if (endedAt) {
    console.log(`Ended: ${endedAt}`);
  }
  const exitCode = readNumber(process, "exitCode");
  if (exitCode !== undefined) {
    console.log(`Exit code: ${exitCode}`);
  }
  const signal = readString(process, "signal");
  if (signal) {
    console.log(`Signal: ${signal}`);
  }
  const durationMs = readNumber(process, "durationMs");
  if (durationMs !== undefined) {
    console.log(`Duration: ${durationMs}ms`);
  }
  console.log(`Stdout bytes: ${readNumber(output, "stdoutByteCount") ?? 0}`);
  console.log(`Stderr bytes: ${readNumber(output, "stderrByteCount") ?? 0}`);
  console.log(`Redacted: ${readBoolean(redaction, "redacted") ?? false}`);
  const artifactId = readString(response, "artifactId");
  if (artifactId) {
    console.log(`Artifact: ${artifactId}`);
  }
  const textArtifactId = readString(response, "textArtifactId");
  if (textArtifactId) {
    console.log(`Text artifact: ${textArtifactId}`);
  }
  const stdoutHead = readString(output, "stdoutHead");
  if (stdoutHead) {
    console.log("");
    console.log("stdout:");
    console.log(stdoutHead);
  }
  const stderrHead = readString(output, "stderrHead");
  if (stderrHead) {
    console.log("");
    console.log("stderr:");
    console.log(stderrHead);
  }
}

function approvalOwnerLabel(approval: unknown): string {
  const externalWorkActionId = readString(approval, "externalWorkActionId");
  if (externalWorkActionId) {
    return `external-action:${externalWorkActionId}`;
  }
  const mediaJobId = readString(approval, "mediaJobId");
  if (mediaJobId) {
    return `media:${mediaJobId}`;
  }
  const runId = readString(approval, "runId");
  return runId ? `run:${runId}` : "";
}

function printRunDetail(run: unknown, eventsResponse?: unknown): void {
  if (!isRecord(run)) {
    printJson(run);
    return;
  }
  console.log(`ID: ${readString(run, "id") ?? ""}`);
  console.log(`Status: ${readString(run, "status") ?? ""}`);
  console.log(`CWD: ${readString(run, "cwd") ?? ""}`);
  console.log(`Task: ${readString(run, "taskId") ?? ""}`);
  console.log(`Provider: ${readString(run, "providerName") ?? ""}/${readString(run, "providerModel") ?? ""}`);
  console.log(`Created: ${readString(run, "createdAt") ?? ""}`);
  console.log(`Updated: ${readString(run, "updatedAt") ?? ""}`);
  const error = readString(run, "errorMessage");
  if (error) {
    console.log(`Error: ${error}`);
  }
  const eventLogPath = readString(run, "eventLogPath");
  if (eventLogPath) {
    console.log(`Event log: ${eventLogPath}`);
  }
  const summaryPath = readString(run, "summaryPath");
  if (summaryPath) {
    console.log(`Summary: ${summaryPath}`);
  }
  if (eventsResponse !== undefined) {
    printRunApprovalSummary(eventsResponse);
  }
}

function printRunApprovalSummary(eventsResponse: unknown): void {
  const approvalSummaries = summarizeRunApprovalEvents(readArray(eventsResponse, "events").filter(isRunEventEnvelope));
  if (approvalSummaries.length === 0) {
    console.log("Approvals: none");
    return;
  }

  console.log("Approvals:");
  printTable(
    ["ID", "Status", "Action", "Risk", "Reason"],
    approvalSummaries.map((approval) => [
      truncate(approval.id, 32),
      approval.status,
      approval.actionType,
      approval.risk,
      truncate(approval.reason, 48),
    ]),
  );
}

function printRunEvents(response: unknown): void {
  const events = readArray(response, "events").filter(isRunEventEnvelope);
  if (events.length === 0) {
    console.log("No events found.");
    return;
  }
  printTable(
    ["Seq", "Type", "Summary"],
    events.map((event) => [String(event.seq), event.type, truncate(summarizeEvent(event), 90)]),
  );
  const nextSeq = readNumber(response, "nextSeq");
  if (nextSeq !== undefined) {
    console.log(`Next seq: ${nextSeq}`);
  }
}

function printExternalWorkImport(response: unknown): void {
  const item = readRequiredRecord(response, "externalWorkItem");
  const workflow = readRequiredRecord(response, "workflow");
  const workflowStep = readRequiredRecord(response, "workflowStep");
  const artifacts = readArray(response, "artifacts");

  console.log(`External work imported: ${readString(item, "identifier") ?? ""}`);
  console.log(`Duplicate: ${readBoolean(response, "duplicate") ?? false}`);
  console.log(`Kind: ${readString(item, "kind") ?? ""}`);
  console.log(`State: ${readString(item, "state") ?? ""}`);
  console.log(`Workflow: ${readString(workflow, "id") ?? ""} (${readString(workflow, "status") ?? ""})`);
  console.log(`Step: ${readString(workflowStep, "id") ?? ""} (${readString(workflowStep, "status") ?? ""})`);
  if (artifacts.length === 0) {
    console.log("Artifacts: none");
    return;
  }
  console.log("Artifacts:");
  printTable(
    ["ID", "Title", "Path"],
    artifacts.map((artifact) => [
      truncate(readString(artifact, "id") ?? "", 32),
      truncate(readString(artifact, "title") ?? "", 34),
      truncate(readString(artifact, "path") ?? "", 72),
    ]),
  );
}

function printExternalWorkList(response: unknown): void {
  const items = readArray(response, "externalWork");
  console.log("External work:");
  if (items.length === 0) {
    console.log("No external work found.");
    return;
  }
  printTable(
    ["ID", "Identifier", "Kind", "Item State", "Scheduler", "Workflow", "Step", "Workspace", "Error"],
    items.map((view) => {
      const externalWork = readOptionalRecord(view, "externalWork");
      const item = externalWork ? readOptionalRecord(externalWork, "item") : undefined;
      const workflow = readOptionalRecord(view, "workflow");
      const workflowStep = readOptionalRecord(view, "workflowStep");
      const schedulerState = readOptionalRecord(view, "schedulerState");
      return [
        truncate(readString(externalWork, "id") ?? "", 30),
        truncate(readString(externalWork, "identifier") ?? "", 30),
        readString(externalWork, "workItemKind") ?? "",
        readString(item, "state") ?? "",
        readString(schedulerState, "schedulerStatus") ?? "-",
        truncate(readString(workflow, "id") ?? readString(externalWork, "workflowId") ?? "", 24),
        truncate(readString(workflowStep, "id") ?? readString(externalWork, "workflowStepId") ?? "", 24),
        truncate(readString(schedulerState, "workspacePath") ?? "", 36),
        truncate(readString(schedulerState, "lastErrorMessage") ?? "", 48),
      ];
    }),
  );
}

function printExternalWorkShow(response: unknown): void {
  const view = readRequiredRecord(response, "externalWork");
  const externalWork = readRequiredRecord(view, "externalWork");
  const item = readOptionalRecord(externalWork, "item");
  const workflow = readOptionalRecord(view, "workflow");
  const workflowStep = readOptionalRecord(view, "workflowStep");
  const schedulerState = readOptionalRecord(view, "schedulerState");
  const artifacts = readArray(view, "artifacts");

  console.log(`External work: ${readString(externalWork, "id") ?? ""}`);
  console.log(`Identifier: ${readString(externalWork, "identifier") ?? ""}`);
  console.log(`Kind: ${readString(externalWork, "workItemKind") ?? ""}`);
  console.log(`Item state: ${readString(item, "state") ?? ""}`);
  console.log(`Channel: ${readString(externalWork, "channelId") ?? ""}`);
  console.log(`Workflow: ${readString(workflow, "id") ?? readString(externalWork, "workflowId") ?? ""} (${readString(workflow, "status") ?? "missing"})`);
  console.log(`Step: ${readString(workflowStep, "id") ?? readString(externalWork, "workflowStepId") ?? ""} (${readString(workflowStep, "status") ?? "missing"})`);
  console.log(`Scheduler: ${readString(schedulerState, "schedulerStatus") ?? "none"}`);
  console.log(`Workspace: ${readString(schedulerState, "workspacePath") ?? ""}`);
  console.log(`Last error: ${readString(schedulerState, "lastErrorMessage") ?? ""}`);
  if (artifacts.length === 0) {
    console.log("Artifacts: none");
    return;
  }
  console.log("Artifacts:");
  printTable(
    ["ID", "Title", "Path"],
    artifacts.map((artifact) => [
      truncate(readString(artifact, "id") ?? "", 32),
      truncate(readString(artifact, "title") ?? "", 34),
      truncate(readString(artifact, "path") ?? "", 72),
    ]),
  );
}

function printExternalWorkActionMutation(response: unknown, title: string): void {
  const action = readRequiredRecord(response, "action");
  const approval = readOptionalRecord(response, "approval");
  const artifacts = readArray(response, "artifacts");
  console.log(`${title}: ${readString(action, "id") ?? ""}`);
  console.log(`Duplicate: ${readBoolean(response, "duplicate") ?? false}`);
  console.log(`Kind: ${readString(action, "actionKind") ?? ""}`);
  console.log(`Status: ${readString(action, "status") ?? ""}`);
  console.log(`External work: ${readString(action, "externalWorkId") ?? ""}`);
  console.log(`Target: ${externalWorkActionTargetLabel(action)}`);
  console.log(`Approval: ${readString(approval, "id") ?? readString(action, "approvalId") ?? "none"}`);
  const lastError = readString(action, "lastErrorMessage");
  if (lastError) {
    console.log(`Last error: ${lastError}`);
  }
  if (artifacts.length === 0) {
    console.log("Artifacts: none");
    return;
  }
  console.log("Artifacts:");
  printTable(
    ["ID", "Title", "Path"],
    artifacts.map((artifact) => [
      truncate(readString(artifact, "id") ?? "", 32),
      truncate(readString(artifact, "title") ?? "", 34),
      truncate(readString(artifact, "path") ?? "", 72),
    ]),
  );
}

function printExternalWorkActionsList(response: unknown): void {
  const actions = readArray(response, "actions");
  console.log("External work actions:");
  if (actions.length === 0) {
    console.log("No external work actions found.");
    return;
  }
  printTable(
    ["ID", "Kind", "Status", "Target", "External Work", "Approval", "Artifacts"],
    actions.map((view) => {
      const action = readOptionalRecord(view, "action");
      return [
        truncate(readString(action, "id") ?? "", 32),
        readString(action, "actionKind") ?? "",
        readString(action, "status") ?? "",
        truncate(externalWorkActionTargetLabel(action), 36),
        truncate(readString(action, "externalWorkId") ?? "", 30),
        truncate(readString(action, "approvalId") ?? "", 28),
        String(readArray(view, "artifacts").length),
      ];
    }),
  );
}

function printExternalWorkActionShow(response: unknown): void {
  const view = readRequiredRecord(response, "action");
  const action = readRequiredRecord(view, "action");
  const approval = readOptionalRecord(view, "approval");
  const artifacts = readArray(view, "artifacts");
  console.log(`External work action: ${readString(action, "id") ?? ""}`);
  console.log(`Kind: ${readString(action, "actionKind") ?? ""}`);
  console.log(`Status: ${readString(action, "status") ?? ""}`);
  console.log(`External work: ${readString(action, "externalWorkId") ?? ""}`);
  console.log(`Target: ${externalWorkActionTargetLabel(action)}`);
  console.log(`Approval requirement: ${readString(action, "approvalRequirement") ?? ""}`);
  console.log(`Approval: ${readString(approval, "id") ?? readString(action, "approvalId") ?? "none"} (${readString(approval, "status") ?? ""})`);
  console.log(`Last error: ${readString(action, "lastErrorMessage") ?? ""}`);
  if (artifacts.length === 0) {
    console.log("Artifacts: none");
    return;
  }
  console.log("Artifacts:");
  printTable(
    ["ID", "Title", "Path"],
    artifacts.map((artifact) => [
      truncate(readString(artifact, "id") ?? "", 32),
      truncate(readString(artifact, "title") ?? "", 34),
      truncate(readString(artifact, "path") ?? "", 72),
    ]),
  );
}

function externalWorkActionTargetLabel(action: unknown): string {
  const target = readOptionalRecord(action, "target");
  const repository = readString(target, "repository") ?? "";
  const number = readNumber(target, "number");
  return number === undefined ? repository : `${repository}#${number}`;
}

function printExternalWorkPoll(response: unknown): void {
  console.log("External work poll:");
  console.log(`Candidates: ${readNumber(response, "candidates") ?? 0}`);
  console.log(`Claimed: ${readNumber(response, "claimed") ?? 0}`);
  console.log(`Duplicates: ${readNumber(response, "duplicates") ?? 0}`);
  console.log(`Blocked: ${readNumber(response, "blocked") ?? 0}`);
  console.log(`Retry scheduled: ${readNumber(response, "retryScheduled") ?? 0}`);
  console.log(`Terminal ignored: ${readNumber(response, "terminalIgnored") ?? 0}`);
  const artifacts = readArray(response, "artifacts");
  console.log(`Artifacts: ${artifacts.length}`);
  printExternalWorkResults(response);
}

function printExternalWorkStatus(response: unknown): void {
  const channel = readRequiredRecord(response, "channel");
  const workflow = readRequiredRecord(response, "workflow");
  const secret = readRequiredRecord(response, "secret");
  const records = readRequiredRecord(response, "records");
  const externalWork = readRequiredRecord(records, "externalWork");
  const ciTriage = readRequiredRecord(records, "ciTriage");
  const actions = readRequiredRecord(records, "actions");
  const background = readRequiredRecord(response, "background");
  const sourceKind = readString(workflow, "sourceKind") ?? "unknown";
  const repository = readString(workflow, "repository");
  const projectSlug = readString(workflow, "projectSlug");
  const workflowValid = readBoolean(workflow, "valid") ?? false;
  const backgroundStatus = readString(background, "status") ?? "not_configured";
  console.log("External work status:");
  console.log(`Channel: ${readString(channel, "name") ?? ""} (${readString(channel, "id") ?? ""})`);
  console.log(`Bound path: ${readString(channel, "boundPath") ?? "not set"}`);
  console.log(`Workflow: ${readString(workflow, "path") ?? ""}`);
  console.log(`Workflow exists: ${readBoolean(workflow, "exists") ?? false}`);
  console.log(`Workflow valid: ${workflowValid}`);
  const workflowError = readString(workflow, "error");
  if (workflowError) {
    console.log(`Workflow error: ${workflowError}`);
  }
  console.log(`Source: ${sourceKind}`);
  console.log(`Target: ${repository ?? projectSlug ?? "not configured"}`);
  console.log(`Events: ${readArray(workflow, "events").join(", ") || "none"}`);
  console.log(`Secret: ${readString(secret, "status") ?? "not_required"}${readString(secret, "ref") ? ` (${readString(secret, "ref")})` : ""}`);
  const secretMessage = readString(secret, "message");
  if (secretMessage) {
    console.log(`Secret message: ${secretMessage}`);
  }
  console.log(`External work: ${readNumber(externalWork, "total") ?? 0} total, ${readNumber(externalWork, "ready") ?? 0} ready, ${readNumber(externalWork, "blocked") ?? 0} blocked`);
  console.log(`CI triage: ${readNumber(ciTriage, "total") ?? 0} total, ${readNumber(ciTriage, "taskCreated") ?? 0} task created, ${readNumber(ciTriage, "failed") ?? 0} failed`);
  console.log(`Actions: ${readNumber(actions, "total") ?? 0} total, ${readNumber(actions, "waitingForApproval") ?? 0} waiting, ${readNumber(actions, "approved") ?? 0} approved`);
  console.log(`Background: ${backgroundStatus}${readString(background, "schedulerId") ? ` (${readString(background, "schedulerId")})` : ""}`);
  const nextPollAt = readString(background, "nextPollAt");
  if (nextPollAt) {
    console.log(`Next poll: ${nextPollAt}`);
  }
  const lastError = readString(background, "lastError");
  if (lastError) {
    console.log(`Background error: ${lastError}`);
  }
  console.log(`Next: ${externalWorkStatusNextCommand(sourceKind, workflowValid, backgroundStatus)}`);
}

function externalWorkStatusNextCommand(sourceKind: string, workflowValid: boolean, backgroundStatus: string): string {
  if (!workflowValid) {
    return "Fix WORKFLOW.md, then rerun external-work status.";
  }
  if (sourceKind === "github" && backgroundStatus !== "running") {
    return "Run external-work github poll --channel <id>, or start background polling.";
  }
  if (sourceKind === "linear") {
    return "Run external-work linear poll --channel <id>.";
  }
  return "Inspect records with external-work list, or reconcile local state.";
}

function printExternalWorkBackgroundMutation(response: unknown, title: string): void {
  const scheduler = readRequiredRecord(response, "scheduler");
  console.log(`${title}: ${readString(scheduler, "id") ?? ""}`);
  console.log(`Duplicate: ${readBoolean(response, "duplicate") ?? false}`);
  console.log(`Status: ${readString(scheduler, "status") ?? ""}`);
  console.log(`Channel: ${readString(scheduler, "channelId") ?? ""}`);
  console.log(`Repository: ${readString(scheduler, "repository") ?? ""}`);
  console.log(`Poll interval ms: ${readNumber(scheduler, "pollIntervalMs") ?? 0}`);
  console.log(`Tick count: ${readNumber(scheduler, "tickCount") ?? 0}`);
  console.log(`Next poll: ${readString(scheduler, "nextPollAt") ?? ""}`);
  const lastError = readString(scheduler, "lastErrorMessage");
  if (lastError) {
    console.log(`Last error: ${lastError}`);
  }
}

function printExternalWorkBackgroundList(response: unknown): void {
  const schedulers = readArray(response, "schedulers");
  console.log("External work background schedulers:");
  if (schedulers.length === 0) {
    console.log("No external work background schedulers found.");
    return;
  }
  printTable(
    ["ID", "Status", "Channel", "Repository", "Interval", "Ticks", "Next Poll", "Error"],
    schedulers.map((scheduler) => [
      truncate(readString(scheduler, "id") ?? "", 34),
      readString(scheduler, "status") ?? "",
      truncate(readString(scheduler, "channelId") ?? "", 24),
      truncate(readString(scheduler, "repository") ?? "", 30),
      String(readNumber(scheduler, "pollIntervalMs") ?? 0),
      String(readNumber(scheduler, "tickCount") ?? 0),
      truncate(readString(scheduler, "nextPollAt") ?? "", 24),
      truncate(readString(scheduler, "lastErrorMessage") ?? "", 42),
    ]),
  );
}

function printAutomationSchedulerMutation(response: unknown, title: string): void {
  const scheduler = readRequiredRecord(response, "scheduler");
  console.log(`${title}: ${readString(scheduler, "id") ?? ""}`);
  console.log(`Duplicate: ${readBoolean(response, "duplicate") ?? false}`);
  console.log(`Status: ${readString(scheduler, "status") ?? ""}`);
  console.log(`Automations: ${readNumber(scheduler, "automationCount") ?? 0}`);
  console.log(`Tick count: ${readNumber(scheduler, "tickCount") ?? 0}`);
  console.log(`Next run: ${readString(scheduler, "nextRunAt") ?? ""}`);
  const lastError = readString(scheduler, "lastErrorMessage");
  if (lastError) {
    console.log(`Last error: ${lastError}`);
  }
}

function printAutomationSchedulerList(response: unknown): void {
  const schedulers = readArray(response, "schedulers");
  console.log("Automation schedulers:");
  if (schedulers.length === 0) {
    console.log("No automation schedulers found.");
    return;
  }
  printTable(
    ["ID", "Status", "Automations", "Ticks", "Next Run", "Last Run", "Error"],
    schedulers.map((scheduler) => [
      truncate(readString(scheduler, "id") ?? "", 34),
      readString(scheduler, "status") ?? "",
      String(readNumber(scheduler, "automationCount") ?? 0),
      String(readNumber(scheduler, "tickCount") ?? 0),
      truncate(readString(scheduler, "nextRunAt") ?? "", 24),
      truncate(readString(scheduler, "lastRunAt") ?? "", 24),
      truncate(readString(scheduler, "lastErrorMessage") ?? "", 42),
    ]),
  );
  for (const scheduler of schedulers) {
    const items = readArray(scheduler, "items");
    if (items.length === 0) {
      continue;
    }
    console.log("");
    console.log(`Items for ${readString(scheduler, "id") ?? "scheduler"}:`);
    printTable(
      ["Automation", "Title", "Next Run", "Last Run", "Last Automation Run", "Error"],
      items.map((item) => [
        truncate(readString(item, "automationId") ?? "", 30),
        truncate(readString(item, "title") ?? "", 28),
        truncate(readString(item, "nextRunAt") ?? "", 24),
        truncate(readString(item, "lastRunAt") ?? "", 24),
        truncate(readString(item, "lastAutomationRunId") ?? "", 28),
        truncate(readString(item, "lastErrorMessage") ?? "", 36),
      ]),
    );
  }
}

function printExternalWorkCiTriage(response: unknown): void {
  console.log("External work CI triage:");
  console.log(`Triaged: ${readNumber(response, "triaged") ?? 0}`);
  console.log(`Task created: ${readNumber(response, "taskCreated") ?? 0}`);
  console.log(`Duplicates: ${readNumber(response, "duplicates") ?? 0}`);
  console.log(`Blocked: ${readNumber(response, "blocked") ?? 0}`);
  console.log(`Stale: ${readNumber(response, "stale") ?? 0}`);
  console.log(`Failed: ${readNumber(response, "failed") ?? 0}`);
  const records = readArray(response, "records");
  if (records.length === 0) {
    console.log("No failing CI records found.");
    return;
  }
  printTable(
    ["Status", "Check", "Target", "Task", "Artifacts", "Error"],
    records.map((view) => {
      const triage = readOptionalRecord(view, "triage");
      const task = readOptionalRecord(view, "task");
      return [
        readString(triage, "status") ?? "",
        truncate(readString(triage, "checkName") ?? "", 34),
        `${readString(triage, "repository") ?? ""}#${readNumber(triage, "subjectNumber") ?? ""}`,
        truncate(readString(task, "id") ?? readString(triage, "taskId") ?? "", 28),
        String(readArray(view, "artifacts").length),
        truncate(readString(triage, "lastErrorMessage") ?? "", 48),
      ];
    }),
  );
}

function printExternalWorkReconcile(response: unknown): void {
  console.log("External work reconcile:");
  console.log(`Expired leases: ${readNumber(response, "expiredLeases") ?? 0}`);
  console.log(`Checked: ${readNumber(response, "checked") ?? 0}`);
  console.log(`Blocked: ${readNumber(response, "blocked") ?? 0}`);
  console.log(`Retry ready: ${readNumber(response, "retryReady") ?? 0}`);
  console.log(`Terminal: ${readNumber(response, "terminal") ?? 0}`);
  const states = readArray(response, "schedulerStates");
  if (states.length === 0) {
    return;
  }
  console.log("Scheduler states:");
  printTable(
    ["External Work", "Status", "Workflow", "Step"],
    states.map((state) => [
      truncate(readString(state, "externalWorkId") ?? "", 32),
      readString(state, "schedulerStatus") ?? "",
      truncate(readString(state, "workflowId") ?? "", 32),
      truncate(readString(state, "workflowStepId") ?? "", 32),
    ]),
  );
}

function printExternalWorkResults(response: unknown): void {
  const results = readArray(response, "results");
  if (results.length === 0) {
    return;
  }
  console.log("Results:");
  printTable(
    ["Action", "Identifier", "Status", "Message"],
    results.map((result) => [
      readString(result, "action") ?? "",
      truncate(readString(result, "identifier") ?? readString(result, "subjectKey") ?? "", 36),
      readString(result, "schedulerStatus") ?? "",
      truncate(readString(result, "message") ?? "", 64),
    ]),
  );
}

function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  const widths = headers.map((header, index) => {
    const values = rows.map((row) => row[index] ?? "");
    return Math.max(header.length, ...values.map((value) => value.length));
  });
  console.log(headers.map((header, index) => header.padEnd(widths[index])).join("  "));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) {
    console.log(row.map((cell, index) => cell.padEnd(widths[index])).join("  "));
  }
}

function summarizeEvent(event: RunEventEnvelope): string {
  switch (event.type) {
    case "assistant_text_delta":
    case "assistant_thinking_delta":
      return readString(event.data, "text") ?? "";
    case "tool_start":
      return `${summarizeToolName(event.data)} ${summarizeUnknown(readField(event.data, "args"), 80)}`;
    case "tool_end":
      return `${summarizeToolName(event.data)} ${readBoolean(event.data, "isError") ? "error" : "ok"} ${summarizeUnifiedExecResult(readField(event.data, "result")) || summarizeUnknown(readField(event.data, "result"), 80)}`;
    case "approval_requested":
      return `${readString(event.data, "approvalId") ?? ""} ${readString(event.data, "actionType") ?? ""} ${readString(event.data, "risk") ?? ""}`;
    case "approval_approved":
    case "approval_denied":
    case "approval_expired":
      return `${readString(event.data, "approvalId") ?? ""} ${readString(event.data, "status") ?? ""}`;
    case "run_error":
      return readString(event.data, "message") ?? summarizeUnknown(event.data, 120);
    case "result":
      return summarizeResult(event.data);
    default:
      return summarizeUnknown(event.data, 120);
  }
}

function summarizeRunApprovalEvents(events: readonly RunEventEnvelope[]): RunApprovalSummary[] {
  const approvals = new Map<string, RunApprovalSummary>();
  for (const event of events) {
    if (event.type === "approval_requested") {
      const approvalId = readString(event.data, "approvalId");
      if (!approvalId || approvals.has(approvalId)) {
        continue;
      }
      approvals.set(approvalId, {
        id: approvalId,
        status: "pending",
        actionType: readString(event.data, "actionType") ?? "",
        risk: readString(event.data, "risk") ?? "",
        reason: readString(event.data, "description") ?? readString(event.data, "title") ?? "",
      });
      continue;
    }

    if (event.type === "approval_approved" || event.type === "approval_denied" || event.type === "approval_expired") {
      const approvalId = readString(event.data, "approvalId");
      if (!approvalId) {
        continue;
      }
      const current = approvals.get(approvalId);
      const fallbackStatus = event.type === "approval_approved" ? "approved" : event.type === "approval_expired" ? "expired" : "denied";
      approvals.set(approvalId, {
        id: approvalId,
        status: readString(event.data, "status") ?? fallbackStatus,
        actionType: current?.actionType ?? "",
        risk: current?.risk ?? "",
        reason: readString(event.data, "decisionReason") ?? current?.reason ?? "",
      });
    }
  }
  return [...approvals.values()];
}

function summarizeResult(data: unknown): string {
  const messageCount = readNumber(data, "messageCount");
  const runnerEventCount = readNumber(data, "runnerEventCount");
  const parts: string[] = [];
  if (messageCount !== undefined) {
    parts.push(`${messageCount} messages`);
  }
  if (runnerEventCount !== undefined) {
    parts.push(`${runnerEventCount} runner events`);
  }
  return parts.length > 0 ? parts.join(", ") : summarizeUnknown(data, 160);
}

function summarizeUnifiedExecResult(data: unknown): string {
  const unifiedExec = readUnifiedExecResultData(data);
  if (!isRecord(unifiedExec)) {
    return "";
  }
  const denied = readBoolean(unifiedExec, "denied");
  const reason = readString(unifiedExec, "reason");
  if (denied) {
    return reason ?? "Command denied by policy.";
  }
  const status = readString(unifiedExec, "status");
  const exitCode = readNumber(unifiedExec, "exitCode");
  const durationMs = readNumber(unifiedExec, "durationMs");
  const duration = durationMs === undefined ? "" : `${durationMs}ms`;
  if (status === "timed_out") {
    return duration ? `Command timed out after ${duration}.` : "Command timed out.";
  }
  if (status === "cancelled") {
    return duration ? `Command cancelled after ${duration}.` : "Command cancelled.";
  }
  if (exitCode !== undefined) {
    return duration ? `Command exited ${exitCode} in ${duration}.` : `Command exited ${exitCode}.`;
  }
  if (status) {
    return duration ? `Command ${status} in ${duration}.` : `Command ${status}.`;
  }
  return reason ?? "";
}

function readUnifiedExecResultData(data: unknown): unknown {
  const candidates = [
    data,
    readField(data, "result"),
    readField(data, "partialResult"),
  ];
  for (const candidate of candidates) {
    const direct = readField(candidate, "unifiedExec");
    if (direct !== undefined) {
      return direct;
    }
    const details = readField(candidate, "details");
    const nested = readField(details, "unifiedExec");
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function summarizeToolName(data: unknown): string {
  return readString(data, "toolName") ?? "tool";
}

function summarizeApprovalPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const type = readString(payload, "type");
  if (type === "bash") {
    const command = readString(payload, "command") ?? "";
    const cwd = readString(payload, "cwd");
    const riskFlags = readArray(payload, "riskFlags").filter((value): value is string => typeof value === "string");
    return `${cwd ? `${cwd}: ` : ""}${command}${riskFlags.length > 0 ? ` [${riskFlags.join(", ")}]` : ""}`;
  }
  if (type === "file_write") {
    if (readString(payload, "patchFormat")) {
      return summarizePatchApprovalPayload(payload);
    }
    return `${readString(payload, "path") ?? "<unknown>"} (${readNumber(payload, "bytes") ?? 0} bytes)`;
  }
  if (type === "file_edit") {
    if (readString(payload, "patchFormat")) {
      return summarizePatchApprovalPayload(payload);
    }
    return `${readString(payload, "path") ?? "<unknown>"} ${truncate(readString(payload, "diffPreview") ?? "", 120)}`;
  }
  return summarizeUnknown(payload, 180);
}

function summarizePatchApprovalPayload(payload: Record<string, unknown>): string {
  const paths = readArray(payload, "touchedPaths").filter((value): value is string => typeof value === "string");
  const summary = readField(payload, "summary");
  const fileCount = isRecord(summary) ? readNumber(summary, "fileCount") : undefined;
  const addedLines = isRecord(summary) ? readNumber(summary, "addedLines") : undefined;
  const removedLines = isRecord(summary) ? readNumber(summary, "removedLines") : undefined;
  const pathSummary = paths.length > 0 ? paths.join(", ") : readString(payload, "path") ?? "<unknown>";
  const statSummary = [
    fileCount !== undefined ? `${fileCount} files` : undefined,
    addedLines !== undefined ? `+${addedLines}` : undefined,
    removedLines !== undefined ? `-${removedLines}` : undefined,
  ].filter(Boolean).join(", ");
  return `${pathSummary}${statSummary ? ` (${statSummary})` : ""}`;
}

function summarizeUnknown(value: unknown, limit: number): string {
  if (value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return truncate(value, limit);
  }
  return truncate(JSON.stringify(value), limit);
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? "CLI run";
  return truncate(firstLine, 80);
}

function truncate(value: string, limit: number): string {
  if (value.length <= limit) {
    return value;
  }
  if (limit <= 3) {
    return value.slice(0, limit);
  }
  return `${value.slice(0, limit - 3)}...`;
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printCliError(error: unknown, options: GlobalOptions): void {
  const cliError = error instanceof CliError ? error : new CliError(1, "error", errorMessage(error));
  if (options.json) {
    const body = removeUndefined({
      ok: false,
      error: cliError.code,
      message: cliError.message,
      status: cliError.status,
    });
    console.error(JSON.stringify(body));
    return;
  }
  console.error(`error: ${cliError.code}`);
  console.error(`message: ${cliError.message}`);
}

function isRunEventEnvelope(value: unknown): value is RunEventEnvelope {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.runId === "string" &&
    typeof value.seq === "number" &&
    typeof value.ts === "string" &&
    typeof value.type === "string" &&
    "data" in value
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readField(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined;
}

function readRequiredRecord(value: unknown, key: string): Record<string, unknown> {
  const field = readField(value, key);
  if (!isRecord(field)) {
    throw new CliError(4, "bad_response", `Response did not include ${key}.`);
  }
  return field;
}

function readOptionalRecord(value: unknown, key: string): Record<string, unknown> | undefined {
  const field = readField(value, key);
  return isRecord(field) ? field : undefined;
}

function readString(value: unknown, key: string): string | undefined {
  const field = readField(value, key);
  return typeof field === "string" ? field : undefined;
}

function readNumber(value: unknown, key: string): number | undefined {
  const field = readField(value, key);
  return typeof field === "number" ? field : undefined;
}

function readBoolean(value: unknown, key: string): boolean | undefined {
  const field = readField(value, key);
  return typeof field === "boolean" ? field : undefined;
}

function readArray(value: unknown, key: string): readonly unknown[] {
  const field = readField(value, key);
  return Array.isArray(field) ? field : [];
}

function removeUndefined<T extends Record<string, unknown>>(value: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

function omitMarkdown<T extends { readonly markdown: string }>(value: T): Omit<T, "markdown"> {
  const { markdown: _markdown, ...rest } = value;
  return rest;
}

function removeUndefinedDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(removeUndefinedDeep);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .map(([key, entryValue]) => [key, removeUndefinedDeep(entryValue)]),
  );
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function printCommandHelp(command: string, subcommand?: string): void {
  if (command === "init") {
    printInitHelp();
    return;
  }
  if (command === "run") {
    printRunHelp();
    return;
  }
  if (command === "doctor") {
    printDoctorHelp();
    return;
  }
  if (command === "workspace") {
    printWorkspaceHelp();
    return;
  }
  if (command === "memory") {
    printMemoryHelp();
    return;
  }
  if (command === "restart" || command === "status" || command === "logs") {
    printLocalHelp(command);
    return;
  }
  if (command === "provider") {
    printProviderHelp();
    return;
  }
  if (command === "channel") {
    printChannelHelp();
    return;
  }
  if (command === "task") {
    printTaskHelp();
    return;
  }
  if (command === "policy") {
    printPolicyHelp();
    return;
  }
  if (command === "approvals") {
    printApprovalsHelp();
    return;
  }
  if (command === "runs") {
    printRunsHelp();
    return;
  }
  if (command === "automations") {
    printAutomationsHelp();
    return;
  }
  if (command === "external-work") {
    printExternalWorkHelp();
    return;
  }
  if (command === "daemon") {
    printDaemonHelp(subcommand);
    return;
  }
  if (command === "ui") {
    printUiHelp();
    return;
  }
  if (command === "completion") {
    printCompletionHelp();
    return;
  }
  printHelp();
}

function printHelp(): void {
  console.log(`Ling Stack CLI

Usage:
  ling restart
  ling status
  ling logs
  ling-stack [global options] init
  ling-stack [global options] doctor [config]
  ling-stack [global options] workspace migrate-state --to <repo-local|user-data-dir> [--dry-run]
  ling-stack [global options] workspace repair-registry [--dry-run]
  ling-stack [global options] memory export [--output memory.md] [--stdout]
  ling-stack [global options] memory import --file memory.md [--dry-run]
  ling-stack [global options] restart
  ling-stack [global options] status
  ling-stack [global options] logs
  ling-stack [global options] daemon status
  ling-stack [global options] daemon start
  ling-stack [global options] daemon stop
  ling-stack [global options] daemon restart
  ling-stack [global options] daemon logs
  ling-stack [global options] provider list
  ling-stack [global options] provider add <kind> --name <name> --provider-id <id> --model <model>
  ling-stack [global options] provider show <id>
  ling-stack [global options] provider check <id>
  ling-stack [global options] provider check-all
  ling-stack [global options] provider update <id> [options]
  ling-stack [global options] provider remove <id>
  ling-stack [global options] channel list
  ling-stack [global options] channel create --name <name> [--path <path>] [--status active|paused|archived]
  ling-stack [global options] channel show <id>
  ling-stack [global options] channel update <id> [options]
  ling-stack [global options] channel remove <id>
  ling-stack [global options] task list
  ling-stack [global options] task create --channel <id> --title <title> --prompt <prompt>
  ling-stack [global options] task show <id>
  ling-stack [global options] task update <id> [options]
  ling-stack [global options] task run <id> --provider <providerPresetId> [--skip-preflight]
  ling-stack [global options] run --provider <providerPresetId> [--skip-preflight] [options] <prompt...>
  ling-stack [global options] policy show
  ling-stack [global options] policy set --tool write=deny --write-path .
  ling-stack [global options] policy reset
  ling-stack [global options] runs list
  ling-stack [global options] runs show <id>
  ling-stack [global options] runs events <id>
  ling-stack [global options] runs cancel <id>
  ling-stack [global options] automations scheduler start
  ling-stack [global options] automations scheduler status
  ling-stack [global options] automations scheduler stop
  ling-stack [global options] external-work github import --channel <id> --event-type <event> --payload-file <payload.json>
  ling-stack [global options] external-work github poll --channel <id> [--workflow-path WORKFLOW.md]
  ling-stack [global options] external-work github background start --channel <id> [--workflow-path WORKFLOW.md]
  ling-stack [global options] external-work github background list
  ling-stack [global options] external-work github background stop <schedulerId>
  ling-stack [global options] external-work github ci triage --external-work <id> [--workflow-path WORKFLOW.md]
  ling-stack [global options] external-work status --channel <id> [--workflow-path WORKFLOW.md]
  ling-stack [global options] external-work list [--channel <id>] [--status ready]
  ling-stack [global options] external-work show <externalWorkId>
  ling-stack [global options] external-work actions propose-comment --external-work <id> --body-file comment.md
  ling-stack [global options] external-work actions propose-labels --external-work <id> --label name
  ling-stack [global options] external-work actions propose-review --external-work <id> --event COMMENT --body-file review.md
  ling-stack [global options] external-work reconcile [--channel <id>] [--workflow-path WORKFLOW.md]
  ling-stack [global options] external-work actions execute <actionId> [--workflow-path WORKFLOW.md]
  ling-stack [global options] approvals list
  ling-stack [global options] approvals show <id>
  ling-stack [global options] approvals approve <id>
  ling-stack [global options] approvals deny <id>
  ling-stack [global options] ui
  ling-stack [global options] completion <bash|zsh|fish>

Global options:
  --daemon-url <url>   Default: LING_STACK_DAEMON_URL or http://127.0.0.1:17891
  --cwd <path>         Workspace path. Default: current directory
  --json               Print machine-readable output
  --verbose            Print extra event detail
  --no-color           Reserved for stable non-colored output
  --help, -h           Show help

`);
}

function printInitHelp(): void {
  console.log(`Usage:
  ling-stack init
  ling-stack init --cwd /path/to/project
  ling-stack init --no-provider-templates
  ling-stack init --workspace-state-location user-data-dir

Behavior:
  Creates workspace runtime state, SQLite, sessions/, artifacts/, logs/, pi/, and config.json.
  Default state location is repo-local under .ling-stack/.
  --workspace-state-location user-data-dir stores workspace state under ~/.ling-stack/workspaces/<workspace-id>/ and writes a repo-local pointer config.
  Provider templates are created disabled by default and use secret refs such as env:NAME or keychain:NAME.
`);
}

function printWorkspaceHelp(): void {
  console.log(`Usage:
  ling-stack workspace migrate-state --to user-data-dir [--dry-run]
  ling-stack workspace migrate-state --to repo-local [--dry-run]
  ling-stack workspace repair-registry [--dry-run]
  ling-stack workspace registry repair [--dry-run]

Behavior:
  Explicitly migrates workspace runtime state between repo-local .ling-stack/ and ~/.ling-stack/workspaces/<workspace-id>/.
  --dry-run prints source, target, backup, registry, daemon, and writability preflight checks without copying files or writing manifests.
  The source state root is not removed. The command writes a migration manifest and backups under ~/.ling-stack/state/migrations/.
  Stop the Ling Stack daemon before migrating so SQLite, sessions, artifacts, and logs are copied from a stable state.
  repair-registry updates only ~/.ling-stack/global.sqlite so the current workspace row matches the resolved state root.
`);
}

function printMemoryHelp(): void {
  console.log(`Usage:
  ling-stack memory export [--output memory.md]
  ling-stack memory export --stdout
  ling-stack memory import --file memory.md [--dry-run]

Options:
  --scope-type workspace|channel|teammate|task|run
  --owner-id <id>
  --review-state candidate|active|disabled|archived|rejected
  --sensitivity normal|private|secret-adjacent
  --tag <tag>
  --limit <n>
  --include-secret-adjacent
  --file <memory.md>
  --source-label <label>
  --dry-run

Behavior:
  Exports a read-only Markdown projection from the resolved workspace SQLite database.
  SQL remains authoritative. Secret-adjacent memories are skipped by default; secret-like
  tokens in exported text are redacted.
  Imports parse Ling memory Markdown projections into review candidates only. Import
  never restores active, disabled, archived, rejected, retrieval, or review authority
  fields without a separate review action.
`);
}

function printLocalHelp(command?: string): void {
  if (command === "restart") {
    console.log(`Usage:
  ling restart [--force] [--skip-build] [--timeout 10000] [--web-url http://127.0.0.1:5173]

Behavior:
  Restarts the local Ling Stack daemon and Web UI.
  This is a local development command only; it does not restart remote or production services.
  When launchd services are installed, uses com.lingstack.local.daemon and com.lingstack.local.web.
  Builds local runtime packages before restart unless --skip-build is passed.
  Refuses active work by default; use --force for an explicit operator override.
`);
    return;
  }
  if (command === "status") {
    console.log(`Usage:
  ling status [--timeout 1500] [--web-url http://127.0.0.1:5173]

Behavior:
  Shows local daemon and Web UI manager, PID, URL, log path, and readiness.
`);
    return;
  }
  if (command === "logs") {
    console.log(`Usage:
  ling logs [--service daemon|web|all] [--lines 200]

Behavior:
  Reads local daemon/Web logs from launchd stdout paths when available, with logs/ fallback.
  --follow is not implemented yet.
`);
    return;
  }
  console.log(`Usage:
  ling restart [--force] [--skip-build] [--timeout 10000]
  ling status [--timeout 1500]
  ling logs [--service daemon|web|all] [--lines 200]

Behavior:
  Local-only daemon + Web UI lifecycle commands.
`);
}

function printProviderHelp(): void {
  console.log(`Usage:
  ling-stack provider list
  ling-stack provider add <kind> --name <name> --provider-id <id> --model <model> [options]
  ling-stack provider show <id>
  ling-stack provider check <id>
  ling-stack provider check-all
  ling-stack provider update <id> [options]
  ling-stack provider remove <id>

Kinds:
  openai, anthropic, google, openai-compatible, doubao, deepseek, minimax, glm, jimeng, seedream, seedance

Common options:
  --api <api>                  Default: openai-completions, anthropic-messages for anthropic, google-generative-ai for google
  --provider-transport <mode>  auto|websocket|websocket-cached|sse for openai-codex-responses
  --base-url <url>             Required for openai-compatible
  --api-key-ref env:NAME|keychain:NAME
                               Secret reference; raw API keys are not accepted
  --capability <name>          Repeatable or comma-separated. Default on add: chat,tool_call,reasoning
  --input <text|image>         Repeatable or comma-separated. Default on add: text
  --context-window <n>
  --max-tokens <n>
  --auth-header | --no-auth-header
  --reasoning | --no-reasoning
  --enabled <true|false> | --disabled
  --header KEY=VALUE           Repeatable custom header
  --headers-json <object>      Custom headers as JSON object with string values
  --compat-json <object>       Provider adapter options, including {"webSearch":{"protocol":"responses-web-search"}}

Update-only clear flags:
  --clear-provider-transport --clear-base-url --clear-api-key-ref --clear-auth-header --clear-reasoning --clear-context-window --clear-max-tokens
`);
}

function printChannelHelp(): void {
  console.log(`Usage:
  ling-stack channel list [--limit <n>]
  ling-stack channel create --name <name> [--path <path>] [--provider <providerPresetId>] [--status active|paused|archived] [--write-lock-scope boundPath|channel|workspace] [--max-concurrent-runs <n>] [--tool read --tool grep]
  ling-stack channel show <id>
  ling-stack channel update <id> [--name <name>] [--path <path>|--clear-path] [--provider <id>|--clear-provider] [--status active|paused|archived] [--write-lock-scope boundPath|channel|workspace] [--tool <name>]
  ling-stack channel remove <id>

Default allowed tools on create:
  read, grep, find, ls

Runtime policy flags:
  --read-only-parallel / --no-read-only-parallel
  --queue-on-conflict / --no-queue-on-conflict
`);
}

function printTaskHelp(): void {
  console.log(`Usage:
  ling-stack task list [--channel <id>] [--status todo] [--limit <n>]
  ling-stack task create --channel <id> [--title <title>] --prompt <prompt>
  ling-stack task create --channel <id> --prompt-file <path>
  ling-stack task show <id>
  ling-stack task update <id> [--title <title>] [--prompt <prompt>] [--status done]
  ling-stack task run <id> --provider <providerPresetId> [--skip-preflight]
  ling-stack task remove <id>
`);
}

function printRunHelp(): void {
  console.log(`Usage:
  ling-stack run --provider <providerPresetId> [options] <prompt...>
  ling-stack run --provider <providerPresetId> -
  cat prompt.md | ling-stack run --provider <providerPresetId>

Options:
  --provider <id>              Provider preset id
  --title <text>               Task title
  --task <id>                  Task id to send to daemon
  --prompt <text>              Prompt text
  --prompt-file <path|->       Read prompt text from file or stdin
  --output-last-message <file> Write final assistant message to file
  --tool <name>                Repeatable. Default: read,grep,find,ls
  --thinking <level>           off|minimal|low|medium|high|xhigh. Default: medium
  --system-prompt <text>       Override system prompt
  --append-system-prompt <txt> Repeatable appended system prompt
  --agent-dir <path>           Pi agent directory
  --skip-preflight             Skip provider last-check gate for debugging

Stdin:
  run - and --prompt-file - read stdin as the primary prompt.
  Prompt text plus piped stdin appends stdin as a <stdin> context block.
`);
}

function printCompletionHelp(): void {
  console.log(`Usage:
  ling-stack completion <bash|zsh|fish>

Behavior:
  Prints a static shell completion script to stdout.
  Does not install shell files, edit shell profiles, or call the daemon.
`);
}

function printAutomationsHelp(): void {
  console.log(`Usage:
  ling-stack automations scheduler start
  ling-stack automations scheduler status
  ling-stack automations scheduler stop

Behavior:
  Controls the explicit process-local automation scheduler for the current workspace.
  Start registers enabled scheduled automations; status lists in-memory scheduler state; stop clears timers.
`);
}

function printExternalWorkHelp(): void {
  console.log(`Usage:
  ling-stack external-work github import --channel <channelId> --event-type <eventType> --payload-file <payload.json> [options]
  ling-stack external-work github poll --channel <channelId> [options]
  ling-stack external-work github background start --channel <channelId> [options]
  ling-stack external-work github background list
  ling-stack external-work github background stop <schedulerId>
  ling-stack external-work github ci triage --external-work <externalWorkId> [options]
  ling-stack external-work github ci run --triage <externalWorkCiTriageId> --provider <providerPresetId> [options]
  ling-stack external-work status --channel <channelId> [--workflow-path WORKFLOW.md]
  ling-stack external-work list [--channel <channelId>] [--status ready|blocked|retry_wait|terminal] [--limit 50]
  ling-stack external-work show <externalWorkId>
  ling-stack external-work actions propose-comment --external-work <id> --body-file comment.md [--approval standard|strict]
  ling-stack external-work actions propose-labels --external-work <id> --label name [--label other] [--approval standard|strict]
  ling-stack external-work actions propose-review --external-work <id> --event COMMENT|APPROVE|REQUEST_CHANGES --body-file review.md [--approval strict]
  ling-stack external-work actions list [--external-work <id>] [--status waiting_for_approval]
  ling-stack external-work actions show <actionId>
  ling-stack external-work actions cancel <actionId> [--reason "..."]
  ling-stack external-work actions execute <actionId> [--workflow-path WORKFLOW.md]
  ling-stack external-work reconcile [options]

Options:
  --channel <id>                  Ling channel id that owns the imported workflow
  --event-type <event>            GitHub event type, for example pull_request.opened or issue.opened
  --payload-file <path>           Local GitHub PR or issue payload JSON fixture
  --workflow-path <path>          WORKFLOW.md path resolved and bounded by the daemon
  --workflow-markdown-file <path> Read workflow markdown from a local file and send it inline
  --limit <n>                     Poll at most n GitHub candidates, max 100
  --no-run-immediately            Register background scheduler without an immediate first tick
  --no-create-task                CI triage writes records/artifacts without creating a local fix task
  --provider <id>                 Provider preset for an explicit local CI fix run
  --skip-preflight                Skip provider last-check gate for debugging local CI fix runs
  --execute-hooks                 Run afterCreate/beforeRun hooks inside isolated workspaces
  --status <status>               Filter external-work list by scheduler status
  --source-kind <kind>            Filter external-work list by source kind
  --work-item-kind <kind>         Filter external-work list by item kind
  --approval <standard|strict>    Approval requirement for a proposed external action
  --body-file <path>              Markdown body for a proposed GitHub comment
  --label <name>                  Label to propose adding; repeatable

Behavior:
  Import creates or reuses local Ling workflow records from local fixtures.
  Poll uses read-only GitHub API calls for PR and issue discovery.
  Background start registers a process-local GitHub poll/reconcile timer for one cwd, channel, and workflow.
  Background list/stop inspect or stop that local timer; they do not call GitHub.
  CI triage reads GitHub checks/actions logs for an existing PR external work item and creates local evidence/tasks.
  CI run starts an explicit local fix run for a triage record through the normal task/run path.
  List and show read local workflow, scheduler, workspace, and artifact state.
  Action propose/list/show/cancel manages local proposed actions and approvals only.
  Action execute requires an approved action, revalidates the GitHub target, then only
  calls the approved GitHub comment, label, or PR review endpoint.
  Reconcile repairs local scheduler state and can optionally check remote terminal state.
  Import, poll, background start/list/stop, triage, list, show, action propose/cancel, and reconcile do not start a runner.
  Only ci run starts a local runner. Only action execute can mutate GitHub.
`);
}

function printDoctorHelp(): void {
  console.log(`Usage:
  ling-stack doctor [--json]
  ling-stack doctor config [--json]

Checks:
  daemon health, providers, provider preflight, channels, tasks, and approval policy.
  doctor config audits resolved Ling project state and flags scattered Ling state.

Exit codes:
  0 ready
  3 daemon unreachable
  4 workspace not ready
`);
}

function printPolicyHelp(): void {
  console.log(`Usage:
  ling-stack policy show
  ling-stack policy set --tool bash=ask --tool write=deny
  ling-stack policy set --write-path . --write-path docs
  ling-stack policy reset

Options:
  --tool <tool=decision>        Repeatable or comma-separated. Tools: ${[...VALID_TOOLS].join(", ")}
  --write-path <path>           Repeatable or comma-separated. Relative paths resolve from the run cwd.

Decisions:
  allow, ask, deny
`);
}

function printApprovalsHelp(): void {
  console.log(`Usage:
  ling-stack approvals list [--status pending] [--run-id <id>] [--media-job-id <id>] [--limit <n>]
  ling-stack approvals show <id>
  ling-stack approvals approve <id> [--reason <text>]
  ling-stack approvals deny <id> [--reason <text>]
`);
}

function printRunsHelp(): void {
  console.log(`Usage:
  ling-stack runs list [--status succeeded] [--limit <n>]
  ling-stack runs show <id>
  ling-stack runs events <id> [--after-seq <n>] [--limit <n>]
  ling-stack runs shell-snapshots <run-id> [--tool-call <id>]
  ling-stack runs shell-snapshot <run-id> <snapshot-id>
  ling-stack runs cancel <id>
`);
}

function printUiHelp(): void {
  console.log(`Usage:
  ling-stack ui
  ling-stack ui --open
  ling-stack ui --foreground [--open] [--host 127.0.0.1] [--port 5173]

Behavior:
  Without --foreground, checks Web UI and daemon status and prints the next command.
  With --foreground, starts the Vite Web UI in this terminal and injects VITE_LING_STACK_DAEMON_URL.
  The current --cwd is also injected as VITE_LING_STACK_DEFAULT_WORKSPACE_CWD for first-run Web defaults.
`);
}

function printDaemonHelp(_subcommand?: string): void {
  console.log(`Usage:
  ling-stack daemon status
  ling-stack daemon start [--host 127.0.0.1] [--port 17891] [--timeout 5000]
  ling-stack daemon start --foreground [--host 127.0.0.1] [--port 17891]
  ling-stack daemon stop [--force] [--timeout 5000]
  ling-stack daemon restart [--force] [--host 127.0.0.1] [--port 17891] [--timeout 5000]
  ling-stack daemon logs [--lines 200]

Notes:
  Without --host/--port, start uses --daemon-url, LING_STACK_DAEMON_URL, or LING_STACK_HOST/LING_STACK_PORT.
  The current --cwd is passed to the daemon as LING_STACK_DEFAULT_WORKSPACE_CWD for first-run Web defaults.
  Background lifecycle state is stored under .ling-stack/daemon and logs under .ling-stack/logs.
  stop and restart refuse active work by default; use --force for explicit operator override.
`);
}
