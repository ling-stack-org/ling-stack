import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_REMOTE_MESSAGE_EXECUTION_POLICY_V1,
  REMOTE_CAPABILITIES_V1,
  REMOTE_CLIENT_COMMAND_TYPES_V1,
  REMOTE_CONVERSATION_KINDS_V1,
  REMOTE_ERROR_CODES_V1,
  REMOTE_LIFECYCLE_COMMAND_TYPES_V1,
  REMOTE_PROTOCOL_LIMITS,
  REMOTE_PROTOCOL_VERSION,
  REMOTE_SERVER_EVENT_TYPES_V1,
  REMOTE_SIGNING_ALGORITHM,
  REMOTE_SUPPORTED_PROTOCOL_VERSIONS,
} from "../dist/index.js";

test("remote V1 protocol and signing algorithm are fixed", () => {
  assert.equal(REMOTE_PROTOCOL_VERSION, 1);
  assert.equal(REMOTE_SIGNING_ALGORITHM, "ES256");
  assert.deepEqual(REMOTE_SUPPORTED_PROTOCOL_VERSIONS, [1]);
});

test("remote V1 allowlists contain only the designed communication surface", () => {
  assert.deepEqual(REMOTE_CAPABILITIES_V1, [
    "conversation.read",
    "conversation.send_text",
    "conversation.mark_read",
    "profile.read",
    "profile.update",
    "security.unpair",
  ]);
  assert.deepEqual(REMOTE_CONVERSATION_KINDS_V1, ["channel", "conversation", "teammate_direct"]);
  assert.deepEqual(REMOTE_CLIENT_COMMAND_TYPES_V1, [
    "session.ping",
    "stream.subscribe",
    "stream.unsubscribe",
    "stream.ack",
    "snapshot.request",
    "conversation.list",
    "conversation.open",
    "conversation.send_text",
    "conversation.mark_read",
    "profile.read",
    "profile.update",
    "security.unpair",
  ]);
  assert.equal(REMOTE_CLIENT_COMMAND_TYPES_V1.includes("approval.resolve"), false);
  assert.equal(REMOTE_CLIENT_COMMAND_TYPES_V1.includes("run.cancel"), false);
  assert.equal(REMOTE_CLIENT_COMMAND_TYPES_V1.includes("file.read"), false);
  assert.equal(REMOTE_LIFECYCLE_COMMAND_TYPES_V1.includes("stream.ack"), false);
  assert.equal(REMOTE_LIFECYCLE_COMMAND_TYPES_V1.includes("security.unpair"), true);
  assert.equal(REMOTE_SERVER_EVENT_TYPES_V1.includes("approval.summary"), false);
  assert.equal(REMOTE_SERVER_EVENT_TYPES_V1.includes("conversation.delta"), true);
  assert.equal(REMOTE_SERVER_EVENT_TYPES_V1.includes("profile.snapshot"), true);
});

test("remote V1 message execution policy cannot start tools or workflows", () => {
  assert.deepEqual(DEFAULT_REMOTE_MESSAGE_EXECUTION_POLICY_V1, {
    sourceSurface: "mobile",
    authorityCeiling: "conversation_comment",
    allowAiReply: true,
    allowToolCalls: false,
    allowWorkflowAutoStart: false,
    allowExecutionProposal: false,
  });
});

test("remote V1 limits and stable errors cover fail-closed behavior", () => {
  assert.equal(REMOTE_PROTOCOL_LIMITS.maxFrameBytes, 256 * 1024);
  assert.equal(REMOTE_PROTOCOL_LIMITS.maxTextBodyBytes, 32 * 1024);
  assert.equal(REMOTE_PROTOCOL_LIMITS.maxPairingLifetimeMs, 5 * 60_000);
  assert.equal(REMOTE_PROTOCOL_LIMITS.maxCommandRetryWindowMs, 24 * 60 * 60_000);
  assert.equal(REMOTE_PROTOCOL_LIMITS.commandTombstoneRetentionMs, 7 * 24 * 60 * 60_000);
  for (const code of [
    "signature_invalid",
    "protocol_incompatible",
    "sequence_invalid",
    "command_expired",
    "command_retry_window_expired",
    "conversation_busy",
    "binding_changed",
    "payload_too_large",
    "resync_required",
  ]) {
    assert.equal(REMOTE_ERROR_CODES_V1.includes(code), true);
  }
});
