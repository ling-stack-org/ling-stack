import {
  desktopCapturer,
  session,
  shell,
  systemPreferences,
  webContents,
  type Event,
  type Session,
  type WebContents,
  type WebContentsDidStartNavigationEventParams,
} from "electron";
import type { ComputerUsePreviewDescriptorResolver } from "./descriptor-registry.js";
import type {
  ComputerUsePreviewPermissionState,
  ComputerUsePreviewPlatformAdapter,
  PreparedComputerUsePreviewSource,
} from "./platform-adapter.js";
import { COMPUTER_USE_PREVIEW_SESSION_PARTITION } from "./session-partition.js";
import {
  ComputerUseDisplayMediaGrantStore,
  createSafeComputerUseDisplayMediaResponder,
} from "./display-media-grant.js";
import { resolveWindowsProviderPermissionState } from "./provider-permission.js";
import { sourceMatchesDescriptor } from "./source-mapping.js";

export interface ElectronComputerUsePreviewPlatformAdapterOptions {
  readonly partition?: string;
  readonly expectedFrameUrl?: string;
  readonly onDiagnostic?: (event: string, details: Readonly<Record<string, unknown>>) => void;
}

export class ElectronComputerUsePreviewPlatformAdapter implements ComputerUsePreviewPlatformAdapter {
  readonly platform: "macos" | "windows";
  private readonly captureSession: Session;
  private readonly displayMediaGrants = new ComputerUseDisplayMediaGrantStore();
  private readonly expectedFrameUrl?: string;
  private readonly onDiagnostic?: ElectronComputerUsePreviewPlatformAdapterOptions["onDiagnostic"];
  private grantRequesterBinding: {
    readonly generation: number;
    readonly dispose: () => void;
  } | undefined;
  private disposed = false;

  constructor(
    private readonly descriptorResolver: ComputerUsePreviewDescriptorResolver,
    options: ElectronComputerUsePreviewPlatformAdapterOptions = {},
  ) {
    if (process.platform !== "darwin" && process.platform !== "win32") {
      throw new Error("computer_use_capture_platform_unsupported");
    }
    this.platform = process.platform === "win32" ? "windows" : "macos";
    this.onDiagnostic = options.onDiagnostic;
    this.expectedFrameUrl = options.expectedFrameUrl;
    this.captureSession = session.fromPartition(options.partition ?? COMPUTER_USE_PREVIEW_SESSION_PARTITION);
    this.captureSession.setDisplayMediaRequestHandler((request, callback) => {
      const frame = request.frame;
      const frameActive = Boolean(frame && !frame.isDestroyed() && !frame.detached);
      const requester = frameActive && frame ? webContents.fromFrame(frame) : undefined;
      const requesterById = requester ? webContents.fromId(requester.id) : undefined;
      const respond = createSafeComputerUseDisplayMediaResponder(callback, (error) => {
        this.onDiagnostic?.("computer_use.capture_callback_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
      const approved = this.displayMediaGrants.consume({
        webContentsId: requester?.id,
        frameToken: frame?.frameToken,
        frameTreeNodeId: frame?.frameTreeNodeId,
        frameProcessId: frame?.processId,
        frameRoutingId: frame?.routingId,
        isMainFrame: Boolean(frame && requester?.mainFrame === frame),
        frameActive,
        requesterIdentityCurrent: Boolean(requester && requesterById === requester),
        requesterUsesCaptureSession: requester?.session === this.captureSession,
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested,
        securityOrigin: request.securityOrigin,
        frameOrigin: frame?.origin ?? "",
        frameUrl: frame?.url ?? "",
      });
      this.onDiagnostic?.("computer_use.capture_requested", {
        videoRequested: request.videoRequested,
        audioRequested: request.audioRequested,
        userGesture: request.userGesture,
        approvedSourceAvailable: Boolean(approved),
        requesterAvailable: Boolean(requester),
        mainFrame: Boolean(frame && requester?.mainFrame === frame),
      });
      if (!approved) {
        respond({});
        return;
      }
      const approvedSource = approved.source;
      void desktopCapturer.getSources({
        types: [approvedSource.type],
        thumbnailSize: { width: 0, height: 0 },
        fetchWindowIcons: false,
      }).then(async (sources) => {
        let source = this.displayMediaGrants.isCurrent(approved.generation)
          ? sources.find((candidate) => sourceMatchesDescriptor(
              candidate,
              approvedSource.type,
              approvedSource.target,
            ))
          : undefined;
        let targetOwnershipValidated = approvedSource.type !== "window";
        if (source && !targetOwnershipValidated) {
          targetOwnershipValidated = await this.isTargetStillAuthorized(approved);
          if (!targetOwnershipValidated) {
            source = undefined;
          }
        }
        this.onDiagnostic?.("computer_use.capture_source_resolved", {
          sourceCount: sources.length,
          matched: Boolean(source),
          approvalStillCurrent: this.displayMediaGrants.isCurrent(approved.generation),
          targetOwnershipValidated,
        });
        respond(source ? { video: { id: source.id, name: source.name } } : {});
      }).catch((error) => {
        this.onDiagnostic?.("computer_use.capture_source_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        respond({});
      }).finally(() => this.clearGrantRequesterBinding(approved.generation));
    });
  }

  async getPermissionState(input: {
    readonly descriptorId: string;
    readonly revision: number;
  }): Promise<ComputerUsePreviewPermissionState> {
    if (process.platform === "win32") {
      const state = await resolveWindowsProviderPermissionState(this.descriptorResolver, input);
      this.onDiagnostic?.("computer_use.capture_permission", {
        state,
        source: "provider_descriptor",
      });
      return state;
    }
    const state = systemPreferences.getMediaAccessStatus("screen");
    const normalized = state === "granted" || state === "denied" || state === "restricted" ? state : "prompt";
    this.onDiagnostic?.("computer_use.capture_permission", { state: normalized });
    return normalized;
  }

  async prepare(input: {
    readonly sessionId: string;
    readonly descriptorId: string;
    readonly revision: number;
    readonly requesterWebContentsId: number;
    readonly maxFrameRate: number;
    readonly maxSize: { readonly width: number; readonly height: number };
  }): Promise<PreparedComputerUsePreviewSource> {
    if (this.disposed) {
      throw new Error("computer_use_capture_adapter_disposed");
    }
    this.clearGrantRequesterBinding();
    const attemptGeneration = this.displayMediaGrants.beginAttempt();
    const descriptor = await this.descriptorResolver.resolve(input.descriptorId, input.revision);
    if (this.disposed || !this.displayMediaGrants.isCurrent(attemptGeneration)) {
      throw new Error("computer_use_capture_prepare_stale");
    }
    const expectedPlatform = process.platform === "win32" ? "windows" : "macos";
    if (descriptor.platform !== expectedPlatform) {
      throw new Error("computer_use_descriptor_platform_mismatch");
    }
    if (descriptor.sourceKind === "fake") {
      return { sourceKind: "fake" };
    }
    const sourceType = descriptor.sourceKind === "display" ? "screen" : "window";
    if (!descriptor.target.electronSourceId && !descriptor.target.nativeWindowId) {
      throw new Error("computer_use_capture_source_not_found");
    }
    if (!this.expectedFrameUrl) {
      throw new Error("computer_use_capture_request_context_unavailable");
    }
    const requester = webContents.fromId(input.requesterWebContentsId);
    const requesterFrame = requester?.mainFrame;
    if (
      !requester ||
      requester.isDestroyed() ||
      requester.session !== this.captureSession ||
      !requesterFrame ||
      requesterFrame.isDestroyed() ||
      requesterFrame.detached ||
      requesterFrame.url !== this.expectedFrameUrl
    ) {
      throw new Error("computer_use_capture_request_context_unavailable");
    }
    const issued = this.displayMediaGrants.issueIfCurrent(attemptGeneration, {
      source: {
        type: sourceType,
        target: {
          processId: descriptor.target.processId,
          electronSourceId: descriptor.target.electronSourceId,
          nativeWindowId: descriptor.target.nativeWindowId,
        },
      },
      sessionId: input.sessionId,
      descriptorId: descriptor.descriptorId,
      revision: descriptor.revision,
      authorizationGrantId: descriptor.authorization.grantId,
      authorizationExpiresAt: descriptor.authorization.expiresAt,
      requesterWebContentsId: input.requesterWebContentsId,
      expectedFrameToken: requesterFrame.frameToken,
      expectedFrameTreeNodeId: requesterFrame.frameTreeNodeId,
      expectedFrameProcessId: requesterFrame.processId,
      expectedFrameRoutingId: requesterFrame.routingId,
      expectedFrameUrl: this.expectedFrameUrl,
    });
    if (!issued) {
      throw new Error("computer_use_capture_prepare_stale");
    }
    this.bindGrantRequester(attemptGeneration, requester);
    return { sourceKind: "display_media" };
  }

  async release(): Promise<void> {
    this.clearGrantRequesterBinding();
    this.displayMediaGrants.invalidate();
  }

  async dispose(): Promise<void> {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    try {
      await this.release();
    } finally {
      this.captureSession.setDisplayMediaRequestHandler(null);
    }
  }

  async openPermissionSettings(): Promise<void> {
    const url = process.platform === "darwin"
      ? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
      : "ms-settings:privacy-graphicscaptureprogrammatic";
    await shell.openExternal(url);
  }

  private async isTargetStillAuthorized(approved: {
    readonly generation: number;
    readonly descriptorId: string;
    readonly revision: number;
    readonly authorizationGrantId: string;
    readonly source: {
      readonly type: "screen" | "window";
      readonly target: {
        readonly processId?: number;
        readonly nativeWindowId?: string;
        readonly electronSourceId?: string;
      };
    };
  }): Promise<boolean> {
    const expected = approved.source.target;
    if (
      expected.processId === undefined ||
      expected.nativeWindowId === undefined ||
      !this.displayMediaGrants.isCurrent(approved.generation)
    ) {
      return false;
    }
    try {
      const descriptor = await this.descriptorResolver.resolve(
        approved.descriptorId,
        approved.revision,
      );
      return (
        this.displayMediaGrants.isCurrent(approved.generation) &&
        descriptor.platform === this.platform &&
        descriptor.sourceKind === "window" &&
        descriptor.authorization.grantId === approved.authorizationGrantId &&
        descriptor.target.processId === expected.processId &&
        descriptor.target.nativeWindowId === expected.nativeWindowId &&
        descriptor.target.electronSourceId === expected.electronSourceId
      );
    } catch {
      return false;
    }
  }

  private bindGrantRequester(generation: number, requester: WebContents): void {
    this.clearGrantRequesterBinding();
    const invalidate = (): void => {
      if (this.displayMediaGrants.isCurrent(generation)) {
        this.displayMediaGrants.invalidate();
      }
      this.clearGrantRequesterBinding(generation);
    };
    const onNavigation = (
      details: Event<WebContentsDidStartNavigationEventParams>,
    ): void => {
      if (details.isMainFrame && !details.isSameDocument) {
        invalidate();
      }
    };
    const onDestroyed = (): void => invalidate();
    requester.on("did-start-navigation", onNavigation);
    requester.on("destroyed", onDestroyed);
    this.grantRequesterBinding = {
      generation,
      dispose: () => {
        if (!requester.isDestroyed()) {
          requester.off("did-start-navigation", onNavigation);
          requester.off("destroyed", onDestroyed);
        }
      },
    };
  }

  private clearGrantRequesterBinding(generation?: number): void {
    const binding = this.grantRequesterBinding;
    if (!binding || (generation !== undefined && binding.generation !== generation)) {
      return;
    }
    this.grantRequesterBinding = undefined;
    try {
      binding.dispose();
    } catch {
      // The requester may have torn down between the identity check and listener cleanup.
    }
  }
}
