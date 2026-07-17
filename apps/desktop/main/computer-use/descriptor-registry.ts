import type { DesktopPlatform } from "../../shared/desktop-capabilities.js";

export interface ResolvedComputerUsePreviewDescriptor {
  readonly descriptorId: string;
  readonly revision: number;
  readonly platform: Extract<DesktopPlatform, "macos" | "windows">;
  readonly sourceKind: "window" | "display" | "fake";
  readonly target: {
    readonly applicationId?: string;
    readonly processId?: number;
    readonly nativeWindowId?: string;
    readonly electronSourceId?: string;
  };
  readonly authorization: {
    readonly grantId: string;
    readonly expiresAt: string;
  };
}

export interface ComputerUsePreviewDescriptorResolver {
  resolve(descriptorId: string, revision: number): Promise<ResolvedComputerUsePreviewDescriptor>;
}

export class InMemoryComputerUsePreviewDescriptorRegistry implements ComputerUsePreviewDescriptorResolver {
  private readonly descriptors = new Map<string, ResolvedComputerUsePreviewDescriptor>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  register(descriptor: ResolvedComputerUsePreviewDescriptor): void {
    if (!descriptor.descriptorId.trim()) {
      throw new Error("Computer Use descriptorId is required");
    }
    if (!Number.isInteger(descriptor.revision) || descriptor.revision < 0) {
      throw new Error("Computer Use descriptor revision must be a non-negative integer");
    }
    if (!descriptor.authorization.grantId.trim() || !Number.isFinite(Date.parse(descriptor.authorization.expiresAt))) {
      throw new Error("Computer Use descriptor authorization is invalid");
    }
    this.descriptors.set(descriptor.descriptorId, descriptor);
  }

  revoke(descriptorId: string): void {
    this.descriptors.delete(descriptorId);
  }

  async resolve(descriptorId: string, revision: number): Promise<ResolvedComputerUsePreviewDescriptor> {
    const descriptor = this.descriptors.get(descriptorId);
    if (!descriptor) {
      throw new Error("computer_use_descriptor_not_found");
    }
    if (descriptor.revision !== revision) {
      throw new Error("computer_use_descriptor_revision_mismatch");
    }
    if (Date.parse(descriptor.authorization.expiresAt) <= this.now().getTime()) {
      this.descriptors.delete(descriptorId);
      throw new Error("computer_use_descriptor_expired");
    }
    return descriptor;
  }
}

export const FAKE_COMPUTER_USE_DESCRIPTOR: ResolvedComputerUsePreviewDescriptor = {
  descriptorId: "preview_fake_session_01",
  revision: 1,
  platform: "macos",
  sourceKind: "fake",
  target: {},
  authorization: {
    grantId: "fake_preview_grant_01",
    expiresAt: "2099-01-01T00:00:00.000Z",
  },
};
