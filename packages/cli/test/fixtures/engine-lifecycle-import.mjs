import { registerHooks } from "node:module";

const fixture = new URL("./engine-lifecycle-host.mjs", import.meta.url);
fixture.search = new URL(import.meta.url).search;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@ling-stack/daemon/dist/execution-engine-host.js") {
      return { url: fixture.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
