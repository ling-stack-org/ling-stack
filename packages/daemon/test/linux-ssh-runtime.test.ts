import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeviceDiagnosisReportV1, DeviceProfileV1, DeviceTaskJournalPageV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, DEFAULT_WORKSPACE_ID, SqliteDeviceSupportStore } from "@ling-stack/core";
import { createDaemonServer, type DaemonServer } from "../dist/index.js";
import type { LocalProcessRunner } from "../dist/features/device-support/adapters/local-pc-executor.js";
import { readLinuxSshTargets } from "../dist/features/device-support/linux-ssh-targets.js";

function publicHostKey(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  const publicValue = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  const wire = Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), publicValue]);
  return "ssh-ed25519 " + wire.toString("base64");
}

test("Linux SSH configuration rejects ambiguous device identities and inline secrets", t => {
  const root = mkdtempSync(join(tmpdir(), "ling-linux-ssh-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "targets.json");
  const target = {
    connectionId: "one", host: "192.0.2.23", user: "ling", identityFile: join(root, "local-identity"), hostKey: publicHostKey(),
  };
  writeFileSync(file, JSON.stringify({ version: 1, targets: [target, { ...target, connectionId: "two", host: "192.0.2.24" }] }));
  assert.throws(() => readLinuxSshTargets(file), /host keys must be unique/u);
  writeFileSync(file, JSON.stringify({ version: 1, targets: [{ ...target, password: "temporary-fixture" }] }));
  assert.throws(() => readLinuxSshTargets(file), /Invalid Linux SSH target/u);
});

test("Linux SSH enrollment, diagnosis, and reconnection use the exact configured target", { timeout: 25_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), "ling-linux-ssh-runtime-"));
  const cwd = join(root, "workspace");
  const targetsFile = join(root, "targets.json");
  mkdirSync(cwd);
  const previousHome = process.env.LING_STACK_HOME;
  process.env.LING_STACK_HOME = join(root, "installation");
  let daemon: DaemonServer | undefined;
  t.after(async () => {
    try {
      await daemon?.stop();
    } finally {
      if (previousHome === undefined) delete process.env.LING_STACK_HOME;
      else process.env.LING_STACK_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });
  const keyA = publicHostKey();
  const keyB = publicHostKey();
  const identityFile = join(root, "ssh client identity");
  const dnsProbeHostname = "checking.example.test";
  const alpha = { connectionId: "alpha", host: "192.0.2.20", user: "ling", port: 2222, hostKey: keyA, identityFile, dnsProbeHostname };
  const beta = { ...alpha, connectionId: "beta", host: "192.0.2.21", hostKey: keyB };
  writeFileSync(targetsFile, JSON.stringify({ version: 1, targets: [alpha, beta] }));

  const calls: Array<{ host: string; command: string }> = [];
  const trustFiles = new Set<string>();
  const disconnected = new Set<string>();
  const linuxSshProcessRunner: LocalProcessRunner = {
    async run(file, args) {
      assert.equal(file, "ssh");
      const delimiter = args.indexOf("--");
      assert.ok(delimiter > 0);
      const host = args[delimiter + 1]!;
      const command = args.slice(delimiter + 2).join(" ");
      calls.push({ host, command });
      assert.equal(args[args.indexOf("-i") + 1], identityFile);
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.ok(args.includes("GlobalKnownHostsFile=none"));
      const trustFile = args.find(arg => arg.startsWith("UserKnownHostsFile="))!.split('"')[1]!;
      trustFiles.add(trustFile);
      const hostKey = host === beta.host ? keyB : keyA;
      assert.equal(readFileSync(trustFile, "utf8"), "[" + host + "]:2222 " + hostKey + "\n");
      if (disconnected.has(host)) return { stdout: "", stderr: "fixture connection credential detail", exitCode: 255 };
      const commands: Record<string, string> = {
        hostname: "same-board\n",
        "uname -sr": "Linux 6.6\n",
        "ip -j addr": '[{"ifname":"wlan0","addr_info":[{"family":"inet","scope":"global","local":"192.0.2.25"}]}]',
        "env LC_ALL=C ip -j route get 1.1.1.1": '[{"dev":"wlan0","prefsrc":"192.0.2.25"}]',
        "iw dev": "phy#0\n\tInterface wlan0\n",
        "iw dev wlan0 link": "Connected to 00:11:22:33:44:55 (on wlan0)\n\tSSID: Fixture Hotspot\n",
      };
      if (command === "getent -s dns ahostsv4 " + dnsProbeHostname) {
        return host === beta.host
          ? { stdout: "", stderr: "", exitCode: 2 }
          : { stdout: "192.0.2.53 STREAM " + dnsProbeHostname + "\n", stderr: "", exitCode: 0 };
      }
      assert.ok(Object.hasOwn(commands, command), "unexpected SSH command: " + command);
      return { stdout: commands[command]!, stderr: "", exitCode: 0 };
    },
  };

  const authToken = "fixture-linux-route-authority";
  const headers = { Authorization: "Bearer " + authToken, "Content-Type": "application/json" };
  let baseUrl = "";
  let databasePath = "";
  async function start() {
    const workspace = createSqliteRunStore(cwd);
    databasePath = workspace.paths.databasePath;
    daemon = createDaemonServer({
      host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd,
      deviceSupport: { linuxSshTargetsFile: targetsFile },
    }, { storeFactory: () => workspace, linuxSshProcessRunner });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    baseUrl = "http://127.0.0.1:" + address.port + "/v1/device-support";
  }

  const getTargets = async () => {
    const response = await fetch(baseUrl + "/linux/targets", { headers });
    assert.equal(response.status, 200);
    return await response.json() as { targets: Array<{ connectionId: string; deviceId: string; status: string }> };
  };
  const post = (action: "enroll" | "diagnose", body: object) =>
    fetch(baseUrl + "/linux/" + action, { method: "POST", headers, body: JSON.stringify(body) });
  const enroll = async (connectionId: string) => {
    const response = await post("enroll", { connectionId });
    assert.equal(response.status, 200);
    const { profile } = await response.json() as { profile: DeviceProfileV1 };
    assert.doesNotMatch(JSON.stringify(profile), /identityFile|hostKey|192\.0\.2\./u);
    return profile;
  };
  const diagnose = async (deviceId: string) => {
    const response = await post("diagnose", { deviceId });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("cache-control") ?? "", /no-store/u);
    return await response.json() as { status: string; report: DeviceDiagnosisReportV1 };
  };

  await start();
  assert.equal((await fetch(baseUrl + "/linux/targets")).status, 401);
  assert.equal((await fetch(baseUrl + "/linux/targets", { headers: { ...headers, Origin: "https://unrelated.example.test" } })).status, 403);
  const { targets } = await getTargets();
  assert.deepEqual(targets.map(target => target.status), ["candidate", "candidate"]);
  assert.equal((await post("diagnose", { deviceId: targets[0]!.deviceId })).status, 404);
  assert.equal((await post("enroll", { connectionId: "alpha", host: beta.host })).status, 400);
  assert.equal(calls.length, 0);
  const enrolledA = await enroll("alpha");
  const enrolledB = await enroll("beta");
  assert.deepEqual([enrolledA.device.displayName, enrolledB.device.displayName], ["same-board", "same-board"]);
  assert.notEqual(enrolledA.device.id, enrolledB.device.id);
  assert.deepEqual([enrolledA.device.id, enrolledB.device.id], targets.map(target => target.deviceId));
  const taskA = await diagnose(enrolledA.device.id);
  const taskB = await diagnose(enrolledB.device.id);
  assert.equal(taskA.status, "succeeded");
  assert.equal(taskB.status, "succeeded");
  assert.equal(taskA.report.playbookId, "linux-wifi-diagnosis");
  assert.deepEqual(taskA.report.facts.map(fact => fact.value), [
    { connected: true, routeAvailable: true, dnsNameResolved: true, wifiAssociated: true },
  ]);
  assert.deepEqual(taskB.report.facts.map(fact => fact.value), [
    { connected: true, routeAvailable: true, dnsNameResolved: false, wifiAssociated: true },
  ]);
  assert.deepEqual(taskB.report.hypotheses.map(hypothesis => hypothesis.code), ["dns_issue"]);
  assert.doesNotMatch(JSON.stringify(taskA), /Fixture Hotspot|192\.0\.2\.25|checking\.example\.test/u);

  const journalResponse = await fetch(baseUrl + "/tasks/" + encodeURIComponent(taskA.report.taskId) + "/events", { headers });
  assert.equal(journalResponse.status, 200);
  const journal = await journalResponse.json() as DeviceTaskJournalPageV1;
  assert.deepEqual(journal.task.targetDeviceIds, [enrolledA.device.id]);
  assert.equal(journal.task.ownerId, "daemon:" + DEFAULT_WORKSPACE_ID);
  assert.ok(journal.events.some(event => event.evidenceRefs?.includes(taskA.report.facts[0]!.observationId)));

  disconnected.add(alpha.host);
  const failed = await diagnose(enrolledA.device.id);
  assert.equal(failed.status, "failed");
  assert.equal(failed.report.actions[0]?.errorCode, "connection_failed");
  assert.deepEqual(failed.report.facts, []);
  assert.doesNotMatch(JSON.stringify(failed), /credential detail/u);
  assert.equal((await getTargets()).targets[0]?.status, "offline");
  assert.ok(trustFiles.size > 0);
  await daemon!.stop();
  daemon = undefined;
  assert.ok([...trustFiles].every(file => !existsSync(file)));

  const movedHost = "192.0.2.42";
  writeFileSync(targetsFile, JSON.stringify({ version: 1, targets: [{ ...alpha, host: movedHost, credentialRevision: "rotated" }] }));
  await start();
  assert.deepEqual((await getTargets()).targets.map(({ deviceId, status }) => [deviceId, status]), [[enrolledA.device.id, "offline"]]);
  const nextCall = calls.length;
  const resumed = await diagnose(enrolledA.device.id);
  assert.equal(resumed.status, "succeeded");
  assert.ok(calls.length > nextCall);
  assert.ok(calls.slice(nextCall).every(call => call.host === movedHost));
  assert.equal((await post("diagnose", { deviceId: enrolledB.device.id })).status, 404);

  const store = new SqliteDeviceSupportStore({ databasePath });
  try {
    const current = store.getDevice(enrolledA.device.id);
    assert.equal(current?.device.id, enrolledA.device.id);
    assert.notDeepEqual(current?.connectionRefs, enrolledA.connectionRefs);
    assert.notEqual(current?.profileRevision, enrolledA.profileRevision);
    assert.ok(store.getTask(taskA.report.taskId));
    assert.ok(store.getTask(failed.report.taskId));
    assert.equal(store.getDevice(enrolledB.device.id)?.device.lifecycleStatus, "offline");
    assert.equal(store.getCurrentCapabilitySnapshot(enrolledB.device.id), undefined);
    assert.deepEqual(store.getCurrentCapabilitySnapshot(enrolledA.device.id)?.capabilities.map(capability => capability.id), [
      "linux.inspect.network", "linux.inspect.wifi",
    ]);
    store.revokeDevice(enrolledA.device.id, new Date().toISOString());
  } finally {
    store.close();
  }
  const beforeRevokedRequests = calls.length;
  assert.equal((await post("enroll", { connectionId: "alpha" })).status, 403);
  assert.equal((await post("diagnose", { deviceId: enrolledA.device.id })).status, 403);
  assert.equal(calls.length, beforeRevokedRequests);
});
