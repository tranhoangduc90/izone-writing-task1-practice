"""Native Draft-only clean-text probe. Reasoning state is explicit fixture setup."""
from pathlib import Path
import json,subprocess,uuid,urllib.request,urllib.error
root=Path('/opt/izone-sw-task2-preview-20261025');file=root/'zero-e2e.private.json'
f=json.loads((root/'fixtures.private.json').read_text());cfg=json.loads((root/'runtime.private.json').read_text())
def uid():return str(uuid.uuid4())
def api(path,method='GET',body=None,internal=False,expected=200):
 q=urllib.request.Request('http://127.0.0.1:18935/api/v1/'+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io','X-Izone-Csrf':'1',**({'Authorization':'Bearer '+cfg['apiToken']} if internal else {})})
 try:
  with urllib.request.urlopen(q,timeout=20) as r:code=r.status;d=json.load(r)
 except urllib.error.HTTPError as e:code=e.code;d=json.load(e)
 assert code==expected,(code,d);return d
if not file.exists():
 fixture=next(c for c in f['classes'] if c['activitySlug'].endswith('-ban') and c['className']=='SW-THU-A')
 s=api('lesson9/sessions','POST',{'activitySlug':fixture['activitySlug'],'classRef':fixture['classRef'],'studentRef':fixture['students'][1]},expected=201)['session']
 clean='A total ban would limit consumer choice. Clear health warnings could help people make informed decisions without removing that choice.'
 responses={'body_choice':'body1','body1_message':'Không đồng ý với lệnh cấm toàn diện.','body1_idea1':'Lệnh cấm hạn chế quyền lựa chọn.','body1_idea2':'Cảnh báo sức khỏe là phương án ít hạn chế hơn.','body2_message':'Cần giúp người dân hiểu rủi ro.','body2_idea1':'Thông tin rõ giúp quyết định phù hợp.','body2_idea2':'Giáo dục hỗ trợ thay đổi thói quen.','topic_sentence':'Health warnings can protect public health while preserving consumer choice.','idea1_a':'Lệnh cấm loại bỏ lựa chọn.','idea1_x':'Người tiêu dùng không thể cân nhắc và quyết định mua sản phẩm.','idea1_b':'Quyền tự quyết bị hạn chế.','idea2_a':'Cảnh báo cung cấp thông tin.','idea2_x':'Người mua biết rủi ro để cân nhắc trước khi chọn.','idea2_b':'Người mua vẫn được quyết định.','draft1':clean,'draft2':clean}
 def lit(v):return "'"+str(v).replace("'","''")+"'"
 q="BEGIN; DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM writing_practice.activity_session s JOIN writing_practice.sw_preview_scope p ON p.scope_id=s.activity_class_id AND p.kind='fixture' WHERE s.public_id="+lit(s['sessionRef'])+") THEN RAISE EXCEPTION 'Not a fixture'; END IF; END $$; UPDATE writing_practice.activity_session SET response_data="+lit(json.dumps(responses,ensure_ascii=False))+"::jsonb,draft2_unlocked=true WHERE public_id="+lit(s['sessionRef'])+"; UPDATE writing_practice.session_section SET locked=(section_key<>'draft') WHERE session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id="+lit(s['sessionRef'])+"); UPDATE writing_practice.lesson9_session_state SET data='{\"idea2Opened\":true,\"draft2Open\":true,\"fixtureSetup\":true}'::jsonb WHERE session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id="+lit(s['sessionRef'])+"); COMMIT;"
 p=subprocess.run(['docker','exec','-i','sw-task2-preview-db','psql','-U','sw_owner','-d','sw_task2_preview_20261025','-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True);assert p.returncode==0,p.stderr
 a=api('lesson-sessions/'+s['sessionRef']+'/checks','POST',{'section':'draft','requestId':uid()},expected=202)['attempt']
 api('internal/grading-jobs/'+a['attemptRef']+'/complete','POST',{'leaseToken':uid(),'resultStatus':'passed','feedback':'Wrong lease fixture callback'},internal=True,expected=409)
 state={'sessionRef':s['sessionRef'],'studentRef':fixture['students'][1],'classRef':fixture['classRef'],'attemptRef':a['attemptRef'],'reasoningSetup':'fixture only; not AI evidence','wrongLeaseDenied':True};file.write_text(json.dumps(state));file.chmod(0o600)
 print(json.dumps({'status':'queued','attemptRef':a['attemptRef'],'wrongLeaseDenied':True}));raise SystemExit(0)
state=json.loads(file.read_text());s=api('lesson9/sessions/'+state['sessionRef'])['session'];a=next(a for a in s['attempts'] if a['attemptRef']==state['attemptRef'])
if a['status']!='completed':print(json.dumps({'status':a['status'],'errorCode':a.get('errorCode')}));raise SystemExit(0)
result=api('lesson-sessions/'+s['sessionRef']+'/draft-result')['result']
state.update(status=a['status'],resultStatus=a['resultStatus'],correctionCards=len(result['essays']),noCorrections=result.get('noCorrections'),readbackVerified=result.get('readbackOk'))
file.write_text(json.dumps(state,indent=2));print(json.dumps(state))
