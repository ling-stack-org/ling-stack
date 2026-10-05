import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, lstatSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

/** Fixture cleanup is test-only, after explicit native close, never a product path cleanup API. */
export function fixture(t, addon) {
  const output = realpathSync(process.env.OFFICE_LOCAL_TEST_OUTPUT);
  const root = mkdtempSync(join(output, "fixture-"));
  const original = lstatSync(root, { bigint: true });
  const host = join(root, "host"), stage = join(host, "stage"), workspace = join(root, "workspace"), scratch = join(root, "scratch");
  for (const directory of [host, stage, workspace, scratch]) mkdirSync(directory, { mode: 0o700 });
  const sessions = [];
  const open = (source = stage, destination = workspace) => {
    const result = addon.openSession(source, destination);
    sessions.push(result.session);
    return result;
  };
  t.after(() => {
    // Every original handle is explicitly closed before owned fixture removal.
    for (const session of sessions) {
      if (addon.inspectSession(session).phase !== "closed") assert.equal(addon.closeSession(session).success, true);
      assert.ok(addon.inspectSession(session).resources.every(resource => ["closed", "not_acquired"].includes(resource.state)));
    }
    const observed = lstatSync(root, { bigint: true });
    assert.equal(observed.dev, original.dev); assert.equal(observed.ino, original.ino);
    assert.ok(root.startsWith(output + "/fixture-"));
    rmSync(root, { recursive: true });
  });
  return { root, host, stage, workspace, scratch, open };
}

export function succeeded(result) {
  assert.equal(result.success, true, JSON.stringify(result));
  assert.equal(result.nativeOutcome, "returned");
  assert.equal(result.hostAcknowledgment, "not_provided");
  assert.equal(result.snapshot.scopeBinding, "unbound");
  assert.equal(result.snapshot.protectedStageVerified, false);
  assert.equal(result.snapshot.coreSafe, false);
  assert.equal(typeof result.then, "undefined");
  return result;
}

/** Minimal genuine OOXML ZIP, generated entirely in memory without another module build. */
export function docxBytes() {
  const entries = {
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>原始 FD 实测</w:t></w:r></w:p></w:body></w:document>',
  };
  const chunks = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const filename = Buffer.from(name), original = Buffer.from(text), compressed = deflateRawSync(original);
    let crc = 0xffffffff;
    for (const byte of original) {
      crc ^= byte;
      for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(original.length, 22);
    local.writeUInt16LE(filename.length, 26);
    chunks.push(local, filename, compressed);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(8, 10); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(compressed.length, 20);
    directory.writeUInt32LE(original.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += local.length + filename.length + compressed.length;
  }
  const table = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10); end.writeUInt32LE(table.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, table, end]);
}

export function stagedTree(addon, held, bytes = docxBytes()) {
  const top = succeeded(addon.createDirectory(held.session, held.stageParent, "native-tree", "mkdir-top"));
  const child = succeeded(addon.createDirectory(held.session, top.capability, "nested", "mkdir-nested"));
  const file = succeeded(addon.createFile(held.session, child.capability, "report.docx", "create-docx"));
  succeeded(addon.writeFile(held.session, file.capability, bytes, "write-docx"));
  succeeded(addon.fsyncResource(held.session, file.capability, "fsync-docx"));
  succeeded(addon.closeResource(held.session, file.capability, "close-docx"));
  succeeded(addon.fsyncResource(held.session, child.capability, "fsync-nested"));
  succeeded(addon.fsyncResource(held.session, top.capability, "fsync-top"));
  return { top, child, file, bytes };
}
