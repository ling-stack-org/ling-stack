import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

import { isLinuxDnsProbeHostname } from "@ling-stack/contracts";

import { isLinuxSshHost, LinuxSshProcessExecutor } from "./adapters/linux-ssh-executor.js";
import type { LinuxSshConnection } from "./adapters/linux-ssh.js";
import { localProcessRunner, type LocalProcessRunner } from "./adapters/local-pc-executor.js";

export interface ConfiguredLinuxSshTarget {
  readonly connectionId: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly identityFile: string;
  readonly hostKey: string;
  readonly hostKeyFingerprint: string;
  readonly credentialRevision?: string;
  readonly dnsProbeHostname?: string;
}

export type BoundLinuxSshTarget = LinuxSshConnection & { readonly connectionId: string };

export function readLinuxSshTargets(path: string | undefined): readonly ConfiguredLinuxSshTarget[] {
  if (path === undefined) return [];
  let document: unknown;
  try {
    if (!isAbsolute(path)) throw new Error();
    const stat = statSync(path);
    if (!stat.isFile() || stat.size > 256 * 1024) throw new Error();
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Linux SSH target configuration must be an absolute path to a readable JSON file");
  }
  if (!isRecord(document) || document.version !== 1 || Object.keys(document).length !== 2
    || !Array.isArray(document.targets) || document.targets.length > 64) {
    throw new Error("Linux SSH target configuration requires version 1 and at most 64 targets");
  }
  const targets = document.targets.map(parseTarget);
  if (new Set(targets.map(target => target.connectionId)).size !== targets.length
    || new Set(targets.map(target => target.hostKeyFingerprint)).size !== targets.length) {
    throw new Error("Linux SSH connection IDs and host keys must be unique");
  }
  return targets;
}

function parseTarget(value: unknown, index: number): ConfiguredLinuxSshTarget {
  const fail = (): never => { throw new Error(`Invalid Linux SSH target at index ${index}`); };
  if (!isRecord(value) || Object.keys(value).some(key =>
    !["connectionId", "host", "port", "user", "identityFile", "hostKey", "credentialRevision", "dnsProbeHostname"].includes(key))) return fail();
  const { connectionId, host, user, identityFile, hostKey, credentialRevision, dnsProbeHostname } = value;
  const port = value.port === undefined ? 22 : value.port;
  if (typeof connectionId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(connectionId)
    || typeof host !== "string" || !isLinuxSshHost(host)
    || typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65_535
    || typeof user !== "string" || !/^[a-z0-9_][a-z0-9_.@-]{0,63}$/iu.test(user)
    || typeof identityFile !== "string" || !isAbsolute(identityFile) || identityFile.length > 1024 || /[\u0000-\u001f\u007f]/u.test(identityFile)
    || (credentialRevision !== undefined && (typeof credentialRevision !== "string" || !/^[a-z0-9_.-]{1,64}$/iu.test(credentialRevision)))
    || (dnsProbeHostname !== undefined && (typeof dnsProbeHostname !== "string" || !isLinuxDnsProbeHostname(dnsProbeHostname)))) return fail();
  const key = parseHostKey(hostKey);
  if (!key) return fail();
  return { connectionId, host, port, user, identityFile, ...key, credentialRevision, dnsProbeHostname };
}

function parseHostKey(value: unknown): Pick<ConfiguredLinuxSshTarget, "hostKey" | "hostKeyFingerprint"> | undefined {
  if (typeof value !== "string" || value.length > 8192 || /[\r\n]/u.test(value)) return undefined;
  const key = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) +([a-z0-9+/]+={0,2})(?: +.*)?$/iu.exec(value.trim());
  if (!key) return undefined;
  const [, algorithm, encoded] = key;
  const blob = Buffer.from(encoded!, "base64");
  if (blob.toString("base64") !== encoded || blob.length < 4) return undefined;
  const algorithmLength = blob.readUInt32BE();
  if (blob.subarray(4, 4 + algorithmLength).toString("ascii") !== algorithm || blob.length <= 4 + algorithmLength) return undefined;
  return { hostKey: `${algorithm} ${encoded}`, hostKeyFingerprint: createHash("sha256").update(blob).digest("base64url") };
}

export function bindLinuxSshTargets(configured: readonly ConfiguredLinuxSshTarget[], runner: LocalProcessRunner = localProcessRunner): {
  readonly targets: readonly BoundLinuxSshTarget[];
  close(): void;
} {
  if (configured.length === 0) return { targets: [], close() {} };
  const root = mkdtempSync(join(tmpdir(), "ling-device-ssh-"));
  const close = () => rmSync(root, { recursive: true, force: true });
  try {
    const targets = configured.map((target, index) => {
      const knownHostsFile = join(root, `target-${index}.known_hosts`);
      const hostPattern = target.port === 22 ? target.host : `[${target.host}]:${target.port}`;
      writeFileSync(knownHostsFile, `${hostPattern} ${target.hostKey}\n`, { mode: 0o600, flag: "wx" });
      const revision = createHash("sha256").update(JSON.stringify([
        target.host, target.port, target.user, target.identityFile, target.hostKeyFingerprint, target.credentialRevision, target.dnsProbeHostname,
      ])).digest("hex");
      return {
        connectionId: target.connectionId,
        connectionRef: `ssh:${target.connectionId}:${revision}`,
        hostKeyFingerprint: target.hostKeyFingerprint,
        executor: new LinuxSshProcessExecutor({
          host: target.host, port: target.port, user: target.user, identityFile: target.identityFile,
          knownHostsFile, dnsProbeHostname: target.dnsProbeHostname, runner,
        }),
      };
    });
    return { targets, close };
  } catch (error) {
    close();
    throw error;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
