"""Open the existing identities that have current, exact ERP membership.

This changes only SW roster availability, without merging profiles or changing
source mappings, historical work, PINs or grading records.
"""
from pathlib import Path
import subprocess,json,sys,unicodedata
trial='--trial' in sys.argv;root=Path('/opt/izone-shops-writing/releases/20261025.sw-task2');out=root/('trial' if trial else 'production')
container='sw-task2-preview-db' if trial else 'shops-writing-db';owner='sw_owner' if trial else 'shops_owner'
def pg(q):
 p=subprocess.run(['docker','exec','-i',container,'psql','-U',owner,'-d','shops_writing','-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True);assert not p.returncode,p.stderr[-1600:];return p.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
erp=json.loads((root/'erp-all-cs.private.json').read_text());by_id={(x[0],x[2]):x for x in erp['rows']}
rows=json.loads(pg("SELECT COALESCE(json_agg(x),'[]') FROM (SELECT a.slug,c.id scope,c.erp_course_class_id cid,i.erp_contact_id contact,r.student_public_id student,r.display_name name,r.active,(SELECT p.status FROM writing_practice.provisional_student p WHERE p.activity_class_id=c.id AND p.student_public_id=r.student_public_id) provisional_status FROM writing_practice.activity a CROSS JOIN writing_practice.shops_roster_identity i JOIN writing_practice.activity_class_scope c ON c.activity_id=a.id AND c.erp_course_class_id=i.erp_course_class_id JOIN writing_practice.activity_roster r ON r.activity_class_id=c.id AND r.student_public_id=i.student_public_id WHERE NOT r.active)x;"))
def norm(v):return ' '.join(unicodedata.normalize('NFC',v).lower().split())
for row in rows:
 e=by_id[(row['cid'],row['contact'])];assert e[4] in ['on_going','completed'] and row['provisional_status'] is None,'An unresolved provisional identity needs review'
 assert norm(e[3])==norm(row['name']),'Do not open a mismatched ERP identity'
before=out/'erp-roster-activation.private.json'
if rows:
 if before.exists():assert json.loads(before.read_text())==rows,'The inactive roster changed since its backup'
 else:before.write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf-8');before.chmod(0o600)
 pg('BEGIN;'+''.join('UPDATE writing_practice.activity_roster SET active=true WHERE activity_class_id='+str(row['scope'])+' AND student_public_id='+lit(row['student'])+' AND active=false;' for row in rows)+'COMMIT;')
receipt=out/'erp-roster-activation.json'
if receipt.exists() and not rows:print(receipt.read_text());raise SystemExit(0)
result={'outcome':'passed','rowsActivated':len(rows),'distinctRegisteredPeople':len({(row['cid'],row['contact']) for row in rows}),'matchedErpClassAndContact':True,'sourceMappingsChanged':False,'historicalWorkChanged':False}
receipt.write_text(json.dumps(result,indent=2),encoding='utf-8');print(json.dumps(result))
