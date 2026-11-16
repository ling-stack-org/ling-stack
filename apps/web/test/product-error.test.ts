import assert from "node:assert/strict";
import test from "node:test";
import { toProductError, type ProductErrorTranslate } from "../src/lib/product-error.ts";

const zhMessages: Readonly<Record<string, string>> = {
  "API key is missing. Add it and try again.": "缺少 API 密钥，请添加后重试。",
  "Authentication failed. Check the API key and account permissions, then try again.": "身份验证失败，请检查 API 密钥和账户权限后重试。",
  "Permission denied. Check account permissions and try again.": "没有操作权限，请检查账户权限后重试。",
  "Some information is invalid. Check the fields and try again.": "部分信息无效，请检查后重试。",
  "Could not connect to the local service. Check its status and try again.": "无法连接本地服务，请检查服务状态后重试。",
  "The request timed out. Try again.": "请求超时，请重试。",
  "The service is temporarily unavailable. Try again shortly.": "服务暂时不可用，请稍后重试。",
  "Could not save the model preset. Check the settings and try again.": "无法保存模型预设，请检查设置后重试。",
};

const translate: ProductErrorTranslate = (key) => zhMessages[key] ?? key;

test("unknown runtime text becomes localized product copy and preserves technical detail", () => {
  const result = toProductError(
    new Error("Synthetic provider save failure"),
    translate,
    { fallbackMessage: "Could not save the model preset. Check the settings and try again." },
  );

  assert.equal(result.message, "无法保存模型预设，请检查设置后重试。");
  assert.equal(result.technicalMessage, "Synthetic provider save failure");
  assert.equal(result.code, "unknown");
});

test("structured daemon code wins over raw message text", () => {
  const result = toProductError(
    { code: "secret_missing", message: "backend wording may change", status: 400 },
    translate,
  );

  assert.equal(result.message, "缺少 API 密钥，请添加后重试。");
  assert.equal(result.technicalMessage, "backend wording may change");
  assert.equal(result.code, "secret_missing");
  assert.equal(result.status, 400);
});

test("structured code and status win over contradictory raw message text", () => {
  assert.equal(
    toProductError(
      { code: "validation_failed", status: 422, message: "The timeout field is invalid" },
      translate,
    ).message,
    "部分信息无效，请检查后重试。",
  );
  assert.equal(
    toProductError(
      { code: "permission_denied", status: 403, message: "Upstream returned unauthorized" },
      translate,
    ).message,
    "没有操作权限，请检查账户权限后重试。",
  );
  assert.equal(
    toProductError(
      { status: 503, message: "Request timed out while reporting service failure" },
      translate,
    ).message,
    "服务暂时不可用，请稍后重试。",
  );
});

test("operation-specific copy may refine a stable error code without exposing raw text", () => {
  const result = toProductError(
    { code: "network_failed", status: 400, message: "Provider socket closed" },
    translate,
    { codeMessages: { network_failed: "Could not save the model preset. Check the settings and try again." } },
  );

  assert.equal(result.message, "无法保存模型预设，请检查设置后重试。");
  assert.equal(result.technicalMessage, "Provider socket closed");
  assert.equal(result.code, "network_failed");
});

test("HTTP status and transport signals map to stable product messages", () => {
  assert.equal(
    toProductError({ status: 401, message: "Unauthorized" }, translate).message,
    "身份验证失败，请检查 API 密钥和账户权限后重试。",
  );
  assert.equal(
    toProductError(new TypeError("Failed to fetch"), translate).message,
    "无法连接本地服务，请检查服务状态后重试。",
  );
  assert.equal(
    toProductError({ status: 504, message: "Gateway Timeout" }, translate).message,
    "请求超时，请重试。",
  );
  assert.equal(
    toProductError({ status: 503, message: "Synthetic service failure" }, translate).message,
    "服务暂时不可用，请稍后重试。",
  );
});
