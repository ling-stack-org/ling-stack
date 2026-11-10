export type ApprovalResolution = "approve" | "approve_once" | "approve_command_rule" | "deny";

export type ExternalActionOperation = "execute" | "cancel";

export interface ExternalActionBusyState {
  readonly busy?: ExternalActionOperation;
  readonly error?: string;
  readonly failedOperation?: ExternalActionOperation | "detail";
}
