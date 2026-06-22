import { GSTACK_DEFAULT_SKILL_PACK_ID } from "./builtin-skill-packs.js";
import type { SkillRegistryEntry, SkillSourceSnapshot } from "./skill-types.js";

export type SkillSourceHealthFindingKind =
  | "missing_source_snapshot"
  | "source_warning"
  | "orphaned_source_snapshot";

export type SkillSourceHealthSeverity = "info" | "warning" | "critical";

export interface SkillSourceHealthFinding {
  readonly kind: SkillSourceHealthFindingKind;
  readonly severity: SkillSourceHealthSeverity;
  readonly skillId?: string;
  readonly snapshotId?: string;
  readonly title: string;
  readonly message: string;
}

export interface SkillSourceHealthSummary {
  readonly totalSkills: number;
  readonly sourceBackedSkills: number;
  readonly missingSourceSnapshots: number;
  readonly warningSnapshots: number;
  readonly orphanedSnapshots: number;
}

export interface SkillSourceHealthReport {
  readonly workspaceId: string;
  readonly generatedAt: string;
  readonly summary: SkillSourceHealthSummary;
  readonly findings: readonly SkillSourceHealthFinding[];
}

export interface BuildSkillSourceHealthReportInput {
  readonly workspaceId: string;
  readonly skills: readonly SkillRegistryEntry[];
  readonly snapshots: readonly SkillSourceSnapshot[];
  readonly generatedAt: string;
  readonly limit?: number;
}

export function buildSkillSourceHealthReport(input: BuildSkillSourceHealthReportInput): SkillSourceHealthReport {
  const skillsById = new Map(input.skills.map((skill) => [skill.id, skill]));
  const publishedSnapshots = input.snapshots.filter((snapshot) => snapshot.reviewStatus === "published");
  const snapshotsBySkillId = new Map(publishedSnapshots.map((snapshot) => [snapshot.skillId, snapshot]));
  const sourceExpectedSkills = input.skills.filter((skill) => isSourceExpectedSkill(skill));
  const findings: SkillSourceHealthFinding[] = [];

  for (const skill of sourceExpectedSkills) {
    if (!snapshotsBySkillId.has(skill.id)) {
      findings.push({
        kind: "missing_source_snapshot",
        severity: "info",
        skillId: skill.id,
        title: "Skill source snapshot missing",
        message: `${skill.id} has registry metadata but no published source snapshot.`,
      });
    }
  }

  for (const snapshot of publishedSnapshots) {
    if (!skillsById.has(snapshot.skillId)) {
      findings.push({
        kind: "orphaned_source_snapshot",
        severity: "warning",
        skillId: snapshot.skillId,
        snapshotId: snapshot.id,
        title: "Orphaned skill source snapshot",
        message: `${snapshot.id} points at missing or archived skill ${snapshot.skillId}.`,
      });
    }
    if (snapshot.warnings.length > 0) {
      findings.push({
        kind: "source_warning",
        severity: sourceWarningSeverity(snapshot),
        skillId: snapshot.skillId,
        snapshotId: snapshot.id,
        title: "Skill source warning",
        message: `${snapshot.id} has ${snapshot.warnings.length} source warning(s).`,
      });
    }
  }

  const limitedFindings = input.limit ? findings.slice(0, input.limit) : findings;
  return {
    workspaceId: input.workspaceId,
    generatedAt: input.generatedAt,
    summary: {
      totalSkills: input.skills.length,
      sourceBackedSkills: snapshotsBySkillId.size,
      missingSourceSnapshots: sourceExpectedSkills.filter((skill) => !snapshotsBySkillId.has(skill.id)).length,
      warningSnapshots: publishedSnapshots.filter((snapshot) => snapshot.warnings.length > 0).length,
      orphanedSnapshots: publishedSnapshots.filter((snapshot) => !skillsById.has(snapshot.skillId)).length,
    },
    findings: limitedFindings,
  };
}

function isSourceExpectedSkill(skill: SkillRegistryEntry): boolean {
  return skill.packId === GSTACK_DEFAULT_SKILL_PACK_ID || skill.source === "gstack" || skill.source === "skill-directory";
}

function sourceWarningSeverity(snapshot: SkillSourceSnapshot): SkillSourceHealthSeverity {
  if (snapshot.warnings.some((warning) => warning.severity === "error")) {
    return "critical";
  }
  if (snapshot.warnings.some((warning) => warning.severity === "warning")) {
    return "warning";
  }
  return "info";
}
