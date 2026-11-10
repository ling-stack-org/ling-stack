import assert from "node:assert/strict";
import test from "node:test";
import { packagedBrowserSource } from "./packaged-browser-source.mjs";

test("all frozen handoff launches bind the supplied browser and disable cache repair", async () => {
  // The compact fixture mirrors the exact frozen source guards; a real-source
  // check is also run by the compiled full-bundle integration.
  const source = "probePoisonedChromiumBundle(chromium.executablePath());\n"
    + "      newContext = await launchWithXProtectHeal(() => chromium.launchPersistentContext(userDataDir, {\n        headless: false,\n"
    + "        timeout: 15000,\n      }));";
  const result = packagedBrowserSource(source);
  assert.match(result, /usesCustomExecutable: Boolean\(executablePath\)/);
  assert.match(result, /\.\.\.\(executablePath \? \{ executablePath \} : \{\}\)/);
  assert.match(result, /if \(!process.env.GSTACK_CHROMIUM_PATH\) probePoisoned/);
  assert.throws(() => packagedBrowserSource(source.replace("timeout: 15000", "timeout: 30000")), /source_changed/);
  assert.throws(() => packagedBrowserSource(source + source), /source_changed/);
});
