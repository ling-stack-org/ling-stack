import { isAbsolute, relative } from "node:path";

export const PROTECTED_HOST_COMMAND_ARENA_PARENT = "/private/tmp";
export const PROTECTED_HOST_COMMAND_ARENA_NAME = /^ling-command-[A-Za-z0-9]{6}$/u;
export const protectedHostPathInside = (path: string, root: string): boolean => {
  const tail = relative(root, path);
  return !isAbsolute(tail) && tail !== ".." && !tail.startsWith("../");
};
/** A permanent Host domain must never live in any still-writable actor scratch/arena. */
export function isProtectedHostCommandArenaPath(path: string): boolean {
  return protectedHostPathInside(path, PROTECTED_HOST_COMMAND_ARENA_PARENT)
    && PROTECTED_HOST_COMMAND_ARENA_NAME.test(relative(PROTECTED_HOST_COMMAND_ARENA_PARENT, path).split("/")[0]!);
}
