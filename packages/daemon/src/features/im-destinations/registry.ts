import { randomUUID } from "node:crypto";
import { createHmac } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  buildImPayload,
  isAllowedImWebhookUrl,
  type DestinationDispatchResult,
  type DestinationMessage,
  type ImDestination,
  type ImDestinationProvider,
} from "@ling-stack/contracts";
import type { SecretResolver } from "@ling-stack/core";

const STORE_VERSION = 1;

interface ImDestinationsFile {
  readonly schemaVersion: 1;
  readonly destinations: readonly ImDestination[];
}

export interface CreateImDestinationInput {
  readonly label: string;
  readonly provider: ImDestinationProvider;
  readonly webhookRef: string;
  readonly secretRef?: string;
  readonly enabled?: boolean;
}

type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;

/**
 * File-backed IM destination registry + dispatcher. Webhook URLs are resolved
 * through the secret resolver (env:/keychain: refs) and validated against the
 * per-provider egress allowlist before any request leaves the daemon.
 */
export class ImDestinationRegistry {
  private readonly storePath: string | null;
  private readonly secretResolver: SecretResolver | undefined;
  private readonly fetchImpl: FetchLike;
  private destinations: ImDestination[] = [];
  private loaded = false;
  private loadPromise: Promise<void> | null = null;

  constructor(paths: { storePath?: string | null; secretResolver?: SecretResolver; fetchImpl?: FetchLike } = {}) {
    this.storePath = paths.storePath ?? null;
    this.secretResolver = paths.secretResolver;
    this.fetchImpl = paths.fetchImpl ?? (globalThis.fetch as FetchLike);
  }

  async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    // A delayed cold read must not overwrite mutations made by another caller.
    this.loadPromise ??= this.load();
    await this.loadPromise;
    this.loaded = true;
  }

  private async load(): Promise<void> {
    if (this.storePath) {
      try {
        const parsed = JSON.parse(await readFile(this.storePath, "utf8")) as ImDestinationsFile;
        if (parsed?.schemaVersion === STORE_VERSION && Array.isArray(parsed.destinations)) {
          this.destinations = parsed.destinations;
        }
      } catch {
        // Missing store: start empty.
      }
    }
  }

  list(): readonly ImDestination[] {
    return this.destinations;
  }

  async create(input: CreateImDestinationInput): Promise<ImDestination> {
    await this.ensureLoaded();
    if (input.label.trim().length === 0) throw new Error("Destination label is required.");
    if (!input.webhookRef.startsWith("env:") && !input.webhookRef.startsWith("keychain:")) {
      throw new Error("webhookRef must use env:NAME or keychain:NAME (raw webhook URLs are never stored).");
    }
    if (input.secretRef && !input.secretRef.startsWith("env:") && !input.secretRef.startsWith("keychain:")) {
      throw new Error("secretRef must use env:NAME or keychain:NAME.");
    }
    const now = new Date().toISOString();
    const destination: ImDestination = {
      id: `im_${randomUUID().slice(0, 12)}`,
      label: input.label.trim(),
      provider: input.provider,
      webhookRef: input.webhookRef,
      secretRef: input.secretRef,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
    };
    this.destinations = [...this.destinations, destination];
    await this.persist();
    return destination;
  }

  async remove(id: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.destinations.length;
    this.destinations = this.destinations.filter((destination) => destination.id !== id);
    if (this.destinations.length === before) return false;
    await this.persist();
    return true;
  }

  async setEnabled(id: string, enabled: boolean): Promise<ImDestination | undefined> {
    await this.ensureLoaded();
    const destination = this.destinations.find((item) => item.id === id);
    if (!destination) return undefined;
    const updated: ImDestination = { ...destination, enabled, updatedAt: new Date().toISOString() };
    this.destinations = this.destinations.map((item) => (item.id === id ? updated : item));
    await this.persist();
    return updated;
  }

  /**
   * Deliver a message to one destination. Egress-pinned, signed when a secret
   * ref is configured (DingTalk sign), and failures are returned — never thrown.
   */
  async dispatch(destination: ImDestination, message: DestinationMessage): Promise<DestinationDispatchResult> {
    try {
      await this.ensureLoaded();
      const resolved = this.secretResolver?.resolve(destination.webhookRef, "webhook_secret");
      const webhookUrl = resolved?.value;
      if (!webhookUrl) {
        return { ok: false, error: "Webhook secret ref is not configured." };
      }
      if (!isAllowedImWebhookUrl(destination.provider, webhookUrl)) {
        return { ok: false, error: "Webhook host is outside the provider allowlist." };
      }
      const url = await this.signedUrl(destination, webhookUrl);
      const payload = buildImPayload(destination.provider, message);
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { "content-type": payload.contentType },
        body: payload.body,
      });
      return { ok: response.ok, status: response.status, error: response.ok ? undefined : `Webhook responded ${response.status}` };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  private async signedUrl(destination: ImDestination, webhookUrl: string): Promise<string> {
    if (!destination.secretRef) return webhookUrl;
    const secret = this.secretResolver?.resolve(destination.secretRef, "webhook_secret")?.value;
    if (!secret) return webhookUrl;
    const timestamp = Date.now();
    if (destination.provider === "dingtalk") {
      const stringToSign = `${timestamp}\n${secret}`;
      const sign = createHmac("sha256", secret).update(stringToSign).digest("base64");
      const url = new URL(webhookUrl);
      url.searchParams.set("timestamp", String(timestamp));
      url.searchParams.set("sign", encodeURIComponent(sign));
      return url.toString();
    }
    // Feishu custom-bot sign: timestamp + "\n" + secret as HMAC-SHA256 key.
    const sign = createHmac("sha256", `${timestamp}\n${secret}`).update("").digest("base64");
    const payload = { timestamp: String(Math.floor(timestamp / 1000)), sign };
    const url = new URL(webhookUrl);
    url.searchParams.set("timestamp", payload.timestamp);
    url.searchParams.set("sign", payload.sign);
    return url.toString();
  }

  private async persist(): Promise<void> {
    if (!this.storePath) return;
    try {
      await mkdir(dirname(this.storePath), { recursive: true });
      const tmp = `${this.storePath}.${randomUUID()}.tmp`;
      await writeFile(tmp, JSON.stringify({ schemaVersion: STORE_VERSION, destinations: this.destinations }), "utf8");
      await rename(tmp, this.storePath);
    } catch {
      // In-memory only when persistence fails.
    }
  }
}
