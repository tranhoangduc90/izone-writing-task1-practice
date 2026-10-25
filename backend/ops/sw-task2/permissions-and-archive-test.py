from pathlib import Path
import json,subprocess,urllib.request,urllib.error
root=Path('/opt/izone-sw-task2-preview-20261025');fixtures=json.loads((root/'fixtures.private.json').read_text())
def pg(q,container='sw-task2-preview-db',user='sw_owner',db='sw_task2_preview_20261025'):
 p=subprocess.run(['docker','exec','-i',container,'psql','-U',user,'-d',db,'-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True);assert p.returncode==0,p.stderr[-1000:];return p.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
expected=json.loads(pg("""BEGIN READ ONLY;
SELECT COALESCE(json_agg(x),'[]') FROM (SELECT DISTINCT a.email,c.erp_course_class_id FROM mapping.reviewer_account a
CROSS JOIN writing_practice.activity_class_scope c WHERE c.activity_id=14 AND a.status='active' AND a.role IN ('admin','teacher') AND
(a.role='admin' OR EXISTS(SELECT 1 FROM mapping.reviewer_class_access p WHERE p.reviewer_email=a.email AND p.erp_course_class_id=c.erp_course_class_id)
OR EXISTS(SELECT 1 FROM mapping.lark_export_teacher_assignments t WHERE lower(trim(t.payload->>'Email tài khoản'))=a.email AND c.erp_course_class_id=ANY(t.scope_class_ids) AND lower(trim(t.payload->>'Trạng thái tài khoản'))='active' AND t.source_status='Đang có trong nguồn')))x;
COMMIT;""",'mapping-postgres','mapping_admin','mapping_db'))
accounts={r['email'] for r in json.loads(pg('SELECT json_agg(a) FROM mapping.reviewer_account a'))};missing=[r for r in expected if r['email'] not in accounts]
for row in expected:
 if row['email'] in accounts:pg("INSERT INTO mapping.reviewer_class_access(reviewer_email,erp_course_class_id) VALUES("+lit(row['email'])+","+str(row['erp_course_class_id'])+") ON CONFLICT DO NOTHING")
def api(path,cookie):
 req=urllib.request.Request('http://127.0.0.1:18935/api/v1/'+path,headers={'Cookie':cookie,'Origin':'https://tranhoangduc90.github.io'})
 with urllib.request.urlopen(req,timeout=20) as r:return json.load(r)
counts={}
for slug,want in [('writing-task2-public-health-spending',12),('writing-task2-public-health-ban',16)]:
 roster=api('admin/activities/'+slug+'/roster',fixtures['cookies']['admin'])['classes'];seen=set()
 archive=pg("SELECT json_agg(c.public_id) FROM writing_practice.activity_class_scope c JOIN writing_practice.sw_preview_scope p ON p.scope_id=c.id AND p.kind='archive' JOIN writing_practice.activity a ON a.id=c.activity_id WHERE a.slug="+lit(slug));refs=json.loads(archive)
 for ref in refs:
  assert any(c['classRef']==ref for c in roster)
  students=api('admin/live/activities/'+slug+'?classRef='+ref,fixtures['cookies']['admin'])['students']
  for student in students:
   if student['sessionRef']:
    detail=api('admin/lesson9/sessions/'+student['sessionRef'],fixtures['cookies']['admin'])['session'];assert detail['previewReadOnly'];seen.add(detail['sessionRef'])
 assert len(seen)==want,(slug,len(seen),want);counts[slug]=len(seen)
report={'outcome':'passed' if not missing else 'partial','archivedSessionsVisible':counts,'sourceEffectiveClassPairs':len(expected),'missingPreviewAccounts':len(missing),'permissionSource':'existing effective assignment snapshot materialized in preview only','productionWrites':False}
(root/'permissions-and-archive.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
