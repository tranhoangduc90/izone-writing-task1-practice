"""Read all preserved archives and compare every pre-extension preview row."""
from pathlib import Path
import subprocess,json,urllib.request,collections
root=Path('/opt/izone-sw-task2-preview-20261025');out=root/'six-lessons';fixtures=json.loads((root/'fixtures.private.json').read_text());lessons=json.loads((root/'candidate/lessons.json').read_text())
def lit(v):return "'"+str(v).replace("'","''")+"'"
def pg(q,source=False):
 args=['docker','exec','-i',*(['mapping-postgres','psql','-U','mapping_admin','-d','mapping_db'] if source else ['sw-task2-preview-db','psql','-U','sw_owner','-d','sw_task2_preview_20261025']),'-qAt','-v','ON_ERROR_STOP=1'];p=subprocess.run(args,input=q,text=True,capture_output=True);assert p.returncode==0,p.stderr[-1000:];return p.stdout.strip()
expected=json.loads(pg("""BEGIN READ ONLY; SELECT COALESCE(json_agg(x),'[]') FROM (SELECT DISTINCT a.email,c.erp_course_class_id FROM mapping.reviewer_account a CROSS JOIN writing_practice.activity_class_scope c WHERE c.activity_id IN (8,10,13,14,16,25,27,28) AND a.status='active' AND a.role IN ('admin','teacher') AND (a.role='admin' OR EXISTS(SELECT 1 FROM mapping.reviewer_class_access p WHERE p.reviewer_email=a.email AND p.erp_course_class_id=c.erp_course_class_id) OR EXISTS(SELECT 1 FROM mapping.lark_export_teacher_assignments t WHERE lower(trim(t.payload->>'Email tài khoản'))=a.email AND c.erp_course_class_id=ANY(t.scope_class_ids) AND lower(trim(t.payload->>'Trạng thái tài khoản'))='active' AND t.source_status='Đang có trong nguồn')))x; COMMIT;""",True))
accounts={r['email'] for r in json.loads(pg('SELECT json_agg(a) FROM mapping.reviewer_account a'))};missing=[r for r in expected if r['email'] not in accounts];assert not missing,'Missing copied reviewer'
for row in expected:pg('INSERT INTO mapping.reviewer_class_access(reviewer_email,erp_course_class_id) VALUES('+lit(row['email'])+','+str(row['erp_course_class_id'])+') ON CONFLICT DO NOTHING')
def api(path,cookie):
 q=urllib.request.Request('http://127.0.0.1:18935/api/v1/'+path,headers={'Cookie':cookie,'Origin':'https://tranhoangduc90.github.io'})
 with urllib.request.urlopen(q,timeout=25) as r:return json.load(r)
source=json.loads((root/'source-eight-activities.private.json').read_text());counts={};allrefs=set()
for slug in lessons:
 oldid=next(a['id'] for a in source['writing_practice.activity'] if a['slug']==slug);want={s['public_id'] for s in source['writing_practice.activity_session'] if s['activity_id']==oldid};seen=set()
 roster=api('admin/activities/'+slug+'/roster',fixtures['cookies']['admin'])['classes']
 archives=json.loads(pg("SELECT json_agg(c.public_id) FROM writing_practice.activity_class_scope c JOIN writing_practice.sw_preview_scope p ON p.scope_id=c.id AND p.kind='archive' JOIN writing_practice.activity a ON a.id=c.activity_id WHERE a.slug="+lit(slug)))
 for ref in archives:
  assert any(c['classRef']==ref for c in roster)
  for student in api('admin/live/activities/'+slug+'?classRef='+ref,fixtures['cookies']['admin'])['students']:
   if student['sessionRef']:
    s=api('admin/lesson9/sessions/'+student['sessionRef'],fixtures['cookies']['admin'])['session'];assert s['previewReadOnly'];assert s['studentRef']==student['studentRef'] and s['classRef']==ref and s['activitySlug']==slug;seen.add(s['sessionRef'])
 assert seen==want,(slug,len(seen),len(want));allrefs|=seen;counts[slug]=len(seen)
report={'outcome':'passed','archivedSessions':len(allrefs),'perLesson':counts,'effectiveClassPairs':len(expected),'missingPreviewAccounts':len(missing),'sourceWrites':False,'archiveReadOnly':True};(out/'archive-audit.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
before=json.loads((out/'preview-before.private.json').read_text());changed={};checked={}
def counter(rows):return collections.Counter(json.dumps(r,sort_keys=True,ensure_ascii=False) for r in rows)
for table,rows in before.items():
 current=json.loads(pg('SELECT COALESCE(json_agg(t),\'[]\') FROM writing_practice.'+table+' t'));lost=counter(rows)-counter(current);checked[table]=len(rows)
 if lost:changed[table]=sum(lost.values())
preservation={'outcome':'passed' if not changed else 'needs-review','allPriorPreviewRowsKept':not changed,'changedRowCounts':changed,'tables':checked,'sourceWrites':False};(out/'preservation-final.json').write_text(json.dumps(preservation,indent=2));print(json.dumps(preservation));assert not changed
