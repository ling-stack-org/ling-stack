import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  selectWorkspaceDirectory,
  WorkspaceDirectoryPickerError,
} from "../dist/features/workspace-directory/directory-picker.js";
import {
  getWorkspaceTerminalProfile,
  runWorkspaceTerminalCommand,
  WorkspaceTerminalCommandError,
} from "../dist/features/workspace-directory/terminal-runner.js";

test("workspace directory picker returns a normalized selected directory", async () => {
  const response = await selectWorkspaceDirectory({
    platform: "darwin",
    defaultPath: "/tmp",
    execFileImpl: async (file, args) => {
      assert.equal(file, "osascript");
      assert.match(args.join("\n"), /choose folder/);
      return { stdout: "/tmp/ling-project/\n", stderr: "" };
    },
    statImpl: async () => ({ isDirectory: () => true }),
  });

  assert.deepEqual(response, {
    cancelled: false,
    path: "/tmp/ling-project",
    label: "ling-project",
  });
});

test("workspace directory picker treats native cancellation as a non-error", async () => {
  const response = await selectWorkspaceDirectory({
    platform: "darwin",
    execFileImpl: async () => {
      const error = new Error("User canceled.");
      error.stderr = "User canceled.";
      throw error;
    },
    statImpl: async () => {
      assert.fail("cancelled selections should not be statted");
    },
  });

  assert.deepEqual(response, { cancelled: true });
});

test("workspace directory picker rejects non-directory selections", async () => {
  await assert.rejects(
    () => selectWorkspaceDirectory({
      platform: "darwin",
      execFileImpl: async () => ({ stdout: "/tmp/file.txt\n", stderr: "" }),
      statImpl: async () => ({ isDirectory: () => false }),
    }),
    (error) => error instanceof WorkspaceDirectoryPickerError
      && error.code === "directory_picker_invalid_selection"
      && error.statusCode === 400,
  );
});

test("workspace directory picker reports unsupported platforms", async () => {
  await assert.rejects(
    () => selectWorkspaceDirectory({
      platform: "freebsd",
      execFileImpl: async () => ({ stdout: "", stderr: "" }),
    }),
    (error) => error instanceof WorkspaceDirectoryPickerError
      && error.code === "directory_picker_unsupported"
      && error.statusCode === 501,
  );
});

test("workspace terminal runner executes a command in the workspace directory", async () => {
  const recorder = createCommandSpawnRecorder({ stdout: "/tmp/ling-stack\n" });
  const response = await runWorkspaceTerminalCommand({
    cwd: "/tmp/ling-stack",
    command: "pwd",
    platform: "darwin",
    spawnImpl: recorder.spawnImpl,
    statImpl: async () => ({ isDirectory: () => true }),
    now: createNowSequence([
      "2026-07-02T00:00:00.000Z",
      "2026-07-02T00:00:00.120Z",
    ]),
    idFactory: () => "terminal-command-1",
  });

  assert.deepEqual(response, {
    id: "terminal-command-1",
    cwd: "/tmp/ling-stack",
    command: "pwd",
    status: "succeeded",
    exitCode: 0,
    signal: undefined,
    stdout: "/tmp/ling-stack\n",
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    startedAt: "2026-07-02T00:00:00.000Z",
    completedAt: "2026-07-02T00:00:00.120Z",
    durationMs: 120,
  });
  assert.equal(recorder.calls.length, 1);
  assert.equal(recorder.calls[0].command, "/bin/zsh");
  assert.deepEqual(recorder.calls[0].args, ["-lc", "pwd"]);
  assert.equal(recorder.calls[0].options.cwd, "/tmp/ling-stack");
});

test("workspace terminal profile reports user host and workspace prompt", async () => {
  const profile = await getWorkspaceTerminalProfile({
    cwd: "/Users/example/ling-stack",
    platform: "darwin",
    statImpl: async () => ({ isDirectory: () => true }),
    userInfoImpl: () => ({ username: "tianxiao" }),
    hostnameImpl: () => "tianxiaodeMacBook-Pro.local",
  });

  assert.deepEqual(profile, {
    cwd: "/Users/example/ling-stack",
    workspaceLabel: "ling-stack",
    promptLabel: "tianxiao@tianxiaodeMacBook-Pro ling-stack %",
    username: "tianxiao",
    hostname: "tianxiaodeMacBook-Pro",
    shell: "/bin/zsh",
  });
});

test("workspace terminal runner reports failed commands without throwing", async () => {
  const recorder = createCommandSpawnRecorder({ stderr: "nope\n", code: 2 });
  const response = await runWorkspaceTerminalCommand({
    cwd: "/repo/ling-stack",
    command: "false",
    platform: "linux",
    spawnImpl: recorder.spawnImpl,
    statImpl: async () => ({ isDirectory: () => true }),
    idFactory: () => "terminal-command-2",
  });

  assert.equal(response.status, "failed");
  assert.equal(response.exitCode, 2);
  assert.equal(response.stderr, "nope\n");
});

test("workspace terminal runner rejects non-directory workspaces", async () => {
  await assert.rejects(
    () => runWorkspaceTerminalCommand({
      cwd: "/tmp/file.txt",
      command: "pwd",
      statImpl: async () => ({ isDirectory: () => false }),
    }),
    (error) => error instanceof WorkspaceTerminalCommandError
      && error.code === "terminal_command_invalid_directory"
      && error.statusCode === 400,
  );
});

test("workspace terminal runner rejects empty commands", async () => {
  await assert.rejects(
    () => runWorkspaceTerminalCommand({
      cwd: "/tmp/ling-stack",
      command: " ",
      statImpl: async () => ({ isDirectory: () => true }),
    }),
    (error) => error instanceof WorkspaceTerminalCommandError
      && error.code === "terminal_command_invalid_input"
      && error.statusCode === 400,
  );
});

function createCommandSpawnRecorder({ stdout = "", stderr = "", code = 0 } = {}) {
  const calls = [];
  return {
    calls,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = () => true;
      process.nextTick(() => {
        child.emit("spawn");
        child.stdout.write(stdout);
        child.stdout.end();
        child.stderr.write(stderr);
        child.stderr.end();
        child.emit("close", code, null);
      });
      return child;
    },
  };
}

function createNowSequence(values) {
  const dates = values.map((value) => new Date(value));
  return () => dates.shift() ?? new Date(values.at(-1));
}
