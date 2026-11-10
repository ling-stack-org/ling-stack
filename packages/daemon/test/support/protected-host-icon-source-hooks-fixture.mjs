import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { promisify } from "node:util";

/**
 * Default-runtime dependencies, not a substitute IconRuntime. Original native
 * producer placement is observed without starting plutil/mdfind/sips; temporary
 * directories are actually created and removed by the original finally path.
 */
export function observeDefaultIconDependencies(t) {
  const calls = [], temporaries = [], removed = [], original = {
    execFile: childProcess.execFile, stat: fs.stat, readdir: fs.readdir, readFile: fs.readFile,
    mkdtemp: fs.mkdtemp, rm: fs.rm,
  };
  let state, revision = 0;
  const notFound = () => Object.assign(new Error("fixture icon not found"), { code: "ENOENT" });
  const execute = (command, args, options) => {
    const call = { command, args: [...args], options }; calls.push(call);
    state.afterProducer?.(call);
    if (state.failCommand === command) throw state.failure;
    if (command === "/usr/bin/mdfind") return { stdout: `${state.applicationPath}\n`, stderr: "" };
    if (command === "/usr/bin/plutil") return { stdout: JSON.stringify({ CFBundleIconFile: "fixture.icns" }), stderr: "" };
    if (command === "/usr/bin/sips") return { stdout: "fixture converted", stderr: "" };
    throw new Error(`unexpected original icon producer ${command}`);
  };
  const execFile = (command, args, options, callback) => {
    const child = new EventEmitter();
    try { const result = execute(command, args, options); queueMicrotask(() => callback(null, result.stdout, result.stderr)); }
    catch (error) { queueMicrotask(() => callback(error, "", "")); }
    return child;
  };
  Object.defineProperty(execFile, promisify.custom, { value: async (...args) => execute(...args) });
  childProcess.execFile = execFile;
  const patches = [
    t.mock.method(fs, "stat", async path => {
      if (state && path === state.applicationPath) return fileStat({ directory: true, mtimeMs: state.revision });
      if (state && path === state.iconPath) return fileStat({ file: true, mtimeMs: state.revision });
      if (typeof path === "string" && path.endsWith(".app")) throw notFound();
      return original.stat(path);
    }),
    t.mock.method(fs, "readdir", async path => {
      if (state && path === join(state.applicationPath, "Contents", "Resources")) {
        state.directoryReads += 1; return ["fixture.icns"];
      }
      return original.readdir(path);
    }),
    t.mock.method(fs, "readFile", async path => {
      if (state && temporaries.some(directory => path === join(directory, "fixture.png"))) {
        state.outputReads += 1; return Buffer.from("source-placement-only-png");
      }
      return original.readFile(path);
    }),
    t.mock.method(fs, "mkdtemp", async prefix => {
      const path = await original.mkdtemp(prefix); temporaries.push(path); return path;
    }),
    t.mock.method(fs, "rm", async (path, options) => {
      removed.push(path); return original.rm(path, options);
    }),
  ];
  syncBuiltinESMExports();
  t.after(async () => {
    childProcess.execFile = original.execFile;
    for (const patch of patches) patch.mock.restore();
    syncBuiltinESMExports();
    for (const path of temporaries) await original.rm(path, { recursive: true, force: true });
  });
  return { calls, temporaries, removed, configure({ applicationName = "Visual Studio Code", discovery = false, ...options } = {}) {
    const applicationPath = join(discovery ? "/fixture/spotlight" : "/Applications", `${applicationName}.app`);
    state = { applicationPath, iconPath: join(applicationPath, "Contents", "Resources", "fixture.icns"),
      revision: ++revision, directoryReads: 0, outputReads: 0, failure: new Error("ordinary icon producer failure"), ...options };
    return state;
  } };
}

function fileStat({ directory = false, file = false, mtimeMs }) {
  return { mtimeMs, isDirectory: () => directory, isFile: () => file };
}
