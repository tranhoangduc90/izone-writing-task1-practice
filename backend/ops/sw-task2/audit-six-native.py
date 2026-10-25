"""Read back prompt identity, six vocabulary groups and genuine sentence results."""
from pathlib import Path
import json,subprocess,urllib.request
root=Path('/opt/izone-sw-task2-preview-20261025');out=root/'six-lessons';native=json.loads((out/'native-six.private.json').read_text());lessons=json.loads((root/'candidate/lessons.json').read_text());assert native['outcome']=='passed'
def pg(q):
 p=subprocess.run(['docker','exec','-i','sw-task2-preview-db','psql','-U','sw_owner','-d','sw_task2_preview_20261025','-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True);assert p.returncode==0,p.stderr[-600:];return p.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def get(path):
 with urllib.request.urlopen('http://127.0.0.1:18935/api/v1/'+path,timeout=15) as r:return json.load(r)
rows=[]
for slug,entry in native['lessons'].items():
 attempts=json.loads(pg('SELECT json_agg(x) FROM (SELECT public_id,grading_context,grading_meta,status,result_status,created_at,completed_at FROM writing_practice.check_attempt WHERE public_id IN ('+','.join(lit(a['attemptRef']) for a in entry['checks'])+'))x'))
 for a in attempts:
  c=a['grading_context'];assert c['activitySlug']==slug and c['taskPrompt']==lessons[slug]['statement'] and c['promptRecordId']=='sw-task2:'+slug+':lesson9-v1' and c['promptVersion']=='2026-10-25.1'
 s=get('lesson9/sessions/'+entry['sessionRef'])['session'];assert s['activitySlug']==slug
 v=s['uiVocabulary'];assert v['status']=='completed' and len(v['groups'])==6;assert all(all(t['meaningVi'] for t in group) for group in v['groups'].values())
 result=get('lesson-sessions/'+entry['sessionRef']+'/draft-result')['result'];assert len(result['essays'])==entry['correctionCards']
 rows.append({'lesson':lessons[slug]['number'],'slug':slug,'checks':len(attempts),'pinnedContext':True,'vocabularyGroups':len(v['groups']),'correctionCards':len(result['essays']),'resultKeys':sorted(result.keys()),'cardKeys':sorted(result['essays'][0].keys())})
report={'outcome':'passed','lessons':rows,'totalChecks':sum(r['checks'] for r in rows),'nativeNegativeChecks':2,'sourceWrites':False};(out/'native-readback.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
