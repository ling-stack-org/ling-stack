import { isDeepStrictEqual } from "node:util";

const GRAPH_SECTIONS = ["importers", "packages", "snapshots"];
const DEPENDENCY_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]);
const IGNORED_REFERENCE_PREFIXES = ["link:", "workspace:", "file:", "http:", "https:"];

/**
 * Check whether a pnpm lockfile change can be traced to workspace importers.
 *
 * The parser deliberately supports only the stable pnpm v9 lockfile shape used
 * by this repository. Any shape or top-level policy change that cannot be
 * proven safe returns `full` so the caller can keep the conservative fallback.
 *
 * @param {{before: string, after: string, changedDirectories?: string[]}} input
 * @returns {{mode: "affected"|"full", directories: string[], reason: string}}
 */
export function analyzeLockfileChange({ before, after, changedDirectories = [] }) {
  const base = parseLockfile(before);
  const head = parseLockfile(after);
  if (!base || !head) return full("lockfile shape could not be verified");

  for (const section of new Set([...base.topLevel.keys(), ...head.topLevel.keys()])) {
    if (GRAPH_SECTIONS.includes(section)) continue;
    if (base.topLevel.get(section) !== head.topLevel.get(section)) {
      return full(`lockfile ${section} metadata changed`);
    }
  }

  const baseImporters = new Set(base.importers.keys());
  const headImporters = new Set(head.importers.keys());
  if (![...baseImporters].every(directory => headImporters.has(directory))
    || [...headImporters].some(directory => !baseImporters.has(directory))) {
    return full("lockfile workspace importers were added or removed");
  }
  if (baseImporters.has(".")) {
    const rootImporterChanged = !isDeepStrictEqual(base.importers.get("."), head.importers.get("."));
    if (rootImporterChanged) return full("root lockfile importer changed");
  }

  const changedNodes = changedGraphNodes(base, head);
  if (changedNodes.size === 0) {
    return full("lockfile changed without a verifiable dependency graph delta");
  }

  const directories = new Set(changedDirectories.filter(directory => directory !== "."));
  const changedImporterDirectories = [...baseImporters].filter(directory =>
    directory !== "." && !isDeepStrictEqual(base.importers.get(directory), head.importers.get(directory)));
  for (const directory of changedImporterDirectories) directories.add(directory);

  const reachable = new Set();
  const affected = new Set();
  for (const directory of [...baseImporters].filter(value => value !== ".")) {
    const baseReachable = walkGraph(base.graph, base.importers.get(directory)?.references ?? []);
    const headReachable = walkGraph(head.graph, head.importers.get(directory)?.references ?? []);
    const importerReachable = new Set([...baseReachable, ...headReachable]);
    for (const node of importerReachable) {
      if (changedNodes.has(node)) {
        affected.add(directory);
        break;
      }
    }
    for (const node of importerReachable) reachable.add(node);
  }

  if ([...changedNodes].some(node => !reachable.has(node))) {
    return full("lockfile dependency graph contains an unreachable changed package");
  }
  for (const directory of affected) directories.add(directory);
  if (directories.size === 0) return full("lockfile change has no workspace consumer");
  return { mode: "affected", directories: [...directories].sort(), reason: "verified lockfile dependency closure" };
}

function full(reason) {
  return { mode: "full", directories: [], reason };
}

function changedGraphNodes(base, head) {
  const names = new Set([...base.graph.keys(), ...head.graph.keys()]);
  return new Set([...names].filter(name => !isDeepStrictEqual(base.graph.get(name), head.graph.get(name))));
}

function walkGraph(graph, roots) {
  const visited = new Set();
  const pending = [...roots];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || visited.has(node)) continue;
    visited.add(node);
    for (const dependency of graph.get(node)?.references ?? []) pending.push(dependency);
  }
  return visited;
}

function parseLockfile(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const topLevel = new Map();
  let currentSection;
  for (const line of lines) {
    const match = /^(\S[^:]*):(?:.*)?$/u.exec(line);
    if (match) {
      currentSection = match[1];
      if (!topLevel.has(currentSection)) topLevel.set(currentSection, []);
    }
    if (currentSection) topLevel.get(currentSection).push(line);
  }
  const required = GRAPH_SECTIONS.every(section => topLevel.has(section));
  if (!required || !topLevel.get("lockfileVersion")?.[0]?.startsWith("lockfileVersion:")) return undefined;
  const importers = parseRecords(topLevel.get("importers"), "importer", "importers");
  const packages = parseRecords(topLevel.get("packages"), "package", "packages");
  const snapshots = parseRecords(topLevel.get("snapshots"), "package", "snapshots");
  if (!importers || !packages || !snapshots) return undefined;

  const graph = new Map();
  for (const record of [...packages.values(), ...snapshots.values()]) {
    const existing = graph.get(record.key) ?? { references: new Set(), fingerprint: "" };
    for (const reference of record.references) existing.references.add(reference);
    existing.fingerprint += record.raw.join("\n");
    graph.set(record.key, existing);
  }
  return {
    topLevel: new Map([...topLevel.entries()].map(([key, section]) => [key, section.join("\n")])),
    importers,
    graph,
  };
}

function parseRecords(sectionLines, kind, sectionName) {
  if (!sectionLines || sectionLines[0] !== `${sectionName}:`) return undefined;
  const records = new Map();
  let record;
  for (const line of sectionLines.slice(1)) {
    if (/^\S/u.test(line)) break;
    const header = /^  ([^:\s][^:]*):(?:\s*\{\})?$/u.exec(line);
    if (header) {
      record = { key: unquote(header[1]), raw: [line], references: [] };
      records.set(record.key, record);
      continue;
    }
    if (!record) continue;
    record.raw.push(line);
    if (kind === "importer") parseImporterReference(record, line);
    else parsePackageReference(record, line);
  }
  return records;
}

function parseImporterReference(record, line) {
  const dependency = /^ {6}(.+):\s*$/u.exec(line);
  if (dependency) {
    record.dependency = unquote(dependency[1]);
    return;
  }
  const version = /^ {8}version:\s*(.+)$/u.exec(line);
  if (version && record.dependency) {
    const reference = packageReference(record.dependency, version[1]);
    if (reference) record.references.push(reference);
  }
}

function parsePackageReference(record, line) {
  const field = /^ {4}(\w[\w-]*):\s*$/u.exec(line);
  if (field) {
    record.field = DEPENDENCY_SECTIONS.has(field[1]) ? field[1] : undefined;
    return;
  }
  if (!record.field) return;
  const dependency = /^ {6}(.+?):\s*(.+)$/u.exec(line);
  if (!dependency) return;
  const reference = packageReference(unquote(dependency[1]), dependency[2]);
  if (reference) record.references.push(reference);
}

function packageReference(name, rawVersion) {
  const version = unquote(rawVersion).replace(/\s+#.*$/u, "");
  if (!version || IGNORED_REFERENCE_PREFIXES.some(prefix => version.startsWith(prefix))) return undefined;
  if (version.startsWith("npm:")) return version.slice(4);
  return `${name}@${version}`;
}

function unquote(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith("'") && trimmed.endsWith("'")) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  return trimmed;
}
