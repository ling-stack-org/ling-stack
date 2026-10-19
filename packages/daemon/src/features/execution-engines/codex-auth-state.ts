import { join } from "node:path";
import { EngineCredentialError } from "./native-secrets.js";
import { readNativeAuthFile } from "./native-auth-file.js";

/** Pinned Codex FileAuthStorage format; probes never mutate or import native auth. */
export async function assertCodexApiKey(home: string, expectedKey: string): Promise<void> {
  try {
    const value: unknown = JSON.parse(await readNativeAuthFile(join(home, "auth.json")));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new EngineCredentialError("engine_native_auth_invalid");
    const auth = value as Record<string, unknown>;
    if ((auth.auth_mode != null && auth.auth_mode !== "apikey") || typeof auth.OPENAI_API_KEY !== "string") {
      throw new EngineCredentialError("engine_native_auth_invalid");
    }
    if (auth.OPENAI_API_KEY !== expectedKey) throw new EngineCredentialError("engine_secret_changed");
  } catch (error) {
    if (error instanceof EngineCredentialError) throw error;
    throw new EngineCredentialError("engine_native_auth_invalid");
  }
}
