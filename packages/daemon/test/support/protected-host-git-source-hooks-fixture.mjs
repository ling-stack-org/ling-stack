import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";

/** Observed original physical producers, not OS Git/profile or descendant-closure evidence. Install before source imports. */
export function observeGitSourceProcesses(t) {
  const calls = [];
  let asyncHandler = defaultGitOutput, syncHandler = defaultGitOutput;
  const record = (kind, command, args, options) => {
    const call = { kind, command, args: [...args], options };
    calls.push(call);
    return call;
  };
  const asyncResult = (command, args, options) => {
    const stdout = asyncHandler(record("execFile", command, args, options));
    return { stdout, stderr: "" };
  };
  const originalExecFile = childProcess.execFile;
  const observedExecFile = (command, args, options, callback) => {
    const child = new EventEmitter();
    try {
      const result = asyncResult(command, args, options);
      queueMicrotask(() => callback(null, result.stdout, result.stderr));
    } catch (error) {
      queueMicrotask(() => callback(error, "", ""));
    }
    return child;
  };
  // The original execFile has this custom contract. Preserve stdout/stderr shape
  // for the production module's captured promisify, rather than changing its API.
  Object.defineProperty(observedExecFile, promisify.custom, { value: asyncResultPromise });
  childProcess.execFile = observedExecFile;
  function asyncResultPromise(command, args, options) {
    try { return Promise.resolve(asyncResult(command, args, options)); }
    catch (error) { return Promise.reject(error); }
  }
  const syncPatch = t.mock.method(childProcess, "execFileSync", (command, args, options) =>
    syncHandler(record("execFileSync", command, args, options)));
  const spawnPatch = t.mock.method(childProcess, "spawn", (command, args, options) => {
    record("spawn", command, args, options);
    const child = new EventEmitter();
    Object.assign(child, { pid: 56000 + calls.length, exitCode: null, signalCode: null,
      stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      unref() {}, kill() { return true; } });
    queueMicrotask(() => {
      child.emit("spawn");
      child.stdout.end("diff --git a/tracked.txt b/tracked.txt\n@@ -1 +1 @@\n-old\n+new\n");
      child.stderr.end(); child.exitCode = 0;
      child.emit("exit", 0, null); child.emit("close", 0, null);
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => {
    childProcess.execFile = originalExecFile;
    syncPatch.mock.restore(); spawnPatch.mock.restore(); syncBuiltinESMExports();
  });
  return { calls, setAsyncHandler(handler = defaultGitOutput) { asyncHandler = handler; },
    setSyncHandler(handler = defaultGitOutput) { syncHandler = handler; } };
}

function defaultGitOutput({ args, options }) {
  if (args[0] === "status") return "## main\0 M tracked.txt\0";
  if (args.includes("--show-toplevel")) return `${options.cwd}\n`;
  if (args.includes("--is-inside-work-tree")) return "true\n";
  if (args.includes("--numstat")) return "1\t1\ttracked.txt\n";
  if (args.includes("--name-only")) return "tracked.txt\n";
  if (args.includes("--stat")) return " tracked.txt | 2 +-\n 1 file changed, 1 insertion(+), 1 deletion(-)\n";
  if (args.includes("--abbrev-ref") || args[0] === "branch") return "main\n";
  if (args[0] === "rev-parse") return "abc123\n";
  if (args[0] === "rev-list") return "0\t1\n";
  if (args[0] === "log") return "abc123 fixture change\n";
  return "";
}
