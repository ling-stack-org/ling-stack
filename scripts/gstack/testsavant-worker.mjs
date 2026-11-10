import { createTestsavantClassifier, testsavantSignal } from "./testsavant-runtime.mjs";

export function testsavantRouteVerdict(combined) {
  const verdict = { safe: "safe", log_only: "safe", warn: "suspicious", block: "unsafe" }[combined.verdict];
  if (!verdict) throw new Error("testsavant_verdict_invalid");
  return verdict;
}

// A bounded replacement for the upstream NDJSON host. Only the managed parent
// writes stdin; model/native initialization remains lazy and process-local.
export function runTestsavantWorker(combineVerdict, options = {}) {
  const [runtimeRoot, modelRoot] = process.argv.slice(2);
  let classifier, loading, failed = false, active = false, ending = false, buffer = Buffer.alloc(0), queue = [];
  const write = value => process.stdout.write(`${JSON.stringify({ ...value, networkAudit: {
    pid: process.pid, attempts: globalThis[Symbol.for("ling.testsavant.network-denial.v1")]?.attempts ?? null,
  } })}\n`);
  const error = (id, code) => write({ id, ok: false, error: code });
  let exiting;
  function exit(code = 0) {
    if (exiting) return;
    exiting = true;
    // Native inference cannot be safely interrupted in-process. The parent
    // deadline escalates to kill; EOF/signals never leave an orphan worker.
    if (active || loading && !classifier) process.exit(code);
    Promise.resolve(classifier?.close()).finally(() => process.exit(code));
  }
  async function pump() {
    if (active || !queue.length) { if (ending && !active) exit(); return; }
    const req = queue.shift(); active = true;
    try {
      if (process.env.GSTACK_SECURITY_OFF === "1") throw new Error("testsavant_disabled");
      loading ??= (options.createClassifier ?? createTestsavantClassifier)({ runtimeRoot, modelRoot });
      classifier = await loading;
      const result = await classifier.scanDocument(req.text), signal = testsavantSignal(result);
      const combined = combineVerdict([signal], { toolOutput: true });
      write({ id: req.id, ok: true, verdict: { ...signal, verdict: testsavantRouteVerdict(combined),
        meta: { ...signal.meta, upstreamVerdict: combined.verdict } } });
    } catch (err) {
      // An oversized document is unavailable, not a broken inference worker.
      if (err?.message !== "testsavant_token_budget_exceeded") failed = true;
      error(req.id, typeof err?.message === "string" && /^testsavant_[a-z_]+$/.test(err.message) ? err.message : "testsavant_unavailable");
    } finally { active = false; void pump(); }
  }
  function line(bytes) {
    if (!bytes.length) return;
    let req;
    try { req = JSON.parse(bytes.toString("utf8")); } catch { error("<malformed>", "malformed-json"); return; }
    if (!req || typeof req.id !== "string" || !req.id || req.id.length > 64) { error("<malformed>", "invalid-id"); return; }
    if (req.op === "ping") { write({ id: req.id, ok: true, verdict: { layer: "ping", verdict: "alive", score: 0 } }); return; }
    if (req.op === "status") {
      write({ id: req.id, ok: true, status: { testsavant: failed ? "degraded" : classifier ? "ok" : "off" } }); return;
    }
    if (req.op !== "scan-page-content") { error(req.id, "unknown-op"); return; }
    if (typeof req.text !== "string" || !req.text.trim()) { error(req.id, "missing-text"); return; }
    if (Buffer.byteLength(req.text) > 65536 || req.text.length > 32768) { error(req.id, "payload-too-large"); return; }
    if (queue.length + Number(active) >= 2) { error(req.id, "queue-full"); return; }
    queue.push(req); void pump();
  }
  process.stdin.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    let index;
    while ((index = buffer.indexOf(10)) !== -1) {
      if (index > 400000) { error("<malformed>", "payload-too-large"); exit(1); return; }
      line(buffer.subarray(0, index)); buffer = buffer.subarray(index + 1);
    }
    if (buffer.length > 400000) { error("<malformed>", "payload-too-large"); exit(1); }
  });
  process.stdin.on("end", () => {
    if (buffer.length) line(buffer);
    buffer = Buffer.alloc(0); ending = true; void pump();
  });
  process.stdin.on("error", () => exit(1));
  process.stdout.on("error", () => exit(1));
  process.on("SIGTERM", () => exit()); process.on("SIGINT", () => exit());
}
