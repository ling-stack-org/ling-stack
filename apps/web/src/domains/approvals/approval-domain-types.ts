export type ApprovalResolution = "approve" | "deny";

export type ExternalActionOperation = "execute" | "cancel";

export interface ExternalActionBusyState {
  readonly busy?: ExternalActionOperation;
  readonly error?: string;
  readonly failedOperation?: ExternalActionOperation | "detail";
}
