import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { test } from "node:test";
import { createSqliteRunStore, resolveStoragePaths } from "../../core/dist/index.js";
import { createDaemonServer } from "../dist/index.js";

test("repo-local run startup creates a missing state root for first-run compatibility", async () => {
  const defaultCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-default-"));
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-first-run-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(defaultCwd, runner);
  try {
    const { runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_repo_local_first_run"));

    assert.ok(runId);
    assert.equal(runner.runs.length, 1);
    await access(resolve(cwd, ".ling-stack", "ling-stack.sqlite"), fsConstants.F_OK);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(defaultCwd, { recursive: true, force: true });
  }
});

test("repo-local run startup blocks before runner start when state root is not writable", async () => {
  const defaultCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-default-"));
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-root-file-"));
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(defaultCwd, runner);
  try {
    await writeFile(resolve(cwd, ".ling-stack"), "not a directory", "utf8");

    const blocked = await postRunExpectError(daemon.url, runBody(cwd, "task_repo_local_state_root_file"));

    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "workspace_state_not_writable");
    assert.match(blocked.body.message, /Workspace state root is not writable|Workspace state root is not a directory/);
    assert.equal(runner.runs.length, 0);
  } finally {
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(defaultCwd, { recursive: true, force: true });
  }
});

test("user-data-dir run startup blocks when the selected state root is missing", async () => {
  const defaultCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-default-"));
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-missing-user-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-missing-user-root-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const runner = new RecordingRunner();
  const daemon = await startDaemonForTest(defaultCwd, runner);
  try {
    await writeUserDataDirPointer(cwd);
    const paths = resolveStoragePaths(cwd, {
      userRootDir: userRoot,
      workspaceStateLocation: "user-data-dir",
    }).workspace;

    const blocked = await postRunExpectError(daemon.url, runBody(cwd, "task_user_data_root_missing"));

    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.error, "workspace_state_missing");
    assert.match(blocked.body.message, /Workspace state root is missing/);
    await assert.rejects(access(paths.rootDir, fsConstants.F_OK));
    assert.equal(runner.runs.length, 0);
  } finally {
    restoreLingStackHome(previousLingStackHome);
    await daemon.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(defaultCwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

test("user-data-dir run startup does not require the repo cwd to be writable", async (t) => {
  const defaultCwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-default-"));
  const cwd = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-readonly-user-cwd-"));
  const userRoot = await mkdtemp(resolve(tmpdir(), "ling-stack-daemon-state-readonly-user-root-"));
  const previousLingStackHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = userRoot;
  const runner = new RecordingRunner();
  let daemon;
  try {
    await writeUserDataDirPointer(cwd);
    const paths = resolveStoragePaths(cwd, {
      userRootDir: userRoot,
      workspaceStateLocation: "user-data-dir",
    }).workspace;
    const store = createSqliteRunStore(cwd, paths);
    store.close();

    await chmod(cwd, 0o555);
    if (await isWritable(cwd)) {
      t.skip("filesystem permissions still report the cwd as writable");
      return;
    }

    daemon = await startDaemonForTest(defaultCwd, runner);
    const { events, runId } = await postRunAndCollectEvents(daemon.url, runBody(cwd, "task_user_data_readonly_cwd"));

    assert.ok(runId);
    assert.equal(runner.runs.length, 1, JSON.stringify(events));
    assert.equal(runner.runs[0].cwd, cwd);
  } finally {
    restoreLingStackHome(previousLingStackHome);
    await chmod(cwd, 0o755).catch(() => undefined);
    await daemon?.close();
    await rm(cwd, { recursive: true, force: true });
    await rm(defaultCwd, { recursive: true, force: true });
    await rm(userRoot, { recursive: true, force: true });
  }
});

class RecordingRunner {
  constructor() {
    this.runs = [];
  }

  async runTask(options) {
    this.runs.push(options);
    options.onEvent?.({
      type: "run_start",
      taskId: options.task.id,
      provider: options.provider.provider,
      model: options.provider.model,
    });
    options.onEvent?.({
      type: "run_end",
      taskId: options.task.id,
      messageCount: 1,
    });
    return {
      taskId: options.task.id,
      events: [],
      messages: [{ role: "assistant", content: "done" }],
    };
  }
}

async function startDaemonForTest(defaultWorkspaceCwd, runner) {
  const daemon = createDaemonServer({
    host: "127.0.0.1",
    port: 0,
    defaultWorkspaceCwd,
  }, {
    runner,
  });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => daemon.stop(),
  };
}

function runBody(cwd, taskId) {
  return {
    cwd,
    task: {
      id: taskId,
      title: taskId,
      prompt: "Run storage preflight test.",
    },
    provider: {
      provider: "test-provider",
      model: "test-model",
    },
    tools: ["read"],
    thinkingLevel: "off",
  };
}

async function writeUserDataDirPointer(cwd) {
  await mkdir(resolve(cwd, ".ling-stack"), { recursive: true });
  await writeFile(resolve(cwd, ".ling-stack", "config.json"), JSON.stringify({
    schemaVersion: 1,
    product: "ling-stack",
    workspaceStateLocation: "user-data-dir",
    createdBy: "workspace-state-storage test pointer",
  }, null, 2), "utf8");
}

async function postRunExpectError(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.notEqual(response.status, 200, text);
  return {
    status: response.status,
    body: text.trim() ? JSON.parse(text) : {},
  };
}

async function postRunAndCollectEvents(baseUrl, body) {
  const response = await fetch(`${baseUrl}/runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    assert.fail(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  const events = parseSseText(await response.text());
  return {
    events,
    runId: events.find((event) => event.event === "ready")?.data.runId,
  };
}

function parseSseText(text) {
  const events = [];
  for (const block of text.trim().split(/\n\n+/)) {
    if (!block.trim()) {
      continue;
    }
    let event = "message";
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trim());
      }
    }
    if (dataLines.length > 0) {
      events.push({ event, data: JSON.parse(dataLines.join("\n")) });
    }
  }
  return events;
}

async function isWritable(path) {
  try {
    await access(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function restoreLingStackHome(previousLingStackHome) {
  if (previousLingStackHome === undefined) {
    delete process.env.LING_STACK_HOME;
  } else {
    process.env.LING_STACK_HOME = previousLingStackHome;
  }
}
