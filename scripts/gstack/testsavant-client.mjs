import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, win32 } from "node:path";

export function testsavantNodePath(runtimeRoot, platform = process.platform) {
  const path = platform === "win32" ? win32 : { isAbsolute, join, resolve };
  if (typeof runtimeRoot !== "string" || !path.isAbsolute(runtimeRoot) || path.resolve(runtimeRoot) !== runtimeRoot ||
    platform === "win32" && !/^[a-z]:\\/i.test(runtimeRoot)) throw new Error("testsavant_runtime_root_invalid");
  return path.join(runtimeRoot, "tools", platform === "win32" ? "node.exe" : "node");
}

export async function verifyTestsavantExecutable(path, expected, maximumBytes = 256 * 1024 ** 2) {
  if (!/^sha256:[a-f0-9]{64}$/.test(expected ?? "")) throw new Error("testsavant_launch_pin_invalid");
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || await realpath(path) !== path || info.size > maximumBytes) throw new Error("testsavant_launch_file_invalid");
  const hash = createHash("sha256");
  let size = 0;
  for await (const part of createReadStream(path)) {
    size += part.length;
    if (size > maximumBytes) throw new Error("testsavant_launch_file_invalid");
    hash.update(part);
  }
  const after = await lstat(path);
  if (size !== info.size || after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) throw new Error("testsavant_launch_file_changed");
  if (`sha256:${hash.digest("hex")}` !== expected) throw new Error("testsavant_launch_content_mismatch");
}

export function testsavantChildEnvironment(env = process.env) {
  // No PATH interpreter fallback, preload injection, inherited auth or gs HOME.
  const output = {};
  for (const name of ["HOME", "USERPROFILE", "TMPDIR", "TMP", "TEMP", "SystemRoot", "WINDIR", "GSTACK_SECURITY_OFF"]) {
    if (env[name] !== undefined) output[name] = env[name];
  }
  return output;
}

export function validTestsavantVerdict(result) {
  const meta = result?.meta;
  if (result?.layer !== "testsavant_content" || !Number.isFinite(result.confidence)
    || result.confidence < 0 || result.confidence > 1 || meta?.coverage !== "complete"
    || meta.aggregation !== "maximum-window-score" || !Number.isInteger(meta.tokens)
    || meta.tokens < 1 || meta.tokens > 4096
    || meta.windows !== 1 + Math.max(0, Math.ceil((meta.tokens - 510) / 446))) return false;
  const verdicts = { safe: "safe", log_only: "safe", warn: "suspicious", block: "unsafe" };
  if (typeof meta.upstreamVerdict !== "string" || !Object.hasOwn(verdicts, meta.upstreamVerdict)
    || result.verdict !== verdicts[meta.upstreamVerdict]) return false;
  if (meta.label === "SAFE") return result.confidence === 0 && meta.upstreamVerdict === "safe"
    && Number.isFinite(meta.safeScore) && meta.safeScore >= 0.5 && meta.safeScore <= 1;
  // Frozen single TestSavant signal, toolOutput:true. Classifier labels are not
  // BLOCK decisions; retain the upstream 0.92/0.75/0.40 combiner thresholds.
  const expected = result.confidence >= 0.92 ? "block" : result.confidence >= 0.75 ? "warn"
    : result.confidence >= 0.4 ? "log_only" : "safe";
  return meta.label === "INJECTION" && result.confidence > 0.5 && meta.safeScore === undefined
    && meta.upstreamVerdict === expected;
}

export function createTestsavantClient({ runtimeRoot, modelRoot, entry, nodeChecksum, entryChecksum,
  startupTimeoutMs = 30000, scanTimeoutMs = 8000, idleMs = 60000, spawnProcess = spawn,
  nodeArguments = [], env = process.env } = {}) {
  for (const value of [startupTimeoutMs, scanTimeoutMs, idleMs]) {
    if (!Number.isInteger(value) || value < 1 || value > 120000) throw new Error("testsavant_limits_invalid");
  }
  const node = testsavantNodePath(runtimeRoot);
  for (const path of [modelRoot, entry]) if (typeof path !== "string" || !isAbsolute(path) || resolve(path) !== path) throw new Error("testsavant_launch_path_invalid");
  let current, warming = true, closed = false, active = 0, tail = Promise.resolve(), sequence = 0, failures = [], idle;
  const children = new Set();
  const parentExit = () => { for (const state of children) state.child.kill("SIGKILL"); };
  process.on("exit", parentExit);
  function fail(state, error) {
    if (!state || state.stopping) return;
    if (!state.failed) { state.failed = true; failures.push(Date.now()); }
    const pending = state.pending; state.pending = null;
    pending?.reject(error);
    stop(state);
  }
  function stop(state) {
    if (!state || state.stopping) return;
    state.stopping = true;
    if (current === state) { current = undefined; warming = true; }
    state.child.stdin.destroy(); state.child.kill("SIGTERM");
    state.killTimer = setTimeout(() => state.child.kill("SIGKILL"), 500);
    state.killTimer.unref();
  }
  async function launch() {
    if (current) return current;
    // Do not overlap native heaps while a timed-out/idle child is being reaped.
    await Promise.all([...children].map(state => state.terminal));
    failures = failures.filter(time => Date.now() - time < 600000);
    if (failures.length >= 3) throw new Error("testsavant_circuit_open");
    try {
      await verifyTestsavantExecutable(node, nodeChecksum);
      await verifyTestsavantExecutable(entry, entryChecksum, 2 * 1024 ** 2);
    } catch { failures.push(Date.now()); throw new Error("testsavant_launch_verification_failed"); }
    if (closed) throw new Error("testsavant_closed");
    let child;
    try {
      child = spawnProcess(node, ["--max-old-space-size=512", ...nodeArguments, entry, runtimeRoot, modelRoot], { shell: false, windowsHide: true,
        env: testsavantChildEnvironment(env), stdio: ["pipe", "pipe", "pipe"] });
    } catch { failures.push(Date.now()); throw new Error("testsavant_spawn_failed"); }
    const state = { child, buffer: "", pending: null, stopping: false, stderrBytes: 0 };
    children.add(state); current = state;
    state.terminal = new Promise(resolve => child.once("close", () => {
      clearTimeout(state.killTimer); children.delete(state);
      if (current === state) { current = undefined; warming = true; }
      if (!state.stopping && !state.failed) { state.failed = true; failures.push(Date.now()); }
      state.pending?.reject(new Error("testsavant_worker_exited")); resolve();
    }));
    const protocolFailure = () => fail(state, new Error("testsavant_protocol_invalid"));
    child.once("error", () => fail(state, new Error("testsavant_spawn_failed")));
    child.stdin.on("error", protocolFailure);
    child.stderr.on("data", bytes => { state.stderrBytes += bytes.length; if (state.stderrBytes > 65536) protocolFailure(); });
    child.stdout.on("data", bytes => {
      state.buffer += bytes.toString("utf8");
      if (Buffer.byteLength(state.buffer) > 65536) { protocolFailure(); return; }
      let index;
      while ((index = state.buffer.indexOf("\n")) !== -1) {
        const line = state.buffer.slice(0, index); state.buffer = state.buffer.slice(index + 1);
        let value;
        try { value = JSON.parse(line); } catch { protocolFailure(); return; }
        if (!value || typeof value !== "object" || Array.isArray(value) || !state.pending
          || value.id !== state.pending.id || typeof value.ok !== "boolean" ||
          value.networkAudit?.pid !== child.pid || value.networkAudit?.attempts !== 0) { protocolFailure(); return; }
        const pending = state.pending; state.pending = null;
        if (value.ok) pending.resolve(value);
        else if (value.error === "testsavant_token_budget_exceeded") {
          warming = false;
          pending.reject(new Error(value.error));
        } else { pending.reject(new Error("testsavant_unavailable")); fail(state, new Error("testsavant_unavailable")); }
      }
    });
    return state;
  }
  async function request(text, { signal, timeoutMs } = {}) {
    if (signal?.aborted) throw new Error("testsavant_cancelled");
    const state = await launch();
    return new Promise((resolve, reject) => {
      const finish = (fn, value) => { clearTimeout(timer); signal?.removeEventListener("abort", cancel); fn(value); };
      const cancel = () => { state.pending = null; stop(state); finish(reject, new Error("testsavant_cancelled")); };
      const timer = setTimeout(() => {
        fail(state, new Error("testsavant_timeout"));
      }, warming ? startupTimeoutMs : timeoutMs ?? scanTimeoutMs);
      const id = String(++sequence);
      state.pending = { id, resolve: value => finish(resolve, value), reject: error => finish(reject, error) };
      signal?.addEventListener("abort", cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      try { state.child.stdin.write(`${JSON.stringify({ id, op: "scan-page-content", text })}\n`); }
      catch { fail(state, new Error("testsavant_write_failed")); }
    });
  }
  return {
    async scan(text, options = {}) {
      if (closed) throw new Error("testsavant_closed");
      if (typeof text !== "string" || !text.trim() || text.length > 32768 || Buffer.byteLength(text) > 65536) throw new Error("testsavant_text_invalid");
      if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000)) throw new Error("testsavant_limits_invalid");
      if (active >= 2) throw new Error("testsavant_queue_full");
      active++; clearTimeout(idle);
      const run = tail.then(async () => {
        if (closed) throw new Error("testsavant_closed");
        const value = await request(text, options);
        const result = value.verdict;
        if (!validTestsavantVerdict(result)) {
          fail(current, new Error("testsavant_verdict_invalid")); throw new Error("testsavant_verdict_invalid");
        }
        warming = false; return { verdict: { ...result, meta: { ...result.meta, networkAudit: value.networkAudit } } };
      });
      tail = run.catch(() => {});
      try { return await run; }
      finally {
        active--;
        if (!active && !closed) { idle = setTimeout(() => stop(current), idleMs); idle.unref(); }
      }
    },
    async close() {
      if (closed) return;
      closed = true; clearTimeout(idle);
      for (const state of children) { state.pending?.reject(new Error("testsavant_closed")); stop(state); }
      await tail;
      await Promise.all([...children].map(state => state.terminal));
      process.off("exit", parentExit);
    },
  };
}
