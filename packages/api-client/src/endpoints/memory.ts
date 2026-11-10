import type {
  CreateMemoryObjectRequest,
  CreateMemoryConsolidationJobRequest,
  MemoryMarkdownExportRequest,
  MemoryMarkdownExportResponse,
  MemoryMarkdownImportRequest,
  MemoryMarkdownImportResponse,
  ApplyMemoryReviewActionRequest,
  MemoryListResponse,
  MemoryConsolidationJobListResponse,
  MemoryConsolidationJobMutationResponse,
  MemoryHealthRequest,
  MemoryHealthResponse,
  MemoryMutationResponse,
  MemoryPromotionInboxResponse,
  MemoryRecallRequest,
  MemoryRecallResponse,
  MemoryReviewPolicyResponse,
  MemoryReviewPolicyUpdateRequest,
  MemoryReviewMutationResponse,
  UpdateMemoryObjectRequest,
  UsedMemoryListResponse,
  MemoryObject,
  MemorySemanticPolicyResponse,
  MemorySemanticPolicyUpdate,
  MemoryWikiResponse, MemoryWikiScope, MemoryWikiExportResponse, MemoryWikiHumanBlock,
} from "@ling-stack/contracts";
import type { LingDaemonEndpointContext, PublicEndpointGroup } from "../transport.js";

export const memoryEndpoints = {
  async getMemoryWiki(this: LingDaemonEndpointContext, cwd: string, scope: MemoryWikiScope): Promise<MemoryWikiResponse> {
    return this._get('/memory/wiki', {cwd, ...scope});
  },
  async compileMemoryWiki(this: LingDaemonEndpointContext, cwd: string, scope: MemoryWikiScope): Promise<MemoryWikiResponse> {
    return this._post('/memory/wiki/compile', {cwd, ...scope});
  },
  async exportMemoryWiki(this: LingDaemonEndpointContext, cwd: string, scope: MemoryWikiScope): Promise<MemoryWikiExportResponse> {
    return this._get('/memory/wiki/export', {cwd, ...scope});
  },
  async updateMemoryWikiHumanBlock(this: LingDaemonEndpointContext, cwd: string, scope: MemoryWikiScope,
    input: {readonly expectedRevision: number; readonly text: string}): Promise<{readonly human: MemoryWikiHumanBlock}> {
    return this._put('/memory/wiki/human', {cwd, ...scope}, input);
  },
  async getMemoryObject(this: LingDaemonEndpointContext, cwd: string, id: string): Promise<{readonly memory: MemoryObject}> {
    return this._get(`/memory/${encodeURIComponent(id)}`, {cwd});
  },
  async getMemorySemanticPolicy(this: LingDaemonEndpointContext, cwd: string): Promise<MemorySemanticPolicyResponse> {
    return this._get('/memory/semantic-policy', {cwd});
  },
  async updateMemorySemanticPolicy(this: LingDaemonEndpointContext, cwd: string, input: MemorySemanticPolicyUpdate): Promise<MemorySemanticPolicyResponse> {
    return this._put('/memory/semantic-policy', {cwd}, input);
  },
  async listMemoryObjects(this: LingDaemonEndpointContext,
      cwd: string,
      options: {
        readonly scopeType?: string;
        readonly ownerId?: string;
        readonly reviewState?: string;
        readonly enabled?: boolean;
        readonly sensitivity?: string;
        readonly tag?: string;
        readonly limit?: number;
      } = {},
    ): Promise<MemoryListResponse> {
      return this._get("/memory", { cwd, ...options });
    },

  async createMemoryObject(this: LingDaemonEndpointContext, cwd: string, input: CreateMemoryObjectRequest): Promise<MemoryMutationResponse> {
      return this._post("/memory", { cwd }, input);
    },

  async exportMemoryMarkdown(this: LingDaemonEndpointContext, cwd: string, options: MemoryMarkdownExportRequest = {}): Promise<MemoryMarkdownExportResponse> {
      return this._get("/memory/export", {
        cwd,
        scopeType: options.scopeType,
        ownerId: options.ownerId,
        reviewState: options.reviewState,
        sensitivity: options.sensitivity,
        tag: options.tag,
        limit: options.limit,
        includeSecretAdjacent: options.includeSecretAdjacent,
        includeMarkdown: options.includeMarkdown,
        fileName: options.fileName,
        generatedAt: options.generatedAt,
      });
    },

  async importMemoryMarkdown(this: LingDaemonEndpointContext, cwd: string, input: MemoryMarkdownImportRequest): Promise<MemoryMarkdownImportResponse> {
      return this._post("/memory/import", { cwd }, input);
    },

  async getMemoryHealth(this: LingDaemonEndpointContext, cwd: string, options: MemoryHealthRequest = {}): Promise<MemoryHealthResponse> {
      return this._get("/memory/health", {
        cwd,
        scopeType: options.scopeType,
        ownerId: options.ownerId,
        staleCandidateDays: options.staleCandidateDays,
        limit: options.limit,
      });
    },

  async listMemoryConsolidationJobs(this: LingDaemonEndpointContext,
      cwd: string,
      options: {
        readonly kind?: string;
        readonly status?: string;
        readonly limit?: number;
      } = {},
    ): Promise<MemoryConsolidationJobListResponse> {
      return this._get("/memory/consolidation-jobs", { cwd, ...options });
    },

  async createMemoryConsolidationJob(this: LingDaemonEndpointContext, cwd: string, input: CreateMemoryConsolidationJobRequest): Promise<MemoryConsolidationJobMutationResponse> {
      return this._post("/memory/consolidation-jobs", { cwd }, input);
    },

  async updateMemoryObject(this: LingDaemonEndpointContext, cwd: string, memoryId: string, input: UpdateMemoryObjectRequest): Promise<MemoryMutationResponse> {
      return this._patch(`/memory/${encodeURIComponent(memoryId)}`, { cwd }, input);
    },

  async getMemoryReviewPolicy(this: LingDaemonEndpointContext, cwd: string): Promise<MemoryReviewPolicyResponse> {
      return this._get("/memory/review-policy", { cwd });
    },

  async updateMemoryReviewPolicy(this: LingDaemonEndpointContext, cwd: string, input: MemoryReviewPolicyUpdateRequest): Promise<MemoryReviewPolicyResponse> {
      return this._patch("/memory/review-policy", { cwd }, input);
    },

  async listMemoryPromotionInbox(this: LingDaemonEndpointContext,
      cwd: string,
      options: {
        readonly scopeType?: string;
        readonly ownerId?: string;
        readonly sensitivity?: string;
        readonly limit?: number;
      } = {},
    ): Promise<MemoryPromotionInboxResponse> {
      return this._get("/memory/promotion-inbox", { cwd, ...options });
    },

  async reviewMemory(this: LingDaemonEndpointContext, cwd: string, memoryId: string, input: ApplyMemoryReviewActionRequest): Promise<MemoryReviewMutationResponse> {
      return this._post(`/memory/${encodeURIComponent(memoryId)}/review`, { cwd }, input);
    },

  async recallMemory(this: LingDaemonEndpointContext, cwd: string, input: MemoryRecallRequest): Promise<MemoryRecallResponse> {
      return this._post("/memory/recall", { cwd }, input);
    },

  async listUsedMemoryEvents(this: LingDaemonEndpointContext,
      cwd: string,
      options: {
        readonly teammateId?: string;
        readonly channelId?: string;
        readonly taskId?: string;
        readonly runId?: string;
        readonly responseId?: string;
        readonly memoryId?: string;
        readonly limit?: number;
      } = {},
    ): Promise<UsedMemoryListResponse> {
      return this._get("/memory/used", { cwd, ...options });
    },
};

export type MemoryEndpoints = PublicEndpointGroup<typeof memoryEndpoints>;
