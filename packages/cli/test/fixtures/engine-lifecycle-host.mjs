import { createServer } from "node:http";

export const fixtureCredentials = {
  capability: "fixture-engine-root-".repeat(3),
  csrfToken: "fixture-engine-csrf-".repeat(3),
};

const scenario = new URL(import.meta.url).searchParams.get("scenario");
const scenarios = new Set(["startup", "enrollment", "renewal", "cleanup-open", "cleanup-closed"]);

export function createExecutionEngineHost(config) {
  if (!scenarios.has(scenario)) throw new Error("Unknown engine lifecycle fixture scenario");
  const startup = deferred();
  const enrollment = deferred();
  const cleanup = deferred();
  let enrollmentCount = 0;
  let stopCount = 0;
  const emit = (event, details = {}) => console.log(`ENGINE_LIFECYCLE ${JSON.stringify({ event, ...details })}`);
  const signalListeners = ["SIGINT", "SIGTERM", "SIGHUP"].map((signal) => {
    const listener = () => emit("signal", { signal });
    process.on(signal, listener);
    return [signal, listener];
  });
  const gates = new Map([["startup", startup], ["enrollment", enrollment], ["cleanup", cleanup]]);
  const server = createServer(async (request, response) => {
    response.setHeader("Content-Type", "application/json");
    const gate = gates.get(request.url?.replace("/__fixture/release/", ""));
    if (request.method === "POST" && request.url?.startsWith("/__fixture/release/") && gate) {
      response.setHeader("Connection", "close");
      response.end("{}", () => setImmediate(gate.resolve));
      return;
    }
    if (request.method !== "POST" || request.url !== "/execution-engines/enrollments") {
      response.writeHead(404).end("{}");
      return;
    }
    if (request.headers.authorization !== `Bearer ${fixtureCredentials.capability}`
      || request.headers["x-ling-engine-csrf"] !== fixtureCredentials.csrfToken) {
      response.writeHead(403).end('{"error":"engine_authority_required"}');
      return;
    }
    for await (const _chunk of request) { /* Drain the real CLI request before replying. */ }
    enrollmentCount++;
    emit("enrollment-request", { count: enrollmentCount });
    response.end(JSON.stringify({
      code: String(enrollmentCount).padStart(32, "a"),
      expiresAt: new Date(Date.now() + 300_000).toISOString(),
    }));
  });

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const response = await originalFetch(input, init);
    const hold = (scenario === "enrollment" && enrollmentCount === 1)
      || (scenario === "renewal" && enrollmentCount === 2);
    if (!hold || new URL(input).pathname !== "/execution-engines/enrollments") return response;
    const body = await response.text();
    const aborted = () => emit("enrollment-aborted");
    init.signal.addEventListener("abort", aborted, { once: true });
    if (init.signal.aborted) aborted();
    emit("enrollment-pending", { count: enrollmentCount });
    // Hold an already received result past cancellation to exercise the owner's final output fence.
    await enrollment.promise;
    init.signal.removeEventListener("abort", aborted);
    emit("enrollment-released");
    return new Response(body, { status: response.status, headers: response.headers });
  };

  return {
    server,
    engineManagement: fixtureCredentials,
    async start() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(config.port, config.host, () => { server.off("error", reject); resolve(); });
      });
      emit("listening", { pid: process.pid });
      if (scenario === "startup") {
        emit("startup-pending");
        await startup.promise;
      }
      emit("started");
    },
    async stop() {
      emit("stop-called", { count: ++stopCount });
      if (scenario === "cleanup-open") {
        emit("cleanup-pending");
        await cleanup.promise;
      }
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      emit("listener-closed");
      if (scenario === "cleanup-closed") {
        emit("cleanup-pending");
        await cleanup.promise;
      }
      globalThis.fetch = originalFetch;
      for (const [signal, listener] of signalListeners) process.off(signal, listener);
      emit("stopped");
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}
