"""Local: prepare a private synthetic teacher cookie, never a real user session."""
from pathlib import Path
import json,importlib.util
spec=importlib.util.spec_from_file_location('trusted_ssh','E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py');trusted=importlib.util.module_from_spec(spec);spec.loader.exec_module(trusted)
client,password=trusted.connect('vps_1');password=''
try:
 code='''from pathlib import Path
import json,secrets,hashlib,subprocess
token=secrets.token_urlsafe(32);digest=hashlib.sha256(token.encode()).hexdigest()
q="INSERT INTO mapping.reviewer_session(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at) VALUES(decode('"+digest+"','hex'),'shops-release-check@preview.invalid','shops-production-release-check',now()+interval '1 hour',now()+interval '1 hour');"
subprocess.run(['docker','exec','-i','shops-writing-db','psql','-U','shops_owner','-d','shops_writing','-qAt','-v','ON_ERROR_STOP=1'],input=q,text=True,capture_output=True,check=True)
f=json.loads(Path('/opt/izone-shops-writing/releases/20261024.1/canary-fixtures.private.json').read_text());f['cookie']=token
print(json.dumps(f))
'''
 stdin,stdout,stderr=client.exec_command('python3 -');stdin.write(code);stdin.channel.shutdown_write();raw=stdout.read();error=stderr.read()
 if stdout.channel.recv_exit_status():raise RuntimeError('Private browser fixture preparation failed')
 f=json.loads(raw);path=Path('C:/Users/ADMIN/Documents/Codex/shops-handout-preview-20261024/production-private/browser-fixture.private.json');path.write_text(json.dumps(f),encoding='utf-8');print(json.dumps({'outcome':'passed','syntheticFixtureOnly':True,'cookiePrinted':False}))
finally:client.close()
