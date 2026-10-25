"""24/47 synthetic concurrent learners; real HTTPS/API/DB and worker scheduler.
Only the AI webhook is replaced in a private test copy of the deployed worker.
No native worker source/config is edited. Original preview service is restored.
"""
from pathlib import Path
import subprocess,json,uuid,urllib.request,urllib.error,time,threading,concurrent.futures,http.server,os,hashlib,statistics,datetime,signal
root=Path('/opt/izone-sw-task2-preview-20261025');out=root/'six-lessons/load';out.mkdir(exist_ok=True)
cfg=json.loads((root/'runtime.private.json').read_text());fixtures=json.loads((root/'fixtures.private.json').read_text());lessons=json.loads((root/'candidate/lessons.json').read_text());lock=threading.Lock()
native='sw-task2-preview-worker.service';metrics=[];jobs={};arrivals=[];active=0;max_active=0;handler_errors=[];loadworker=None;created_scopes=[]
public='https://ducizone.ddns.net/sw-task2-preview-api/api/v1/';internal='http://127.0.0.1:18935/api/v1/'
def uid():return str(uuid.uuid4())
def lit(v):return "'"+str(v).replace("'","''")+"'"
def pg(q):
 p=subprocess.run(['docker','exec','-i','sw-task2-preview-db','psql','-U','sw_owner','-d','sw_task2_preview_20261025','-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True);assert p.returncode==0,p.stderr[-1000:];return p.stdout.strip()
def call(path,method='GET',body=None,expected=200,priv=False,cookie='',tag=None):
 start=time.monotonic();q=urllib.request.Request((internal if priv else public)+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io','X-Izone-Csrf':'1',**({'Authorization':'Bearer '+cfg['apiToken']} if priv else {}),**({'Cookie':cookie} if cookie else {})})
 try:
  with urllib.request.urlopen(q,timeout=30) as r:code=r.status;data=json.load(r)
 except urllib.error.HTTPError as e:code=e.code;data=json.load(e)
 if tag:
  with lock:metrics.append({'kind':tag,'ms':round((time.monotonic()-start)*1000,2),'status':code})
 assert code==expected,(path,code,data)
 return data
class Handler(http.server.BaseHTTPRequestHandler):
 def log_message(self,*args):pass
 def do_POST(self):
  global active,max_active
  if self.path!='/dispatch' or self.headers.get('X-Shops-Worker-Key')!=cfg['workerKey']:self.send_error(403);return
  try:
   found=call('internal/grading-jobs/claim','POST',{'workerId':'sw-preview-load-fixture','workerPool':'task2','maxJobs':1,'leaseSeconds':420},priv=True)['jobs']
   if found:
    j=found[0]
    with lock:
     assert j['attemptRef'] in jobs,'Unexpected non-load job: abort; native preview worker will recover lease'
     owner=jobs[j['attemptRef']];active+=1;max_active=max(active,max_active)
    assert j['activitySlug']==owner['slug'] and j['taskPrompt']==lessons[owner['slug']]['statement']
    assert j['promptRecordId']=='sw-task2:'+owner['slug']+':lesson9-v1' and j['promptVersion']=='2026-10-25.1'
    time.sleep(1.5 if owner['ordinal']%2 else 2.0)
    call('internal/grading-jobs/'+j['jobRef']+'/complete','POST',{'leaseToken':str(uuid.uuid4()),'resultStatus':'passed','feedback':'Wrong lease'},expected=409,priv=True)
    call('internal/grading-jobs/'+j['jobRef']+'/complete','POST',{'leaseToken':j['leaseToken'],'resultStatus':'passed','feedback':'LOAD_FIXTURE_ONLY:'+owner['slug']+':'+j['attemptRef'],'rawModelMeta':{'provider':'load-fixture','realAI':False}},priv=True)
    with lock:active-=1;arrivals.append({'attemptRef':j['attemptRef'],'elapsedSeconds':round(time.monotonic()-owner['queuedAt'],3),'ordinal':owner['ordinal']})
   self.send_response(200);self.send_header('Content-Type','application/json');self.end_headers();self.wfile.write(b'{"ok":true,"aiMode":"mock-load-fixture"}')
  except Exception as e:
   with lock:handler_errors.append(type(e).__name__+':'+str(e))
   self.send_error(500)
def resource():
 p=subprocess.run(['docker','stats','--no-stream','--format','{{json .}}','sw-task2-preview-api','sw-task2-preview-db','shops-writing-api','writing-task1-practice-api'],capture_output=True,text=True)
 return [json.loads(line) for line in p.stdout.splitlines() if line.strip()] if p.returncode==0 else []
def fixture_scope(slug,count,name,run):
 aid=pg('SELECT id FROM writing_practice.activity WHERE slug='+lit(slug));ref=uid();erp=900000000+uuid.uuid4().int%90000000
 q="WITH c AS (INSERT INTO writing_practice.activity_class_scope(activity_id,public_id,erp_course_class_id,class_name_snapshot,status,end_date) VALUES("+aid+","+lit(ref)+","+str(erp)+","+lit(name)+",'active','2099-12-31') RETURNING id) INSERT INTO writing_practice.sw_preview_scope SELECT id,'fixture' FROM c"
 pg(q);created_scopes.append(ref);pg("INSERT INTO mapping.reviewer_class_access(reviewer_email,erp_course_class_id) VALUES('sw-preview-check@preview.invalid',"+str(erp)+") ON CONFLICT DO NOTHING")
 people=[]
 for ordinal in range(count):
  sid=uid();display='Học viên thử tải '+str(run)+'-'+str(ordinal+1).zfill(2)
  pg("INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias,active) SELECT id,"+lit(sid)+","+lit(display)+","+lit(display)+",true FROM writing_practice.activity_class_scope WHERE public_id="+lit(ref));people.append({'slug':slug,'classRef':ref,'studentRef':sid})
 return people
def user_start(identity,ordinal,barrier):
 barrier.wait();slug=identity['slug'];call('activities/'+slug+'/roster',tag='roster')
 s=call('lesson9/sessions','POST',{'activitySlug':slug,'classRef':identity['classRef'],'studentRef':identity['studentRef']},expected=201,tag='open')['session']
 allowed={k for d in s['sectionDefinitions'] for k in d['inputFields']};values={k:'LOAD_FIXTURE_ONLY '+str(ordinal)+' '+k for k in allowed if k not in ['draft1','draft2']};values['body_choice']='body1'
 saved=call('lesson-sessions/'+s['sessionRef']+'/responses','PUT',{'baseVersion':s['draftVersion'],'requestId':uid(),'responses':values},tag='save')['session']
 if ordinal==0:call('lesson-sessions/'+s['sessionRef']+'/responses','PUT',{'baseVersion':s['draftVersion'],'requestId':uid(),'responses':values},expected=409,tag='conflict')
 body={'section':'topic_sentence','requestId':uid()};a=call('lesson-sessions/'+s['sessionRef']+'/checks','POST',body,expected=202,tag='check')['attempt'];again=call('lesson-sessions/'+s['sessionRef']+'/checks','POST',body,expected=202,tag='duplicate-check')['attempt'];assert a['attemptRef']==again['attemptRef']
 with lock:jobs[a['attemptRef']]={**identity,'sessionRef':s['sessionRef'],'ordinal':ordinal,'queuedAt':time.monotonic(),'responses':values}
 return a['attemptRef']
def percentile(values,p):
 ordered=sorted(values);return round(ordered[min(len(ordered)-1,int((len(ordered)-1)*p))],2) if ordered else None
def scenario(n,run):
 global loadworker,max_active
 assert pg("SELECT count(*) FROM writing_practice.check_attempt WHERE status IN ('queued','leased')")=='0'
 start_metrics=len(metrics);start_arrivals=len(arrivals);max_active=0;started=time.monotonic();identities=[]
 if n==24:identities=fixture_scope('writing-task2-crime-prevention-responsibility',24,'SW-TAI-24',run)
 else:
  for index,slug in enumerate(lessons):identities+=fixture_scope(slug,6 if index<7 else 5,'SW-TAI-47',run)
 barrier=threading.Barrier(n)
 with concurrent.futures.ThreadPoolExecutor(max_workers=n) as pool:refs=list(pool.map(lambda pair:user_start(pair[1],pair[0],barrier),enumerate(identities)))
 resources=[resource()];before=len(arrivals);env={**os.environ,'SW_PREVIEW_WORKER_CONFIG':str(out/'worker-config.private.json'),'STATE_DIRECTORY':str(out/('state-'+str(n)))};Path(env['STATE_DIRECTORY']).mkdir(exist_ok=True)
 with (out/('worker-'+str(n)+'.log')).open('w') as log:loadworker=subprocess.Popen(['/usr/bin/python3',str(out/'worker-load.py')],env=env,stdout=log,stderr=log)
 with concurrent.futures.ThreadPoolExecutor(max_workers=n+2) as observers:
  deadline=time.monotonic()+600;iteration=0
  while len(arrivals)-before<n:
   assert loadworker.poll() is None,'Test worker exited'
   assert not handler_errors,handler_errors
   assert time.monotonic()<deadline,'Queue deadline exceeded'
   owned=[jobs[ref] for ref in refs]
   futures=[observers.submit(call,'lesson9/sessions/'+j['sessionRef'],tag='poll') for j in owned]
   sample=owned[0];futures.append(observers.submit(call,'admin/live/activities/'+sample['slug']+'?classRef='+sample['classRef'],cookie=fixtures['cookies']['teacher'],tag='teacher-dashboard'))
   for f in futures:f.result()
   iteration+=1
   if iteration==2:resources.append(resource())
   (out/'progress.json').write_text(json.dumps({'users':n,'completed':len(arrivals)-before,'queued':call('sw/status')['queued'],'maxConcurrent':max_active,'elapsedSeconds':round(time.monotonic()-started,1)}))
   time.sleep(5)
 loadworker.send_signal(signal.SIGTERM);loadworker.wait(timeout=15);loadworker=None
 for ref in refs:
  owner=jobs[ref];s=call('lesson9/sessions/'+owner['sessionRef'],tag='final-read')['session'];a=next(a for a in s['attempts'] if a['attemptRef']==ref);c=next(c for c in s['comments'] if c['attemptRef']==ref)
  assert a['status']=='completed' and a['resultStatus']=='passed';assert c['feedback']=='LOAD_FIXTURE_ONLY:'+owner['slug']+':'+ref
  assert all(s['responses'][k]==v for k,v in owner['responses'].items())
 assert max_active==2,('Expected deployed two-slot scheduler',max_active)
 assert len({a['attemptRef'] for a in arrivals[before:]})==n
 times=[a['elapsedSeconds'] for a in arrivals[before:]];m=metrics[start_metrics:];summary={}
 for kind in {r['kind'] for r in m}:
  rows=[r['ms'] for r in m if r['kind']==kind];summary[kind]={'requests':len(rows),'p50Ms':percentile(rows,.5),'p95Ms':percentile(rows,.95),'maxMs':max(rows)}
 resources.append(resource())
 return {'outcome':'passed','concurrentLearners':n,'lessonCount':len({j['slug'] for j in identities}),'completedJobs':n,'maxConcurrentWorkerJobs':max_active,'durationSeconds':round(time.monotonic()-started,2),'queueSeconds':{'p50':percentile(times,.5),'p95':percentile(times,.95),'max':max(times)},'http':summary,'resources':resources,'lostDrafts':0,'duplicateAttempts':0,'misassignedResults':0,'aiMode':'mock 1.5/2-second callback','transport':'public HTTPS for learners and teacher; internal authenticated claim/callback','teacherAuth':'native fixture cookie, not Google broker load','pollingIntervalSeconds':5}
assert pg('SELECT current_database()')=='sw_task2_preview_20261025'
assert pg("SELECT count(*) FROM writing_practice.check_attempt WHERE status IN ('queued','leased')")=='0','Wait until real AI acceptance completes'
source=(root/'worker.py').read_text();needle="assert c['webhookUrl']=='http://127.0.0.1:5678/webhook/sw_task2_preview_worker'";assert source.count(needle)==1
(out/'worker-load.py').write_text(source.replace(needle,"assert c['webhookUrl']=='http://127.0.0.1:18937/dispatch'"))
worker_cfg=json.loads((root/'worker-config.private.json').read_text());worker_cfg['webhookUrl']='http://127.0.0.1:18937/dispatch';(out/'worker-config.private.json').write_text(json.dumps(worker_cfg));(out/'worker-config.private.json').chmod(0o600)
original_hash=hashlib.sha256((root/'worker.py').read_bytes()).hexdigest();report={'outcome':'running','scenarios':[],'productionWrites':False,'realAI':False,'workerSchedulingSourceSha256':original_hash,'workerTestDelta':'Only webhook destination assertion in a private copy; native source/config unchanged','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat().replace('+00:00','Z')}
server=http.server.ThreadingHTTPServer(('127.0.0.1',18937),Handler);threading.Thread(target=server.serve_forever,daemon=True).start()
subprocess.run(['systemctl','stop',native],check=True)
try:
 for n,run in [(24,24),(47,47)]:
  report['scenarios'].append(scenario(n,run));(out/'report.json').write_text(json.dumps(report,indent=2));print(json.dumps({'users':n,'outcome':'passed'}),flush=True)
 report['outcome']='passed'
except Exception as e:report.update(outcome='failed',error=type(e).__name__+':'+str(e));raise
finally:
 if loadworker and loadworker.poll() is None:loadworker.send_signal(signal.SIGTERM);loadworker.wait(timeout=15)
 server.shutdown()
 if created_scopes:
  ids=','.join(lit(x) for x in created_scopes)
  pg("WITH ended AS(UPDATE writing_practice.check_attempt a SET status='failed',error_code='LOAD_FIXTURE_ABORTED',late_callback_token=NULL,lease_token=NULL,lease_expires_at=NULL,worker_id=NULL FROM writing_practice.activity_session s JOIN writing_practice.activity_class_scope c ON c.id=s.activity_class_id WHERE a.session_id=s.id AND c.public_id IN ("+ids+") AND a.status IN ('queued','leased') RETURNING a.id) UPDATE writing_practice.comment SET status='technical_error',content='LOAD_FIXTURE_ABORTED' WHERE attempt_id IN (SELECT id FROM ended)")
  pg("UPDATE writing_practice.activity_class_scope SET status='closed' WHERE public_id IN ("+ids+") AND class_name_snapshot IN ('SW-TAI-24','SW-TAI-47')")
 assert hashlib.sha256((root/'worker.py').read_bytes()).hexdigest()==original_hash
 subprocess.run(['systemctl','start',native],check=True)
 report['nativePreviewWorkerRestored']=subprocess.check_output(['systemctl','is-active',native],text=True).strip()=='active';report['loadDataPreservedAndScopesClosed']=True;(out/'report.json').write_text(json.dumps(report,indent=2))
