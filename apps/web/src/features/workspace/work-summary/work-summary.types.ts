export type { WorkSummaryResponse, WorkSummarySession, WorkSummaryWorkspace, WorkSummaryPullRequest, WorkSummaryCommit } from "@ling-stack/contracts";
import type { WorkSummarySession, WorkSummaryWorkspace } from "@ling-stack/contracts";

export type WorkSummaryTarget =
  | { readonly kind: "thread"; readonly threadId: string }
  | { readonly kind: "workspace"; readonly path: string };

export interface WorkSummaryGroupModel {
  readonly id: string;
  readonly sessions: readonly WorkSummarySession[];
  readonly workspace?: WorkSummaryWorkspace;
}
