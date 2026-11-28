import { isDeepStrictEqual } from "node:util";

const GRAPH_SECTIONS = ["importers", "packages", "snapshots"];
const DEPENDENCY_SECTIONS = new Set(["dependencies", "devDependencies", "optionalDependencies"]);

/** @typedef {{name: string, before: string, after: string}} PinnedDependencyUpdate */

/**
 * Trace changes in a pnpm v9 lockfile to workspace importers. Unsupported
 * lockfile shapes and changes to shared settings use the full CI scope.
 * @param {{before: string, after: string}} input
 * @returns {{mode: "affected"|"full", directories: string[], runtimeDirectories: string[], directRuntimeDirectories?: string[], isolatedDevelopmentUpdates?: Map<string, PinnedDependencyUpdate>, reason: string}}
 */
export function analyzeLockfileChange({ before, after }) {
  const base = parseLockfile(before);
  const head = parseLockfile(after);
  if (!base || !head) return full("lockfile shape could not be verified");

  for (const section of new Set([...base.topLevel.keys(), ...head.topLevel.keys()])) {
    if (GRAPH_SECTIONS.includes(section)) continue;
    if (base.topLevel.get(section) !== head.topLevel.get(section)) {
      return full(`lockfile ${section} metadata changed`);
    }
  }

  if (base.importers.size !== head.importers.size
    || [...base.importers.keys()].some(directory => !head.importers.has(directory))) {
    return full("lockfile workspace importers were added or removed");
  }

  const graphKeys = new Set([...base.graph.keys(), ...head.graph.keys()]);
  const changedNodes = new Set([...graphKeys].filter(key =>
    base.graph.get(key)?.fingerprint !== head.graph.get(key)?.fingerprint));
  const reachedChanges = new Set();
  const directories = [];
  const runtimeDirectories = [];
  const directRuntimeDirectories = [];
  const isolatedDevelopmentUpdates = new Map();
  for (const [directory, previous] of base.importers) {
    const current = head.importers.get(directory);
    const directRuntimeChanges = changedDirectImporterDependencies(previous.runtime, current.runtime);
    const directDevelopmentChanges = changedDirectImporterDependencies(previous.development, current.development);
    const runtimeChanges = changedImporterDependencies(previous.runtime, current.runtime, base, head, changedNodes, reachedChanges);
    const developmentChanges = changedImporterDependencies(previous.development, current.development, base, head, changedNodes, reachedChanges);
    if (runtimeChanges.size === 0 && developmentChanges.size === 0) continue;
    if (directory === ".") return full("root lockfile dependency closure changed");
    directories.push(directory);
    if (runtimeChanges.size > 0) runtimeDirectories.push(directory);
    if (directRuntimeChanges.size > 0) directRuntimeDirectories.push(directory);
    if (directRuntimeChanges.size === 0 && directDevelopmentChanges.size === 1) {
      const [name] = directDevelopmentChanges;
      const from = previous.development.get(name);
      const to = current.development.get(name);
      if (from?.reference && to?.reference && from.specifier === from.version && to.specifier === to.version
        && from.version !== to.version) {
        isolatedDevelopmentUpdates.set(directory, { name, before: from.version, after: to.version });
      }
    }
  }

  if (changedNodes.size !== reachedChanges.size) {
    return full("lockfile dependency graph contains an unreachable changed package");
  }
  if (directories.length === 0) return full("lockfile changed without a verifiable dependency graph delta");
  return { mode: "affected", directories: directories.sort(), runtimeDirectories: runtimeDirectories.sort(),
    ...(directRuntimeDirectories.length ? { directRuntimeDirectories: directRuntimeDirectories.sort() } : {}),
    ...(isolatedDevelopmentUpdates.size ? { isolatedDevelopmentUpdates } : {}),
    reason: "verified lockfile dependency closure" };
}

function full(reason) {
  return { mode: "full", directories: [], runtimeDirectories: [], reason };
}

function changedImporterDependencies(previous, current, base, head, changedNodes, reachedChanges) {
  const names = new Set([...previous.keys(), ...current.keys()]);
  const affected = new Set([...names].filter(name => !isDeepStrictEqual(previous.get(name), current.get(name))));
  if (changedNodes.size === 0) return affected;
  for (const [graph, dependencies] of [[base.graph, previous], [head.graph, current]]) {
    for (const [name, { reference }] of dependencies) {
      if (!reference) continue;
      const visited = new Set();
      const pending = [reference];
      while (pending.length > 0) {
        const key = pending.pop();
        if (visited.has(key)) continue;
        visited.add(key);
        if (changedNodes.has(key)) {
          reachedChanges.add(key);
          affected.add(name);
        }
        for (const dependency of graph.get(key).references) pending.push(dependency);
      }
    }
  }
  return affected;
}

function changedDirectImporterDependencies(previous, current) {
  const names = new Set([...previous.keys(), ...current.keys()]);
  return new Set([...names].filter(name => !isDeepStrictEqual(previous.get(name), current.get(name))));
}

function parseLockfile(text) {
  const sections = new Map();
  let lines;
  for (const line of text.replaceAll("\r\n", "\n").split("\n")) {
    const header = /^([a-zA-Z][\w-]*):(?: .*)?$/u.exec(line);
    if (header) {
      if (sections.has(header[1])) return undefined;
      lines = [];
      sections.set(header[1], lines);
    } else if (line && (!lines || !/^ +\S/u.test(line) || /^\s*#/u.test(line))) {
      return undefined;
    }
    lines?.push(line);
  }
  if (!/^lockfileVersion: ['"]?9\.0['"]?$/u.test(sections.get("lockfileVersion")?.[0] ?? "")) return undefined;
  const importerRecords = parseRecords(sections.get("importers"), "importers");
  const packages = parseRecords(sections.get("packages"), "packages");
  const snapshots = parseRecords(sections.get("snapshots"), "snapshots");
  if (!importerRecords || !packages || !snapshots) return undefined;

  const graph = new Map();
  for (const [key, record] of packages) {
    graph.set(`package:${key}`, { fingerprint: record.join("\n"), references: [] });
  }
  for (const [key, record] of snapshots) {
    // A single package metadata record is used by every snapshot of that
    // version, including snapshots with peer or patch suffixes.
    const packageKey = `package:${key.split("(", 1)[0]}`;
    const references = parseSnapshotReferences(record);
    if (!references || !graph.has(packageKey)) return undefined;
    graph.set(`snapshot:${key}`, { fingerprint: record.join("\n"), references: [packageKey, ...references] });
  }
  if ([...graph.values()].some(record => record.references.some(reference => !graph.has(reference)))) return undefined;

  const importers = new Map();
  for (const [directory, record] of importerRecords) {
    const importer = parseImporter(record);
    if (!importer || [...importer.runtime.values(), ...importer.development.values()].some(dependency =>
      dependency.reference && !graph.has(dependency.reference))) return undefined;
    importers.set(directory, importer);
  }
  return {
    topLevel: new Map([...sections].map(([key, section]) => [key, section.join("\n")])),
    importers,
    graph,
  };
}

function parseRecords(sectionLines, sectionName) {
  if (sectionLines?.[0] !== `${sectionName}:`) return undefined;
  const records = new Map();
  let record;
  for (const line of sectionLines.slice(1)) {
    if (/^ {2}\S/u.test(line)) {
      const header = /^ {2}([^:\s][^:]*):(?: \{\})?$/u.exec(line);
      if (!header) return undefined;
      const key = unquote(header[1]);
      if (!key || records.has(key)) return undefined;
      record = [line];
      records.set(key, record);
    } else if (line && (!record || !/^ {4,}\S/u.test(line) || record[0].endsWith("{}"))) {
      return undefined;
    } else if (record) {
      record.push(line);
    }
  }
  return records;
}

function parseImporter(record) {
  const importer = { runtime: new Map(), development: new Map() };
  const sections = new Set();
  let field;
  const lines = record.slice(1).filter(Boolean);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const heading = /^ {4}(\w+):$/u.exec(line)?.[1];
    if (heading) {
      if (!DEPENDENCY_SECTIONS.has(heading) || sections.has(heading)) return undefined;
      sections.add(heading);
      field = heading;
      continue;
    }
    const name = /^ {6}(\S+):$/u.exec(line)?.[1];
    const specifier = /^ {8}specifier: (.+)$/u.exec(lines[index + 1] ?? "")?.[1];
    const rawVersion = /^ {8}version: (\S+)$/u.exec(lines[index + 2] ?? "")?.[1];
    if (!field || !name || !specifier || !rawVersion) return undefined;
    const version = unquote(rawVersion);
    const reference = version.startsWith("link:") ? undefined : snapshotReference(unquote(name), version);
    const dependencies = field === "devDependencies" ? importer.development : importer.runtime;
    const key = field === "devDependencies" ? unquote(name) : `${field}:${unquote(name)}`;
    if (dependencies.has(key)) return undefined;
    dependencies.set(key, { specifier, version, reference });
    index += 2;
  }
  return importer;
}

function parseSnapshotReferences(record) {
  const references = [];
  const sections = new Set();
  let field;
  for (const line of record.slice(1).filter(Boolean)) {
    const heading = /^ {4}(\w+):(?: (\S+))?$/u.exec(line);
    if (heading) {
      field = heading[1];
      if (sections.has(field)) return undefined;
      sections.add(field);
      if (field === "optional" && heading[2] === "true") continue;
      if (heading[2] || !["dependencies", "optionalDependencies", "transitivePeerDependencies"].includes(field)) return undefined;
      continue;
    }
    if (field === "transitivePeerDependencies" && /^ {6}- \S+$/u.test(line)) continue;
    const dependency = /^ {6}(\S+): (\S+)$/u.exec(line);
    if (!dependency || !["dependencies", "optionalDependencies"].includes(field)) return undefined;
    references.push(snapshotReference(unquote(dependency[1]), unquote(dependency[2])));
  }
  return references;
}

function snapshotReference(name, version) {
  const reference = version.startsWith("npm:") ? version.slice(4) : version;
  return `snapshot:${reference.split("(", 1)[0].includes("@") ? reference : `${name}@${reference}`}`;
}

function unquote(value) {
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}
