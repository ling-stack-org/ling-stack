import { parseWorkflowTemplate, workflowTemplateCanonicalJson, type SkillPackSource, type SkillRegistryReviewStatus,
  type WorkflowTemplateRegistryEntry, type WorkflowTemplateVersion } from "@ling-stack/contracts";
import type { RunStore } from "../../run-types.js";
import { DEFAULT_WORKSPACE_ID } from "../../workspace-types.js";
import { normalizeRunnerIdsInSnapshot } from "../../runner-ids.js";
import { WorkflowTemplateRegistryError, type WorkflowTemplateRegistryStore } from "../../workflow-template-registry-types.js";
import { assertWorkflowTemplateRegistry as requireRegistry, workflowTemplateDigest, workflowTemplateRegistryString as string,
  workflowTemplateReviewStatuses, workflowTemplateSources, workflowTemplateVisibility } from "../../workflow-template-registry-validation.js";
import { rollbackOwnedSqliteTransaction } from "./helpers.js";
import { readSqliteSnapshot } from "./read-snapshot.js";
import type { SqliteStoreContext } from "./store-context.js";

const adapters = new WeakMap<RunStore, WorkflowTemplateRegistryStore>();
const time = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value))
  && new Date(value).toISOString() === value;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const digest = (value: unknown): value is string => typeof value === "string" && /^wt1_[a-f0-9]{64}$/u.test(value);
const keys = (value: unknown, allowed: readonly string[]): boolean => value !== null && typeof value === "object"
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Reflect.ownKeys(value).every(key => typeof key === "string" && allowed.includes(key)
    && Object.getOwnPropertyDescriptor(value, key)?.enumerable && "value" in Object.getOwnPropertyDescriptor(value, key)!);

export function createSqliteWorkflowTemplateRegistryStore(store: RunStore): WorkflowTemplateRegistryStore {
  const adapter = adapters.get(store);
  if (!adapter) throw new WorkflowTemplateRegistryError("workflow_template_registry.store_not_sqlite");
  return adapter;
}

export function registerSqliteWorkflowTemplateRegistryStore(store: RunStore, context: SqliteStoreContext): void {
  requireRegistry(!adapters.has(store), "store_already_registered");
  adapters.set(store, new SqliteWorkflowTemplateRegistryStore(context));
}

class SqliteWorkflowTemplateRegistryStore implements WorkflowTemplateRegistryStore {
  constructor(private readonly context: SqliteStoreContext) {}

  list(options: Parameters<WorkflowTemplateRegistryStore["list"]>[0] = {}): readonly WorkflowTemplateRegistryEntry[] {
    requireRegistry(options && keys(options, ["includeArchived", "includeDisabled", "source", "ownerTeammateId", "limit"])
      && (options.includeArchived === undefined || typeof options.includeArchived === "boolean")
      && (options.includeDisabled === undefined || typeof options.includeDisabled === "boolean")
      && (options.source === undefined || workflowTemplateSources.includes(options.source))
      && (options.ownerTeammateId === undefined || string(options.ownerTeammateId, 256))
      && (options.limit === undefined || Number.isSafeInteger(options.limit) && options.limit > 0 && options.limit <= 1000), "invalid_list");
    return readSqliteSnapshot(this.context.database, () => this.context.database.prepare(`SELECT id FROM workflow_template_registry
      WHERE workspace_id=? AND (? OR review_status<>'archived') AND (? OR review_status<>'disabled')
      AND (? IS NULL OR source=?) AND (? IS NULL OR json_extract(visibility_json,'$.ownerTeammateId')=?)
      ORDER BY source,id LIMIT ?`).all(DEFAULT_WORKSPACE_ID, options.includeArchived ? 1 : 0, options.includeDisabled ? 1 : 0,
        options.source ?? null, options.source ?? null, options.ownerTeammateId ?? null, options.ownerTeammateId ?? null,
        options.limit ?? 100).map(row => this.entry(String(row.id))!));
  }

  get(id: string): WorkflowTemplateRegistryEntry | undefined {
    requireRegistry(string(id), "invalid_id");
    return readSqliteSnapshot(this.context.database, () => this.entry(id));
  }

  getVersion(id: string, version: string): WorkflowTemplateVersion | undefined {
    requireRegistry(string(id) && string(version), "invalid_version");
    return readSqliteSnapshot(this.context.database, () => this.entry(id) ? this.version(id, version) : undefined);
  }

  saveVersion(input: Parameters<WorkflowTemplateRegistryStore["saveVersion"]>[0]): ReturnType<WorkflowTemplateRegistryStore["saveVersion"]> {
    requireRegistry(input && keys(input, ["kind", "id", "version", "template", "source", "sourcePath", "visibility", "expectedRevision", "now"])
      && input.kind === "workflow_template" && string(input.id) && string(input.version)
      && workflowTemplateSources.includes(input.source) && (input.sourcePath === undefined || string(input.sourcePath, 4096))
      && revision(input.expectedRevision) && time(input.now), "invalid_save");
    const visibility = workflowTemplateVisibility(input.visibility), visibilityJson = JSON.stringify(visibility);
    // Registry bytes and digests must use the same canonical Runner identity
    // that preview and compilation use. This keeps legacy aliases compatible
    // without allowing a preview/compile digest mismatch.
    const template = normalizeRunnerIdsInSnapshot(parseWorkflowTemplate(input.template));
    const json = workflowTemplateCanonicalJson(template), templateDigest = workflowTemplateDigest(template);
    requireRegistry(JSON.parse(json).id === input.id, "template_id_mismatch");
    return this.transaction(() => {
      const existing = this.entry(input.id);
      requireRegistry((existing?.revision ?? 0) === input.expectedRevision, "revision_conflict");
      requireRegistry(!existing || existing.source === input.source && existing.sourcePath === input.sourcePath
        && JSON.stringify(existing.visibility) === visibilityJson, "identity_conflict");
      requireRegistry(!existing || input.now >= existing.updatedAt, "invalid_time");
      const previous = this.version(input.id, input.version);
      if (previous) {
        requireRegistry(previous.digest === templateDigest, "version_conflict");
        return { status: "duplicate", entry: existing!, version: previous };
      }
      const database = this.context.database;
      if (!existing) database.prepare(`INSERT INTO workflow_template_registry(workspace_id,id,kind,source,source_path,
        visibility_json,review_status,latest_version,revision,created_at,updated_at) VALUES(?,?,'workflow_template',?,?,?,'draft',?,1,?,?)`)
        .run(DEFAULT_WORKSPACE_ID, input.id, input.source, input.sourcePath ?? null, visibilityJson, input.version, input.now, input.now);
      database.prepare(`INSERT INTO workflow_template_versions(workspace_id,template_id,kind,version,digest,template_json,created_at)
        VALUES(?,?,'workflow_template',?,?,?,?)`).run(DEFAULT_WORKSPACE_ID, input.id, input.version, templateDigest, json, input.now);
      if (existing) requireRegistry(database.prepare(`UPDATE workflow_template_registry SET latest_version=?,review_status=?,
        revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`)
        .run(input.version, ["disabled", "archived"].includes(existing.reviewStatus) ? existing.reviewStatus : "draft",
          input.now, DEFAULT_WORKSPACE_ID, input.id, input.expectedRevision).changes === 1, "revision_conflict");
      return { status: "created", entry: this.entry(input.id)!, version: this.version(input.id, input.version)! };
    });
  }

  setReviewStatus(input: Parameters<WorkflowTemplateRegistryStore["setReviewStatus"]>[0]): WorkflowTemplateRegistryEntry {
    requireRegistry(input && keys(input, ["id", "reviewStatus", "version", "digest", "expectedRevision", "now"])
      && string(input.id) && revision(input.expectedRevision) && time(input.now)
      && workflowTemplateReviewStatuses.includes(input.reviewStatus), "invalid_review");
    const publish = input.reviewStatus === "published" || input.reviewStatus === "builtin";
    requireRegistry(publish ? string(input.version) && digest(input.digest) : !("version" in input) && !("digest" in input), "invalid_review_pin");
    return this.transaction(() => {
      const entry = this.entry(input.id);
      requireRegistry(entry, "not_found");
      requireRegistry(entry.revision === input.expectedRevision, "revision_conflict");
      requireRegistry(input.now >= entry.updatedAt, "invalid_time");
      requireRegistry(input.reviewStatus !== "builtin" || entry.source === "builtin", "identity_conflict");
      const selected = publish ? this.version(input.id, input.version!) : undefined;
      requireRegistry(!publish || selected && selected.digest === input.digest, "version_conflict");
      if (entry.reviewStatus === input.reviewStatus && (!publish
        || entry.publishedVersion?.version === selected!.version && entry.publishedVersion.digest === selected!.digest)) return entry;
      requireRegistry(this.context.database.prepare(`UPDATE workflow_template_registry SET review_status=?,published_version=?,published_digest=?,
        revision=revision+1,updated_at=? WHERE workspace_id=? AND id=? AND revision=?`).run(input.reviewStatus,
          selected?.version ?? entry.publishedVersion?.version ?? null, selected?.digest ?? entry.publishedVersion?.digest ?? null,
          input.now, DEFAULT_WORKSPACE_ID, input.id, input.expectedRevision).changes === 1, "revision_conflict");
      return this.entry(input.id)!;
    });
  }

  private entry(id: string): WorkflowTemplateRegistryEntry | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_template_registry WHERE workspace_id=? AND id=?").get(DEFAULT_WORKSPACE_ID, id);
    if (!row) return undefined;
    requireRegistry(row.kind === "workflow_template" && row.id === id && string(row.id) && row.workspace_id === DEFAULT_WORKSPACE_ID
      && workflowTemplateSources.includes(row.source as SkillPackSource) && (row.source_path === null || string(row.source_path, 4096))
      && workflowTemplateReviewStatuses.includes(row.review_status as SkillRegistryReviewStatus) && string(row.latest_version)
      && revision(row.revision) && row.revision > 0 && time(row.created_at) && time(row.updated_at) && row.updated_at >= row.created_at, "corrupt");
    const visibility = workflowTemplateVisibility(JSON.parse(String(row.visibility_json)));
    requireRegistry(JSON.stringify(visibility) === row.visibility_json && this.version(id, row.latest_version), "corrupt");
    const published = row.published_version === null ? undefined : this.version(id, String(row.published_version));
    requireRegistry(row.published_version === null ? row.published_digest === null : published && published.digest === row.published_digest, "corrupt");
    requireRegistry(!["published", "builtin"].includes(String(row.review_status)) || published, "corrupt");
    requireRegistry(row.review_status !== "builtin" || row.source === "builtin", "corrupt");
    return { kind: "workflow_template", id, workspaceId: DEFAULT_WORKSPACE_ID, source: row.source as SkillPackSource,
      ...(row.source_path === null ? {} : { sourcePath: String(row.source_path) }), visibility,
      reviewStatus: row.review_status as SkillRegistryReviewStatus, latestVersion: row.latest_version,
      ...(published ? { publishedVersion: { id, version: published.version, digest: published.digest } } : {}),
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
  }

  private version(id: string, version: string): WorkflowTemplateVersion | undefined {
    const row = this.context.database.prepare("SELECT * FROM workflow_template_versions WHERE workspace_id=? AND template_id=? AND version=?")
      .get(DEFAULT_WORKSPACE_ID, id, version);
    if (!row) return undefined;
    requireRegistry(row.kind === "workflow_template" && row.template_id === id && string(id) && row.version === version && string(version)
      && row.workspace_id === DEFAULT_WORKSPACE_ID && digest(row.digest) && time(row.created_at), "corrupt");
    const json = workflowTemplateCanonicalJson(JSON.parse(String(row.template_json))), template = JSON.parse(json);
    requireRegistry(json === row.template_json && template.id === id && workflowTemplateDigest(template) === row.digest, "corrupt");
    return { kind: "workflow_template", id, workspaceId: DEFAULT_WORKSPACE_ID, version, digest: row.digest, template, createdAt: row.created_at };
  }

  private transaction<T>(write: () => T): T {
    const database = this.context.database;
    requireRegistry(!database.isTransaction, "transaction_active");
    database.exec("BEGIN IMMEDIATE");
    try { const result = write(); database.exec("COMMIT"); return result; }
    catch (error) { rollbackOwnedSqliteTransaction(database); throw error; }
  }
}
