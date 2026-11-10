// QA-only loopback transport fault. Commands are in-process, never HTTP admin routes.
// Forwarded headers/bodies are not retained; records contain bounded transport metadata only.
import assert from "node:assert/strict";
import { createServer, request as requestHttp } from "node:http";

export async function createQaSseFaultRelay({ upstreamPort, port = 0 }) {
  assert.ok(Number.isInteger(upstreamPort) && upstreamPort > 0 && upstreamPort < 65536);
  assert.ok(Number.isInteger(port) && port >= 0 && port < 65536 && port !== upstreamPort);
  let sequence = 0;
  let holding = false;
  let closing = false;
  const streams = new Map();
  const sockets = new Set();
  const outbound = new Set();
  const records = [];
  function record(event, fields = {}) {
    assert.ok(records.length < 10000, "QA relay record budget exhausted");
    records.push({ at: new Date().toISOString(), event, ...fields });
  }
  function streamKind(method, pathname) {
    if (method === "GET" && pathname === "/control-plane/stream") return "control";
    if (method === "POST" && pathname === "/conversations/stream") return "execution";
    return undefined;
  }
  function cursor(value) {
    if (typeof value !== "string" || !/^\d+$/u.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  }
  function observeControl(state, bytes) {
    state.controlBuffer += state.decoder.decode(bytes, { stream: true }).replace(/\r\n/gu, "\n");
    if (state.controlBuffer.length > 65536) {
      record("control-frame-budget-exceeded", { id: state.id });
      state.controlBuffer = "";
      return;
    }
    let end;
    while ((end = state.controlBuffer.indexOf("\n\n")) !== -1) {
      const frame = state.controlBuffer.slice(0, end);
      state.controlBuffer = state.controlBuffer.slice(end + 2);
      const lines = frame.split("\n");
      const event = lines.find(line => line.startsWith("event:"))?.slice(6).trim();
      if (!["control_plane_event", "control_plane_replay_ready", "control_plane_snapshot_required"].includes(event)) continue;
      let data;
      try { data = JSON.parse(lines.filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n")); }
      catch { continue; }
      if (!data || typeof data !== "object" || Array.isArray(data)) continue;
      const fields = { id: state.id, type: event };
      for (const key of ["seq", "afterSeq", "oldestAvailableSeq", "latestSeq", "nextAfterSeq"]) {
        if (Number.isSafeInteger(data[key]) && data[key] >= 0) fields[key] = data[key];
      }
      if (["complete", "snapshot_required"].includes(data.disposition)) fields.disposition = data.disposition;
      record("control-frame", fields);
    }
  }
  const server = createServer((incoming, response) => {
    if (closing) { incoming.resume(); response.writeHead(503).end(); return; }
    const url = new URL(incoming.url, "http://127.0.0.1");
    const kind = streamKind(incoming.method, url.pathname);
    const afterSeq = kind === "control" ? cursor(url.searchParams.get("afterSeq")) : undefined;
    if (kind && holding) {
      record("stream-refused-during-fault", { kind, ...(afterSeq === undefined ? {} : { afterSeq }) });
      incoming.resume();
      response.writeHead(503, { "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" }).end();
      return;
    }
    const id = ++sequence;
    const state = kind ? { id, kind, response, upstream: null, remote: null, ready: false,
      ...(afterSeq === undefined ? {} : { afterSeq }), bytesReceived: 0,
      ...(kind === "control" ? { controlBuffer: "", decoder: new TextDecoder() } : {}) } : undefined;
    if (state) { streams.set(id, state); record("stream-request", { id, kind, ...(afterSeq === undefined ? {} : { afterSeq }) }); }
    const upstream = requestHttp({ hostname: "127.0.0.1", port: upstreamPort,
      path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, host: `127.0.0.1:${upstreamPort}` } }, remote => {
      if (state) {
        state.remote = remote;
        state.ready = remote.statusCode === 200 && remote.headers["content-type"]?.startsWith("text/event-stream") === true;
        record("stream-response", { id, kind, status: remote.statusCode, ready: state.ready });
        remote.on("data", bytes => {
          state.bytesReceived += bytes.length;
          if (kind === "control") observeControl(state, bytes);
        });
      }
      remote.once("error", () => response.destroy());
      remote.once("aborted", () => response.destroy());
      response.writeHead(remote.statusCode, remote.headers);
      remote.pipe(response);
    });
    outbound.add(upstream);
    if (state) state.upstream = upstream;
    upstream.once("close", () => outbound.delete(upstream));
    upstream.once("error", () => {
      if (state) record("stream-upstream-error", { id, kind });
      if (!response.headersSent) response.writeHead(502, { "Access-Control-Allow-Origin": "*" }).end();
      else response.destroy();
    });
    response.once("close", () => {
      upstream.destroy();
      if (state) {
        state.remote?.destroy();
        streams.delete(id);
        record("stream-closed", { id, kind, bytesReceived: state.bytesReceived });
      }
    });
    incoming.once("aborted", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  server.on("upgrade", (_request, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); });
  });
  return {
    port: server.address().port,
    records,
    liveStreams: () => [...streams.values()].map(({ id, kind, ready, afterSeq, bytesReceived }) =>
      ({ id, kind, ready, ...(afterSeq === undefined ? {} : { afterSeq }), bytesReceived })),
    disconnect({ requiredKinds = ["control", "execution"] } = {}) {
      assert.equal(closing, false);
      assert.equal(holding, false, "No repeated fault without restoration");
      assert.ok(Array.isArray(requiredKinds) && requiredKinds.length > 0
        && requiredKinds.every(kind => ["control", "execution"].includes(kind)), "Explicit valid stream kinds required");
      const current = [...streams.values()].filter(stream => stream.ready);
      for (const kind of requiredKinds) assert.ok(current.some(stream => stream.kind === kind), `A live successful ${kind} SSE is required before fault`);
      holding = true;
      record("fault-start", { streams: current.map(({ id, kind, afterSeq, bytesReceived }) =>
        ({ id, kind, ...(afterSeq === undefined ? {} : { afterSeq }), bytesReceived })) });
      for (const stream of streams.values()) { stream.remote?.destroy(); stream.upstream.destroy(); stream.response.destroy(); }
      return current.map(({ id, kind }) => ({ id, kind }));
    },
    restore() {
      assert.equal(closing, false);
      assert.equal(holding, true, "Restoration requires an actual prior fault");
      holding = false;
      record("fault-restored");
    },
    async close() {
      if (closing) return;
      closing = true;
      for (const request of outbound) request.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      record("relay-closed");
    },
  };
}
