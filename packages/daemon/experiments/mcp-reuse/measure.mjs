import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { ExperimentalGenerationPool } from "./generation-pool.mjs";

if (process.argv.length !== 3 || process.argv[2] !== "--run-isolated-probe") {
  throw new Error("Disabled by default. Run measure.mjs --run-isolated-probe for local synthetic servers only.");
}

const scope = { workspaceId: "research-workspace", serverId: "research-server", configRevision: "1", credentialGeneration: "1", activationEpoch: "1" };
const guards = { admit() {}, assertCurrent() {} };
const fixturePath = fileURLToPath(new URL("./fixture-server.mjs", import.meta.url));
const http = await startHttpFixture();
const childPids = new Set();
const results = [];
try {
  for (const transportKind of ["stdio", "streamable-http"]) {
    for (const reuse of [false, true]) {
      let connects = 0;
      const handshakes = [];
      const connect = async () => {
        const client = new Client({ name: "ling-reuse-research-client", version: "1" });
        const transport = transportKind === "stdio"
          ? new StdioClientTransport({ command: process.execPath, args: [fixturePath], env: {}, stderr: "pipe" })
          : new StreamableHTTPClientTransport(new URL(http.url));
        const started = performance.now();
        try { await client.connect(transport, { timeout: 5000 }); }
        catch (error) { await transport.close(); throw error; }
        handshakes.push(performance.now() - started);
        connects++;
        if (transport.pid) childPids.add(transport.pid);
        return client;
      };
      const pool = reuse ? new ExperimentalGenerationPool({ enabled: true, connect, idleMs: 1000 }) : undefined;
      const samples = [];
      const heapBefore = process.memoryUsage().heapUsed;
      try {
        for (let index = 0; index < 10; index++) {
          const started = performance.now();
          const call = client => client.callTool({ name: "read_fixture", arguments: {} }, undefined, { timeout: 3000 });
          const result = pool ? await pool.run(scope, guards, call) : await (async () => {
            const client = await connect();
            try { return await call(client); } finally { await client.close(); }
          })();
          assert.equal(result.isError, undefined);
          assert.equal(result.content[0].text, "research fixture");
          samples.push(performance.now() - started);
        }
      } finally { if (pool) assert.equal((await pool.shutdown()).drained, true); }
      assert.equal(connects, reuse ? 1 : 10);
      results.push({ transport: transportKind, mode: reuse ? "experimental-reuse" : "connect-per-call", connects,
        calls: samples.length, roundTripMs: summarize(samples), handshakeMs: summarize(handshakes),
        samplesMs: samples, heapDeltaBytes: process.memoryUsage().heapUsed - heapBefore });
    }
  }
} finally { await http.close(); }

const alive = [...childPids].filter(pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } });
assert.deepEqual(alive, [], "all owned stdio servers must have exited");
const sourceSha256 = {};
for (const name of ["generation-pool.mjs", "fixture-server.mjs", "measure.mjs"]) {
  sourceSha256[name] = createHash("sha256").update(await readFile(new URL(name, import.meta.url))).digest("hex");
}
process.stdout.write(`${JSON.stringify({ kind: "local-sdk-prototype-only", timestamp: new Date().toISOString(),
  platform: process.platform, architecture: process.arch, node: process.version, sourceSha256, results,
  cleanup: { ownedStdioProcesses: childPids.size, alive, httpClosed: true },
  limits: ["No production Host admission, credentials or external MCP server.", "Heap deltas include garbage collection and are not resident-memory comparisons.", "Sequential fixed-order local samples are exploratory, not a product latency claim."] }, null, 2)}\n`);

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return { min: sorted[0], median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * 0.95) - 1], max: sorted.at(-1) };
}

async function startHttpFixture() {
  const live = new Set();
  const server = createServer(async (request, response) => {
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    const sdk = new McpServer({ name: "ling-reuse-research-http", version: "1" });
    sdk.registerTool("read_fixture", {}, async () => ({ content: [{ type: "text", text: "research fixture" }] }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    live.add(sdk);
    response.once("close", () => { live.delete(sdk); void sdk.close(); });
    try {
      let body = "";
      for await (const chunk of request) { body += chunk; if (body.length > 16_384) throw new Error("fixture_request_too_large"); }
      await sdk.connect(transport);
      await transport.handleRequest(request, response, JSON.parse(body));
    } catch {
      if (!response.headersSent) response.writeHead(400).end();
      else response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return { url: `http://127.0.0.1:${server.address().port}/mcp`, async close() {
    await Promise.all([...live].map(client => client.close()));
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  } };
}
