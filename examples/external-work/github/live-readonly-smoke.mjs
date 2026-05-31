#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliPath = resolve(repoRoot, "packages/cli/dist/index.js");

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

const repository = args.repo ?? "openclaw/openclaw";
const limit = Number.parseInt(args.limit ?? "1", 10);
const port = Number.parseInt(args.port ?? "17991", 10);

if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) {
  fail("--repo must use owner/name format.");
}
if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
  fail("--limit must be an integer from 1 to 100.");
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  fail("--port must be a valid TCP port.");
}

await assertBuiltCli();

const workspace = await mkdtemp(resolve(tmpdir(), "ling-stack-external-work-live-"));
const daemonUrl = `http://127.0.0.1:${port}`;
const workflowPath = resolve(workspace, "WORKFLOW.md");

await writeFile(workflowPath, renderWorkflow(repository, Boolean(process.env.GITHUB_TOKEN)), "utf8");

let daemon;
let shuttingDown = false;

try {
  log(`Workspace: ${workspace}`);
  log(`Repository: ${repository}`);
  log(`Daemon URL: ${daemonUrl}`);
  log(process.env.GITHUB_TOKEN ? "GitHub token: using env:GITHUB_TOKEN for read-only API calls." : "GitHub token: not set; public unauthenticated API limits apply.");

  runCli(["init", "--no-provider-templates"], { workspace });
  await assertPortFree(daemonUrl);

  daemon = spawn(process.execPath, [
    cliPath,
    "--cwd",
    workspace,
    "daemon",
    "start",
    "--foreground",
    "--host",
    "127.0.0.1",
    "--port",
    String(port),
  ], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const daemonOutput = [];
  daemon.stdout.on("data", (chunk) => daemonOutput.push(String(chunk)));
  daemon.stderr.on("data", (chunk) => daemonOutput.push(String(chunk)));
  daemon.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    if (code !== null && code !== 0) {
      console.error(`Daemon exited with code ${code}.`);
    } else if (signal) {
      console.error(`Daemon exited with signal ${signal}.`);
    }
  });

  await waitForHealth(daemonUrl, daemonOutput);

  const channelResponse = runCliJson([
    "--json",
    "channel",
    "create",
    "--name",
    "GitHub Live Smoke",
    "--path",
    workspace,
  ], { workspace, daemonUrl });
  const channelId = channelResponse?.channel?.id;
  if (!channelId) {
    throw new Error("channel create did not return channel.id.");
  }
  log(`Channel: ${channelId}`);

  const pollResponse = runCliJson([
    "--json",
    "external-work",
    "github",
    "poll",
    "--channel",
    channelId,
    "--workflow-path",
    "WORKFLOW.md",
    "--limit",
    String(limit),
  ], { workspace, daemonUrl });
  log(`Poll: candidates=${pollResponse.candidates ?? 0}, claimed=${pollResponse.claimed ?? 0}, duplicates=${pollResponse.duplicates ?? 0}, blocked=${pollResponse.blocked ?? 0}`);

  const listResponse = runCliJson([
    "--json",
    "external-work",
    "list",
    "--channel",
    channelId,
    "--status",
    "ready",
    "--limit",
    "1",
  ], { workspace, daemonUrl });
  const externalWorkView = listResponse?.externalWork?.[0];
  const externalWorkId = externalWorkView?.externalWork?.id;
  if (!externalWorkId) {
    throw new Error("No ready external work was created. Use a repository with at least one open PR or issue, or raise --limit.");
  }
  log(`External work: ${externalWorkId} (${externalWorkView.externalWork.identifier})`);

  const commentPath = resolve(workspace, "proposed-comment.md");
  await writeFile(
    commentPath,
    [
      "Ling Stack live read-only smoke proposal.",
      "",
      "This local proposed action proves approval records and artifacts can be created.",
      "The smoke script cancels it and never calls GitHub mutation APIs.",
      "",
    ].join("\n"),
    "utf8",
  );

  const proposal = runCliJson([
    "--json",
    "external-work",
    "actions",
    "propose-comment",
    "--external-work",
    externalWorkId,
    "--body-file",
    commentPath,
    "--approval",
    "standard",
  ], { workspace, daemonUrl });
  const actionId = proposal?.action?.id;
  const approvalId = proposal?.approval?.id ?? proposal?.action?.approvalId;
  if (!actionId || !approvalId) {
    throw new Error("propose-comment did not return action.id and approval.id.");
  }
  log(`Proposed action: ${actionId}`);
  log(`Approval: ${approvalId}`);

  const cancel = runCliJson([
    "--json",
    "external-work",
    "actions",
    "cancel",
    actionId,
    "--reason",
    "Live read-only smoke cleanup",
  ], { workspace, daemonUrl });
  log(`Cancel: ${cancel?.action?.status ?? "unknown"}`);

  const reconcile = runCliJson([
    "--json",
    "external-work",
    "reconcile",
    "--channel",
    channelId,
    "--workflow-path",
    "WORKFLOW.md",
  ], { workspace, daemonUrl });
  log(`Reconcile: terminal=${reconcile.terminal ?? 0}, retryReady=${reconcile.retryReady ?? 0}, blocked=${reconcile.blocked ?? 0}`);

  const runs = runCliJson(["--json", "runs", "list"], { workspace, daemonUrl });
  const runCount = Array.isArray(runs?.runs) ? runs.runs.length : 0;
  if (runCount !== 0) {
    throw new Error(`Expected no runner starts, but runs list returned ${runCount} run(s).`);
  }
  log("Runs: 0 (external work smoke did not start the runner).");

  log("");
  log("PASS: live read-only external work smoke completed.");
  log(`Inspect artifacts under: ${resolve(workspace, ".ling-stack/artifacts")}`);
} finally {
  if (daemon && !daemon.killed) {
    shuttingDown = true;
    daemon.kill("SIGTERM");
  }
}

function parseArgs(rawArgs) {
  const parsed = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
      continue;
    }
    if (arg === "--repo" || arg === "--port" || arg === "--limit") {
      const value = rawArgs[index + 1];
      if (!value) {
        fail(`${arg} requires a value.`);
      }
      parsed[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--repo=")) {
      parsed.repo = arg.slice("--repo=".length);
      continue;
    }
    if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
      continue;
    }
    if (arg.startsWith("--limit=")) {
      parsed.limit = arg.slice("--limit=".length);
      continue;
    }
    fail(`Unknown option: ${arg}`);
  }
  return parsed;
}

async function assertBuiltCli() {
  try {
    await access(cliPath);
  } catch {
    fail(`Built CLI not found at ${cliPath}. Run: corepack pnpm build`);
  }
}

function runCli(args, options) {
  const result = spawnSync(process.execPath, [
    cliPath,
    "--cwd",
    options.workspace,
    ...(options.daemonUrl ? ["--daemon-url", options.daemonUrl] : []),
    ...args,
  ], {
    cwd: repoRoot,
    env: process.env,
    encoding: "utf8",
  });

  if (result.status !== 0) {
    throw new Error([
      `Command failed: node ${["packages/cli/dist/index.js", ...args].join(" ")}`,
      result.stdout.trim(),
      result.stderr.trim(),
    ].filter(Boolean).join("\n"));
  }
  return result.stdout;
}

function runCliJson(args, options) {
  const stdout = runCli(args, options);
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Failed to parse CLI JSON output: ${error instanceof Error ? error.message : String(error)}\n${stdout}`);
  }
}

async function waitForHealth(daemonUrl, daemonOutput) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) {
        return;
      }
    } catch {
      await delay(200);
    }
  }
  throw new Error(`Daemon did not become healthy at ${daemonUrl}.\n${daemonOutput.join("").trim()}`);
}

async function assertPortFree(daemonUrl) {
  try {
    const response = await fetch(`${daemonUrl}/health`, { signal: AbortSignal.timeout(500) });
    if (response.ok) {
      throw new Error(`${daemonUrl} is already serving a Ling daemon. Pass --port with an unused port.`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes("already serving")) {
      throw error;
    }
  }
}

function renderWorkflow(repository, includeSecretRef) {
  return `---
source:
  kind: github
  repository: ${repository}
${includeSecretRef ? "  secretRef: env:GITHUB_TOKEN\n" : ""}  events:
    - pull_request.opened
    - pull_request.synchronize
    - issue.opened
agent:
  teammateId: engineer
workspace:
  mode: per_subject
actions:
  defaultExternalMutationApproval: strict
---

You are importing live read-only GitHub work into Ling Stack.

External item: {{ item.kind }} {{ item.identifier }}
Title: {{ item.title }}
State: {{ item.state }}
Labels: {{ item.labels }}
URL: {{ item.url }}

Summarize the requested work, list the evidence you would gather first, and do not post
comments, add labels, push commits, request reviews, merge, or close external work
unless Ling creates and approves a separate external action.
`;
}

function printHelp() {
  console.log(`Usage:
  node examples/external-work/github/live-readonly-smoke.mjs [--repo owner/name] [--port 17991] [--limit 1]

This starts an isolated local daemon, polls GitHub read-only PR/issue endpoints,
creates local Ling external-work records, proposes then cancels a local comment action,
and verifies no runner was started.

It never approves or executes the action, so it never calls GitHub mutation APIs.

Environment:
  GITHUB_TOKEN  Optional token for authenticated GitHub read-only API calls.
`);
}

function log(message) {
  console.log(`[external-work-live-smoke] ${message}`);
}

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}
