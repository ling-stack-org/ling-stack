import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import type { RunEvaluationHumanConfirmationV1 } from "@ling-stack/contracts";
import { humanEvaluationConfirmationBytes, readHumanEvaluationHandshake,
  type HumanEvaluationAuthority, type HumanEvaluationHandshake } from "./human-evaluation-protocol.js";

export interface HumanEvaluationAuthorityOptions {
  readonly workspaceCwd: string;
  readonly daemonEpoch?: string;
}

/**
 * Independent process-local Main authority. A transport token can establish a
 * connection but never supplies OS confirmation. The private signing key is
 * rotated with every handshake, session change, revocation and Daemon shutdown.
 */
export class HumanEvaluationDesktopAuthority {
  readonly workspaceCwd: string;
  private readonly daemonEpoch: string;
  private current?: HumanEvaluationAuthority;
  private key?: Buffer;
  private closed = false;
  private generation = 0;

  constructor(options: HumanEvaluationAuthorityOptions) {
    this.workspaceCwd = canonical(options.workspaceCwd);
    this.daemonEpoch = options.daemonEpoch ?? randomUUID();
  }

  /** Main-only connection activation; it does not create an authenticated sample. */
  handshake(value: unknown): HumanEvaluationHandshake {
    if (this.closed) throw new Error("evaluation_human_authority_closed");
    const input = readHumanEvaluationHandshake(value);
    if (canonical(input.workspaceCwd) !== this.workspaceCwd) throw new Error("evaluation_human_workspace_mismatch");
    this.clear();
    const authority: HumanEvaluationAuthority = Object.freeze({ daemonEpoch: this.daemonEpoch,
      desktopInstanceId: input.desktopInstanceId, desktopEpoch: input.desktopEpoch,
      connectionEpoch: randomUUID(), osSessionId: input.session.osSessionId,
      osUserId: input.session.osUserId, lockEpoch: input.session.lockEpoch });
    this.current = authority;
    this.key = randomBytes(32);
    return Object.freeze({ authority, workspaceCwd: this.workspaceCwd, confirmationKey: this.key.toString("base64url") });
  }

  isCurrent(authority: HumanEvaluationAuthority): boolean {
    const current = this.current;
    return Boolean(!this.closed && current && this.key
      && authority.daemonEpoch === current.daemonEpoch
      && authority.desktopInstanceId === current.desktopInstanceId
      && authority.desktopEpoch === current.desktopEpoch
      && authority.connectionEpoch === current.connectionEpoch
      && authority.osSessionId === current.osSessionId
      && authority.osUserId === current.osUserId
      && authority.lockEpoch === current.lockEpoch);
  }

  /** Captures a synchronous fence to detect Store/clock callback reentry. */
  capture(authority: HumanEvaluationAuthority): () => boolean {
    const generation = this.generation;
    return () => this.generation === generation && this.isCurrent(authority);
  }

  verifyConfirmation(authority: HumanEvaluationAuthority, intentId: string,
    confirmation: RunEvaluationHumanConfirmationV1, signature: string): boolean {
    if (!this.isCurrent(authority) || !this.key || !/^[a-f0-9]{64}$/u.test(signature)) return false;
    const expected = createHmac("sha256", this.key)
      .update(humanEvaluationConfirmationBytes(authority, intentId, confirmation)).digest();
    return timingSafeEqual(expected, Buffer.from(signature, "hex"));
  }

  /** Exact revocation cannot retire a replacement connection belonging to another Main. */
  revoke(authority: HumanEvaluationAuthority): boolean {
    if (!this.isCurrent(authority)) return false;
    this.clear();
    return true;
  }

  close(): void { this.clear(); this.closed = true; }

  private clear(): void {
    this.key?.fill(0);
    this.key = undefined;
    this.current = undefined;
    this.generation += 1;
  }
}

function canonical(cwd: string): string {
  try { return realpathSync(resolve(cwd)); }
  catch { throw new Error("evaluation_human_workspace_unavailable"); }
}
