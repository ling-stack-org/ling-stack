#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import process from "node:process";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = "17891";
const DEFAULT_TOOLS = ["read", "grep", "find", "ls"] as const;
const VALID_TOOLS = new Set(["read", "grep", "find", "ls", "bash", "edit", "write"]);
const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh"]);

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
    case "doctor":
      assertNoPositionals(rest, "doctor");
      return await handleDoctor(parsed.options);
    case "daemon":
      return await handleDaemon(rest, parsed.options);
    case "run":
      return await handleRun(rest, parsed.options);
    case "approvals":
      return await handleApprovals(rest, parsed.options);
    case "runs":
      return await handleRuns(rest, parsed.options);
    case "init":
    case "provider":
    case "channel":
    case "task":
    case "ui":
      throw new CliError(2, "not_implemented", `${command} is planned but not implemented in CLI v0.1 yet.`);
    default:
      throw new CliError(2, "unknown_command", `Unknown command: ${command}`);
  }
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
    throw new CliError(2, "not_implemented", "daemon start is not implemented in CLI v0.1 yet. Run: corepack pnpm --filter @ling-stack/daemon build && node packages/daemon/dist/cli.js");
  }
  if (subcommand === "stop") {
    throw new CliError(2, "not_implemented", "daemon stop is not implemented yet. Stop the foreground daemon with Ctrl-C.");
  }
  throw new CliError(2, "unknown_command", `Unknown daemon command: ${subcommand}`);
}

async function handleRun(args: readonly string[], options: GlobalOptions): Promise<number> {
  const parsed = parseCommandArgs(args, {
    stringFlags: new Set(["provider", "title", "task", "thinking", "system-prompt", "agent-dir", "prompt", "prompt-file"]),
    repeatableFlags: new Set(["tool", "append-system-prompt"]),
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

  const body = removeUndefined({
    cwd: options.cwd,
    providerPresetId,
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
  printRunDetail(response);
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

async function requestJson(
  options: GlobalOptions,
  method: "GET" | "POST",
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

async function readPrompt(parsed: ParsedCommandArgs): Promise<string> {
  const promptParts: string[] = [];
  const promptFile = getFlag(parsed, "prompt-file");
  if (promptFile) {
    promptParts.push(await readFile(resolve(promptFile), "utf8"));
  }
  const promptFlag = getFlag(parsed, "prompt");
  if (promptFlag) {
    promptParts.push(promptFlag);
  }
  if (parsed.positionals.length > 0) {
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

function printRunDetail(run: unknown): void {
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
  if (command === "run") {
    printRunHelp();
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
  printHelp();
}

function printHelp(): void {
  console.log(`Ling Stack CLI

Usage:
  ling-stack [global options] doctor
  ling-stack [global options] daemon status
  ling-stack [global options] run --provider <providerPresetId> [options] <prompt...>
  ling-stack [global options] runs list
  ling-stack [global options] runs show <id>
  ling-stack [global options] runs events <id>
  ling-stack [global options] approvals list
  ling-stack [global options] approvals show <id>
  ling-stack [global options] approvals approve <id>
  ling-stack [global options] approvals deny <id>

Global options:
  --daemon-url <url>   Default: LING_STACK_DAEMON_URL or http://127.0.0.1:17891
  --cwd <path>         Workspace path. Default: current directory
  --json               Print machine-readable output
  --verbose            Print extra event detail
  --no-color           Reserved for stable non-colored output
  --help, -h           Show help

Planned commands:
  init, provider, channel, task, ui, daemon start, daemon stop
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
`);
}

function printDaemonHelp(_subcommand?: string): void {
  console.log(`Usage:
  ling-stack daemon status

Not implemented yet:
  ling-stack daemon start
  ling-stack daemon stop
`);
}

void main();
