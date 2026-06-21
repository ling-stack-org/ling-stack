import type { SQLOutputValue } from "node:sqlite";
import {
  DEVELOPMENT_COUNCIL_ID,
  DEVELOPMENT_COUNCIL_MEMBER_TEMPLATE_IDS,
  DEVELOPMENT_COUNCIL_TEMPLATE_ID,
} from "../../builtin-skill-packs.js";
import {
  DEFAULT_WORKSPACE_ID,
  aiCouncilRoutingModes,
  createBuiltinAiTeammateId,
  createAiCouncilId,
  isLingAgentTeammateId,
  type AiCouncil,
  type AiCouncilGovernanceProfile,
  type AiCouncilHealthFinding,
  type AiCouncilHealthFindingKind,
  type AiCouncilHealthReport,
  type AiCouncilHealthReportOptions,
  type AiCouncilHealthSeverity,
  type AiCouncilMember,
  type AiCouncilRoutingPolicy,
  type AiTeammate,
  type Channel,
  type ChannelCouncilPolicy,
  type CloneAiCouncilInput,
  type CreateAiCouncilInput,
  type EffectiveChannelCouncil,
  type EffectiveChannelCouncilMember,
  type EffectiveChannelCouncilProjection,
  type EffectiveChannelSpecialistSource,
  type ListAiCouncilsOptions,
  type ReplaceAiCouncilMemberInput,
  type TeammateChannelMembership,
  type UpdateAiCouncilInput,
  type UpsertChannelCouncilPolicyInput,
} from "../../workspace-types.js";
import {
  mapAiCouncil,
  mapAiCouncilMember,
  mapChannelCouncilPolicy,
} from "./ai-council-mappers.js";
import { stringifyJson } from "./helpers.js";
import {
  aiCouncilMemberSelectSql,
  aiCouncilSelectSql,
  channelCouncilPolicySelectSql,
  teammateChannelMembershipSelectSql,
} from "./select-sql.js";
import type { SqliteStoreContext } from "./store-context.js";
import { mapTeammateChannelMembership } from "./teammate-mappers.js";

const developmentCouncilRoutingPolicy: AiCouncilRoutingPolicy = {
  defaultMode: "advisory",
  notes: [
    "Use this council as a reusable management collection of development specialists.",
    "Route execution to explicit teammates; the council itself is not a super-agent.",
  ],
};

const developmentCouncilGovernanceProfile: AiCouncilGovernanceProfile = {
  permissionBoundary: "restrict_only",
  approvalBoundary: "cannot_bypass",
  toolGrantBoundary: "cannot_grant",
  credentialBoundary: "cannot_grant",
  notes: [
    "Council policy can only narrow execution authority.",
    "Tools, MCP servers, provider credentials, deploy rights, external-send rights, and approvals stay owned by teammates and runtime policy.",
  ],
};

const customCouncilGovernanceProfile: AiCouncilGovernanceProfile = {
  permissionBoundary: "restrict_only",
  approvalBoundary: "cannot_bypass",
  toolGrantBoundary: "cannot_grant",
  credentialBoundary: "cannot_grant",
  notes: [
    "Custom councils are management collections only.",
    "Council settings cannot grant tools, credentials, deploy rights, external-send rights, or approval bypass.",
  ],
};

const defaultCustomCouncilRoutingPolicy: AiCouncilRoutingPolicy = {
  defaultMode: "advisory",
  notes: [
    "Attach by reference; do not copy members into channel memberships.",
    "Route execution to explicit teammates; the council itself is not a super-agent.",
  ],
};

export interface SqliteAiCouncilStorePorts {
  readonly getAiTeammate: (id: string) => AiTeammate | undefined;
  readonly getChannel: (id: string) => Channel | undefined;
  readonly hasTable: (tableName: string) => boolean;
}

export class SqliteAiCouncilStore {
  constructor(
    private readonly context: SqliteStoreContext,
    private readonly ports: SqliteAiCouncilStorePorts,
  ) {}

  ensureBuiltinDevelopmentCouncil(now: string): void {
    if (!this.hasCouncilTables() || this.hasRetentionTombstone("ai-council", DEVELOPMENT_COUNCIL_ID)) {
      return;
    }
    if (!this.getAiCouncil(DEVELOPMENT_COUNCIL_ID)) {
      this.context.database
        .prepare(`
          INSERT INTO ai_councils (
            id,
            workspace_id,
            source,
            template_id,
            display_name,
            description,
            routing_policy_json,
            governance_profile_json,
            status,
            pinned,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          DEVELOPMENT_COUNCIL_ID,
          DEFAULT_WORKSPACE_ID,
          "builtin",
          DEVELOPMENT_COUNCIL_TEMPLATE_ID,
          "Development Council",
          "Built-in council for product, architecture, implementation, design, QA, security, release, and documentation specialists.",
          stringifyJson(developmentCouncilRoutingPolicy),
          stringifyJson(developmentCouncilGovernanceProfile),
          "active",
          1,
          now,
          now,
        );
    }
    this.ensureBuiltinDevelopmentCouncilMembers(now);
  }

  getAiCouncil(id: string): AiCouncil | undefined {
    const row = this.context.database.prepare(aiCouncilSelectSql("WHERE id = ?")).get(id);
    return row ? mapAiCouncil(row as Record<string, SQLOutputValue>) : undefined;
  }

  listAiCouncils(options: ListAiCouncilsOptions = {}): AiCouncil[] {
    const clauses = ["workspace_id = ?"];
    const params: (string | number)[] = [DEFAULT_WORKSPACE_ID];
    if (options.status) {
      clauses.push("status = ?");
      params.push(options.status);
    } else if (!options.includeArchived) {
      clauses.push("status != 'archived'");
    }
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
    params.push(limit);
    return this.context.database
      .prepare(`${aiCouncilSelectSql(`WHERE ${clauses.join(" AND ")}`)} ORDER BY pinned DESC, display_name ASC, created_at ASC LIMIT ?`)
      .all(...params)
      .map((row) => mapAiCouncil(row as Record<string, SQLOutputValue>));
  }

  createAiCouncil(input: CreateAiCouncilInput, now: string): AiCouncil {
    const id = createAiCouncilId();
    const displayName = normalizeNonEmptyText(input.displayName, "displayName");
    const description = normalizeOptionalText(input.description) ?? "";
    const routingPolicy = createCustomCouncilRoutingPolicy(input.routingPolicy);
    const members = this.normalizeAndValidateCouncilMembers(input.members ?? []);
    this.context.database.exec("BEGIN");
    try {
      this.insertAiCouncil({
        id,
        source: "user",
        templateId: undefined,
        displayName,
        description,
        routingPolicy,
        governanceProfile: customCouncilGovernanceProfile,
        status: "active",
        pinned: input.pinned ?? false,
        now,
      });
      this.writeCouncilMembers(id, members, now);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    const council = this.getAiCouncil(id);
    if (!council) {
      throw new Error(`Failed to create AI council: ${id}`);
    }
    return council;
  }

  cloneAiCouncil(sourceCouncilId: string, input: CloneAiCouncilInput, now: string): AiCouncil {
    const source = this.getAiCouncil(sourceCouncilId);
    if (!source) {
      throw new Error(`AI council not found: ${sourceCouncilId}`);
    }
    if (source.status === "archived") {
      throw new Error(`Archived AI council cannot be cloned: ${sourceCouncilId}`);
    }
    const id = createAiCouncilId();
    const displayName = normalizeOptionalText(input.displayName) ?? `Copy of ${source.displayName}`;
    const description = normalizeOptionalText(input.description) ?? source.description;
    const members = this.normalizeAndValidateCouncilMembers(this.listAiCouncilMembers(sourceCouncilId));
    this.context.database.exec("BEGIN");
    try {
      this.insertAiCouncil({
        id,
        source: "user",
        templateId: undefined,
        displayName,
        description,
        routingPolicy: source.routingPolicy,
        governanceProfile: customCouncilGovernanceProfile,
        status: "active",
        pinned: input.pinned ?? false,
        now,
      });
      this.writeCouncilMembers(id, members, now);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    const council = this.getAiCouncil(id);
    if (!council) {
      throw new Error(`Failed to clone AI council: ${sourceCouncilId}`);
    }
    return council;
  }

  updateAiCouncil(id: string, input: UpdateAiCouncilInput, now: string): AiCouncil | undefined {
    const existing = this.getAiCouncil(id);
    if (!existing) {
      return undefined;
    }
    if (existing.source !== "user") {
      throw new Error("Built-in and template councils cannot be modified; clone them first.");
    }
    const displayName = input.displayName === undefined
      ? existing.displayName
      : normalizeNonEmptyText(input.displayName, "displayName");
    const description = input.description === undefined
      ? existing.description
      : normalizeOptionalText(input.description) ?? "";
    const status = input.status ?? existing.status;
    const pinned = input.pinned ?? existing.pinned;

    this.context.database.exec("BEGIN");
    try {
      this.context.database
        .prepare(`
          UPDATE ai_councils
          SET display_name = ?, description = ?, status = ?, pinned = ?, updated_at = ?
          WHERE id = ?
        `)
        .run(displayName, description, status, pinned ? 1 : 0, now, id);
      if (status === "archived") {
        this.detachCouncilFromChannels(id, now);
      }
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }
    return this.getAiCouncil(id);
  }

  getAiCouncilHealthReport(generatedAt: string, options: AiCouncilHealthReportOptions = {}): AiCouncilHealthReport {
    const councils = this.listAiCouncils({ includeArchived: true, limit: 500 });
    const findings: AiCouncilHealthFinding[] = [];
    let totalMembers = 0;
    let availableMembers = 0;
    let blockedMembers = 0;

    for (const council of councils) {
      const members = this.listAiCouncilMembers(council.id);
      totalMembers += members.length;
      if (council.status !== "active") {
        findings.push(createCouncilHealthFinding({
          kind: "council_not_active",
          severity: "warning",
          council,
          title: "Council is not active",
          message: `${council.displayName} is ${council.status} and will not project specialists into channels.`,
        }));
      }
      if (members.length === 0) {
        findings.push(createCouncilHealthFinding({
          kind: "council_empty",
          severity: council.status === "active" ? "critical" : "warning",
          council,
          title: "Council has no members",
          message: `${council.displayName} has no member projections.`,
        }));
      }

      let availableMembersForCouncil = 0;
      for (const member of members) {
        const teammate = this.ports.getAiTeammate(member.teammateId);
        const blockedReason = resolveCouncilMemberBlockedReason(member, teammate);
        if (!blockedReason) {
          availableMembers += 1;
          availableMembersForCouncil += 1;
          continue;
        }
        blockedMembers += 1;
        findings.push(createCouncilMemberHealthFinding(council, member, blockedReason));
      }

      if (council.status === "active" && members.length > 0 && availableMembersForCouncil === 0) {
        findings.push(createCouncilHealthFinding({
          kind: "council_no_available_members",
          severity: "critical",
          council,
          title: "Council has no available members",
          message: `${council.displayName} cannot project any runnable specialists.`,
        }));
      }
    }

    const summary = {
      totalCouncils: councils.length,
      activeCouncils: councils.filter((council) => council.status === "active").length,
      totalMembers,
      availableMembers,
      blockedMembers,
      findings: countCouncilHealthFindings(findings),
    };
    const limit = Math.min(Math.max(options.limit ?? findings.length, 0), 500);
    return {
      workspaceId: DEFAULT_WORKSPACE_ID,
      generatedAt,
      summary,
      findings: findings.slice(0, limit),
    };
  }

  listAiCouncilMembers(councilId: string): AiCouncilMember[] {
    return this.context.database
      .prepare(`${aiCouncilMemberSelectSql("WHERE council_id = ?")} ORDER BY position ASC, created_at ASC`)
      .all(councilId)
      .map((row) => mapAiCouncilMember(row as Record<string, SQLOutputValue>));
  }

  replaceAiCouncilMembers(
    councilId: string,
    members: readonly ReplaceAiCouncilMemberInput[],
    now: string,
  ): AiCouncilMember[] {
    this.assertCouncilExists(councilId);
    const normalized = this.normalizeAndValidateCouncilMembers(members);

    this.context.database.exec("BEGIN");
    try {
      this.writeCouncilMembers(councilId, normalized, now);
      this.context.database.exec("COMMIT");
    } catch (error) {
      this.context.database.exec("ROLLBACK");
      throw error;
    }

    return this.listAiCouncilMembers(councilId);
  }

  getChannelCouncilPolicy(channelId: string): ChannelCouncilPolicy | undefined {
    const channel = this.ports.getChannel(channelId);
    if (!channel) {
      return undefined;
    }
    const row = this.context.database.prepare(channelCouncilPolicySelectSql("WHERE channel_id = ?")).get(channelId);
    if (row) {
      return mapChannelCouncilPolicy(row as Record<string, SQLOutputValue>);
    }
    return {
      workspaceId: DEFAULT_WORKSPACE_ID,
      channelId,
      attachedCouncilIds: [],
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  }

  upsertChannelCouncilPolicy(
    channelId: string,
    input: UpsertChannelCouncilPolicyInput,
    now: string,
  ): ChannelCouncilPolicy {
    const existing = this.getChannelCouncilPolicy(channelId);
    if (!existing) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    const attachedCouncilIds = input.attachedCouncilIds === undefined
      ? existing.attachedCouncilIds
      : dedupeStrings(input.attachedCouncilIds);
    for (const councilId of attachedCouncilIds) {
      const council = this.getAiCouncil(councilId);
      if (!council) {
        throw new Error(`AI council not found: ${councilId}`);
      }
      if (council.status === "archived") {
        throw new Error(`Archived AI council cannot be attached: ${councilId}`);
      }
    }
    const preferredCouncilId = input.preferredCouncilId === undefined
      ? existing.preferredCouncilId
      : input.preferredCouncilId ?? undefined;
    if (preferredCouncilId && !attachedCouncilIds.includes(preferredCouncilId)) {
      throw new Error(`Preferred AI council must be attached first: ${preferredCouncilId}`);
    }

    this.context.database
      .prepare(`
        INSERT INTO channel_council_policies (
          workspace_id,
          channel_id,
          attached_council_ids_json,
          preferred_council_id,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel_id) DO UPDATE SET
          attached_council_ids_json = excluded.attached_council_ids_json,
          preferred_council_id = excluded.preferred_council_id,
          updated_at = excluded.updated_at
      `)
      .run(
        DEFAULT_WORKSPACE_ID,
        channelId,
        stringifyJson(attachedCouncilIds),
        preferredCouncilId ?? null,
        existing.createdAt,
        now,
      );

    const policy = this.getChannelCouncilPolicy(channelId);
    if (!policy) {
      throw new Error(`Failed to upsert channel council policy: ${channelId}`);
    }
    return policy;
  }

  getEffectiveChannelCouncil(channelId: string): EffectiveChannelCouncilProjection | undefined {
    const channel = this.ports.getChannel(channelId);
    const policy = this.getChannelCouncilPolicy(channelId);
    if (!channel || !policy) {
      return undefined;
    }

    const specialistsById = new Map<string, MutableEffectiveSpecialist>();
    for (const membership of this.listDirectChannelMemberships(channelId)) {
      const teammate = this.ports.getAiTeammate(membership.teammateId);
      if (!isRunnableSpecialist(teammate)) {
        continue;
      }
      addSpecialistSource(specialistsById, teammate, {
        kind: "direct",
        isDefault: membership.isDefault || channel.defaultTeammateId === teammate.id,
      });
    }

    const effectiveCouncils: EffectiveChannelCouncil[] = [];
    for (const councilId of policy.attachedCouncilIds) {
      const council = this.getAiCouncil(councilId);
      if (!council || council.status !== "active") {
        continue;
      }
      const members = this.listAiCouncilMembers(councilId).map((member): EffectiveChannelCouncilMember => {
        const teammate = this.ports.getAiTeammate(member.teammateId);
        const blockedReason = resolveCouncilMemberBlockedReason(member, teammate);
        if (!blockedReason && teammate) {
          addSpecialistSource(specialistsById, teammate, {
            kind: "council",
            councilId: council.id,
            councilDisplayName: council.displayName,
            slotKey: member.slotKey,
            label: member.label,
          });
        }
        return {
          member,
          teammate,
          enabled: !blockedReason,
          blockedReason,
        };
      });
      effectiveCouncils.push({ council, members });
    }

    return {
      channelId,
      policy,
      councils: effectiveCouncils,
      specialists: [...specialistsById.values()].map((specialist) => ({
        teammateId: specialist.teammateId,
        teammate: specialist.teammate,
        sources: specialist.sources,
        isDefault: specialist.isDefault,
      })),
    };
  }

  private ensureBuiltinDevelopmentCouncilMembers(now: string): void {
    const existingByTeammateId = new Set(this.listAiCouncilMembers(DEVELOPMENT_COUNCIL_ID).map((member) => member.teammateId));
    const insert = this.context.database.prepare(`
      INSERT INTO ai_council_members (
        council_id,
        teammate_id,
        slot_key,
        label,
        position,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    `);
    for (const [index, templateId] of DEVELOPMENT_COUNCIL_MEMBER_TEMPLATE_IDS.entries()) {
      const teammateId = createBuiltinAiTeammateId(templateId);
      if (existingByTeammateId.has(teammateId) || !this.ports.getAiTeammate(teammateId) || isLingAgentTeammateId(teammateId)) {
        continue;
      }
      insert.run(
        DEVELOPMENT_COUNCIL_ID,
        teammateId,
        templateId,
        builtinCouncilMemberLabel(templateId),
        index,
        now,
        now,
      );
    }
  }

  private assertCouncilExists(councilId: string): void {
    if (!this.getAiCouncil(councilId)) {
      throw new Error(`AI council not found: ${councilId}`);
    }
  }

  private insertAiCouncil(input: {
    readonly id: string;
    readonly source: AiCouncil["source"];
    readonly templateId?: string;
    readonly displayName: string;
    readonly description: string;
    readonly routingPolicy: AiCouncilRoutingPolicy;
    readonly governanceProfile: AiCouncilGovernanceProfile;
    readonly status: AiCouncil["status"];
    readonly pinned: boolean;
    readonly now: string;
  }): void {
    this.context.database
      .prepare(`
        INSERT INTO ai_councils (
          id,
          workspace_id,
          source,
          template_id,
          display_name,
          description,
          routing_policy_json,
          governance_profile_json,
          status,
          pinned,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        DEFAULT_WORKSPACE_ID,
        input.source,
        input.templateId ?? null,
        input.displayName,
        input.description,
        stringifyJson(input.routingPolicy),
        stringifyJson(input.governanceProfile),
        input.status,
        input.pinned ? 1 : 0,
        input.now,
        input.now,
      );
  }

  private normalizeAndValidateCouncilMembers(
    members: readonly ReplaceAiCouncilMemberInput[],
  ): readonly RequiredCouncilMemberInput[] {
    const normalized = dedupeCouncilMemberInputs(members);
    for (const member of normalized) {
      const teammate = this.ports.getAiTeammate(member.teammateId);
      if (!teammate) {
        throw new Error(`AI teammate not found: ${member.teammateId}`);
      }
      if (isLingAgentTeammateId(member.teammateId)) {
        throw new Error("Ling Agent cannot be added as a council member.");
      }
    }
    return normalized;
  }

  private writeCouncilMembers(
    councilId: string,
    members: readonly RequiredCouncilMemberInput[],
    now: string,
  ): void {
    this.context.database.prepare("DELETE FROM ai_council_members WHERE council_id = ?").run(councilId);
    const insert = this.context.database.prepare(`
      INSERT INTO ai_council_members (
        council_id,
        teammate_id,
        slot_key,
        label,
        position,
        enabled,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const member of members) {
      insert.run(
        councilId,
        member.teammateId,
        member.slotKey ?? null,
        member.label ?? null,
        member.position,
        member.enabled ? 1 : 0,
        now,
        now,
      );
    }
  }

  private detachCouncilFromChannels(councilId: string, now: string): void {
    const policies = this.context.database
      .prepare(channelCouncilPolicySelectSql("WHERE workspace_id = ?"))
      .all(DEFAULT_WORKSPACE_ID)
      .map((row) => mapChannelCouncilPolicy(row as Record<string, SQLOutputValue>));
    const update = this.context.database.prepare(`
      UPDATE channel_council_policies
      SET attached_council_ids_json = ?, preferred_council_id = ?, updated_at = ?
      WHERE channel_id = ?
    `);
    for (const policy of policies) {
      if (!policy.attachedCouncilIds.includes(councilId)) {
        continue;
      }
      const attachedCouncilIds = policy.attachedCouncilIds.filter((id) => id !== councilId);
      const preferredCouncilId = policy.preferredCouncilId === councilId ? attachedCouncilIds[0] : policy.preferredCouncilId;
      update.run(
        stringifyJson(attachedCouncilIds),
        preferredCouncilId ?? null,
        now,
        policy.channelId,
      );
    }
  }

  private listDirectChannelMemberships(channelId: string): TeammateChannelMembership[] {
    return this.context.database
      .prepare(`${teammateChannelMembershipSelectSql("WHERE channel_id = ?")} ORDER BY created_at ASC`)
      .all(channelId)
      .map((row) => mapTeammateChannelMembership(row as Record<string, SQLOutputValue>));
  }

  private hasCouncilTables(): boolean {
    return this.ports.hasTable("ai_councils") &&
      this.ports.hasTable("ai_council_members") &&
      this.ports.hasTable("channel_council_policies");
  }

  private hasRetentionTombstone(entityType: string, entityId: string): boolean {
    if (!this.ports.hasTable("retention_tombstones")) {
      return false;
    }
    return Boolean(
      this.context.database
        .prepare("SELECT id FROM retention_tombstones WHERE workspace_id = ? AND entity_type = ? AND entity_id = ? LIMIT 1")
        .get(DEFAULT_WORKSPACE_ID, entityType, entityId),
    );
  }
}

interface MutableEffectiveSpecialist {
  readonly teammateId: string;
  readonly teammate: AiTeammate;
  readonly sources: EffectiveChannelSpecialistSource[];
  isDefault: boolean;
}

function addSpecialistSource(
  specialistsById: Map<string, MutableEffectiveSpecialist>,
  teammate: AiTeammate,
  source: EffectiveChannelSpecialistSource,
): void {
  const existing = specialistsById.get(teammate.id);
  if (existing) {
    existing.sources.push(source);
    existing.isDefault = existing.isDefault || source.isDefault === true;
    return;
  }
  specialistsById.set(teammate.id, {
    teammateId: teammate.id,
    teammate,
    sources: [source],
    isDefault: source.isDefault === true,
  });
}

function dedupeCouncilMemberInputs(members: readonly ReplaceAiCouncilMemberInput[]): readonly RequiredCouncilMemberInput[] {
  const byTeammateId = new Map<string, RequiredCouncilMemberInput>();
  for (const [index, member] of members.entries()) {
    byTeammateId.set(member.teammateId, {
      teammateId: member.teammateId,
      slotKey: normalizeOptionalString(member.slotKey),
      label: normalizeOptionalString(member.label),
      position: member.position ?? index,
      enabled: member.enabled !== false,
    });
  }
  return [...byTeammateId.values()].sort((left, right) => left.position - right.position);
}

function dedupeStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function createCustomCouncilRoutingPolicy(
  input: CreateAiCouncilInput["routingPolicy"],
): AiCouncilRoutingPolicy {
  const defaultMode = input?.defaultMode ?? defaultCustomCouncilRoutingPolicy.defaultMode;
  if (!aiCouncilRoutingModes.includes(defaultMode)) {
    throw new Error(`routingPolicy.defaultMode must be one of: ${aiCouncilRoutingModes.join(", ")}`);
  }
  const maxActiveMembers = input?.maxActiveMembers;
  if (maxActiveMembers !== undefined && (!Number.isInteger(maxActiveMembers) || maxActiveMembers < 1)) {
    throw new Error("routingPolicy.maxActiveMembers must be a positive integer");
  }
  return {
    defaultMode,
    maxActiveMembers,
    notes: input?.notes ?? defaultCustomCouncilRoutingPolicy.notes,
  };
}

function normalizeNonEmptyText(value: string, fieldName: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized;
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return value.trim();
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function isRunnableSpecialist(teammate: AiTeammate | undefined): teammate is AiTeammate {
  return Boolean(teammate && teammate.status === "active" && !teammate.hidden && !isLingAgentTeammateId(teammate.id));
}

function resolveCouncilMemberBlockedReason(member: AiCouncilMember, teammate: AiTeammate | undefined): string | undefined {
  if (!member.enabled) {
    return "member_disabled";
  }
  if (!teammate) {
    return "teammate_missing";
  }
  if (isLingAgentTeammateId(teammate.id)) {
    return "system_teammate_excluded";
  }
  if (teammate.status !== "active") {
    return "teammate_not_active";
  }
  if (teammate.hidden) {
    return "teammate_hidden";
  }
  return undefined;
}

function createCouncilHealthFinding(input: {
  readonly kind: AiCouncilHealthFindingKind;
  readonly severity: AiCouncilHealthSeverity;
  readonly council: AiCouncil;
  readonly title: string;
  readonly message: string;
}): AiCouncilHealthFinding {
  return {
    id: `ai-council-health:${input.kind}:${input.council.id}`,
    kind: input.kind,
    severity: input.severity,
    councilId: input.council.id,
    councilDisplayName: input.council.displayName,
    title: input.title,
    message: input.message,
  };
}

function createCouncilMemberHealthFinding(
  council: AiCouncil,
  member: AiCouncilMember,
  blockedReason: string,
): AiCouncilHealthFinding {
  const kind = councilHealthKindFromBlockedReason(blockedReason);
  const label = member.label ?? member.slotKey ?? member.teammateId;
  return {
    id: `ai-council-health:${kind}:${council.id}:${member.teammateId}`,
    kind,
    severity: councilHealthSeverityFromFindingKind(kind),
    councilId: council.id,
    councilDisplayName: council.displayName,
    teammateId: member.teammateId,
    slotKey: member.slotKey,
    label: member.label,
    title: councilHealthTitleFromFindingKind(kind),
    message: `${label} is not available in ${council.displayName}: ${blockedReason}.`,
  };
}

function councilHealthKindFromBlockedReason(blockedReason: string): AiCouncilHealthFindingKind {
  if (blockedReason === "member_disabled") {
    return "member_disabled";
  }
  if (blockedReason === "teammate_missing") {
    return "teammate_missing";
  }
  if (blockedReason === "teammate_not_active") {
    return "teammate_not_active";
  }
  if (blockedReason === "teammate_hidden") {
    return "teammate_hidden";
  }
  if (blockedReason === "system_teammate_excluded") {
    return "system_teammate_excluded";
  }
  return "teammate_not_active";
}

function councilHealthSeverityFromFindingKind(kind: AiCouncilHealthFindingKind): AiCouncilHealthSeverity {
  if (kind === "teammate_missing" || kind === "council_no_available_members" || kind === "council_empty") {
    return "critical";
  }
  if (kind === "member_disabled") {
    return "info";
  }
  return "warning";
}

function councilHealthTitleFromFindingKind(kind: AiCouncilHealthFindingKind): string {
  if (kind === "member_disabled") {
    return "Council member is disabled";
  }
  if (kind === "teammate_missing") {
    return "Council member teammate is missing";
  }
  if (kind === "teammate_hidden") {
    return "Council member teammate is hidden";
  }
  if (kind === "system_teammate_excluded") {
    return "System teammate is excluded";
  }
  return "Council member teammate is not active";
}

function countCouncilHealthFindings(findings: readonly AiCouncilHealthFinding[]): Record<AiCouncilHealthSeverity, number> {
  return findings.reduce<Record<AiCouncilHealthSeverity, number>>(
    (counts, finding) => ({
      ...counts,
      [finding.severity]: counts[finding.severity] + 1,
    }),
    { info: 0, warning: 0, critical: 0 },
  );
}

function builtinCouncilMemberLabel(templateId: string): string {
  return templateId.split("-").map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)).join(" ");
}

interface RequiredCouncilMemberInput {
  readonly teammateId: string;
  readonly slotKey?: string;
  readonly label?: string;
  readonly position: number;
  readonly enabled: boolean;
}
