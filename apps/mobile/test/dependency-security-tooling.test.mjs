import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const localRequire = createRequire(import.meta.url);
const expoRequire = createRequire(localRequire.resolve("expo/package.json"));
const cliRequire = createRequire(expoRequire.resolve("@expo/cli/package.json"));
const signingPath = cliRequire.resolve("@expo/code-signing-certificates");
const signing = cliRequire("@expo/code-signing-certificates");
const forge = createRequire(signingPath)("node-forge");
const metroRequire = createRequire(expoRequire.resolve("metro/package.json"));
const fileMapRequire = createRequire(metroRequire.resolve("metro-file-map/package.json"));
const braces = createRequire(fileMapRequire.resolve("micromatch"))("braces");
const { z } = cliRequire("zod");
const { z: legacyZod } = cliRequire("zod/v3");
const { PluginSchema, DevToolsPluginOutputSchema } =
  cliRequire("./build/src/start/server/DevToolsPlugin.schema.js");
const { createMCPDevToolsExtensionSchema } =
  cliRequire("./build/src/start/server/createMCPDevToolsExtensionSchema.js");
const { addMcpCapabilities } =
  cliRequire("./build/src/start/server/MCPDevToolsPluginCLIExtensions.js");
const daemonRequire = createRequire(new URL("../../../packages/daemon/package.json", import.meta.url));
const mcpSdkRequire = createRequire(daemonRequire.resolve("@modelcontextprotocol/sdk/server/mcp.js"));
const { zodToJsonSchema } = mcpSdkRequire("zod-to-json-schema");
const pem = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const keyPair = signing.convertKeyPairPEMToKeyPair({
  publicKeyPEM: pem.publicKey,
  privateKeyPEM: pem.privateKey,
});
const digest = forge.md.sha256.create().update("dependency-security-test").digest().getBytes();

function digestInfo({ parameters = true, extra = false } = {}) {
  const { asn1 } = forge;
  const algorithm = [asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false,
    asn1.oidToDer(forge.oids.sha256).getBytes())];
  if (parameters) {
    algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, ""));
  }
  if (extra) {
    algorithm.push(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, "garbage"));
  }
  return asn1.toDer(asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, [
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, algorithm),
    asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, digest),
  ])).getBytes();
}

function devToolsPlugin() {
  return {
    packageName: "dependency-security-plugin",
    packageRoot: "/fixture/plugin",
    cliExtensions: {
      description: "Inspect development tools",
      entryPoint: "tools.js",
      commands: [
        {
          name: "inspect",
          title: "Inspect",
          environments: ["mcp"],
          parameters: [
            { name: "query", type: "text" },
            { name: "count", type: "number" },
            { name: "confirm", type: "confirm" },
          ],
        },
        { name: "ping", title: "Ping", environments: ["cli", "mcp"] },
      ],
    },
  };
}

test("Expo's node-forge rejects extra nested DigestAlgorithm elements (GHSA-86w9-cpqp-85rv)", () => {
  for (const parameters of [true, false]) {
    const signature = keyPair.privateKey.sign(digestInfo({ parameters, extra: true }), "NONE");
    assert.throws(() => keyPair.publicKey.verify(digest, signature), /valid RSASSA-PKCS1-v1_5 DigestInfo/);
  }
});

test("node-forge preserves valid SHA-256 DigestInfo with optional NULL parameters", () => {
  for (const parameters of [true, false]) {
    const signature = keyPair.privateKey.sign(digestInfo({ parameters }), "NONE");
    assert.equal(keyPair.publicKey.verify(digest, signature), true);
  }
});

test("Expo code-signing certificates and signatures still round-trip", () => {
  const certificate = signing.generateSelfSignedCodeSigningCertificate({
    keyPair,
    validityNotBefore: new Date(Date.now() - 60_000),
    validityNotAfter: new Date(Date.now() + 86_400_000),
    commonName: "Ling dependency security test",
  });
  const restored = signing.convertCertificatePEMToCertificate(
    signing.convertCertificateToCertificatePEM(certificate),
  );
  assert.doesNotThrow(() => signing.validateSelfSignedCertificate(restored, keyPair));
  const payload = Buffer.from("expo-update-manifest");
  const signature = signing.signBufferRSASHA256AndVerify(keyPair.privateKey, restored, payload);
  const hash = forge.md.sha256.create().update(payload.toString("binary")).digest().getBytes();
  assert.equal(restored.publicKey.verify(hash, forge.util.decode64(signature)), true);
  const otherHash = forge.md.sha256.create().update("tampered-manifest").digest().getBytes();
  assert.equal(restored.publicKey.verify(otherHash, forge.util.decode64(signature)), false);
});

test("Metro's braces rejects deeply nested braces and parentheses before walking (GHSA-vfj7-8cjw-p6xm)", () => {
  for (const [open, close] of [["{", "}"], ["(", ")"]]) {
    const pattern = open.repeat(500) + "a,b" + close.repeat(500);
    for (const method of ["parse", "compile", "expand", "stringify", "create"]) {
      assert.throws(() => braces[method](pattern), (error) =>
        error instanceof SyntaxError && /nesting exceeds max depth/.test(error.message));
    }
    assert.throws(() => braces(pattern), /nesting exceeds max depth/);
    assert.throws(() => braces(pattern, { expand: true }), /nesting exceeds max depth/);
  }
});

test("braces guards caller-supplied deep and cyclic ASTs", () => {
  let nested = { type: "text", value: "safe" };
  for (let i = 0; i < 500; i++) {
    nested = { type: "paren", nodes: [nested] };
  }
  const cyclic = { type: "root", nodes: [] };
  cyclic.nodes.push(cyclic);
  for (const ast of [{ type: "root", nodes: [nested] }, cyclic]) {
    for (const method of ["compile", "expand", "stringify"]) {
      assert.throws(() => braces[method](ast), /nesting exceeds max depth/);
    }
  }
});

test("braces preserves normal glob compilation, expansion and literal escaping", () => {
  assert.equal(braces.compile("src/{app,lib}/**/*.{js,ts}"), "src/(app|lib)/**/*.(js|ts)");
  assert.deepEqual(braces.expand("file-{01..03}.{js,ts}"), [
    "file-01.js", "file-01.ts", "file-02.js", "file-02.ts", "file-03.js", "file-03.ts",
  ]);
  const pattern = "src/{app,{lib,test}}/x";
  assert.equal(braces.stringify(braces.parse(pattern)), pattern);
  const escaped = "\\{".repeat(150) + "x" + "\\}".repeat(150);
  assert.doesNotThrow(() => braces.compile(escaped));
  const quoted = '"' + "{".repeat(150) + "}".repeat(150) + '"';
  assert.doesNotThrow(() => braces.compile(quoted));
  const boundary = "{".repeat(100) + "x" + "}".repeat(100);
  assert.equal(braces.stringify(braces.parse(boundary)), boundary);
});

test("Expo's Zod rejects oversized bounded arrays before visiting elements", () => {
  let elementVisits = 0;
  const schema = z.array(z.string().transform((value) => {
    elementVisits++;
    return value.toUpperCase();
  })).max(2);
  const oversized = schema.safeParse(["a", "b", "c"]);
  assert.equal(oversized.success, false);
  assert.equal(oversized.error.issues[0].code, "too_big");
  assert.equal(elementVisits, 0);
  assert.deepEqual(schema.parse(["a", "b"]), ["A", "B"]);
  assert.equal(elementVisits, 2);
});

test("Expo's DevTools plugin schema preserves command and parameter validation", () => {
  const plugin = devToolsPlugin();
  assert.deepEqual(PluginSchema.parse(plugin), plugin);
  for (const invalid of [
    { ...plugin, packageName: "" },
    { ...plugin, packageRoot: "" },
    { ...plugin, cliExtensions: { ...plugin.cliExtensions, commands: [] } },
    {
      ...plugin,
      cliExtensions: {
        ...plugin.cliExtensions,
        commands: [{
          ...plugin.cliExtensions.commands[0],
          parameters: [{ name: "query", type: "object" }],
        }],
      },
    },
  ]) {
    assert.equal(PluginSchema.safeParse(invalid).success, false);
  }
});

test("Expo's DevTools output schema preserves text, audio and image validation", () => {
  const output = [
    { type: "text", text: "Ready", level: "info" },
    { type: "audio", url: "https://example.com/audio.mp3" },
    { type: "image", url: "https://example.com/image.png", text: "Preview" },
  ];
  assert.deepEqual(DevToolsPluginOutputSchema.parse(output), output);
  for (const invalid of [
    { type: "video", url: "https://example.com/video.mp4" },
    { type: "text", text: "Missing level" },
    { type: "text", text: "Invalid level", level: "debug" },
    { type: "audio", url: "invalid-url" },
    { type: "image" },
  ]) {
    assert.equal(DevToolsPluginOutputSchema.safeParse([invalid]).success, false);
  }
});

test("Expo's generated MCP schema preserves strict commands and optional typed parameters", () => {
  const plugin = devToolsPlugin();
  const schema = createMCPDevToolsExtensionSchema(plugin);
  const parameters = { command: "inspect", query: "status", count: 2, confirm: true };
  assert.deepEqual(schema.parse(parameters), parameters);
  assert.deepEqual(schema.parse({ command: "ping" }), { command: "ping" });
  for (const invalid of [
    {},
    { command: "unknown" },
    { ...parameters, query: 1 },
    { ...parameters, count: "2" },
    { ...parameters, confirm: "true" },
    { ...parameters, unexpected: true },
  ]) {
    assert.equal(schema.safeParse(invalid).success, false);
  }
  assert.throws(() => createMCPDevToolsExtensionSchema({ ...plugin, cliExtensions: undefined }), /no commands defined/);
  assert.throws(() => createMCPDevToolsExtensionSchema({
    ...plugin,
    cliExtensions: { ...plugin.cliExtensions, commands: [] },
  }), /no commands defined/);
});

test("Expo's MCP registration retains constraints through the legacy JSON schema converter", async () => {
  const plugin = devToolsPlugin();
  plugin.cliExtensions.commands.push({
    name: "local",
    title: "Local only",
    environments: ["cli"],
    parameters: [{ name: "localPath", type: "text" }],
  });
  const registrations = [];
  await addMcpCapabilities({
    registerTool(...args) {
      registrations.push(args);
    },
  }, {
    devtoolsPluginManager: {
      async queryPluginsAsync() {
        return [plugin];
      },
    },
  });
  assert.equal(registrations.length, 1);
  const [name, config, handler] = registrations[0];
  assert.equal(name, plugin.packageName);
  assert.equal(config.title, plugin.packageName);
  assert.equal(typeof handler, "function");
  assert.equal(config.inputSchema.parameters.safeParse({ command: "local" }).success, false);

  // Expo's optional MCP tunnel wraps inputSchema with Zod 3 before this conversion.
  const converted = zodToJsonSchema(legacyZod.object(config.inputSchema));
  assert.equal(converted.type, "object");
  assert.deepEqual(converted.required, ["parameters"]);
  const parameters = converted.properties.parameters;
  assert.equal(parameters.type, "object");
  assert.deepEqual(parameters.properties.command.enum, ["inspect", "ping"]);
  assert.equal(parameters.properties.command.type, "string");
  assert.equal(parameters.properties.query.type, "string");
  assert.equal(parameters.properties.count.type, "number");
  assert.equal(parameters.properties.confirm.type, "boolean");
  assert.equal(Object.hasOwn(parameters.properties, "localPath"), false);
  assert.deepEqual(parameters.required, ["command"]);
  assert.equal(parameters.additionalProperties, false);
});
