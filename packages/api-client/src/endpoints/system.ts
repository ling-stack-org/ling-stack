import type {
  ControlPlaneDomain,
  ControlPlaneEventsRequest,
  ControlPlaneEventsResponse,
  ControlPlaneSnapshotResponse,
  DaemonHealthResponse,
  EffectiveConfigResponse,
  HarnessFeatureSnapshotV1,
  UpdateUserProfileRequest,
  UpdateWorkspaceSettingsRequest,
  StartupRefreshResponse,
  StartupStatusResponse,
  UserProfileResponse,
  WorkspaceDirectorySelectResponse,
  WorkspaceTerminalCommandRequest,
  WorkspaceTerminalCommandResponse,
  WorkspaceTerminalProfileResponse,
  WorkspaceSettingsResponse,
} from "@ling-stack/contracts";
import { LingDaemonError } from "../errors.js";
import { readErrorMessage } from "../transport.js";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const systemEndpoints = {
  async getHealth(this: LingDaemonEndpointContext): Promise<DaemonHealthResponse> {
      const response = await this._fetch(this._url("/health"));
      if (!response.ok) {
        return { ok: false };
      }
      const body = (await response.json()) as {
        ok?: unknown;
        service?: unknown;
        defaultWorkspaceCwd?: unknown;
        readiness?: unknown;
        features?: unknown;
      };
      return {
        ok: body.ok === true,
        service: typeof body.service === "string" ? body.service : undefined,
        defaultWorkspaceCwd: typeof body.defaultWorkspaceCwd === "string" ? body.defaultWorkspaceCwd : undefined,
        readiness: readStartupReadiness(body.readiness),
        features: readDaemonFeatureFlags(body.features),
      };
    },

  async getWorkspaceSettings(this: LingDaemonEndpointContext, cwd: string): Promise<WorkspaceSettingsResponse> {
      return this._get("/workspace-settings", { cwd });
    },

  async updateWorkspaceSettings(this: LingDaemonEndpointContext, cwd: string, input: UpdateWorkspaceSettingsRequest): Promise<WorkspaceSettingsResponse> {
      return this._patch("/workspace-settings", { cwd }, input);
    },

  async getUserProfile(this: LingDaemonEndpointContext, cwd: string): Promise<UserProfileResponse> {
      return this._get("/profile", { cwd });
    },

  async updateUserProfile(this: LingDaemonEndpointContext, cwd: string, input: UpdateUserProfileRequest): Promise<UserProfileResponse> {
      return this._patch("/profile", { cwd }, input);
    },

  async getEffectiveConfig(this: LingDaemonEndpointContext, cwd: string): Promise<EffectiveConfigResponse> {
      return this._get("/config/effective", { cwd });
    },

  async getStartupStatus(this: LingDaemonEndpointContext, cwd?: string): Promise<StartupStatusResponse> {
      return this._get("/startup/status", { cwd });
    },

  async refreshStartupStatus(this: LingDaemonEndpointContext, cwd?: string): Promise<StartupRefreshResponse> {
      return this._post("/startup/refresh", { cwd });
    },

  async selectWorkspaceDirectory(this: LingDaemonEndpointContext, cwd: string): Promise<WorkspaceDirectorySelectResponse> {
      return this._post("/workspace-directory/select", { cwd });
    },

  async getWorkspaceTerminalProfile(this: LingDaemonEndpointContext, cwd: string): Promise<WorkspaceTerminalProfileResponse> {
      return this._get("/workspace-terminal/profile", { cwd });
    },

  async runWorkspaceTerminalCommand(
    this: LingDaemonEndpointContext,
    cwd: string,
    input: WorkspaceTerminalCommandRequest,
  ): Promise<WorkspaceTerminalCommandResponse> {
      return this._post("/workspace-terminal/commands", { cwd }, input);
    },

  async getControlPlaneSnapshot(this: LingDaemonEndpointContext,
      cwd: string,
      domains?: readonly ControlPlaneDomain[],
    ): Promise<ControlPlaneSnapshotResponse> {
      return this._get("/control-plane/snapshot", {
        cwd,
        domains: domains?.join(","),
      });
    },

  async listControlPlaneEvents(this: LingDaemonEndpointContext,
      cwd: string,
      options: ControlPlaneEventsRequest = {},
    ): Promise<ControlPlaneEventsResponse> {
      return this._get("/control-plane/events", {
        cwd,
        afterSeq: options.afterSeq,
        limit: options.limit,
        domains: options.domains?.join(","),
      });
    },

  async streamControlPlaneEvents(this: LingDaemonEndpointContext,
      cwd: string,
      options: ControlPlaneEventsRequest = {},
    ): Promise<Response> {
      const response = await this._fetch(this._url("/control-plane/stream", {
        cwd,
        afterSeq: options.afterSeq,
        domains: options.domains?.join(","),
      }), {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
        },
      });
      if (!response.ok) {
        throw new LingDaemonError(await readErrorMessage(response), response.status, response.statusText);
      }
      return response;
    },
};

export type SystemEndpoints = PublicEndpointGroup<typeof systemEndpoints>;

function readDaemonFeatureFlags(value: unknown): DaemonHealthResponse["features"] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { channels: { autoRoute: false } };
  }
  const features = value as Record<string, unknown>;
  const channels = features.channels;
  const transports = features.transports;
  const harness = readHarnessFeatureSnapshot(features.harness);
  const channelRecord = typeof channels === "object" && channels !== null && !Array.isArray(channels)
    ? channels as Record<string, unknown>
    : {};
  const transportRecord = typeof transports === "object" && transports !== null && !Array.isArray(transports)
    ? transports as Record<string, unknown>
    : {};
  return {
    channels: {
      autoRoute: channelRecord.autoRoute === true,
      intentSelector: channelRecord.intentSelector === true,
    },
    transports: {
      providerWebSocketFallback: transportRecord.providerWebSocketFallback === true,
      localWebSocketRpc: transportRecord.localWebSocketRpc === true,
    },
    ...(harness ? { harness } : {}),
  };
}

function readHarnessFeatureSnapshot(value: unknown): HarnessFeatureSnapshotV1 | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const snapshot = value as Record<string, unknown>;
  const { schemaVersion, continuations, toolBroker, evaluations, evaluationModelGate, delegations, delegationMaxDepth,
    delegationSelectedWorkflowIds } = snapshot;
  if (
    schemaVersion !== 1
    || !isHarnessMode(continuations)
    || !isHarnessMode(toolBroker)
    || !isHarnessMode(evaluations)
    || (evaluationModelGate !== "shadow" && evaluationModelGate !== "enforce")
    || !isHarnessMode(delegations)
    || typeof delegationMaxDepth !== "number"
    || !Number.isInteger(delegationMaxDepth)
    || delegationMaxDepth < 1
    || delegationMaxDepth > 16
    || !isDelegationWorkflowSelection(delegationSelectedWorkflowIds)
  ) {
    return undefined;
  }
  return { schemaVersion, continuations, toolBroker, evaluations, evaluationModelGate, delegations, delegationMaxDepth,
    ...(delegationSelectedWorkflowIds === undefined ? {} : {
      delegationSelectedWorkflowIds: [...delegationSelectedWorkflowIds],
    }) };
}

function isDelegationWorkflowSelection(value: unknown): value is readonly string[] | undefined {
  return value === undefined || Array.isArray(value) && value.length <= 100
    && value.every(id => typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/u.test(id))
    && new Set(value).size === value.length;
}

function isHarnessMode(value: unknown): value is HarnessFeatureSnapshotV1["continuations"] {
  return value === "off" || value === "shadow" || value === "enforce";
}

function readStartupReadiness(value: unknown): DaemonHealthResponse["readiness"] {
  return value === "starting" || value === "ready" || value === "degraded" || value === "failed"
    ? value
    : undefined;
}
