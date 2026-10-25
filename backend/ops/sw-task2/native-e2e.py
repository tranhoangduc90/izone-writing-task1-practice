"""One bounded transition of the real staging flow; fixtures only, no source writes."""
from pathlib import Path
import json,uuid,urllib.request,urllib.error
root=Path('/opt/izone-sw-task2-preview-20261025')
fixtures=json.loads((root/'fixtures.private.json').read_text());statefile=root/'native-e2e.private.json'
base='http://127.0.0.1:18935/api/v1/'
def uid():return str(uuid.uuid4())
def api(path,method='GET',body=None,cookie='',expected=None):
 req=urllib.request.Request(base+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io','X-Izone-Csrf':'1',**({'Cookie':cookie} if cookie else {})})
 try:
  with urllib.request.urlopen(req,timeout=25) as r:code=r.status;data=json.load(r)
 except urllib.error.HTTPError as e:
  code=e.code;data=json.load(e)
 if expected is not None:
  assert code in ([expected] if isinstance(expected,int) else expected),(path,code,data)
 elif code>=400:raise RuntimeError(str((path,code,data)))
 return data
def get(ref):return api('lesson9/sessions/'+ref)['session']
def save(s,changes):
 allowed={f for d in s['sectionDefinitions'] for f in d['inputFields']}
 assert not set(changes)-allowed,sorted(set(changes)-allowed)
 values={k:v for k,v in s['responses'].items() if k in allowed};values.update(changes)
 return api('lesson-sessions/'+s['sessionRef']+'/responses','PUT',{'baseVersion':s['draftVersion'],'requestId':uid(),'responses':values})['session']
def action(s,kind,**extra):return api('lesson9/sessions/'+s['sessionRef']+'/actions','POST',{'baseVersion':s['draftVersion'],'requestId':uid(),'kind':kind,**extra})['session']
if not statefile.exists():
 f=next(f for f in fixtures['classes'] if f['activitySlug'].endswith('health-spending') and f['className']=='SW-THU-A')
 s=api('lesson9/sessions','POST',{'activitySlug':f['activitySlug'],'classRef':f['classRef'],'studentRef':f['students'][0]})['session']
 ref=s['sessionRef']
 api('lesson-sessions/'+ref+'/checks','POST',{'section':'supporting_idea_2','requestId':uid()},expected=[400,409])
 api('lesson9/sessions/'+ref+'/actions','POST',{'baseVersion':s['draftVersion'],'requestId':uid(),'kind':'copy_draft'},expected=409)
 source=json.loads((root/'source-eight-activities.private.json').read_text())
 old=next(r for r in source['writing_practice.activity_session'] if r['activity_id']==14)['public_id']
 api('lesson9/sessions/'+old,expected=401)
 api('lesson9/sessions/'+old,cookie=fixtures['cookies']['teacher'],expected=403)
 legacy=api('admin/lesson9/sessions/'+old,cookie=fixtures['cookies']['admin'],expected=200)['session'];assert legacy['previewReadOnly']
 api('lesson9/sessions/'+old+'/actions','POST',{'baseVersion':legacy['draftVersion'],'requestId':uid(),'kind':'edit','field':'topic_sentence','value':'Forbidden archive edit'},cookie=fixtures['cookies']['admin'],expected=403)
 s=save(s,{'body_choice':'body1','body1_message':'Ưu tiên phòng bệnh là cách dùng ngân sách y tế hợp lý.','body1_idea1':'Phòng bệnh giảm nhu cầu điều trị tốn kém.','body1_idea2':'Sức khỏe tốt giúp người dân duy trì năng suất làm việc.','body2_message':'Tuy vậy vẫn cần duy trì ngân sách chữa trị cho người đang bệnh.','body2_idea1':'Người đang mắc bệnh nặng cần được điều trị kịp thời để bảo toàn tính mạng.','body2_idea2':'Hỗ trợ chữa trị giúp người thu nhập thấp có cơ hội được chăm sóc.','topic_sentence':'Prioritising preventive care is a sound use of public funds because it reduces avoidable treatment costs and helps people stay productive.'})
 state={'sessionRef':ref,'classRef':f['classRef'],'studentRef':f['students'][0],'activitySlug':f['activitySlug'],'stage':'topic_sentence','checks':[],'negativeChecks':['idea2_prerequisite','draft_prerequisite','archive_anonymous','archive_teacher_denied','archive_admin_read','archive_write_denied']}
else:state=json.loads(statefile.read_text());s=get(state['sessionRef'])
if state.get('attemptRef'):
 attempt=next(a for a in s['attempts'] if a['attemptRef']==state['attemptRef'])
 if attempt['status'] in ['queued','leased']:
  print(json.dumps({'stage':state['stage'],'status':attempt['status'],'attemptRef':attempt['attemptRef']}));raise SystemExit(0)
 if attempt['status']!='completed' or attempt['resultStatus']!='passed':
  print(json.dumps({'stage':state['stage'],'status':attempt['status'],'resultStatus':attempt['resultStatus'],'feedback':next((c['feedback'] for c in s['comments'] if c['attemptRef']==attempt['attemptRef']),''),'error':attempt.get('errorCode')},ensure_ascii=False));raise SystemExit(2)
 state['checks'].append({'section':state['stage'],'attemptRef':state['attemptRef'],'resultStatus':'passed'});state.pop('attemptRef')
 if state['stage']=='topic_sentence':
  s=save(s,{'idea1_a':'Các chương trình công cộng khuyến khích ăn uống lành mạnh và vận động thường xuyên.','idea1_x':'Khi nhiều người thực hiện những thói quen đó, nguy cơ mắc các bệnh có thể phòng tránh giảm, nên ít người cần các đợt điều trị dài và tốn kém.','idea1_b':'Nhờ giảm nhu cầu điều trị, chính phủ có thể giảm chi phí y tế có thể tránh được, nên ưu tiên phòng bệnh là cách sử dụng tiền công hiệu quả.'});state['stage']='supporting_idea_1'
 elif state['stage']=='supporting_idea_1':
  s=action(s,'open_idea2');s=save(s,{'idea2_a':'Các chiến dịch sống lành mạnh giúp người lao động duy trì sức khỏe tốt hơn.','idea2_x':'Khi ít bị ốm hơn, họ nghỉ việc ít ngày hơn và có đủ sức tập trung hoàn thành công việc.','idea2_b':'Việc duy trì ngày công và khả năng làm việc hỗ trợ năng suất của nền kinh tế, tạo thêm lý do để ưu tiên ngân sách phòng bệnh.'});state['stage']='supporting_idea_2'
 elif state['stage']=='supporting_idea_2':state['stage']='vocabulary'
 elif state['stage']=='draft':state['stage']='complete'
if state['stage']=='vocabulary':
 api('lesson9/sessions/'+s['sessionRef']+'/vocabulary','POST',{'requestId':uid()})
 s=get(s['sessionRef'])
 if s['uiVocabulary']['status']!='completed':
  statefile.write_text(json.dumps(state,ensure_ascii=False));print(json.dumps({'stage':'vocabulary','status':s['uiVocabulary']['status']}));raise SystemExit(0)
 assert set(s['uiVocabulary']['groups'])=={'A1','X1','B1','A2','X2','B2'}
 state['vocabularyGroups']=6
 draft='Preventive healthcare deserve a greater share of public spending for two reasons. First, public health campaigns can encourage people to eat well and exercise regularly. These habits reduce the risk of preventable illnesses, meaning fewer people need prolonged and costly treatment. This allows governments to avoid some treatment costs. Second, healthier workers are less likely to miss work through illness and can concentrate on their tasks. Consequently, they can maintains their productivity. These benefits make prevention a worthwhile priority, although essential treatment for people who are already ill must remain available.'
 s=save(s,{'draft1':draft});s=action(s,'copy_draft');state['stage']='draft'
if state['stage']=='complete':
 result=api('lesson-sessions/'+s['sessionRef']+'/draft-result')['result']
 assert result.get('essays') is not None
 state['correctionCards']=len(result['essays']);state['readbackVerified']=True
 statefile.write_text(json.dumps(state,ensure_ascii=False,indent=2));print(json.dumps({'outcome':'passed','checks':state['checks'],'vocabularyGroups':6,'correctionCards':len(result['essays']),'sessionRef':s['sessionRef']}));raise SystemExit(0)
body={'section':state['stage'],'requestId':uid()}
attempt=api('lesson-sessions/'+s['sessionRef']+'/checks','POST',body)['attempt']
again=api('lesson-sessions/'+s['sessionRef']+'/checks','POST',body)['attempt'];assert attempt['attemptRef']==again['attemptRef']
state['attemptRef']=attempt['attemptRef'];statefile.write_text(json.dumps(state,ensure_ascii=False,indent=2));statefile.chmod(0o600)
print(json.dumps({'stage':state['stage'],'status':attempt['status'],'idempotencyVerified':True,'attemptRef':attempt['attemptRef']}))
