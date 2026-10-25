"""Append six lesson archives to the owned preview; never reseed earlier work."""
from pathlib import Path
import subprocess,json,uuid
root=Path('/opt/izone-sw-task2-preview-20261025');out=root/'six-lessons'
def pg(q,source=False):
 args=['docker','exec','-i',*(['mapping-postgres','psql','-U','mapping_admin','-d','mapping_db'] if source else ['sw-task2-preview-db','psql','-U','sw_owner','-d','sw_task2_preview_20261025']),'-qAt','-v','ON_ERROR_STOP=1']
 p=subprocess.run(args,input=q,text=True,capture_output=True);assert p.returncode==0,p.stderr[-1800:];return p.stdout.strip()
def lit(v):return "'"+str(v).replace("'","''")+"'"
def js(v):return lit(json.dumps(v,ensure_ascii=False))+'::json'
assert pg('SELECT current_database()')=='sw_task2_preview_20261025'
receipt=out/'migration.json'
if receipt.exists():print(receipt.read_text());raise SystemExit(0)
source=json.loads((root/'source-eight-activities.private.json').read_text());ids={10,13,16,25,27,28}
scopes={r['id'] for r in source['writing_practice.activity_class_scope'] if r['activity_id'] in ids}
sessions={r['id'] for r in source['writing_practice.activity_session'] if r['activity_id'] in ids}
attempts={r['id'] for r in source['writing_practice.check_attempt'] if r['session_id'] in sessions}
threads={r['id'] for r in source['writing_practice.teacher_comment_thread'] if r['session_id'] in sessions}
def selected(table,row):
 if table=='writing_practice.activity':return row['id'] in ids
 for key,values in [('activity_id',ids),('activity_class_id',scopes),('session_id',sessions),('attempt_id',attempts),('thread_id',threads)]:
  if key in row:return row[key] in values
 return False
data={t:[r for r in rows if selected(t,r)] for t,rows in source.items()};data={t:rows for t,rows in data.items() if rows}
columns=json.loads((out/'target-columns.private.json').read_text())
# purge_after is computed by both schemas: compare it, never insert a value into it.
if not any(c['name']=='purge_after' for c in columns['writing_practice.activity']):columns['writing_practice.activity'].append({'name':'purge_after','type':'date','generated':True})
for table,rows in data.items():
 assert not set(rows[0])-{c['name'] for c in columns[table]},('TARGET_COLUMN_MISSING',table)
fks=json.loads(pg("SELECT COALESCE(json_agg(json_build_object('table',c.conrelid::regclass::text,'depends',c.confrelid::regclass::text,'columns',(SELECT array_agg(a.attname ORDER BY u.ord) FROM unnest(c.conkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.num),'targets',(SELECT array_agg(a.attname ORDER BY u.ord) FROM unnest(c.confkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=u.num))),'[]') FROM pg_constraint c WHERE contype='f' AND connamespace IN ('writing_practice'::regnamespace,'mapping'::regnamespace)"))
statefile=out/'import-state.private.json'
if statefile.exists():maps=json.loads(statefile.read_text())['maps'];maps={t:{int(k):v for k,v in m.items()} for t,m in maps.items()}
else:
 maps={}
 for table,rows in data.items():
  if any(c['name']=='id' and c['type'] in ['bigint','integer','smallint'] for c in columns[table]):
   start=int(pg('SELECT COALESCE(max(id),0)+1000 FROM '+table));maps[table]={r['id']:start+i for i,r in enumerate(sorted(rows,key=lambda r:r['id']))}
 statefile.write_text(json.dumps({'maps':maps}));statefile.chmod(0o600)
rewritten=json.loads(json.dumps(data))
for table,rows in rewritten.items():
 for row in rows:
  original_id=row.get('id')
  for edge in fks:
   if edge['table']==table and edge['depends'] in maps and edge['targets']==['id']:
    key=edge['columns'][0]
    if row.get(key) is not None:row[key]=maps[edge['depends']][row[key]]
  if table in maps:row['id']=maps[table][original_id]
def insert(table,rows):
 names=','.join('"'+c['name']+'"' for c in columns[table] if c['name'] in rows[0] and not c.get('generated'))
 return f'INSERT INTO {table}({names}) SELECT {names} FROM json_populate_recordset(NULL::{table},{js(rows)});'
pending=set(data);order=[]
while pending:
 ready=sorted(t for t in pending if not any(e['table']==t and e['depends']!=t and e['depends'] in pending for e in fks));assert ready,'Cyclic table dependencies';order+=ready;pending-=set(ready)
present=int(pg('SELECT count(*) FROM writing_practice.activity WHERE slug IN ('+','.join(lit(r['slug']) for r in data['writing_practice.activity'])+')'))
if present==0:
 commands=['BEGIN;']+[insert(t,rewritten[t]) for t in order]
 # The target trigger supplies a context for NULL. Historical NULL is preserved explicitly.
 commands+=['UPDATE writing_practice.check_attempt t SET grading_context=s.grading_context FROM json_populate_recordset(NULL::writing_practice.check_attempt,'+js(rewritten['writing_practice.check_attempt'])+')s WHERE t.public_id=s.public_id;','COMMIT;'];pg('\n'.join(commands))
else:assert present==6,'Partial import; no overwrite is allowed'
checked={}
for table,expected in data.items():
 cols=[c['name'] for c in columns[table] if c['name'] in expected[0]]
 if table in maps:where='id IN ('+','.join(map(str,maps[table].values()))+')'
 else:
  scope_keys=[('activity_id','writing_practice.activity'),('activity_class_id','writing_practice.activity_class_scope'),('session_id','writing_practice.activity_session'),('attempt_id','writing_practice.check_attempt'),('thread_id','writing_practice.teacher_comment_thread')]
  matched=next(((k,t) for k,t in scope_keys if k in expected[0]),None)
  assert matched,('Explicit comparison scope missing',table)
  key,target=matched;values=maps[target].values() if target in maps else {r[key] for r in expected};where=key+' IN ('+','.join(lit(v) for v in values)+')'
 got=json.loads(pg('SELECT COALESCE(json_agg(x),\'[]\') FROM (SELECT * FROM '+table+' WHERE '+where+')x'))
 for row in got:
  if table in maps:row['id']={v:k for k,v in maps[table].items()}[row['id']]
  for e in fks:
   if e['table']==table and e['depends'] in maps and e['targets']==['id']:
    k=e['columns'][0]
    if row.get(k) is not None:row[k]={v:k for k,v in maps[e['depends']].items()}[row[k]]
 names=','.join('"'+c+'"' for c in cols)
 q=f"WITH e AS(SELECT {names} FROM json_populate_recordset(NULL::{table},{js(expected)})),a AS(SELECT {names} FROM json_populate_recordset(NULL::{table},{js(got)})) SELECT count(*) FROM ((TABLE e EXCEPT ALL TABLE a) UNION ALL (TABLE a EXCEPT ALL TABLE e))d"
 assert pg(q)=='0',('FIELD_PRESERVATION_FAILED',table);checked[table]=len(expected)
(out/'field-preservation-before-ui.json').write_text(json.dumps({'outcome':'passed','tables':checked},indent=2))
lessons=json.loads((root/'candidate/lessons.json').read_text());approved=json.loads(pg("SELECT json_agg(d) FROM writing_practice.activity_section_definition d WHERE activity_id=(SELECT id FROM writing_practice.activity WHERE slug='writing-task2-public-health-spending')"))
commands=['BEGIN;'];fixtures=json.loads((root/'fixtures.private.json').read_text())
for a in data['writing_practice.activity']:
 aid=maps['writing_practice.activity'][a['id']];slug=a['slug'];assert lessons[slug]['statement']==a['task_prompt'],('TASK_PROMPT_MISMATCH',slug)
 record='sw-task2:'+slug+':lesson9-v1'
 commands.append("UPDATE writing_practice.activity SET status='active',prompt_registry_key='ielts:writing:sw-task2-preview:prompt_registry:20261025.1',prompt_record_ref="+lit(record)+",prompt_version='2026-10-25.1' WHERE id="+str(aid))
 commands.append('DELETE FROM writing_practice.activity_section_definition WHERE activity_id='+str(aid))
 defs=json.loads(json.dumps(approved))
 for d in defs:d.update(activity_id=aid,prompt_record_ref=record,prompt_version='2026-10-25.1')
 commands.append(insert('writing_practice.activity_section_definition',defs))
 commands.append("INSERT INTO writing_practice.lesson9_rollout(activity_id,ui_version,starts_at) VALUES("+str(aid)+",'sw-task2-lesson9-v1','2020-01-01T00:00:00Z'); INSERT INTO writing_practice.lesson9_session_state(session_id,ui_version,data) SELECT s.id,'sw-task2-lesson9-v1',jsonb_build_object('idea2Opened',EXISTS(SELECT 1 FROM writing_practice.session_section st WHERE st.session_id=s.id AND st.section_key='supporting_idea_1' AND st.locked),'draft2Open',s.draft2_unlocked OR COALESCE(s.response_data->>'draft2','')<>'','editedFields','[]'::jsonb) FROM writing_practice.activity_session s WHERE s.activity_id="+str(aid)+"; INSERT INTO writing_practice.sw_preview_scope SELECT id,'archive' FROM writing_practice.activity_class_scope WHERE activity_id="+str(aid))
 for index,code in enumerate(['SW-THU-A','SW-THU-B']):
  cref=str(uuid.uuid5(uuid.NAMESPACE_URL,'sw-preview:'+slug+':'+code));cid=99920001+index
  commands.append("INSERT INTO writing_practice.activity_class_scope(activity_id,public_id,erp_course_class_id,class_name_snapshot,status,end_date) VALUES("+str(aid)+","+lit(cref)+","+str(cid)+","+lit(code)+",'active','2099-12-31')")
  commands.append("INSERT INTO writing_practice.sw_preview_scope SELECT id,'fixture' FROM writing_practice.activity_class_scope WHERE public_id="+lit(cref))
  people=[]
  for i in range(1,7):
   sid=str(uuid.uuid5(uuid.NAMESPACE_URL,'sw-preview:'+code+':'+str(i)));name='Học viên thử '+str(i).zfill(2);people.append(sid)
   commands.append("INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias,active) SELECT id,"+lit(sid)+","+lit(name)+","+lit(name)+",true FROM writing_practice.activity_class_scope WHERE public_id="+lit(cref))
  fixtures['classes'].append({'activitySlug':slug,'classRef':cref,'className':code,'students':people})
commands.append('COMMIT;');pg(';\n'.join(commands))
for table in maps:
 seq=pg("SELECT COALESCE(pg_get_serial_sequence("+lit(table)+",'id'),'')")
 if seq:pg("SELECT setval("+lit(seq)+",GREATEST(COALESCE((SELECT max(id) FROM "+table+"),0),1),true)")
(root/'fixtures.private.json').write_text(json.dumps(fixtures));(root/'fixtures.private.json').chmod(0o600)
result={'outcome':'passed','lessonsAdded':6,'publicUuidPreserved':True,'fieldComparison':'SQL typed equality after reversing internal PK/FK maps','tables':checked,'priorPreviewReseeded':False,'sourceWrites':False,'realClassesOpened':False}
receipt.write_text(json.dumps(result,indent=2));print(json.dumps(result))
