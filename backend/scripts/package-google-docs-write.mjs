import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const output = process.argv[2];
if (!output) throw Error('Usage: node scripts/package-google-docs-write.mjs <new output directory>');
const folder = resolve(output);
const hash = data => createHash('sha256').update(data).digest('hex');
const files = ['google.js', 'execute.js', 'lock.js'];
const sources = await Promise.all(files.map(name => readFile(new URL('../src/google-docs-write/' + name, import.meta.url))));
const manifest = JSON.stringify({ files: Object.fromEntries(files.map((name, i) => [name, hash(sources[i])])) }, null, 2) + '\n';
await mkdir(folder);
await Promise.all(files.map((name, i) => writeFile(resolve(folder, name), sources[i], { flag: 'wx' })));
await writeFile(resolve(folder, 'package.json'), '{"type":"module"}\n', { flag: 'wx' });
await writeFile(resolve(folder, 'manifest.json'), manifest, { flag: 'wx' });
console.log(JSON.stringify({ folder, manifestSha256: hash(manifest) }));
