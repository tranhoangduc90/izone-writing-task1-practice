"""Small real-AI acceptance run. All writes belong to fake SW-THU learners."""
from pathlib import Path
import json,uuid,urllib.request,urllib.error,time,sys,subprocess
root=Path('/opt/izone-sw-task2-preview-20261025');out=root/'six-lessons';statefile=out/'native-six.private.json'
fixtures=json.loads((root/'fixtures.private.json').read_text());cases=json.loads((root/'candidate/native-six-fixtures.json').read_text());lessons=json.loads((root/'candidate/lessons.json').read_text())
def uid():return str(uuid.uuid4())
def api(path,method='GET',body=None):
 q=urllib.request.Request('http://127.0.0.1:18935/api/v1/'+path,method=method,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':'https://tranhoangduc90.github.io','X-Izone-Csrf':'1'})
 try:
  with urllib.request.urlopen(q,timeout=35) as r:return json.load(r)
 except urllib.error.HTTPError as e:raise RuntimeError(str((path,e.code,json.load(e))))
def save(s,changes):
 allowed={f for d in s['sectionDefinitions'] for f in d['inputFields']};assert not set(changes)-allowed
 values={k:v for k,v in s['responses'].items() if k in allowed};values.update(changes)
 return api('lesson-sessions/'+s['sessionRef']+'/responses','PUT',{'baseVersion':s['draftVersion'],'requestId':uid(),'responses':values})['session']
def action(s,kind,**extra):return api('lesson9/sessions/'+s['sessionRef']+'/actions','POST',{'baseVersion':s['draftVersion'],'requestId':uid(),'kind':kind,**extra})['session']
state=json.loads(statefile.read_text()) if statefile.exists() else {'lessons':{},'aiMode':'real native AI','outcome':'running'}
def persist():statefile.write_text(json.dumps(state,ensure_ascii=False,indent=2));statefile.chmod(0o600)
def step():
 for slug,case in cases.items():
  entry=state['lessons'].get(slug)
  if entry and entry['stage']=='complete':continue
  if not entry:
   f=next(f for f in fixtures['classes'] if f['activitySlug']==slug and f['className']=='SW-THU-A')
   s=api('lesson9/sessions','POST',{'activitySlug':slug,'classRef':f['classRef'],'studentRef':f['students'][0]})['session']
   planning={k:v for k,v in case.items() if k.startswith('body') or k=='topic_sentence'};planning['body_choice']='body1'
   if case.get('negativeTopic'):planning['topic_sentence']='Playing computer games is an enjoyable way to relax after a busy day.'
   s=save(s,planning);entry={'slug':slug,'sessionRef':s['sessionRef'],'studentRef':f['students'][0],'classRef':f['classRef'],'stage':'negative_topic' if case.get('negativeTopic') else 'topic_sentence','checks':[]};state['lessons'][slug]=entry;persist()
  else:s=api('lesson9/sessions/'+entry['sessionRef'])['session']
  if entry.get('attemptRef'):
   a=next(a for a in s['attempts'] if a['attemptRef']==entry['attemptRef'])
   if a['status'] in ['queued','leased']:continue
   expected='needs_revision' if entry['stage']=='negative_topic' else 'passed'
   feedback=next((c['feedback'] for c in s['comments'] if c['attemptRef']==a['attemptRef']),'')
   if a['status']!='completed' or a['resultStatus']!=expected:
    entry['review']={'attempt':a,'feedback':feedback};state['outcome']='needs-review';persist();raise RuntimeError(slug+' '+entry['stage']+' '+json.dumps(entry['review'],ensure_ascii=False))
   entry['checks'].append({'stage':entry['stage'],'attemptRef':a['attemptRef'],'resultStatus':a['resultStatus']});entry.pop('attemptRef');persist()
   if entry['stage']=='negative_topic':s=save(s,{'topic_sentence':case['topic_sentence']});entry['stage']='topic_sentence'
   elif entry['stage']=='topic_sentence':s=save(s,{k:case[k] for k in ['idea1_a','idea1_x','idea1_b']});entry['stage']='supporting_idea_1'
   elif entry['stage']=='supporting_idea_1':s=action(s,'open_idea2');s=save(s,{k:case[k] for k in ['idea2_a','idea2_x','idea2_b']});entry['stage']='supporting_idea_2'
   elif entry['stage']=='supporting_idea_2':entry['stage']='vocabulary'
   elif entry['stage']=='draft':entry['stage']='complete'
   persist()
  if entry['stage']=='vocabulary':
   if s['uiVocabulary']['status']=='missing':api('lesson9/sessions/'+s['sessionRef']+'/vocabulary','POST',{'requestId':uid()})
   s=api('lesson9/sessions/'+s['sessionRef'])['session'];v=s['uiVocabulary']
   if v['status']=='failed':raise RuntimeError('Vocabulary failed '+slug)
   if v['status']!='completed':continue
   assert set(v['groups'])=={'A1','X1','B1','A2','X2','B2'}
   assert all(terms and all(t['phrase'] and t['meaningVi'] for t in terms) for terms in v['groups'].values())
   entry['vocabularyGroups']=6;s=save(s,{'draft1':case['draft1']});s=action(s,'copy_draft');entry['stage']='draft';persist()
  if entry['stage']=='complete':
   result=api('lesson-sessions/'+s['sessionRef']+'/draft-result')['result'];cards=result['essays'];assert cards,('Expected genuine correction for deliberately erroneous Draft',slug)
   entry.update(correctionCards=len(cards),readbackVerified=True);persist();continue
  section='topic_sentence' if entry['stage']=='negative_topic' else entry['stage'];body={'section':section,'requestId':uid()}
  a=api('lesson-sessions/'+s['sessionRef']+'/checks','POST',body)['attempt'];again=api('lesson-sessions/'+s['sessionRef']+'/checks','POST',body)['attempt'];assert a['attemptRef']==again['attemptRef']
  entry['attemptRef']=a['attemptRef'];entry['idempotencyVerified']=True;persist()
 state['outcome']='passed' if len(state['lessons'])==6 and all(e['stage']=='complete' and e.get('readbackVerified') for e in state['lessons'].values()) else 'running';persist()
 print(json.dumps({'outcome':state['outcome'],'lessons':{lessons[s]['number']:{'stage':e['stage'],'checks':len(e['checks']),'cards':e.get('correctionCards')} for s,e in state['lessons'].items()}},ensure_ascii=False),flush=True)
if '--watch' in sys.argv:
 deadline=time.monotonic()+1800
 while time.monotonic()<deadline:
  step()
  if state['outcome']=='passed':break
  time.sleep(10)
 else:raise RuntimeError('Acceptance deadline exceeded; no attempt was cleared or replayed')
else:step()
