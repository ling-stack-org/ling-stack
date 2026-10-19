import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync, type Stats } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import type { ExecutionEngineProfile } from "@ling-stack/contracts";
import type { ExecutionEngineProfileStore } from "@ling-stack/core";
import { readNativeAuthFile } from "../../features/execution-engines/native-auth-file.js";

interface OAuthToken {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: number;
  readonly expires_in: number;
  readonly scope: string;
  readonly token_type: string;
}
interface CredentialSnapshot { readonly value: OAuthToken; readonly info: Stats }
interface DirectoryIdentity { readonly path: string; readonly info: Stats }
export interface KimiOAuthCredentialOptions {
  readonly home: string;
  readonly store: ExecutionEngineProfileStore;
  readonly profile: ExecutionEngineProfile;
  readonly region: "mainland-cn" | "global";
  readonly oauth: { readonly storage: "file"; readonly key: string; readonly oauth_host?: string };
  readonly assertCurrent: () => void;
  /** Register both old and rotated secrets synchronously before returning or persisting them. */
  readonly onSecrets: (secrets: readonly string[]) => void;
  readonly fetchImpl?: typeof fetch;
}
const failure = (code: string): Error => new Error(`kimi_oauth_${code}`);
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const tokenText = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\x00-\x20\x7f]/.test(value);
const clientId = "17e5f671-d194-4dfb-9706-5516cb48c098";

/** Host-only native credential ownership. This never logs in, adopts another slot, or sends a model prompt. */
export function createKimiOAuthCredentialSource(options: KimiOAuthCredentialOptions) {
  const store = options.store, profile = structuredClone(options.profile);
  try {
    if (profile?.configuration.engineId !== "kimi-acp" || profile.configuration.secretRef
      || profile.configuration.kimiLoginRegion !== options.region) throw failure("configuration_invalid");
    if (options.home !== store.getAuthProfileDirectory(profile)) throw failure("configuration_invalid");
  } catch { throw failure("configuration_invalid"); }
  const host = options.region === "mainland-cn" ? "https://auth.kimi.com" : options.region === "global" ? "https://auth.kimi.ai" : undefined;
  const key = options.oauth?.key;
  const name = typeof key === "string" ? key.replace(/^oauth\//, "") : "";
  if (!host || options.oauth?.storage !== "file" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(name)
    || (options.oauth.oauth_host !== undefined && options.oauth.oauth_host.replace(/\/$/, "") !== host)) throw failure("configuration_invalid");
  const home = directory(options.home), credentials = directory(join(home.path, "credentials"));
  const path = join(credentials.path, `${name}.json`);
  const fetchImpl = options.fetchImpl ?? fetch;

  async function resolve(requestSignal: AbortSignal): Promise<string> {
    const deadline = performance.now() + 15_000;
    const compromised = new AbortController();
    const signal = AbortSignal.any([requestSignal, AbortSignal.timeout(15_000), compromised.signal]);
    let release: (() => Promise<void>) | undefined;
    const assertActive = (): void => {
      signal.throwIfAborted();
      // SQLite lock waits can prevent the abort timer from firing before publication.
      if (performance.now() >= deadline) throw failure("refresh_failed");
    };
    const assertCurrent = (): void => {
      assertActive();
      assertDirectory(home); assertDirectory(credentials);
      try { store.assertCurrentAuthProfile(profile); options.assertCurrent(); } catch { throw failure("configuration_invalid"); }
      assertActive();
    };
    try {
      assertCurrent();
      const lockPath = join(home.path, "oauth");
      try { await mkdir(lockPath, { mode: 0o700 }); }
      catch (error) { if (!record(error) || error.code !== "EEXIST") throw failure("configuration_invalid"); }
      assertCurrent();
      const lockDirectory = directory(lockPath);
      const check = (): void => { assertCurrent(); assertDirectory(lockDirectory); };
      // Use the official slot's .lock directory on every platform; never opt out through ambient env.
      while (!release) {
        check();
        try {
          release = await lockfile.lock(join(lockPath, name), { realpath: false, stale: 5000, update: 1000,
            retries: 0, onCompromised: () => compromised.abort() });
        } catch (error) {
          if (!record(error) || error.code !== "ELOCKED") throw failure("configuration_invalid");
          await delay(25, undefined, { signal });
        }
      }
      check();
      const before = await readSlot(path);
      check();
      if (before.value.access_token) options.onSecrets([before.value.access_token, before.value.refresh_token]);
      check();
      if (!before.value.access_token || !before.value.refresh_token) throw failure("login_required");
      if (before.value.expires_at - Date.now() / 1000 > Math.max(300, before.value.expires_in * 0.5)) {
        return before.value.access_token;
      }
      const next = await refresh(before.value, `${host}/api/oauth/token`, fetchImpl, signal);
      check();
      // Reject observed slot replacement; final commit also needs exclusive host lifecycle ownership.
      const current = await readSlot(path);
      check();
      if (!sameFile(before.info, current.info)) throw failure("credentials_changed");
      const replacement = next ?? { ...before.value, access_token: "", refresh_token: "", expires_at: 0, expires_in: 0 };
      if (next) options.onSecrets([next.access_token, next.refresh_token]);
      await replaceSlot(path, before, replacement, check, publish => store.commitAuthRefresh(profile, publish), assertActive);
      check();
      if (!next) throw failure("login_required");
      return next.access_token;
    } catch (error) {
      if (requestSignal.aborted) throw failure("cancelled");
      if (error instanceof Error && /^kimi_oauth_(configuration_invalid|login_required|credentials_changed|refresh_failed)$/.test(error.message)) throw error;
      throw failure(signal.aborted ? "refresh_failed" : "configuration_invalid");
    } finally {
      if (release) {
        try { await release(); }
        catch { if (!compromised.signal.aborted) throw failure("configuration_invalid"); }
      }
    }
  }
  return { resolve };
}

async function refresh(previous: OAuthToken, endpoint: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<OAuthToken | undefined> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal.throwIfAborted();
      let response: Response;
      try {
        response = await fetchImpl(endpoint, { method: "POST", redirect: "error", signal,
          headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
          body: new URLSearchParams({ client_id: clientId, grant_type: "refresh_token", refresh_token: previous.refresh_token }).toString() });
      } catch {
        signal.throwIfAborted();
        if (attempt === 2) throw failure("refresh_failed");
        await delay(100 * 2 ** attempt, undefined, { signal });
        continue;
      }
      signal.throwIfAborted();
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); return undefined; }
      if (response.status === 429 || response.status >= 500) {
        await response.body?.cancel();
        if (attempt < 2) { await delay(100 * 2 ** attempt, undefined, { signal }); continue; }
        throw failure("refresh_failed");
      }
      const value = await boundedJson(response, signal);
      if (!response.ok) {
        if (record(value) && value.error === "invalid_grant") return undefined;
        throw failure("refresh_failed");
      }
      if (!record(value) || !tokenText(value.access_token) || !tokenText(value.refresh_token)
        || typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in) || value.expires_in <= 0
        || value.expires_in > Number.MAX_SAFE_INTEGER - Math.floor(Date.now() / 1000)) throw failure("refresh_failed");
      const scope = value.scope ?? previous.scope, type = value.token_type ?? previous.token_type;
      if (typeof scope !== "string" || scope.length > 8192 || /[\x00-\x1f\x7f]/.test(scope)
        || typeof type !== "string" || type.toLowerCase() !== "bearer") throw failure("refresh_failed");
      return { access_token: value.access_token, refresh_token: value.refresh_token,
        expires_at: Math.floor(Date.now() / 1000) + value.expires_in, expires_in: value.expires_in, scope, token_type: type };
    }
  } catch { throw failure("refresh_failed"); }
  throw failure("refresh_failed");
}

async function boundedJson(response: Response, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") || !response.body) {
    await response.body?.cancel(); throw failure("refresh_failed");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      signal.throwIfAborted();
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 64 * 1024) throw failure("refresh_failed");
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  } finally { await reader.cancel(); reader.releaseLock(); }
}

async function readSlot(path: string): Promise<CredentialSnapshot> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.nlink !== 1 || realpathSync(path) !== path) throw failure("configuration_invalid");
    const value: unknown = JSON.parse(await readNativeAuthFile(path));
    if (!sameFile(info, await lstat(path)) || !record(value)) throw failure("configuration_invalid");
    const revoked = value.access_token === "" && value.refresh_token === "" && value.expires_at === 0 && value.expires_in === 0;
    if ((!revoked && (!tokenText(value.access_token) || !tokenText(value.refresh_token)))
      || typeof value.expires_at !== "number" || !Number.isSafeInteger(value.expires_at) || value.expires_at < 0
      || typeof value.expires_in !== "number" || !Number.isSafeInteger(value.expires_in) || value.expires_in < (revoked ? 0 : 1)
      || typeof value.scope !== "string" || value.scope.length > 8192 || /[\x00-\x1f\x7f]/.test(value.scope)
      || typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") throw failure("configuration_invalid");
    return { value: value as unknown as OAuthToken, info };
  } catch (error) {
    if (record(error) && (error.code === "ENOENT" || error.code === "engine_native_auth_missing")) throw failure("login_required");
    throw failure("configuration_invalid");
  }
}

async function replaceSlot(path: string, before: CredentialSnapshot, next: OAuthToken, check: () => void,
  commit: (publish: () => void) => void, assertActive: () => void): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  let file;
  try {
    check();
    file = await open(temporary, "wx", 0o600);
    await file.writeFile(`${JSON.stringify(next)}\n`, "utf8");
    await file.sync();
    const written = await file.stat();
    await file.close(); file = undefined;
    commit(() => {
      check();
      const current = lstatSync(path);
      if (!sameFile(before.info, current)) throw failure("credentials_changed");
      if (!sameFile(written, lstatSync(temporary))) throw failure("configuration_invalid");
      // Serializes Ling profile mutations; native/external writers still need lifecycle ownership.
      assertActive();
      renameSync(temporary, path);
    });
  } finally {
    await file?.close();
    await rm(temporary, { force: true });
  }
}
function directory(path: string): DirectoryIdentity {
  try {
    const info = lstatSync(path);
    if (!info.isDirectory() || realpathSync(path) !== path) throw failure("configuration_invalid");
    return { path, info };
  } catch { throw failure("configuration_invalid"); }
}
function assertDirectory(before: DirectoryIdentity): void {
  const next = directory(before.path);
  if (next.info.dev !== before.info.dev || next.info.ino !== before.info.ino) throw failure("configuration_invalid");
}
function sameFile(before: Stats, next: Stats): boolean {
  return next.isFile() && next.nlink === 1 && next.dev === before.dev && next.ino === before.ino
    && next.size === before.size && next.mtimeMs === before.mtimeMs && next.ctimeMs === before.ctimeMs;
}
