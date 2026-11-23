export type WorkspaceDirectorySelectResponse =
  | {
      readonly cancelled: true;
    }
  | {
      readonly cancelled: false;
      readonly path: string;
      readonly label: string;
    };

export interface RegisteredWorkspaceSummary {
  readonly workspaceId: string;
  readonly cwd: string;
  readonly name: string;
  readonly available: boolean;
}

export interface RegisteredWorkspacesResponse {
  readonly workspaces: readonly RegisteredWorkspaceSummary[];
}
