export type WorkspaceDirectorySelectResponse =
  | {
      readonly cancelled: true;
    }
  | {
      readonly cancelled: false;
      readonly path: string;
      readonly label: string;
    };
