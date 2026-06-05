import { useState } from "react";
import {
  configureExternalWorkSecret,
  configureExternalWorkWorkflow,
  deleteExternalWorkSecret,
  getExternalWorkStatus,
  listGitHubExternalWorkCiTriage,
  pollGitHubExternalWork,
  pollLinearExternalWork,
  reconcileExternalWork,
  startGitHubExternalWorkBackground,
  stopExternalWorkBackground,
} from "../../api.js";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import type {
  ExternalWorkCiTriageView,
  ExternalWorkStatusResponse,
  ExternalWorkWorkflowConfigureRequest,
} from "../../types.js";

export type ExternalWorkStatusAction = "poll" | "reconcile" | "start" | "stop";
export type ExternalWorkSecretAction = "configure" | "delete";
export type ExternalWorkWorkflowAction = "configure";

export interface ExternalWorkState {
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly externalWorkCiTriageLoading: boolean;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: ExternalWorkStatusAction | undefined;
  readonly externalWorkSecretAction: ExternalWorkSecretAction | undefined;
  readonly externalWorkWorkflowAction: ExternalWorkWorkflowAction | undefined;
}

export interface ExternalWorkActions {
  readonly refreshExternalWorkCiTriage: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshExternalWorkStatus: (cwd?: string, channelId?: string) => Promise<void>;
  readonly configureExternalWorkWorkflowAction: (input: Omit<ExternalWorkWorkflowConfigureRequest, "channelId">) => Promise<void>;
  readonly runExternalWorkStatusAction: (action: ExternalWorkStatusAction) => Promise<void>;
  readonly configureExternalWorkSecretAction: (token: string) => Promise<void>;
  readonly deleteExternalWorkSecretAction: () => Promise<void>;
  readonly resetSelectedChannel: () => void;
  readonly resetForCwd: () => void;
}

export type ExternalWorkController = DomainController<ExternalWorkState, ExternalWorkActions>;

export function useExternalWorkDomain(input: {
  readonly cwd: string;
  readonly selectedChannelId: string;
  readonly setErrorMessage: (message: string) => void;
}): ExternalWorkController {
  const [externalWorkCiTriage, setExternalWorkCiTriage] = useState<readonly ExternalWorkCiTriageView[]>([]);
  const [externalWorkCiTriageLoading, setExternalWorkCiTriageLoading] = useState(false);
  const [externalWorkStatus, setExternalWorkStatus] = useState<ExternalWorkStatusResponse | undefined>();
  const [externalWorkStatusLoading, setExternalWorkStatusLoading] = useState(false);
  const [externalWorkStatusAction, setExternalWorkStatusAction] = useState<ExternalWorkStatusAction | undefined>();
  const [externalWorkSecretAction, setExternalWorkSecretAction] = useState<ExternalWorkSecretAction | undefined>();
  const [externalWorkWorkflowAction, setExternalWorkWorkflowAction] = useState<ExternalWorkWorkflowAction | undefined>();
  const [error, setError] = useState<DomainError | undefined>();

  async function refreshExternalWorkCiTriage(
    cwd = input.cwd.trim(),
    channelId = input.selectedChannelId,
  ): Promise<void> {
    if (!cwd || !channelId) {
      setExternalWorkCiTriage([]);
      return;
    }

    setExternalWorkCiTriageLoading(true);
    try {
      setError(undefined);
      const response = await listGitHubExternalWorkCiTriage(cwd, { channelId, limit: 25 });
      setExternalWorkCiTriage(response.records);
    } catch {
      setExternalWorkCiTriage([]);
    } finally {
      setExternalWorkCiTriageLoading(false);
    }
  }

  async function refreshExternalWorkStatus(
    cwd = input.cwd.trim(),
    channelId = input.selectedChannelId,
  ): Promise<void> {
    if (!cwd || !channelId) {
      setExternalWorkStatus(undefined);
      return;
    }

    setExternalWorkStatusLoading(true);
    try {
      setError(undefined);
      const response = await getExternalWorkStatus(cwd, { channelId });
      setExternalWorkStatus(response);
    } catch {
      setExternalWorkStatus(undefined);
    } finally {
      setExternalWorkStatusLoading(false);
    }
  }

  async function configureExternalWorkWorkflowAction(
    workflowInput: Omit<ExternalWorkWorkflowConfigureRequest, "channelId">,
  ): Promise<void> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    if (!cwd || !channelId) {
      input.setErrorMessage("Select a channel before creating WORKFLOW.md.");
      return;
    }

    setExternalWorkWorkflowAction("configure");
    try {
      input.setErrorMessage("");
      setError(undefined);
      await configureExternalWorkWorkflow(cwd, {
        channelId,
        sourceKind: workflowInput.sourceKind,
        repository: workflowInput.repository,
        projectSlug: workflowInput.projectSlug,
      });
      await refreshExternalWorkStatus(cwd, channelId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      await refreshExternalWorkStatus(cwd, channelId);
    } finally {
      setExternalWorkWorkflowAction(undefined);
    }
  }

  async function runExternalWorkStatusAction(action: ExternalWorkStatusAction): Promise<void> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    if (!cwd || !channelId || externalWorkStatusAction) {
      return;
    }

    setExternalWorkStatusAction(action);
    try {
      input.setErrorMessage("");
      setError(undefined);
      if (action === "poll") {
        if (externalWorkStatus?.workflow.sourceKind === "linear") {
          await pollLinearExternalWork(cwd, { channelId, limit: 50 });
        } else {
          await pollGitHubExternalWork(cwd, { channelId, limit: 50 });
        }
      } else if (action === "reconcile") {
        await reconcileExternalWork(cwd, { channelId });
      } else if (action === "start") {
        await startGitHubExternalWorkBackground(cwd, { channelId, limit: 50 });
      } else if (action === "stop") {
        const schedulerId = externalWorkStatus?.background.schedulerId;
        if (!schedulerId) {
          throw new Error("No external work background scheduler is registered for this channel.");
        }
        await stopExternalWorkBackground(cwd, schedulerId);
      }
      await Promise.all([
        refreshExternalWorkStatus(cwd, channelId),
        refreshExternalWorkCiTriage(cwd, channelId),
      ]);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      await refreshExternalWorkStatus(cwd, channelId);
    } finally {
      setExternalWorkStatusAction(undefined);
    }
  }

  async function configureExternalWorkSecretAction(token: string): Promise<void> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    if (!cwd || !channelId) {
      input.setErrorMessage("Select a channel before configuring an external work token.");
      return;
    }

    setExternalWorkSecretAction("configure");
    try {
      input.setErrorMessage("");
      setError(undefined);
      await configureExternalWorkSecret(cwd, { channelId, token });
      await refreshExternalWorkStatus(cwd, channelId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      await refreshExternalWorkStatus(cwd, channelId);
    } finally {
      setExternalWorkSecretAction(undefined);
    }
  }

  async function deleteExternalWorkSecretAction(): Promise<void> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    const secretRef = externalWorkStatus?.secret.ref ?? externalWorkStatus?.workflow.secretRef;
    if (!cwd || !channelId) {
      input.setErrorMessage("Select a channel before removing an external work token.");
      return;
    }
    if (!secretRef?.startsWith("keychain:")) {
      input.setErrorMessage("Only keychain external work tokens can be removed from Settings.");
      return;
    }

    setExternalWorkSecretAction("delete");
    try {
      input.setErrorMessage("");
      setError(undefined);
      await deleteExternalWorkSecret(cwd, { channelId, secretRef });
      await refreshExternalWorkStatus(cwd, channelId);
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      await refreshExternalWorkStatus(cwd, channelId);
    } finally {
      setExternalWorkSecretAction(undefined);
    }
  }

  function resetSelectedChannel(): void {
    setExternalWorkCiTriage([]);
    setExternalWorkStatus(undefined);
  }

  function resetForCwd(): void {
    setExternalWorkCiTriage([]);
    setExternalWorkCiTriageLoading(false);
    setExternalWorkStatus(undefined);
    setExternalWorkStatusLoading(false);
    setExternalWorkStatusAction(undefined);
    setExternalWorkSecretAction(undefined);
    setExternalWorkWorkflowAction(undefined);
    setError(undefined);
  }

  return {
    state: {
      externalWorkCiTriage,
      externalWorkCiTriageLoading,
      externalWorkStatus,
      externalWorkStatusLoading,
      externalWorkStatusAction,
      externalWorkSecretAction,
      externalWorkWorkflowAction,
    },
    actions: {
      refreshExternalWorkCiTriage,
      refreshExternalWorkStatus,
      configureExternalWorkWorkflowAction,
      runExternalWorkStatusAction,
      configureExternalWorkSecretAction,
      deleteExternalWorkSecretAction,
      resetSelectedChannel,
      resetForCwd,
    },
    refresh: refreshExternalWorkStatus,
    isLoading: externalWorkCiTriageLoading || externalWorkStatusLoading,
    error,
    clearError: () => setError(undefined),
  };
}
