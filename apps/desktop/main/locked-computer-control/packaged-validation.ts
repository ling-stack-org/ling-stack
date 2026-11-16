import { createHash, randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import type { LockedComputerControlGrantV1 } from "@ling-stack/contracts";
import {
  LOCKED_USE_PACKAGED_VALIDATION_FACTS, parseLockedUsePackagedValidationReport,
  type LockedUsePackagedValidationReport, type LockedUseValidationCandidate,
} from "../../shared/locked-use-validation-contract.js";
import { RestrictedCuaDriverGeneration, type RestrictedCuaDriverCoordinator } from "../cua-driver/restricted-generation.js";
import type { CuaDriverCoordinatorOptions } from "../cua-driver/coordinator.js";
import type { DarwinLockedUseNativeClient } from "./darwin-locked-use-client.js";
import { parseLockedControlNativeIdentityResponse } from "./native-bridge.js";

const tools = Object.freeze(["get_window_state", "click"]);
type Native = Pick<DarwinLockedUseNativeClient, "readSession" | "readStatus" | "verifyIdentity" | "begin" | "check"
  | "providerHostProcessID" | "attachProvider" | "beginAction" | "finishAction" | "end" | "close">;

export interface LockedUseValidationFixture {
  readonly processID: number;
  readonly windowID: number;
  waitForCounter(value: number, signal: AbortSignal): Promise<void>;
}

/** Fixed fixture operations through the packaged coordinator and native gate. */
export async function runLockedUsePackagedValidation(options: {
  readonly candidate: LockedUseValidationCandidate;
  readonly candidateSha256: string;
  readonly packageCodeHash: string;
  readonly workspaceCwd: string;
  readonly fixture: LockedUseValidationFixture;
  readonly signal: AbortSignal;
  readonly createNative: (onRevoked: () => void) => Native;
  readonly createCoordinator: (input: Pick<CuaDriverCoordinatorOptions, "generationFloor" | "actionGate" | "providerLifetime">) => RestrictedCuaDriverCoordinator;
  readonly connect: (generation: number, signal: AbortSignal) => Promise<(name: string, args: Readonly<Record<string, unknown>>) => Promise<unknown>>;
  readonly onPhase: (phase: string) => void;
}): Promise<{ report: LockedUsePackagedValidationReport; beforeImage: Buffer; afterImage: Buffer }> {
  const startedAt = new Date().toISOString();
  const { signal } = options;
  let generation: RestrictedCuaDriverGeneration | undefined;
  let observer: Native | undefined;
  let ended = false;
  const revoked = () => {
    generation?.closeCallGate("locked_use_validation_revoked");
  };
  signal.addEventListener("abort", revoked, { once: true });
  const native = options.createNative(revoked);
  try {
    signal.throwIfAborted();
    const initial = await native.readSession(signal);
    if (!initial.sessionActive || initial.sessionLocked) throw new Error("locked_use_validation_unlocked_session_required");
    const status = await native.readStatus(signal);
    if (status.productCapability !== "supported_restricted") throw new Error("locked_use_validation_native_acceptance_required");
    options.onPhase("local_identity_verification");
    const identity = parseLockedControlNativeIdentityResponse(await native.verifyIdentity({
      requestId: randomUUID(), platform: "darwin", localizedReason: "Validate protected Computer Use with a disposable counter window", signal,
    }));
    if (identity?.status !== "verified") throw new Error("locked_use_validation_identity_not_verified");
    await options.fixture.waitForCounter(0, signal);
    const consentSession = await native.readSession(signal);
    if (!consentSession.sessionActive || consentSession.sessionLocked
      || consentSession.sessionBindingDigest !== initial.sessionBindingDigest) throw new Error("locked_use_validation_session_changed");
    options.onPhase("waiting_for_manual_lock");
    await waitForSession(native, initial.sessionBindingDigest, true, signal);
    const now = Date.now();
    const grant: LockedComputerControlGrantV1 = {
      schemaVersion: 1, grantId: randomUUID(), runId: randomUUID(), computerUseSessionId: randomUUID(),
      issuedAt: new Date(now).toISOString(), expiresAt: new Date(now + 240_000).toISOString(), ttlSeconds: 240,
      workspaceCwd: options.workspaceCwd, platform: "darwin", desktopInstanceId: "locked-use-validation-" + randomUUID(),
      desktopInstanceEpoch: 1, daemonAuthorityEpoch: randomUUID(), bridgeConnectionId: randomUUID(),
      authorizedNormalGeneration: 0, authorizedLockEpoch: 1, osSessionBindingDigest: initial.sessionBindingDigest,
      allowedLockedToolIdsDigest: digest(Buffer.from(JSON.stringify(tools))),
    };
    let reserved = 0;
    generation = new RestrictedCuaDriverGeneration({
      currentGeneration: () => 0, advanceNormalGenerationFloor: value => { reserved = value; },
      createCoordinator: options.createCoordinator, native, allowedToolIds: tools,
      isAuthorityCurrent: candidate => !signal.aborted && candidate.grantId === grant.grantId
        && candidate.osSessionBindingDigest === initial.sessionBindingDigest,
    });
    generation.reserve();
    options.onPhase("starting_protected_provider");
    await native.begin(grant, reserved, signal);
    await generation.start({ generation: reserved, grant, holdActionAdmission: true });
    const snapshot = await generation.waitUntilReady(signal);
    if (snapshot.permissions?.accessibility !== "granted" || snapshot.permissions.screenRecording !== "granted"
      || snapshot.permissions.capturable !== true) throw new Error("locked_use_validation_provider_permissions_required");
    await native.check(signal);
    const managed = await native.readSession(signal);
    if (!managed.sessionActive || managed.sessionLocked || managed.sessionBindingDigest !== initial.sessionBindingDigest) {
      throw new Error("locked_use_validation_managed_session_mismatch");
    }
    generation.openActionAdmission();
    const call = await options.connect(reserved, signal);
    const target = Object.freeze({ pid: options.fixture.processID, window_id: options.fixture.windowID });
    options.onPhase("capturing_and_clicking_fixture");
    const before = await call("get_window_state", { ...target, include_screenshot: true });
    const beforeImage = captureImage(before, options.fixture);
    const beforePixelsSha256 = await pixelsDigest(beforeImage);
    const button = incrementButtonIndex(before);
    const click = await call("click", { ...target, element_index: button, delivery_mode: "background" });
    if (!record(click) || click.isError === true) throw new Error("locked_use_validation_provider_input_failed");
    await options.fixture.waitForCounter(1, signal);
    const afterImage = captureImage(await call("get_window_state", { ...target, include_screenshot: true }), options.fixture);
    const afterPixelsSha256 = await pixelsDigest(afterImage);
    if (beforePixelsSha256 === afterPixelsSha256) throw new Error("locked_use_validation_unchanged_window_capture");
    await native.check(signal);
    signal.throwIfAborted();
    options.onPhase("stopping_provider_and_relocking");
    await generation.stop("locked_use_validation_complete");
    ended = true;
    observer = options.createNative(() => undefined);
    const locked = await observer.readSession(signal);
    if (!locked.sessionActive || !locked.sessionLocked || locked.sessionBindingDigest !== initial.sessionBindingDigest) {
      throw new Error("locked_use_validation_relock_not_observed");
    }
    options.onPhase("waiting_for_manual_unlock");
    await waitForSession(observer, initial.sessionBindingDigest, false, signal);
    await options.fixture.waitForCounter(1, signal);
    signal.throwIfAborted();
    const report = parseLockedUsePackagedValidationReport({
      schemaVersion: 1, kind: "packaged_gui_capture_input", result: "passed", productCapability: "disabled_by_build",
      candidateSha256: options.candidateSha256, nativeBuildManifestSha256: options.candidate.expectedBuildManifestSha256,
      providerCodeHash: options.candidate.providerCodeHash, fixtureExecutableSha256: options.candidate.fixtureExecutableSha256,
      packageCodeHash: options.packageCodeHash, osBuild: options.candidate.osBuild, architecture: "arm64", startedAt,
      completedAt: new Date().toISOString(), counterBefore: 0, counterAfter: 1,
      beforeImageSha256: digest(beforeImage), afterImageSha256: digest(afterImage),
      beforePixelsSha256, afterPixelsSha256,
      facts: Object.fromEntries(LOCKED_USE_PACKAGED_VALIDATION_FACTS.map(key => [key, true])),
    });
    return { report, beforeImage, afterImage };
  } catch (error) {
    try {
      if (!ended) {
        if (generation) await generation.stop("locked_use_validation_failed");
        else await native.end();
      }
    } catch (cleanup) { throw new AggregateError([error, cleanup], "locked_use_validation_cleanup_unconfirmed"); }
    throw error;
  } finally {
    signal.removeEventListener("abort", revoked);
    observer?.close();
  }
}

async function waitForSession(native: Native, digest: string, locked: boolean, signal: AbortSignal): Promise<void> {
  const deadline = performance.now() + 120_000;
  while (performance.now() < deadline) {
    signal.throwIfAborted();
    const session = await native.readSession(signal);
    if (!session.sessionActive || session.sessionBindingDigest !== digest) throw new Error("locked_use_validation_session_changed");
    if (session.sessionLocked === locked) return;
    await wait(200, undefined, { signal });
  }
  throw new Error("locked_use_validation_manual_transition_timeout");
}

export function captureImage(result: unknown, target: Pick<LockedUseValidationFixture, "processID" | "windowID">): Buffer {
  if (!record(result) || result.isError === true || !Array.isArray(result.content)) throw new Error("locked_use_validation_capture_failed");
  if (!record(result.structuredContent) || result.structuredContent.pid !== target.processID
    || result.structuredContent.window_id !== target.windowID) throw new Error("locked_use_validation_capture_target_mismatch");
  const images = result.content.filter(item => record(item) && item.type === "image" && item.mimeType === "image/png");
  if (images.length !== 1 || !record(images[0]) || typeof images[0].data !== "string"
    || images[0].data.length > 16 * 1024 * 1024) throw new Error("locked_use_validation_image_missing");
  const image = Buffer.from(images[0].data, "base64");
  if (image.length < 24 || image.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
    || image.toString("base64") !== images[0].data || image.readUInt32BE(16) === 0 || image.readUInt32BE(20) === 0
    || image.readUInt32BE(16) > 4096 || image.readUInt32BE(20) > 4096) {
    throw new Error("locked_use_validation_image_invalid");
  }
  return image;
}

async function pixelsDigest(bytes: Buffer): Promise<string> {
  const image = await loadImage(bytes);
  const canvas = createCanvas(image.width, image.height);
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return digest(new Uint8Array(context.getImageData(0, 0, image.width, image.height).data));
}

function incrementButtonIndex(result: unknown): number {
  const content = record(result) && record(result.structuredContent) ? result.structuredContent : undefined;
  const buttons = Array.isArray(content?.elements) ? content.elements.filter(item => record(item)
    && item.role === "AXButton" && item.label === "Increment" && Number.isSafeInteger(item.element_index)
    && (item.element_index as number) >= 0) : [];
  if (buttons.length !== 1) throw new Error("locked_use_validation_fixture_button_missing");
  return (buttons[0] as Record<string, unknown>).element_index as number;
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function digest(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
