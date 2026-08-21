import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMediaProjectAssetByteLength,
  assertMediaProjectAssetDimensions,
} from "../dist/features/media/project-asset-routes.js";
import { assertProviderImageInputTotalBytes } from "../dist/features/media/video-image-materializer.js";

const MIB = 1024 * 1024;

test("media project image byte limits include the documented boundaries", () => {
  assert.doesNotThrow(() => assertMediaProjectAssetByteLength(1));
  assert.doesNotThrow(() => assertMediaProjectAssetByteLength(25 * MIB));
  assertInvalidMediaAsset(() => assertMediaProjectAssetByteLength(0), /1 字节到 25 MiB/);
  assertInvalidMediaAsset(() => assertMediaProjectAssetByteLength(25 * MIB + 1), /1 字节到 25 MiB/);
});

test("media project image dimension and aspect ratio limits include the documented boundaries", () => {
  for (const [width, height] of [
    [300, 300],
    [6000, 6000],
    [300, 750],
    [750, 300],
  ]) {
    assert.doesNotThrow(() => assertMediaProjectAssetDimensions(width, height));
  }

  for (const [width, height] of [
    [299, 300],
    [300, 299],
    [6001, 6000],
    [6000, 6001],
  ]) {
    assertInvalidMediaAsset(() => assertMediaProjectAssetDimensions(width, height), /300 到 6000/);
  }
  assertInvalidMediaAsset(() => assertMediaProjectAssetDimensions(300, 751), /0.4 到 2.5/);
  assertInvalidMediaAsset(() => assertMediaProjectAssetDimensions(751, 300), /0.4 到 2.5/);
});

test("provider image aggregate byte limit includes 45 MiB and rejects the next byte", () => {
  assert.doesNotThrow(() => assertProviderImageInputTotalBytes(45 * MIB));
  assertInvalidMediaAsset(() => assertProviderImageInputTotalBytes(45 * MIB + 1), /45 MiB/);
});

function assertInvalidMediaAsset(action, messagePattern) {
  assert.throws(
    action,
    (error) => error?.statusCode === 400
      && error?.code === "invalid_media_asset"
      && messagePattern.test(error.message),
  );
}
