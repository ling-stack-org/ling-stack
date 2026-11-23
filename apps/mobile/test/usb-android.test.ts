import assert from "node:assert/strict";
import test from "node:test";

import type { AndroidApkIdentityV1 } from "@ling-stack/contracts";
import { createAsyncStorageMobileDeviceJournal, type MobileStorageLike } from "../src/device/journal.ts";
import { MobileDeviceExecution } from "../src/device/execution.ts";
import { createPhoneUsbAndroidRuntime } from "../src/device/usb-android-runtime.ts";
import type { UsbAndroidBridge, UsbAndroidDevice, UsbAndroidSession } from "../src/device/usb-android.ts";
import type { OpenPhoneTaskArtifactFile } from "../src/device/phone-task-artifacts.ts";
import { projectMobileTaskEvidenceExport } from "../src/device/conformance.ts";

class MemoryStorage implements MobileStorageLike {
  readonly values = new Map<string, string>();
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) { this.values.set(key, value); }
}

const now = () => "2026-11-23T12:00:00.000Z";
const identity: AndroidApkIdentityV1 = {
  packageId: "com.example.headunit",
  versionCode: "42",
  signerCertificateSha256: ["a".repeat(64)],
};
const digest = "sha256:" + "b".repeat(64);
const target: UsbAndroidDevice = { portId: "usb0:0", vendorId: 0x18d1, productId: 0x4ee7, label: "head unit", permissionGranted: true };

function createFixture(options: { readonly loseInstallReply?: boolean } = {}) {
  const storage = new MemoryStorage();
  const journal = createAsyncStorageMobileDeviceJournal(storage, "phone_owner_fixture_12345678");
  const execution = new MobileDeviceExecution({ ownerId: "phone_owner_fixture_12345678", journal, now });
  execution.setForeground(true);
  let installs = 0;
  let reads = 0;
  let hardwareDigest = "1".repeat(64);
  const session: UsbAndroidSession = {
    get identity() { return { hardwareDigest, firmwareDigest: "2".repeat(64), model: "Head Unit", androidVersion: "11" }; },
    async install(uri, receivedDigest) {
      assert.equal(uri, "file:///private/device-artifacts/apk1/verified/head-unit.apk");
      assert.equal(receivedDigest, digest);
      installs += 1;
      if (options.loseInstallReply) throw new Error("connection_lost");
      return true;
    },
    async readPackage(packageId) {
      assert.equal(packageId, identity.packageId);
      reads += 1;
      return { present: true, versionCode: identity.versionCode, digest };
    },
    async readLogs(tag) { return tag ? `[${tag}] connected\n` : "connected\n"; },
    close() {},
  };
  const bridge: UsbAndroidBridge = {
    async list() { return [target]; },
    async authorize() {},
    async open(selected) {
      assert.deepEqual(selected, target);
      return session;
    },
  };
  const file: OpenPhoneTaskArtifactFile = () => ({
    uri: () => "file:///private/device-artifacts/apk1/verified/head-unit.apk",
    async size() { return 1024; },
    async append() {},
    async digest() { return digest; },
    async reset() {},
    async seal() {},
    async export() {},
    async inspectAndroidApk() { return identity; },
  });
  let idSequence = 0;
  const runtime = createPhoneUsbAndroidRuntime({
    bridge, ownerId: "phone_owner_fixture_12345678", policyRevision: "device-policy-v1",
    randomId: async prefix => prefix + "_1234567890abcdef" + (++idSequence),
    now, journal, execution, openFile: file, async listSaved() { return []; }, async readProjection() { return undefined; },
    async waitForForeground() {}, foregroundOperations: new Set(),
  });
  return {
    runtime, journal, target,
    changeTarget() { hardwareDigest = "3".repeat(64); },
    get installs() { return installs; }, get reads() { return reads; },
  };
}

test("phone-owned USB Android install binds APK identity and verifies installed bytes", async () => {
  const fixture = createFixture();
  const diagnosis = await fixture.runtime.identify({ target: fixture.target });
  const review = await fixture.runtime.review(diagnosis.taskId, { source: "phone_file", fileId: "apk1", name: "head-unit.apk" });
  assert.deepEqual(review.identity, identity);
  const run = await fixture.runtime.install({ target: fixture.target, review });
  assert.equal(run.status, "succeeded");
  assert.equal(run.installedDigest, digest);
  assert.equal(fixture.installs, 1);
  assert.equal(fixture.reads, 1);
});

test("phone-owned USB Android does not dispatch a second install after a retained task", async () => {
  const fixture = createFixture();
  const diagnosis = await fixture.runtime.identify({ target: fixture.target });
  const review = await fixture.runtime.review(diagnosis.taskId, { source: "phone_file", fileId: "apk1", name: "head-unit.apk" });
  const first = await fixture.runtime.install({ target: fixture.target, review });
  const second = await fixture.runtime.install({ target: fixture.target, review });
  assert.equal(second.taskId, first.taskId);
  assert.equal(fixture.installs, 1);
});

test("phone-owned USB Android retains a lost install reply until package readback", async () => {
  const fixture = createFixture({ loseInstallReply: true });
  const diagnosis = await fixture.runtime.identify({ target: fixture.target });
  const review = await fixture.runtime.review(diagnosis.taskId, { source: "phone_file", fileId: "apk1", name: "head-unit.apk" });
  const pending = await fixture.runtime.install({ target: fixture.target, review });
  assert.equal(pending.status, "unknown");
  assert.equal(fixture.installs, 1);
  const settled = await fixture.runtime.readback({ target: fixture.target, taskId: pending.taskId });
  assert.equal(settled.status, "succeeded");
  assert.equal(settled.installedDigest, digest);
  assert.equal(fixture.installs, 1);
  assert.equal(fixture.reads, 1);
});

test("USB Android rejects an APK installation when the connected target changed after review", async () => {
  const fixture = createFixture();
  const diagnosis = await fixture.runtime.identify({ target: fixture.target });
  const review = await fixture.runtime.review(diagnosis.taskId, { source: "phone_file", fileId: "apk1", name: "head-unit.apk" });
  fixture.changeTarget();
  await assert.rejects(fixture.runtime.install({ target: fixture.target, review }), /usb_target_changed/u);
  assert.equal(fixture.installs, 0);
  assert.deepEqual(await fixture.runtime.listInstalls(), []);
});

test("phone-owned USB Android captures bounded logs under the enrolled target", async () => {
  const fixture = createFixture();
  const diagnosis = await fixture.runtime.identify({ target: fixture.target });
  await assert.rejects(fixture.runtime.captureLogs({ target: fixture.target, diagnosisTaskId: diagnosis.taskId, tag: "*:V" }), /invalid_log_tag/u);
  const run = await fixture.runtime.captureLogs({ target: fixture.target, diagnosisTaskId: diagnosis.taskId, tag: "DiPlay" });
  assert.equal(run.status, "succeeded");
  assert.equal(run.tag, "DiPlay");
  assert.equal(run.text, "[DiPlay] connected\n");
  assert.deepEqual(await fixture.runtime.listLogs(), [run]);
  const evidence = await fixture.journal.readTaskEvidence(run.taskId);
  assert.equal(evidence.observations[0]?.redactionClass, "sensitive");
  const exported = projectMobileTaskEvidenceExport(evidence, "phone_owner_fixture_12345678");
  assert.ok(exported);
  assert.doesNotMatch(JSON.stringify(exported), /\[DiPlay\] connected/u);
});
