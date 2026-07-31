import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalizeJson,
  parseRemoteClientFrameV1,
} from "../dist/index.js";

function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function shuffled(values, random) {
  const output = [...values];
  for (let index = output.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1));
    [output[index], output[target]] = [output[target], output[index]];
  }
  return output;
}

function reorderObject(value, random) {
  if (Array.isArray(value)) {
    return value.map((item) => reorderObject(item, random));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      shuffled(Object.entries(value), random).map(([key, item]) => [key, reorderObject(item, random)]),
    );
  }
  return value;
}

function generatedJsonValue(random, depth = 0) {
  const scalars = [null, false, true, 0, 1, -17, 1e-7, 42.5, "Ling", "手机😀", "line\nfeed"];
  if (depth >= 3 || random() < 0.45) {
    return scalars[Math.floor(random() * scalars.length)];
  }
  if (random() < 0.45) {
    return Array.from({ length: Math.floor(random() * 5) }, () => generatedJsonValue(random, depth + 1));
  }
  const count = Math.floor(random() * 5);
  const output = {};
  for (let index = 0; index < count; index += 1) {
    output[`key_${depth}_${index}_${Math.floor(random() * 10_000)}`] = generatedJsonValue(random, depth + 1);
  }
  return output;
}

test("canonical JSON is stable across generated object insertion orders", () => {
  const random = createPrng(0x1a2b3c4d);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const value = generatedJsonValue(random);
    const canonical = canonicalizeJson(value);
    assert.equal(canonicalizeJson(reorderObject(value, random)), canonical);
    assert.equal(canonicalizeJson(JSON.parse(canonical)), canonical);
  }
});

test("generated valid frame key permutations preserve one parsed value", () => {
  const random = createPrng(0x5eed1234);
  const nowMs = Date.parse("2026-07-19T10:00:00.000Z");
  const frame = {
    version: 1,
    type: "conversation.send_text",
    messageId: "frame-property-1",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: "2026-07-19T10:00:00.000Z",
    clientSeq: 1,
    expiresAt: "2026-07-19T10:00:30.000Z",
    payload: {
      commandId: "command-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      body: "来自 property test 的消息",
      issuedAt: "2026-07-19T10:00:00.000Z",
      retryUntil: "2026-07-19T10:30:00.000Z",
    },
  };

  for (let iteration = 0; iteration < 250; iteration += 1) {
    const reordered = reorderObject(frame, random);
    assert.deepEqual(parseRemoteClientFrameV1(JSON.stringify(reordered), { nowMs }), frame);
  }
});

test("generated frame boundary mutations always fail closed", () => {
  const random = createPrng(0xc0ffee12);
  const nowMs = Date.parse("2026-07-19T10:00:00.000Z");
  const frame = {
    version: 1,
    type: "conversation.send_text",
    messageId: "frame-property-1",
    gatewayId: "gateway-1",
    sessionId: "session-1",
    sentAt: "2026-07-19T10:00:00.000Z",
    clientSeq: 1,
    expiresAt: "2026-07-19T10:00:30.000Z",
    payload: {
      commandId: "command-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      body: "safe",
      issuedAt: "2026-07-19T10:00:00.000Z",
      retryUntil: "2026-07-19T10:30:00.000Z",
    },
  };
  const mutations = [
    (candidate, iteration) => { candidate[`unknown_${iteration}`] = true; },
    (candidate, iteration) => { candidate.payload[`unknown_${iteration}`] = true; },
    (candidate) => { delete candidate.sessionId; },
    (candidate) => { delete candidate.payload.commandId; },
    (candidate) => { candidate.type = "file.read"; },
    (candidate) => { candidate.version = 2; },
    (candidate) => { candidate.clientSeq = 0; },
    (candidate) => { candidate.expiresAt = "2026-07-19T10:01:01.000Z"; },
    (candidate) => { candidate.payload.workspaceId = "/tmp/workspace"; },
    (candidate) => { candidate.payload.body = "x".repeat(32 * 1024 + 1); },
    (candidate) => { candidate.payload.retryUntil = "2026-07-20T10:00:01.000Z"; },
  ];

  for (let iteration = 0; iteration < 500; iteration += 1) {
    const candidate = structuredClone(frame);
    mutations[Math.floor(random() * mutations.length)](candidate, iteration);
    assert.throws(() => parseRemoteClientFrameV1(JSON.stringify(candidate), { nowMs }));
  }
});
