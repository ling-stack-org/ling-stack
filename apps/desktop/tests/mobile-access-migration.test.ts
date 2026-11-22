import assert from "node:assert/strict";
import test from "node:test";

import type {
  LingServerConfirmedPairingMigrationV1,
  LingServerPairingMigrationRequestV1,
  RemoteP256PublicJwkV1,
} from "@ling-stack/contracts";
import type { IpcMain, IpcMainInvokeEvent } from "electron";

import { registerDesktopIpc } from "../dist/main/ipc.js";
import { deriveMobileAccessCsrfToken, deriveMobileAccessManagementCapability } from "../dist/main/mobile-access/authority.js";
import { DesktopMobileAccessClient } from "../dist/main/mobile-access/client.js";
import { DESKTOP_IPC_CHANNELS } from "../dist/shared/ipc-channels.js";

const request: LingServerPairingMigrationRequestV1 = {
  routingProfile: {
    schemaVersion: 1,
    bindingId: "peer-binding-1",
    installationId: "server-install-1",
    installationRevision: 2,
    serverOrigin: "https://ling.example",
    applicationKeyFingerprint: "A".repeat(43),
    signalingProtocolMajor: 1,
    gatewayProtocolMajor: 1,
  },
  retainedCommandIds: ["reviewed-command"],
};
const preview = {
  schemaVersion: 1,
  migrationId: "migration-1",
  oldPairing: {
    gatewayId: "gateway-1", gatewayOrigin: "https://pc.example", mobileDeviceId: "phone-1",
    gatewayKeyFingerprint: "A".repeat(43), mobileKeyFingerprint: "E".repeat(43), deviceEpoch: 7, workspaceBindingId: "workspace-1",
  },
  routingProfile: request.routingProfile,
  retainedReceipts: [{ commandId: "reviewed-command", payloadDigest: "A".repeat(43) }],
  confirmationDigest: "a".repeat(64),
  createdAt: "2026-11-22T00:00:00.000Z",
  expiresAt: "2026-11-22T00:05:00.000Z",
  status: "pending",
} as const;
const confirmationRequest = { migrationId: preview.migrationId, confirmationDigest: preview.confirmationDigest };
const confirmation: LingServerConfirmedPairingMigrationV1 = {
  ...preview,
  status: "confirmed",
  confirmedAt: "2026-11-22T00:01:00.000Z",
  gatewaySignature: "A".repeat(86),
};
const gatewayPublicKeyJwk: RemoteP256PublicJwkV1 = { kty: "EC", crv: "P-256", x: "A".repeat(43), y: "A".repeat(43) };

test("Desktop produces a signed publication from authenticated loopback migration requests", async () => {
  const origin = "http://127.0.0.1:17891";
  const bridgeToken = "fixture-desktop-bridge";
  const managementCapability = deriveMobileAccessManagementCapability(bridgeToken);
  const csrfToken = deriveMobileAccessCsrfToken(managementCapability);
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const client = new DesktopMobileAccessClient({
    daemonBaseUrl: origin,
    desktopBridgeToken: bridgeToken,
    fetch: async (input, init) => {
      assert.ok(init?.method);
      const url = new URL(input instanceof Request ? input.url : input);
      const headers = new Headers(init.headers);
      assert.equal(url.origin, origin);
      assert.equal(headers.get("Origin"), origin);
      assert.equal(headers.get("X-Ling-Mobile-Management-Capability"), managementCapability);
      assert.equal(headers.get("X-Ling-Csrf-Token"), init.method === "POST" ? csrfToken : null);
      assert.equal(init.redirect, "error");
      const path = url.pathname.replace("/v1/mobile-access/pairing-migration/", "");
      calls.push({ path, method: init.method, ...(typeof init.body === "string" ? { body: JSON.parse(init.body) } : {}) });
      if (path === "prepare") return Response.json(preview);
      if (path === "gateway-key") return Response.json({ gatewayPublicKeyJwk, unexpected: bridgeToken });
      if (path === "confirm") return Response.json(confirmation);
      assert.fail(`Unexpected request to ${url.pathname}`);
    },
  });

  assert.deepEqual(await client.preparePairingMigration(request), preview);
  assert.deepEqual(await client.confirmPairingMigration(confirmationRequest), { confirmation, gatewayPublicKeyJwk });
  assert.deepEqual(calls, [
    { path: "prepare", method: "POST", body: request },
    { path: "gateway-key", method: "GET" },
    { path: "confirm", method: "POST", body: confirmationRequest },
  ]);
});

test("Desktop fences migration previews and signatures to the trusted paired-settings document", async t => {
  type Registration = Parameters<typeof registerDesktopIpc>[0];
  const handlers = new Map<string, Parameters<IpcMain["handle"]>[1]>();
  function unavailable(): never { assert.fail("Unexpected fixture operation"); }
  const ipc = {
    handle: (channel: string, handler: Parameters<IpcMain["handle"]>[1]) => handlers.set(channel, handler),
    on: () => {},
    removeHandler: (channel: string) => handlers.delete(channel),
    removeAllListeners: () => {},
  } as unknown as Registration["ipcMainImpl"];
  const documentUrl = "file:///ling/index.html";
  const frame = { detached: false, url: documentUrl };
  const owner = { id: 7, mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url };
  const calls: unknown[] = [];
  const analysis = { shareId: "phone-share", proposalId: "diagnostic-note", expectedRevision: 2, text: "Check the network status." };
  const analysisRequest = { shareId: analysis.shareId, expectedRevision: analysis.expectedRevision, locale: "en-US" };
  const analysisDraft = { shareId: analysis.shareId, expectedRevision: analysis.expectedRevision, text: analysis.text, modelLabel: "Fixture model" };
  const share = { workspaceId: "fixture-workspace", shareId: analysis.shareId, revision: 3, expiresAt: "2026-11-23T10:02:00.000Z", state: "revoked" } as const;
  const unregister = registerDesktopIpc({
    ipcMainImpl: ipc,
    trustedDocumentUrl: documentUrl,
    getMainWindow: () => ({ webContents: owner, isDestroyed: () => false }) as ReturnType<Registration["getMainWindow"]>,
    runtime: {
      status: { state: "connected", baseUrl: "http://127.0.0.1:17891", ownedByDesktop: true },
      onStatusChanged: () => () => {},
      restart: unavailable,
      requestComputerControlPermissions: unavailable,
      openComputerControlPermissionSettings: unavailable,
      getLockedTaskContinuationPreferences: unavailable,
      setContinueTasksWhileLocked: unavailable,
      getLockedComputerControlState: unavailable,
      authorizeLockedComputerControl: unavailable,
      revokeLockedComputerControl: unavailable,
    },
    computerUse: { ownsPreviewWebContents: () => false } as unknown as Registration["computerUse"],
    mobileAccess: {
      status: unavailable,
      enable: unavailable,
      disable: unavailable,
      startPairing: unavailable,
      confirmPairing: unavailable,
      rejectPairing: unavailable,
      revoke: unavailable,
      async listDeviceCollaboration() { return []; },
      async draftDeviceAnalysis(input) { calls.push(input); return analysisDraft; },
      listDeviceArtifacts: async () => [],
      offerDeviceArtifact: unavailable,
      async proposeDeviceAnalysis(input) { calls.push(input); return share; },
      async preparePairingMigration(input) { calls.push(input); return preview; },
      async confirmPairingMigration(input) { calls.push(input); return { confirmation, gatewayPublicKeyJwk }; },
    },
  });
  t.after(unregister);
  const invoke = (channel: string, body: unknown, sender = owner, senderFrame = frame) => {
    const handler = handlers.get(channel);
    assert.ok(handler);
    return handler({ sender, senderFrame } as unknown as IpcMainInvokeEvent, body);
  };
  const prepare = DESKTOP_IPC_CHANNELS.mobileAccessPairingMigrationPrepare;
  const confirm = DESKTOP_IPC_CHANNELS.mobileAccessPairingMigrationConfirm;
  const listCollaboration = DESKTOP_IPC_CHANNELS.mobileAccessDeviceCollaborationList;
  const draftAnalysis = DESKTOP_IPC_CHANNELS.mobileAccessDeviceCollaborationDraft;
  const proposeAnalysis = DESKTOP_IPC_CHANNELS.mobileAccessDeviceCollaborationPropose;
  const offerArtifact = DESKTOP_IPC_CHANNELS.mobileAccessDeviceArtifactOffer;
  await assert.rejects(invoke(prepare, request, { ...owner, id: 9 }), /mobile_access_unauthorized/u);
  await assert.rejects(invoke(confirm, confirmationRequest, owner, { ...frame }), /mobile_access_unauthorized/u);
  frame.url = "https://different.example";
  await assert.rejects(invoke(prepare, request), /mobile_access_unauthorized/u);
  await assert.rejects(invoke(listCollaboration, undefined), /mobile_access_unauthorized/u);
  await assert.rejects(invoke(draftAnalysis, analysisRequest), /mobile_access_unauthorized/u);
  await assert.rejects(invoke(proposeAnalysis, analysis), /mobile_access_unauthorized/u);
  await assert.rejects(invoke(offerArtifact, analysisRequest), /mobile_access_unauthorized/u);
  frame.url = documentUrl + "#/settings/mobile-access";
  await assert.rejects(invoke(prepare, { ...request, retainedCommandIds: ["duplicate", "duplicate"] }), /invalid_pairing_migration_request/u);
  await assert.rejects(invoke(confirm, { ...confirmationRequest, confirmationDigest: "invalid" }), /invalid_pairing_migration_confirmation/u);
  await assert.rejects(invoke(proposeAnalysis, { ...analysis, expectedRevision: 0 }), /invalid_device_analysis_proposal/u);
  await assert.rejects(invoke(draftAnalysis, { ...analysisRequest, facts: {} }), /invalid_device_analysis_draft/u);
  await assert.rejects(invoke(offerArtifact, {
    shareId: "s", expectedRevision: 1, proposalId: "p", path: "file-from-renderer",
  }), /invalid_device_artifact_offer/u);
  assert.deepEqual(calls, []);

  assert.deepEqual(await invoke(prepare, request), preview);
  assert.deepEqual(await invoke(confirm, confirmationRequest), { confirmation, gatewayPublicKeyJwk });
  assert.deepEqual(await invoke(listCollaboration, undefined), []);
  assert.deepEqual(await invoke(draftAnalysis, analysisRequest), analysisDraft);
  assert.deepEqual(await invoke(proposeAnalysis, analysis), share);
  assert.deepEqual(calls, [request, confirmationRequest, analysisRequest, analysis]);
});
