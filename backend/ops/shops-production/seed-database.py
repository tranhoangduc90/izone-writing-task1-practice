"""VPS: consistent, scoped copy of Shops history + fresh ERP CS roster.
Imports into the new Shops DB only. Real scopes remain closed until cutover.
"""
from pathlib import Path
import subprocess,json,uuid,datetime
root=Path('/opt/izone-shops-writing/releases/20261024.1')
def pg(q,source=False):
 container,user,db=('mapping-postgres','mapping_admin','mapping_db') if source else ('shops-writing-db','shops_owner','shops_writing')
 p=subprocess.run(['docker','exec','-i',container,'psql','-U',user,'-d',db,'-v','ON_ERROR_STOP=1','-qAt'],input=q,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr[-1200:])
 return p.stdout.strip()
def quote(v):return "'"+json.dumps(v,ensure_ascii=False).replace("'","''")+"'::json"
if (root/'seed-receipt.json').exists():raise RuntimeError('Already seeded; use an explicit merge, never reseed working data')
meta=json.loads(pg("SELECT json_agg(json_build_object('table',table_name,'columns',cols)) FROM (SELECT table_name,array_agg(column_name) cols FROM information_schema.columns WHERE table_schema='writing_practice' GROUP BY table_name)x",True))
session="SELECT id FROM writing_practice.activity_session WHERE activity_id=8"
scope="SELECT id FROM writing_practice.activity_class_scope WHERE activity_id=8"
attempt=f"SELECT id FROM writing_practice.check_attempt WHERE session_id IN ({session})"
thread=f"SELECT id FROM writing_practice.teacher_comment_thread WHERE session_id IN ({session})"
predicates={'activity':'id=8'}
for t in meta:
 name,cols=t['table'],t['columns']
 if 'activity_id' in cols:predicates[name]='activity_id=8'
 elif 'activity_class_id' in cols:predicates[name]=f'activity_class_id IN ({scope})'
 elif 'session_id' in cols:predicates[name]=f'session_id IN ({session})'
 elif 'thread_id' in cols:predicates[name]=f'thread_id IN ({thread})'
 elif 'attempt_id' in cols:predicates[name]=f'attempt_id IN ({attempt})'
parts=[]
for name,where in predicates.items():parts += ["'writing_practice."+name+"'",f"(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT * FROM writing_practice.{name} WHERE {where})x)"]
parts += ["'mapping.student_mapping_review'","(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT * FROM mapping.student_mapping_review WHERE erp_course_class_id IN (1184,1283,1384))x)","'mapping.classroom_course_mapping'","(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT * FROM mapping.classroom_course_mapping WHERE erp_course_class_id IN (1184,1283,1384))x)","'mapping.reviewer_account'","(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT * FROM mapping.reviewer_account WHERE status='active' AND (can_access_all_classes OR role='admin' OR email IN (SELECT reviewer_email FROM mapping.reviewer_class_access WHERE erp_course_class_id IN (1184,1283,1384))))x)","'mapping.reviewer_class_access'","(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT DISTINCT reviewer_email,erp_course_class_id FROM mapping.reviewer_class_access WHERE erp_course_class_id IN (1184,1283,1384))x)"]
data=json.loads((root/'migration-source.private.json').read_text()) if (root/'history-imported.json').exists() else json.loads(pg('SELECT json_build_object('+','.join(parts)+');',True))
assert len(data['writing_practice.activity'])==1 and len(data['writing_practice.activity_session'])==16
(root/'migration-source.private.json').write_text(json.dumps(data,ensure_ascii=False));(root/'migration-source.private.json').chmod(0o600)
columns=json.loads(pg("SELECT json_object_agg(t,cols) FROM (SELECT table_schema||'.'||table_name t,json_agg(column_name ORDER BY ordinal_position) cols FROM information_schema.columns WHERE table_schema IN ('mapping','writing_practice') AND is_generated='NEVER' GROUP BY 1)x"))
edges=json.loads(pg("SELECT COALESCE(json_agg(json_build_object('table',conrelid::regclass::text,'depends',confrelid::regclass::text)),'[]') FROM pg_constraint WHERE contype='f' AND connamespace IN ('writing_practice'::regnamespace,'mapping'::regnamespace)"))
order=[];pending=set(data)
while pending:
 ready=sorted(t for t in pending if not any(e['table']==t and e['depends']!=t and e['depends'] in pending for e in edges))
 if not ready:raise RuntimeError('Unexpected cyclic dependency')
 order+=ready;pending-=set(ready)
commands=['BEGIN;']
for table in order:
 rows=data[table]
 if not rows or table not in columns:continue
 cs=[c for c in columns[table] if c in rows[0]]
 names=','.join('"'+c+'"' for c in cs)
 commands.append(f'INSERT INTO {table}({names}) SELECT {names} FROM json_populate_recordset(NULL::{table},{quote(rows)});')
# Restore historical NULL context after the schema's BEFORE INSERT pin trigger.
if data.get('writing_practice.check_attempt'):
 commands.append('UPDATE writing_practice.check_attempt target SET grading_context=source.grading_context FROM json_populate_recordset(NULL::writing_practice.check_attempt,'+quote(data['writing_practice.check_attempt'])+') source WHERE target.id=source.id;')
# Keep the approved Lesson 9 contract/prompt exactly, changing only its namespace.
preview=lambda q:subprocess.check_output(['docker','exec','shops-preview-db-20261024','psql','-U','shops_owner','-d','shops_preview_20261024','-At','-c',q],text=True)
approved=json.loads(preview('SELECT json_agg(d) FROM writing_practice.activity_section_definition d WHERE activity_id=8'))
commands.append('DELETE FROM writing_practice.activity_section_definition WHERE activity_id=8;')
commands.append('INSERT INTO writing_practice.activity_section_definition SELECT * FROM json_populate_recordset(NULL::writing_practice.activity_section_definition,'+quote(approved)+');')
commands.append("UPDATE writing_practice.activity SET status='active',prompt_registry_key='ielts:writing:shops:prompt_registry:20261024.1',prompt_record_ref='task2-shops-lesson9-v2',prompt_version='2026-10-24.1' WHERE id=8;")
commands.append("UPDATE writing_practice.activity_section_definition SET prompt_record_ref='task2-shops-lesson9-v2',prompt_version='2026-10-24.1' WHERE activity_id=8;")
commands.append("UPDATE writing_practice.activity_class_scope SET status='closed' WHERE activity_id=8;")
commands.append("INSERT INTO writing_practice.lesson9_rollout(activity_id,ui_version,starts_at) VALUES(8,'shops-lesson9-v1','2020-01-01T00:00:00Z'); INSERT INTO writing_practice.lesson9_session_state(session_id,ui_version,data) SELECT id,'shops-lesson9-v1',jsonb_build_object('idea2Opened',COALESCE(response_data->>'idea2_a','')<>'','draft2Open',draft2_unlocked OR COALESCE(response_data->>'draft2','')<>'','editedFields','[]'::jsonb) FROM writing_practice.activity_session WHERE activity_id=8;")
commands.append("CREATE TABLE writing_practice.shops_roster_identity(erp_course_class_id bigint NOT NULL,erp_contact_id bigint NOT NULL,student_public_id uuid NOT NULL,source_observed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(erp_course_class_id,erp_contact_id),UNIQUE(student_public_id)); GRANT SELECT ON writing_practice.shops_roster_identity TO shops_api;")
commands.append('COMMIT;')
if not (root/'history-imported.json').exists():
 pg('\n'.join(commands));(root/'history-imported.json').write_text(json.dumps({'imported':True,'sessions':16}))
# Reset serial sequences to the imported maximum; no source sequence is changed.
for table in order:
 if table not in columns or 'id' not in columns[table]:continue
 seq=pg("SELECT COALESCE(pg_get_serial_sequence('"+table+"','id'),'')")
 if seq:pg("SELECT setval('"+seq+"',GREATEST(COALESCE((SELECT max(id) FROM "+table+"),0),1),true)")
roster=json.loads((root/'erp-roster.private.json').read_text());assert len(roster['rows'])==47
scopes={r['erp_course_class_id']:r for r in json.loads(pg('SELECT json_agg(c) FROM writing_practice.activity_class_scope c WHERE activity_id=8'))}
existing={ (r['erp_course_class_id'],r['erp_student_contact_id']):r for r in data['mapping.student_mapping_review'] if r.get('status')=='approved'}
current_contact_ids={1283:set(),1384:set()}
for cid,code,contact,name,status in roster['rows']:
 assert cid in (1283,1384) and status=='on_going' and code in ('CS.160826','CS.181026')
 if cid not in scopes:
  public=str(uuid.uuid5(uuid.NAMESPACE_URL,'https://izone.edu.vn/shops/classes/'+str(cid)))
  created=json.loads(pg("INSERT INTO writing_practice.activity_class_scope(public_id,activity_id,erp_course_class_id,class_name_snapshot,status,end_date) VALUES('"+public+"',8,"+str(cid)+",'"+code+"','closed','2026-12-31') RETURNING row_to_json(activity_class_scope)"));scopes[cid]=created
 student=existing.get((cid,contact));sid=student['public_id'] if student else str(uuid.uuid5(uuid.NAMESPACE_URL,'https://izone.edu.vn/shops/erp/'+str(cid)+'/'+str(contact)))
 values=[scopes[cid]['id'],sid,name,name]
 pg("INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias,active) SELECT class_id,student_id,name,alias,true FROM json_to_record("+quote({'class_id':values[0],'student_id':sid,'name':name,'alias':name})+") AS x(class_id bigint,student_id uuid,name text,alias text) ON CONFLICT(activity_class_id,student_public_id) DO UPDATE SET display_name=EXCLUDED.display_name,display_alias=EXCLUDED.display_alias,active=true;")
 pg("INSERT INTO writing_practice.shops_roster_identity(erp_course_class_id,erp_contact_id,student_public_id) VALUES("+str(cid)+","+str(contact)+",'"+sid+"') ON CONFLICT(erp_course_class_id,erp_contact_id) DO NOTHING")
 current_contact_ids[cid].add(sid)
# Former official roster entries remain for historical joins but aren't selectable
# in an ongoing class when absent from its newly verified registration list.
for cid,ids in current_contact_ids.items():
 sidlist=','.join("'"+x+"'" for x in ids)
 pg("UPDATE writing_practice.activity_roster r SET active=false WHERE activity_class_id="+str(scopes[cid]['id'])+" AND student_public_id NOT IN ("+sidlist+") AND NOT EXISTS(SELECT 1 FROM writing_practice.provisional_student p WHERE p.activity_class_id=r.activity_class_id AND p.student_public_id=r.student_public_id AND p.status='pending')")
pg("ALTER ROLE shops_api SET timezone='Asia/Ho_Chi_Minh';")
summary=json.loads(pg("SELECT json_agg(json_build_object('code',c.class_name_snapshot,'status',c.status,'roster',(SELECT count(*) FROM writing_practice.activity_roster r WHERE r.activity_class_id=c.id AND active),'sessions',(SELECT count(*) FROM writing_practice.activity_session s WHERE s.activity_class_id=c.id))) FROM writing_practice.activity_class_scope c WHERE activity_id=8"))
receipt={'outcome':'passed','sourceSessions':16,'sourceCounts':{t:len(v) for t,v in data.items()},'classes':summary,'erpCurrentStudents':47,'realScopesOpened':False}
(root/'seed-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
