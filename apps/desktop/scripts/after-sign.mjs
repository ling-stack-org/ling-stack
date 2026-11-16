import afterSignCuaDriver from "./cua-driver-signing/after-sign.mjs";
import { sealEngineSupervisorPackage } from "./engine-supervisor-package.mjs";
import { verifyPackagedLockedUse } from "./locked-use-release-build.ts";

export default async function afterSign(context) {
  const result = await afterSignCuaDriver(context);
  await sealEngineSupervisorPackage(context);
  await verifyPackagedLockedUse(context);
  return result;
}
