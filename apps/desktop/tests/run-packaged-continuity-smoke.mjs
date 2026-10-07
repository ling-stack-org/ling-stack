#!/usr/bin/env node

import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { arch, platform, release, tmpdir, type as osType, version as osVersion } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

import { resolvePackagedArtifactName } from "./packaged-artifact-path.mjs";
import {
  buildPackagedContinuityIntentFixture,
  extractPackagedExactCommand,
  resolvePackagedContinuityWorkspaces,
} from "./support/packaged-continuity-intent-fixture.mjs";

const repositoryRoot = resolve(new URL("../../..", import.meta.url).pathname);
const defaultApp = join(repositoryRoot, "apps/desktop/release/mac-arm64/Ling Stack.app/Contents/MacOS/Ling Stack");
const desktopPackage = JSON.parse(await readFile(join(repositoryRoot, "apps/desktop/package.json"), "utf8"));
const defaultArtifact = join(
  repositoryRoot,
  "apps/desktop/release",
  resolvePackagedArtifactName({
    artifactName: desktopPackage.build?.mac?.artifactName,
    version: desktopPackage.version,
    arch: "arm64",
    ext: "zip",
  }),
);
const options = parseArgs(process.argv.slice(2));

if (process.platform !== "darwin") {
  throw new Error("packaged_continuity_smoke_requires_darwin");
}

const appExecutable = resolve(options.app ?? defaultApp);
const artifact = options.artifact ? resolve(options.artifact) : defaultArtifact;
const packagedContentsPath = resolve(dirname(appExecutable), "..");
const browserHostMetadataPath = join(packagedContentsPath, "Resources", "browser-host", "build-metadata.json");
const browserHostDefaultExecutable = process.arch === "x64" ? "ling-browser-host.exe" : "ling-browser-host";
const runRoot = options.output ? resolve(options.output) : await mkdtemp(join(tmpdir(), "ling-packaged-continuity-"));
const userData = join(runRoot, "user-data");
const lingHome = join(runRoot, "ling-stack-home");
const scenarioWorkspaces = resolvePackagedContinuityWorkspaces(runRoot);
const workspace = scenarioWorkspaces.continuity;
const effectUnknownWorkspace = scenarioWorkspaces.effectUnknown;
const logs = join(runRoot, "logs");
const desktopStartupLog = join(userData, "desktop-startup.log");
const proofFileName = "r5-packaged-proof.txt";
const proofContent = "continuity-v2-r5-proof";
const exactVerificationCommand = `node -e "const fs=require('fs');const p=Buffer.from('${Buffer.from(proofFileName, "utf8").toString("base64")}','base64').toString('utf8');const e=Buffer.from('${Buffer.from(proofContent, "utf8").toString("base64")}','base64').toString('utf8');if(fs.readFileSync(p,'utf8')!==e)process.exit(1)"`;
await mkdir(workspace, { recursive: true });
await mkdir(effectUnknownWorkspace, { recursive: true });
await mkdir(logs, { recursive: true });

const report = {
  schemaVersion: 2,
  kind: "ling-desktop-macos-packaged-continuity",
  status: "running",
  simulation: true,
  evidenceScope: "packaged-host-with-local-mock-provider",
  nativeGuiVerified: false,
  appExecutable,
  artifact,
  runRoot,
  environment: {
    platform: platform(),
    architecture: arch(),
    osType: osType(),
    osRelease: release(),
    osVersion: osVersion(),
    nodeVersion: process.version,
  },
  paths: {
    workspace,
    effectUnknownWorkspace,
    userData,
    lingHome,
    logs,
    desktopStartupLog,
    browserHostMetadata: browserHostMetadataPath,
  },
  checks: [],
};

const launchedSessions = [];

function check(id, status, details) {
  report.checks.push({ id, status, details });
  if (status !== "passed") throw new Error(`${id}:${details?.message ?? "failed"}`);
}

function hashFile(path) {
  return new Promise((resolveHash, reject) => {
    const hash = createHash("sha256");
    readFile(path).then((bytes) => resolveHash(hash.update(bytes).digest("hex")), reject);
  });
}

function commandOutput(command, args) {
  try {
    return execFileSync(command, args, { encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function readMacOsMetadata() {
  return {
    productName: commandOutput("/usr/bin/sw_vers", ["-productName"]),
    productVersion: commandOutput("/usr/bin/sw_vers", ["-productVersion"]),
    buildVersion: commandOutput("/usr/bin/sw_vers", ["-buildVersion"]),
  };
}

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function readDesktopStartupEvents() {
  try {
    return (await readFile(desktopStartupLog, "utf8"))
      .split(/\r?\n/u)
      .filter(Boolean)
      .flatMap((line) => {
        try {
          const value = JSON.parse(line);
          return value && typeof value === "object" ? [value] : [];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

async function updateSessionProcessEvidence(session, health) {
  if (!session) return;
  session.daemonCwd = typeof health?.defaultWorkspaceCwd === "string"
    ? health.defaultWorkspaceCwd
    : undefined;
  const events = await readDesktopStartupEvents();
  const startedAt = Date.parse(session.startedAt);
  const spawned = events
    .filter((event) => event.event === "daemon.spawned" && typeof event.ts === "string")
    .filter((event) => Number.isNaN(startedAt) || Date.parse(event.ts) >= startedAt)
    .at(-1);
  if (Number.isInteger(spawned?.pid)) session.daemonPid = spawned.pid;
}

async function flushSessionLogs(session) {
  if (!session) return;
  await writeFile(session.stdoutPath, session.stdout.join(""), "utf8");
  await writeFile(session.stderrPath, session.stderr.join(""), "utf8");
  report.processes = launchedSessions.map((candidate) => ({
    launchIndex: candidate.launchIndex,
    appPid: candidate.child.pid ?? null,
    appCwd: candidate.cwd,
    daemonPid: candidate.daemonPid ?? null,
    daemonCwd: candidate.daemonCwd ?? null,
    startedAt: candidate.startedAt,
    stoppedAt: candidate.stoppedAt ?? null,
    exitCode: candidate.child.exitCode,
    signal: candidate.child.signalCode,
    stdoutPath: candidate.stdoutPath,
    stderrPath: candidate.stderrPath,
  }));
  report.logs = {
    desktopStartup: desktopStartupLog,
    stdout: launchedSessions.map((candidate) => candidate.stdoutPath),
    stderr: launchedSessions.map((candidate) => candidate.stderrPath),
  };
}

async function freePort() {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : undefined;
      server.close((error) => error ? reject(error) : resolvePort(port));
    });
  });
}

async function startMockOpenAICompatibleServer() {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    const bodyText = Buffer.concat(chunks).toString("utf8");
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "invalid_json" } }));
      return;
    }
    requests.push({ method: request.method, path: request.url, body });

    const messages = Array.isArray(body.messages) ? body.messages : [];
    const messageText = (message) => {
      if (typeof message?.content === "string") return message.content;
      if (!Array.isArray(message?.content)) return "";
      return message.content
        .map((part) => typeof part?.text === "string" ? part.text : typeof part?.content === "string" ? part.content : "")
        .join("\n");
    };
    const prompt = messages.map(messageText).join("\n");
    const systemPrompt = messages
      .filter((message) => message?.role === "system" || message?.role === "developer")
      .map(messageText)
      .join("\n");
    const toolNames = (Array.isArray(body.tools) ? body.tools : [])
      .map((tool) => tool?.function?.name ?? tool?.custom?.name)
      .filter((name) => typeof name === "string");
    const lastMessage = messages.at(-1);
    let content = "Packaged continuity mock completed.";
    let toolCall;

    if (/channel intent selector/i.test(systemPrompt)) {
      content = JSON.stringify(buildPackagedContinuityIntentFixture({
        prompt,
        proofFileName,
        proofContent,
        exactVerificationCommand,
      }));
    } else if (/terminal report synthesizer/i.test(systemPrompt)) {
      const ref = (prompt.match(/Allowed source refs:\s*([^\n]+)/i)?.[1] ?? "").split(",")[0]?.trim();
      const [kind, id] = ref.split(":");
      content = JSON.stringify({
        outcome: {
          status: "succeeded",
          title: "Packaged continuity workflow completed",
          summary: "Engineer and QA produced verified Host evidence.",
          corrections: [],
          sourceRefs: kind && id ? [{ kind, id, visibility: "conversation" }] : [],
        },
        changes: [],
        verification: [],
        participants: [],
        artifacts: [],
        risks: [],
        references: kind && id ? [{ kind, id, visibility: "conversation" }] : [],
      });
    } else if (/naked-ready/i.test(prompt)) {
      content = "ready";
    } else if (lastMessage?.role === "tool") {
      content = /bash/i.test(lastMessage?.name ?? "") || /bash/i.test(prompt)
        ? "QA verified the exact Host-materialized command with clean output."
        : "Engineer created the requested file with a durable Host write result.";
    } else if (toolNames.includes("write")) {
      toolCall = {
        id: "packaged_engineer_write",
        name: "write",
        arguments: { path: proofFileName, content: proofContent },
      };
    } else if (toolNames.includes("bash")) {
      toolCall = {
        id: "packaged_qa_verify",
        name: "bash",
        arguments: { command: extractPackagedExactCommand(prompt, exactVerificationCommand) },
      };
    }

    const payload = {
      id: "chatcmpl-packaged-continuity",
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? "packaged-continuity",
      choices: [{
        index: 0,
        message: {
          role: "assistant",
          ...(toolCall
            ? {
                content: null,
                tool_calls: [{
                  id: toolCall.id,
                  type: "function",
                  function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
                }],
              }
            : { content }),
        },
        finish_reason: toolCall ? "tool_calls" : "stop",
      }],
    };

    if (body.stream === true) {
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      const choice = payload.choices[0];
      const delta = toolCall
        ? {
            role: "assistant",
            tool_calls: [{
              index: 0,
              id: toolCall.id,
              type: "function",
              function: { name: toolCall.name, arguments: JSON.stringify(toolCall.arguments) },
            }],
          }
        : { role: "assistant", content };
      response.write(`data: ${JSON.stringify({ ...payload, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ ...payload, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason }] })}\n\n`);
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address !== "object") throw new Error("mock_provider_address_unavailable");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose())),
  };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function request(baseUrl, path, init = {}) {
  let lastError;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}${path}`, init);
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
      return { status: response.status, body, text };
    } catch (error) {
      lastError = error;
      await sleep(200);
    }
  }
  throw lastError ?? new Error("request_failed");
}

async function waitForHealth(baseUrl, session) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await request(baseUrl, "/health");
    if (response.status === 200 && response.body?.ok === true) {
      await updateSessionProcessEvidence(session, response.body);
      return response.body;
    }
    await sleep(200);
  }
  throw new Error("packaged_daemon_health_timeout");
}

function launch(baseUrl, cwd) {
  const launchIndex = launchedSessions.length + 1;
  const child = spawn(appExecutable, [`--user-data-dir=${userData}`], {
    cwd,
    env: {
      ...process.env,
      LING_STACK_DAEMON_URL: baseUrl,
      LING_STACK_DEFAULT_WORKSPACE_CWD: cwd,
      LING_STACK_HOME: lingHome,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(String(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  const session = {
    launchIndex,
    child,
    stdout,
    stderr,
    cwd,
    startedAt: new Date().toISOString(),
    stdoutPath: join(logs, `app-${launchIndex}.stdout.log`),
    stderrPath: join(logs, `app-${launchIndex}.stderr.log`),
  };
  launchedSessions.push(session);
  return session;
}

async function stop(session) {
  if (!session?.child) return;
  if (session.child.exitCode === null) {
    session.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolveExit) => session.child.once("exit", resolveExit)),
      sleep(5_000),
    ]);
    if (session.child.exitCode === null) session.child.kill("SIGKILL");
  }
  session.stoppedAt = new Date().toISOString();
  await flushSessionLogs(session);
}

function jsonHeaders() {
  return { "content-type": "application/json", accept: "application/json" };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--app" || arg === "--artifact" || arg === "--output") result[arg.slice(2)] = argv[++index];
    else if (arg === "--keep") result.keep = true;
    else if (arg === "--help") {
      console.log("Usage: node apps/desktop/tests/run-packaged-continuity-smoke.mjs [--app path] [--artifact path] [--output dir] [--keep]");
      process.exit(0);
    } else throw new Error(`unknown_argument:${arg}`);
  }
  return result;
}

async function waitForFile(path, expectedContent) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await access(path);
      const content = await readFile(path, "utf8");
      if (content === expectedContent) return;
    } catch {
      // The workflow is still executing.
    }
    await sleep(200);
  }
  throw new Error(`host_file_evidence_timeout:${path}`);
}

async function waitFor(checkFn, failureCode, attempts = 100) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await checkFn();
    if (result) return result;
    await sleep(200);
  }
  throw new Error(failureCode);
}

function createSseReader(response) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async nextEvent() {
      for (;;) {
        const match = /\r?\n\r?\n/.exec(buffer);
        if (match) {
          const block = buffer.slice(0, match.index);
          buffer = buffer.slice(match.index + match[0].length);
          const event = parseSseBlock(block);
          if (event) return event;
          continue;
        }
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const finalBlock = buffer.trim() ? buffer : undefined;
          buffer = "";
          return finalBlock ? parseSseBlock(finalBlock) : undefined;
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async waitFor(eventName) {
      for (;;) {
        const event = await this.nextEvent();
        if (!event) throw new Error(`sse_stream_ended_before:${eventName}`);
        if (event.event === eventName) return event;
      }
    },
    async close() {
      await reader.cancel().catch(() => undefined);
    },
  };
}

function parseSseBlock(block) {
  let event = "message";
  const dataLines = [];
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.startsWith("event:")) event = rawLine.slice("event:".length).trim();
    if (rawLine.startsWith("data:")) dataLines.push(rawLine.slice("data:".length).trimStart());
  }
  if (dataLines.length === 0) return undefined;
  return { event, data: JSON.parse(dataLines.join("\n")) };
}

function databasePathFor(cwd) {
  return join(cwd, ".ling-stack", "ling-stack.sqlite");
}

async function seedPreReleaseMigrationFixture(cwd) {
  const core = await import(pathToFileURL(join(repositoryRoot, "packages/core/dist/index.js")).href);
  const now = "2026-08-24T02:00:00.000Z";
  const fixture = core.createPreContinuityV2ReleaseSqliteRunStoreForMigrationTest(cwd);
  const channel = fixture.createChannel({ name: "Packaged migration rollback", boundPath: cwd }, now);
  const workflow = fixture.createChannelWorkflow({
    channelId: channel.id,
    title: "Legacy packaged workflow",
    objective: "Exercise packaged migration rollback",
    createdBy: "packaged-smoke",
    status: "ready",
  }, now);
  fixture.close();

  const databasePath = core.resolveRuntimePaths(cwd).databasePath;
  const database = new DatabaseSync(databasePath);
  try {
    const workspaceId = database.prepare("SELECT workspace_id FROM channels WHERE id = ?").get(channel.id).workspace_id;
    database.prepare(`
      INSERT INTO channel_workflow_steps (
        id, workspace_id, channel_id, workflow_id, source_handoff_id,
        context_summary_id, task_id, run_id, position, title, prompt,
        to_participant_id, to_participant_label, status, blocker,
        result_summary, metadata_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)
    `).run(
      "packaged-legacy-invalid-step",
      workspaceId,
      channel.id,
      workflow.id,
      1,
      "Legacy packaged step",
      "This row is intentionally malformed for migration rollback.",
      "",
      "Unknown",
      "queued",
      now,
      now,
    );
  } finally {
    database.close();
  }
  return { databasePath, channelId: channel.id, workflowId: workflow.id };
}

async function waitForPackagedStartupFailure(baseUrl, session) {
  let lastResponse;
  for (let attempt = 0; attempt < 75; attempt += 1) {
    if (session.child.exitCode !== null) return { processExited: true, lastResponse };
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(250) });
      const text = await response.text();
      lastResponse = { status: response.status, text };
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      if (response.status === 200 && body?.ok === true) {
        throw new Error("packaged_migration_failure_not_observed");
      }
    } catch (error) {
      if (error?.message === "packaged_migration_failure_not_observed") throw error;
    }
    await sleep(200);
  }
  return { processExited: session.child.exitCode !== null, lastResponse };
}

function inspectPreReleaseMigrationFixture(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const columns = new Set(database.prepare("PRAGMA table_info(channel_workflow_steps)").all().map((row) => row.name));
    const migration = (version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version));
    return {
      authorityColumnPresent: columns.has("participant_authority_json"),
      blockerColumnPresent: new Set(database.prepare("PRAGMA table_info(channel_execution_proposals)").all().map((row) => row.name)).has("blocker_json"),
      migrations: { 119: migration(119), 120: migration(120), 121: migration(121) },
      foreignKeyCheck: database.prepare("PRAGMA foreign_key_check").all(),
      integrityCheck: database.prepare("PRAGMA integrity_check").get().integrity_check,
    };
  } finally {
    database.close();
  }
}

function repairPreReleaseMigrationFixture(databasePath) {
  const database = new DatabaseSync(databasePath);
  try {
    database.prepare("UPDATE channel_workflow_steps SET to_participant_id = ? WHERE id = ?")
      .run("teammate_builtin_engineer", "packaged-legacy-invalid-step");
  } finally {
    database.close();
  }
}

function auditReleaseMigrations(databasePath) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const columns = new Set(database.prepare("PRAGMA table_info(channel_workflow_steps)").all().map((row) => row.name));
    const migrations = [119, 120, 121].map((version) => Boolean(database.prepare("SELECT 1 FROM schema_migrations WHERE version = ?").get(version)));
    const foreignKeys = database.prepare("PRAGMA foreign_key_check").all();
    const integrity = database.prepare("PRAGMA integrity_check").get().integrity_check;
    if (!columns.has("participant_authority_json") || !migrations.every(Boolean)) {
      throw new Error(`packaged_release_migrations_missing:${JSON.stringify({ columns: [...columns], migrations })}`);
    }
    if (foreignKeys.length !== 0 || integrity !== "ok") {
      throw new Error(`packaged_release_migrations_integrity:${JSON.stringify({ foreignKeys, integrity })}`);
    }
    const authority = database.prepare("SELECT participant_authority_json FROM channel_workflow_steps WHERE id = ?")
      .get("packaged-legacy-invalid-step")?.participant_authority_json;
    if (JSON.parse(authority).participantId !== "teammate_builtin_engineer") {
      throw new Error("packaged_release_migration_backfill_missing");
    }
    return { migrations: [119, 120, 121], foreignKeyCheck: "ok", integrityCheck: "ok" };
  } finally {
    database.close();
  }
}

async function startDirectPackagedRun(baseUrl, cwd, providerPresetId, taskId, prompt) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      cwd,
      task: { id: taskId, title: taskId, prompt },
      providerPresetId,
      tools: ["bash"],
      thinkingLevel: "off",
    }),
  });
  if (!response.ok || !response.body) throw new Error(`packaged_run_start:${response.status}`);
  const sse = createSseReader(response);
  const ready = await sse.waitFor("ready");
  return { runId: ready.data.runId, sse };
}

async function configurePackagedMockProvider(baseUrl, cwd, providerUrl, displayName = "Packaged Continuity Mock") {
  const cwdQuery = `?cwd=${encodeURIComponent(cwd)}`;
  const providerResponse = await request(baseUrl, `/providers${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      kind: "openai-compatible",
      displayName,
      providerId: "packaged-continuity-mock",
      model: "packaged-continuity",
      api: "openai-completions",
      baseUrl: `${providerUrl}/v1`,
      capabilities: ["chat", "tool_call"],
      input: ["text"],
      authHeader: false,
      apiKey: "packaged-mock-key",
      enabled: true,
    }),
  });
  if (providerResponse.status !== 201) throw new Error(`provider_create:${providerResponse.text}`);
  const providerId = providerResponse.body.provider.id;
  const providerCheck = await request(baseUrl, `/providers/${encodeURIComponent(providerId)}/check${cwdQuery}`, { method: "POST" });
  if (providerCheck.status !== 200) throw new Error(`provider_check:${providerCheck.text}`);
  return providerId;
}

async function waitForRunStatus(baseUrl, cwd, runId, status, failureCode) {
  return await waitFor(async () => {
    const response = await request(baseUrl, `/runs/${encodeURIComponent(runId)}?cwd=${encodeURIComponent(cwd)}`);
    return response.status === 200 && response.body?.status === status ? response.body : undefined;
  }, failureCode, 150);
}

async function waitForResumedToolStart(cwd, runId, approvalId, failureCode) {
  return await waitFor(() => {
    const database = new DatabaseSync(databasePathFor(cwd), { readOnly: true });
    try {
      const rows = database.prepare("SELECT data_json FROM run_events WHERE run_id = ? AND type = 'tool_start' ORDER BY seq")
        .all(runId);
      return rows.map((row) => JSON.parse(row.data_json)).find((data) => data.resumedFromApprovalId === approvalId);
    } finally {
      database.close();
    }
  }, failureCode, 150);
}

function readSqliteAudit(databasePath, ids) {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const count = (sql, ...params) => Number(database.prepare(sql).get(...params)?.count ?? 0);
    const rows = (sql, ...params) => database.prepare(sql).all(...params);
    const foreignKeys = rows("PRAGMA foreign_key_check");
    const integrity = rows("PRAGMA integrity_check")[0]?.integrity_check;
    if (foreignKeys.length !== 0) throw new Error(`sqlite_foreign_key_check_failed:${JSON.stringify(foreignKeys)}`);
    if (integrity !== "ok") throw new Error(`sqlite_integrity_check_failed:${String(integrity)}`);
    const sourceItem = rows("SELECT id, turn_id, thread_id FROM conversation_items WHERE id = ?", ids.sourceItemId)[0];
    if (!sourceItem) throw new Error("sqlite_lineage_source_item_missing");
    const sourceTurn = rows("SELECT id, thread_id, status, source_item_id FROM ling_turns WHERE id = ?", sourceItem.turn_id)[0];
    if (!sourceTurn || sourceTurn.source_item_id !== ids.sourceItemId) throw new Error("sqlite_lineage_source_turn_missing");
    const decision = rows("SELECT id, source_item_id, workflow_id, participant_manifest_json FROM channel_intent_decisions WHERE source_item_id = ? AND workflow_id = ?", ids.sourceItemId, ids.workflowId)[0];
    if (!decision || decision.workflow_id !== ids.workflowId) throw new Error("sqlite_lineage_intent_decision_missing");
    const workflow = rows("SELECT id, channel_id, status, metadata_json FROM channel_workflows WHERE id = ?", ids.workflowId)[0];
    if (!workflow || workflow.status !== "succeeded") throw new Error("sqlite_lineage_workflow_missing");
    const steps = rows("SELECT id, workflow_id, run_id, to_participant_id, status, metadata_json FROM channel_workflow_steps WHERE workflow_id = ? ORDER BY position", ids.workflowId);
    if (steps.length !== 2 || steps.some((step) => step.workflow_id !== ids.workflowId || step.status !== "succeeded" || !step.run_id)) {
      throw new Error("sqlite_lineage_workflow_steps_incomplete");
    }
    const runs = rows(`SELECT id, status, workflow_step_id FROM run_sessions WHERE id IN (${ids.runIds.map(() => "?").join(",")})`, ...ids.runIds);
    if (runs.length !== ids.runIds.length || runs.some((run) => run.status !== "succeeded")) throw new Error("sqlite_lineage_runs_incomplete");
    const evidenceEvents = count(`SELECT COUNT(*) AS count FROM run_events WHERE run_id IN (${ids.runIds.map(() => "?").join(",")}) AND type IN ('tool_start','tool_end')`, ...ids.runIds);
    if (evidenceEvents < 4) throw new Error(`sqlite_lineage_evidence_incomplete:${evidenceEvents}`);
    const reports = rows("SELECT id, source_kind, source_id, outcome_status, result_item_id FROM ling_terminal_reports WHERE source_kind = 'workflow' AND source_id = ? AND status IN ('committed','fallback')", ids.workflowId);
    if (reports.length !== 1 || reports[0].outcome_status !== "succeeded" || !reports[0].result_item_id) throw new Error("sqlite_lineage_terminal_report_incomplete");
    const succeededTransitions = count("SELECT COUNT(*) AS count FROM state_transition_events WHERE entity_type = 'turn' AND entity_id = ? AND to_status = 'succeeded'", sourceTurn.id);
    if (succeededTransitions !== 1) throw new Error(`sqlite_lineage_turn_settlement_not_idempotent:${succeededTransitions}`);
    const manifest = JSON.parse(decision.participant_manifest_json);
    if (manifest.participants?.length !== 2) throw new Error("sqlite_lineage_manifest_incomplete");
    return {
      sourceItemId: ids.sourceItemId,
      sourceTurnId: sourceTurn.id,
      threadId: sourceItem.thread_id,
      workflowId: ids.workflowId,
      workflowStepIds: steps.map((step) => step.id),
      runIds: runs.map((run) => run.id),
      evidenceEvents,
      terminalReportId: reports[0].id,
      resultItemId: reports[0].result_item_id,
      succeededTransitions,
      foreignKeyCheck: "ok",
      integrityCheck: "ok",
      tableCounts: {
        threads: count("SELECT COUNT(*) AS count FROM ling_threads WHERE channel_id = ?", ids.channelId),
        turns: count("SELECT COUNT(*) AS count FROM ling_turns WHERE source_item_id = ?", ids.sourceItemId),
        items: count("SELECT COUNT(*) AS count FROM conversation_items WHERE channel_id = ?", ids.channelId),
        decisions: count("SELECT COUNT(*) AS count FROM channel_intent_decisions WHERE source_item_id = ?", ids.sourceItemId),
        workflows: count("SELECT COUNT(*) AS count FROM channel_workflows WHERE id = ?", ids.workflowId),
        runs: runs.length,
        terminalReports: reports.length,
      },
    };
  } finally {
    database.close();
  }
}

let session;
let mockProvider;
try {
  report.environment.macos = readMacOsMetadata();
  const artifactSha256 = await hashFile(artifact);
  report.artifactSha256 = artifactSha256;
  // The supplied archive may predate an explicitly selected app. Identify the
  // actual executable and separate Web payload without asserting archive parity.
  const appAsarPath = join(packagedContentsPath, "Resources", "app.asar");
  const webIndexPath = join(packagedContentsPath, "Resources", "web", "index.html");
  report.packageIdentity = {
    executable: { path: appExecutable, sha256: await hashFile(appExecutable) },
    appAsar: { path: appAsarPath, sha256: await hashFile(appAsarPath) },
    webIndex: { path: webIndexPath, sha256: await hashFile(webIndexPath) },
    artifactToBundleParityVerified: false,
  };
  const browserHostMetadata = await readJson(browserHostMetadataPath);
  const browserHostExecutable = join(dirname(browserHostMetadataPath), browserHostMetadata.executable ?? browserHostDefaultExecutable);
  const browserHostSourceExecutable = join(repositoryRoot, "packages/browser-host/dist/native", browserHostMetadata.executable ?? browserHostDefaultExecutable);
  const browserHostSourceSha256 = await hashFile(browserHostSourceExecutable);
  const browserHostPackagedSha256 = await hashFile(browserHostExecutable);
  if (browserHostMetadata.hostSha256 !== browserHostSourceSha256) {
    throw new Error(`browser_host_source_hash_mismatch:${JSON.stringify({ expected: browserHostMetadata.hostSha256, actual: browserHostSourceSha256 })}`);
  }
  report.browserHost = {
    metadataPath: browserHostMetadataPath,
    sourceExecutable: browserHostSourceExecutable,
    packagedExecutable: browserHostExecutable,
    metadata: browserHostMetadata,
    sourceSha256: browserHostSourceSha256,
    packagedSha256: browserHostPackagedSha256,
    packagingChangedBytes: browserHostSourceSha256 !== browserHostPackagedSha256,
  };
  check("artifact", "passed", {
    sha256: artifactSha256,
    app: appExecutable,
    packageIdentity: report.packageIdentity,
  });
  check("browser_host_build", "passed", {
    sourceSha256: browserHostSourceSha256,
    packagedSha256: browserHostPackagedSha256,
    packagingChangedBytes: browserHostSourceSha256 !== browserHostPackagedSha256,
    sourceCommit: browserHostMetadata.sourceCommit,
    platform: browserHostMetadata.platform,
  });
  const daemonPort = await freePort();
  const baseUrl = `http://127.0.0.1:${daemonPort}`;
  mockProvider = await startMockOpenAICompatibleServer();
  const releaseMigrationFixture = await seedPreReleaseMigrationFixture(workspace);
  session = launch(baseUrl, workspace);
  const failedStartup = await waitForPackagedStartupFailure(baseUrl, session);
  const failedMigrationState = inspectPreReleaseMigrationFixture(releaseMigrationFixture.databasePath);
  if (failedMigrationState.authorityColumnPresent
    || Object.values(failedMigrationState.migrations).some(Boolean)
    || failedMigrationState.foreignKeyCheck.length !== 0
    || failedMigrationState.integrityCheck !== "ok") {
    throw new Error(`packaged_release_migration_rollback_failed:${JSON.stringify(failedMigrationState)}`);
  }
  await stop(session);
  repairPreReleaseMigrationFixture(releaseMigrationFixture.databasePath);
  session = launch(baseUrl, workspace);
  const health = await waitForHealth(baseUrl, session);
  check("launch", "passed", {
    pid: session.child.pid,
    daemonPort,
    readiness: health.readiness,
    features: health.features,
  });
  check("packaged_release_migration_recovery", "passed", {
    startupFailureObserved: true,
    processExited: failedStartup.processExited,
    preMigration: failedMigrationState,
    postMigration: auditReleaseMigrations(releaseMigrationFixture.databasePath),
  });

  const cwdQuery = `?cwd=${encodeURIComponent(workspace)}`;
  const providerId = await configurePackagedMockProvider(baseUrl, workspace, mockProvider.url);
  const approvalPolicy = await request(baseUrl, `/approval-policy${cwdQuery}`, {
    method: "PATCH",
    headers: jsonHeaders(),
    body: JSON.stringify({ toolDecisions: { write: "allow", bash: "allow" }, allowedWritePaths: ["."] }),
  });
  if (approvalPolicy.status !== 200) throw new Error(`approval_policy:${approvalPolicy.text}`);

  const channelResponse = await request(baseUrl, `/channels${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: "Packaged Continuity",
      status: "active",
      boundPath: workspace,
      defaultProviderPresetId: providerId,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write", "bash"],
    }),
  });
  if (channelResponse.status !== 201) throw new Error(`channel_create:${channelResponse.text}`);
  const channelId = channelResponse.body.channel.id;
  const channelExecutionPath = channelResponse.body.channel.workspaceBinding?.executionPath ?? workspace;
  for (const teammateId of ["teammate_builtin_engineer", "teammate_builtin_qa"]) {
    const teammateResponse = await request(baseUrl, `/teammates/${encodeURIComponent(teammateId)}${cwdQuery}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ providerPresetId: providerId, allowedTools: ["read", "write", "bash"], approvalProfile: { mode: "none" } }),
    });
    if (teammateResponse.status !== 200) throw new Error(`teammate_patch:${teammateId}:${teammateResponse.text}`);
    const membershipResponse = await request(baseUrl, `/teammates/${encodeURIComponent(teammateId)}/channels${cwdQuery}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ memberships: [{ channelId }] }),
    });
    if (membershipResponse.status !== 200) throw new Error(`teammate_membership:${teammateId}:${membershipResponse.text}`);
  }
  const turnBody = JSON.stringify({
    body: `@Engineer @QA 请协作完成一个最小可验证任务：由 Engineer 创建 ${proofFileName}，内容为 ${proofContent}；QA 执行精确命令：${exactVerificationCommand} 验证文件内容。Engineer 与 QA 都必须完成并提供真实 evidence 后才报告成功。`,
    mentions: [
      { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
      { id: "teammate_builtin_qa", label: "QA", kind: "ai-teammate" },
    ],
    requestAiReply: true,
    idempotencyKey: "packaged-continuity-sse-1",
  });

  const initialStream = await fetch(`${baseUrl}/channels/${encodeURIComponent(channelId)}/turns/stream${cwdQuery}`, {
    method: "POST",
    headers: { ...jsonHeaders(), accept: "text/event-stream" },
    body: turnBody,
  });
  if (!initialStream.ok || !initialStream.body) throw new Error(`sse_initial:${initialStream.status}`);
  const reader = initialStream.body.getReader();
  const firstChunk = await reader.read();
  await reader.cancel();
  const firstText = new TextDecoder().decode(firstChunk.value);
  if (!firstText.includes("event: ready")) throw new Error("sse_initial_missing_ready");
  check("sse_disconnect", "passed", { status: initialStream.status, firstEvent: "ready" });

  await sleep(1_500);
  const replayStream = await fetch(`${baseUrl}/channels/${encodeURIComponent(channelId)}/turns/stream${cwdQuery}`, {
    method: "POST",
    headers: { ...jsonHeaders(), accept: "text/event-stream" },
    body: turnBody,
  });
  const replayText = await replayStream.text();
  if (!replayStream.ok || !replayText.includes("event: ready")) throw new Error(`sse_reconnect:${replayStream.status}`);
  check("sse_reconnect", "passed", {
    status: replayStream.status,
    replayedReady: replayText.includes("event: ready"),
    terminalEvent: replayText.includes("event: blocked") ? "blocked" : replayText.includes("event: done") ? "done" : "unknown",
  });

  await waitForFile(join(channelExecutionPath, proofFileName), proofContent);
  const { response: workflowsResponse, workflow } = await waitFor(async () => {
    const response = await request(baseUrl, `/channels/${encodeURIComponent(channelId)}/workflows${cwdQuery}`);
    if (response.status !== 200 || response.body.workflows?.length !== 1) return undefined;
    const candidate = response.body.workflows[0];
    return ["succeeded", "blocked", "failed", "cancelled"].includes(candidate.status)
      ? { response, workflow: candidate }
      : undefined;
  }, "workflow_terminal_timeout");
  if (workflow.status !== "succeeded" || workflow.metadata?.completionGate?.status !== "verified") {
    throw new Error(`workflow_completion_gate:${JSON.stringify({ status: workflow.status, gate: workflow.metadata?.completionGate })}`);
  }
  const stepsResponse = await request(baseUrl, `/workflows/${encodeURIComponent(workflow.id)}/steps${cwdQuery}`);
  const workflowSteps = stepsResponse.body.workflowSteps ?? [];
  if (stepsResponse.status !== 200 || workflowSteps.length !== 2 || workflowSteps.some((step) => step.status !== "succeeded" || !step.runId)) {
    throw new Error(`workflow_steps:${stepsResponse.text}`);
  }

  const itemsResponse = await request(baseUrl, `/channels/${encodeURIComponent(channelId)}/items${cwdQuery}`);
  const initialItems = itemsResponse.body.items ?? [];
  const userItems = initialItems.filter((item) => item.kind === "user_message");
  if (userItems.length !== 1) throw new Error(`duplicate_user_items:${userItems.length}`);
  const sourceTurnId = userItems[0].turnId;
  const intentResponse = await request(baseUrl, `/channels/${encodeURIComponent(channelId)}/intent-decisions${cwdQuery}`);
  const decision = (intentResponse.body.decisions ?? []).find((candidate) => candidate.sourceItemId === userItems[0].id && candidate.workflowId === workflow.id);
  if (!decision || decision.participantManifest?.participants?.length !== 2) throw new Error("participant_manifest_not_persisted");
  if (new Set(decision.participantManifest.participants.map((participant) => participant.participantId)).size !== 2) throw new Error("participant_manifest_not_distinct");

  // Workflow settlement and terminal-report publication are separate durable
  // steps. The workflow can be succeeded before the async report coordinator
  // finishes its evidence barrier and publishes the fallback/model report.
  // Do not treat that valid intermediate empty collection as a packaged
  // failure; wait for the public API to expose the committed/fallback report.
  const terminalReportsResponse = await waitFor(async () => {
    const response = await request(baseUrl, `/channels/${encodeURIComponent(channelId)}/terminal-reports${cwdQuery}`);
    return response.status === 200
      && response.body.reports?.length === 1
      && response.body.reports[0].outcome?.status === "succeeded"
      ? response
      : undefined;
  }, "terminal_report_publication_timeout", 150);
  for (const step of workflowSteps) {
    const eventsResponse = await request(baseUrl, `/runs/${encodeURIComponent(step.runId)}/events${cwdQuery}`);
    const events = eventsResponse.body.events ?? [];
    if (eventsResponse.status !== 200 || !events.some((event) => event.type === "tool_start") || !events.some((event) => event.type === "tool_end")) {
      throw new Error(`run_evidence:${step.runId}:${eventsResponse.text}`);
    }
  }
  const terminalReport = terminalReportsResponse.body.reports[0];
  const terminalReportId = terminalReport.id;
  const expectedResultItemId = typeof terminalReport.resultItemId === "string" && terminalReport.resultItemId.length > 0
    ? terminalReport.resultItemId
    : `result_terminal_report:${terminalReportId}`;
  // The report coordinator commits the terminal-report item after the report
  // becomes publicly readable. Refresh the canonical item snapshot before
  // asserting lineage; otherwise a valid async publication is mistaken for a
  // missing or duplicate terminal item.
  const settledItemsResponse = await waitFor(async () => {
    const response = await request(baseUrl, `/channels/${encodeURIComponent(channelId)}/items${cwdQuery}`);
    const currentItems = response.body.items ?? [];
    return response.status === 200 && currentItems.some((item) => item.kind === "terminal_report" && item.id === expectedResultItemId)
      ? response
      : undefined;
  }, "terminal_item_publication_timeout", 150);
  const items = settledItemsResponse.body.items ?? [];
  const terminalItems = items.filter((item) => item.kind === "terminal_report" && item.id === expectedResultItemId);
  if (terminalItems.length !== 1) throw new Error(`duplicate_terminal_items:${terminalItems.length}`);
  if (terminalItems[0].payload?.reportId !== terminalReportId) throw new Error("terminal_report_item_lineage_mismatch");
  check("lineage_before_restart", "passed", {
    itemCount: items.length,
    userItemCount: userItems.length,
    sourceTurnId,
    workflowId: workflow.id,
    workflowStepIds: workflowSteps.map((step) => step.id),
    runIds: workflowSteps.map((step) => step.runId),
    terminalReportCount: terminalReportsResponse.body.reports.length,
    hostEvidence: { executionPath: channelExecutionPath, path: proofFileName, content: proofContent },
  });

  const nakedTeammateResponse = await request(baseUrl, `/teammates${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      roleKey: "engineer",
      displayName: "Naked Ready",
      description: "Packaged negative-path participant.",
      providerPresetId: providerId,
      allowedTools: ["write"],
      approvalProfile: { mode: "none" },
      status: "active",
    }),
  });
  if (nakedTeammateResponse.status !== 201) throw new Error(`naked_teammate_create:${nakedTeammateResponse.text}`);
  const nakedTeammateId = nakedTeammateResponse.body.teammate.id;
  const nakedChannelResponse = await request(baseUrl, `/channels${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: "Packaged Naked Ready",
      status: "active",
      boundPath: workspace,
      defaultProviderPresetId: providerId,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write"],
    }),
  });
  if (nakedChannelResponse.status !== 201) throw new Error(`naked_channel_create:${nakedChannelResponse.text}`);
  const nakedChannelId = nakedChannelResponse.body.channel.id;
  const nakedMembership = await request(baseUrl, `/teammates/${encodeURIComponent(nakedTeammateId)}/channels${cwdQuery}`, {
    method: "PUT",
    headers: jsonHeaders(),
    body: JSON.stringify({ memberships: [{ channelId: nakedChannelId }] }),
  });
  if (nakedMembership.status !== 200) throw new Error(`naked_membership:${nakedMembership.text}`);
  const nakedTurnResponse = await request(baseUrl, `/channels/${encodeURIComponent(nakedChannelId)}/turns${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      body: "@Naked Ready 请创建 naked-ready.txt 完成 naked-ready delegated task；只有真实 evidence 才能报告成功。",
      mentions: [{ id: nakedTeammateId, label: "Naked Ready", kind: "ai-teammate" }],
      requestAiReply: true,
      idempotencyKey: "packaged-continuity-naked-ready-1",
    }),
  });
  if (nakedTurnResponse.status < 200 || nakedTurnResponse.status >= 300) throw new Error(`naked_turn:${nakedTurnResponse.text}`);
  const nakedWorkflow = await waitFor(async () => {
    const response = await request(baseUrl, `/channels/${encodeURIComponent(nakedChannelId)}/workflows${cwdQuery}`);
    const candidate = response.body.workflows?.[0];
    return candidate?.status === "blocked" ? candidate : undefined;
  }, "naked_ready_blocker_timeout");
  const nakedStepsResponse = await request(baseUrl, `/workflows/${encodeURIComponent(nakedWorkflow.id)}/steps${cwdQuery}`);
  const nakedSteps = nakedStepsResponse.body.workflowSteps ?? [];
  if (nakedSteps.length !== 1 || nakedSteps[0].status !== "blocked") throw new Error(`naked_ready_step:${nakedStepsResponse.text}`);
  if (nakedSteps[0].runId) {
    const nakedEventsResponse = await request(baseUrl, `/runs/${encodeURIComponent(nakedSteps[0].runId)}/events${cwdQuery}`);
    const nakedEvents = nakedEventsResponse.body.events ?? [];
    if (nakedEvents.some((event) => event.type === "tool_start" || event.type === "tool_end")) {
      throw new Error("naked_ready_published_execution_evidence");
    }
  }
  check("naked_ready_blocker", "passed", {
    workflowId: nakedWorkflow.id,
    workflowStatus: nakedWorkflow.status,
    stepStatus: nakedSteps[0].status,
    blocker: nakedSteps[0].metadata?.delegatedOutcome?.code ?? nakedSteps[0].metadata?.blocker,
    toolEvidence: false,
  });

  for (const teammateId of ["teammate_builtin_engineer", "teammate_builtin_qa"]) {
    const reset = await request(baseUrl, `/teammates/${encodeURIComponent(teammateId)}${cwdQuery}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ modelBindingMode: "workspace_default", providerPresetId: null }),
    });
    if (reset.status !== 200) throw new Error(`reset_workspace_binding:${teammateId}:${reset.text}`);
  }
  const missingChannelResponse = await request(baseUrl, `/channels${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      name: "Packaged Missing Provider",
      status: "active",
      boundPath: workspace,
      defaultProviderPresetId: providerId,
      autoReplyMode: "mentions_only",
      allowedTools: ["read", "write", "bash"],
    }),
  });
  if (missingChannelResponse.status !== 201) throw new Error(`missing_provider_channel:${missingChannelResponse.text}`);
  const missingChannelId = missingChannelResponse.body.channel.id;
  for (const teammateId of ["teammate_builtin_engineer", "teammate_builtin_qa"]) {
    const membership = await request(baseUrl, `/teammates/${encodeURIComponent(teammateId)}/channels${cwdQuery}`, {
      method: "PUT",
      headers: jsonHeaders(),
      body: JSON.stringify({ memberships: [{ channelId: missingChannelId }] }),
    });
    if (membership.status !== 200) throw new Error(`missing_provider_membership:${teammateId}:${membership.text}`);
  }
  const missingTurnResponse = await request(baseUrl, `/channels/${encodeURIComponent(missingChannelId)}/turns${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({
      body: "@Engineer @QA 请协作完成 missing-provider task：Engineer 创建 missing-provider.txt；QA 执行精确命令 `node -e \"process.exit(0)\"` 验证。",
      mentions: [
        { id: "teammate_builtin_engineer", label: "Engineer", kind: "ai-teammate" },
        { id: "teammate_builtin_qa", label: "QA", kind: "ai-teammate" },
      ],
      requestAiReply: true,
      idempotencyKey: "packaged-continuity-missing-provider-1",
    }),
  });
  if (missingTurnResponse.status < 200 || missingTurnResponse.status >= 300) throw new Error(`missing_provider_turn:${missingTurnResponse.text}`);
  const missingItemId = missingTurnResponse.body.message?.id ?? missingTurnResponse.body.item?.id;
  const missingDraftProposal = await waitFor(async () => {
    const suffix = missingItemId ? `&sourceMessageId=${encodeURIComponent(missingItemId)}` : "";
    const response = await request(baseUrl, `/channels/${encodeURIComponent(missingChannelId)}/proposals${cwdQuery}${suffix}`);
    const candidate = response.body.proposals?.find((proposal) => proposal.status === "draft");
    return candidate;
  }, "missing_provider_draft_timeout");
  const confirmMissing = await request(baseUrl, `/channel-proposals/${encodeURIComponent(missingDraftProposal.id)}/confirm-workflow${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
  });
  if (confirmMissing.status !== 400 && confirmMissing.status !== 409) throw new Error(`missing_provider_confirm_unexpected:${confirmMissing.status}:${confirmMissing.text}`);
  const missingProposal = await waitFor(async () => {
    const suffix = missingItemId ? `&sourceMessageId=${encodeURIComponent(missingItemId)}` : "";
    const response = await request(baseUrl, `/channels/${encodeURIComponent(missingChannelId)}/proposals${cwdQuery}${suffix}`);
    return response.body.proposals?.find((proposal) => proposal.status === "blocked");
  }, "missing_provider_blocker_timeout");
  const missingWorkflowsResponse = await request(baseUrl, `/channels/${encodeURIComponent(missingChannelId)}/workflows${cwdQuery}`);
  if ((missingWorkflowsResponse.body.workflows ?? []).length !== 0) throw new Error(`missing_provider_created_workflow:${missingWorkflowsResponse.text}`);
  let missingFileExists = false;
  try {
    await access(join(workspace, "missing-provider.txt"));
    missingFileExists = true;
  } catch {
    // The provider blocker must happen before any Host side effect.
  }
  if (missingFileExists) throw new Error("missing_provider_created_side_effect");
  check("missing_provider_blocker", "passed", {
    proposalId: missingProposal.id,
    status: missingProposal.status,
    blocker: missingProposal.blocker,
    workflowCount: 0,
    runCount: 0,
    sideEffectCount: 0,
  });

  // S4.3 packaged restart matrix. These are direct daemon-owned Runs behind the
  // packaged Electron process so the assertions cover the real lifecycle boundary,
  // not only the in-process coordinator tests.
  const patchApprovalPolicy = async (cwd, toolDecisions) => {
    const response = await request(baseUrl, `/approval-policy?cwd=${encodeURIComponent(cwd)}`, {
      method: "PATCH",
      headers: jsonHeaders(),
      body: JSON.stringify({ toolDecisions, allowedWritePaths: ["."] }),
    });
    if (response.status !== 200) throw new Error(`packaged_restart_policy:${response.text}`);
  };

  await patchApprovalPolicy(workspace, { bash: "ask" });
  const safeRestartCommand = "printf 'packaged-safe-resume\\n' > packaged-safe-resume.txt";
  const safeRestart = await startDirectPackagedRun(
    baseUrl,
    workspace,
    providerId,
    "packaged_safe_approval_restart",
    `Run the exact command: ${safeRestartCommand}`,
  );
  const safeApproval = await safeRestart.sse.waitFor("approval_requested");
  const safeApprovalId = safeApproval.data.data.approvalId;
  const safeRunId = safeRestart.runId;
  await safeRestart.sse.close();
  await stop(session);
  session = launch(baseUrl, workspace);
  await waitForHealth(baseUrl, session);
  const safeApprove = await request(baseUrl, `/approvals/${encodeURIComponent(safeApprovalId)}/approve${cwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ reason: "packaged safe checkpoint resume" }),
  });
  if (safeApprove.status !== 200) throw new Error(`packaged_safe_resume_approve:${safeApprove.text}`);
  const safeCompleted = await waitForRunStatus(baseUrl, workspace, safeRunId, "succeeded", "packaged_safe_resume_timeout");
  await waitForFile(join(workspace, "packaged-safe-resume.txt"), "packaged-safe-resume\n");
  check("packaged_restart_safe_checkpoint", "passed", {
    runId: safeRunId,
    approvalId: safeApprovalId,
    status: safeCompleted.status,
    error: safeCompleted.errorMessage,
  });

  await patchApprovalPolicy(workspace, { bash: "allow" });
  const noCheckpointCommand = "sleep 30; printf 'must-not-complete\\n' > packaged-no-checkpoint.txt";
  const noCheckpoint = await startDirectPackagedRun(
    baseUrl,
    workspace,
    providerId,
    "packaged_no_checkpoint_restart",
    `Run the exact command: ${noCheckpointCommand}`,
  );
  await noCheckpoint.sse.waitFor("tool_start");
  const noCheckpointRunId = noCheckpoint.runId;
  await noCheckpoint.sse.close();
  await stop(session);
  session = launch(baseUrl, workspace);
  await waitForHealth(baseUrl, session);
  const noCheckpointFailed = await waitForRunStatus(baseUrl, workspace, noCheckpointRunId, "failed", "packaged_no_checkpoint_timeout");
  if (!String(noCheckpointFailed.errorMessage ?? "").includes("runtime_interrupted_no_checkpoint")) {
    throw new Error(`packaged_no_checkpoint_reason:${noCheckpointFailed.errorMessage ?? "missing"}`);
  }
  try {
    await access(join(workspace, "packaged-no-checkpoint.txt"));
    throw new Error("packaged_no_checkpoint_side_effect");
  } catch (error) {
    if (error?.message === "packaged_no_checkpoint_side_effect") throw error;
  }
  check("packaged_restart_no_checkpoint", "passed", {
    runId: noCheckpointRunId,
    status: noCheckpointFailed.status,
    error: noCheckpointFailed.errorMessage,
  });

  await stop(session);
  session = launch(baseUrl, effectUnknownWorkspace);
  await waitForHealth(baseUrl, session);
  const effectUnknownProviderId = await configurePackagedMockProvider(
    baseUrl,
    effectUnknownWorkspace,
    mockProvider.url,
    "Packaged Effect Unknown Mock",
  );
  const effectUnknownCwdQuery = `?cwd=${encodeURIComponent(effectUnknownWorkspace)}`;
  await patchApprovalPolicy(effectUnknownWorkspace, { bash: "ask" });
  const effectUnknownCommand = "sleep 30; printf 'must-not-repeat\\n' > packaged-effect-unknown.txt";
  const effectUnknown = await startDirectPackagedRun(
    baseUrl,
    effectUnknownWorkspace,
    effectUnknownProviderId,
    "packaged_effect_unknown_restart",
    `Run the exact command: ${effectUnknownCommand}`,
  );
  const effectApproval = await effectUnknown.sse.waitFor("approval_requested");
  const effectApprovalId = effectApproval.data.data.approvalId;
  const effectRunId = effectUnknown.runId;
  // First restart preserves the pending approval/checkpoint. Approving only
  // after recovery forces the replacement Attempt path, which is the path whose
  // tool_start/effect boundary we need to interrupt.
  await effectUnknown.sse.close();
  await stop(session);
  session = launch(baseUrl, effectUnknownWorkspace);
  await waitForHealth(baseUrl, session);
  const effectApprove = await request(baseUrl, `/approvals/${encodeURIComponent(effectApprovalId)}/approve${effectUnknownCwdQuery}`, {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ reason: "packaged effect unknown probe" }),
  });
  if (effectApprove.status !== 200) throw new Error(`packaged_effect_unknown_approve:${effectApprove.text}`);
  await waitForResumedToolStart(effectUnknownWorkspace, effectRunId, effectApprovalId, "packaged_effect_unknown_tool_start_timeout");
  // The resumed process owns the long-running shell now. Stop the packaged app
  // immediately after the durable resumed tool_start, while the side effect is
  // still in flight; waiting for terminal output would miss the crash window.
  await stop(session);
  session = launch(baseUrl, effectUnknownWorkspace);
  await waitForHealth(baseUrl, session);
  const effectUnknownFailed = await waitForRunStatus(baseUrl, effectUnknownWorkspace, effectRunId, "failed", "packaged_effect_unknown_timeout");
  const effectDatabase = new DatabaseSync(databasePathFor(effectUnknownWorkspace), { readOnly: true });
  try {
    const checkpoint = effectDatabase.prepare("SELECT status, resume_failure_reason FROM approval_checkpoints WHERE approval_id = ?")
      .get(effectApprovalId);
    if (checkpoint?.status !== "resume_failed" || checkpoint?.resume_failure_reason !== "approval_resume_effect_unknown") {
      throw new Error(`packaged_effect_unknown_checkpoint:${JSON.stringify(checkpoint)}`);
    }
    if (effectDatabase.prepare("SELECT 1 FROM run_events WHERE run_id = ? AND type = 'run_cancelled'").get(effectRunId)) {
      throw new Error("packaged_effect_unknown_recorded_cancellation");
    }
  } finally {
    effectDatabase.close();
  }
  try {
    await access(join(effectUnknownWorkspace, "packaged-effect-unknown.txt"));
    throw new Error("packaged_effect_unknown_side_effect");
  } catch (error) {
    if (error?.message === "packaged_effect_unknown_side_effect") throw error;
  }
  check("packaged_restart_effect_unknown", "passed", {
    runId: effectRunId,
    approvalId: effectApprovalId,
    status: effectUnknownFailed.status,
    error: effectUnknownFailed.errorMessage,
    checkpoint: "resume_failed:approval_resume_effect_unknown",
  });

  await stop(session);
  const databasePath = databasePathFor(workspace);
  const auditIds = { channelId, sourceItemId: userItems[0].id, workflowId: workflow.id, runIds: workflowSteps.map((step) => step.runId) };
  const beforeRestartAudit = readSqliteAudit(databasePath, auditIds);
  check("sqlite_lineage_before_restart", "passed", beforeRestartAudit);

  session = launch(baseUrl, workspace);
  const recoveredHealth = await waitForHealth(baseUrl, session);
  const recoveredItemsResponse = await request(baseUrl, `/channels/${encodeURIComponent(channelId)}/items${cwdQuery}`);
  const recoveredItems = recoveredItemsResponse.body.items ?? [];
  const recoveredUsers = recoveredItems.filter((item) => item.kind === "user_message");
  if (recoveredUsers.length !== 1 || recoveredUsers[0].turnId !== sourceTurnId) throw new Error("restart_lineage_not_recovered");
  const recoveredReplay = await request(baseUrl, `/channels/${encodeURIComponent(channelId)}/turns/stream${cwdQuery}`, {
    method: "POST",
    headers: { ...jsonHeaders(), accept: "text/event-stream" },
    body: turnBody,
  });
  if (recoveredReplay.status !== 200 || !recoveredReplay.text.includes("event: ready")) throw new Error(`restart_replay:${recoveredReplay.status}`);
  const afterRestartAudit = readSqliteAudit(databasePath, auditIds);
  if (JSON.stringify(afterRestartAudit) !== JSON.stringify(beforeRestartAudit)) throw new Error("restart_replay_changed_canonical_lineage");
  check("daemon_restart_recovery", "passed", {
    readiness: recoveredHealth.readiness,
    itemCount: recoveredItems.length,
    userItemCount: recoveredUsers.length,
    sourceTurnId,
    duplicateUserItem: false,
    replayIdempotent: true,
    sqlite: afterRestartAudit,
  });

  report.finalUiState = {
    surface: "channel",
    channelId,
    workflowId: workflow.id,
    workflowStatus: workflow.status,
    completionGateStatus: workflow.metadata?.completionGate?.status ?? null,
    terminalReportStatus: terminalReportsResponse.body.reports[0]?.outcome?.status ?? null,
    visibleItemCount: recoveredItems.length,
    userItemCount: recoveredUsers.length,
    terminalReportItemCount: recoveredItems.filter((item) => item.kind === "terminal_report").length,
    sseReconnectReady: recoveredReplay.text.includes("event: ready"),
    daemonReadiness: recoveredHealth.readiness,
    canonicalReplayIdempotent: true,
  };

  await stop(session);
  session = undefined;
  report.status = "passed";
  report.finishedAt = new Date().toISOString();
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ type: "result", ...report }));
} catch (error) {
  report.status = "failed";
  report.error = { message: error instanceof Error ? error.message : String(error) };
  await flushSessionLogs(session).catch(() => undefined);
  report.finishedAt = new Date().toISOString();
  await writeFile(join(runRoot, "report.json"), `${JSON.stringify(report, null, 2)}\n`).catch(() => undefined);
  console.error(JSON.stringify({ type: "result", ...report }));
  process.exitCode = 1;
} finally {
  await stop(session);
  await mockProvider?.close().catch(() => undefined);
  if (!options.keep && !options.output) await rm(runRoot, { recursive: true, force: true }).catch(() => undefined);
}
