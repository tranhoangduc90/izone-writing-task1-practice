"""VPS: exercise the own DB, callback, writer and lease recovery boundaries."""
from pathlib import Path
import subprocess,json,uuid,urllib.request,urllib.error
release=Path('/opt/izone-shops-writing/releases/20261024.1');cfg=json.loads((release.parent.parent/'runtime.private.json').read_text())
def run(a,input=None):
 p=subprocess.run(a,input=input,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr[-800:])
 return p.stdout.strip()
def sql(q):return run(['docker','exec','-i','shops-writing-db','psql','-U','shops_owner','-d','shops_writing','-qAt','-v','ON_ERROR_STOP=1'],q)
def node(container,code):return json.loads(run(['docker','exec','-i',container,'node','--input-type=module'],code))
f=json.loads((release/'ai-canary.json').read_text());ref=f['cases'][1]['attemptRef']
db=node('shops-writing-api',r'''
import pg from 'pg';
const c=new pg.Client({connectionString:process.env.DATABASE_URL});await c.connect();
const meta=(await c.query("SELECT current_database() db,current_user role,has_database_privilege(current_user,'postgres','CONNECT') outside_connect")).rows[0];
const u=new URL(process.env.DATABASE_URL);u.pathname='/postgres';const other=new pg.Client({connectionString:u.href,connectionTimeoutMillis:3000});let denied=false;
try{await other.connect();}catch(e){denied=e.code==='42501';}finally{await other.end().catch(()=>{});}
if(!denied)throw Error('Own database boundary failed');await c.end();console.log(JSON.stringify({...meta,actualOutsideConnectDenied:denied}));
''');assert db['db']=='shops_writing' and db['role']=='shops_api'
before=sql("SELECT md5(row_to_json(a)::text) FROM writing_practice.check_attempt a WHERE public_id='"+ref+"'")
def post(path,token,body):
 q=urllib.request.Request('http://127.0.0.1:18927/api/v1/'+path,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
 try:
  with urllib.request.urlopen(q,timeout=10) as r:return r.status,json.load(r)
 except urllib.error.HTTPError as e:return e.code,json.load(e)
body={'leaseToken':str(uuid.uuid4()),'resultStatus':'passed','feedback':'Canary callback denied'}
assert post('internal/grading-jobs/'+ref+'/complete','invalid-release-probe',body)[0]==401
assert post('internal/grading-jobs/'+ref+'/complete',cfg['apiToken'],body)[0]==409
assert sql("SELECT md5(row_to_json(a)::text) FROM writing_practice.check_attempt a WHERE public_id='"+ref+"'")==before
run(['systemctl','stop','shops-writing-worker.service'])
try:
 job=str(uuid.uuid4());session=f['cases'][0]['sessionRef']
 sql("INSERT INTO writing_practice.check_attempt(public_id,session_id,section_key,round_number,comment_number,request_id,body_hash,snapshot,status,worker_id,lease_token,lease_expires_at,retry_count) SELECT '"+job+"',s.id,'draft',1,100,gen_random_uuid(),repeat('b',64),'{}'::jsonb,'leased','shops-recovery-release-check',gen_random_uuid(),now()-interval '1 second',1 FROM writing_practice.activity_session s WHERE public_id='"+session+"';")
 assert post('internal/grading-jobs/recover',cfg['apiToken'],{})[0]==200
 assert sql("SELECT status FROM writing_practice.check_attempt WHERE public_id='"+job+"'")=='queued'
 sql("UPDATE writing_practice.check_attempt SET status='failed',error_code='RELEASE_RECOVERY_PROBE',worker_id=NULL WHERE public_id='"+job+"'")
finally:run(['systemctl','start','shops-writing-worker.service'])
writer=node('shops-writing-writer',r'''
import assert from 'node:assert/strict';
const body={schema_version:2,strict_highlights:true,request_id:'shops-production-release:writer-replay:20261024',bai_viet:'A ban reduce harmful consumption.',tr_cc:'',corrections:[{source_index:0,correction_index:0,operation_key:'shops-production-release:writer:1',original_text:'A ban reduce harmful consumption.',revised_text:'A ban reduces harmful consumption.',original:'reduce',improved:'reduces',original_start:6,original_end:12,revised_start:6,revised_end:13,original_next_word:'harmful',improved_next_word:'harmful',reason:'Em dùng reduces với chủ ngữ số ít.'}]};
async function post(data,key=process.env.API_WRITE_TOKEN){const r=await fetch('http://127.0.0.1:8780/v1/writing-essays',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(data)});return {status:r.status,body:await r.json()};}
assert.equal((await post(body,'invalid-release-key')).status,401);
const a=await post(body),b=await post(body);assert.ok([200,201].includes(a.status));assert.equal(b.status,200);assert.equal(a.body.data,b.body.data);assert.equal(a.body.version,b.body.version);assert.equal(b.body.created,false);
const invalid=structuredClone(body);invalid.request_id+=':invalid';invalid.corrections[0].original_start=0;assert.equal((await post(invalid)).status,400);
assert.ok(a.body.view_url.startsWith('https://ducizone.ddns.net/shops-writing-api/results/'));
console.log(JSON.stringify({wrongKeyRejected:true,exactReplaySameIdVersion:true,wrongOffsetRejected:true,ownReadOnlyBase:true}));
''')
report={'outcome':'passed','database':db,'callbackWrongKeyAndLeaseRejected':True,'rejectedCallbackNoMutation':True,'expiredLeaseRecovered':True,'workerRestarted':True,'writer':writer,'realStudentWrites':False}
(release/'boundary-receipt.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
