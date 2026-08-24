import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";

import { resolveSigningProfile } from "./cua-driver-signing/signing-contract.mjs";

const execFileAsync = promisify(execFile);

export async function verifyMacDevelopmentBundle(context, dependencies = {}) {
  if (context?.electronPlatformName !== "darwin") {
    return Object.freeze({ skipped: true, reason: "not_macos" });
  }
  const profile = resolveSigningProfile(dependencies.profile);
  if (profile.signingTier !== "unsigned_dev") {
    return Object.freeze({ skipped: true, reason: "release_signing_profile" });
  }
  const appOutDir = nonEmptyString(context?.appOutDir, "macos_development_app_output_missing");
  const productFilename = nonEmptyString(
    context?.packager?.appInfo?.productFilename,
    "macos_development_product_filename_missing",
  );
  const appPath = join(appOutDir, `${productFilename}.app`);
  const run = dependencies.execFile ?? execFileAsync;
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", appPath]);
  return Object.freeze({ skipped: false, appPath, identity: "ad-hoc" });
}

function nonEmptyString(value, code) {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  return value;
}
