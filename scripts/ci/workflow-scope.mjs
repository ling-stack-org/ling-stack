const catalogWorkflows = new Set([
  ".github/workflows/sync-translation-catalogs.yml",
  ".github/workflows/translate-pr-catalogs.yml",
]);

/** @param {string} source */
export function catalogAppPin(source) {
  const pins = [...source.matchAll(/^ {8}id: catalog-app\n( {8}uses: actions\/create-github-app-token@([a-f0-9]{40})(?: # v\d+\.\d+\.\d+)?)$/gmu)];
  if (pins.length !== 1) return undefined;
  const [match, line, sha] = pins[0];
  return { sha, start: pins[0].index + match.length - line.length, length: line.length };
}

/**
 * Only the reviewed catalog App action reference may change. Compare the
 * remaining Git blob bytes verbatim, including triggers, inputs and permissions.
 * @param {{files: string[], base: string, head: string, git: (args: string[], encoding?: BufferEncoding) => string}} input
 */
export function isCatalogWorkflowPinUpdate({ files, base, head, git }) {
  return files.length > 0 && files.every(file => {
    if (!catalogWorkflows.has(file)) return false;
    try {
      if (![base, head].every(ref => /^100644 blob /u.test(git(["ls-tree", ref, "--", file])))) return false;
      const before = git(["cat-file", "blob", base + ":" + file], "latin1");
      const after = git(["cat-file", "blob", head + ":" + file], "latin1");
      const oldPin = catalogAppPin(before);
      const newPin = catalogAppPin(after);
      return Boolean(oldPin && newPin && oldPin.sha !== newPin.sha
        && before.slice(0, oldPin.start) === after.slice(0, newPin.start)
        && before.slice(oldPin.start + oldPin.length) === after.slice(newPin.start + newPin.length));
    } catch {
      return false;
    }
  });
}
