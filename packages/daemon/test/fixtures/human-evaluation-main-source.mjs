import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Bundle the actual Main source and its read-validation leaf, not old Desktop dist.
// The bundle stays in memory; neither Electron nor native authentication is invoked.
const requireDesktop = createRequire(new URL("../../../../apps/desktop/package.json", import.meta.url));
const { buildSync } = requireDesktop("esbuild");
const bundle = buildSync({ entryPoints: [fileURLToPath(new URL("../../../../apps/desktop/main/human-evaluation/daemon-client.ts", import.meta.url))],
  bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent" });
const source = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`);
export const { createHumanEvaluationDaemonClient, signHumanEvaluationConfirmation } = source;
