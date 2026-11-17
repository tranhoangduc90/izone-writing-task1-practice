import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { stageReadingRecoveryEntry, stageReadingRecoveryRouter, stageReadingWorkerJournal } from './reading-journal-recovery.mjs';

async function stage() {
  const [release, destination] = process.argv.slice(2);
  if (!release || !destination) throw new Error('Pass a pinned runtime directory and a fresh output directory');
  const root = resolve(destination);
  await mkdir(root);
  const bundle = [
    ['scripts/serve-reading67-web.mjs', stageReadingRecoveryEntry],
    ['src/reading-listening67/web-routes.js', stageReadingRecoveryRouter],
    ['src/reading-listening67/web-journal-worker.js', stageReadingWorkerJournal],
  ];
  const sha = bytes => createHash('sha256').update(bytes).digest('hex');
  const files = [];
  for (const [path, prepare] of bundle) {
    const raw = await readFile(join(release, path));
    const source = raw.toString('utf8').replaceAll('\r\n', '\n');
    const candidate = prepare(source);
    await writeFile(join(root, basename(path)), candidate, { flag: 'wx' });
    files.push({ path, sourceRawSha256: sha(raw), sourceSha256: sha(source), candidateSha256: sha(candidate) });
  }
  const helper = await readFile(new URL('./reading-journal-recovery.mjs', import.meta.url));
  await writeFile(join(root, 'reading-journal-recovery.mjs'), helper, { flag: 'wx' });
  files.push({ path: '/run/reading-journal-cloud/reading-journal-recovery.mjs', candidateSha256: sha(helper) });
  await writeFile(join(root, 'STAGED.json'), JSON.stringify(files, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ files: files.length }));
}

await stage();
