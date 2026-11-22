import type { EdgeRuntimeEnrollmentGrantV1 } from "@ling-stack/contracts";
import { canonicalJsonBytes } from "./canonical.js";

export function edgeRuntimeEnrollmentProofBytes(grant: EdgeRuntimeEnrollmentGrantV1): Uint8Array {
  return canonicalJsonBytes({ purpose: "ling.edge-runtime-enrollment.v1", grant });
}
