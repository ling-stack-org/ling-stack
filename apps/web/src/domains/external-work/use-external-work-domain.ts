import { useEffect, useState } from "react";
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
import type { DomainController } from "../../app/domain-controller.js";
import {
  domainErrorMessage,
  type FocusedDomainError,
  type FocusedErrorRequest,
  useFocusedDomainErrorOwner,
} from "../../app/use-focused-domain-error-owner.js";
import type {
  ExternalWorkCiTriageView,
  ExternalWorkStatusResponse,
  ExternalWorkWorkflowConfigureRequest,
} from "../../types.js";

export type ExternalWorkStatusAction = "poll" | "reconcile" | "start" | "stop";
export type ExternalWorkSecretAction = "configure" | "delete";
export type ExternalWorkWorkflowAction = "configure";
export type ExternalWorkErrorAction =
  | "background:start"
  | "background:stop"
  | "credential:configure"
  | "credential:delete"
  | "poll"
  | "reconcile"
  | "status:load"
  | "triage:load"
  | "workflow:configure";
export type ExternalWorkErrorScope =
  | "background"
  | "credential"
  | "poll"
  | "reconcile"
  | "status"
  | "triage"
  | "workflow";

export interface ExternalWorkDomainError extends FocusedDomainError<"external-work", ExternalWorkErrorAction> {
  readonly kind: ExternalWorkErrorScope;
}

export interface ExternalWorkState {
  readonly externalWorkCiTriage: readonly ExternalWorkCiTriageView[];
  readonly externalWorkCiTriageLoading: boolean;
  readonly externalWorkStatus: ExternalWorkStatusResponse | undefined;
  readonly externalWorkStatusLoading: boolean;
  readonly externalWorkStatusAction: ExternalWorkStatusAction | undefined;
  readonly externalWorkSecretAction: ExternalWorkSecretAction | undefined;
  readonly externalWorkWorkflowAction: ExternalWorkWorkflowAction | undefined;
  readonly externalWorkErrors: readonly ExternalWorkDomainError[];
}

export interface ExternalWorkActions {
  readonly refreshExternalWorkCiTriage: (cwd?: string, channelId?: string) => Promise<void>;
  readonly refreshExternalWorkStatus: (cwd?: string, channelId?: string) => Promise<void>;
  readonly configureExternalWorkWorkflowAction: (input: Omit<ExternalWorkWorkflowConfigureRequest, "channelId">) => Promise<boolean>;
  readonly runExternalWorkStatusAction: (action: ExternalWorkStatusAction) => Promise<boolean>;
  readonly configureExternalWorkSecretAction: (token: string) => Promise<boolean>;
  readonly deleteExternalWorkSecretAction: () => Promise<boolean>;
  readonly resetSelectedChannel: () => void;
  readonly resetForCwd: () => void;
}

export type ExternalWorkController = Omit<DomainController<ExternalWorkState, ExternalWorkActions>, "error"> & {
  readonly error: ExternalWorkDomainError | undefined;
};

export function useExternalWorkDomain(input: {
  readonly cwd: string;
  readonly selectedChannelId: string;
}): ExternalWorkController {
  const [externalWorkCiTriage, setExternalWorkCiTriage] = useState<readonly ExternalWorkCiTriageView[]>([]);
  const [externalWorkCiTriageLoading, setExternalWorkCiTriageLoading] = useState(false);
  const [externalWorkStatus, setExternalWorkStatus] = useState<ExternalWorkStatusResponse | undefined>();
  const [externalWorkStatusLoading, setExternalWorkStatusLoading] = useState(false);
  const [externalWorkStatusAction, setExternalWorkStatusAction] = useState<ExternalWorkStatusAction | undefined>();
  const [externalWorkSecretAction, setExternalWorkSecretAction] = useState<ExternalWorkSecretAction | undefined>();
  const [externalWorkWorkflowAction, setExternalWorkWorkflowAction] = useState<ExternalWorkWorkflowAction | undefined>();
  const externalWorkIdentity = externalWorkRequestIdentity(input.cwd, input.selectedChannelId);
  const errorOwner = useFocusedDomainErrorOwner<"external-work", ExternalWorkErrorAction>(externalWorkIdentity);

  function isCurrentExternalRequest(
    request: FocusedErrorRequest<"external-work", ExternalWorkErrorAction>,
    cwd: string,
    channelId: string,
  ): boolean {
    return errorOwner.isCurrent(request)
      && request.identity === externalWorkRequestIdentity(cwd, channelId);
  }

  useEffect(() => {
    setExternalWorkCiTriageLoading(false);
    setExternalWorkStatusLoading(false);
    setExternalWorkStatusAction(undefined);
    setExternalWorkSecretAction(undefined);
    setExternalWorkWorkflowAction(undefined);
  }, [externalWorkIdentity]);

  async function refreshExternalWorkCiTriage(
    cwd = input.cwd.trim(),
    channelId = input.selectedChannelId,
  ): Promise<void> {
    if (!cwd || !channelId) {
      setExternalWorkCiTriage([]);
      return;
    }

    const request = errorOwner.begin("external-work", channelId, "triage:load");
    errorOwner.clear(request);
    if (request.identity === externalWorkRequestIdentity(cwd, channelId)) setExternalWorkCiTriageLoading(true);
    try {
      const response = await listGitHubExternalWorkCiTriage(cwd, { channelId, limit: 25 });
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        setExternalWorkCiTriage(response.records);
        errorOwner.clear(request);
      }
    } catch (caught) {
      if (isCurrentExternalRequest(request, cwd, channelId)) setExternalWorkCiTriage([]);
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        errorOwner.report(request, { scope: "load", message: domainErrorMessage(caught) });
      }
    } finally {
      if (isCurrentExternalRequest(request, cwd, channelId)) setExternalWorkCiTriageLoading(false);
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

    const request = errorOwner.begin("external-work", channelId, "status:load");
    errorOwner.clear(request);
    if (request.identity === externalWorkRequestIdentity(cwd, channelId)) setExternalWorkStatusLoading(true);
    try {
      const response = await getExternalWorkStatus(cwd, { channelId });
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        setExternalWorkStatus(response);
        errorOwner.clear(request);
      }
    } catch (caught) {
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        errorOwner.report(request, { scope: "load", message: domainErrorMessage(caught) });
      }
    } finally {
      if (isCurrentExternalRequest(request, cwd, channelId)) setExternalWorkStatusLoading(false);
    }
  }

  async function configureExternalWorkWorkflowAction(
    workflowInput: Omit<ExternalWorkWorkflowConfigureRequest, "channelId">,
  ): Promise<boolean> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    if (!cwd || !channelId) {
      errorOwner.reportImmediate("external-work", channelId || "channel:unselected", "workflow:configure", {
        scope: "mutation",
        message: "Select a channel before creating WORKFLOW.md.",
      });
      return false;
    }
    if (errorOwner.identity() !== externalWorkRequestIdentity(cwd, channelId)) return false;

    const request = errorOwner.begin("external-work", channelId, "workflow:configure");
    errorOwner.clear(request);
    setExternalWorkWorkflowAction("configure");
    try {
      await configureExternalWorkWorkflow(cwd, {
        channelId,
        sourceKind: workflowInput.sourceKind,
        repository: workflowInput.repository,
        projectSlug: workflowInput.projectSlug,
      });
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      await refreshExternalWorkStatus(cwd, channelId);
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      errorOwner.clear(request);
      return true;
    } catch (caught) {
      if (isCurrentExternalRequest(request, cwd, channelId)) await refreshExternalWorkStatus(cwd, channelId);
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(caught) });
      }
      return false;
    } finally {
      if (isCurrentExternalRequest(request, cwd, channelId)) setExternalWorkWorkflowAction(undefined);
    }
  }

  async function runExternalWorkStatusAction(action: ExternalWorkStatusAction): Promise<boolean> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    if (!cwd || !channelId || externalWorkStatusAction) {
      return false;
    }
    if (errorOwner.identity() !== externalWorkRequestIdentity(cwd, channelId)) return false;

    const errorAction: ExternalWorkErrorAction = action === "start" || action === "stop"
      ? `background:${action}`
      : action;
    const request = errorOwner.begin("external-work", channelId, errorAction);
    errorOwner.clear(request);
    setExternalWorkStatusAction(action);
    try {
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
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      await Promise.all([
        refreshExternalWorkStatus(cwd, channelId),
        refreshExternalWorkCiTriage(cwd, channelId),
      ]);
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      errorOwner.clear(request);
      return true;
    } catch (caught) {
      if (isCurrentExternalRequest(request, cwd, channelId)) await refreshExternalWorkStatus(cwd, channelId);
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(caught) });
      }
      return false;
    } finally {
      if (isCurrentExternalRequest(request, cwd, channelId)) setExternalWorkStatusAction(undefined);
    }
  }

  async function configureExternalWorkSecretAction(token: string): Promise<boolean> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    if (!cwd || !channelId) {
      errorOwner.reportImmediate("external-work", channelId || "channel:unselected", "credential:configure", {
        scope: "mutation",
        message: "Select a channel before configuring an external work token.",
      });
      return false;
    }
    if (errorOwner.identity() !== externalWorkRequestIdentity(cwd, channelId)) return false;

    const request = errorOwner.begin("external-work", channelId, "credential:configure");
    errorOwner.clear(request);
    setExternalWorkSecretAction("configure");
    try {
      await configureExternalWorkSecret(cwd, { channelId, token });
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      await refreshExternalWorkStatus(cwd, channelId);
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      errorOwner.clear(request);
      return true;
    } catch (caught) {
      if (isCurrentExternalRequest(request, cwd, channelId)) await refreshExternalWorkStatus(cwd, channelId);
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(caught) });
      }
      return false;
    } finally {
      if (isCurrentExternalRequest(request, cwd, channelId)) setExternalWorkSecretAction(undefined);
    }
  }

  async function deleteExternalWorkSecretAction(): Promise<boolean> {
    const cwd = input.cwd.trim();
    const channelId = input.selectedChannelId;
    const secretRef = externalWorkStatus?.secret.ref ?? externalWorkStatus?.workflow.secretRef;
    if (!cwd || !channelId) {
      errorOwner.reportImmediate("external-work", channelId || "channel:unselected", "credential:delete", {
        scope: "mutation",
        message: "Select a channel before removing an external work token.",
      });
      return false;
    }
    if (!secretRef?.startsWith("keychain:")) {
      errorOwner.reportImmediate("external-work", channelId, "credential:delete", {
        scope: "mutation",
        message: "Only keychain external work tokens can be removed from Settings.",
      });
      return false;
    }
    if (errorOwner.identity() !== externalWorkRequestIdentity(cwd, channelId)) return false;

    const request = errorOwner.begin("external-work", channelId, "credential:delete");
    errorOwner.clear(request);
    setExternalWorkSecretAction("delete");
    try {
      await deleteExternalWorkSecret(cwd, { channelId, secretRef });
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      await refreshExternalWorkStatus(cwd, channelId);
      if (!isCurrentExternalRequest(request, cwd, channelId)) return false;
      errorOwner.clear(request);
      return true;
    } catch (caught) {
      if (isCurrentExternalRequest(request, cwd, channelId)) await refreshExternalWorkStatus(cwd, channelId);
      if (isCurrentExternalRequest(request, cwd, channelId)) {
        errorOwner.report(request, { scope: "mutation", message: domainErrorMessage(caught) });
      }
      return false;
    } finally {
      if (isCurrentExternalRequest(request, cwd, channelId)) setExternalWorkSecretAction(undefined);
    }
  }

  function resetSelectedChannel(): void {
    setExternalWorkCiTriage([]);
    setExternalWorkStatus(undefined);
    errorOwner.clearAll();
  }

  function resetForCwd(): void {
    setExternalWorkCiTriage([]);
    setExternalWorkCiTriageLoading(false);
    setExternalWorkStatus(undefined);
    setExternalWorkStatusLoading(false);
    setExternalWorkStatusAction(undefined);
    setExternalWorkSecretAction(undefined);
    setExternalWorkWorkflowAction(undefined);
    errorOwner.clearAll();
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
      externalWorkErrors: externalErrors(errorOwner.errors()),
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
    error: externalError(errorOwner.latest()),
    clearError: errorOwner.clearAll,
  };
}

function externalErrors(
  errors: readonly FocusedDomainError<"external-work", ExternalWorkErrorAction>[],
): readonly ExternalWorkDomainError[] {
  return errors.map((error) => ({ ...error, kind: externalWorkErrorKind(error.action) }));
}

function externalError(
  error: FocusedDomainError<"external-work", ExternalWorkErrorAction> | undefined,
): ExternalWorkDomainError | undefined {
  return error ? { ...error, kind: externalWorkErrorKind(error.action) } : undefined;
}

function externalWorkRequestIdentity(cwd: string, channelId: string): string {
  return `${cwd.trim() || "workspace:unavailable"}::${channelId || "channel:unselected"}`;
}

function externalWorkErrorKind(action: ExternalWorkErrorAction): ExternalWorkErrorScope {
  if (action.startsWith("background:")) return "background";
  if (action.startsWith("credential:")) return "credential";
  if (action.startsWith("status:")) return "status";
  if (action.startsWith("triage:")) return "triage";
  if (action.startsWith("workflow:")) return "workflow";
  return action === "poll" ? "poll" : "reconcile";
}
