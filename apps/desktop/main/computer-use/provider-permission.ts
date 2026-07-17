import type { ComputerUsePreviewDescriptorResolver } from "./descriptor-registry.js";
import type {
  ComputerUsePreviewPermissionInput,
  ComputerUsePreviewPermissionState,
} from "./platform-adapter.js";

/**
 * Windows does not expose a meaningful Electron screen-permission status:
 * `getMediaAccessStatus("screen")` is documented as always granted. Bind the
 * preflight to the exact daemon-issued provider descriptor instead so a
 * missing, stale, cross-platform, or identity-poor provider cannot fail open.
 * The source endpoint and display-media callback revalidate HWND ownership;
 * this function only reports whether that fail-closed path is available.
 */
export async function resolveWindowsProviderPermissionState(
  descriptorResolver: ComputerUsePreviewDescriptorResolver,
  input: ComputerUsePreviewPermissionInput,
): Promise<ComputerUsePreviewPermissionState> {
  try {
    const descriptor = await descriptorResolver.resolve(input.descriptorId, input.revision);
    if (descriptor.platform !== "windows") {
      return "denied";
    }
    if (descriptor.sourceKind === "window") {
      return descriptor.target.processId !== undefined && descriptor.target.nativeWindowId !== undefined
        ? "granted"
        : "denied";
    }
    return descriptor.sourceKind === "display" && descriptor.target.electronSourceId !== undefined
      ? "granted"
      : "denied";
  } catch {
    return "denied";
  }
}
