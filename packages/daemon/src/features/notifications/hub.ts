import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  defaultNotificationPreferences,
  isQuietHour,
  notificationMatchesTone,
  type NotificationDeliveryTone,
  type NotificationEventKind,
  type NotificationPreferences,
  type NotificationRecord,
  type NotificationPreferencesUpdate,
} from "@ling-stack/contracts";

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_RECORDS = 200;

interface NotificationJournalFile {
  readonly schemaVersion: 1;
  readonly records: readonly NotificationRecord[];
}

interface NotificationPreferencesFile {
  readonly schemaVersion: 1;
  readonly preferences: NotificationPreferences;
}

export interface NotificationEmitInput {
  readonly kind: NotificationEventKind;
  readonly title: string;
  readonly body: string;
  readonly automationId?: string;
  readonly automationLabel?: string;
  readonly runId?: string;
  readonly cwd?: string;
  readonly at?: Date;
}

export interface NotificationDelivery {
  readonly record: NotificationRecord;
  /** False when suppressed by preferences (tone/off/quiet hours) — recorded but not delivered. */
  readonly deliver: boolean;
}

/**
 * File-backed notification journal + preferences with in-process waiters for
 * long-poll delivery. The journal is bounded (oldest entries dropped) and
 * survives restarts; failures to persist degrade to in-memory operation.
 */
export class NotificationHub {
  private readonly journalPath: string | null;
  private readonly preferencesPath: string | null;
  private records: NotificationRecord[] = [];
  private preferences: NotificationPreferences = defaultNotificationPreferences();
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(paths: { journalPath?: string | null; preferencesPath?: string | null } = {}) {
    this.journalPath = paths.journalPath ?? null;
    this.preferencesPath = paths.preferencesPath ?? null;
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    this.loadPromise ??= this.load();
    await this.loadPromise;
    this.loaded = true;
  }

  private async load(): Promise<void> {
    if (this.journalPath) {
      try {
        const raw = await readFile(this.journalPath, "utf8");
        const parsed = JSON.parse(raw) as NotificationJournalFile;
        if (parsed?.schemaVersion === JOURNAL_VERSION && Array.isArray(parsed.records)) {
          this.records = parsed.records.slice(-MAX_JOURNAL_RECORDS);
        }
      } catch {
        // Missing or unreadable journal: start empty rather than failing runs.
      }
    }
    if (this.preferencesPath) {
      try {
        const raw = await readFile(this.preferencesPath, "utf8");
        const parsed = JSON.parse(raw) as NotificationPreferencesFile;
        if (parsed?.schemaVersion === 1 && parsed.preferences) {
          this.preferences = sanitizePreferences(parsed.preferences);
        }
      } catch {
        // Defaults apply.
      }
    }
  }

  getPreferences(): NotificationPreferences {
    return this.preferences;
  }

  async updatePreferences(update: NotificationPreferencesUpdate): Promise<NotificationPreferences> {
    await this.ensureLoaded();
    const defaults = defaultNotificationPreferences();
    const quietHours = update.quietHours === null ? undefined : update.quietHours ?? this.preferences.quietHours;
    const merged = sanitizePreferences({
      ...this.preferences,
      ...update,
      quietHours,
      events: {
        automation_run_finished: update.events?.automation_run_finished ?? this.preferences.events.automation_run_finished ?? defaults.events.automation_run_finished,
        automation_run_failed: update.events?.automation_run_failed ?? this.preferences.events.automation_run_failed ?? defaults.events.automation_run_failed,
        approval_required: update.events?.approval_required ?? this.preferences.events.approval_required ?? defaults.events.approval_required,
      },
    });
    this.preferences = merged;
    if (this.preferencesPath) {
      try {
        await mkdir(dirname(this.preferencesPath), { recursive: true });
        await atomicWriteJson(this.preferencesPath, { schemaVersion: 1, preferences: merged });
      } catch {
        // In-memory only if persistence fails.
      }
    }
    return merged;
  }

  /**
   * Record a notification event. Delivery (as opposed to journaling) respects
   * global enabled flag, per-kind tone and quiet hours.
   */
  async emit(input: NotificationEmitInput): Promise<NotificationDelivery | null> {
    await this.ensureLoaded();
    const at = input.at ?? new Date();
    const record: NotificationRecord = {
      id: randomUUID(),
      kind: input.kind,
      title: input.title,
      body: input.body,
      createdAt: at.toISOString(),
      automationId: input.automationId,
      automationLabel: input.automationLabel,
      runId: input.runId,
      cwd: input.cwd,
    };
    this.records = [...this.records, record].slice(-MAX_JOURNAL_RECORDS);
    if (this.journalPath) {
      try {
        await mkdir(dirname(this.journalPath), { recursive: true });
        await atomicWriteJson(this.journalPath, { schemaVersion: JOURNAL_VERSION, records: this.records });
      } catch {
        // Journal write failures never break run completion.
      }
    }
    if (!this.preferences.globalEnabled) return { record, deliver: false };
    const tone: NotificationDeliveryTone | undefined = this.preferences.events[input.kind];
    if (!notificationMatchesTone(input.kind, tone)) return { record, deliver: false };
    if (isQuietHour(this.preferences, at)) return { record, deliver: false };
    return { record, deliver: true };
  }

  list(since?: string): { notifications: readonly NotificationRecord[]; nextSince: string } {
    const cursorIndex = since ? this.records.findIndex((record) => record.id === since) : -1;
    const notifications = cursorIndex >= 0 ? this.records.slice(cursorIndex + 1) : this.records.slice();
    return { notifications, nextSince: this.records.at(-1)?.id ?? "" };
  }

  size(): number {
    return this.records.length;
  }
}

function sanitizePreferences(input: NotificationPreferences): NotificationPreferences {
  const defaults = defaultNotificationPreferences();
  const tones: NotificationDeliveryTone[] = ["all", "failures", "off"];
  const readTone = (value: unknown, fallback: NotificationDeliveryTone): NotificationDeliveryTone =>
    typeof value === "string" && (tones as string[]).includes(value) ? value as NotificationDeliveryTone : fallback;
  const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/u;
  const quietHours = input.quietHours && typeof input.quietHours === "object"
    && timePattern.test(String(input.quietHours.start ?? ""))
    && timePattern.test(String(input.quietHours.end ?? ""))
    ? { start: String(input.quietHours.start), end: String(input.quietHours.end) }
    : undefined;
  return {
    schemaVersion: 1,
    globalEnabled: input.globalEnabled !== false,
    events: {
      automation_run_finished: readTone(input.events?.automation_run_finished, defaults.events.automation_run_finished),
      automation_run_failed: readTone(input.events?.automation_run_failed, defaults.events.automation_run_failed),
      approval_required: readTone(input.events?.approval_required, defaults.events.approval_required),
    },
    quietHours,
  };
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, path);
}
