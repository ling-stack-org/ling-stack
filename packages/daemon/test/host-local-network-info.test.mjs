import assert from "node:assert/strict";
import test from "node:test";
import { collectHostLocalNetworkInfo } from "../dist/features/runs/host-local-network-info.js";
import { hostLocalNetworkToolResult } from "../dist/features/runs/host-local-network-result.js";

const date = "2026-09-09T08:00:00.000Z";
const row = (address = "192.0.2.1", family = "IPv4", internal = false) => ({ address, family, internal,
  netmask: "private-mask", mac: "private-mac", cidr: "private-cidr", scopeid: 123 });
const collect = (raw, input = {}, overrides = {}) => collectHostLocalNetworkInfo(input, {
  readInterfaces: () => raw, now: () => new Date(date), ...overrides,
});

test("local interface collection filters defaults, sorts deterministically and selects only permitted fields", () => {
  const raw = { z: [row("2001:db8::2", "IPv6"), row("192.0.2.2")], lo: [row("127.0.0.1", "IPv4", true)], a: [row()], none: undefined };
  const before = structuredClone(raw);
  const result = collect(raw);
  assert.equal(result.status, "succeeded");
  assert.equal(result.collectedAt, date);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.addresses, [
    { interfaceName: "a", address: "192.0.2.1", family: "IPv4", internal: false },
    { interfaceName: "z", address: "192.0.2.2", family: "IPv4", internal: false },
    { interfaceName: "z", address: "2001:db8::2", family: "IPv6", internal: false },
  ]);
  assert.equal(/private-|netmask|scopeid|cidr|mac/.test(JSON.stringify(result)), false);
  assert.deepEqual(raw, before);
  assert.deepEqual(collect({ a: raw.a, lo: raw.lo, z: [...raw.z].reverse(), none: undefined }), result);
});

for (const family of ["IPv4", "IPv6"]) test(`local interface collection respects explicit ${family} and loopback inclusion`, () => {
  const raw = { lo: [row("127.0.0.1", "IPv4", true), row("::1", "IPv6", true)], tunnel: [row("2001:db8::3", "IPv6"), row()] };
  const result = collect(raw, { family, includeLoopback: true });
  assert.equal(result.addresses.length, 2);
  assert.ok(result.addresses.every(address => address.family === family));
  assert.ok(result.addresses.some(address => address.internal));
});

test("empty or filtered interfaces are a successful empty result, not invented loopback", () => {
  for (const raw of [{}, { none: undefined }, { lo: [row("127.0.0.1", "IPv4", true)] }]) {
    const result = collect(raw);
    assert.equal(result.status, "succeeded");
    assert.deepEqual(result.addresses, []);
    const tool = hostLocalNetworkToolResult(result);
    assert.equal(tool.isError, false);
    assert.match(tool.content[0].text, /No interface addresses matched/);
    assert.equal(tool.content[0].text.includes("127.0.0.1"), false);
  }
});

test("invalid query input fails before accessing OS and does not expand to public-IP or shell work", () => {
  let reads = 0;
  for (const input of [null, { family: "IPv5" }, { includeLoopback: "true" }, { publicIp: true }, { command: "ifconfig" }, { runId: "foreign" }]) {
    const result = collectHostLocalNetworkInfo(input, { readInterfaces: () => { reads += 1; return {}; } });
    assert.equal(result.status, "failed");
    assert.equal(result.code, "invalid_capability_input");
  }
  assert.equal(reads, 0);
});

test("OS errors and malformed records are structured failures without leaking raw diagnostics", () => {
  const failure = collect({}, {}, { readInterfaces: () => { throw new Error("private-host-diagnostic /Users/private/token"); } });
  assert.equal(failure.status, "failed");
  assert.equal(failure.code, "host_capability_failed");
  assert.equal(JSON.stringify(failure).includes("private"), false);
  assert.equal(hostLocalNetworkToolResult(failure).isError, true);
  for (const raw of [null, [], { a: "bad" }, { a: [null] }, { a: [row("not-an-ip")] },
    { a: [row("2001:db8::1", "IPv4")] }, { a: [{ ...row(), internal: "no" }] }]) {
    assert.equal(collect(raw).status, "failed");
  }
  assert.equal(collect({}, {}, { now: () => new Date("invalid") }).status, "failed");
});

test("interface and address limits bound actual returned facts and mark truncation", () => {
  const interfaces = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`interface${String(i).padStart(3, "0")}`, [row()]]));
  const first = collect(interfaces);
  assert.equal(new Set(first.addresses.map(address => address.interfaceName)).size, 64);
  assert.equal(first.truncated, true);
  const addresses = Array.from({ length: 300 }, (_, i) => row(`192.0.${Math.floor(i / 256)}.${i % 256}`));
  const second = collect({ interface: addresses });
  assert.equal(second.addresses.length, 256);
  assert.equal(second.truncated, true);
  assert.equal(collect({ interface: addresses.slice(0, 256) }).truncated, false);
});

test("UTF-8 result byte budget keeps whole addresses and does not claim filtered emptiness after truncation", () => {
  const name = "界".repeat(12000);
  const result = collect({ [name]: [row()] });
  assert.equal(result.status, "succeeded");
  assert.equal(result.truncated, true);
  assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8") <= 32 * 1024, true);
  assert.deepEqual(result.addresses, []);
  const tool = hostLocalNetworkToolResult(result);
  assert.match(tool.content[0].text, /truncated/);
  assert.equal(tool.content[0].text.includes("No interface addresses matched"), false);
});

test("tool text is readable, bounded, and escapes interface names as data while keeping atomic facts", () => {
  const name = "interface\n\u001b[31m<script>\u202e";
  const raw = { [name]: Array.from({ length: 100 }, (_, i) => row(`192.0.2.${i}`)) };
  const result = collect(raw);
  const tool = hostLocalNetworkToolResult(result);
  assert.equal(tool.isError, false);
  assert.deepEqual(tool.details.hostCapabilityResult, result);
  const text = tool.content[0].text;
  assert.equal(Buffer.byteLength(text, "utf8") <= 8 * 1024, true);
  assert.equal(text.split("\n").length <= 40, true);
  assert.match(text, /display truncated/);
  assert.equal(/[\u001b\u202e]/u.test(text), false);
  assert.match(text, /not a public egress IP/);
  assert.equal(text.includes("exit 0"), false);
});

test("cancellation before and during collection does not return successful facts", () => {
  for (const when of ["before", "during"]) {
    const controller = new AbortController();
    let reads = 0;
    if (when === "before") controller.abort();
    assert.throws(() => collect({}, {}, { signal: controller.signal, readInterfaces: () => { reads += 1; controller.abort(); return {}; } }), { name: "AbortError" });
    assert.equal(reads, when === "before" ? 0 : 1);
  }
});

test("actual local OS collection returns only bounded interface facts without printing addresses", () => {
  const result = collectHostLocalNetworkInfo({ includeLoopback: true });
  assert.equal(result.status, "succeeded");
  assert.ok(Number.isFinite(Date.parse(result.collectedAt)));
  assert.equal(result.addresses.length <= 256, true);
  assert.equal(Buffer.byteLength(JSON.stringify(result), "utf8") <= 32 * 1024, true);
  for (const address of result.addresses) assert.deepEqual(Object.keys(address).sort(), ["address", "family", "interfaceName", "internal"]);
});
