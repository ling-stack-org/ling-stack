import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parse, stringify } from "smol-toml";
import type { KimiApiKeyConfiguration } from "@ling-stack/contracts";
import { readNativeAuthFile } from "./native-auth-file.js";
import { EngineCredentialError } from "./native-secrets.js";

/** Called only for a newly owned auth generation, never to repair a saved account. */
export async function writeKimiApiKey(home: string, configuration: KimiApiKeyConfiguration, apiKey: string): Promise<void> {
  await writeFile(join(home, "config.toml"), stringify(nativeConfiguration(configuration, apiKey)), { mode: 0o600, flag: "wx" });
  await assertKimiApiKey(home, configuration, apiKey);
}

export async function assertKimiApiKey(home: string, configuration: KimiApiKeyConfiguration, expectedKey: string): Promise<void> {
  try {
    const value = parse(await readNativeAuthFile(join(home, "config.toml")));
    // smol-toml tables have null prototypes. Compare two TOML values so exact
    // content checks do not confuse the parser's representation with key drift.
    const expected = parse(stringify(nativeConfiguration(configuration, expectedKey)));
    if (!isDeepStrictEqual(value, expected)) {
      throw new EngineCredentialError("engine_native_auth_mismatch");
    }
  } catch (error) {
    if (error instanceof EngineCredentialError) throw error;
    throw new EngineCredentialError("engine_native_auth_invalid");
  }
}

function nativeConfiguration(configuration: KimiApiKeyConfiguration, apiKey: string): Record<string, unknown> {
  return {
    default_model: "ling-default", default_permission_mode: "manual", telemetry: false, merge_all_available_skills: false,
    providers: { ling: { type: configuration.providerType, base_url: configuration.baseUrl, api_key: apiKey } },
    models: { "ling-default": { provider: "ling", model: configuration.modelId, max_context_size: configuration.maxContextSize } },
  };
}
