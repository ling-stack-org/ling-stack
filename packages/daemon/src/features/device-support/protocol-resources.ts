import {
  HARDWARE_PROTOCOL_PROFILE_ENTRYPOINT_V1, isHardwareProtocolProfileResourceV1,
  type DeviceDeveloperSessionV1, type DeviceProfileV1, type DeviceResourceManifestV1, type HardwareProtocolProfileV1,
} from "@ling-stack/contracts";
import {
  DeviceFabricError, hardwareProtocolProfileMatches, type DeviceResourceActivationValidator, type DeviceResourceCompatibility,
} from "@ling-stack/core";
import type { DeviceSupportRuntime } from "./runtime.js";

const resourcePlatforms: Partial<Record<NodeJS.Platform, DeviceResourceCompatibility["platform"]>> = {
  darwin: "macos", linux: "linux", win32: "windows",
};

export function hostDeviceResourceCompatibility(): DeviceResourceCompatibility {
  return { platform: resourcePlatforms[process.platform] };
}

export function validateProtocolResourceActivation(
  runtime: DeviceSupportRuntime, input: Parameters<DeviceResourceActivationValidator>[0],
): void {
  const { manifest, payload, current } = input;
  if (current && isProtocolResource(current.manifest) !== isProtocolResource(manifest)) {
    throw new DeviceFabricError("resource_conflict", "protocol profile resource kind cannot change");
  }
  if (isProtocolResource(manifest)) parseProtocolResource(runtime, manifest, payload);
}

export function listProtocolProfiles(runtime: DeviceSupportRuntime): readonly HardwareProtocolProfileV1[] {
  const builtIn = runtime.protocolProfiles.list();
  if (!runtime.resourceTrustConfigured) return builtIn;
  const store = runtime.fabricStore;
  return store.withReadSnapshot(() => {
    const imported = store.listActiveResourceIds("profile", HARDWARE_PROTOCOL_PROFILE_ENTRYPOINT_V1).flatMap(id => {
      try {
        const resource = readActiveProtocolProfile(runtime, id);
        return resource ? [resource.profile] : [];
      } catch (error) {
        if (error instanceof DeviceFabricError && (error.code === "resource_conflict" || error.code === "target_missing")) return [];
        throw error;
      }
    });
    return [...builtIn, ...imported].sort((a, b) => a.profileId.localeCompare(b.profileId));
  });
}

export function resolveProtocolProfile(runtime: DeviceSupportRuntime, profileId: string, target: DeviceProfileV1 | undefined) {
  const facts = {
    deviceKind: target?.device.kind ?? ("hardware" as const), model: target?.device.model, firmwareVersion: target?.device.firmwareVersion,
  };
  const resource = readActiveProtocolProfile(runtime, profileId, target);
  if (!resource) return { profile: runtime.protocolProfiles.resolve({ profileId, ...facts }), digest: undefined };
  if (!hardwareProtocolProfileMatches(resource.profile, facts)) {
    throw new DeviceFabricError("target_missing", "protocol profile is incompatible with the target");
  }
  return resource;
}

export function assertActiveProtocolProfile(runtime: DeviceSupportRuntime, session: DeviceDeveloperSessionV1): void {
  const binding = session.protocolReplay;
  if (!binding?.profileResource) return;
  const target = runtime.store.getDevice(session.targetDeviceId);
  const resource = readActiveProtocolProfile(runtime, binding.profileId, target);
  if (!resource || resource.digest !== binding.profileResource.digest || resource.profile.version !== binding.profileVersion
    || !hardwareProtocolProfileMatches(resource.profile, {
      deviceKind: target?.device.kind ?? session.targetKind, model: target?.device.model, firmwareVersion: target?.device.firmwareVersion,
    })) {
    throw new DeviceFabricError("target_changed", "protocol profile resource or target compatibility changed");
  }
}

function readActiveProtocolProfile(runtime: DeviceSupportRuntime, profileId: string, target?: DeviceProfileV1) {
  if (!runtime.resourceTrustConfigured) return undefined;
  const store = runtime.fabricStore;
  return store.withReadSnapshot(() => {
    const record = store.getResource(profileId);
    if (record?.status !== "active" || !isProtocolResource(record.manifest)) return undefined;
    const payload = store.readActiveResourcePayload(profileId, {
      ...hostDeviceResourceCompatibility(), ...(target ? { deviceKind: target.device.kind, firmwareVersion: target.device.firmwareVersion } : {}),
      availablePermissions: [],
    });
    if (!payload) throw new DeviceFabricError("resource_conflict", "protocol profile payload is unavailable");
    return { profile: parseProtocolResource(runtime, record.manifest, payload), digest: record.payloadDigest };
  });
}

function isProtocolResource(manifest: DeviceResourceManifestV1): boolean {
  return manifest.kind === "profile" && manifest.entrypoint === HARDWARE_PROTOCOL_PROFILE_ENTRYPOINT_V1;
}

function parseProtocolResource(runtime: DeviceSupportRuntime, manifest: DeviceResourceManifestV1, payload: Uint8Array): HardwareProtocolProfileV1 {
  if (runtime.protocolProfiles.get(manifest.resourceId) || payload.byteLength > 64 * 1024
    || manifest.supportedDeviceKinds.length === 0 || (manifest.requiredPermissions?.length ?? 0) > 0) {
    throw new DeviceFabricError("resource_conflict", "protocol profile collides with a built-in profile or has incompatible metadata");
  }
  let profile: unknown;
  try {
    profile = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new DeviceFabricError("resource_conflict", "protocol profile must be a UTF-8 JSON document");
  }
  if (!isHardwareProtocolProfileResourceV1(profile)) {
    throw new DeviceFabricError("resource_conflict", "protocol profile fields are invalid");
  }
  const codec = runtime.protocolWorkbench.getCodecManifest(profile.codecId);
  if (!codec) throw new DeviceFabricError("resource_conflict", "protocol profile requires an installed codec");
  return {
    profileId: manifest.resourceId, version: manifest.version, license: manifest.license, codecId: codec.codecId, transport: codec.transport,
    supportedDeviceKinds: manifest.supportedDeviceKinds, capabilityIds: profile.capabilityIds,
    ...(profile.supportedModels ? { supportedModels: profile.supportedModels } : {}),
    ...(manifest.supportedFirmwareRanges ? { supportedFirmwareRanges: manifest.supportedFirmwareRanges } : {}),
  };
}
