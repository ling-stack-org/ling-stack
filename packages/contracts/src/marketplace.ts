/**
 * Skill marketplace index contract (ux-gap-roadmap-10).
 *
 * The marketplace is a static, git-hosted JSON index — no server, forkable.
 * The index is never a trust boundary: installing still flows through the
 * existing skill import review queue; the index only points at packs whose
 * integrity is verified at download time (sha256-<hex>).
 */

export interface MarketplaceSkillVersion {
  readonly version: string;
  /** Absolute https URL of the .lingpack file. */
  readonly url: string;
  /** sha256-<hex> of the pack bytes. */
  readonly integrity: string;
  readonly compat?: Readonly<{ minLingVersion?: string }>;
}

export interface MarketplaceSkill {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly versions: readonly MarketplaceSkillVersion[];
}

export interface MarketplaceIndex {
  readonly indexVersion: 1;
  readonly generatedAt?: string;
  readonly skills: readonly MarketplaceSkill[];
}

export interface ParsedMarketplaceIndex {
  readonly ok: boolean;
  readonly index?: MarketplaceIndex;
  readonly reason?: string;
}

const MAX_INDEX_SKILLS = 500;

export function parseMarketplaceIndex(raw: unknown): ParsedMarketplaceIndex {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "Marketplace index must be a JSON object." };
  }
  const input = raw as Record<string, unknown>;
  if (input.indexVersion !== 1) {
    return { ok: false, reason: "Unsupported marketplace index version; update Ling to browse this index." };
  }
  if (!Array.isArray(input.skills)) {
    return { ok: false, reason: "Marketplace index skills must be an array." };
  }
  if (input.skills.length > MAX_INDEX_SKILLS) {
    return { ok: false, reason: `Marketplace index exceeds ${MAX_INDEX_SKILLS} skills.` };
  }
  const skills: MarketplaceSkill[] = [];
  for (const entry of input.skills) {
    const skill = parseMarketplaceSkill(entry);
    if (!skill.ok) return { ok: false, reason: skill.reason };
    skills.push(skill.skill!);
  }
  return {
    ok: true,
    index: {
      indexVersion: 1,
      generatedAt: typeof input.generatedAt === "string" ? input.generatedAt : undefined,
      skills,
    },
  };
}

function parseMarketplaceSkill(entry: unknown): { ok: boolean; skill?: MarketplaceSkill; reason?: string } {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return { ok: false, reason: "Marketplace skill entries must be objects." };
  }
  const input = entry as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id : "";
  if (!/^[a-z0-9][a-z0-9._-]*$/iu.test(id)) {
    return { ok: false, reason: `Marketplace skill id is invalid: ${String(input.id)}` };
  }
  const name = typeof input.name === "string" && input.name.trim().length > 0 ? input.name.trim() : id;
  if (!Array.isArray(input.versions) || input.versions.length === 0) {
    return { ok: false, reason: `Marketplace skill ${id} has no versions.` };
  }
  const versions: MarketplaceSkillVersion[] = [];
  for (const versionEntry of input.versions) {
    if (versionEntry === null || typeof versionEntry !== "object" || Array.isArray(versionEntry)) {
      return { ok: false, reason: `Marketplace skill ${id} has an invalid version entry.` };
    }
    const version = versionEntry as Record<string, unknown>;
    const versionLabel = typeof version.version === "string" ? version.version : "";
    const url = typeof version.url === "string" ? version.url : "";
    const integrity = typeof version.integrity === "string" ? version.integrity : "";
    if (!/^sha256-[0-9a-f]{64}$/u.test(integrity)) {
      return { ok: false, reason: `Marketplace skill ${id} version ${versionLabel} integrity must be sha256-<hex>.` };
    }
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return { ok: false, reason: `Marketplace skill ${id} version ${versionLabel} url is invalid.` };
    }
    if (parsedUrl.protocol !== "https:") {
      return { ok: false, reason: `Marketplace skill ${id} version ${versionLabel} url must be https.` };
    }
    versions.push({
      version: versionLabel,
      url,
      integrity,
      compat: typeof version.compat === "object" && version.compat !== null && !Array.isArray(version.compat)
        ? {
            minLingVersion: typeof (version.compat as Record<string, unknown>).minLingVersion === "string"
              ? String((version.compat as Record<string, unknown>).minLingVersion)
              : undefined,
          }
        : undefined,
    });
  }
  return {
    ok: true,
    skill: {
      id,
      name,
      description: typeof input.description === "string" ? input.description : undefined,
      versions,
    },
  };
}
