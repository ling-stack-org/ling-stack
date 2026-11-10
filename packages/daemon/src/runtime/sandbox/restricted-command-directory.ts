import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { isChannelCommandWorkingDirectoryV1, type ChannelCommandWorkingDirectoryV1 } from "@ling-stack/contracts";

/** Capture all original directory identities before asynchronous input capture.
 * This is a Host revalidation boundary, not protection from unrestricted same-UID processes.
 */
export function captureRestrictedCommandDirectory(cwd: string, directory?: ChannelCommandWorkingDirectoryV1) {
  if (directory !== undefined && !isChannelCommandWorkingDirectoryV1(directory)) {
    throw new Error("restricted_command_directory_invalid");
  }
  const root = realpathSync(cwd), paths = [root];
  if (directory) for (const part of directory.path.split("/")) paths.push(join(paths.at(-1)!, part));
  const facts = paths.map(path => {
    const fact = lstatSync(path, { bigint: true });
    if (!fact.isDirectory() || fact.isSymbolicLink() || realpathSync(path) !== path) {
      throw new Error("restricted_command_directory_invalid");
    }
    return { path, dev: fact.dev, ino: fact.ino };
  });
  return {
    root, originalCwd: resolve(cwd, directory?.path ?? "."), relativePath: directory?.path,
    assertCurrent() {
      try {
        if (realpathSync(cwd) !== root || facts.some(({ path, dev, ino }) => {
          const fact = lstatSync(path, { bigint: true });
          return !fact.isDirectory() || fact.isSymbolicLink() || fact.dev !== dev || fact.ino !== ino || realpathSync(path) !== path;
        })) throw new Error("restricted_command_directory_changed");
      } catch { throw new Error("restricted_command_directory_changed"); }
    },
  };
}
