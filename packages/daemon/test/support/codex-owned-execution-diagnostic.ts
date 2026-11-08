import type { ChildProcess } from "node:child_process";
import type { TestContext } from "node:test";

type Phase = "fixture_setup" | "sqlite_init" | "fixture_records" | "fixture_node_read" | "fixture_node_hash"
  | "fixture_reservation" | "fixture_ready" | "pre_spawn_validation_including_digest" | "spawn_call"
  | "handshake_to_turn_start" | "execute" | "native_reap" | "assertions" | "fixture_cleanup";
type Mark = "child_spawn" | "child_exit" | "child_close" | "initialize_request" | "thread_start_request"
  | "thread_resume_request" | "turn_start_request" | "execution_returned";
type Failure = "body_failure" | "test_aborted" | "cleanup_failure";
type Context = Pick<TestContext, "signal" | "after" | "diagnostic">;
interface Timing { phase: Phase; startMs: number; endMs: number | null; cpu: NodeJS.CpuUsage }

/** Test-only observation: no request payloads, auth, paths or stream data are retained. */
export function createOwnedExecutionDiagnostic(t: Context, timeoutMs: number) {
  const started = performance.now();
  const initialCpu = process.cpuUsage();
  const phases: Timing[] = [];
  const marks: Partial<Record<Mark, number>> = {};
  const detach: (() => void)[] = [];
  let active: Timing | undefined;
  let disposed = false;
  let reported = false;
  const elapsed = () => performance.now() - started;
  const cpuMs = (usage: NodeJS.CpuUsage) => ({ user: usage.user / 1000, system: usage.system / 1000 });
  const end = () => {
    if (disposed || !active) return;
    active.endMs = elapsed();
    active.cpu = process.cpuUsage(active.cpu);
    active = undefined;
  };
  const begin = (phase: Phase) => {
    if (disposed) return;
    end();
    active = { phase, startMs: elapsed(), endMs: null, cpu: process.cpuUsage() };
    phases.push(active);
  };
  const mark = (name: Mark) => { if (!disposed && marks[name] === undefined) marks[name] = elapsed(); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    t.signal.removeEventListener("abort", aborted);
    for (const remove of detach) remove();
  };
  const fail = (reason: Failure) => {
    if (disposed || reported) return;
    reported = true;
    const elapsedMs = elapsed();
    t.diagnostic(JSON.stringify({ kind: "codex_owned_execution_diagnostic_v1", reason, timeoutMs,
      elapsedMs, cpuMs: cpuMs(process.cpuUsage(initialCpu)), nodeVersion: process.version,
      platform: process.platform, arch: process.arch, activePhase: active?.phase ?? null,
      phases: phases.map(value => ({ phase: value.phase, startMs: value.startMs, endMs: value.endMs,
        durationMs: (value.endMs ?? elapsedMs) - value.startMs,
        cpuMs: cpuMs(value === active ? process.cpuUsage(value.cpu) : value.cpu) })), marks }));
    dispose();
  };
  const aborted = () => fail("test_aborted");
  t.signal.addEventListener("abort", aborted, { once: true });
  const observeChild = (child: ChildProcess) => {
    const spawned = () => mark("child_spawn");
    const exited = () => mark("child_exit");
    const closed = () => { mark("child_close"); if (active?.phase === "native_reap") end(); };
    const message = (value: unknown) => {
      const method = value && typeof value === "object" && "method" in value ? value.method : undefined;
      if (method === "initialize") mark("initialize_request");
      else if (method === "thread/start") mark("thread_start_request");
      else if (method === "thread/resume") mark("thread_resume_request");
      else if (method === "turn/start") mark("turn_start_request");
    };
    if (disposed) return;
    child.once("spawn", spawned);
    child.once("exit", exited);
    child.once("close", closed);
    child.on("message", message);
    detach.push(() => { child.removeListener("spawn", spawned); child.removeListener("exit", exited);
      child.removeListener("close", closed); child.removeListener("message", message); });
  };
  return { begin, end, mark, observeChild, fail, dispose };
}

export async function captureOwnedExecutionDiagnostic<T>(t: Context, timeoutMs: number,
  execute: (diagnostic: ReturnType<typeof createOwnedExecutionDiagnostic>) => Promise<T>): Promise<T> {
  const diagnostic = createOwnedExecutionDiagnostic(t, timeoutMs);
  try {
    return await execute(diagnostic);
  } catch (error) {
    diagnostic.fail("body_failure");
    throw error;
  } finally {
    // Node also aborts successful tests; detach after fixture teardown, before that abort.
    if (t.signal.aborted) diagnostic.dispose();
    else t.after(() => diagnostic.dispose());
  }
}
