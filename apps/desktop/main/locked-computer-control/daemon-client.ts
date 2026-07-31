import type {
  LockedComputerControlAttestationV1,
  LockedComputerControlCapabilityV1,
  LockedComputerControlGrantV1,
  LockedComputerControlProjectionV1,
  LockedControlIdentityResultV1,
  LockedControlReasonCode,
} from "@ling-stack/contracts";
import {
  LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS,
  isLockedComputerControlGrantV1,
  isLockedComputerControlProjectionV1,
  isLockedControlReasonCode,
} from "@ling-stack/contracts";

export interface LockedControlDaemonSnapshot {
  readonly revision: number;
  readonly projection: LockedComputerControlProjectionV1;
}

export interface LockedControlDaemonHandshakeAuthority {
  readonly daemonAuthorityEpoch: string;
  readonly bridgeConnectionId: string;
  readonly desktopInstanceEpoch: number;
  readonly workspaceCwd: string;
}

export interface LockedControlDaemonGrantAuthority extends LockedControlDaemonHandshakeAuthority {
  readonly platform: "darwin" | "win32";
  readonly desktopInstanceId: string;
  readonly authorizedNormalGeneration: number;
  readonly osSessionBindingDigest: string;
  readonly authorizedLockEpoch: number;
  readonly allowedLockedToolIdsDigest: string;
}

export type LockedControlDaemonMutationResult =
  | { readonly accepted: true; readonly snapshot: LockedControlDaemonSnapshot }
  | { readonly accepted: false; readonly reason: LockedControlReasonCode; readonly snapshot: LockedControlDaemonSnapshot };

export type LockedControlDaemonPrepareResult =
  | {
      readonly accepted: true;
      readonly grant: LockedComputerControlGrantV1;
      readonly snapshot: LockedControlDaemonSnapshot;
    }
  | {
      readonly accepted: false;
      readonly reason: LockedControlReasonCode;
      readonly snapshot: LockedControlDaemonSnapshot;
    };

export interface LockedControlDaemonClient {
  snapshot(): Promise<LockedControlDaemonSnapshot>;
  beginAuthorization(input: { readonly requestId: string; readonly expectedRevision: number }): Promise<LockedControlDaemonMutationResult>;
  prepare(input: {
    readonly requestId: string;
    readonly expectedRevision: number;
    readonly identity: LockedControlIdentityResultV1;
    readonly authority: LockedControlDaemonGrantAuthority;
  }): Promise<LockedControlDaemonPrepareResult>;
  commit(input: {
    readonly requestId: string;
    readonly grantId: string;
    readonly expectedRevision: number;
    readonly authority: LockedControlDaemonHandshakeAuthority;
  }): Promise<LockedControlDaemonMutationResult>;
  reconcile(input: {
    readonly requestId: string;
    readonly grantId: string;
    readonly authority: LockedControlDaemonHandshakeAuthority;
  }): Promise<LockedControlDaemonSnapshot>;
  publishAttestation(input: {
    readonly authority: LockedControlDaemonHandshakeAuthority;
    readonly attestation: LockedComputerControlAttestationV1;
  }): Promise<LockedControlDaemonMutationResult>;
  publishCapability(input: {
    readonly authority: LockedControlDaemonHandshakeAuthority;
    readonly capability: LockedComputerControlCapabilityV1;
    readonly buildId: string;
  }): Promise<LockedControlDaemonMutationResult>;
  revoke(input: {
    readonly authority?: LockedControlDaemonHandshakeAuthority;
    readonly requestId?: string;
    readonly expectedRevision?: number;
    readonly reason?: LockedControlReasonCode;
    readonly acknowledged?: boolean;
  }): Promise<LockedControlDaemonMutationResult>;
}

export class LockedControlDaemonClientError extends Error {
  constructor(readonly clientCode: "invalid_response" | "request_failed") {
    super(`locked_control_daemon_${clientCode}`);
    this.name = "LockedControlDaemonClientError";
  }
}

export function createLockedControlDaemonClient(options: {
  readonly daemonBaseUrl: string;
  readonly workspaceCwd: string;
  readonly bridgeToken: string;
  readonly routeToken?: string;
  readonly fetch?: typeof globalThis.fetch;
}): LockedControlDaemonClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const routeToken = options.routeToken ?? options.bridgeToken;
  const base = new URL(options.daemonBaseUrl);
  const rendererUrl = (suffix = ""): URL => {
    const url = new URL(`/computer-use/locked-control${suffix}`, base);
    url.searchParams.set("cwd", options.workspaceCwd);
    return url;
  };
  const desktopUrl = (action: string): URL => new URL(
    `/computer-use/locked-control/desktop/${action}`,
    base,
  );
  const rendererRequest = (suffix: string, body?: unknown): Promise<unknown> => requestJson(
    fetchImpl,
    rendererUrl(suffix),
    routeToken,
    "X-Ling-Computer-Use-Token",
    body,
  );
  const desktopRequest = (action: string, body: unknown): Promise<unknown> => requestJson(
    fetchImpl,
    desktopUrl(action),
    options.bridgeToken,
    "X-Ling-Desktop-Bridge-Token",
    body,
  );

  const client: LockedControlDaemonClient = {
    async snapshot() {
      return parseSnapshot(await rendererRequest(""));
    },
    async beginAuthorization(input) {
      return parseMutation(await rendererRequest("/authorize", input));
    },
    async prepare(input) {
      const value = await desktopRequest("prepare", {
        ...input,
        authority: grantAuthorityBody(input.authority),
      });
      const mutation = parseMutation(value);
      if (!mutation.accepted) return mutation;
      if (!isRecord(value)
        || !isLockedComputerControlGrantV1(value.grant, LOCKED_COMPUTER_CONTROL_MAX_GRANT_TTL_SECONDS)) {
        throw new LockedControlDaemonClientError("invalid_response");
      }
      return { accepted: true as const, grant: value.grant, snapshot: mutation.snapshot };
    },
    async commit(input) {
      return parseMutation(await desktopRequest("commit", {
        ...input,
        authority: handshakeAuthorityBody(input.authority),
      }));
    },
    async reconcile(input) {
      const value = await desktopRequest("reconcile", {
        ...input,
        authority: handshakeAuthorityBody(input.authority),
      });
      if (!isRecord(value) || value.accepted !== true) {
        throw new LockedControlDaemonClientError("invalid_response");
      }
      return parseSnapshot(value.snapshot);
    },
    async publishAttestation(input) {
      return parseMutation(await desktopRequest("attestation", {
        ...input,
        authority: handshakeAuthorityBody(input.authority),
      }));
    },
    async publishCapability(input) {
      return parseMutation(await desktopRequest("capability", {
        ...input,
        authority: handshakeAuthorityBody(input.authority),
      }));
    },
    async revoke(input) {
      if (input.authority) {
        return parseMutation(await desktopRequest("revoke", {
          authority: handshakeAuthorityBody(input.authority),
          ...(input.reason ? { reason: input.reason } : {}),
          ...(input.acknowledged === undefined ? {} : { acknowledged: input.acknowledged }),
        }));
      }
      if (!input.requestId || input.expectedRevision === undefined) {
        throw new LockedControlDaemonClientError("request_failed");
      }
      return parseMutation(await rendererRequest("/revoke", {
        requestId: input.requestId,
        expectedRevision: input.expectedRevision,
      }));
    },
  };
  return Object.freeze(client);
}

function handshakeAuthorityBody(
  authority: LockedControlDaemonHandshakeAuthority,
): LockedControlDaemonHandshakeAuthority {
  return {
    daemonAuthorityEpoch: authority.daemonAuthorityEpoch,
    bridgeConnectionId: authority.bridgeConnectionId,
    desktopInstanceEpoch: authority.desktopInstanceEpoch,
    workspaceCwd: authority.workspaceCwd,
  };
}

function grantAuthorityBody(
  authority: LockedControlDaemonGrantAuthority,
): LockedControlDaemonGrantAuthority {
  return {
    ...handshakeAuthorityBody(authority),
    platform: authority.platform,
    desktopInstanceId: authority.desktopInstanceId,
    authorizedNormalGeneration: authority.authorizedNormalGeneration,
    osSessionBindingDigest: authority.osSessionBindingDigest,
    authorizedLockEpoch: authority.authorizedLockEpoch,
    allowedLockedToolIdsDigest: authority.allowedLockedToolIdsDigest,
  };
}

async function requestJson(
  fetchImpl: typeof globalThis.fetch,
  url: URL,
  token: string,
  tokenHeader: string,
  body?: unknown,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        [tokenHeader]: token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new LockedControlDaemonClientError("request_failed");
  }
  const value = await response.json().catch(() => undefined) as unknown;
  if (!response.ok && !isRecord(value)) {
    throw new LockedControlDaemonClientError("request_failed");
  }
  return value;
}

function parseMutation(value: unknown): LockedControlDaemonMutationResult {
  if (!isRecord(value) || typeof value.accepted !== "boolean") {
    throw new LockedControlDaemonClientError("invalid_response");
  }
  const snapshot = parseSnapshot(value.snapshot);
  if (value.accepted === true) return { accepted: true, snapshot };
  if (!isLockedControlReasonCode(value.reason)) {
    throw new LockedControlDaemonClientError("invalid_response");
  }
  return { accepted: false, reason: value.reason, snapshot };
}

function parseSnapshot(value: unknown): LockedControlDaemonSnapshot {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.revision)
    || (value.revision as number) < 0
    || !isLockedComputerControlProjectionV1(value.projection)) {
    throw new LockedControlDaemonClientError("invalid_response");
  }
  return Object.freeze({
    revision: value.revision as number,
    projection: value.projection,
  });
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
