export type { WorkSummaryResponse, WorkSummarySession, WorkSummaryWorkspace, WorkSummaryPullRequest, WorkSummaryCommit } from "@ling-stack/contracts";
import type { WorkSummarySession, WorkSummaryWorkspace } from "@ling-stack/contracts";

export interface WorkSummaryGroupModel {
  readonly id: string;
  readonly sessions: readonly WorkSummarySession[];
  readonly workspace?: WorkSummaryWorkspace;
}
