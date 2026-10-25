"""AI-free protocol tests against the real staging API/DB, fixture classes only."""
from pathlib import Path
import json,uuid,subprocess,urllib.request,urllib.error,datetime
root=Path('/opt/izone-sw-task2-preview-20261025');fixtures=json.loads((root/'fixtures.private.json').read_text());cfg=json.loads((root/'runtime.private.json').read_text())
def uid():return str(uuid.uuid4())
def sql(q):
 p=subprocess.run(['docker','exec','-i','sw-task2-preview-db','psql','-U','sw_owner','-d','sw_task2_preview_20261025','-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True)
 assert p.returncode==0,p.stderr[-1000:];return p.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def api(path,method='GET',body=None,expected=200,internal=False,cookie=''):
 q=urllib.request.Request('http://127.0.0.1:18935/api/v1/'+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io','X-Izone-Csrf':'1',**({'Authorization':'Bearer '+cfg['apiToken']} if internal else {}),**({'Cookie':cookie} if cookie else {})})
 try:
  with urllib.request.urlopen(q,timeout=20) as r:code=r.status;raw=r.read();data=json.loads(raw) if 'json' in r.headers.get('content-type','') else raw.decode('utf-8-sig')
 except urllib.error.HTTPError as e:code=e.code;data=json.load(e)
 assert code==expected,(path,code,data);return data
assert sql("SELECT count(*) FROM writing_practice.check_attempt WHERE status IN ('queued','leased')")=='0','Wait for native jobs first'
subprocess.run(['systemctl','stop','sw-task2-preview-worker.service'],check=True)
report={'aiMode':'mock callbacks on real API/DB','productionWrites':False,'checks':[]}
try:
 sessions=[]
 for i,slug in enumerate(['writing-task2-public-health-ban','writing-task2-public-health-spending']):
  f=next(f for f in fixtures['classes'] if f['activitySlug']==slug and f['className']=='SW-THU-B')
  s=api('lesson9/sessions','POST',{'activitySlug':slug,'classRef':f['classRef'],'studentRef':f['students'][5]},expected=201)['session']
  vals={k:'Nội dung giả để kiểm giao thức, không phải bằng chứng AI chấm đạt.' for d in s['sectionDefinitions'] for k in d['inputFields'] if k not in ['draft1','draft2']};vals['body_choice']='body1'
  body={'baseVersion':s['draftVersion'],'requestId':uid(),'responses':vals};saved=api('lesson-sessions/'+s['sessionRef']+'/responses','PUT',body)['session']
  api('lesson-sessions/'+s['sessionRef']+'/responses','PUT',{**body,'requestId':uid(),'responses':{**vals,'topic_sentence':'Must not overwrite'}},expected=409)
  a=api('lesson-sessions/'+s['sessionRef']+'/checks','POST',{'section':'topic_sentence','requestId':uid()},expected=202)['attempt'];sessions.append((s,a))
 jobs=api('internal/grading-jobs/claim','POST',{'workerId':'protocol-fixture','workerPool':'task2','maxJobs':2,'leaseSeconds':420},internal=True)['jobs'];assert len(jobs)==2
 expected={s['sessionRef']:a['attemptRef'] for s,a in sessions};job_by_ref={j['attemptRef']:j for j in jobs}
 assert {j['activitySlug'] for j in jobs}=={'writing-task2-public-health-ban','writing-task2-public-health-spending'}
 for j in reversed(jobs):
  api('internal/grading-jobs/'+j['jobRef']+'/complete','POST',{'leaseToken':uid(),'resultStatus':'needs_revision','feedback':'Wrong owner callback'},expected=409,internal=True)
  api('internal/grading-jobs/'+j['jobRef']+'/complete','POST',{'leaseToken':j['leaseToken'],'resultStatus':'needs_revision','feedback':'PROTOCOL_FIXTURE_ONLY:'+j['activitySlug']},internal=True)
 for s,a in sessions:
  got=api('lesson9/sessions/'+s['sessionRef'])['session'];comment=next(c for c in got['comments'] if c['attemptRef']==a['attemptRef'])
  assert comment['feedback']=='PROTOCOL_FIXTURE_ONLY:'+got['activitySlug']
 report['checks']+=['optimistic conflict preserves first write','two lesson jobs retain pinned context','reverse callbacks update correct two attempts','wrong lease cannot complete another job']
 # Age probes bypass AI; leave every probe terminal before restarting the worker.
 s=sessions[0][0];ref=s['sessionRef']
 for status,expired,want in [('queued',False,'queued'),('leased',False,'leased'),('leased',True,'failed')]:
  attempt=uid();request=uid();lease=uid()
  extra=',worker_id,lease_token,lease_expires_at' if status=='leased' else ''
  vals=",'protocol-age',"+lit(lease)+",now()+interval '"+('-1 second' if expired else '20 minutes')+"'" if status=='leased' else ''
  number=sql("SELECT coalesce(max(comment_number),0)+1 FROM writing_practice.check_attempt WHERE session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id="+lit(ref)+") AND section_key='topic_sentence'")
  q="WITH a AS (INSERT INTO writing_practice.check_attempt(public_id,session_id,section_key,round_number,comment_number,request_id,body_hash,snapshot,status,created_at"+extra+") SELECT "+lit(attempt)+",id,'topic_sentence',1,"+number+","+lit(request)+",repeat('b',64),response_data,"+lit(status)+",now()-interval '4 minutes'"+vals+" FROM writing_practice.activity_session WHERE public_id="+lit(ref)+" RETURNING id,session_id) INSERT INTO writing_practice.comment(attempt_id,session_id,section_key,comment_number,status,content) SELECT id,session_id,'topic_sentence',"+number+",'queued','PROTOCOL_FIXTURE_ONLY' FROM a"
  sql(q)
  got=api('attempts/'+attempt)['attempt'];assert got['status']==want,(status,expired,got)
  sql("UPDATE writing_practice.check_attempt SET status='failed',error_code='PROTOCOL_FIXTURE_FINISHED',late_callback_token=NULL,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE public_id="+lit(attempt)+"; UPDATE writing_practice.comment SET status='technical_error',content='PROTOCOL_FIXTURE_FINISHED' WHERE attempt_id=(SELECT id FROM writing_practice.check_attempt WHERE public_id="+lit(attempt)+");")
  report['checks'].append({'probeStatus':status,'expiredLease':expired,'atFourMinutes':want})
 # Teacher CSV is a scoped read; no admin role is used for the fixture class.
 f=next(f for f in fixtures['classes'] if f['activitySlug'].endswith('health-spending') and f['className']=='SW-THU-A')
 csv=api('admin/activities/'+f['activitySlug']+'/export.csv?classRef='+f['classRef'],cookie=fixtures['cookies']['teacher'])
 assert 'SW-THU-A' in csv and 'CS.' not in csv;report['checks'].append('teacher CSV limited to requested fixture class')
 report['databaseRole']=json.loads(sql("SELECT json_build_object('superuser',rolsuper,'createDatabase',rolcreatedb,'createRole',rolcreaterole,'canConnectOtherDatabase',has_database_privilege('sw_api','postgres','CONNECT')) FROM pg_roles WHERE rolname='sw_api'"))
 assert not any(report['databaseRole'].values())
 report['outcome']='passed';(root/'protocol-tests.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
finally:
 subprocess.run(['systemctl','start','sw-task2-preview-worker.service'],check=True)
