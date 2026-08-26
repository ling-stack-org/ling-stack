import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertMediaProjectAssetByteLength,
  assertMediaProjectAssetDimensions,
} from "../dist/features/media/project-asset-routes.js";
import { inspectSupportedImage } from "../dist/features/media/image-inspection.js";
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

test("supported image dimension parsing covers PNG, JPEG, and WebP without image-size", () => {
  assert.deepEqual(inspectSupportedImage(createPngFixture(1280, 720)), {
    contentType: "image/png",
    width: 1280,
    height: 720,
  });
  assert.deepEqual(inspectSupportedImage(createJpegFixture(1280, 720)), {
    contentType: "image/jpeg",
    width: 1280,
    height: 720,
  });
  assert.deepEqual(inspectSupportedImage(createWebpFixture(1280, 720)), {
    contentType: "image/webp",
    width: 1280,
    height: 720,
  });
});

test("supported image dimension parsing rejects truncated containers", () => {
  assert.equal(inspectSupportedImage(Buffer.from("89504e470d0a1a0a", "hex")), undefined);
  const zeroLengthWebpBox = Buffer.alloc(20);
  zeroLengthWebpBox.write("RIFF", 0, "ascii");
  zeroLengthWebpBox.writeUInt32LE(12, 4);
  zeroLengthWebpBox.write("WEBP", 8, "ascii");
  zeroLengthWebpBox.write("meta", 12, "ascii");
  assert.equal(inspectSupportedImage(zeroLengthWebpBox), undefined);
});

function createPngFixture(width, height) {
  const chunk = (type, data) => {
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    result.write(type, 4, "ascii");
    data.copy(result, 8);
    return result;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    chunk("IHDR", ihdr),
    chunk("IDAT", Buffer.alloc(0)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function createJpegFixture(width, height) {
  const sof = Buffer.alloc(9);
  sof[0] = 8;
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  sof[5] = 3;
  sof[6] = 1;
  sof[7] = 0x11;
  sof[8] = 0;
  return Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 11]),
    sof,
    Buffer.from([0xff, 0xda, 0, 2, 0xff, 0xd9]),
  ]);
}

function createWebpFixture(width, height) {
  const data = Buffer.alloc(10);
  data.writeUIntLE(width - 1, 4, 3);
  data.writeUIntLE(height - 1, 7, 3);
  const chunk = Buffer.alloc(18);
  chunk.write("VP8X", 0, "ascii");
  chunk.writeUInt32LE(data.length, 4);
  data.copy(chunk, 8);
  const result = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP"), chunk]);
  result.writeUInt32LE(result.length - 8, 4);
  return result;
}

function assertInvalidMediaAsset(action, messagePattern) {
  assert.throws(
    action,
    (error) => error?.statusCode === 400
      && error?.code === "invalid_media_asset"
      && messagePattern.test(error.message),
  );
}
