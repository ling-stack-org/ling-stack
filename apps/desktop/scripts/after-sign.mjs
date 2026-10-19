import afterSignCuaDriver from "./cua-driver-signing/after-sign.mjs";
import { sealEngineSupervisorPackage } from "./engine-supervisor-package.mjs";

export default async function afterSign(context) {
  const result = await afterSignCuaDriver(context);
  await sealEngineSupervisorPackage(context);
  return result;
}
