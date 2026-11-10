import { runAfterSign } from "./hooks.mjs";
import { verifyMacDevelopmentBundle } from "../macos-development-signing.mjs";
import { verifyOfficeAfterSign } from "../packaged-office-native-package-checks.mjs";
import { verifyPackagedGstack } from "../packaged-gstack-resources.mjs";

export default async function afterSign(context) {
  const result = await runAfterSign(context);
  await verifyMacDevelopmentBundle(context);
  await verifyOfficeAfterSign(context);
  await verifyPackagedGstack(context);
  return result;
}
