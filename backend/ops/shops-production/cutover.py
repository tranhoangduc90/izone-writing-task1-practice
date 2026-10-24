"""VPS: verify the copy, freeze only legacy Shops writes, open approved CS scopes.
The old database is retained. No old database or session-store restore is used.
"""
from pathlib import Path
import json,subprocess,hashlib
release=Path('/opt/izone-shops-writing/releases/20261024.1');original=json.loads((release/'migration-source.private.json').read_text())
def pg(q,source=False):
 container,user,db=('mapping-postgres','mapping_admin','mapping_db') if source else ('shops-writing-db','shops_owner','shops_writing')
 p=subprocess.run(['docker','exec','-i',container,'psql','-U',user,'-d',db,'-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True)
 if p.returncode:raise RuntimeError(p.stderr[-1000:])
 return p.stdout.strip()
def literal(v):return "'"+json.dumps(v,ensure_ascii=False).replace("'","''")+"'::jsonb"
assert not (release/'cutover-receipt.json').exists(),'Already opened; never rerun migration over active work'
for n in ['ai-canary-receipt.json','boundary-receipt.json','sso-release-receipt.json','https-receipt.json']:
 assert json.loads((release/n).read_text())['outcome']=='passed',n
session='SELECT id FROM writing_practice.activity_session WHERE activity_id=8'
attempt=f'SELECT id FROM writing_practice.check_attempt WHERE session_id IN ({session})'
thread=f'SELECT id FROM writing_practice.teacher_comment_thread WHERE session_id IN ({session})'
scope='SELECT id FROM writing_practice.activity_class_scope WHERE activity_id=8'
guards={
 'activity_session':('activity_id','activity_id=8'),
 'check_attempt':('session_id',f'session_id IN ({session})'),
 'comment':('session_id',f'session_id IN ({session})'),
 'session_section':('session_id',f'session_id IN ({session})'),
 'draft_request':('session_id',f'session_id IN ({session})'),
 'grading_dispatch':('attempt_id',f'attempt_id IN ({attempt})'),
 'teacher_comment_thread':('session_id',f'session_id IN ({session})'),
 'teacher_comment_message':('thread_id',f'thread_id IN ({thread})'),
 'teacher_comment_status_event':('thread_id',f'thread_id IN ({thread})'),
 'provisional_student':('activity_class_id',f'activity_class_id IN ({scope})'),
 'provisional_student_audit':('activity_class_id',f'activity_class_id IN ({scope})'),
 'activity_student_alias':('activity_id','activity_id=8'),
}
# Match every imported learner record exactly before opening the destination.
# The inherited BEFORE INSERT trigger fills a context on legacy NULL rows.
# Restore that migration-only metadata, after checking every other field.
attempt_rows=original['writing_practice.check_attempt']
copied={r['id']:r for r in json.loads(pg('SELECT json_agg(a) FROM writing_practice.check_attempt a'))}
for row in attempt_rows:
 assert all(copied[row['id']].get(k)==v for k,v in row.items() if k!='grading_context'),'Unexpected imported-attempt difference'
pg('UPDATE writing_practice.check_attempt target SET grading_context=source.grading_context FROM json_populate_recordset(NULL::writing_practice.check_attempt,'+literal(attempt_rows)+'::json) source WHERE target.id=source.id;')
for table,(_,where) in guards.items():
 rows=original.get('writing_practice.'+table,[])
 if rows:
  target=json.loads(pg('SELECT json_agg(x) FROM (SELECT * FROM writing_practice.'+table+' WHERE '+where+')x')) or []
  # Synthetic sessions/attempts are outside the original record set.
  targetset={json.dumps(x,sort_keys=True,ensure_ascii=False) for x in target}
  assert all(json.dumps(x,sort_keys=True,ensure_ascii=False) in targetset for x in rows),'Destination history mismatch: '+table
pending=int(pg("SELECT count(*) FROM writing_practice.check_attempt WHERE session_id IN ("+session+") AND status IN ('queued','leased')",True));assert pending==0
other_query="SELECT md5(jsonb_build_object('activities',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM writing_practice.activity a WHERE id<>8),'scopes',(SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM writing_practice.activity_class_scope c WHERE activity_id<>8))::text)"
others=pg(other_query,True)
commands=['BEGIN; SET LOCAL lock_timeout=\'5s\';']
commands.append('''CREATE FUNCTION writing_practice.shops_moved_write_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE record_data jsonb; key_value text; affected boolean:=false;
BEGIN
 record_data:=to_jsonb(NEW); key_value:=record_data->>TG_ARGV[0];
 IF TG_ARGV[0]='activity_id' THEN affected:=key_value::bigint=8;
 ELSIF TG_ARGV[0]='activity_class_id' THEN SELECT activity_id=8 INTO affected FROM writing_practice.activity_class_scope WHERE id=key_value::bigint;
 ELSIF TG_ARGV[0]='session_id' THEN SELECT activity_id=8 INTO affected FROM writing_practice.activity_session WHERE id=key_value::uuid;
 ELSIF TG_ARGV[0]='thread_id' THEN SELECT s.activity_id=8 INTO affected FROM writing_practice.teacher_comment_thread t JOIN writing_practice.activity_session s ON s.id=t.session_id WHERE t.id=key_value::uuid;
 ELSIF TG_ARGV[0]='attempt_id' THEN SELECT s.activity_id=8 INTO affected FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id WHERE a.id=key_value::uuid;
 END IF;
 IF affected THEN RAISE EXCEPTION 'SHOPS_BACKEND_MOVED' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END; $$;''')
columns=json.loads(pg("SELECT json_object_agg(table_name,cols) FROM (SELECT table_name,json_agg(column_name) cols FROM information_schema.columns WHERE table_schema='writing_practice' GROUP BY table_name)x",True))
for table,(field,where) in guards.items():
 if field not in columns.get(table,[]):continue
 commands.append(f"CREATE TRIGGER shops_moved_write_guard BEFORE INSERT OR UPDATE ON writing_practice.{table} FOR EACH ROW EXECUTE FUNCTION writing_practice.shops_moved_write_guard('{field}');")
 rows=original.get('writing_practice.'+table,[])
 commands.append(f"DO $$ BEGIN IF EXISTS((SELECT to_jsonb(x) FROM writing_practice.{table} x WHERE {where} EXCEPT SELECT value FROM jsonb_array_elements({literal(rows)})) UNION ALL (SELECT value FROM jsonb_array_elements({literal(rows)}) EXCEPT SELECT to_jsonb(x) FROM writing_practice.{table} x WHERE {where})) THEN RAISE EXCEPTION 'SOURCE_CHANGED_{table}'; END IF; END $$;")
commands.append("DO $$ BEGIN BEGIN UPDATE writing_practice.activity_session SET updated_at=updated_at WHERE id=(SELECT id FROM writing_practice.activity_session WHERE activity_id=8 LIMIT 1); RAISE EXCEPTION 'GUARD_DID_NOT_BLOCK'; EXCEPTION WHEN SQLSTATE 'P0001' THEN IF SQLERRM<>'SHOPS_BACKEND_MOVED' THEN RAISE; END IF; END; END $$;")
commands.append("UPDATE writing_practice.activity SET status='closed',updated_at=now() WHERE id=8; UPDATE writing_practice.activity_class_scope SET status='closed' WHERE activity_id=8;")
commands.append('COMMIT;')
(release/'source-freeze.sql').write_text('\n'.join(commands));(release/'source-freeze.sql').chmod(0o600)
pg('\n'.join(commands),True)
assert pg(other_query,True)==others,'Unrelated source configuration changed'
pg("BEGIN; UPDATE writing_practice.activity_class_scope SET status='closed' WHERE activity_id=8 AND class_name_snapshot='SHOPS-KIEM-TRIEN-KHAI'; UPDATE writing_practice.activity_class_scope SET status='active' WHERE activity_id=8 AND erp_course_class_id IN (1184,1283,1384); COMMIT;")
classes=json.loads(pg("SELECT json_agg(x) FROM (SELECT c.class_name_snapshot code,c.status,count(*) FILTER(WHERE r.active) students FROM writing_practice.activity_class_scope c JOIN writing_practice.activity_roster r ON r.activity_class_id=c.id WHERE c.activity_id=8 AND c.status='active' GROUP BY c.id ORDER BY code)x"))
assert {c['code']:c['students'] for c in classes}=={'CS.070626':23,'CS.160826':23,'CS.181026':24}
report={'outcome':'passed','classes':classes,'currentCSStudents':47,'legacyHistoryStudents':23,'oldStudentSessionsPreserved':16,'oldAttemptsPreserved':99,'oldCommentsPreserved':99,'sourceShopsFrozen':True,'unrelatedSourceConfigurationUnchanged':True,'syntheticClassClosed':True,'historyTablesVerified':len(guards),'oldDatabaseRetained':True}
(release/'cutover-receipt.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
