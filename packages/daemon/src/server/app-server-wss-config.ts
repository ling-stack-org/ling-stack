import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

export interface AppServerWssConfig {
  readonly host: string;
  readonly port: number;
  readonly certificateFile: string;
  readonly privateKeyFile: string;
  readonly allowedHosts: readonly string[];
  readonly allowedOrigins?: readonly string[];
}

export function resolveAppServerWssConfig(configured: AppServerWssConfig | undefined): AppServerWssConfig | undefined {
  const configPath = process.env.LING_STACK_APP_SERVER_WSS_CONFIG;
  let config = configured;
  if (config === undefined && configPath) {
    try { config = JSON.parse(readFileSync(configPath, "utf8")); }
    catch { throw new Error("The App Server WSS configuration file must contain valid JSON."); }
  }
  if (config === undefined) return undefined;
  if (!config || typeof config.host !== "string" || !config.host.trim()
    || !Number.isInteger(config.port) || config.port < 0 || config.port > 65535
    || typeof config.certificateFile !== "string" || !isAbsolute(config.certificateFile)
    || typeof config.privateKeyFile !== "string" || !isAbsolute(config.privateKeyFile)
    || !Array.isArray(config.allowedHosts) || !config.allowedHosts.length || config.allowedHosts.length > 32
    || config.allowedHosts.some(host => typeof host !== "string" || !isHostName(host))
    || config.allowedOrigins !== undefined && (!Array.isArray(config.allowedOrigins) || config.allowedOrigins.length > 32
      || config.allowedOrigins.some(origin => typeof origin !== "string" || !isHttpsOrigin(origin)))) {
    throw new Error("App Server WSS requires a bind address, port, TLS files and allowed hosts.");
  }
  return { ...config, allowedHosts: config.allowedHosts.map(host => host.toLowerCase()), allowedOrigins: config.allowedOrigins ?? [] };
}

function isHostName(host: string): boolean {
  try { return host.length <= 253 && new URL(`https://${host}`).hostname === host.toLowerCase(); }
  catch { return false; }
}

function isHttpsOrigin(origin: string): boolean {
  try { return new URL(origin).protocol === "https:" && new URL(origin).origin === origin; }
  catch { return false; }
}
