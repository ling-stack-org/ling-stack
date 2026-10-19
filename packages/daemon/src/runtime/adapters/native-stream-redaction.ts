import { redactSecrets } from "@ling-stack/core";

export class NativeOutputError extends Error {
  constructor(readonly code: "invalid_event" | "capacity_exceeded" | "unsupported_item" | "empty_output") { super(code); }
}

/** One execution's secret lifetime, shared explicitly instead of cloned into native DTOs. */
export class NativeSecretRegistry {
  #secrets: readonly string[] = [];

  constructor(secrets: readonly string[] = []) { this.register(secrets); }

  register(secrets: readonly string[]): void {
    if (!Array.isArray(secrets) || secrets.length > 128) throw new NativeOutputError("capacity_exceeded");
    const added = Array.from(secrets);
    if (added.some(secret => typeof secret !== "string" || !secret.length || secret.length > 8192)) {
      throw new NativeOutputError("capacity_exceeded");
    }
    const next = [...new Set([...this.#secrets, ...added])];
    if (next.length > 128 || next.reduce((sum, secret) => sum + Buffer.byteLength(secret, "utf8"), 0) > 1024 * 1024) {
      throw new NativeOutputError("capacity_exceeded");
    }
    this.#secrets = Object.freeze(next);
  }

  getSnapshot(): readonly string[] { return this.#secrets; }
}

export type NativeOutputSecrets = readonly string[] | NativeSecretRegistry;

export function redactNativeOutput<T>(value: T, secrets: NativeOutputSecrets = []): T {
  const snapshot = secrets instanceof NativeSecretRegistry ? secrets.getSnapshot() : secrets;
  return redactSecrets(redactSecrets(value, snapshot), snapshot) as T;
}

/** Retains unfinished secret/token prefixes so no sensitive fragment is emitted early. */
export class NativeStreamRedactor {
  readonly #secrets: NativeOutputSecrets;
  #pending = "";
  #bytes = 0;
  #finished = false;

  constructor(secrets: NativeOutputSecrets, readonly maxBytes = 4 * 1024 * 1024) {
    const snapshot = secrets instanceof NativeSecretRegistry ? secrets.getSnapshot() : secrets;
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 2 ** 30
      || !Array.isArray(snapshot) || snapshot.length > 128
      || snapshot.some(secret => typeof secret !== "string" || secret.length > 8192)) {
      throw new NativeOutputError("capacity_exceeded");
    }
    this.#secrets = secrets instanceof NativeSecretRegistry ? secrets : [...new Set(snapshot.filter(Boolean))];
  }

  push(text: string): string {
    if (this.#finished || typeof text !== "string") throw new NativeOutputError("invalid_event");
    const bytes = this.#bytes + Buffer.byteLength(text, "utf8");
    if (bytes > this.maxBytes) throw new NativeOutputError("capacity_exceeded");
    this.#bytes = bytes;
    const secrets = this.#secrets instanceof NativeSecretRegistry ? this.#secrets.getSnapshot() : this.#secrets;
    const pending = this.#pending + text;
    let cut = pending.length;
    const token = /[A-Za-z0-9._~+/=-]+$/.exec(pending);
    const auth = /\b(?:Bearer|Basic)(?:\s+[A-Za-z0-9._~+/=-]*)?\s*$/i.exec(pending);
    if (token) cut = Math.min(cut, token.index);
    if (auth) cut = Math.min(cut, auth.index);
    if (/[\uD800-\uDBFF]$/.test(pending)) cut = Math.min(cut, pending.length - 1);
    for (const secret of secrets) {
      for (let length = Math.min(secret.length - 1, pending.length); length > 0; length--) {
        if (pending.endsWith(secret.slice(0, length))) { cut = Math.min(cut, pending.length - length); break; }
      }
    }
    // A complete multiword secret can straddle a cut chosen for another unfinished token.
    let previous;
    do {
      previous = cut;
      for (const secret of secrets) {
        for (let start = pending.indexOf(secret); start >= 0 && start < cut; start = pending.indexOf(secret, start + 1)) {
          if (start + secret.length > cut) { cut = start; break; }
        }
      }
      for (const pattern of [/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, /\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g]) {
        for (const match of pending.matchAll(pattern)) {
          if (match.index < cut && match.index + match[0].length > cut) cut = match.index;
        }
      }
    } while (cut !== previous);
    const emitted = redactNativeOutput(pending.slice(0, cut), secrets);
    this.#pending = pending.slice(cut);
    return emitted;
  }

  finish(): string {
    if (this.#finished) throw new NativeOutputError("invalid_event");
    this.#finished = true;
    const text = redactNativeOutput(this.#pending, this.#secrets);
    this.#pending = "";
    return text;
  }
}
