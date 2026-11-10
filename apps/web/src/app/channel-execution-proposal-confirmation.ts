export interface ChannelExecutionProposalReference {
  readonly id: string;
  readonly channelId: string;
}

export type ChannelExecutionProposalRefreshStage = "after-confirmation" | "after-confirmation-failure";

export interface ChannelExecutionProposalConfirmationCoordinatorInput<TResponse> {
  readonly proposal: ChannelExecutionProposalReference;
  readonly workspaceCwd: string;
  readonly confirm: (workspaceCwd: string, proposalId: string) => Promise<TResponse>;
  readonly publishConfirmed: (response: TResponse) => void;
  readonly refreshAfterConfirmation: () => Promise<void>;
  readonly refreshAfterConfirmationFailure: () => Promise<void>;
  readonly reportConfirmationError: (message: string) => void;
  readonly reportRefreshError: (stage: ChannelExecutionProposalRefreshStage, message: string) => void;
}

/**
 * Coordinates the server-owned proposal transition without allowing a stale
 * client revision to overwrite the authoritative result.
 *
 * Confirmation errors and dependent-view refresh errors are deliberately
 * separate. Once the confirmation endpoint succeeds, a failed refresh must
 * not make the UI claim that the proposal itself failed.
 */
export async function coordinateChannelExecutionProposalConfirmation<TResponse>(
  input: ChannelExecutionProposalConfirmationCoordinatorInput<TResponse>,
): Promise<void> {
  let response: TResponse;
  try {
    response = await input.confirm(input.workspaceCwd, input.proposal.id);
  } catch (error) {
    input.reportConfirmationError(errorMessage(error));
    try {
      await input.refreshAfterConfirmationFailure();
    } catch (refreshError) {
      input.reportRefreshError("after-confirmation-failure", errorMessage(refreshError));
    }
    return;
  }

  input.publishConfirmed(response);
  try {
    await input.refreshAfterConfirmation();
  } catch (refreshError) {
    input.reportRefreshError("after-confirmation", errorMessage(refreshError));
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
