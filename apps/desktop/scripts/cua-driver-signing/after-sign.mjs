import { runAfterSign } from "./hooks.mjs";
import { verifyMacDevelopmentBundle } from "../macos-development-signing.mjs";

export default async function afterSign(context) {
  const result = await runAfterSign(context);
  await verifyMacDevelopmentBundle(context);
  return result;
}
