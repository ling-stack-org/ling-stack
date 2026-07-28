import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CUA_DRIVER_COMMITTED_LOCK_SHA256,
  normalizePackagePlatform,
} from "./cua-driver-package-staging-contract.mjs";
import {
  PROVIDER_RESOURCE_ROOT,
  sha256File,
  verifyDistributionLockV2,
} from "./cua-driver-source-build-lib.mjs";

export function resolveCuaDriverPackageAuthorization({
  actualLockSha256,
  expectedLockSha256,
  platform,
  providerLock,
}) {
  const normalizedPlatform = normalizePackagePlatform(platform);
  if (actualLockSha256 !== expectedLockSha256) {
    throw new Error("provider_lock_anchor_mismatch");
  }
  verifyDistributionLockV2(providerLock);
  return Object.freeze({
    authorized: providerLock.enabledPlatforms.includes(normalizedPlatform),
    platform: normalizedPlatform,
    providerLockSha256: actualLockSha256,
  });
}

export async function checkCommittedCuaDriverPackageAuthorization(platform) {
  const lockPath = join(PROVIDER_RESOURCE_ROOT, "provider-lock.json");
  const providerLock = JSON.parse(await readFile(lockPath, "utf8"));
  return resolveCuaDriverPackageAuthorization({
    actualLockSha256: await sha256File(lockPath),
    expectedLockSha256: CUA_DRIVER_COMMITTED_LOCK_SHA256,
    platform,
    providerLock,
  });
}

function parsePlatform(argv) {
  const index = argv.indexOf("--platform");
  if (index === -1 || !argv[index + 1] || index + 2 !== argv.length) {
    throw new Error("usage: check-cua-driver-package-authorization.mjs --platform <darwin|win32-x64>");
  }
  return argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkCommittedCuaDriverPackageAuthorization(
      parsePlatform(process.argv.slice(2)),
    );
    if (process.env.GITHUB_OUTPUT) {
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `authorized=${result.authorized}\n`,
        { encoding: "utf8" },
      );
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
