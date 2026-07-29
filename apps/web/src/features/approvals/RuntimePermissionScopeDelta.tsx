import type { ApprovalRequest } from "../../types.js";
import { ApprovalPermissionDelta } from "./ApprovalPermissionDelta.js";

export function RuntimePermissionScopeDelta({ approval }: { readonly approval: ApprovalRequest }): JSX.Element | null {
  return <ApprovalPermissionDelta approval={approval} compact />;
}
