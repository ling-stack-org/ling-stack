import { constants, type Stats } from "node:fs";

export function isInheritedDaemonPipe(info: Stats): boolean {
  // Node's Windows Stats predicates suppress FIFO, but libuv preserves the
  // exact FIFO mode for an inherited pipe.
  return info.isFIFO() || info.isSocket()
    || (process.platform === "win32" && (info.mode & constants.S_IFMT) === constants.S_IFIFO);
}
