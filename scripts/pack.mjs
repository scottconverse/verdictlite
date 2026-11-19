// Build release/verdictlite.zip and release/verdictlite.zip.sha256 from the built dist/.
// No dependencies: a small zip writer (deflate) so it works the same on every OS.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'release');

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => (a.name < b.name ? -1 : 1))
    .flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));
}

if (!existsSync(join(root, 'dist', 'cli.js'))) {
  console.error('dist/cli.js is missing. Run pnpm build first.');
  process.exit(1);
}
const files = [...walk(join(root, 'dist'))];
for (const f of ['package.json', 'LICENSE', 'NOTICE', 'README.md']) {
  if (existsSync(join(root, f)) && statSync(join(root, f)).isFile()) files.push(join(root, f));
}

const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1; // fixed date: same input, same zip
const parts = [];
const central = [];
let offset = 0;
for (const f of files) {
  const name = Buffer.from(relative(root, f).split(sep).join('/'));
  const data = readFileSync(f);
  const comp = deflateRawSync(data, { level: 9 });
  const crc = crc32(data);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // UTF-8 names
  local.writeUInt16LE(8, 8);
  local.writeUInt16LE(DOS_TIME, 10);
  local.writeUInt16LE(DOS_DATE, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comp.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  parts.push(local, name, comp);
  const c = Buffer.alloc(46);
  c.writeUInt32LE(0x02014b50, 0);
  c.writeUInt16LE(20, 4);
  c.writeUInt16LE(20, 6);
  c.writeUInt16LE(0x0800, 8);
  c.writeUInt16LE(8, 10);
  c.writeUInt16LE(DOS_TIME, 12);
  c.writeUInt16LE(DOS_DATE, 14);
  c.writeUInt32LE(crc, 16);
  c.writeUInt32LE(comp.length, 20);
  c.writeUInt32LE(data.length, 24);
  c.writeUInt16LE(name.length, 28);
  c.writeUInt32LE(offset, 42);
  central.push(c, name);
  offset += local.length + name.length + comp.length;
}
const centralBuf = Buffer.concat(central);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
const zip = Buffer.concat([...parts, centralBuf, end]);

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'verdictlite.zip'), zip);
const sha = createHash('sha256').update(zip).digest('hex');
writeFileSync(join(out, 'verdictlite.zip.sha256'), `${sha}  verdictlite.zip\n`);
console.log(`release/verdictlite.zip  ${files.length} files  sha256 ${sha}`);
