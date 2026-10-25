"""VPS: reproduce and repair the queued-versus-leased deadline in Shops only."""
from pathlib import Path
import json,subprocess,urllib.request,uuid,time
root=Path('/opt/izone-shops-writing');release=root/'releases/20261024.1'
def run(a,input=None):
 p=subprocess.run(a,input=input,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(str(a[:3])+': '+p.stderr[-900:])
 return p.stdout.strip()
def sql(q):return run(['docker','exec','-i','shops-writing-db','psql','-U','shops_owner','-d','shops_writing','-qAt','-v','ON_ERROR_STOP=1'],q)
def lit(v):return "'"+str(v).replace("'","''")+"'"
def api(path,body=None):
 req=urllib.request.Request('http://127.0.0.1:18927/api/v1/'+path,data=json.dumps(body).encode() if body is not None else None,headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io'})
 with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
fixture=release/'canary-fixtures.private.json'
if not fixture.exists():
 class_ref=str(uuid.uuid5(uuid.NAMESPACE_URL,'shops-production-release-canary-20261024'))
 cid=sql("INSERT INTO writing_practice.activity_class_scope(activity_id,public_id,erp_course_class_id,class_name_snapshot,end_date,status) VALUES(8,"+lit(class_ref)+",999992426,'SHOPS-KIEM-TRIEN-KHAI','2099-12-31','active') RETURNING id")
 sql("INSERT INTO mapping.reviewer_class_access(reviewer_email,erp_course_class_id) VALUES('shops-release-check@preview.invalid',999992426) ON CONFLICT DO NOTHING;")
 with urllib.request.urlopen('http://127.0.0.1:18924/api/v1/lesson9/sessions/6e89f300-4300-4147-85ce-4766ecd16ed2',timeout=20) as r:template=json.load(r)['session']
 refs=[]
 for i in range(3):
  student=str(uuid.uuid5(uuid.NAMESPACE_URL,'shops-production-release-student-'+str(i)))
  sql("INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias,active) VALUES("+cid+","+lit(student)+","+lit('Học viên kiểm triển khai '+str(i+1))+","+lit('HV kiểm '+str(i+1)) +",true)")
  s=api('lesson9/sessions',{'activitySlug':'writing-task2-public-health-ban','classRef':class_ref,'studentRef':student})['session']
  sql("UPDATE writing_practice.activity_session SET response_data="+lit(json.dumps(template['responses']))+"::jsonb WHERE public_id="+lit(s['sessionRef'])+"; UPDATE writing_practice.session_section SET locked=(section_key<>'draft') WHERE session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id="+lit(s['sessionRef'])+"); UPDATE writing_practice.lesson9_session_state SET data='{\"idea2Opened\":true,\"draft2Open\":true}'::jsonb WHERE session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id="+lit(s['sessionRef'])+");")
  refs.append({'sessionRef':s['sessionRef'],'studentRef':student})
 fixture.write_text(json.dumps({'classRef':class_ref,'classId':int(cid),'sessions':refs}));fixture.chmod(0o600)
f=json.loads(fixture.read_text());session=f['sessions'][0]['sessionRef']
def probe(status):
 ref=str(uuid.uuid4());request=str(uuid.uuid4())
 number=sql("SELECT coalesce(max(comment_number),0)+1 FROM writing_practice.check_attempt WHERE session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id="+lit(session)+") AND section_key='draft'")
 extra=",worker_id,lease_token,lease_expires_at" if status=='leased' else ''
 values=",'release-deadline-probe',gen_random_uuid(),now()+interval '20 minutes'" if status=='leased' else ''
 sql("WITH a AS (INSERT INTO writing_practice.check_attempt(public_id,session_id,section_key,round_number,comment_number,request_id,body_hash,snapshot,status,created_at"+extra+") SELECT "+lit(ref)+",id,'draft',1,"+number+","+lit(request)+",repeat('a',64),'{}'::jsonb,"+lit(status)+",now()-interval '4 minutes'"+values+" FROM writing_practice.activity_session WHERE public_id="+lit(session)+" RETURNING id,session_id) INSERT INTO writing_practice.comment(attempt_id,session_id,section_key,comment_number,status,content) SELECT id,session_id,'draft',"+number+",'queued','Kiểm thời hạn hàng chờ' FROM a")
 result=api('attempts/'+ref)['attempt']['status']
 sql("UPDATE writing_practice.check_attempt SET status='failed',error_code='RELEASE_QUEUE_GUARD_PROBE',lease_token=NULL,lease_expires_at=NULL,worker_id=NULL WHERE public_id="+lit(ref)+"; UPDATE writing_practice.comment SET status='technical_error',content='Đã hoàn tất kiểm thời hạn hàng chờ' WHERE attempt_id=(SELECT id FROM writing_practice.check_attempt WHERE public_id="+lit(ref)+");")
 return result
receipt=release/'queue-guard-receipt.json'
assert not receipt.exists(),'Already verified; preserve receipt'
red=probe('queued');assert red=='failed',red
source=release/'image/src/service.js';old=source.read_text();assert old.count('GRADING_TIMEOUT_3_MINUTES')==2
(release/'service-before-queue-guard.js').write_text(old)
patched=old.replace('GRADING_TIMEOUT_3_MINUTES','SHOPS_GRADING_TIMEOUT').replace('Lượt chấm vừa rồi mất quá 3 phút nên đã dừng. Em hãy bấm Check lại.','Lượt chấm đã quá thời hạn xử lý. Em hãy bấm Check lại.')
needle="AND attempt.created_at<=now()-interval '3 minutes'"
assert patched.count(needle)==1
patched=patched.replace(needle,"AND ((attempt.status='queued' AND attempt.created_at<=now()-interval '45 minutes') OR (attempt.status='leased' AND attempt.lease_expires_at<=now()))")
source.write_text(patched)
run(['docker','build','--network=none','-t','shops-writing-api:20261024.2',str(release/'image')])
image=run(['docker','image','inspect','shops-writing-api:20261024.2','--format','{{.Id}}'])
before=json.loads(run(['docker','inspect','shops-writing-api']))[0]
run(['docker','stop','shops-writing-api']);run(['docker','rename','shops-writing-api','shops-writing-api-before-queue-guard']);run(['docker','update','--restart=no','shops-writing-api-before-queue-guard'])
run(['docker','run','-d','--name','shops-writing-api','--label','izone.product=shops-writing','--restart','unless-stopped','--network','shops-writing-net','--memory','256m','--cpus','0.5','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','100','--env-file',str(release/'api.env'),'-p','127.0.0.1:18927:8790',image])
run(['docker','network','connect','n8n-net','shops-writing-api']);run(['docker','network','connect','bridge','shops-writing-api'])
for _ in range(20):
 try:assert api('shops/status')['database']=='shops_writing';break
 except Exception:time.sleep(1)
else:raise RuntimeError('New Shops API not healthy')
green_queued=probe('queued');green_leased=probe('leased');assert green_queued=='queued' and green_leased=='leased'
result={'outcome':'passed','oldQueuedAt4Minutes':red,'newQueuedAt4Minutes':green_queued,'newLeasedAt4MinutesWithLiveLease':green_leased,'oldImage':before['Image'],'apiImage':image,'queuedDeadlineMinutes':45,'usesLeaseDeadline':True,'realStudentWrites':False}
receipt.write_text(json.dumps(result,indent=2));print(json.dumps(result))
