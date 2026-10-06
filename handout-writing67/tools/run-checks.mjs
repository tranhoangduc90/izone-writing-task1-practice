import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Nhận tên lượt kiểm và danh sách file tùy chọn; chạy Node native trên fixture local.
// Giữ stdout/stderr/exit thật và ID thực thi; lỗi test vẫn trả exit lỗi, không tạo pass giả.
const root=process.cwd();
const [runId,...chosen]=process.argv.slice(2);
if(!/^[a-zA-Z0-9_-]+$/.test(runId||''))throw new Error('Cần runId hợp lệ.');
const files=chosen.length?chosen:fs.readdirSync(path.join(root,'test')).filter(n=>n.endsWith('.test.mjs')).sort().map(n=>'test/'+n);
if(!files.length||files.some(n=>!/^test\/[a-zA-Z0-9_.-]+\.test\.mjs$/.test(n)))throw new Error('File test không hợp lệ.');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const fingerprint=()=>{
  const probe=spawnSync('C:/Python314/python.exe',['-X','utf8','C:/Users/ADMIN/.codex/hooks/enforce_product_process.py','fingerprint','--root',root,'--manifest',root+'/.codex/product-quality-gate.json'],{encoding:'utf8'});
  if(probe.status!==0)throw new Error('Không lấy được revision: '+probe.stderr+probe.stdout);
  return JSON.parse(probe.stdout).tree_revision;
};
const before=fingerprint();
const argv=[process.execPath,'--test','--test-reporter=tap',...files];
const native=spawnSync(argv[0],argv.slice(1),{cwd:root,encoding:'utf8',timeout:600000,maxBuffer:32*1024*1024});
const output=native.stdout||'',errors=native.stderr||'';
const tests=[...output.matchAll(/^(not ok|ok) \d+ - (.+)$/gm)].map(m=>({id:m[2].replace(/ # (SKIP|TODO).*$/,''),passed:m[1]==='ok',skipped:/ # (SKIP|TODO)/.test(m[2])}));
const counter=label=>Number(output.match(new RegExp('^# '+label+' (\\d+)$','m'))?.[1]??NaN);
const after=fingerprint();
const passed=counter('pass'),failed=counter('fail'),skipped=counter('skipped');
const inventoryValid=tests.length===counter('tests')&&new Set(tests.map(t=>t.id)).size===tests.length;
const outcome=native.status===0&&failed===0&&skipped===0&&inventoryValid&&before===after?'passed':'failed';
const directory=path.join(root,'.codex/product-evidence',runId);fs.mkdirSync(directory,{recursive:true});
const save=(name,content)=>{const file=path.join(directory,name);fs.writeFileSync(file,content,'utf8');return {path:file,sha256:digest(fs.readFileSync(file))};};
const receipt={run_id:runId,command:argv.map(a=>/\s/.test(a)?'"'+a+'"':a).join(' '),argv,cwd:root,tree_revision:before,revision_after:after,captured_at:new Date().toISOString(),exit_code:native.status??1,outcome,passed,failed,skipped,inventory_valid:inventoryValid,executed_test_ids:tests.map(t=>t.id),tests,stdout:save('stdout.tap',output),stderr:save('stderr.txt',errors),runner_fingerprint:digest(fs.readFileSync(new URL(import.meta.url))),environment_fingerprint:digest(JSON.stringify({node:process.version,platform:os.platform(),arch:os.arch(),lock:fs.readFileSync('package-lock.json','utf8')})),configuration_fingerprint:digest(fs.readFileSync('package.json')),fixture_fingerprint:digest(files.map(n=>n+':'+digest(fs.readFileSync(n))).join('\n'))};
save('receipt.json',JSON.stringify(receipt,null,2));
process.stdout.write(output);process.stderr.write(errors);
console.log(JSON.stringify({run_id:runId,outcome,passed,failed,skipped,inventory_valid:inventoryValid,tree_revision:before,receipt:directory+'/receipt.json'}));
process.exit(native.status===0?(outcome==='passed'?0:1):(native.status??1));
