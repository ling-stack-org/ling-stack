import type { SQLOutputValue } from "node:sqlite";
import {
  createCompanionEventId,
  createCompanionId,
  companionEventTypes,
  normalizeCompanionBehaviorPolicy,
  normalizeCompanionManifest,
  validateCompanionAction,
  validateCompanionEmotion,
  type CompanionEvent,
  type CompanionEventPage,
  type CompanionEventType,
  type CompanionBehaviorPolicy,
  type CompanionManifest,
  type CompanionProfile,
  type CompanionState,
  type CreateCompanionInput,
  type ListCompanionEventsOptions,
  type ListCompanionsOptions,
  type RecordCompanionInteractionInput,
  type RecordCompanionInteractionResult,
  type RecordCompanionEventInput,
  type UpdateCompanionInput,
} from "../../companion-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import {
  omitUndefined,
  parseJsonObject,
  readNumber,
  readNullableString,
  readString,
  stringifyJson,
} from "./helpers.js";
import type { SqliteStoreContext } from "./store-context.js";

export class SqliteCompanionStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: { readonly getAiTeammate: (id: string) => { readonly id: string } | undefined },
  ) {}

  createCompanion(input: CreateCompanionInput, now: string): CompanionProfile {
    if (!this.ports.getAiTeammate(input.teammateId)) {
      throw new Error(`AI teammate not found: ${input.teammateId}`);
    }
    const manifest = normalizeCompanionManifest(input.manifest);
    const behaviorPolicy = normalizeCompanionBehaviorPolicy(input.behaviorPolicy);
    const companion: CompanionProfile = {
      id: input.id ?? createCompanionId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      teammateId: input.teammateId,
      displayName: requireNonEmpty(input.displayName, "displayName"),
      description: input.description ?? "",
      manifest,
      behaviorPolicy,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    this.context.database.prepare(`
      INSERT INTO companions (
        id, workspace_id, teammate_id, display_name, description,
        manifest_json, behavior_policy_json, status, phase, emotion_id,
        emotion_intensity, energy, last_interaction_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      companion.id,
      companion.workspaceId,
      companion.teammateId,
      companion.displayName,
      companion.description,
      stringifyJson(companion.manifest),
      stringifyJson(companion.behaviorPolicy),
      companion.status,
      "idle",
      companion.manifest.defaultEmotionId,
      0.5,
      100,
      null,
      companion.createdAt,
      companion.updatedAt,
    );
    return this.getCompanionOrThrow(companion.id);
  }

  getCompanion(id: string): CompanionProfile | undefined {
    const row = this.context.database.prepare(companionSelectSql("WHERE id = ?")).get(id);
    return row ? mapCompanion(row as Record<string, SQLOutputValue>) : undefined;
  }

  listCompanions(options: ListCompanionsOptions = {}): CompanionProfile[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const offset = Math.max(options.offset ?? 0, 0);
    params.push(limit, offset);
    return this.context.database
      .prepare(`${companionSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params)
      .map((row) => mapCompanion(row as Record<string, SQLOutputValue>));
  }

  updateCompanion(id: string, input: UpdateCompanionInput, now: string): CompanionProfile | undefined {
    const existing = this.getCompanion(id);
    if (!existing) return undefined;
    const manifest = input.manifest ? normalizeCompanionManifest(input.manifest) : existing.manifest;
    const behaviorPolicy = input.behaviorPolicy
      ? normalizeCompanionBehaviorPolicy({ ...existing.behaviorPolicy, ...input.behaviorPolicy })
      : existing.behaviorPolicy;
    const currentState = this.getCompanionStateOrThrow(id);
    const nextEmotionId = manifest.emotions.some((emotion) => emotion.id === currentState.emotionId)
      ? currentState.emotionId
      : manifest.defaultEmotionId;
    const next: CompanionProfile = {
      ...existing,
      displayName: input.displayName === undefined ? existing.displayName : requireNonEmpty(input.displayName, "displayName"),
      description: input.description ?? existing.description,
      manifest,
      behaviorPolicy,
      status: input.status ?? existing.status,
      updatedAt: now,
    };
    this.context.database.prepare(`
      UPDATE companions
      SET display_name = ?, description = ?, manifest_json = ?, behavior_policy_json = ?, status = ?,
          emotion_id = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      next.displayName,
      next.description,
      stringifyJson(next.manifest),
      stringifyJson(next.behaviorPolicy),
      next.status,
      nextEmotionId,
      next.updatedAt,
      id,
    );
    return this.getCompanion(id);
  }

  disableCompanion(id: string, now: string): CompanionProfile | undefined {
    return this.updateCompanion(id, { status: "disabled" }, now);
  }

  getCompanionState(companionId: string): CompanionState | undefined {
    const row = this.context.database.prepare(`
      SELECT id, phase, emotion_id, emotion_intensity, energy, last_interaction_at, updated_at
      FROM companions WHERE id = ?
    `).get(companionId);
    return row ? mapCompanionState(row as Record<string, SQLOutputValue>) : undefined;
  }

  listCompanionEvents(options: ListCompanionEventsOptions): CompanionEvent[] {
    return this.listCompanionEventsPage(options).events.slice();
  }

  listCompanionEventsPage(options: ListCompanionEventsOptions): CompanionEventPage {
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID, options.companionId];
    let where = "workspace_id = ? AND companion_id = ?";
    if (options.beforeCreatedAt) {
      if (options.beforeEventId) {
        const cursor = this.context.database
          .prepare("SELECT companion_id, created_at, rowid FROM companion_events WHERE workspace_id = ? AND id = ?")
          .get(DEFAULT_WORKSPACE_ID, options.beforeEventId);
        if (!cursor || readString(cursor as Record<string, SQLOutputValue>, "companion_id") !== options.companionId) {
          throw new Error(`Invalid companion event cursor: ${options.beforeEventId}`);
        }
        const cursorCreatedAt = readString(cursor as Record<string, SQLOutputValue>, "created_at");
        if (cursorCreatedAt !== options.beforeCreatedAt) {
          throw new Error(`Companion event cursor timestamp does not match: ${options.beforeEventId}`);
        }
        where += " AND (created_at < ? OR (created_at = ? AND rowid < ?))";
        params.push(options.beforeCreatedAt, options.beforeCreatedAt, readNumber(cursor as Record<string, SQLOutputValue>, "rowid"));
      } else {
        where += " AND created_at < ?";
        params.push(options.beforeCreatedAt);
      }
    } else if (options.beforeEventId) {
      const cursor = this.context.database
        .prepare("SELECT companion_id, created_at, rowid FROM companion_events WHERE workspace_id = ? AND id = ?")
        .get(DEFAULT_WORKSPACE_ID, options.beforeEventId);
      if (!cursor || readString(cursor as Record<string, SQLOutputValue>, "companion_id") !== options.companionId) {
        throw new Error(`Invalid companion event cursor: ${options.beforeEventId}`);
      }
      const cursorCreatedAt = readString(cursor as Record<string, SQLOutputValue>, "created_at");
      where += " AND (created_at < ? OR (created_at = ? AND rowid < ?))";
      params.push(cursorCreatedAt, cursorCreatedAt, readNumber(cursor as Record<string, SQLOutputValue>, "rowid"));
    }
    params.push(limit + 1);
    const events = this.context.database
      .prepare(`${companionEventSelectSql(`WHERE ${where}`)} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(...params)
      .map((row) => mapCompanionEvent(row as Record<string, SQLOutputValue>));
    const hasMore = events.length > limit;
    const pageEvents = events.slice(0, limit);
    const oldest = pageEvents[pageEvents.length - 1];
    return {
      events: pageEvents,
      hasMore,
      ...(hasMore && oldest ? { nextBeforeCreatedAt: oldest.createdAt, nextBeforeEventId: oldest.id } : {}),
    };
  }

  recordCompanionInteraction(input: RecordCompanionInteractionInput, now: string): RecordCompanionInteractionResult {
    const companion = this.getCompanionOrThrow(input.companionId);
    if (companion.status === "disabled") {
      throw new Error("Disabled companions cannot receive interactions");
    }
    if (input.emotionId) validateCompanionEmotion(companion.manifest, input.emotionId);
    if (input.actionId) validateCompanionAction(companion.manifest, input.actionId);
    const current = this.getCompanionStateOrThrow(input.companionId);
    const nextEmotionId = input.emotionId ?? current.emotionId;
    const nextIntensity = clamp(input.emotionIntensity ?? current.emotionIntensity, 0, 1);
    const nextEnergy = clamp(input.energy ?? current.energy, 0, 100);
    const nextPhase = input.phase ?? phaseForInteraction(input.type, current.phase);
    const eventPayload = {
      ...(input.payload ?? {}),
      ...(input.emotionId ? { emotionId: input.emotionId, intensity: nextIntensity } : {}),
      ...(input.actionId ? { actionId: input.actionId } : {}),
    };
    const event = this.buildEvent({
      companionId: input.companionId,
      type: input.type,
      payload: eventPayload,
    }, now);
    try {
      this.context.database.exec("BEGIN");
      this.context.database.prepare(`
        UPDATE companions
        SET phase = ?, emotion_id = ?, emotion_intensity = ?, energy = ?, last_interaction_at = ?, updated_at = ?
        WHERE id = ?
      `).run(nextPhase, nextEmotionId, nextIntensity, nextEnergy, now, now, input.companionId);
      this.insertEvent(event);
      this.context.database.exec("COMMIT");
    } catch (error) {
      try { this.context.database.exec("ROLLBACK"); } catch { /* preserve the original error */ }
      throw error;
    }
    return {
      companion: this.getCompanionOrThrow(input.companionId),
      state: this.getCompanionStateOrThrow(input.companionId),
      event,
    };
  }

  recordCompanionEvent(input: RecordCompanionEventInput, now: string): CompanionEvent {
    this.getCompanionOrThrow(input.companionId);
    const event = this.buildEvent(input, now);
    this.insertEvent(event);
    return event;
  }

  private getCompanionOrThrow(id: string): CompanionProfile {
    const companion = this.getCompanion(id);
    if (!companion) throw new Error(`Companion not found: ${id}`);
    return companion;
  }

  private getCompanionStateOrThrow(id: string): CompanionState {
    const state = this.getCompanionState(id);
    if (!state) throw new Error(`Companion not found: ${id}`);
    return state;
  }

  private buildEvent(input: RecordCompanionEventInput, now: string): CompanionEvent {
    if (!companionEventTypes.includes(input.type as (typeof companionEventTypes)[number])) {
      throw new Error(`Companion event type is not supported: ${input.type}`);
    }
    return {
      id: createCompanionEventId(),
      workspaceId: DEFAULT_WORKSPACE_ID,
      companionId: input.companionId,
      type: input.type,
      payload: input.payload ?? {},
      createdAt: now,
    };
  }

  private insertEvent(event: CompanionEvent): void {
    this.context.database.prepare(`
      INSERT INTO companion_events (id, workspace_id, companion_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(event.id, event.workspaceId, event.companionId, event.type, stringifyJson(event.payload), event.createdAt);
  }
}

const companionSelectSql = (where: string): string => `
  SELECT id, workspace_id, teammate_id, display_name, description,
         manifest_json, behavior_policy_json, status, created_at, updated_at
  FROM companions ${where}
`;

const companionEventSelectSql = (where: string): string => `
  SELECT id, workspace_id, companion_id, type, payload_json, created_at
  FROM companion_events ${where}
`;

function mapCompanion(row: Record<string, SQLOutputValue>): CompanionProfile {
  return omitUndefined({
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    teammateId: readString(row, "teammate_id"),
    displayName: readString(row, "display_name"),
    description: readString(row, "description"),
    manifest: normalizeCompanionManifest(parseJsonObject(readString(row, "manifest_json")) as unknown as CompanionManifest),
    behaviorPolicy: normalizeCompanionBehaviorPolicy(parseJsonObject(readString(row, "behavior_policy_json")) as unknown as CompanionBehaviorPolicy),
    status: readString(row, "status") as CompanionProfile["status"],
    createdAt: readString(row, "created_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapCompanionState(row: Record<string, SQLOutputValue>): CompanionState {
  return omitUndefined({
    companionId: readString(row, "id"),
    phase: readString(row, "phase") as CompanionState["phase"],
    emotionId: readString(row, "emotion_id"),
    emotionIntensity: readNumber(row, "emotion_intensity"),
    energy: readNumber(row, "energy"),
    lastInteractionAt: readNullableString(row, "last_interaction_at"),
    updatedAt: readString(row, "updated_at"),
  });
}

function mapCompanionEvent(row: Record<string, SQLOutputValue>): CompanionEvent {
  return {
    id: readString(row, "id"),
    workspaceId: readString(row, "workspace_id"),
    companionId: readString(row, "companion_id"),
    type: readString(row, "type") as CompanionEventType,
    payload: parseJsonObject(readString(row, "payload_json")),
    createdAt: readString(row, "created_at"),
  };
}

function phaseForInteraction(type: RecordCompanionInteractionInput["type"], current: CompanionState["phase"]): CompanionState["phase"] {
  if (type === "error") return "error";
  if (type === "action_requested" || type === "emotion_changed" || type === "milestone") return "reacting";
  return current;
}

function requireNonEmpty(value: string, key: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`Companion ${key} cannot be empty`);
  return normalized;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) throw new Error("Companion state values must be finite numbers");
  return Math.min(max, Math.max(min, value));
}
