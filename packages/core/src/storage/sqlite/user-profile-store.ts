import type { SQLOutputValue } from "node:sqlite";
import type { UpdateUserProfileInput, UserProfile } from "../../workspace-types.js";
import { nullableUpdate, omitUndefined, readNullableString, readString } from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

const DEFAULT_PROFILE_ID = "default";
const DEFAULT_DISPLAY_NAME = "Ling User";

export class SqliteUserProfileStore {
  constructor(private readonly context: SqliteStoreContext) {}

  getUserProfile(now: string): UserProfile {
    const row = this.context.database
      .prepare(`
        SELECT display_name, handle, avatar_data_url, created_at, updated_at
        FROM user_profile
        WHERE id = ?
      `)
      .get(DEFAULT_PROFILE_ID);
    if (!row) {
      return {
        schemaVersion: 1,
        displayName: DEFAULT_DISPLAY_NAME,
        createdAt: now,
        updatedAt: now,
      };
    }
    return mapUserProfile(row as Record<string, SQLOutputValue>);
  }

  updateUserProfile(input: UpdateUserProfileInput, now: string): UserProfile {
    const current = this.getUserProfile(now);
    const next: UserProfile = omitUndefined({
      schemaVersion: 1 as const,
      displayName: input.displayName === undefined ? current.displayName : normalizeDisplayName(input.displayName),
      handle: nullableUpdate(input.handle === undefined ? undefined : normalizeHandle(input.handle), current.handle),
      avatarDataUrl: nullableUpdate(input.avatarDataUrl, current.avatarDataUrl),
      createdAt: current.createdAt,
      updatedAt: now,
    });

    this.context.database
      .prepare(`
        INSERT INTO user_profile (id, display_name, handle, avatar_data_url, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          display_name = excluded.display_name,
          handle = excluded.handle,
          avatar_data_url = excluded.avatar_data_url,
          updated_at = excluded.updated_at
      `)
      .run(
        DEFAULT_PROFILE_ID,
        next.displayName,
        next.handle ?? null,
        next.avatarDataUrl ?? null,
        next.createdAt,
        next.updatedAt,
      );
    return this.getUserProfile(now);
  }
}

function mapUserProfile(row: Record<string, SQLOutputValue>): UserProfile {
  return omitUndefined({
    schemaVersion: 1 as const,
    displayName: readString(row, "display_name"),
    handle: readNullableString(row, "handle"),
    avatarDataUrl: readNullableString(row, "avatar_data_url"),
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function normalizeDisplayName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("displayName is required.");
  }
  if (trimmed.length > 80) {
    throw new Error("displayName must be 80 characters or fewer.");
  }
  return trimmed;
}

function normalizeHandle(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim().replace(/^@+/, "");
  if (!trimmed) {
    return null;
  }
  if (trimmed.length > 48) {
    throw new Error("handle must be 48 characters or fewer.");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(trimmed)) {
    throw new Error("handle may only contain letters, numbers, underscores, periods, and dashes.");
  }
  return trimmed;
}
