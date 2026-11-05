// Build a source ZIP with Node's standard library; package the current Git-visible working tree.
import fs from "node:fs";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {deflateRawSync} from "node:zlib";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const {version} = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version)) throw new Error("Invalid package version");
const prefix = `ModelBridge-v${version}`;
const files = [...new Set(execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {cwd: root, encoding: "utf8"}).split("\0").filter(Boolean))].sort();
const local = [];
const central = [];
const manifest = [];
let offset = 0;
const crcTable = Array.from({length: 256}, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
for (const file of files) {
  const source = path.resolve(root, file);
  if (!fs.existsSync(source)) continue;
  const relative = path.relative(root, fs.realpathSync(source));
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`File outside project: ${file}`);
  if (!fs.statSync(source).isFile()) throw new Error(`Not a regular file: ${file}`);
  if (/(^|\/)(\.git|releases|\.ui-artifacts|node_modules)(\/|$)|(^|\/)(api\.txt|config\.local\.json(?:\..*)?|\.env(?:\..*)?)$/.test(file) && file !== ".env.example") {
    throw new Error(`Refusing to package private or generated file: ${file}`);
  }
  const name = Buffer.from(`${prefix}/${file}`, "utf8");
  const data = fs.readFileSync(source);
  const compressed = deflateRawSync(data);
  const crc = crc32(data);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x800, 6); // UTF-8 filenames, including the Windows launcher.
  header.writeUInt16LE(8, 8); // Deflate.
  header.writeUInt16LE(33, 12); // Fixed valid DOS date: 1980-01-01.
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(compressed.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  const directory = Buffer.alloc(46);
  directory.writeUInt32LE(0x02014b50, 0);
  directory.writeUInt16LE(20, 4);
  header.copy(directory, 6, 4, 28);
  directory.writeUInt32LE(offset, 42);
  local.push(header, name, compressed);
  central.push(directory, name);
  offset += header.length + name.length + compressed.length;
  manifest.push(file);
}
if (!manifest.length || manifest.length > 65535) throw new Error("Unsupported number of source files");
const directory = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(manifest.length, 8);
end.writeUInt16LE(manifest.length, 10);
end.writeUInt32LE(directory.length, 12);
end.writeUInt32LE(offset, 16);
fs.mkdirSync(path.join(root, "releases"), {recursive: true});
const output = path.join(root, "releases", `${prefix}.zip`);
// Refuse to overwrite a release; rename/remove an older ZIP explicitly before rebuilding.
fs.writeFileSync(output, Buffer.concat([...local, directory, end]), {flag: "wx"});
console.log(`Packaged ${manifest.length} files: ${output}`);
