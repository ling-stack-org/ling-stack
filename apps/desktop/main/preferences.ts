import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type {
  ComputerUsePipCorner,
  ComputerUsePipNormalizedPlacement,
} from "../shared/desktop-capabilities.js";

export interface DesktopPreferences {
  readonly schemaVersion: 1;
  readonly previewAutoShow: boolean;
  readonly hiddenSessionSuppressions: Readonly<Record<string, string>>;
  readonly previewPreferredCorner?: ComputerUsePipCorner;
  readonly previewDisplayPlacements?: Readonly<Record<string, ComputerUsePipNormalizedPlacement>>;
  readonly previewBounds?: {
    readonly displayId?: string;
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

const DEFAULT_PREFERENCES: DesktopPreferences = {
  schemaVersion: 1,
  previewAutoShow: true,
  hiddenSessionSuppressions: {},
};

export class DesktopPreferenceStore {
  private saveQueue: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async load(): Promise<DesktopPreferences> {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
      return sanitizePreferences(value, this.now());
    } catch (error) {
      if (isMissingFile(error)) {
        return DEFAULT_PREFERENCES;
      }
      return DEFAULT_PREFERENCES;
    }
  }

  async save(preferences: DesktopPreferences): Promise<void> {
    const sanitized = sanitizePreferences(preferences, this.now());
    const operation = this.saveQueue.then(() => this.writePreferences(sanitized));
    this.saveQueue = operation.catch(() => undefined);
    return operation;
  }

  private async writePreferences(preferences: DesktopPreferences): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporaryPath, "wx", 0o600);
      try {
        await file.writeFile(`${JSON.stringify(preferences, null, 2)}\n`, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporaryPath, this.filePath);
      if (process.platform !== "win32") {
        const directory = await open(dirname(this.filePath), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      }
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  }
}

export function sanitizePreferences(value: unknown, now = new Date()): DesktopPreferences {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    return DEFAULT_PREFERENCES;
  }
  const hiddenSessionSuppressions = isRecord(value.hiddenSessionSuppressions)
    ? Object.fromEntries(
        Object.entries(value.hiddenSessionSuppressions).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string" && Date.parse(entry[1]) > now.getTime(),
        ),
      )
    : {};
  const previewBounds = readBounds(value.previewBounds);
  const previewPreferredCorner = readCorner(value.previewPreferredCorner);
  const previewDisplayPlacements = readDisplayPlacements(value.previewDisplayPlacements);
  return {
    schemaVersion: 1,
    previewAutoShow: value.previewAutoShow !== false,
    hiddenSessionSuppressions,
    ...(previewPreferredCorner ? { previewPreferredCorner } : {}),
    ...(previewDisplayPlacements ? { previewDisplayPlacements } : {}),
    ...(previewBounds ? { previewBounds } : {}),
  };
}

function readCorner(value: unknown): ComputerUsePipCorner | undefined {
  return value === "top-left" || value === "top-right" || value === "bottom-left" || value === "bottom-right"
    ? value
    : undefined;
}

function readDisplayPlacements(
  value: unknown,
): Readonly<Record<string, ComputerUsePipNormalizedPlacement>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const placements = Object.entries(value).flatMap(([displayId, placement]) => {
    const parsed = readDisplayPlacement(displayId, placement);
    return parsed ? [[displayId, parsed] as const] : [];
  });
  return placements.length > 0 ? Object.fromEntries(placements) : undefined;
}

function readDisplayPlacement(
  displayId: string,
  value: unknown,
): ComputerUsePipNormalizedPlacement | undefined {
  if (!displayId.trim() || !isRecord(value) || value.displayId !== displayId || !isRect(value.sourceWorkArea)) {
    return undefined;
  }
  if (
    typeof value.normalizedX !== "number" || !Number.isFinite(value.normalizedX) || value.normalizedX < 0 || value.normalizedX > 1 ||
    typeof value.normalizedY !== "number" || !Number.isFinite(value.normalizedY) || value.normalizedY < 0 || value.normalizedY > 1 ||
    typeof value.width !== "number" || !Number.isFinite(value.width) || value.width < 240 ||
    typeof value.height !== "number" || !Number.isFinite(value.height) || value.height < 150
  ) {
    return undefined;
  }
  return {
    displayId,
    normalizedX: value.normalizedX,
    normalizedY: value.normalizedY,
    width: value.width,
    height: value.height,
    sourceWorkArea: value.sourceWorkArea,
  };
}

function readBounds(value: unknown): DesktopPreferences["previewBounds"] {
  if (!isRecord(value)) {
    return undefined;
  }
  const numbers = [value.x, value.y, value.width, value.height];
  if (!numbers.every((item) => typeof item === "number" && Number.isFinite(item))) {
    return undefined;
  }
  if ((value.width as number) < 240 || (value.height as number) < 160) {
    return undefined;
  }
  return {
    ...(typeof value.displayId === "string" ? { displayId: value.displayId } : {}),
    x: value.x as number,
    y: value.y as number,
    width: value.width as number,
    height: value.height as number,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRect(value: unknown): value is ComputerUsePipNormalizedPlacement["sourceWorkArea"] {
  return isRecord(value) &&
    [value.x, value.y, value.width, value.height].every((item) => typeof item === "number" && Number.isFinite(item)) &&
    typeof value.width === "number" && value.width > 0 &&
    typeof value.height === "number" && value.height > 0;
}

function isMissingFile(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}
