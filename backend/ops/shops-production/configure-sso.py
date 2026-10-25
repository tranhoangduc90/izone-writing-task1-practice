"""VPS: validate Shops against a separate broker candidate, then add the source.
The activation phase preserves the live session store and all existing sources.
"""
from pathlib import Path
import json,subprocess,hashlib,secrets,urllib.request,urllib.error,sys,os,time
root=Path('/opt/izone-shops-writing');release=root/'releases/20261024.1'
private=Path('/opt/izone-teacher-session/private')
def run(a,input=None):
 p=subprocess.run(a,input=input,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(str(a[:3])+': '+p.stderr[-800:])
 return p.stdout
def sql(q):return run(['docker','exec','-i','shops-writing-db','psql','-U','shops_owner','-d','shops_writing','-qAt','-v','ON_ERROR_STOP=1'],q).strip()
cfg=json.loads((root/'runtime.private.json').read_text())
live=json.loads(run(['docker','inspect','izone-teacher-session']))[0]
current=Path(live['Config']['Cmd'][-1].replace('/run/teacher-session',str(private)))
original=json.loads(current.read_text());new=json.loads(current.read_text())
source={'connectionString':'postgres://izone_teacher_sso:'+cfg['ssoPassword']+'@shops-writing-db/shops_writing','kind':'reviewer','schema':'mapping','cookieName':'izone_shops_teacher','cookiePath':'/shops-writing-api','bridgePath':'/shops-writing-api/api/v1/auth/session/shared-session'}
new['sources']['shops']=source;new['revision']=original['revision']+'-shops-20261024'
for key,value in original['sources'].items():assert new['sources'][key]==value
if sys.argv[1]=='prepare':
 role=sql("SELECT count(*) FROM pg_roles WHERE rolname='izone_teacher_sso'")
 if role=='0':sql('ALTER ROLE shops_sso RENAME TO izone_teacher_sso;')
 sql('GRANT UPDATE(google_subject,last_login_at,updated_at) ON mapping.reviewer_account TO izone_teacher_sso; GRANT DELETE ON mapping.reviewer_session TO izone_teacher_sso;')
 sql("UPDATE mapping.reviewer_session SET revoked_at=now() WHERE reviewer_email='shops-release-check@preview.invalid' AND revoked_at IS NULL;")
 token=secrets.token_urlsafe(32);digest=hashlib.sha256(token.encode()).hexdigest()
 sql("INSERT INTO mapping.reviewer_account(email,google_subject,display_name,role,status,can_access_all_classes) VALUES('shops-release-check@preview.invalid','shops-production-release-check','Giảng viên kiểm triển khai','teacher','active',false) ON CONFLICT(email) DO UPDATE SET status='active'; INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at) VALUES(decode('"+digest+"','hex'),'shops-release-check@preview.invalid','shops-production-release-check',now()+interval '1 hour',now()+interval '1 hour');")
 (release/'fixture-native.private.json').write_text(json.dumps({'cookie':'izone_shops_teacher='+token}));(release/'fixture-native.private.json').chmod(0o600)
 candidate={**new,'sources':{'shops':source},'store':'/data/shops-canary.sqlite'}
 path=private/'shops-canary-20261024.json';path.write_text(json.dumps(candidate));os.chown(path,current.stat().st_uid,current.stat().st_gid);path.chmod(current.stat().st_mode&0o777)
 data=root/'sso-canary';data.mkdir(exist_ok=True);os.chown(data,1000,1000)
 canary='shops-sso-canary-20261024'
 if not run(['docker','ps','-a','--filter','name=^/'+canary+'$','-q']).strip():
  run(['docker','run','-d','--name',canary,'--label','izone.product=shops-writing','--network','shops-writing-net','--memory','128m','--cpus','0.25','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','-p','127.0.0.1:18929:8962','-v',str(private)+':/run/teacher-session:ro','-v',str(data)+':/data',live['Image'],'node','scripts/serve-teacher-sso.mjs','/run/teacher-session/'+path.name])
 info=json.loads(run(['docker','inspect',canary]))[0]
 if 'bridge' not in info['NetworkSettings']['Networks']:run(['docker','network','connect','bridge',canary])
 def post(path,cookie=''):
  req=urllib.request.Request('http://127.0.0.1:18929/v1/'+path,data=b'{}',headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io','X-Izone-Csrf':'1','Cookie':cookie})
  with urllib.request.urlopen(req,timeout=15) as r:return r.status,r.headers.get_all('Set-Cookie') or [],json.load(r)
 for _ in range(15):
  try:code,cookies,value=post('source/shops','izone_shops_teacher='+token);assert code==200;break
  except Exception:time.sleep(1)
 else:raise RuntimeError('Separate Shops broker candidate failed; production broker not changed')
 shared=next(c.split(';',1)[0] for c in cookies if c.startswith('izone_teacher_shared='))
 assert post('restore/shops',shared)[0]==200
 assert post('logout',shared)[0]==200
 active=int(sql("SELECT count(*) FROM mapping.reviewer_session WHERE reviewer_email='shops-release-check@preview.invalid' AND revoked_at IS NULL"));assert active==0
 baseline={'containerId':live['Id'],'image':live['Image'],'config':str(current),'sha256':hashlib.sha256(current.read_bytes()).hexdigest(),'sourceIds':list(original['sources'])}
 (release/'sso-baseline.json').write_text(json.dumps(baseline,indent=2));(release/'sso-candidate-receipt.json').write_text(json.dumps({'outcome':'passed','source':'shops','nativeSourceRestoreLogout':True,'existingSourcesUnchanged':True,'googleVerification':False}))
 print(json.dumps({'outcome':'passed','phase':'separate-broker-candidate','nativeSourceRestoreLogout':True,'existingSourcesUnchanged':True,'googleVerification':False}))
elif sys.argv[1]=='activate':
 baseline=json.loads((release/'sso-baseline.json').read_text());assert live['Id']==baseline['containerId'] and hashlib.sha256(current.read_bytes()).hexdigest()==baseline['sha256'],'Broker changed concurrently'
 path=private/'config-shops-20261024.json';path.write_text(json.dumps(new));os.chown(path,current.stat().st_uid,current.stat().st_gid);path.chmod(current.stat().st_mode&0o777)
 (release/'sso-before.private.json').write_bytes(current.read_bytes());(release/'sso-before.private.json').chmod(0o600)
 backup='izone-teacher-session-before-shops-20261024';assert not run(['docker','ps','-a','--filter','name=^/'+backup+'$','-q']).strip()
 run(['docker','stop','izone-teacher-session']);run(['docker','rename','izone-teacher-session',backup]);run(['docker','update','--restart=no',backup])
 args=['docker','run','-d','--name','izone-teacher-session','--restart','unless-stopped','--network','n8n-net','--memory','256m','--cpus','0.5','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','100','-p','127.0.0.1:8968:8962']
 for m in live['Mounts']:args+=['-v',m['Source']+':'+m['Destination']+('' if m['RW'] else ':ro')]
 run(args+[live['Image'],'node','scripts/serve-teacher-sso.mjs','/run/teacher-session/'+path.name])
 for network in list(live['NetworkSettings']['Networks'])+['shops-writing-net']:
  if network!='n8n-net':run(['docker','network','connect',network,'izone-teacher-session'])
 for _ in range(20):
  try:
   req=urllib.request.Request('http://127.0.0.1:8968/v1/restore/shops',data=b'{}',headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io','X-Izone-Csrf':'1'})
   try:urllib.request.urlopen(req,timeout=4)
   except urllib.error.HTTPError as e:assert e.code==401;break
  except Exception:time.sleep(1)
 else:raise RuntimeError('Broker did not become ready; rollback container preserved; no store restore allowed')
 report={'outcome':'passed','sourceAdded':'shops','existingSourceIdsPreserved':list(original['sources']),'imageUnchanged':True,'liveStorePreserved':new['store']==original['store'],'rollbackContainer':backup}
 (release/'sso-release-receipt.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
else:raise RuntimeError('Unknown phase')
