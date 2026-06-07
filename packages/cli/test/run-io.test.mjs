import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const cliPath = resolve(dirname(fileURLToPath(import.meta.url)), "../dist/index.js");

test("run reads prompt from flags, positionals, stdin, and appended stdin context", async () => {
  const daemon = await startRunDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  try {
    const flag = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "--prompt", "hello"], "");
    assert.equal(flag.code, 0, flag.stderr);
    assert.equal(daemon.runRequests.at(-1).task.prompt, "hello");

    const positional = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "hello", "world"], "");
    assert.equal(positional.code, 0, positional.stderr);
    assert.equal(daemon.runRequests.at(-1).task.prompt, "hello world");

    const stdinDash = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "-"], "stdin prompt\n");
    assert.equal(stdinDash.code, 0, stdinDash.stderr);
    assert.equal(daemon.runRequests.at(-1).task.prompt, "stdin prompt");

    const stdinPromptFile = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "--prompt-file", "-"], "file stdin\n");
    assert.equal(stdinPromptFile.code, 0, stdinPromptFile.stderr);
    assert.equal(daemon.runRequests.at(-1).task.prompt, "file stdin");

    const promptFilePath = resolve(cwd, "prompt.md");
    await writeFile(promptFilePath, "file prompt\n", "utf8");
    const promptFile = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "--prompt-file", promptFilePath], "");
    assert.equal(promptFile.code, 0, promptFile.stderr);
    assert.equal(daemon.runRequests.at(-1).task.prompt, "file prompt");

    const pipedOnly = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight"], "pipe prompt\n");
    assert.equal(pipedOnly.code, 0, pipedOnly.stderr);
    assert.equal(daemon.runRequests.at(-1).task.prompt, "pipe prompt");

    const appended = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "Review"], "diff");
    assert.equal(appended.code, 0, appended.stderr);
    assert.equal(daemon.runRequests.at(-1).task.prompt, "Review\n\n<stdin>\ndiff\n</stdin>");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run rejects ambiguous prompt sources before contacting daemon", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  try {
    const result = await runCli("http://127.0.0.1:1", cwd, [
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "--prompt",
      "hello",
      "positional",
    ], "");
    assert.equal(result.code, 2);
    assert.match(result.stderr, /ambiguous_prompt/);
    assert.equal(result.stdout, "");

    const promptFilePath = resolve(cwd, "prompt.md");
    await writeFile(promptFilePath, "hello", "utf8");
    const fileAndPositional = await runCli("http://127.0.0.1:1", cwd, [
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "--prompt-file",
      promptFilePath,
      "positional",
    ], "");
    assert.equal(fileAndPositional.code, 2);
    assert.match(fileAndPositional.stderr, /ambiguous_prompt/);
    assert.equal(fileAndPositional.stdout, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run rejects invalid UTF-8 stdin", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  try {
    const result = await runCli("http://127.0.0.1:1", cwd, [
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "-",
    ], Buffer.from([0xff]));
    assert.equal(result.code, 2);
    assert.match(result.stderr, /invalid_prompt_encoding/);
    assert.equal(result.stdout, "");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("run --json emits JSONL on stdout and approval help on stderr", async () => {
  const daemon = await startRunDaemon({
    events: [
      event(1, "run_start", { provider: "test", model: "mock", cwd: "/tmp/workspace" }),
      event(2, "approval_requested", {
        approvalId: "approval_1",
        actionType: "bash",
        risk: "medium",
        title: "Run tests",
      }),
      event(3, "assistant_text_delta", { text: "ok" }),
      event(4, "message_end", {}),
      event(5, "run_end", { taskId: "task_1" }),
    ],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  try {
    const result = await runCli(daemon.url, cwd, [
      "--json",
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "--prompt",
      "hello",
    ], "");

    assert.equal(result.code, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.ok(lines.length >= 2);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line));
    }
    assert.equal(JSON.parse(lines[0]).type, "ready");
    assert.doesNotMatch(result.stdout, /Approval requested|Run:/);
    assert.match(result.stderr, /Approval requested/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run default output writes assistant text to stdout and progress to stderr", async () => {
  const daemon = await startRunDaemon();
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  try {
    const result = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "--prompt", "hello"], "");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "ok\n");
    assert.match(result.stderr, /Run: run_1/);
    assert.match(result.stderr, /Run ended:/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run default output summarizes unified exec results without dumping shell output", async () => {
  const daemon = await startRunDaemon({
    events: [
      event(1, "tool_start", {
        toolCallId: "tool_bash_1",
        toolName: "bash",
        args: { command: "printf lots" },
      }),
      event(2, "tool_end", {
        toolCallId: "tool_bash_1",
        toolName: "bash",
        isError: false,
        result: {
          content: [{ type: "text", text: "Command exited 0 in 123ms." }],
          details: {
            unifiedExec: {
              status: "succeeded",
              toolCallId: "tool_bash_1",
              durationMs: 123,
              exitCode: 0,
              stdout: { preview: "very long shell output that should stay out of human progress", truncated: true },
              stderr: { preview: "", truncated: false },
            },
          },
        },
      }),
      event(3, "assistant_text_delta", { text: "ok" }),
      event(4, "message_end", {}),
      event(5, "run_end", { taskId: "task_1" }),
    ],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  try {
    const result = await runCli(daemon.url, cwd, ["run", "--provider", "provider_test", "--skip-preflight", "--prompt", "hello"], "");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, "ok\n");
    assert.match(result.stderr, /Tool end: bash ok Command exited 0 in 123ms\./);
    assert.doesNotMatch(result.stderr, /very long shell output/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run --output-last-message writes the last completed assistant message atomically", async () => {
  const daemon = await startRunDaemon({
    events: [
      event(1, "assistant_text_delta", { text: "first" }),
      event(2, "message_end", {}),
      event(3, "assistant_text_delta", { text: "second" }),
      event(4, "message_end", {}),
      event(5, "run_end", { taskId: "task_1" }),
    ],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  const outputPath = resolve(cwd, "answer.txt");
  try {
    const result = await runCli(daemon.url, cwd, [
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "--output-last-message",
      outputPath,
      "--prompt",
      "hello",
    ], "");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(await readFile(outputPath, "utf8"), "second");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run --output-last-message leaves existing file untouched on run failure", async () => {
  const daemon = await startRunDaemon({
    events: [
      event(1, "assistant_text_delta", { text: "partial" }),
      event(2, "run_error", { message: "failed" }),
    ],
  });
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  const outputPath = resolve(cwd, "answer.txt");
  try {
    await writeFile(outputPath, "previous", "utf8");
    const result = await runCli(daemon.url, cwd, [
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "--output-last-message",
      outputPath,
      "--prompt",
      "hello",
    ], "");
    assert.equal(result.code, 6);
    assert.equal(await readFile(outputPath, "utf8"), "previous");
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await daemon.close();
  }
});

test("run --output-last-message validates parent and requires a completed message", async () => {
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  try {
    const missingParent = await runCli("http://127.0.0.1:1", cwd, [
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "--output-last-message",
      resolve(cwd, "missing", "answer.txt"),
      "--prompt",
      "hello",
    ], "");
    assert.equal(missingParent.code, 2);
    assert.match(missingParent.stderr, /output_parent_missing/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }

  const daemon = await startRunDaemon({
    events: [
      event(1, "run_end", { taskId: "task_1" }),
    ],
  });
  const successCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-cli-run-io-"));
  const outputPath = resolve(successCwd, "answer.txt");
  try {
    await writeFile(outputPath, "previous", "utf8");
    const noMessage = await runCli(daemon.url, successCwd, [
      "run",
      "--provider",
      "provider_test",
      "--skip-preflight",
      "--output-last-message",
      outputPath,
      "--prompt",
      "hello",
    ], "");
    assert.equal(noMessage.code, 4);
    assert.match(noMessage.stderr, /no_final_message/);
    assert.equal(await readFile(outputPath, "utf8"), "previous");
  } finally {
    await rm(successCwd, { recursive: true, force: true });
    await daemon.close();
  }
});

function runCli(daemonUrl, cwd, args, input) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cliPath, "--daemon-url", daemonUrl, "--cwd", cwd, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("close", (code) => {
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}

async function startRunDaemon(options = {}) {
  const runRequests = [];
  const events = options.events ?? [
    event(1, "assistant_text_delta", { text: "ok" }),
    event(2, "message_end", {}),
    event(3, "run_end", { taskId: "task_1" }),
  ];
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/runs") {
      runRequests.push(await readJsonBody(request));
      writeSse(response, "run_1", events);
      return;
    }
    writeJson(response, 404, { error: "not_found" });
  });

  await new Promise((resolveListen) => {
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    runRequests,
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    }),
  };
}

function event(seq, type, data) {
  return {
    id: `evt_${seq}`,
    runId: "run_1",
    seq,
    ts: "2026-06-06T00:00:00.000Z",
    type,
    data,
  };
}

function writeSse(response, runId, events) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.write(`event: ready\ndata: ${JSON.stringify({ runId })}\n\n`);
  for (const envelope of events) {
    response.write(`event: run_event\ndata: ${JSON.stringify(envelope)}\n\n`);
  }
  response.end();
}

function readJsonBody(request) {
  return new Promise((resolveBody, rejectBody) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("error", rejectBody);
    request.on("end", () => {
      resolveBody(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    });
  });
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
