import { useState } from "react";
import type { DomainController, DomainError } from "../../app/domain-controller.js";
import { getApprovalPolicy, getControlPlaneSnapshot, getRuntimeSettings, listRunners, updateApprovalPolicy, updateRuntimeSettings } from "../../api.js";
import { approvalPolicyToForm, defaultApprovalPolicyForm } from "../../lib/approvals.js";
import { readControlPlaneDomainData, runnerItemsFromControlPlaneSnapshot } from "../../lib/control-plane.js";
import type {
  ApprovalPolicy,
  ApprovalPolicyFormState,
  RunnersDomainSnapshot,
  RunnerFallbackPolicy,
  RunnerListItem,
  WorkspaceRuntimeSettings,
} from "../../types.js";

export interface RuntimeSettingsFormState {
  readonly defaultRunnerId: string;
  readonly allowedRunnerIds: readonly string[];
  readonly explicitRunnerFallback: RunnerFallbackPolicy;
  readonly implicitRunnerFallback: RunnerFallbackPolicy;
}

export interface SettingsState {
  readonly approvalPolicy: ApprovalPolicy | undefined;
  readonly approvalPolicyForm: ApprovalPolicyFormState;
  readonly approvalPolicyLoading: boolean;
  readonly runners: readonly RunnerListItem[];
  readonly runtimeSettings: WorkspaceRuntimeSettings | undefined;
  readonly runtimeSettingsForm: RuntimeSettingsFormState;
  readonly runtimeSettingsLoading: boolean;
  readonly runtimeSettingsAction: "save" | undefined;
  readonly runtimeSettingsError: string;
}

export interface SettingsActions {
  readonly setApprovalPolicyForm: (form: ApprovalPolicyFormState) => void;
  readonly refreshApprovalPolicy: () => Promise<void>;
  readonly saveApprovalPolicy: () => Promise<void>;
  readonly setRuntimeSettingsForm: (form: RuntimeSettingsFormState) => void;
  readonly toggleAllowedRunner: (runnerId: string, allowed: boolean) => void;
  readonly refreshRuntimeSettings: () => Promise<void>;
  readonly saveRuntimeSettings: () => Promise<void>;
  readonly resetForCwd: () => void;
}

export type SettingsController = DomainController<SettingsState, SettingsActions>;

const defaultRuntimeSettingsForm: RuntimeSettingsFormState = {
  defaultRunnerId: "pi",
  allowedRunnerIds: ["pi"],
  explicitRunnerFallback: "disabled",
  implicitRunnerFallback: "allow_to_default",
};

export function useSettingsDomain(input: {
  readonly cwd: string;
  readonly setErrorMessage: (message: string) => void;
}): SettingsController {
  const [approvalPolicy, setApprovalPolicy] = useState<ApprovalPolicy | undefined>();
  const [approvalPolicyForm, setApprovalPolicyForm] = useState<ApprovalPolicyFormState>(defaultApprovalPolicyForm);
  const [approvalPolicyLoading, setApprovalPolicyLoading] = useState(false);
  const [runners, setRunners] = useState<readonly RunnerListItem[]>([]);
  const [runtimeSettings, setRuntimeSettings] = useState<WorkspaceRuntimeSettings | undefined>();
  const [runtimeSettingsForm, setRuntimeSettingsForm] = useState<RuntimeSettingsFormState>(defaultRuntimeSettingsForm);
  const [runtimeSettingsLoading, setRuntimeSettingsLoading] = useState(false);
  const [runtimeSettingsAction, setRuntimeSettingsAction] = useState<"save" | undefined>();
  const [runtimeSettingsError, setRuntimeSettingsError] = useState("");
  const [error, setError] = useState<DomainError | undefined>();

  async function refreshApprovalPolicy(): Promise<void> {
    if (!input.cwd.trim()) {
      setApprovalPolicy(undefined);
      return;
    }

    setApprovalPolicyLoading(true);
    try {
      setError(undefined);
      input.setErrorMessage("");
      const response = await getApprovalPolicy(input.cwd.trim());
      setApprovalPolicy(response.policy);
      setApprovalPolicyForm(approvalPolicyToForm(response.policy));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "load", message });
      input.setErrorMessage(message);
    } finally {
      setApprovalPolicyLoading(false);
    }
  }

  async function saveApprovalPolicy(): Promise<void> {
    if (!input.cwd.trim()) {
      const message = "本地工作区未就绪";
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
      return;
    }

    setApprovalPolicyLoading(true);
    try {
      setError(undefined);
      input.setErrorMessage("");
      const response = await updateApprovalPolicy(input.cwd.trim(), approvalPolicyForm);
      setApprovalPolicy(response.policy);
      setApprovalPolicyForm(approvalPolicyToForm(response.policy));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setError({ scope: "mutation", message });
      input.setErrorMessage(message);
    } finally {
      setApprovalPolicyLoading(false);
    }
  }

  async function refreshRuntimeSettings(): Promise<void> {
    if (!input.cwd.trim()) {
      setRunners([]);
      setRuntimeSettings(undefined);
      setRuntimeSettingsError("");
      return;
    }
    setRuntimeSettingsLoading(true);
    setRuntimeSettingsError("");
    const runnerSnapshot = await getControlPlaneSnapshot(input.cwd, ["runners"])
      .then((snapshot) => readControlPlaneDomainData<RunnersDomainSnapshot>(snapshot, "runners"))
      .catch(() => undefined);
    if (runnerSnapshot) {
      setRunners(runnerItemsFromControlPlaneSnapshot(runnerSnapshot));
      setRuntimeSettingsForm((current) => ({
        ...current,
        defaultRunnerId: runnerSnapshot.defaultRunnerId,
        allowedRunnerIds: runnerSnapshot.allowedRunnerIds,
      }));
    }
    try {
      setError(undefined);
      const [runnerResponse, settingsResponse] = await Promise.all([
        listRunners(input.cwd).catch(() => ({ cwd: input.cwd, runners: runnerSnapshot ? runnerItemsFromControlPlaneSnapshot(runnerSnapshot) : [] })),
        getRuntimeSettings(input.cwd),
      ]);
      setRunners(runnerResponse.runners);
      setRuntimeSettings(settingsResponse.settings);
      setRuntimeSettingsForm(runtimeSettingsToForm(settingsResponse.settings));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setRuntimeSettingsError(message);
      setError({ scope: "load", message });
    } finally {
      setRuntimeSettingsLoading(false);
    }
  }

  async function saveRuntimeSettings(): Promise<void> {
    if (!input.cwd.trim()) {
      return;
    }
    setRuntimeSettingsAction("save");
    setRuntimeSettingsError("");
    try {
      setError(undefined);
      const response = await updateRuntimeSettings(input.cwd, runtimeSettingsForm);
      setRuntimeSettings(response.settings);
      setRuntimeSettingsForm(runtimeSettingsToForm(response.settings));
    } catch (caught) {
      const message = caught instanceof Error ? caught.message : String(caught);
      setRuntimeSettingsError(message);
      setError({ scope: "mutation", message });
    } finally {
      setRuntimeSettingsAction(undefined);
    }
  }

  function toggleAllowedRunner(runnerId: string, allowed: boolean): void {
    setRuntimeSettingsForm((current) => {
      const nextAllowed = allowed
        ? [...new Set([...current.allowedRunnerIds, runnerId])]
        : current.allowedRunnerIds.filter((id) => id !== runnerId);
      return {
        ...current,
        allowedRunnerIds: nextAllowed,
        defaultRunnerId: nextAllowed.includes(current.defaultRunnerId) ? current.defaultRunnerId : nextAllowed[0] ?? current.defaultRunnerId,
      };
    });
  }

  function resetForCwd(): void {
    setApprovalPolicy(undefined);
    setApprovalPolicyForm(defaultApprovalPolicyForm);
    setApprovalPolicyLoading(false);
    setRunners([]);
    setRuntimeSettings(undefined);
    setRuntimeSettingsForm(defaultRuntimeSettingsForm);
    setRuntimeSettingsLoading(false);
    setRuntimeSettingsAction(undefined);
    setRuntimeSettingsError("");
    setError(undefined);
  }

  return {
    state: {
      approvalPolicy,
      approvalPolicyForm,
      approvalPolicyLoading,
      runners,
      runtimeSettings,
      runtimeSettingsForm,
      runtimeSettingsLoading,
      runtimeSettingsAction,
      runtimeSettingsError,
    },
    actions: {
      setApprovalPolicyForm,
      refreshApprovalPolicy,
      saveApprovalPolicy,
      setRuntimeSettingsForm,
      toggleAllowedRunner,
      refreshRuntimeSettings,
      saveRuntimeSettings,
      resetForCwd,
    },
    refresh: async () => {
      await Promise.all([refreshApprovalPolicy(), refreshRuntimeSettings()]);
    },
    isLoading: approvalPolicyLoading || runtimeSettingsLoading,
    error,
    clearError: () => setError(undefined),
  };
}

function runtimeSettingsToForm(settings: WorkspaceRuntimeSettings): RuntimeSettingsFormState {
  return {
    defaultRunnerId: settings.defaultRunnerId,
    allowedRunnerIds: settings.allowedRunnerIds,
    explicitRunnerFallback: settings.explicitRunnerFallback,
    implicitRunnerFallback: settings.implicitRunnerFallback,
  };
}
