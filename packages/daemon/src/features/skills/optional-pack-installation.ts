import { parseSkillFrontMatter, type RunStore } from "@ling-stack/core";
import type { OptionalSkillPackAction, OptionalSkillPackId, OptionalSkillPackView } from "@ling-stack/contracts";
import { HttpError } from "../../errors.js";
import { isRecord } from "../../shared/validation.js";
import { preparePackagedGstackPublication } from "./bundled-startup.js";
import { findRetainedGstackChecksum, inspectGstackPack, openGstackPack, prepareGstackPack, type GstackPack } from "./optional-gstack-source.js";
import { optionalSkillPackDescriptor, optionalSkillPackEnabled, optionalSkillPackPluginId, optionalSkillPacks } from "./optional-pack-catalog.js";
import { prepareInstructionPackPublication } from "./optional-pack-publication.js";
import { downloadSuperpowersSkills, readInstructionSkills, readRetainedInstructionPack, retainInstructionPack,
  superpowersDownloadBytes, type InstructionPack } from "./optional-pack-source.js";
import { registerPackagedSkillGeneration } from "./packaged-runtime.js";

type Pack = GstackPack | InstructionPack;
interface Selection { readonly current: Pack; readonly previous?: Pack }
const packIds = Object.keys(optionalSkillPacks) as OptionalSkillPackId[];
const conflicts = new Set<string>();
let superpowersInstallation: ReturnType<typeof installSuperpowers> | undefined;

function checkedPack(value: unknown, id: OptionalSkillPackId): Pack {
  const kind = id === "gstack" ? "gstack" : "instructions";
  if (!isRecord(value) || value.kind !== kind || typeof value.version !== "string" || value.version.length > 60
    || typeof value.checksum !== "string" || !(kind === "gstack" ? /^sha256:[a-f0-9]{64}$/u : /^[a-f0-9]{64}$/u).test(value.checksum)
    || typeof value.skillCount !== "number" || !Number.isInteger(value.skillCount) || value.skillCount < 1 || value.skillCount > 100) {
    throw new HttpError(409, "skill_pack_selection_invalid", "The saved skill pack selection requires repair.");
  }
  return { kind, checksum: value.checksum, version: value.version, skillCount: value.skillCount };
}

function selection(store: RunStore, id: OptionalSkillPackId): Selection | undefined {
  const row = store.getManagedPluginPackage(optionalSkillPackPluginId(id));
  if (row?.status !== "installed") return undefined;
  const value: unknown = JSON.parse(row.manifestJson);
  if (!isRecord(value) || value.schemaVersion !== 1) throw new HttpError(409, "skill_pack_selection_invalid", "The saved skill pack selection requires repair.");
  return { current: checkedPack(value.current, id), previous: value.previous === undefined ? undefined : checkedPack(value.previous, id) };
}

export async function listOptionalSkillPacks(store: RunStore): Promise<OptionalSkillPackView[]> {
  return Promise.all(packIds.map(async (id) => {
    const info = { id, name: optionalSkillPacks[id].name, upstreamUrl: optionalSkillPacks[id].upstreamUrl,
      downloadBytes: id === "superpowers" ? superpowersDownloadBytes : undefined };
    const saved = store.getManagedPluginPackage(optionalSkillPackPluginId(id));
    const installedPackage = saved?.status === "installed" ? saved : undefined;
    try {
      const installed = selection(store, id);
      const enabled = optionalSkillPackEnabled(store, id);
      const issue = installed?.current.kind === "gstack" ? await inspectGstackPack(installed.current.checksum) : undefined;
      if (installed?.current.kind === "instructions") await readRetainedInstructionPack(installed.current.checksum);
      return { ...info, state: issue ? "unavailable" : !installed ? "not_installed" : enabled ? "enabled" : "disabled", issue,
        version: installed?.current.version, skillCount: installed?.current.skillCount, previousVersion: installed?.previous?.version,
        retainedVersion: id === "gstack" && !installed ? (await findRetainedGstackChecksum(store))?.slice(7, 19) : undefined };
    } catch {
      return { ...info, state: "unavailable", issue: "invalid_resources", version: installedPackage?.version };
    }
  }));
}

async function installSuperpowers(): Promise<InstructionPack> {
  const release = await downloadSuperpowersSkills();
  return retainInstructionPack(release.skills, release.version);
}

async function connectOrInstall(store: RunStore, id: OptionalSkillPackId, path?: string): Promise<Pack> {
  if (id === "gstack") return prepareGstackPack(store, path);
  if (path) {
    const skills = await readInstructionSkills(path);
    if (!skills.some(skill => skill.name === "using-superpowers" && parseSkillFrontMatter(skill.markdown).frontMatter.name === skill.name)) {
      throw new HttpError(400, "skill_pack_source_invalid", "Choose a Superpowers repository or its skills directory.");
    }
    return retainInstructionPack(skills);
  }
  superpowersInstallation ??= installSuperpowers().finally(() => { superpowersInstallation = undefined; });
  return superpowersInstallation;
}

async function preparePublication(pack: Pack, rollback = false): Promise<(store: RunStore, now: string) => void> {
  if (pack.kind === "instructions") return prepareInstructionPackPublication(pack);
  const runtime = await openGstackPack(pack.checksum);
  registerPackagedSkillGeneration(runtime);
  return preparePackagedGstackPublication(runtime.source, rollback);
}

export async function changeOptionalSkillPack(store: RunStore, id: OptionalSkillPackId, input: OptionalSkillPackAction, now: string): Promise<void> {
  const pluginId = optionalSkillPackPluginId(id);
  const key = `${store.paths.databasePath}\0${id}`;
  if (conflicts.has(key)) throw new HttpError(409, "skill_pack_busy", "This skill pack is already being prepared for the workspace.");
  conflicts.add(key);
  try {
    const action = input.action;
    const previousPackage = store.getManagedPluginPackage(pluginId);
    const previousEnabled = optionalSkillPackEnabled(store, id);
    function commit(write: () => void): void {
      store.commitManagedSkillPackChange(() => {
        const current = store.getManagedPluginPackage(pluginId);
        if (current?.status !== previousPackage?.status || current?.manifestJson !== previousPackage?.manifestJson
          || optionalSkillPackEnabled(store, id) !== previousEnabled) {
          throw new HttpError(409, "skill_pack_conflict", "The skill pack selection changed. Reload it and try again.");
        }
        write();
      });
    }
    if (action === "disable" || action === "uninstall") {
      if (previousPackage?.status !== "installed") throw notInstalled();
      commit(() => {
        const descriptor = optionalSkillPackDescriptor(id, previousPackage.version);
        store.upsertManagedPlugin({ id: pluginId, sourceKind: descriptor.sourceKind, version: descriptor.version, descriptor, enabled: false }, now);
        if (action === "uninstall") store.markManagedPluginPackageUninstalled(pluginId, now);
        store.replaceManagedPluginContributions(pluginId, [{ contributionKind: "skill-pack", contributionId: optionalSkillPacks[id].packId,
          linkedResourceId: optionalSkillPacks[id].packId, enabled: false }], now);
        store.appendManagedPluginEvent({ pluginId, actor: "local-user", type: action === "uninstall" ? "uninstalled" : "disabled",
          message: `${optionalSkillPacks[id].name} ${action === "uninstall" ? "uninstalled" : "disabled"}.` }, now);
      });
      return;
    }
    let prior: Selection | undefined;
    try {
      prior = selection(store, id);
    } catch (error) {
      if (action !== "connect" && action !== "install") throw error;
    }
    let next: Selection;
    if (action === "install" || action === "connect") {
      const current = await connectOrInstall(store, id, action === "connect" ? input.path : undefined);
      next = { current, previous: current.checksum === prior?.current.checksum ? prior.previous : prior?.current };
    } else {
      if (!prior) throw notInstalled();
      if (action === "rollback" && !prior.previous) throw new HttpError(409, "skill_pack_previous_missing", "No previous skill pack version is available.");
      next = action === "rollback" ? { current: prior.previous!, previous: prior.current } : prior;
    }
    const publish = await preparePublication(next.current, action === "rollback");
    const nextEnabled = action === "enable" || previousEnabled === true;
    commit(() => {
      if (nextEnabled) publish(store, now);
      const descriptor = optionalSkillPackDescriptor(id, next.current.version);
      store.upsertManagedPlugin({ id: pluginId, sourceKind: descriptor.sourceKind, version: descriptor.version, descriptor, enabled: nextEnabled }, now);
      store.upsertManagedPluginPackage({ pluginId, sourceKind: descriptor.sourceKind, version: next.current.version,
        status: "installed", cacheRef: next.current.checksum, packageHash: next.current.checksum.replace(/^sha256:/u, ""),
        manifestJson: JSON.stringify({ schemaVersion: 1, ...next }), previousVersion: next.previous?.version }, now);
      store.replaceManagedPluginContributions(pluginId, [{ contributionKind: "skill-pack", contributionId: optionalSkillPacks[id].packId,
        linkedResourceId: optionalSkillPacks[id].packId, enabled: nextEnabled }], now);
      store.appendManagedPluginEvent({ pluginId, actor: "local-user",
        type: action === "enable" ? "enabled" : prior ? "package_refreshed" : "installed",
        message: `${optionalSkillPacks[id].name} ${action === "enable" ? "enabled" : "prepared"}.`,
        data: { checksum: next.current.checksum, version: next.current.version, action } }, now);
    });
  } finally {
    conflicts.delete(key);
  }
}

function notInstalled(): HttpError { return new HttpError(409, "skill_pack_not_installed", "Install or connect the skill pack first."); }
