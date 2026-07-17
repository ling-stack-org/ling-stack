export interface ComputerUseDisplayMediaSourceGrant {
  readonly type: "screen" | "window";
  readonly target: {
    readonly processId?: number;
    readonly nativeWindowId?: string;
    readonly electronSourceId?: string;
  };
}

export interface ComputerUseDisplayMediaRequestContext {
  readonly webContentsId?: number;
  readonly frameToken?: string;
  readonly frameTreeNodeId?: number;
  readonly frameProcessId?: number;
  readonly frameRoutingId?: number;
  readonly isMainFrame: boolean;
  readonly frameActive: boolean;
  readonly requesterIdentityCurrent: boolean;
  readonly requesterUsesCaptureSession: boolean;
  readonly videoRequested: boolean;
  readonly audioRequested: boolean;
  readonly securityOrigin: string;
  readonly frameOrigin: string;
  readonly frameUrl: string;
}

interface IssuedComputerUseDisplayMediaGrant {
  readonly generation: number;
  readonly source: ComputerUseDisplayMediaSourceGrant;
  readonly sessionId: string;
  readonly descriptorId: string;
  readonly revision: number;
  readonly authorizationGrantId: string;
  readonly authorizationExpiresAtMs: number;
  readonly requesterWebContentsId: number;
  readonly expectedFrameToken: string;
  readonly expectedFrameTreeNodeId: number;
  readonly expectedFrameProcessId: number;
  readonly expectedFrameRoutingId: number;
  readonly expectedFrameUrl: string;
}

export interface ConsumedComputerUseDisplayMediaGrant {
  readonly generation: number;
  readonly source: ComputerUseDisplayMediaSourceGrant;
  readonly sessionId: string;
  readonly descriptorId: string;
  readonly revision: number;
  readonly authorizationGrantId: string;
}

/**
 * Holds the one-shot capture capability issued for one prepared descriptor.
 *
 * The Electron display-media callback is Session-scoped, so the source id
 * alone is not authorization. A request must also come from the exact PiP
 * main frame that was current when the descriptor was prepared.
 */
export class ComputerUseDisplayMediaGrantStore {
  private generation = 0;
  private current: IssuedComputerUseDisplayMediaGrant | undefined;

  beginAttempt(): number {
    this.generation += 1;
    this.current = undefined;
    return this.generation;
  }

  issueIfCurrent(attemptGeneration: number, input: {
    readonly source: ComputerUseDisplayMediaSourceGrant;
    readonly sessionId: string;
    readonly descriptorId: string;
    readonly revision: number;
    readonly authorizationGrantId: string;
    readonly authorizationExpiresAt: string;
    readonly requesterWebContentsId: number;
    readonly expectedFrameToken: string;
    readonly expectedFrameTreeNodeId: number;
    readonly expectedFrameProcessId: number;
    readonly expectedFrameRoutingId: number;
    readonly expectedFrameUrl: string;
  }): boolean {
    const authorizationExpiresAtMs = Date.parse(input.authorizationExpiresAt);
    if (
      attemptGeneration !== this.generation ||
      !Number.isFinite(authorizationExpiresAtMs)
    ) {
      return false;
    }
    this.current = {
      ...input,
      generation: attemptGeneration,
      authorizationExpiresAtMs,
    };
    return true;
  }

  consume(
    request: ComputerUseDisplayMediaRequestContext,
    now: Date = new Date(),
  ): ConsumedComputerUseDisplayMediaGrant | undefined {
    const current = this.current;
    if (
      !current ||
      current.authorizationExpiresAtMs <= now.getTime() ||
      !isAuthorizedComputerUseDisplayMediaRequest(request, current)
    ) {
      if (current?.authorizationExpiresAtMs !== undefined && current.authorizationExpiresAtMs <= now.getTime()) {
        this.current = undefined;
      }
      return undefined;
    }
    this.current = undefined;
    return {
      generation: current.generation,
      source: current.source,
      sessionId: current.sessionId,
      descriptorId: current.descriptorId,
      revision: current.revision,
      authorizationGrantId: current.authorizationGrantId,
    };
  }

  invalidate(): void {
    this.generation += 1;
    this.current = undefined;
  }

  isCurrent(generation: number): boolean {
    return this.generation === generation;
  }
}

export function isAuthorizedComputerUseDisplayMediaRequest(
  request: ComputerUseDisplayMediaRequestContext,
  grant: {
    readonly requesterWebContentsId: number;
    readonly expectedFrameToken: string;
    readonly expectedFrameTreeNodeId: number;
    readonly expectedFrameProcessId: number;
    readonly expectedFrameRoutingId: number;
    readonly expectedFrameUrl: string;
  },
): boolean {
  if (
    request.webContentsId !== grant.requesterWebContentsId ||
    request.frameToken !== grant.expectedFrameToken ||
    request.frameTreeNodeId !== grant.expectedFrameTreeNodeId ||
    request.frameProcessId !== grant.expectedFrameProcessId ||
    request.frameRoutingId !== grant.expectedFrameRoutingId ||
    !request.isMainFrame ||
    !request.frameActive ||
    !request.requesterIdentityCurrent ||
    !request.requesterUsesCaptureSession ||
    !request.videoRequested ||
    request.audioRequested ||
    !sameFrameUrl(request.frameUrl, grant.expectedFrameUrl)
  ) {
    return false;
  }
  return isExpectedSecurityOrigin(
    request.securityOrigin,
    request.frameOrigin,
    grant.expectedFrameUrl,
  );
}

function sameFrameUrl(actual: string, expected: string): boolean {
  try {
    const actualUrl = new URL(actual);
    const expectedUrl = new URL(expected);
    actualUrl.hash = "";
    expectedUrl.hash = "";
    return actualUrl.href === expectedUrl.href;
  } catch {
    return false;
  }
}

function isExpectedSecurityOrigin(
  securityOrigin: string,
  frameOrigin: string,
  expectedFrameUrl: string,
): boolean {
  try {
    const expected = new URL(expectedFrameUrl);
    if (expected.protocol === "file:") {
      // Electron 43 reports the observed pair as file:/// and file://. Some
      // Chromium versions serialize an opaque file origin as null. Accept only
      // these explicit representations after the exact frame identity checks.
      return (
        (securityOrigin === "file:///" && frameOrigin === "file://") ||
        (securityOrigin === "file://" && frameOrigin === "file://") ||
        (securityOrigin === "null" && frameOrigin === "null")
      );
    }
    return securityOrigin === frameOrigin && new URL(securityOrigin).origin === expected.origin;
  } catch {
    return false;
  }
}

export function createSafeComputerUseDisplayMediaResponder<T>(
  callback: (value: T) => void,
  onCallbackError?: (error: unknown) => void,
): (value: T) => void {
  let settled = false;
  return (value) => {
    if (settled) {
      return;
    }
    settled = true;
    try {
      callback(value);
    } catch (error) {
      onCallbackError?.(error);
    }
  };
}
