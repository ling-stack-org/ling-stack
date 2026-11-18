import type { ManagedWorktreeActionRequest } from "@ling-stack/contracts";
import { daemonClient } from "./client.js";

export const listManagedWorktrees = (cwd: string) => daemonClient.listManagedWorktrees(cwd);
export const actOnManagedWorktree = (cwd: string, input: ManagedWorktreeActionRequest) => daemonClient.actOnManagedWorktree(cwd, input);
