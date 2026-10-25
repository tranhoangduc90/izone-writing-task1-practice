"""VPS: prepare independent production DB and immutable API/writer images.
No source activity is closed here; no student-facing class is opened here.
"""
from pathlib import Path
import subprocess,json,secrets,time,shutil,os,hashlib
root=Path('/opt/izone-shops-writing');release=root/'releases/20261024.1';release.mkdir(parents=True,exist_ok=True)
preview=Path('/opt/izone-shops-preview-20261024')
def run(args,input=None):
 p=subprocess.run(args,input=input,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(str(args[:3])+': '+p.stderr[-900:])
 return p.stdout
def exists(name):return bool(run(['docker','ps','-a','--filter','name=^/'+name+'$','-q']).strip())
def sql(q):return run(['docker','exec','-i','shops-writing-db','psql','-U','shops_owner','-d','shops_writing','-v','ON_ERROR_STOP=1','-At'],q)
configfile=root/'runtime.private.json'
if not configfile.exists():
 source=json.loads(run(['docker','inspect','writing-task1-practice-api']))[0]
 env=dict(x.split('=',1) for x in source['Config']['Env'] if '=' in x)
 cfg={'dbOwnerPassword':secrets.token_hex(32),'apiPassword':secrets.token_hex(32),'ssoPassword':secrets.token_hex(32),'apiToken':secrets.token_hex(40),'writerToken':secrets.token_hex(32),'writerHmac':secrets.token_hex(32),'workerKey':secrets.token_hex(32),'googleClientId':env['GOOGLE_CLIENT_ID'],'pinPepper':env['PROVISIONAL_STUDENT_PIN_PEPPER']}
 configfile.write_text(json.dumps(cfg));configfile.chmod(0o600)
cfg=json.loads(configfile.read_text())
if not exists('shops-writing-db'):
 run(['docker','network','create','--internal','shops-writing-net'])
 image=json.loads(run(['docker','inspect','shops-preview-db-20261024']))[0]['Image']
 run(['docker','run','-d','--name','shops-writing-db','--label','izone.product=shops-writing','--restart','unless-stopped','--network','shops-writing-net','--memory','256m','--cpus','0.5','-e','POSTGRES_USER=shops_owner','-e','POSTGRES_DB=shops_writing','-e','POSTGRES_PASSWORD='+cfg['dbOwnerPassword'],'-v',str(root/'pgdata')+':/var/lib/postgresql/data',image,'postgres','-c','max_connections=30','-c','shared_buffers=32MB'])
for _ in range(30):
 try:
  if 'accepting connections' in run(['docker','exec','shops-writing-db','pg_isready','-U','shops_owner']):break
 except RuntimeError:pass
 time.sleep(1)
if not (release/'schema-installed.json').exists():
 schema=run(['docker','exec','shops-preview-db-20261024','pg_dump','-U','shops_owner','-d','shops_preview_20261024','-n','mapping','-n','writing_practice','--schema-only','--no-owner','--no-privileges'])
 (release/'schema.sql').write_text(schema)
 sql('CREATE EXTENSION IF NOT EXISTS pgcrypto;\n'+schema)
 sql("CREATE ROLE shops_api LOGIN PASSWORD '"+cfg['apiPassword']+"'; CREATE ROLE shops_sso LOGIN PASSWORD '"+cfg['ssoPassword']+"'; GRANT USAGE ON SCHEMA writing_practice,mapping TO shops_api; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA writing_practice TO shops_api; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA writing_practice TO shops_api; GRANT SELECT,UPDATE ON mapping.reviewer_account TO shops_api; GRANT SELECT,INSERT,UPDATE ON mapping.reviewer_session TO shops_api; GRANT SELECT ON mapping.reviewer_class_access,mapping.lark_export_teacher_assignments,mapping.student_mapping_review,mapping.classroom_course_mapping,mapping.classroom_roster_snapshot TO shops_api; GRANT USAGE ON SCHEMA mapping TO shops_sso; GRANT SELECT ON mapping.reviewer_account TO shops_sso; GRANT UPDATE(last_login_at,updated_at) ON mapping.reviewer_account TO shops_sso; GRANT SELECT,INSERT,UPDATE ON mapping.reviewer_session TO shops_sso; REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC,shops_api,shops_sso;")
 (release/'schema-installed.json').write_text(json.dumps({'installed':True,'schemaSha256':hashlib.sha256(schema.encode()).hexdigest()}))
context=release/'image';context.mkdir(exist_ok=True)
if not (context/'node_modules').exists():
 for name in ['src','node_modules','package.json','package-lock.json']:shutil.copytree(preview/'atomic-image/api'/name,context/name) if (preview/'atomic-image/api'/name).is_dir() else shutil.copy2(preview/'atomic-image/api'/name,context/name)
source=context/'src/service.js';s=source.read_text();s=s.replace('shops-review-preview-api','shops-writing-api');source.write_text(s)
ops=context/'ops/shops-production';ops.mkdir(parents=True,exist_ok=True)
for p in (release/'candidate').glob('*.mjs'):shutil.copy2(p,ops/p.name);(ops/p.name).chmod(0o644)
for name in ['lesson9-service.js','lesson9-vocabulary.js']:
 p=preview/'candidate/backend/src'/name;shutil.copy2(p,context/'src'/name);(context/'src'/name).chmod(0o644)
# Authoritative grants are materialized in this product; no Lark permission fallback.
(context/'src/teacher-class-access-sql.js').write_text('''export function reviewerClassAccessSql(scopeAlias,reviewerParam){if(!/^[a-z_][a-z0-9_]*$/u.test(scopeAlias)||!/^\\$\\d+$/u.test(reviewerParam))throw TypeError('Invalid SQL binding');return `(EXISTS (SELECT 1 FROM mapping.reviewer_class_access access WHERE access.reviewer_email=${reviewerParam} AND access.erp_course_class_id=${scopeAlias}.erp_course_class_id))`;}\n''')
base='node@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43'
(context/'Dockerfile').write_text(f'FROM {base}\nWORKDIR /app\nCOPY . .\nUSER node\nCMD ["node","ops/shops-production/server.mjs"]\n')
run(['docker','build','--network=none','-t','shops-writing-api:20261024.1',str(context)])
image=run(['docker','image','inspect','shops-writing-api:20261024.1','--format','{{.Id}}']).strip()
env={'NODE_ENV':'production','PORT':'8790','DATABASE_URL':'postgres://shops_api:'+cfg['apiPassword']+'@shops-writing-db/shops_writing','DB_POOL_MAX':'3','ALLOWED_ORIGINS':'https://tranhoangduc90.github.io','TRUST_PROXY_HOPS':'1','INTERNAL_API_TOKEN':cfg['apiToken'],'GOOGLE_CLIENT_ID':cfg['googleClientId'],'PROVISIONAL_STUDENT_PIN_PEPPER':cfg['pinPepper'],'TEACHER_SESSION_COOKIE_NAME':'izone_shops_teacher','TEACHER_SESSION_COOKIE_PATH':'/shops-writing-api','TEACHER_SESSION_COOKIE_SECURE':'true','TEACHER_SESSION_COOKIE_PARTITIONED':'true'}
(release/'api.env').write_text('\n'.join(k+'='+v for k,v in env.items())+'\n');(release/'api.env').chmod(0o600)
if not exists('shops-writing-api'):
 run(['docker','run','-d','--name','shops-writing-api','--label','izone.product=shops-writing','--restart','unless-stopped','--network','shops-writing-net','--memory','256m','--cpus','0.5','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','100','--env-file',str(release/'api.env'),'-p','127.0.0.1:18927:8790',image])
 run(['docker','network','connect','n8n-net','shops-writing-api']);run(['docker','network','connect','bridge','shops-writing-api'])
writer=release/'writer-image'
if not writer.exists():shutil.copytree(preview/'atomic-image/writer',writer)
(writer/'Dockerfile').write_text(f'FROM {base}\nWORKDIR /app\nCOPY . .\nCMD ["node","server.mjs"]\n')
run(['docker','build','--network=none','-t','shops-writing-writer:20261024.1',str(writer)])
wi=run(['docker','image','inspect','shops-writing-writer:20261024.1','--format','{{.Id}}']).strip()
we={'NODE_ENV':'production','PORT':'8780','BIND_HOST':'0.0.0.0','DATA_ROOT':'/data','PUBLIC_BASE_URL':'https://ducizone.ddns.net/shops-writing-api/results','API_WRITE_TOKEN':cfg['writerToken'],'ID_HMAC_SECRET':cfg['writerHmac']}
(release/'writer.env').write_text('\n'.join(k+'='+v for k,v in we.items())+'\n');(release/'writer.env').chmod(0o600)
(root/'results').mkdir(exist_ok=True)
if not exists('shops-writing-writer'):
 run(['docker','run','-d','--name','shops-writing-writer','--label','izone.product=shops-writing','--restart','unless-stopped','--network','shops-writing-net','--memory','128m','--cpus','0.25','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','50','--env-file',str(release/'writer.env'),'-v',str(root/'results')+':/data',wi]);run(['docker','network','connect','n8n-net','shops-writing-writer'])
for _ in range(20):
 try:
  health=json.loads(run(['curl','-fsS','--max-time','3','http://127.0.0.1:18927/api/v1/shops/status']));assert health['database']=='shops_writing';break
 except Exception:time.sleep(1)
else:raise RuntimeError('Production candidate API not healthy; no public route changed')
receipt={'outcome':'passed','phase':'private-runtime-only','apiImage':image,'writerImage':wi,'database':'shops_writing','root':str(root),'healthy':health,'realClassesOpened':False}
(release/'runtime-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
