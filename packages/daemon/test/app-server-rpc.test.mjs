import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { createDaemonServer } from "../dist/index.js";

test("App Server WebSocket negotiates the Ling protocol and supports ping", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-rpc-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`);
  const messages = [];
  socket.on("message", data => messages.push(JSON.parse(String(data))));
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersions: ["ling-app-server/1"],
        requiredCapabilities: ["server/ping"],
      },
    }));
    const initialized = await waitFor(messages, message => message.id === 1);
    assert.equal(initialized.result.protocolVersion, "ling-app-server/1");
    assert.equal(initialized.result.serverInfo.name, "ling-stack-daemon");
    assert.equal(typeof initialized.result.connectionId, "string");
    assert.ok(initialized.result.capabilities.includes("server/ping"));

    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "server/ping", params: {} }));
    const ping = await waitFor(messages, message => message.id === 2);
    assert.equal(ping.result.ok, true);
    assert.equal(ping.result.connectionId, initialized.result.connectionId);
    assert.equal(typeof ping.result.serverTime, "string");
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("App Server rejects unsupported protocol versions before serving methods", { timeout: 10_000 }, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "ling-app-server-rpc-version-"));
  const daemon = createDaemonServer({ host: "127.0.0.1", port: 0, defaultWorkspaceCwd: cwd });
  await daemon.start();
  const address = daemon.server.address();
  assert.ok(address && typeof address === "object");
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/app-server/rpc?cwd=${encodeURIComponent(cwd)}`);
  const messages = [];
  socket.on("message", data => messages.push(JSON.parse(String(data))));
  try {
    await once(socket, "open");
    socket.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersions: ["ling-app-server/99"] } }));
    const response = await waitFor(messages, message => message.id === 1);
    assert.equal(response.error.data.code, "protocol_version_unsupported");
    assert.equal(response.error.code, -32010);
  } finally {
    socket.terminate();
    await daemon.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function waitFor(messages, predicate) {
  for (const message of messages) {
    if (predicate(message)) return message;
  }
  return new Promise((resolve, reject) => {
    const deadline = setTimeout(() => reject(new Error("Timed out waiting for App Server response")), 2_000);
    const timer = setInterval(() => {
      const message = messages.find(predicate);
      if (message) {
        clearTimeout(deadline);
        clearInterval(timer);
        resolve(message);
      }
    }, 10);
  });
}
