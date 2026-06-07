import type {
  ControlPlaneDomain,
  ControlPlaneEventsRequest,
  ControlPlaneEventsResponse,
  ControlPlaneSnapshotResponse,
  DaemonHealthResponse,
} from "../types.js";
import { daemonClient } from "./client.js";

export async function getDaemonHealth(): Promise<DaemonHealthResponse> {
  return daemonClient.getHealth();
}

export async function getControlPlaneSnapshot(
  cwd: string,
  domains?: readonly ControlPlaneDomain[],
): Promise<ControlPlaneSnapshotResponse> {
  return daemonClient.getControlPlaneSnapshot(cwd, domains);
}

export async function listControlPlaneEvents(
  cwd: string,
  options: ControlPlaneEventsRequest = {},
): Promise<ControlPlaneEventsResponse> {
  return daemonClient.listControlPlaneEvents(cwd, options);
}

export async function streamControlPlaneEvents(
  cwd: string,
  options: ControlPlaneEventsRequest = {},
): Promise<Response> {
  return daemonClient.streamControlPlaneEvents(cwd, options);
}
