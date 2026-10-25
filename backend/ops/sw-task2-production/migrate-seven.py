"""Append seven Task 2 activities, preserving history and stable public IDs.

Run only on the owned trial or Shops database after capturing the final source.
The trial mode never changes source tables. Production requires source freeze.
"""
from pathlib import Path
import subprocess,json,uuid,sys,datetime
trial='--trial' in sys.argv
root=Path('/opt/izone-shops-writing/releases/20261025.sw-task2');out=root/('trial' if trial else 'production');out.mkdir(exist_ok=True)
container='sw-task2-preview-db' if trial else 'shops-writing-db';owner='sw_owner' if trial else 'shops_owner'
def pg(q,source=False):
    args=['docker','exec','-i',*(['mapping-postgres','psql','-U','mapping_admin','-d','mapping_db'] if source else [container,'psql','-U',owner,'-d','shops_writing']),'-qAt','-v','ON_ERROR_STOP=1']
    p=subprocess.run(args,input=q.rstrip(';')+';',text=True,capture_output=True);assert p.returncode==0,p.stderr[-1800:];return p.stdout.strip()
def lit(value):return "'"+str(value).replace("'","''")+"'"
def js(value):return lit(json.dumps(value,ensure_ascii=False))+'::json'
assert pg('SELECT current_database()')=='shops_writing'
if not trial:assert pg("SELECT to_regclass('sw_task2_migration.frozen_activity') IS NOT NULL",True)=='t','Freeze source before final snapshot'
if (out/'migration.json').exists():print((out/'migration.json').read_text());raise SystemExit(0)
ids='10,13,14,16,25,27,28'
classes=json.loads((root/'erp-all-cs.private.json').read_text());classids=','.join(str(r[0]) for r in classes['classes']);assert len(classes['classes'])==12
source_path=out/'source-seven.private.json'
if not source_path.exists():
    meta=json.loads(pg("SELECT json_agg(json_build_object('table',table_name,'columns',cols)) FROM (SELECT table_name,array_agg(column_name) cols FROM information_schema.columns WHERE table_schema='writing_practice' GROUP BY table_name)x",True))
    session=f'SELECT id FROM writing_practice.activity_session WHERE activity_id IN ({ids})';scope=f'SELECT id FROM writing_practice.activity_class_scope WHERE activity_id IN ({ids})'
    attempt=f'SELECT id FROM writing_practice.check_attempt WHERE session_id IN ({session})';thread=f'SELECT id FROM writing_practice.teacher_comment_thread WHERE session_id IN ({session})'
    predicates={'activity':f'id IN ({ids})'}
    for t in meta:
        for key,values in [('activity_id',ids),('activity_class_id',scope),('session_id',session),('attempt_id',attempt),('thread_id',thread)]:
            if key in t['columns']:predicates[t['table']]=f'{key} IN ({values})';break
    parts=[]
    for table,where in predicates.items():parts.extend([lit('writing_practice.'+table),f"(SELECT COALESCE(json_agg(x),'[]'::json) FROM (SELECT * FROM writing_practice.{table} WHERE {where} ORDER BY 1)x)"])
    data=json.loads(pg('BEGIN READ ONLY; SELECT json_build_object('+','.join(parts)+'); COMMIT',True))
    assert len(data['writing_practice.activity'])==7
    source_path.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');source_path.chmod(0o600)
else:data=json.loads(source_path.read_text())
columns=json.loads(pg("SELECT json_object_agg(t,cols) FROM (SELECT table_schema||'.'||table_name t,json_agg(json_build_object('name',column_name,'type',data_type,'generated',is_generated<>'NEVER') ORDER BY ordinal_position) cols FROM information_schema.columns WHERE table_schema IN ('writing_practice','mapping') GROUP BY table_schema,table_name)x"))
fks=json.loads(pg("SELECT COALESCE(json_agg(json_build_object('table',c.conrelid::regclass::text,'depends',c.confrelid::regclass::text,'columns',(SELECT array_agg(a.attname ORDER BY u.ord) FROM unnest(c.conkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=u.num),'targets',(SELECT array_agg(a.attname ORDER BY u.ord) FROM unnest(c.confkey) WITH ORDINALITY u(num,ord) JOIN pg_attribute a ON a.attrelid=c.confrelid AND a.attnum=u.num))),'[]') FROM pg_constraint c WHERE contype='f' AND connamespace IN ('writing_practice'::regnamespace,'mapping'::regnamespace)"))
def insert(table,rows,suffix=''):
    names=','.join('"'+c['name']+'"' for c in columns[table] if c['name'] in rows[0] and not c['generated'])
    return f'INSERT INTO {table}({names}) SELECT {names} FROM json_populate_recordset(NULL::{table},{js(rows)}) '+suffix+';'
# Keep native Shops Google accounts authoritative. Add only missing accounts/grants
# already authorised for a CS class in the current source registry.
teachers=json.loads(pg("SELECT COALESCE(json_agg(x),'[]') FROM (SELECT * FROM mapping.reviewer_account a WHERE a.status='active' AND (a.role='admin' OR a.email IN(SELECT reviewer_email FROM mapping.reviewer_class_access WHERE erp_course_class_id IN("+classids+"))))x",True))
if teachers:pg(insert('mapping.reviewer_account',teachers,'ON CONFLICT(email) DO NOTHING'))
grants=json.loads(pg("SELECT COALESCE(json_agg(x),'[]') FROM (SELECT DISTINCT reviewer_email,erp_course_class_id FROM mapping.reviewer_class_access WHERE erp_course_class_id IN("+classids+"))x",True))
known={r['email'] for r in json.loads(pg('SELECT json_agg(x) FROM (SELECT email FROM mapping.reviewer_account)x'))}
grants=[r for r in grants if r['reviewer_email'] in known]
if grants:pg(insert('mapping.reviewer_class_access',grants,'ON CONFLICT DO NOTHING'))
data={t:rows for t,rows in data.items() if rows};maps={}
map_path=out/'id-maps.private.json'
if map_path.exists():maps={t:{int(k):v for k,v in m.items()} for t,m in json.loads(map_path.read_text()).items()}
for table,rows in data.items():
    assert not set(rows[0])-{c['name'] for c in columns[table]},('MISSING_COLUMN',table)
    if table not in maps and any(c['name']=='id' and c['type'] in ['bigint','integer','smallint'] for c in columns[table]):
        start=int(pg('SELECT COALESCE(max(id),0)+1000 FROM '+table));maps[table]={r['id']:start+i for i,r in enumerate(sorted(rows,key=lambda r:r['id']))}
(out/'id-maps.private.json').write_text(json.dumps(maps),encoding='utf-8');(out/'id-maps.private.json').chmod(0o600)
rewritten=json.loads(json.dumps(data))
for table,rows in rewritten.items():
    for row in rows:
        original=row.get('id')
        for edge in fks:
            if edge['table']==table and edge['depends'] in maps and edge['targets']==['id']:
                key=edge['columns'][0]
                if row.get(key) is not None:row[key]=maps[edge['depends']][row[key]]
        if table in maps:row['id']=maps[table][original]
pending=set(data);order=[]
while pending:
    ready=sorted(t for t in pending if not any(e['table']==t and e['depends']!=t and e['depends'] in pending for e in fks));assert ready,'Cyclic tables';order+=ready;pending-=set(ready)
present=int(pg('SELECT count(*) FROM writing_practice.activity WHERE id<>8'));assert present in (0,7),'Never overwrite a partial import'
commands=['BEGIN;']+[insert(t,rewritten[t]) for t in order]
commands.append('UPDATE writing_practice.check_attempt t SET grading_context=s.grading_context FROM json_populate_recordset(NULL::writing_practice.check_attempt,'+js(rewritten['writing_practice.check_attempt'])+')s WHERE t.public_id=s.public_id;');commands.append('COMMIT;')
if present==0:pg('\n'.join(commands))
checked={}
for table,rows in rewritten.items():
    if (out/'field-preservation.json').exists():checked[table]=len(rows);continue
    names=','.join('"'+key+'"' for key in rows[0]);q=f'WITH expected AS(SELECT {names} FROM json_populate_recordset(NULL::{table},{js(rows)})),actual AS(SELECT {names} FROM {table} WHERE '
    if table in maps:q+='id IN ('+','.join(map(str,maps[table].values()))+')'
    elif 'public_id' in rows[0]:q+='public_id IN ('+','.join(lit(r['public_id']) for r in rows)+')'
    else:
        key=next(k for k in ['activity_id','activity_class_id','session_id','attempt_id','thread_id'] if k in rows[0]);q+=key+' IN ('+','.join(lit(v) for v in {r[key] for r in rows})+')'
    q+=') SELECT count(*) FROM ((TABLE expected EXCEPT ALL TABLE actual) UNION ALL (TABLE actual EXCEPT ALL TABLE expected))d'
    assert pg(q)=='0',('FIELD_MISMATCH',table);checked[table]=len(rows)
(out/'field-preservation.json').write_text(json.dumps({'outcome':'passed','tables':checked},indent=2),encoding='utf-8')
pg("BEGIN; ALTER TABLE writing_practice.lesson9_rollout DROP CONSTRAINT IF EXISTS lesson9_rollout_ui_version_check; ALTER TABLE writing_practice.lesson9_rollout ADD CONSTRAINT lesson9_rollout_ui_version_check CHECK(ui_version IN ('shops-lesson9-v1','sw-task2-lesson9-v1')); ALTER TABLE writing_practice.lesson9_session_state DROP CONSTRAINT IF EXISTS lesson9_session_state_ui_version_check; ALTER TABLE writing_practice.lesson9_session_state ADD CONSTRAINT lesson9_session_state_ui_version_check CHECK(ui_version IN ('shops-lesson9-v1','sw-task2-lesson9-v1')); ALTER TABLE writing_practice.check_attempt DROP CONSTRAINT IF EXISTS check_attempt_late_callback_token_check; ALTER TABLE writing_practice.check_attempt ADD CONSTRAINT check_attempt_late_callback_token_check CHECK(late_callback_token IS NULL OR (status='failed' AND error_code IN ('GRADING_TIMEOUT_3_MINUTES','SHOPS_GRADING_TIMEOUT'))); COMMIT;")
lessons=json.loads((root/'candidate/lessons.json').read_text());approved=json.loads(pg('SELECT json_agg(d) FROM writing_practice.activity_section_definition d WHERE activity_id=8'))
commands=['BEGIN;']
for a in data['writing_practice.activity']:
    aid=maps['writing_practice.activity'][a['id']];slug=a['slug'];assert lessons[slug]['statement']==a['task_prompt']
    record='sw-task2:'+slug+':lesson9-v1'
    commands.append("UPDATE writing_practice.activity SET status='active',prompt_registry_key='ielts:writing:shops:prompt_registry:20261024.1',prompt_record_ref="+lit(record)+",prompt_version='2026-10-25.1' WHERE id="+str(aid)+';')
    commands.append('DELETE FROM writing_practice.activity_section_definition WHERE activity_id='+str(aid)+';')
    definitions=json.loads(json.dumps(approved))
    for d in definitions:d.update(activity_id=aid,prompt_record_ref=record,prompt_version='2026-10-25.1')
    commands.append(insert('writing_practice.activity_section_definition',definitions))
    commands.append("INSERT INTO writing_practice.lesson9_rollout(activity_id,ui_version,starts_at) VALUES("+str(aid)+",'sw-task2-lesson9-v1','2020-01-01T00:00:00Z') ON CONFLICT DO NOTHING; INSERT INTO writing_practice.lesson9_session_state(session_id,ui_version,data) SELECT s.id,'sw-task2-lesson9-v1',jsonb_build_object('idea2Opened',EXISTS(SELECT 1 FROM writing_practice.session_section st WHERE st.session_id=s.id AND st.section_key='supporting_idea_1' AND st.locked),'draft2Open',s.draft2_unlocked OR COALESCE(s.response_data->>'draft2','')<>'','editedFields','[]'::jsonb) FROM writing_practice.activity_session s WHERE s.activity_id="+str(aid)+' ON CONFLICT DO NOTHING;')
commands.append('COMMIT;');pg('\n'.join(commands))
# Ensure all serials can accept subsequent real writes without key collisions.
for table in maps:
    seq=pg("SELECT COALESCE(pg_get_serial_sequence("+lit(table)+",'id'),'')")
    if seq:pg("SELECT setval("+lit(seq)+",GREATEST(COALESCE((SELECT max(id) FROM "+table+"),0),1),true)")
identity=json.loads(pg('SELECT COALESCE(json_agg(x),\'[]\') FROM writing_practice.shops_roster_identity x'))
by_contact={(r['erp_course_class_id'],r['erp_contact_id']):r['student_public_id'] for r in identity}
mapping=json.loads(pg('SELECT COALESCE(json_agg(x),\'[]\') FROM (SELECT public_id,erp_course_class_id,erp_student_contact_id,status FROM mapping.student_mapping_review WHERE erp_student_contact_id IS NOT NULL AND erp_course_class_id IN('+classids+'))x',True))
existing_roster=json.loads(pg('SELECT json_agg(x) FROM (SELECT DISTINCT c.erp_course_class_id,r.student_public_id FROM writing_practice.activity_roster r JOIN writing_practice.activity_class_scope c ON c.id=r.activity_class_id)x'))
existing_ids={(r['erp_course_class_id'],r['student_public_id']) for r in existing_roster}
for row in mapping:
    key=(row['erp_course_class_id'],row['erp_student_contact_id'])
    # A pending Classroom review does not replace the UUID already used for
    # this exact ERP contact/class. Preserve the roster identity, not its name.
    if (key[0],row['public_id']) in existing_ids:by_contact[key]=row['public_id']
    elif row['status']=='approved':by_contact.setdefault(key,row['public_id'])
activities=json.loads(pg('SELECT json_agg(x) FROM (SELECT id,slug FROM writing_practice.activity)x'))
for cid,code,contact,name,status in classes['rows']:
    assert status in ['on_going','completed'];key=(cid,contact);sid=by_contact.get(key) or str(uuid.uuid5(uuid.NAMESPACE_URL,'https://izone.edu.vn/shops/erp/'+str(cid)+'/'+str(contact)));by_contact[key]=sid
    previous=next((r['student_public_id'] for r in identity if r['erp_course_class_id']==cid and r['erp_contact_id']==contact),None)
    if previous and previous!=sid:
        assert (cid,previous) not in existing_ids,'Do not replace a roster identity already in use'
        pg('UPDATE writing_practice.shops_roster_identity SET student_public_id='+lit(sid)+' WHERE erp_course_class_id='+str(cid)+' AND erp_contact_id='+str(contact))
    else:pg('INSERT INTO writing_practice.shops_roster_identity(erp_course_class_id,erp_contact_id,student_public_id) VALUES('+str(cid)+','+str(contact)+','+lit(sid)+') ON CONFLICT(erp_course_class_id,erp_contact_id) DO NOTHING')
commands=['BEGIN;']
alias_collisions=[]
for a in activities:
    scopes=json.loads(pg('SELECT COALESCE(json_agg(x),\'[]\') FROM writing_practice.activity_class_scope x WHERE activity_id='+str(a['id'])))
    scope_by_class={c['erp_course_class_id']:c for c in scopes}
    rosters=json.loads(pg('SELECT COALESCE(json_agg(x),\'[]\') FROM (SELECT r.activity_class_id,r.student_public_id,r.display_alias FROM writing_practice.activity_roster r JOIN writing_practice.activity_class_scope c ON c.id=r.activity_class_id WHERE c.activity_id='+str(a['id'])+')x'))
    for row in classes['classes']:
        cid,code=row[:2];assert code.startswith('CS.')
        c=scope_by_class.get(cid);ref=c['public_id'] if c else str(uuid.uuid5(uuid.NAMESPACE_URL,'https://izone.edu.vn/sw-task2/'+a['slug']+'/classes/'+str(cid)))
        prior=[r for r in rosters if c and r['activity_class_id']==c['id']];known_ids={r['student_public_id'] for r in prior};used_aliases={r['display_alias'] for r in prior}
        commands.append('INSERT INTO writing_practice.activity_class_scope(public_id,activity_id,erp_course_class_id,class_name_snapshot,status,end_date) VALUES('+lit(ref)+','+str(a['id'])+','+str(cid)+','+lit(code)+",'active','2026-12-31') ON CONFLICT(activity_id,erp_course_class_id) DO UPDATE SET status='active',end_date='2026-12-31';")
        for rcid,rcode,contact,name,status in classes['rows']:
            if rcid!=cid:continue
            sid=by_contact[(cid,contact)]
            if sid in known_ids:continue
            alias=name;n=1
            while alias in used_aliases:
                alias=name+' · Danh sách lớp'+(' '+str(n) if n>1 else '');n+=1
            if alias!=name:alias_collisions.append({'activity':a['slug'],'classRef':ref,'studentRef':sid,'displayAlias':alias})
            used_aliases.add(alias);known_ids.add(sid)
            commands.append('INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias,active) SELECT id,'+lit(sid)+','+lit(name)+','+lit(alias)+',true FROM writing_practice.activity_class_scope WHERE public_id='+lit(ref)+' ON CONFLICT(activity_class_id,student_public_id) DO NOTHING;')
commands.append('COMMIT;');pg('\n'.join(commands))
summary=json.loads(pg("SELECT json_agg(x) FROM (SELECT a.slug,count(*) FILTER(WHERE c.status='active' AND c.class_name_snapshot LIKE 'CS.%') classes FROM writing_practice.activity a JOIN writing_practice.activity_class_scope c ON c.activity_id=a.id GROUP BY a.slug)x"))
assert len(summary)==8 and all(r['classes']==12 for r in summary)
activation=subprocess.run([sys.executable,str(root/'candidate/activate-erp-rosters.py'),*(['--trial'] if trial else [])],text=True,capture_output=True)
assert activation.returncode==0,activation.stderr[-1600:]
(out/'distinct-identities.private.json').write_text(json.dumps(alias_collisions,ensure_ascii=False,indent=2),encoding='utf-8');(out/'distinct-identities.private.json').chmod(0o600)
receipt={'outcome':'passed','trial':trial,'sourceHistoryTables':checked,'activities':summary,'erpStudents':len(classes['rows']),'sessionsImported':len(data['writing_practice.activity_session']),'checksImported':len(data['writing_practice.check_attempt']),'distinctSameNameProfiles':len(alias_collisions),'sourceWrites':False,'publicUuidPreserved':True}
(out/'migration.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8');print(json.dumps(receipt))
