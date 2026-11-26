import {
  OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY,
  OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY,
} from "../../packages/core/dist/official-plugin-runtime.js";
import { requireOfficialSigningKey } from "./official-signing-key.mjs";

requireOfficialSigningKey(process.env.LING_PLUGIN_ARTIFACT_PRIVATE_KEY,
  OFFICIAL_PLUGIN_ARTIFACT_PUBLIC_KEY, "LING_PLUGIN_ARTIFACT_PRIVATE_KEY");
requireOfficialSigningKey(process.env.LING_PLUGIN_CATALOG_PRIVATE_KEY,
  OFFICIAL_PLUGIN_CATALOG_PUBLIC_KEY, "LING_PLUGIN_CATALOG_PRIVATE_KEY");
console.log("The official plugin artifact and catalog signing keys match the public keys pinned in Ling.");
