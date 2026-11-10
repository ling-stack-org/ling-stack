import type { BigIntStats } from "node:fs";
import type { HostOfficeFileIdentity } from "@ling-stack/core";

/** Exact descriptor/path observation; never creator or cleanup authority by itself. */
export const officeFileIdentity = (stat: BigIntStats): HostOfficeFileIdentity => Object.freeze({ device: String(stat.dev), inode: String(stat.ino),
  sizeBytes: Number(stat.size), modifiedNs: String(stat.mtimeNs), changedNs: String(stat.ctimeNs) });
export const sameOfficeNode = (a: HostOfficeFileIdentity, b: HostOfficeFileIdentity): boolean => a.device === b.device && a.inode === b.inode;
export const sameOfficeFile = (a: HostOfficeFileIdentity, b: HostOfficeFileIdentity): boolean => sameOfficeNode(a, b)
  && a.sizeBytes === b.sizeBytes && a.modifiedNs === b.modifiedNs && a.changedNs === b.changedNs;
