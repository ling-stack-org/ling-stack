import { createHash } from "node:crypto";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const storeBootstrap = process.argv.includes("--store-bootstrap") || process.env.LING_CHROME_STORE_BOOTSTRAP === "1";
const dist = join(packageRoot, storeBootstrap ? "dist-store-bootstrap" : "dist");
const zipPath = join(packageRoot, storeBootstrap ? "ling-for-chrome-store-bootstrap.zip" : "ling-for-chrome.zip");

await rm(dist, { recursive: true, force: true });
await mkdir(join(dist, "icons"), { recursive: true });
const manifest = JSON.parse(await readFile(join(packageRoot, "manifest.json"), "utf8"));
if (storeBootstrap) delete manifest.key;
await writeFile(join(dist, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
for (const file of ["background.js", "content-script.js", "popup.html", "popup.css", "popup.js", "protocol.js"]) {
  await cp(join(packageRoot, "src", file), join(dist, file));
}
for (const file of ["icon-16.png", "icon-32.png", "icon-48.png", "icon-128.png"]) {
  await cp(join(packageRoot, "assets", file), join(dist, "icons", file));
}

const files = await listFiles(dist);
const archive = [];
for (const file of files) {
  archive.push({ name: relative(dist, file).replaceAll("\\", "/"), data: await readFile(file) });
}
const zip = createZip(archive);
await writeFile(zipPath, zip);
await writeFile(join(dist, "build-metadata.json"), `${JSON.stringify({
  identityMode: storeBootstrap ? "store-bootstrap" : "production",
  extensionId: storeBootstrap ? null : extensionIdFromKey(manifest.key),
  version: manifest.version,
  manifestSha256: createHash("sha256").update(await readFile(join(dist, "manifest.json"))).digest("hex"),
  zipSha256: createHash("sha256").update(zip).digest("hex"),
}, null, 2)}\n`);

async function listFiles(root) {
  const result = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) result.push(...await listFiles(path));
    else result.push(path);
  }
  return result.sort();
}

function extensionIdFromKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16);
  return [...digest].flatMap((byte) => [byte >> 4, byte & 15]).map((nibble) => String.fromCharCode(97 + nibble)).join("");
}

function createZip(entries) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(33, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(33, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + compressed.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
