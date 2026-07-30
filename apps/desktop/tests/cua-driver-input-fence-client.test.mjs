import assert from "node:assert/strict";
import { createServer } from "node:net";
import test from "node:test";
import {
  CUA_DRIVER_INPUT_FENCE_HARD_DEADLINE_MS,
  CuaDriverInputFenceError,
  createCuaDriverInputFenceConfiguration,
  fenceCuaDriverInput,
} from "../dist/main/cua-driver/input-fence-client.js";

test("input-fence configuration is generation-bound and carries a private token", async () => {
  const configuration = await createCuaDriverInputFenceConfiguration(17);
  assert.equal(configuration.epoch, 17);
  assert.match(configuration.token, /^[a-f0-9]{64}$/u);
  assert.ok(configuration.port > 0 && configuration.port <= 65_535);
  assert.equal(CUA_DRIVER_INPUT_FENCE_HARD_DEADLINE_MS, 100);
});

test("input-fence client sends the exact one-way protocol and accepts only a drained epoch", async (t) => {
  const token = "a".repeat(64);
  let observed;
  const server = createServer((socket) => {
    let bytes = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      bytes += chunk;
      const newline = bytes.indexOf("\n");
      if (newline < 0) return;
      observed = JSON.parse(bytes.slice(0, newline));
      socket.end(`${JSON.stringify({
        protocolVersion: 1,
        status: "fenced",
        previousEpoch: 23,
        nextEpoch: 24,
        activeInputs: 0,
      })}\n`);
    });
  });
  const port = await listen(server);
  t.after(() => server.close());

  const acknowledgement = await fenceCuaDriverInput({ port, token, epoch: 23 });
  assert.deepEqual(observed, {
    protocolVersion: 1,
    token,
    command: "fence",
    expectedEpoch: 23,
    timeoutMs: 100,
  });
  assert.deepEqual(acknowledgement, {
    protocolVersion: 1,
    status: "fenced",
    previousEpoch: 23,
    nextEpoch: 24,
    activeInputs: 0,
  });
});

test("input-fence client rejects stale, expanded and undrained acknowledgements", async (t) => {
  for (const response of [
    { protocolVersion: 1, status: "fenced", previousEpoch: 4, nextEpoch: 5, activeInputs: 0 },
    { protocolVersion: 1, status: "fenced", previousEpoch: 5, nextEpoch: 6, activeInputs: 1 },
    { protocolVersion: 1, status: "fenced", previousEpoch: 5, nextEpoch: 6, activeInputs: 0, extra: true },
  ]) {
    const server = createServer((socket) => socket.end(`${JSON.stringify(response)}\n`));
    const port = await listen(server);
    t.after(() => server.close());
    await assert.rejects(
      fenceCuaDriverInput({ port, token: "b".repeat(64), epoch: 5 }),
      (error) => error instanceof CuaDriverInputFenceError && error.fenceCode === "response_invalid",
    );
  }
});

test("input-fence hard deadline is absolute even when the provider trickles bytes", async () => {
  const sockets = new Set();
  const server = createServer((socket) => {
    sockets.add(socket);
    const trickle = setInterval(() => socket.write(" "), 5);
    socket.once("close", () => {
      clearInterval(trickle);
      sockets.delete(socket);
    });
  });
  const port = await listen(server);
  try {
    const startedAt = performance.now();
    await assert.rejects(
      fenceCuaDriverInput({ port, token: "c".repeat(64), epoch: 7 }, 25),
      (error) => error instanceof CuaDriverInputFenceError && error.fenceCode === "timeout",
    );
    assert.ok(performance.now() - startedAt < 150);
  } finally {
    const closed = new Promise((resolve) => server.close(resolve));
    for (const socket of sockets) socket.destroy();
    await closed;
  }
});

async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}
