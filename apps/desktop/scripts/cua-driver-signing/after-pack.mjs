import { runAfterPack } from "./hooks.mjs";
import { validateCuaDriverPackageAuthority } from "../../shared/cua-driver-package-authority-contract.mjs";

export default async function afterPack(context) {
  const packageProvider = process.env.LING_CUA_DRIVER_PACKAGE_PROVIDER === "1";
  return runAfterPack(context, {
    ...(packageProvider
      ? {
          requireProvider: true,
          expectedHostAuthority: readExpectedHostAuthority(),
        }
      : {}),
    ...(process.env.LING_CUA_EXPECTED_PRE_SIGN_PAYLOAD_SHA256
      ? { expectedPreSignPayloadSha256: process.env.LING_CUA_EXPECTED_PRE_SIGN_PAYLOAD_SHA256 }
      : {}),
  });
}

function readExpectedHostAuthority() {
  const value = process.env.LING_CUA_PACKAGE_HOST_AUTHORITY_JSON;
  if (typeof value !== "string" || value.length === 0 || value.length > 16 * 1024) {
    throw new Error("cua_driver_package_host_authority_invalid");
  }
  return validateCuaDriverPackageAuthority(JSON.parse(value));
}
