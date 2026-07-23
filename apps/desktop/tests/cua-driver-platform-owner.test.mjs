import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createPackagedCuaDriverDesktopPlatformOwner } from "../dist/main/cua-driver/platform-owner-composition.js";
import {
  CuaDriverDesktopPlatformOwnerError,
  createCuaDriverDesktopPlatformOwner,
} from "../dist/main/cua-driver/platform-owner.js";
import {
  CUA_DRIVER_RUNTIME_TRUST_POLICY_RESOURCE_SEGMENTS,
  validateCuaDriverRuntimeTrustPolicy,
} from "../dist/main/cua-driver/runtime-trust-policy.js";

const CERTIFICATE_SHA = "b".repeat(64);

test("Darwin platform owner starts one process-wide permission monitor and disposes once", async () => {
  let reads = 0;
  let scheduled = 0;
  let cancelled = 0;
  const owner = createCuaDriverDesktopPlatformOwner({
    platform: "darwin",
    policy: validateCuaDriverRuntimeTrustPolicy({
      schemaVersion: 1,
      componentId: "cua-driver",
      distributionRevision: "0.8.3-ling.1",
      platform: "darwin",
      expectedTeamId: "ABCDEFGHIJ",
    }, "darwin"),
    permissionPort: {
      async read() {
        reads += 1;
        return { accessibility: false, screenRecording: false };
      },
      async probeLiveScreenCapture() {
        return false;
      },
      async requestAccessibility() {},
      async requestScreenRecording() {},
    },
    permissionScheduler: {
      schedule() {
        scheduled += 1;
        return {
          cancel() {
            cancelled += 1;
          },
        };
      },
    },
  });

  assert.equal(owner.platform, "darwin");
  assert.equal(owner.binding.platform, "darwin");
  assert.equal(owner.binding.availability.status, "available");
  await Promise.all([owner.start(), owner.start()]);
  assert.equal(reads, 1);
  assert.equal(scheduled, 1);

  await Promise.all([owner.dispose(), owner.dispose()]);
  assert.equal(cancelled, 1);
  await assert.rejects(
    owner.start(),
    (error) => error instanceof CuaDriverDesktopPlatformOwnerError && error.ownerCode === "disposed",
  );
});

test("Darwin platform owner retries a transient monitor startup failure without duplicating success", async () => {
  let reads = 0;
  let scheduled = 0;
  const owner = createCuaDriverDesktopPlatformOwner({
    platform: "darwin",
    policy: validateCuaDriverRuntimeTrustPolicy({
      schemaVersion: 1,
      componentId: "cua-driver",
      distributionRevision: "0.8.3-ling.1",
      platform: "darwin",
      expectedTeamId: "ABCDEFGHIJ",
    }, "darwin"),
    permissionPort: {
      async read() {
        reads += 1;
        if (reads === 1) throw new Error("transient permission probe failure");
        return { accessibility: false, screenRecording: false };
      },
      async probeLiveScreenCapture() { return false; },
      async requestAccessibility() {},
      async requestScreenRecording() {},
    },
    permissionScheduler: {
      schedule() {
        scheduled += 1;
        return { cancel() {} };
      },
    },
  });

  await assert.rejects(owner.start(), /darwin_permission_unavailable/);
  await owner.start();
  await owner.start();
  assert.equal(reads, 2);
  assert.equal(scheduled, 1);
  await owner.dispose();
});

test("Win32 platform owner requires separately injected trusted SystemRoot and powerMonitor", async () => {
  const policy = validateCuaDriverRuntimeTrustPolicy(internalWindowsPolicy(), "win32");
  assert.throws(
    () => createCuaDriverDesktopPlatformOwner({ platform: "win32", policy, powerMonitor: monitor() }),
    (error) => error instanceof CuaDriverDesktopPlatformOwnerError && error.ownerCode === "system_root_missing",
  );
  assert.throws(
    () => createCuaDriverDesktopPlatformOwner({ platform: "win32", policy, systemRoot: "C:\\Windows" }),
    (error) => error instanceof CuaDriverDesktopPlatformOwnerError && error.ownerCode === "win32_power_monitor_missing",
  );

  const owner = createCuaDriverDesktopPlatformOwner({
    platform: "win32",
    policy,
    systemRoot: "C:\\Windows",
    powerMonitor: monitor(),
  });
  assert.equal(owner.binding.platform, "win32");
  assert.equal(owner.binding.metadata.integrityCoverage, "standard");
  await owner.start();
  await owner.dispose();
  await assert.rejects(
    owner.start(),
    (error) => error instanceof CuaDriverDesktopPlatformOwnerError && error.ownerCode === "disposed",
  );
});

test("platform owner rejects a policy for the other host before creating an adapter", () => {
  const darwinPolicy = validateCuaDriverRuntimeTrustPolicy({
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    platform: "darwin",
    expectedTeamId: "ABCDEFGHIJ",
  }, "darwin");
  assert.throws(
    () => createCuaDriverDesktopPlatformOwner({
      platform: "win32",
      policy: darwinPolicy,
      systemRoot: "C:\\Windows",
      powerMonitor: monitor(),
    }),
    (error) => error instanceof CuaDriverDesktopPlatformOwnerError && error.ownerCode === "platform_mismatch",
  );
});

test("packaged platform-owner composition accepts only a preverified platform policy", async () => {
    const darwinPolicy = validateCuaDriverRuntimeTrustPolicy({
      schemaVersion: 1,
      componentId: "cua-driver",
      distributionRevision: "0.8.3-ling.1",
      platform: "darwin",
      expectedTeamId: "ABCDEFGHIJ",
    }, "darwin");

    const darwin = await createPackagedCuaDriverDesktopPlatformOwner({
      platform: "darwin",
      policy: darwinPolicy,
    });
    assert.equal(darwin.platform, "darwin");
    assert.equal(darwin.binding.platform, "darwin");
    await darwin.dispose();

    const powerMonitor = monitor();
    const win32 = await createPackagedCuaDriverDesktopPlatformOwner({
      platform: "win32",
      policy: validateCuaDriverRuntimeTrustPolicy(internalWindowsPolicy(), "win32"),
      win32SystemRoot: "C:\\Windows",
      win32PowerMonitor: powerMonitor,
      baseEnvironment: { PATH: "C:\\fixture" },
    });
    assert.equal(win32.platform, "win32");
    assert.equal(win32.binding.platform, "win32");
    assert.deepEqual(win32.binding.metadata, {
      integrityCoverage: "standard",
      limitations: ["elevated_pixel_input", "uwp_send_input"],
    });
    await win32.start();
    await win32.dispose();
});

test("packaged platform-owner composition rejects unsupported hosts before reading resources", async () => {
  await assert.rejects(
    createPackagedCuaDriverDesktopPlatformOwner({
      platform: "linux",
      policy: validateCuaDriverRuntimeTrustPolicy(internalWindowsPolicy(), "win32"),
    }),
    (error) => error instanceof CuaDriverDesktopPlatformOwnerError
      && error.ownerCode === "platform_mismatch",
  );
});

function monitor() {
  return {
    on() {},
    off() {},
  };
}

function internalWindowsPolicy() {
  return {
    schemaVersion: 1,
    componentId: "cua-driver",
    distributionRevision: "0.8.3-ling.1",
    platform: "win32",
    signingPolicy: {
      signingTier: "test_signed_internal",
      distributionChannel: "internal",
      providerSigner: {
        subject: "CN=Ling Stack Internal Test",
        certificateSha256: CERTIFICATE_SHA,
      },
      catalogSigner: {
        subject: "CN=Ling Stack Internal Test",
        certificateSha256: CERTIFICATE_SHA,
      },
      catalogTimestampStatus: "NotRequired",
    },
  };
}
