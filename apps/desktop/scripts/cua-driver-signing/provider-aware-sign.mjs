import { runProviderAwareSign } from "./hooks.mjs";

/**
 * Electron Builder custom-sign seam used by the feasibility fixture and later
 * wired to the real platform signer in Slice 6A.
 */
export default async function providerAwareSign(context) {
  return runProviderAwareSign(context);
}
