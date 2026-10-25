"""Freeze only the seven migrated SW source activities after draining their jobs.

The old data stays in place. Run on VPS only within an approved cutover.
"""
from pathlib import Path
import subprocess,json,datetime
root=Path('/opt/izone-shops-writing/releases/20261025.sw-task2');out=root/'production';out.mkdir(exist_ok=True)
def pg(sql):
 p=subprocess.run(['docker','exec','-i','mapping-postgres','psql','-U','mapping_admin','-d','mapping_db','-qAt','-v','ON_ERROR_STOP=1'],input=sql,text=True,capture_output=True)
 assert not p.returncode,p.stderr[-2000:];return p.stdout.strip()
ids='10,13,14,16,25,27,28'
preflight=pg(f'''SELECT json_build_object('lessons',(SELECT count(*) FROM writing_practice.activity WHERE id IN({ids})),
 'inflight',(SELECT count(*) FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id WHERE s.activity_id IN({ids}) AND a.status IN('queued','leased')),
 'staleQueuedComments',(SELECT count(*) FROM writing_practice.comment c JOIN writing_practice.check_attempt a ON a.id=c.attempt_id JOIN writing_practice.activity_session s ON s.id=a.session_id WHERE s.activity_id IN({ids}) AND a.status='failed' AND c.status='queued'));''')
counts=json.loads(preflight);assert counts['lessons']==7 and counts['inflight']==0 and counts['staleQueuedComments']==0,counts
before=out/'source-status-before.private.json'
if not before.exists():
 before.write_text(pg(f"SELECT json_build_object('activities',(SELECT json_agg(x) FROM (SELECT id,status,updated_at FROM writing_practice.activity WHERE id IN({ids}))x),'scopes',(SELECT json_agg(x) FROM (SELECT id,status FROM writing_practice.activity_class_scope WHERE activity_id IN({ids}))x));"),encoding='utf-8');before.chmod(0o600)
guard=(root/'candidate/source-write-guard.sql').read_text()
q='BEGIN; SET LOCAL lock_timeout=\'10s\';\n'+guard+f'''
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='writing_practice' AND (column_name IN('activity_id','activity_class_id','session_id','attempt_id','thread_id') OR (table_name='activity' AND column_name='id')) GROUP BY table_name ORDER BY table_name LOOP
  EXECUTE format('LOCK TABLE writing_practice.%I IN SHARE ROW EXCLUSIVE MODE',t.table_name);
 END LOOP;
 IF EXISTS(SELECT 1 FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id WHERE s.activity_id IN({ids}) AND a.status IN('queued','leased')) THEN RAISE EXCEPTION 'SW_SOURCE_JOBS_IN_FLIGHT'; END IF;
END $$;
UPDATE writing_practice.activity SET status='closed',updated_at=now() WHERE id IN({ids}) AND status<>'closed';
UPDATE writing_practice.activity_class_scope SET status='closed' WHERE activity_id IN({ids}) AND status<>'closed';
INSERT INTO sw_task2_migration.frozen_activity(activity_id) SELECT id FROM writing_practice.activity WHERE id IN({ids}) ON CONFLICT DO NOTHING;
COMMIT;
'''
pg(q)
assert pg(f'SELECT count(*) FROM sw_task2_migration.frozen_activity WHERE activity_id IN({ids}) AND enabled')=='7'
receipt={'outcome':'frozen','at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'activities':list(map(int,ids.split(','))),'preflight':counts,'sourceDataDeleted':False,'otherActivitiesFrozen':False}
(out/'source-freeze.json').write_text(json.dumps(receipt,indent=2),encoding='utf-8');print(json.dumps(receipt))
