import { createContext, useContext, useRef } from "react";
import { LingDaemonTransportError } from "@ling-stack/api-client";
import { isDesktopDaemonStatus, type DesktopDaemonStatus } from "../../../../../desktop/shared/desktop-capabilities.js";

/** View/read admission only. Never an execution status or permission grant. */
export interface DaemonObservation {
  readonly paused: boolean;
  readonly epoch: number;
  readonly workspaceCwd: string;
  readonly baseUrl: string;
}

export const liveDaemonObservation: DaemonObservation = { paused: false, epoch: 0, workspaceCwd: "", baseUrl: "" };
const context = createContext<DaemonObservation>(liveDaemonObservation);
export const DaemonObservationProvider = context.Provider;
export const useDaemonObservation = (): DaemonObservation => useContext(context);

export function projectDaemonObservation(
  previous: DaemonObservation,
  status: DesktopDaemonStatus | undefined,
  baseUrl: string,
  workspaceCwd: string,
): DaemonObservation {
  const paused = Boolean(status && isDesktopDaemonStatus(status) && status.ownedByDesktop
    && (status.state === "draining" || status.state === "blocked")
    && sameEndpoint(status.baseUrl, baseUrl));
  const cwd = workspaceCwd.trim();
  return previous.paused === paused && previous.workspaceCwd === cwd && previous.baseUrl === baseUrl
    ? previous : { paused, workspaceCwd: cwd, baseUrl, epoch: previous.epoch + 1 };
}

export function useDaemonObservationState(
  status: DesktopDaemonStatus | undefined, baseUrl: string, workspaceCwd: string,
): DaemonObservation {
  const observation = useRef(liveDaemonObservation);
  observation.current = projectDaemonObservation(observation.current, status, baseUrl, workspaceCwd);
  return observation.current;
}

export function isDaemonObservationPausedForWorkspace(observation: DaemonObservation, cwd: string): boolean {
  return observation.paused && observation.workspaceCwd === cwd.trim();
}

/** A deferred read is NOT an applied control-plane invalidation. */
export class DaemonObservationDeferredError extends Error {
  constructor() { super("Observation paused"); this.name = "DaemonObservationDeferredError"; }
}

export function shouldDeferDaemonObservationError(error: unknown, observation: DaemonObservation, cwd: string): boolean {
  return isDaemonObservationPausedForWorkspace(observation, cwd)
    && (error instanceof LingDaemonTransportError || error instanceof DaemonObservationDeferredError);
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    const normalize = (value: string): string => {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return "";
      return `${url.origin}${url.pathname.replace(/\/+$/u, "")}`;
    };
    const endpoint = normalize(left);
    return Boolean(endpoint) && endpoint === normalize(right);
  } catch { return false; }
}
