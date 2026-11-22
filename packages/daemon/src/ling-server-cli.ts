#!/usr/bin/env node

import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readLingServerConfiguration } from "./features/ling-server/configuration.js";
import { LingServerControlPlane, type LingServerControlPlaneOptions } from "./features/ling-server/control-plane.js";

try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Ling Server failed");
  process.exitCode = 1;
}

async function main(args: readonly string[]): Promise<void> {
  const [command, configPath, outputPath] = args;
  if (command === "--write-coturn-config" && args.length === 3 && configPath && outputPath) {
    const { coturnConfig } = readLingServerConfiguration(configPath);
    if (!coturnConfig) throw new Error("Configure transport.coturn before writing coturn configuration");
    writeCoturnConfig(outputPath, coturnConfig);
    console.log("Coturn configuration written to " + resolve(outputPath));
    return;
  }
  if (args.length === 1 && command && !command.startsWith("-")) {
    await start(readLingServerConfiguration(command).control);
    return;
  }
  console.log("Usage: ling-server <config.json>\n       ling-server --write-coturn-config <config.json> <output.conf>");
  process.exitCode = args.length === 1 && command === "--help" ? 0 : 1;
}

function writeCoturnConfig(path: string, content: string): void {
  const output = resolve(path);
  const temporary = mkdtempSync(join(dirname(output), ".ling-coturn-"));
  try {
    const staged = join(temporary, "turnserver.conf");
    writeFileSync(staged, content, { mode: 0o600, flush: true });
    linkSync(staged, output);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

async function start(config: LingServerControlPlaneOptions): Promise<void> {
  const server = new LingServerControlPlane(config);
  const address = await server.start();
  const host = address.host.includes(":") ? `[${address.host}]` : address.host;
  console.log(`Ling Server listening on ${config.tls ? "https" : "http"}://${host}:${address.port}`);
  const admin = server.adminAddress();
  if (admin) console.log(`Ling Server administration on http://${admin.host}:${admin.port}`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await server.stop();
    } catch {
      console.error("Ling Server shutdown failed");
      process.exitCode = 1;
    }
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
}
