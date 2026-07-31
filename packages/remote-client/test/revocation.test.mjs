import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { RemoteSessionClient } from "../dist/index.js";

const fixture = JSON.parse(await readFile(new URL("../../remote-protocol/fixtures/v1/canonical-signing.json", import.meta.url), "utf8"));
const binding = {
  version: 1,
  status: "active",
  gatewayId: "gateway-fixture-1",
  gatewayOrigin: "https://ling-pc.example.ts.net",
  gatewayIdentityPublicKeyJwk: fixture.gatewayIdentity.publicKeyJwk,
  gatewayIdentityFingerprint: fixture.gatewayIdentity.fingerprint,
  deviceId: "device-fixture-1",
  deviceKeyId: "ling.remote.device.gateway-fixture-1",
  deviceEpoch: 7,
  pairedAt: "2026-07-31T10:00:00.000Z",
  workspaceBindingId: "workspace-binding-1",
};

test("local revocation attempts every cleanup step and can retry after a partial failure", async () => {
  const operations = [];
  let failFirstWrite = true;
  const client = new RemoteSessionClient({
    binding,
    autoReconnect: false,
    keys: {
      generateOrLoad: async () => { throw new Error("not_used"); },
      sign: async () => { throw new Error("not_used"); },
      verify: async () => false,
      delete: async (keyId) => { operations.push(["delete_key", keyId]); },
    },
    bindingStore: {
      read: async () => binding,
      write: async (next) => {
        operations.push(["write_revoked", next.status]);
        if (failFirstWrite) {
          failFirstWrite = false;
          throw new Error("secure_store_temporarily_unavailable");
        }
      },
      remove: async () => { operations.push(["remove_binding"]); },
    },
    cacheStore: {
      read: async () => undefined,
      write: async () => undefined,
      remove: async (workspaceBindingId) => { operations.push(["remove_cache", workspaceBindingId]); },
    },
    http: {
      getJson: async () => { throw new Error("not_used"); },
      postJson: async () => { throw new Error("not_used"); },
    },
    webSocketFactory: () => { throw new Error("not_used"); },
  });

  await assert.rejects(client.revokeLocal(), /remote_local_revoke_incomplete/u);
  assert.equal(client.state.connection, "revoked");
  assert.deepEqual(operations, [
    ["write_revoked", "revoked"],
    ["remove_cache", "workspace-binding-1"],
    ["delete_key", "ling.remote.device.gateway-fixture-1"],
    ["remove_binding"],
  ]);

  operations.length = 0;
  await client.revokeLocal();
  assert.deepEqual(operations, [
    ["write_revoked", "revoked"],
    ["remove_cache", "workspace-binding-1"],
    ["delete_key", "ling.remote.device.gateway-fixture-1"],
    ["remove_binding"],
  ]);
});
