import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, ftruncateSync, linkSync, mkdirSync, mkdtempSync, openSync, closeSync,
  readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createPackageWithOptions, extractFile, getRawHeader, listPackage, statFile, uncache } from "@electron/asar";

const scriptUrl = new URL("../scripts/packaged-office-native-asar-checks.mjs", import.meta.url).href;
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const cliEntry = "dist/daemon/cli.mjs";
let fixtureNumber = 0;
function newFile(path, bytes) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, bytes, { mode: 0o600 }); }

/** A real ASAR byte container with hand-authored adversarial headers, still parsed by installed @electron/asar. */
function rawArchive(header, data) {
  const json = Buffer.from(JSON.stringify(header));
  const pickle = Buffer.alloc(8 + Math.ceil(json.length / 4) * 4);
  pickle.writeUInt32LE(pickle.length - 4, 0); pickle.writeUInt32LE(json.length, 4); json.copy(pickle, 8);
  const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(pickle.length, 4);
  return Buffer.concat([prefix, pickle, data]);
}
function replaceHeader(f, change) {
  uncache(f.archive);
  const raw = getRawHeader(f.archive), before = readFileSync(f.archive);
  change(raw.header); writeFileSync(f.archive, rawArchive(raw.header, before.subarray(8 + raw.headerSize)));
}

/** Real ASAR create/parser APIs; only original publication readers and deliberate mutation hooks are synthetic. */
async function fixture(t) {
  const number = ++fixtureNumber, root = realpathSync(mkdtempSync(join(tmpdir(), "ling-office-asar-test-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const app = join(root, "Fixture.app"), archive = join(app, "Contents/Resources/app.asar"), source = join(root, "source");
  const cli = Buffer.from("TEST-ONLY REAL ASAR CLI BYTES\n");
  const addon = Buffer.from("TEST-ONLY NATIVE ORIGINAL SIGNED BYTES, NOT A REAL SIGNATURE");
  const pins = Object.freeze({ sizeBytes: cli.length, sha256: hash(cli) });
  const native = Object.freeze({ finalBinarySizeBytes: addon.length, finalBinarySha256: hash(addon) });
  newFile(join(source, cliEntry), cli); mkdirSync(dirname(archive), { recursive: true, mode: 0o700 });
  await createPackageWithOptions(source, archive, {});
  const state = { pins, native, pinReads: 0, nativeReads: 0, listCalls: 0, extractCalls: 0,
    afterExtract: undefined, afterPinRead: undefined, afterNativeRead: undefined,
    getRawHeader, statFile, uncache,
    listPackage(...args) { state.listCalls++; return listPackage(...args); },
    extractFile(...args) { const bytes = extractFile(...args); state.extractCalls++; state.afterExtract?.(...args); return bytes; },
    readPins() { state.pinReads++; state.afterPinRead?.(); return state.pins; },
    readNative() { state.nativeReads++; state.afterNativeRead?.(); return state.native; },
  };
  const symbolName = "ling.office.asar.synthetic." + number, symbol = Symbol.for(symbolName);
  globalThis[symbol] = state; t.after(() => { delete globalThis[symbol]; });
  const url = scriptUrl + "?fixture=" + number;
  const bridge = `const state = globalThis[Symbol.for(${JSON.stringify(symbolName)})];\n`;
  const sources = new Map([
    ["./build-packaged-daemon.mjs", bridge + "export const readActiveOriginalPackagedOfficeDaemonBundle = () => state.readPins();"],
    ["./build-packaged-office-native.mjs", bridge + "export const readActiveOriginalPackagedOfficeNativePublication = () => state.readNative();"],
    ["@electron/asar", bridge + ["getRawHeader", "statFile", "uncache", "listPackage", "extractFile"]
      .map(name => `export const ${name} = (...args) => state.${name}(...args);`).join("\n")],
  ]);
  const loader = registerHooks({ resolve(specifier, context, nextResolve) {
    if (context.parentURL === url && sources.has(specifier))
      return { shortCircuit: true, url: "data:text/javascript," + encodeURIComponent(sources.get(specifier)) };
    return nextResolve(specifier, context);
  } });
  t.after(() => loader.deregister());
  t.after(() => uncache(archive));
  return { root, app, archive, source, cli, addon, pins, native, state, api: await import(url),
    async repack(options = {}) { uncache(archive); await createPackageWithOptions(source, archive, options); } };
}
function assertInvalid(f) { assert.throws(() => f.api.verifyOriginalOfficeDaemonInApp(f.app)); }

test("actual local Office ASAR contracts (synthetic original readers, NOT packaged/signature validation)", async t => {
  await t.test("exact packed original CLI accepts frozen hash/size-only evidence", async t => {
    const f = await fixture(t), result = f.api.verifyOriginalOfficeDaemonInApp(f.app);
    assert.equal(Object.isFrozen(result), true); assert.equal(result.evidenceKind, "copied_asar_cli_byte_pins_only");
    assert.equal(result.archivePath, f.archive); assert.equal(result.cliEntry, cliEntry);
    assert.equal(result.cliSha256, f.pins.sha256); assert.equal(result.cliSizeBytes, f.cli.length);
    assert.equal("authority" in result, false); assert.equal("bytes" in result, false);
    assert.equal(f.state.pinReads, 2); assert.equal(f.state.nativeReads, 2);
    assert.equal(f.api.verifyOriginalOfficeDaemonInApp.length, 1);
  });
  for (const invalid of ["missing", "same size stale", "sentinel", "link", "unpacked", "ancestor link", "ancestor unpacked"]) {
    await t.test(invalid + " CLI is rejected by real parser/checker", async t => {
      const f = await fixture(t);
      if (invalid === "missing") rmSync(join(f.source, cliEntry));
      else if (invalid === "same size stale") writeFileSync(join(f.source, cliEntry), Buffer.alloc(f.cli.length, 88));
      else if (invalid === "sentinel") writeFileSync(join(f.source, cliEntry), "NO_PACKAGED_OFFICE_NATIVE_REVIEW");
      if (["missing", "same size stale", "sentinel"].includes(invalid)) await f.repack();
      else if (invalid === "unpacked") await f.repack({ unpack: "**/cli.mjs" });
      else replaceHeader(f, header => {
        if (invalid === "link") header.files.dist.files.daemon.files["cli.mjs"] = { link: "foreign/cli.mjs" };
        else if (invalid === "ancestor link") header.files.dist.link = "foreign";
        else header.files.dist.unpacked = true;
      });
      assertInvalid(f);
    });
  }
  for (const name of ["office-local.node", "OfFiCe-LoCaL.NoDe", "OFFICE-LOCAL/empty", ".office-local-next-foreign/empty", "renamed-addon-with-no-extension"]) {
    for (const unpacked of [false, true]) {
      await t.test((unpacked ? "unpacked " : "packed ") + name + " second Office is rejected", async t => {
        const f = await fixture(t), path = "foreign/" + name;
        if (unpacked) newFile(join(f.archive + ".unpacked", path), f.addon);
        else { newFile(join(f.source, path), f.addon); await f.repack(); }
        assertInvalid(f);
      });
    }
  }
  await t.test("packed renamed link to the external Office stage is rejected", async t => {
    const f = await fixture(t);
    replaceHeader(f, header => { header.files.alias = { link: "../OFFICE-LOCAL/office-local.node" }; });
    assertInvalid(f);
  });
  await t.test("development bundled metadata inside app.asar is rejected", async t => {
    const f = await fixture(t);
    newFile(join(f.source, "dist/daemon/bundled/foreign-plugin/unreviewed.txt"), "UNREVIEWED FOREIGN FILE\n");
    await f.repack();
    assertInvalid(f);
  });
  await t.test("same-size unrelated files do not count as a duplicate Office addon", async t => {
    const f = await fixture(t); newFile(join(f.source, "unrelated-data"), Buffer.alloc(f.addon.length, 65));
    await f.repack(); newFile(join(f.archive + ".unpacked", "unrelated-data"), Buffer.alloc(f.addon.length, 66));
    assert.equal(f.api.verifyOriginalOfficeDaemonInApp(f.app).cliSha256, f.pins.sha256);
  });
  await t.test("actual vendor same-path cached header cannot hide a replaced stale archive", async t => {
    const f = await fixture(t); assert.equal(statFile(f.archive, cliEntry, false).size, f.cli.length);
    writeFileSync(join(f.source, cliEntry), Buffer.alloc(f.cli.length, 77));
    await createPackageWithOptions(f.source, f.archive, {});
    assertInvalid(f);
    writeFileSync(join(f.source, cliEntry), f.cli); await f.repack();
    assert.equal(f.api.verifyOriginalOfficeDaemonInApp(f.app).cliSha256, f.pins.sha256);
  });
  for (const mutation of ["same byte inode replacement", "same inode byte mutation", "late unpacked creation", "unpacked candidate replacement"]) {
    await t.test(mutation + " during actual extract is rejected by observation fences", async t => {
      const f = await fixture(t); let mutated = false;
      if (mutation === "unpacked candidate replacement") newFile(join(f.archive + ".unpacked", "candidate"), Buffer.alloc(f.addon.length, 65));
      f.state.afterExtract = () => {
        if (mutated) return; mutated = true;
        if (mutation === "same byte inode replacement") {
          const next = join(f.root, "next.asar"); copyFileSync(f.archive, next); renameSync(next, f.archive);
        } else if (mutation === "same inode byte mutation") {
          const bytes = readFileSync(f.archive); bytes[bytes.length - 1] ^= 1; writeFileSync(f.archive, bytes);
        } else if (mutation === "late unpacked creation") mkdirSync(f.archive + ".unpacked");
        else {
          const path = join(f.archive + ".unpacked", "candidate"), next = join(f.root, "next-candidate");
          newFile(next, f.addon); renameSync(next, path);
        }
      };
      assertInvalid(f); assert.equal(mutated, true);
    });
  }
  for (const invalid of ["archive symlink", "archive hardlink", "unpacked symlink", "writable ancestor", "writable archive"]) {
    await t.test(invalid + " fails closed", async t => {
      const f = await fixture(t);
      if (invalid === "archive symlink") { const next = join(f.root, "original.asar"); renameSync(f.archive, next); symlinkSync(next, f.archive); }
      else if (invalid === "archive hardlink") linkSync(f.archive, join(f.root, "second.asar"));
      else if (invalid === "unpacked symlink") { mkdirSync(f.archive + ".unpacked"); symlinkSync(f.source, join(f.archive + ".unpacked", "linked")); }
      else chmodSync(invalid === "writable archive" ? f.archive : dirname(f.archive), 0o777);
      assertInvalid(f);
    });
  }
  for (const missing of ["pins", "native"]) {
    for (const late of [false, true]) {
      await t.test((late ? "late retirement of " : "missing ") + missing + " rejects without DTO fallback", async t => {
        const f = await fixture(t);
        if (late) f.state.afterExtract = () => { f.state[missing] = undefined; };
        else f.state[missing] = undefined;
        assertInvalid(f);
      });
    }
  }
  await t.test("CLI byte limit is checked before any ASAR parsing/allocation", async t => {
    const f = await fixture(t); f.state.pins = { ...f.pins, sizeBytes: 64 * 1024 * 1024 + 1 };
    assertInvalid(f); assert.equal(f.state.listCalls, 0); assert.equal(f.state.extractCalls, 0);
  });
  await t.test("archive byte and header byte limits reject sparse files before vendor parse", async t => {
    const f = await fixture(t), before = readFileSync(f.archive);
    for (const kind of ["archive", "header"]) {
      writeFileSync(f.archive, before);
      if (kind === "header") { const prefix = Buffer.alloc(8); prefix.writeUInt32LE(4, 0); prefix.writeUInt32LE(16 * 1024 * 1024 + 1, 4); writeFileSync(f.archive, prefix); }
      const fd = openSync(f.archive, "r+");
      try { ftruncateSync(fd, kind === "archive" ? 2 * 1024 * 1024 * 1024 + 1 : 16 * 1024 * 1024 + 9); }
      finally { closeSync(fd); }
      assertInvalid(f); assert.equal(f.state.listCalls, 0); assert.equal(f.state.extractCalls, 0);
    }
  });
  for (const kind of ["entry count", "depth"]) {
    await t.test(kind + " budget rejects raw real header before listPackage allocates", async t => {
      const f = await fixture(t);
      replaceHeader(f, header => {
        if (kind === "entry count") for (let index = 0; index < 100_001; index++) header.files["entry-" + index] = { size: 0, offset: "0" };
        else { let node = header; for (let index = 0; index < 66; index++) node = node.files["depth-" + index] = { files: {} }; }
      });
      assertInvalid(f); assert.equal(f.state.listCalls, 0); assert.equal(f.state.extractCalls, 0);
    });
  }
  for (const kind of ["candidate count", "aggregate duplicate reads"]) {
    await t.test(kind + " budget limits actual candidate extraction", async t => {
      const f = await fixture(t), size = kind === "candidate count" ? f.addon.length : 1024 * 1024;
      const count = kind === "candidate count" ? 257 : 129;
      f.state.native = Object.freeze({ finalBinarySizeBytes: size, finalBinarySha256: hash(Buffer.alloc(size, 88)) });
      replaceHeader(f, header => {
        for (let index = 0; index < count; index++) header.files["candidate-" + index] = { size, offset: String(f.cli.length) };
      });
      const raw = getRawHeader(f.archive), archive = readFileSync(f.archive);
      writeFileSync(f.archive, rawArchive(raw.header, Buffer.concat([archive.subarray(8 + raw.headerSize), Buffer.alloc(size, 65)])));
      assertInvalid(f); assert.equal(f.state.extractCalls, 1 + count - 1);
    });
  }
  t.diagnostic("Real @electron/asar create/list/stat/extract/parser/cache used; adversarial headers and mutation hooks are explicit fixtures. Original emitted/native readers are synthetic; this is not original-FD custody, same-UID isolation, real signed .app/ZIP/DMG, Electron or MCP acceptance.");
});
