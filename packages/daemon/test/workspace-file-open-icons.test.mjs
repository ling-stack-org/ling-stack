import assert from "node:assert/strict";
import test from "node:test";
import { createWorkspaceFileOpenIconLoader } from "../dist/features/previews/workspace-file-open-icons.js";

test("workspace file open icons convert the installed macOS application icon once and cache it", async () => {
  const applicationPath = "/Applications/Visual Studio Code.app";
  const iconPath = `${applicationPath}/Contents/Resources/Code.icns`;
  const temporaryPath = "/tmp/ling-stack-open-icon-test";
  const png = Buffer.from("mock-png");
  const commands = [];
  const removed = [];
  const runtime = {
    platform: "darwin",
    homeDirectory: () => "/Users/test",
    temporaryDirectory: () => "/tmp",
    stat: async (path) => {
      if (path === applicationPath) {
        return fileStat({ directory: true, mtimeMs: 10 });
      }
      if (path === iconPath) {
        return fileStat({ file: true, mtimeMs: 20 });
      }
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
    readdir: async () => [],
    readFile: async (path) => {
      assert.equal(path, `${temporaryPath}/Code.png`);
      return png;
    },
    mkdtemp: async (prefix) => {
      assert.equal(prefix, "/tmp/ling-stack-open-icon-");
      return temporaryPath;
    },
    rm: async (path) => {
      removed.push(path);
    },
    execFile: async (command, args) => {
      commands.push({ command, args: [...args] });
      if (command === "/usr/bin/plutil") {
        return { stdout: JSON.stringify({ CFBundleIconFile: "Code.icns" }), stderr: "" };
      }
      if (command === "/usr/bin/sips") {
        assert.deepEqual(args, [
          "-s",
          "format",
          "png",
          "-z",
          "64",
          "64",
          iconPath,
          "--out",
          `${temporaryPath}/Code.png`,
        ]);
        return { stdout: "converted", stderr: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };
  const loadIcon = createWorkspaceFileOpenIconLoader(runtime);

  const first = await loadIcon("vscode");
  const second = await loadIcon("vscode");

  assert.deepEqual(first?.bytes, png);
  assert.equal(first?.etag, second?.etag);
  assert.equal(commands.filter((call) => call.command === "/usr/bin/plutil").length, 1);
  assert.equal(commands.filter((call) => call.command === "/usr/bin/sips").length, 1);
  assert.deepEqual(removed, [temporaryPath]);
});

test("workspace file open icons use Spotlight discovery after direct bundle candidates miss", async () => {
  const applicationPath = "/opt/apps/PyCharm.app";
  const iconPath = `${applicationPath}/Contents/Resources/pycharm.icns`;
  const commands = [];
  const runtime = {
    platform: "darwin",
    homeDirectory: () => "/Users/test",
    temporaryDirectory: () => "/tmp",
    stat: async (path) => {
      if (path === applicationPath) {
        return fileStat({ directory: true, mtimeMs: 10 });
      }
      if (path === iconPath) {
        return fileStat({ file: true, mtimeMs: 20 });
      }
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
    readdir: async () => [],
    readFile: async () => Buffer.from("pycharm-png"),
    mkdtemp: async () => "/tmp/ling-stack-open-icon-pycharm",
    rm: async () => undefined,
    execFile: async (command, args) => {
      commands.push({ command, args: [...args] });
      if (command === "/usr/bin/mdfind") {
        return { stdout: `${applicationPath}\n`, stderr: "" };
      }
      if (command === "/usr/bin/plutil") {
        return { stdout: JSON.stringify({ CFBundleIconFile: "pycharm" }), stderr: "" };
      }
      if (command === "/usr/bin/sips") {
        return { stdout: "converted", stderr: "" };
      }
      throw new Error(`unexpected command: ${command}`);
    },
  };

  const icon = await createWorkspaceFileOpenIconLoader(runtime)("pycharm");

  assert.deepEqual(icon?.bytes, Buffer.from("pycharm-png"));
  assert.equal(commands[0]?.command, "/usr/bin/mdfind");
  assert.match(commands[0]?.args[0] ?? "", /com\.jetbrains\.pycharm/u);
});

test("workspace file open icons keep non-editor targets and unsupported platforms on fallback icons", async () => {
  let touched = false;
  const runtime = {
    platform: "linux",
    homeDirectory: () => "/home/test",
    temporaryDirectory: () => "/tmp",
    stat: async () => {
      touched = true;
      throw new Error("unexpected stat");
    },
    readdir: async () => [],
    readFile: async () => Buffer.alloc(0),
    mkdtemp: async () => "/tmp/icon",
    rm: async () => undefined,
    execFile: async () => {
      touched = true;
      return { stdout: "", stderr: "" };
    },
  };

  const linuxLoader = createWorkspaceFileOpenIconLoader(runtime);
  assert.equal(await linuxLoader("vscode"), undefined);
  assert.equal(touched, false);

  const macLoader = createWorkspaceFileOpenIconLoader({ ...runtime, platform: "darwin" });
  assert.equal(await macLoader("finder"), undefined);
  assert.equal(await macLoader("terminal"), undefined);
  assert.equal(touched, false);
});

function fileStat({ directory = false, file = false, mtimeMs = 0 }) {
  return {
    mtimeMs,
    isDirectory: () => directory,
    isFile: () => file,
  };
}
