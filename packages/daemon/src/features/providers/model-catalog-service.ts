import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import lockfile from "proper-lockfile";
import { bundledProviderModelCatalog, type ProviderModelCatalogSnapshot } from "@ling-stack/core";
import { MODEL_CATALOG_URL, normalizeModelCatalog } from "./model-catalog-normalize.js";

const MAX_BYTES = 16 * 1024 * 1024;
const REFRESH_MS = 24 * 60 * 60 * 1000;

export class ProviderModelCatalogService {
  private current: ProviderModelCatalogSnapshot = bundledProviderModelCatalog;
  private readonly snapshots = new Map<string, ProviderModelCatalogSnapshot>([[bundledProviderModelCatalog.manifest.version, bundledProviderModelCatalog]]);
  private loaded = false;
  private running?: Promise<void>;
  private lastAttempt = 0;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;
  private readonly abort = new AbortController();
  constructor(private readonly path: string, private readonly fetchCatalog: typeof fetch = fetch, private readonly enabled = true) {}

  snapshot(): ProviderModelCatalogSnapshot { return this.current; }
  snapshotForVersion(version?: string): ProviderModelCatalogSnapshot | undefined {
    return version ? this.snapshots.get(version) : this.current;
  }

  private install(snapshot: ProviderModelCatalogSnapshot): void {
    this.current = snapshot;
    this.snapshots.delete(snapshot.manifest.version);
    this.snapshots.set(snapshot.manifest.version, snapshot);
    while (this.snapshots.size > 4) this.snapshots.delete(this.snapshots.keys().next().value!);
  }

  start(): void {
    if (!this.enabled || this.stopped || this.timer) return;
    void this.refreshIfDue();
    this.timer = setInterval(() => { void this.refreshIfDue(); }, 60 * 60 * 1000);
    this.timer.unref();
  }

  async initialize(): Promise<void> {
    if (!this.enabled) return;
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.install(await this.readCache());
    } catch { /* Missing or invalid cache leaves the bundled snapshot available. */ }
  }

  refreshIfDue(force = false): Promise<void> {
    if (this.stopped || !this.enabled) return Promise.resolve();
    if (this.running) return this.running;
    if (!force && Date.now() - this.lastAttempt < 5 * 60 * 1000) return Promise.resolve();
    const fetchedAt = this.current === bundledProviderModelCatalog ? 0 : Date.parse(this.current.manifest.generatedAt);
    if (!force && Number.isFinite(fetchedAt) && Date.now() - fetchedAt < REFRESH_MS) return Promise.resolve();
    this.lastAttempt = Date.now();
    this.running = this.refresh().finally(() => { this.running = undefined; });
    return this.running;
  }

  async close(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.abort.abort();
    await this.running;
  }

  private async refresh(): Promise<void> {
    try {
      const fetchedAt = new Date().toISOString();
      const response = await this.fetchCatalog(MODEL_CATALOG_URL, {
        headers: { Accept: "application/json", "User-Agent": "ling-stack-model-catalog" },
        redirect: "error", signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(20_000)]),
      });
      if (!response.ok || !response.body) throw new Error("catalog_fetch_failed");
      const length = Number(response.headers.get("content-length"));
      if (Number.isFinite(length) && length > MAX_BYTES) throw new Error("catalog_too_large");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new Error("catalog_too_large");
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => undefined); }
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const snapshot = normalizeModelCatalog(payload, fetchedAt);
      if (snapshot.records.length < this.current.records.length / 2) throw new Error("catalog_incomplete");
      if (this.stopped) return;
      const persisted = await this.persist(payload, fetchedAt);
      if (!this.stopped && persisted) this.install(snapshot);
      else if (!this.stopped) this.install(await this.readCache());
    } catch { /* Keep the last valid snapshot and its original freshness. */ }
  }

  private async persist(payload: unknown, fetchedAt: string): Promise<boolean> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    let compromised = false;
    const release = await lockfile.lock(dirname(this.path), {
      lockfilePath: `${this.path}.lock`, realpath: false, stale: 30_000, update: 5_000,
      onCompromised: () => { compromised = true; },
    });
    const temp = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let created = false;
    try {
      try {
        const current = await this.readCache();
        if (Date.parse(current.manifest.generatedAt) >= Date.parse(fetchedAt)) return false;
      } catch { /* A missing or corrupt cache may be replaced. */ }
      const file = await open(temp, "wx", 0o600);
      created = true;
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, fetchedAt, payload })); } finally { await file.close(); }
      if (compromised) throw new Error("catalog_lock_compromised");
      await rename(temp, this.path);
      created = false;
      return true;
    } finally {
      if (created) await unlink(temp).catch(() => undefined);
      await release().catch(() => undefined);
    }
  }

  private async readCache(): Promise<ProviderModelCatalogSnapshot> {
    if ((await stat(this.path)).size > MAX_BYTES) throw new Error("catalog_cache_too_large");
    const text = await readFile(this.path, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("catalog_cache_too_large");
    const envelope: unknown = JSON.parse(text);
    if (!isRecord(envelope) || envelope.schemaVersion !== 1 || typeof envelope.fetchedAt !== "string"
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(envelope.fetchedAt)
      || !Number.isFinite(Date.parse(envelope.fetchedAt))
      || new Date(envelope.fetchedAt).toISOString() !== envelope.fetchedAt
      || Date.parse(envelope.fetchedAt) > Date.now() + 60_000) throw new Error("invalid_catalog_cache");
    return normalizeModelCatalog(envelope.payload, envelope.fetchedAt);
  }
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
