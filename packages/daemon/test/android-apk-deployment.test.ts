import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import type { DeviceDeveloperArtifactV1, DeviceDeveloperJobV1, DeviceDeveloperSessionV1, DeviceProfileV1 } from "@ling-stack/contracts";
import { createSqliteRunStore, SqliteDeviceDeveloperStore, SqliteDeviceSupportStore } from "@ling-stack/core";
import { createDaemonServer } from "../dist/index.js";
import { localProcessRunner, type LocalProcessRunner } from "../dist/features/device-support/adapters/local-pc-executor.js";

test("the PC installs a verified APK through the developer session and replays the original outcome", { timeout: 20_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-native-apk-"));
  const authToken = "local-fixture-apk-authority";
  const headers = { Authorization: "Bearer " + authToken, "Content-Type": "application/json" };
  const targetsPath = join(cwd, "targets.json");
  const native = process.env.LING_TEST_ANDROID_FIXTURE_DIR || undefined;
  const apk = native ? readFileSync(join(native, "fixture.apk")) : Buffer.from("signed test APK");
  const apkSha256 = createHash("sha256").update(apk).digest("hex");
  const unsigned = native ? readFileSync(join(native, "fixture-unsigned.apk")) : Buffer.from("unsigned test APK");
  const serial = "fixture-approved-hardware";
  const fingerprint = "fixture/device/build";
  const packageId = "org.lingstack.devicefixture";
  const tools = {
    javaPath: process.env.LING_TEST_ANDROID_JAVA ?? process.execPath,
    apkSignerJar: join(native ?? cwd, "apksigner.jar"),
    aapt2Path: join(native ?? cwd, "aapt2"),
  };
  if (!native) {
    writeFileSync(tools.apkSignerJar, "");
    writeFileSync(tools.aapt2Path, "");
  }
  writeFileSync(targetsPath, JSON.stringify({
    version: 1, apkTools: tools,
    targets: [{ connectionId: "bench", adbSerial: "fixture-adb", hardwareSerial: serial, kind: "head_unit" }],
  }));
  let installs = 0;
  let installedVersion = "41";
  let installedSha256 = "";
  let lostReply = false;
  let interruptedUploadTarget = false;
  const runner: LocalProcessRunner = {
    async run(file, args, signal, input) {
      if (file === tools.javaPath || file === tools.aapt2Path) {
        if (native) return await localProcessRunner.run(file, args, signal);
        const fileBytes = readFileSync(file === tools.javaPath ? args.at(-1)! : args[2]!);
        if (file === tools.javaPath) {
          assert.deepEqual(args.slice(0, -1), ["-jar", tools.apkSignerJar, "verify", "--verbose", "--print-certs"]);
          if (fileBytes.equals(unsigned)) return { stdout: "", stderr: "", exitCode: 1 };
          assert.deepEqual(fileBytes, apk);
          return { stdout: "Verifies\nSigner #1 certificate SHA-256 digest: " + "b".repeat(64) + "\n", stderr: "", exitCode: 0 };
        }
        assert.deepEqual(args.slice(0, 2), ["dump", "xmltree"]);
        assert.deepEqual(args.slice(3), ["--file", "AndroidManifest.xml"]);
        assert.deepEqual(fileBytes, apk);
        return { stdout: [
          "E: manifest (line=2)",
          "  A: http://schemas.android.com/apk/res/android:versionCode(0x0101021b)=42",
          "  A: http://schemas.android.com/apk/res/android:versionCodeMajor(0x01010576)=1",
          `  A: package="${packageId}"`,
          "  E: application",
        ].join("\n"), stderr: "", exitCode: 0 };
      }
      assert.deepEqual(args.slice(0, 4), ["-H", "localhost", "-P", "5037"]);
      if (args[4] === "devices") return { stdout: "List of devices attached\nfixture-adb device transport_id:17\n", stderr: "", exitCode: 0 };
      assert.deepEqual(args.slice(4, 8), ["-t", "17", "shell", "-T"]);
      const command = args[8]!;
      if (input) {
        assert.match(command, /pm install -r -S \d+ -- -/u);
        assert.ok(command.includes(`[ "$serial" = '${serial}' ]`));
        assert.ok(command.includes(`[ "$fingerprint" = '${fingerprint}' ]`));
        if (interruptedUploadTarget) return { stdout: "different-device\n", stderr: "", exitCode: 1 };
        assert.equal(input.readyPrefix, `${serial}\n${fingerprint}\nling-apk-input-ready\n`);
        const received = [];
        for await (const chunk of input.source) received.push(Buffer.from(chunk));
        assert.deepEqual(Buffer.concat(received), apk);
        installs += 1;
        installedVersion = "42";
        installedSha256 = apkSha256;
        return lostReply ? { stdout: "", stderr: "", exitCode: 1 }
          : { stdout: input.readyPrefix + "Success\nling-apk-result:0\n", stderr: "", exitCode: 0 };
      }
      if (command.includes("pm list packages")) {
        // An Android 7 target only reports package names through this command.
        return { stdout: `${serial}\n${fingerprint}\npackage:${packageId}\n`, stderr: "", exitCode: 0 };
      }
      if (command.includes("dumpsys package")) {
        assert.match(command, /dumpsys package org\.lingstack\.devicefixture/u);
        return { stdout: `${serial}\n${fingerprint}\nPackages:\n  Package [${packageId}] (123a):\n    versionCode=${installedVersion} minSdk=24\n`, stderr: "", exitCode: 0 };
      }
      if (command.includes("pm path")) {
        assert.match(command, /pm path org\.lingstack\.devicefixture/u);
        assert.match(command, /sha256sum "\$apk"/u);
        return { stdout: `${serial}\n${fingerprint}\n${installedSha256}\n`, stderr: "", exitCode: 0 };
      }
      return { stdout: `${serial}\nFixture head unit\n7.1.2\n${fingerprint}\n`, stderr: "", exitCode: 0 };
    },
  };
  let daemon: ReturnType<typeof createDaemonServer> | undefined;
  let databasePath = "";
  const start = async () => {
    const workspace = createSqliteRunStore(cwd);
    databasePath = workspace.paths.databasePath;
    daemon = createDaemonServer({
      host: "127.0.0.1", port: 0, authToken, defaultWorkspaceCwd: cwd, deviceSupport: { androidAdbTargetsFile: targetsPath },
    }, { storeFactory: () => workspace, androidAdbProcessRunner: runner, chromeBrowserNativeMessagingEnabled: false, remoteReplyDispatcher: null });
    await daemon.start();
    const address = daemon.server.address();
    assert.ok(address && typeof address === "object");
    return `http://127.0.0.1:${address.port}/v1/device-support`;
  };
  t.after(async () => {
    await daemon?.stop();
    rmSync(cwd, { recursive: true, force: true });
  });
  let base = await start();
  const post = (path: string, body: object) => fetch(base + path, { method: "POST", headers, body: JSON.stringify(body) });
  const enrollment = await post("/android/enroll", { connectionId: "bench" });
  assert.equal(enrollment.status, 200);
  const { profile } = (await enrollment.json()) as { profile: DeviceProfileV1 };
  const sessionsPath = "/developer/sessions";
  const authorize = async () => {
    const created = await post(sessionsPath, { targetDeviceId: profile.device.id, mode: "developer" });
    assert.equal(created.status, 201);
    const { session } = (await created.json()) as { session: DeviceDeveloperSessionV1 };
    const path = sessionsPath + "/" + session.sessionId;
    const authorized = await post(path + "/authorize", { expectedRevision: session.revision });
    assert.equal(authorized.status, 200);
    return { path, session: ((await authorized.json()) as { session: DeviceDeveloperSessionV1 }).session };
  };
  const upload = (path: string, revision: number, bytes: Buffer) => fetch(base + path + "/artifact?expectedRevision=" + revision, {
    method: "POST", headers: { ...headers, "Content-Type": "application/vnd.android.package-archive" }, body: new Blob([new Uint8Array(bytes)]),
  });
  const opened = await authorize();
  assert.equal((await upload(opened.path, opened.session.revision, unsigned)).status, 400);
  assert.equal((await fetch(base + opened.path + "/artifact", { headers })).status, 404);
  const response = await upload(opened.path, opened.session.revision, apk);
  assert.equal(response.status, 201);
  const { session, artifact } = (await response.json()) as { session: DeviceDeveloperSessionV1; artifact: DeviceDeveloperArtifactV1 };
  assert.equal(artifact.digest, "sha256:" + apkSha256);
  assert.equal(artifact.targetDeviceId, profile.device.id);
  assert.equal(artifact.packageId, packageId);
  assert.equal(artifact.androidApk?.versionCode, native ? "42" : "4294967338");
  assert.equal(artifact.androidApk?.legacyVersionCode, native ? undefined : "42");
  assert.match(artifact.androidApk?.signerCertificateSha256[0] ?? "", /^[0-9a-f]{64}$/u);
  assert.equal(session.artifactId, artifact.artifactId);
  assert.equal(installs, 0);
  const input = { jobId: "fixture-install", kind: "deploy", artifactDigest: artifact.digest,
    authorizationRevision: session.authorizationRevision, expectedSessionRevision: session.revision };
  assert.equal((await post(opened.path + "/jobs", { ...input, expectedSessionRevision: opened.session.revision })).status, 409);
  assert.equal((await post(opened.path + "/jobs", { ...input, artifactDigest: "sha256:" + "a".repeat(64) })).status, 409);
  assert.equal(installs, 0);
  const submitted = await post(opened.path + "/jobs", input);
  assert.equal(submitted.status, 201);
  const { job } = (await submitted.json()) as { job: DeviceDeveloperJobV1 };
  assert.equal(job.status, "completed");
  assert.equal(job.taskStatus, "succeeded");
  assert.equal(installs, 1);
  const journal = new SqliteDeviceSupportStore({ databasePath });
  try {
    const [attempt] = journal.listAttempts(job.outputRef!);
    assert.ok(attempt?.attempt.approvalId);
    assert.equal(attempt.attempt.verification?.status, "verified");
    assert.deepEqual(attempt.request.normalizedInput, { artifactDigest: artifact.digest, packageId, versionCode: "42" });
    assert.deepEqual(journal.listObservations(job.outputRef!).at(-1)?.value,
      { packageId, present: true, versionCode: "42", artifactDigest: artifact.digest });
  } finally { journal.close(); }
  const repeated = await post(opened.path + "/jobs", input);
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), { job });
  const next = await authorize();
  const staged = await upload(next.path, next.session.revision, apk);
  assert.equal(staged.status, 201);
  const lostSession = ((await staged.json()) as { session: DeviceDeveloperSessionV1 }).session;
  const lostInput = { ...input, jobId: "lost-install-reply", authorizationRevision: lostSession.authorizationRevision, expectedSessionRevision: lostSession.revision };
  lostReply = true;
  const interrupted = await post(next.path + "/jobs", lostInput);
  assert.equal(interrupted.status, 201);
  const lost = (await interrupted.json()) as { job: DeviceDeveloperJobV1 };
  assert.equal(lost.job.status, "unknown");
  assert.equal(installs, 2);
  await daemon?.stop();
  const jobs = new SqliteDeviceDeveloperStore({ databasePath });
  try {
    // Simulate a process exit after the device journal commit and before the job settled.
    jobs.saveJob({ ...job, status: "running", taskStatus: "executing", outputRef: undefined, revision: job.revision + 1 });
  } finally { jobs.close(); }
  base = await start();
  const replay = await post(opened.path + "/jobs", input);
  assert.equal(replay.status, 200);
  const { job: recovered } = (await replay.json()) as { job: DeviceDeveloperJobV1 };
  assert.equal(recovered.status, "completed");
  assert.equal(recovered.taskStatus, "succeeded");
  assert.equal(recovered.outputRef, job.outputRef);
  const stillUnknown = await post(next.path + "/jobs", lostInput);
  assert.equal(stillUnknown.status, 200);
  assert.deepEqual(await stillUnknown.json(), lost);
  assert.equal(installs, 2);
  const reopened = await fetch(base + opened.path + "/artifact", { headers });
  assert.equal(reopened.status, 200);
  assert.deepEqual(((await reopened.json()) as { artifact: DeviceDeveloperArtifactV1 }).artifact, artifact);
  const readbackPath = next.path + "/jobs/" + lost.job.jobId + "/readback";
  installedSha256 = "e".repeat(64);
  const mismatched = await post(readbackPath, {});
  assert.equal(mismatched.status, 200);
  const wrong = await mismatched.json() as { status: string; reconciliation: { verification: { status: string; reason: string } } };
  assert.equal(wrong.status, "unresolved");
  assert.equal(wrong.reconciliation.verification.status, "failed");
  assert.match(wrong.reconciliation.verification.reason, /different APK digest/u);
  installedSha256 = "";
  const noHash = await post(readbackPath, {});
  assert.equal(noHash.status, 200);
  assert.equal((await noHash.json() as { status: string }).status, "unresolved");
  installedSha256 = apkSha256;
  const confirmed = await post(readbackPath, {});
  assert.equal(confirmed.status, 200);
  const result = await confirmed.json() as { job: DeviceDeveloperJobV1; taskStatus: string; status: string };
  assert.equal(result.status, "verified");
  assert.equal(result.taskStatus, "succeeded");
  assert.equal(result.job.status, "unknown");
  assert.equal(installs, 2);
  const third = await authorize();
  const target = await upload(third.path, third.session.revision, apk);
  assert.equal(target.status, 201);
  const targetSession = ((await target.json()) as { session: DeviceDeveloperSessionV1 }).session;
  interruptedUploadTarget = true;
  const changed = await post(third.path + "/jobs", { ...input, jobId: "foreign-install-target",
    authorizationRevision: targetSession.authorizationRevision, expectedSessionRevision: targetSession.revision });
  assert.equal(changed.status, 201);
  assert.equal(((await changed.json()) as { job: DeviceDeveloperJobV1 }).job.status, "unknown");
  assert.equal(installs, 2);
});

test("the process sends APK contents only after the exact target presents its ready prefix", { timeout: 8_000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), "ling-apk-input-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const receivedPath = join(cwd, "received.bin");
  const body = Buffer.alloc(100_000, 17);
  const code = [
    "const out = process.argv[1]; const ready = process.argv[2]; const chunks = [];",
    "process.stdout.write(ready.slice(0, 4));",
    "setImmediate(() => process.stdout.write(ready.slice(4)));",
    "process.stdin.on('data', chunk => chunks.push(chunk));",
    "process.stdin.on('end', () => { if (chunks.length) require('node:fs').writeFileSync(out, Buffer.concat(chunks)); });",
  ].join(" ");
  const send = (ready: string) => localProcessRunner.run(process.execPath, ["-e", code, receivedPath, ready],
    AbortSignal.timeout(3_000), { source: Readable.from([body]), readyPrefix: "bound-device\n" });
  assert.notEqual((await send("foreign-device\n")).exitCode, 0);
  assert.equal(existsSync(receivedPath), false);
  assert.equal((await send("bound-device\n")).exitCode, 0);
  assert.deepEqual(readFileSync(receivedPath), body);
});
