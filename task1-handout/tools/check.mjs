import fs from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sha} from '../src/grading.mjs';
const root=new URL('../',import.meta.url),lock=JSON.parse(await fs.readFile(new URL('vendor-lock.json',root),'utf8'));
for(const [name,pin] of Object.entries(lock.files))if(sha((await fs.readFile(new URL('vendor/'+name,root),'utf8')).replaceAll('\r\n','\n'))!==pin.candidate_sha256)throw Error('VENDOR_HASH_CHANGED: '+name);
async function walk(url){for(const p of await fs.readdir(url,{withFileTypes:true})){const file=new URL(p.name+(p.isDirectory()?'/':''),url);if(p.isDirectory())await walk(file);else if(/\.(?:mjs|js)$/.test(p.name)){const r=spawnSync(process.execPath,['--check',fileURLToPath(file)],{encoding:'utf8'});if(r.status)throw Error(r.stderr);}}}
for(const dir of ['src/','vendor/','tools/','test/'])await walk(new URL(dir,root));
console.log(JSON.stringify({outcome:'success',pinnedRevision:lock.revision,vendorFiles:Object.keys(lock.files).length}));
