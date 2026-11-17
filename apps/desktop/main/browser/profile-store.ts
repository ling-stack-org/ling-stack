import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserRecord, DESKTOP_BROWSER_MAX_TABS, parseDesktopBrowserScope, parseDesktopBrowserUrl, type DesktopBrowserScope } from "@ling-stack/contracts";
import type { DesktopBrowserPreferences } from "../../shared/browser-capabilities.js";

export const defaultBrowserPreferences: DesktopBrowserPreferences = { websiteLinks: "in_app", localhostLinks: "in_app", restoreTabs: true };

export interface BrowserProfileMetadata {
  readonly version: 1;
  readonly workspaceCwd: string;
  readonly preferences: DesktopBrowserPreferences;
  readonly tabs: readonly { readonly scope: DesktopBrowserScope; readonly url: string; readonly active: boolean }[];
}

export function parseBrowserPreferences(value: unknown): DesktopBrowserPreferences {
  const record = browserRecord(value, ["websiteLinks", "localhostLinks", "restoreTabs"]);
  if (!["in_app", "system"].includes(String(record.websiteLinks)) || !["in_app", "system"].includes(String(record.localhostLinks))
    || typeof record.restoreTabs !== "boolean") throw new Error("browser_preferences_invalid");
  return { websiteLinks: record.websiteLinks as DesktopBrowserPreferences["websiteLinks"], localhostLinks: record.localhostLinks as DesktopBrowserPreferences["localhostLinks"], restoreTabs: record.restoreTabs };
}

export function parseBrowserProfileMetadata(value: unknown, workspaceCwd: string): BrowserProfileMetadata {
  const record = browserRecord(value, ["version", "workspaceCwd", "preferences", "tabs"]);
  if (record.version !== 1 || record.workspaceCwd !== workspaceCwd || !Array.isArray(record.tabs) || record.tabs.length > DESKTOP_BROWSER_MAX_TABS) throw new Error("browser_profile_invalid");
  return { version: 1, workspaceCwd, preferences: parseBrowserPreferences(record.preferences), tabs: record.tabs.map(value => {
    const tab = browserRecord(value, ["scope", "url", "active"]);
    if (typeof tab.active !== "boolean") throw new Error("browser_profile_invalid");
    return { scope: parseDesktopBrowserScope(tab.scope), url: parseDesktopBrowserUrl(tab.url), active: tab.active };
  }) };
}

/** Stores native tab restoration metadata without document state or automation authority. */
export class BrowserProfileStore {
  private lastSaved?: string;
  private readonly path?: string;
  constructor(readonly workspaceCwd: string, private readonly directory?: string) {
    if (directory) this.path = join(directory, `${createHash("sha256").update(workspaceCwd).digest("hex")}.json`);
  }

  read(): BrowserProfileMetadata {
    if (this.path) {
      try {
        const stat = lstatSync(this.path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024) throw new Error("browser_profile_file_invalid");
        const metadata = parseBrowserProfileMetadata(JSON.parse(readFileSync(this.path, "utf8")), this.workspaceCwd);
        this.lastSaved = JSON.stringify(metadata);
        return metadata;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw new Error("browser_profile_unreadable", { cause: error });
      }
    }
    return { version: 1, workspaceCwd: this.workspaceCwd, preferences: { ...defaultBrowserPreferences }, tabs: [] };
  }

  write(value: BrowserProfileMetadata): void {
    const encoded = JSON.stringify(parseBrowserProfileMetadata(value, this.workspaceCwd));
    if (!this.path || !this.directory || encoded === this.lastSaved) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, encoded, { encoding: "utf8", mode: 0o600, flag: "wx" });
      renameSync(temporary, this.path); this.lastSaved = encoded;
    } finally {
      try { unlinkSync(temporary); } catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error; }
    }
  }
}
