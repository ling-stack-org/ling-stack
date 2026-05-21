#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import {
  approvalToolDecisions,
  createSqliteRunStore,
  defaultAllowedWritePaths,
  defaultApprovalToolDecisions,
  defaultProviderTemplates,
  resolveRuntimePaths,
  type ApprovalToolDecision,
  type ProviderCheckResult,
  type ProviderPreset,
  type ProviderPresetInput,
  type RunTool,
} from "@ling-stack/core";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "17891";
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const VALID_TOOLS: ReadonlySet<string> = new Set(Object.keys(defaultApprovalToolDecisions) as RunTool[]);
const VALID_POLICY_DECISIONS: ReadonlySet<string> = new Set(approvalToolDecisions);
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);
const VALID_PROVIDER_KINDS = new Set(["openai", "anthropic", "openai-compatible", "doubao", "deepseek", "minimax", "glm", "jimeng", "seedream", "seedance"]);
const VALID_PROVIDER_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai", "mistral-conversations", "media-job"]);
const VALID_PROVIDER_CAPABILITIES = new Set(["chat", "tool_call", "reasoning", "vision", "embedding", "image_generate", "image_edit", "video_generate", "tts", "asr"]);
const VALID_PROVIDER_INPUTS = new Set(["text", "image"]);

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

interface SseBlock {
  readonly event: string;
  readonly data: string;
}

interface RunEventEnvelope {
  readonly id: string;
  readonly runId: string;
  readonly seq: number;
  readonly ts: string;
  readonly type: string;
  readonly data: unknown;
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

interface InitResult {
  readonly cwd: string;
  readonly rootDir: string;
  readonly databasePath: string;
  readonly sessionsDir: string;
  readonly artifactsDir: string;
  readonly logsDir: string;
  readonly piDir: string;
  readonly configPath: string;
  readonly createdProviders: readonly ProviderPreset[];
  readonly skippedProviders: readonly ProviderPreset[];
}

interface DaemonListenOptions {
  readonly host: string;
  readonly port: number;
}

interface UiOptions {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  readonly open: boolean;
  readonly foreground: boolean;
}

class CliError extends Error {
  readonly exitCode: number;
  readonly code: string;
  readonly status?: number;

  constructor(exitCode: number, code: string, message: string, status?: number) {
    super(message);
    this.name = "CliError";
    this.exitCode = exitCode;
    this.code = code;
    this.status = status;
  }
}

class RunPrinter {
  private textOpen = false;
  private runFailed = false;
  private approvalDenied = false;

  constructor(private readonly options: GlobalOptions) {}

  printReady(runId: string): void {
    if (this.options.json) {
      console.log(JSON.stringify({ type: "ready", runId }));
      return;
    }
    console.log(`Run: ${runId}`);
  }

  printEvent(envelope: RunEventEnvelope): void {
    if (this.options.json) {
      console.log(JSON.stringify(envelope));
      this.updateExitState(envelope);
      return;
    }

    switch (envelope.type) {
      case "run_created":
        if (this.options.verbose) {
          this.line(`Run created: ${envelope.runId}`);
        }
        break;
      case "run_start":
        this.printRunStart(envelope.data);
        break;
      case "assistant_text_delta":
        this.writeTextDelta(envelope.data);
        break;
      case "assistant_thinking_delta":
        if (this.options.verbose) {
          this.line(`[thinking] ${readString(envelope.data, "text") ?? summarizeUnknown(envelope.data, 180)}`);
        }
        break;
      case "message_end":
        this.closeText();
        break;
      case "tool_start":
        this.printToolStart(envelope.data);
        break;
      case "tool_update":
        if (this.options.verbose) {
          this.line(`Tool update: ${summarizeToolName(envelope.data)} ${summarizeUnknown(readField(envelope.data, "partialResult"), 180)}`);
        }
        break;
      case "tool_end":
        this.printToolEnd(envelope.data);
        break;
      case "approval_requested":
        this.printApprovalRequested(envelope.data);
        break;
      case "approval_approved":
        this.line(`Approval approved: ${readString(envelope.data, "approvalId") ?? "<unknown>"}`);
        break;
      case "approval_denied":
        this.line(`Approval denied: ${readString(envelope.data, "approvalId") ?? "<unknown>"}`);
        break;
      case "run_error":
        this.line(`Run failed: ${readString(envelope.data, "message") ?? summarizeUnknown(envelope.data, 240)}`);
        break;
      case "run_end":
        this.line(`Run ended: ${readString(envelope.data, "taskId") ?? envelope.runId}`);
        break;
      case "result":
        this.line(`Result: ${summarizeResult(envelope.data)}`);
        break;
      default:
        if (this.options.verbose) {
          this.line(`${envelope.type}: ${summarizeUnknown(envelope.data, 240)}`);
        }
    }

    this.updateExitState(envelope);
  }

  finish(): void {
    this.closeText();
  }

  exitCode(): number {
    if (this.approvalDenied) {
      return 5;
    }
    if (this.runFailed) {
      return 6;
    }
    return 0;
  }

  private updateExitState(envelope: RunEventEnvelope): void {
    if (envelope.type === "run_error") {
      this.runFailed = true;
    }
    if (envelope.type === "approval_denied") {
      this.approvalDenied = true;
    }
  }

  private printRunStart(data: unknown): void {
    const provider = readString(data, "provider");
    const model = readString(data, "model");
    const cwd = readString(data, "cwd");
    const suffix = [provider, model].filter(Boolean).join("/");
    this.line(`Started${suffix ? `: ${suffix}` : ""}${cwd ? ` (${cwd})` : ""}`);
  }

  private writeTextDelta(data: unknown): void {
    const text = readString(data, "text");
    if (!text) {
      return;
    }
    process.stdout.write(text);
    this.textOpen = true;
  }

  private printToolStart(data: unknown): void {
    const toolName = summarizeToolName(data);
    const args = readField(data, "args");
    this.line(`Tool start: ${toolName}${args === undefined ? "" : ` ${summarizeUnknown(args, 180)}`}`);
  }

  private printToolEnd(data: unknown): void {
    const toolName = summarizeToolName(data);
    const isError = readBoolean(data, "isError") ?? false;
    const result = readField(data, "result");
    this.line(`Tool end: ${toolName} ${isError ? "error" : "ok"}${result === undefined ? "" : ` ${summarizeUnknown(result, 180)}`}`);
  }

  private printApprovalRequested(data: unknown): void {
    const approvalId = readString(data, "approvalId") ?? "<unknown>";
    const actionType = readString(data, "actionType") ?? "action";
    const risk = readString(data, "risk") ?? "unknown";
    const title = readString(data, "title") ?? "Approval requested";
    const description = readString(data, "description");
    const payload = readField(data, "payload");

    this.line("");
    console.log("Approval requested");
    console.log(`  ID: ${approvalId}`);
    console.log(`  Action: ${actionType}`);
    console.log(`  Risk: ${risk}`);
    console.log(`  Title: ${title}`);
    if (description) {
      console.log(`  Description: ${description}`);
    }
    const payloadSummary = summarizeApprovalPayload(payload);
    if (payloadSummary) {
      console.log(`  Payload: ${payloadSummary}`);
    }
    console.log("  Approve:");
    console.log(`    ling-stack --daemon-url ${shellQuote(this.options.daemonUrl)} --cwd ${shellQuote(this.options.cwd)} approvals approve ${shellQuote(approvalId)}`);
    console.log("  Deny:");
    console.log(`    ling-stack --daemon-url ${shellQuote(this.options.daemonUrl)} --cwd ${shellQuote(this.options.cwd)} approvals deny ${shellQuote(approvalId)}`);
  }

  private line(value: string): void {
    this.closeText();
    if (value.length > 0) {
      console.log(value);
    } else {
      console.log();
    }
  }

  private closeText(): void {
    if (this.textOpen) {
      process.stdout.write("\n");
      this.textOpen = false;
    }
  }
}

async function main(): Promise<void> {
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
      assertNoPositionals(rest, "doctor");
      return await handleDoctor(parsed.options);
    case "daemon":
      return await handleDaemon(rest, parsed.options);
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
    case "ui":
      return await handleUi(rest, parsed.options);
    default:
      throw new CliError(2, "unknown_command", `Unknown command: ${command}`);
  }
}

async function handleInit(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    booleanFlags: new Set(["with-provider-templates", "no-provider-templates"]),
  });
  assertNoPositionals(parsed.positionals, "init");
  const withProviderTemplates = readProviderTemplatesFlag(parsed);
  const result = await initWorkspace(options.cwd, withProviderTemplates);

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
      createdProviderIds: result.createdProviders.map((provider) => provider.id),
      skippedProviderIds: result.skippedProviders.map((provider) => provider.id),
    });
    return 0;
  }

  console.log(`Initialized Ling Stack at ${result.rootDir}`);
  console.log(`Database: ${result.databasePath}`);
  console.log(`Config: ${result.configPath}`);
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

async function handleDoctor(options: GlobalOptions): Promise<number> {
  const startedAt = Date.now();
  const health = await requestJson(options, "GET", "/health");
  const elapsedMs = Date.now() - startedAt;
  if (options.json) {
    printJson({ ok: true, daemonUrl: options.daemonUrl, elapsedMs, health });
    return 0;
  }

  console.log("Daemon: ok");
  console.log(`URL: ${options.daemonUrl}`);
  console.log(`Service: ${readString(health, "service") ?? "unknown"}`);
  console.log(`Latency: ${elapsedMs}ms`);
  return 0;
}

async function handleDaemon(args: readonly string[], options: GlobalOptions): Promise<number> {
  const [subcommand = "status", ...rest] = args;
  if (subcommand === "status") {
    assertNoPositionals(rest, "daemon status");
    return await handleDoctor(options);
  }
  if (subcommand === "start") {
    return await handleDaemonStart(rest, options);
  }
  if (subcommand === "stop") {
    throw new CliError(2, "not_implemented", "daemon stop is not implemented yet. Stop the foreground daemon with Ctrl-C.");
  }
  throw new CliError(2, "unknown_command", `Unknown daemon command: ${subcommand}`);
}

async function handleDaemonStart(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["host", "port"]),
    booleanFlags: new Set(["foreground"]),
  });
  assertNoPositionals(parsed.positionals, "daemon start");
  if (!parsed.booleans.has("foreground")) {
    throw new CliError(2, "not_implemented", "Background daemon start is not implemented yet. Use: ling-stack daemon start --foreground");
  }
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
    return await runWebForeground(uiOptions, options.daemonUrl);
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

async function handleRun(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["provider", "title", "task", "thinking", "system-prompt", "agent-dir", "prompt", "prompt-file"]),
    repeatableFlags: new Set(["tool", "append-system-prompt"]),
    booleanFlags: new Set(["skip-preflight"]),
  });

  const providerPresetId = getFlag(parsed, "provider");
  if (!providerPresetId) {
    throw new CliError(2, "missing_provider", "ling-stack run requires --provider <providerPresetId> for CLI v0.1.");
  }

  const prompt = await readPrompt(parsed);
  if (!prompt) {
    throw new CliError(2, "missing_prompt", "ling-stack run requires prompt text, --prompt <text>, or --prompt-file <path>.");
  }

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

  const printer = new RunPrinter(options);
  await streamRun(options, body, printer);
  printer.finish();
  return printer.exitCode();
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
    boundPath: getFlag(parsed, "path") ?? options.cwd,
    defaultProviderPresetId: getFlag(parsed, "provider"),
    defaultTeammateId: getFlag(parsed, "teammate"),
    allowedTools: readChannelTools(parsed),
  });
  const response = await requestJson(options, "POST", "/channels", { cwd: options.cwd }, body);
  if (options.json) {
    printJson(response);
    return 0;
  }
  const channel = readField(response, "channel");
  console.log(`Channel created: ${readString(channel, "id") ?? ""}`);
  console.log(`Name: ${readString(channel, "name") ?? ""}`);
  console.log(`Path: ${readString(channel, "boundPath") ?? ""}`);
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
    boundPath: readNullableFlag(parsed, "path", parsed.booleans.has("clear-path")),
    defaultProviderPresetId: readNullableFlag(parsed, "provider", parsed.booleans.has("clear-provider")),
    defaultTeammateId: readNullableFlag(parsed, "teammate", parsed.booleans.has("clear-teammate")),
    allowedTools: readChannelTools(parsed),
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
  const printer = new RunPrinter(options);
  await streamRun(options, body, printer);
  printer.finish();
  return printer.exitCode();
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
    stringFlags: new Set(["status", "run-id", "limit"]),
  });
  assertNoPositionals(parsed.positionals, "approvals list");
  const response = await requestJson(options, "GET", "/approvals", {
    cwd: options.cwd,
    status: getFlag(parsed, "status"),
    runId: getFlag(parsed, "run-id"),
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

async function initWorkspace(cwd: string, withProviderTemplates: boolean): Promise<InitResult> {
  const paths = resolveRuntimePaths(cwd);
  const logsDir = join(paths.rootDir, "logs");
  await mkdir(paths.rootDir, { recursive: true });
  await mkdir(paths.sessionsDir, { recursive: true });
  await mkdir(paths.artifactsDir, { recursive: true });
  await mkdir(logsDir, { recursive: true });
  await mkdir(paths.piDir, { recursive: true });
  await writeDefaultConfig(paths.rootDir);

  const store = createSqliteRunStore(cwd);
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

  return {
    cwd,
    rootDir: paths.rootDir,
    databasePath: paths.databasePath,
    sessionsDir: paths.sessionsDir,
    artifactsDir: paths.artifactsDir,
    logsDir,
    piDir: paths.piDir,
    configPath: join(paths.rootDir, "config.json"),
    createdProviders,
    skippedProviders,
  };
}

async function writeDefaultConfig(rootDir: string): Promise<void> {
  const configPath = join(rootDir, "config.json");
  const config = {
    schemaVersion: 1,
    product: "ling-stack",
    providerTemplates: "sqlite",
    secrets: "env",
    createdBy: "ling-stack init",
  };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { flag: "wx" }).catch((error: unknown) => {
    if (isNodeError(error) && error.code === "EEXIST") {
      return;
    }
    throw error;
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
  return { host, port };
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

async function runWebForeground(options: UiOptions, daemonUrl: string): Promise<number> {
  const webDir = resolveWebPackageDir();
  const viteCliPath = resolveViteCliPath(webDir);
  const child = spawn(process.execPath, [viteCliPath, "--host", options.host, "--port", String(options.port), "--strictPort"], {
    cwd: webDir,
    env: {
      ...process.env,
      VITE_LING_STACK_DAEMON_URL: daemonUrl,
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

async function streamRun(options: GlobalOptions, body: unknown, printer: RunPrinter): Promise<void> {
  const url = buildUrl(options.daemonUrl, "/runs");
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
      handleSseBlock(block, printer);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim().length > 0) {
    handleSseBlock(buffer, printer);
  }
}

function handleSseBlock(block: string, printer: RunPrinter): void {
  const parsed = parseSseBlock(block);
  if (!parsed) {
    return;
  }
  const data = parseJson(parsed.data, `Invalid SSE JSON for event ${parsed.event}`);
  if (parsed.event === "ready") {
    const runId = readString(data, "runId");
    if (!runId) {
      throw new CliError(4, "bad_sse_event", "ready event did not include runId");
    }
    printer.printReady(runId);
    return;
  }
  if (!isRunEventEnvelope(data)) {
    throw new CliError(4, "bad_sse_event", `SSE event ${parsed.event} did not contain a run event envelope`);
  }
  printer.printEvent(data);
}

function parseSseBlock(block: string): SseBlock | undefined {
  const lines = block.split("\n");
  let event = "message";
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith(":")) {
      continue;
    }
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      dataLines.push(line.slice("data:".length).trimStart());
    }
  }

  if (dataLines.length === 0) {
    return undefined;
  }
  return { event, data: dataLines.join("\n") };
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
        ? ["clear-base-url", "clear-api-key-ref", "clear-auth-header", "clear-reasoning", "clear-context-window", "clear-max-tokens"]
        : []),
    ]),
  };
}

function channelCommandParserSpec(options: { readonly includeClearFlags?: boolean } = {}): CommandParserSpec {
  return {
    stringFlags: new Set(["name", "path", "provider", "teammate"]),
    repeatableFlags: new Set(["tool"]),
    booleanFlags: new Set([
      ...(options.includeClearFlags ? ["clear-path", "clear-provider", "clear-teammate"] : []),
    ]),
  };
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
    ["ID", "Kind", "Name", "Provider", "Model", "API", "Enabled", "Secret", "Check"],
    providers.map((provider) => [
      truncate(readString(provider, "id") ?? "", 32),
      truncate(readString(provider, "kind") ?? "", 18),
      truncate(readString(provider, "displayName") ?? "", 24),
      truncate(readString(provider, "providerId") ?? "", 18),
      truncate(readString(provider, "model") ?? "", 20),
      truncate(readString(provider, "api") ?? "", 20),
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
    return `${displayName}: missing ${envNameFromRef(readString(provider, "apiKeyRef") ?? "")}.`;
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
  return ref.startsWith("env:") ? ref.slice("env:".length) : ref;
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
    ["ID", "Name", "Path", "Provider", "Tools", "Updated"],
    channels.map((channel) => [
      truncate(readString(channel, "id") ?? "", 32),
      truncate(readString(channel, "name") ?? "", 24),
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
  console.log(`Created: ${readString(channel, "createdAt") ?? ""}`);
  console.log(`Updated: ${readString(channel, "updatedAt") ?? ""}`);
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
    ["ID", "Status", "Risk", "Action", "Run", "Title", "Created"],
    approvals.map((approval) => [
      truncate(readString(approval, "id") ?? "", 32),
      readString(approval, "status") ?? "",
      readString(approval, "risk") ?? "",
      readString(approval, "actionType") ?? "",
      truncate(readString(approval, "runId") ?? "", 18),
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
      return `${summarizeToolName(event.data)} ${readBoolean(event.data, "isError") ? "error" : "ok"} ${summarizeUnknown(readField(event.data, "result"), 80)}`;
    case "approval_requested":
      return `${readString(event.data, "approvalId") ?? ""} ${readString(event.data, "actionType") ?? ""} ${readString(event.data, "risk") ?? ""}`;
    case "approval_approved":
    case "approval_denied":
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

    if (event.type === "approval_approved" || event.type === "approval_denied") {
      const approvalId = readString(event.data, "approvalId");
      if (!approvalId) {
        continue;
      }
      const current = approvals.get(approvalId);
      approvals.set(approvalId, {
        id: approvalId,
        status: readString(event.data, "status") ?? (event.type === "approval_approved" ? "approved" : "denied"),
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
    return `${readString(payload, "path") ?? "<unknown>"} (${readNumber(payload, "bytes") ?? 0} bytes)`;
  }
  if (type === "file_edit") {
    return `${readString(payload, "path") ?? "<unknown>"} ${truncate(readString(payload, "diffPreview") ?? "", 120)}`;
  }
  return summarizeUnknown(payload, 180);
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
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
  if (command === "daemon") {
    printDaemonHelp(subcommand);
    return;
  }
  if (command === "ui") {
    printUiHelp();
    return;
  }
  printHelp();
}

function printHelp(): void {
  console.log(`Ling Stack CLI

Usage:
  ling-stack [global options] init
  ling-stack [global options] doctor
  ling-stack [global options] daemon status
  ling-stack [global options] daemon start --foreground
  ling-stack [global options] provider list
  ling-stack [global options] provider add <kind> --name <name> --provider-id <id> --model <model>
  ling-stack [global options] provider show <id>
  ling-stack [global options] provider check <id>
  ling-stack [global options] provider check-all
  ling-stack [global options] provider update <id> [options]
  ling-stack [global options] provider remove <id>
  ling-stack [global options] channel list
  ling-stack [global options] channel create --name <name> [--path <path>]
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
  ling-stack [global options] approvals list
  ling-stack [global options] approvals show <id>
  ling-stack [global options] approvals approve <id>
  ling-stack [global options] approvals deny <id>
  ling-stack [global options] ui

Global options:
  --daemon-url <url>   Default: LING_STACK_DAEMON_URL or http://127.0.0.1:17891
  --cwd <path>         Workspace path. Default: current directory
  --json               Print machine-readable output
  --verbose            Print extra event detail
  --no-color           Reserved for stable non-colored output
  --help, -h           Show help

Planned commands:
  daemon stop, background daemon start
`);
}

function printInitHelp(): void {
  console.log(`Usage:
  ling-stack init
  ling-stack init --cwd /path/to/project
  ling-stack init --no-provider-templates

Behavior:
  Creates .ling-stack/, SQLite runtime state, sessions/, artifacts/, logs/, pi/, and config.json.
  Provider templates are created disabled by default and use env: secret references only.
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
  openai, anthropic, openai-compatible, doubao, deepseek, minimax, glm, jimeng, seedream, seedance

Common options:
  --api <api>                  Default: openai-completions, anthropic-messages for anthropic
  --base-url <url>             Required for openai-compatible
  --api-key-ref env:NAME       Secret reference; raw API keys are not accepted
  --capability <name>          Repeatable or comma-separated. Default on add: chat,tool_call,reasoning
  --input <text|image>         Repeatable or comma-separated. Default on add: text
  --context-window <n>
  --max-tokens <n>
  --auth-header | --no-auth-header
  --reasoning | --no-reasoning
  --enabled <true|false> | --disabled
  --header KEY=VALUE           Repeatable custom header
  --headers-json <object>      Custom headers as JSON object with string values
  --compat-json <object>       OpenAI-compatible adapter options

Update-only clear flags:
  --clear-base-url --clear-api-key-ref --clear-auth-header --clear-reasoning --clear-context-window --clear-max-tokens
`);
}

function printChannelHelp(): void {
  console.log(`Usage:
  ling-stack channel list [--limit <n>]
  ling-stack channel create --name <name> [--path <path>] [--provider <providerPresetId>] [--tool read --tool grep]
  ling-stack channel show <id>
  ling-stack channel update <id> [--name <name>] [--path <path>|--clear-path] [--provider <id>|--clear-provider] [--tool <name>]
  ling-stack channel remove <id>

Default allowed tools on create:
  read, grep, find, ls
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

Options:
  --provider <id>              Provider preset id
  --title <text>               Task title
  --task <id>                  Task id to send to daemon
  --prompt <text>              Prompt text
  --prompt-file <path>         Read prompt text from file
  --tool <name>                Repeatable. Default: read,grep,find,ls
  --thinking <level>           off|minimal|low|medium|high|xhigh. Default: medium
  --system-prompt <text>       Override system prompt
  --append-system-prompt <txt> Repeatable appended system prompt
  --agent-dir <path>           Pi agent directory
  --skip-preflight             Skip provider last-check gate for debugging
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
  ling-stack approvals list [--status pending] [--run-id <id>] [--limit <n>]
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
`);
}

function printDaemonHelp(_subcommand?: string): void {
  console.log(`Usage:
  ling-stack daemon status
  ling-stack daemon start --foreground [--host 127.0.0.1] [--port 17891]

Not implemented yet:
  ling-stack daemon start without --foreground
  ling-stack daemon stop

Notes:
  Without --host/--port, start uses --daemon-url, LING_STACK_DAEMON_URL, or LING_STACK_HOST/LING_STACK_PORT.
  Background process management is not implemented yet; use --foreground and stop with Ctrl-C.
`);
}

void main();
