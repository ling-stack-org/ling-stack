import { lstatSync, realpathSync, type BigIntStats } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { HostOfficeDirectoryAncestorV2, HostOfficeLocalDirectoryPreparedV2,
  HostOfficeNativeIdentityV2, HostOfficeDirectoryMemberV2 } from "@ling-stack/core";
import { revalidateOfficeLocalSnapshot, type OfficeLocalReadSnapshot } from "./office-local-snapshot.js";

const fail = (): never => { throw new Error("office_local_directory_graph_unsupported"); };
const component = (value: string): boolean => value.length > 0 && Buffer.byteLength(value) <= 255
  && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\0");
const inside = (root: string, path: string): boolean => {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};

function directoryIdentity(stat: BigIntStats): HostOfficeNativeIdentityV2 {
  if (!stat.isDirectory() || stat.isSymbolicLink()) return fail();
  return Object.freeze({ device: String(stat.dev), inode: String(stat.ino), sizeBytes: String(stat.size),
    modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs), mode: Number(stat.mode), isFile: false, isDirectory: true });
}

/**
 * Historical namespace only, not captured native handles or a scope proof.
 * The fixed adapter must compare these nodes to the original acquired native
 * lifetimes under its real issuer before using any created-directory capability.
 */
function ancestorChain(parent: string, prefix: string): readonly HostOfficeDirectoryAncestorV2[] {
  if (!isAbsolute(parent) || resolve(parent) !== parent || parent === "/" || parent.includes("\0")) return fail();
  const paths: string[] = [];
  for (let current = parent; ; current = dirname(current)) {
    paths.unshift(current);
    if (current === "/") break;
    if (dirname(current) === current || paths.length >= 128) return fail();
  }
  return Object.freeze(paths.map((path, index) => {
    if (realpathSync(path) !== path || (path !== "/" && !component(basename(path)))) return fail();
    return Object.freeze({ resourceSlotId: `${prefix}-${index}`, path, identity: directoryIdentity(lstatSync(path, { bigint: true })) });
  }));
}

export type OfficeLocalDirectoryGraph = Pick<HostOfficeLocalDirectoryPreparedV2, "stage" | "destination" | "members" | "workspaceIdentity">;

/**
 * Project the exact first-missing-directory subtree from the original owned
 * snapshot. No mkdir/open/install/cleanup, ticket, actor classification, scope
 * issuance or safe receipt happens here. Existing-parent leaf and overwrite
 * retain their independent implementation; they are never silently routed here.
 */
export function projectOfficeLocalDirectoryGraph(snapshot: OfficeLocalReadSnapshot,
  stageParentPath: string, topBasename: string): OfficeLocalDirectoryGraph {
  revalidateOfficeLocalSnapshot(snapshot); // Reject clones and changed snapshots.
  if (snapshot.input.state !== "absent" || !component(topBasename)
    || stageParentPath === snapshot.workspacePath || inside(snapshot.workspacePath, stageParentPath)
    || inside(stageParentPath, snapshot.workspacePath)) return fail();
  const firstMissing = snapshot.directories.findIndex(directory => !directory.identity);
  if (firstMissing < 0) return fail();
  const missing = snapshot.directories.slice(firstMissing);
  if (missing.some(directory => directory.identity) || missing.length + 1 > 128) return fail();
  const first = missing[0]!, destinationParentPath = dirname(first.path);
  const stageAncestors = ancestorChain(stageParentPath, "stage-ancestor"),
    destinationAncestors = ancestorChain(destinationParentPath, "destination-ancestor");
  // Publication acquires one additional readonly lifetime per created member.
  // Reject an unsupported graph before any native effect, not after installation.
  if (stageAncestors.length + destinationAncestors.length + 2 * (missing.length + 1) > 384) return fail();
  const workspace = destinationAncestors.find(ancestor => ancestor.path === snapshot.workspacePath);
  if (!workspace || workspace.identity.device !== snapshot.workspaceIdentity.device
    || workspace.identity.inode !== snapshot.workspaceIdentity.inode) return fail();
  for (const directory of snapshot.directories.slice(0, firstMissing)) {
    const ancestor = destinationAncestors.find(row => row.path === directory.path);
    if (!ancestor || ancestor.identity.device !== directory.identity!.device || ancestor.identity.inode !== directory.identity!.inode) return fail();
  }
  const members: HostOfficeDirectoryMemberV2[] = [];
  let parentSlot = stageAncestors.at(-1)!.resourceSlotId, stagePath = stageParentPath,
    canonicalParent = destinationParentPath;
  for (const [index, canonicalPath] of [...missing.map(directory => directory.path), snapshot.targetPath].entries()) {
    const canonicalBasename = basename(canonicalPath), name = index === 0 ? topBasename : canonicalBasename;
    if (!component(canonicalBasename) || dirname(canonicalPath) !== canonicalParent) return fail();
    stagePath = join(stagePath, name);
    const member = Object.freeze({ memberId: `member-${index}`, resourceSlotId: `created-${index}`,
      publicationResourceSlotId: `publication-${index}`, parentResourceSlotId: parentSlot,
      kind: index === missing.length ? "created_file" as const : "created_directory" as const,
      basename: name, canonicalPath, stagePath, initial: "absent" as const });
    members.push(member); parentSlot = member.resourceSlotId; canonicalParent = canonicalPath;
  }
  revalidateOfficeLocalSnapshot(snapshot);
  return Object.freeze({ workspaceIdentity: workspace.identity,
    stage: Object.freeze({ parentPath: stageParentPath, parentResourceSlotId: stageAncestors.at(-1)!.resourceSlotId,
      topBasename, ancestors: stageAncestors }),
    destination: Object.freeze({ parentPath: destinationParentPath, parentResourceSlotId: destinationAncestors.at(-1)!.resourceSlotId,
      firstMissingComponent: basename(first.path), ancestors: destinationAncestors }), members: Object.freeze(members) });
}
