import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import { sign } from "@electron/osx-sign";

import {
  SigningContractError,
  canonicalJson,
  sha256File,
} from "./signing-contract.mjs";

const CODESIGN = "/usr/bin/codesign";
const PLUTIL = "/usr/bin/plutil";
const SECURITY = "/usr/bin/security";
const MAX_COMMAND_OUTPUT_BYTES = 2 * 1024 * 1024;
const PROVIDER_IDENTIFIER = "com.lingstack.desktop.cua-driver";
const REQUIRED_PROVIDER_ENTITLEMENTS = Object.freeze({
  "com.apple.security.automation.apple-events": true,
  "com.apple.security.device.screen-capture": true,
});

/**
 * Create the real macOS signer used by local/internal product packages.
 * Production can use the same boundary with a Developer ID identity later.
 */
export function createDarwinPlatformSigner(input = {}) {
  const identity = requireText(input.identity, "darwin_signing_identity_missing");
  const expectedTeamId = requireTeamId(input.expectedTeamId);
  const entitlementsPath = resolve(
    requireText(input.entitlementsPath, "darwin_provider_entitlements_missing"),
  );
  const bundleSignOptions = input.bundleSignOptions;
  let certificateIdentityPromise;

  const certificateIdentity = () => {
    certificateIdentityPromise ??= inspectCertificateIdentity(identity);
    return certificateIdentityPromise;
  };

  return Object.freeze({
    kind: "darwin-platform",

    async signFile({ filePath, platform, role, profile }) {
      assertDarwinProfile(platform, profile);
      if (role !== "provider") {
        throw new SigningContractError(
          "darwin_signing_role_invalid",
          `Darwin provider signer cannot sign ${String(role)}`,
        );
      }
      const beforeSha256 = await sha256File(filePath);
      await runCommand(CODESIGN, [
        "--force",
        "--sign",
        identity,
        "--identifier",
        PROVIDER_IDENTIFIER,
        "--options",
        "runtime",
        "--timestamp=none",
        "--entitlements",
        entitlementsPath,
        filePath,
      ]);
      await runCommand(CODESIGN, [
        "--verify",
        "--strict",
        "--all-architectures",
        "--verbose=4",
        filePath,
      ]);
      const codeSignature = await inspectDarwinCodeSignature(filePath);
      assertProviderCodeSignature(codeSignature, expectedTeamId);
      const certificate = await certificateIdentity();
      return Object.freeze({
        ...signerProfileIdentity(profile, certificate),
        role,
        scheme: "AppleCodeSign",
        teamId: codeSignature.teamId,
        codeIdentifier: codeSignature.codeIdentifier,
        cdhash: codeSignature.cdhash,
        hardenedRuntime: codeSignature.hardenedRuntime,
        designatedRequirement: codeSignature.designatedRequirement,
        designatedRequirementSha256: codeSignature.designatedRequirementSha256,
        entitlementsCanonicalSha256: codeSignature.entitlementsCanonicalSha256,
        beforeSha256,
        afterSha256: await sha256File(filePath),
      });
    },

    async signBundle({ filePath, platform, role, profile }) {
      assertDarwinProfile(platform, profile);
      if (role !== "outer-app-bundle" || !bundleSignOptions) {
        throw new SigningContractError(
          "darwin_bundle_sign_invalid",
          `Darwin bundle signer received an invalid target: ${filePath}`,
        );
      }
      const mainExecutable = await resolveBundleMainExecutable(filePath);
      const beforeSha256 = await sha256File(mainExecutable);
      const originalOptionsForFile = bundleSignOptions.optionsForFile;
      await sign({
        ...bundleSignOptions,
        app: filePath,
        identity,
        identityValidation: true,
        ignore: combineDarwinSignIgnore(
          bundleSignOptions.ignore,
          (candidate) => isPackagedDarwinProviderPath(candidate),
        ),
        optionsForFile(candidate) {
          return {
            ...(typeof originalOptionsForFile === "function"
              ? originalOptionsForFile(candidate)
              : {}),
            hardenedRuntime: true,
            timestamp: "none",
          };
        },
        preEmbedProvisioningProfile: false,
        strictVerify: true,
      });
      await runCommand(CODESIGN, [
        "--verify",
        "--deep",
        "--strict",
        "--all-architectures",
        "--verbose=4",
        filePath,
      ]);
      const codeSignature = await inspectDarwinCodeSignature(mainExecutable, {
        includeEntitlements: false,
      });
      if (codeSignature.teamId !== expectedTeamId || !codeSignature.hardenedRuntime) {
        throw new SigningContractError(
          "darwin_outer_identity_mismatch",
          "Signed Ling app does not match the expected Team ID and hardened runtime",
        );
      }
      const certificate = await certificateIdentity();
      return Object.freeze({
        ...signerProfileIdentity(profile, certificate),
        role,
        scheme: "AppleCodeSign",
        teamId: codeSignature.teamId,
        beforeSha256,
        afterSha256: await sha256File(mainExecutable),
      });
    },
  });
}

export async function inspectDarwinCodeSignature(
  filePath,
  { includeEntitlements = true } = {},
) {
  const details = await runCommand(CODESIGN, [
    "--display",
    "--verbose=4",
    "--arch",
    "arm64",
    filePath,
  ]);
  const parsedDetails = parseDarwinCodeSignatureDetails(
    `${details.stdout}\n${details.stderr}`,
  );
  const requirements = await runCommand(CODESIGN, [
    "--display",
    "--requirements",
    "-",
    "--arch",
    "arm64",
    filePath,
  ]);
  const designatedRequirement = parseDesignatedRequirement(
    `${requirements.stdout}\n${requirements.stderr}`,
  );
  let entitlementsCanonicalSha256;
  if (includeEntitlements) {
    const entitlements = await runCommand(CODESIGN, [
      "--display",
      "--entitlements",
      "-",
      "--xml",
      "--arch",
      "arm64",
      filePath,
    ]);
    const plist = extractPlist(`${entitlements.stdout}\n${entitlements.stderr}`);
    const json = await runCommand(PLUTIL, ["-convert", "json", "-o", "-", "--", "-"], {
      stdin: plist,
    });
    const parsedEntitlements = parseBooleanEntitlements(json.stdout);
    if (canonicalJson(parsedEntitlements) !== canonicalJson(REQUIRED_PROVIDER_ENTITLEMENTS)) {
      throw new SigningContractError(
        "darwin_provider_entitlements_mismatch",
        "Signed provider entitlements differ from the locked allowlist",
      );
    }
    entitlementsCanonicalSha256 = sha256Text(canonicalJson(parsedEntitlements));
  }
  return Object.freeze({
    ...parsedDetails,
    designatedRequirement,
    designatedRequirementSha256: sha256Text(designatedRequirement),
    ...(entitlementsCanonicalSha256 ? { entitlementsCanonicalSha256 } : {}),
  });
}

export function parseDarwinCodeSignatureDetails(output) {
  const lines = output.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  const valueFor = (prefix) =>
    lines.find((line) => line.startsWith(prefix))?.slice(prefix.length).trim();
  const codeIdentifier = valueFor("Identifier=");
  const teamId = valueFor("TeamIdentifier=");
  const cdhash = valueFor("CDHash=")?.toLowerCase();
  const codeDirectory = lines.find((line) => line.startsWith("CodeDirectory "));
  const signerSubject = lines
    .find((line) => line.startsWith("Authority="))
    ?.slice("Authority=".length)
    .trim();
  if (
    !codeIdentifier
    || !teamId
    || !/^[A-Z0-9]{10}$/u.test(teamId)
    || !cdhash
    || !/^[0-9a-f]{40}$/u.test(cdhash)
    || !codeDirectory
    || !signerSubject
  ) {
    throw new SigningContractError(
      "darwin_codesign_details_invalid",
      "codesign did not report one complete Darwin identity",
    );
  }
  return Object.freeze({
    codeIdentifier,
    teamId,
    cdhash,
    signerSubject,
    hardenedRuntime: /(?:\(|,)runtime(?:\)|,)/u.test(codeDirectory),
  });
}

export function parseDesignatedRequirement(output) {
  const requirement = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.startsWith("designated =>"))
    ?.replace(/^designated\s*=>\s*/u, "")
    .trim();
  if (!requirement) {
    throw new SigningContractError(
      "darwin_designated_requirement_missing",
      "codesign did not report a designated requirement",
    );
  }
  return requirement;
}

function assertDarwinProfile(platform, profile) {
  if (
    platform !== "darwin"
    || !profile
    || profile.signingTier === "unsigned_dev"
  ) {
    throw new SigningContractError(
      "darwin_signing_profile_invalid",
      "Real Darwin signing requires a signed internal or production profile",
    );
  }
}

function assertProviderCodeSignature(identity, expectedTeamId) {
  if (
    identity.teamId !== expectedTeamId
    || identity.codeIdentifier !== PROVIDER_IDENTIFIER
    || identity.hardenedRuntime !== true
  ) {
    throw new SigningContractError(
      "darwin_provider_identity_mismatch",
      "Signed provider identity differs from the locked Ling identity",
    );
  }
}

function signerProfileIdentity(profile, certificate) {
  return Object.freeze({
    signingTier: profile.signingTier,
    distributionChannel: profile.distributionChannel,
    authorityKind:
      profile.signingTier === "production_signed"
        ? "platform-release"
        : profile.testAuthorityKind,
    testOnly: profile.signingTier !== "production_signed",
    signerSubject: certificate.signerSubject,
    certificateSha256: certificate.certificateSha256,
  });
}

async function inspectCertificateIdentity(identity) {
  const result = await runCommand(SECURITY, [
    "find-certificate",
    "-c",
    identity,
    "-p",
  ]);
  const pem = result.stdout;
  const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/u.exec(pem);
  if (!match) {
    throw new SigningContractError(
      "darwin_signing_certificate_missing",
      `Unable to export signing certificate ${identity}`,
    );
  }
  const der = Buffer.from(match[1].replace(/\s+/gu, ""), "base64");
  if (der.length === 0) {
    throw new SigningContractError(
      "darwin_signing_certificate_invalid",
      "Signing certificate export is empty",
    );
  }
  return Object.freeze({
    signerSubject: identity,
    certificateSha256: createHash("sha256").update(der).digest("hex"),
  });
}

async function resolveBundleMainExecutable(appPath) {
  const executableDirectory = join(appPath, "Contents", "MacOS");
  const entries = (await readdir(executableDirectory, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  if (entries.length !== 1) {
    throw new SigningContractError(
      "darwin_bundle_main_executable_invalid",
      `Expected one main executable in ${executableDirectory}`,
    );
  }
  return join(executableDirectory, entries[0]);
}

export function combineDarwinSignIgnore(existing, providerPredicate) {
  const values = existing === undefined
    ? []
    : Array.isArray(existing)
      ? existing
      : [existing];
  return (candidate) =>
    values.some((ignore) =>
      typeof ignore === "function"
        ? ignore(candidate)
        : String(candidate).match(ignore) !== null,
    ) || providerPredicate(candidate);
}

export function isPackagedDarwinProviderPath(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/").toLowerCase();
  return normalized.includes("providers/cua-driver/")
    && basename(normalized) === "ling-cua-driver";
}

function extractPlist(output) {
  const start = output.indexOf("<?xml");
  const end = output.lastIndexOf("</plist>");
  if (start < 0 || end < start) {
    throw new SigningContractError(
      "darwin_entitlements_plist_missing",
      "codesign did not return an entitlements plist",
    );
  }
  return `${output.slice(start, end + "</plist>".length).trim()}\n`;
}

function parseBooleanEntitlements(output) {
  let value;
  try {
    value = JSON.parse(output);
  } catch (error) {
    throw new SigningContractError(
      "darwin_entitlements_json_invalid",
      "plutil did not return valid entitlement JSON",
      { cause: error },
    );
  }
  if (
    !value
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.values(value).some((entry) => entry !== true)
  ) {
    throw new SigningContractError(
      "darwin_entitlements_shape_invalid",
      "Provider entitlements must be a boolean allowlist",
    );
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
    ),
  );
}

async function runCommand(executable, args, options = {}) {
  return new Promise((settle, reject) => {
    const child = spawn(executable, args, {
      env: { ...process.env, LANG: "C", LC_ALL: "C" },
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    const collect = (target) => (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_COMMAND_OUTPUT_BYTES) {
        child.kill();
        reject(new SigningContractError(
          "darwin_signing_output_oversize",
          `${executable} exceeded the bounded output limit`,
        ));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (code !== 0 || signal) {
        reject(new SigningContractError(
          "darwin_signing_command_failed",
          `${executable} failed (${String(code)}, ${String(signal)}): ${result.stderr.trim()}`,
        ));
        return;
      }
      settle(result);
    });
    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, "utf8");
    } else {
      child.stdin.end();
    }
  });
}

function requireText(value, code) {
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new SigningContractError(code, code);
  }
  return value;
}

function requireTeamId(value) {
  if (typeof value !== "string" || !/^[A-Z0-9]{10}$/u.test(value)) {
    throw new SigningContractError(
      "darwin_signing_team_id_invalid",
      "Darwin signer requires one exact 10-character Team ID",
    );
  }
  return value;
}

function sha256Text(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export const DARWIN_PROVIDER_ENTITLEMENTS = REQUIRED_PROVIDER_ENTITLEMENTS;
