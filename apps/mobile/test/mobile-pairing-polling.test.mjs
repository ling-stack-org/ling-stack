import assert from "node:assert/strict";
import test from "node:test";

import {
  isTransientPairingPollError,
  pollForPairingAcceptance,
} from "../src/remote/pairing-polling.ts";

test("pairing confirmation polling survives a transient network failure", async () => {
  let submissions = 0;
  const transientErrors = [];
  const accepted = await pollForPairingAcceptance({
    expiresAt: "2026-08-01T10:05:00.000Z",
    now: () => Date.parse("2026-08-01T10:00:00.000Z"),
    wait: async () => undefined,
    isActive: () => true,
    submit: async () => {
      submissions += 1;
      if (submissions === 1) {
        throw new Error("Network request failed");
      }
      if (submissions === 2) {
        return undefined;
      }
      return { status: "active" };
    },
    onTransientError: (error) => transientErrors.push(error),
  });

  assert.deepEqual(accepted, { status: "active" });
  assert.equal(submissions, 3);
  assert.equal(transientErrors.length, 1);
});

test("pairing confirmation polling still rejects protocol failures", async () => {
  await assert.rejects(
    () => pollForPairingAcceptance({
      expiresAt: "2026-08-01T10:05:00.000Z",
      now: () => Date.parse("2026-08-01T10:00:00.000Z"),
      wait: async () => undefined,
      isActive: () => true,
      submit: async () => { throw new Error("pairing_response_invalid"); },
    }),
    /pairing_response_invalid/u,
  );
});

test("pairing confirmation polling stops when the QR expires", async () => {
  await assert.rejects(
    () => pollForPairingAcceptance({
      expiresAt: "2026-08-01T10:00:00.000Z",
      now: () => Date.parse("2026-08-01T10:00:01.000Z"),
      wait: async () => undefined,
      isActive: () => true,
      submit: async () => undefined,
    }),
    /pairing_expired/u,
  );
});

test("transient classifier is narrow enough to preserve security failures", () => {
  assert.equal(isTransientPairingPollError(new Error("fetch failed")), true);
  assert.equal(isTransientPairingPollError(new Error("pairing_gateway_signature_invalid")), false);
  assert.equal(isTransientPairingPollError(new Error("pairing_acceptance_identity_mismatch")), false);
});
