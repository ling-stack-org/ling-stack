import { useEffect, useMemo, useState } from "react";
import {
  buildComposerSlashCommandOptions,
  type ComposerSlashCommandOption,
  type ComposerSlashFallbackSkill,
} from "@ling-stack/core/composer-slash-intents";
import { listSkills } from "../api/skills.js";
import type { SkillRegistryEntry } from "../types.js";

export function useSlashCommandRegistry(input: {
  readonly workspaceCwd: string;
  readonly refreshToken: number;
  readonly fallbackSkills: readonly ComposerSlashFallbackSkill[];
}): readonly ComposerSlashCommandOption[] {
  const [registryEntries, setRegistryEntries] = useState<readonly SkillRegistryEntry[] | undefined>(undefined);

  useEffect(() => {
    const workspaceCwd = input.workspaceCwd.trim();
    if (!workspaceCwd) {
      setRegistryEntries(undefined);
      return undefined;
    }

    let cancelled = false;
    void listSkills(workspaceCwd)
      .then((response) => {
        if (!cancelled) {
          setRegistryEntries(response.skills);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setRegistryEntries(undefined);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [input.refreshToken, input.workspaceCwd]);

  return useMemo(
    () => buildComposerSlashCommandOptions({
      fallbackSkills: input.fallbackSkills,
      registryEntries,
    }),
    [input.fallbackSkills, registryEntries],
  );
}
