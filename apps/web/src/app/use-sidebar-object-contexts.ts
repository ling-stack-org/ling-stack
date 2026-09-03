import { useEffect, useMemo, useState } from "react";
import { getWorkspaceChanges } from "../api/workspace-changes.js";
import {
  projectSidebarObjectGitContext,
  type SidebarObjectContext,
  type SidebarObjectContextSeed,
  type SidebarObjectGitContext,
} from "./sidebar-object-context.js";

export function useSidebarObjectContexts(
  seeds: readonly SidebarObjectContextSeed[],
): Readonly<Record<string, SidebarObjectContext>> {
  const uniqueCwds = useMemo(
    () => [...new Set(seeds.flatMap((seed) => seed.cwd ? [seed.cwd] : []))],
    [seeds],
  );
  const cwdKey = uniqueCwds.join("\u0001");
  const [gitByCwd, setGitByCwd] = useState<Readonly<Record<string, SidebarObjectGitContext>>>({});

  useEffect(() => {
    let cancelled = false;
    if (uniqueCwds.length === 0) {
      setGitByCwd({});
      return () => {
        cancelled = true;
      };
    }

    void Promise.all(uniqueCwds.map(async (cwd) => {
      try {
        const changes = await getWorkspaceChanges(cwd);
        return [cwd, projectSidebarObjectGitContext(changes)] as const;
      } catch {
        return [cwd, undefined] as const;
      }
    })).then((entries) => {
      if (cancelled) return;
      const next: Record<string, SidebarObjectGitContext> = {};
      for (const [cwd, git] of entries) {
        if (git) next[cwd] = git;
      }
      setGitByCwd(next);
    });

    return () => {
      cancelled = true;
    };
  }, [cwdKey]);

  return useMemo(() => Object.fromEntries(seeds.map((seed) => [
    seed.key,
    {
      activityAt: seed.activityAt,
      ...(seed.cwd && gitByCwd[seed.cwd] ? { git: gitByCwd[seed.cwd] } : {}),
    } satisfies SidebarObjectContext,
  ])), [gitByCwd, seeds]);
}
