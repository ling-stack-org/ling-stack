import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES, type RemoteDeviceArtifactOfferV1, type RemotePhoneTaskProjectionV1,
} from "@ling-stack/contracts";
import { phoneTaskProjectionDigest } from "@ling-stack/remote-protocol";
import { createPhoneTaskArtifactReceiver, type PhoneTaskArtifactPeer } from "../src/device/phone-task-artifacts.ts";

const time = "2026-11-23T10:00:00.000Z";
const bytes = Buffer.from("signed-build-output");
const sha256 = (value: Uint8Array) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
const signature = Buffer.alloc(64, 1).toString("base64url");
const baseline: RemotePhoneTaskProjectionV1 = {
  taskId: "task", ownerId: "owner", targetDeviceId: "external", status: "succeeded", updatedAt: time,
  attempt: { attemptId: "attempt", connectionRevision: "conn-1", capabilityId: "inspect", status: "completed" },
};
const offer: RemoteDeviceArtifactOfferV1 = {
  status: "accepted", signature, manifest: {
    version: 1, gatewayId: "gateway", mobileDeviceId: "phone", deviceEpoch: 2, workspaceId: "workspace",
    workspaceBindingId: "workspace-binding", policyVersion: 1, shareId: "share", revision: 3, proposalId: "proposal",
    taskId: "task", projectionDigest: phoneTaskProjectionDigest(baseline), ownerId: "owner", targetDeviceId: "external", attemptId: "attempt",
    connectionRevision: "conn-1", name: "fixture.bin", sizeBytes: bytes.length, digest: sha256(bytes),
    chunkBytes: REMOTE_DEVICE_ARTIFACT_CHUNK_BYTES, expiresAt: "2026-11-23T10:19:00.000Z",
  },
};

test("phone discards a corrupt assembly and leaves no verified receipt", async () => {
  const values = new Map<string, string>();
  let projection = baseline;
  let received = Buffer.alloc(0);
  let reads = 0;
  let receipts = 0;
  let sealed = false;
  let corrupt = true;
  const runtime = createPhoneTaskArtifactReceiver({
    ownerId: "owner", foreground: () => true, now: () => time, readProjection: async () => projection,
    storage: { async getItem(key) { return values.get(key) ?? null; }, async setItem(key, value) { values.set(key, value); } },
    openFile: () => ({
      async size() { return received.length; },
      async append(offset, part) { assert.equal(received.length, offset); received = Buffer.concat([received, part]); },
      async digest() { return sha256(received); },
      async reset() { received = Buffer.alloc(0); },
      async seal() { sealed = true; },
      async export() {},
    }),
  });
  const peer: PhoneTaskArtifactPeer = {
    async listDeviceArtifacts() { return [offer]; },
    async decideDeviceArtifact() { return offer; },
    async readDeviceArtifactChunk() {
      reads += 1;
      return corrupt ? Buffer.alloc(bytes.length, 78) : bytes;
    },
    async confirmDeviceArtifactReceived(_, digest) {
      receipts += 1;
      return { ...offer, receipt: { digest, verifiedAt: time, signature } };
    },
  };
  await assert.rejects(runtime.receive({ offer, peer }), /digest_mismatch/u);
  assert.equal(received.length, 0);
  assert.equal(sealed, false);
  assert.equal(receipts, 0);
  assert.deepEqual(await runtime.listSaved("task"), []);
  projection = { ...projection, targetDeviceId: "changed" };
  await assert.rejects(runtime.receive({ offer, peer }), /binding_changed/u);
  assert.equal(reads, 1);
  projection = { ...baseline, status: "unknown" };
  await assert.rejects(runtime.receive({ offer, peer }), /binding_changed/u);
  assert.equal(reads, 1);
  projection = baseline;
  corrupt = false;
  assert.equal((await runtime.receive({ offer, peer })).receipt?.digest, sha256(bytes));
  assert.equal(receipts, 1);
  assert.equal(sealed, true);
  assert.equal((await runtime.listSaved("task"))[0]?.offer.manifest.digest, sha256(bytes));
});
