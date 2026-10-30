import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.argv.length !== 3 || process.argv[2] !== "--run-isolated-probe") {
  throw new Error("Disabled by default: measure.mjs --run-isolated-probe");
}
// Set the disposable scope before loading modules that resolve Ling paths.
const root = await mkdtemp(join(tmpdir(), "ling-read-scheduling-"));
await chmod(root, 0o700);
const cwd = join(root, "workspace"), lingHome = join(root, "ling-home");
await mkdir(cwd, { mode: 0o700 });
await mkdir(lingHome, { mode: 0o700 });
process.env.LING_STACK_HOME = lingHome;
process.env.LING_STACK_DEFAULT_WORKSPACE_CWD = cwd;
const { createSqliteRunStore } = await import("@ling-stack/core");
const { createDaemonServer } = await import("../../dist/index.js");
let store, modelCalls = 0;
const daemon = createDaemonServer({ defaultWorkspaceCwd: cwd, port: 0, channels: { terminalReports: false } }, {
  runner: { async runTask() { modelCalls++; throw new Error("No model execution in read probe"); } },
  secretResolver: {
    resolve: ref => ({ ref, kind: "env", configured: false, errorCode: "secret_missing" }),
    status: ref => ({ ref, kind: "env", configured: false, errorCode: "secret_missing" }),
  },
  storeFactory: path => { assert.equal(path, cwd); store = createSqliteRunStore(path); return store; },
});
const counts = new Map();
let inflight = 0, peakInflight = 0;
daemon.server.on("request", (request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  counts.set(path, (counts.get(path) ?? 0) + 1);
  inflight++;
  peakInflight = Math.max(peakInflight, inflight);
  let finished = false;
  const finish = () => { if (!finished) { finished = true; inflight--; } };
  response.once("finish", finish);
  response.once("close", finish);
});
try {
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`;
  async function get(path) {
    const began = performance.now();
    const response = await fetch(`${baseUrl}${path}?cwd=${encodeURIComponent(cwd)}`, {
      redirect: "error", signal: AbortSignal.timeout(5000),
    });
    const body = await response.json();
    assert.equal(response.status, 200, JSON.stringify(body));
    return performance.now() - began;
  }
  await get("/runtime");
  const now = new Date().toISOString();
  const thread = store.createLingThread({ kind: "conversation", teammateId: "ling_agent",
    title: "Read scheduling probe", objective: "Synthetic history; no execution" }, now);
  for (let index = 0; index < 48; index++) {
    const body = `Synthetic history ${index}: ${"bounded local read ".repeat(32)}`;
    store.appendConversationUserTurn({ threadId: thread.id, title: `Read ${index}`, userInstruction: body,
      payload: { body, format: "markdown", mentions: [], attachmentIds: [], linkPreviewIds: [], fileRefs: [] },
      idempotencyKey: `read-probe-${index}` }, now);
  }
  const foregroundPath = `/conversations/${encodeURIComponent(thread.id)}`;
  const backgroundPath = "/teammates";
  await get(foregroundPath);
  await get(backgroundPath);
  const rounds = 30, results = [];
  // Reverse the order in round two; this is exploratory, not a significance test.
  for (const order of [["foreground-only", "four-background-consumers"], ["four-background-consumers", "foreground-only"]]) {
    for (const mode of order) {
      counts.clear(); peakInflight = 0;
      const foreground = [], background = [];
      const workers = mode === "four-background-consumers" ? 4 : 0;
      const foregroundRun = (async () => { for (let n = 0; n < rounds; n++) foreground.push(await get(foregroundPath)); })();
      const backgroundRuns = Array.from({ length: workers }, async () => {
        for (let n = 0; n < rounds; n++) background.push(await get(backgroundPath));
      });
      const settled = await Promise.allSettled([foregroundRun, ...backgroundRuns]);
      for (const result of settled) if (result.status === "rejected") throw result.reason;
      assert.equal(counts.get(foregroundPath), rounds);
      assert.equal(counts.get(backgroundPath) ?? 0, rounds * workers);
      results.push({ mode, foreground: summary(foreground), background: summary(background),
        requests: { foreground: counts.get(foregroundPath), background: counts.get(backgroundPath) ?? 0 }, peakInflight });
    }
  }
  assert.equal(modelCalls, 0);
  const sourceSha256 = {};
  for (const name of ["index.js", "features/conversations/routes.js", "features/teammates/routes.js"])
    sourceSha256[`packages/daemon/dist/${name}`] = digest(await readFile(new URL(`../../dist/${name}`, import.meta.url)));
  sourceSha256["packages/daemon/experiments/read-scheduling/measure.mjs"] = digest(await readFile(new URL(import.meta.url)));
  const report = { kind: "isolated-real-daemon-synthetic-read-load", timestamp: new Date().toISOString(),
    platform: process.platform, architecture: process.arch, node: process.version, historyItems: 48,
    endpoints: { foreground: "/conversations/:threadId", background: backgroundPath },
    sourceSha256, results, modelCalls,
    limitations: ["Synthetic consumers do not measure actual UI duplicate demand.",
      "Client elapsed includes transport, queue, projection and JSON parsing; queue time is not isolated.",
      "Concurrent suite activity and a warm OS cache can affect these local samples.",
      "No global cache, single-flight, priority queue or production configuration is enabled.",
      "Private timeline GET also creates its thread and flushes governance notifications; it is not a pure metadata candidate."] };
  await writeFile(join(root, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ...report, evidenceDirectory: root }, null, 2)}\n`);
} finally {
  if (daemon.server.listening) await daemon.stop();
  // Keep the report and failure evidence; only this owned disposable DB/home is removed after drain.
  await rm(cwd, { recursive: true, force: true });
  await rm(lingHome, { recursive: true, force: true });
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
function summary(values) {
  if (!values.length) return { count: 0 };
  const sorted = [...values].sort((a, b) => a - b);
  return { count: values.length, minMs: sorted[0], medianMs: sorted[Math.floor(sorted.length / 2)],
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1], maxMs: sorted.at(-1) };
}
