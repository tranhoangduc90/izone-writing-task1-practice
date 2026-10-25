"""Install only the authorized SW staging runtime. Never replaces a live service."""
from pathlib import Path
import json,subprocess,secrets,shutil,time,hashlib
root=Path('/opt/izone-sw-task2-preview-20261025')
base=Path('/opt/izone-shops-writing/releases/20261024.1')
def run(a,input=None):
 p=subprocess.run(a,input=input,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(str(a[:3])+': '+p.stderr[-1000:])
 return p.stdout.strip()
def exists(n):return bool(run(['docker','ps','-aq','--filter','name=^/'+n+'$']))
def sql(q):return run(['docker','exec','-i','sw-task2-preview-db','psql','-U','sw_owner','-d','sw_task2_preview_20261025','-qAt','-v','ON_ERROR_STOP=1'],q)
root.mkdir(exist_ok=True)
private=root/'runtime.private.json'
if not private.exists():
 old=json.loads(Path('/opt/izone-shops-writing/runtime.private.json').read_text())
 cfg={k:secrets.token_hex(32) for k in ['ownerPassword','apiPassword','apiToken','writerToken','writerHmac','workerKey']}
 cfg.update({'googleClientId':old['googleClientId'],'pinPepper':old['pinPepper']})
 private.write_text(json.dumps(cfg));private.chmod(0o600)
cfg=json.loads(private.read_text())
if not exists('sw-task2-preview-db'):
 assert not run(['docker','network','ls','-q','--filter','name=^sw-task2-preview-net$'])
 run(['docker','network','create','--internal','sw-task2-preview-net'])
 image=json.loads(run(['docker','inspect','shops-writing-db']))[0]['Image']
 run(['docker','run','-d','--name','sw-task2-preview-db','--label','izone.product=sw-task2-preview','--restart','unless-stopped','--network','sw-task2-preview-net','--memory','256m','--cpus','0.5','-e','POSTGRES_USER=sw_owner','-e','POSTGRES_DB=sw_task2_preview_20261025','-e','POSTGRES_PASSWORD='+cfg['ownerPassword'],'-v',str(root/'pgdata')+':/var/lib/postgresql/data',image,'postgres','-c','max_connections=25','-c','shared_buffers=32MB'])
for _ in range(25):
 try:
  if 'accepting connections' in run(['docker','exec','sw-task2-preview-db','pg_isready','-U','sw_owner']):break
 except RuntimeError:pass
 time.sleep(1)
if not (root/'schema-installed.json').exists():
 schema=run(['docker','exec','shops-writing-db','pg_dump','-U','shops_owner','-d','shops_writing','-n','mapping','-n','writing_practice','--schema-only','--no-owner','--no-privileges'])
 sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;\n'+schema)
 sql("CREATE ROLE sw_api LOGIN PASSWORD '"+cfg['apiPassword']+"'; GRANT USAGE ON SCHEMA writing_practice,mapping TO sw_api; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA writing_practice TO sw_api; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA writing_practice TO sw_api; GRANT SELECT,UPDATE ON mapping.reviewer_account TO sw_api; GRANT SELECT,INSERT,UPDATE ON mapping.reviewer_session TO sw_api; GRANT SELECT ON mapping.reviewer_class_access,mapping.lark_export_teacher_assignments,mapping.student_mapping_review,mapping.classroom_course_mapping,mapping.classroom_roster_snapshot TO sw_api; REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC,sw_api;")
 sql("CREATE TABLE writing_practice.sw_preview_scope(scope_id bigint PRIMARY KEY REFERENCES writing_practice.activity_class_scope(id),kind text NOT NULL CHECK(kind IN ('fixture','archive'))); GRANT SELECT ON writing_practice.sw_preview_scope TO sw_api;")
 (root/'schema-installed.json').write_text(json.dumps({'sha256':hashlib.sha256(schema.encode()).hexdigest()}))
context=root/'image'
if not context.exists():
 context.mkdir()
 for name in ['src','node_modules','package.json','package-lock.json']:
  source=base/'image'/name
  shutil.copytree(source,context/name) if source.is_dir() else shutil.copy2(source,context/name)
ops=context/'ops/sw-task2';ops.mkdir(parents=True,exist_ok=True)
for p in (root/'candidate').iterdir():
 if p.is_file() and p.suffix in ['.mjs','.js','.json']:
  shutil.copy2(p,ops/p.name);(ops/p.name).chmod(0o644)
node='node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43'
(context/'Dockerfile').write_text(f'FROM {node}\nWORKDIR /app\nCOPY . .\nUSER node\nCMD ["node","ops/sw-task2/server.mjs"]\n')
run(['docker','build','--network=none','-t','sw-task2-preview-api:20261025.1',str(context)])
image=run(['docker','image','inspect','sw-task2-preview-api:20261025.1','--format','{{.Id}}'])
env={'NODE_ENV':'production','PORT':'8790','DATABASE_URL':'postgres://sw_api:'+cfg['apiPassword']+'@sw-task2-preview-db/sw_task2_preview_20261025','DB_POOL_MAX':'3','ALLOWED_ORIGINS':'https://tranhoangduc90.github.io','TRUST_PROXY_HOPS':'1','INTERNAL_API_TOKEN':cfg['apiToken'],'GOOGLE_CLIENT_ID':cfg['googleClientId'],'PROVISIONAL_STUDENT_PIN_PEPPER':cfg['pinPepper'],'TEACHER_SESSION_COOKIE_NAME':'izone_sw_preview_teacher','TEACHER_SESSION_COOKIE_PATH':'/sw-task2-preview-api','TEACHER_SESSION_COOKIE_SECURE':'true','TEACHER_SESSION_COOKIE_PARTITIONED':'true'}
(root/'api.env').write_text('\n'.join(k+'='+v for k,v in env.items())+'\n');(root/'api.env').chmod(0o600)
writer=root/'writer-image'
if not writer.exists():shutil.copytree(base/'writer-image',writer)
(writer/'Dockerfile').write_text(f'FROM {node}\nWORKDIR /app\nCOPY . .\nCMD ["node","server.mjs"]\n')
run(['docker','build','--network=none','-t','sw-task2-preview-writer:20261025.1',str(writer)])
wi=run(['docker','image','inspect','sw-task2-preview-writer:20261025.1','--format','{{.Id}}'])
we={'NODE_ENV':'production','PORT':'8780','BIND_HOST':'0.0.0.0','DATA_ROOT':'/data','PUBLIC_BASE_URL':'https://ducizone.ddns.net/sw-task2-preview-api/results','API_WRITE_TOKEN':cfg['writerToken'],'ID_HMAC_SECRET':cfg['writerHmac']}
(root/'writer.env').write_text('\n'.join(k+'='+v for k,v in we.items())+'\n');(root/'writer.env').chmod(0o600)
if not exists('sw-task2-preview-writer'):
 (root/'results').mkdir(exist_ok=True)
 run(['docker','run','-d','--name','sw-task2-preview-writer','--label','izone.product=sw-task2-preview','--restart','unless-stopped','--network','sw-task2-preview-net','--memory','128m','--cpus','0.25','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--env-file',str(root/'writer.env'),'-v',str(root/'results')+':/data',wi]);run(['docker','network','connect','n8n-net','sw-task2-preview-writer'])
# API starts only after the migration has been validated.
receipt={'outcome':'prepared','database':'sw_task2_preview_20261025','apiImage':image,'writerImage':wi,'apiPort':18935,'realRoutesChanged':False}
(root/'runtime-prepared.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
