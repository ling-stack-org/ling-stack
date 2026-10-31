import type { SQLOutputValue } from "node:sqlite";
import type { DelegationBudgetCharge, DelegationBudgetReservation, DelegationRootBudgetRecord } from "../../harness/delegation-write-types.js";
import { delegationId, delegationInteger, delegationTimestamp, delegationWriteFail } from "../../harness/delegation-write-validation.js";

export type DelegationBudgetRow = Record<string, SQLOutputValue>;
const code = "delegation.persisted_fact_invalid";
function text(row: DelegationBudgetRow, field: string): string { return delegationId(row[field], code); }
function integer(row: DelegationBudgetRow, field: string): number {
  const value = row[field];
  return delegationInteger(typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value, code);
}
function time(row: DelegationBudgetRow, field: string): string { return delegationTimestamp(row[field], code); }
function digest(row: DelegationBudgetRow, field: string): string {
  const value = text(row, field);
  if (!/^[0-9a-f]{64}$/u.test(value)) return delegationWriteFail(code);
  return value;
}
function optional<T>(row: DelegationBudgetRow, field: string, parse: (row: DelegationBudgetRow, field: string) => T): T | undefined {
  if (!Object.hasOwn(row, field)) return delegationWriteFail(code);
  return row[field] === null ? undefined : parse(row, field);
}
function fields(row: DelegationBudgetRow): { readonly createdAt: string; readonly updatedAt: string; readonly settledAt?: string; readonly revision: number } {
  const createdAt = time(row, "created_at");
  const updatedAt = time(row, "updated_at");
  const settledAt = optional(row, "settled_at", time);
  if (updatedAt < createdAt || settledAt !== undefined && (settledAt < createdAt || settledAt > updatedAt)) return delegationWriteFail(code);
  if (integer(row, "schema_version") !== 1) return delegationWriteFail(code);
  return { createdAt, updatedAt, ...(settledAt === undefined ? {} : { settledAt }), revision: integer(row, "revision") };
}

export function mapDelegationRootBudget(row: DelegationBudgetRow): DelegationRootBudgetRecord {
  if (integer(row, "schema_version") !== 1) return delegationWriteFail(code);
  const frozenAt = time(row, "frozen_at");
  const deadlineAt = time(row, "deadline_at");
  const createdAt = time(row, "created_at");
  const priceArtifactId = optional(row, "price_artifact_id", text);
  const priceDigest = optional(row, "price_digest", digest);
  const tokenBudget = optional(row, "token_budget", integer);
  const costBudgetMicros = optional(row, "cost_budget_micros", integer);
  if (deadlineAt <= frozenAt || createdAt !== frozenAt || (priceArtifactId === undefined) !== (priceDigest === undefined)
    || costBudgetMicros !== undefined && priceArtifactId === undefined) return delegationWriteFail(code);
  return Object.freeze({ schemaVersion: 1, rootRunId: text(row, "root_run_id"), authorityArtifactId: text(row, "authority_artifact_id"),
    authorityDigest: digest(row, "authority_digest"), ...(priceArtifactId === undefined ? {} : { priceArtifactId, priceDigest }),
    ...(tokenBudget === undefined ? {} : { tokenBudget }), ...(costBudgetMicros === undefined ? {} : { costBudgetMicros }), frozenAt, deadlineAt, createdAt });
}

export function mapDelegationBudgetReservation(row: DelegationBudgetRow): DelegationBudgetReservation {
  const state = text(row, "state") as DelegationBudgetReservation["state"];
  const parentReservationId = optional(row, "parent_reservation_id", text);
  const tokenReserved = optional(row, "token_reserved", integer);
  const costReservedMicros = optional(row, "cost_reserved_micros", integer);
  const settledTokenUsage = optional(row, "settled_token_usage", integer);
  const settledCostMicros = optional(row, "settled_cost_micros", integer);
  const settlementDigest = optional(row, "settlement_digest", digest);
  const failureCode = optional(row, "failure_code", text);
  const common = fields(row);
  const deadlineAt = time(row, "deadline_at");
  if (!["reserved", "settled", "released", "unresolved"].includes(state) || deadlineAt <= common.createdAt
    || (["settled", "released"].includes(state)) !== (common.settledAt !== undefined)
    || (["settled", "released"].includes(state)) !== (settlementDigest !== undefined)
    || state === "settled" && settledTokenUsage === undefined
    || ["reserved", "unresolved"].includes(state) && (settledTokenUsage !== undefined || settledCostMicros !== undefined)
    || state === "released" && (settledTokenUsage !== 0 || settledCostMicros !== 0)
    || (state === "unresolved") !== (failureCode === "delegation.usage_unknown")
    || state !== "unresolved" && failureCode !== undefined) return delegationWriteFail(code);
  return Object.freeze({ id: text(row, "id"), rootRunId: text(row, "root_run_id"), delegationStepId: text(row, "delegation_step_id"),
    childRunId: text(row, "child_run_id"), requestDigest: digest(row, "request_digest"), idempotencyKey: text(row, "idempotency_key"),
    ...(parentReservationId === undefined ? {} : { parentReservationId }), ...(tokenReserved === undefined ? {} : { tokenReserved }),
    ...(costReservedMicros === undefined ? {} : { costReservedMicros }), ...(settledTokenUsage === undefined ? {} : { settledTokenUsage }),
    ...(settlementDigest === undefined ? {} : { settlementDigest }),
    ...(settledCostMicros === undefined ? {} : { settledCostMicros }), ...(failureCode === undefined ? {} : { failureCode: "delegation.usage_unknown" as const }),
    deadlineAt, state, ...common });
}

export function mapDelegationBudgetCharge(row: DelegationBudgetRow): DelegationBudgetCharge {
  const state = text(row, "state") as DelegationBudgetCharge["state"];
  const common = fields(row);
  const reservationId = optional(row, "reservation_id", text);
  const priceArtifactId = optional(row, "price_artifact_id", text);
  const priceDigest = optional(row, "price_digest", digest);
  const reservedTokens = optional(row, "reserved_tokens", integer);
  const reservedCostMicros = optional(row, "reserved_cost_micros", integer);
  const inputTokens = optional(row, "input_tokens", integer);
  const cachedInputTokens = optional(row, "cached_input_tokens", integer);
  const outputTokens = optional(row, "output_tokens", integer);
  const actualCostMicros = optional(row, "actual_cost_micros", integer);
  if (!["reserved", "measured", "cancelled_before_dispatch", "unresolved"].includes(state)
    || (["measured", "cancelled_before_dispatch"].includes(state)) !== (common.settledAt !== undefined)
    || (priceArtifactId === undefined) !== (priceDigest === undefined)
    || reservedCostMicros !== undefined && priceArtifactId === undefined
    || state === "measured" && (inputTokens === undefined || cachedInputTokens === undefined || outputTokens === undefined
      || cachedInputTokens > inputTokens || !Number.isSafeInteger(inputTokens + outputTokens)
      || (priceArtifactId === undefined) !== (actualCostMicros === undefined))
    || state !== "measured" && [inputTokens, cachedInputTokens, outputTokens, actualCostMicros].some(value => value !== undefined)) return delegationWriteFail(code);
  return Object.freeze({ id: text(row, "id"), rootRunId: text(row, "root_run_id"), runId: text(row, "run_id"),
    attemptId: text(row, "attempt_id"), invocationId: text(row, "invocation_id"), requestDigest: digest(row, "request_digest"),
    idempotencyKey: text(row, "idempotency_key"), ...(reservationId === undefined ? {} : { reservationId }),
    ...(priceArtifactId === undefined ? {} : { priceArtifactId, priceDigest }), ...(reservedTokens === undefined ? {} : { reservedTokens }),
    ...(reservedCostMicros === undefined ? {} : { reservedCostMicros }), ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }), ...(outputTokens === undefined ? {} : { outputTokens }),
    ...(actualCostMicros === undefined ? {} : { actualCostMicros }), state, ...common });
}
