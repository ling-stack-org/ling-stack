import assert from "node:assert/strict";
import test from "node:test";
import {
  MCP_STDIO_MAX_BUFFER_BYTES,
  createDefaultMcpProcessLauncher,
} from "../dist/features/mcp/stdio-launcher.js";

const MIB = 1024 * 1024;

test("default MCP stdio transport accepts messages larger than the SDK default", async () => {
  assert.equal(MCP_STDIO_MAX_BUFFER_BYTES, 64 * MIB);

  const payloadBytes = 11 * MIB;
  const childScript = [
    "const payloadBytes = Number(process.argv[1]);",
    "const message = { jsonrpc: '2.0', method: 'fixture/large', params: { payload: 'x'.repeat(payloadBytes) } };",
    "process.stdout.write(`${JSON.stringify(message)}\\n`, () => process.exit(0));",
  ].join("\n");
  const transport = createDefaultMcpProcessLauncher().createStdioTransport({
    command: process.execPath,
    args: ["-e", childScript, String(payloadBytes)],
    env: {},
  });

  const messagePromise = new Promise((resolve, reject) => {
    transport.onmessage = resolve;
    transport.onerror = reject;
  });

  await transport.start();
  try {
    const message = await withTimeout(messagePromise, 10_000);
    assert.equal(message.method, "fixture/large");
    assert.equal(message.params.payload.length, payloadBytes);
  } finally {
    await transport.close();
  }
});

async function withTimeout(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
