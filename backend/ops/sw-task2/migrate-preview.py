"""Scoped rehearsal with public UUID preservation and explicit internal FK mapping."""
from pathlib import Path
import subprocess,json,uuid,hashlib,secrets
root=Path('/opt/izone-sw-task2-preview-20261025')
def pg(q,source=False,shops=False):
 container,user,db=('mapping-postgres','mapping_admin','mapping_db') if source else ('shops-writing-db','shops_owner','shops_writing') if shops else ('sw-task2-preview-db','sw_owner','sw_task2_preview_20261025')
 p=subprocess.run(['docker','exec','-i',container,'psql','-U',user,'-d',db,'-v','ON_ERROR_STOP=1','-qAt'],input=q,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr[-1600:])
 return p.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def js(v):return lit(json.dumps(v,ensure_ascii=False))+'::json'
receipt=root/'migration-receipt.json'
assert not receipt.exists(),'Never reseed a working preview'
source=json.loads((root/'source-eight-activities.private.json').read_text())
ids={8,14}
scopes={r['id'] for r in source['writing_practice.activity_class_scope'] if r['activity_id'] in ids}
sessions={r['id'] for r in source['writing_practice.activity_session'] if r['activity_id'] in ids}
attempts={r['id'] for r in source['writing_practice.check_attempt'] if r['session_id'] in sessions}
threads={r['id'] for r in source['writing_practice.teacher_comment_thread'] if r['session_id'] in sessions}
def selected(table,row):
 if table=='writing_practice.activity':return row['id'] in ids
 for key,values in [('activity_id',ids),('activity_class_id',scopes),('session_id',sessions),('attempt_id',attempts),('thread_id',threads)]:
  if key in row:return row[key] in values
 return False
data={t:[r for r in rows if selected(t,r)] for t,rows in source.items()}
data={t:rows for t,rows in data.items() if rows}
classids={r['erp_course_class_id'] for r in data['writing_practice.activity_class_scope']}
cids=','.join(str(c) for c in classids)
mapping={
 'mapping.student_mapping_review':f'erp_course_class_id IN ({cids})',
 'mapping.classroom_course_mapping':f'erp_course_class_id IN ({cids})',
 'mapping.reviewer_account':"status='active'",
 'mapping.reviewer_class_access':f'erp_course_class_id IN ({cids})'}
for table,where in mapping.items():
 data[table]=json.loads(pg(f"BEGIN READ ONLY; SELECT COALESCE(json_agg(r),'[]') FROM (SELECT * FROM {table} WHERE {where})r; COMMIT;",source=table not in ['mapping.reviewer_account'])) if table!='mapping.reviewer_account' else json.loads(pg(f"BEGIN READ ONLY; SELECT COALESCE(json_agg(r),'[]') FROM (SELECT * FROM {table} WHERE {where})r; COMMIT;",shops=True))
columns=json.loads(pg("SELECT json_object_agg(t,cols) FROM (SELECT table_schema||'.'||table_name t,json_agg(json_build_object('name',column_name,'type',data_type) ORDER BY ordinal_position) cols FROM information_schema.columns WHERE table_schema IN ('mapping','writing_practice') AND is_generated='NEVER' GROUP BY 1)x"))
fks=json.loads(pg("SELECT COALESCE(json_agg(json_build_object('table',c.conrelid::regclass::text,'depends',c.confrelid::regclass::text,'columns',(SELECT array_agg(a.attname ORDER BY u.ord) FROM unnest(c.conkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.num),'targets',(SELECT array_agg(a.attname ORDER BY u.ord) FROM unnest(c.confkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=u.num))),'[]') FROM pg_constraint c WHERE contype='f' AND connamespace IN ('writing_practice'::regnamespace,'mapping'::regnamespace)"))
maps={}
for table,rows in data.items():
 # Keep mapping IDs since they may encode external relationships; writing IDs are local.
 if table.startswith('writing_practice.') and any(c['name']=='id' and c['type'] in ['bigint','integer','smallint'] for c in columns[table]):
  maps[table]={r['id']:1000+i for i,r in enumerate(sorted(rows,key=lambda r:r['id']))}
rewritten=json.loads(json.dumps(data))
for table,rows in rewritten.items():
 for row in rows:
  oldid=row.get('id')
  for edge in fks:
   if edge['table']==table and edge['depends'] in maps and edge['targets']==['id']:
    key=edge['columns'][0]
    if row.get(key) is not None:
     if row[key] not in maps[edge['depends']]:raise RuntimeError('Unmapped FK '+table+'.'+key)
     row[key]=maps[edge['depends']][row[key]]
  if table in maps:row['id']=maps[table][oldid]
order=[];pending=set(data)
while pending:
 ready=sorted(t for t in pending if not any(e['table']==t and e['depends']!=t and e['depends'] in pending for e in fks))
 if not ready:raise RuntimeError('Cyclic table dependencies')
 order+=ready;pending-=set(ready)
commands=['BEGIN;']
# An existing row deliberately occupies the source pilot's internal activity ID.
sentinel=dict(rewritten['writing_practice.activity'][0]);sentinel.update(id=14,public_id=str(uuid.uuid4()),slug='sw-preview-collision-sentinel',status='closed')
def insert(table,rows):
 cs=[c['name'] for c in columns[table] if c['name'] in rows[0]];names=','.join('"'+c+'"' for c in cs)
 return f'INSERT INTO {table}({names}) SELECT {names} FROM json_populate_recordset(NULL::{table},{js(rows)});'
commands.append(insert('writing_practice.activity',[sentinel]))
for table in order:
 if rewritten[table]:commands.append(insert(table,rewritten[table]))
if rewritten.get('writing_practice.check_attempt'):
 commands.append('UPDATE writing_practice.check_attempt t SET grading_context=s.grading_context FROM json_populate_recordset(NULL::writing_practice.check_attempt,'+js(rewritten['writing_practice.check_attempt'])+') s WHERE t.public_id=s.public_id;')
commands.append('COMMIT;')
already=pg("SELECT count(*) FROM writing_practice.activity WHERE slug='sw-preview-collision-sentinel'")=='1'
if already:
 # Resume only this pre-opening rehearsal: no fixture or learner writes exist.
 assert pg('SELECT count(*) FROM writing_practice.sw_preview_scope')=='0'
 assert pg('SELECT count(*) FROM writing_practice.lesson9_session_state')=='0'
 assert pg('SELECT count(*) FROM writing_practice.activity_session')==str(len(rewritten['writing_practice.activity_session']))
 restore=['BEGIN;']
 for a in rewritten['writing_practice.activity']:
  restore.append('UPDATE writing_practice.activity SET '+','.join(k+'='+lit(a[k]) for k in ['status','prompt_registry_key','prompt_record_ref','prompt_version'])+' WHERE id='+str(a['id'])+';')
 restore.append('DELETE FROM writing_practice.activity_section_definition WHERE activity_id IN ('+','.join(str(maps['writing_practice.activity'][i]) for i in ids)+');')
 restore.append(insert('writing_practice.activity_section_definition',rewritten['writing_practice.activity_section_definition']))
 restore.append('COMMIT;');pg('\n'.join(restore))
else:
 pg('\n'.join(commands))
# Compare every original column after reversing only local numeric PK/FK values.
checked={}
for table,expected in data.items():
 cols=[c['name'] for c in columns[table] if c['name'] in expected[0]] if expected else []
 if not expected:continue
 key='id' if 'id' in expected[0] else 'reviewer_email' if 'reviewer_email' in expected[0] else None
 if table in maps:where='id IN ('+','.join(str(v) for v in maps[table].values())+')'
 elif key=='id':where='id IN ('+','.join(lit(r['id']) for r in expected)+')'
 else:where='TRUE'
 got=json.loads(pg(f"SELECT COALESCE(json_agg(t),'[]') FROM (SELECT * FROM {table} WHERE {where})t"))
 for row in got:
  if table in maps:row['id']={v:k for k,v in maps[table].items()}[row['id']]
  for edge in fks:
   if edge['table']==table and edge['depends'] in maps and edge['targets']==['id']:
    k=edge['columns'][0]
    if row.get(k) is not None:row[k]={v:k for k,v in maps[edge['depends']].items()}[row[k]]
 # PostgreSQL normalizes timezone rendering; let its JSON record parser compare values.
 expected_sql=js(expected)
 actual_sql=js([{c:r[c] for c in cols} for r in got])
 n=pg(f"WITH e AS (SELECT {','.join(cols)} FROM json_populate_recordset(NULL::{table},{expected_sql})), a AS (SELECT {','.join(cols)} FROM json_populate_recordset(NULL::{table},{actual_sql})) SELECT count(*) FROM ((TABLE e EXCEPT ALL TABLE a) UNION ALL (TABLE a EXCEPT ALL TABLE e))d")
 if n!='0':raise RuntimeError('Field preservation failed: '+table+' '+n)
 checked[table]=len(expected)
for table in order:
 if 'id' not in [c['name'] for c in columns[table]]:continue
 seq=pg("SELECT COALESCE(pg_get_serial_sequence("+lit(table)+",'id'),'')")
 if seq:pg("SELECT setval("+lit(seq)+",GREATEST(COALESCE((SELECT max(id) FROM "+table+"),0),1),true)")
(root/'field-preservation-before-ui.json').write_text(json.dumps({'outcome':'passed','tables':checked},indent=2))
# Version names are an explicit product configuration, not a Shops-only schema literal.
pg("ALTER TABLE writing_practice.lesson9_rollout DROP CONSTRAINT IF EXISTS lesson9_rollout_ui_version_check; ALTER TABLE writing_practice.lesson9_rollout ADD CONSTRAINT lesson9_rollout_ui_version_check CHECK(ui_version IN ('shops-lesson9-v1','sw-task2-lesson9-v1')); ALTER TABLE writing_practice.lesson9_session_state DROP CONSTRAINT IF EXISTS lesson9_session_state_ui_version_check; ALTER TABLE writing_practice.lesson9_session_state ADD CONSTRAINT lesson9_session_state_ui_version_check CHECK(ui_version IN ('shops-lesson9-v1','sw-task2-lesson9-v1'));")
# Pin new UI metadata without changing historical attempts, fields or feedback.
lessons=json.loads((root/'candidate/lessons.json').read_text())
for oldid in [8,14]:
 aid=maps['writing_practice.activity'][oldid]
 slug=next(a['slug'] for a in data['writing_practice.activity'] if a['id']==oldid)
 registry='ielts:writing:sw-task2-preview:prompt_registry:20261025.1';record='sw-task2:'+slug+':lesson9-v1'
 pg("UPDATE writing_practice.activity SET status='active',prompt_registry_key="+lit(registry)+",prompt_record_ref="+lit(record)+",prompt_version='2026-10-25.1' WHERE id="+str(aid)+"; UPDATE writing_practice.activity_section_definition SET prompt_record_ref="+lit(record)+",prompt_version='2026-10-25.1' WHERE activity_id="+str(aid)+";")
 # Use the reviewed Shops Lesson 9 definition for both; input keys remain identical.
 approved=json.loads(pg('SELECT json_agg(d) FROM writing_practice.activity_section_definition d WHERE activity_id=8',shops=True))
 pg('DELETE FROM writing_practice.activity_section_definition WHERE activity_id='+str(aid)+';')
 for i,d in enumerate(approved):d.update(id=2000+(oldid*10)+i,activity_id=aid,prompt_record_ref=record,prompt_version='2026-10-25.1')
 pg(insert('writing_practice.activity_section_definition',approved))
 pg("INSERT INTO writing_practice.lesson9_rollout(activity_id,ui_version,starts_at) VALUES("+str(aid)+",'sw-task2-lesson9-v1','2020-01-01T00:00:00Z'); INSERT INTO writing_practice.lesson9_session_state(session_id,ui_version,data) SELECT s.id,'sw-task2-lesson9-v1',jsonb_build_object('idea2Opened',EXISTS(SELECT 1 FROM writing_practice.session_section st WHERE st.session_id=s.id AND st.section_key='supporting_idea_1' AND st.locked),'draft2Open',s.draft2_unlocked OR COALESCE(s.response_data->>'draft2','')<>'','editedFields','[]'::jsonb) FROM writing_practice.activity_session s WHERE s.activity_id="+str(aid)+"; INSERT INTO writing_practice.sw_preview_scope SELECT id,'archive' FROM writing_practice.activity_class_scope WHERE activity_id="+str(aid)+";")
for email,role in [('sw-preview-check@preview.invalid','teacher'),('sw-preview-admin@preview.invalid','admin')]:
 pg("INSERT INTO mapping.reviewer_account(email,google_subject,display_name,role,status,can_access_all_classes) VALUES("+lit(email)+","+lit('fixture:'+email)+",'Giảng viên kiểm thử',"+lit(role)+",'active',"+('true' if role=='admin' else 'false')+");")
fixtures=[]
for oldid in [8,14]:
 aid=maps['writing_practice.activity'][oldid];slug=next(a['slug'] for a in data['writing_practice.activity'] if a['id']==oldid)
 for index,code in enumerate(['SW-THU-A','SW-THU-B']):
  cref=str(uuid.uuid5(uuid.NAMESPACE_URL,'sw-preview:'+slug+':'+code));cid=99920001+index
  scope=int(pg("INSERT INTO writing_practice.activity_class_scope(activity_id,public_id,erp_course_class_id,class_name_snapshot,status,end_date) VALUES("+str(aid)+","+lit(cref)+","+str(cid)+","+lit(code)+",'active','2099-12-31') RETURNING id"))
  pg("INSERT INTO writing_practice.sw_preview_scope VALUES("+str(scope)+",'fixture'); INSERT INTO mapping.reviewer_class_access(reviewer_email,erp_course_class_id) VALUES('sw-preview-check@preview.invalid',"+str(cid)+") ON CONFLICT DO NOTHING")
  people=[]
  for i in range(1,7):
   sid=str(uuid.uuid5(uuid.NAMESPACE_URL,'sw-preview:'+code+':'+str(i)));name='Học viên thử '+str(i).zfill(2)
   pg("INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias,active) VALUES("+str(scope)+","+lit(sid)+","+lit(name)+","+lit(name)+",true)")
   people.append(sid)
  fixtures.append({'activitySlug':slug,'classRef':cref,'className':code,'students':people})
cookies={}
for key,email in [('teacher','sw-preview-check@preview.invalid'),('admin','sw-preview-admin@preview.invalid')]:
 token=secrets.token_urlsafe(32);digest=hashlib.sha256(token.encode()).hexdigest()
 pg("INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at) VALUES(decode("+lit(digest)+",'hex'),"+lit(email)+","+lit('fixture:'+email)+",now()+interval '1 day',now()+interval '1 day')")
 cookies[key]='izone_sw_preview_teacher='+token
(root/'fixtures.private.json').write_text(json.dumps({'classes':fixtures,'cookies':cookies}));(root/'fixtures.private.json').chmod(0o600)
(root/'id-map.private.json').write_text(json.dumps(maps));(root/'id-map.private.json').chmod(0o600)
result={'outcome':'passed','fieldComparison':'equal after explicit internal ID reversal','tables':checked,'sourceWrites':False,'publicUuidPreserved':True,'collisionSourceActivityId':14,'collisionMappedTargetId':maps['writing_practice.activity'][14],'archiveMutationAllowed':False,'fixtureClasses':4,'fixtureStudentsPerClass':6,'realClassesOpened':False}
receipt.write_text(json.dumps(result,indent=2));print(json.dumps(result))
