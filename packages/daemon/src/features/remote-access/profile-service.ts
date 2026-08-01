import type { RunStore, UserProfile } from "@ling-stack/core";
import {
  REMOTE_PROTOCOL_LIMITS,
  type RemoteProfileUpdateCommandV1,
  type RemoteUserProfileV1,
} from "@ling-stack/contracts";
import { RemoteAccessError } from "./errors.js";

const MAX_AVATAR_DECODED_BYTES = 72 * 1024;
const MAX_AVATAR_DIMENSION = 1_024;
const DEFAULT_PROFILE_ENTITY_ID = "default";

type RemoteProfileStore = Pick<RunStore, "getUserProfile" | "updateUserProfile" | "getRemoteProjectionEntityVersion">;

export class RemoteProfileService {
  constructor(
    private readonly store: RemoteProfileStore,
    private readonly workspaceId: string,
  ) {}

  read(now: string): RemoteUserProfileV1 {
    return this.project(this.store.getUserProfile(now));
  }

  update(input: RemoteProfileUpdateCommandV1, now: string): RemoteUserProfileV1 {
    if (input.workspaceId !== this.workspaceId) {
      throw new RemoteAccessError("workspace_not_allowed", "The requested workspace is not bound to this device.");
    }
    if (input.displayName === undefined && input.avatarDataUrl === undefined) {
      throw new RemoteAccessError("profile_update_invalid", "A profile update must include displayName or avatarDataUrl.");
    }
    const displayName = input.displayName === undefined ? undefined : normalizeDisplayName(input.displayName);
    if (input.avatarDataUrl !== undefined && input.avatarDataUrl !== null) {
      validateAvatarDataUrl(input.avatarDataUrl);
    }
    const profile = this.store.updateUserProfile({
      ...(displayName === undefined ? {} : { displayName }),
      ...(input.avatarDataUrl === undefined ? {} : { avatarDataUrl: input.avatarDataUrl }),
    }, now);
    return this.project(profile);
  }

  private project(profile: UserProfile): RemoteUserProfileV1 {
    const version = this.store.getRemoteProjectionEntityVersion({
      workspaceId: this.workspaceId,
      entityType: "user_profile",
      entityId: DEFAULT_PROFILE_ENTITY_ID,
    });
    return {
      workspaceId: this.workspaceId,
      displayName: profile.displayName,
      ...(profile.handle ? { handle: profile.handle } : {}),
      ...(profile.avatarDataUrl ? { avatarDataUrl: profile.avatarDataUrl } : {}),
      revision: version.revision,
      updatedAt: profile.updatedAt,
    };
  }
}

function normalizeDisplayName(value: string): string {
  const displayName = value.trim();
  if (!displayName || [...displayName].length > 80) {
    throw new RemoteAccessError("profile_update_invalid", "displayName must contain 1 to 80 characters.");
  }
  return displayName;
}

function validateAvatarDataUrl(value: string): void {
  if (Buffer.byteLength(value, "utf8") > REMOTE_PROTOCOL_LIMITS.maxAvatarDataUrlBytes) {
    throw new RemoteAccessError("profile_update_invalid", "The avatar data URL is too large.");
  }
  const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(value);
  if (!match) {
    throw new RemoteAccessError("profile_update_invalid", "The avatar must be a PNG, JPEG, or WebP base64 data URL.");
  }
  const bytes = Buffer.from(match[2]!, "base64");
  if (bytes.length === 0 || bytes.length > MAX_AVATAR_DECODED_BYTES || bytes.toString("base64") !== match[2]) {
    throw new RemoteAccessError("profile_update_invalid", "The avatar base64 payload is invalid or too large.");
  }
  const dimensions = imageDimensions(match[1]!, bytes);
  if (!dimensions || dimensions.width < 1 || dimensions.height < 1) {
    throw new RemoteAccessError("profile_update_invalid", "The avatar image header is invalid.");
  }
  if (dimensions.width > MAX_AVATAR_DIMENSION || dimensions.height > MAX_AVATAR_DIMENSION) {
    throw new RemoteAccessError("profile_update_invalid", "The avatar dimensions must not exceed 1024 by 1024 pixels.");
  }
}

function imageDimensions(mimeType: string, bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (mimeType === "image/png") {
    return pngDimensions(bytes);
  }
  if (mimeType === "image/jpeg") {
    return jpegDimensions(bytes);
  }
  return webpDimensions(bytes);
}

function pngDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  const signature = "89504e470d0a1a0a";
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== signature || bytes.subarray(12, 16).toString("ascii") !== "IHDR") {
    return undefined;
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function jpegDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) {
      continue;
    }
    if (offset + 2 > bytes.length) {
      return undefined;
    }
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) {
      return undefined;
    }
    if (isJpegStartOfFrame(marker) && length >= 7) {
      return { width: bytes.readUInt16BE(offset + 5), height: bytes.readUInt16BE(offset + 3) };
    }
    offset += length;
  }
  return undefined;
}

function isJpegStartOfFrame(marker: number): boolean {
  return (marker >= 0xc0 && marker <= 0xc3)
    || (marker >= 0xc5 && marker <= 0xc7)
    || (marker >= 0xc9 && marker <= 0xcb)
    || (marker >= 0xcd && marker <= 0xcf);
}

function webpDimensions(bytes: Buffer): { readonly width: number; readonly height: number } | undefined {
  if (bytes.length < 30 || bytes.subarray(0, 4).toString("ascii") !== "RIFF" || bytes.subarray(8, 12).toString("ascii") !== "WEBP") {
    return undefined;
  }
  const chunk = bytes.subarray(12, 16).toString("ascii");
  if (chunk === "VP8X") {
    return {
      width: 1 + bytes.readUIntLE(24, 3),
      height: 1 + bytes.readUIntLE(27, 3),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return {
      width: bytes.readUInt16LE(26) & 0x3fff,
      height: bytes.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const packed = bytes.readUInt32LE(21);
    return {
      width: 1 + (packed & 0x3fff),
      height: 1 + ((packed >>> 14) & 0x3fff),
    };
  }
  return undefined;
}
