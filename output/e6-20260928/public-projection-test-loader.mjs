import { resolve as resolveCandidate } from "./project-inputs-final-build/final-build-loader.mjs";

const root = new URL("../../", import.meta.url);
const daemonDist = new URL("packages/daemon/dist/", root).href;
const daemonCandidate = new URL("./project-inputs-final-build/daemon/", import.meta.url).href;

// Resolve newly authored modules before Node checks whether an old dist entry exists.
export function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("file:")) {
    const target = new URL(specifier, context.parentURL ?? root).href;
    if (target.startsWith(daemonDist)) {
      return nextResolve(daemonCandidate + target.slice(daemonDist.length), context);
    }
  }
  return resolveCandidate(specifier, context, nextResolve);
}
