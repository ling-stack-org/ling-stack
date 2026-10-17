import {
  useTeammateAsyncRequestOwner,
  type TeammateAsyncRequestOwner,
  type TeammateAsyncRequestToken,
} from "./useTeammateAsyncRequestOwner.js";

export type TeammateWorkspaceResource =
  | "activity"
  | "conversation"
  | "execution-actions"
  | "mcp"
  | "skills"
  | "terminal-reports";

export type TeammateWorkspaceRequestAction =
  | "activity"
  | "attachment-delete"
  | "attachment-upload"
  | "execution-actions"
  | "guidance"
  | "guidance-cancel"
  | "guidance-promote"
  | "messages"
  | "older-messages"
  | "runtime"
  | "send"
  | "stop"
  | "terminal-reports"
  | "workspace";

export type TeammateWorkspaceRequestToken = TeammateAsyncRequestToken<
  TeammateWorkspaceRequestAction,
  TeammateWorkspaceResource
>;

export interface TeammateWorkspaceRequestOwner extends TeammateAsyncRequestOwner<
  TeammateWorkspaceRequestAction,
  TeammateWorkspaceResource
> {
  readonly beginWorkspaceAction: (
    action: TeammateWorkspaceRequestAction,
  ) => TeammateWorkspaceRequestToken;
}

const READ_RESOURCES: Readonly<Partial<Record<
  TeammateWorkspaceRequestAction,
  readonly TeammateWorkspaceResource[]
>>> = {
  activity: ["activity"],
  "execution-actions": ["execution-actions"],
  messages: ["conversation"],
  "older-messages": ["conversation"],
  runtime: ["conversation"],
  "terminal-reports": ["terminal-reports"],
  workspace: ["conversation", "activity", "skills", "mcp"],
};

export function useTeammateWorkspaceRequestOwner(
  cwd: string,
  teammateId: string,
): TeammateWorkspaceRequestOwner {
  const owner = useTeammateAsyncRequestOwner<
    TeammateWorkspaceRequestAction,
    TeammateWorkspaceResource
  >(teammateId, workspaceIdentity(cwd, teammateId));
  return {
    ...owner,
    beginWorkspaceAction: (action) => owner.begin(action, READ_RESOURCES[action]),
  };
}

function workspaceIdentity(cwd: string, teammateId: string): string {
  return JSON.stringify([cwd.trim(), teammateId]);
}
