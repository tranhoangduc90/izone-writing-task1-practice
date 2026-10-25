"""VPS: enqueue synthetic AI checks and read back exact owned results."""
from pathlib import Path
import json,urllib.request,urllib.error,uuid,sys,subprocess
root=Path('/opt/izone-shops-writing');release=root/'releases/20261024.1'
f=json.loads((release/'canary-fixtures.private.json').read_text());path=release/'ai-canary.json'
def api(route,body=None,method=None):
 q=urllib.request.Request('http://127.0.0.1:18927/api/v1/'+route,data=json.dumps(body).encode() if body is not None else None,method=method,headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io'})
 try:
  with urllib.request.urlopen(q,timeout=20) as r:return json.load(r)
 except urllib.error.HTTPError as e:raise RuntimeError(route+': '+str(e.code)+' '+e.read().decode()[:500]) from None
def sql(q):
 p=subprocess.run(['docker','exec','-i','shops-writing-db','psql','-U','shops_owner','-d','shops_writing','-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,check=True);return p.stdout.strip()
if sys.argv[1]=='enqueue':
 assert not path.exists(),'Already enqueued; inspect instead'
 cases=[]
 texts=['Banning harmful drinks can reduce sugar consumption. Clear health warnings can also help consumers make informed choices.','A ban on harmful drinks can protect public health. It reduce the amount of sugar that people consume every day. Some families is unable to avoid these products because healthier choices cost more.']
 for i,text in enumerate(texts):
  ref=f['sessions'][i]['sessionRef'];s=api('lesson9/sessions/'+ref)['session'];responses={k:v for k,v in s['responses'].items() if k not in ['overview','body1','body2']};responses.update(draft1=text,draft2=text)
  api('lesson-sessions/'+ref+'/responses',{'baseVersion':s['draftVersion'],'requestId':str(uuid.uuid4()),'responses':responses},'PUT')
  a=api('lesson-sessions/'+ref+'/checks',{'section':'draft','requestId':str(uuid.uuid4())})['attempt']
  cases.append({'case':['clean','grammar'][i],'sessionRef':ref,'attemptRef':a['attemptRef']})
 ref=f['sessions'][2]['sessionRef']
 sql("UPDATE writing_practice.session_section SET locked=false WHERE session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id='"+ref+"');")
 a=api('lesson-sessions/'+ref+'/checks',{'section':'topic_sentence','requestId':str(uuid.uuid4())})['attempt'];cases.append({'case':'topic','sessionRef':ref,'attemptRef':a['attemptRef']})
 path.write_text(json.dumps({'cases':cases},indent=2));print(json.dumps({'outcome':'enqueued','cases':cases,'realStudentWrites':False}))
elif sys.argv[1]=='readback':
 state=json.loads(path.read_text());done=True;results=[]
 for case in state['cases']:
  a=api('attempts/'+case['attemptRef'])['attempt'];r={**case,'status':a['status'],'errorCode':a.get('errorCode')}
  if a['status']!='completed':done=False
  elif case['case']=='topic':r.update(resultStatus=a['resultStatus'],hasFeedback=bool(a['feedback']))
  else:
   value=api('lesson-sessions/'+case['sessionRef']+'/draft-result')['result']
   r.update(cards=len(value['essays']),readbackOk=value.get('readbackOk'),gradingEngine=value.get('gradingEngine'))
   assert value.get('readbackOk') is True
   if case['case']=='clean':assert len(value['essays'])==0
   else:assert len(value['essays'])==2
  results.append(r)
 report={'outcome':'passed' if done else 'running','cases':results,'realStudentWrites':False}
 if done:(release/'ai-canary-receipt.json').write_text(json.dumps(report,indent=2))
 print(json.dumps(report))
else:raise RuntimeError('Unknown phase')
