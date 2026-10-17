/** All browser modes use the admitted executable; no cache repair/download fallback. */
export function packagedBrowserSource(source) {
  const start = "      newContext = await launchWithXProtectHeal(() => chromium.launchPersistentContext(userDataDir, {\n        headless: false,";
  const end = "        timeout: 15000,\n      }));";
  if (source.split(start).length !== 2 || source.split(end).length !== 2) throw new Error("packaged_browser_handoff_source_changed");
  return source.replace(start, "      const executablePath = process.env.GSTACK_CHROMIUM_PATH || undefined;\n" + start
    + "\n        ...(executablePath ? { executablePath } : {}),")
    .replace(end, "        timeout: 15000,\n      }), { usesCustomExecutable: Boolean(executablePath) });")
    .replaceAll("probePoisonedChromiumBundle(chromium.executablePath());",
      "if (!process.env.GSTACK_CHROMIUM_PATH) probePoisonedChromiumBundle(chromium.executablePath());");
}
