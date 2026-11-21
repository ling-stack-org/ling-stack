#!/usr/bin/env node

import { readLingServerConfiguration } from "./features/ling-server/configuration.js";
import { LingServerControlPlane } from "./features/ling-server/control-plane.js";

const [configPath, ...extra] = process.argv.slice(2);
if (!configPath || extra.length > 0 || configPath === "--help") {
  console.log("Usage: ling-server <config.json>");
  process.exitCode = configPath === "--help" ? 0 : 1;
} else {
  try {
    const config = readLingServerConfiguration(configPath);
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
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Ling Server failed to start");
    process.exitCode = 1;
  }
}
