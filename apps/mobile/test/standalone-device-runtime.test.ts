import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";

import type { DeviceActionRequestV1, DeviceCapabilitySnapshotV1, DeviceObservationV1, DeviceProfileV1, DeviceTaskV1 } from "@ling-stack/contracts";
import { digestDeviceRequest, MobileDeviceExecution, type MobileDeviceTransport } from "../src/device/execution.ts";
import type { HomeAssistantFetch } from "../src/device/home-assistant.ts";
import { createAsyncStorageMobileDeviceJournal, type MobileStorageLike } from "../src/device/journal.ts";
import { createStandaloneDeviceRuntime } from "../src/device/standalone-runtime.ts";

class MemoryStorage implements MobileStorageLike {
  readonly values: Map<string, string>;

  constructor(values: Iterable<readonly [string, string]> = []) {
    this.values = new Map(values);
  }

  async getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  async setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const time = "2026-11-21T10:00:00.000Z";
const options = { randomId: async (prefix: string) => `${prefix}_${randomUUID()}`, now: () => time };
const target = { origin: "https://ha.fixture.example", token: "fixture-credential", entityId: "light.kitchen" };

test("a phone-owned write checks its alternate route and journals a fresh target readback", { timeout: 5_000 }, async t => {
  const profile: DeviceProfileV1 = {
    device: { id: "fixture-board", ownerScope: "owner", displayName: "Fixture board", kind: "hardware", lifecycleStatus: "healthy", profileRevision: "1" },
    adapterId: "fixture-ble", adapterVersion: "1", transports: ["ble"], connectionRefs: ["primary"],
    transportDeployments: [{ transport: "ble", mode: "none", pairing: "os_permission", removal: "disconnect_only" }],
    profileRevision: "1", source: "adapter",
  };
  const deviceId = profile.device.id;
  const read = {
    id: "fixture.read", schemaVersion: "1", semanticVerb: "inspect.connectivity", inputSchema: {}, outputSchema: {},
    sideEffect: "read_only", approvalClass: "allow", requiredPermissions: ["ble"], prerequisites: [],
    timeoutMs: 5_000, responseBytesLimit: 1_024, idempotency: "request", supportedDeviceKinds: ["hardware"], supportedTransports: ["ble"],
  } as const;
  const write = { ...read, id: "fixture.write", sideEffect: "reversible", approvalClass: "ask", verificationCapabilityId: read.id, requiresRecovery: true } as const;
  const expiresAt = "2026-11-21T10:00:20.000Z";
  const snapshot: DeviceCapabilitySnapshotV1 = {
    snapshotId: "snapshot", deviceId, adapterId: profile.adapterId, adapterVersion: profile.adapterVersion, contractMajor: 1,
    connectionRevision: "primary", capabilities: [read, write], observedAt: time, freshnessUntil: expiresAt,
  };
  const task: DeviceTaskV1 = {
    id: "task", ownerKind: "mobile", ownerId: "phone", targetDeviceIds: [deviceId], status: "planning",
    capabilitySnapshotIds: [snapshot.snapshotId], createdAt: time, updatedAt: time,
  };
  const baseline: DeviceObservationV1 = {
    id: "baseline", subjectId: deviceId, source: "ble", value: { online: false }, observedAt: time,
    receivedAt: time, freshnessUntil: expiresAt, provenance: [deviceId], quality: "good", redactionClass: "public",
  };
  const readRequest: DeviceActionRequestV1 = {
    taskId: task.id, actionId: "read", targetDeviceId: deviceId, capabilityId: read.id, capabilitySchemaVersion: "1",
    capabilitySnapshotId: snapshot.snapshotId, normalizedInput: {}, idempotencyKey: "read",
  };
  const recoveryPlan = { kind: "alternate_route", routeRevision: "usb-fixture", baselineObservationId: baseline.id, verifyBy: expiresAt } as const;
  const rule = { online: true };
  const proposal = { ...readRequest, actionId: "write", capabilityId: write.id, idempotencyKey: "write", expectedVerification: rule, recoveryPlan };
  const approval = {
    approvalId: "approval", taskId: task.id, actionId: proposal.actionId, targetDeviceId: deviceId,
    capabilitySnapshotId: snapshot.snapshotId, connectionRevision: snapshot.connectionRevision, policyRevision: "device-policy-v1",
    normalizedInputDigest: digestDeviceRequest(proposal), expiresAt, recoveryScope: recoveryPlan,
  };
  for (const scenario of ["foreign readback", "fresh readback", "suspended route check"]) {
    await t.test(scenario, async () => {
      const sameTarget = scenario !== "foreign readback";
      const suspends = scenario === "suspended route check";
      const storage = new MemoryStorage();
      const journal = createAsyncStorageMobileDeviceJournal(storage, task.ownerId);
      const execution = new MobileDeviceExecution({ journal, ownerId: task.ownerId, now: options.now });
      const started = Promise.withResolvers<AbortSignal>();
      const recoveryProof = Promise.withResolvers<boolean>();
      let writes = 0;
      let probes = 0;
      const transport: MobileDeviceTransport = {
        deviceId, connectionRevision: snapshot.connectionRevision, permissions: ["ble"],
        async execute({ request }) {
          const reading = request.capabilityId === read.id;
          if (!reading) writes += 1;
          return {
            action: { actionId: request.actionId, status: "completed", observationIds: reading ? [baseline.id] : [], startedAt: time },
            ...(reading ? { observations: [baseline] } : {}),
          };
        },
        async verifyRecoveryPath(input) {
          probes += 1;
          if (suspends && probes === 1) {
            started.resolve(input.signal);
            return recoveryProof.promise;
          }
          return input.plan.routeRevision === recoveryPlan.routeRevision && input.baseline.subjectId === deviceId;
        },
        async verify({ request }) {
          return {
            verification: { actionId: request.actionId, status: "verified", rule, observationIds: ["after"], checkedAt: time },
            observations: [{ ...baseline, id: "after", subjectId: sameTarget ? deviceId : "other-device", value: rule }],
          };
        },
      };
      const context = { profile, snapshot, task, transport };
      await execution.execute({ ...context, request: readRequest, finalizeTask: false });
      await journal.saveTask({ ...task, status: "awaiting_approval" });
      const approved = { ...proposal, approvalId: approval.approvalId, approval };
      await assert.rejects(() => execution.execute({ ...context, request: { ...approved, approval: { ...approval, recoveryScope: undefined } } }), /exact current approval/u);
      assert.equal(probes, 0);
      if (suspends) {
        const pending = execution.execute({ ...context, request: approved });
        const signal = await started.promise;
        execution.setForeground(false);
        assert.equal(signal.aborted, true);
        await assert.rejects(pending, { code: "permission_denied" });
        assert.equal((await journal.getTask(task.id))?.status, "awaiting_approval");
        assert.deepEqual((await journal.listAttempts(task.id)).map(record => record.request.actionId), [readRequest.actionId]);
        assert.equal(writes, 0);
        recoveryProof.resolve(true);
        await execution.recoverAfterResume();
        execution.setForeground(true);
      }
      const result = await execution.execute({ ...context, request: approved });
      const reopened = createAsyncStorageMobileDeviceJournal(storage, task.ownerId);
      assert.equal((await reopened.getTask(task.id))?.status, sameTarget ? "succeeded" : "unknown");
      assert.equal(result.attempt.recoveryPathVerifiedAt, time);
      assert.deepEqual((await reopened.listObservations(task.id)).map(item => item.id), sameTarget ? ["baseline", "after"] : ["baseline"]);
      assert.equal(writes, 1);
      assert.equal(probes, suspends ? 2 : 1);
    });
  }
});

test("a phone-only Home Assistant diagnosis records scoped facts and restores them without a PC", async () => {
  const storage = new MemoryStorage();
  let requests = 0;
  const fetch: HomeAssistantFetch = async (url, init) => {
    requests += 1;
    assert.equal(url, `${target.origin}/api/states/light.kitchen`);
    assert.equal(init.method, "GET");
    assert.equal(init.redirect, "error");
    assert.equal(init.headers.authorization, `Bearer ${target.token}`);
    return Response.json({ entity_id: target.entityId, state: "unavailable", attributes: { text: "untrusted-entity-output" } });
  };
  const phone = await createStandaloneDeviceRuntime({ ...options, storage, fetch });
  await assert.rejects(() => phone.diagnoseHomeAssistant(target), /前台|手机界面/);
  await phone.setForeground(true);
  const result = await phone.diagnoseHomeAssistant(target);
  assert.equal(result.taskStatus, "succeeded");
  assert.equal(result.availability, "unavailable");
  assert.equal(result.entityId, target.entityId);
  const journal = [...storage.values.values()].join("\n");
  for (const value of [target.token, target.origin, "untrusted-entity-output"]) assert.ok(!journal.includes(value));

  const reopened = await createStandaloneDeviceRuntime({ ...options, storage, fetch });
  await reopened.setForeground(true);
  assert.deepEqual(await reopened.listHomeAssistantRuns(), [result]);
  assert.equal(requests, 1);
});

test("phone diagnosis distinguishes missing entities and denied credentials and rejects misbound or oversized results", async () => {
  const responses = [
    new Response(null, { status: 404 }),
    new Response(null, { status: 403 }),
    Response.json({ entity_id: "light.other", state: "on" }),
    new Response("x".repeat(256 * 1024 + 1)),
  ];
  const phone = await createStandaloneDeviceRuntime({
    ...options,
    storage: new MemoryStorage(),
    fetch: async () => {
      const response = responses.shift();
      assert.ok(response, "invalid input must never call the device");
      return response;
    },
  });
  await phone.setForeground(true);
  await assert.rejects(() => phone.diagnoseHomeAssistant({ ...target, origin: "http://ha.fixture.example" }), /HTTPS/);
  await assert.rejects(() => phone.diagnoseHomeAssistant({ ...target, origin: "https://ha.fixture.example/path" }), /HTTPS/);
  await assert.rejects(() => phone.diagnoseHomeAssistant({ ...target, token: "abc\r\ncredential" }), /令牌/);
  assert.equal((await phone.diagnoseHomeAssistant(target)).availability, "absent");
  assert.equal((await phone.diagnoseHomeAssistant(target)).errorCode, "permission_denied");
  assert.equal((await phone.diagnoseHomeAssistant(target)).errorCode, "service_unavailable");
  assert.equal((await phone.diagnoseHomeAssistant(target)).errorCode, "service_unavailable");
  assert.equal((await phone.listHomeAssistantRuns()).length, 4);
  assert.equal(responses.length, 0);
});

test("a phone restart marks interrupted work unknown without replaying a device request", async () => {
  const storage = new MemoryStorage();
  const began = Promise.withResolvers<void>();
  const stop = new AbortController();
  const phone = await createStandaloneDeviceRuntime({
    ...options,
    storage,
    fetch: async (_url, { signal }) => {
      began.resolve();
      return new Promise<Response>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("disconnected")), { once: true }));
    },
  });
  await phone.setForeground(true);
  const diagnosis = phone.diagnoseHomeAssistant({ ...target, signal: stop.signal });
  await began.promise;
  const reopenedStorage = new MemoryStorage(storage.values);
  stop.abort();
  assert.equal((await diagnosis).taskStatus, "unknown");

  let resumedRequests = 0;
  const reopened = await createStandaloneDeviceRuntime({
    ...options,
    storage: reopenedStorage,
    fetch: async () => {
      resumedRequests += 1;
      return Response.json({ entity_id: target.entityId, state: "on" });
    },
  });
  await reopened.setForeground(true);
  const [retained] = await reopened.listHomeAssistantRuns();
  assert.equal(retained?.taskStatus, "unknown");
  assert.equal(retained?.availability, undefined);
  assert.equal(resumedRequests, 0);
});

const linuxTarget = {
  host: "192.0.2.40", port: 22, username: "operator",
  fingerprint: "SHA256:" + Buffer.alloc(32, 5).toString("base64").replace(/=+$/u, ""),
  dnsProbeHostname: "checking.example.test",
};
const linuxPassword = "authorized-ssh-fixture";
const unusedFetch: HomeAssistantFetch = async () => { throw new Error("this task owns its SSH connection"); };

test("phone Linux diagnosis retains its pinned identity and redacted evidence across address changes and reopen", async () => {
  const storage = new MemoryStorage();
  const reads: string[] = [];
  let connections = 0;
  let closed = 0;
  const phone = await createStandaloneDeviceRuntime({
    ...options, storage, fetch: unusedFetch,
    openLinuxSsh: async (target, fingerprint, password) => {
      connections += 1;
      assert.equal(target.username, linuxTarget.username);
      assert.equal(fingerprint, "05".repeat(32));
      assert.equal(password, linuxPassword);
      return {
        async read(operation, argument) {
          reads.push(argument === undefined ? operation : operation + ":" + argument);
          const outputs: Record<string, string> = {
            kernel: "Linux 6.6\n",
            addresses: '[{"ifname":"wlan0","addr_info":[{"family":"inet","scope":"global","local":"192.0.2.25"}]}]',
            route: '[{"dev":"wlan0","prefsrc":"192.0.2.25"}]',
            wifi: "phy#0\n\tInterface wlan0\n",
            link: "Connected to 00:11:22:33:44:55 (on wlan0)\n\tSSID: Fixture Hotspot\n",
          };
          if (operation === "dns") return { stdout: "", stderr: "unsupported tool", exitCode: 127 };
          const stdout = outputs[operation];
          assert.ok(stdout);
          return { stdout, stderr: "", exitCode: 0 };
        },
        close() { closed += 1; },
      };
    },
  });
  await assert.rejects(() => phone.diagnoseLinuxSsh({ target: linuxTarget, password: linuxPassword }), /手机界面/u);
  await phone.setForeground(true);
  await assert.rejects(() => phone.diagnoseLinuxSsh({
    target: { ...linuxTarget, dnsProbeHostname: "192.0.2.1" }, password: linuxPassword,
  }), /DNS 测试域名/u);
  const result = await phone.diagnoseLinuxSsh({ target: linuxTarget, password: linuxPassword });
  assert.equal(result.taskStatus, "succeeded");
  assert.deepEqual(result.facts, { connected: true, routeAvailable: true, wifiAssociated: true });
  assert.deepEqual(reads, ["kernel", "addresses", "route", "wifi", "link:wlan0", "dns:checking.example.test"]);

  const moved = { ...linuxTarget, host: "192.0.2.42" };
  const next = await phone.diagnoseLinuxSsh({ target: moved, password: linuxPassword });
  assert.equal(next.deviceId, result.deviceId);
  assert.equal(next.taskStatus, "succeeded");
  assert.notEqual(next.taskId, result.taskId);
  assert.equal(closed, 2);
  assert.deepEqual(await phone.listLinuxSshTargets(), [{ ...moved, deviceId: result.deviceId }]);
  const persisted = [...storage.values.values()].join("\n");
  assert.doesNotMatch(persisted, /authorized-ssh-fixture|Fixture Hotspot|192\.0\.2\.25|unsupported tool/u);
  for (const [key, value] of storage.values) {
    if (key.startsWith("ling-device-execution:")) assert.doesNotMatch(value, /192\.0\.2\.42|checking\.example\.test/u);
  }

  const reopened = await createStandaloneDeviceRuntime({
    ...options, storage, fetch: unusedFetch,
    openLinuxSsh: async () => { throw new Error("reopen must not contact the device"); },
  });
  await reopened.setForeground(true);
  assert.deepEqual(await reopened.listLinuxSshRuns(), [next, result]);
  assert.equal(connections, 2);
});

test("phone SSH denial retains a failed receipt and leaves the target unenrolled", async () => {
  const storage = new MemoryStorage();
  const phone = await createStandaloneDeviceRuntime({
    ...options, storage, fetch: unusedFetch,
    openLinuxSsh: async () => { throw new Error("ssh_host_key_mismatch untrusted failure detail"); },
  });
  await phone.setForeground(true);
  const result = await phone.diagnoseLinuxSsh({ target: linuxTarget, password: linuxPassword });
  assert.equal(result.taskStatus, "failed");
  assert.equal(result.errorCode, "target_changed");
  assert.equal(result.facts, undefined);
  assert.deepEqual(await phone.listLinuxSshTargets(), []);
  assert.doesNotMatch([...storage.values.values()].join("\n"), /untrusted failure detail|authorized-ssh-fixture/u);
});

test("leaving the foreground stops the phone Linux connection and retains the interrupted attempt", async () => {
  const storage = new MemoryStorage();
  const began = Promise.withResolvers<void>();
  const phone = await createStandaloneDeviceRuntime({
    ...options, storage, fetch: unusedFetch,
    openLinuxSsh: async (_target, _pin, _password, signal) => {
      assert.ok(signal);
      began.resolve();
      return await new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("closed")), { once: true }));
    },
  });
  await phone.setForeground(true);
  const running = phone.diagnoseLinuxSsh({ target: linuxTarget, password: linuxPassword });
  await began.promise;
  await phone.setForeground(false);
  const run = await running;
  assert.equal(run.taskStatus, "unknown");
  await phone.setForeground(true);
  assert.deepEqual(await phone.listLinuxSshRuns(), [run]);
  assert.deepEqual(await phone.listLinuxSshTargets(), []);
});
